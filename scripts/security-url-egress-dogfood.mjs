#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repoRoot = process.cwd();
const defaultProvider = "ambient";
const defaultModel = "example/model-id";
const supportedScenarios = new Set(["security-plugin-preview-egress", "security-managed-download-egress"]);
const scenario = parseScenario(process.argv.slice(2));
const resultsDir = join(repoRoot, "test-results", scenario);
const latestReportPath = join(resultsDir, "latest.json");
const schemaVersion = "ambient-security-url-egress-dogfood-v1";
const cdpCommandTimeoutMs = 120_000;
const appWaitTimeoutMs = 90_000;
const chatTurnTimeoutMs = Number(process.env.AMBIENT_SECURITY_URL_EGRESS_CHAT_TIMEOUT_MS ?? 300_000);
const startedAt = new Date().toISOString();
const allowedDownloadToolNames = new Set([
  "ambient_tool_search",
  "ambient_tool_describe",
  "ambient_download_start",
]);

let app;
let cdp;
let scratch;
let fixtureServer;
let dogfoodEnv;

try {
  await rm(latestReportPath, { force: true });
  await mkdir(resultsDir, { recursive: true });
  dogfoodEnv = buildDogfoodEnv();
  await run("pnpm", ["run", "prepare:electron-native"], dogfoodEnv);

  scratch = await createScratch();
  fixtureServer = await startBlockedFixtureServer();
  app = launchDesktop(scratch);
  cdp = await connectToElectron(dogfoodCdpPort(), app);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await setViewport(cdp, 1500, 950);
  await waitForText(cdp, "Ambient", appWaitTimeoutMs);

  const initialEvidence = await captureAgentBrowserEvidence(cdp, "initial");
  const threadId = await createThread(cdp, `${scenario} dogfood`);
  const proof = scenario === "security-plugin-preview-egress"
    ? await exercisePluginPreviewEgress(cdp, { fixtureUrl: fixtureServer.url })
    : await exerciseManagedDownloadEgress(cdp, { threadId, fixtureUrl: fixtureServer.url });
  const finalEvidence = await captureAgentBrowserEvidence(cdp, "final");

  await assertFixtureNotReached(fixtureServer, proof);
  await writeReport({
    schemaVersion,
    scenario,
    startedAt,
    status: "passed",
    provider: {
      providerId: dogfoodProviderId(),
      modelId: dogfoodModelId(),
      ambientKeyConfigured: ambientKeyConfigured(),
    },
    fixture: {
      url: fixtureServer.url,
      requestCount: fixtureServer.requestCount(),
      requests: fixtureServer.requests(),
    },
    thread: {
      threadId,
      workspacePath: scratch.workspacePath,
      userDataPath: scratch.userDataPath,
    },
    proof,
    electronSkillEvidence: {
      initial: initialEvidence,
      final: finalEvidence,
    },
    artifacts: {
      latestReport: outputPathRelative(latestReportPath),
      initialSnapshot: initialEvidence.snapshotPath,
      initialScreenshot: initialEvidence.screenshotPath,
      finalSnapshot: finalEvidence.snapshotPath,
      finalScreenshot: finalEvidence.screenshotPath,
    },
  });
  console.log(`${scenario} dogfood passed. Results: ${outputPathRelative(latestReportPath)}`);
} catch (error) {
  const failure = error instanceof Error ? error : new Error(String(error));
  if (cdp) {
    try {
      const failureScreenshotPath = join(resultsDir, "failure-cdp-screenshot.png");
      const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, { timeoutMs: 30_000 });
      await writeFile(failureScreenshotPath, Buffer.from(screenshot.data, "base64"));
    } catch {
      // Preserve the original failure.
    }
  }
  await writeReport({
    schemaVersion,
    scenario,
    startedAt,
    status: "failed",
    provider: {
      providerId: dogfoodProviderId(),
      modelId: dogfoodModelId(),
      ambientKeyConfigured: ambientKeyConfigured(),
    },
    fixture: fixtureServer
      ? {
          url: fixtureServer.url,
          requestCount: fixtureServer.requestCount(),
          requests: fixtureServer.requests(),
        }
      : undefined,
    error: failure.message,
    stack: failure.stack,
  }).catch(() => undefined);
  console.error(failure.stack ?? failure.message);
  process.exitCode = 1;
} finally {
  cdp?.close?.();
  fixtureServer?.close?.();
  await terminateProcessTree(app);
  try {
    await run("pnpm", ["run", "prepare:node-native"], dogfoodEnv ?? buildDogfoodEnv());
  } catch (error) {
    process.exitCode = 1;
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  }
  if (scratch && process.env.AMBIENT_SECURITY_URL_EGRESS_KEEP_SCRATCH !== "1") {
    await rm(scratch.root, { recursive: true, force: true }).catch(() => undefined);
  } else if (scratch) {
    console.error(`Keeping security URL egress dogfood scratch: ${scratch.root}`);
  }
}

