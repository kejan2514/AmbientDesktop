#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyWorkflowCompilerLiveBenchmarkAttempt } from "./workflow-compiler-live-benchmark-lib.mjs";
import {
  workflowUiDogfoodSnapshotPreflight,
  workflowUiDogfoodSnapshotPreflightErrorMessage,
} from "./workflow-ui-dogfood-contract.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const DEFAULT_OUTPUT_DIR = join(repoRoot, "test-results", "workflow-jitter-matrix");
const DEFAULT_TIMEOUT_MS = 900_000;
const DEFAULT_RETRY_BASE_MS = 5_000;

const PROFILE_TASKS = {
  "phase8-smoke": [
    "model-tolerance-mock",
    "workflow-ir-path-jitter",
    "workflow-path-registry-jitter",
    "workflow-ui-comprehension",
    "workflow-program-core",
  ],
  "phase8-live-smoke": [
    "model-tolerance-mock",
    "workflow-ir-path-jitter",
    "workflow-path-registry-jitter",
    "workflow-ui-comprehension",
    "workflow-program-core",
    "ui-dogfood-vocabulary-quiz",
  ],
  release: [
    "model-tolerance-mock",
    "model-tolerance-live-compile-prompts",
    "workflow-ir-path-jitter",
    "workflow-path-registry-jitter",
    "workflow-ui-comprehension",
    "workflow-program-core",
    "ui-dogfood-vocabulary-quiz",
    "ui-dogfood-local-file-classifier",
    "ui-dogfood-public-source-browser",
    "ui-dogfood-downloads-document-categorization",
    "ui-dogfood-gmail-20-metadata-readonly-validation",
    "ui-dogfood-current-web-recipe-report",
    "ui-dogfood-flaky-browser-recovery",
    "ui-dogfood-vocabulary-quiz-repeat-2",
    "ui-dogfood-local-file-classifier-repeat-2",
    "ui-dogfood-public-source-browser-repeat-2",
  ],
};

export function defaultWorkflowJitterMatrixTasks() {
  return [
    {
      id: "model-tolerance-mock",
      label: "Model tolerance mock jitter",
      axis: "prompt",
      tier: "deterministic",
      command: process.execPath,
      args: [
        "scripts/workflow-model-tolerance-lab.mjs",
        "--mock",
        "--seeds=2",
        "--concurrency=4",
        "--promotion-gate",
        "--min-cases=10",
        "--markdown-case-filter=failures",
      ],
      deterministicStressUnits: 10,
      timeoutMs: 180_000,
    },
    modelToleranceLiveTask(),
    {
      id: "workflow-ir-path-jitter",
      label: "Workflow IR path jitter",
      axis: "ir",
      tier: "deterministic",
      command: "pnpm",
      args: ["run", "test:workflow-ir-path-jitter"],
      exclusiveGroup: "workflow-vitest",
      deterministicStressUnits: 1_560,
      timeoutMs: 240_000,
    },
    {
      id: "workflow-path-registry-jitter",
      label: "Workflow path registry jitter",
      axis: "ir",
      tier: "deterministic",
      command: "pnpm",
      args: ["run", "test:workflow-path-registry-jitter"],
      exclusiveGroup: "workflow-vitest",
      deterministicStressUnits: 500,
      timeoutMs: 240_000,
    },
    {
      id: "workflow-ui-comprehension",
      label: "Workflow UI comprehension models",
      axis: "ui_state",
      tier: "deterministic",
      command: "pnpm",
      args: [
        "exec",
        "vitest",
        "run",
        "src/renderer/src/workflowCompileActivityUiModel.test.ts",
        "src/renderer/src/workflowAgentGraphUiModel.test.ts",
        "src/renderer/src/workflowDiagramViewportUiModel.test.ts",
        "src/renderer/src/workflowPersistentStatusUiModel.test.ts",
      ],
      exclusiveGroup: "workflow-vitest",
      deterministicStressUnits: 4,
      timeoutMs: 240_000,
    },
    {
      id: "workflow-program-core",
      label: "Workflow compiler path contract core",
      axis: "compiler",
      tier: "deterministic",
      command: "pnpm",
      args: [
        "exec",
        "vitest",
        "run",
        "src/main/workflow-program/workflowProgramCompiler.test.ts",
        "src/main/workflow-program/workflowProgramCompilerConnectors.test.ts",
        "src/main/workflow-program/workflowProgramPathRegistry.test.ts",
        "src/main/workflow-program/workflowProgramPathRegistryJitter.test.ts",
        "src/main/workflow-program/workflowProgramOutputContracts.test.ts",
        "src/main/workflow-program/workflowProgramOutputContractJitter.test.ts",
      ],
      exclusiveGroup: "workflow-vitest",
      deterministicStressUnits: 5,
      timeoutMs: 360_000,
    },
    liveUiDogfoodTask("ui-dogfood-vocabulary-quiz", "vocabulary-quiz", "Model-only vocabulary workflow UI dogfood", "model-only"),
    liveUiDogfoodTask("ui-dogfood-local-file-classifier", "local-file-classifier", "Local file classifier workflow UI dogfood", "local"),
    liveUiDogfoodTask("ui-dogfood-public-source-browser", "public-source-browser", "Public source browser workflow UI dogfood", "browser"),
    liveUiDogfoodTask(
      "ui-dogfood-downloads-document-categorization",
      "downloads-document-categorization",
      "Downloads document categorization workflow UI dogfood",
      "document",
    ),
    liveUiDogfoodTask(
      "ui-dogfood-gmail-20-metadata-readonly-validation",
      "gmail-20-metadata-readonly-validation",
      "Gmail metadata read-only validation workflow UI dogfood",
      "connector",
    ),
    liveUiDogfoodTask(
      "ui-dogfood-current-web-recipe-report",
      "current-web-recipe-report",
      "Current web recipe report workflow UI dogfood",
      "browser",
    ),
    liveUiDogfoodTask(
      "ui-dogfood-flaky-browser-recovery",
      "flaky-browser-recovery",
      "Flaky browser recovery workflow UI dogfood",
      "recovery",
    ),
    liveUiDogfoodTask(
      "ui-dogfood-vocabulary-quiz-repeat-2",
      "vocabulary-quiz",
      "Model-only vocabulary workflow UI dogfood repeat",
      "model-only",
    ),
    liveUiDogfoodTask(
      "ui-dogfood-local-file-classifier-repeat-2",
      "local-file-classifier",
      "Local file classifier workflow UI dogfood repeat",
      "local",
    ),
    liveUiDogfoodTask(
      "ui-dogfood-public-source-browser-repeat-2",
      "public-source-browser",
      "Public source browser workflow UI dogfood repeat",
      "browser",
    ),
  ];
}

