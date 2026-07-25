#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { redactArtifactText } from "./harness-eval.mjs";

const DEFAULT_MODEL = "example/model-id";
const DEFAULT_BASE_URL = "https://api.ambient.xyz/v1";
const MAX_TEXT_PREVIEW_CHARS = 4000;
const MAX_CONCERNS = 8;

export const JUDGE_SCHEMA = {
  pass: "boolean",
  score: "number 0..1",
  failureCategory: "string|null",
  unrelatedMutationRisk: "low|medium|high",
  toolUseCoherence: "poor|adequate|strong",
  contractAdherence: "poor|adequate|strong",
  deterministicAgreement: "agrees|questions-pass|questions-fail",
  concerns: "string[]",
  conciseRationale: "string",
};

export function parseJudgeArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    runRoot: env.AMBIENT_HARNESS_JUDGE_RUN_ROOT,
    outputName: env.AMBIENT_HARNESS_JUDGE_OUTPUT || "judge-results.jsonl",
    model: env.AMBIENT_HARNESS_JUDGE_MODEL || env.AMBIENT_LIVE_MODEL || DEFAULT_MODEL,
    baseUrl: normalizeAmbientBaseUrl(env.AMBIENT_BASE_URL || env.AMBIENT_AGENT_AMBIENT_BASE_URL),
    limit: positiveIntegerOrUndefined(env.AMBIENT_HARNESS_JUDGE_LIMIT, "AMBIENT_HARNESS_JUDGE_LIMIT"),
    dryRun: false,
    resume: false,
    failOnInvalid: false,
    includeTextPreviews: true,
    cwd: process.cwd(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const [flag, inlineValue] = raw.includes("=") ? raw.split(/=(.*)/s, 2) : [raw, undefined];
    const readValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} requires a value.`);
      return argv[index];
    };

    if (flag === "--run-root" || flag === "--run") options.runRoot = readValue();
    else if (flag === "--output") options.outputName = readValue();
    else if (flag === "--model") options.model = readValue();
    else if (flag === "--base-url") options.baseUrl = normalizeAmbientBaseUrl(readValue());
    else if (flag === "--limit") options.limit = positiveIntegerOrUndefined(readValue(), "--limit");
    else if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--resume") options.resume = true;
    else if (flag === "--fail-on-invalid") options.failOnInvalid = true;
    else if (flag === "--no-text-previews") options.includeTextPreviews = false;
    else if (flag === "--help" || flag === "-h") options.help = true;
    else throw new Error(`Unknown harness-eval-judge option: ${raw}`);
  }

  if (!options.help && !options.runRoot) throw new Error("Provide --run-root <test-results/harness-evals/run-id>.");
  return options;
}

export async function runHarnessJudge(options, deps = {}) {
  const cwd = deps.cwd ?? options.cwd ?? process.cwd();
  const now = deps.now ?? (() => new Date());
  const fetchImpl = deps.fetch ?? fetch;
  const runRoot = resolve(cwd, options.runRoot);
  const config = await readJson(join(runRoot, "config.json"));
  const rows = (await readResults(runRoot)).slice(0, options.limit ?? undefined);
  const candidateLabels = blindCandidateLabels(rows);
  const judgeRows = [];
  const outputPath = join(runRoot, options.outputName);
  const existingByKey = options.resume ? await readExistingJudgeRows({ runRoot, outputPath, rows }) : new Map();
  let skipped = 0;
  let executed = 0;
  const apiKey = options.dryRun ? "" : readAmbientApiKey(process.env);
  if (!options.dryRun && !apiKey) {
    throw new Error("Set AMBIENT_API_KEY, AMBIENT_AGENT_AMBIENT_API_KEY, or AMBIENT_API_KEY_FILE before running live judging.");
  }

  for (const row of rows) {
    const existing = existingByKey.get(judgeRowKey(row));
    if (existing) {
      skipped += 1;
      judgeRows.push(existing);
      if (options.failOnInvalid && existing.status !== "valid") {
        throw new Error(`Judge returned invalid output for ${row.variant}/${row.taskId}/trial-${row.trial}: ${(existing.validationErrors ?? []).join("; ")}`);
      }
      continue;
    }

    const traceDir = resolveTraceDir(runRoot, row);
    const packet = await buildJudgePacket({
      runRoot,
      config,
      row,
      traceDir,
      candidateLabel: candidateLabels.get(row.variant),
      includeTextPreviews: options.includeTextPreviews,
      now,
    });
    await writeJson(join(traceDir, "judge-packet.json"), packet);
    const judgeResult = options.dryRun
      ? dryRunJudgeResult(packet, now)
      : await callAmbientJudge({ packet, apiKey, model: options.model, baseUrl: options.baseUrl, fetchImpl, now });
    const merged = mergeJudgeWithDeterministic(row, judgeResult);
    const output = {
      version: 1,
      generatedAt: now().toISOString(),
      runId: row.runId ?? config.runId,
      candidateLabel: packet.candidateLabel,
      variant: row.variant,
      taskId: row.taskId,
      trial: row.trial,
      status: judgeResult.status,
      deterministicPassed: Boolean(row.deterministic?.passed),
      judge: judgeResult.judge,
      validationErrors: judgeResult.validationErrors,
      merged,
    };
    await writeJson(join(traceDir, "judge-result.json"), output);
    judgeRows.push(output);
    executed += 1;
    await writeJudgeRows(outputPath, judgeRows);
    if (options.failOnInvalid && judgeResult.status !== "valid") {
      throw new Error(`Judge returned invalid output for ${row.variant}/${row.taskId}/trial-${row.trial}: ${judgeResult.validationErrors.join("; ")}`);
    }
  }

  const resume = { enabled: options.resume, expected: rows.length, existing: existingByKey.size, skipped, executed };
  const summary = buildJudgeSummary({ config, judgeRows, candidateLabels, generatedAt: now().toISOString(), dryRun: options.dryRun, resume });
  await writeJudgeRows(outputPath, judgeRows);
  await writeJson(join(runRoot, "judge-frontier.json"), summary);
  await writeJudgeSummaryMarkdown(join(runRoot, "judge-summary.md"), summary);
  return { runRoot, config, judgeRows, summary, resume };
}

export async function buildJudgePacket({ runRoot, config, row, traceDir = resolveTraceDir(runRoot, row), candidateLabel, includeTextPreviews, now }) {
  const [deterministic, summary, stdoutPreview, stderrPreview, changedFiles, scriptTracePreview, toolTranscriptPreview] = await Promise.all([
    readOptionalJson(join(traceDir, "deterministic-score.json")),
    readOptionalJson(join(traceDir, "summary.json")),
    includeTextPreviews ? readTextPreview(join(traceDir, "stdout.log")) : undefined,
    includeTextPreviews ? readTextPreview(join(traceDir, "stderr.log")) : undefined,
    readOptionalJson(join(traceDir, "changed-files.json")),
    readOptionalJson(join(traceDir, "trace-preview.json")),
    includeTextPreviews ? readTextPreview(join(traceDir, "tool-transcript.txt")) : undefined,
  ]);
  return {
    version: 1,
    generatedAt: now().toISOString(),
    runId: row.runId ?? config.runId,
    candidateLabel,
    taskId: row.taskId,
    trial: row.trial,
    localFactsAreAuthoritative: true,
    deterministic: {
      status: row.status,
      passed: Boolean(row.deterministic?.passed),
      failureCategory: row.deterministic?.failureCategory ?? null,
      evidence: boundedStringArray(row.deterministic?.evidence ?? deterministic?.evidence ?? [], 12, 240),
      elapsedMs: row.elapsedMs,
      metrics: row.metrics ?? {},
      mutation: row.deterministic?.mutation ?? deterministic?.mutation,
      changedFiles: summarizeChangedFiles(changedFiles),
      artifacts: Array.isArray(row.artifacts) ? row.artifacts : undefined,
    },
    scriptSummary: summarizeScriptJson(summary),
    tracePreview: {
      stdoutTail: stdoutPreview,
      stderrTail: stderrPreview,
      toolTranscriptTail: toolTranscriptPreview,
      scriptTrace: scriptTracePreview
        ? {
            messageCount: scriptTracePreview.messageCount,
            toolMessageCount: scriptTracePreview.toolMessageCount,
            toolNames: scriptTracePreview.toolNames,
            assistantTail: scriptTracePreview.assistantTail,
          }
        : undefined,
    },
    rubric: {
      judgeMayAssess: [
        "semantic quality of the assistant behavior",
        "tool-use coherence and avoidable churn",
        "whether the final user-facing result appears trustworthy",
        "risk signals that deterministic checks do not capture",
      ],
      judgeMustNotOverride: [
        "required files missing",
        "tests failing",
        "timeout status",
        "exact content marker failures",
        "secret scan failures",
        "blocking mutation-policy failures",
      ],
      mutationPolicyGuidance:
        "If deterministic.mutation is present, treat unexpectedPaths as unrelated mutation risk. Do not count ignoredPaths as unrelated mutations; they are known Ambient-managed setup noise.",
      requiredJsonSchema: JUDGE_SCHEMA,
    },
  };
}

export function validateJudgeObject(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, errors: ["judge output is not an object"] };
  if (typeof value.pass !== "boolean") errors.push("pass must be boolean");
  if (typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || value.score > 1) errors.push("score must be a number between 0 and 1");
  if (value.failureCategory !== null && typeof value.failureCategory !== "string") errors.push("failureCategory must be string or null");
  if (!["low", "medium", "high"].includes(value.unrelatedMutationRisk)) errors.push("unrelatedMutationRisk must be low, medium, or high");
  if (!["poor", "adequate", "strong"].includes(value.toolUseCoherence)) errors.push("toolUseCoherence must be poor, adequate, or strong");
  if (!["poor", "adequate", "strong"].includes(value.contractAdherence)) errors.push("contractAdherence must be poor, adequate, or strong");
  if (!["agrees", "questions-pass", "questions-fail"].includes(value.deterministicAgreement)) {
    errors.push("deterministicAgreement must be agrees, questions-pass, or questions-fail");
  }
  if (!Array.isArray(value.concerns) || value.concerns.some((item) => typeof item !== "string")) errors.push("concerns must be a string array");
  if (typeof value.conciseRationale !== "string" || !value.conciseRationale.trim()) errors.push("conciseRationale must be a non-empty string");
  return { ok: errors.length === 0, errors };
}

export function mergeJudgeWithDeterministic(row, judgeResult) {
  const deterministicPassed = Boolean(row.deterministic?.passed);
  if (judgeResult.status !== "valid") {
    return {
      pass: false,
      score: 0,
      reason: "invalid-judge-output",
      localFactsAuthoritative: true,
    };
  }
  return {
    pass: deterministicPassed && judgeResult.judge.pass,
    score: deterministicPassed ? judgeResult.judge.score : 0,
    reason: deterministicPassed ? (judgeResult.judge.pass ? "deterministic-and-judge-pass" : "judge-quality-fail") : "deterministic-fail",
    localFactsAuthoritative: true,
  };
}

export function buildJudgeSummary({ config, judgeRows, candidateLabels, generatedAt, dryRun, resume }) {
  const byVariant = new Map();
  for (const row of judgeRows) {
    const entry = byVariant.get(row.variant) ?? {
      variant: row.variant,
      candidateLabel: row.candidateLabel,
      judged: 0,
      valid: 0,
      deterministicPasses: 0,
      mergedPasses: 0,
      invalid: 0,
      scores: [],
      riskCounts: { low: 0, medium: 0, high: 0 },
      concerns: [],
    };
    entry.judged += 1;
    if (row.status === "valid") {
      entry.valid += 1;
      if (row.deterministicPassed) entry.deterministicPasses += 1;
      if (row.merged?.pass) entry.mergedPasses += 1;
      entry.scores.push(row.merged?.score ?? 0);
      entry.riskCounts[row.judge.unrelatedMutationRisk] += 1;
      entry.concerns.push(...boundedStringArray(row.judge.concerns ?? [], MAX_CONCERNS, 180));
    } else {
      entry.invalid += 1;
    }
    byVariant.set(row.variant, entry);
  }
  const variants = [...byVariant.values()].map((entry) => ({
    variant: entry.variant,
    candidateLabel: entry.candidateLabel,
    judged: entry.judged,
    valid: entry.valid,
    invalid: entry.invalid,
    deterministicPassRate: entry.judged ? entry.deterministicPasses / entry.judged : 0,
    mergedPassRate: entry.valid ? entry.mergedPasses / entry.valid : 0,
    medianScore: median(entry.scores),
    riskCounts: entry.riskCounts,
    concerns: [...new Set(entry.concerns)].slice(0, MAX_CONCERNS),
  }));
  variants.sort((left, right) => {
    if (right.mergedPassRate !== left.mergedPassRate) return right.mergedPassRate - left.mergedPassRate;
    if ((right.medianScore ?? 0) !== (left.medianScore ?? 0)) return (right.medianScore ?? 0) - (left.medianScore ?? 0);
    return left.variant.localeCompare(right.variant);
  });
  return {
    version: 1,
    runId: config.runId,
    generatedAt,
    dryRun,
    resume,
    judgedTrialCount: judgeRows.length,
    candidateMap: Object.fromEntries([...candidateLabels.entries()].map(([variant, label]) => [label, variant])),
    recommendedVariant: variants[0]?.variant,
    variants,
  };
}

export function parseJsonObjectText(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) throw new Error("Ambient judge did not return a JSON object.");
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

async function callAmbientJudge({ packet, apiKey, model, baseUrl, fetchImpl, now }) {
  const prompt = [
    "Grade this Ambient Desktop harness trial.",
    "Return one JSON object only. Do not use markdown.",
    "Respect the localFactsAreAuthoritative field: if deterministic.passed is false, pass must be false.",
    "Use the schema exactly:",
    JSON.stringify(JUDGE_SCHEMA, null, 2),
    "",
    "Judge packet:",
    JSON.stringify(packet, null, 2),
  ].join("\n");
  const response = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are a strict Ambient harness judge. Return a single JSON object matching the requested schema. Deterministic local facts are authoritative.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 2000,
      response_format: { type: "json_object" },
      stream: true,
    }),
  });
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, " ").trim();
    throw new Error(detail ? `Ambient judge request failed (${response.status}): ${detail.slice(0, 240)}` : `Ambient judge request failed (${response.status}).`);
  }
  const rawText = await readAmbientResponseText(response, Number(process.env.AMBIENT_HARNESS_JUDGE_IDLE_MS || 90_000));
  let parsed;
  try {
    parsed = parseJsonObjectText(rawText);
  } catch (error) {
    return {
      status: "invalid",
      rawText: rawText.slice(0, MAX_TEXT_PREVIEW_CHARS),
      validationErrors: [error instanceof Error ? error.message : String(error)],
      judge: undefined,
      completedAt: now().toISOString(),
    };
  }
  const validation = validateJudgeObject(parsed);
  return {
    status: validation.ok ? "valid" : "invalid",
    rawText: rawText.slice(0, MAX_TEXT_PREVIEW_CHARS),
    validationErrors: validation.errors,
    judge: validation.ok ? normalizeJudgeObject(parsed, packet) : undefined,
    completedAt: now().toISOString(),
  };
}

async function readAmbientResponseText(response, idleTimeoutMs) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const payload = await response.json();
    return payload.choices?.[0]?.message?.content ?? payload.choices?.[0]?.text ?? "";
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let responseText = "";
  const consumeEvent = (eventText) => {
    for (const line of eventText.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice("data:".length).trim();
      if (!data || data === "[DONE]") continue;
      const parsed = JSON.parse(data);
      const choice = parsed?.choices?.[0];
      responseText += choice?.delta?.content ?? choice?.message?.content ?? choice?.text ?? "";
    }
  };
  while (true) {
    const { done, value } = await readStreamChunk(reader, idleTimeoutMs, responseText.length);
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      events.forEach(consumeEvent);
    }
    if (done) break;
  }
  if (buffer.trim()) consumeEvent(buffer);
  return responseText;
}

async function readStreamChunk(reader, idleTimeoutMs, responseCharCount) {
  let timeout;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Ambient judge stream stalled after ${idleTimeoutMs}ms (${responseCharCount} response chars received).`));
        }, idleTimeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function dryRunJudgeResult(packet, now) {
  const deterministicPassed = Boolean(packet.deterministic?.passed);
  const judge = normalizeJudgeObject(
    {
      pass: deterministicPassed,
      score: deterministicPassed ? 0.8 : 0,
      failureCategory: deterministicPassed ? null : packet.deterministic?.failureCategory ?? "deterministic-fail",
      unrelatedMutationRisk: "low",
      toolUseCoherence: deterministicPassed ? "adequate" : "poor",
      contractAdherence: deterministicPassed ? "adequate" : "poor",
      deterministicAgreement: "agrees",
      concerns: deterministicPassed ? [] : ["Deterministic trial failed; judge cannot override local facts."],
      conciseRationale: deterministicPassed ? "Dry run placeholder for a deterministic pass." : "Dry run placeholder for a deterministic failure.",
    },
    packet,
  );
  return {
    status: "valid",
    rawText: "",
    validationErrors: [],
    judge,
    completedAt: now().toISOString(),
  };
}