function parseScenario(argv) {
  let nextScenario = "security-plugin-preview-egress";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--scenario") nextScenario = argv[++index];
    else if (arg.startsWith("--scenario=")) nextScenario = arg.slice("--scenario=".length);
    else throw new Error(`Unknown security URL egress dogfood argument: ${arg}`);
  }
  if (!supportedScenarios.has(nextScenario)) {
    throw new Error(`Unsupported security URL egress dogfood scenario: ${nextScenario}`);
  }
  return nextScenario;
}

async function createScratch() {
  const root = await mkdtemp(join(tmpdir(), "ambient-security-url-egress-"));
  const workspacePath = resolve(join(root, "workspace"));
  const userDataPath = resolve(join(root, "userData"));
  await mkdir(workspacePath, { recursive: true });
  await mkdir(userDataPath, { recursive: true });
  await writeFile(join(workspacePath, "README.md"), "# Security URL Egress Dogfood\n", "utf8");
  return { root, workspacePath, userDataPath };
}

async function createThread(cdpClient, title) {
  return evaluate(cdpClient, async (input) => {
    const state = await window.ambientDesktop.createThread({
      permissionMode: "full-access",
      collaborationMode: "agent",
      model: input.model,
      thinkingLevel: "minimal",
    });
    const threadId = state.activeThreadId;
    if (window.ambientDesktop.updateThread) {
      await window.ambientDesktop.updateThread({ threadId, title: input.title });
    }
    if (window.ambientDesktop.updateThreadSettings) {
      await window.ambientDesktop.updateThreadSettings({
        threadId,
        collaborationMode: "agent",
        model: input.model,
        thinkingLevel: "minimal",
      });
    }
    await window.ambientDesktop.selectThread(threadId);
    return threadId;
  }, { title, model: dogfoodModelId() });
}

async function exercisePluginPreviewEgress(cdpClient, input) {
  const result = await evaluate(cdpClient, async ({ fixtureUrl }) => {
    await window.ambientDesktop.addCodexMarketplace({
      source: fixtureUrl,
      name: "Blocked Loopback Marketplace",
      allowExperimental: true,
    });
    const catalog = await window.ambientDesktop.discoverCodexPlugins();
    return {
      errors: catalog.errors ?? [],
      marketplaceSources: catalog.marketplaceSources ?? [],
      pluginCount: catalog.plugins?.length ?? 0,
      importCandidateCount: catalog.importCandidates?.length ?? 0,
    };
  }, input);
  const combinedText = [
    ...(result.errors ?? []),
    ...(result.marketplaceSources ?? []).map((source) => JSON.stringify(source)),
  ].join("\n");
  const failures = [];
  if (!/URL egress/i.test(combinedText)) failures.push("plugin preview catalog did not surface a URL egress error");
  if (!/loopback/i.test(combinedText)) failures.push("plugin preview catalog did not identify the loopback target");
  if (!combinedText.includes(input.fixtureUrl)) failures.push("plugin preview evidence did not include the blocked marketplace URL");
  if (failures.length) {
    throw new Error(`Security plugin preview egress dogfood failed:\n- ${failures.join("\n- ")}\n\nCatalog text:\n${combinedText.slice(-4000)}`);
  }
  return {
    scenario,
    blockedUrl: input.fixtureUrl,
    catalogErrors: result.errors,
    marketplaceSources: result.marketplaceSources,
    pluginCount: result.pluginCount,
    importCandidateCount: result.importCandidateCount,
    egressErrorVisible: /URL egress/i.test(combinedText),
    loopbackVisible: /loopback/i.test(combinedText),
  };
}

