#!/usr/bin/env node
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  detectDirectHelperOperation,
  sourceClassificationDecisionsFromBody,
  sourceClassificationInputsFromBody,
} from "./e2e-project-board-direct-helper-retry-gmi-live-lib.mjs";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const outputRoot = resolve(process.env.AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_OUT_DIR || join(repoRoot, "test-results", "project-board-direct-helper-retry-gmi"));
const latestSummaryPath = resolve(process.env.AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_OUT || join(outputRoot, "latest.json"));
const defaultTimeoutMs = Number(process.env.AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_TIMEOUT_MS || 0) || 300_000;
const electronTargetTimeoutMs = Number(process.env.AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_ELECTRON_TARGET_TIMEOUT_MS || 0) || 90_000;
const DEFAULT_DIRECT_HELPER_RETRY_PRE_STREAM_TIMEOUT_MS = 15_000;
const DEFAULT_DIRECT_HELPER_RETRY_STREAM_IDLE_TIMEOUT_MS = 15_000;
const DEFAULT_DIRECT_HELPER_RETRY_CONTENT_IDLE_MS = 12_000;
const DEFAULT_PROOF_JUDGMENT_RETRY_PRE_STREAM_TIMEOUT_MS = 30_000;
const DEFAULT_PROOF_JUDGMENT_RETRY_STREAM_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_PROOF_JUDGMENT_RETRY_CONTENT_IDLE_MS = 30_000;
const requestedFailpointCount = Math.max(
  1,
  Math.floor(Number(process.env.AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_FAILPOINT_COUNT || 1)),
);
const requestedRetryTargets = readRetryTargets();
const output = [];
const children = new Set();
let activeRetryTarget;
let activeTimeoutMs;
let directHelperPreStreamTimeoutMs;
let directHelperStreamIdleTimeoutMs;
let directHelperContentIdleMs;
let runRoot;
let userData;
let workspace;
let cdpPort;
let proxyPort;
let lastCdpProbe;

