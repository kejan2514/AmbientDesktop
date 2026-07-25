import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AmbientProjectBoardSynthesisProvider,
  type ProjectBoardSynthesisReasoning,
} from "./projectBoardSynthesisProvider";
import type { ProjectBoardSynthesisCardInput, ProjectBoardSynthesisSource } from "./projectBoardSynthesis";

const runLive = process.env.AMBIENT_PROJECT_BOARD_RELEASE_MATRIX_LIVE === "1";
const liveIt = runLive ? it : it.skip;

interface MatrixScenarioResult {
  name: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  timeToFirstCardMs: number | null;
  promptCharCount: number;
  responseCharCount: number;
  cardCount: number;
  proofReadyCardCount: number;
  duplicateTitleCount: number;
  clarificationQuestionCount: number;
  warningCodes: string[];
  errorCodes: string[];
  providerTimeoutObserved: boolean;
  progressStages: string[];
  sectionCount?: number;
  failedSectionCount?: number;
  semanticIdleSectionCount?: number;
  titles: string[];
  notes: string[];
}

describe("project board release-gate live matrix", () => {
  liveIt(
    "archives a concise live repeatability matrix across synthesis paths",
    async () => {
      const apiKey = readLiveAmbientApiKey();
      const reasoning = readReleaseMatrixReasoning();
      const model = process.env.AMBIENT_PROJECT_BOARD_MODEL || process.env.AMBIENT_LIVE_MODEL || "zai-org/GLM-5.1-FP8";
      const startedAt = new Date();
      const scenarios: MatrixScenarioResult[] = [];

      scenarios.push(await runShortSpaceshipSynthesis({ apiKey, model, reasoning }));
      scenarios.push(await runStarshipAddCards({ apiKey, model, reasoning }));
      scenarios.push(await runSmallProjectSynthesis({ apiKey, model, reasoning }));

      const workerExecution = {
        name: "worker-enabled first-ready execution",
        status: "skipped" as const,
        reason:
          "This provider-level matrix does not launch Electron workers. Use the full in-app dogfood release gate for task-action and runtime-split execution.",
      };
      const report = {
        status: scenarios.every((scenario) => scenario.status === "passed") ? "passed_with_worker_pass_skipped" : "failed",
        generatedAt: new Date().toISOString(),
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        model,
        reasoning: describeReasoning(reasoning),
        outputContract:
          "Short live provider matrix for repeatability. It checks grounded card synthesis, additive card generation, small-project planning, proof expectations, duplicate titles, warnings/errors, and timeout signatures.",
        sourceRevision: readSourceRevision(),
        scenarios,
        workerExecution,
        summary: {
          scenarioCount: scenarios.length,
          totalDurationMs: scenarios.reduce((sum, scenario) => sum + scenario.durationMs, 0),
          totalCards: scenarios.reduce((sum, scenario) => sum + scenario.cardCount, 0),
          totalProofReadyCards: scenarios.reduce((sum, scenario) => sum + scenario.proofReadyCardCount, 0),
          duplicateTitleCount: scenarios.reduce((sum, scenario) => sum + scenario.duplicateTitleCount, 0),
          warningCodes: [...new Set(scenarios.flatMap((scenario) => scenario.warningCodes))],
          errorCodes: [...new Set(scenarios.flatMap((scenario) => scenario.errorCodes))],
          providerTimeoutObserved: scenarios.some((scenario) => scenario.providerTimeoutObserved),
        },
      };
      const outputPath = resolve(
        process.env.AMBIENT_PROJECT_BOARD_RELEASE_MATRIX_OUT ||
          join(dirname(fileURLToPath(import.meta.url)), "../../test-results/project-board-release-matrix/latest.json"),
      );
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");
      console.info(`[project-board-release-matrix] ${JSON.stringify({ outputPath, summary: report.summary })}`);

      expect(report.status).toBe("passed_with_worker_pass_skipped");
      expect(report.summary.totalCards).toBeGreaterThanOrEqual(7);
      expect(report.summary.totalProofReadyCards).toBe(report.summary.totalCards);
      expect(report.summary.duplicateTitleCount).toBe(0);
      expect(report.summary.providerTimeoutObserved).toBe(false);
    },
    420_000,
  );
});

