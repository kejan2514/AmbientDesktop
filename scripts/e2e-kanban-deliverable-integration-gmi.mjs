#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const outputRoot = resolve(process.env.AMBIENT_KANBAN_DELIVERABLE_INTEGRATION_OUT_DIR || join(repoRoot, "test-results", "kanban-deliverable-integration-gmi"));
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = join(outputRoot, "runs", runStamp);
const workspace = join(runRoot, "workspace");
const userData = join(runRoot, "userData");
const reportPath = resolve(process.env.AMBIENT_KANBAN_DELIVERABLE_INTEGRATION_OUT || join(outputRoot, "latest.json"));
const screenshotPath = join(runRoot, "phase2-deliverable-integration.png");
const cdpPort = Number(process.env.AMBIENT_KANBAN_DELIVERABLE_INTEGRATION_CDP_PORT || 0) || (await availablePort());
const keyFile = resolve(process.env.GMI_CLOUD_API_KEY_FILE || join(repoRoot, "ignored-provider-key-file.txt"));
const defaultSnapshotWorkspace = join(homedir(), "Documents", "ambientCoderArchive");
const sourceWorkspace =
  process.env.AMBIENT_KANBAN_DELIVERABLE_INTEGRATION_SNAPSHOT_WORKSPACE ||
  process.env.AMBIENT_DESKTOP_WORKSPACE ||
  (existsSync(defaultSnapshotWorkspace) ? defaultSnapshotWorkspace : "");
const sourceUserData = process.env.AMBIENT_KANBAN_DELIVERABLE_INTEGRATION_SNAPSHOT_USER_DATA || process.env.AMBIENT_E2E_USER_DATA || "";
const output = [];
let app;
let cdp;

