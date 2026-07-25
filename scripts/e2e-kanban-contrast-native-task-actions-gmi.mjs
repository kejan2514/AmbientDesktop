#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const outputRoot = resolve(
  process.env.AMBIENT_KANBAN_CONTRAST_NATIVE_ACTIONS_OUT_DIR ||
    join(tmpdir(), "ambient-kanban-contrast-native-task-actions-gmi"),
);
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = join(outputRoot, "runs", runStamp);
const workspace = join(runRoot, "workspace");
const userData = join(runRoot, "userData");
const reportPath = resolve(process.env.AMBIENT_KANBAN_CONTRAST_NATIVE_ACTIONS_OUT || join(outputRoot, "latest.json"));
const boardScreenshotPath = join(runRoot, "phase7-contrast-native-board.png");
const taskActionsScreenshotPath = join(runRoot, "phase7-contrast-native-task-actions.png");
const cdpPort = Number(process.env.AMBIENT_KANBAN_CONTRAST_NATIVE_ACTIONS_CDP_PORT || 0) || (await availablePort());
const workerRunMaxElapsedMs = Number(process.env.AMBIENT_KANBAN_CONTRAST_NATIVE_ACTIONS_RUN_MAX_TIMEOUT_MS || 0) || 1_200_000;
const workerIdleTimeoutMs = Number(process.env.AMBIENT_KANBAN_CONTRAST_NATIVE_ACTIONS_RUN_IDLE_TIMEOUT_MS || 0) || 300_000;
const defaultRepoKeyFile = join(repoRoot, "ignored-provider-key-file.txt");
const defaultHomeCheckoutKeyFile = join(homedir(), "ambientCoder", "ignored-provider-key-file.txt");
const keyFile = resolve(
  process.env.GMI_CLOUD_API_KEY_FILE ||
    (existsSync(defaultRepoKeyFile) ? defaultRepoKeyFile : defaultHomeCheckoutKeyFile),
);
const defaultSnapshotWorkspace = join(homedir(), "Documents", "ambientCoderArchive");
const sourceWorkspace =
  process.env.AMBIENT_KANBAN_CONTRAST_NATIVE_ACTIONS_SNAPSHOT_WORKSPACE ||
  process.env.AMBIENT_DESKTOP_WORKSPACE ||
  (existsSync(defaultSnapshotWorkspace) ? defaultSnapshotWorkspace : "");
const sourceUserData = process.env.AMBIENT_KANBAN_CONTRAST_NATIVE_ACTIONS_SNAPSHOT_USER_DATA || process.env.AMBIENT_E2E_USER_DATA || "";
const expectDurableCompletionRecovery = process.env.AMBIENT_KANBAN_CONTRAST_NATIVE_ACTIONS_EXPECT_DURABLE_COMPLETION_RECOVERY === "1";
const cardTitle = "Phase 7 Contrast Checker Native Task Actions";
const expectedFiles = [
  "src/contrast-checker.mjs",
  "tokens/contrast-fixtures.json",
  "tests/verify-contrast-checker.mjs",
  "reports/contrast-check-results.md",
];
const output = [];
let app;
let cdp;

