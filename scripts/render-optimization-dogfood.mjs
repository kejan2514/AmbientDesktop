#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  HEAVY_RENDER_FIXTURE,
  RENDER_OPTIMIZATION_SCHEMA_VERSION,
  buildRenderOptimizationFixtureMessages,
  evaluateRenderOptimizationGate,
  fixtureStaticHotspotEstimate,
} from "./render-optimization-fixture-lib.mjs";

const repoRoot = process.cwd();
const resultsDir = join(repoRoot, "test-results", "render-optimization");
const latestReportPath = join(resultsDir, "latest.json");
const defaultProvider = "ambient";
const defaultModel = "example/model-id";
const appWaitTimeoutMs = 90_000;
const cdpCommandTimeoutMs = 20_000;
const liveContinuationTimeoutMs = 180_000;
const liveContinuationToken = "RENDER_OPTIMIZATION_PHASE5_LIVE_DONE";
const args = parseArgs(process.argv.slice(2));
const startedAt = new Date().toISOString();

let app;
let cdp;
let scratch;
let report;

try {
  await rm(latestReportPath, { force: true });
  await mkdir(resultsDir, { recursive: true });
  const providerCredentialEnv = args.phase === "phase5" ? await readDogfoodProviderCredentialEnv() : {};
  if (args.phase === "phase5" && Object.keys(providerCredentialEnv).length === 0) {
    throw new Error(
      `Phase 5 live continuation requires credentials for ${dogfoodProviderId()}: ${dogfoodProviderCredentialHelp()}.`,
    );
  }
  await run("pnpm", ["run", "prepare:electron-native"], buildDogfoodEnv({}));

  scratch = await createScratch();
  app = launchDesktop(scratch, providerCredentialEnv);
  cdp = await connectToElectron(dogfoodCdpPort(), app);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await setViewport(cdp, 1500, 950);
  await waitForText(cdp, "Ambient", appWaitTimeoutMs);

  const threadId = await createFixtureThread(cdp);
  const messages = buildRenderOptimizationFixtureMessages({ threadId, startedAt });
  seedFixtureMessages(dogfoodStateDbPath(scratch), threadId, messages);
  await reloadRendererForThread(cdp, threadId);
  await waitForFixtureMessageCount(cdp, threadId, messages.length, appWaitTimeoutMs);

  const initial = await collectRenderMetrics(cdp, threadId, "initial");
  await scrollMessages(cdp, "middle");
  const middle = await collectRenderMetrics(cdp, threadId, "middle");
  await scrollMessages(cdp, "bottom");
  const bottom = await collectRenderMetrics(cdp, threadId, "bottom");
  const cdpLatency = await measureCdpLatency(cdp, 20);
  const liveContinuation = args.phase === "phase5" ? await runPhase5LiveContinuation(cdp, threadId) : undefined;
  const screenshotPath = await writeScreenshot(cdp, `render-optimization-${args.phase}.png`);

  const renderSamples = [initial, middle, bottom, liveContinuation?.postRunMetrics].filter(Boolean);
  const latencySamples = [cdpLatency, liveContinuation?.postRunCdpLatency].filter(Boolean);
  const metrics = {
    ...bottom,
    messageCount: bottom.messageCount,
    mountedDomNodes: maxMetric(renderSamples, "mountedDomNodes"),
    inlineUrlButtons: maxMetric(renderSamples, "inlineUrlButtons"),
    inlineArtifactButtons: maxMetric(renderSamples, "inlineArtifactButtons"),
    inlineLinkButtons: maxMetric(renderSamples, "inlineLinkButtons"),
    visibleMessageRows: maxMetric(renderSamples, "visibleMessageRows"),
    cdpLatencyP95Ms: maxMetric(latencySamples, "p95Ms"),
  };
  const gate = evaluateRenderOptimizationGate(metrics, { requireBudget: args.requireBudget });

  report = {
    schemaVersion: RENDER_OPTIMIZATION_SCHEMA_VERSION,
    scenario: "render-optimization",
    phase: args.phase,
    status: gate.status,
    classification: gate.status,
    startedAt,
    provider: {
      providerId: dogfoodProviderId(),
      model: dogfoodModelId(),
      budgetRequired: args.requireBudget,
    },
    fixture: {
      threadId,
      staticHotspotEstimate: fixtureStaticHotspotEstimate(messages),
    },
    measurements: {
      initial,
      middle,
      bottom,
      cdpLatency,
      aggregate: metrics,
      ...(liveContinuation ? { liveContinuation } : {}),
    },
    gate,
    artifacts: {
      latestReport: outputPathRelative(latestReportPath),
      screenshot: outputPathRelative(screenshotPath),
    },
  };
  await writeReport(report);
  if (gate.status !== "passed") throw new Error(`Render optimization dogfood failed:\n- ${gate.failures.join("\n- ")}`);
  console.log(`Render optimization dogfood passed. Results: ${outputPathRelative(latestReportPath)}`);
} catch (error) {
  const failure = error instanceof Error ? error : new Error(String(error));
  if (cdp) {
    try {
      await writeScreenshot(cdp, `render-optimization-${args.phase}-failure.png`);
    } catch {
      // Preserve original failure.
    }
  }
  report = {
    ...(report ?? {
      schemaVersion: RENDER_OPTIMIZATION_SCHEMA_VERSION,
      scenario: "render-optimization",
      phase: args.phase,
    }),
    status: "failed",
    classification: "failed",
    error: failure.message,
    stack: failure.stack,
  };
  await writeReport(report).catch(() => undefined);
  console.error(failure.stack ?? failure.message);
  process.exitCode = 1;
} finally {
  cdp?.close?.();
  await terminateProcessTree(app);
  try {
    await run("pnpm", ["run", "prepare:node-native"], buildDogfoodEnv({}));
  } catch (error) {
    process.exitCode = 1;
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
  if (scratch && process.env.AMBIENT_RENDER_OPTIMIZATION_KEEP_SCRATCH !== "1") {
    await rm(scratch.root, { recursive: true, force: true }).catch(() => undefined);
  } else if (scratch) {
    console.error(`Keeping render optimization dogfood scratch: ${scratch.root}`);
  }
}

function parseArgs(argv) {
  const parsed = { phase: "phase0", requireBudget: false };
  for (const arg of argv) {
    if (arg === "--require-budget") parsed.requireBudget = true;
    else if (arg.startsWith("--phase=")) parsed.phase = arg.slice("--phase=".length);
    else throw new Error(`Unknown render optimization dogfood argument: ${arg}`);
  }
  return parsed;
}

async function createScratch() {
  const root = await mkdtemp(join(tmpdir(), "ambient-render-optimization-"));
  const workspacePath = join(root, "workspace");
  const userDataPath = join(root, "userData");
  const authorityStateRoot = join(userDataPath, "authority-state");
  await mkdir(workspacePath, { recursive: true });
  await mkdir(authorityStateRoot, { recursive: true });
  await writeFile(join(workspacePath, "README.md"), "# Render Optimization Dogfood\n\nDisposable renderer performance fixture.\n", "utf8");
  return { root, workspacePath, userDataPath, authorityStateRoot };
}

function launchDesktop(input, providerCredentialEnv) {
  return spawn("pnpm", ["exec", "electron-vite", "dev", "--", `--remote-debugging-port=${dogfoodCdpPort()}`], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: buildDogfoodEnv({
      AMBIENT_E2E: "1",
      AMBIENT_DESKTOP_WORKSPACE: input.workspacePath,
      AMBIENT_E2E_USER_DATA: input.userDataPath,
      AMBIENT_AUTHORITY_STATE_ROOT: input.authorityStateRoot,
      AMBIENT_RENDER_OPTIMIZATION_DOGFOOD: "1",
      ...providerCredentialEnv,
    }),
  });
}