function normalizeJudgeObject(value, packet) {
  const deterministicPassed = Boolean(packet.deterministic?.passed);
  return {
    pass: deterministicPassed && Boolean(value.pass),
    score: Math.max(0, Math.min(1, Number(value.score))),
    failureCategory: value.failureCategory ?? null,
    unrelatedMutationRisk: value.unrelatedMutationRisk,
    toolUseCoherence: value.toolUseCoherence,
    contractAdherence: value.contractAdherence,
    deterministicAgreement: value.deterministicAgreement,
    concerns: boundedStringArray(value.concerns ?? [], MAX_CONCERNS, 220),
    conciseRationale: String(value.conciseRationale).slice(0, 800),
  };
}

function blindCandidateLabels(rows) {
  const variants = [...new Set(rows.map((row) => row.variant))].sort();
  return new Map(variants.map((variant, index) => [variant, `candidate_${String.fromCharCode(97 + index)}`]));
}

async function readResults(runRoot) {
  const resultJsonl = join(runRoot, "results.jsonl");
  if (!existsSync(resultJsonl)) throw new Error(`Missing results.jsonl in ${runRoot}`);
  const text = await readFile(resultJsonl, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function readExistingJudgeRows({ runRoot, outputPath, rows }) {
  const byKey = new Map();
  for (const row of await readJudgeRowsFile(outputPath)) {
    const key = judgeRowKey(row);
    if (key) byKey.set(key, row);
  }
  for (const row of rows) {
    const traceRow = await readOptionalJson(join(resolveTraceDir(runRoot, row), "judge-result.json"));
    const key = judgeRowKey(traceRow);
    if (key) byKey.set(key, traceRow);
  }
  return byKey;
}

async function readJudgeRowsFile(path) {
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  if (path.endsWith(".jsonl")) {
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [];
}

function judgeRowKey(row) {
  if (!row?.variant || !row?.taskId || !row?.trial) return undefined;
  return `${row.variant}\0${row.taskId}\0${row.trial}`;
}

async function writeJudgeSummaryMarkdown(path, summary) {
  const lines = [
    "# Meta-Harness Judge Summary",
    "",
    `Run ID: \`${summary.runId}\``,
    `Generated: \`${summary.generatedAt}\``,
    `Mode: ${summary.dryRun ? "dry run" : "live Ambient judge"}`,
    summary.resume?.enabled ? `Resume: skipped ${summary.resume.skipped}/${summary.resume.expected} completed judge result(s), executed ${summary.resume.executed}.` : undefined,
    "",
    "| Variant | Candidate | Judged | Valid | Merged Pass Rate | Median Score | Risk Low/Med/High |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- |",
    ...summary.variants.map((variant) =>
      `| \`${variant.variant}\` | \`${variant.candidateLabel}\` | ${variant.judged} | ${variant.valid} | ${percent(variant.mergedPassRate)} | ${score(variant.medianScore)} | ${variant.riskCounts.low}/${variant.riskCounts.medium}/${variant.riskCounts.high} |`,
    ),
    "",
    "## Notes",
    "",
    "- Deterministic checks remain authoritative for files, tests, exact markers, timeouts, and secret scans.",
    "- Candidate labels are blind in judge packets; the local summary maps them back to variants.",
    "",
  ].filter((line) => line !== undefined);
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
}

function summarizeScriptJson(summary) {
  if (!summary || typeof summary !== "object") return undefined;
  return {
    model: stringOrUndefined(summary.model),
    messageDeltaCount: numberOrUndefined(summary.messageDeltaCount),
    toolEventCount: numberOrUndefined(summary.toolEventCount),
    toolMessageCount: numberOrUndefined(summary.toolMessageCount),
    toolNames: Array.isArray(summary.toolNames) ? [...new Set(summary.toolNames.filter((value) => typeof value === "string"))].slice(0, 40) : undefined,
    createdFiles: Array.isArray(summary.createdFiles) ? summary.createdFiles.filter((value) => typeof value === "string").slice(0, 20) : undefined,
    expectedFileBytes: numberOrUndefined(summary.expectedFileBytes),
    npmTestLines: numberOrUndefined(summary.npmTestLines),
    dossierBytes: numberOrUndefined(summary.dossierBytes),
  };
}

function summarizeChangedFiles(changedFiles) {
  if (!changedFiles || typeof changedFiles !== "object" || !Array.isArray(changedFiles.changes)) return undefined;
  return {
    count: changedFiles.changes.length,
    changes: changedFiles.changes
      .filter((change) => change && typeof change === "object" && typeof change.path === "string")
      .slice(0, 40)
      .map((change) => ({
        path: change.path,
        status: typeof change.status === "string" ? change.status : undefined,
        bytes: typeof change.bytes === "number" ? change.bytes : typeof change.after?.bytes === "number" ? change.after.bytes : undefined,
      })),
    omitted: {
      before: changedFiles.beforeOmitted,
      after: changedFiles.afterOmitted,
    },
  };
}

async function readTextPreview(path) {
  if (!existsSync(path)) return undefined;
  const text = await readFile(path, "utf8");
  const redacted = redactArtifactText(text, secretValuesFromEnv(process.env));
  return redacted.slice(Math.max(0, redacted.length - MAX_TEXT_PREVIEW_CHARS));
}

async function readOptionalJson(path) {
  if (!existsSync(path)) return undefined;
  return readJson(path);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJudgeRows(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  if (path.endsWith(".jsonl")) {
    await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), "utf8");
    return;
  }
  await writeFile(path, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
}

function readAmbientApiKey(env) {
  const direct = env.AMBIENT_API_KEY || env.AMBIENT_AGENT_AMBIENT_API_KEY;
  if (direct?.trim()) return direct.trim();
  const fileCandidates = [
    env.AMBIENT_API_KEY_FILE,
    env.AMBIENT_AGENT_AMBIENT_API_KEY_FILE,
    join(process.cwd(), "ignored-provider-key-file.txt"),
    join(process.cwd(), "..", "ambientCoder", "ignored-provider-key-file.txt"),
  ].filter(Boolean);
  for (const file of fileCandidates) {
    try {
      if (existsSync(file)) return readFileSync(file, "utf8").trim();
    } catch {
      // Try the next configured location.
    }
  }
  return "";
}

function secretValuesFromEnv(env) {
  return [env.AMBIENT_API_KEY, env.AMBIENT_AGENT_AMBIENT_API_KEY].filter((value) => typeof value === "string" && value.length >= 8);
}

function resolveTraceDir(runRoot, row) {
  if (row.artifactDir && existsSync(row.artifactDir)) return row.artifactDir;
  return join(runRoot, "traces", row.variant, row.taskId, `trial-${row.trial}`);
}

function boundedStringArray(value, maxItems, maxChars) {
  return (Array.isArray(value) ? value : [])
    .filter((item) => typeof item === "string" && item.trim())
    .slice(0, maxItems)
    .map((item) => item.replace(/\s+/g, " ").trim().slice(0, maxChars));
}

function normalizeAmbientBaseUrl(baseUrl) {
  const root = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return root.endsWith("/v1") ? root : `${root}/v1`;
}

function positiveIntegerOrUndefined(value, label) {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function stringOrUndefined(value) {
  return typeof value === "string" ? value : undefined;
}

function numberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function median(values) {
  const sorted = values.filter((value) => typeof value === "number" && Number.isFinite(value)).sort((left, right) => left - right);
  if (!sorted.length) return undefined;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function percent(value) {
  return typeof value === "number" ? `${Math.round(value * 100)}%` : "n/a";
}

function score(value) {
  return typeof value === "number" ? value.toFixed(2) : "n/a";
}

function printUsage() {
  console.log(`Usage: node scripts/harness-eval-judge.mjs --run-root test-results/harness-evals/<run-id> [options]

Options:
  --run-root <path>       Harness run directory containing results.jsonl.
  --limit <n>             Judge only the first n result rows.
  --model <model>         Ambient judge model. Defaults to Kimi K2.7 Code.
  --base-url <url>        Ambient API base URL.
  --output <file>         Output JSON file name under run root.
  --dry-run               Build packets and placeholder judge results without calling Ambient.
  --resume                Reuse existing judge-result artifacts and judge only missing rows.
  --fail-on-invalid       Exit on the first invalid judge response.
  --no-text-previews      Omit bounded stdout/stderr tails from judge packets.
`);
}

async function main() {
  const options = parseJudgeArgs();
  if (options.help) {
    printUsage();
    return;
  }
  const result = await runHarnessJudge(options);
  console.log(JSON.stringify({ runRoot: result.runRoot, summary: result.summary, resume: result.resume }, null, 2));
  if (result.judgeRows.some((row) => row.status !== "valid")) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