async function runShortSpaceshipSynthesis(input: {
  apiKey: string;
  model: string;
  reasoning?: ProjectBoardSynthesisReasoning;
}): Promise<MatrixScenarioResult> {
  const sources: ProjectBoardSynthesisSource[] = [
    {
      kind: "functional_spec",
      title: "Spaceship game vision",
      summary:
        "Build a browser WebGL spaceship survival game with a readable nonblank scene, player movement, enemies, score, and proof that the first playable slice works.",
      path: "README.md",
      relevance: 95,
    },
    {
      kind: "architecture_artifact",
      title: "Render architecture",
      summary:
        "Use Three.js/WebGL with separated render loop, input reducer, entity update systems, collision helpers, and lightweight HUD state.",
      path: "docs/architecture.md",
      relevance: 92,
    },
    {
      kind: "implementation_plan",
      title: "Known ambiguities",
      summary:
        "Controls are unresolved between arcade movement and inertia thrust. Enemy pacing is unresolved between waves and endless spawning. Proof should include unit tests for pure state and visual/manual proof for the canvas.",
      path: "docs/gameplay-notes.md",
      relevance: 88,
    },
  ];
  const scenario = await synthesizeScenario({
    name: "short spaceship synthesis",
    projectName: "Live Spaceship Fixture",
    sources,
    ...input,
  });
  expect(scenario.cardCount).toBeGreaterThanOrEqual(3);
  expect(scenario.responseCharCount).toBeGreaterThan(500);
  expect(scenario.titles.join(" ").toLowerCase()).toMatch(/ship|webgl|game|enemy|scene|control|hud/);
  return scenario;
}

async function runStarshipAddCards(input: {
  apiKey: string;
  model: string;
  reasoning?: ProjectBoardSynthesisReasoning;
}): Promise<MatrixScenarioResult> {
  const featureDoc = [
    "# Spectral Cartography Contracts",
    "",
    "Add an optional mission loop where the pilot accepts comet-lane survey contracts from a cartography board.",
    "The player fires a scan ping to reveal spectral beacon echoes, route-risk overlays, and hidden salvage pockets.",
    "Each contract grades the route by drift stability, shield exposure, and enemy patrol density.",
    "The first implementation should create the mission board data model, scan-ping state transition, HUD route-risk overlay, and proof that the loop can be tested without a full art pass.",
  ].join("\n");
  const scenario = await synthesizeScenario({
    name: "starship additive feature cards",
    projectName: "testStarshipGame",
    sources: [
      {
        id: "source-spectral-cartography",
        kind: "functional_spec",
        title: "Spectral Cartography Contracts",
        summary:
          "New feature doc for comet-lane survey contracts, scan pings, spectral beacon echoes, route-risk overlays, and hidden salvage pockets.",
        excerpt: featureDoc,
        path: "docs/spectral-cartography-contracts.md",
        relevance: 99,
      },
    ],
    refinement: {
      previousDraft: {
        summary: "Existing starship board.",
        goal: "Complete the MVP slice of THE LAST VECTOR.",
        currentState: "The shell and primary movement cards already exist.",
        targetUser: "Browser action RPG player.",
        qualityBar: "Cards need concrete acceptance criteria and proof expectations.",
        assumptions: ["The selected feature doc is newly added and should be elaborated additively."],
        questions: [],
        sourceNotes: ["Existing board contains shell and controls cards."],
        cards: [
          existingCard({
            sourceId: "synthesis:pixijs-game-shell",
            title: "Create the PixiJS game shell",
            phase: "Foundation",
            labels: ["pixijs", "foundation"],
          }),
          existingCard({
            sourceId: "synthesis:sylvian-ship-controls",
            title: "Implement Sylvian ship with hybrid Newtonian controls",
            phase: "Core Gameplay",
            labels: ["movement"],
            blockedBy: ["synthesis:pixijs-game-shell"],
          }),
        ],
      },
      answers: [
        {
          question: "Add Cards source scope",
          answer:
            "Elaborate only docs/spectral-cartography-contracts.md. This is a newly added feature document. Produce 2-4 additive cards for the mission board, scan ping, route-risk HUD, and proof path. Do not duplicate shell or movement cards.",
        },
        {
          question: "Existing board cards to avoid duplicating",
          answer:
            "1. Create the PixiJS game shell (needs_clarification, phase Foundation)\n2. Implement Sylvian ship with hybrid Newtonian controls (needs_clarification, phase Core Gameplay)",
        },
      ],
    },
    ...input,
  });
  expect(scenario.cardCount).toBeGreaterThanOrEqual(2);
  expect(scenario.cardCount).toBeLessThanOrEqual(5);
  expect(scenario.titles).not.toContain("Create the PixiJS game shell");
  expect(scenario.titles).not.toContain("Implement Sylvian ship with hybrid Newtonian controls");
  expect(`${scenario.titles.join(" ")} ${scenario.notes.join(" ")}`.toLowerCase()).toMatch(/cartograph|scan|spectral|route|contract|beacon/);
  return scenario;
}

