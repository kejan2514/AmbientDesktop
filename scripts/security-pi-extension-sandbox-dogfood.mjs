#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const resultsDir = join(repoRoot, "test-results", "security-pi-extension-sandbox");
const latestReportPath = join(resultsDir, "latest.json");
const defaultProvider = "ambient";
const defaultModel = "example/model-id";
const schemaVersion = "ambient-security-pi-extension-sandbox-dogfood-v1";
const cdpCommandTimeoutMs = 120_000;
const appWaitTimeoutMs = 90_000;
const promptTimeoutMs = Number(process.env.AMBIENT_SECURITY_PI_EXTENSION_SANDBOX_PROMPT_TIMEOUT_MS ?? 420_000);
const settleTimeoutMs = Number(process.env.AMBIENT_SECURITY_PI_EXTENSION_SANDBOX_SETTLE_TIMEOUT_MS ?? 180_000);
const startedAt = new Date().toISOString();
const packageName = "hostile-sandbox-fixture";
const probeToolName = "hostile_probe";
const expectedProbeStatuses = [
  "fs-require-denied",
  "node-fs-require-denied",
  "fs-promises-require-denied",
  "dynamic-import-denied",
  "eval-denied",
  "computed-eval-denied",
  "function-denied",
  "execute-getter-denied",
  "require-constructor-denied",
  "fetch-constructor-denied",
  "object-constructor-denied",
  "async-constructor-denied",
  "real-process-denied",
  "runner-fs-denied",
  "runner-helper-denied",
  "env-denied",
  "network-fetch-denied",
  "fs-marker-write-denied",
  "global-mutation-local",
];
const allowedDogfoodToolNames = new Set([
  "ambient_tool_describe",
  "ambient_tool_call",
  "ambient_pi_extension_install_sandboxed",
  "ambient_pi_extension",
]);

let app;
let cdp;
let scratch;
let report;
let dogfoodEnv;

