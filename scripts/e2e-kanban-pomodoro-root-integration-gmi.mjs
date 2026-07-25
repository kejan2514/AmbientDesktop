#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const outputRoot = resolve(process.env.AMBIENT_KANBAN_POMODORO_ROOT_OUT_DIR || join(tmpdir(), "ambient-kanban-pomodoro-root-integration-gmi"));
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = join(outputRoot, "runs", runStamp);
const workspace = join(runRoot, "workspace");
const userData = join(runRoot, "userData");
const reportPath = resolve(process.env.AMBIENT_KANBAN_POMODORO_ROOT_OUT || join(outputRoot, "latest.json"));
const boardScreenshotPath = join(runRoot, "phase2-pomodoro-board.png");
const integrationScreenshotPath = join(runRoot, "phase2-pomodoro-integration.png");
const cdpPort = Number(process.env.AMBIENT_KANBAN_POMODORO_ROOT_CDP_PORT || 0) || (await availablePort());
const workerRunMaxElapsedMs = Number(process.env.AMBIENT_KANBAN_POMODORO_ROOT_RUN_MAX_TIMEOUT_MS || 0) || 1_200_000;
const workerIdleTimeoutMs = Number(process.env.AMBIENT_KANBAN_POMODORO_ROOT_RUN_IDLE_TIMEOUT_MS || 0) || 300_000;
const keyFile = resolve(process.env.GMI_CLOUD_API_KEY_FILE || join(repoRoot, "ignored-provider-key-file.txt"));
const defaultSnapshotWorkspace = join(homedir(), "Documents", "ambientCoderArchive");
const sourceWorkspace =
  process.env.AMBIENT_KANBAN_POMODORO_ROOT_SNAPSHOT_WORKSPACE ||
  process.env.AMBIENT_DESKTOP_WORKSPACE ||
  (existsSync(defaultSnapshotWorkspace) ? defaultSnapshotWorkspace : "");
const sourceUserData = process.env.AMBIENT_KANBAN_POMODORO_ROOT_SNAPSHOT_USER_DATA || process.env.AMBIENT_E2E_USER_DATA || "";
const cardTitle = "Pomodoro mini-app root integration";
const expectedFiles = ["index.html", "app.js", "style.css", "tests/checklist.md", "tests/verify-pomodoro.mjs"];
const output = [];
let app;
let cdp;