try {
  if (!sourceWorkspace || !existsSync(sourceWorkspace)) {
    throw new Error("Set AMBIENT_KANBAN_CONTRAST_NATIVE_ACTIONS_SNAPSHOT_WORKSPACE to a local snapshot workspace directory.");
  }
  if (!existsSync(keyFile) && !process.env.GMI_CLOUD_API_KEY && !process.env.GMI_API_KEY) {
    throw new Error("Set GMI_CLOUD_API_KEY_FILE, GMI_CLOUD_API_KEY, or GMI_API_KEY before running the GMI contrast native task-action gate.");
  }

  await prepareRunState();
  app = await launchApp();
  cdp = await connectCdp(app.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await waitFor(() => document.body?.innerText.includes("Ambient"), "Ambient shell", 120_000);

  const initialState = await invoke("bootstrap");
  const provider = initialState.provider;
  if (provider.providerId !== "gmi-cloud") throw new Error(`Expected gmi-cloud provider, got ${provider.providerId ?? "missing"}.`);
  if (!provider.hasApiKey) throw new Error("GMI provider launched without a visible API key.");
  await invoke("setOrchestrationAutoDispatchEnabled", { enabled: false }).catch(() => undefined);

  const { board, card } = await createContrastNativeTaskCard();
  await waitFor(() => document.body?.innerText.includes("Open Board"), "Open Board action");
  await clickButton("Open Board");
  await waitFor(() => document.querySelector(".project-board-tabs")?.textContent?.includes("Board"), "project board tabs");
  await clickProjectBoardTab("Board");
  await captureScreenshot(boardScreenshotPath);

  await invokeDetached("prepareNextOrchestrationTasks", undefined, "__kanbanContrastPrepareError");
  const { run: preparedRun } = await waitForPreparedOrStartedRun(card.orchestrationTaskId, card.title);
  if (preparedRun.status === "prepared") {
    await invokeDetached("startOrchestrationRun", { runId: preparedRun.id }, "__kanbanContrastRunStartError");
  }
  const liveNativeEvent = await waitForNativeTaskProgressEvent(preparedRun.id);
  const terminalRun = await waitForTerminalRun(preparedRun.id);
  if (terminalRun.status !== "completed") {
    throw new Error(`Contrast Local Task did not complete. Status=${terminalRun.status}; error=${terminalRun.error ?? "none"}.`);
  }
  const taskActions = taskActionObservation(terminalRun.proofOfWork);
  assertNativeTaskActionGate(taskActions);
  const durableCompletionRecovery = durableCompletionRecoveryObservation(terminalRun.proofOfWork);
  if (expectDurableCompletionRecovery) assertDurableCompletionRecovery(terminalRun, durableCompletionRecovery);

  const reviewedCard = await waitForCardProofReview(card.id);
  const boardAfterRun = boardFromState(await invoke("bootstrap"));
  const nativeEvents = nativeTaskActionEvents(boardAfterRun, terminalRun.id);
  if (nativeEvents.length < 3) throw new Error(`Expected at least 3 durable native task board events, saw ${nativeEvents.length}.`);
  const changedPaths = meaningfulChangedPaths(terminalRun.proofOfWork);
  for (const file of expectedFiles) {
    if (!changedPaths.includes(file)) {
      throw new Error(`Contrast proof did not report expected deliverable ${file}. Reported: ${changedPaths.join(", ") || "none"}.`);
    }
    await assertAbsoluteFile(join(terminalRun.workspacePath, file), file === "reports/contrast-check-results.md" ? "Contrast Check Results" : "");
  }

  const verify = await runCommand("node", ["tests/verify-contrast-checker.mjs"], { cwd: terminalRun.workspacePath, timeoutMs: 60_000 });
  const report = await runCommand("node", ["src/contrast-checker.mjs", "tokens/contrast-fixtures.json", "--report", "reports/contrast-check-results.md"], {
    cwd: terminalRun.workspacePath,
    timeoutMs: 60_000,
  });
  await assertAbsoluteFile(join(terminalRun.workspacePath, "reports/contrast-check-results.md"), "failing-token-on-white");

  if (!["done", "ready_for_review"].includes(reviewedCard.proofReview?.status ?? "")) {
    throw new Error(`Contrast card proof review did not reach review/done. Review=${JSON.stringify(reviewedCard.proofReview)}`);
  }

  await clickProjectBoardTab("Board");
  await clickBoardCard(card.title);
  await waitFor(() => document.body?.innerText.includes("Native task tools:"), "visible native task-action diagnostics", 120_000);
  await captureScreenshot(taskActionsScreenshotPath);

  const result = {
    status: "passed",
    providerId: provider.providerId,
    usedGmiKeyFile: existsSync(keyFile),
    sourceWorkspace,
    usedSnapshotUserData: Boolean(sourceUserData && existsSync(sourceUserData)),
    runRoot,
    boardId: board.id,
    cardId: card.id,
    taskId: card.orchestrationTaskId,
    runId: terminalRun.id,
    runStatus: terminalRun.status,
    runWorkspacePath: terminalRun.workspacePath,
    durableCompletionRecovery,
    liveNativeEvent,
    nativeEventCount: nativeEvents.length,
    taskActions,
    changedPaths,
    proofReview: reviewedCard.proofReview,
    commands: {
      verify: commandSummary(verify),
      report: commandSummary(report),
    },
    screenshots: { board: boardScreenshotPath, taskActions: taskActionsScreenshotPath },
    assertions: [
      "Desktop launched with the temporary GMI Cloud provider override without exposing the API key",
      "The harness used a temp copy of Documents/ambientCoderArchive before running the destructive Local Task",
      "The contrast checker Local Task produced native task_heartbeat, task_report_proof, and task_complete actions",
      "Native task actions were recorded as card_run_progress events before relying on final assistant prose",
      "The final proof diagnostics reported native task tools and zero fenced JSON fallback actions",
      "The Ambient Desktop board rendered native task-action diagnostics in the default card inspector",
      "The task workspace contains the contrast checker, fixture tokens, verification test, and report artifact",
      ...(expectDurableCompletionRecovery
        ? ["The run recovered from a simulated final provider error after durable native task_complete without forcing retry"]
        : []),
    ],
  };
  await writeReport(result);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const report = {
    status: "failed",
    classification: classifyHarnessFailure(error),
    message: error instanceof Error ? error.message : String(error),
    runRoot,
    domSnapshot: await safeDomSnapshot(),
    outputTail: output.join("").split("\n").slice(-180),
  };
  await writeReport(report).catch(() => undefined);
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  cdp?.close();
  if (app?.child) await terminateProcess(app.child);
}

async function prepareRunState() {
  await rm(runRoot, { recursive: true, force: true });
  await mkdir(runRoot, { recursive: true });
  await cp(sourceWorkspace, workspace, { recursive: true });
  if (sourceUserData && existsSync(sourceUserData)) {
    await cp(sourceUserData, userData, { recursive: true });
    for (const name of ["SingletonCookie", "SingletonLock", "SingletonSocket"]) await rm(join(userData, name), { force: true });
  } else {
    await mkdir(userData, { recursive: true });
  }
  await sanitizeTempWorkspace();
  await writeHarnessWorkflow();
}

async function sanitizeTempWorkspace() {
  await rm(join(workspace, ".ambient"), { recursive: true, force: true });
  await rm(join(workspace, ".ambient-codex"), { recursive: true, force: true });
  await removeCredentialNamedFiles(workspace, 3);
  for (const file of expectedFiles) await rm(join(workspace, file), { force: true });
  await rm(join(workspace, "src"), { recursive: true, force: true });
  await rm(join(workspace, "tokens"), { recursive: true, force: true });
  await rm(join(workspace, "reports"), { recursive: true, force: true });
  await rm(join(workspace, "tests", "verify-contrast-checker.mjs"), { force: true });
}

async function removeCredentialNamedFiles(root, maxDepth) {
  if (maxDepth < 0) return;
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (isCredentialLikeFilename(entry.name)) {
      await rm(path, { recursive: entry.isDirectory(), force: true });
      continue;
    }
    if (entry.isDirectory() && !["node_modules", ".git"].includes(entry.name)) await removeCredentialNamedFiles(path, maxDepth - 1);
  }
}

