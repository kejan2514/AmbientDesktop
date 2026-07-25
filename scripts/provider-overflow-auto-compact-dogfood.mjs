#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SessionManager } from "@mariozechner/pi-coding-agent";

const repoRoot = process.cwd();
const resultsDir = join(repoRoot, "test-results", "provider-overflow-auto-compact");
const latestReportPath = join(resultsDir, "latest.json");
const defaultDogfoodProvider = "ambient";
const defaultDogfoodModel = "example/model-id";
const appWaitTimeoutMs = 90_000;
const cdpCommandTimeoutMs = 20_000;
const compactingTimeoutMs = 180_000;
const chatTurnTimeoutMs = Number(process.env.AMBIENT_PROVIDER_OVERFLOW_CHAT_TIMEOUT_MS ?? 480_000);
const seedChars = Number(process.env.AMBIENT_PROVIDER_OVERFLOW_SEED_CHARS ?? 1_050_000);
const seedMessageChars = 12_000;

const report = {
  scenario: "provider-overflow-auto-compact",
  status: "running",
  startedAt: new Date().toISOString(),
  git: {
    branch: gitValue(["rev-parse", "--abbrev-ref", "HEAD"]),
    commit: gitValue(["rev-parse", "HEAD"]),
  },
  provider: dogfoodProviderId(),
  model: dogfoodModelId(),
  seedChars,
  workspacePath: undefined,
  userDataPath: undefined,
  threadId: undefined,
  checks: {},
  artifacts: {},
};

let exitCode = 0;
let scratch;
let app;
let cdp;
let dogfoodEnv;