export function resolveWorkflowJitterMatrixTasks(input = {}) {
  const allTasks = input.tasks ?? defaultWorkflowJitterMatrixTasks();
  const taskIds = normalizeIds(input.taskIds);
  const profile = input.profile ?? "phase8-smoke";
  const includeLive = input.includeLive === true;
  let selectedIds = taskIds;
  if (!selectedIds.length) {
    const profileIds = PROFILE_TASKS[profile];
    if (!profileIds) {
      throw new Error(`Unknown workflow jitter matrix profile "${profile}". Known profiles: ${Object.keys(PROFILE_TASKS).join(", ")}`);
    }
    selectedIds = includeLive && profile === "phase8-smoke" ? PROFILE_TASKS["phase8-live-smoke"] : profileIds;
  }
  const byId = new Map(allTasks.map((task) => [task.id, task]));
  const selected = [];
  const missing = [];
  for (const id of selectedIds) {
    const task = byId.get(id);
    if (task) selected.push(task);
    else missing.push(id);
  }
  if (missing.length) {
    throw new Error(`Unknown workflow jitter matrix task(s): ${missing.join(", ")}. Known tasks: ${allTasks.map((task) => task.id).join(", ")}`);
  }
  return selected;
}

export function classifyWorkflowJitterMatrixAttempt(input) {
  const classification = classifyWorkflowCompilerLiveBenchmarkAttempt(input);
  if (classification.status === "skipped") {
    return {
      ...classification,
      status: "environment_skipped",
      reason: classification.reason ?? "The task could not run in this environment.",
    };
  }
  return classification;
}

export async function runWorkflowJitterMatrix(input = {}) {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const runId = input.runId ? safeFilePart(input.runId) : workflowJitterMatrixRunId(generatedAt);
  const tasks = input.tasks ?? resolveWorkflowJitterMatrixTasks(input);
  const startedAtMs = nowMs();
  const concurrency = clampConcurrency(input.concurrency ?? 2);
  const retries = Math.max(0, Math.floor(input.retries ?? 0));
  const pending = tasks.map((task, index) => ({ task, index }));
  const results = new Array(tasks.length);
  const activeGroups = new Set();
  const waiters = [];
  let completed = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, tasks.length)) }, async () => {
      for (;;) {
        const item = takeRunnableTask(pending, activeGroups);
        if (!item) {
          if (completed >= tasks.length) return;
          await waitForTaskSlot(waiters);
          continue;
        }
        const group = item.task.exclusiveGroup;
        if (group) activeGroups.add(group);
        try {
          results[item.index] = await runWorkflowJitterMatrixTask(item.task, {
            ...input,
            generatedAt,
            runId,
            retries,
          });
        } finally {
          if (group) activeGroups.delete(group);
          completed += 1;
          notifyTaskSlot(waiters);
        }
      }
    }),
  );

  const taskResults = results.filter(Boolean);
  const passedTasks = taskResults.filter((result) => result.status === "passed");
  const sourceRevision = input.sourceRevision ?? await readWorkflowJitterMatrixSourceRevision(input.cwd ?? repoRoot);
  const summary = {
    schemaVersion: 1,
    runId,
    generatedAt,
    sourceRevision,
    profile: input.profile ?? "phase8-smoke",
    totalWallClockMs: roundMs(nowMs() - startedAtMs),
    concurrency,
    retryLimit: retries,
    taskCount: taskResults.length,
    deterministicCount: taskResults.filter((result) => result.tier === "deterministic").length,
    liveCount: taskResults.filter((result) => result.tier === "live").length,
    deterministicStressUnitCount: sumTaskUnits(passedTasks, "deterministicStressUnits"),
    livePromptVariantCount: sumTaskUnits(passedTasks, "livePromptVariantUnits"),
    liveDogfoodRunCount: sumTaskUnits(passedTasks, "liveDogfoodRunUnits"),
    liveFamilies: Array.from(new Set(passedTasks.map((result) => result.liveFamily).filter(Boolean))).sort(),
    passedCount: taskResults.filter((result) => result.status === "passed").length,
    providerDegradedCount: taskResults.filter((result) => result.status === "provider_degraded").length,
    environmentSkippedCount: taskResults.filter((result) => result.status === "environment_skipped").length,
    productOrTestFailureCount: taskResults.filter((result) => result.status === "product_or_test_failure").length,
    environmentBlockers: workflowJitterMatrixEnvironmentBlockers(taskResults),
    tasks: taskResults,
  };
  const paths = input.outputDir === false ? undefined : await writeWorkflowJitterMatrixReport(summary, input.outputDir ?? DEFAULT_OUTPUT_DIR);
  return { summary, paths };
}

export function workflowJitterMatrixExitCode(summary, options = {}) {
  if (summary.productOrTestFailureCount > 0) return 1;
  const deterministicNonPass = (summary.tasks ?? []).some(
    (task) => task.tier === "deterministic" && task.status !== "passed",
  );
  if (deterministicNonPass) return 1;
  if (options.promotionGate && (summary.providerDegradedCount > 0 || summary.environmentSkippedCount > 0 || summary.passedCount < summary.taskCount)) return 1;
  if (options.requireLive) {
    const liveTasks = (summary.tasks ?? []).filter((task) => task.tier === "live");
    if (!liveTasks.length || liveTasks.some((task) => task.status !== "passed")) return 1;
  }
  return 0;
}