const scenarioSummaries = [];
let failedScenarioError;
for (const retryTarget of requestedRetryTargets) {
  let appInstance;
  let proxy;
  try {
    activeRetryTarget = retryTarget;
    activeTimeoutMs = timeoutMsForTarget(retryTarget);
    directHelperPreStreamTimeoutMs = preStreamTimeoutMsForTarget(retryTarget);
    directHelperStreamIdleTimeoutMs = streamIdleTimeoutMsForTarget(retryTarget);
    directHelperContentIdleMs = contentIdleMsForTarget(retryTarget);
    const runStamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${retryTarget}`;
    runRoot = join(outputRoot, "runs", runStamp);
    userData = join(runRoot, "userData");
    workspace = join(runRoot, "workspace");
    cdpPort = Number(process.env.AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_CDP_PORT || 0) || (await findOpenPort());
    proxyPort = Number(process.env.AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_PROXY_PORT || 0) || (await findOpenPort());
    output.length = 0;
    await prepareWorkspaceCopy();
    proxy = await startGmiFailpointProxy(proxyPort);
    appInstance = await launchApp(proxy.baseUrl);
    scenarioSummaries.push(await runSmoke(appInstance.cdp, proxy));
  } catch (error) {
    console.error(outputTail());
    failedScenarioError = error;
    scenarioSummaries.push(await buildFailedScenarioSummary(retryTarget, error, appInstance?.cdp, proxy));
    break;
  } finally {
    appInstance?.cdp.close();
    if (appInstance?.child) await terminateProcessTree(appInstance.child);
    for (const child of children) await terminateProcessTree(child);
    await closeProxy(proxy);
    await terminateDebugPortProcesses();
  }
}

const report = buildReport(scenarioSummaries);
await mkdir(outputRoot, { recursive: true });
await mkdir(dirname(latestSummaryPath), { recursive: true });
await writeFile(latestSummaryPath, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));
if (report.status === "passed") {
  console.log("Project-board direct-helper retry GMI smoke passed.");
} else {
  console.error(
    `Project-board direct-helper retry GMI smoke failed; wrote attention report to ${latestSummaryPath}: ${
      failedScenarioError instanceof Error ? failedScenarioError.message : String(failedScenarioError ?? "unknown failure")
    }`,
  );
  process.exitCode = 1;
}

function readRetryTargets() {
  const raw =
    process.env.AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_TARGETS ||
    process.env.AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_TARGET ||
    "source-classification";
  const targets = raw
    .split(",")
    .map((target) => target.trim().toLowerCase())
    .filter(Boolean)
    .flatMap((target) => (target === "all" ? ["source-classification", "charter-summary", "proof-judgment"] : [target]));
  const uniqueTargets = [...new Set(targets)];
  for (const target of uniqueTargets) {
    if (!["source-classification", "charter-summary", "proof-judgment"].includes(target)) {
      throw new Error(`Unsupported direct-helper retry target: ${target}`);
    }
  }
  return uniqueTargets.length > 0 ? uniqueTargets : ["source-classification"];
}

function contentIdleMsForTarget(target) {
  const specific =
    target === "charter-summary"
      ? process.env.AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_CHARTER_CONTENT_IDLE_MS
      : target === "proof-judgment"
        ? process.env.AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_PROOF_CONTENT_IDLE_MS
      : process.env.AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_SOURCE_CONTENT_IDLE_MS;
  return (
    Number(specific || process.env.AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_CONTENT_IDLE_MS || 0) ||
    (target === "proof-judgment" ? DEFAULT_PROOF_JUDGMENT_RETRY_CONTENT_IDLE_MS : DEFAULT_DIRECT_HELPER_RETRY_CONTENT_IDLE_MS)
  );
}

function preStreamTimeoutMsForTarget(target) {
  const specific =
    target === "charter-summary"
      ? process.env.AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_CHARTER_PRE_STREAM_TIMEOUT_MS
      : target === "proof-judgment"
        ? process.env.AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_PROOF_PRE_STREAM_TIMEOUT_MS
      : process.env.AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_SOURCE_PRE_STREAM_TIMEOUT_MS;
  return (
    Number(specific || process.env.AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_PRE_STREAM_TIMEOUT_MS || 0) ||
    (target === "proof-judgment" ? DEFAULT_PROOF_JUDGMENT_RETRY_PRE_STREAM_TIMEOUT_MS : DEFAULT_DIRECT_HELPER_RETRY_PRE_STREAM_TIMEOUT_MS)
  );
}

function streamIdleTimeoutMsForTarget(target) {
  const specific =
    target === "charter-summary"
      ? process.env.AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_CHARTER_STREAM_IDLE_TIMEOUT_MS
      : target === "proof-judgment"
        ? process.env.AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_PROOF_STREAM_IDLE_TIMEOUT_MS
      : process.env.AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_SOURCE_STREAM_IDLE_TIMEOUT_MS;
  return (
    Number(specific || process.env.AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_STREAM_IDLE_TIMEOUT_MS || 0) ||
    (target === "proof-judgment" ? DEFAULT_PROOF_JUDGMENT_RETRY_STREAM_IDLE_TIMEOUT_MS : DEFAULT_DIRECT_HELPER_RETRY_STREAM_IDLE_TIMEOUT_MS)
  );
}

function activeTransportTimeouts() {
  return {
    preStreamResponseTimeoutMs: directHelperPreStreamTimeoutMs,
    streamIdleTimeoutMs: directHelperStreamIdleTimeoutMs,
    streamContentIdleTimeoutMs: directHelperContentIdleMs,
  };
}

function timeoutMsForTarget(target) {
  const specific =
    target === "charter-summary"
      ? process.env.AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_CHARTER_TIMEOUT_MS
      : target === "proof-judgment"
        ? process.env.AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_PROOF_TIMEOUT_MS
      : process.env.AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_SOURCE_TIMEOUT_MS;
  return Number(specific || 0) || (target === "proof-judgment" ? Math.max(defaultTimeoutMs, 600_000) : defaultTimeoutMs);
}

function buildReport(scenarios) {
  const generatedAt = new Date().toISOString();
  const report = {
    status: scenarios.every((scenario) => scenario.status === "passed") ? "passed" : "attention",
    generatedAt,
    scenarioCount: scenarios.length,
    targets: scenarios.map((scenario) => scenario.scenario),
    scenarios,
  };
  if (scenarios.length === 1) Object.assign(report, scenarios[0]);
  return report;
}

async function buildFailedScenarioSummary(retryTarget, error, cdp, proxyRef) {
  const finalState = cdp ? await optionalDesktopState(cdp) : undefined;
  const finalBoard = finalState ? activeBoard(finalState) : undefined;
  const latestRun = latestRunForBoard(finalBoard, finalBoard?.id);
  const proofReview = findProofReview(finalBoard);
  const retryEvent = findRetryEventForTarget(retryTarget, finalState, finalBoard?.id);
  const fallbackToNonStream =
    hasFallbackRetryEventForTarget(retryTarget, finalState, finalBoard?.id) ||
    (proxyRef?.state?.forwardedNonStreamChatCompletionCount ?? 0) > 0;
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: "attention",
    scenario: retryTarget,
    providerId: finalState?.provider?.providerId,
    providerLabel: finalState?.provider?.providerLabel,
    model: finalState?.provider?.model,
    boardId: finalBoard?.id,
    runRoot,
    transportTimeouts: activeTransportTimeouts(),
    sourceCount: finalBoard?.sources?.length ?? 0,
    latestRunStatus: latestRun?.status,
    latestRunStage: latestRun?.stage,
    proofJudgmentApplied: Boolean(proofReview),
    proofReviewReviewer: proofReview?.reviewer,
    proofReviewStatus: proofReview?.status,
    proofReviewRecommendedAction: proofReview?.recommendedAction,
    proofReviewEvidenceQuality: proofReview?.evidenceQuality,
    proofReviewConfidence: proofReview?.confidence,
    proofReviewSummary: proofReview?.summary,
    failpointTriggered: proxyRef?.state?.failpointTriggered,
    failpointLimit: proxyRef?.state?.failpointLimit,
    failpointTriggerCount: proxyRef?.state?.failpointTriggerCount,
    failpointClosedByClient: proxyRef?.state?.failpointClosedByClient,
    failpointChatCompletionCount: proxyRef?.state?.failpointChatCompletionCount,
    failpointChatCompletionCounts: proxyRef?.state?.failpointChatCompletionCounts,
    chatCompletionCount: proxyRef?.state?.chatCompletionCount,
    forwardedChatCompletionCount: proxyRef?.state?.forwardedChatCompletionCount,
    forwardedStreamChatCompletionCount: proxyRef?.state?.forwardedStreamChatCompletionCount,
    forwardedNonStreamChatCompletionCount: proxyRef?.state?.forwardedNonStreamChatCompletionCount,
    fallbackToNonStream,
    deterministicSetupChatCompletionCount: proxyRef?.state?.deterministicSetupChatCompletionCount,
    observedOperations: proxyRef?.state?.requests?.map((request) => request.operation) ?? [],
    observedRequests: proxyRef?.state?.requests ?? [],
    ...(retryEvent ? { retryEvent: retryEventSummaryForTarget(retryTarget, retryEvent) } : {}),
    error: message,
    issues: [message],
  };
}

async function optionalDesktopState(cdp) {
  try {
    return await desktopState(cdp);
  } catch {
    return undefined;
  }
}

function findProofReview(board) {
  return board?.cards?.find((card) => card?.proofReview)?.proofReview;
}

async function prepareWorkspaceCopy() {
  const snapshotUserData = process.env.AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_SNAPSHOT_USER_DATA || process.env.AMBIENT_E2E_USER_DATA;
  const snapshotWorkspace = process.env.AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_SNAPSHOT_WORKSPACE || process.env.AMBIENT_DESKTOP_WORKSPACE;
  if (!snapshotUserData || !existsSync(snapshotUserData)) {
    throw new Error("Configure AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_SNAPSHOT_USER_DATA or AMBIENT_E2E_USER_DATA with a local snapshot userData directory.");
  }
  if (!snapshotWorkspace || !existsSync(snapshotWorkspace)) {
    throw new Error("Configure AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_SNAPSHOT_WORKSPACE or AMBIENT_DESKTOP_WORKSPACE with a local snapshot workspace directory.");
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
  await resetWorkspaceToSmallBoardFixture();
}

async function resetWorkspaceToSmallBoardFixture() {
  await mkdir(workspace, { recursive: true });
  for (const entry of await readdir(workspace)) {
    await rm(join(workspace, entry), { recursive: true, force: true });
  }
  await writeFile(
    join(workspace, "README.md"),
    [
      "# Direct Helper Retry Smoke",
      "",
      "This workspace validates Ambient Desktop project-board source classification through GMI Cloud.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(workspace, "PROJECT_BRIEF.md"),
    [
      "# Asteroid Relay Project Brief",
      "",
      "Build a browser-based spaceship logistics game with deterministic movement, cargo routing, shield timing, and a concise HUD.",
      "The implementation should use TypeScript, PixiJS rendering, deterministic game-state tests, and a small visual smoke proof.",
      "Acceptance criteria must include a nonblank canvas, player movement, mission state, enemy pressure, and automated state coverage.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(workspace, "TECHNICAL_NOTES.md"),
    [
      "# Technical Notes",
      "",
      "The game loop should keep simulation state pure enough for unit tests while rendering through a separate PixiJS adapter.",
      "Matter.js can be used for collision helpers, but mission state and scoring should remain deterministic.",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function startGmiFailpointProxy(port) {
  const upstreamBaseUrl = (process.env.GMI_CLOUD_UPSTREAM_BASE_URL || "https://api.gmi-serving.com").replace(/\/+$/, "");
  const state = {
    target: activeRetryTarget,
    chatCompletionCount: 0,
    forwardedChatCompletionCount: 0,
    forwardedStreamChatCompletionCount: 0,
    forwardedNonStreamChatCompletionCount: 0,
    deterministicSetupChatCompletionCount: 0,
    failpointChatCompletionCount: 0,
    failpointChatCompletionCounts: [],
    failpointLimit: requestedFailpointCount,
    failpointTriggerCount: 0,
    failpointTriggered: false,
    failpointClosedByClient: false,
    requests: [],
  };
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    try {
      const body = await readRequestBody(req);
      if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
        state.chatCompletionCount += 1;
        const requestBody = parseChatCompletionRequestBody(body);
        const operation = detectDirectHelperOperation(body);
        state.requests.push({ index: state.chatCompletionCount, operation, stream: requestBody?.stream });
        if (
          state.target === "charter-summary" &&
          operation === "source-classification" &&
          sourceClassificationInputsFromBody(body).length > 0
        ) {
          state.deterministicSetupChatCompletionCount += 1;
          return writeDeterministicSourceClassificationStream(res, body);
        }
        if (state.failpointTriggerCount < state.failpointLimit && shouldTriggerFailpoint(state, operation)) {
          state.failpointTriggered = true;
          state.failpointTriggerCount += 1;
          state.failpointChatCompletionCount = state.chatCompletionCount;
          state.failpointChatCompletionCounts.push(state.chatCompletionCount);
          return writeKeepaliveOnlyStream(res, state);
        }
        state.forwardedChatCompletionCount += 1;
        if (requestBody?.stream === false) state.forwardedNonStreamChatCompletionCount += 1;
        else state.forwardedStreamChatCompletionCount += 1;
      }
      await forwardRequest({ req, res, body, upstreamBaseUrl });
    } catch (error) {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return { server, state, sockets, baseUrl: `http://127.0.0.1:${port}` };
}

function shouldTriggerFailpoint(state, operation) {
  if (state.target === "charter-summary") return operation === "charter-summary";
  if (state.target === "proof-judgment") return operation === "proof-judgment";
  return operation === "source-classification" || state.chatCompletionCount === 1;
}

function writeDeterministicSourceClassificationStream(res, body) {
  const content = JSON.stringify({
    classifications: sourceClassificationDecisionsFromBody(body),
  });
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of chunkString(content, 512)) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
  }
  res.end("data: [DONE]\n\n");
}