async function runSmallProjectSynthesis(input: {
  apiKey: string;
  model: string;
  reasoning?: ProjectBoardSynthesisReasoning;
}): Promise<MatrixScenarioResult> {
  const sources: ProjectBoardSynthesisSource[] = [
    {
      kind: "functional_spec",
      title: "Scottsdale weekend planner",
      summary:
        "Build a tiny browser-only weekend activity planner for Scottsdale, Arizona. Users manually add activities, categorize them as outdoors, food, arts, family, or nightlife, favorite options, and assemble a Saturday/Sunday itinerary.",
      path: "README.md",
      relevance: 95,
    },
    {
      kind: "architecture_artifact",
      title: "Simple local architecture",
      summary:
        "Use one page with a pure itinerary reducer, localStorage persistence, accessible filters, and no backend or live web research in the MVP.",
      path: "docs/architecture.md",
      relevance: 90,
    },
    {
      kind: "implementation_plan",
      title: "Proof policy",
      summary:
        "Start with the shell, activity model, add/edit form, filters, itinerary builder, persistence, and visual proof that the planner is usable on desktop and mobile.",
      path: "docs/plan.md",
      relevance: 89,
    },
  ];
  const scenario = await synthesizeScenario({
    name: "small simple project",
    projectName: "Scottsdale Weekend Planner",
    sources,
    ...input,
  });
  expect(scenario.cardCount).toBeGreaterThanOrEqual(2);
  expect(`${scenario.titles.join(" ")} ${scenario.notes.join(" ")}`.toLowerCase()).toMatch(/planner|activity|itinerary|filter|localstorage|browser/);
  return scenario;
}

async function synthesizeScenario(input: {
  name: string;
  projectName: string;
  apiKey: string;
  model: string;
  sources: ProjectBoardSynthesisSource[];
  refinement?: Parameters<AmbientProjectBoardSynthesisProvider["synthesizeWithTelemetry"]>[0]["refinement"];
  reasoning?: ProjectBoardSynthesisReasoning;
}): Promise<MatrixScenarioResult> {
  const startedAt = Date.now();
  const progressStages: string[] = [];
  const provider = new AmbientProjectBoardSynthesisProvider({
    apiKey: input.apiKey,
    model: input.model,
    reasoning: input.reasoning,
  });
  const result = await provider.synthesizeWithTelemetry({
    projectName: input.projectName,
    sources: input.sources,
    refinement: input.refinement,
    onProgress: (event) => progressStages.push(event.stage),
  });
  const durationMs = Date.now() - startedAt;
  const warningCodes = (result.progressiveRecords ?? []).flatMap((record) => (record.type === "warning" ? [record.code] : []));
  const errorCodes = (result.progressiveRecords ?? []).flatMap((record) => (record.type === "error" ? [record.code] : []));
  const cards = result.draft.cards;
  const proofReadyCardCount = cards.filter(cardHasProof).length;
  const duplicateTitleCount = countDuplicateTitles(cards);
  const notes = [
    result.draft.summary,
    result.draft.goal,
    ...result.draft.sourceNotes.slice(0, 4),
    ...cards.flatMap((card) => [card.description, ...card.sourceRefs]).slice(0, 8),
  ];

  expect(progressStages[0]).toBe("model_request");
  expect(progressStages).toContain("model_response");
  expect(progressStages).toContain("schema_validation");
  expect(cards.length).toBeGreaterThan(0);
  expect(proofReadyCardCount).toBe(cards.length);
  expect(duplicateTitleCount).toBe(0);
  expect(errorCodes.filter((code) => /timeout|idle|stall/i.test(code))).toEqual([]);

  return {
    name: input.name,
    status: "passed",
    durationMs,
    timeToFirstCardMs: durationMs,
    promptCharCount: result.telemetry.promptCharCount,
    responseCharCount: result.telemetry.responseCharCount,
    cardCount: cards.length,
    proofReadyCardCount,
    duplicateTitleCount,
    clarificationQuestionCount: result.draft.questions.length + cards.reduce((sum, card) => sum + (card.clarificationQuestions?.length ?? 0), 0),
    warningCodes,
    errorCodes,
    providerTimeoutObserved: errorCodes.some((code) => /timeout|idle|stall/i.test(code)),
    progressStages,
    sectionCount: result.telemetry.sectionCount,
    failedSectionCount: result.telemetry.failedSectionCount,
    semanticIdleSectionCount: result.telemetry.semanticIdleSectionCount,
    titles: cards.map((card) => card.title),
    notes,
  };
}