try {
  await rm(latestReportPath, { force: true });
  await mkdir(resultsDir, { recursive: true });
  scratch = await createScratch();
  report.workspacePath = scratch.workspacePath;
  report.userDataPath = scratch.userDataPath;
  await seedWorkspace(scratch.workspacePath);

  dogfoodEnv = buildDogfoodEnv({
    AMBIENT_E2E: "1",
    AMBIENT_DESKTOP_WORKSPACE: scratch.workspacePath,
    AMBIENT_E2E_USER_DATA: scratch.userDataPath,
    AMBIENT_PROVIDER_OVERFLOW_AUTOCOMPACT_DOGFOOD: "1",
  });
  await run("pnpm", ["run", "prepare:electron-native"], dogfoodEnv);

  app = launchDesktop(scratch, dogfoodEnv);
  cdp = await connectToElectron(dogfoodCdpPort(), app);
  await initializePage(cdp);
  await installLiveCollector(cdp);
  const threadId = await createThread(cdp);
  report.threadId = threadId;
  report.artifacts.initialAgentBrowserSnapshot = await writeAgentBrowserSnapshot("initial-snapshot.txt");
  cdp.close();
  cdp = undefined;
  await terminateProcessTree(app);
  app = undefined;

  const seed = await seedOversizedSession({
    threadId,
    workspacePath: scratch.workspacePath,
    userDataPath: scratch.userDataPath,
  });
  report.seed = seed;

  app = launchDesktop(scratch, dogfoodEnv);
  cdp = await connectToElectron(dogfoodCdpPort(), app);
  await initializePage(cdp);
  await installLiveCollector(cdp);
  await selectThread(cdp, threadId);
  report.artifacts.seededAgentBrowserSnapshot = await writeAgentBrowserSnapshot("seeded-snapshot.txt");
  report.artifacts.beforeSendScreenshot = await writeScreenshot(cdp, "before-send.png");

  await sendPrompt(cdp, threadId, "Please answer with PROVIDER_OVERFLOW_AUTOCOMPACT_OK after recovering this thread context.");
  const compactionDom = await waitForCompactingDom(cdp);
  report.checks.compactionDom = compactionDom;
  report.artifacts.compactingScreenshot = await writeScreenshot(cdp, "compacting.png");
  const completion = await waitForCompletion(cdp);
  const finalState = await threadState(cdp, threadId);
  const finalDom = await visibleDomState(cdp);
  const runtimeActivities = completion.runtimeActivities ?? [];
  const statuses = completion.statuses ?? [];
  const assistantText = finalState.assistantText;
  const compactionStart = runtimeActivities.some((activity) =>
    activity.kind === "compaction" && activity.status === "starting" && activity.reason === "overflow"
  );
  const compactionFinishRetry = runtimeActivities.some((activity) =>
    activity.kind === "compaction" &&
    activity.status === "finished" &&
    activity.reason === "overflow" &&
    activity.willRetry === true
  );
  const thinkingEvents = completion.thinkingMessageEvents + completion.thinkingDeltaCount;

  assert(statuses.includes("compacting"), `Run statuses never entered compacting: ${statuses.join(", ")}`);
  assert(compactionStart, `Missing overflow compaction start activity: ${JSON.stringify(runtimeActivities)}`);
  assert(compactionFinishRetry, `Missing overflow compaction finish/willRetry activity: ${JSON.stringify(runtimeActivities)}`);
  assert(compactionDom.progressVisible, `Compaction progress UI was not visible: ${JSON.stringify(compactionDom)}`);
  assert(compactionDom.bodyText.includes("Compacting context"), "Compaction status card text was not visible while compacting.");
  assert(completion.sawRunIdle, `Run did not return to idle after send: ${JSON.stringify(completion)}`);
  assert(/PROVIDER_OVERFLOW_AUTOCOMPACT_OK/i.test(assistantText), `Assistant did not complete the post-compaction turn. Tail: ${assistantText.slice(-1000)}`);
  if (thinkingEvents > 0) {
    assert(
      completion.transientThinkingSeen || finalDom.transientThinkingVisible,
      `Thinking events arrived but transient thinking UI was never observed: ${JSON.stringify(completion)}`,
    );
  }

  report.checks.statuses = statuses;
  report.checks.runtimeActivities = runtimeActivities;
  report.checks.assistantTail = assistantText.slice(-1200);
  report.checks.thinkingEvents = thinkingEvents;
  report.checks.transientThinkingSeen = completion.transientThinkingSeen || finalDom.transientThinkingVisible;
  report.checks.finalDom = finalDom;
  report.artifacts.finalScreenshot = await writeScreenshot(cdp, "final.png");
  report.status = "passed";
} catch (error) {
  exitCode = 1;
  report.status = "failed";
  report.error = error instanceof Error ? error.stack ?? error.message : String(error);
  if (cdp) {
    report.artifacts.failureScreenshot = await writeScreenshot(cdp, "failure.png").catch((screenshotError) => ({
      error: screenshotError instanceof Error ? screenshotError.message : String(screenshotError),
    }));
    report.bodyTail = await bodyText(cdp).then((text) => text.slice(-4000)).catch(() => undefined);
    report.liveTail = await getLiveState(cdp).catch(() => undefined);
  }
  process.stderr.write(`${report.error}\n`);
} finally {
  await writeReport(report);
  if (cdp) cdp.close();
  if (app) await terminateProcessTree(app);
  if (dogfoodEnv) {
    try {
      await run("pnpm", ["run", "prepare:node-native"], dogfoodEnv);
    } catch (error) {
      exitCode = 1;
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    }
  }
  if (scratch) await cleanupScratch(scratch);
}

process.exit(exitCode);

async function createThread(cdpClient) {
  const result = await evaluate(cdpClient, async (model) => {
    await window.ambientDesktop.updateThinkingDisplaySettings({ mode: "transient", showRunStatusCard: false });
    const next = await window.ambientDesktop.createThread({
      permissionMode: "workspace",
      collaborationMode: "agent",
      model,
      thinkingLevel: "minimal",
    });
    const threadId = next.activeThreadId;
    await window.ambientDesktop.updateThread({ threadId, title: "Provider overflow auto-compact dogfood" });
    await window.ambientDesktop.selectThread(threadId);
    return { threadId };
  }, dogfoodModelId());
  assert(result?.threadId, `createThread did not return a thread id: ${JSON.stringify(result)}`);
  return result.threadId;
}

