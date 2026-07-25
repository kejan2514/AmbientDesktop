#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repoRoot = process.cwd();
const resultsDir = join(repoRoot, "test-results", "security-local-folder-allowlist");
const latestReportPath = join(resultsDir, "latest.json");
const defaultProvider = "ambient";
const defaultModel = "example/model-id";
const schemaVersion = "ambient-security-local-folder-allowlist-dogfood-v1";
const cdpCommandTimeoutMs = 120_000;
const appWaitTimeoutMs = 90_000;
const startedAt = new Date().toISOString();

let app;
let cdp;
let scratch;
let report;
let dogfoodEnv;

try {
  await rm(latestReportPath, { force: true });
  await mkdir(resultsDir, { recursive: true });
  dogfoodEnv = buildDogfoodEnv();
  await run("pnpm", ["run", "prepare:electron-native"], dogfoodEnv);

  scratch = await createScratch();
  app = launchDesktop(scratch);
  cdp = await connectToElectron(dogfoodCdpPort(), app);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await setViewport(cdp, 1500, 950);
  await waitForText(cdp, "Ambient", appWaitTimeoutMs);

  const initialEvidence = await captureAgentBrowserEvidence(cdp, "initial");
  const threadId = await createThread(cdp, "Security local folder allowlist dogfood");
  const beforeGrant = await exerciseBeforeGrant(cdp, scratch);
  const grant = await addFolderAllowlistGrant(cdp);
  const afterGrant = await exerciseAfterGrant(cdp, scratch, grant.id);
  const secondThreadId = await createThread(cdp, "Security local folder allowlist sibling thread");
  const threadIsolation = await previewLocal(cdp, scratch.allowedFilePath);
  const revoked = await revokeAndVerify(cdp, {
    grantId: grant.id,
    originalThreadId: threadId,
    allowedFilePath: scratch.allowedFilePath,
  });
  const finalEvidence = await captureAgentBrowserEvidence(cdp, "final");

  assertDogfood({ beforeGrant, afterGrant, threadIsolation, revoked });
  report = {
    schemaVersion,
    scenario: "security-local-folder-allowlist",
    startedAt,
    status: "passed",
    provider: {
      providerId: dogfoodProviderId(),
      modelId: dogfoodModelId(),
      ambientKeyConfigured: ambientKeyConfigured(),
    },
    fixture: {
      workspacePath: scratch.workspacePath,
      allowedPath: scratch.allowedPath,
      allowedFilePath: scratch.allowedFilePath,
      siblingFilePath: scratch.siblingFilePath,
      outsideFilePath: scratch.outsideFilePath,
      symlinkEscapePath: scratch.symlinkEscapePath,
    },
    threads: {
      originalThreadId: threadId,
      siblingThreadId: secondThreadId,
    },
    proof: {
      beforeGrant,
      grant,
      afterGrant,
      threadIsolation,
      revoked,
    },
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
  };
  await writeReport(report);
  console.log(`Security local folder allowlist dogfood passed. Results: ${outputPathRelative(latestReportPath)}`);
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
    scenario: "security-local-folder-allowlist",
    startedAt,
    status: "failed",
    provider: {
      providerId: dogfoodProviderId(),
      modelId: dogfoodModelId(),
      ambientKeyConfigured: ambientKeyConfigured(),
    },
    fixture: scratch,
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
  if (scratch && process.env.AMBIENT_SECURITY_LOCAL_FOLDER_ALLOWLIST_KEEP_SCRATCH !== "1") {
    await rm(scratch.root, { recursive: true, force: true }).catch(() => undefined);
  } else if (scratch) {
    console.error(`Keeping security local folder allowlist scratch: ${scratch.root}`);
  }
}