async function createFixtureThread(cdpClient) {
  const threadId = await evaluate(cdpClient, async (input) => {
    const next = await window.ambientDesktop.createThread({
      permissionMode: "workspace",
      collaborationMode: "agent",
      model: input.model,
      thinkingLevel: "low",
    });
    const id = next.activeThreadId;
    if (window.ambientDesktop.updateThread) {
      await window.ambientDesktop.updateThread({ threadId: id, title: input.title });
    }
    await window.ambientDesktop.selectThread(id);
    return id;
  }, { title: "Render optimization heavy transcript", model: dogfoodModelId() });
  if (!threadId) throw new Error("Could not create render optimization fixture thread.");
  return threadId;
}

async function createLiveContinuationThread(cdpClient) {
  const threadId = await evaluate(cdpClient, async (input) => {
    const next = await window.ambientDesktop.createThread({
      permissionMode: "workspace",
      collaborationMode: "agent",
      model: input.model,
      thinkingLevel: "minimal",
    });
    const id = next.activeThreadId;
    if (window.ambientDesktop.updateThread) {
      await window.ambientDesktop.updateThread({ threadId: id, title: input.title });
    }
    await window.ambientDesktop.selectThread(id);
    return id;
  }, { title: "Render optimization live provider gate", model: dogfoodModelId() });
  if (!threadId) throw new Error("Could not create Phase 5 live continuation thread.");
  return threadId;
}

