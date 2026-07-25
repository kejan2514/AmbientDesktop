#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(process.env.AMBIENT_AGGRESSIVE_RETRIES_GMI_OUT_DIR || join(repoRoot, "test-results", "aggressive-retries-desktop-smoke"));
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = join(outputRoot, "runs", runStamp);
const userData = join(runRoot, "userData");
const workspace = join(runRoot, "workspace");
const latestSummaryPath = join(outputRoot, "latest.json");
const port = Number(process.env.AMBIENT_AGGRESSIVE_RETRIES_GMI_CDP_PORT || 0) || (await findOpenPort());
const timeoutMs = Number(process.env.AMBIENT_AGGRESSIVE_RETRIES_GMI_TIMEOUT_MS || 0) || 300_000;
const electronTargetTimeoutMs = Number(process.env.AMBIENT_AGGRESSIVE_RETRIES_GMI_ELECTRON_TARGET_TIMEOUT_MS || 0) || 90_000;
const baselineToken = "AGGRESSIVE_RETRIES_BASELINE_OK";
const toggledToken = "AGGRESSIVE_RETRIES_AFTER_TOGGLE_OK";
const output = [];
const children = new Set();
let lastCdpProbe;
let appInstance;

try {
  await prepareSnapshotCopy();
  appInstance = await launchApp();
  const summary = await runSmoke(appInstance.cdp);
  await mkdir(outputRoot, { recursive: true });
  await writeFile(latestSummaryPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(JSON.stringify(summary, null, 2));
  console.log("Aggressive retries GMI Desktop smoke passed.");
} catch (error) {
  console.error(outputTail());
  throw error;
} finally {
  appInstance?.cdp.close();
  if (appInstance?.child) await terminateProcessTree(appInstance.child);
  for (const child of children) await terminateProcessTree(child);
  await terminateDebugPortProcesses();
}

async function prepareSnapshotCopy() {
  const snapshotUserData = process.env.AMBIENT_AGGRESSIVE_RETRIES_SNAPSHOT_USER_DATA || process.env.AMBIENT_E2E_USER_DATA;
  const snapshotWorkspace = process.env.AMBIENT_AGGRESSIVE_RETRIES_SNAPSHOT_WORKSPACE || process.env.AMBIENT_DESKTOP_WORKSPACE;
  if (!snapshotUserData || !existsSync(snapshotUserData)) {
    throw new Error("Configure AMBIENT_AGGRESSIVE_RETRIES_SNAPSHOT_USER_DATA or AMBIENT_E2E_USER_DATA with a local snapshot userData directory.");
  }
  if (!snapshotWorkspace || !existsSync(snapshotWorkspace)) {
    throw new Error("Configure AMBIENT_AGGRESSIVE_RETRIES_SNAPSHOT_WORKSPACE or AMBIENT_DESKTOP_WORKSPACE with a local snapshot workspace directory.");
  }
  if (!process.env.GMI_CLOUD_API_KEY && !process.env.GMI_API_KEY && !process.env.GMI_CLOUD_API_KEY_FILE && !existsSync(join(repoRoot, "ignored-provider-key-file.txt"))) {
    throw new Error("Configure GMI_CLOUD_API_KEY, GMI_API_KEY, GMI_CLOUD_API_KEY_FILE, or the ignored ignored-provider-key-file.txt file before running this live smoke.");
  }

  await rm(runRoot, { recursive: true, force: true });
  await mkdir(runRoot, { recursive: true });
  await cp(snapshotUserData, userData, { recursive: true });
  await cp(snapshotWorkspace, workspace, { recursive: true });
  for (const name of ["SingletonCookie", "SingletonLock", "SingletonSocket"]) {
    await rm(join(userData, name), { force: true });
  }
}

async function launchApp() {
  const child = spawn("pnpm", ["exec", "electron-vite", "dev", "--remoteDebuggingPort", String(port)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AMBIENT_PROVIDER: "gmi-cloud",
      AMBIENT_E2E: "1",
      AMBIENT_E2E_USER_DATA: userData,
      AMBIENT_DESKTOP_WORKSPACE: workspace,
      AMBIENT_DESKTOP_BOOTSTRAP_WATCHDOG_MS: process.env.AMBIENT_DESKTOP_BOOTSTRAP_WATCHDOG_MS ?? "180000",
      AMBIENT_PI_USER_SETTINGS_PATH: join(userData, "missing-pi-settings.json"),
      AMBIENT_CODEX_CURATED_MARKETPLACE_URL: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  children.add(child);
  let childExit;
  child.once("exit", (code, signal) => {
    childExit = { code, signal };
    children.delete(child);
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));

  const target = await waitForTarget(port, () => childExit);
  await delay(750);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await waitFor(cdp, () => document.body?.innerText.includes("Ambient"), "main shell", 45_000);
  return { child, cdp };
}

async function runSmoke(cdp) {
  await installCollector(cdp);
  let state = await desktopState(cdp);
  if (state.provider.providerId !== "gmi-cloud") {
    throw new Error(`Expected GMI Cloud provider, got ${state.provider.providerId}.`);
  }
  if (!state.provider.hasApiKey) throw new Error("GMI Cloud API key was not visible to the launched app.");
  const keyCheck = await evaluate(cdp, "window.ambientDesktop.testAmbientApiKey()");
  if (!keyCheck?.ok) throw new Error(`GMI Cloud API key check failed: ${keyCheck?.message ?? "unknown error"}`);

  state = await evaluate(cdp, "window.ambientDesktop.createThread()");
  const threadId = state.activeThreadId;
  if (!threadId) throw new Error("Creating a fresh smoke thread did not produce an active thread id.");
  const model = process.env.GMI_CLOUD_MODEL || state.provider.model || state.settings.model;
  await evaluate(cdp, "window.ambientDesktop.updateModelRuntimeSettings({ aggressiveRetries: false })");
  await waitFor(cdp, () => window.ambientDesktop.bootstrap().then((state) => state.settings.modelRuntime.aggressiveRetries === false), "aggressive retries disabled", 10_000);

  await sendPromptAndWait(cdp, {
    threadId,
    model,
    token: baselineToken,
    prompt: `Reply with exactly ${baselineToken}. Do not call tools. Do not use markdown.`,
  });
  state = await desktopState(cdp);
  const threadBeforeToggle = state.threads.find((thread) => thread.id === threadId);
  if (!threadBeforeToggle?.piSessionFile) throw new Error("Baseline run did not record a Pi session file.");

  await evaluate(cdp, "window.ambientDesktop.updateModelRuntimeSettings({ aggressiveRetries: true })");
  await waitFor(
    cdp,
    (targetThreadId) =>
      window.__ambientAggressiveRetries?.runtimeSettingsActivities?.some(
        (activity) => activity.threadId === targetThreadId && activity.aggressiveRetries === true && activity.disposedSession === true,
      ),
    "idle Pi session reset after enabling aggressive retries",
    20_000,
    threadId,
  );

  await sendPromptAndWait(cdp, {
    threadId,
    model,
    token: toggledToken,
    prompt: `Reply with exactly ${toggledToken}. Do not call tools. Do not use markdown.`,
  });
  const finalState = await desktopState(cdp);
  const runtimeSettingsActivities = await runtimeSettingsActivitiesForThread(cdp, threadId);
  const resetActivity = runtimeSettingsActivities.find((activity) => activity.aggressiveRetries === true && activity.disposedSession === true);
  const finalThread = finalState.threads.find((thread) => thread.id === threadId);

  return {
    status: "passed",
    providerId: finalState.provider.providerId,
    providerLabel: finalState.provider.providerLabel,
    model,
    threadId,
    runRoot,
    baselineTokenSeen: assistantText(finalState).includes(baselineToken),
    toggledTokenSeen: assistantText(finalState).includes(toggledToken),
    sessionFileBeforeToggleName: basename(threadBeforeToggle.piSessionFile),
    sessionFileAfterToggleName: finalThread?.piSessionFile ? basename(finalThread.piSessionFile) : undefined,
    runtimeSettingsActivity: resetActivity
      ? {
          status: resetActivity.status,
          aggressiveRetries: resetActivity.aggressiveRetries,
          disposedSession: resetActivity.disposedSession,
          deferredSession: resetActivity.deferredSession,
          message: resetActivity.message,
        }
      : undefined,
  };
}

async function sendPromptAndWait(cdp, input) {
  await evaluate(
    cdp,
    `
    (() => {
      const smoke = window.__ambientAggressiveRetries;
      smoke.runStatuses = [];
      smoke.messageDeltaCount = 0;
      smoke.sawRunStart = false;
      smoke.sawRunIdle = false;
      smoke.sendResolved = false;
      smoke.error = undefined;
      window.ambientDesktop.sendMessage({
        threadId: ${JSON.stringify(input.threadId)},
        content: ${JSON.stringify(input.prompt)},
        permissionMode: "workspace",
        collaborationMode: "agent",
        model: ${JSON.stringify(input.model)},
        thinkingLevel: "low",
      }).then(() => {
        smoke.sendResolved = true;
      }).catch((error) => {
        smoke.error = error instanceof Error ? error.message : String(error);
      });
      return true;
    })()
  `,
  );
  await waitForRunStart(cdp, `${input.token} run start`, 45_000);
  await waitForSmokeCompletion(cdp, timeoutMs);
  await waitFor(cdp, (token) => window.ambientDesktop.bootstrap().then((state) => assistantTextFromState(state).includes(token)), `${input.token} assistant text`, 45_000, input.token);
}

async function installCollector(cdp) {
  await evaluate(
    cdp,
    `
    (() => {
      window.__ambientAggressiveRetries?.unsubscribe?.();
      window.__ambientAggressiveRetries = {
        runStatuses: [],
        runtimeSettingsActivities: [],
        messageDeltaCount: 0,
        sawRunStart: false,
        sawRunIdle: false,
        sendResolved: false,
        error: undefined,
      };
      window.assistantTextFromState = (state) => state.messages
        .filter((message) => message.role === "assistant")
        .map((message) => String(message.content ?? ""))
        .join("\\n");
      window.__ambientAggressiveRetries.unsubscribe = window.ambientDesktop.onEvent((event) => {
        const smoke = window.__ambientAggressiveRetries;
        if (event.type === "run-status") {
          smoke.runStatuses.push({ threadId: event.threadId, status: event.status });
          if (event.status !== "idle") smoke.sawRunStart = true;
          if (smoke.sawRunStart && event.status === "idle") smoke.sawRunIdle = true;
        }
        if (event.type === "message-delta") smoke.messageDeltaCount += 1;
        if (event.type === "runtime-activity" && event.activity?.kind === "runtime-settings") {
          smoke.runtimeSettingsActivities.push(event.activity);
        }
        if (event.type === "error") smoke.error = event.message;
      });
      return true;
    })()
  `,
  );
}

async function waitForSmokeCompletion(cdp, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const smoke = await evaluate(
      cdp,
      `
      (() => {
        const smoke = window.__ambientAggressiveRetries;
        return smoke ? {
          sawRunIdle: smoke.sawRunIdle,
          sendResolved: smoke.sendResolved,
          error: smoke.error,
        } : undefined;
      })()
    `,
    );
    if (smoke?.error) throw new Error(smoke.error);
    if (smoke?.sawRunIdle && smoke?.sendResolved) return;
    await delay(1_000);
  }
  throw new Error(`Timed out after ${maxMs}ms waiting for live Desktop run completion.`);
}

async function waitForRunStart(cdp, label, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const smoke = await evaluate(
      cdp,
      `
      (() => {
        const smoke = window.__ambientAggressiveRetries;
        return smoke ? {
          sawRunStart: smoke.sawRunStart,
          error: smoke.error,
        } : undefined;
      })()
    `,
    );
    if (smoke?.error) throw new Error(smoke.error);
    if (smoke?.sawRunStart) return;
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function runtimeSettingsActivitiesForThread(cdp, threadId) {
  return evaluate(
    cdp,
    `
    (() => {
      const threadId = ${JSON.stringify(threadId)};
      return (window.__ambientAggressiveRetries?.runtimeSettingsActivities ?? []).filter((activity) => activity.threadId === threadId);
    })()
  `,
  );
}

function assistantText(state) {
  return state.messages
    .filter((message) => message.role === "assistant")
    .map((message) => String(message.content ?? ""))
    .join("\n");
}

async function desktopState(cdp) {
  return evaluate(cdp, "window.ambientDesktop.bootstrap()");
}

async function waitForTarget(cdpPort, childExitState = () => undefined) {
  lastCdpProbe = undefined;
  const deadline = Date.now() + electronTargetTimeoutMs;
  while (Date.now() < deadline) {
    const childExit = childExitState();
    if (childExit) {
      throw new Error(`Electron exited before exposing CDP target: ${JSON.stringify(childExit)}. Last CDP probe: ${JSON.stringify(lastCdpProbe ?? {})}`);
    }
    try {
      const version = await fetchJsonWithTimeout(`http://127.0.0.1:${cdpPort}/json/version`, 2_000);
      lastCdpProbe = {
        checkedAt: new Date().toISOString(),
        port: cdpPort,
        browserEndpoint: Boolean(version?.webSocketDebuggerUrl),
        browser: version?.Browser,
      };
      const targets = await fetchJsonWithTimeout(`http://127.0.0.1:${cdpPort}/json/list`, 2_000);
      lastCdpProbe = {
        ...lastCdpProbe,
        targets: summarizeCdpTargets(targets),
      };
      const target = targets.find((item) => item.webSocketDebuggerUrl && item.type === "page");
      if (target?.webSocketDebuggerUrl) return target;
    } catch (error) {
      lastCdpProbe = {
        checkedAt: new Date().toISOString(),
        port: cdpPort,
        error: error instanceof Error ? error.message : String(error),
      };
      // App is still starting.
    }
    await delay(250);
  }
  throw new Error(
    `Timed out waiting for Electron CDP target after ${electronTargetTimeoutMs.toLocaleString()}ms. Last CDP probe: ${JSON.stringify(
      lastCdpProbe ?? {},
    )}`,
  );
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`CDP endpoint ${url} returned HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

function summarizeCdpTargets(targets) {
  return (Array.isArray(targets) ? targets : []).slice(0, 10).map((target) => ({
    id: target.id,
    type: target.type,
    title: target.title,
    url: target.url,
    hasWebSocketDebuggerUrl: Boolean(target.webSocketDebuggerUrl),
  }));
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let nextId = 1;
    const pending = new Map();
    const closePending = (error) => {
      for (const [id, entry] of pending) {
        clearTimeout(entry.timeout);
        pending.delete(id);
        entry.reject(error);
      }
    };
    socket.addEventListener("open", () => {
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((innerResolve, innerReject) => {
            const timeout = setTimeout(() => {
              if (!pending.has(id)) return;
              pending.delete(id);
              innerReject(new Error(`Timed out waiting for CDP ${method}.`));
            }, 30_000);
            timeout.unref?.();
            pending.set(id, { resolve: innerResolve, reject: innerReject, timeout });
          });
        },
        close() {
          closePending(new Error("CDP websocket closed."));
          socket.close();
        },
      });
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timeout);
      if (message.error) entry.reject(new Error(message.error.message ?? "CDP error"));
      else entry.resolve(message.result);
    });
    socket.addEventListener("error", () => {
      closePending(new Error("CDP websocket failed."));
      reject(new Error("CDP websocket failed."));
    });
    socket.addEventListener("close", () => closePending(new Error("CDP websocket closed.")));
  });
}

async function evaluate(cdp, expression, ...args) {
  const expressionText =
    typeof expression === "function" ? `(${expression.toString()})(...${JSON.stringify(args)})` : String(expression);
  const result = await cdp.send("Runtime.evaluate", {
    expression: expressionText,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Runtime.evaluate failed.");
  }
  return result.result?.value;
}

async function waitFor(cdp, predicate, label, maxMs = 10_000, ...args) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, predicate, ...args)) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function findOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close(() => (port ? resolve(port) : reject(new Error("Could not allocate a CDP port."))));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function terminateProcessTree(proc) {
  children.delete(proc);
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise((resolve) => proc.once("exit", resolve));
  try {
    if (process.platform === "win32") proc.kill("SIGTERM");
    else process.kill(-proc.pid, "SIGTERM");
  } catch {
    proc.kill("SIGTERM");
  }
  await Promise.race([exited, delay(1_500)]);
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    if (process.platform === "win32") proc.kill("SIGKILL");
    else process.kill(-proc.pid, "SIGKILL");
  } catch {
    proc.kill("SIGKILL");
  }
  await Promise.race([exited, delay(500)]);
}

async function terminateDebugPortProcesses() {
  if (process.platform === "win32") return;
  const cwdPattern = repoRoot.replace(/[.[\]{}()*+?^$|\\]/g, "\\$&");
  await runIgnoringFailure("pkill", ["-f", `${cwdPattern}.*remote-debugging-port=${port}`]);
  await runIgnoringFailure("pkill", ["-f", `electron-vite dev.*remote-debugging-port=${port}`]);
  await runIgnoringFailure("pkill", ["-f", `electron-vite dev.*remoteDebuggingPort ${port}`]);
}

function runIgnoringFailure(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", resolve);
    child.on("close", resolve);
  });
}

function outputTail() {
  return `Electron output tail:\n${output.join("").split("\n").slice(-160).join("\n")}\n`;
}
