#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repoRoot = process.cwd();
const resultsDir = join(repoRoot, "test-results", "model-reasoning-modes");
const latestReportPath = join(resultsDir, "latest.json");
const evidencePath = join(resultsDir, "payload-shapes.jsonl");
const defaultProvider = "ambient";
const kimiModel = "example/model-id";
const glmModel = process.env.AMBIENT_MODEL_REASONING_GLM_MODEL || "z-ai/glm-5.2";
const appWaitTimeoutMs = 90_000;
const chatTurnTimeoutMs = Number(process.env.AMBIENT_MODEL_REASONING_DOGFOOD_CHAT_TIMEOUT_MS ?? 240_000);
const cdpCommandTimeoutMs = 20_000;

const startedAt = new Date().toISOString();
let app;
let cdp;
let scratch;
let report;

try {
  await rm(latestReportPath, { force: true });
  await rm(evidencePath, { force: true });
  await mkdir(resultsDir, { recursive: true });
  await run("pnpm", ["run", "prepare:electron-native"], buildDogfoodEnv());

  scratch = await createScratch();
  app = launchDesktop({
    workspacePath: scratch.workspacePath,
    userDataPath: scratch.userDataPath,
    evidencePath,
  });
  cdp = await connectToElectron(dogfoodCdpPort(), app);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await setViewport(cdp, 1500, 950);
  await waitForText(cdp, "Ambient", appWaitTimeoutMs);
  await installLiveCollector(cdp);

  const kimiThreadId = await createThread(cdp, {
    title: "Model reasoning Kimi fixed",
    model: kimiModel,
    thinkingLevel: "xhigh",
  });
  const kimiUi = await readReasoningControl(cdp, "Reasoning mode: Reasoning on");
  const kimiTurn = await runChatTurn(cdp, {
    threadId: kimiThreadId,
    model: kimiModel,
    thinkingLevel: "xhigh",
    content: "Reply exactly KIMI_REASONING_MODE_OK.",
    expected: "KIMI_REASONING_MODE_OK",
  });

  const standardThreadId = await createThread(cdp, {
    title: "Model reasoning GLM Standard",
    model: glmModel,
    thinkingLevel: "medium",
  });
  const standardUi = await readReasoningControl(cdp, "Reasoning mode: Standard");
  const standardTurn = await runChatTurn(cdp, {
    threadId: standardThreadId,
    model: glmModel,
    thinkingLevel: "medium",
    content: "Reply exactly GLM_STANDARD_REASONING_MODE_OK.",
    expected: "GLM_STANDARD_REASONING_MODE_OK",
  });

  const deepThreadId = await createThread(cdp, {
    title: "Model reasoning GLM Deep",
    model: glmModel,
    thinkingLevel: "xhigh",
  });
  const deepUi = await readReasoningControl(cdp, "Reasoning mode: Deep");
  const deepTurn = await runChatTurn(cdp, {
    threadId: deepThreadId,
    model: glmModel,
    thinkingLevel: "xhigh",
    content: "Reply exactly GLM_DEEP_REASONING_MODE_OK.",
    expected: "GLM_DEEP_REASONING_MODE_OK",
  });

  const evidence = await readPayloadEvidence(evidencePath);
  const evidenceChecks = assertPayloadEvidence(evidence);
  report = {
    scenario: "model-reasoning-modes",
    startedAt,
    status: "passed",
    provider: {
      providerId: dogfoodProviderId(),
      defaultModel: dogfoodModelId(),
      testedModels: [kimiModel, glmModel],
      ambientKeyConfigured: ambientKeyConfigured(),
    },
    ui: {
      kimi: kimiUi,
      glmStandard: standardUi,
      glmDeep: deepUi,
    },
    turns: {
      kimi: summarizeTurn(kimiTurn),
      glmStandard: summarizeTurn(standardTurn),
      glmDeep: summarizeTurn(deepTurn),
    },
    evidence: evidenceChecks,
    artifacts: {
      payloadEvidence: outputPathRelative(evidencePath),
    },
  };
  await writeReport(report);
  console.log(`Model reasoning modes dogfood passed. Results: ${outputPathRelative(latestReportPath)}`);
} catch (error) {
  const failure = error instanceof Error ? error : new Error(String(error));
  report = {
    scenario: "model-reasoning-modes",
    startedAt,
    status: "failed",
    error: failure.message,
    stack: failure.stack,
    artifacts: {
      payloadEvidence: existsSync(evidencePath) ? outputPathRelative(evidencePath) : undefined,
    },
  };
  await writeReport(report).catch(() => undefined);
  console.error(failure.stack ?? failure.message);
  process.exitCode = 1;
} finally {
  cdp?.close?.();
  await terminateProcessTree(app);
  if (scratch && process.env.AMBIENT_MODEL_REASONING_DOGFOOD_KEEP_SCRATCH !== "1") {
    await rm(scratch.root, { recursive: true, force: true }).catch(() => undefined);
  } else if (scratch) {
    console.error(`Keeping model reasoning dogfood scratch: ${scratch.root}`);
  }
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
    const live = window.__ambientModelReasoningDogfood;
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
  const { live, messages, assistantText } = await waitForExpectedAssistant(cdpClient, input, chatTurnTimeoutMs);
  return {
    threadId: input.threadId,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    assistantText,
    thinkingChars: messages
      .filter((message) => message.role === "assistant" && message.metadata?.kind === "thinking")
      .reduce((sum, message) => sum + String(message.content ?? "").length, 0),
    runtimeThinkingChars: Math.max(0, ...((live?.runtimeActivities ?? []).map((activity) => Number(activity.thinkingChars) || 0))),
    statuses: live?.statuses ?? [],
  };
}