export async function writeWorkflowJitterMatrixReport(summary, outputDir = DEFAULT_OUTPUT_DIR) {
  await mkdir(outputDir, { recursive: true });
  const fingerprintHistoryPath = join(outputDir, "failure-fingerprints.jsonl");
  const previousFingerprintCounts = await readWorkflowJitterMatrixFailureFingerprintCounts(fingerprintHistoryPath);
  summary.promotionCandidates = buildWorkflowJitterMatrixPromotionCandidates(summary, previousFingerprintCounts);
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  const markdown = renderWorkflowJitterMatrixMarkdown(summary);
  const latestJsonPath = join(outputDir, "latest.json");
  const latestMarkdownPath = join(outputDir, "latest.md");
  const runPaths = await writeImmutableWorkflowJitterMatrixReport(outputDir, summary.runId, json, markdown);
  const historyPath = join(outputDir, "history.jsonl");
  const promotionCandidatePaths = await writeWorkflowJitterMatrixPromotionCandidates(summary, outputDir);
  await Promise.all([
    writeFile(latestJsonPath, json, "utf8"),
    writeFile(latestMarkdownPath, markdown, "utf8"),
    appendFile(historyPath, `${JSON.stringify(workflowJitterMatrixHistoryEntry(summary, { ...runPaths, latestJsonPath, latestMarkdownPath, promotionCandidatePaths }))}\n`, "utf8"),
    appendWorkflowJitterMatrixFailureFingerprints(summary, fingerprintHistoryPath),
  ]);
  return { latestJsonPath, latestMarkdownPath, historyPath, fingerprintHistoryPath, promotionCandidatePaths, ...runPaths };
}

