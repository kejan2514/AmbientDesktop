import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AmbientProjectBoardSynthesisProvider } from "./projectBoardSynthesisProvider";
import { createProjectBoardPlannerWorkspace } from "./projectBoardPlannerWorkspace";
import type { ProposalJsonlRecordArtifact } from "./projectBoardArtifacts";
import type { ProjectBoardSynthesisSource } from "./projectBoardSynthesis";

const runLive = process.env.AMBIENT_PROJECT_BOARD_PAUSE_RESUME_LIVE === "1";
const liveIt = runLive ? it : it.skip;

describe("project board pause/resume live smoke", () => {
  liveIt(
    "pauses a live planner batch and resumes without duplicate rendered cards",
    async () => {
      const apiKey = readLiveAmbientApiKey();
      const model = process.env.AMBIENT_PROJECT_BOARD_MODEL || process.env.AMBIENT_LIVE_MODEL || "zai-org/GLM-5.1-FP8";
      const startedAt = new Date();
      const workspaceRoot = mkdtempSync(join(process.env.TMPDIR || "/tmp", "ambient-board-pause-resume-live-"));
      try {
        const sources = pauseResumeFixtureSources();
        const provider = new AmbientProjectBoardSynthesisProvider({
          model,
          apiKey,
          reasoning: { effort: "minimal", enabled: true, exclude: true },
        });
        const pausedWorkspace = await createProjectBoardPlannerWorkspace({
          projectPath: workspaceRoot,
          boardId: "board-live-pause-resume",
          runId: "run-live-pause",
          projectName: "Live Pause Resume Board",
          operation: "board_synthesis",
          sources,
        });
        const pauseProgress: string[] = [];
        const pauseBatches: number[] = [];
        const paused = await provider.synthesizePlannerBatchesWithTelemetry({
          projectName: "Live Pause Resume Board",
          sources,
          plannerWorkspace: pausedWorkspace,
          maxBatches: 3,
          maxCardsPerBatch: 2,
          shouldPause: (checkpoint) => checkpoint.phase === "planner_batch" && checkpoint.batchNumber === 1,
          onProgress: (event) => pauseProgress.push(`${event.stage}:${event.title}`),
          onProgressiveRecords: (batch) => pauseBatches.push(batch.records.length),
        });

        const pausedCandidateRecords = candidateRecords(paused.progressiveRecords ?? []);
        expect(paused.telemetry.paused).toBe(true);
        expect(paused.telemetry.partial).toBe(true);
        expect(paused.telemetry.lastValidRecordId).toBeTruthy();
        expect(paused.telemetry.lastValidRecordType).toBeTruthy();
        expect(pausedCandidateRecords.length).toBeGreaterThanOrEqual(1);
        expect(hasPauseCheckpoint(paused.progressiveRecords ?? [])).toBe(true);

        const resumedWorkspace = await createProjectBoardPlannerWorkspace({
          projectPath: workspaceRoot,
          boardId: "board-live-pause-resume",
          runId: "run-live-resume",
          projectName: "Live Pause Resume Board",
          operation: "board_synthesis",
          sources,
        });
        const resumeProgress: string[] = [];
        const resumeContinuation = {
          retryOfRunId: "run-live-pause",
          finishReason: "user_cancelled",
          stopReason: "pause_requested",
          outputTokenBudget: paused.telemetry.outputTokenBudget,
          lastValidRecordId: paused.telemetry.lastValidRecordId!,
          lastValidRecordType: paused.telemetry.lastValidRecordType!,
          originalRecordCount: paused.progressiveRecords?.length ?? 0,
          retainedRecordCount: paused.progressiveRecords?.length ?? 0,
          truncatedToLastValidRecord: true,
        };
        const resumed = await provider.synthesizePlannerBatchesWithTelemetry({
          projectName: "Live Pause Resume Board",
          sources,
          plannerWorkspace: resumedWorkspace,
          maxBatches: 3,
          maxCardsPerBatch: 2,
          resumeFromRecords: paused.progressiveRecords ?? [],
          resumeContinuation,
          onProgress: (event) => {
            if (event.metadata?.plannerContinuation) resumeProgress.push("continuation");
            resumeProgress.push(`${event.stage}:${event.title}`);
          },
        });

        const resumedCandidateRecords = candidateRecords(resumed.progressiveRecords ?? []);
        const noDuplicateSourceIds = duplicateValues(resumed.draft.cards.map((card) => card.sourceId)).length === 0;
        const noDuplicateTitles = duplicateValues(resumed.draft.cards.map((card) => normalizeTitle(card.title))).length === 0;
        const observations = {
          pauseObserved: paused.telemetry.paused === true,
          pauseCheckpointObserved: hasPauseCheckpoint(paused.progressiveRecords ?? []),
          resumeObserved: resumed.telemetry.paused !== true && resumed.draft.cards.length >= paused.draft.cards.length,
          continuationPromptObserved: resumeProgress.includes("continuation"),
          noDuplicateCardsObserved: noDuplicateSourceIds && noDuplicateTitles,
          pausedCardCount: paused.draft.cards.length,
          resumedCardCount: resumed.draft.cards.length,
          pausedCandidateRecordCount: pausedCandidateRecords.length,
          resumedCandidateRecordCount: resumedCandidateRecords.length,
          renderedCardDuplicateFilterCount: resumed.telemetry.renderedCardDuplicateFilterCount ?? 0,
          pauseProgressEventCount: pauseProgress.length,
          pauseProgressiveBatchCount: pauseBatches.length,
          resumeProgressEventCount: resumeProgress.length,
          pausedPlannerBatchCount: paused.telemetry.plannerBatchCount,
          resumedPlannerBatchCount: resumed.telemetry.plannerBatchCount,
        };
        const report = {
          status:
            observations.pauseObserved &&
            observations.pauseCheckpointObserved &&
            observations.resumeObserved &&
            observations.continuationPromptObserved &&
            observations.noDuplicateCardsObserved
              ? "passed"
              : "attention",
          generatedAt: new Date().toISOString(),
          startedAt: startedAt.toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt.getTime(),
          model,
          sourceRevision: readSourceRevision(),
          fixture: "provider-level live Pi planner-batch pause/resume",
          observations,
          pausedTitles: paused.draft.cards.map((card) => card.title),
          resumedTitles: resumed.draft.cards.map((card) => card.title),
        };
        const outputPath = resolve(
          process.env.AMBIENT_PROJECT_BOARD_PAUSE_RESUME_GATE_OUT ||
            join(dirname(fileURLToPath(import.meta.url)), "../../test-results/project-board-release-matrix/latest-pause-resume.json"),
        );
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");
        console.info(`[project-board-pause-resume-live] ${JSON.stringify({ outputPath, status: report.status, observations })}`);

        expect(report.status).toBe("passed");
        expect(resumed.draft.cards.length).toBeGreaterThanOrEqual(paused.draft.cards.length);
        expect(noDuplicateSourceIds).toBe(true);
        expect(noDuplicateTitles).toBe(true);
      } finally {
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    },
    360_000,
  );
});

function pauseResumeFixtureSources(): ProjectBoardSynthesisSource[] {
  return [
    {
      id: "source-kanban-shell",
      kind: "functional_spec",
      title: "Kanban board shell",
      summary: "Build a small web kanban board with Backlog, Doing, Review, and Done columns plus a visible empty state.",
      path: "docs/kanban-shell.md",
      relevance: 98,
    },
    {
      id: "source-card-editing",
      kind: "functional_spec",
      title: "Card editing workflow",
      summary: "Users can create, rename, delete, and annotate cards. The first pass should keep state local and test pure reducers.",
      path: "docs/card-editing.md",
      relevance: 96,
    },
    {
      id: "source-drag-drop",
      kind: "architecture_artifact",
      title: "Drag and keyboard movement",
      summary: "Cards move between columns through drag-and-drop and keyboard actions with accessible status announcements.",
      path: "docs/drag-keyboard.md",
      relevance: 94,
    },
    {
      id: "source-persistence",
      kind: "implementation_plan",
      title: "Local persistence",
      summary: "Persist board state to local storage, recover from malformed saved data, and expose import/export proof hooks.",
      path: "docs/persistence.md",
      relevance: 92,
    },
  ];
}

function candidateRecords(records: ProposalJsonlRecordArtifact[]): ProposalJsonlRecordArtifact[] {
  return records.filter((record) => record.type === "candidate_card");
}

function hasPauseCheckpoint(records: ProposalJsonlRecordArtifact[]): boolean {
  return records.some((record) => {
    if (record.type !== "progress") return false;
    const metadata = record.metadata;
    return Boolean(
      metadata &&
        typeof metadata === "object" &&
        !Array.isArray(metadata) &&
        metadata.stopReason === "pause_requested" &&
        metadata.recoverableOutputStop === true,
    );
  });
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function normalizeTitle(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
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
