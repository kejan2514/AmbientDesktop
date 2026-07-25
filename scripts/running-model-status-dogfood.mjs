#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repoRoot = process.cwd();
const resultsDir = join(repoRoot, "test-results", "running-model-status");
const latestReportPath = join(resultsDir, "latest.json");
const defaultProvider = "ambient";
const kimiModel = "example/model-id";
const kimi26Model = "moonshotai/kimi-k2.6";
const glm52Model = "z-ai/glm-5.2";
const schemaVersion = "ambient-running-model-status-v1";
const toolName = "ambient_model_status";
const appWaitTimeoutMs = 90_000;
const chatTurnTimeoutMs = Number(process.env.AMBIENT_RUNNING_MODEL_STATUS_DOGFOOD_CHAT_TIMEOUT_MS ?? 240_000);
const cdpCommandTimeoutMs = 20_000;

const args = parseArgs(process.argv.slice(2));
const expectedModel = normalizeModelId(args.expectedModel ?? dogfoodModelId());
const requestedModel = args.requestedModel ?? expectedModel;
const expected = expectedModelContract(expectedModel, requestedModel);
const startedAt = new Date().toISOString();

let app;
let cdp;
let scratch;
let report;
let cachedAgentBrowserAvailable;

try {
  await rm(latestReportPath, { force: true });
  await mkdir(resultsDir, { recursive: true });
  await run("pnpm", ["run", "prepare:electron-native"], buildDogfoodEnv({ modelId: expectedModel }));

  scratch = await createScratch();
  app = launchDesktop({
    workspacePath: scratch.workspacePath,
    userDataPath: scratch.userDataPath,
    modelId: expectedModel,
  });
  cdp = await connectToElectron(dogfoodCdpPort(), app);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await setViewport(cdp, 1500, 950);
  await waitForText(cdp, "Ambient", appWaitTimeoutMs);
  await installLiveCollector(cdp);

  const threadId = await createThread(cdp, {
    title: `Running model status ${expected.shortName}`,
    model: requestedModel,
    thinkingLevel: expected.thinkingLevel,
  });
  const initialBrowserEvidence = await captureAgentBrowserEvidence(cdp, "before-turn");
  const turn = await runChatTurn(cdp, {
    threadId,
    model: requestedModel,
    thinkingLevel: expected.thinkingLevel,
    content: modelStatusPrompt(),
    expectedMarker: "RUNNING_MODEL_STATUS_OK",
  });
  const transcript = await readTranscriptEvidence(cdp, threadId);
  const proof = assertRunningModelStatusEvidence({
    expected,
    turn,
    transcript,
  });
  const finalBrowserEvidence = await captureAgentBrowserEvidence(cdp, "after-turn");

  report = {
    scenario: "running-model-status",
    startedAt,
    status: "passed",
    provider: {
      providerId: dogfoodProviderId(),
      expectedModel,
      requestedModel,
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
  console.log(`Running model status dogfood passed. Results: ${outputPathRelative(latestReportPath)}`);
} catch (error) {
  const failure = error instanceof Error ? error : new Error(String(error));
  report = {
    scenario: "running-model-status",
    startedAt,
    status: "failed",
    expectedModel,
    requestedModel,
    error: failure.message,
    stack: failure.stack,
  };
  await writeReport(report).catch(() => undefined);
  console.error(failure.stack ?? failure.message);
  process.exitCode = 1;
} finally {
  cdp?.close?.();
  await terminateProcessTree(app);
  if (scratch && process.env.AMBIENT_RUNNING_MODEL_STATUS_DOGFOOD_KEEP_SCRATCH !== "1") {
    await rm(scratch.root, { recursive: true, force: true }).catch(() => undefined);
  } else if (scratch) {
    console.error(`Keeping running model status dogfood scratch: ${scratch.root}`);
  }
}

function parseArgs(argv) {
  const parsed = {
    expectedModel: undefined,
    requestedModel: undefined,
  };
  for (const arg of argv) {
    if (arg.startsWith("--expected-model=")) parsed.expectedModel = arg.slice("--expected-model=".length);
    else if (arg.startsWith("--requested-model=")) parsed.requestedModel = arg.slice("--requested-model=".length);
    else throw new Error(`Unknown running model status dogfood argument: ${arg}`);
  }
  return parsed;
}

function modelStatusPrompt() {
  return [
    `Your next action must be a tool call to ${toolName} with JSON input {"purpose":"running-model-status-dogfood"}.`,
    "Do not write words before the tool call.",
    "After the tool returns, reply exactly RUNNING_MODEL_STATUS_OK.",
  ].join("\n");
}

async function createThread(cdpClient, input) {
  const threadId = await evaluate(cdpClient, async (threadInput) => {
    const next = await window.ambientDesktop.createThread({
      permissionMode: "full-access",
      collaborationMode: "agent",
      model: threadInput.model,
      thinkingLevel: threadInput.thinkingLevel,
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
        thinkingLevel: threadInput.thinkingLevel,
      });
    }
    await window.ambientDesktop.selectThread(id);
    return id;
  }, input);
  if (!threadId) throw new Error(`createThread did not return an active thread id for ${input.title}.`);
  await reloadRendererForThread(cdpClient, threadId);
  return threadId;
}

async function reloadRendererForThread(cdpClient, threadId) {
  await cdpClient.send("Page.reload", { ignoreCache: true }, { timeoutMs: 30_000 });
  await waitForText(cdpClient, "Ambient", appWaitTimeoutMs);
  await evaluate(cdpClient, async (id) => {
    await window.ambientDesktop.selectThread(id);
    return window.ambientDesktop.bootstrap();
  }, threadId);
  await installLiveCollector(cdpClient);
}

async function runChatTurn(cdpClient, input) {
  await resetLiveCollector(cdpClient);
  await evaluate(cdpClient, async (turn) => {
    const live = window.__ambientRunningModelStatusDogfood;
    await window.ambientDesktop.selectThread(turn.threadId);
    window.ambientDesktop.sendMessage({
      threadId: turn.threadId,
      content: turn.content,
      permissionMode: "full-access",
      collaborationMode: "agent",
      model: turn.model,
      thinkingLevel: turn.thinkingLevel,
    })
      .then(() => {
        live.sendResolved = true;
      })
      .catch((error) => {
        live.error = error instanceof Error ? error.message : String(error);
      });
    return true;
  }, input);
  const { live, messages, assistantText } = await waitForModelStatusToolEvidence(cdpClient, input, chatTurnTimeoutMs);
  return {
    threadId: input.threadId,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    assistantText,
    statuses: live?.statuses ?? [],
    toolEvents: live?.toolEvents ?? [],
    runtimeActivities: live?.runtimeActivities ?? [],
    messageCount: messages.length,
  };
}

async function waitForModelStatusToolEvidence(cdpClient, input, maxMs) {
  const deadline = Date.now() + maxMs;
  let lastAssistantText = "";
  let lastLive;
  let lastMessages = [];
  while (Date.now() < deadline) {
    lastLive = await getLiveState(cdpClient);
    if (lastLive?.error) throw new Error(lastLive.error);
    const state = await evaluate(cdpClient, async (threadId) => {
      await window.ambientDesktop.selectThread(threadId);
      return window.ambientDesktop.bootstrap();
    }, input.threadId);
    lastMessages = (state.messages ?? []).filter((message) => message.threadId === input.threadId);
    lastAssistantText = lastMessages
      .filter((message) => message.role === "assistant" && message.metadata?.kind !== "thinking")
      .map((message) => message.content)
      .join("\n");
    const hasCompletedModelStatus = lastMessages.some((message) =>
      message.role === "tool" &&
      message.metadata?.toolName === toolName &&
      message.metadata?.status === "done" &&
      modelStatusPayloadFromToolMessage(message)?.schemaVersion === schemaVersion
    );
    if (hasCompletedModelStatus && lastAssistantText.includes(input.expectedMarker)) {
      return { live: lastLive, messages: lastMessages, assistantText: lastAssistantText };
    }
    await delay(1_000);
  }
  throw new Error(`Expected completed ${toolName} transcript evidence for ${input.threadId}; assistant tail=${lastAssistantText.slice(-1000)} collector=${JSON.stringify(lastLive)}`);
}

async function readTranscriptEvidence(cdpClient, threadId) {
  return evaluate(cdpClient, async (id) => {
    await window.ambientDesktop.selectThread(id);
    const state = await window.ambientDesktop.bootstrap();
    const messages = (state.messages ?? []).filter((message) => message.threadId === id);
    return messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      metadata: message.metadata,
    }));
  }, threadId);
}