async function reloadRendererForThread(cdpClient, threadId) {
  await cdpClient.send("Page.reload", { ignoreCache: true }, { timeoutMs: 30_000 });
  await waitForText(cdpClient, "Ambient", appWaitTimeoutMs);
  await evaluate(cdpClient, async (id) => {
    await window.ambientDesktop.selectThread(id);
    return window.ambientDesktop.bootstrap();
  }, threadId);
}

async function waitForFixtureMessageCount(cdpClient, threadId, expectedMessageCount, timeoutMs) {
  await waitFor(cdpClient, async (input) => {
    const state = await window.ambientDesktop.bootstrap();
    const messages = (state.messages ?? []).filter((message) => message.threadId === input.threadId);
    return messages.length === input.expectedMessageCount;
  }, timeoutMs, { threadId, expectedMessageCount });
}

async function waitForHeavyTranscriptMounted(cdpClient) {
  await waitFor(cdpClient, () => {
    const scroll = document.querySelector(".messages");
    if (!(scroll instanceof HTMLElement)) return false;
    return document.querySelectorAll(".messages .message").length > 0 && scroll.scrollHeight > scroll.clientHeight * 5;
  }, appWaitTimeoutMs);
}

function seedFixtureMessages(dbPath, threadId, messages) {
  if (!existsSync(dbPath)) throw new Error(`Render optimization state DB does not exist: ${dbPath}`);
  const statements = ["BEGIN IMMEDIATE;"];
  for (const message of messages) {
    statements.push(
      [
        "INSERT OR REPLACE INTO messages (id, thread_id, role, content, created_at, metadata_json) VALUES (",
        sqlLiteral(message.id), ", ",
        sqlLiteral(threadId), ", ",
        sqlLiteral(message.role), ", ",
        sqlLiteral(message.content), ", ",
        sqlLiteral(message.createdAt), ", ",
        message.metadata ? sqlLiteral(JSON.stringify(message.metadata)) : "NULL",
        ");",
      ].join(""),
    );
  }
  statements.push(
    [
      "UPDATE threads SET title = ",
      sqlLiteral("Render optimization heavy transcript"),
      ", updated_at = ",
      sqlLiteral(new Date().toISOString()),
      ", last_message_preview = ",
      sqlLiteral("Render optimization fixture seeded."),
      " WHERE id = ",
      sqlLiteral(threadId),
      ";",
    ].join(""),
  );
  statements.push("COMMIT;");
  const result = spawnSync("sqlite3", [dbPath], {
    cwd: repoRoot,
    input: statements.join("\n"),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`Failed to seed render optimization fixture DB: ${result.stderr || result.stdout}`);
  }
}

