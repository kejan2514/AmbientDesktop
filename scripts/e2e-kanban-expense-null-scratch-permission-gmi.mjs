#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const outputRoot = resolve(process.env.AMBIENT_KANBAN_EXPENSE_NULL_SCRATCH_PERMISSION_OUT_DIR || join(tmpdir(), "ambient-kanban-expense-null-scratch-permission-gmi"));
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = join(outputRoot, "runs", runStamp);
const outsideProbePath = join(runRoot, "unrelated-outside-read.csv");
const workspace = join(runRoot, "workspace");
const userData = join(runRoot, "userData");
const reportPath = resolve(process.env.AMBIENT_KANBAN_EXPENSE_NULL_SCRATCH_PERMISSION_OUT || join(outputRoot, "latest.json"));
const boardScreenshotPath = join(runRoot, "phase5-expense-null-scratch-board.png");
const proofScreenshotPath = join(runRoot, "phase5-expense-null-scratch-proof.png");
const cdpPort = Number(process.env.AMBIENT_KANBAN_EXPENSE_NULL_SCRATCH_PERMISSION_CDP_PORT || 0) || (await availablePort());
const workerIdleTimeoutMs = Number(process.env.AMBIENT_KANBAN_EXPENSE_NULL_SCRATCH_PERMISSION_IDLE_TIMEOUT_MS || 0) || 240_000;
const workerRunMaxElapsedMs = Number(process.env.AMBIENT_KANBAN_EXPENSE_NULL_SCRATCH_PERMISSION_MAX_TIMEOUT_MS || 0) || 900_000;
const defaultRepoKeyFile = join(repoRoot, "ignored-provider-key-file.txt");
const defaultHomeCheckoutKeyFile = join(homedir(), "ambientCoder", "ignored-provider-key-file.txt");
const keyFile = resolve(process.env.GMI_CLOUD_API_KEY_FILE || (existsSync(defaultRepoKeyFile) ? defaultRepoKeyFile : defaultHomeCheckoutKeyFile));
const defaultSnapshotWorkspace = join(homedir(), "Documents", "ambientCoderArchive");
const sourceWorkspace =
  process.env.AMBIENT_KANBAN_EXPENSE_NULL_SCRATCH_PERMISSION_SNAPSHOT_WORKSPACE ||
  process.env.AMBIENT_DESKTOP_WORKSPACE ||
  (existsSync(defaultSnapshotWorkspace) ? defaultSnapshotWorkspace : "");
const sourceUserData = process.env.AMBIENT_KANBAN_EXPENSE_NULL_SCRATCH_PERMISSION_SNAPSHOT_USER_DATA || process.env.AMBIENT_E2E_USER_DATA || "";
const nullDeviceProofCommand = "node tests/verify-expense-summary.mjs > /dev/null 2>&1";
const scratchProofCommand =
  "mkdir -p tmp && node --input-type=module -e 'import { readFileSync } from \"node:fs\"; const report = JSON.parse(readFileSync(\"reports/expense-summary.json\", \"utf8\")); console.log(JSON.stringify({ scratchProof: true, totalAmount: report.totalAmount, unusualCount: report.unusualRows.length }, null, 2));' > tmp/expense-scratch-proof.json";
const outsideReadCommand = `cat ${outsideProbePath}`;

const cardSpec = {
  key: "expense-null-scratch-proof",
  title: `Phase 5 Gate B expense null scratch proof ${runStamp}`,
  expectedFiles: [
    "data/expenses.csv",
    "summarize-expenses.mjs",
    "tests/verify-expense-summary.mjs",
    "reports/expense-summary.json",
    "tmp/expense-scratch-proof.json",
    "blocked-outside-read.json",
  ],
};

const output = [];
let app;
let cdp;
let outsideReadPromptText = "";

