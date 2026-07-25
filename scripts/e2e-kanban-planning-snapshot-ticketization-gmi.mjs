#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const outputRoot = resolve(process.env.AMBIENT_KANBAN_PLANNING_SNAPSHOT_OUT_DIR || join(repoRoot, "test-results", "kanban-planning-snapshot-gmi"));
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = join(outputRoot, "runs", runStamp);
const workspace = join(runRoot, "workspace");
const userData = join(runRoot, "userData");
const reportPath = resolve(process.env.AMBIENT_KANBAN_PLANNING_SNAPSHOT_OUT || join(outputRoot, "latest.json"));
const screenshotPath = join(runRoot, "phase3-planning-snapshot-ticketization.png");
const cdpPort = Number(process.env.AMBIENT_KANBAN_PLANNING_SNAPSHOT_CDP_PORT || 0) || (await availablePort());
const keyFile = resolve(process.env.GMI_CLOUD_API_KEY_FILE || join(repoRoot, "ignored-provider-key-file.txt"));
const defaultSnapshotWorkspace = join(homedir(), "Documents", "ambientCoderArchive");
const sourceWorkspace =
  process.env.AMBIENT_KANBAN_PLANNING_SNAPSHOT_WORKSPACE ||
  process.env.AMBIENT_DESKTOP_WORKSPACE ||
  (existsSync(defaultSnapshotWorkspace) ? defaultSnapshotWorkspace : "");
const sourceUserData = process.env.AMBIENT_KANBAN_PLANNING_SNAPSHOT_USER_DATA || process.env.AMBIENT_E2E_USER_DATA || "";
const output = [];
let app;
let cdp;