async function createScratch() {
  const root = await mkdtemp(join(tmpdir(), "ambient-security-local-folder-allowlist-"));
  const workspacePath = resolve(join(root, "workspace"));
  const userDataPath = resolve(join(root, "userData"));
  const allowedPath = resolve(join(root, "allowed"));
  const outsidePath = resolve(join(root, "outside"));
  const siblingPath = resolve(join(root, "sibling"));
  await mkdir(workspacePath, { recursive: true });
  await mkdir(userDataPath, { recursive: true });
  await mkdir(join(workspacePath, "docs"), { recursive: true });
  await mkdir(allowedPath, { recursive: true });
  await mkdir(outsidePath, { recursive: true });
  await mkdir(siblingPath, { recursive: true });

  const workspaceFilePath = join(workspacePath, "docs", "workspace-note.md");
  const allowedFilePath = join(allowedPath, "allowed-note.md");
  const outsideFilePath = join(outsidePath, "secret-note.md");
  const siblingFilePath = join(siblingPath, "sibling-note.md");
  const symlinkEscapePath = join(allowedPath, "linked-secret.md");
  await writeFile(workspaceFilePath, "# Workspace\n\nWorkspace preview should always work.\n", "utf8");
  await writeFile(allowedFilePath, "# Allowed\n\nFolder allowlist preview should work.\n", "utf8");
  await writeFile(outsideFilePath, "# Secret\n\nSymlink escape target.\n", "utf8");
  await writeFile(siblingFilePath, "# Sibling\n\nSibling folder should stay blocked.\n", "utf8");
  await symlink(outsideFilePath, symlinkEscapePath);
  return {
    root,
    workspacePath,
    userDataPath,
    allowedPath,
    outsidePath,
    siblingPath,
    workspaceFilePath,
    allowedFilePath,
    outsideFilePath,
    siblingFilePath,
    symlinkEscapePath,
  };
}

async function createThread(cdpClient, title) {
  return evaluate(cdpClient, async (input) => {
    const state = await window.ambientDesktop.createThread({
      permissionMode: "workspace",
      collaborationMode: "agent",
      model: input.model,
      thinkingLevel: "minimal",
    });
    const threadId = state.activeThreadId;
    await window.ambientDesktop.updateThread({ threadId, title: input.title });
    await window.ambientDesktop.updateThreadSettings({
      threadId,
      collaborationMode: "agent",
      model: input.model,
      thinkingLevel: "minimal",
    });
    await window.ambientDesktop.selectThread(threadId);
    return threadId;
  }, { title, model: dogfoodModelId() });
}

async function exerciseBeforeGrant(cdpClient, input) {
  const workspacePreview = await previewLocal(cdpClient, input.workspaceFilePath);
  const allowedPreview = await previewLocal(cdpClient, input.allowedFilePath);
  const siblingPreview = await previewLocal(cdpClient, input.siblingFilePath);
  const revealDenied = await revealLocal(cdpClient, input.allowedFilePath);
  return {
    workspacePreview,
    allowedPreview,
    siblingPreview,
    revealDenied,
  };
}

async function addFolderAllowlistGrant(cdpClient) {
  return evaluate(cdpClient, async () => window.ambientDesktop.addLocalFolderAllowlistForThread());
}

async function exerciseAfterGrant(cdpClient, input, grantId) {
  const allowedPreview = await previewLocal(cdpClient, input.allowedFilePath);
  const revealAllowed = await revealLocal(cdpClient, input.allowedFilePath);
  const siblingPreview = await previewLocal(cdpClient, input.siblingFilePath);
  const symlinkEscapePreview = await previewLocal(cdpClient, input.symlinkEscapePath);
  const openPrompt = await openLocalAndDenyFreshPrompt(cdpClient, input.allowedFilePath);
  const grants = await evaluate(cdpClient, async () => window.ambientDesktop.listPermissionGrants());
  return {
    grantId,
    allowedPreview,
    revealAllowed,
    siblingPreview,
    symlinkEscapePreview,
    openPrompt,
    activeGrantCount: grants.filter((grant) => !grant.revokedAt).length,
  };
}

async function revokeAndVerify(cdpClient, input) {
  const revokedGrant = await evaluate(cdpClient, async (grantId) => window.ambientDesktop.revokePermissionGrant({ id: grantId }), input.grantId);
  await evaluate(cdpClient, async (threadId) => window.ambientDesktop.selectThread(threadId), input.originalThreadId);
  const previewAfterRevoke = await previewLocal(cdpClient, input.allowedFilePath);
  return { revokedGrant, previewAfterRevoke };
}