try {
  if (!sourceWorkspace || !existsSync(sourceWorkspace)) {
    throw new Error("Set AMBIENT_KANBAN_DELIVERABLE_INTEGRATION_SNAPSHOT_WORKSPACE to a local snapshot workspace directory.");
  }
  if (!existsSync(keyFile) && !process.env.GMI_CLOUD_API_KEY && !process.env.GMI_API_KEY) {
    throw new Error("Set GMI_CLOUD_API_KEY_FILE, GMI_CLOUD_API_KEY, or GMI_API_KEY before running the GMI Desktop integration harness.");
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

  const seed = await seedPhaseTwoDeliverables();
  const pomodoro = scenario(seed, "pomodoro_root_apply");
  const recipe = scenario(seed, "recipe_index_export");
  const deferred = scenario(seed, "deferred_theme_review");

  await waitFor(() => document.body?.innerText.includes("Open Board"), "Open Board action");
  await clickButton("Open Board");
  await waitFor(() => document.querySelector(".project-board-tabs")?.textContent?.includes("Integration"), "project board Integration tab");
  await clickProjectBoardTab("Board");
  await waitFor(() => document.body?.innerText.includes("Executable board closed; integration pending"), "closed board integration pending state");
  assertIncludes(await elementText(".project-board-execution-overview"), "Open Integration", "closed board pending integration action");
  await clickProjectBoardTab("Integration");
  await waitFor(() => document.querySelector(".project-board-integration-panel")?.textContent?.includes("Integration Queue"), "Integration panel selected");
  await waitFor(() => document.querySelector(".project-board-integration-panel")?.textContent?.includes("Pomodoro root integration"), "Pomodoro deliverable queue item");
  await waitFor(() => document.querySelector(".project-board-integration-panel")?.textContent?.includes("Recipe index export bundle"), "Recipe deliverable queue item");
  await waitFor(() => document.querySelector(".project-board-integration-panel")?.textContent?.includes("Deferred theme review"), "Deferred deliverable queue item");
  const pendingText = await elementText(".project-board-integration-panel");
  assertIncludes(pendingText, "3 pending", "initial integration pending count");
  assertIncludes(pendingText, "Excluded", "initial runtime/dependency exclusion visibility");
  assertIncludes(pendingText, ".ambient/phase2-dogfood-runtime.json", "Pomodoro runtime exclusion");
  assertIncludes(pendingText, "node_modules/phase2-dogfood-cache/index.js", "dependency exclusion");

  await clickIntegrationAction("Pomodoro root integration", "Apply To Root");
  await waitForIntegrationStatus("Pomodoro root integration", "Integrated");
  await assertWorkspaceFile("index.html", "Pomodoro");
  await assertWorkspaceFile("app.js", "pomodoroMinutes");
  await assertWorkspaceFile("style.css", "font-family");
  await assertWorkspaceFile("tests/checklist.md", "Timer controls render");
  assertFileAbsent(".ambient/phase2-dogfood-runtime.json", "Pomodoro runtime file should not be copied to root");
  assertFileAbsent("node_modules/phase2-dogfood-cache/index.js", "dependency cache should not be copied to root");

  await clickIntegrationAction("Recipe index export bundle", "Export Bundle");
  await waitForIntegrationStatus("Recipe index export bundle", "Exported");
  const bundleRoot = join(workspace, ".ambient", "project-board", "deliverable-bundles", recipe.runId);
  await assertAbsoluteFile(join(bundleRoot, "files", "INDEX.md"), "Recipe Index");
  await assertAbsoluteFile(join(bundleRoot, "files", "build-index.mjs"), "INDEX.md generated");
  await assertAbsoluteFile(join(bundleRoot, "manifest.json"), "export_bundle");

  await evaluate(() => {
    window.prompt = () => "Waiting for PM theme approval.";
  });
  await clickIntegrationAction("Deferred theme review", "Defer");
  await waitForIntegrationStatus("Deferred theme review", "Deferred");
  assertFileAbsent("theme-review.md", "deferred deliverable should remain outside project root");
  const resolvedText = await elementText(".project-board-integration-panel");
  assertIncludes(resolvedText, "Waiting for PM theme approval.", "defer reason");
  assertIncludes(resolvedText, "Resolved", "resolved integration status");
  assertIncludes(resolvedText, "1 integrated, 1 exported, and 1 deferred", "resolved integration outcome summary");
  await clickProjectBoardTab("Board");
  await waitFor(() => document.body?.innerText.includes("Executable board closed; deliverables integrated"), "closed board deliverables integrated state");
  assertIncludes(await elementText(".project-board-execution-overview"), "1 integrated, 1 exported, and 1 deferred", "closed board integrated outcome detail");

  await captureScreenshot(screenshotPath);
  const report = {
    status: "passed",
    providerId: provider.providerId,
    usedGmiKeyFile: existsSync(keyFile),
    sourceWorkspace,
    usedSnapshotUserData: Boolean(sourceUserData && existsSync(sourceUserData)),
    runRoot,
    screenshotPath,
    scenarios: seed.scenarios,
    assertions: [
      "Integration tab showed three pending deliverable decisions from seeded completed Local Task runs",
      "Apply To Root copied Pomodoro material files into the temp snapshot root",
      "Runtime and dependency files were visible as excluded and were not copied to root",
      "Export Bundle wrote Recipe Index material files and manifest under .ambient/project-board/deliverable-bundles",
      "Defer recorded a PM reason and did not write the deferred file to root",
      "Board close-state moved from integration pending to deliverables integrated after visible queue decisions",
    ],
    appliedRunId: pomodoro.runId,
    exportedRunId: recipe.runId,
    deferredRunId: deferred.runId,
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

async function seedPhaseTwoDeliverables() {
  return evaluate(async () => {
    const initialState = await window.ambientDesktop.bootstrap();
    const activeProject = initialState.projects.find((project) => project.path === initialState.workspace.path) ?? initialState.projects[0];
    if (!activeProject) throw new Error("No active project available for kanban deliverable seed.");
    const stateWithBoard = activeProject.board
      ? initialState
      : await window.ambientDesktop.createProjectBoard({
          projectId: activeProject.id,
          title: "Phase 2 Deliverable Integration Gate Board",
          summary: "Deterministic Phase 2 fixtures for deliverable apply/export/defer validation.",
        });
    const project = stateWithBoard.projects.find((candidate) => candidate.path === stateWithBoard.workspace.path) ?? stateWithBoard.projects[0];
    if (!project?.board) throw new Error("Project board was not available after creation.");
    return window.ambientDesktop.seedProjectBoardDeliverableIntegrationDogfood({ boardId: project.board.id });
  });
}

function scenario(seed, name) {
  const match = seed.scenarios.find((item) => item.name === name);
  if (!match) throw new Error(`Seed scenario not found: ${name}`);
  return match;
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
  assertIncludes(content, expectedText, path);
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
