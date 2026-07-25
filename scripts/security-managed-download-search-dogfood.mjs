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
const resultsDir = join(repoRoot, "test-results", "security-managed-download-search");
const latestReportPath = join(resultsDir, "latest.json");
const defaultProvider = "ambient";
const defaultModel = "example/model-id";
const schemaVersion = "ambient-security-managed-download-search-dogfood-v1";
const cdpCommandTimeoutMs = 20_000;
const appWaitTimeoutMs = 90_000;
const chatTurnTimeoutMs = Number(process.env.AMBIENT_SECURITY_DOWNLOAD_DOGFOOD_CHAT_TIMEOUT_MS ?? 300_000);
const fixtureBytes = Buffer.from("unsigned managed download fixture\n");
const startedAt = new Date().toISOString();
const allowedDogfoodToolNames = new Set([
  "ambient_tool_search",
  "ambient_tool_describe",
  "ambient_cli_search",
  "ambient_download_start",
  "ambient_download_wait",
]);

let app;
let cdp;
let scratch;
let report;
let fixtureServer;

try {
  await rm(latestReportPath, { force: true });
  await mkdir(resultsDir, { recursive: true });
  await run("pnpm", ["run", "prepare:electron-native"], buildDogfoodEnv());

  scratch = await createScratch();
  fixtureServer = await startFixtureServer(fixtureBytes);
  app = launchDesktop(scratch);
  cdp = await connectToElectron(dogfoodCdpPort(), app);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await setViewport(cdp, 1500, 950);
  await waitForText(cdp, "Ambient", appWaitTimeoutMs);
  await installLiveCollector(cdp);

  const initialBrowserEvidence = await captureAgentBrowserEvidence(cdp, "before-turn");
  const threadId = await createThread(cdp, {
    title: "Security managed download search dogfood",
    model: dogfoodModelId(),
  });
  await seedAmbientCliSearchFixture(scratch.workspacePath, scratch.healthMarkerPath);
  await rm(scratch.healthMarkerPath, { force: true });
  const prompt = dogfoodPrompt(fixtureServer.url);
  const turn = await runChatTurn(cdp, { threadId, prompt, model: dogfoodModelId() });
  const finalBrowserEvidence = await captureAgentBrowserEvidence(cdp, "after-turn");
  const proof = await assertSecurityEvidence(turn, scratch);

  report = {
    schemaVersion,
    scenario: "security-managed-download-search",
    startedAt,
    status: "passed",
    provider: {
      providerId: dogfoodProviderId(),
      modelId: dogfoodModelId(),
      ambientKeyConfigured: ambientKeyConfigured(),
    },
    turn: summarizeTurn(turn),
    proof,
    electronSkillEvidence: {
      initial: initialBrowserEvidence,
      final: finalBrowserEvidence,
    },
    artifacts: {
      latestReport: outputPathRelative(latestReportPath),
      initialSnapshot: initialBrowserEvidence.snapshotPath,
      initialScreenshot: initialBrowserEvidence.screenshotPath,
      finalSnapshot: finalBrowserEvidence.snapshotPath,
      finalScreenshot: finalBrowserEvidence.screenshotPath,
    },
  };
  await writeReport(report);
  console.log(`Security managed download search dogfood passed. Results: ${outputPathRelative(latestReportPath)}`);
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
  report = {
    schemaVersion,
    scenario: "security-managed-download-search",
    startedAt,
    status: "failed",
    provider: {
      providerId: dogfoodProviderId(),
      modelId: dogfoodModelId(),
      ambientKeyConfigured: ambientKeyConfigured(),
    },
    error: failure.message,
    stack: failure.stack,
  };
  await writeReport(report).catch(() => undefined);
  console.error(failure.stack ?? failure.message);
  process.exitCode = 1;
} finally {
  cdp?.close?.();
  fixtureServer?.close?.();
  await terminateProcessTree(app);
  try {
    await run("pnpm", ["run", "prepare:node-native"], buildDogfoodEnv());
  } catch (error) {
    process.exitCode = 1;
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  }
  if (scratch && process.env.AMBIENT_SECURITY_DOWNLOAD_DOGFOOD_KEEP_SCRATCH !== "1") {
    await rm(scratch.root, { recursive: true, force: true }).catch(() => undefined);
  } else if (scratch) {
    console.error(`Keeping security managed download search dogfood scratch: ${scratch.root}`);
  }
}