async function previewLocal(cdpClient, path) {
  return evaluate(cdpClient, async (targetPath) => {
    try {
      const result = await window.ambientDesktop.previewLocalFile(targetPath);
      return {
        ok: true,
        path: result.path,
        absolutePath: result.absolutePath,
        source: result.source,
        kind: result.kind,
        contentPreview: typeof result.content === "string" ? result.content.slice(0, 120) : undefined,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }, path);
}

async function revealLocal(cdpClient, path) {
  return evaluate(cdpClient, async (targetPath) => {
    try {
      await window.ambientDesktop.revealLocalPath(targetPath);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }, path);
}

async function openLocalAndDenyFreshPrompt(cdpClient, path) {
  return evaluate(cdpClient, async (targetPath) => {
    const token = `open-${Date.now()}-${Math.random()}`;
    window.__ambientSecurityLocalOpenPromises = window.__ambientSecurityLocalOpenPromises ?? {};
    window.__ambientSecurityLocalOpenPromises[token] = window.ambientDesktop
      .openLocalPath(targetPath)
      .then(() => ({ settled: "resolved" }))
      .catch((error) => ({ settled: "rejected", error: error instanceof Error ? error.message : String(error) }));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 700));
    const pending = await window.ambientDesktop.listPendingPermissionRequests();
    const request = pending.find((item) => item.toolName === "local_file_open" && item.detail?.includes(targetPath));
    if (request) await window.ambientDesktop.respondPermissionRequest(request.id, "deny");
    const settled = await Promise.race([
      window.__ambientSecurityLocalOpenPromises[token],
      new Promise((resolveTimeout) => setTimeout(() => resolveTimeout({ settled: "pending-after-probe-timeout" }), 1500)),
    ]);
    delete window.__ambientSecurityLocalOpenPromises[token];
    return {
      request: request
        ? {
            id: request.id,
            toolName: request.toolName,
            risk: request.risk,
            title: request.title,
            detail: request.detail,
            reusableScopes: request.reusableScopes,
          }
        : undefined,
      settled,
    };
  }, path);
}

function assertDogfood({ beforeGrant, afterGrant, threadIsolation, revoked }) {
  const failures = [];
  if (!beforeGrant.workspacePreview.ok) failures.push(`workspace preview failed before grant: ${beforeGrant.workspacePreview.error}`);
  if (beforeGrant.allowedPreview.ok) failures.push("outside allowed-folder preview succeeded before grant");
  if (beforeGrant.siblingPreview.ok) failures.push("sibling-folder preview succeeded before grant");
  if (beforeGrant.revealDenied.ok) failures.push("outside reveal succeeded before grant");
  if (!afterGrant.allowedPreview.ok) failures.push(`allowlisted preview failed after grant: ${afterGrant.allowedPreview.error}`);
  if (!afterGrant.revealAllowed.ok) failures.push(`allowlisted reveal failed after grant: ${afterGrant.revealAllowed.error}`);
  if (afterGrant.siblingPreview.ok) failures.push("sibling-folder preview succeeded after allowlisting a different folder");
  if (afterGrant.symlinkEscapePreview.ok) failures.push("symlink escape preview succeeded under folder allowlist");
  if (!afterGrant.openPrompt.request) failures.push("outside local open did not create a fresh permission request after folder allowlist");
  if (afterGrant.openPrompt.settled?.settled !== "rejected") failures.push("outside local open did not reject after denied fresh prompt");
  if (threadIsolation.ok) failures.push("sibling thread inherited the folder allowlist");
  if (!revoked.revokedGrant.revokedAt) failures.push("folder allowlist grant did not record revokedAt");
  if (revoked.previewAfterRevoke.ok) failures.push("allowlisted preview still succeeded after revocation");
  if (failures.length) throw new Error(`Security local folder allowlist dogfood failed:\n- ${failures.join("\n- ")}`);
}

async function captureAgentBrowserEvidence(cdpClient, label) {
  const session = `security-local-folder-allowlist-${process.pid}`;
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
          AMBIENT_E2E_LOCAL_FOLDER_ALLOWLIST_DIALOG_PATH: input.allowedPath,
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
          : new Promise((resolveOpen, rejectOpen) => {
              socket.addEventListener("open", resolveOpen, { once: true });
              socket.addEventListener("error", () => rejectOpen(new Error("CDP socket failed to open")), { once: true });
            });
      return ready.then(() => new Promise((resolveSend, rejectSend) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectSend(new Error(`Timed out waiting for CDP ${method}`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolveSend(value);
          },
          reject: (error) => {
            clearTimeout(timer);
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

async function waitForText(cdpClient, text, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const body = await bodyText(cdpClient).catch(() => "");
    if (body.includes(text)) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for "${text}" in Electron renderer.`);
}

async function run(command, args, env = process.env) {
  const result = await runCaptured(command, args, 120_000, env);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function runCaptured(command, args, timeoutMs, env = process.env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: cleanChildEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error(`Timed out running ${command} ${args.join(" ")}`));
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
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") child.kill();
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
  }
  const exited = await Promise.race([
    new Promise((resolveExit) => child.once("exit", () => resolveExit(true))),
    delay(5_000).then(() => false),
  ]);
  if (!exited) {
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
    }
  }
}

async function writeReport(nextReport) {
  await mkdir(resultsDir, { recursive: true });
  await writeFile(latestReportPath, `${JSON.stringify(nextReport, null, 2)}\n`, "utf8");
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
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 19793;
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