try {
  if (!sourceWorkspace || !existsSync(sourceWorkspace)) {
    throw new Error("Set AMBIENT_KANBAN_POMODORO_ROOT_SNAPSHOT_WORKSPACE to a local snapshot workspace directory.");
  }
  if (!existsSync(keyFile) && !process.env.GMI_CLOUD_API_KEY && !process.env.GMI_API_KEY) {
    throw new Error("Set GMI_CLOUD_API_KEY_FILE, GMI_CLOUD_API_KEY, or GMI_API_KEY before running the GMI Desktop Pomodoro gate.");
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

  const { board, card } = await createPomodoroImplementationCard();
  await waitFor(() => document.body?.innerText.includes("Open Board"), "Open Board action");
  await clickButton("Open Board");
  await waitFor(() => document.querySelector(".project-board-tabs")?.textContent?.includes("Board"), "project board tabs");
  await clickProjectBoardTab("Board");
  await captureScreenshot(boardScreenshotPath);

  await invokeDetached("prepareNextOrchestrationTasks", undefined, "__kanbanPomodoroPrepareError");
  const { run: preparedRun } = await waitForPreparedOrStartedRun(card.orchestrationTaskId, card.title);
  if (preparedRun.status === "prepared") {
    await invokeDetached("startOrchestrationRun", { runId: preparedRun.id }, "__kanbanPomodoroRunStartError");
  }
  const terminalRun = await waitForTerminalRun(preparedRun.id);
  if (terminalRun.status !== "completed") {
    throw new Error(`Pomodoro Local Task did not complete. Status=${terminalRun.status}; error=${terminalRun.error ?? "none"}.`);
  }

  const reviewedCard = await waitForCardProofReview(card.id);
  const taskActions = taskActionObservation(terminalRun.proofOfWork);
  if (taskActions.count <= 0) throw new Error("Pomodoro run completed without project-board task actions.");
  if (taskActions.terminalCount <= 0) throw new Error("Pomodoro run completed without a terminal project-board task action.");
  const changedPaths = meaningfulChangedPaths(terminalRun.proofOfWork);
  for (const file of expectedFiles) {
    if (!changedPaths.includes(file)) {
      throw new Error(`Pomodoro run proof did not report expected deliverable ${file}. Reported: ${changedPaths.join(", ") || "none"}.`);
    }
    await assertAbsoluteFile(join(terminalRun.workspacePath, file), file === "app.js" ? "export const pomodoroMinutes" : file === "index.html" ? "Pomodoro" : "");
  }
  if (reviewedCard.proofReview?.status !== "done") {
    throw new Error(`Pomodoro card proof review did not close as done. Review=${JSON.stringify(reviewedCard.proofReview)}`);
  }

  await waitFor(() => document.body?.innerText.includes("Executable board closed; integration pending"), "closed board integration pending state", 180_000);
  await clickProjectBoardTab("Integration");
  await waitFor(() => document.querySelector(".project-board-integration-panel")?.textContent?.includes("Integration Queue"), "Integration panel selected");
  await waitFor(
    (title) => document.querySelector(".project-board-integration-panel")?.textContent?.includes(title),
    "Pomodoro deliverable queue item",
    60_000,
    cardTitle,
  );
  const pendingText = await elementText(".project-board-integration-panel");
  assertIncludes(pendingText, "1 pending", "initial Pomodoro pending count");
  for (const file of expectedFiles) assertIncludes(pendingText, file, `visible integration manifest for ${file}`);

  for (const file of expectedFiles) assertFileAbsent(file, `${file} should not exist in project root before visible integration`);
  await clickIntegrationAction(cardTitle, "Apply To Root");
  await waitForIntegrationStatus(cardTitle, "Integrated");
  const resolvedText = await elementText(".project-board-integration-panel");
  assertIncludes(resolvedText, "Resolved", "resolved integration status");
  assertIncludes(resolvedText, "1 integrated, 0 exported, and 0 deferred", "resolved integration outcome summary");

  await assertWorkspaceFile("index.html", "Pomodoro");
  await assertWorkspaceFile("app.js", "export const pomodoroMinutes");
  await assertWorkspaceFile("style.css", "font-family");
  await assertWorkspaceFile("tests/checklist.md", "Reset");
  await assertWorkspaceFile("tests/verify-pomodoro.mjs", "pomodoroMinutes");
  assertFileAbsent("node_modules/pomodoro-root-integration/index.js", "dependency cache should not be copied to root");
  assertFileAbsent(".ambient/phase2-pomodoro-runtime.json", "runtime file should not be copied to root");

  await captureScreenshot(integrationScreenshotPath);
  await clickProjectBoardTab("Board");
  await waitFor(() => document.body?.innerText.includes("Executable board closed; deliverables integrated"), "closed board deliverables integrated state", 180_000);

  const report = {
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
    taskActions,
    changedPaths,
    proofReview: reviewedCard.proofReview,
    screenshots: { board: boardScreenshotPath, integration: integrationScreenshotPath },
    assertions: [
      "Live GMI Local Task created Pomodoro deliverables through a project-board implementation card",
      "Proof included project-board task actions and all expected material changed files",
      "Board reached integration-pending close state before root writes",
      "Visible Integration Queue applied deliverables to the temp snapshot root",
      "Root contains index.html, app.js, style.css, tests/checklist.md, and tests/verify-pomodoro.mjs after integration",
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
    outputTail: output.join("").split("\n").slice(-160),
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
  for (const path of ["index.html", "app.js", "style.css", "tests/checklist.md", "tests/verify-pomodoro.mjs"]) {
    await rm(join(workspace, path), { force: true });
  }
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
    This is a bounded Phase 2 Pomodoro root-integration gate. Do not inspect, print, summarize, or copy API keys, secret files, local-secrets folders, credentials, browser profiles, or environment values. Do not install packages or use network calls. Keep all writes inside the writable task workspace.
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

Title: {{ task.title }}

Description:
{{ task.description }}

Complete the task in the prepared workspace. Keep the scope narrow, run the requested verification commands, and finish with project-board task actions that name the changed files and commands.
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

async function createPomodoroImplementationCard() {
  const initialState = await invoke("bootstrap");
  const activeProject = initialState.projects.find((project) => project.path === initialState.workspace.path) ?? initialState.projects[0];
  if (!activeProject) throw new Error("No active project available for Pomodoro gate.");
  const stateWithBoard = await invoke("createProjectBoard", {
    projectId: activeProject.id,
    title: "Phase 2 Pomodoro Root Integration Gate Board",
    summary: "Live execution gate for applying project-board Local Task deliverables into the project root.",
  });
  let board = boardFromState(stateWithBoard);
  if (board.status !== "active") {
    board = boardFromState(await invoke("updateProjectBoardStatus", { boardId: board.id, status: "active" }));
  }

  const beforeIds = new Set(board.cards.map((card) => card.id));
  let state = await invoke("createProjectBoardCard", {
    boardId: board.id,
    title: cardTitle,
    description: "Build the static Pomodoro mini-app deliverables in the prepared task workspace.",
  });
  board = boardFromState(state);
  const created = board.cards.find((card) => !beforeIds.has(card.id) && card.sourceKind === "manual");
  if (!created) throw new Error("Pomodoro manual implementation card was not created.");

  state = await invoke("updateProjectBoardCard", {
    cardId: created.id,
    title: cardTitle,
    description: pomodoroCardDescription(),
    candidateStatus: "ready_to_create",
    priority: 1,
    phase: "Phase 2 Gate A",
    labels: ["phase-2", "pomodoro", "integration-gate", "live-gmi"],
    blockedBy: [],
    acceptanceCriteria: [
      "Create index.html, app.js, style.css, tests/checklist.md, and tests/verify-pomodoro.mjs in the writable task workspace.",
      "The Pomodoro implementation is dependency-free, has Start, Pause, and Reset controls, and exposes a 25 minute work duration through an exported ESM pomodoroMinutes constant.",
      "Run node --check app.js and node tests/verify-pomodoro.mjs successfully from the task workspace.",
      "Report proof through project-board task actions with changedFiles covering all material deliverables and commands covering the verification commands.",
    ],
    testPlan: {
      unit: ["Run node tests/verify-pomodoro.mjs."],
      integration: ["Run node --check app.js."],
      visual: [],
      manual: [],
    },
    clarificationQuestions: [],
  });
  board = boardFromState(state);
  const ready = board.cards.find((card) => card.id === created.id);
  if (!ready) throw new Error("Pomodoro card disappeared after update.");
  state = await invoke("approveProjectBoardCard", { cardId: ready.id });
  board = boardFromState(state);
  const ticketized = board.cards.find((card) => card.id === ready.id);
  if (!ticketized?.orchestrationTaskId) throw new Error("Pomodoro card was not ticketized into a Local Task.");
  return { board, card: ticketized };
}

function pomodoroCardDescription() {
  return [
    "Build a tiny dependency-free Pomodoro mini-app in this card's writable task workspace. Do not modify the owning project root directly; the Integration Queue must apply deliverables later.",
    "",
    "Required files:",
    "- index.html: static page with a Pomodoro title, a visible time display using id `time-display`, and Start, Pause, and Reset buttons. Link `style.css` and load `app.js` with `<script type=\"module\" src=\"./app.js\"></script>`.",
    "- app.js: browser-safe ESM JavaScript with `export const pomodoroMinutes = 25`, countdown state, Start/Pause/Reset handlers, and mode display. Do not use CommonJS `module.exports`.",
    "- style.css: polished readable layout using system fonts, responsive spacing, and accessible button states.",
    "- tests/checklist.md: concise manual checklist that names timer controls, reset behavior, and responsive readability.",
    "- tests/verify-pomodoro.mjs: Node fs/assert script that reads index.html and app.js, imports `{ pomodoroMinutes }` from `../app.js`, and verifies the title, module script, controls, `time-display`, and `pomodoroMinutes` contract.",
    "",
    "Verification commands to run from the task workspace:",
    "- node --check app.js",
    "- node tests/verify-pomodoro.mjs",
    "",
    "Project-board reporting contract:",
    "- First, call native `task_heartbeat` with the immediate plan before editing files. If native task tools are unavailable, emit a fenced `task_actions` JSON fallback.",
    "- After writing and verifying files, call `task_report_proof` with changedFiles exactly including index.html, app.js, style.css, tests/checklist.md, and tests/verify-pomodoro.mjs, and commands including both verification commands.",
    "- Then call `task_complete` only when those files and commands are complete.",
    "- Do not install dependencies, call network services, read secrets, or write outside the task workspace.",
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
      throw new Error(`Timed out waiting for terminal Pomodoro Local Task run; no run progress was observed for ${workerIdleTimeoutMs.toLocaleString()}ms.`);
    }
    if (Date.now() - startedAt > workerRunMaxElapsedMs) {
      throw new Error(`Timed out waiting for terminal Pomodoro Local Task run after ${workerRunMaxElapsedMs.toLocaleString()}ms total elapsed.`);
    }
    await delay(1000);
  }
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

async function waitForCardProofReview(cardId) {
  return waitForState(
    async () => {
      const state = await invoke("bootstrap");
      const board = boardFromState(state);
      const card = board.cards.find((candidate) => candidate.id === cardId);
      return card?.proofReview ? card : undefined;
    },
    "Pomodoro card proof review",
    180_000,
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
  return evaluate(() => window.__kanbanPomodoroPrepareError || window.__kanbanPomodoroRunStartError || null).catch(() => null);
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

async function clickIntegrationAction(title, actionLabel) {
  await evaluate(
    ({ title: itemTitle, actionLabel: label }) => {
      const item = [...document.querySelectorAll(".project-board-proof-review-item")].find((candidate) => candidate.textContent?.includes(itemTitle));
      if (!item) throw new Error(`Integration queue item not found: ${itemTitle}`);
      const button = [...item.querySelectorAll("button")].find((candidate) => (candidate.textContent || "").includes(label));
      if (!button) throw new Error(`Integration action ${label} not found for ${itemTitle}`);
      button.click();
    },
    { title, actionLabel },
  );
}

async function waitForIntegrationStatus(title, status) {
  await waitFor(
    ({ title: itemTitle, status: expectedStatus }) =>
      [...document.querySelectorAll(".project-board-proof-review-item")].some((candidate) => candidate.textContent?.includes(itemTitle) && candidate.textContent?.includes(expectedStatus)),
    `${title} ${status}`,
    60_000,
    { title, status },
  );
}

async function elementText(selector) {
  return evaluate((targetSelector) => document.querySelector(targetSelector)?.textContent || "", selector);
}

async function assertWorkspaceFile(relativePath, expectedText) {
  await assertAbsoluteFile(join(workspace, relativePath), expectedText);
}

async function assertAbsoluteFile(path, expectedText) {
  const content = await readFile(path, "utf8");
  if (expectedText) assertIncludes(content, expectedText, path);
}

function assertFileAbsent(relativePath, label) {
  if (existsSync(join(workspace, relativePath))) throw new Error(label);
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
  if (/Local Task|proof|Integration|deliverable|Pomodoro|card|board/i.test(message)) return "product";
  if (/gmi|provider|api key|stream|rate|timeout/i.test(message)) return "provider-degraded-or-timeout";
  if (/cdp|electron|Ambient shell|spawn|exited/i.test(message)) return "environment-or-harness";
  return "unknown";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