function chunkString(value, size) {
  const chunks = [];
  for (let index = 0; index < value.length; index += size) chunks.push(value.slice(index, index + size));
  return chunks;
}

function writeKeepaliveOnlyStream(res, state) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const interval = setInterval(() => {
    if (!res.destroyed) res.write(": keepalive\n\n");
  }, 200);
  const timeout = setTimeout(() => {
    clearInterval(interval);
    if (!res.destroyed) res.end();
  }, directHelperContentIdleMs + 15_000);
  res.on("close", () => {
    state.failpointClosedByClient = true;
    clearInterval(interval);
    clearTimeout(timeout);
  });
}

function parseChatCompletionRequestBody(body) {
  try {
    const parsed = JSON.parse(Buffer.isBuffer(body) ? body.toString("utf8") : String(body ?? ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function forwardRequest({ req, res, body, upstreamBaseUrl }) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (!value || ["host", "content-length", "connection"].includes(name.toLowerCase())) continue;
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else headers.set(name, value);
  }
  const upstream = await fetch(`${upstreamBaseUrl}${req.url}`, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });
  const responseHeaders = {};
  upstream.headers.forEach((value, name) => {
    responseHeaders[name] = value;
  });
  res.writeHead(upstream.status, responseHeaders);
  if (!upstream.body) {
    res.end();
    return;
  }
  for await (const chunk of upstream.body) {
    res.write(Buffer.from(chunk));
  }
  res.end();
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function launchApp(proxyBaseUrl) {
  const child = spawn("pnpm", ["exec", "electron-vite", "dev", "--remoteDebuggingPort", String(cdpPort)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AMBIENT_PROVIDER: "gmi-cloud",
      GMI_CLOUD_BASE_URL: proxyBaseUrl,
      AMBIENT_E2E: "1",
      AMBIENT_E2E_USER_DATA: userData,
      AMBIENT_DESKTOP_WORKSPACE: workspace,
      AMBIENT_DESKTOP_BOOTSTRAP_WATCHDOG_MS: process.env.AMBIENT_DESKTOP_BOOTSTRAP_WATCHDOG_MS ?? "180000",
      AMBIENT_E2E_SKIP_PROJECT_BOARD_SOURCE_REFRESH: "1",
      AMBIENT_PI_USER_SETTINGS_PATH: join(userData, "missing-pi-settings.json"),
      AMBIENT_CODEX_CURATED_MARKETPLACE_URL: "0",
      AMBIENT_DIRECT_HELPER_PRE_STREAM_TIMEOUT_MS: String(directHelperPreStreamTimeoutMs),
      AMBIENT_DIRECT_HELPER_STREAM_IDLE_TIMEOUT_MS: String(directHelperStreamIdleTimeoutMs),
      AMBIENT_DIRECT_HELPER_STREAM_CONTENT_IDLE_TIMEOUT_MS: String(directHelperContentIdleMs),
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

  const target = await waitForTarget(cdpPort, () => childExit);
  await delay(750);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await waitFor(cdp, () => document.body?.innerText.includes("Ambient"), "main shell", 45_000);
  return { child, cdp };
}

async function runSmoke(cdp, proxyRef) {
  let state = await desktopState(cdp);
  if (state.provider.providerId !== "gmi-cloud") throw new Error(`Expected GMI Cloud provider, got ${state.provider.providerId}.`);
  if (!state.provider.hasApiKey) throw new Error("GMI Cloud API key was not visible to the launched app.");
  const keyCheck = await evaluate(cdp, "window.ambientDesktop.testAmbientApiKey()");
  if (!keyCheck?.ok) throw new Error(`GMI Cloud API key check failed: ${keyCheck?.message ?? "unknown error"}`);
  await evaluate(cdp, "window.ambientDesktop.updateModelRuntimeSettings({ aggressiveRetries: true })");
  state = await desktopState(cdp);

  const projectId = activeProjectId(state);
  state = await evaluate(
    cdp,
    `
    window.ambientDesktop.createProjectBoard({
      projectId: ${JSON.stringify(projectId)},
      title: "Direct Helper Retry Smoke",
      summary: "Focused source-classification retry smoke."
    })
  `,
  );
  const board = activeBoard(state);
  if (!board?.id) throw new Error("Project board was not created.");

  if (activeRetryTarget === "charter-summary") {
    return runCharterSummarySmoke(cdp, proxyRef, board.id);
  }
  if (activeRetryTarget === "proof-judgment") {
    return runProofJudgmentSmoke(cdp, proxyRef, board.id);
  }
  return runSourceClassificationSmoke(cdp, proxyRef, board.id);
}

async function runSourceClassificationSmoke(cdp, proxyRef, boardId) {
  await startRefreshSources(cdp, boardId);
  const retryEvent = await waitForSourceClassificationRetryEvent(cdp, boardId, activeTimeoutMs);
  await waitForRefreshCompletion(cdp, activeTimeoutMs);
  const finalState = await desktopState(cdp);
  const finalBoard = activeBoard(finalState);
  const latestRun = latestRunForBoard(finalBoard, boardId);
  const finalRetryEvent = findSourceClassificationRetryEvent(finalState, boardId) ?? retryEvent;
  const fallbackRetryRecorded = hasFallbackRetryEventForTarget("source-classification", finalState, boardId);
  assertFailpointRecovery(proxyRef, "GMI failpoint proxy");
  assertRepeatedFailpointFallback(proxyRef, fallbackRetryRecorded, "source classification");

  return {
    status: "passed",
    scenario: "source-classification",
    providerId: finalState.provider.providerId,
    providerLabel: finalState.provider.providerLabel,
    model: finalState.provider.model,
    boardId,
    runRoot,
    transportTimeouts: activeTransportTimeouts(),
    sourceCount: finalBoard?.sources.length ?? 0,
    latestRunStatus: latestRun?.status,
    latestRunStage: latestRun?.stage,
    failpointTriggered: proxyRef.state.failpointTriggered,
    failpointLimit: proxyRef.state.failpointLimit,
    failpointTriggerCount: proxyRef.state.failpointTriggerCount,
    failpointClosedByClient: proxyRef.state.failpointClosedByClient,
    failpointChatCompletionCount: proxyRef.state.failpointChatCompletionCount,
    failpointChatCompletionCounts: proxyRef.state.failpointChatCompletionCounts,
    chatCompletionCount: proxyRef.state.chatCompletionCount,
    forwardedChatCompletionCount: proxyRef.state.forwardedChatCompletionCount,
    forwardedStreamChatCompletionCount: proxyRef.state.forwardedStreamChatCompletionCount,
    forwardedNonStreamChatCompletionCount: proxyRef.state.forwardedNonStreamChatCompletionCount,
    fallbackToNonStream: fallbackRetryRecorded || proxyRef.state.forwardedNonStreamChatCompletionCount > 0,
    deterministicSetupChatCompletionCount: proxyRef.state.deterministicSetupChatCompletionCount,
    observedOperations: proxyRef.state.requests.map((request) => request.operation),
    observedRequests: proxyRef.state.requests,
    retryEvent: {
      title: finalRetryEvent.title,
      stage: finalRetryEvent.stage,
      summary: finalRetryEvent.summary,
      transientRetry: finalRetryEvent.metadata?.transientRetry,
      aggressiveRetries: finalRetryEvent.metadata?.aggressiveRetries,
      retryAttempt: finalRetryEvent.metadata?.retryAttempt,
      maxRetries: finalRetryEvent.metadata?.maxRetries,
      retryDelayMs: finalRetryEvent.metadata?.retryDelayMs,
      error: finalRetryEvent.metadata?.error,
      fallbackToNonStream: finalRetryEvent.metadata?.fallbackToNonStream,
      responseCharCount: finalRetryEvent.metadata?.responseCharCount,
    },
  };
}

async function runCharterSummarySmoke(cdp, proxyRef, boardId) {
  await answerKickoffQuestions(cdp, boardId);
  await startFinalizeKickoff(cdp, boardId);
  const retryEvent = await waitForCharterSummaryRetryEvent(cdp, boardId, activeTimeoutMs);
  const appliedEvent = await waitForCharterSummaryAppliedEvent(cdp, boardId, activeTimeoutMs);
  const finalState = await desktopState(cdp);
  const finalBoard = boardForId(finalState, boardId);
  const latestRun = latestRunForBoard(finalBoard, boardId);
  const finalRetryEvent = findCharterSummaryRetryEvent(finalState, boardId) ?? retryEvent;
  const fallbackRetryRecorded = hasFallbackRetryEventForTarget("charter-summary", finalState, boardId);
  assertFailpointRecovery(proxyRef, "GMI charter-summary failpoint proxy");
  assertRepeatedFailpointFallback(proxyRef, fallbackRetryRecorded, "charter summary");

  return {
    status: "passed",
    scenario: "charter-summary",
    providerId: finalState.provider.providerId,
    providerLabel: finalState.provider.providerLabel,
    model: finalState.provider.model,
    boardId,
    runRoot,
    transportTimeouts: activeTransportTimeouts(),
    sourceCount: finalBoard?.sources.length ?? 0,
    latestRunStatus: latestRun?.status,
    latestRunStage: latestRun?.stage,
    charterSummaryApplied: true,
    charterSummaryEvent: {
      title: appliedEvent.title,
      stage: appliedEvent.stage,
      summary: appliedEvent.summary,
    },
    failpointTriggered: proxyRef.state.failpointTriggered,
    failpointLimit: proxyRef.state.failpointLimit,
    failpointTriggerCount: proxyRef.state.failpointTriggerCount,
    failpointClosedByClient: proxyRef.state.failpointClosedByClient,
    failpointChatCompletionCount: proxyRef.state.failpointChatCompletionCount,
    failpointChatCompletionCounts: proxyRef.state.failpointChatCompletionCounts,
    chatCompletionCount: proxyRef.state.chatCompletionCount,
    forwardedChatCompletionCount: proxyRef.state.forwardedChatCompletionCount,
    forwardedStreamChatCompletionCount: proxyRef.state.forwardedStreamChatCompletionCount,
    forwardedNonStreamChatCompletionCount: proxyRef.state.forwardedNonStreamChatCompletionCount,
    fallbackToNonStream: fallbackRetryRecorded || proxyRef.state.forwardedNonStreamChatCompletionCount > 0,
    deterministicSetupChatCompletionCount: proxyRef.state.deterministicSetupChatCompletionCount,
    observedOperations: proxyRef.state.requests.map((request) => request.operation),
    observedRequests: proxyRef.state.requests,
    retryEvent: {
      title: finalRetryEvent.title,
      stage: finalRetryEvent.stage,
      summary: finalRetryEvent.summary,
      transientRetry: finalRetryEvent.metadata?.transientRetry,
      aggressiveRetries: finalRetryEvent.metadata?.aggressiveRetries,
      retryAttempt: finalRetryEvent.metadata?.retryAttempt,
      maxRetries: finalRetryEvent.metadata?.maxRetries,
      retryDelayMs: finalRetryEvent.metadata?.retryDelayMs,
      error: finalRetryEvent.metadata?.error,
      fallbackToNonStream: finalRetryEvent.metadata?.fallbackToNonStream,
      responseCharCount: finalRetryEvent.metadata?.responseCharCount,
    },
  };
}

async function runProofJudgmentSmoke(cdp, proxyRef, boardId) {
  await startProofJudgmentReview(cdp, boardId);
  const retryEvent = await waitForProofJudgmentRetryEvent(cdp, boardId, activeTimeoutMs);
  const proofResult = await waitForProofJudgmentCompletion(cdp, activeTimeoutMs);
  const finalState = proofResult?.state ?? (await desktopState(cdp));
  const finalBoard = boardForId(finalState, boardId);
  const proofCard = findCardById(finalBoard, proofResult?.cardId);
  const proofReview = proofCard?.proofReview ?? proofResult?.proofReview;
  const finalRetryEvent = findProofJudgmentRetryEvent(finalState, boardId) ?? retryEvent;
  const fallbackRetryRecorded = hasFallbackRetryEventForTarget("proof-judgment", finalState, boardId);
  assertFailpointRecovery(proxyRef, "GMI proof-judgment failpoint proxy");
  if (!proofReview) throw new Error("Recovered proof judgment did not apply a proof review to the dogfood card.");
  if (proofReview.reviewer !== "ambient_pi") {
    throw new Error(`Expected live Ambient/Pi proof review after retry, got ${proofReview.reviewer ?? "missing reviewer"}.`);
  }
  if (!["strong", "mixed", "weak"].includes(proofReview.evidenceQuality)) {
    throw new Error(`Expected proof review evidence quality, got ${proofReview.evidenceQuality ?? "missing"}.`);
  }
  if (!["close", "retry", "follow_up", "ask_user", "block"].includes(proofReview.recommendedAction)) {
    throw new Error(`Expected proof review recommended action, got ${proofReview.recommendedAction ?? "missing"}.`);
  }
  if (typeof proofReview.confidence !== "number") throw new Error("Expected proof review confidence from live Ambient/Pi judgment.");

  return {
    status: "passed",
    scenario: "proof-judgment",
    providerId: finalState.provider.providerId,
    providerLabel: finalState.provider.providerLabel,
    model: finalState.provider.model,
    boardId,
    cardId: proofResult.cardId,
    runId: proofResult.runId,
    runRoot,
    transportTimeouts: activeTransportTimeouts(),
    sourceCount: finalBoard?.sources.length ?? 0,
    proofJudgmentApplied: true,
    proofReviewReviewer: proofReview.reviewer,
    proofReviewStatus: proofReview.status,
    proofReviewRecommendedAction: proofReview.recommendedAction,
    proofReviewEvidenceQuality: proofReview.evidenceQuality,
    proofReviewConfidence: proofReview.confidence,
    proofReviewSummary: proofReview.summary,
    failpointTriggered: proxyRef.state.failpointTriggered,
    failpointLimit: proxyRef.state.failpointLimit,
    failpointTriggerCount: proxyRef.state.failpointTriggerCount,
    failpointClosedByClient: proxyRef.state.failpointClosedByClient,
    failpointChatCompletionCount: proxyRef.state.failpointChatCompletionCount,
    failpointChatCompletionCounts: proxyRef.state.failpointChatCompletionCounts,
    chatCompletionCount: proxyRef.state.chatCompletionCount,
    forwardedChatCompletionCount: proxyRef.state.forwardedChatCompletionCount,
    forwardedStreamChatCompletionCount: proxyRef.state.forwardedStreamChatCompletionCount,
    forwardedNonStreamChatCompletionCount: proxyRef.state.forwardedNonStreamChatCompletionCount,
    fallbackToNonStream: fallbackRetryRecorded || proxyRef.state.forwardedNonStreamChatCompletionCount > 0,
    deterministicSetupChatCompletionCount: proxyRef.state.deterministicSetupChatCompletionCount,
    observedOperations: proxyRef.state.requests.map((request) => request.operation),
    observedRequests: proxyRef.state.requests,
    retryEvent: {
      title: finalRetryEvent.title,
      kind: finalRetryEvent.kind,
      summary: finalRetryEvent.summary,
      transientRetry: finalRetryEvent.metadata?.transientRetry,
      aggressiveRetries: finalRetryEvent.metadata?.aggressiveRetries,
      retryAttempt: finalRetryEvent.metadata?.retryAttempt,
      maxRetries: finalRetryEvent.metadata?.maxRetries,
      retryDelayMs: finalRetryEvent.metadata?.retryDelayMs,
      error: finalRetryEvent.metadata?.error,
      fallbackToNonStream: finalRetryEvent.metadata?.fallbackToNonStream,
      responseCharCount: finalRetryEvent.metadata?.responseCharCount,
    },
  };
}

function assertFailpointRecovery(proxyRef, label) {
  if (!proxyRef.state.failpointTriggered) throw new Error(`${label} did not trigger.`);
  if (proxyRef.state.failpointTriggerCount < proxyRef.state.failpointLimit) {
    throw new Error(`${label} triggered ${proxyRef.state.failpointTriggerCount}/${proxyRef.state.failpointLimit} configured interruptions.`);
  }
  if (proxyRef.state.forwardedChatCompletionCount < 1) {
    throw new Error(`${label} did not forward a recovery chat-completion request.`);
  }
}

function assertRepeatedFailpointFallback(proxyRef, fallbackRetryRecorded, label) {
  if (proxyRef.state.failpointLimit < 2) return;
  if (proxyRef.state.forwardedNonStreamChatCompletionCount < 1) {
    throw new Error(`Expected ${label} to recover through a non-stream fallback after repeated stream interruptions.`);
  }
  if (!fallbackRetryRecorded) {
    throw new Error(`Expected ${label} retry activity to record fallbackToNonStream after repeated stream interruptions.`);
  }
}

async function startRefreshSources(cdp, boardId) {
  await evaluate(
    cdp,
    `
    (() => {
      window.__projectBoardDirectHelperRetry = {
        refreshResolved: false,
        error: undefined,
      };
      window.ambientDesktop.refreshProjectBoardSources({ boardId: ${JSON.stringify(boardId)} })
        .then(() => {
          window.__projectBoardDirectHelperRetry.refreshResolved = true;
        })
        .catch((error) => {
          window.__projectBoardDirectHelperRetry.error = error instanceof Error ? error.message : String(error);
        });
      return true;
    })()
  `,
  );
}

async function answerKickoffQuestions(cdp, boardId) {
  let state = await desktopState(cdp);
  let board = boardForId(state, boardId);
  if (!board) throw new Error(`Project board not found before kickoff answers: ${boardId}`);
  for (const question of (board.questions ?? []).filter((candidate) => !candidate.answer)) {
    state = await evaluate(
      cdp,
      `
      window.ambientDesktop.answerProjectBoardQuestion({
        questionId: ${JSON.stringify(question.id)},
        answer: ${JSON.stringify(answerForKickoffQuestion(question.question))}
      })
    `,
    );
    board = boardForId(state, boardId);
  }
}

function answerForKickoffQuestion(question) {
  const normalized = String(question ?? "").toLowerCase();
  if (/\b(primary|outcome|optimize|goal)\b/.test(normalized)) {
    return "Ship a narrow playable WebGL spaceship logistics slice with visible movement, cargo routing, hazards, scoring, and restart proof.";
  }
  if (/\b(source|authoritative|docs|threads)\b/.test(normalized)) {
    return "Treat README, project brief, and technical notes as authoritative. Ignore scratch notes unless a human explicitly reclassifies them.";
  }
  if (/\b(judgment|decision|handle|executing)\b/.test(normalized)) {
    return "Prefer small reversible implementation choices, ask focused PM questions when sources conflict, and keep decisions grounded in the charter.";
  }
  if (/\b(proof|review|test|done)\b/.test(normalized)) {
    return "Require unit coverage, visual smoke proof, and explicit acceptance notes before marking implementation cards complete.";
  }
  return "Keep the first board small, deterministic, and proof-oriented so Ambient/Pi can generate executable cards without broad product expansion.";
}

async function startFinalizeKickoff(cdp, boardId) {
  await evaluate(
    cdp,
    `
    (() => {
      window.__projectBoardDirectHelperRetry = {
        finalizeResolved: false,
        error: undefined,
      };
      window.ambientDesktop.finalizeProjectBoardKickoff({ boardId: ${JSON.stringify(boardId)} })
        .then(() => {
          window.__projectBoardDirectHelperRetry.finalizeResolved = true;
        })
        .catch((error) => {
          window.__projectBoardDirectHelperRetry.error = error instanceof Error ? error.message : String(error);
        });
      return true;
    })()
  `,
  );
}

async function startProofJudgmentReview(cdp, boardId) {
  await evaluate(
    cdp,
    `
    (() => {
      window.__projectBoardDirectHelperRetry = {
        proofResolved: false,
        proofResult: undefined,
        error: undefined,
      };
      window.ambientDesktop.seedProjectBoardProofJudgmentDogfood({ boardId: ${JSON.stringify(boardId)} })
        .then((result) => {
          window.__projectBoardDirectHelperRetry.proofResolved = true;
          window.__projectBoardDirectHelperRetry.proofResult = result;
        })
        .catch((error) => {
          window.__projectBoardDirectHelperRetry.error = error instanceof Error ? error.message : String(error);
        });
      return true;
    })()
  `,
  );
}

async function waitForSourceClassificationRetryEvent(cdp, boardId, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const state = await desktopState(cdp);
    const retryEvent = findSourceClassificationRetryEvent(state, boardId);
    if (retryEvent) {
      const error = String(retryEvent.metadata?.error ?? "");
      if (!error.includes("without model content")) {
        throw new Error(`Expected content-idle retry diagnostic, got: ${error}`);
      }
      return retryEvent;
    }
    const harness = await refreshHarnessState(cdp);
    if (harness?.error) throw new Error(harness.error);
    await delay(1_000);
  }
  throw new Error("Timed out waiting for source-classification retry activity.");
}

async function waitForCharterSummaryRetryEvent(cdp, boardId, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const state = await desktopState(cdp);
    const retryEvent = findCharterSummaryRetryEvent(state, boardId);
    if (retryEvent) {
      const error = String(retryEvent.metadata?.error ?? "");
      if (!error.includes("without model content")) {
        throw new Error(`Expected charter-summary content-idle retry diagnostic, got: ${error}`);
      }
      return retryEvent;
    }
    const harness = await refreshHarnessState(cdp);
    if (harness?.error) throw new Error(harness.error);
    await delay(1_000);
  }
  throw new Error("Timed out waiting for charter-summary retry activity.");
}

async function waitForCharterSummaryAppliedEvent(cdp, boardId, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const state = await desktopState(cdp);
    const appliedEvent = findProjectBoardRunEvent(state, boardId, "Applied Pi charter project summary");
    if (appliedEvent) return appliedEvent;
    const harness = await refreshHarnessState(cdp);
    if (harness?.error) throw new Error(harness.error);
    await delay(1_000);
  }
  throw new Error("Timed out waiting for recovered charter summary to be applied.");
}

async function waitForProofJudgmentRetryEvent(cdp, boardId, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const state = await desktopState(cdp);
    const retryEvent = findProofJudgmentRetryEvent(state, boardId);
    if (retryEvent) {
      const error = String(retryEvent.metadata?.error ?? "");
      if (!error.includes("without model content")) {
        throw new Error(`Expected proof-judgment content-idle retry diagnostic, got: ${error}`);
      }
      return retryEvent;
    }
    const harness = await refreshHarnessState(cdp);
    if (harness?.error) throw new Error(harness.error);
    await delay(1_000);
  }
  throw new Error("Timed out waiting for proof-judgment retry activity.");
}