async function seedOversizedSession({ threadId, workspacePath, userDataPath }) {
  const stateDbPath = findStateDb(userDataPath, threadId);
  setProviderOverflowDogfoodCompactionSettings(stateDbPath);
  const authorityRoot = dirname(stateDbPath);
  const sessionDir = join(authorityRoot, "sessions", threadId);
  const sessionManager = SessionManager.create(workspacePath, sessionDir);
  sessionManager.appendModelChange(dogfoodProviderId(), dogfoodModelId());
  sessionManager.appendThinkingLevelChange("minimal");
  const seedMessages = oversizedSeedContents(seedChars);
  for (const content of seedMessages) {
    sessionManager.appendMessage({
      role: "user",
      content,
      timestamp: Date.now(),
    });
  }
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Seeded oversized context acknowledged." }],
    api: "dogfood-seed",
    provider: dogfoodProviderId(),
    model: dogfoodModelId(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const sessionFile = sessionManager.getSessionFile();
  assert(sessionFile && existsSync(sessionFile), `SessionManager did not write a session file in ${sessionDir}.`);
  updateThreadSessionRow(stateDbPath, {
    threadId,
    sessionFile,
    model: dogfoodModelId(),
    thinkingLevel: "minimal",
  });
  return {
    sessionFile,
    sessionBytes: await fileSize(sessionFile),
    seededMessageCount: seedMessages.length,
    stateDbPath,
  };
}

function oversizedSeedContents(chars) {
  const header = [
    "Provider overflow auto-compact seed.",
    "This text intentionally simulates a prior transcript that is too large for provider context safety preflight.",
    "The live prompt after this seed is small; only provider context protection should trigger compaction.",
    "",
  ].join("\n");
  const chunk = "context-overflow-fixture-line abcdefghijklmnopqrstuvwxyz 0123456789\n";
  const messages = [];
  let remaining = Math.max(0, chars);
  let index = 0;
  while (remaining > 0) {
    const targetChars = Math.min(seedMessageChars, remaining);
    const prefix = index === 0 ? header : `Provider overflow auto-compact seed continuation ${index + 1}.\n`;
    let body = "";
    while (prefix.length + body.length < targetChars) body += chunk;
    messages.push(`${prefix}${body.slice(0, Math.max(0, targetChars - prefix.length))}`);
    remaining -= targetChars;
    index += 1;
  }
  return messages;
}

async function sendPrompt(cdpClient, threadId, content) {
  await resetLiveCollector(cdpClient);
  await evaluate(cdpClient, async (input) => {
    const live = window.__ambientProviderOverflowDogfood;
    await window.ambientDesktop.selectThread(input.threadId);
    window.ambientDesktop.sendMessage({
      threadId: input.threadId,
      content: input.content,
      permissionMode: "workspace",
      collaborationMode: "agent",
      model: input.model,
      thinkingLevel: "minimal",
    })
      .then(() => {
        live.sendResolved = true;
      })
      .catch((error) => {
        live.error = error instanceof Error ? error.message : String(error);
      });
    return true;
  }, { threadId, content, model: dogfoodModelId() });
}

async function waitForCompactingDom(cdpClient) {
  const deadline = Date.now() + compactingTimeoutMs;
  while (Date.now() < deadline) {
    const live = await getLiveState(cdpClient);
    if (live?.error) throw new Error(live.error);
    const dom = await visibleDomState(cdpClient);
    if (dom.transientThinkingVisible) await markTransientThinkingSeen(cdpClient);
    if ((live?.statuses ?? []).includes("compacting") && dom.progressVisible) return dom;
    if (live?.sawRunIdle) {
      throw new Error(`Run completed before compacting UI appeared. live=${JSON.stringify(live)}`);
    }
    await delay(300);
  }
  throw new Error(`Timed out waiting for visible compacting UI. live=${JSON.stringify(await getLiveState(cdpClient))}`);
}

async function waitForCompletion(cdpClient) {
  const deadline = Date.now() + chatTurnTimeoutMs;
  while (Date.now() < deadline) {
    const live = await getLiveState(cdpClient);
    if (live?.error) throw new Error(live.error);
    const dom = await visibleDomState(cdpClient);
    if (dom.transientThinkingVisible) await markTransientThinkingSeen(cdpClient);
    if (live?.sendResolved && live?.sawRunIdle) return await getLiveState(cdpClient);
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for provider overflow dogfood completion. live=${JSON.stringify(await getLiveState(cdpClient))}`);
}

async function installLiveCollector(cdpClient) {
  await evaluate(cdpClient, () => {
    if (window.__ambientProviderOverflowDogfood?.unsubscribe) window.__ambientProviderOverflowDogfood.unsubscribe();
    window.__ambientProviderOverflowDogfood = {
      statuses: [],
      runtimeActivities: [],
      messageKinds: {},
      thinkingMessageEvents: 0,
      thinkingDeltaCount: 0,
      assistantTail: "",
      sawRunStart: false,
      sawRunIdle: false,
      sendResolved: false,
      transientThinkingSeen: false,
      error: undefined,
      unsubscribe: undefined,
    };
    window.__ambientProviderOverflowDogfood.unsubscribe = window.ambientDesktop.onEvent((event) => {
      const live = window.__ambientProviderOverflowDogfood;
      if (event.type === "run-status") {
        live.statuses.push(event.status);
        if (event.status !== "idle") live.sawRunStart = true;
        if (live.sawRunStart && event.status === "idle") live.sawRunIdle = true;
      }
      if (event.type === "runtime-activity") {
        live.runtimeActivities.push({
          kind: event.activity?.kind,
          status: event.activity?.status,
          reason: event.activity?.reason,
          willRetry: event.activity?.willRetry,
          aborted: event.activity?.aborted,
          message: event.activity?.message,
          outputChars: event.activity?.outputChars,
          thinkingChars: event.activity?.thinkingChars,
        });
        live.runtimeActivities = live.runtimeActivities.slice(-60);
      }
      if ((event.type === "message-created" || event.type === "message-updated") && event.message?.id) {
        const kind = event.message.metadata?.kind ?? event.message.role;
        live.messageKinds[event.message.id] = kind;
        if (kind === "thinking") live.thinkingMessageEvents += 1;
      }
      if (event.type === "message-delta") {
        const kind = live.messageKinds[event.messageId];
        if (kind === "thinking") live.thinkingDeltaCount += 1;
        if (kind === "assistant") live.assistantTail = `${live.assistantTail}${String(event.delta ?? "")}`.slice(-8000);
      }
      if (event.type === "error") live.error = event.message;
    });
    return true;
  });
}

async function resetLiveCollector(cdpClient) {
  await evaluate(cdpClient, () => {
    const live = window.__ambientProviderOverflowDogfood;
    live.statuses = [];
    live.runtimeActivities = [];
    live.messageKinds = {};
    live.thinkingMessageEvents = 0;
    live.thinkingDeltaCount = 0;
    live.assistantTail = "";
    live.sawRunStart = false;
    live.sawRunIdle = false;
    live.sendResolved = false;
    live.transientThinkingSeen = false;
    live.error = undefined;
    return true;
  });
}

async function markTransientThinkingSeen(cdpClient) {
  await evaluate(cdpClient, () => {
    if (window.__ambientProviderOverflowDogfood) window.__ambientProviderOverflowDogfood.transientThinkingSeen = true;
    return true;
  });
}

async function getLiveState(cdpClient) {
  return evaluate(cdpClient, () => {
    const live = window.__ambientProviderOverflowDogfood;
    return live ? {
      statuses: live.statuses,
      runtimeActivities: live.runtimeActivities,
      thinkingMessageEvents: live.thinkingMessageEvents,
      thinkingDeltaCount: live.thinkingDeltaCount,
      assistantTail: live.assistantTail,
      sawRunStart: live.sawRunStart,
      sawRunIdle: live.sawRunIdle,
      sendResolved: live.sendResolved,
      transientThinkingSeen: live.transientThinkingSeen,
      error: live.error,
    } : undefined;
  });
}

async function threadState(cdpClient, threadId) {
  return evaluate(cdpClient, async (id) => {
    const state = await window.ambientDesktop.bootstrap();
    const messages = (state.messages ?? []).filter((message) => message.threadId === id);
    return {
      messageCount: messages.length,
      assistantText: messages
        .filter((message) => message.role === "assistant" && message.metadata?.kind !== "thinking")
        .map((message) => message.content)
        .join("\n"),
      thinkingMessageCount: messages.filter((message) => message.metadata?.kind === "thinking").length,
      contextUsage: state.contextUsage,
    };
  }, threadId);
}

async function visibleDomState(cdpClient) {
  return evaluate(cdpClient, () => ({
    bodyText: document.body.innerText,
    progressVisible: Boolean(document.querySelector(".run-activity-progress")),
    transientThinkingVisible: Boolean(document.querySelector(".run-activity-card.thinking-transient")),
    runActivityText: Array.from(document.querySelectorAll(".run-activity-card")).map((item) => item.textContent ?? "").join("\n"),
  }));
}

async function selectThread(cdpClient, threadId) {
  await evaluate(cdpClient, async (id) => {
    await window.ambientDesktop.selectThread(id);
    return true;
  }, threadId);
}

async function initializePage(cdpClient) {
  await cdpClient.send("Runtime.enable");
  await cdpClient.send("Page.enable");
  await setViewport(cdpClient, 1500, 950);
  await waitForText(cdpClient, "Ambient", appWaitTimeoutMs);
}

function launchDesktop(_input, env) {
  return spawn("pnpm", [
    "exec",
    "electron-vite",
    "dev",
    "--",
    `--remote-debugging-port=${dogfoodCdpPort()}`,
  ], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env,
  });
}

async function connectToElectron(port, child) {
  const started = Date.now();
  let lastOutput = "";
  child.stdout?.on("data", (chunk) => {
    lastOutput = `${lastOutput}${chunk.toString()}`.slice(-8000);
  });
  child.stderr?.on("data", (chunk) => {
    lastOutput = `${lastOutput}${chunk.toString()}`.slice(-8000);
  });
  while (Date.now() - started < 60_000) {
    if (child.exitCode !== null) throw new Error(`Electron exited before CDP was available.\n${lastOutput}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
        if (page?.webSocketDebuggerUrl) return createCdpClient(page.webSocketDebuggerUrl);
      }
    } catch {
      // Poll until Electron exposes the debugger endpoint.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for Electron CDP on port ${port}.\n${lastOutput}`);
}

function createCdpClient(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (typeof message.id !== "number") return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message || "CDP command failed"));
    else waiter.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const waiter of pending.values()) waiter.reject(new Error("CDP socket closed"));
    pending.clear();
  });
  return {
    send(method, params = {}, options = {}) {
      const id = nextId++;
      const timeoutMs = options.timeoutMs ?? cdpCommandTimeoutMs;
      const ready = socket.readyState === WebSocket.OPEN
        ? Promise.resolve()
        : new Promise((resolveReady, rejectReady) => {
          const timeout = setTimeout(() => rejectReady(new Error(`Timed out waiting for CDP socket open after ${timeoutMs}ms.`)), timeoutMs);
          socket.addEventListener("open", () => {
            clearTimeout(timeout);
            resolveReady();
          }, { once: true });
          socket.addEventListener("error", () => {
            clearTimeout(timeout);
            rejectReady(new Error("CDP socket failed to open."));
          }, { once: true });
        });
      return ready.then(() => new Promise((resolveSend, rejectSend) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          rejectSend(new Error(`Timed out waiting for CDP ${method} after ${timeoutMs}ms.`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timeout);
            resolveSend(value);
          },
          reject: (error) => {
            clearTimeout(timeout);
            rejectSend(error);
          },
        });
        socket.send(JSON.stringify({ id, method, params }));
      }));
    },
    close() {
      socket.close();
    },
  };
}

