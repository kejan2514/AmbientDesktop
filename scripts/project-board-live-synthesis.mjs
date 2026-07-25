#!/usr/bin/env node
import { existsSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = resolve(process.env.AMBIENT_PROJECT_BOARD_FIXTURE || join(repoRoot, "fixtures", "project-board-spaceship"));
const model = process.env.AMBIENT_PROJECT_BOARD_MODEL || process.env.AMBIENT_LIVE_MODEL || "example/model-id";
const baseUrl = normalizeAmbientBaseUrl(process.env.AMBIENT_BASE_URL || process.env.AMBIENT_AGENT_AMBIENT_BASE_URL);
const runRefinement = process.argv.includes("--refine") || process.env.AMBIENT_PROJECT_BOARD_SYNTHESIS_REFINEMENT === "1";
const outputPath = resolve(
  process.env.AMBIENT_PROJECT_BOARD_SYNTHESIS_OUT ||
    join(repoRoot, "test-results", "project-board-live-synthesis", runRefinement ? "latest-refinement.json" : "latest.json"),
);

const spaceshipRefinementAnswers = [
  {
    question: "Should ship controls use arcade movement or inertia-based thrust?",
    answer: "Use arcade movement for the first playable slice. Defer inertia-based thrust to a later tuning card.",
  },
  {
    question: "Should enemy spawning use discrete waves or endless pacing?",
    answer: "Use discrete waves for MVP proof because they are easier to test and easier for players to understand.",
  },
  {
    question: "What scoring model should the first playable slice use?",
    answer: "Score by survival time plus enemies destroyed; do not add multipliers yet.",
  },
  {
    question: "How precise should collision semantics be for MVP?",
    answer: "Use simple circle bounds for ship, enemies, asteroids, and shots in the first version.",
  },
  {
    question: "What visual asset approach should ship first?",
    answer: "Use simple vector or primitive geometry first, with screenshots proving a readable nonblank scene.",
  },
];

const apiKey = await readAmbientApiKey();
if (!apiKey) {
  throw new Error(
    [
      "Ambient API key is missing.",
      "Set AMBIENT_API_KEY/AMBIENT_AGENT_AMBIENT_API_KEY, set AMBIENT_API_KEY_FILE, or place ignored-provider-key-file.txt near the repo.",
    ].join(" "),
  );
}

const sources = await readFixtureSources(fixtureRoot);
const prompt = buildPrompt(sources);
const startedAt = new Date().toISOString();
const raw = await callAmbient({ apiKey, baseUrl, model, prompt });
const parsed = validateSynthesis(parseJson(raw));
const observations = observeSynthesis(parsed);
let refinement;
if (runRefinement) {
  const refinementStartedAt = new Date().toISOString();
  const refinementPrompt = buildRefinementPrompt(sources, parsed, spaceshipRefinementAnswers);
  const refinementRaw = await callAmbient({ apiKey, baseUrl, model, prompt: refinementPrompt });
  const refined = validateSynthesis(parseJson(refinementRaw));
  refinement = {
    startedAt: refinementStartedAt,
    completedAt: new Date().toISOString(),
    answers: spaceshipRefinementAnswers,
    observations: observeRefinement(refined),
    synthesis: refined,
    rawText: refinementRaw,
  };
}
const completedAt = new Date().toISOString();

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  JSON.stringify(
    {
      startedAt,
      completedAt,
      model,
      baseUrl,
      fixtureRoot,
      sourceCount: sources.length,
      observations,
      synthesis: parsed,
      rawText: raw,
      refinement,
    },
    null,
    2,
  ),
  "utf8",
);

console.log(
  JSON.stringify(
    {
      model,
      fixtureRoot,
      outputPath,
      sourceCount: sources.length,
      observations,
      refinement: refinement
        ? {
            observations: refinement.observations,
            questionCount: refinement.synthesis.questions.length,
            cardCount: refinement.synthesis.cards.length,
            cards: refinement.synthesis.cards.map((card) => ({
              sourceId: card.sourceId,
              title: card.title,
              candidateStatus: card.candidateStatus,
              priority: card.priority,
              phase: card.phase,
              blockedBy: card.blockedBy,
            })),
          }
        : undefined,
      questionCount: parsed.questions.length,
      cardCount: parsed.cards.length,
      cards: parsed.cards.map((card) => ({
        sourceId: card.sourceId,
        title: card.title,
        candidateStatus: card.candidateStatus,
        priority: card.priority,
        phase: card.phase,
        blockedBy: card.blockedBy,
      })),
    },
    null,
    2,
  ),
);