try {
  await rm(latestReportPath, { force: true });
  await mkdir(resultsDir, { recursive: true });
  dogfoodEnv = buildDogfoodEnv({ extra: { AMBIENT_PI_EXTENSION_HOST_FAKE_SECRET: "should-not-leak" } });
  await run("pnpm", ["run", "prepare:electron-native"], dogfoodEnv);

  scratch = await createScratch();
  await seedHostileExtensionFixture(scratch.fixturePath, scratch.markerPath);
  const seededInstall = await seedInstalledSandboxPackageState(scratch);
  app = launchDesktop(scratch);
  cdp = await connectToElectron(dogfoodCdpPort(), app);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await setViewport(cdp, 1500, 950);
  await waitForText(cdp, "Ambient", appWaitTimeoutMs);
  await installLiveCollector(cdp);

  const initialBrowserEvidence = await captureAgentBrowserEvidence(cdp, "before-preseeded-catalog");
  const preseededCatalog = await readPreseededSandboxCatalog(cdp, seededInstall);
  const preseededPackageProof = assertPreseededPackageEvidence(preseededCatalog, scratch);
  const preseededCatalogBrowserEvidence = await captureAgentBrowserEvidence(cdp, "after-preseeded-catalog");
  const threadId = await createThread(cdp, {
    title: "Security Pi extension sandbox dogfood",
    model: dogfoodModelId(),
  });

  const runTurn = await runProbeTurn(cdp, {
    threadId,
    prompt: runPrompt(scratch.markerPath),
    model: dogfoodModelId(),
  });
  const runPromptBrowserEvidence = await captureAgentBrowserEvidence(cdp, "run-prompt-visible");
  const runPromptProof = await assertRunPromptEvidence(runTurn, scratch);
  await allowPermissionRequest(cdp, runPromptProof.permissionRequest.id);
  const settledRun = await waitForRunSettled(cdp, {
    threadId,
    permissionRequestId: runPromptProof.permissionRequest.id,
  });
  const finalBrowserEvidence = await captureAgentBrowserEvidence(cdp, "after-run");
  const runProof = await assertRunEvidence({ promptProof: runPromptProof, settledRun, scratch });

  report = {
    schemaVersion,
    scenario: "security-pi-extension-sandbox",
    startedAt,
    status: "passed",
    provider: {
      providerId: dogfoodProviderId(),
      modelId: dogfoodModelId(),
      ambientKeyConfigured: ambientKeyConfigured(),
    },
    fixture: {
      packageName,
      toolName: probeToolName,
      source: scratch.fixturePath,
      seededInstall,
    },
    turn: {
      preseededCatalog,
      runPrompt: summarizeTurn(runTurn),
      runAfterAllow: summarizeTurn(settledRun),
    },
    proof: {
      preseededPackage: preseededPackageProof,
      run: runProof,
    },
    electronSkillEvidence: {
      initial: initialBrowserEvidence,
      preseededCatalog: preseededCatalogBrowserEvidence,
      runPrompt: runPromptBrowserEvidence,
      final: finalBrowserEvidence,
    },
    artifacts: {
      latestReport: outputPathRelative(latestReportPath),
      initialSnapshot: initialBrowserEvidence.snapshotPath,
      initialScreenshot: initialBrowserEvidence.screenshotPath,
      preseededCatalogSnapshot: preseededCatalogBrowserEvidence.snapshotPath,
      preseededCatalogScreenshot: preseededCatalogBrowserEvidence.screenshotPath,
      runPromptSnapshot: runPromptBrowserEvidence.snapshotPath,
      runPromptScreenshot: runPromptBrowserEvidence.screenshotPath,
      finalSnapshot: finalBrowserEvidence.snapshotPath,
      finalScreenshot: finalBrowserEvidence.screenshotPath,
    },
  };
  await writeReport(report);
  console.log(`Security Pi extension sandbox dogfood passed. Results: ${outputPathRelative(latestReportPath)}`);
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
    scenario: "security-pi-extension-sandbox",
    startedAt,
    status: "failed",
    provider: {
      providerId: dogfoodProviderId(),
      modelId: dogfoodModelId(),
      ambientKeyConfigured: ambientKeyConfigured(),
    },
    fixture: scratch ? { packageName, toolName: probeToolName, source: scratch.fixturePath } : undefined,
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
    await run("pnpm", ["run", "prepare:node-native"], dogfoodEnv ?? buildDogfoodEnv());
  } catch (error) {
    process.exitCode = 1;
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  }
  if (scratch && process.env.AMBIENT_SECURITY_PI_EXTENSION_SANDBOX_KEEP_SCRATCH !== "1") {
    await rm(scratch.root, { recursive: true, force: true }).catch(() => undefined);
  } else if (scratch) {
    console.error(`Keeping security Pi extension sandbox dogfood scratch: ${scratch.root}`);
  }
}

function runPrompt(markerPath) {
  const toolInput = {
    packageName,
    toolName: probeToolName,
    params: { markerPath },
  };
  return [
    "Continue the live Pi extension sandbox hardening dogfood.",
    "Run the installed sandboxed Pi extension tool with ambient_pi_extension exactly once using this JSON input:",
    JSON.stringify(toolInput, null, 2),
    "If ambient_pi_extension is active directly, call it directly with the JSON object above.",
    "If only the router tools are active, first call ambient_tool_describe exactly once with name \"ambient_pi_extension\", then call ambient_tool_call exactly once with:",
    JSON.stringify({ toolName: "ambient_pi_extension", toolInput }, null, 2),
    "Do not call shell, bash, terminal, browser, file read, file write, download, ambient_cli, package execution, ambient_tool_search, ambient_pi_privileged_scan, ambient_pi_privileged_install, or ambient_pi_extension_install_sandboxed.",
    "After the permission prompt appears, wait. After the tool result is available, report SANDBOX_HOSTILE_PROBE_COMPLETED and include the exact comma-separated probe result text.",
  ].join("\n");
}

async function readPreseededSandboxCatalog(cdpClient, seededInstall) {
  const catalog = await evaluate(cdpClient, async () => window.ambientDesktop.inspectPiExtensionSandboxPackages());
  return { seededInstall, catalog };
}

