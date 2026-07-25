#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const outputRoot = resolve(process.env.AMBIENT_KANBAN_CANONICAL_PROJECTION_OUT_DIR || join(repoRoot, "test-results", "kanban-canonical-card-projection-gmi"));
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = join(outputRoot, "runs", runStamp);
const workspace = join(runRoot, "workspace");
const userData = join(runRoot, "userData");
const reportPath = resolve(process.env.AMBIENT_KANBAN_CANONICAL_PROJECTION_OUT || join(outputRoot, "latest.json"));
const screenshotPath = join(runRoot, "phase1-canonical-projection-gates.png");
const cdpPort = Number(process.env.AMBIENT_KANBAN_CANONICAL_PROJECTION_CDP_PORT || 0) || (await availablePort());
const keyFile = resolve(process.env.GMI_CLOUD_API_KEY_FILE || join(repoRoot, "ignored-provider-key-file.txt"));
const defaultSnapshotWorkspace = join(homedir(), "Documents", "ambientCoderArchive");
const sourceWorkspace =
  process.env.AMBIENT_KANBAN_CANONICAL_SNAPSHOT_WORKSPACE ||
  process.env.AMBIENT_DESKTOP_WORKSPACE ||
  (existsSync(defaultSnapshotWorkspace) ? defaultSnapshotWorkspace : "");
const sourceUserData = process.env.AMBIENT_KANBAN_CANONICAL_SNAPSHOT_USER_DATA || process.env.AMBIENT_E2E_USER_DATA || "";
const output = [];
let app;
let cdp;

try {
  if (!sourceWorkspace || !existsSync(sourceWorkspace)) {
    throw new Error("Set AMBIENT_KANBAN_CANONICAL_SNAPSHOT_WORKSPACE to a local snapshot workspace directory.");
  }
  if (!existsSync(keyFile) && !process.env.GMI_CLOUD_API_KEY && !process.env.GMI_API_KEY) {
    throw new Error("Set GMI_CLOUD_API_KEY_FILE, GMI_CLOUD_API_KEY, or GMI_API_KEY before running the GMI Desktop projection harness.");
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

  const seed = await seedPhaseOneGateCards();
  await waitFor(() => document.body?.innerText.includes("Open Board"), "Open Board action");
  await clickButton("Open Board");
  await waitFor(() => document.querySelector(".project-board-tabs")?.textContent?.includes("Board"), "project board tabs");
  await clickProjectBoardTab("Board");
  await waitFor(() => document.body?.innerText.includes("Static stopwatch DOM wiring"), "stopwatch retry cleanup card on board");
  await waitFor(() => document.body?.innerText.includes("CSV expense stopped-after-proof"), "CSV stopped-after-proof card on board");

  await assertBoardCard({
    title: "Static stopwatch DOM wiring",
    statusLabel: "Done with evidence",
    runLabel: "Historical run accepted",
    label: "Stopwatch retry cleanup board card",
  });
  await assertBoardCard({
    title: "CSV expense stopped-after-proof",
    statusLabel: "Done: accepted with evidence",
    runLabel: "Historical stopped run accepted",
    label: "CSV stopped-after-proof board card",
  });

  await clickButton("Close project board");
  await waitFor(() => !document.querySelector(".project-board-workspace"), "project board closed before reopen");
  await clickButton("Open Board");
  await waitFor(() => document.querySelector(".project-board-tabs")?.textContent?.includes("Board"), "project board tabs after reopen");
  await clickProjectBoardTab("Board");
  await assertBoardCard({
    title: "Static stopwatch DOM wiring",
    statusLabel: "Done with evidence",
    runLabel: "Historical run accepted",
    label: "reopened Stopwatch retry cleanup board card",
  });

  await assertInspector({
    title: "Static stopwatch DOM wiring",
    statusLabel: "Done with evidence",
    runLabel: "Historical run accepted",
    label: "Stopwatch retry cleanup inspector",
  });
  await assertInspector({
    title: "CSV expense stopped-after-proof",
    statusLabel: "Done: accepted with evidence",
    runLabel: "Historical stopped run accepted",
    label: "CSV stopped-after-proof inspector",
  });

  await clickProjectBoardTab("Proof");
  await waitFor(() => document.body?.innerText.includes("Static stopwatch DOM wiring"), "PM Review stopwatch retry cleanup card");
  await waitFor(() => document.body?.innerText.includes("CSV expense stopped-after-proof"), "PM Review CSV stopped-after-proof card");
  const pmReviewText = await elementText(".project-board-proof-review-queue");
  assertIncludes(pmReviewText, "Done with evidence", "PM Review retry cleanup done status");
  assertIncludes(pmReviewText, "Historical run accepted", "PM Review retry cleanup historical run accepted label");
  assertIncludes(pmReviewText, "Done: accepted with evidence", "PM Review stopped-after-proof clean done status");
  assertIncludes(pmReviewText, "Historical stopped run accepted", "PM Review historical run accepted label");
  assertExcludes(pmReviewText, /Run\s+failed|Run\s+canceled|Failed\s+·|Canceled\s+·|Retry run/i, "PM Review stale failed/canceled run labels");

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
    scenarios: seed.scenarios,
    assertions: [
      "Stopwatch retry cleanup card projects Done with clean proof after board reopen",
      "Stopwatch retry cleanup card suppresses stale failed/canceled/retry labels",
      "CSV stopped-after-proof card projects Done: accepted with evidence",
      "CSV stopped-after-proof card suppresses Run Failed contradictions in board, inspector, and PM Review",
      "Accepted terminal cards expose no enabled retry/start/prepare action",
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
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));
  const target = await waitForPageEndpoint(child);
  return { child, webSocketDebuggerUrl: target.webSocketDebuggerUrl };
}