try {
  if (!sourceWorkspace || !existsSync(sourceWorkspace)) {
    throw new Error("Set AMBIENT_KANBAN_EXPENSE_NULL_SCRATCH_PERMISSION_SNAPSHOT_WORKSPACE to a local snapshot workspace directory.");
  }
  if (!existsSync(keyFile) && !process.env.GMI_CLOUD_API_KEY && !process.env.GMI_API_KEY) {
    throw new Error("Set GMI_CLOUD_API_KEY_FILE, GMI_CLOUD_API_KEY, or GMI_API_KEY before running the GMI expense null/scratch permission gate.");
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

  const { board, card } = await createBoardAndCard();
  await openProjectBoard();
  await clickProjectBoardTab("Board");
  await captureScreenshot(boardScreenshotPath);

  const result = await approveRunAndVerifyCard(card, cardSpec);
  const expenseReport = await assertExpenseReports(result.run.workspacePath);
  const permissionAudit = await assertPermissionAudit();
  const visiblePermissionDialog = await currentPermissionDialogText();
  if (visiblePermissionDialog.includes(outsideProbePath)) {
    throw new Error(`The unrelated outside-read permission dialog remained open after denial: ${visiblePermissionDialog}`);
  }
  await captureScreenshot(proofScreenshotPath);

  const report = {
    status: "passed",
    providerId: provider.providerId,
    usedGmiKeyFile: existsSync(keyFile),
    sourceWorkspace,
    usedSnapshotUserData: Boolean(sourceUserData && existsSync(sourceUserData)),
    runRoot,
    boardId: board.id,
    card: {
      key: result.spec.key,
      cardId: result.card.id,
      taskId: result.card.orchestrationTaskId,
      runId: result.run.id,
      runStatus: result.run.status,
      runWorkspacePath: result.run.workspacePath,
      changedPaths: result.changedPaths,
      taskActions: result.taskActions,
      proofReview: result.reviewedCard.proofReview,
    },
    expenseReport,
    permissionAudit,
    outsideProbePath,
    outsideReadPromptText,
    screenshots: { board: boardScreenshotPath, proof: proofScreenshotPath },
    assertions: [
      "Desktop launched with the GMI Cloud provider against a temp copy of Documents/ambientCoderArchive",
      "A CSV expense Local Task was prepared and started through visible Board UI controls",
      "The worker ran a proof command with output redirected to /dev/null without a false outside-workspace prompt",
      "The worker wrote a workspace-local temporary scratch proof file under tmp/",
      "Permission audit recorded null-device and scratch proof commands as allowed workspace-scoped scratch proof output",
      "The deliberate unrelated outside read produced an outside-workspace permission prompt, was denied, and did not remain open",
      "Final expense report and scratch proof artifacts were useful and internally consistent",
    ],
  };
  await writeReport(report);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const report = {
    status: "failed",
    classification: classifyHarnessFailure(error),
    message: error instanceof Error ? error.message : String(error),
    runRoot,
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
  await writeFile(outsideProbePath, "outside-probe-should-not-appear,999\n", "utf8");
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
  await rm(join(workspace, "data"), { recursive: true, force: true });
  await rm(join(workspace, "reports"), { recursive: true, force: true });
  await rm(join(workspace, "tmp"), { recursive: true, force: true });
  await rm(join(workspace, "summarize-expenses.mjs"), { force: true });
  await rm(join(workspace, "blocked-outside-read.json"), { force: true });
  await rm(join(workspace, "tests", "verify-expense-summary.mjs"), { force: true });
  for (const path of ["ignored-provider-key-file.txt", "ignored-provider-key-file.txt", "brave_api_key.txt", ".env", ".env.local"]) {
    await rm(join(workspace, path), { force: true });
  }
  await removeCredentialNamedFiles(workspace, 3);
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
    if (entry.isDirectory() && !["node_modules", ".git"].includes(entry.name)) {
      await removeCredentialNamedFiles(path, maxDepth - 1);
    }
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
  stall_timeout_ms: 420000
workspace:
  strategy: directory
  root: .ambient-codex/orchestration/workspaces
  branch_prefix: ambient/
  cleanup_terminal_workspaces: false
  reuse_existing: true
agent:
  permission_mode: workspace
  extra_instructions: |
    This is a bounded Phase 5 semantic permission gate. Do not inspect, print, summarize, or copy API keys, secret files, local-secrets folders, credentials, browser profiles, or environment values. Do not install packages or use network calls. Keep all writes inside the writable task workspace. The only outside path mentioned by the task is a benign permission-denial probe; run it only when explicitly requested, expect denial, and never include outside file contents in artifacts.
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
- Do not mutate the owning project root. The Project Board Integration Queue will apply accepted deliverables later.
- Do not read or expose secret files, API key files, credential directories, browser profiles, or environment values.
- Do not read outside-workspace paths except the exact benign denied probe command named in the task description.

Title: {{ task.title }}

Description:
{{ task.description }}

Complete the task in the prepared workspace. Keep the scope narrow, run the requested verification commands exactly, and finish with project-board task actions that name the changed files and commands.
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
      AMBIENT_CODEX_CURATED_MARKETPLACE_URL: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));
  const target = await waitForPageEndpoint(child);
  return { child, webSocketDebuggerUrl: target.webSocketDebuggerUrl };
}