async function exerciseManagedDownloadEgress(cdpClient, input) {
  await installLiveCollector(cdpClient);
  await resetLiveCollector(cdpClient);
  const prompt = [
    "This is a live Ambient Desktop security hardening dogfood.",
    "Do not call shell, bash, browser, file write, install, ambient_cli, ambient_tool_call, or package execution tools.",
    "Use the direct tools when active. If Ambient requires routed discovery, you may call ambient_tool_search or ambient_tool_describe only to locate or activate the direct download tool for this task.",
    `Call ambient_download_start exactly once with url ${JSON.stringify(input.fixtureUrl)}, destinationKind "quarantine", destinationPath "blocked-egress.txt", overwrite true, and no sha256.`,
    "This request is expected to be rejected by URL egress policy before the fixture server receives any HTTP request.",
    "Do not call ambient_download_wait unless ambient_download_start returns a successful jobId.",
    "After the tool returns, reply exactly SECURITY_MANAGED_DOWNLOAD_EGRESS_OK.",
  ].join("\n");
  await evaluate(cdpClient, async (turn) => {
    const live = window.__ambientSecurityUrlEgressDogfood;
    await window.ambientDesktop.selectThread(turn.threadId);
    window.ambientDesktop.sendMessage({
      threadId: turn.threadId,
      content: turn.prompt,
      permissionMode: "full-access",
      collaborationMode: "agent",
      model: turn.model,
      thinkingLevel: "minimal",
    })
      .then(() => {
        live.sendResolved = true;
      })
      .catch((error) => {
        live.error = error instanceof Error ? error.message : String(error);
      });
    return true;
  }, { threadId: input.threadId, prompt, model: dogfoodModelId() });
  const turn = await waitForManagedDownloadEvidence(cdpClient, input.threadId, chatTurnTimeoutMs);
  return assertManagedDownloadEvidence(turn, input);
}

