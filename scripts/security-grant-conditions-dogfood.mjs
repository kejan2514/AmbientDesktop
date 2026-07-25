#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repoRoot = process.cwd();
const scenario = "security-grant-conditions";
const schemaVersion = "ambient-security-grant-conditions-dogfood-v1";
const resultsDir = join(repoRoot, "test-results", scenario);
const latestReportPath = join(resultsDir, "latest.json");
const defaultProvider = "ambient";
const defaultModel = "example/model-id";
const cdpCommandTimeoutMs = 120_000;
const appWaitTimeoutMs = 90_000;
const startedAt = new Date().toISOString();

const target = {
  actionKind: "connector_content_read",
  targetKind: "tool",
  targetLabel: "Google Workspace drive.files.export (neo@example.test)",
  targetIdentity: "google.workspace.call\0neo@example.test\0drive.files.export\0personal_content_read",
};
const targetHash = permissionGrantHash(target.actionKind, target.targetKind, target.targetIdentity);
const grantConditionsA = {
  provider: "google.workspace.cli",
  operation: "method_call",
  accountHint: "neo@example.test",
  methodId: "drive.files.export",
  sideEffect: "personal_content_read",
  requestedAccountHint: "neo@example.test",
  resolvedAccountHint: "neo@example.test",
};
const requestConditionsB = {
  ...grantConditionsA,
  methodId: "drive.files.get",
};

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

  const state = await evaluate(cdp, async () => window.ambientDesktop.bootstrap());
  const grant = await createConditionedGrant(cdp, state.activeThreadId);
  await emitPermissionFixture(cdp, grant, state.activeThreadId);
  await openSecuritySettings(cdp);
  const grantRegistryText = await bodyText(cdp);
  assertIncludes(grantRegistryText, "Conditions:", "grant registry condition label");
  assertIncludes(grantRegistryText, "Method Id=drive.files.export", "grant registry method condition");
  const registryEvidence = await captureAgentBrowserEvidence(cdp, "grant-registry");

  const brokerProbe = await resolveMismatchedPermissionGrant(cdp, state.activeThreadId);
  if (brokerProbe.decisionSource !== "denied_by_user" || brokerProbe.allowed !== false || brokerProbe.promptRequested !== true || brokerProbe.grantId) {
    throw new Error(`Condition-B request unexpectedly reused grant A: ${JSON.stringify(brokerProbe, null, 2)}`);
  }
  if (brokerProbe.promptRequest?.grantConditions?.methodId !== "drive.files.get") {
    throw new Error(`Broker prompt did not carry condition-B methodId: ${JSON.stringify(brokerProbe.promptRequest, null, 2)}`);
  }

  await emitMismatchedPermissionPrompt(cdp, state.activeThreadId);
  await waitForText(cdp, "Condition mismatch grant request?", 30_000);
  await waitForText(cdp, "Method Id: drive.files.get", 30_000);
  const promptText = await bodyText(cdp);
  assertIncludes(promptText, "Always for this thread", "repeated prompt reusable action");
  const promptEvidence = await captureAgentBrowserEvidence(cdp, "mismatched-prompt");

  report = {
    schemaVersion,
    scenario,
    startedAt,
    status: "passed",
    provider: {
      providerId: dogfoodProviderId(),
      modelId: dogfoodModelId(),
      ambientKeyConfigured: ambientKeyConfigured(),
    },
    proof: {
      grantCreatedWithConditions: grant.conditions,
      mismatchedRequestConditions: requestConditionsB,
      sameGrantTargetHash: grant.targetHash === targetHash,
      conditionsDiffer: stableConditionString(grant.conditions) !== stableConditionString(requestConditionsB),
      brokerDecisionSource: brokerProbe.decisionSource,
      brokerPromptRequested: brokerProbe.promptRequested,
      brokerRejectedPersistentGrant: brokerProbe.allowed === false && !brokerProbe.grantId,
      brokerPromptMethodId: brokerProbe.promptRequest?.grantConditions?.methodId,
      grantRegistryConditionLabelVisible: grantRegistryText.includes("Method Id=drive.files.export"),
      repeatedPromptVisible: promptText.includes("Condition mismatch grant request?"),
      repeatedPromptConditionVisible: promptText.includes("Method Id: drive.files.get"),
    },
    electronSkillEvidence: {
      registry: registryEvidence,
      prompt: promptEvidence,
    },
    artifacts: {
      latestReport: outputPathRelative(latestReportPath),
      registrySnapshot: registryEvidence.snapshotPath,
      registryScreenshot: registryEvidence.screenshotPath,
      promptSnapshot: promptEvidence.snapshotPath,
      promptScreenshot: promptEvidence.screenshotPath,
    },
  };
  await writeReport(report);
  console.log(`Security grant conditions dogfood passed. Results: ${outputPathRelative(latestReportPath)}`);
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
    scenario,
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
    await run("pnpm", ["run", "prepare:node-native"], dogfoodEnv ?? buildDogfoodEnv());
  } catch (error) {
    process.exitCode = 1;
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  }
  if (scratch) await rm(scratch.root, { recursive: true, force: true }).catch(() => undefined);
}