async function createBoardAndCard() {
  const initialState = await invoke("bootstrap");
  const activeProject = initialState.projects.find((project) => project.path === initialState.workspace.path) ?? initialState.projects[0];
  if (!activeProject) throw new Error("No active project available for expense null/scratch permission gate.");
  const stateWithBoard = await invoke("createProjectBoard", {
    projectId: activeProject.id,
    title: "Phase 5 Expense Null Scratch Permission Gate Board",
    summary: "Live Gate B proof that null-device and workspace scratch proof outputs are allowed while unrelated outside reads stay guarded.",
  });
  let board = boardFromState(stateWithBoard);
  if (board.status !== "active") {
    board = boardFromState(await invoke("updateProjectBoardStatus", { boardId: board.id, status: "active" }));
  }

  const card = await createReadyCard(board.id, cardSpec.title, expenseNullScratchDescription(), {
    priority: 1,
    labels: ["phase-5", "semantic-permissions", "expense-summary", "scratch-output", "live-gmi"],
    blockedBy: [],
    acceptanceCriteria: [
      "Create a deterministic CSV expense fixture and dependency-free summarizer.",
      "Run the exact null-device proof command and exact workspace scratch proof command.",
      "Run the exact unrelated outside-read probe command, expect Ambient permission denial, and record the denial without retrying.",
      "Write reports/expense-summary.json, tmp/expense-scratch-proof.json, and blocked-outside-read.json.",
      "Report project-board proof with changedFiles covering all material outputs and commands covering all verification commands.",
    ],
    testPlan: {
      unit: ["Run node --check summarize-expenses.mjs.", "Run node tests/verify-expense-summary.mjs."],
      integration: [nullDeviceProofCommand, scratchProofCommand, outsideReadCommand],
      visual: [],
      manual: [],
    },
  });
  board = boardFromState(await invoke("bootstrap"));
  return { board, card };
}

async function createReadyCard(boardId, title, description, fields) {
  let board = boardFromState(await invoke("bootstrap"));
  const beforeIds = new Set(board.cards.map((card) => card.id));
  let state = await invoke("createProjectBoardCard", {
    boardId,
    title,
    description: description.slice(0, 1000),
  });
  board = boardFromState(state);
  const created = board.cards.find((card) => !beforeIds.has(card.id) && card.sourceKind === "manual");
  if (!created) throw new Error(`Manual card was not created: ${title}`);
  state = await invoke("updateProjectBoardCard", {
    cardId: created.id,
    title,
    description,
    candidateStatus: "ready_to_create",
    priority: fields.priority,
    phase: "Phase 5 Gate B",
    labels: fields.labels,
    blockedBy: fields.blockedBy,
    acceptanceCriteria: fields.acceptanceCriteria,
    testPlan: fields.testPlan,
    clarificationQuestions: [],
  });
  board = boardFromState(state);
  const ready = board.cards.find((card) => card.id === created.id);
  if (!ready || ready.candidateStatus !== "ready_to_create") throw new Error(`Card did not become ready_to_create: ${title}`);
  return ready;
}