async function waitForText(cdpClient, text, timeoutMs) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await bodyText(cdpClient)).includes(text)) return;
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw new Error(`Timed out waiting for Electron UI text ${JSON.stringify(text)}.${lastError ? ` Last error: ${lastError.message}` : ""}`);
}

async function evaluate(cdpClient, fnOrExpression, ...args) {
  const expression = typeof fnOrExpression === "function"
    ? `(${fnOrExpression.toString()})(...${JSON.stringify(args)})`
    : String(fnOrExpression);
  const result = await cdpClient.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(`Runtime.evaluate failed: ${JSON.stringify(result.exceptionDetails)}`);
  return result.result?.value;
}

async function bodyText(cdpClient) {
  return evaluate(cdpClient, () => document.body.innerText);
}

async function setViewport(cdpClient, width, height) {
  await cdpClient.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function writeScreenshot(cdpClient, name) {
  await mkdir(resultsDir, { recursive: true });
  const result = await cdpClient.send("Page.captureScreenshot", { format: "png", fromSurface: true }, { timeoutMs: 30_000 });
  const outputPath = join(resultsDir, name);
  await writeFile(outputPath, Buffer.from(result.data, "base64"));
  return outputPathRelative(outputPath);
}

async function writeAgentBrowserSnapshot(name) {
  const outputPath = join(resultsDir, name);
  const result = spawn("pnpm", ["exec", "agent-browser", "--cdp", String(dogfoodCdpPort()), "snapshot", "-i"], {
    cwd: repoRoot,
    env: dogfoodEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  result.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  result.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const [code] = await once(result, "exit");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, stdout || stderr, "utf8");
  assert(code === 0, `agent-browser snapshot failed with ${code}: ${stderr.slice(-1000)}`);
  return outputPathRelative(outputPath);
}

async function createScratch() {
  const root = await mkdtemp(join(tmpdir(), "ambient-provider-overflow-"));
  const workspacePath = resolve(join(root, "workspace"));
  const userDataPath = resolve(join(root, "userData"));
  await mkdir(workspacePath, { recursive: true });
  await mkdir(userDataPath, { recursive: true });
  return { root, workspacePath, userDataPath };
}

async function cleanupScratch(input) {
  if (process.env.AMBIENT_PROVIDER_OVERFLOW_KEEP_SCRATCH === "1") {
    process.stdout.write(`Provider overflow dogfood scratch retained at ${input.root}\n`);
    return;
  }
  await rm(input.root, { recursive: true, force: true });
}

async function seedWorkspace(workspacePath) {
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(workspacePath, "README.md"), "Provider overflow auto-compact dogfood workspace.\n", "utf8");
}

function findStateDb(userDataPath, threadId) {
  const workspacesRoot = join(userDataPath, "authority-state", "workspaces");
  const candidates = [];
  collectStateDbs(workspacesRoot, candidates);
  if (threadId) {
    const matches = candidates.filter((candidate) => stateDbContainsThread(candidate, threadId));
    assert(
      matches.length === 1,
      `Expected exactly one state.sqlite containing thread ${threadId} under ${workspacesRoot}, found ${matches.length} across ${candidates.length} state DB(s).`,
    );
    return matches[0];
  }
  assert(candidates.length === 1, `Expected exactly one state.sqlite under ${workspacesRoot}, found ${candidates.length}.`);
  return candidates[0];
}

function collectStateDbs(dir, output) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) collectStateDbs(full, output);
    else if (name.isFile() && name.name === "state.sqlite") output.push(full);
  }
}