function assertRunningModelStatusEvidence(input) {
  const { expected, turn, transcript } = input;
  const assistantText = turn.assistantText;
  if (!assistantText.includes("RUNNING_MODEL_STATUS_OK")) {
    throw new Error(`Assistant output missing RUNNING_MODEL_STATUS_OK. Output tail: ${assistantText.slice(-2000)}`);
  }

  const toolMessages = transcript.filter((message) => message.role === "tool" && message.metadata?.toolName === toolName);
  const completedToolMessages = toolMessages.filter((message) => message.metadata?.status === "done");
  if (!completedToolMessages.length) {
    throw new Error(`Transcript did not contain a completed ${toolName} tool message. Tool messages: ${JSON.stringify(toolMessages)}`);
  }
  const statusPayload = completedToolMessages
    .map((message) => modelStatusPayloadFromToolMessage(message))
    .find((payload) => payload?.schemaVersion === schemaVersion);
  if (!statusPayload) {
    throw new Error(`Completed ${toolName} messages did not include a parseable ${schemaVersion} JSON payload.`);
  }
  assertEqualStatusField(statusPayload.selected?.effectiveModelId, expected.effectiveModelId, "selected.effectiveModelId");
  assertEqualStatusField(statusPayload.running?.modelId, expected.effectiveModelId, "running.modelId");
  assertEqualStatusField(statusPayload.running?.matchesSelected, true, "running.matchesSelected");
  assertEqualStatusField(statusPayload.provider?.secretStatus, "available", "provider.secretStatus");
  assertEqualStatusField(statusPayload.reasoning?.control, expected.reasoningControl, "reasoning.control");
  assertEqualStatusField(statusPayload.reasoning?.current?.requestedThinkingLevel, expected.thinkingLevel, "reasoning.current.requestedThinkingLevel");
  assertEqualStatusField(statusPayload.reasoning?.current?.effectiveThinkingLevel, expected.effectiveThinkingLevel, "reasoning.current.effectiveThinkingLevel");
  assertEqualStatusField(statusPayload.reasoning?.current?.label, expected.reasoningLabel, "reasoning.current.label");
  if (expected.providerEffort) {
    assertEqualStatusField(statusPayload.reasoning?.current?.providerEffort, expected.providerEffort, "reasoning.current.providerEffort");
  }
  assertPayloadStrategyStatusField(statusPayload.reasoning?.payloadStrategy, expected.payloadStrategy);
  if (expected.payloadStrategy === "zai-reasoning-effort") {
    assertArrayIncludes(statusPayload.reasoning?.requestFields, "enable_thinking", "reasoning.requestFields");
    assertArrayIncludes(statusPayload.reasoning?.requestFields, "reasoning_effort", "reasoning.requestFields");
  }
  const serializedTool = JSON.stringify(completedToolMessages);
  for (const required of [
    schemaVersion,
    expected.effectiveModelId,
    expected.label,
    expected.reasoningControl,
  ]) {
    if (!serializedTool.includes(required)) {
      throw new Error(`Completed ${toolName} transcript evidence missing ${required}. Evidence tail: ${serializedTool.slice(-3000)}`);
    }
  }
  if (serializedTool.includes("ambient_api_key") || serializedTool.includes("sk-test") || serializedTool.includes("api-key")) {
    throw new Error(`${toolName} transcript evidence exposed a secret-looking value.`);
  }

  const sawToolEvent = turn.toolEvents.some((event) =>
    event.label === toolName ||
    event.details?.toolName === toolName ||
    String(event.label ?? "").includes(toolName)
  );
  return {
    assistantMarkerPresent: assistantText.includes("RUNNING_MODEL_STATUS_OK"),
    completedToolMessageCount: completedToolMessages.length,
    toolMessageIds: completedToolMessages.map((message) => message.id),
    toolEventObserved: sawToolEvent,
    transcriptMessageCount: transcript.length,
    checkedFields: {
      effectiveModelId: expected.effectiveModelId,
      requestedModelId: expected.requestedModelId,
      reasoningControl: expected.reasoningControl,
      reasoningCurrent: {
        requestedThinkingLevel: expected.thinkingLevel,
        effectiveThinkingLevel: expected.effectiveThinkingLevel,
        label: expected.reasoningLabel,
        providerEffort: expected.providerEffort,
      },
      payloadStrategy: expected.payloadStrategy,
    },
  };
}