async function collectRenderMetrics(cdpClient, threadId, label) {
  return evaluate(cdpClient, async (input) => {
    const state = await window.ambientDesktop.bootstrap();
    const messages = (state.messages ?? []).filter((message) => message.threadId === input.threadId);
    const scroll = document.querySelector(".messages");
    const viewport = scroll?.getBoundingClientRect();
    const rowElements = [...document.querySelectorAll(".messages .message")];
    const visibleMessageRows = rowElements.filter((element) => {
      const rect = element.getBoundingClientRect();
      if (!viewport) return rect.bottom > 0 && rect.top < window.innerHeight;
      return rect.bottom >= viewport.top && rect.top <= viewport.bottom;
    }).length;
    return {
      label: input.label,
      messageCount: messages.length,
      renderedMessageRows: rowElements.length,
      visibleMessageRows,
      mountedDomNodes: document.querySelectorAll("*").length,
      inlineUrlButtons: document.querySelectorAll(".inline-url-link").length,
      inlineArtifactButtons: document.querySelectorAll(".inline-artifact-link").length,
      inlineLinkButtons: document.querySelectorAll(".inline-url-link, .inline-artifact-link").length,
      scrollTop: scroll instanceof HTMLElement ? Math.round(scroll.scrollTop) : 0,
      scrollHeight: scroll instanceof HTMLElement ? Math.round(scroll.scrollHeight) : 0,
      clientHeight: scroll instanceof HTMLElement ? Math.round(scroll.clientHeight) : 0,
      bodyTextChars: document.body.innerText.length,
      containsLastBatch: document.body.innerText.includes("Render batch 89"),
    };
  }, { threadId, label });
}

async function scrollMessages(cdpClient, position) {
  await evaluate(cdpClient, (targetPosition) => {
    const scroll = document.querySelector(".messages");
    if (!(scroll instanceof HTMLElement)) return false;
    if (targetPosition === "top") scroll.scrollTop = 0;
    else if (targetPosition === "middle") scroll.scrollTop = Math.max(0, (scroll.scrollHeight - scroll.clientHeight) / 2);
    else scroll.scrollTop = scroll.scrollHeight;
    scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
    return true;
  }, position);
  await delay(250);
}

