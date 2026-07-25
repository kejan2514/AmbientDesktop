#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repoRoot = process.cwd();
const resultsDir = join(repoRoot, "test-results", "security-pi-privileged-toctou");
const latestReportPath = join(resultsDir, "latest.json");
const defaultProvider = "ambient";
const defaultModel = "example/model-id";
const schemaVersion = "ambient-security-pi-privileged-toctou-dogfood-v1";
const cdpCommandTimeoutMs = 20_000;
const appWaitTimeoutMs = 90_000;
const promptTimeoutMs = Number(process.env.AMBIENT_SECURITY_PI_PRIVILEGED_TOCTOU_PROMPT_TIMEOUT_MS ?? 420_000);
const settleTimeoutMs = Number(process.env.AMBIENT_SECURITY_PI_PRIVILEGED_TOCTOU_SETTLE_TIMEOUT_MS ?? 180_000);
const startedAt = new Date().toISOString();
const packageSource = "npm:context-mode-like";
const packageName = "context-mode-like";
const allowedDogfoodToolNames = new Set([
  "ambient_tool_describe",
  "ambient_tool_call",
  "ambient_pi_privileged_install",
]);

let app;
let cdp;
let scratch;
let registry;
let report;
let dogfoodEnv;

try {
  await rm(latestReportPath, { force: true });
  await mkdir(resultsDir, { recursive: true });
  registry = await startMutableRegistryFixture();
  dogfoodEnv = buildDogfoodEnv({ extra: { AMBIENT_NPM_REGISTRY_URL: registry.url } });
  await run("pnpm", ["run", "prepare:electron-native"], dogfoodEnv);

  scratch = await createScratch();
  app = launchDesktop(scratch, registry.url);
  cdp = await connectToElectron(dogfoodCdpPort(), app);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await setViewport(cdp, 1500, 950);
  await waitForText(cdp, "Ambient", appWaitTimeoutMs);
  await installLiveCollector(cdp);

  const initialBrowserEvidence = await captureAgentBrowserEvidence(cdp, "before-turn");
  const threadId = await createThread(cdp, {
    title: "Security Pi privileged TOCTOU dogfood",
    model: dogfoodModelId(),
  });
  const promptTurn = await runPrivilegedInstallTurn(cdp, {
    threadId,
    prompt: dogfoodPrompt(registry.url),
    model: dogfoodModelId(),
  });
  const promptBrowserEvidence = await captureAgentBrowserEvidence(cdp, "prompt-visible");
  const promptProof = await assertPromptEvidence(promptTurn, scratch, registry);

  registry.setLatest("2.0.0");
  await allowPermissionRequest(cdp, promptProof.permissionRequest.id);
  const settledTurn = await waitForInstallSettled(cdp, {
    threadId,
    permissionRequestId: promptProof.permissionRequest.id,
  });
  const finalBrowserEvidence = await captureAgentBrowserEvidence(cdp, "after-allow");
  const proof = await assertMismatchEvidence({ promptProof, settledTurn, scratch, registry });

  report = {
    schemaVersion,
    scenario: "security-pi-privileged-toctou",
    startedAt,
    status: "passed",
    provider: {
      providerId: dogfoodProviderId(),
      modelId: dogfoodModelId(),
      ambientKeyConfigured: ambientKeyConfigured(),
    },
    registry: {
      url: registry.url,
      reviewedLatest: "1.0.0",
      installLatest: registry.latest(),
    },
    turn: {
      beforeAllow: summarizeTurn(promptTurn),
      afterAllow: summarizeTurn(settledTurn),
    },
    proof,
    electronSkillEvidence: {
      initial: initialBrowserEvidence,
      prompt: promptBrowserEvidence,
      final: finalBrowserEvidence,
    },
    artifacts: {
      latestReport: outputPathRelative(latestReportPath),
      initialSnapshot: initialBrowserEvidence.snapshotPath,
      initialScreenshot: initialBrowserEvidence.screenshotPath,
      promptSnapshot: promptBrowserEvidence.snapshotPath,
      promptScreenshot: promptBrowserEvidence.screenshotPath,
      finalSnapshot: finalBrowserEvidence.snapshotPath,
      finalScreenshot: finalBrowserEvidence.screenshotPath,
    },
  };
  await writeReport(report);
  console.log(`Security Pi privileged TOCTOU dogfood passed. Results: ${outputPathRelative(latestReportPath)}`);
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
    scenario: "security-pi-privileged-toctou",
    startedAt,
    status: "failed",
    provider: {
      providerId: dogfoodProviderId(),
      modelId: dogfoodModelId(),
      ambientKeyConfigured: ambientKeyConfigured(),
    },
    registry: registry ? { url: registry.url, latest: registry.latest() } : undefined,
    error: failure.message,
    stack: failure.stack,
  };
  await writeReport(report).catch(() => undefined);
  console.error(failure.stack ?? failure.message);
  process.exitCode = 1;
} finally {
  cdp?.close?.();
  await terminateProcessTree(app);
  await registry?.close?.();
  try {
    await run("pnpm", ["run", "prepare:node-native"], dogfoodEnv ?? buildDogfoodEnv());
  } catch (error) {
    process.exitCode = 1;
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  }
  if (scratch && process.env.AMBIENT_SECURITY_PI_PRIVILEGED_TOCTOU_KEEP_SCRATCH !== "1") {
    await rm(scratch.root, { recursive: true, force: true }).catch(() => undefined);
  } else if (scratch) {
    console.error(`Keeping security Pi privileged TOCTOU dogfood scratch: ${scratch.root}`);
  }
}