function existingCard(input: {
  sourceId: string;
  title: string;
  phase: string;
  labels: string[];
  blockedBy?: string[];
}): ProjectBoardSynthesisCardInput {
  return {
    sourceId: input.sourceId,
    title: input.title,
    description: `Existing board card for ${input.title}.`,
    candidateStatus: "needs_clarification",
    priority: 1,
    phase: input.phase,
    labels: input.labels,
    blockedBy: input.blockedBy ?? [],
    acceptanceCriteria: ["Existing card has already been proposed and should not be duplicated."],
    testPlan: { unit: ["Existing unit proof."], integration: [], visual: [], manual: [] },
    sourceRefs: ["GAME_DESIGN_DOCUMENT.md"],
  };
}

function cardHasProof(card: ProjectBoardSynthesisCardInput): boolean {
  return (
    card.acceptanceCriteria.length > 0 &&
    card.testPlan.unit.length + card.testPlan.integration.length + card.testPlan.visual.length + card.testPlan.manual.length > 0
  );
}

function countDuplicateTitles(cards: ProjectBoardSynthesisCardInput[]): number {
  const counts = new Map<string, number>();
  for (const card of cards) {
    const normalized = card.title.trim().toLowerCase();
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return [...counts.values()].filter((count) => count > 1).reduce((sum, count) => sum + count - 1, 0);
}

function readReleaseMatrixReasoning(): ProjectBoardSynthesisReasoning | undefined {
  const raw = process.env.AMBIENT_PROJECT_BOARD_RELEASE_MATRIX_REASONING?.trim().toLowerCase();
  if (!raw || raw === "default" || raw === "product-default") return undefined;
  if (raw === "false" || raw === "off" || raw === "none" || raw === "no-reasoning") return false;
  const budget = Number(process.env.AMBIENT_PROJECT_BOARD_RELEASE_MATRIX_REASONING_BUDGET || "");
  return {
    effort: raw === "capped-low" ? "low" : raw === "capped-medium" ? "medium" : raw === "capped-high" ? "high" : raw === "xhigh" ? "xhigh" : raw === "high" ? "high" : raw === "medium" ? "medium" : raw === "minimal" ? "minimal" : "low",
    ...(Number.isFinite(budget) && budget > 0 ? { max_tokens: budget } : {}),
    exclude: true,
    enabled: true,
  };
}

function describeReasoning(reasoning: ProjectBoardSynthesisReasoning | undefined): string {
  if (reasoning === undefined) return "product-default";
  if (reasoning === false) return "disabled";
  return JSON.stringify(reasoning);
}

function readLiveAmbientApiKey(): string {
  const explicit = process.env.AMBIENT_API_KEY || process.env.AMBIENT_AGENT_AMBIENT_API_KEY;
  if (explicit?.trim()) return explicit.trim();
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const candidates = [
    process.env.AMBIENT_API_KEY_FILE,
    join(repoRoot, "ignored-provider-key-file.txt"),
    join(dirname(repoRoot), "ignored-provider-key-file.txt"),
    join(dirname(dirname(repoRoot)), "ignored-provider-key-file.txt"),
    "/Users/example/Documents/ambientCoder/ignored-provider-key-file.txt",
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const key = readFileSync(candidate, "utf8").trim();
    if (key) return key;
  }
  throw new Error("Set AMBIENT_API_KEY, AMBIENT_API_KEY_FILE, or place ignored-provider-key-file.txt near the repo.");
}

function readSourceRevision(): { gitHead?: string; dirty?: boolean } {
  try {
    const gitHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const status = execFileSync("git", ["status", "--short", "--untracked-files=no"], { encoding: "utf8" }).trim();
    return { gitHead, dirty: status.length > 0 };
  } catch {
    return {};
  }
}