async function measureCdpLatency(cdpClient, samples) {
  const values = [];
  for (let index = 0; index < samples; index += 1) {
    const started = Date.now();
    await evaluate(cdpClient, () => document.querySelectorAll("*").length);
    values.push(Date.now() - started);
  }
  const sorted = [...values].sort((left, right) => left - right);
  const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return {
    samples: values,
    p50Ms: sorted[Math.floor(sorted.length / 2)] ?? 0,
    p95Ms: sorted[p95Index] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

function maxMetric(samples, key) {
  return Math.max(...samples.map((sample) => Number(sample?.[key] ?? 0)));
}

async function runPhase5LiveContinuation(cdpClient, threadId) {
  const providerState = await evaluate(cdpClient, () => window.ambientDesktop.bootstrap().then((state) => state.provider));
  if (!providerState?.hasApiKey) {
    throw new Error(`Provider ${dogfoodProviderId()} did not report an available API key before Phase 5 continuation.`);
  }
  if (dogfoodProviderKind() === "ambient") {
    const keyCheck = await evaluate(cdpClient, () => window.ambientDesktop.testAmbientApiKey());
    if (!keyCheck?.ok) throw new Error(`Ambient API key check failed before Phase 5 continuation: ${keyCheck?.message ?? "unknown error"}`);
  }

  const liveThreadId = await createLiveContinuationThread(cdpClient);
  await evaluate(cdpClient, (id) => window.ambientDesktop.selectThread(id), threadId);
  await waitForFixtureMessageCount(cdpClient, threadId, HEAVY_RENDER_FIXTURE.expectedMessageCount, appWaitTimeoutMs);
  await waitForHeavyTranscriptMounted(cdpClient);
  await installRenderOptimizationLiveCollector(cdpClient, liveThreadId);
  const beforePerformance = await collectPerformanceMetrics(cdpClient);
  const prompt = [
    `Reply exactly ${liveContinuationToken}.`,
    "Do not call tools, edit files, browse the web, or inspect local state.",
    "This is a render optimization live-provider gate on an already-open heavy transcript.",
  ].join("\n");
  const liveStartedAt = Date.now();
  await evaluate(cdpClient, async (input) => {
    const state = await window.ambientDesktop.bootstrap();
    const live = window.__ambientRenderOptimizationLive;
    live.statuses = [];
    live.runtimeActivities = [];
    live.toolNames = [];
    live.assistantTail = "";
    live.sawRunStart = false;
    live.sawRunIdle = false;
    live.lastStatusAtMs = 0;
    live.sendResolved = false;
    live.error = undefined;
    window.ambientDesktop.sendMessage({
      threadId: input.liveThreadId,
      content: input.prompt,
      permissionMode: "workspace",
      collaborationMode: "agent",
      model: input.model || state.settings.model,
      thinkingLevel: "minimal",
      preserveActiveThread: true,
    })
      .then(() => {
        live.sendResolved = true;
      })
      .catch((error) => {
        live.error = error instanceof Error ? error.message : String(error);
      });
    return true;
  }, { liveThreadId, prompt, model: dogfoodModelId() });

  const live = await waitForRenderOptimizationLiveCompletion(cdpClient, liveContinuationTimeoutMs);
  const persistedAssistantTail = await latestAssistantTail(cdpClient, liveThreadId);
  const liveWithReadback = {
    ...live,
    threadId: liveThreadId,
    mountedThreadId: threadId,
    persistedAssistantTail,
  };
  if (!`${live.assistantTail}\n${persistedAssistantTail}`.includes(liveContinuationToken)) {
    throw new Error(`Phase 5 live continuation did not return ${liveContinuationToken}. Live state: ${JSON.stringify(liveWithReadback)}`);
  }
  if (liveWithReadback.toolNames.length > 0) {
    throw new Error(`Phase 5 live continuation unexpectedly used tools: ${liveWithReadback.toolNames.join(", ")}`);
  }

  await evaluate(cdpClient, (id) => window.ambientDesktop.selectThread(id), threadId);
  await waitForFixtureMessageCount(cdpClient, threadId, HEAVY_RENDER_FIXTURE.expectedMessageCount, appWaitTimeoutMs);
  await waitForHeavyTranscriptMounted(cdpClient);
  await scrollMessages(cdpClient, "bottom");
  const postRunMetrics = await collectRenderMetrics(cdpClient, threadId, "post-live");
  const postRunCdpLatency = await measureCdpLatency(cdpClient, 20);
  const afterPerformance = await collectPerformanceMetrics(cdpClient);
  return {
    status: "passed",
    durationMs: Date.now() - liveStartedAt,
    token: liveContinuationToken,
    provider: dogfoodProviderId(),
    model: dogfoodModelId(),
    live: liveWithReadback,
    postRunMetrics,
    postRunCdpLatency,
    performance: {
      before: beforePerformance,
      after: afterPerformance,
      delta: diffPerformanceMetrics(beforePerformance, afterPerformance),
    },
  };
}

async function installRenderOptimizationLiveCollector(cdpClient, threadId) {
  await evaluate(cdpClient, (id) => {
    window.__ambientRenderOptimizationLive?.unsubscribe?.();
    window.__ambientRenderOptimizationLive = {
      threadId: id,
      statuses: [],
      runtimeActivities: [],
      toolNames: [],
      assistantTail: "",
      sawRunStart: false,
      sawRunIdle: false,
      lastStatusAtMs: 0,
      sendResolved: false,
      error: undefined,
      unsubscribe: undefined,
    };
    window.__ambientRenderOptimizationLive.unsubscribe = window.ambientDesktop.onEvent((event) => {
      const live = window.__ambientRenderOptimizationLive;
      const eventThreadId = event.threadId ?? event.message?.threadId ?? event.activity?.threadId;
      if (eventThreadId && eventThreadId !== live.threadId) return;
      if (event.type === "run-status") {
        live.lastStatusAtMs = Date.now();
        live.statuses.push(event.status);
        live.statuses = live.statuses.slice(-32);
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
          idleElapsedMs: event.activity?.idleElapsedMs,
          idleTimeoutMs: event.activity?.idleTimeoutMs,
        });
        live.runtimeActivities = live.runtimeActivities.slice(-24);
      }
      if (event.type === "message-delta") {
        live.assistantTail = `${live.assistantTail}${String(event.delta ?? "")}`.slice(-4000);
      }
      if ((event.type === "message-created" || event.type === "message-updated") && event.message?.role === "tool") {
        const toolName = String(event.message.metadata?.toolName ?? "");
        if (toolName) live.toolNames = [...live.toolNames, toolName].slice(-24);
      }
      if (event.type === "error") live.error = event.message;
    });
    return true;
  }, threadId);
}