try {
  if (!sourceWorkspace || !existsSync(sourceWorkspace)) {
    throw new Error("Set AMBIENT_KANBAN_PLANNING_SNAPSHOT_WORKSPACE to a local snapshot workspace directory.");
  }
  if (!existsSync(keyFile) && !process.env.GMI_CLOUD_API_KEY && !process.env.GMI_API_KEY) {
    throw new Error("Set GMI_CLOUD_API_KEY_FILE, GMI_CLOUD_API_KEY, or GMI_API_KEY before running the GMI planning snapshot harness.");
  }

  await prepareRunState();
  app = await launchApp();
  cdp = await connectCdp(app.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await waitFor(() => document.body?.innerText.includes("Ambient"), "Ambient shell");

  const provider = await evaluate(() => window.ambientDesktop.bootstrap().then((state) => state.provider));
  if (provider.providerId !== "gmi-cloud") throw new Error(`Expected gmi-cloud provider, got ${provider.providerId ?? "missing"}.`);
  if (!provider.hasApiKey) throw new Error("GMI provider launched without a visible API key.");

  const seed = await seedPlanningSnapshotBoard();
  const initialSnapshotEvidence = await assertPlanningSnapshotEvidence({
    boardId: seed.boardId,
    cardId: seed.cardId,
    expectedTicketized: false,
  });
  await openProjectBoard();
  await clickProjectBoardTab("Draft Inbox");

  await assertSnapshotPanel({
    label: "Snapshot ready",
    status: "Ready",
    detail: "Planner output is at a stable checkpoint.",
  });
  await clickButton("Create 1 Ready Task");
  await assertSnapshotPanel({
    label: "Snapshot ticketized",
    status: "Protected",
    detail: "A stable planning snapshot has already been converted to Local Tasks.",
  });

  const ticketized = await readTicketizedCard(seed.cardId);
  if (!ticketized?.orchestrationTaskId) throw new Error("Expected the snapshot card to receive a Local Task id.");
  const taskCountAfterTicketization = await projectBoardTaskCount();
  if (taskCountAfterTicketization !== 1) throw new Error(`Expected exactly one Local Task after ticketization, got ${taskCountAfterTicketization}.`);
  const ticketizedSnapshotEvidence = await assertReadyTaskSnapshotProvenance({
    boardId: seed.boardId,
    cardId: seed.cardId,
    taskId: ticketized.orchestrationTaskId,
  });

  const additive = await createAdditiveProposalCard(seed.boardId);
  await assertSnapshotPanel({
    label: "New proposal available",
    status: "Review additive drafts",
    detail: "Existing Local Tasks are protected.",
  });
  const protectedTicketized = await readTicketizedCard(seed.cardId);
  if (protectedTicketized?.orchestrationTaskId !== ticketized.orchestrationTaskId) {
    throw new Error("Expected additive planning output to preserve the existing ticketized Local Task link.");
  }
  const taskCountAfterAdditiveProposal = await projectBoardTaskCount();
  if (taskCountAfterAdditiveProposal !== 1) {
    throw new Error(`Expected additive draft proposal to avoid creating duplicate Local Tasks, got ${taskCountAfterAdditiveProposal}.`);
  }

  await captureScreenshot(screenshotPath);
  const report = {
    status: "passed",
    providerId: provider.providerId,
    usedGmiKeyFile: existsSync(keyFile),
    sourceWorkspace,
    sourceUserData: sourceUserData || undefined,
    usedSnapshotUserData: Boolean(sourceUserData && existsSync(sourceUserData)),
    runRoot,
    screenshotPath,
    boardId: seed.boardId,
    synthesisRunId: initialSnapshotEvidence.runId,
    planningSnapshotId: initialSnapshotEvidence.snapshotId,
    planningSnapshotFingerprint: initialSnapshotEvidence.renderFingerprint,
    readyTaskPlanningSnapshotId: ticketizedSnapshotEvidence.planningSnapshotId,
    ticketizedCardId: seed.cardId,
    additiveCardId: additive.cardId,
    taskCountAfterTicketization,
    taskCountAfterAdditiveProposal,
    assertions: [
      "GMI Cloud provider launches with API-key presence but without exposing the key",
      "Completed planning runs expose immutable planning snapshots with source hashes, card ids, and render fingerprints",
      "Draft Inbox shows Snapshot ready for a completed planning checkpoint",
      "Create Ready Tasks is driven through the visible UI and ticketizes one chosen snapshot card",
      "ready_tasks_created history records the exact final planning snapshot chosen for ticketization",
      "Draft Inbox transitions to Snapshot ticketized with the Local Task link preserved",
      "A later additive draft shows New proposal available without duplicating Local Tasks or mutating the ticketized card link",
    ],
  };
  await writeReport(report);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const report = {
    status: "failed",
    message: error instanceof Error ? error.message : String(error),
    runRoot,
    outputTail: output.join("").split("\n").slice(-140),
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
    for (const name of ["SingletonCookie", "SingletonLock", "SingletonSocket"]) {
      await rm(join(userData, name), { force: true });
    }
  } else {
    await mkdir(userData, { recursive: true });
  }
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

async function seedPlanningSnapshotBoard() {
  return evaluate(async () => {
    const initialState = await window.ambientDesktop.bootstrap();
    const activeProject = initialState.projects.find((project) => project.path === initialState.workspace.path) ?? initialState.projects[0];
    if (!activeProject) throw new Error("No active project available for the Phase 3 planning snapshot seed.");
    const stateWithBoard = activeProject.board
      ? initialState
      : await window.ambientDesktop.createProjectBoard({
          projectId: activeProject.id,
          title: "Phase 3 Planning Snapshot Gate Board",
          summary: "Deterministic fixture for planning snapshot ticketization boundaries.",
        });
    let project = stateWithBoard.projects.find((candidate) => candidate.path === stateWithBoard.workspace.path) ?? stateWithBoard.projects[0];
    if (!project?.board) throw new Error("Project board was not available after creation.");
    const boardId = project.board.id;
    await window.ambientDesktop.seedProjectBoardSemanticIdleDogfood({ boardId });
    let state = await window.ambientDesktop.bootstrap();
    project = state.projects.find((candidate) => candidate.path === state.workspace.path) ?? state.projects[0];
    const card = project?.board?.cards.find((candidate) => candidate.sourceId === "synthesis:dogfood-foundation-shell");
    if (!card) throw new Error("Semantic-idle seed did not create the expected snapshot card.");
    const answeredAt = new Date().toISOString();
    const clarificationAnswers = (card.clarificationQuestions ?? []).map((question) => ({
      question,
      answer: "Yes. Keep the deterministic foundation card as the chosen Phase 3 snapshot ticketization fixture.",
      answeredAt,
    }));
    state = await window.ambientDesktop.updateProjectBoardCard({
      cardId: card.id,
      candidateStatus: "ready_to_create",
      clarificationAnswers,
      acceptanceCriteria: ["Phase 3 snapshot ticketization fixture can become one Local Task."],
      testPlan: {
        unit: ["Inspect deterministic ticketization state."],
        integration: [],
        visual: ["Confirm the Draft Inbox planning snapshot panel is visible."],
        manual: [],
      },
    });
    project = state.projects.find((candidate) => candidate.path === state.workspace.path) ?? state.projects[0];
    const updatedCard = project?.board?.cards.find((candidate) => candidate.id === card.id);
    if (updatedCard?.candidateStatus !== "ready_to_create") throw new Error("Snapshot card was not marked ready to create.");
    const run = [...(project?.board?.synthesisRuns ?? [])].reverse().find((candidate) => candidate.model === "dogfood-semantic-idle");
    if (!run) throw new Error("Semantic-idle seed did not expose a synthesis run.");
    return { boardId, cardId: card.id, runId: run.id, title: updatedCard.title };
  });
}

async function createAdditiveProposalCard(boardId) {
  return evaluate(async (input) => {
    const state = await window.ambientDesktop.createProjectBoardCard({
      boardId: input.boardId,
      title: "Phase 3 additive proposal after ticketization",
      description: "Draft proposal added after the chosen snapshot was converted to a Local Task.",
    });
    const project = state.projects.find((candidate) => candidate.path === state.workspace.path) ?? state.projects[0];
    const card = project?.board?.cards.find((candidate) => candidate.title === "Phase 3 additive proposal after ticketization");
    if (!card) throw new Error("Additive proposal card was not created.");
    return { cardId: card.id };
  }, { boardId });
}

async function openProjectBoard() {
  const opened = await evaluate(() => {
    if (document.querySelector(".project-board-workspace")) return true;
    const button = [...document.querySelectorAll("button")].find((item) => {
      const text = `${item.textContent || ""} ${item.getAttribute("aria-label") || ""} ${item.getAttribute("title") || ""}`;
      return /Open Board|Build Board|Project Kanban/i.test(text);
    });
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  });
  if (!opened) throw new Error("Unable to open Project Board.");
  await waitFor(() => Boolean(document.querySelector(".project-board-workspace")), "Project Board workspace");
}

async function clickProjectBoardTab(label) {
  await waitFor(() => Boolean(document.querySelector(".project-board-tabs")), "project board tabs");
  const clicked = await evaluate((tabLabel) => {
    const button = [...document.querySelectorAll(".project-board-tabs button")].find((item) => {
      const text = (item.textContent || "").replace(/\s+/g, " ").trim();
      return text === tabLabel || text.startsWith(tabLabel);
    });
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  }, label);
  if (!clicked) throw new Error(`Project board tab not found: ${label}`);
  if (label === "Draft Inbox") await waitFor(() => Boolean(document.querySelector(".project-board-draft-board")), "Draft Inbox panel");
}

async function clickButton(label) {
  const clicked = await evaluate((buttonLabel) => {
    const button = [...document.querySelectorAll("button")].find((item) => {
      const text = `${item.textContent || ""} ${item.getAttribute("aria-label") || ""} ${item.getAttribute("title") || ""}`;
      return text.includes(buttonLabel) && !item.disabled;
    });
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  }, label);
  if (!clicked) throw new Error(`Enabled button not found: ${label}`);
}

async function assertSnapshotPanel({ label, status, detail }) {
  await waitFor(
    (expected) => {
      const panel = document.querySelector(".project-board-planning-snapshot-state");
      const text = panel?.textContent || "";
      return text.includes(expected.label) && text.includes(expected.status) && text.includes(expected.detail);
    },
    `planning snapshot panel: ${label}`,
    60_000,
    { label, status, detail },
  );
}

async function readTicketizedCard(cardId) {
  return evaluate(async (input) => {
    const state = await window.ambientDesktop.bootstrap();
    const project = state.projects.find((candidate) => candidate.path === state.workspace.path) ?? state.projects[0];
    return project?.board?.cards.find((card) => card.id === input.cardId);
  }, { cardId });
}

async function assertPlanningSnapshotEvidence({ boardId, cardId, expectedTicketized }) {
  return evaluate(async (input) => {
    const state = await window.ambientDesktop.bootstrap();
    const project = state.projects.find((candidate) => candidate.board?.id === input.boardId);
    const board = project?.board;
    if (!board) throw new Error(`Project board not found in bootstrap state: ${input.boardId}`);
    const stableRuns = (board.synthesisRuns ?? []).filter((run) => run.status === "paused" || run.status === "succeeded");
    const run = [...stableRuns].reverse().find((candidate) =>
      (candidate.planningSnapshots ?? []).some((snapshot) => snapshot.cardIds?.includes(input.cardId)),
    );
    if (!run) throw new Error("No stable synthesis run exposed planning snapshots for the seeded card.");
    const snapshots = run.planningSnapshots ?? [];
    if (snapshots.length < 2) throw new Error(`Expected incremental and final planning snapshots, got ${snapshots.length}.`);
    const finalSnapshot = [...snapshots].reverse().find((snapshot) => snapshot.kind === "final" && snapshot.planningStatus === "succeeded");
    if (!finalSnapshot) throw new Error("No final succeeded planning snapshot was exposed for ticketization.");
    if (!finalSnapshot.cardIds?.includes(input.cardId)) throw new Error("Final planning snapshot does not include the seeded card id.");
    if (!Array.isArray(finalSnapshot.sourceHashes) || finalSnapshot.sourceHashes.length === 0) {
      throw new Error("Final planning snapshot did not preserve source hashes.");
    }
    if (!String(finalSnapshot.renderFingerprint || "").startsWith("planning-snapshot-")) {
      throw new Error("Final planning snapshot did not expose a stable render fingerprint.");
    }
    if (Boolean(finalSnapshot.ticketizedCount) !== Boolean(input.expectedTicketized)) {
      throw new Error(`Expected final planning snapshot ticketized=${input.expectedTicketized}, got ${finalSnapshot.ticketizedCount}.`);
    }
    return {
      runId: run.id,
      snapshotId: finalSnapshot.id,
      renderFingerprint: finalSnapshot.renderFingerprint,
      cardIds: finalSnapshot.cardIds,
      sourceHashCount: finalSnapshot.sourceHashes.length,
      readyCandidateCount: finalSnapshot.readyCandidateCount,
      ticketizedCount: finalSnapshot.ticketizedCount,
    };
  }, { boardId, cardId, expectedTicketized });
}

async function assertReadyTaskSnapshotProvenance({ boardId, cardId, taskId }) {
  return evaluate(async (input) => {
    const state = await window.ambientDesktop.bootstrap();
    const project = state.projects.find((candidate) => candidate.board?.id === input.boardId);
    const board = project?.board;
    if (!board) throw new Error(`Project board not found in bootstrap state: ${input.boardId}`);
    const event = [...(board.events ?? [])].reverse().find((candidate) => candidate.kind === "ready_tasks_created");
    if (!event) throw new Error("ready_tasks_created event was not recorded.");
    const metadata = event.metadata ?? {};
    if (!Array.isArray(metadata.cardIds) || !metadata.cardIds.includes(input.cardId)) {
      throw new Error("ready_tasks_created event does not include the ticketized card id.");
    }
    if (!Array.isArray(metadata.taskIds) || !metadata.taskIds.includes(input.taskId)) {
      throw new Error("ready_tasks_created event does not include the created Local Task id.");
    }
    if (!metadata.planningSnapshotId || !metadata.planningSnapshotRunId || !metadata.planningSnapshotFingerprint) {
      throw new Error("ready_tasks_created event is missing planning snapshot provenance.");
    }
    const run = (board.synthesisRuns ?? []).find((candidate) => candidate.id === metadata.planningSnapshotRunId);
    if (!run) throw new Error("ready_tasks_created event references a missing synthesis run.");
    const snapshot = (run.planningSnapshots ?? []).find((candidate) => candidate.id === metadata.planningSnapshotId);
    if (!snapshot) throw new Error("ready_tasks_created event references a missing planning snapshot.");
    if (snapshot.kind !== "final" || snapshot.planningStatus !== "succeeded") {
      throw new Error(`ready_tasks_created referenced ${snapshot.kind}/${snapshot.planningStatus}, expected final/succeeded.`);
    }
    if (snapshot.renderFingerprint !== metadata.planningSnapshotFingerprint) {
      throw new Error("ready_tasks_created fingerprint does not match the referenced planning snapshot.");
    }
    if (!Array.isArray(metadata.planningSnapshotCardIds) || !metadata.planningSnapshotCardIds.includes(input.cardId)) {
      throw new Error("ready_tasks_created planningSnapshotCardIds does not include the ticketized card.");
    }
    return {
      planningSnapshotId: metadata.planningSnapshotId,
      planningSnapshotRunId: metadata.planningSnapshotRunId,
      planningSnapshotFingerprint: metadata.planningSnapshotFingerprint,
      planningSnapshotCardIds: metadata.planningSnapshotCardIds,
    };
  }, { boardId, cardId, taskId });
}

async function projectBoardTaskCount() {
  return evaluate(async () => {
    const state = await window.ambientDesktop.bootstrap();
    const project = state.projects.find((candidate) => candidate.path === state.workspace.path) ?? state.projects[0];
    return project?.board?.cards.filter((card) => Boolean(card.orchestrationTaskId)).length ?? 0;
  });
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