async function callAmbient(input) {
  const body = JSON.stringify({
    model: input.model,
    messages: [
      {
        role: "system",
        content:
          "You are Ambient/Pi acting as a senior project manager for an autonomous coding board. Return one JSON object only. Do not use markdown.",
      },
      { role: "user", content: input.prompt },
    ],
    temperature: 0.1,
    max_tokens: 12_000,
    response_format: { type: "json_object" },
    stream: true,
  });
  const text = await postAmbientStreamText(`${input.baseUrl}/chat/completions`, {
    body,
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "Content-Length": Buffer.byteLength(body),
    },
  });
  if (!text.trim()) throw new Error("Ambient synthesis returned an empty response.");
  return text;
}

function postAmbientStreamText(rawUrl, input) {
  const url = new URL(rawUrl);
  const client = url.protocol === "http:" ? http : https;
  const timeoutMs = Number(process.env.AMBIENT_PROJECT_BOARD_SYNTHESIS_TIMEOUT_MS || 900_000);
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let idleTimer;
    let responseText = "";
    let buffered = "";
    let fallbackText = "";
    let lastProgressAt = Date.now();
    let lastProgressChars = 0;
    const startedAt = Date.now();

    const settle = (callback) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      callback();
    };
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        request.destroy(
          new Error(
            `Ambient synthesis stream timed out after ${timeoutMs} ms without stream activity (${responseText.length} response chars received).`,
          ),
        );
      }, timeoutMs);
    };
    const emitProgress = (force = false) => {
      const now = Date.now();
      if (!force && responseText.length - lastProgressChars < 1_000 && now - lastProgressAt < 5_000) return;
      lastProgressAt = now;
      lastProgressChars = responseText.length;
      console.error(
        `[project-board-live-synthesis] streamed ${responseText.length.toLocaleString()} response chars in ${Math.round(
          (now - startedAt) / 1000,
        )}s`,
      );
    };
    const consumeEvent = (eventText) => {
      const dataLines = eventText
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart());
      if (dataLines.length === 0) return;
      const data = dataLines.join("\n").trim();
      if (!data || data === "[DONE]") return;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch (error) {
        throw new Error(`Ambient synthesis stream returned malformed SSE data: ${error.message}`);
      }
      const choice = parsed?.choices?.[0];
      const delta =
        choice?.delta?.content ??
        choice?.message?.content ??
        choice?.text ??
        parsed?.delta?.content ??
        parsed?.content ??
        "";
      if (typeof delta === "string" && delta) {
        responseText += delta;
        emitProgress();
      }
    };

    const request = client.request(
      url,
      {
        method: "POST",
        headers: input.headers,
      },
      (response) => {
        const isEventStream = (response.headers["content-type"] ?? "").includes("text/event-stream");
        resetIdleTimer();
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          resetIdleTimer();
          fallbackText += chunk;
          if (isEventStream) {
            buffered += chunk;
            const events = buffered.split(/\r?\n\r?\n/);
            buffered = events.pop() ?? "";
            try {
              for (const eventText of events) consumeEvent(eventText);
            } catch (error) {
              settle(() => reject(error));
              request.destroy(error);
            }
          }
        });
        response.on("end", () => {
          if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
            const detail = fallbackText.replace(/\s+/g, " ").trim();
            settle(() =>
              reject(
                new Error(
                  detail
                    ? `Ambient synthesis failed (${response.statusCode}): ${detail.slice(0, 400)}`
                    : `Ambient synthesis failed (${response.statusCode}).`,
                ),
              ),
            );
            return;
          }
          try {
            if (isEventStream) {
              if (buffered.trim()) consumeEvent(buffered);
              if (!responseText.trim()) {
                const detail = fallbackText.replace(/\s+/g, " ").trim();
                throw new Error(
                  detail
                    ? `Ambient synthesis stream ended without content deltas. Stream sample: ${detail.slice(0, 400)}`
                    : "Ambient synthesis stream ended without content deltas.",
                );
              }
            } else {
              const payload = JSON.parse(fallbackText);
              responseText = payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.text ?? "";
            }
            emitProgress(true);
            settle(() => resolvePromise(responseText));
          } catch (error) {
            settle(() => reject(error));
          }
        });
      },
    );
    request.on("error", (error) => settle(() => reject(error)));
    resetIdleTimer();
    request.write(input.body);
    request.end();
  });
}