function expenseNullScratchDescription() {
  return [
    "Create a dependency-free CSV expense summarizer proof in this card's writable task workspace. Do not modify the owning project root directly.",
    "",
    "Required files: data/expenses.csv, summarize-expenses.mjs, tests/verify-expense-summary.mjs, reports/expense-summary.json, tmp/expense-scratch-proof.json, blocked-outside-read.json.",
    "CSV rows: meals 42.15 USD; travel 315.20 USD; lodging 620.00 USD with empty notes; software 89.99 USD; supplies 23.45 USD; travel 140.00 EUR.",
    "summarize-expenses.mjs must export summarizeExpenses(csvText), write reports/expense-summary.json from CLI args, compute USD-only totalAmount 1090.79, rowCount 6, totals, and unusualRows for amount over 500, lodging missing notes, and non-USD currency.",
    "tests/verify-expense-summary.mjs must assert passed true, totalAmount 1090.79, rowCount 6, unusualRows length 2, lodging missing-note evidence, and non-USD evidence.",
    "tmp/expense-scratch-proof.json must include scratchProof true, totalAmount 1090.79, and unusualCount 2.",
    "blocked-outside-read.json must include blockedOutsideRead true, denied true, and command exactly matching the outside-read probe. Do not include outside file contents.",
    "",
    "Run these exact commands from the task workspace:",
    "- node --check summarize-expenses.mjs",
    "- node summarize-expenses.mjs data/expenses.csv reports/expense-summary.json",
    "- node tests/verify-expense-summary.mjs",
    `- ${nullDeviceProofCommand}`,
    `- ${scratchProofCommand}`,
    `- ${outsideReadCommand}`,
    "",
    "The outside-read probe is expected to be denied by Ambient Desktop. Do not request approval, retry, or treat denial as failure; after denial, write blocked-outside-read.json and complete.",
    "",
    "Project-board reporting: call task_heartbeat first. After verification, call task_report_proof with changedFiles exactly including all required files and commands including all six commands above. Then call task_complete.",
    "- Do not install dependencies, call network services, read secrets, write outside the task workspace, or read any outside path except the single explicit denied outside-read probe.",
  ].join("\n");
}

async function approveRunAndVerifyCard(card, spec) {
  const state = await invoke("approveProjectBoardCard", { cardId: card.id });
  const board = boardFromState(state);
  const ticketized = board.cards.find((candidate) => candidate.id === card.id);
  if (!ticketized?.orchestrationTaskId) throw new Error(`${spec.title} was not ticketized into a Local Task.`);

  const task = await waitForTask(ticketized.orchestrationTaskId);
  const description = String(task.description || "");
  for (const required of [nullDeviceProofCommand, scratchProofCommand, outsideReadCommand]) {
    if (!description.includes(required)) {
      throw new Error(`${spec.title} task description lost required permission proof command: ${required}`);
    }
  }

  const { run: preparedRun } = await prepareRunViaUi(ticketized.orchestrationTaskId, spec.title);
  const run = await startRunViaUi(preparedRun.id, spec.title);
  if (run.status !== "completed") {
    throw new Error(`${spec.title} Local Task did not complete. Status=${run.status}; error=${run.error ?? "none"}.`);
  }

  const reviewedCard = await waitForCardProofReview(ticketized.id, spec.title);
  const taskActions = taskActionObservation(run.proofOfWork);
  if (taskActions.count <= 0) throw new Error(`${spec.title} completed without project-board task actions.`);
  if (taskActions.terminalCount <= 0) throw new Error(`${spec.title} completed without a terminal project-board task action.`);
  const changedPaths = meaningfulChangedPaths(run.proofOfWork);
  for (const file of spec.expectedFiles) {
    if (!changedPaths.includes(file)) {
      throw new Error(`${spec.title} proof did not report expected deliverable ${file}. Reported: ${changedPaths.join(", ") || "none"}.`);
    }
    await assertAbsoluteFile(join(run.workspacePath, file), expectedNeedleForFile(file));
  }
  if (reviewedCard.proofReview?.status !== "done") {
    throw new Error(`${spec.title} proof review did not close as done. Review=${JSON.stringify(reviewedCard.proofReview)}`);
  }
  return { spec, card: reviewedCard, run, taskActions, changedPaths, reviewedCard };
}

async function prepareRunViaUi(taskId, title) {
  await reloadRendererForFreshBoardState(`preparing ${title}`);
  await openProjectBoard();
  await clickProjectBoardTab("Board");
  await clickButton("Prepare Runs");
  return waitForPreparedOrStartedRun(taskId, title);
}