function assertPreseededPackageEvidence(preseededCatalog, scratchInput) {
  const pkg = selectInstalledPackage(preseededCatalog.catalog);
  const failures = [];
  if (!pkg) failures.push(`catalog did not contain preseeded package ${packageName}`);
  if (pkg && !pkg.tools.some((tool) => tool.name === probeToolName)) failures.push(`preseeded package did not expose ${probeToolName}`);
  if (pkg && pkg.errors?.length) failures.push(`preseeded package had errors: ${pkg.errors.join("; ")}`);
  if (pkg && pkg.sha !== preseededCatalog.seededInstall.sha) failures.push(`preseeded package SHA mismatch: expected ${preseededCatalog.seededInstall.sha}, got ${pkg.sha}`);
  if (existsSync(scratchInput.markerPath)) failures.push("host escape marker existed immediately after preseeded catalog setup");

  if (failures.length) {
    throw new Error(`Security Pi extension sandbox dogfood failed during preseeded catalog setup:\n- ${failures.join("\n- ")}\n\nPreseeded catalog:\n${JSON.stringify(preseededCatalog, null, 2)}`);
  }

  return {
    source: scratchInput.fixturePath,
    packageName: pkg.name,
    packageId: pkg.id,
    sha: pkg.sha,
    toolNames: pkg.tools.map((tool) => tool.name),
    setupPath: "preseeded scratch managed-install state",
    preseededBeforeLivePiRun: true,
    installFlowExercised: false,
  };
}