function dogfoodPrompt(registryUrl) {
  return [
    "This is a live Ambient Desktop security hardening dogfood.",
    "The user has explicitly approved this dogfood attempt. Ambient will still show a native permission prompt before copying any privileged package.",
    "Use the logical Ambient tool ambient_pi_privileged_install exactly once with this JSON input:",
    JSON.stringify({ source: packageSource }, null, 2),
    "If ambient_pi_privileged_install is active directly, call it directly with the JSON object above.",
    "If only the router tools are active, first call ambient_tool_describe exactly once with name \"ambient_pi_privileged_install\", then call ambient_tool_call exactly once with:",
    JSON.stringify({ toolName: "ambient_pi_privileged_install", toolInput: { source: packageSource } }, null, 2),
    "Do not call shell, bash, terminal, browser, file write, download, ambient_cli, package execution, ambient_tool_search, or ambient_pi_privileged_scan.",
    `The test npm registry is already configured for the app at ${registryUrl}; do not browse or inspect it yourself.`,
    "After the permission prompt appears, wait. If the tool later reports that the privileged Pi package identity changed after scan, report SECURITY_TOCTOU_BLOCKED and include the exact error.",
  ].join("\n");
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
  if (!threadId) throw new Error("Security Pi privileged TOCTOU dogfood could not create an active thread.");
  return threadId;
}