async function waitForProofJudgmentCompletion(cdp, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const harness = await refreshHarnessState(cdp);
    if (harness?.error) throw new Error(harness.error);
    if (harness?.proofResolved && harness.proofResult) return harness.proofResult;
    await delay(1_000);
  }
  throw new Error("Timed out waiting for recovered proof judgment to be applied.");
}

async function waitForRefreshCompletion(cdp, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const harness = await refreshHarnessState(cdp);
    if (harness?.error) throw new Error(harness.error);
    if (harness?.refreshResolved) return;
    await delay(1_000);
  }
  throw new Error("Timed out waiting for Refresh Sources to settle.");
}

function findSourceClassificationRetryEvent(state, boardId) {
  return findProjectBoardRunEvent(state, boardId, "Retrying Pi source classification", (event) => event.metadata?.transientRetry === true && event.metadata?.aggressiveRetries === true);
}

function findCharterSummaryRetryEvent(state, boardId) {
  return findProjectBoardRunEvent(state, boardId, "Retrying Pi charter summary", (event) => event.metadata?.transientRetry === true && event.metadata?.aggressiveRetries === true);
}

function findProofJudgmentRetryEvent(state, boardId) {
  const board = boardForId(state, boardId);
  return (board?.events ?? [])
    .filter(
      (event) =>
        event.title === "Retrying Pi proof judgment" &&
        event.kind === "card_run_progress" &&
        event.metadata?.transientRetry === true &&
        event.metadata?.aggressiveRetries === true,
    )
    .at(-1);
}