export function renderWorkflowJitterMatrixMarkdown(summary) {
  const lines = [
    "# Workflow Jitter Matrix",
    "",
    `Generated: ${summary.generatedAt}`,
    `Run: ${summary.runId}`,
    `Source revision: ${summary.sourceRevision?.gitHead ?? "unknown"}${summary.sourceRevision?.dirty ? " (tracked dirty)" : ""}`,
    `Profile: ${summary.profile}`,
    `Concurrency: ${summary.concurrency}`,
    `Retry limit: ${summary.retryLimit}`,
    `Wall clock: ${formatMs(summary.totalWallClockMs)}ms`,
    "",
    "## Summary",
    "",
    `- Tasks: ${summary.passedCount}/${summary.taskCount} passed`,
    `- Deterministic tasks: ${summary.deterministicCount}`,
    `- Live tasks: ${summary.liveCount}`,
    `- Passed deterministic stress units: ${summary.deterministicStressUnitCount ?? 0}`,
    `- Passed live prompt variants: ${summary.livePromptVariantCount ?? 0}`,
    `- Passed live dogfood runs: ${summary.liveDogfoodRunCount ?? 0}`,
    `- Passed live families: ${(summary.liveFamilies ?? []).join(", ") || "none"}`,
    `- Provider-degraded/inconclusive: ${summary.providerDegradedCount}`,
    `- Environment skipped: ${summary.environmentSkippedCount}`,
    `- Environment blockers: ${(summary.environmentBlockers ?? []).length}`,
    `- Product or test failures: ${summary.productOrTestFailureCount}`,
    `- Promotion candidates: ${(summary.promotionCandidates ?? []).length}`,
    "",
    "| Task | Tier | Axis | Family | Units | Status | Provider health | Attempts | Total ms | Reason | Logs |",
    "| --- | --- | --- | --- | ---: | --- | --- | ---: | ---: | --- | --- |",
    ...summary.tasks.map((task) =>
      `| ${[
        escapeMarkdownCell(task.label),
        task.tier,
        task.axis,
        task.liveFamily ?? "",
        String(task.deterministicStressUnits ?? task.livePromptVariantUnits ?? task.liveDogfoodRunUnits ?? ""),
        task.status,
        task.providerHealth,
        String((task.attempts ?? []).length),
        formatMs(task.totalWallClockMs),
        escapeMarkdownCell(task.reason),
        (task.attempts ?? []).map((attempt) => attempt.logPath).filter(Boolean).map((logPath) => `\`${logPath}\``).join("<br>"),
      ].join(" | ")} |`,
    ),
    "",
  ];
  if ((summary.environmentBlockers ?? []).length) {
    lines.push("## Environment Blockers", "");
    lines.push("| Blocker | Affected tasks | Next step | Snapshot preflight |");
    lines.push("| --- | ---: | --- | --- |");
    for (const blocker of summary.environmentBlockers) {
      lines.push(
        `| ${[
          escapeMarkdownCell(`${blocker.kind}: ${blocker.summary}`),
          String(blocker.affectedTaskCount ?? blocker.taskIds?.length ?? 0),
          escapeMarkdownCell(blocker.nextStep),
          escapeMarkdownCell(workflowJitterMatrixPreflightMarkdown(blocker.preflight)),
        ].join(" | ")} |`,
      );
    }
    lines.push("");
  }
  lines.push("## Task Details", "");
  if ((summary.promotionCandidates ?? []).length) {
    lines.push("## Promotion Candidates", "");
    lines.push("| Candidate | Task | Status | Recurrence | Suggested fixture | Next action |");
    lines.push("| --- | --- | --- | ---: | --- | --- |");
    for (const candidate of summary.promotionCandidates) {
      lines.push(
        `| ${[
          candidate.id,
          escapeMarkdownCell(candidate.taskLabel),
          candidate.status,
          String(candidate.recurrenceCount),
          `\`${candidate.suggestedFixture}\``,
          escapeMarkdownCell(candidate.nextAction),
        ].join(" | ")} |`,
      );
    }
    lines.push("");
  }
  for (const task of summary.tasks) {
    lines.push(
      ...[
      `### ${task.label}`,
      "",
      `- id: ${task.id}`,
      `- tier: ${task.tier}`,
      `- axis: ${task.axis}`,
      task.liveFamily ? `- live family: ${task.liveFamily}` : undefined,
      task.deterministicStressUnits ? `- deterministic stress units: ${task.deterministicStressUnits}` : undefined,
      task.livePromptVariantUnits ? `- live prompt variants: ${task.livePromptVariantUnits}` : undefined,
      task.liveDogfoodRunUnits ? `- live dogfood run units: ${task.liveDogfoodRunUnits}` : undefined,
      `- command: \`${[task.command, ...(task.args ?? [])].join(" ")}\``,
      `- status: ${task.status}`,
      `- provider health: ${task.providerHealth}`,
      `- reason: ${task.reason}`,
      task.environmentBlocker ? `- environment blocker: ${task.environmentBlocker.kind}; ${task.environmentBlocker.nextStep}` : undefined,
      task.environmentBlocker?.preflight ? `- snapshot preflight: ${workflowJitterMatrixPreflightMarkdown(task.environmentBlocker.preflight)}` : undefined,
      "",
      ].filter(Boolean),
    );
    for (const attempt of task.attempts ?? []) {
      lines.push(
        `- attempt ${attempt.attempt}: ${attempt.status}; exit=${attempt.exitCode ?? "signal"}; duration=${formatMs(attempt.durationMs)}ms; stdout=${attempt.stdoutChars}; stderr=${attempt.stderrChars}${attempt.logPath ? `; log=\`${attempt.logPath}\`` : ""}`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

function workflowJitterMatrixPreflightMarkdown(preflight) {
  if (!preflight) return "none";
  return [
    `status=${preflight.status ?? "missing"}`,
    `source=${preflight.selectedRootSource ?? "missing"}`,
    `label=${preflight.snapshotRootLabel ?? "missing"}`,
    `digest=${preflight.snapshotRootPathDigest ?? "missing"}`,
    `candidates=${(preflight.candidateRoots ?? []).length}`,
  ].join("; ");
}

export function buildWorkflowJitterMatrixPromotionCandidates(summary, previousFingerprintCounts = {}) {
  return (summary.tasks ?? [])
    .filter((task) => task.status === "product_or_test_failure")
    .map((task) => {
      const fingerprint = workflowJitterMatrixFailureFingerprint(task);
      const recurrenceCount = (previousFingerprintCounts[fingerprint] ?? 0) + 1;
      const id = safeFilePart(`${task.id}-${fingerprint.slice(0, 12)}`);
      return {
        id,
        fingerprint,
        taskId: task.id,
        taskLabel: task.label,
        tier: task.tier,
        axis: task.axis,
        status: task.status,
        providerHealth: task.providerHealth,
        matchedPattern: task.matchedPattern,
        reason: task.reason,
        recurrenceCount,
        priority: recurrenceCount >= 2 ? "promote" : "watch",
        suggestedFixture: suggestedWorkflowJitterMatrixFixturePath(task),
        suggestedArtifact: `test-results/workflow-jitter-matrix/promotion-candidates/${id}.md`,
        suggestedJsonArtifact: `test-results/workflow-jitter-matrix/promotion-candidates/${id}.json`,
        nextAction:
          recurrenceCount >= 2
            ? "Promote this recurring live/product failure into a deterministic regression before closing Phase 8."
            : "Watch for recurrence; promote if this fingerprint appears again.",
        command: [task.command, ...(task.args ?? [])].join(" "),
        replay: workflowJitterMatrixFailureReplay(summary, task, id),
        evidence: {
          attempts: (task.attempts ?? []).map((attempt) => ({
            attempt: attempt.attempt,
            status: attempt.status,
            exitCode: attempt.exitCode,
            signal: attempt.signal,
            timedOut: attempt.timedOut,
            durationMs: attempt.durationMs,
            logPath: attempt.logPath,
          })),
        },
      };
    });
}

async function runWorkflowJitterMatrixTask(task, input) {
  const startedAtMs = nowMs();
  const environmentBlocker = workflowJitterMatrixTaskEnvironmentBlocker(task, input);
  if (environmentBlocker) {
    return workflowJitterMatrixSkippedTaskResult(task, {
      startedAtMs,
      environmentBlocker,
    });
  }
  const attempts = [];
  const maxAttempts = (input.retries ?? 0) + 1;
  let finalClassification;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    input.log?.(`[workflow-jitter-matrix] ${task.id} attempt ${attempt}/${maxAttempts} started`);
    const attemptResult = await runWorkflowJitterMatrixAttempt(task, { ...input, attempt });
    attempts.push(attemptResult);
    finalClassification = attemptResult.classification;
    input.log?.(`[workflow-jitter-matrix] ${task.id} attempt ${attempt}/${maxAttempts} ${finalClassification.status}: ${finalClassification.reason}`);
    if (!finalClassification.retryable || attempt >= maxAttempts) break;
    await (input.sleep ?? sleep)(retryDelayMs(attempt, input.retryBaseMs));
  }
  const classification = finalClassification ?? {
    status: "product_or_test_failure",
    providerHealth: "unknown",
    retryable: false,
    reason: "No attempt result was recorded.",
  };
  return {
    id: task.id,
    label: task.label,
    axis: task.axis,
    tier: task.tier,
    deterministicStressUnits: task.deterministicStressUnits,
    livePromptVariantUnits: task.livePromptVariantUnits,
    liveDogfoodRunUnits: task.liveDogfoodRunUnits,
    liveFamily: task.liveFamily,
    command: task.command,
    args: task.args,
    envKeys: Object.keys(task.env ?? {}).sort(),
    status: classification.status,
    providerHealth: classification.providerHealth,
    reason: classification.reason,
    matchedPattern: classification.matchedPattern,
    environmentBlocker: workflowJitterMatrixEnvironmentBlockerFromClassification(classification),
    totalWallClockMs: roundMs(nowMs() - startedAtMs),
    attempts,
  };
}

function workflowJitterMatrixSkippedTaskResult(task, input) {
  return {
    id: task.id,
    label: task.label,
    axis: task.axis,
    tier: task.tier,
    deterministicStressUnits: task.deterministicStressUnits,
    livePromptVariantUnits: task.livePromptVariantUnits,
    liveDogfoodRunUnits: task.liveDogfoodRunUnits,
    liveFamily: task.liveFamily,
    command: task.command,
    args: task.args,
    envKeys: Object.keys(task.env ?? {}).sort(),
    status: "environment_skipped",
    providerHealth: "unknown",
    reason: input.environmentBlocker.summary,
    matchedPattern: input.environmentBlocker.kind,
    environmentBlocker: input.environmentBlocker,
    totalWallClockMs: roundMs(nowMs() - input.startedAtMs),
    attempts: [],
  };
}

function workflowJitterMatrixTaskEnvironmentBlocker(task, input) {
  if (!workflowJitterMatrixTaskUsesWorkflowUiDogfood(task)) return undefined;
  const env = { ...process.env, ...(input.env ?? {}), ...(task.env ?? {}) };
  const preflight = workflowUiDogfoodSnapshotPreflight({ env, homeDir: input.homeDir });
  if (!preflight.requested || preflight.ok) return undefined;
  const message = workflowUiDogfoodSnapshotPreflightErrorMessage(preflight);
  return {
    kind: "credentialed_snapshot_missing",
    summary: `Credentialed workflow UI dogfood snapshot unavailable: ${message}`,
    nextStep:
      "Set AMBIENT_WORKFLOW_UI_DOGFOOD_SNAPSHOT_ROOT or AMBIENT_SHARED_SECRETS_SNAPSHOT_ROOT to a valid credentialed snapshot copy, then rerun the workflow jitter release profile.",
    preflight,
  };
}

function workflowJitterMatrixTaskUsesWorkflowUiDogfood(task) {
  return (task.args ?? []).some((arg) => String(arg).includes("workflow-agent-thread-ui-dogfood.mjs"));
}

function workflowJitterMatrixEnvironmentBlockerFromClassification(classification) {
  if (classification?.status !== "environment_skipped" || classification?.matchedPattern !== "credentialed_snapshot_missing") return undefined;
  return {
    kind: "credentialed_snapshot_missing",
    summary: classification.reason,
    nextStep:
      "Set AMBIENT_WORKFLOW_UI_DOGFOOD_SNAPSHOT_ROOT or AMBIENT_SHARED_SECRETS_SNAPSHOT_ROOT to a valid credentialed snapshot copy, then rerun the workflow jitter release profile.",
  };
}

function workflowJitterMatrixEnvironmentBlockers(taskResults) {
  const blockers = new Map();
  for (const task of taskResults) {
    const blocker = task.environmentBlocker;
    if (!blocker?.kind) continue;
    const key = `${blocker.kind}:${blocker.preflight?.snapshotRootPathDigest ?? ""}`;
    const existing = blockers.get(key);
    const taskRef = {
      id: task.id,
      label: task.label,
      liveFamily: task.liveFamily,
      status: task.status,
    };
    if (existing) {
      existing.taskIds.push(task.id);
      existing.tasks.push(taskRef);
      existing.affectedTaskCount += 1;
    } else {
      blockers.set(key, {
        kind: blocker.kind,
        summary: blocker.summary,
        nextStep: blocker.nextStep,
        taskIds: [task.id],
        tasks: [taskRef],
        affectedTaskCount: 1,
        preflight: blocker.preflight,
      });
    }
  }
  return Array.from(blockers.values());
}

async function runWorkflowJitterMatrixAttempt(task, input) {
  const startedAtMs = nowMs();
  const runCommand = input.runCommand ?? runCommandCapture;
  const commandResult = await runCommand({
    command: task.command,
    args: task.args,
    cwd: input.cwd ?? repoRoot,
    env: { ...process.env, ...(input.env ?? {}), ...(task.env ?? {}) },
    timeoutMs: task.timeoutMs ?? input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  const durationMs = roundMs(nowMs() - startedAtMs);
  const classification = classifyWorkflowJitterMatrixAttempt(commandResult);
  const logPath =
    input.outputDir === false
      ? undefined
      : await writeAttemptLog({
          outputDir: input.outputDir ?? DEFAULT_OUTPUT_DIR,
          runId: input.runId,
          task,
          attempt: input.attempt,
          commandResult,
          classification,
        });
  return {
    attempt: input.attempt,
    exitCode: commandResult.exitCode,
    signal: commandResult.signal,
    timedOut: Boolean(commandResult.timedOut),
    durationMs,
    stdoutChars: commandResult.stdout?.length ?? 0,
    stderrChars: commandResult.stderr?.length ?? 0,
    status: classification.status,
    classification,
    logPath,
  };
}

function modelToleranceLiveTask() {
  return {
    id: "model-tolerance-live-compile-prompts",
    label: "Live workflow compile prompt tolerance",
    axis: "prompt",
    tier: "live",
    command: process.execPath,
    args: [
      "scripts/workflow-model-tolerance-lab.mjs",
      "--live",
      "--require-live",
      "--seeds=24",
      "--concurrency=2",
      "--stop-after-failures=1",
      "--promotion-gate",
      "--min-cases=120",
      "--markdown-case-filter=failures",
    ],
    env: {
      AMBIENT_PROVIDER: "gmi-cloud",
      GMI_CLOUD_API_KEY_FILE: resolveGmiCloudKeyFileForChildEnv(),
    },
    livePromptVariantUnits: 120,
    liveFamily: "model-only",
    exclusiveGroup: "workflow-model-tolerance-live",
    timeoutMs: 1_800_000,
  };
}

function liveUiDogfoodTask(id, scenario, label, liveFamily) {
  return {
    id,
    label,
    axis: "ui_state",
    tier: "live",
    command: process.execPath,
    args: ["scripts/workflow-agent-thread-ui-dogfood.mjs", `--scenario=${scenario}`],
    env: {
      AMBIENT_PROVIDER: "gmi-cloud",
      AMBIENT_WORKFLOW_UI_DOGFOOD_USE_SHARED_SNAPSHOT: "1",
      AMBIENT_WORKFLOW_UI_DOGFOOD_PERMISSION_MODE: "full-access",
      AMBIENT_WORKFLOW_UI_DOGFOOD_TIMEOUT_MS: "900000",
      AMBIENT_WORKFLOW_UI_DOGFOOD_STEP_TIMEOUT_MS: "600000",
      GMI_CLOUD_API_KEY_FILE: resolveGmiCloudKeyFileForChildEnv(),
    },
    liveDogfoodRunUnits: 1,
    liveFamily,
    exclusiveGroup: "workflow-ui-dogfood",
    timeoutMs: 900_000,
  };
}

export function resolveGmiCloudKeyFileForChildEnv(input = {}) {
  const env = input.env ?? process.env;
  const root = input.repoRoot ?? repoRoot;
  const home = input.homeDir ?? homedir();
  const fileExists = input.existsSync ?? existsSync;
  if (env.GMI_CLOUD_API_KEY_FILE) return env.GMI_CLOUD_API_KEY_FILE;
  const candidates = [
    join(root, "ignored-provider-key-file.txt"),
    join(dirname(root), "ignored-provider-key-file.txt"),
    join(dirname(root), "ambientCoder", "ignored-provider-key-file.txt"),
    join(home, "ambientCoder", "ignored-provider-key-file.txt"),
    join(home, "Documents", "ambientCoder", "ignored-provider-key-file.txt"),
  ];
  return candidates.find((candidate) => fileExists(candidate)) ?? join(root, "ignored-provider-key-file.txt");
}

function sumTaskUnits(tasks, field) {
  return tasks.reduce((total, task) => total + (Number(task[field]) || 0), 0);
}

function takeRunnableTask(pending, activeGroups) {
  for (let index = 0; index < pending.length; index += 1) {
    const item = pending[index];
    const group = item.task.exclusiveGroup;
    if (group && activeGroups.has(group)) continue;
    pending.splice(index, 1);
    return item;
  }
  return undefined;
}

function waitForTaskSlot(waiters) {
  return new Promise((resolve) => waiters.push(resolve));
}

function notifyTaskSlot(waiters) {
  const queued = waiters.splice(0);
  for (const resolve of queued) resolve();
}

function runCommandCapture(input) {
  return new Promise((resolve) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref();
    child.stdout?.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        signal: undefined,
        timedOut,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        error: error instanceof Error ? error.message : String(error),
      });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        timedOut,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

async function readWorkflowJitterMatrixSourceRevision(cwd) {
  try {
    const [gitHead, status] = await Promise.all([
      execFileText("git", ["rev-parse", "HEAD"], cwd),
      execFileText("git", ["status", "--short", "--untracked-files=no"], cwd),
    ]);
    return {
      gitHead: gitHead.trim(),
      dirty: status.trim().length > 0,
    };
  } catch {
    return {};
  }
}

function execFileText(commandName, args, cwd) {
  return new Promise((resolveText, rejectText) => {
    execFile(commandName, args, { cwd, encoding: "utf8" }, (error, stdout) => {
      if (error) rejectText(error);
      else resolveText(stdout);
    });
  });
}

async function writeAttemptLog(input) {
  const runId = safeFilePart(input.runId ?? "manual-run");
  const logDir = join(input.outputDir, "logs", runId);
  await mkdir(logDir, { recursive: true });
  const logPath = join(logDir, `${safeFilePart(input.task.id)}-attempt-${input.attempt}.log`);
  await writeFile(
    logPath,
    [
      `runId: ${runId}`,
      `task: ${input.task.id}`,
      `attempt: ${input.attempt}`,
      `command: ${[input.task.command, ...input.task.args].join(" ")}`,
      `status: ${input.classification.status}`,
      `providerHealth: ${input.classification.providerHealth}`,
      `reason: ${input.classification.reason}`,
      `exitCode: ${input.commandResult.exitCode ?? ""}`,
      `signal: ${input.commandResult.signal ?? ""}`,
      `timedOut: ${Boolean(input.commandResult.timedOut)}`,
      "",
      "----- stdout -----",
      input.commandResult.stdout ?? "",
      "",
      "----- stderr -----",
      input.commandResult.stderr ?? "",
      input.commandResult.error ? `\n----- error -----\n${input.commandResult.error}\n` : "",
    ].join("\n"),
    "utf8",
  );
  return logPath;
}

async function readWorkflowJitterMatrixFailureFingerprintCounts(fingerprintHistoryPath) {
  try {
    const text = await readFile(fingerprintHistoryPath, "utf8");
    const counts = {};
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (typeof row.fingerprint === "string" && row.fingerprint) {
          counts[row.fingerprint] = (counts[row.fingerprint] ?? 0) + 1;
        }
      } catch {
        // Ignore corrupted historical rows; the immutable reports remain the source of truth.
      }
    }
    return counts;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function appendWorkflowJitterMatrixFailureFingerprints(summary, fingerprintHistoryPath) {
  const candidates = summary.promotionCandidates ?? [];
  if (!candidates.length) return;
  await appendFile(
    fingerprintHistoryPath,
    candidates
      .map((candidate) =>
        JSON.stringify({
          schemaVersion: 1,
          generatedAt: summary.generatedAt,
          runId: summary.runId,
          fingerprint: candidate.fingerprint,
          candidateId: candidate.id,
          taskId: candidate.taskId,
          tier: candidate.tier,
          axis: candidate.axis,
          status: candidate.status,
          matchedPattern: candidate.matchedPattern,
          priority: candidate.priority,
        }),
      )
      .join("\n") + "\n",
    "utf8",
  );
}

async function writeWorkflowJitterMatrixPromotionCandidates(summary, outputDir) {
  const candidates = summary.promotionCandidates ?? [];
  if (!candidates.length) return [];
  const promotionDir = join(outputDir, "promotion-candidates");
  await mkdir(promotionDir, { recursive: true });
  const paths = [];
  for (const candidate of candidates) {
    const path = join(promotionDir, `${candidate.id}.md`);
    const jsonPath = join(promotionDir, `${candidate.id}.json`);
    await Promise.all([
      writeFile(path, renderWorkflowJitterMatrixPromotionCandidateMarkdown(summary, candidate), "utf8"),
      writeFile(jsonPath, `${JSON.stringify(renderWorkflowJitterMatrixPromotionCandidateJson(summary, candidate), null, 2)}\n`, "utf8"),
    ]);
    paths.push(path);
  }
  return paths;
}

function renderWorkflowJitterMatrixPromotionCandidateJson(summary, candidate) {
  return {
    schemaVersion: 1,
    generatedAt: summary.generatedAt,
    runId: summary.runId,
    sourceRevision: summary.sourceRevision,
    candidate,
  };
}

function renderWorkflowJitterMatrixPromotionCandidateMarkdown(summary, candidate) {
  const lines = [
    "# Workflow Jitter Matrix Promotion Candidate",
    "",
    `Generated: ${summary.generatedAt}`,
    `Run: ${summary.runId}`,
    `Candidate: ${candidate.id}`,
    `Fingerprint: ${candidate.fingerprint}`,
    `Source revision: ${candidate.replay?.sourceRevision?.gitHead ?? summary.sourceRevision?.gitHead ?? "unknown"}${candidate.replay?.sourceRevision?.dirty || summary.sourceRevision?.dirty ? " (tracked dirty)" : ""}`,
    `Task: ${candidate.taskLabel} (${candidate.taskId})`,
    `Tier: ${candidate.tier}`,
    `Axis: ${candidate.axis}`,
    `Status: ${candidate.status}`,
    `Provider health: ${candidate.providerHealth}`,
    `Recurrence count: ${candidate.recurrenceCount}`,
    `Priority: ${candidate.priority}`,
    "",
    "## Reason",
    "",
    candidate.reason ?? "No reason recorded.",
    "",
    "## Suggested Regression",
    "",
    `- Fixture path: \`${candidate.suggestedFixture}\``,
    `- Command under test: \`${candidate.command}\``,
    `- Next action: ${candidate.nextAction}`,
    "",
    "## Replay",
    "",
    `- Matrix replay: \`${candidate.replay?.matrixCommand ?? ""}\``,
    `- Direct command: \`${candidate.replay?.directCommand ?? candidate.command}\``,
    `- Environment keys required: ${(candidate.replay?.envKeys ?? []).length ? candidate.replay.envKeys.map((key) => `\`${key}\``).join(", ") : "none"}`,
    `- Scenario: ${candidate.replay?.scenario ?? "n/a"}`,
    `- Seed hints: ${(candidate.replay?.seedHints ?? []).length ? candidate.replay.seedHints.join(", ") : "n/a"}`,
    `- JSON replay bundle: \`${candidate.suggestedJsonArtifact}\``,
    "",
    "## Evidence",
    "",
  ];
  for (const attempt of candidate.evidence.attempts) {
    lines.push(
      `- attempt ${attempt.attempt}: ${attempt.status}; exit=${attempt.exitCode ?? attempt.signal ?? "unknown"}; timedOut=${Boolean(attempt.timedOut)}; duration=${formatMs(attempt.durationMs)}ms${attempt.logPath ? `; log=\`${attempt.logPath}\`` : ""}`,
    );
  }
  lines.push(
    "",
    "## Promotion Rule",
    "",
    "If this fingerprint recurs, extract the smallest failing contract from the log/report into a deterministic Vitest fixture or compiler/UI-model test, then keep the live row as coverage rather than the only proof.",
    "",
  );
  return `${lines.join("\n").trim()}\n`;
}

function workflowJitterMatrixFailureReplay(summary, task, candidateId) {
  const replayOutputDir = `test-results/workflow-jitter-matrix/replay/${candidateId}`;
  const matrixArgs = [
    "scripts/workflow-jitter-matrix.mjs",
    `--task=${task.id}`,
    "--retries=0",
    `--output-dir=${replayOutputDir}`,
  ];
  const directArgs = task.args ?? [];
  return {
    schemaVersion: 1,
    runId: summary.runId,
    generatedAt: summary.generatedAt,
    profile: summary.profile,
    sourceRevision: summary.sourceRevision,
    taskId: task.id,
    taskLabel: task.label,
    matrixReplay: {
      command: "node",
      args: matrixArgs,
      cwd: ".",
      taskIds: [task.id],
      retries: 0,
      outputDir: replayOutputDir,
    },
    directReplay: {
      command: task.command,
      args: directArgs,
      cwd: ".",
    },
    matrixCommand: ["node", ...matrixArgs].map(shellToken).join(" "),
    directCommand: [task.command, ...directArgs].map(shellToken).join(" "),
    envKeys: task.envKeys ?? [],
    scenario: workflowJitterMatrixTaskScenario(task),
    seedHints: workflowJitterMatrixTaskSeedHints(task),
    attempts: (task.attempts ?? []).map((attempt) => ({
      attempt: attempt.attempt,
      status: attempt.status,
      exitCode: attempt.exitCode,
      signal: attempt.signal,
      timedOut: attempt.timedOut,
      durationMs: attempt.durationMs,
      logPath: attempt.logPath,
    })),
  };
}

function workflowJitterMatrixTaskScenario(task) {
  return (task.args ?? []).find((arg) => String(arg).startsWith("--scenario="))?.slice("--scenario=".length);
}

function workflowJitterMatrixTaskSeedHints(task) {
  return (task.args ?? []).filter((arg) => /^--(?:seed|seeds|case|suite|profile)=/.test(String(arg)));
}

function shellToken(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=,@+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\"'\"'")}'`;
}