function buildPrompt(sources) {
  return [
    "Build a project-board synthesis draft for the project corpus below.",
    "",
    "Return JSON matching this exact shape:",
    JSON.stringify(
      {
        summary: "short synthesis summary",
        goal: "project goal",
        currentState: "what appears to exist now",
        targetUser: "who this is for",
        qualityBar: "proof/testing bar for board cards",
        assumptions: ["assumption"],
        questions: ["ambiguity question"],
        sourceNotes: ["source evidence note"],
        cards: [
          {
            sourceId: "synthesis:stable-id",
            title: "self-contained card title",
            description: "card scope and source basis",
            candidateStatus: "needs_clarification",
            priority: 1,
            phase: "Foundation",
            labels: ["label"],
            blockedBy: [],
            acceptanceCriteria: ["observable done condition"],
            testPlan: {
              unit: ["unit proof expectation"],
              integration: ["integration proof expectation"],
              visual: ["visual/browser/manual screenshot expectation"],
              manual: ["manual proof expectation"],
            },
            sourceRefs: ["path-or-source-title"],
            clarificationQuestions: ["exact user decision needed before this needs_clarification card is executable"],
          },
        ],
      },
      null,
      2,
    ),
    "",
    "Rules:",
    "- Propose several cards, not one broad task.",
    "- Prefer self-contained Local Task cards that can execute with little user interaction after approval.",
    "- Ask questions when the sources conflict instead of guessing final product decisions.",
    "- Use dependencies for true execution order, not vague preference.",
    "- Include proof expectations on every card.",
    "- Every needs_clarification card must include clarificationQuestions with concrete, answerable missing decisions. If no decision is missing, use ready_to_create.",
    "- Treat architecture and implementation plan docs as more authoritative than scratch TODO notes.",
    "- Keep every candidateStatus as needs_clarification unless the card is fully specified and proof-ready.",
    "",
    "Project corpus:",
    ...sources.map((source) =>
      [
        "",
        `--- SOURCE ${source.index}: ${source.path} (${source.kind}, relevance ${source.relevance}) ---`,
        source.content,
      ].join("\n"),
    ),
  ].join("\n");
}

function buildRefinementPrompt(sources, previousDraft, answers) {
  return [
    "Refine a project-board synthesis draft for the WebGL spaceship fixture.",
    "",
    "Return one valid JSON object only, with no markdown, comments, or trailing commas.",
    "Return JSON matching this exact shape:",
    JSON.stringify(
      {
        summary: "short synthesis summary",
        goal: "project goal",
        currentState: "what appears to exist now",
        targetUser: "who this is for",
        qualityBar: "proof/testing bar for board cards",
        assumptions: ["assumption"],
        questions: ["remaining ambiguity question"],
        sourceNotes: ["source evidence note"],
        cards: [
          {
            sourceId: "synthesis:stable-id",
            title: "self-contained card title",
            description: "card scope and source basis",
            candidateStatus: "needs_clarification",
            priority: 1,
            phase: "Foundation",
            labels: ["label"],
            blockedBy: [],
            acceptanceCriteria: ["observable done condition"],
            testPlan: {
              unit: ["unit proof expectation"],
              integration: ["integration proof expectation"],
              visual: ["visual/browser/manual screenshot expectation"],
              manual: ["manual proof expectation"],
            },
            sourceRefs: ["path-or-source-title"],
            clarificationQuestions: ["exact user decision needed before this needs_clarification card is executable"],
          },
        ],
      },
      null,
      2,
    ),
    "",
    "Previous PM Review proposal:",
    JSON.stringify(previousDraft, null, 2),
    "",
    "User answers collected during PM Review:",
    ...answers.map((item, index) => `${index + 1}. Q: ${item.question}\n   A: ${item.answer}`),
    "",
    "Rules:",
    "- Incorporate these answers as stronger evidence than unresolved ambiguity in the raw corpus.",
    "- Remove or rewrite questions that were answered; keep only genuinely unresolved ambiguity.",
    "- Every needs_clarification card must include clarificationQuestions with concrete, answerable missing decisions. If no decision is missing, use ready_to_create.",
    "- Update assumptions, card scope, dependencies, acceptance criteria, and proof expectations to reflect the answers.",
    "- Prefer stable sourceId values from the previous proposal when a card still represents the same work.",
    "- Keep proposed work decomposed into self-contained Local Task cards, not one broad task.",
    "",
    "Project corpus:",
    ...sources.map((source) =>
      [
        "",
        `--- SOURCE ${source.index}: ${source.path} (${source.kind}, relevance ${source.relevance}) ---`,
        source.content,
      ].join("\n"),
    ),
  ].join("\n");
}