function isCredentialLikeFilename(name) {
  const lower = name.toLowerCase();
  return lower === ".env" || lower.startsWith(".env.") || (lower.includes("api") && lower.includes("key"));
}

async function writeHarnessWorkflow() {
  const workflow = `---
version: 1
tracker:
  kind: local
  active_states: [ready]
  terminal_states: [done, canceled, duplicate]
  review_states: [review]
orchestration:
  auto_dispatch: false
  max_concurrent_agents: 1
  max_turns: 8
  poll_interval_ms: 30000
  stall_timeout_ms: 300000
workspace:
  strategy: directory
  root: .ambient-codex/orchestration/workspaces
  branch_prefix: ambient/
  cleanup_terminal_workspaces: false
  reuse_existing: true
agent:
  permission_mode: workspace
  extra_instructions: |
    This is a bounded Phase 7 native task-action gate. Use native task tools when they are available. Do not inspect, print, summarize, or copy API keys, secret files, local-secrets folders, credentials, browser profiles, or environment values. Do not install packages or use network calls. Keep all writes inside the writable task workspace.
proof_of_work:
  require_tests: true
  require_diff_summary: true
  require_screenshots: false
  max_summary_chars: 4000
---
Work on Local Task {{ task.identifier }} in {{ workspace.path }}.

Execution workspace contract:
- Writable task workspace: {{ workspace.path }}
- Owning project root: {{ task.projectPath }}
- Create, modify, delete, stage, and commit task files only inside the writable task workspace. Use paths relative to that workspace.
- Do not mutate the owning project root.
- Do not read or expose secret files, API key files, credential directories, browser profiles, or environment values.

Title: {{ task.title }}

Description:
{{ task.description }}

Complete the task in the prepared workspace. Keep the scope narrow, run the requested verification commands, and finish with native project-board task actions that name the changed files and commands.
`;
  await writeFile(join(workspace, "WORKFLOW.md"), workflow, "utf8");
}