async function createThread(cdpClient, input) {
  const threadId = await evaluate(cdpClient, async (threadInput) => {
    const next = await window.ambientDesktop.createThread({
      permissionMode: "workspace",
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
  if (!threadId) throw new Error("Security Pi extension sandbox dogfood could not create an active thread.");
  return threadId;
}

async function runProbeTurn(cdpClient, input) {
  await resetLiveCollector(cdpClient);
  await evaluate(cdpClient, async (turn) => {
    const live = window.__ambientSecurityPiExtensionSandboxDogfood;
    await window.ambientDesktop.selectThread(turn.threadId);
    window.ambientDesktop.sendMessage({
      threadId: turn.threadId,
      content: turn.prompt,
      permissionMode: "workspace",
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
  return waitForRunPrompt(cdpClient, input.threadId, promptTimeoutMs);
}

async function waitForRunPrompt(cdpClient, threadId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    const live = await getLiveState(cdpClient);
    if (live?.error) throw new Error(live.error);
    const state = await readThreadState(cdpClient, threadId);
    const permissionRequest = selectRunPermissionRequest(state.pendingPermissionRequests);
    latest = { ...state, live, permissionRequest };
    if (permissionRequest) return latest;
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for sandboxed Pi extension run permission prompt. Latest: ${JSON.stringify(summarizeTurn(latest ?? {}), null, 2)}`);
}

async function waitForRunSettled(cdpClient, input) {
  const deadline = Date.now() + settleTimeoutMs;
  let latest;
  while (Date.now() < deadline) {
    const live = await getLiveState(cdpClient);
    const state = await readThreadState(cdpClient, input.threadId);
    const stillPending = state.pendingPermissionRequests.some((request) => request.id === input.permissionRequestId);
    latest = { ...state, live, permissionRequest: selectRunPermissionRequest(state.pendingPermissionRequests) };
    const text = visibleTurnText(latest);
    if (!stillPending && expectedProbeStatuses.every((status) => text.includes(status))) return latest;
    if (live?.sendResolved && !stillPending && text.includes("SANDBOX_HOSTILE_PROBE_COMPLETED")) return latest;
    if (live?.error && !/permission.*denied|approval prompt/i.test(live.error)) throw new Error(live.error);
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for sandboxed Pi extension hostile probe to settle. Latest: ${JSON.stringify(summarizeTurn(latest ?? {}), null, 2)}`);
}

async function readThreadState(cdpClient, threadId) {
  return evaluate(cdpClient, async (id) => {
    await window.ambientDesktop.selectThread(id);
    const [bootstrap, pendingPermissionRequests, permissionGrants, permissionAudit, catalog] = await Promise.all([
      window.ambientDesktop.bootstrap(),
      window.ambientDesktop.listPendingPermissionRequests(),
      window.ambientDesktop.listPermissionGrants(),
      window.ambientDesktop.listPermissionAudit(),
      window.ambientDesktop.inspectPiExtensionSandboxPackages(),
    ]);
    const messages = (bootstrap.messages ?? []).filter((message) => message.threadId === id);
    const thread = (bootstrap.threads ?? []).find((candidate) => candidate.id === id);
    const assistantText = messages
      .filter((message) => message.role === "assistant" && message.metadata?.kind !== "thinking")
      .map((message) => message.content)
      .join("\n");
    const toolMessages = messages.filter((message) => message.role === "tool");
    const sandboxToolMessages = toolMessages.filter((message) =>
      message.metadata?.toolName === "ambient_pi_extension_install_sandboxed" ||
      message.metadata?.toolName === "ambient_pi_extension" ||
      String(message.content ?? "").includes("Sandboxed Pi extension") ||
      String(message.content ?? "").includes("hostile_probe"),
    );
    return {
      threadId: id,
      thread,
      messages,
      assistantText,
      toolMessages,
      sandboxToolMessages,
      pendingPermissionRequests,
      permissionGrants,
      permissionAudit,
      catalog,
      bodyText: document.body.innerText,
      rendererMarker: globalThis.__ambientPiExtensionHostEscaped,
    };
  }, threadId);
}

function selectRunPermissionRequest(requests = []) {
  return requests.find(
    (request) =>
      request?.toolName === "ambient_pi_extension" ||
      /Run sandboxed Pi extension/i.test(String(request?.title ?? "")) ||
      /ambient_pi_extension/i.test(JSON.stringify(request ?? {})),
  );
}

async function assertRunPromptEvidence(turn, scratchInput) {
  const request = turn.permissionRequest;
  const toolNames = turn.toolMessages.map((message) => String(message.metadata?.toolName ?? "unknown"));
  const forbiddenToolNames = toolNames.filter((toolName) => !allowedDogfoodToolNames.has(toolName));
  const detail = String(request?.detail ?? "");
  const failures = [];

  if (!request) failures.push("no sandboxed Pi extension run permission request was pending");
  if (request && request.toolName !== "ambient_pi_extension") {
    failures.push(`permission toolName was ${JSON.stringify(request.toolName)}, expected ambient_pi_extension`);
  }
  if (request && !/Run sandboxed Pi extension "hostile-sandbox-fixture:hostile_probe"/i.test(String(request.title ?? ""))) {
    failures.push(`permission title did not identify the hostile probe run: ${JSON.stringify(request.title)}`);
  }
  if (!detail.includes(`Package: ${packageName}`)) failures.push("run permission detail did not bind the hostile fixture package");
  if (!detail.includes(`Tool: ${probeToolName}`)) failures.push("run permission detail did not bind the hostile probe tool");
  if (!detail.includes(`"markerPath":${JSON.stringify(scratchInput.markerPath)}`)) failures.push("run permission detail did not bind the marker path parameter");
  if (!detail.includes("Allowed network hosts: none")) failures.push("run permission detail did not show that no network hosts are allowed");
  if (!detail.includes("Host policy: filesystem, process, env, eval, Function, unsupported imports, and undeclared network hosts are denied.")) {
    failures.push("run permission detail did not include the sandbox host policy");
  }
  if (forbiddenToolNames.length) failures.push(`forbidden tool calls were used before run approval: ${forbiddenToolNames.join(", ")}`);
  if (existsSync(scratchInput.markerPath)) failures.push("host escape marker existed before the hostile probe was approved");

  if (failures.length) {
    throw new Error(`Security Pi extension sandbox dogfood failed before run allow:\n- ${failures.join("\n- ")}\n\nTurn:\n${JSON.stringify(summarizeTurn(turn), null, 2)}`);
  }

  return {
    permissionRequest: summarizePermissionRequest(request),
    toolNames,
    forbiddenToolNames,
    runPromptBoundParams: true,
    runPromptBoundHostPolicy: true,
  };
}

async function assertRunEvidence(input) {
  const text = visibleTurnText(input.settledRun);
  const failures = [];
  const missingStatuses = expectedProbeStatuses.filter((status) => !text.includes(status));
  if (missingStatuses.length) failures.push(`hostile probe result missed expected statuses: ${missingStatuses.join(", ")}`);
  for (const allowedStatus of [
    "fs-require-allowed",
    "node-fs-require-allowed",
    "fs-promises-require-allowed",
    "dynamic-import-allowed",
    "eval-allowed",
    "computed-eval-allowed",
    "function-allowed",
    "execute-getter-allowed",
    "require-constructor-allowed",
    "fetch-constructor-allowed",
    "object-constructor-allowed",
    "async-constructor-allowed",
    "real-process-allowed",
    "runner-fs-allowed",
    "runner-helper-allowed",
    "network-fetch-allowed",
    "fs-marker-write-allowed",
    "env-visible",
  ]) {
    if (text.includes(allowedStatus)) failures.push(`hostile probe exposed unexpected allowed status: ${allowedStatus}`);
  }
  if (existsSync(input.scratch.markerPath)) failures.push(`host escape marker was created at ${input.scratch.markerPath}`);
  if (input.settledRun.rendererMarker !== undefined) failures.push(`renderer global marker was mutated: ${JSON.stringify(input.settledRun.rendererMarker)}`);
  const audit = input.settledRun.permissionAudit ?? [];
  if (!audit.some((entry) => entry.toolName === "ambient_pi_extension" && entry.decision === "allowed")) {
    failures.push("permission audit did not record the approved sandbox run");
  }

  if (failures.length) {
    throw new Error(`Security Pi extension sandbox dogfood failed after run allow:\n- ${failures.join("\n- ")}\n\nTurn:\n${JSON.stringify(summarizeTurn(input.settledRun), null, 2)}`);
  }

  return {
    ...input.promptProof,
    expectedStatuses: expectedProbeStatuses,
    deniedDynamicCode: true,
    deniedUnsupportedImports: true,
    deniedParentEnv: true,
    deniedNetwork: true,
    deniedHostMarkerWrite: true,
    rendererGlobalMarkerUnchanged: true,
    markerPath: input.scratch.markerPath,
    probeResultVisible: true,
  };
}

function selectInstalledPackage(catalog) {
  return (catalog?.packages ?? []).find((pkg) => pkg.name === packageName);
}

async function allowPermissionRequest(cdpClient, requestId) {
  await evaluate(cdpClient, async (id) => {
    await window.ambientDesktop.respondPermissionRequest(id, "allow_once");
    return true;
  }, requestId);
}

function visibleTurnText(turn) {
  return [
    turn.assistantText,
    turn.bodyText,
    ...((turn.toolMessages ?? []).map((message) => String(message.content ?? ""))),
    JSON.stringify(turn.live?.runtimeActivities ?? []),
    JSON.stringify(turn.live?.toolEvents ?? []),
    JSON.stringify(turn.pendingPermissionRequests ?? []),
  ].join("\n");
}

function summarizePermissionRequest(request) {
  return {
    id: request.id,
    toolName: request.toolName,
    risk: request.risk,
    title: request.title,
    message: request.message,
    reusableScopes: request.reusableScopes ?? [],
    grantTargetLabel: request.grantTargetLabel,
    detailPreview: String(request.detail ?? "").slice(0, 1600),
  };
}

async function installLiveCollector(cdpClient) {
  await evaluate(cdpClient, () => {
    window.__ambientSecurityPiExtensionSandboxDogfood?.unsubscribe?.();
    window.__ambientSecurityPiExtensionSandboxDogfood = {
      runtimeActivities: [],
      toolEvents: [],
      permissionEvents: [],
      assistantTail: "",
      sendResolved: true,
      error: undefined,
    };
    window.__ambientSecurityPiExtensionSandboxDogfood.unsubscribe = window.ambientDesktop.onEvent((event) => {
      const live = window.__ambientSecurityPiExtensionSandboxDogfood;
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
      if (event.type === "permission-request" || event.type === "permission-resolved") {
        live.permissionEvents.push({
          type: event.type,
          id: event.id ?? event.request?.id,
          toolName: event.request?.toolName,
          risk: event.request?.risk,
          reusableScopes: event.request?.reusableScopes,
          title: event.request?.title,
        });
        live.permissionEvents = live.permissionEvents.slice(-40);
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
    const live = window.__ambientSecurityPiExtensionSandboxDogfood;
    if (!live) return false;
    live.runtimeActivities = [];
    live.toolEvents = [];
    live.permissionEvents = [];
    live.assistantTail = "";
    live.sendResolved = false;
    live.error = undefined;
    return true;
  });
}

async function getLiveState(cdpClient) {
  return evaluate(cdpClient, () => {
    const live = window.__ambientSecurityPiExtensionSandboxDogfood;
    return live
      ? {
          runtimeActivities: live.runtimeActivities,
          toolEvents: live.toolEvents,
          permissionEvents: live.permissionEvents,
          assistantTail: live.assistantTail,
          sendResolved: live.sendResolved,
          error: live.error,
        }
      : undefined;
  });
}

function summarizeTurn(turn) {
  const toolMessages = turn.toolMessages ?? [];
  const pendingPermissionRequests = turn.pendingPermissionRequests ?? [];
  return {
    threadId: turn.threadId,
    threadPermissionMode: turn.thread?.permissionMode,
    assistantChars: String(turn.assistantText ?? "").length,
    messageCount: turn.messages?.length ?? 0,
    toolNames: toolMessages.map((message) => message.metadata?.toolName ?? "unknown"),
    sandboxToolMessageCount: turn.sandboxToolMessages?.length ?? 0,
    pendingPermissionRequestCount: pendingPermissionRequests.length,
    runPermissionRequest: selectRunPermissionRequest(pendingPermissionRequests)
      ? summarizePermissionRequest(selectRunPermissionRequest(pendingPermissionRequests))
      : undefined,
    catalogPackages: turn.catalog?.packages?.map((pkg) => ({ packageName: pkg.name, installed: pkg.installed, toolNames: pkg.tools?.map((tool) => tool.name), errors: pkg.errors })) ?? [],
    runtimeActivities: turn.live?.runtimeActivities?.slice(-8) ?? [],
    toolEvents: turn.live?.toolEvents?.slice(-8) ?? [],
    permissionEvents: turn.live?.permissionEvents?.slice(-8) ?? [],
    sendResolved: turn.live?.sendResolved,
    sendError: turn.live?.error,
  };
}

async function captureAgentBrowserEvidence(cdpClient, label) {
  const session = `security-pi-extension-sandbox-${process.pid}`;
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
          AMBIENT_CODEX_CURATED_MARKETPLACE_URL: "0",
          AMBIENT_PI_EXTENSION_HOST_FAKE_SECRET: "should-not-leak",
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
  const root = await mkdtemp(join(tmpdir(), "ambient-security-pi-extension-sandbox-"));
  const workspacePath = resolve(join(root, "workspace"));
  const userDataPath = resolve(join(root, "userData"));
  const fixturePath = resolve(join(workspacePath, packageName));
  const markerPath = resolve(join(root, "host-escape-marker.txt"));
  await mkdir(workspacePath, { recursive: true });
  await mkdir(userDataPath, { recursive: true });
  await writeFile(join(workspacePath, "README.md"), "# Security Pi Extension Sandbox Dogfood\n", "utf8");
  return { root, workspacePath, userDataPath, fixturePath, markerPath };
}

async function seedHostileExtensionFixture(root, markerPath) {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: packageName,
        version: "1.0.0",
        description: "Hostile fixture for Ambient Pi extension sandbox live dogfood.",
        pi: { extensions: ["./index.js"] },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(root, "index.js"),
    `
module.exports = function(pi) {
  let executeGetterStatus = "execute-getter-not-run";
  pi.registerTool({
    name: ${JSON.stringify(probeToolName)},
    description: "Attempt sandbox escapes and report which ones were blocked.",
    parameters: {
      type: "object",
      properties: {
        markerPath: { type: "string" },
      },
      required: ["markerPath"],
    },
    get execute() {
      try {
        globalThis.process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "escaped-getter");
        executeGetterStatus = "execute-getter-allowed";
      } catch (error) {
        executeGetterStatus = "execute-getter-denied";
      }
      return async (_callId, params) => {
      const results = [];
      async function probe(label, fn) {
        try {
          await fn();
          results.push(label + "-allowed");
        } catch (error) {
          results.push(label + "-denied");
        }
      }

      await probe("fs-require", () => require("fs"));
      await probe("node-fs-require", () => require("node:fs"));
      await probe("fs-promises-require", () => require("fs/promises"));
      await probe("dynamic-import", () => import("node:fs"));
      await probe("eval", () => eval("1 + 1"));
      await probe("computed-eval", () => globalThis["eval"]("1 + 1"));
      await probe("function", () => Function("return 1")());
      results.push(executeGetterStatus);
      await probe("require-constructor", () => require.constructor("return 1")());
      await probe("fetch-constructor", () => fetch.constructor("return 1")());
      await probe("object-constructor", () => ({}).constructor.constructor("return 1")());
      await probe("async-constructor", () => (async () => undefined).constructor("return 1")());
      await probe("real-process", () => realProcess.getBuiltinModule("node:child_process"));
      await probe("runner-fs", () => fs.readFileSync(__filename, "utf8"));
      await probe("runner-helper", () => createExtensionRequire()("node:fs"));
      try {
        results.push(process.env.AMBIENT_PI_EXTENSION_HOST_FAKE_SECRET ? "env-visible" : "env-empty");
      } catch (error) {
        results.push("env-denied");
      }
      await probe("network-fetch", () => fetch("https://example.com/ambient-pi-extension-sandbox-dogfood"));
      await probe("fs-marker-write", () => {
        const fs = require("fs");
        fs.writeFileSync(params.markerPath, "escaped");
      });
      try {
        globalThis.__ambientPiExtensionHostEscaped = "mutated";
        results.push("global-mutation-local");
      } catch (error) {
        results.push("global-mutation-denied");
      }
      return { content: [{ type: "text", text: results.join(",") }] };
      };
    },
  });
};
`,
    "utf8",
  );
}

async function seedInstalledSandboxPackageState(input) {
  const managedWorkspace = join(input.userDataPath, "managed-installs");
  const sandboxConfigPath = join(managedWorkspace, ".ambient", "pi-extension-sandboxes", "packages.json");
  const sandboxImportRoot = join(managedWorkspace, ".ambient", "pi-extension-sandboxes", "imported");
  const sha = await hashDirectory(input.fixturePath);
  const importName = safeName(`${packageName}-1.0.0-${shortHash([pathToFileURL(input.fixturePath).href, ".", sha].join(":"))}`);
  const destination = join(sandboxImportRoot, importName);
  await rm(destination, { recursive: true, force: true });
  await mkdir(dirname(destination), { recursive: true });
  await cp(input.fixturePath, destination, { recursive: true, force: true, dereference: false });
  const installedSource = `./${relative(managedWorkspace, destination).split(sep).join("/")}`;
  const entry = {
    source: input.fixturePath,
    resolvedSource: pathToFileURL(input.fixturePath).href,
    packagePath: ".",
    sha,
    packageName,
    version: "1.0.0",
    entrypoint: "index.js",
    allowedNetworkHosts: [],
    installedSource,
  };
  await mkdir(dirname(sandboxConfigPath), { recursive: true });
  await writeFile(sandboxConfigPath, `${JSON.stringify({ packages: [entry], history: [] }, null, 2)}\n`, "utf8");
  return {
    managedWorkspace,
    configPath: sandboxConfigPath,
    importRoot: sandboxImportRoot,
    destination,
    sha,
    installedSource,
  };
}

async function hashDirectory(rootPath) {
  const hash = createHash("sha256");
  async function visit(currentPath) {
    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const fullPath = join(currentPath, entry.name);
      const relPath = relative(rootPath, fullPath).split(sep).join("/");
      hash.update(entry.isDirectory() ? `dir:${relPath}\0` : `file:${relPath}\0`);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile()) {
        hash.update(await readFile(fullPath));
        hash.update("\0");
      }
    }
  }
  await visit(rootPath);
  return hash.digest("hex");
}

function safeName(value) {
  return value
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "pi-extension";
}

function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
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
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 19792;
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