async function readFixtureSources(root) {
  if (!existsSync(root)) throw new Error(`Fixture project not found: ${root}`);
  const paths = [];
  await walk(root, root, paths, 0);
  const sources = [];
  let index = 1;
  for (const path of paths.sort((left, right) => left.localeCompare(right))) {
    const absolute = join(root, path);
    const content = (await readFile(absolute, "utf8")).trim();
    if (!content) continue;
    const classification = classifySource(path, content);
    sources.push({
      index,
      path,
      title: titleForSource(path, content),
      content: content.slice(0, 8_000),
      ...classification,
    });
    index += 1;
  }
  return sources;
}

async function walk(root, directory, paths, depth) {
  if (depth > 5) return;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".ambient-codex") continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(root, absolute, paths, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = extname(entry.name).toLowerCase();
    if (!new Set([".md", ".json", ".ts", ".tsx", ".js", ".mjs", ".yml", ".yaml"]).has(extension)) continue;
    paths.push(relative(root, absolute));
  }
}

function classifySource(path, content) {
  const normalized = path.toLowerCase();
  const haystack = `${normalized}\n${content.slice(0, 4000).toLowerCase()}`;
  if (/(architecture|architectural|system|design)/.test(haystack)) return { kind: "architecture_artifact", relevance: 92 };
  if (/(gameplay|requirements|functional|specification|acceptance criteria)/.test(haystack)) return { kind: "functional_spec", relevance: 88 };
  if (/(implementation plan|phase|roadmap|milestone|todo|kanban)/.test(haystack)) return { kind: "implementation_plan", relevance: 84 };
  if (/(vitest|jest|playwright|test|spec)/.test(haystack)) return { kind: "test_artifact", relevance: 78 };
  if (/(package\.json|tsconfig|vite|src\/)/.test(normalized)) return { kind: "implementation_file", relevance: 76 };
  return { kind: "markdown", relevance: 58 };
}

function titleForSource(path, content) {
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim() || basename(path);
}

function parseJson(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return JSON.parse(fenced[1].trim());
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    throw new Error("Ambient synthesis did not return valid JSON.");
  }
}

function validateSynthesis(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Synthesis output must be an object.");
  const result = {
    summary: stringValue(value.summary, "summary"),
    goal: stringValue(value.goal, "goal"),
    currentState: stringValue(value.currentState, "currentState"),
    targetUser: stringValue(value.targetUser, "targetUser"),
    qualityBar: stringValue(value.qualityBar, "qualityBar"),
    assumptions: stringArray(value.assumptions, "assumptions"),
    questions: stringArray(value.questions, "questions"),
    sourceNotes: stringArray(value.sourceNotes, "sourceNotes"),
    cards: arrayValue(value.cards, "cards").map(validateCard),
  };
  if (result.cards.length < 3) throw new Error(`Expected at least 3 synthesized cards, got ${result.cards.length}.`);
  return result;
}