function findRetryEventForTarget(target, state, boardId) {
  if (!state || !boardId) return undefined;
  if (target === "source-classification") return findSourceClassificationRetryEvent(state, boardId);
  if (target === "charter-summary") return findCharterSummaryRetryEvent(state, boardId);
  if (target === "proof-judgment") return findProofJudgmentRetryEvent(state, boardId);
  return undefined;
}

function hasFallbackRetryEventForTarget(target, state, boardId) {
  if (!state || !boardId) return false;
  if (target === "source-classification") {
    return findProjectBoardRunEvents(state, boardId, "Retrying Pi source classification", isAggressiveTransientRetryEvent).some(
      (event) => event.metadata?.fallbackToNonStream === true,
    );
  }
  if (target === "charter-summary") {
    return findProjectBoardRunEvents(state, boardId, "Retrying Pi charter summary", isAggressiveTransientRetryEvent).some(
      (event) => event.metadata?.fallbackToNonStream === true,
    );
  }
  if (target === "proof-judgment") {
    const board = boardForId(state, boardId);
    return (board?.events ?? []).some(
      (event) =>
        event.title === "Retrying Pi proof judgment" &&
        event.kind === "card_run_progress" &&
        isAggressiveTransientRetryEvent(event) &&
        event.metadata?.fallbackToNonStream === true,
    );
  }
  return false;
}