async function launchApp() {
  const child = spawn("pnpm", ["exec", "electron-vite", "dev", "--remoteDebuggingPort", String(cdpPort)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AMBIENT_PROVIDER: "gmi-cloud",
      GMI_CLOUD_API_KEY_FILE: keyFile,
      AMBIENT_DESKTOP_WORKSPACE: workspace,
      AMBIENT_E2E: "1",
      AMBIENT_E2E_USER_DATA: userData,
      AMBIENT_DESKTOP_BOOTSTRAP_WATCHDOG_MS: process.env.AMBIENT_DESKTOP_BOOTSTRAP_WATCHDOG_MS ?? "180000",
      AMBIENT_E2E_SKIP_PROJECT_BOARD_SOURCE_REFRESH: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));
  const target = await waitForPageEndpoint(child);
  return { child, webSocketDebuggerUrl: target.webSocketDebuggerUrl };
}

async function createContrastNativeTaskCard() {
  const initialState = await invoke("bootstrap");
  const activeProject = initialState.projects.find((project) => project.path === initialState.workspace.path) ?? initialState.projects[0];
  if (!activeProject) throw new Error("No active project available for contrast native task-action gate.");
  const stateWithBoard = await invoke("createProjectBoard", {
    projectId: activeProject.id,
    title: "Phase 7 Native Task Action Gate Board",
    summary: "Live execution gate for native task action durability, diagnostics, and recovery.",
  });
  let board = boardFromState(stateWithBoard);
  if (board.status !== "active") {
    board = boardFromState(await invoke("updateProjectBoardStatus", { boardId: board.id, status: "active" }));
  }

  const beforeIds = new Set(board.cards.map((card) => card.id));
  let state = await invoke("createProjectBoardCard", {
    boardId: board.id,
    title: cardTitle,
    description: "Build a dependency-free contrast checker and prove native task action reporting.",
  });
  board = boardFromState(state);
  const created = board.cards.find((card) => !beforeIds.has(card.id) && card.sourceKind === "manual");
  if (!created) throw new Error("Contrast native task-action card was not created.");

  state = await invoke("updateProjectBoardCard", {
    cardId: created.id,
    title: cardTitle,
    description: contrastCardDescription(),
    candidateStatus: "ready_to_create",
    priority: 1,
    phase: "Phase 7 Gate A",
    labels: ["phase-7", "native-task-actions", "contrast-checker", "live-gmi"],
    blockedBy: [],
    acceptanceCriteria: [
      "Create src/contrast-checker.mjs, tokens/contrast-fixtures.json, tests/verify-contrast-checker.mjs, and reports/contrast-check-results.md in the writable task workspace.",
      "The checker computes WCAG contrast ratios for token foreground/background pairs and marks pass/fail at AA normal text threshold 4.5.",
      "The fixture includes passing-token-on-white and failing-token-on-white examples, and the report names both outcomes.",
      "Run node tests/verify-contrast-checker.mjs and node src/contrast-checker.mjs tokens/contrast-fixtures.json --report reports/contrast-check-results.md successfully.",
      "Report heartbeat, proof, and completion through native task tools, with changedFiles covering all material deliverables and commands covering both verification commands.",
    ],
    testPlan: {
      unit: ["Run node tests/verify-contrast-checker.mjs."],
      integration: ["Run node src/contrast-checker.mjs tokens/contrast-fixtures.json --report reports/contrast-check-results.md."],
      visual: [],
      manual: [],
    },
    clarificationQuestions: [],
  });
  board = boardFromState(state);
  const ready = board.cards.find((card) => card.id === created.id);
  if (!ready) throw new Error("Contrast card disappeared after update.");
  state = await invoke("approveProjectBoardCard", { cardId: ready.id });
  board = boardFromState(state);
  const ticketized = board.cards.find((card) => card.id === ready.id);
  if (!ticketized?.orchestrationTaskId) throw new Error("Contrast card was not ticketized into a Local Task.");
  return { board, card: ticketized };
}