async function createScratch() {
  const root = await mkdtemp(join(tmpdir(), "ambient-grant-conditions-"));
  const workspacePath = join(root, "workspace");
  const userDataPath = join(root, "userData");
  await mkdir(workspacePath, { recursive: true });
  await mkdir(userDataPath, { recursive: true });
  await writeFile(join(workspacePath, "README.md"), "# Grant conditions dogfood\n", "utf8");
  return { root, workspacePath, userDataPath };
}

async function createConditionedGrant(cdpClient, threadId) {
  return evaluate(cdpClient, async (input) => window.ambientDesktop.createPermissionGrant(input), {
    permissionModeAtCreation: "workspace",
    scopeKind: "thread",
    threadId,
    actionKind: target.actionKind,
    targetKind: target.targetKind,
    targetHash,
    targetLabel: target.targetLabel,
    conditions: grantConditionsA,
    source: "permission_prompt",
    reason: "Security dogfood conditioned grant A.",
  });
}

async function emitPermissionFixture(cdpClient, grant, threadId) {
  await evaluate(cdpClient, async (event) => window.ambientDesktop.emitE2eEvent(event), {
    type: "e2e-permission-fixture",
    grants: [grant],
    audit: [
      {
        id: "grant-condition-audit",
        threadId,
        createdAt: startedAt,
        permissionMode: "workspace",
        toolName: "google_workspace_call",
        risk: "plugin-tool",
        decision: "allowed",
        reason: "Security dogfood conditioned grant A was reused for matching condition A.",
        decisionSource: "persistent_grant",
        grantId: grant.id,
        detail: "Method Id: drive.files.export",
      },
    ],
  });
}

async function resolveMismatchedPermissionGrant(cdpClient, threadId) {
  return evaluate(cdpClient, async (input) => {
    if (!window.ambientDesktop.resolveE2ePermissionGrant) {
      throw new Error("Missing E2E permission grant resolver.");
    }
    return window.ambientDesktop.resolveE2ePermissionGrant(input);
  }, {
    request: mismatchedPermissionRequest(threadId),
    context: { threadId },
  });
}

async function emitMismatchedPermissionPrompt(cdpClient, threadId) {
  await evaluate(cdpClient, async (event) => window.ambientDesktop.emitE2eEvent(event), {
    type: "permission-request",
    request: {
      id: "grant-condition-mismatch-request",
      ...mismatchedPermissionRequest(threadId),
    },
  });
}

function mismatchedPermissionRequest(threadId) {
  return {
    threadId,
    toolName: "google_workspace_call",
    title: "Condition mismatch grant request?",
    message: "Existing grant A must not authorize this condition-B request.",
    detail: [
      "Account: neo@example.test",
      "Method Id: drive.files.get",
      "Existing grant condition: drive.files.export",
    ].join("\n"),
    risk: "plugin-tool",
    reusableScopes: ["thread", "project", "workspace"],
    grantActionKind: target.actionKind,
    grantTargetKind: target.targetKind,
    grantTargetLabel: target.targetLabel,
    grantTargetHash: targetHash,
    grantConditions: requestConditionsB,
  };
}

async function openSecuritySettings(cdpClient) {
  await clickButton(cdpClient, "Settings").catch(() => undefined);
  await waitForText(cdpClient, "Security & Access", 15_000).catch(() => undefined);
  await openSettingsSection(cdpClient, "security-access", "Security & Access");
  await clickButton(cdpClient, "Refresh").catch(() => undefined);
  await openSettingsDisclosure(cdpClient, "Persistent grant details");
  await delay(500);
}

async function openSettingsSection(cdpClient, sectionId, label) {
  const opened = await evaluate(cdpClient, (targetSectionId, targetLabel) => {
    const buttons = Array.from(document.querySelectorAll(".settings-nav button"));
    const button = buttons.find((item) => {
      const sectionLabel = item.querySelector("span")?.textContent?.trim();
      return sectionLabel === targetLabel;
    });
    const section = document.getElementById(`settings-section-${targetSectionId}`);
    if (!button || !section) return false;
    button.click();
    section.scrollIntoView({ block: "start", behavior: "auto" });
    const content = section.closest(".settings-content");
    if (content instanceof HTMLElement) {
      content.scrollTop = Math.max(0, section.offsetTop - content.offsetTop);
    }
    section.focus({ preventScroll: true });
    return true;
  }, sectionId, label);
  if (!opened) throw new Error(`Could not open settings section "${label}".`);
  await waitForVisibleSettingsSection(cdpClient, sectionId, label, 15_000);
}

