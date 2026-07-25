#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repoRoot = process.cwd();
const resultsDir = join(repoRoot, "test-results", "container-runtime-lifecycle-dogfood");
const latestReportPath = join(resultsDir, "latest.json");
const defaultProvider = "ambient";
const defaultModel = "example/model-id";
const schemaVersion = "ambient-container-runtime-lifecycle-dogfood-v1";
const appWaitTimeoutMs = 90_000;
const cdpCommandTimeoutMs = 20_000;
const startedAt = new Date().toISOString();
const forceWarning = "Force quit and restart can interrupt every container on this runtime, including non-Ambient containers.";

let app;
let cdp;
let scratch;
let report;
let cachedAgentBrowserAvailable;

try {
  await rm(latestReportPath, { force: true });
  await mkdir(resultsDir, { recursive: true });
  await run("pnpm", ["run", "prepare:electron-native"], buildDogfoodEnv());

  scratch = await createScratch();
  app = launchDesktop(scratch);
  cdp = await connectToElectron(dogfoodCdpPort(), app);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await setViewport(cdp, 1500, 950);
  await waitForText(cdp, "Ambient", appWaitTimeoutMs);
  await installLifecycleCollector(cdp);

  const bootState = await evaluate(cdp, async () => window.ambientDesktop.bootstrap());
  const workspacePath = bootState?.workspace?.path ?? scratch.workspacePath;
  await openMcpRuntimeSettings(cdp, workspacePath);
  await waitForText(cdp, "MCP Runtime & Web Research", appWaitTimeoutMs);
  const initialEvidence = await captureAgentBrowserEvidence(cdp, "settings-opened");

  const uiPreflightClick = await clickButtonContaining(cdp, "Run preflight");
  await delay(uiPreflightClick.clicked ? 1_000 : 300);

  const before = await getContainerRuntimeStatus(cdp);
  assertUsableHostRuntime(before);
  await waitForText(cdp, "Container runtime", appWaitTimeoutMs);
  const uiPreview = await previewViaUiIfAvailable(cdp, before);
  const settingsEvidence = await captureAgentBrowserEvidence(cdp, "settings-runtime-preview");

  const runtime = lifecycleRuntime(before);
  const restartPreview = await previewLifecycle(cdp, { action: "restart", runtime });
  const forcePreview = await previewLifecycle(cdp, { action: "force-quit-and-restart", runtime });
  const recoveryPreview = await previewLifecycle(cdp, { action: "open-recovery", runtime });
  const liveAction = await maybeRunGracefulRestart(cdp, before, restartPreview, runtime);
  const after = liveAction.result?.after ?? await getContainerRuntimeStatus(cdp);
  const diagnostics = await exportDiagnostics(cdp);
  const liveState = await getLiveState(cdp);
  const proof = assertLifecycleDogfoodProof({
    before,
    after,
    restartPreview,
    forcePreview,
    recoveryPreview,
    liveAction,
    diagnostics,
    liveState,
  });
  const finalEvidence = await captureAgentBrowserEvidence(cdp, "after-lifecycle-check");

  report = {
    schemaVersion,
    scenario: "container-runtime-lifecycle",
    startedAt,
    status: "passed",
    provider: {
      providerId: dogfoodProviderId(),
      modelId: dogfoodModelId(),
      ambientKeyConfigured: ambientKeyConfigured(),
    },
    runtime: {
      before: summarizeRuntimeStatus(before),
      after: summarizeRuntimeStatus(after),
      restartPreview: summarizePreview(restartPreview),
      forcePreview: summarizePreview(forcePreview),
      recoveryPreview: summarizePreview(recoveryPreview),
      uiPreflightClick,
      uiPreview,
      liveAction: summarizeLiveAction(liveAction),
      scraplingHandoff: proof.scraplingHandoff,
    },
    proof,
    diagnostics,
    electronSkillEvidence: {
      initial: initialEvidence,
      settings: settingsEvidence,
      final: finalEvidence,
    },
    artifacts: {
      latestReport: outputPathRelative(latestReportPath),
      initialSnapshot: initialEvidence.snapshotPath,
      initialScreenshot: initialEvidence.screenshotPath,
      settingsSnapshot: settingsEvidence.snapshotPath,
      settingsScreenshot: settingsEvidence.screenshotPath,
      finalSnapshot: finalEvidence.snapshotPath,
      finalScreenshot: finalEvidence.screenshotPath,
      diagnosticsPath: diagnostics?.path,
    },
  };
  await writeReport(report);
  console.log(`Container runtime lifecycle dogfood passed. Results: ${outputPathRelative(latestReportPath)}`);
} catch (error) {
  const failure = error instanceof Error ? error : new Error(String(error));
  if (cdp) {
    try {
      await writeCdpScreenshot(cdp, "failure-cdp-screenshot.png");
    } catch {
      // Preserve the original failure.
    }
  }
  report = {
    schemaVersion,
    scenario: "container-runtime-lifecycle",
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
  await terminateProcessTree(app);
  try {
    await run("pnpm", ["run", "prepare:node-native"], buildDogfoodEnv());
  } catch (error) {
    process.exitCode = 1;
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  }
  if (scratch && process.env.AMBIENT_CONTAINER_RUNTIME_LIFECYCLE_DOGFOOD_KEEP_SCRATCH !== "1") {
    await rm(scratch.root, { recursive: true, force: true }).catch(() => undefined);
  } else if (scratch) {
    console.error(`Keeping container runtime lifecycle dogfood scratch: ${scratch.root}`);
  }
}

async function openMcpRuntimeSettings(cdpClient, workspacePath) {
  await evaluate(cdpClient, async (eventWorkspacePath) => {
    if (typeof window.ambientDesktop?.emitE2eEvent !== "function") {
      throw new Error("Missing E2E desktop event bridge.");
    }
    await window.ambientDesktop.emitE2eEvent({
      type: "mcp-container-runtime-setup-needed",
      workspacePath: eventWorkspacePath,
    });
    return true;
  }, workspacePath);
}

async function previewViaUiIfAvailable(cdpClient, status) {
  const label = status.status === "installed-not-running" ? "Preview restart" : "Preview recovery";
  const click = await clickButtonContaining(cdpClient, label);
  if (!click.clicked) return { clicked: false, label, availableButtons: click.availableButtons };
  await delay(750);
  const text = await bodyText(cdpClient);
  return {
    clicked: true,
    label,
    hasRuntimeRestartPanel: text.includes("Runtime restart"),
    hasCommandRows: text.includes("Commands:") || text.includes("Open recovery"),
    forceWarningVisible: text.includes(forceWarning),
  };
}

async function getContainerRuntimeStatus(cdpClient) {
  const status = await evaluate(cdpClient, async () => window.ambientDesktop.getMcpContainerRuntimeStatus());
  if (!status || status.schemaVersion !== "ambient-container-runtime-probe-v1") {
    throw new Error(`Container runtime status returned an unexpected payload: ${JSON.stringify(status)}`);
  }
  return status;
}

async function previewLifecycle(cdpClient, input) {
  const preview = await evaluate(cdpClient, async (previewInput) => window.ambientDesktop.previewMcpContainerRuntimeLifecycle(previewInput), input);
  if (!preview || preview.schemaVersion !== "ambient-container-runtime-lifecycle-preview-v1") {
    throw new Error(`Lifecycle preview returned an unexpected payload: ${JSON.stringify(preview)}`);
  }
  return preview;
}

async function maybeRunGracefulRestart(cdpClient, before, preview, runtime) {
  if (before.status === "ready") {
    return {
      mode: "blocked-ready-no-mutation",
      message: "Runtime was already ready, so the live run validated blocked restart preview without mutating Docker or Podman.",
    };
  }
  if (before.status !== "installed-not-running") {
    return {
      mode: "skipped-unavailable-runtime-state",
      message: `Runtime state ${before.status} is not a safe live restart target.`,
    };
  }
  if (preview.status !== "available") {
    return {
      mode: "skipped-preview-blocked",
      message: preview.summary,
    };
  }
  await resetLiveCollector(cdpClient);
  const result = await evaluate(cdpClient, async (runInput) => window.ambientDesktop.runMcpContainerRuntimeLifecycle(runInput), {
    action: "restart",
    runtime,
    expectedPreviewId: preview.previewId,
  });
  if (!result || result.schemaVersion !== "ambient-container-runtime-lifecycle-result-v1") {
    throw new Error(`Lifecycle run returned an unexpected payload: ${JSON.stringify(result)}`);
  }
  if (result.status !== "ready" && result.status !== "running") {
    throw new Error(`Graceful runtime restart did not recover the runtime: ${JSON.stringify(summarizeResult(result))}`);
  }
  return {
    mode: "ran-graceful-restart",
    result,
  };
}

async function exportDiagnostics(cdpClient) {
  const result = await evaluate(cdpClient, async () => window.ambientDesktop.exportDiagnosticBundle());
  if (!result?.path) throw new Error(`Diagnostic bundle export did not return a path: ${JSON.stringify(result)}`);
  return {
    path: result.path,
    bytes: result.bytes,
    createdAt: result.createdAt,
  };
}

function assertLifecycleDogfoodProof(input) {
  const {
    before,
    after,
    restartPreview,
    forcePreview,
    recoveryPreview,
    liveAction,
    diagnostics,
    liveState,
  } = input;
  assertSchema(before, "ambient-container-runtime-probe-v1", "before runtime status");
  assertSchema(after, "ambient-container-runtime-probe-v1", "after runtime status");
  assertSchema(restartPreview, "ambient-container-runtime-lifecycle-preview-v1", "restart preview");
  assertSchema(forcePreview, "ambient-container-runtime-lifecycle-preview-v1", "force preview");
  assertSchema(recoveryPreview, "ambient-container-runtime-lifecycle-preview-v1", "recovery preview");
  if (!["docker", "podman", "colima"].includes(restartPreview.runtime)) {
    throw new Error(`Restart preview did not select a supported runtime: ${restartPreview.runtime}`);
  }
  if (before.status === "ready") {
    if (restartPreview.status !== "blocked") {
      throw new Error(`Ready runtime should block restart preview, got ${restartPreview.status}.`);
    }
    if (!/already appears ready/i.test(restartPreview.summary)) {
      throw new Error(`Ready runtime restart preview did not explain the block: ${restartPreview.summary}`);
    }
    if (liveAction.mode !== "blocked-ready-no-mutation") {
      throw new Error(`Ready runtime should not be restarted in live dogfood: ${JSON.stringify(liveAction)}`);
    }
  }
  if (before.status === "installed-not-running" && restartPreview.status === "available" && liveAction.mode !== "ran-graceful-restart") {
    throw new Error(`Installed-not-running runtime should exercise graceful restart, got ${JSON.stringify(liveAction)}.`);
  }
  if (liveAction.mode !== "blocked-ready-no-mutation" && liveAction.mode !== "ran-graceful-restart") {
    throw new Error(`harness environment preflight failed: lifecycle dogfood cannot pass after skipping the live restart path: ${JSON.stringify(summarizeLiveAction(liveAction))}`);
  }
  if (forcePreview.action !== "force-quit-and-restart" || forcePreview.requiresConfirmation !== true) {
    throw new Error(`Force preview must require confirmation: ${JSON.stringify(summarizePreview(forcePreview))}`);
  }
  if (forcePreview.status === "available" && !forcePreview.expectedInterruption.includes("containers")) {
    throw new Error(`Available force preview did not state interruption scope: ${forcePreview.expectedInterruption}`);
  }
  if (!diagnostics?.path || diagnostics.bytes < 1000) {
    throw new Error(`Diagnostic bundle evidence is missing or too small: ${JSON.stringify(diagnostics)}`);
  }
  const scraplingHandoff = summarizeScraplingHandoff(after);
  if (after.status === "ready" && !scraplingHandoff) {
    throw new Error("Ready runtime status did not include Scrapling default capability handoff evidence.");
  }
  return {
    beforeStatus: before.status,
    afterStatus: after.status,
    restartPreviewStatus: restartPreview.status,
    forcePreviewStatus: forcePreview.status,
    recoveryPreviewStatus: recoveryPreview.status,
    liveActionMode: liveAction.mode,
    lifecycleProgressPhases: liveState.lifecycleProgress.map((entry) => entry.phase),
    scraplingHandoff,
    forceWarningContract: forcePreview.requiresConfirmation
      ? forceWarning
      : "Force warning not applicable because force preview was unavailable.",
  };
}

function assertUsableHostRuntime(status) {
  const runtime = lifecycleRuntime(status);
  const hasHost = status.hosts.some((host) => (
    host.kind === "docker" ||
    host.kind === "podman" ||
    host.kind === "colima"
  ) && host.status !== "missing");
  if (runtime && hasHost && (status.status === "ready" || status.status === "installed-not-running")) return;
  throw new Error([
    "harness environment preflight failed: live container runtime lifecycle dogfood requires a ready or installed-not-running Docker, Podman, or Colima host.",
    `Status: ${JSON.stringify(summarizeRuntimeStatus(status))}`,
  ].join(" "));
}

function lifecycleRuntime(status) {
  if (status.runtime === "docker" || status.runtime === "podman" || status.runtime === "colima") return status.runtime;
  const host = status.hosts.find((candidate) =>
    (candidate.kind === "docker" || candidate.kind === "podman" || candidate.kind === "colima") &&
    candidate.status !== "missing",
  );
  return host?.kind;
}

function assertSchema(value, expected, label) {
  if (value?.schemaVersion !== expected) {
    throw new Error(`${label} schema was ${value?.schemaVersion ?? "missing"}, expected ${expected}.`);
  }
}

function summarizeRuntimeStatus(status) {
  return {
    status: status.status,
    runtime: status.runtime,
    platform: status.platform,
    reason: status.reason,
    nextAction: status.nextAction,
    message: status.message,
    toolHive: {
      status: status.toolHive?.status,
      preflightOk: status.toolHive?.preflightOk,
      message: status.toolHive?.message,
      versionLine: status.toolHive?.versionLine,
    },
    hosts: (status.hosts ?? []).map((host) => ({
      kind: host.kind,
      status: host.status,
      reason: host.reason,
      version: host.version,
      message: host.message,
    })),
    postInstallQueue: status.postInstallQueue,
    defaultCapabilities: (status.defaultCapabilities ?? []).map((capability) => ({
      capabilityId: capability.capabilityId,
      status: capability.status,
      nextAction: capability.nextAction,
      runtimeStatus: capability.runtimeStatus,
      workloadName: capability.workloadName,
      installedWorkloadStatus: capability.installedWorkloadStatus,
      message: capability.message,
    })),
  };
}

function summarizePreview(preview) {
  return {
    action: preview.action,
    runtime: preview.runtime,
    status: preview.status,
    reason: preview.reason,
    summary: preview.summary,
    requiresConfirmation: preview.requiresConfirmation,
    expectedInterruption: preview.expectedInterruption,
    targetCount: preview.targets?.length ?? 0,
    commandCount: preview.commands?.length ?? 0,
    warnings: preview.warnings,
  };
}

function summarizeResult(result) {
  return {
    action: result.action,
    runtime: result.runtime,
    status: result.status,
    reason: result.reason,
    message: result.message,
    logPath: result.logPath,
    durationMs: result.durationMs,
    progress: (result.progress ?? []).map((entry) => ({
      phase: entry.phase,
      status: entry.status,
      message: entry.message,
      logPath: entry.logPath,
    })),
    before: result.before ? summarizeRuntimeStatus(result.before) : undefined,
    after: result.after ? summarizeRuntimeStatus(result.after) : undefined,
  };
}

function summarizeLiveAction(action) {
  if (!action?.result) return action;
  return {
    ...action,
    result: summarizeResult(action.result),
  };
}

function summarizeScraplingHandoff(status) {
  const queue = status.postInstallQueue?.find((item) => item.capabilityId === "scrapling");
  const capability = status.defaultCapabilities?.find((item) => item.capabilityId === "scrapling");
  if (!queue && !capability) return undefined;
  return {
    postInstallQueueStatus: queue?.status,
    status: capability?.status,
    nextAction: capability?.nextAction,
    runtimeStatus: capability?.runtimeStatus,
    workloadName: capability?.workloadName,
    message: capability?.message,
  };
}

async function installLifecycleCollector(cdpClient) {
  await evaluate(cdpClient, () => {
    window.__ambientContainerRuntimeLifecycleDogfood?.unsubscribe?.();
    window.__ambientContainerRuntimeLifecycleDogfood = {
      lifecycleProgress: [],
      errors: [],
    };
    window.__ambientContainerRuntimeLifecycleDogfood.unsubscribe = window.ambientDesktop.onEvent((event) => {
      const live = window.__ambientContainerRuntimeLifecycleDogfood;
      if (event.type === "mcp-container-runtime-lifecycle-progress") {
        live.lifecycleProgress.push({
          phase: event.progress?.phase,
          status: event.progress?.status,
          message: event.progress?.message,
          runtime: event.progress?.runtime,
          logPath: event.progress?.logPath,
        });
        live.lifecycleProgress = live.lifecycleProgress.slice(-80);
      }
      if (event.type === "error") live.errors.push(event.message);
      live.errors = live.errors.slice(-20);
    });
    return true;
  });
}

async function resetLiveCollector(cdpClient) {
  await evaluate(cdpClient, () => {
    const live = window.__ambientContainerRuntimeLifecycleDogfood;
    if (!live) return false;
    live.lifecycleProgress = [];
    live.errors = [];
    return true;
  });
}

async function getLiveState(cdpClient) {
  return evaluate(cdpClient, () => {
    const live = window.__ambientContainerRuntimeLifecycleDogfood;
    return live
      ? {
          lifecycleProgress: live.lifecycleProgress,
          errors: live.errors,
        }
      : { lifecycleProgress: [], errors: [] };
  });
}

async function clickButtonContaining(cdpClient, label) {
  return evaluate(cdpClient, (expectedLabel) => {
    const buttons = [...document.querySelectorAll("button")].filter((button) => button instanceof HTMLButtonElement);
    const availableButtons = buttons.map((button) => ({
      text: button.innerText.replace(/\s+/g, " ").trim(),
      disabled: button.disabled,
    })).filter((button) => button.text);
    const button = buttons.find((candidate) =>
      !candidate.disabled &&
      candidate.innerText.replace(/\s+/g, " ").trim().includes(expectedLabel),
    );
    if (!button) return { clicked: false, label: expectedLabel, availableButtons };
    button.scrollIntoView({ block: "center", inline: "center" });
    button.click();
    return {
      clicked: true,
      label: expectedLabel,
      buttonText: button.innerText.replace(/\s+/g, " ").trim(),
      availableButtons,
    };
  }, label);
}

async function captureAgentBrowserEvidence(cdpClient, label) {
  const session = `container-runtime-lifecycle-${process.pid}`;
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
  const screenshotPath = await writeCdpScreenshot(cdpClient, input.screenshotPath);
  const screenshotStat = await stat(screenshotPath);
  return {
    source: "cdp fallback; agent-browser unavailable",
    label: input.label,
    session: input.session,
    cdpPort: dogfoodCdpPort(),
    snapshotPath: outputPathRelative(input.snapshotPath),
    snapshotPreview: snapshotText.slice(0, 1200),
    screenshotPath: outputPathRelative(screenshotPath),
    screenshotBytes: screenshotStat.size,
  };
}

async function writeCdpScreenshot(cdpClient, nameOrPath) {
  await mkdir(resultsDir, { recursive: true });
  const outputPath = isAbsolute(nameOrPath) ? nameOrPath : join(resultsDir, nameOrPath);
  await mkdir(dirname(outputPath), { recursive: true });
  const screenshot = await cdpClient.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, { timeoutMs: 30_000 });
  await writeFile(outputPath, Buffer.from(screenshot.data, "base64"));
  const screenshotStat = await stat(outputPath);
  if (screenshotStat.size < 1_000) throw new Error(`CDP screenshot was unexpectedly small: ${screenshotStat.size} bytes.`);
  return outputPath;
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

function launchDesktop(input) {
  return spawn("pnpm", ["exec", "electron-vite", "dev", "--", `--remote-debugging-port=${dogfoodCdpPort()}`], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: buildDogfoodEnv({
      AMBIENT_E2E: "1",
      AMBIENT_DESKTOP_WORKSPACE: input.workspacePath,
      AMBIENT_E2E_USER_DATA: input.userDataPath,
      AMBIENT_AUTHORITY_STATE_ROOT: input.authorityStateRoot,
      AMBIENT_E2E_DIAGNOSTICS_PATH: input.diagnosticsPath,
      AMBIENT_CONTAINER_RUNTIME_LIFECYCLE_DOGFOOD: "1",
    }),
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
      return ready.then(() =>
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
  const root = await mkdtemp(join(tmpdir(), "ambient-container-runtime-lifecycle-"));
  const workspacePath = resolve(join(root, "workspace"));
  const userDataPath = resolve(join(root, "userData"));
  const authorityStateRoot = resolve(join(userDataPath, "authority-state"));
  const diagnosticsPath = resolve(join(resultsDir, "latest-diagnostics.json"));
  await mkdir(workspacePath, { recursive: true });
  await mkdir(authorityStateRoot, { recursive: true });
  await mkdir(dirname(diagnosticsPath), { recursive: true });
  await writeFile(join(workspacePath, "README.md"), "# Container Runtime Lifecycle Dogfood\n", "utf8");
  return { root, workspacePath, userDataPath, authorityStateRoot, diagnosticsPath };
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

function buildDogfoodEnv(overrides = {}) {
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
    ...overrides,
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
  const raw = process.env.AMBIENT_HARNESS_CDP_PORT || process.env.AMBIENT_SUBAGENT_DESKTOP_DOGFOOD_CDP_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("AMBIENT_HARNESS_CDP_PORT is required; run through scripts/run-electron-dogfood.mjs.");
  }
  return port;
}

function cleanChildEnv(env) {
  const next = { ...env };
  delete next.NODE_OPTIONS;
  delete next.VITEST;
  return next;
}

function outputPathRelative(path) {
  const rel = relative(repoRoot, resolve(path));
  return rel && !rel.startsWith("..") ? rel : path;
}