async function waitForExpectedAssistant(cdpClient, input, maxMs) {
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
    if (lastAssistantText.includes(input.expected)) {
      return { live: lastLive, messages: lastMessages, assistantText: lastAssistantText };
    }
    await delay(1_000);
  }
  throw new Error(`Expected ${input.expected} in assistant output for ${input.threadId}; saw ${lastAssistantText.slice(-1000)} collector=${JSON.stringify(lastLive)}`);
}

async function readReasoningControl(cdpClient, expectedAriaLabel) {
  await waitFor(
    cdpClient,
    (label) => Boolean(document.querySelector(`.composer-settings-controls [aria-label="${label}"]`)),
    appWaitTimeoutMs,
    expectedAriaLabel,
  );
  return evaluate(cdpClient, () => {
    const control = document.querySelector('.composer-settings-controls [aria-label^="Reasoning mode"]');
    const select = control?.querySelector?.("select") ?? (control?.matches?.("select") ? control : undefined);
    return {
      ariaLabel: control?.getAttribute("aria-label"),
      text: control?.textContent?.replace(/\s+/g, " ").trim(),
      hasSelect: Boolean(select),
      options: select ? [...select.querySelectorAll("option")].map((option) => ({ value: option.value, label: option.textContent })) : [],
    };
  });
}