function contrastCardDescription() {
  return [
    "Build a small dependency-free contrast checker in this card's writable task workspace.",
    "",
    "Required files:",
    "- src/contrast-checker.mjs: browser-independent Node ESM module and CLI. Export hexToRgb, relativeLuminance, contrastRatio, evaluatePairs, and renderMarkdownReport. Support CLI usage: node src/contrast-checker.mjs tokens/contrast-fixtures.json --report reports/contrast-check-results.md.",
    "- tokens/contrast-fixtures.json: JSON fixture with at least passing-token-on-white and failing-token-on-white pairs. Include foreground/background hex values and expectedPass booleans.",
    "- tests/verify-contrast-checker.mjs: Node assert script that imports the module, checks known ratio math, verifies passing-token-on-white passes, verifies failing-token-on-white fails, runs renderMarkdownReport, and asserts the report names both tokens.",
    "- reports/contrast-check-results.md: Markdown report generated by the CLI with a Contrast Check Results heading and pass/fail rows for every fixture token.",
    "",
    "Verification commands to run from the task workspace:",
    "- node tests/verify-contrast-checker.mjs",
    "- node src/contrast-checker.mjs tokens/contrast-fixtures.json --report reports/contrast-check-results.md",
    "",
    "Project-board reporting contract:",
    "- First, call native task_heartbeat with the immediate plan before editing files. Use fenced task_actions JSON only if native task tools are unavailable.",
    "- After writing and verifying files, call native task_report_proof with changedFiles exactly including src/contrast-checker.mjs, tokens/contrast-fixtures.json, tests/verify-contrast-checker.mjs, and reports/contrast-check-results.md, and commands including both verification commands.",
    "- Then call native task_complete only when those files and commands are complete.",
    "- Do not duplicate native tool actions with fenced JSON fallback. Do not install dependencies, call network services, read secrets, or write outside the task workspace.",
  ].join("\n");
}

async function waitForPreparedOrStartedRun(taskId, title) {
  return waitForState(
    async () => {
      const detachedError = await detachedErrorText();
      if (detachedError) throw new Error(`Local Task preparation failed: ${detachedError}`);
      const board = await invoke("listOrchestrationBoard");
      const run = board.runs.find((candidate) => candidate.taskId === taskId && ["prepared", "running", "completed", "failed", "stalled", "canceled"].includes(candidate.status));
      return run ? { board, run } : undefined;
    },
    `prepared or started Local Task run for ${title}`,
    300_000,
  );
}