async function waitForRenderOptimizationLiveCompletion(cdpClient, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const live = await getRenderOptimizationLiveState(cdpClient);
    if (live?.error) throw new Error(live.error);
    const latestStatus = live?.statuses?.[live.statuses.length - 1];
    if (live?.sawRunIdle && live?.sendResolved && latestStatus === "idle" && Date.now() - live.lastStatusAtMs >= 2_000) return live;
    await delay(1_000);
  }
  const live = await getRenderOptimizationLiveState(cdpClient);
  throw new Error(`Timed out waiting for Phase 5 live continuation after ${timeoutMs}ms. Live state: ${JSON.stringify(live)}`);
}

async function getRenderOptimizationLiveState(cdpClient) {
  return evaluate(cdpClient, () => {
    const live = window.__ambientRenderOptimizationLive;
    return live ? {
      statuses: live.statuses,
      runtimeActivities: live.runtimeActivities,
      toolNames: live.toolNames,
      assistantTail: live.assistantTail,
      sawRunStart: live.sawRunStart,
      sawRunIdle: live.sawRunIdle,
      lastStatusAtMs: live.lastStatusAtMs,
      sendResolved: live.sendResolved,
      error: live.error,
    } : undefined;
  });
}

async function latestAssistantTail(cdpClient, threadId) {
  return evaluate(cdpClient, async (id) => {
    await window.ambientDesktop.selectThread(id);
    const state = await window.ambientDesktop.bootstrap();
    const assistantMessages = (state.messages ?? []).filter((message) => message.threadId === id && message.role === "assistant");
    const latest = assistantMessages.at(-1);
    return String(latest?.content ?? "").slice(-4000);
  }, threadId);
}

async function collectPerformanceMetrics(cdpClient) {
  await cdpClient.send("Performance.enable").catch(() => undefined);
  const result = await cdpClient.send("Performance.getMetrics").catch(() => undefined);
  const metrics = {};
  for (const metric of result?.metrics ?? []) {
    if ([
      "TaskDuration",
      "ScriptDuration",
      "LayoutDuration",
      "RecalcStyleDuration",
      "JSHeapUsedSize",
      "JSHeapTotalSize",
    ].includes(metric.name)) {
      metrics[metric.name] = metric.value;
    }
  }
  return metrics;
}

function diffPerformanceMetrics(before, after) {
  const delta = {};
  for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
    const beforeValue = Number(before?.[key] ?? 0);
    const afterValue = Number(after?.[key] ?? 0);
    delta[key] = afterValue - beforeValue;
  }
  return delta;
}