async function startRunViaUi(runId, title) {
  await openProjectBoard();
  await clickProjectBoardTab("Board");
  await waitFor(() => document.body?.innerText.includes("Start Run") || document.body?.innerText.includes("Start run"), `visible Start Run control for ${title}`, 120_000);
  await clickButton("Start Run");
  return waitForTerminalRun(runId, title);
}

async function waitForTask(taskId) {
  return waitForState(
    async () => {
      const board = await invoke("listOrchestrationBoard");
      return board.tasks.find((candidate) => candidate.id === taskId);
    },
    `Local Task ${taskId}`,
    60_000,
  );
}

async function waitForPreparedOrStartedRun(taskId, title) {
  return waitForState(
    async () => {
      const board = await invoke("listOrchestrationBoard");
      const run = board.runs.find((candidate) => candidate.taskId === taskId && ["prepared", "running", "completed", "failed", "stalled", "canceled"].includes(candidate.status));
      return run ? { board, run } : undefined;
    },
    `prepared or started Local Task run for ${title}`,
    300_000,
  );
}

async function waitForTerminalRun(runId, title) {
  const startedAt = Date.now();
  let lastActivityAt = Date.now();
  let lastSignature = "";
  while (true) {
    await maybeDenyOutsideReadPrompt();
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
      throw new Error(`Timed out waiting for terminal ${title} Local Task run; no run progress was observed for ${workerIdleTimeoutMs.toLocaleString()}ms.`);
    }
    if (Date.now() - startedAt > workerRunMaxElapsedMs) {
      throw new Error(`Timed out waiting for terminal ${title} Local Task run after ${workerRunMaxElapsedMs.toLocaleString()}ms total elapsed.`);
    }
    await delay(1000);
  }
}

async function maybeDenyOutsideReadPrompt() {
  const text = await currentPermissionDialogText().catch(() => "");
  if (!text.includes(outsideProbePath)) return;
  if (!outsideReadPromptText) outsideReadPromptText = text;
  await evaluate(() => {
    const dialog = document.querySelector(".permission-dialog[role='dialog']");
    const deny = dialog ? [...dialog.querySelectorAll("button")].find((button) => (button.textContent || "").trim() === "Deny") : undefined;
    if (!deny) throw new Error("Deny button not found in outside-read permission dialog");
    deny.click();
  });
  await waitFor((path) => !document.querySelector(".permission-dialog[role='dialog']")?.textContent?.includes(path), "outside-read permission dialog denial", 30_000, outsideProbePath);
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
    proof.lastAssistantText,
    taskActionObservation(proof).count,
  ].join("|");
}

async function waitForCardProofReview(cardId, title) {
  return waitForState(
    async () => {
      const state = await invoke("bootstrap");
      const board = boardFromState(state);
      const card = board.cards.find((candidate) => candidate.id === cardId);
      return card?.proofReview ? card : undefined;
    },
    `${title} card proof review`,
    240_000,
  );
}

function taskActionObservation(proof) {
  const actions = Array.isArray(proof?.taskToolActions) ? proof.taskToolActions : [];
  const countsByAction = {};
  for (const action of actions) {
    const key = typeof action?.action === "string" ? action.action : "unknown";
    countsByAction[key] = (countsByAction[key] ?? 0) + 1;
  }
  const terminalCount = actions.filter((action) =>
    ["task_block", "task_complete", "task_create_followup", "task_report_proof", "task_report_handoff"].includes(action?.action),
  ).length;
  return { count: actions.length, terminalCount, countsByAction };
}

function meaningfulChangedPaths(proof) {
  const actions = Array.isArray(proof?.taskToolActions) ? proof.taskToolActions : [];
  return uniqueStrings([
    ...stringsFromUnknownArray(proof?.changedFiles),
    ...stringsFromUnknownArray(proof?.toolChangedFiles),
    ...actions.flatMap((action) => stringsFromUnknownArray(action?.changedFiles)),
  ]).filter((file) => file && !file.startsWith(".ambient/") && !file.startsWith(".ambient-codex/") && !file.startsWith("node_modules/"));
}