function modelStatusPayloadFromToolMessage(message) {
  const content = String(message.content ?? "");
  const match = content.match(/```json\s*([\s\S]*?)\s*```/);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]);
  } catch {
    return undefined;
  }
}

function assertEqualStatusField(actual, expected, path) {
  if (actual !== expected) {
    throw new Error(`Completed ${toolName} payload field ${path} was ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}.`);
  }
}

function assertPayloadStrategyStatusField(actual, expected) {
  if (actual === expected) return;
  if (expected === "zai-reasoning-effort" && actual === "[REDACTED]") return;
  throw new Error(`Completed ${toolName} payload field reasoning.payloadStrategy was ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}.`);
}

function assertArrayIncludes(actual, expected, path) {
  if (Array.isArray(actual) && actual.includes(expected)) return;
  throw new Error(`Completed ${toolName} payload field ${path} did not include ${JSON.stringify(expected)}; got ${JSON.stringify(actual)}.`);
}

async function captureAgentBrowserEvidence(cdpClient, label) {
  const session = `running-model-status-${process.pid}`;
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
  if (cachedAgentBrowserAvailable !== undefined) return cachedAgentBrowserAvailable;
  const result = spawnSync("agent-browser", ["--help"], {
    cwd: repoRoot,
    stdio: "ignore",
    env: cleanChildEnv(process.env),
  });
  cachedAgentBrowserAvailable = result.status === 0;
  return cachedAgentBrowserAvailable;
}