function dogfoodPrompt(fixtureUrl) {
  return [
    "This is a live Ambient Desktop security hardening dogfood.",
    "Do not call shell, bash, browser, file write, install, ambient_cli, ambient_tool_call, or package execution tools.",
    "Use the direct tools when active. If Ambient requires routed discovery, you may call ambient_tool_search or ambient_tool_describe only to locate or activate the direct tools for this task.",
    "Call ambient_cli_search exactly once with query \"search health marker\" and kind \"command\".",
    `Then call ambient_download_start with url ${JSON.stringify(fixtureUrl)}, destinationKind "managed-install", destinationPath "runtimes/unsigned-fixture.txt", overwrite true, and no sha256. This is expected to be rejected because managed-install requires a checksum.`,
    `Then call ambient_download_start with url ${JSON.stringify(fixtureUrl)}, destinationKind "quarantine", destinationPath "unsigned-fixture.txt", overwrite true, and no sha256.`,
    "Then call ambient_download_wait exactly once for the quarantine jobId returned by the successful start.",
    "After those tool calls return, reply exactly SECURITY_MANAGED_DOWNLOAD_SEARCH_OK.",
    "Do not call ambient_cli, and do not try to run any package command.",
  ].join("\n");
}

async function createThread(cdpClient, input) {
  const threadId = await evaluate(cdpClient, async (threadInput) => {
    const next = await window.ambientDesktop.createThread({
      permissionMode: "full-access",
      collaborationMode: "agent",
      model: threadInput.model,
      thinkingLevel: "minimal",
    });
    const id = next.activeThreadId;
    if (window.ambientDesktop.updateThread) {
      await window.ambientDesktop.updateThread({ threadId: id, title: threadInput.title });
    }
    await window.ambientDesktop.selectThread(id);
    if (window.ambientDesktop.updateThreadSettings) {
      await window.ambientDesktop.updateThreadSettings({
        threadId: id,
        collaborationMode: "agent",
        model: threadInput.model,
        thinkingLevel: "minimal",
      });
    }
    await window.ambientDesktop.selectThread(id);
    return id;
  }, input);
  if (!threadId) throw new Error("Security managed download search dogfood could not create an active thread.");
  return threadId;
}

async function runChatTurn(cdpClient, input) {
  await resetLiveCollector(cdpClient);
  await evaluate(cdpClient, async (turn) => {
    const live = window.__ambientSecurityManagedDownloadDogfood;
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
  }, input);
  return waitForSecurityEvidence(cdpClient, input.threadId, chatTurnTimeoutMs);
}