function stringsFromUnknownArray(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [item.trim().replace(/^[MADRCU?! ]+\s+/, "").replace(/^\.\//, "")];
    if (item && typeof item === "object") {
      for (const key of ["path", "file", "name", "command"]) {
        if (typeof item[key] === "string") return [item[key].trim().replace(/^[MADRCU?! ]+\s+/, "").replace(/^\.\//, "")];
      }
    }
    return [];
  });
}

function uniqueStrings(values) {
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))].sort();
}

function expectedNeedleForFile(file) {
  if (file === "data/expenses.csv") return "lodging";
  if (file === "summarize-expenses.mjs") return "summarizeExpenses";
  if (file === "tests/verify-expense-summary.mjs") return "expense-summary.json";
  if (file === "reports/expense-summary.json") return '"totalAmount"';
  if (file === "tmp/expense-scratch-proof.json") return '"scratchProof"';
  if (file === "blocked-outside-read.json") return '"blockedOutsideRead"';
  return "";
}

async function assertExpenseReports(runWorkspacePath) {
  const reportText = await assertAbsoluteFile(join(runWorkspacePath, "reports", "expense-summary.json"), '"totalAmount"');
  const report = JSON.parse(reportText);
  if (report.passed !== undefined && report.passed !== true) throw new Error(`Expected expense report passed true when present: ${reportText}`);
  if (Number(report.totalAmount) !== 1090.79) throw new Error(`Expected totalAmount 1090.79, got ${report.totalAmount}`);
  if (Number(report.rowCount) !== 6) throw new Error(`Expected rowCount 6, got ${report.rowCount}`);
  const unusualRows = Array.isArray(report.unusualRows) ? report.unusualRows : [];
  if (unusualRows.length !== 2) throw new Error(`Expected 2 unusualRows, got ${unusualRows.length}: ${reportText}`);
  const unusualText = JSON.stringify(unusualRows).toLowerCase();
  if (!unusualText.includes("lodging") || !unusualText.includes("non-usd")) {
    throw new Error(`Unexpected unusualRows evidence: ${JSON.stringify(unusualRows)}`);
  }

  const scratchText = await assertAbsoluteFile(join(runWorkspacePath, "tmp", "expense-scratch-proof.json"), '"scratchProof"');
  const scratch = JSON.parse(scratchText);
  if (scratch.scratchProof !== true) throw new Error(`Expected scratchProof true: ${scratchText}`);
  if (Number(scratch.totalAmount) !== 1090.79) throw new Error(`Expected scratch totalAmount 1090.79, got ${scratch.totalAmount}`);
  if (Number(scratch.unusualCount) !== 2) throw new Error(`Expected scratch unusualCount 2, got ${scratch.unusualCount}`);

  const blockedText = await assertAbsoluteFile(join(runWorkspacePath, "blocked-outside-read.json"), '"blockedOutsideRead"');
  const blocked = JSON.parse(blockedText);
  if (blocked.blockedOutsideRead !== true || blocked.denied !== true) throw new Error(`Expected blocked outside read denial evidence: ${blockedText}`);
  if (blocked.command !== outsideReadCommand) throw new Error(`Blocked outside read command mismatch: ${blocked.command}`);
  if (blockedText.includes("outside-probe-should-not-appear")) throw new Error("Blocked outside read artifact included outside file contents.");

  return {
    passed: report.passed ?? true,
    totalAmount: report.totalAmount,
    rowCount: report.rowCount,
    unusualCount: unusualRows.length,
    scratchProof: scratch.scratchProof,
    blockedOutsideRead: blocked.blockedOutsideRead,
  };
}