function stateDbContainsThread(stateDbPath, threadId) {
  try {
    const output = runSqlite(stateDbPath, `SELECT COUNT(*) FROM threads WHERE id = ${sqliteLiteral(threadId)} LIMIT 1;`, { readonly: true });
    return Number(output.trim()) > 0;
  } catch {
    return false;
  }
}

function updateThreadSessionRow(stateDbPath, { threadId, sessionFile, model, thinkingLevel }) {
  const sql = [
    "BEGIN;",
    `UPDATE threads SET pi_session_file = ${sqliteLiteral(sessionFile)}, model = ${sqliteLiteral(model)}, thinking_level = ${sqliteLiteral(thinkingLevel)}, updated_at = ${sqliteLiteral(new Date().toISOString())} WHERE id = ${sqliteLiteral(threadId)};`,
    "SELECT changes();",
    "COMMIT;",
  ].join("\n");
  const output = runSqlite(stateDbPath, sql);
  const changes = Number(output.trim().split(/\r?\n/).at(-1));
  assert(changes === 1, `Expected to update one thread row, updated ${Number.isFinite(changes) ? changes : output.trim()}.`);
}

function setProviderOverflowDogfoodCompactionSettings(stateDbPath) {
  const settings = {
    autoCompactionEnabled: true,
    reserveTokens: 16_384,
    keepRecentTokens: 20_000,
    softWarningPercent: 80,
    hardPreflightPercent: 100,
  };
  runSqlite(
    stateDbPath,
    `INSERT INTO settings (key, value_json) VALUES ('compaction', ${sqliteLiteral(JSON.stringify(settings))}) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json;`,
  );
}