async function readPayloadEvidence(path) {
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assertPayloadEvidence(entries) {
  const kimi = entries.find((entry) => entry.modelId === kimiModel && entry.strategy === "omit-reasoning-controls");
  if (!kimi) throw new Error("Missing Kimi omit-reasoning-controls payload evidence.");
  for (const field of ["enable_thinking", "reasoning_effort", "thinking", "reasoning"]) {
    if (kimi.fieldPresence?.[field]) throw new Error(`Kimi payload unexpectedly retained ${field}.`);
  }
  const standard = entries.find((entry) => entry.modelId === glmModel && entry.requestedThinkingLevel === "medium" && entry.reasoningEffort === "high");
  if (!standard) throw new Error("Missing GLM Standard payload evidence with reasoning_effort=high.");
  const deep = entries.find((entry) => entry.modelId === glmModel && entry.requestedThinkingLevel === "xhigh" && entry.reasoningEffort === "max");
  if (!deep) throw new Error("Missing GLM Deep payload evidence with reasoning_effort=max.");
  if (!standard.fieldPresence?.enable_thinking || !standard.fieldPresence?.reasoning_effort) {
    throw new Error("GLM Standard evidence did not include required reasoning request fields.");
  }
  if (!deep.fieldPresence?.enable_thinking || !deep.fieldPresence?.reasoning_effort) {
    throw new Error("GLM Deep evidence did not include required reasoning request fields.");
  }
  return {
    totalEntries: entries.length,
    kimi: {
      strategy: kimi.strategy,
      fieldPresence: kimi.fieldPresence,
      resolvedThinkingLevel: kimi.resolvedThinkingLevel,
    },
    glmStandard: {
      strategy: standard.strategy,
      requestedThinkingLevel: standard.requestedThinkingLevel,
      resolvedThinkingLevel: standard.resolvedThinkingLevel,
      reasoningEffort: standard.reasoningEffort,
      fieldPresence: standard.fieldPresence,
    },
    glmDeep: {
      strategy: deep.strategy,
      requestedThinkingLevel: deep.requestedThinkingLevel,
      resolvedThinkingLevel: deep.resolvedThinkingLevel,
      reasoningEffort: deep.reasoningEffort,
      fieldPresence: deep.fieldPresence,
    },
  };
}

async function installLiveCollector(cdpClient) {
  await evaluate(cdpClient, () => {
    window.__ambientModelReasoningDogfood?.unsubscribe?.();
    window.__ambientModelReasoningDogfood = {
      statuses: [],
      runtimeActivities: [],
      assistantTail: "",
      sawRunStart: false,
      sawRunIdle: false,
      lastStatusAtMs: 0,
      sendResolved: true,
      error: undefined,
    };
    window.__ambientModelReasoningDogfood.unsubscribe = window.ambientDesktop.onEvent((event) => {
      const live = window.__ambientModelReasoningDogfood;
      if (event.type === "run-status") {
        live.lastStatusAtMs = Date.now();
        live.statuses.push(event.status);
        if (event.status !== "idle") live.sawRunStart = true;
        if (live.sawRunStart && event.status === "idle") live.sawRunIdle = true;
      }
      if (event.type === "runtime-activity") {
        live.runtimeActivities.push({
          kind: event.activity?.kind,
          status: event.activity?.status,
          message: event.activity?.message,
          outputChars: event.activity?.outputChars,
          thinkingChars: event.activity?.thinkingChars,
        });
        live.runtimeActivities = live.runtimeActivities.slice(-50);
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
    const live = window.__ambientModelReasoningDogfood;
    if (!live) return false;
    live.statuses = [];
    live.runtimeActivities = [];
    live.assistantTail = "";
    live.sawRunStart = false;
    live.sawRunIdle = false;
    live.lastStatusAtMs = 0;
    live.sendResolved = false;
    live.error = undefined;
    return true;
  });
}

async function getLiveState(cdpClient) {
  return evaluate(cdpClient, () => {
    const live = window.__ambientModelReasoningDogfood;
    return live
      ? {
          statuses: live.statuses,
          runtimeActivities: live.runtimeActivities,
          assistantTail: live.assistantTail,
          sawRunStart: live.sawRunStart,
          sawRunIdle: live.sawRunIdle,
          lastStatusAtMs: live.lastStatusAtMs,
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
    thinkingChars: turn.thinkingChars,
    runtimeThinkingChars: turn.runtimeThinkingChars,
    statuses: turn.statuses.slice(-8),
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
        AMBIENT_E2E: "1",
        AMBIENT_DESKTOP_WORKSPACE: input.workspacePath,
        AMBIENT_E2E_USER_DATA: input.userDataPath,
        AMBIENT_MODEL_REASONING_EVIDENCE_PATH: input.evidencePath,
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
  const root = await mkdtemp(join(tmpdir(), "ambient-model-reasoning-"));
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
}

async function waitForAppExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const timeout = delay(timeoutMs).then(() => false);
  const exited = new Promise((resolveExit) => child.once("exit", () => resolveExit(true)));
  return Promise.race([timeout, exited]);
}

function buildDogfoodEnv(extra = {}) {
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
    ...extra,
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
    ? process.env.GMI_CLOUD_MODEL || process.env.AMBIENT_MODEL || kimiModel
    : process.env.AMBIENT_LIVE_MODEL || process.env.AMBIENT_MODEL || kimiModel;
}

function dogfoodCdpPort() {
  const parsed = Number(process.env.AMBIENT_HARNESS_CDP_PORT || process.env.AMBIENT_SUBAGENT_DESKTOP_DOGFOOD_CDP_PORT);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 19789;
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