async function waitForTerminalRun(runId) {
  const startedAt = Date.now();
  let lastActivityAt = Date.now();
  let lastSignature = "";
  while (true) {
    const detachedError = await detachedErrorText();
    if (detachedError) throw new Error(`Local Task start failed: ${detachedError}`);
    const board = await invoke("listOrchestrationBoard");
    const run = board.runs.find((candidate) => candidate.id === runId);
    if (!run) throw new Error(`Orchestration run disappeared: ${runId}`);
    const signature = orchestrationRunProgressSignature(run);
    if (signature !== lastSignature) {
      lastSignature = signature;
      lastActivityAt = Date.now();
    }
    if (["completed", "failed", "stalled", "canceled"].includes(run.status)) return run;
    if (Date.now() - lastActivityAt > workerIdleTimeoutMs) {
      throw new Error(`Timed out waiting for terminal contrast Local Task run; no run progress was observed for ${workerIdleTimeoutMs.toLocaleString()}ms.`);
    }
    if (Date.now() - startedAt > workerRunMaxElapsedMs) {
      throw new Error(`Timed out waiting for terminal contrast Local Task run after ${workerRunMaxElapsedMs.toLocaleString()}ms total elapsed.`);
    }
    await delay(1000);
  }
}

async function waitForNativeTaskProgressEvent(runId) {
  return waitForState(
    async () => {
      const board = boardFromState(await invoke("bootstrap"));
      return nativeTaskActionEvents(board, runId)[0];
    },
    "live native task-action board event",
    420_000,
  );
}

function nativeTaskActionEvents(board, runId) {
  return (board.events ?? []).filter(
    (event) =>
      event.kind === "card_run_progress" &&
      event.metadata?.runId === runId &&
      event.metadata?.taskAction &&
      event.metadata?.source === "native_tool",
  );
}

function orchestrationRunProgressSignature(run) {
  const proof = run.proofOfWork && typeof run.proofOfWork === "object" ? run.proofOfWork : {};
  return [
    run.id,
    run.status,
    run.lastEventAt,
    run.finishedAt,
    run.error,
    proof.messageCount,
    proof.assistantMessageCount,
    proof.toolMessageCount,
    proof.outputCharCount,
    proof.lastActivityAt,
    proof.lastAssistantStatus,
    taskActionObservation(proof).count,
    taskActionObservation(proof).nativeToolActionCount,
  ].join("|");
}

async function waitForCardProofReview(cardId) {
  return waitForState(
    async () => {
      const state = await invoke("bootstrap");
      const board = boardFromState(state);
      const card = board.cards.find((candidate) => candidate.id === cardId);
      return card?.proofReview ? card : undefined;
    },
    "contrast card proof review",
    180_000,
  );
}

function taskActionObservation(proof) {
  const actions = Array.isArray(proof?.taskToolActions) ? proof.taskToolActions : [];
  const diagnostics = proof?.taskActionDiagnostics && typeof proof.taskActionDiagnostics === "object" ? proof.taskActionDiagnostics : {};
  const countsByAction = {};
  for (const action of actions) {
    const key = typeof action?.action === "string" ? action.action : "unknown";
    countsByAction[key] = (countsByAction[key] ?? 0) + 1;
  }
  const terminalCount = actions.filter((action) =>
    ["task_block", "task_complete", "task_create_followup", "task_report_proof", "task_report_handoff"].includes(action?.action),
  ).length;
  const nativeToolActionCount =
    Number(diagnostics.nativeToolActionCount ?? NaN) ||
    actions.filter((action) => action?.metadata?.transport === "native_tool").length;
  const fencedFallbackActionCount =
    Number(diagnostics.fencedFallbackActionCount ?? NaN) ||
    actions.filter((action) => !action?.metadata || action.metadata.transport === "fenced_fallback").length;
  return {
    count: actions.length,
    terminalCount,
    nativeToolActionCount,
    fencedFallbackActionCount,
    countsByAction,
    diagnostics,
  };
}

function assertNativeTaskActionGate(observation) {
  if ((observation.countsByAction.task_heartbeat ?? 0) <= 0) throw new Error("Run completed without native task_heartbeat proof.");
  if ((observation.countsByAction.task_report_proof ?? 0) <= 0) throw new Error("Run completed without native task_report_proof proof.");
  if ((observation.countsByAction.task_complete ?? 0) <= 0) throw new Error("Run completed without native task_complete proof.");
  if (observation.nativeToolActionCount < 3) throw new Error(`Expected at least 3 native task actions, saw ${observation.nativeToolActionCount}.`);
  if (observation.fencedFallbackActionCount > 0) {
    throw new Error(`Expected zero fenced fallback actions when native tools are available, saw ${observation.fencedFallbackActionCount}.`);
  }
}