function runSqlite(stateDbPath, sql, options = {}) {
  const result = spawnSync("sqlite3", [
    "-batch",
    ...(options.readonly ? ["-readonly"] : []),
    stateDbPath,
    sql,
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`sqlite3 failed for ${stateDbPath}: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function sqliteLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function fileSize(path) {
  return (await readFile(path)).byteLength;
}

function buildDogfoodEnv(extra = {}) {
  const apiKeyFile = ambientApiKeyFilePath();
  const apiKeyFileEnv = apiKeyFile
    ? {
      AMBIENT_API_KEY_FILE: apiKeyFile,
      AMBIENT_AGENT_AMBIENT_API_KEY_FILE: process.env.AMBIENT_AGENT_AMBIENT_API_KEY_FILE || apiKeyFile,
    }
    : {};
  return {
    ...process.env,
    ...dogfoodProviderEnv(process.env),
    ...apiKeyFileEnv,
    ...extra,
  };
}

function ambientApiKeyFilePath() {
  if (process.env.AMBIENT_API_KEY_FILE) return process.env.AMBIENT_API_KEY_FILE;
  if (process.env.AMBIENT_AGENT_AMBIENT_API_KEY_FILE) return process.env.AMBIENT_AGENT_AMBIENT_API_KEY_FILE;
  let current = repoRoot;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(current, "ignored-provider-key-file.txt");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const siblingCheckoutCandidate = join(dirname(repoRoot), "ambientCoder", "ignored-provider-key-file.txt");
  if (existsSync(siblingCheckoutCandidate)) return siblingCheckoutCandidate;
  return undefined;
}

function dogfoodProviderEnv(env) {
  const providerId = env.AMBIENT_PROVIDER || defaultDogfoodProvider;
  const modelId = env.AMBIENT_LIVE_MODEL || env.GMI_CLOUD_MODEL || env.AMBIENT_MODEL || defaultDogfoodModel;
  const next = {
    AMBIENT_PROVIDER: providerId,
    AMBIENT_MODEL: modelId,
    AMBIENT_LIVE_MODEL: modelId,
  };
  if (providerId === "gmi-cloud") next.GMI_CLOUD_MODEL = modelId;
  return next;
}

function dogfoodProviderId() {
  return process.env.AMBIENT_PROVIDER || defaultDogfoodProvider;
}

function dogfoodModelId() {
  return process.env.AMBIENT_LIVE_MODEL || process.env.GMI_CLOUD_MODEL || process.env.AMBIENT_MODEL || defaultDogfoodModel;
}

function dogfoodCdpPort() {
  const raw = process.env.AMBIENT_SUBAGENT_DESKTOP_DOGFOOD_CDP_PORT || process.env.AMBIENT_HARNESS_CDP_PORT;
  const port = Number(raw);
  if (Number.isInteger(port) && port > 0 && port < 65_536) return port;
  throw new Error("AMBIENT_SUBAGENT_DESKTOP_DOGFOOD_CDP_PORT is required; run through scripts/run-electron-dogfood.mjs.");
}

async function run(command, args, env) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env,
  });
  const [code, signal] = await once(child, "exit");
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed with ${signal ?? code}.`);
}

async function terminateProcessTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    // Best effort cleanup.
  }
  if (await waitForAppExit(child, 5_000)) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    // Best effort cleanup.
  }
  await waitForAppExit(child, 5_000);
}

async function waitForAppExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  let timeout;
  const exitPromise = once(child, "exit").then(() => true);
  const timeoutPromise = new Promise((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
  });
  const result = await Promise.race([exitPromise, timeoutPromise]);
  if (timeout) clearTimeout(timeout);
  return result;
}

async function writeReport(value) {
  await mkdir(resultsDir, { recursive: true });
  const next = {
    ...value,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - Date.parse(value.startedAt),
  };
  await writeFile(latestReportPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  const runReportPath = join(resultsDir, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(runReportPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function outputPathRelative(path) {
  return relative(repoRoot, path);
}

function gitValue(args) {
  try {
    const result = spawnGit(args);
    return result.status === 0 ? result.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

function spawnGit(args) {
  return spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