async function waitForManagedDownloadEvidence(cdpClient, threadId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    const live = await getLiveState(cdpClient);
    if (live?.error) throw new Error(live.error);
    const state = await evaluate(cdpClient, async (id) => {
      await window.ambientDesktop.selectThread(id);
      return window.ambientDesktop.bootstrap();
    }, threadId);
    const messages = (state.messages ?? []).filter((message) => message.threadId === threadId);
    const assistantText = messages
      .filter((message) => message.role === "assistant" && message.metadata?.kind !== "thinking")
      .map((message) => message.content)
      .join("\n");
    const toolMessages = messages.filter((message) => message.role === "tool");
    const downloadMessages = toolMessages.filter((message) => message.metadata?.toolName === "ambient_download_start");
    latest = { threadId, messages, assistantText, toolMessages, downloadMessages, live };
    if (downloadMessages.length >= 1 && assistantText.includes("SECURITY_MANAGED_DOWNLOAD_EGRESS_OK")) return latest;
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for managed download egress evidence. Latest: ${JSON.stringify(summarizeTurn(latest ?? {}), null, 2)}`);
}

function assertManagedDownloadEvidence(turn, input) {
  const toolText = turn.downloadMessages.map((message) => String(message.content ?? "")).join("\n");
  const allToolText = turn.toolMessages.map((message) => String(message.content ?? "")).join("\n");
  const assistantText = String(turn.assistantText ?? "");
  const visibleText = [toolText, allToolText, assistantText, JSON.stringify(turn.live?.toolEvents ?? [])].join("\n");
  const toolNames = turn.toolMessages.map((message) => String(message.metadata?.toolName ?? "unknown"));
  const forbiddenToolNames = toolNames.filter((toolName) => !allowedDownloadToolNames.has(toolName));
  const destinationPath = join(scratch.workspacePath, ".ambient", "download-quarantine", "blocked-egress.txt");
  const failures = [];
  if (forbiddenToolNames.length) failures.push(`forbidden tool calls were used: ${forbiddenToolNames.join(", ")}`);
  if (turn.downloadMessages.length !== 1) failures.push(`expected exactly one ambient_download_start tool message, saw ${turn.downloadMessages.length}`);
  if (!/URL egress/i.test(visibleText)) failures.push("managed download result did not surface a URL egress error");
  if (!/loopback/i.test(visibleText)) failures.push("managed download result did not identify the loopback target");
  if (!assistantText.includes("SECURITY_MANAGED_DOWNLOAD_EGRESS_OK")) failures.push("assistant did not emit SECURITY_MANAGED_DOWNLOAD_EGRESS_OK");
  if (existsSync(destinationPath)) failures.push(`blocked managed download wrote ${destinationPath}`);
  if (failures.length) {
    throw new Error(`Security managed download egress dogfood failed:\n- ${failures.join("\n- ")}\n\nTool text:\n${visibleText.slice(-4000)}`);
  }
  return {
    scenario,
    blockedUrl: input.fixtureUrl,
    toolNames,
    forbiddenToolNames,
    downloadToolMessageCount: turn.downloadMessages.length,
    egressErrorVisible: /URL egress/i.test(visibleText),
    loopbackVisible: /loopback/i.test(visibleText),
    destinationPath: outputPathRelative(destinationPath),
    destinationExists: existsSync(destinationPath),
    assistantHasMarker: assistantText.includes("SECURITY_MANAGED_DOWNLOAD_EGRESS_OK"),
    runtimeActivities: turn.live?.runtimeActivities?.slice(-12) ?? [],
    toolEvents: turn.live?.toolEvents?.slice(-12) ?? [],
  };
}

async function assertFixtureNotReached(server, proof) {
  const requestCount = server.requestCount();
  if (requestCount !== 0) {
    throw new Error(`${proof.scenario} allowed ${requestCount} request(s) to reach the blocked fixture: ${JSON.stringify(server.requests(), null, 2)}`);
  }
}

async function installLiveCollector(cdpClient) {
  await evaluate(cdpClient, () => {
    window.__ambientSecurityUrlEgressDogfood?.unsubscribe?.();
    window.__ambientSecurityUrlEgressDogfood = {
      runtimeActivities: [],
      toolEvents: [],
      assistantTail: "",
      sendResolved: true,
      error: undefined,
    };
    window.__ambientSecurityUrlEgressDogfood.unsubscribe = window.ambientDesktop.onEvent((event) => {
      const live = window.__ambientSecurityUrlEgressDogfood;
      if (event.type === "runtime-activity") {
        live.runtimeActivities.push({
          kind: event.activity?.kind,
          status: event.activity?.status,
          message: event.activity?.message,
          toolName: event.activity?.toolName,
        });
        live.runtimeActivities = live.runtimeActivities.slice(-120);
      }
      if (event.type === "tool-event") {
        live.toolEvents.push({
          status: event.status,
          label: event.label,
          details: event.details,
        });
        live.toolEvents = live.toolEvents.slice(-120);
      }
      if (event.type === "message-delta") {
        live.assistantTail = (live.assistantTail + String(event.delta ?? "")).slice(-8000);
      }
      if (event.type === "error") live.error = event.message;
    });
    return true;
  });
}

async function resetLiveCollector(cdpClient) {
  await evaluate(cdpClient, () => {
    const live = window.__ambientSecurityUrlEgressDogfood;
    if (!live) return false;
    live.runtimeActivities = [];
    live.toolEvents = [];
    live.assistantTail = "";
    live.sendResolved = false;
    live.error = undefined;
    return true;
  });
}

async function getLiveState(cdpClient) {
  return evaluate(cdpClient, () => {
    const live = window.__ambientSecurityUrlEgressDogfood;
    return live
      ? {
          runtimeActivities: live.runtimeActivities,
          toolEvents: live.toolEvents,
          assistantTail: live.assistantTail,
          sendResolved: live.sendResolved,
          error: live.error,
        }
      : undefined;
  });
}

function summarizeTurn(turn) {
  return {
    threadId: turn.threadId,
    assistantChars: String(turn.assistantText ?? "").length,
    assistantHasMarker: String(turn.assistantText ?? "").includes("SECURITY_MANAGED_DOWNLOAD_EGRESS_OK"),
    downloadToolMessageCount: turn.downloadMessages?.length ?? 0,
    toolNames: (turn.toolMessages ?? []).map((message) => message.metadata?.toolName ?? "unknown"),
    messageCount: turn.messages?.length ?? 0,
    runtimeActivities: turn.live?.runtimeActivities?.slice(-8) ?? [],
    toolEvents: turn.live?.toolEvents?.slice(-8) ?? [],
  };
}

async function startBlockedFixtureServer() {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      host: request.headers.host,
      at: new Date().toISOString(),
    });
    if (scenario === "security-plugin-preview-egress") {
      const body = JSON.stringify({
        name: "blocked-loopback-marketplace",
        plugins: [],
      });
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      });
      response.end(body);
      return;
    }
    const body = "blocked managed download fixture\n";
    response.writeHead(200, {
      "content-type": "text/plain",
      "content-length": String(Buffer.byteLength(body)),
    });
    response.end(body);
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Blocked fixture server did not bind a TCP port.");
  return {
    url: `http://127.0.0.1:${address.port}/${scenario}.fixture`,
    requests: () => [...requests],
    requestCount: () => requests.length,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}