async function installLiveCollector(cdpClient) {
  await evaluate(cdpClient, () => {
    window.__ambientRunningModelStatusDogfood?.unsubscribe?.();
    window.__ambientRunningModelStatusDogfood = {
      statuses: [],
      runtimeActivities: [],
      toolEvents: [],
      assistantTail: "",
      sawRunStart: false,
      sawRunIdle: false,
      sendResolved: true,
      error: undefined,
    };
    window.__ambientRunningModelStatusDogfood.unsubscribe = window.ambientDesktop.onEvent((event) => {
      const live = window.__ambientRunningModelStatusDogfood;
      if (event.type === "run-status") {
        live.statuses.push(event.status);
        if (event.status !== "idle") live.sawRunStart = true;
        if (live.sawRunStart && event.status === "idle") live.sawRunIdle = true;
      }
      if (event.type === "runtime-activity") {
        live.runtimeActivities.push({
          kind: event.activity?.kind,
          status: event.activity?.status,
          message: event.activity?.message,
          toolName: event.activity?.toolName,
        });
        live.runtimeActivities = live.runtimeActivities.slice(-80);
      }
      if (event.type === "tool-event") {
        live.toolEvents.push({
          status: event.status,
          label: event.label,
          details: event.details,
        });
        live.toolEvents = live.toolEvents.slice(-80);
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
    const live = window.__ambientRunningModelStatusDogfood;
    if (!live) return false;
    live.statuses = [];
    live.runtimeActivities = [];
    live.toolEvents = [];
    live.assistantTail = "";
    live.sawRunStart = false;
    live.sawRunIdle = false;
    live.sendResolved = false;
    live.error = undefined;
    return true;
  });
}

async function getLiveState(cdpClient) {
  return evaluate(cdpClient, () => {
    const live = window.__ambientRunningModelStatusDogfood;
    return live
      ? {
          statuses: live.statuses,
          runtimeActivities: live.runtimeActivities,
          toolEvents: live.toolEvents,
          assistantTail: live.assistantTail,
          sawRunStart: live.sawRunStart,
          sawRunIdle: live.sawRunIdle,
          sendResolved: live.sendResolved,
          error: live.error,
        }
      : undefined;
  });
}

function summarizeTurn(turn) {
  return {
    threadId: turn.threadId,
    model: turn.model,
    thinkingLevel: turn.thinkingLevel,
    assistantChars: turn.assistantText.length,
    messageCount: turn.messageCount,
    statuses: turn.statuses.slice(-8),
    toolEvents: turn.toolEvents.slice(-8),
    runtimeActivities: turn.runtimeActivities.slice(-8),
  };
}

function launchDesktop(input) {
  return spawn(
    "pnpm",
    [
      "exec",
      "electron-vite",
      "dev",
      "--",
      `--remote-debugging-port=${dogfoodCdpPort()}`,
    ],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: buildDogfoodEnv({
        modelId: input.modelId,
        extra: {
          AMBIENT_E2E: "1",
          AMBIENT_DESKTOP_WORKSPACE: input.workspacePath,
          AMBIENT_E2E_USER_DATA: input.userDataPath,
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
              const timeout = setTimeout(() => {
                rejectReady(new Error(`Timed out waiting for CDP socket open after ${timeoutMs}ms.`));
              }, timeoutMs);
              socket.addEventListener(
                "open",
                () => {
                  clearTimeout(timeout);
                  resolveReady();
                },
                { once: true },
              );
              socket.addEventListener(
                "error",
                () => {
                  clearTimeout(timeout);
                  rejectReady(new Error("CDP socket failed to open."));
                },
                { once: true },
              );
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
  const root = await mkdtemp(join(tmpdir(), "ambient-running-model-status-"));
  const workspacePath = resolve(join(root, "workspace"));
  const userDataPath = resolve(join(root, "userData"));
  await mkdir(workspacePath, { recursive: true });
  await mkdir(userDataPath, { recursive: true });
  return { root, workspacePath, userDataPath };
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
  const modelId = input.modelId ?? dogfoodModelId(providerId);
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
  return normalizeModelId(
    providerId === "gmi-cloud"
      ? process.env.GMI_CLOUD_MODEL || process.env.AMBIENT_MODEL || kimiModel
      : process.env.AMBIENT_LIVE_MODEL || process.env.AMBIENT_MODEL || kimiModel,
  );
}

function dogfoodCdpPort() {
  const parsed = Number(process.env.AMBIENT_HARNESS_CDP_PORT || process.env.AMBIENT_SUBAGENT_DESKTOP_DOGFOOD_CDP_PORT);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 19790;
}

function normalizeModelId(modelId) {
  if (modelId === "glm-5.1" || modelId === "ambient/large" || modelId === "zai-org/GLM-5.1-FP8") return glm52Model;
  return modelId;
}

function expectedModelContract(modelId, requestedModelId) {
  const kimiLabel = kimiModelLabel(modelId);
  if (kimiLabel) {
    return {
      shortName: modelId === kimiModel ? "kimi" : "kimi26",
      label: kimiLabel,
      requestedModelId,
      effectiveModelId: modelId,
      thinkingLevel: "xhigh",
      effectiveThinkingLevel: "medium",
      reasoningLabel: "Reasoning on",
      reasoningControl: "fixed_on",
      payloadStrategy: "omit-reasoning-controls",
    };
  }
  if (modelId === glm52Model) {
    return {
      shortName: "glm52",
      label: "GLM 5.2",
      requestedModelId,
      effectiveModelId: glm52Model,
      thinkingLevel: "xhigh",
      effectiveThinkingLevel: "xhigh",
      reasoningLabel: "Deep",
      providerEffort: "max",
      reasoningControl: "selectable_effort",
      payloadStrategy: "zai-reasoning-effort",
    };
  }
  throw new Error(`running-model-status dogfood only has contracts for ${kimiModel}, ${kimi26Model}, and ${glm52Model}; got ${modelId}`);
}

function kimiModelLabel(modelId) {
  if (modelId === kimiModel) return "Kimi K2.7 Code";
  if (modelId === kimi26Model) return "Kimi K2.6";
  return undefined;
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