async function runPrivilegedInstallTurn(cdpClient, input) {
  await resetLiveCollector(cdpClient);
  await evaluate(cdpClient, async (turn) => {
    const live = window.__ambientSecurityPiPrivilegedToctouDogfood;
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
  return waitForInstallPrompt(cdpClient, input.threadId, promptTimeoutMs);
}

async function waitForInstallPrompt(cdpClient, threadId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    const live = await getLiveState(cdpClient);
    if (live?.error) throw new Error(live.error);
    const state = await readThreadState(cdpClient, threadId);
    const permissionRequest = selectInstallPermissionRequest(state.pendingPermissionRequests);
    latest = { ...state, live, permissionRequest };
    if (permissionRequest) return latest;
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for privileged Pi install permission prompt. Latest: ${JSON.stringify(summarizeTurn(latest ?? {}), null, 2)}`);
}

async function waitForInstallSettled(cdpClient, input) {
  const deadline = Date.now() + settleTimeoutMs;
  let latest;
  while (Date.now() < deadline) {
    const live = await getLiveState(cdpClient);
    const state = await readThreadState(cdpClient, input.threadId);
    const stillPending = state.pendingPermissionRequests.some((request) => request.id === input.permissionRequestId);
    latest = { ...state, live, permissionRequest: selectInstallPermissionRequest(state.pendingPermissionRequests) };
    const text = visibleTurnText(latest);
    if (!stillPending && /Privileged Pi package identity changed after scan|rescan before installing|SECURITY_TOCTOU_BLOCKED/i.test(text)) {
      return latest;
    }
    if (live?.sendResolved && !stillPending) return latest;
    if (live?.error && !/identity changed after scan|rescan before installing/i.test(live.error)) {
      throw new Error(live.error);
    }
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for privileged Pi install mismatch to settle. Latest: ${JSON.stringify(summarizeTurn(latest ?? {}), null, 2)}`);
}

async function readThreadState(cdpClient, threadId) {
  return evaluate(cdpClient, async (id) => {
    await window.ambientDesktop.selectThread(id);
    const [bootstrap, pendingPermissionRequests, permissionGrants, permissionAudit, catalog] = await Promise.all([
      window.ambientDesktop.bootstrap(),
      window.ambientDesktop.listPendingPermissionRequests(),
      window.ambientDesktop.listPermissionGrants(),
      window.ambientDesktop.listPermissionAudit(),
      window.ambientDesktop.inspectPiPrivilegedPackages(),
    ]);
    const messages = (bootstrap.messages ?? []).filter((message) => message.threadId === id);
    const thread = (bootstrap.threads ?? []).find((candidate) => candidate.id === id);
    const assistantText = messages
      .filter((message) => message.role === "assistant" && message.metadata?.kind !== "thinking")
      .map((message) => message.content)
      .join("\n");
    const toolMessages = messages.filter((message) => message.role === "tool");
    const installToolMessages = toolMessages.filter((message) =>
      message.metadata?.toolName === "ambient_pi_privileged_install" ||
      String(message.content ?? "").includes("ambient_pi_privileged_install") ||
      String(message.content ?? "").includes("Privileged Pi package"),
    );
    return {
      threadId: id,
      thread,
      messages,
      assistantText,
      toolMessages,
      installToolMessages,
      pendingPermissionRequests,
      permissionGrants,
      permissionAudit,
      catalog,
      bodyText: document.body.innerText,
    };
  }, threadId);
}

function selectInstallPermissionRequest(requests = []) {
  return requests.find(
    (request) =>
      request?.toolName === "ambient_pi_privileged_install" ||
      /Install privileged Pi package/i.test(String(request?.title ?? "")) ||
      /ambient_pi_privileged_install/i.test(JSON.stringify(request ?? {})),
  );
}

async function assertPromptEvidence(turn, scratchInput, registryInput) {
  const request = turn.permissionRequest;
  const toolNames = turn.toolMessages.map((message) => String(message.metadata?.toolName ?? "unknown"));
  const forbiddenToolNames = toolNames.filter((toolName) => !allowedDogfoodToolNames.has(toolName));
  const activePackagesBeforeAllow = turn.catalog?.packages ?? [];
  const visibleText = visibleTurnText(turn);
  const detail = String(request?.detail ?? "");
  const failures = [];

  if (!request) failures.push("no privileged Pi install permission request was pending");
  if (request && request.toolName !== "ambient_pi_privileged_install") failures.push(`permission toolName was ${JSON.stringify(request.toolName)}, expected ambient_pi_privileged_install`);
  if (request && !/Install privileged Pi package "context-mode-like" as disabled/i.test(String(request.title ?? ""))) {
    failures.push(`permission title did not identify context-mode-like install: ${JSON.stringify(request.title)}`);
  }
  if (!/Version: 1\.0\.0/.test(detail)) failures.push("permission detail did not bind reviewed version 1.0.0");
  if (!/Descriptor hash: [a-f0-9]{64}/.test(detail)) failures.push("permission detail did not include descriptor hash");
  if (!/Package tree hash: [a-f0-9]{64}/.test(detail)) failures.push("permission detail did not include package tree hash");
  if (!/Fingerprint: [a-f0-9]{64}/.test(detail)) failures.push("permission detail did not include fingerprint");
  if (/registry-secret|token=|#signature/i.test(detail)) failures.push("permission detail leaked raw credentialed tarball URL material");
  if (!detail.includes(`${registryInput.url}/context-mode-like/-/context-mode-like-1.0.0.tgz`)) {
    failures.push("permission detail did not include the public reviewed tarball URL");
  }
  if ((turn.thread?.permissionMode ?? "workspace") !== "workspace") {
    failures.push(`thread permissionMode was ${JSON.stringify(turn.thread?.permissionMode)}, expected workspace`);
  }
  if (forbiddenToolNames.length) failures.push(`forbidden tool calls were used: ${forbiddenToolNames.join(", ")}`);
  if (activePackagesBeforeAllow.length) failures.push(`catalog already contained privileged packages before approval: ${activePackagesBeforeAllow.map((pkg) => pkg.packageName).join(", ")}`);
  if (!/Install privileged Pi package|context-mode-like|Package tree hash/i.test(visibleText)) {
    failures.push("visible UI/transcript text did not show privileged install prompt evidence");
  }
  if (!existsSync(scratchInput.workspacePath)) failures.push("scratch workspace disappeared before approval");

  if (failures.length) {
    throw new Error(`Security Pi privileged TOCTOU dogfood failed before allow:\n- ${failures.join("\n- ")}\n\nTurn:\n${JSON.stringify(summarizeTurn(turn), null, 2)}`);
  }

  return {
    permissionRequest: summarizePermissionRequest(request),
    reviewedVersion: "1.0.0",
    reviewedTarballPublicUrl: `${registryInput.url}/context-mode-like/-/context-mode-like-1.0.0.tgz`,
    rawTarballCredentialsRedacted: true,
    packageTreeHashInPrompt: true,
    descriptorHashInPrompt: true,
    toolNames,
    forbiddenToolNames,
    activePackageCountBeforeAllow: activePackagesBeforeAllow.length,
  };
}

async function assertMismatchEvidence(input) {
  const text = visibleTurnText(input.settledTurn);
  const catalog = await evaluate(cdp, () => window.ambientDesktop.inspectPiPrivilegedPackages());
  const activeGrants = input.settledTurn.permissionGrants.filter((grant) => !grant.revokedAt);
  const installAudit = input.settledTurn.permissionAudit.filter((entry) => entry.toolName === "ambient_pi_privileged_install");
  const failures = [];

  if (input.registry.latest() !== "2.0.0") failures.push(`registry latest was ${input.registry.latest()}, expected 2.0.0`);
  if (!/Privileged Pi package identity changed after scan|rescan before installing|SECURITY_TOCTOU_BLOCKED/i.test(text)) {
    failures.push("turn did not report the identity mismatch/rescan error");
  }
  if ((catalog.packages ?? []).length) {
    failures.push(`catalog contained installed privileged packages after mismatch: ${catalog.packages.map((pkg) => pkg.packageName).join(", ")}`);
  }
  if (!installAudit.some((entry) => entry.decision === "allowed" && String(entry.detail ?? "").includes("Version: 1.0.0"))) {
    failures.push("permission audit did not record the approved reviewed 1.0.0 install detail");
  }
  if (activeGrants.some((grant) => /ambient_pi_privileged_install|context-mode-like/i.test(JSON.stringify(grant)))) {
    failures.push("privileged Pi install left an active reusable grant after the mismatch");
  }

  if (failures.length) {
    throw new Error(`Security Pi privileged TOCTOU dogfood failed after allow:\n- ${failures.join("\n- ")}\n\nTurn:\n${JSON.stringify(summarizeTurn(input.settledTurn), null, 2)}`);
  }

  return {
    ...input.promptProof,
    registryLatestMutatedBeforeApproval: true,
    installRejectedAfterApproval: true,
    mismatchVisible: true,
    activePackageCountAfterAllow: catalog.packages.length,
    retainedHistoryCountAfterAllow: catalog.history.length,
    installAuditCount: installAudit.length,
  };
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
    window.__ambientSecurityPiPrivilegedToctouDogfood?.unsubscribe?.();
    window.__ambientSecurityPiPrivilegedToctouDogfood = {
      runtimeActivities: [],
      toolEvents: [],
      permissionEvents: [],
      assistantTail: "",
      sendResolved: true,
      error: undefined,
    };
    window.__ambientSecurityPiPrivilegedToctouDogfood.unsubscribe = window.ambientDesktop.onEvent((event) => {
      const live = window.__ambientSecurityPiPrivilegedToctouDogfood;
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
    const live = window.__ambientSecurityPiPrivilegedToctouDogfood;
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
    const live = window.__ambientSecurityPiPrivilegedToctouDogfood;
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
    installToolMessageCount: turn.installToolMessages?.length ?? 0,
    pendingPermissionRequestCount: pendingPermissionRequests.length,
    installPermissionRequest: turn.permissionRequest ? summarizePermissionRequest(turn.permissionRequest) : undefined,
    catalogPackages: turn.catalog?.packages?.map((pkg) => ({ packageName: pkg.packageName, status: pkg.status, version: pkg.version })) ?? [],
    runtimeActivities: turn.live?.runtimeActivities?.slice(-8) ?? [],
    toolEvents: turn.live?.toolEvents?.slice(-8) ?? [],
    permissionEvents: turn.live?.permissionEvents?.slice(-8) ?? [],
    sendResolved: turn.live?.sendResolved,
    sendError: turn.live?.error,
  };
}

async function captureAgentBrowserEvidence(cdpClient, label) {
  const session = `security-pi-privileged-toctou-${process.pid}`;
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

function launchDesktop(input, registryUrl) {
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
          AMBIENT_NPM_REGISTRY_URL: registryUrl,
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
  const root = await mkdtemp(join(tmpdir(), "ambient-security-pi-privileged-toctou-"));
  const workspacePath = resolve(join(root, "workspace"));
  const userDataPath = resolve(join(root, "userData"));
  await mkdir(workspacePath, { recursive: true });
  await mkdir(userDataPath, { recursive: true });
  await writeFile(join(workspacePath, "README.md"), "# Security Pi Privileged TOCTOU Dogfood\n", "utf8");
  return { root, workspacePath, userDataPath };
}

async function startMutableRegistryFixture() {
  const root = await mkdtemp(join(tmpdir(), "ambient-security-pi-registry-"));
  const versions = {
    "1.0.0": await createRegistryPackage(root, "1.0.0", "reviewed"),
    "2.0.0": await createRegistryPackage(root, "2.0.0", "swapped"),
  };
  let latest = "1.0.0";
  let registryUrl = "";
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === `/${packageName}`) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          name: packageName,
          "dist-tags": { latest },
          versions: Object.fromEntries(Object.entries(versions).map(([version, info]) => [
            version,
            {
              name: packageName,
              version,
              dist: {
                tarball: `${registryUrl}/${packageName}/-/${packageName}-${version}.tgz?token=registry-secret-${version}#signature`,
                integrity: info.integrity,
                shasum: info.shasum,
              },
            },
          ])),
        }));
        return;
      }
      const match = url.pathname.match(new RegExp(`^/${packageName}/-/${packageName}-(1\\.0\\.0|2\\.0\\.0)\\.tgz$`));
      if (match) {
        const bytes = await readFile(versions[match[1]].tarballPath);
        response.setHeader("content-type", "application/octet-stream");
        response.end(bytes);
        return;
      }
      response.statusCode = 404;
      response.end("not found");
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mutable registry did not expose a TCP address.");
  registryUrl = `http://127.0.0.1:${address.port}`;
  return {
    url: registryUrl,
    latest: () => latest,
    setLatest(version) {
      latest = version;
    },
    async close() {
      await new Promise((resolveClose) => server.close(() => resolveClose()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function createRegistryPackage(root, version, marker) {
  const packageRoot = join(root, `package-${version}`, "package");
  await seedPrivilegedFixture(packageRoot, { version, marker });
  const tarballPath = join(root, `${packageName}-${version}.tgz`);
  await runCaptured("tar", ["-czf", tarballPath, "-C", dirname(packageRoot), "package"], 30_000);
  const bytes = await readFile(tarballPath);
  return {
    tarballPath,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    shasum: createHash("sha1").update(bytes).digest("hex"),
  };
}

async function seedPrivilegedFixture(root, input) {
  await mkdir(join(root, "build"), { recursive: true });
  await mkdir(join(root, "configs", "codex"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: packageName,
        version: input.version,
        description: `Fixture privileged Pi package ${input.marker}.`,
        bin: { [packageName]: "start.mjs" },
        pi: { extensions: ["./build/pi-extension.js"] },
        optionalDependencies: { "better-sqlite3": "^12.6.2" },
        scripts: { postinstall: "node scripts/postinstall.mjs" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(root, "build", "pi-extension.js"),
    `
import { homedir } from "node:os";
import { writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

export default function(pi) {
  pi.on("session_start", () => {
    const dir = homedir() + "/.pi/context-mode-like";
    mkdirSync(dir, { recursive: true });
    writeFileSync(dir + "/context.db", ${JSON.stringify(input.marker)});
  });
  pi.registerCommand("ctx-stats", { description: "stats", handler: () => ${JSON.stringify(input.marker)} });
  execFileSync("node", ["--version"]);
}
`,
    "utf8",
  );
  await writeFile(join(root, ".mcp.json"), `${JSON.stringify({ mcpServers: { [packageName]: { command: "node", args: ["./start.mjs"] } } }, null, 2)}\n`, "utf8");
  await writeFile(join(root, "configs", "codex", "hooks.json"), `${JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: "command", command: `${packageName} hook` }] }] } }, null, 2)}\n`, "utf8");
  await writeFile(
    join(root, "start.mjs"),
    `
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
writeFileSync(homedir() + "/.codex/config.toml", ${JSON.stringify(`mcp_servers.${packageName}.${input.marker}`)});
`,
    "utf8",
  );
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