async function waitForSecurityEvidence(cdpClient, threadId, timeoutMs) {
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
    const searchMessages = messages.filter(
      (message) => message.role === "tool" && message.metadata?.toolName === "ambient_cli_search",
    );
    const toolMessages = messages.filter((message) => message.role === "tool");
    const downloadMessages = messages.filter(
      (message) =>
        message.role === "tool" &&
        (message.metadata?.toolName === "ambient_download_start" || message.metadata?.toolName === "ambient_download_wait"),
    );
    latest = { threadId, messages, assistantText, toolMessages, searchMessages, downloadMessages, live };
    if (searchMessages.length >= 1 && downloadMessages.length >= 2 && assistantText.includes("SECURITY_MANAGED_DOWNLOAD_SEARCH_OK")) {
      return latest;
    }
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for security managed download search evidence. Latest: ${JSON.stringify(summarizeTurn(latest ?? {}), null, 2)}`);
}

async function assertSecurityEvidence(turn, scratchInput) {
  const markerCreated = existsSync(scratchInput.healthMarkerPath);
  const searchText = turn.searchMessages.map((message) => String(message.content ?? "")).join("\n");
  const downloadText = turn.downloadMessages.map((message) => String(message.content ?? "")).join("\n");
  const toolText = [searchText, downloadText].join("\n");
  const assistantText = String(turn.assistantText ?? "");
  const runtimeActivityText = JSON.stringify(turn.live?.runtimeActivities ?? []);
  const toolEventText = JSON.stringify(turn.live?.toolEvents ?? []);
  const visibleNonUserText = [toolText, assistantText, runtimeActivityText, toolEventText].join("\n");
  const toolNames = turn.toolMessages.map((message) => String(message.metadata?.toolName ?? "unknown"));
  const forbiddenToolNames = toolNames.filter((toolName) => !allowedDogfoodToolNames.has(toolName));
  const downloadStartCount = toolNames.filter((toolName) => toolName === "ambient_download_start").length;
  const downloadWaitCount = toolNames.filter((toolName) => toolName === "ambient_download_wait").length;
  const managedInstallRejected =
    /Managed-install downloads require a trusted sha256 checksum|managed-install downloads require a trusted sha256/i.test(visibleNonUserText);
  const searchHealthNotRun = /health not run|health:\s*unknown/i.test(searchText);
  const quarantineCompleted = /Ambient managed download completed/i.test(downloadText);
  const quarantineDestination = /\.ambient\/download-quarantine\/unsigned-fixture\.txt/i.test(downloadText);
  const quarantineUnverified = /Integrity:\s*unverified/i.test(downloadText) || /"integrityStatus"\s*:\s*"unverified"/i.test(visibleNonUserText);
  const failures = [];

  if (markerCreated) failures.push(`ambient_cli_search executed descriptor health check marker at ${scratchInput.healthMarkerPath}`);
  if (forbiddenToolNames.length) failures.push(`forbidden tool calls were used: ${forbiddenToolNames.join(", ")}`);
  if (turn.searchMessages.length < 1) failures.push("ambient_cli_search was not called");
  if (downloadStartCount < 2) failures.push(`expected at least two ambient_download_start tool messages, saw ${downloadStartCount}`);
  if (downloadWaitCount < 1) failures.push(`expected at least one ambient_download_wait tool message, saw ${downloadWaitCount}`);
  if (!assistantText.includes("SECURITY_MANAGED_DOWNLOAD_SEARCH_OK")) failures.push("assistant did not emit SECURITY_MANAGED_DOWNLOAD_SEARCH_OK");
  if (!managedInstallRejected) failures.push("managed-install download without sha256 was not rejected visibly");
  if (!searchHealthNotRun) failures.push("ambient_cli_search did not report that health was not run");
  if (!quarantineCompleted) failures.push("quarantine managed download did not complete");
  if (!quarantineDestination) failures.push("quarantine download destination was not the explicit quarantine root");
  if (!quarantineUnverified) failures.push("quarantine download did not report unverified integrity");

  if (failures.length) {
    throw new Error(`Security managed download search dogfood failed:\n- ${failures.join("\n- ")}\n\nTool text:\n${toolText.slice(-4000)}\n\nAssistant:\n${assistantText.slice(-2000)}`);
  }
  return {
    markerPath: scratchInput.healthMarkerPath,
    markerCreated,
    toolNames,
    forbiddenToolNames,
    searchToolMessageCount: turn.searchMessages.length,
    downloadToolMessageCount: turn.downloadMessages.length,
    managedInstallRejected,
    searchHealthNotRun,
    quarantineCompleted,
    quarantineDestination,
    quarantineUnverified,
  };
}

async function installLiveCollector(cdpClient) {
  await evaluate(cdpClient, () => {
    window.__ambientSecurityManagedDownloadDogfood?.unsubscribe?.();
    window.__ambientSecurityManagedDownloadDogfood = {
      runtimeActivities: [],
      toolEvents: [],
      assistantTail: "",
      sendResolved: true,
      error: undefined,
    };
    window.__ambientSecurityManagedDownloadDogfood.unsubscribe = window.ambientDesktop.onEvent((event) => {
      const live = window.__ambientSecurityManagedDownloadDogfood;
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
    const live = window.__ambientSecurityManagedDownloadDogfood;
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
    const live = window.__ambientSecurityManagedDownloadDogfood;
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
  const searchMessages = turn.searchMessages ?? [];
  const downloadMessages = turn.downloadMessages ?? [];
  const toolMessages = turn.toolMessages ?? [];
  return {
    threadId: turn.threadId,
    assistantChars: String(turn.assistantText ?? "").length,
    assistantHasMarker: String(turn.assistantText ?? "").includes("SECURITY_MANAGED_DOWNLOAD_SEARCH_OK"),
    searchToolMessageCount: searchMessages.length,
    downloadToolMessageCount: downloadMessages.length,
    toolNames: toolMessages.map((message) => message.metadata?.toolName ?? "unknown"),
    messageCount: turn.messages?.length ?? 0,
    runtimeActivities: turn.live?.runtimeActivities?.slice(-8) ?? [],
    toolEvents: turn.live?.toolEvents?.slice(-8) ?? [],
  };
}

async function captureAgentBrowserEvidence(cdpClient, label) {
  const session = `security-managed-download-search-${process.pid}`;
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

function agentBrowserAvailable() {
  const result = spawnSync("agent-browser", ["--help"], {
    cwd: repoRoot,
    stdio: "ignore",
    env: cleanChildEnv(process.env),
  });
  return result.status === 0;
}

function launchDesktop(input) {
  return spawn(
    "pnpm",
    ["exec", "electron-vite", "dev", "--", `--remote-debugging-port=${dogfoodCdpPort()}`],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: buildDogfoodEnv({
        extra: {
          AMBIENT_E2E: "1",
          AMBIENT_DESKTOP_WORKSPACE: input.workspacePath,
          AMBIENT_E2E_USER_DATA: input.userDataPath,
          AMBIENT_EGRESS_ALLOW_LOCAL_HTTP: "1",
        },
      }),
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

async function createScratch() {
  const root = await mkdtemp(join(tmpdir(), "ambient-security-managed-download-"));
  const workspacePath = resolve(join(root, "workspace"));
  const userDataPath = resolve(join(root, "userData"));
  const healthMarkerPath = resolve(join(root, "ambient-cli-search-health-executed"));
  await mkdir(workspacePath, { recursive: true });
  await mkdir(userDataPath, { recursive: true });
  await writeFile(join(workspacePath, "README.md"), "# Security Managed Download Search Dogfood\n", "utf8");
  return { root, workspacePath, userDataPath, healthMarkerPath };
}

async function seedAmbientCliSearchFixture(workspacePath, healthMarkerPath) {
  const packageRoot = join(workspacePath, ".ambient", "cli-packages", "imported", "search-health-marker");
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await mkdir(join(packageRoot, "skills"), { recursive: true });
  await writeFile(
    join(workspacePath, ".ambient", "cli-packages", "packages.json"),
    `${JSON.stringify({ packages: [{ source: "./.ambient/cli-packages/imported/search-health-marker" }] }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(packageRoot, "ambient-cli.json"),
    `${JSON.stringify(
      {
        name: "search-health-marker",
        version: "0.1.0",
        description: "Search fixture whose health check must not execute during ambient_cli_search.",
        skills: "./skills",
        commands: {
          marker: {
            command: "node",
            args: ["./bin/marker.mjs"],
            cwd: "package",
            description: "Search health marker command.",
            healthCheck: ["node", "./bin/health-marker.mjs"],
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(join(packageRoot, "bin", "marker.mjs"), "process.stdout.write('marker command should not run during search');\n", "utf8");
  await writeFile(
    join(packageRoot, "bin", "health-marker.mjs"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(healthMarkerPath)}, "health executed");\nprocess.stdout.write("healthy");\n`,
    "utf8",
  );
  await writeFile(
    join(packageRoot, "skills", "SKILL.md"),
    "---\nname: search-health-marker\ndescription: Search health marker fixture.\n---\n\nUse ambient_cli only after approval.\n",
    "utf8",
  );
}

async function startFixtureServer(bytes) {
  const server = createServer((request, response) => {
    if (request.url !== "/unsigned-fixture.txt") {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "content-type": "text/plain",
      "content-length": String(bytes.length),
    });
    response.end(bytes);
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind a TCP port.");
  return {
    url: `http://127.0.0.1:${address.port}/unsigned-fixture.txt`,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
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

async function run(command, commandArgs, env) {
  const child = spawn(command, commandArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    env,
  });
  const [code, signal] = await once(child, "exit");
  if (code !== 0) throw new Error(`${command} ${commandArgs.join(" ")} failed with ${signal ?? code}.`);
}

async function runCaptured(command, commandArgs, timeoutMs) {
  const child = spawn(command, commandArgs, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: cleanChildEnv(process.env),
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const timeout = delay(timeoutMs).then(() => "timeout");
  const exit = once(child, "exit").then(([code, signal]) => ({ code, signal }));
  const result = await Promise.race([timeout, exit]);
  if (result === "timeout") {
    child.kill("SIGTERM");
    throw new Error(`${command} ${commandArgs.join(" ")} timed out after ${timeoutMs}ms.\n${stderr}`);
  }
  if (result.code !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed with ${result.signal ?? result.code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  return { stdout, stderr };
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
  return cleanChildEnv({
    ...process.env,
    ...(input.extra ?? {}),
    ...keyFileEnv,
    AMBIENT_PROVIDER: providerId,
    ...(providerId === "gmi-cloud" ? { GMI_CLOUD_MODEL: modelId } : { AMBIENT_LIVE_MODEL: modelId }),
  });
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
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 19790;
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