async function captureAgentBrowserEvidence(cdpClient, label) {
  const session = `${scenario}-${process.pid}`;
  const snapshotPath = join(resultsDir, `${label}-agent-browser-snapshot.txt`);
  const screenshotPath = join(resultsDir, `${label}-agent-browser-screenshot.png`);
  await mkdir(resultsDir, { recursive: true });
  if (!agentBrowserAvailable()) {
    return captureCdpBrowserEvidence(cdpClient, { label, session, snapshotPath, screenshotPath });
  }
  await runCaptured("agent-browser", ["--session", session, "connect", String(dogfoodCdpPort())], 30_000);
  const snapshot = await runCaptured("agent-browser", ["--session", session, "snapshot", "-i"], 30_000);
  await writeFile(snapshotPath, snapshot.stdout || snapshot.stderr, "utf8");
  await runCaptured("agent-browser", ["--session", session, "screenshot", screenshotPath], 30_000);
  const screenshotStat = await stat(screenshotPath);
  if (screenshotStat.size < 1_000) throw new Error(`agent-browser screenshot was unexpectedly small: ${screenshotStat.size} bytes.`);
  const rendererBodyText = await bodyText(cdpClient).catch((error) => `CDP body text unavailable: ${error instanceof Error ? error.message : String(error)}`);
  assertRendererDidNotCrash(label, snapshot.stdout || snapshot.stderr, rendererBodyText);
  return {
    source: "agent-browser electron skill",
    label,
    session,
    cdpPort: dogfoodCdpPort(),
    snapshotPath: outputPathRelative(snapshotPath),
    snapshotPreview: (snapshot.stdout || snapshot.stderr).slice(0, 1200),
    screenshotPath: outputPathRelative(screenshotPath),
    screenshotBytes: screenshotStat.size,
  };
}

async function captureCdpBrowserEvidence(cdpClient, input) {
  const snapshotText = await bodyText(cdpClient).catch((error) => `CDP body text unavailable: ${error instanceof Error ? error.message : String(error)}`);
  await writeFile(input.snapshotPath, snapshotText || "(empty body text)", "utf8");
  const screenshot = await cdpClient.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, { timeoutMs: 30_000 });
  await writeFile(input.screenshotPath, Buffer.from(screenshot.data, "base64"));
  const screenshotStat = await stat(input.screenshotPath);
  if (screenshotStat.size < 1_000) throw new Error(`CDP fallback screenshot was unexpectedly small: ${screenshotStat.size} bytes.`);
  assertRendererDidNotCrash(input.label, snapshotText);
  return {
    source: "cdp fallback; agent-browser unavailable",
    label: input.label,
    session: input.session,
    cdpPort: dogfoodCdpPort(),
    snapshotPath: outputPathRelative(input.snapshotPath),
    snapshotPreview: snapshotText.slice(0, 1200),
    screenshotPath: outputPathRelative(input.screenshotPath),
    screenshotBytes: screenshotStat.size,
  };
}

function assertRendererDidNotCrash(label, ...texts) {
  const crashText = texts.find((text) => /Ambient renderer crashed|Maximum update depth exceeded|\[renderer:react-error-boundary\]/i.test(String(text ?? "")));
  if (!crashText) return;
  throw new Error(`Renderer crash screen appeared during ${label} evidence capture:\n${String(crashText).slice(0, 4000)}`);
}

function agentBrowserAvailable() {
  const result = spawnSync("agent-browser", ["--help"], {
    cwd: repoRoot,
    stdio: "ignore",
    env: cleanChildEnv(process.env),
  });
  return result.status === 0;
}

function launchDesktop(input) {
  const env = buildDogfoodEnv({
    extra: {
      AMBIENT_E2E: "1",
      AMBIENT_DESKTOP_WORKSPACE: input.workspacePath,
      AMBIENT_E2E_USER_DATA: input.userDataPath,
      AMBIENT_CODEX_CURATED_MARKETPLACE_URL: "0",
    },
    disableLocalHttpEgress: true,
  });
  return spawn(
    "pnpm",
    ["exec", "electron-vite", "dev", "--", `--remote-debugging-port=${dogfoodCdpPort()}`],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env,
    },
  );
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
      // Keep polling until Electron exposes the debugger endpoint.
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
      const ready =
        socket.readyState === WebSocket.OPEN
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
      return ready.then(
        () =>
          new Promise((resolveSend, rejectSend) => {
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
          }),
      );
    },
    close() {
      socket.close();
    },
  };
}