function durableCompletionRecoveryObservation(proof) {
  const finalResponseError = proof?.finalResponseError && typeof proof.finalResponseError === "object" ? proof.finalResponseError : undefined;
  return {
    expected: expectDurableCompletionRecovery,
    recovered: finalResponseError?.recoveredBy === "durable_task_complete",
    recoveredBy: finalResponseError?.recoveredBy,
    message: typeof finalResponseError?.message === "string" ? finalResponseError.message : undefined,
    lastAssistantStatus: typeof proof?.lastAssistantStatus === "string" ? proof.lastAssistantStatus : undefined,
  };
}

function assertDurableCompletionRecovery(run, observation) {
  if (run.error) throw new Error(`Durable completion recovery left a run error: ${run.error}`);
  if (!observation.recovered) {
    throw new Error(`Expected finalResponseError.recoveredBy=durable_task_complete. Observed=${JSON.stringify(observation)}`);
  }
  if (observation.lastAssistantStatus !== "done_after_task_complete") {
    throw new Error(`Expected lastAssistantStatus=done_after_task_complete after simulated final error. Observed=${observation.lastAssistantStatus ?? "missing"}.`);
  }
  if (!/Simulated final provider error after durable task_complete/.test(observation.message ?? "")) {
    throw new Error(`Expected simulated final-provider error message in proof. Observed=${observation.message ?? "missing"}.`);
  }
}

function meaningfulChangedPaths(proof) {
  const paths = new Set();
  const collect = (value) => {
    if (typeof value === "string") {
      const cleaned = value.trim().replace(/^[MADRCU?! ]+\s+/, "").replace(/^\.\//, "");
      if (cleaned) paths.add(cleaned);
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const key of ["path", "file", "name"]) collect(value[key]);
  };
  if (Array.isArray(proof?.changedFiles)) proof.changedFiles.forEach(collect);
  if (Array.isArray(proof?.toolChangedFiles)) proof.toolChangedFiles.forEach(collect);
  if (Array.isArray(proof?.taskToolActions)) {
    for (const action of proof.taskToolActions) {
      if (Array.isArray(action?.changedFiles)) action.changedFiles.forEach(collect);
    }
  }
  return [...paths].sort();
}

async function detachedErrorText() {
  return evaluate(() => window.__kanbanContrastPrepareError || window.__kanbanContrastRunStartError || null).catch(() => null);
}

async function invoke(method, input) {
  return evaluate(
    ({ method: targetMethod, input: targetInput }) => {
      const fn = window.ambientDesktop?.[targetMethod];
      if (typeof fn !== "function") throw new Error(`ambientDesktop method not found: ${targetMethod}`);
      return targetInput === undefined ? fn() : fn(targetInput);
    },
    { method, input },
  );
}

async function invokeDetached(method, input, errorSlot) {
  return evaluate(
    ({ method: targetMethod, input: targetInput, errorSlot: slot }) => {
      window[slot] = null;
      const fn = window.ambientDesktop?.[targetMethod];
      if (typeof fn !== "function") throw new Error(`ambientDesktop method not found: ${targetMethod}`);
      Promise.resolve(targetInput === undefined ? fn() : fn(targetInput)).catch((error) => {
        window[slot] = String(error && error.message ? error.message : error);
      });
      return true;
    },
    { method, input, errorSlot },
  );
}

function boardFromState(state) {
  const project = state.projects.find((candidate) => candidate.path === state.workspace.path);
  if (!project?.board) throw new Error("Expected active project to have a project board.");
  return project.board;
}

async function clickProjectBoardTab(label) {
  await evaluate((tabLabel) => {
    const button = [...document.querySelectorAll(".project-board-tabs button")].find((item) => item.querySelector("span")?.textContent?.trim() === tabLabel);
    if (!button) throw new Error(`Project board tab not found: ${tabLabel}`);
    button.click();
  }, label);
}

async function clickButton(label) {
  await evaluate((buttonLabel) => {
    const button = [...document.querySelectorAll("button")].find((item) => {
      const visible = item.textContent || "";
      const aria = item.getAttribute("aria-label") || "";
      const title = item.getAttribute("title") || "";
      return visible.includes(buttonLabel) || aria.includes(buttonLabel) || title.includes(buttonLabel);
    });
    if (!button) throw new Error(`Button not found: ${buttonLabel}`);
    button.click();
  }, label);
}

async function clickBoardCard(title) {
  await evaluate((cardTitleText) => {
    const candidate = [...document.querySelectorAll(".project-board-card, .project-board-card-row, [data-card-id], button")].find((item) =>
      (item.textContent || "").includes(cardTitleText),
    );
    if (!(candidate instanceof HTMLElement)) throw new Error(`Visible board card not found: ${cardTitleText}`);
    candidate.click();
  }, title);
}

async function assertAbsoluteFile(path, expectedText) {
  const content = await readFile(path, "utf8");
  if (expectedText) assertIncludes(content, expectedText, path);
}

function assertIncludes(text, expected, label) {
  if (!text.includes(expected)) throw new Error(`Expected ${label} to include ${JSON.stringify(expected)}. Text was: ${text.slice(0, 1000)}`);
}

async function waitFor(predicate, label, timeoutMs = 60_000, arg) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(predicate, arg)) return;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}.`);
}

async function waitForState(producer, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await producer();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}.`);
}