function isAggressiveTransientRetryEvent(event) {
  return event.metadata?.transientRetry === true && event.metadata?.aggressiveRetries === true;
}

function retryEventSummaryForTarget(target, event) {
  const base = {
    title: event.title,
    summary: event.summary,
    transientRetry: event.metadata?.transientRetry,
    aggressiveRetries: event.metadata?.aggressiveRetries,
    retryAttempt: event.metadata?.retryAttempt,
    maxRetries: event.metadata?.maxRetries,
    retryDelayMs: event.metadata?.retryDelayMs,
    error: event.metadata?.error,
    fallbackToNonStream: event.metadata?.fallbackToNonStream,
    responseCharCount: event.metadata?.responseCharCount,
  };
  return target === "proof-judgment" ? { ...base, kind: event.kind } : { ...base, stage: event.stage };
}

function findProjectBoardRunEvent(state, boardId, title, predicate = () => true) {
  return findProjectBoardRunEvents(state, boardId, title, predicate).at(-1);
}

function findProjectBoardRunEvents(state, boardId, title, predicate = () => true) {
  const board = boardForId(state, boardId);
  return (board?.synthesisRuns ?? [])
    .flatMap((run) => run.events ?? [])
    .filter((event) => event.title === title && predicate(event));
}

function latestRunForBoard(board, boardId) {
  return (board?.synthesisRuns ?? []).filter((run) => run.boardId === boardId).at(-1);
}