async function assertPermissionAudit() {
  const audit = await invoke("listPermissionAudit");
  const scratchEntries = audit.filter((entry) => entry.toolName === "bash" && entry.decision === "allowed" && String(entry.reason || "").includes("scratch proof output"));
  const nullDeviceEntry = scratchEntries.find((entry) => String(entry.detail || "").includes("/dev/null"));
  if (!nullDeviceEntry) throw new Error(`Permission audit did not record an allowed scratch-output /dev/null command. Entries=${JSON.stringify(scratchEntries)}`);
  const scratchFileEntry = scratchEntries.find((entry) => String(entry.detail || "").includes("tmp/expense-scratch-proof.json"));
  if (!scratchFileEntry) throw new Error(`Permission audit did not record an allowed workspace scratch proof command. Entries=${JSON.stringify(scratchEntries)}`);

  const outsideEntries = audit.filter((entry) => entry.toolName === "bash" && entry.risk === "outside-workspace" && String(entry.detail || "").includes(outsideProbePath));
  const deniedOutsideRead = outsideEntries.find((entry) => entry.decision === "denied");
  if (!deniedOutsideRead) throw new Error(`Permission audit did not record a denied outside-read probe. Entries=${JSON.stringify(outsideEntries)}`);

  const falseNullPrompt = audit.find((entry) => entry.risk === "outside-workspace" && String(entry.detail || "").includes("/dev/null"));
  if (falseNullPrompt) throw new Error(`False outside-workspace prompt for /dev/null proof output: ${JSON.stringify(falseNullPrompt)}`);
  const falseWorkspaceScratchPrompt = audit.find((entry) => entry.risk === "outside-workspace" && String(entry.detail || "").includes("tmp/expense-scratch-proof.json"));
  if (falseWorkspaceScratchPrompt) throw new Error(`False outside-workspace prompt for workspace scratch proof output: ${JSON.stringify(falseWorkspaceScratchPrompt)}`);

  return {
    allowedScratchCommandCount: scratchEntries.length,
    nullDeviceReason: nullDeviceEntry.reason,
    scratchFileReason: scratchFileEntry.reason,
    deniedOutsideReadRisk: deniedOutsideRead.risk,
    deniedOutsideReadDecision: deniedOutsideRead.decision,
    deniedOutsideReadDetailIncludesProbe: String(deniedOutsideRead.detail || "").includes(outsideProbePath),
    falseNullDevicePromptCount: audit.filter((entry) => entry.risk === "outside-workspace" && String(entry.detail || "").includes("/dev/null")).length,
    falseWorkspaceScratchPromptCount: audit.filter((entry) => entry.risk === "outside-workspace" && String(entry.detail || "").includes("tmp/expense-scratch-proof.json")).length,
  };
}

async function currentPermissionDialogText() {
  return evaluate(() => document.querySelector(".permission-dialog[role='dialog']")?.textContent || "");
}

async function openProjectBoard() {
  if (await evaluate(() => Boolean(document.querySelector(".project-board-tabs"))).catch(() => false)) return;
  await waitFor(() => document.body?.innerText.includes("Open Board"), "Open Board action");
  await clickButton("Open Board");
  await waitFor(() => document.querySelector(".project-board-tabs")?.textContent?.includes("Board"), "project board tabs");
}

async function clickProjectBoardTab(label) {
  await evaluate((tabLabel) => {
    const button = [...document.querySelectorAll(".project-board-tabs button")].find((item) => item.querySelector("span")?.textContent?.trim() === tabLabel);
    if (!button) throw new Error(`Project board tab not found: ${tabLabel}`);
    button.click();
  }, label);
}

async function reloadRendererForFreshBoardState(label) {
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitFor(
    () => document.readyState === "complete" && Boolean(window.ambientDesktop) && Boolean(document.body?.innerText.includes("Ambient")),
    `renderer reload for ${label}`,
    120_000,
  );
  await waitFor(
    async () => {
      const bridge = window.ambientDesktop;
      if (!bridge?.bootstrap) return false;
      const state = await bridge.bootstrap();
      return Boolean(state?.projects?.length);
    },
    `fresh Desktop bootstrap state for ${label}`,
    120_000,
  );
}

async function describeButtons(label) {
  return evaluate((buttonLabel) => {
    const needle = String(buttonLabel).toLowerCase();
    return [...document.querySelectorAll("button")]
      .map((item) => {
        const rect = item.getBoundingClientRect();
        const haystack = [item.textContent || "", item.getAttribute("aria-label") || "", item.getAttribute("title") || ""].join(" ").toLowerCase();
        return {
          text: (item.textContent || "").trim().replace(/\s+/g, " "),
          ariaLabel: item.getAttribute("aria-label") || "",
          title: item.getAttribute("title") || "",
          disabled: item.disabled || item.getAttribute("aria-disabled") === "true",
          visible: rect.width > 0 && rect.height > 0 && getComputedStyle(item).visibility !== "hidden" && getComputedStyle(item).display !== "none",
          matches: haystack.includes(needle),
        };
      })
      .filter((item) => item.matches);
  }, label);
}