function validateCard(card, index) {
  if (!card || typeof card !== "object" || Array.isArray(card)) throw new Error(`cards[${index}] must be an object.`);
  const testPlan = card.testPlan && typeof card.testPlan === "object" && !Array.isArray(card.testPlan) ? card.testPlan : {};
  const result = {
    sourceId: stringValue(card.sourceId, `cards[${index}].sourceId`),
    title: stringValue(card.title, `cards[${index}].title`),
    description: stringValue(card.description, `cards[${index}].description`),
    candidateStatus: stringValue(card.candidateStatus, `cards[${index}].candidateStatus`),
    priority: Number.isFinite(Number(card.priority)) ? Number(card.priority) : undefined,
    phase: typeof card.phase === "string" ? card.phase : undefined,
    labels: stringArray(card.labels, `cards[${index}].labels`),
    blockedBy: stringArray(card.blockedBy, `cards[${index}].blockedBy`),
    acceptanceCriteria: stringArray(card.acceptanceCriteria, `cards[${index}].acceptanceCriteria`),
    testPlan: {
      unit: stringArray(testPlan.unit, `cards[${index}].testPlan.unit`),
      integration: stringArray(testPlan.integration, `cards[${index}].testPlan.integration`),
      visual: stringArray(testPlan.visual, `cards[${index}].testPlan.visual`),
      manual: stringArray(testPlan.manual, `cards[${index}].testPlan.manual`),
    },
    sourceRefs: stringArray(card.sourceRefs, `cards[${index}].sourceRefs`),
    clarificationQuestions: stringArray(card.clarificationQuestions, `cards[${index}].clarificationQuestions`),
  };
  if (result.candidateStatus === "needs_clarification" && result.clarificationQuestions.length === 0) {
    throw new Error(`cards[${index}] is needs_clarification but has no clarificationQuestions.`);
  }
  return result;
}

function observeSynthesis(synthesis) {
  const text = JSON.stringify(synthesis).toLowerCase();
  const cardsWithProof = synthesis.cards.filter(
    (card) => card.acceptanceCriteria.length > 0 && Object.values(card.testPlan).some((items) => items.length > 0),
  ).length;
  return {
    decomposedIntoMultipleCards: synthesis.cards.length >= 4,
    cardCount: synthesis.cards.length,
    cardsWithProof,
    needsClarificationCount: synthesis.cards.filter((card) => card.candidateStatus === "needs_clarification").length,
    needsClarificationWithoutQuestions: synthesis.cards.filter(
      (card) => card.candidateStatus === "needs_clarification" && card.clarificationQuestions.length === 0,
    ).length,
    questionCount: synthesis.questions.length,
    asksControlQuestion: /\b(arcade|inertia|thrust)\b/.test(synthesis.questions.join("\n").toLowerCase()),
    asksPacingQuestion: /\b(wave|endless|spawn)\b/.test(synthesis.questions.join("\n").toLowerCase()),
    hasDependencyChain: synthesis.cards.some((card) => card.blockedBy.length > 0),
    mentionsWebGlOrThree: /\b(webgl|three\.?js|threejs)\b/.test(text),
    mentionsVisualProof: /\b(screenshot|visual|canvas|nonblank|non-blank)\b/.test(text),
  };
}

function observeRefinement(synthesis) {
  const text = JSON.stringify(synthesis).toLowerCase();
  const answerTopics = {
    arcadeControls: /\barcade\b/.test(text),
    wavePacing: /\bwave|waves\b/.test(text),
    survivalScoring: /\bsurvival|time|destroyed\b/.test(text),
    circleCollisions: /\bcircle|bounds|collision\b/.test(text),
    primitiveVisuals: /\bprimitive|vector|nonblank|non-blank|screenshot\b/.test(text),
  };
  const incorporatedTopicCount = Object.values(answerTopics).filter(Boolean).length;
  if (incorporatedTopicCount < 3) {
    throw new Error(`Expected refined synthesis to incorporate at least 3 answer topics, got ${incorporatedTopicCount}.`);
  }
  return {
    ...observeSynthesis(synthesis),
    answerTopics,
    incorporatedTopicCount,
  };
}

function stringValue(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function arrayValue(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function stringArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
}

async function readAmbientApiKey() {
  const envKey = process.env.AMBIENT_API_KEY || process.env.AMBIENT_AGENT_AMBIENT_API_KEY;
  if (envKey?.trim()) return envKey.trim();
  const candidates = [
    process.env.AMBIENT_API_KEY_FILE,
    join(repoRoot, "ignored-provider-key-file.txt"),
    join(dirname(repoRoot), "ignored-provider-key-file.txt"),
    join(dirname(dirname(repoRoot)), "ignored-provider-key-file.txt"),
    join(homedir(), "ignored-provider-key-file.txt"),
    "/Users/example/Documents/ambientCoder/ignored-provider-key-file.txt",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const key = (await readFile(candidate, "utf8")).trim();
    if (key) return key;
  }
  return undefined;
}

function normalizeAmbientBaseUrl(baseUrl) {
  const root = (baseUrl || "https://api.ambient.xyz").replace(/\/+$/, "");
  return root.endsWith("/v1") ? root : `${root}/v1`;
}