function activeBoard(state) {
  return state.projects.find((project) => project.path === state.workspace.path)?.board ?? state.projects.find((project) => project.board)?.board;
}

function boardForId(state, boardId) {
  return state.projects.map((project) => project.board).find((board) => board?.id === boardId);
}

function findCardById(board, cardId) {
  if (!board || !cardId) return undefined;
  return (board.cards ?? []).find((card) => card.id === cardId);
}

function activeProjectId(state) {
  const project = state.projects.find((item) => item.path === state.workspace.path) ?? state.projects[0];
  if (!project?.id) throw new Error("Could not resolve active project id.");
  return project.id;
}

async function refreshHarnessState(cdp) {
  return evaluate(
    cdp,
    `
    (() => {
      const value = window.__projectBoardDirectHelperRetry;
      return value ? { ...value } : undefined;
    })()
  `,
  );
}

async function desktopState(cdp) {
  return evaluate(cdp, "window.ambientDesktop.bootstrap()");
}

async function waitForTarget(port, childExitState = () => undefined) {
  lastCdpProbe = undefined;
  const deadline = Date.now() + electronTargetTimeoutMs;
  while (Date.now() < deadline) {
    const childExit = childExitState();
    if (childExit) {
      throw new Error(`Electron exited before exposing CDP target: ${JSON.stringify(childExit)}. Last CDP probe: ${JSON.stringify(lastCdpProbe ?? {})}`);
    }
    try {
      const version = await fetchJsonWithTimeout(`http://127.0.0.1:${port}/json/version`, 2_000);
      lastCdpProbe = {
        checkedAt: new Date().toISOString(),
        port,
        browserEndpoint: Boolean(version?.webSocketDebuggerUrl),
        browser: version?.Browser,
      };
      const targets = await fetchJsonWithTimeout(`http://127.0.0.1:${port}/json/list`, 2_000);
      lastCdpProbe = {
        ...lastCdpProbe,
        targets: summarizeCdpTargets(targets),
      };
      const target = targets.find((item) => item.webSocketDebuggerUrl && item.type === "page");
      if (target?.webSocketDebuggerUrl) return target;
    } catch (error) {
      lastCdpProbe = {
        checkedAt: new Date().toISOString(),
        port,
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
      server.close(() => (port ? resolve(port) : reject(new Error("Could not allocate a port."))));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeProxy(proxyRef) {
  if (!proxyRef?.server) return;
  proxyRef.server.closeAllConnections?.();
  for (const socket of proxyRef.sockets ?? []) socket.destroy();
  await Promise.race([new Promise((resolve) => proxyRef.server.close(resolve)), delay(1_000)]);
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
  await runIgnoringFailure("pkill", ["-f", `${cwdPattern}.*remoteDebuggingPort ${cdpPort}`]);
  await runIgnoringFailure("pkill", ["-f", `electron-vite dev.*remoteDebuggingPort ${cdpPort}`]);
  await runIgnoringFailure("pkill", ["-f", `${cwdPattern}.*remote-debugging-port=${cdpPort}`]);
  await runIgnoringFailure("pkill", ["-f", `electron-vite dev.*remote-debugging-port=${cdpPort}`]);
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