async function waitForVisibleEnabledButton(label, timeoutMs = 60_000) {
  const started = Date.now();
  let lastCandidates = [];
  while (Date.now() - started < timeoutMs) {
    lastCandidates = await describeButtons(label);
    if (lastCandidates.some((candidate) => candidate.visible && !candidate.disabled)) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for enabled visible ${label} button; candidates=${JSON.stringify(lastCandidates)}`);
}

async function clickButton(label) {
  await waitForVisibleEnabledButton(label);
  await evaluate((buttonLabel) => {
    const needle = String(buttonLabel).toLowerCase();
    const button = [...document.querySelectorAll("button")].find((item) => {
      const haystack = [item.textContent || "", item.getAttribute("aria-label") || "", item.getAttribute("title") || ""].join(" ").toLowerCase();
      const rect = item.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(item).visibility !== "hidden" && getComputedStyle(item).display !== "none";
      const disabled = item.disabled || item.getAttribute("aria-disabled") === "true";
      return haystack.includes(needle) && visible && !disabled;
    });
    if (!button) throw new Error(`Enabled visible button not found after wait: ${buttonLabel}`);
    button.click();
  }, label);
}

async function captureScreenshot(path) {
  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(screenshot.data, "base64"));
}

async function assertAbsoluteFile(path, needle) {
  const text = await readFile(path, "utf8").catch((error) => {
    throw new Error(`Expected file at ${path}: ${error.message}`);
  });
  if (needle && !text.includes(needle)) throw new Error(`Expected ${path} to contain ${needle}.`);
  return text;
}

function boardFromState(state) {
  const activeProject = state.projects.find((project) => project.path === state.workspace.path) ?? state.projects[0];
  if (!activeProject?.board) throw new Error("No project board available in Desktop state.");
  return activeProject.board;
}

async function invoke(method, args) {
  return evaluate(
    async ({ method: methodName, args: methodArgs }) => {
      const bridge = window.ambientDesktop;
      if (!bridge || typeof bridge[methodName] !== "function") throw new Error(`ambientDesktop.${methodName} is unavailable`);
      return methodArgs === undefined ? bridge[methodName]() : bridge[methodName](methodArgs);
    },
    { method, args },
  );
}

async function evaluate(fn, arg) {
  const expression = `(${fn})(${JSON.stringify(arg)})`;
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: 120_000,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Evaluation failed");
  }
  return result.result.value;
}

async function waitFor(predicate, label, timeoutMs = 60_000, arg) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      if (await evaluate(predicate, arg)) return true;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

async function waitForState(fn, label, timeoutMs = 60_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

async function connectCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out connecting to CDP websocket")), 30_000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("CDP websocket connection failed"));
    });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data.toString());
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() {
      socket.close();
    },
  };
}

async function waitForPageEndpoint(child) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited early with code ${child.exitCode}. Output:\n${output.join("").slice(-4000)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      const targets = await response.json();
      const target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl) ?? targets.find((item) => item.webSocketDebuggerUrl);
      if (target) return target;
    } catch {
      // Dev server not listening yet.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for Electron CDP endpoint. Output:\n${output.join("").slice(-4000)}`);
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function writeReport(report) {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function terminateProcess(child) {
  if (child.exitCode !== null) return;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(5000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }),
  ]);
}

function classifyHarnessFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/Expected gmi-cloud|API key|provider|Ambient\/Pi|stream|model|rate|timeout/i.test(message)) return "provider-degraded";
  if (/CDP|Electron|Timed out waiting for Ambient shell|websocket|dev server/i.test(message)) return "environment/snapshot issue";
  if (/Local Task|proof|permission|outside-workspace|expense|scratch|blocked|project-board|card|board|verification/i.test(message)) return "product";
  return "test harness";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