async function writeImmutableWorkflowJitterMatrixReport(outputDir, runId, json, markdown) {
  const runDir = join(outputDir, "runs");
  await mkdir(runDir, { recursive: true });
  for (let collision = 0; collision < 1_000; collision += 1) {
    const suffix = collision === 0 ? "" : `-${collision + 1}`;
    const candidateRunId = `${safeFilePart(runId)}${suffix}`;
    const runJsonPath = join(runDir, `${candidateRunId}.json`);
    const runMarkdownPath = join(runDir, `${candidateRunId}.md`);
    try {
      await writeFile(runJsonPath, json, { encoding: "utf8", flag: "wx" });
      try {
        await writeFile(runMarkdownPath, markdown, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        await rm(runJsonPath, { force: true });
        if (error?.code === "EEXIST") continue;
        throw error;
      }
      return { runId: candidateRunId, runJsonPath, runMarkdownPath };
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error(`Unable to allocate a unique workflow jitter matrix report id for ${runId}`);
}

function workflowJitterMatrixHistoryEntry(summary, paths) {
  return {
    schemaVersion: 1,
    generatedAt: summary.generatedAt,
    runId: paths.runId,
    sourceRevision: summary.sourceRevision,
    profile: summary.profile,
    taskCount: summary.taskCount,
    passedCount: summary.passedCount,
    providerDegradedCount: summary.providerDegradedCount,
    environmentSkippedCount: summary.environmentSkippedCount,
    productOrTestFailureCount: summary.productOrTestFailureCount,
    retryLimit: summary.retryLimit,
    concurrency: summary.concurrency,
    totalWallClockMs: summary.totalWallClockMs,
    deterministicStressUnitCount: summary.deterministicStressUnitCount ?? 0,
    livePromptVariantCount: summary.livePromptVariantCount ?? 0,
    liveDogfoodRunCount: summary.liveDogfoodRunCount ?? 0,
    liveFamilies: summary.liveFamilies ?? [],
    promotionCandidateCount: (summary.promotionCandidates ?? []).length,
    promotionCandidatePaths: paths.promotionCandidatePaths ?? [],
    jsonPath: paths.runJsonPath,
    markdownPath: paths.runMarkdownPath,
    latestJsonPath: paths.latestJsonPath,
    latestMarkdownPath: paths.latestMarkdownPath,
  };
}

function parseCliArgs(args) {
  const parsed = {
    profile: "phase8-smoke",
    taskIds: [],
    includeLive: false,
    requireLive: false,
    promotionGate: false,
    concurrency: positiveEnvInt("AMBIENT_WORKFLOW_JITTER_MATRIX_CONCURRENCY", 2),
    retries: positiveEnvInt("AMBIENT_WORKFLOW_JITTER_MATRIX_RETRIES", 0),
    timeoutMs: positiveEnvInt("AMBIENT_WORKFLOW_JITTER_MATRIX_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    outputDir: process.env.AMBIENT_WORKFLOW_JITTER_MATRIX_OUT || DEFAULT_OUTPUT_DIR,
    help: false,
  };
  for (const arg of args) {
    if (arg === "--include-live") parsed.includeLive = true;
    else if (arg === "--require-live") parsed.requireLive = true;
    else if (arg === "--promotion-gate") parsed.promotionGate = true;
    else if (arg.startsWith("--profile=")) parsed.profile = arg.slice("--profile=".length);
    else if (arg.startsWith("--task=")) parsed.taskIds.push(arg.slice("--task=".length));
    else if (arg.startsWith("--concurrency=")) parsed.concurrency = nonNegativeIntArg(arg, "--concurrency=");
    else if (arg.startsWith("--retries=")) parsed.retries = nonNegativeIntArg(arg, "--retries=");
    else if (arg.startsWith("--timeout-ms=")) parsed.timeoutMs = nonNegativeIntArg(arg, "--timeout-ms=");
    else if (arg.startsWith("--output-dir=")) parsed.outputDir = resolve(arg.slice("--output-dir=".length));
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else throw new Error(`Unknown option ${arg}. Run with --help for usage.`);
  }
  parsed.taskIds = normalizeIds(parsed.taskIds);
  return parsed;
}

function usage() {
  return `Usage: node scripts/workflow-jitter-matrix.mjs [options]

Options:
  --profile=ID          Matrix profile: ${Object.keys(PROFILE_TASKS).join(", ")}. Default: phase8-smoke.
  --task=ID[,ID]        Run only selected task ids. Can be repeated.
  --include-live        Add the default live UI dogfood row to phase8-smoke.
  --require-live        Exit nonzero unless requested live rows pass.
  --promotion-gate      Exit nonzero for any provider-degraded or environment-skipped row.
  --concurrency=N       Run up to N tasks concurrently. Default: 2, capped at 4.
  --retries=N           Retry retryable provider-degraded rows. Default: 0.
  --timeout-ms=N        Default timeout for rows without a task-specific timeout.
  --output-dir=PATH     Report output directory. Default: test-results/workflow-jitter-matrix.
`;
}

function normalizeIds(values) {
  return (values ?? []).flatMap((value) => String(value).split(",")).map((value) => value.trim()).filter(Boolean);
}

function positiveEnvInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function nonNegativeIntArg(arg, prefix) {
  const value = Number(arg.slice(prefix.length));
  if (!Number.isFinite(value) || value < 0) throw new Error(`Expected a non-negative integer for ${prefix.slice(0, -1)}`);
  return Math.floor(value);
}

function clampConcurrency(value) {
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric)) return 2;
  return Math.min(4, Math.max(1, numeric));
}

function retryDelayMs(attempt, retryBaseMs = DEFAULT_RETRY_BASE_MS) {
  return Math.min(60_000, Math.max(0, retryBaseMs) * 2 ** Math.max(0, attempt - 1));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function roundMs(value) {
  return Math.max(0, Math.round(value * 100) / 100);
}

function formatMs(value) {
  return Number(value ?? 0).toFixed(2);
}

function workflowJitterMatrixRunId(generatedAt) {
  return safeFilePart(String(generatedAt).replace(/[:]/g, "-"));
}

function workflowJitterMatrixFailureFingerprint(task) {
  const normalized = [
    task.id,
    task.tier,
    task.axis,
    task.status,
    task.matchedPattern ?? "",
    normalizeFailureText(task.reason ?? ""),
  ].join("\n");
  return createHash("sha256").update(normalized).digest("hex");
}

function normalizeFailureText(value) {
  return String(value)
    .replace(/\b\d{4}-\d{2}-\d{2}T[\w:.-]+Z\b/g, "<timestamp>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<uuid>")
    .replace(/\/(?:Users|private|tmp|var)\/[^\s'")]+/g, "<path>")
    .replace(/\b\d+(?:\.\d+)?ms\b/g, "<duration>")
    .replace(/\b\d{4,}\b/g, "<number>")
    .replace(/\s+/g, " ")
    .trim();
}

function suggestedWorkflowJitterMatrixFixturePath(task) {
  const suffix = safeFilePart(task.id).replace(/-/g, "_");
  if (task.axis === "ui_state") return `src/renderer/src/workflowJitterRegression.${suffix}.test.ts`;
  if (task.axis === "prompt") return `scripts/workflow-model-tolerance-lab.test.mjs`;
  return `src/main/workflow/workflowJitterRegression.${suffix}.test.ts`;
}

function safeFilePart(value) {
  return String(value).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "task";
}

function escapeMarkdownCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      process.exit(0);
    }
    const { summary, paths } = await runWorkflowJitterMatrix({
      ...options,
      cwd: repoRoot,
      log: (line) => console.log(line),
    });
    console.log(renderWorkflowJitterMatrixMarkdown(summary));
    console.log(`Workflow jitter matrix latest report written to ${paths?.latestJsonPath} and ${paths?.latestMarkdownPath}`);
    console.log(`Workflow jitter matrix immutable report written to ${paths?.runJsonPath} and ${paths?.runMarkdownPath}`);
    console.log(`Workflow jitter matrix history appended to ${paths?.historyPath}`);
    process.exit(workflowJitterMatrixExitCode(summary, { requireLive: options.requireLive, promotionGate: options.promotionGate }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