async function waitForVisibleSettingsSection(cdpClient, sectionId, label, timeoutMs) {
  const started = Date.now();
  let lastState;
  while (Date.now() - started < timeoutMs) {
    const state = await evaluate(cdpClient, (targetSectionId, targetLabel) => {
      const section = document.getElementById(`settings-section-${targetSectionId}`);
      if (!section) return { visible: false, reason: "missing-section" };
      const rect = section.getBoundingClientRect();
      const title = section.querySelector("h3")?.textContent?.trim();
      const activeNav = document.querySelector(".settings-nav button.active, .settings-nav button[aria-current='location']");
      return {
        visible: title === targetLabel && rect.bottom > 120 && rect.top < window.innerHeight * 0.45,
        reason: `title=${title ?? ""}; rectTop=${Math.round(rect.top)}; rectBottom=${Math.round(rect.bottom)}; activeNav=${activeNav?.textContent?.trim() ?? ""}`,
      };
    }, sectionId, label);
    lastState = state;
    if (state?.visible) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for visible settings section "${label}" (${lastState?.reason ?? "no state"}).`);
}

async function openSettingsDisclosure(cdpClient, label) {
  const opened = await evaluate(cdpClient, (targetLabel) => {
    const disclosures = Array.from(document.querySelectorAll("details.settings-disclosure"));
    const details = disclosures.find((item) => item.querySelector(".settings-disclosure-title strong")?.textContent?.trim() === targetLabel);
    if (!(details instanceof HTMLDetailsElement)) return false;
    details.scrollIntoView({ block: "center", behavior: "auto" });
    if (!details.open) details.querySelector("summary")?.click();
    return true;
  }, label);
  if (!opened) throw new Error(`Could not open settings disclosure "${label}".`);
  await waitForOpenSettingsDisclosure(cdpClient, label, 15_000);
}

async function waitForOpenSettingsDisclosure(cdpClient, label, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const isOpen = await evaluate(cdpClient, (targetLabel) => {
      const disclosures = Array.from(document.querySelectorAll("details.settings-disclosure"));
      const details = disclosures.find((item) => item.querySelector(".settings-disclosure-title strong")?.textContent?.trim() === targetLabel);
      return details instanceof HTMLDetailsElement && details.open;
    }, label);
    if (isOpen) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for settings disclosure "${label}" to open.`);
}

async function clickButton(cdpClient, label) {
  const clicked = await evaluate(cdpClient, (targetLabel) => {
    const controls = Array.from(document.querySelectorAll("button, [role='button']"));
    const control = controls.find((item) => item.textContent?.trim().includes(targetLabel));
    if (!control) return false;
    control.click();
    return true;
  }, label);
  if (!clicked) throw new Error(`Could not click button containing "${label}".`);
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
  assertRendererDidNotCrash(label, snapshot.stdout || snapshot.stderr, await bodyText(cdpClient).catch(() => ""));
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
  if (crashText) throw new Error(`Renderer crash screen appeared during ${label} evidence capture:\n${String(crashText).slice(0, 4000)}`);
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
  return spawn("pnpm", ["exec", "electron-vite", "dev", "--", `--remote-debugging-port=${dogfoodCdpPort()}`], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: buildDogfoodEnv({
      extra: {
        AMBIENT_E2E: "1",
        AMBIENT_DESKTOP_WORKSPACE: input.workspacePath,
        AMBIENT_E2E_USER_DATA: input.userDataPath,
        AMBIENT_CODEX_CURATED_MARKETPLACE_URL: "0",
      },
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
      const ready = socket.readyState === WebSocket.OPEN
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
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with ${result.status}\n${result.stdout}\n${result.stderr}`);
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
  return existsSync(siblingCheckoutCandidate) ? siblingCheckoutCandidate : undefined;
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
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 19794;
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

function permissionGrantHash(actionKind, targetKind, identity) {
  return createHash("sha256").update(`${actionKind}\0${targetKind}\0${identity}`).digest("hex");
}

function stableConditionString(value) {
  return value === undefined ? "undefined" : JSON.stringify(stableConditionValue(value));
}

function stableConditionValue(value) {
  if (Array.isArray(value)) return value.map(stableConditionValue);
  if (!value || typeof value !== "object") return value;
  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) sorted[key] = stableConditionValue(value[key]);
  }
  return sorted;
}

function assertIncludes(text, expected, label) {
  if (!String(text).includes(expected)) throw new Error(`Missing ${label}: ${expected}`);
}