async function waitForText(cdpClient, text, timeoutMs) {
  await waitFor(cdpClient, (expected) => document.body.innerText.includes(expected), timeoutMs, text);
}

async function waitFor(cdpClient, predicate, timeoutMs, ...args) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      if (await evaluate(cdpClient, predicate, ...args)) return;
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  const body = await bodyText(cdpClient).catch(() => "");
  throw new Error(`Timed out waiting for Electron UI condition.${lastError ? ` Last error: ${lastError.message}` : ""}\n\nBody tail:\n${body.slice(-2000)}`);
}

async function evaluate(cdpClient, fnOrExpression, ...args) {
  const expression = typeof fnOrExpression === "function" ? `(${fnOrExpression.toString()})(...${JSON.stringify(args)})` : String(fnOrExpression);
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

async function run(command, commandArgs, env = process.env) {
  const result = await runCaptured(command, commandArgs, 120_000, env);
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed with ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function runCaptured(command, commandArgs, timeoutMs, env = process.env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs, {
      cwd: repoRoot,
      env: cleanChildEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error(`Timed out running ${command} ${commandArgs.join(" ")}`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once("exit", (status) => {
      clearTimeout(timer);
      resolveRun({ status: status ?? 1, stdout, stderr });
    });
  });
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
}

async function waitForAppExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const timeout = delay(timeoutMs).then(() => false);
  const exited = new Promise((resolveExit) => child.once("exit", () => resolveExit(true)));
  return Promise.race([timeout, exited]);
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

function buildDogfoodEnv(input = {}) {
  const providerId = dogfoodProviderId();
  const modelId = dogfoodModelId(providerId);
  const apiKeyFile = ambientApiKeyFilePath();
  const keyFileEnv = apiKeyFile
    ? {
        AMBIENT_API_KEY_FILE: apiKeyFile,
        AMBIENT_AGENT_AMBIENT_API_KEY_FILE: process.env.AMBIENT_AGENT_AMBIENT_API_KEY_FILE || apiKeyFile,
      }
    : {};
  const next = cleanChildEnv({
    ...process.env,
    ...(input.extra ?? {}),
    ...keyFileEnv,
    AMBIENT_PROVIDER: providerId,
    ...(providerId === "gmi-cloud" ? { GMI_CLOUD_MODEL: modelId } : { AMBIENT_LIVE_MODEL: modelId }),
  });
  if (input.disableLocalHttpEgress) delete next.AMBIENT_EGRESS_ALLOW_LOCAL_HTTP;
  return next;
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
  if (process.env.HOME) {
    const homeCheckoutCandidate = join(process.env.HOME, "ambientCoder", "ignored-provider-key-file.txt");
    if (existsSync(homeCheckoutCandidate)) return homeCheckoutCandidate;
  }
  const siblingCheckoutCandidate = join(dirname(repoRoot), "ambientCoder", "ignored-provider-key-file.txt");
  if (existsSync(siblingCheckoutCandidate)) return siblingCheckoutCandidate;
  return undefined;
}

function ambientKeyConfigured() {
  return Boolean(process.env.AMBIENT_API_KEY || process.env.AMBIENT_AGENT_AMBIENT_API_KEY || ambientApiKeyFilePath());
}

function dogfoodProviderId() {
  return process.env.AMBIENT_PROVIDER || defaultProvider;
}

function dogfoodModelId(providerId = dogfoodProviderId()) {
  return providerId === "gmi-cloud"
    ? process.env.GMI_CLOUD_MODEL || process.env.AMBIENT_MODEL || defaultModel
    : process.env.AMBIENT_LIVE_MODEL || process.env.AMBIENT_MODEL || defaultModel;
}

function dogfoodCdpPort() {
  const parsed = Number(process.env.AMBIENT_HARNESS_CDP_PORT || process.env.AMBIENT_SUBAGENT_DESKTOP_DOGFOOD_CDP_PORT);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 19791;
}

function cleanChildEnv(env) {
  const next = { ...env };
  delete next.NODE_OPTIONS;
  delete next.VITEST;
  return next;
}

function outputPathRelative(path) {
  const rel = relative(repoRoot, path);
  return rel && !rel.startsWith("..") ? rel : path;
}