async function evaluate(fn, arg) {
  const expression = `(${fn.toString()})(${arg === undefined ? "" : JSON.stringify(arg)})`;
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(description || "Runtime.evaluate failed.");
  }
  return result.result?.value;
}

async function captureScreenshot(path) {
  await mkdir(dirname(path), { recursive: true });
  const result = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(path, Buffer.from(result.data, "base64"));
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? 60_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed with code ${code ?? signal}.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      resolve({ command: [command, ...args].join(" "), code, stdout, stderr });
    });
  });
}

function commandSummary(result) {
  return {
    command: result.command,
    code: result.code,
    stdoutTail: result.stdout.split("\n").slice(-20).join("\n"),
    stderrTail: result.stderr.split("\n").slice(-20).join("\n"),
  };
}

async function connectCdp(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const callbacks = pending.get(message.id);
    if (!callbacks) return;
    pending.delete(message.id);
    if (message.error) callbacks.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else callbacks.resolve(message.result ?? {});
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP websocket failed to open.")), { once: true });
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() {
      ws.close();
    },
  };
}

async function waitForPageEndpoint(child) {
  const deadline = Date.now() + 120_000;
  let lastTargets = [];
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited before exposing CDP. Output tail:\n${output.join("").split("\n").slice(-80).join("\n")}`);
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      const targets = await response.json();
      if (Array.isArray(targets)) {
        lastTargets = targets;
        const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl && !String(target.url || "").startsWith("devtools://"));
        if (page) return page;
      }
    } catch {
      // CDP is not ready yet.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for Electron CDP page target. Last targets: ${JSON.stringify(lastTargets)}`);
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("No port allocated."))));
    });
    server.on("error", reject);
  });
}

async function safeDomSnapshot() {
  try {
    return await evaluate(() => ({
      title: document.title,
      text: (document.body?.innerText || "").slice(0, 8000),
    }));
  } catch {
    return undefined;
  }
}

async function terminateProcess(child) {
  if (child.exitCode !== null || child.signalCode) return;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(5_000)]);
  if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
}

async function writeReport(report) {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function classifyHarnessFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/native task|task action|Local Task|proof|Contrast|card|board|changedFiles|Task actions/i.test(message)) return "product";
  if (/gmi|provider|api key|stream|rate|timeout|429|5\d\d/i.test(message)) return "provider-degraded-or-timeout";
  if (/cdp|electron|Ambient shell|spawn|exited|websocket|snapshot workspace/i.test(message)) return "environment-or-harness";
  return "unknown";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