async function writeScreenshot(cdpClient, name) {
  await mkdir(resultsDir, { recursive: true });
  const result = await cdpClient.send("Page.captureScreenshot", { format: "png", fromSurface: true }, { timeoutMs: 30_000 });
  const outputPath = join(resultsDir, name);
  await writeFile(outputPath, Buffer.from(result.data, "base64"));
  return outputPath;
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
      // Keep polling.
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
      return ready.then(() => new Promise((resolveCommand, rejectCommand) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          rejectCommand(new Error(`Timed out waiting for CDP ${method} after ${timeoutMs}ms.`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timeout);
            resolveCommand(value);
          },
          reject: (error) => {
            clearTimeout(timeout);
            rejectCommand(error);
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
  await waitFor(cdpClient, (expected) => document.body.innerText.includes(expected), timeoutMs, text);
}

async function waitFor(cdpClient, predicate, timeoutMs, ...predicateArgs) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      if (await evaluate(cdpClient, predicate, ...predicateArgs)) return;
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  const body = await evaluate(cdpClient, () => document.body.innerText).catch(() => "");
  throw new Error(`Timed out waiting for Electron UI condition.${lastError ? ` Last error: ${lastError.message}` : ""}\n\nBody tail:\n${body.slice(-2000)}`);
}

async function evaluate(cdpClient, fnOrExpression, ...evaluateArgs) {
  const expression = typeof fnOrExpression === "function"
    ? `(${fnOrExpression.toString()})(...${JSON.stringify(evaluateArgs)})`
    : String(fnOrExpression);
  const result = await cdpClient.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(`Runtime.evaluate failed: ${JSON.stringify(result.exceptionDetails)}`);
  return result.result?.value;
}

async function setViewport(cdpClient, width, height) {
  await cdpClient.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

function dogfoodStateDbPath(input) {
  const legacyDbPath = join(input.workspacePath, ".ambient-codex", "state.sqlite");
  const authorityDbPath = join(input.authorityStateRoot, "workspaces", authorityWorkspaceDirectoryName(input.workspacePath), "state.sqlite");
  return existsSync(authorityDbPath) || !existsSync(legacyDbPath) ? authorityDbPath : legacyDbPath;
}

function authorityWorkspaceDirectoryName(workspace) {
  const name = safePathSegment(basename(workspace)) || "workspace";
  const id = createHash("sha256").update(resolve(workspace)).digest("hex").slice(0, 16);
  return `${name}-${id}`;
}

function safePathSegment(value) {
  return value.trim().replace(/[^A-Za-z0-9._-]/g, "_").replace(/_+/g, "_").replace(/^\.+|\.+$/g, "");
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function dogfoodCdpPort() {
  const raw = process.env.AMBIENT_SUBAGENT_DESKTOP_DOGFOOD_CDP_PORT || process.env.AMBIENT_HARNESS_CDP_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`AMBIENT_SUBAGENT_DESKTOP_DOGFOOD_CDP_PORT must be a TCP port, got ${raw ?? ""}.`);
  }
  return port;
}

function buildDogfoodEnv(overrides) {
  return cleanChildEnv({
    ...process.env,
    AMBIENT_PROVIDER: dogfoodProviderId(),
    AMBIENT_LIVE_MODEL: dogfoodModelId(),
    ...overrides,
  });
}

function dogfoodProviderId() {
  return process.env.AMBIENT_PROVIDER || defaultProvider;
}

function dogfoodProviderKind() {
  const raw = dogfoodProviderId().toLowerCase().replace(/[_\s]+/g, "-");
  if (raw === "gmi" || raw === "gmicloud" || raw === "gmi-cloud") return "gmi-cloud";
  return raw;
}

function dogfoodModelId() {
  if (dogfoodProviderKind() === "gmi-cloud") return process.env.GMI_CLOUD_MODEL || process.env.AMBIENT_LIVE_MODEL || process.env.AMBIENT_MODEL || defaultModel;
  return process.env.AMBIENT_LIVE_MODEL || process.env.AMBIENT_MODEL || defaultModel;
}

async function readDogfoodProviderCredentialEnv() {
  if (dogfoodProviderKind() === "gmi-cloud") {
    const key = await readFirstCredential([
      process.env.GMI_CLOUD_API_KEY,
      process.env.GMI_API_KEY,
    ], [
      process.env.GMI_CLOUD_API_KEY_FILE,
      join(repoRoot, "ignored-provider-key-file.txt"),
      join(dirname(repoRoot), "ignored-provider-key-file.txt"),
      join(homedir(), "ignored-provider-key-file.txt"),
      join(dirname(repoRoot), "ambientCoder", "ignored-provider-key-file.txt"),
      join(homedir(), "ambientCoder", "ignored-provider-key-file.txt"),
      join(homedir(), "Documents", "ambientCoder", "ignored-provider-key-file.txt"),
      join(homedir(), "Documents", "New project 3", "ignored-provider-key-file.txt"),
      "/Users/example/Documents/ambientCoder/ignored-provider-key-file.txt",
    ]);
    return key ? { GMI_CLOUD_API_KEY: key, GMI_API_KEY: key } : {};
  }

  const key = await readFirstCredential([
    process.env.AMBIENT_API_KEY,
    process.env.AMBIENT_AGENT_AMBIENT_API_KEY,
  ], [
    process.env.AMBIENT_API_KEY_FILE,
    process.env.AMBIENT_AGENT_AMBIENT_API_KEY_FILE,
    join(repoRoot, "ambient_api_key_u.txt"),
    join(repoRoot, "ignored-provider-key-file.txt"),
    join(dirname(repoRoot), "ambient_api_key_u.txt"),
    join(dirname(repoRoot), "ignored-provider-key-file.txt"),
    join(homedir(), "ambient_api_key_u.txt"),
    join(homedir(), "ignored-provider-key-file.txt"),
    join(homedir(), "Documents", "ambientCoder", "ambient_api_key_u.txt"),
    join(homedir(), "Documents", "ambientCoder", "ignored-provider-key-file.txt"),
    join(homedir(), "Documents", "New project 3", "ambient_api_key_u.txt"),
    join(homedir(), "Documents", "New project 3", "ignored-provider-key-file.txt"),
    "/Users/example/Documents/ambientCoder/ambient_api_key_u.txt",
    "/Users/example/Documents/ambientCoder/ignored-provider-key-file.txt",
  ]);
  return key ? { AMBIENT_API_KEY: key, AMBIENT_AGENT_AMBIENT_API_KEY: key } : {};
}

async function readFirstCredential(envValues, fileCandidates) {
  for (const value of envValues) {
    if (value?.trim()) return value.trim();
  }
  const candidates = fileCandidates.filter(Boolean);
  for (const candidate of candidates) {
    try {
      const key = (await readFile(candidate, "utf8")).trim();
      if (key) return key;
    } catch {
      // Try the next local-only key location.
    }
  }
  return undefined;
}

function dogfoodProviderCredentialHelp() {
  if (dogfoodProviderKind() === "gmi-cloud") {
    return "GMI_CLOUD_API_KEY, GMI_API_KEY, GMI_CLOUD_API_KEY_FILE, or local ignored-provider-key-file.txt";
  }
  return "AMBIENT_API_KEY, AMBIENT_AGENT_AMBIENT_API_KEY, AMBIENT_API_KEY_FILE, AMBIENT_AGENT_AMBIENT_API_KEY_FILE, or local ignored-provider-key-file.txt / ambient_api_key_u.txt";
}

function cleanChildEnv(env) {
  const next = { ...env };
  delete next.NODE_OPTIONS;
  delete next.VITEST;
  return next;
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

async function terminateProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([once(child, "exit"), delay(5_000)]).catch(() => undefined);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function writeReport(nextReport) {
  await mkdir(resultsDir, { recursive: true });
  await writeFile(latestReportPath, `${JSON.stringify(nextReport, null, 2)}\n`, "utf8");
}

function outputPathRelative(path) {
  const absolute = resolve(path);
  return absolute.startsWith(`${repoRoot}/`) ? relative(repoRoot, absolute) : absolute;
}