async function seedPhaseOneGateCards() {
  return evaluate(async () => {
    const initialState = await window.ambientDesktop.bootstrap();
    const activeProject = initialState.projects.find((project) => project.path === initialState.workspace.path) ?? initialState.projects[0];
    if (!activeProject) throw new Error("No active project available for kanban projection seed.");
    const stateWithBoard = activeProject.board
      ? initialState
      : await window.ambientDesktop.createProjectBoard({
          projectId: activeProject.id,
          title: "Phase 1 Canonical Projection Gate Board",
          summary: "Deterministic Phase 1 fixtures for accepted retry and stopped-after-proof projection gates.",
        });
    const project = stateWithBoard.projects.find((candidate) => candidate.path === stateWithBoard.workspace.path) ?? stateWithBoard.projects[0];
    if (!project?.board) throw new Error("Project board was not available after creation.");
    return window.ambientDesktop.seedProjectBoardCanonicalProjectionDogfood({ boardId: project.board.id });
  });
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

async function assertBoardCard({ title, statusLabel, runLabel, label }) {
  await waitFor(
    (cardTitle) => [...document.querySelectorAll(".project-board-card")].some((card) => card.textContent?.includes(cardTitle)),
    `${label} visible`,
    60_000,
    title,
  );
  const text = await cardText(title);
  assertIncludes(text, statusLabel, `${label} status`);
  assertIncludes(text, runLabel, `${label} historical run label`);
  assertIncludes(text, "1 unit", `${label} proof-count signal`);
  assertExcludes(text, /Run\s+failed|Run\s+canceled|Failed\s+·|Canceled\s+·|Retry run|Start run|Prepare run|\b[1-9]\d*\s+blocker/i, `${label} stale failure/retry/blocker labels`);
}

async function assertInspector({ title, statusLabel, runLabel, label }) {
  await clickCard(title);
  await waitFor(
    (cardTitle) => document.querySelector(".project-board-active-card-detail")?.textContent?.includes(cardTitle),
    `${label} detail selected`,
    60_000,
    title,
  );
  await waitFor(
    (expectedStatus) => document.querySelector(".project-board-active-card-detail")?.textContent?.includes(expectedStatus),
    `${label} clean status`,
    60_000,
    statusLabel,
  );
  const text = await elementText(".project-board-active-card-detail");
  assertIncludes(text, title, `${label} title`);
  assertIncludes(text, statusLabel, `${label} clean status`);
  assertIncludes(text, runLabel, `${label} historical run label`);
  assertIncludes(text, "No active blockers", `${label} blocker suppression`);
  assertExcludes(text, /Run\s+failed|Run\s+canceled|Retry run|Start run|Prepare run|\b[1-9]\d*\s+blocker/i, `${label} stale active run labels`);
  const enabledRetryButtons = await evaluate(() =>
    [...document.querySelectorAll(".project-board-active-card-detail button")]
      .filter((button) => !button.disabled && /retry|start run|prepare run/i.test(button.textContent || ""))
      .map((button) => button.textContent?.trim() || ""),
  );
  if (enabledRetryButtons.length > 0) {
    throw new Error(`Expected ${label} to expose no enabled retry/start/prepare action. Enabled buttons: ${enabledRetryButtons.join(", ")}`);
  }
}

async function cardText(title) {
  return evaluate((cardTitle) => {
    const card = [...document.querySelectorAll(".project-board-card")].find((item) => item.textContent?.includes(cardTitle));
    if (!card) throw new Error(`Card not found: ${cardTitle}`);
    return card.textContent || "";
  }, title);
}

async function clickCard(title) {
  await evaluate((cardTitle) => {
    const card = [...document.querySelectorAll(".project-board-card")].find((item) => item.textContent?.includes(cardTitle));
    if (!card) throw new Error(`Card not found: ${cardTitle}`);
    card.click();
  }, title);
}

async function elementText(selector) {
  return evaluate((targetSelector) => document.querySelector(targetSelector)?.textContent || "", selector);
}

function assertIncludes(text, expected, label) {
  if (!text.includes(expected)) throw new Error(`Expected ${label} to include ${JSON.stringify(expected)}. Text was: ${text.slice(0, 1000)}`);
}

function assertExcludes(text, pattern, label) {
  if (pattern.test(text)) throw new Error(`Expected ${label} to exclude ${pattern}. Text was: ${text.slice(0, 1000)}`);
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
