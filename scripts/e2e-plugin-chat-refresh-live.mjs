#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { snapshotHarnessWorkspace, writeHarnessTraceArtifacts } from "./harness-trace-artifacts.mjs";
import { writeLiveDogfoodSummary, writeLiveVisualManifest } from "./plugin-visual-manifest.mjs";

const port = Number(process.env.AMBIENT_PLUGIN_CHAT_REFRESH_CDP_PORT ?? 9492);
const timeoutMs = Number(process.env.AMBIENT_PLUGIN_CHAT_REFRESH_TIMEOUT_MS ?? 600_000);
const piStreamIdleTimeoutMs = Number(process.env.AMBIENT_PLUGIN_CHAT_REFRESH_PI_IDLE_TIMEOUT_MS || 0);
const selectedScenarios = parseSelectedScenarios();
const workspace = await mkdtemp(join(tmpdir(), "ambient-plugin-chat-refresh-"));
const userData = await mkdtemp(join(tmpdir(), "ambient-plugin-chat-refresh-data-"));
const resultsDir = join(process.cwd(), "test-results", "plugins");
const output = [];
let appInstance;
let beforeWorkspace;

try {
  await mkdir(resultsDir, { recursive: true });
  await seedWorkspace(workspace);
  beforeWorkspace = await snapshotHarnessWorkspace(workspace);
  const ambientApiKey = await readAmbientApiKey();
  if (!ambientApiKey) {
    throw new Error("Set AMBIENT_API_KEY, AMBIENT_AGENT_AMBIENT_API_KEY, AMBIENT_API_KEY_FILE, or place ignored-provider-key-file.txt near the repo.");
  }
  appInstance = await launchApp(ambientApiKey);
  const summary = await runLivePluginPanelRefreshSmoke(appInstance.cdp);
  await writeLiveVisualManifest({ resultsDir, screenshots: summary.screenshots });
  await writeLiveDogfoodSummary({ resultsDir, summary });
  console.log(JSON.stringify(summary, null, 2));
  console.log("Live plugin chat refresh smoke passed.");
} catch (error) {
  console.error(outputTail());
  throw error;
} finally {
  appInstance?.cdp.close();
  if (appInstance?.child) await terminateProcessTree(appInstance.child);
  await terminateDebugPortProcesses();
  await rm(workspace, { recursive: true, force: true });
  await rm(userData, { recursive: true, force: true });
}

async function seedWorkspace(root) {
  await writeFile(
    join(root, "README.md"),
    [
      "# Plugin chat refresh live smoke",
      "",
      "This temporary workspace validates open Plugins panel refresh after live Ambient/Pi package mutations.",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function launchApp(ambientApiKey) {
  const child = spawn("pnpm", ["exec", "electron-vite", "dev", "--", `--remote-debugging-port=${port}`], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AMBIENT_DESKTOP_WORKSPACE: workspace,
      AMBIENT_E2E: "1",
      AMBIENT_E2E_USER_DATA: userData,
      AMBIENT_CODEX_CURATED_MARKETPLACE_URL: "0",
      AMBIENT_PI_USER_SETTINGS_PATH: join(userData, "missing-pi-settings.json"),
      ...(piStreamIdleTimeoutMs > 0 ? { AMBIENT_CHAT_PI_STREAM_IDLE_TIMEOUT_MS: String(piStreamIdleTimeoutMs) } : {}),
      AMBIENT_API_KEY: ambientApiKey,
      AMBIENT_AGENT_AMBIENT_API_KEY: ambientApiKey,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));

  const target = await waitForTarget();
  await delay(750);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitFor(cdp, () => document.body?.innerText.includes("Ambient"), "main shell", 30_000);
  return { child, cdp };
}

async function runLivePluginPanelRefreshSmoke(cdp) {
  const state = await desktopState(cdp);
  if (!state.provider.hasApiKey) throw new Error("Ambient API key was not visible to the launched app.");
  const keyCheck = await evaluate(cdp, "window.ambientDesktop.testAmbientApiKey()");
  if (!keyCheck?.ok) throw new Error(`Ambient API key check failed: ${keyCheck?.message ?? "unknown error"}`);

  await clickButton(cdp, "Plugins");
  await waitFor(cdp, () => document.body.innerText.includes("Ambient Plugin Host"), "plugins panel", 30_000);
  await clickButton(cdp, "Sources");
  await clickButton(cdp, "Inspect Pi packages");
  await waitFor(cdp, () => document.body.innerText.includes("Pi Packages"), "Pi package section", 30_000);
  await installLiveCollector(cdp);

  const screenshots = [];
  if (selectedScenarios.has("arxiv")) {
    screenshots.push(...(await runScenarioWithDiagnostics(cdp, "arxiv", () => runArxivRefreshScenario(cdp, state.activeThreadId))));
  }
  if (selectedScenarios.has("ffmpeg")) {
    screenshots.push(...(await runScenarioWithDiagnostics(cdp, "ffmpeg", () => runFfmpegFallbackScenario(cdp, state.activeThreadId))));
  }

  const live = await getLiveState(cdp);
  if (selectedScenarios.has("arxiv")) {
    for (const toolName of ["ambient_cli_package_install_pi_catalog", "ambient_cli_describe", "ambient_cli"]) {
      if (!live.toolNames.includes(toolName)) throw new Error(`Expected live chat to call ${toolName}. Tool names: ${JSON.stringify(live.toolNames)}`);
    }
    for (const forbidden of ["ambient_pi_extension_install_sandboxed", "ambient_pi_privileged_install", "ambient_pi_privileged_scan"]) {
      if (live.toolNames.includes(forbidden)) throw new Error(`Expected pi-arxiv to use the Ambient CLI adapter path, but saw ${forbidden}. Tool names: ${JSON.stringify(live.toolNames)}`);
    }
    if (!live.assistantTail.includes("PLUGIN_PANEL_ARXIV_CLI_RUN") || !/\b2303\.04137(v\d+)?\b/.test(live.assistantTail)) {
      throw new Error(`Final pi-arxiv assistant token missing. Assistant tail: ${live.assistantTail}`);
    }
  }
  if (selectedScenarios.has("ffmpeg")) {
    const privilegedCatalog = await evaluate(cdp, "window.ambientDesktop.inspectPiPrivilegedPackages()");
    if (live.privilegedScanUpdatedCount < 1) throw new Error("Expected at least one pi-privileged-scan-updated event from the live pi-ffmpeg fallback scan.");
    if (!live.toolNames.includes("ambient_pi_extension_install_sandboxed")) {
      throw new Error(`Expected live chat to call ambient_pi_extension_install_sandboxed. Tool names: ${JSON.stringify(live.toolNames)}`);
    }
    if (!live.assistantTail.includes("PLUGIN_PANEL_FFMPEG_PRIVILEGED_REVIEW_REQUIRED")) {
      throw new Error(`Fallback assistant token missing. Assistant tail: ${live.assistantTail}`);
    }
    if (privilegedCatalog.packages.length !== 0 || privilegedCatalog.history.length !== 0) {
      throw new Error(`Expected no privileged installs from review-only fallback smoke: ${JSON.stringify(privilegedCatalog)}`);
    }
  }
  const summary = {
    scenarios: [...selectedScenarios],
    pluginCatalogUpdatedCount: live.pluginCatalogUpdatedCount,
    privilegedScanUpdatedCount: live.privilegedScanUpdatedCount,
    toolNames: live.toolNames,
    toolNameCounts: live.toolNameCounts,
    toolMessageCount: live.toolNames.length,
    screenshots,
  };
  const finalState = await desktopState(cdp);
  await writeHarnessTraceArtifacts({ workspace, beforeWorkspace, messages: finalState.messages, summary });
  return summary;
}

async function runScenarioWithDiagnostics(cdp, scenario, run) {
  try {
    return await run();
  } catch (error) {
    const live = await getLiveState(cdp).catch((liveError) => ({ collectorReadError: liveError instanceof Error ? liveError.message : String(liveError) }));
    await captureScreenshot(cdp, `failure-live-chat-${scenario}`).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Live plugin chat refresh scenario '${scenario}' failed: ${message}\ncollector=${JSON.stringify(live)}`, { cause: error });
  }
}

async function runArxivRefreshScenario(cdp, threadId) {
  await runChatTurn(cdp, threadId, [
    "This is a live Ambient Desktop Pi catalog adapter smoke.",
    "Use ambient_cli_package_install_pi_catalog exactly once with source https://pi.dev/packages/pi-arxiv?name=arxiv.",
    "Then call ambient_cli_describe exactly once with packageName pi-arxiv and command arxiv_paper.",
    "Then call ambient_cli exactly once with packageName pi-arxiv, command arxiv_paper, and args [\"2303.04137\"].",
    "Do not use browser, shell, ambient_pi_extension_install_sandboxed, ambient_pi_extension, ambient_pi_privileged_scan, or ambient_pi_privileged_install.",
    "After the ambient_cli result is available, answer with exactly PLUGIN_PANEL_ARXIV_CLI_RUN and include arXiv ID 2303.04137.",
  ].join("\n"));
  await waitFor(cdp, () => window.__ambientPluginChatRefresh?.assistantTail.includes("PLUGIN_PANEL_ARXIV_CLI_RUN"), "live pi-arxiv Ambient CLI completion", 60_000);
  await captureScreenshot(cdp, "07-live-chat-pi-arxiv-cli-run");
  return [
    "test-results/plugins/07-live-chat-pi-arxiv-cli-run.png",
  ];
}

async function runFfmpegFallbackScenario(cdp, threadId) {
  await runChatTurn(cdp, threadId, [
    "Exercise the live Plugins panel sandbox fallback path.",
    "Call ambient_pi_extension_install_sandboxed exactly once with source https://pi.dev/packages/pi-ffmpeg?name=bet.",
    "Do not call ambient_pi_privileged_install, ambient_pi_privileged_scan, browser, shell, or ambient_cli tools.",
    "After the sandbox install tool result reports privileged review is required, answer exactly PLUGIN_PANEL_FFMPEG_PRIVILEGED_REVIEW_REQUIRED.",
  ].join("\n"));
  await waitFor(
    cdp,
    () =>
      document.body.innerText.includes("Sandbox fallback: pi-ffmpeg") &&
      document.body.innerText.includes("Privileged Scan: pi-ffmpeg") &&
      document.body.innerText.includes("Privileged review required") &&
      document.body.innerText.includes("From sandbox fallback"),
    "open panel rendered live chat sandbox fallback privileged review",
    120_000,
  );
  await captureScreenshot(cdp, "10-live-chat-ffmpeg-fallback-review");
  return ["test-results/plugins/10-live-chat-ffmpeg-fallback-review.png"];
}

async function installLiveCollector(cdp) {
  await evaluate(
    cdp,
    `
    (() => {
      window.__ambientPluginChatRefresh?.unsubscribe?.();
      window.__ambientPluginChatRefresh = {
        statuses: [],
        toolMessageIds: [],
        toolNames: [],
        toolNameCounts: {},
        runtimeActivities: [],
        assistantTail: "",
        pluginCatalogUpdatedCount: 0,
        privilegedScanUpdatedCount: 0,
        sawRunStart: false,
        sawRunIdle: false,
        sendResolved: true,
        error: undefined,
      };
      window.__ambientPluginChatRefresh.unsubscribe = window.ambientDesktop.onEvent((event) => {
        if (event.type === "plugin-catalog-updated") window.__ambientPluginChatRefresh.pluginCatalogUpdatedCount += 1;
        if (event.type === "pi-privileged-scan-updated") window.__ambientPluginChatRefresh.privilegedScanUpdatedCount += 1;
        if (event.type === "run-status") {
          window.__ambientPluginChatRefresh.statuses.push(event.status);
          if (event.status !== "idle") window.__ambientPluginChatRefresh.sawRunStart = true;
          if (window.__ambientPluginChatRefresh.sawRunStart && event.status === "idle") window.__ambientPluginChatRefresh.sawRunIdle = true;
        }
        if (event.type === "runtime-activity") {
          window.__ambientPluginChatRefresh.runtimeActivities.push({
            kind: event.activity?.kind,
            status: event.activity?.status,
            message: event.activity?.message,
            outputChars: event.activity?.outputChars,
            thinkingChars: event.activity?.thinkingChars,
            idleElapsedMs: event.activity?.idleElapsedMs,
            idleTimeoutMs: event.activity?.idleTimeoutMs,
          });
          window.__ambientPluginChatRefresh.runtimeActivities = window.__ambientPluginChatRefresh.runtimeActivities.slice(-12);
        }
        if (event.type === "message-delta") {
          window.__ambientPluginChatRefresh.assistantTail = (window.__ambientPluginChatRefresh.assistantTail + String(event.delta ?? "")).slice(-4000);
        }
        if ((event.type === "message-created" || event.type === "message-updated") && event.message?.role === "tool") {
          const toolName = String(event.message.metadata?.toolName ?? "");
          if (!toolName) return;
          const messageId = event.message.id === undefined || event.message.id === null ? "" : String(event.message.id);
          if (!messageId && event.type !== "message-created") return;
          const toolMessageKey = messageId || \`\${toolName}:\${window.__ambientPluginChatRefresh.toolNames.length}\`;
          if (window.__ambientPluginChatRefresh.toolMessageIds.includes(toolMessageKey)) return;
          window.__ambientPluginChatRefresh.toolMessageIds.push(toolMessageKey);
          window.__ambientPluginChatRefresh.toolNames.push(toolName);
          window.__ambientPluginChatRefresh.toolNameCounts[toolName] = (window.__ambientPluginChatRefresh.toolNameCounts[toolName] ?? 0) + 1;
        }
        if (event.type === "error") window.__ambientPluginChatRefresh.error = event.message;
      });
      return true;
    })()
  `,
  );
}

async function runChatTurn(cdp, threadId, content) {
  await evaluate(
    cdp,
    `
    (async () => {
      const live = window.__ambientPluginChatRefresh;
      const state = await window.ambientDesktop.bootstrap();
      live.sawRunStart = false;
      live.sawRunIdle = false;
      live.sendResolved = false;
      live.error = undefined;
      live.runtimeActivities = [];
      window.ambientDesktop.sendMessage({
        threadId: ${JSON.stringify(threadId)},
        content: ${JSON.stringify(content)},
        permissionMode: "full-access",
        collaborationMode: "agent",
        model: ${JSON.stringify(process.env.AMBIENT_PLUGIN_CHAT_REFRESH_MODEL ?? "")} || state.settings.model,
        thinkingLevel: "minimal",
      })
        .then(() => { live.sendResolved = true; })
        .catch((error) => { live.error = error instanceof Error ? error.message : String(error); });
      return true;
    })()
  `,
  );
  await waitForLiveCompletion(cdp, timeoutMs);
}

async function waitForLiveCompletion(cdp, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const live = await getLiveState(cdp);
    if (live.error) throw new Error(live.error);
    if (live.sawRunIdle && live.sendResolved) return;
    await delay(1_000);
  }
  const live = await getLiveState(cdp);
  throw new Error(`Timed out waiting for live chat turn. collector=${JSON.stringify(live)}`);
}

async function getLiveState(cdp) {
  return evaluate(
    cdp,
    `
    (() => {
      const live = window.__ambientPluginChatRefresh;
      return live ? {
        statuses: live.statuses,
        toolNames: live.toolNames,
        toolNameCounts: live.toolNameCounts,
        toolMessageCount: live.toolNames.length,
        runtimeActivities: live.runtimeActivities,
        assistantTail: live.assistantTail,
        pluginCatalogUpdatedCount: live.pluginCatalogUpdatedCount,
        privilegedScanUpdatedCount: live.privilegedScanUpdatedCount,
        sawRunStart: live.sawRunStart,
        sawRunIdle: live.sawRunIdle,
        sendResolved: live.sendResolved,
        error: live.error,
      } : undefined;
    })()
  `,
  );
}

async function desktopState(cdp) {
  return evaluate(cdp, "window.ambientDesktop.bootstrap()");
}

async function captureScreenshot(cdp, name) {
  const result = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  if (!result.data || result.data.length < 10_000) throw new Error(`Screenshot ${name} returned an empty image.`);
  await writeFile(join(resultsDir, `${name}.png`), Buffer.from(result.data, "base64"));
}

async function readAmbientApiKey() {
  const existing = process.env.AMBIENT_API_KEY || process.env.AMBIENT_AGENT_AMBIENT_API_KEY;
  if (existing?.trim()) return existing.trim();
  const candidates = [
    process.env.AMBIENT_API_KEY_FILE,
    join(process.cwd(), "ignored-provider-key-file.txt"),
    join(dirname(process.cwd()), "ignored-provider-key-file.txt"),
    join(dirname(dirname(process.cwd())), "ignored-provider-key-file.txt"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const value = (await readFile(candidate, "utf8")).trim();
      if (value) return value;
    } catch {
      // Try the next conventional key location.
    }
  }
  return undefined;
}

async function waitForTarget() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const target = targets.find((item) => item.webSocketDebuggerUrl && item.type === "page") ?? targets[0];
      if (target?.webSocketDebuggerUrl) return target;
    } catch {
      // App not listening yet.
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for Electron CDP target.");
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let nextId = 1;
    const pending = new Map();
    socket.addEventListener("open", () => {
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((innerResolve, innerReject) => {
            pending.set(id, { resolve: innerResolve, reject: innerReject });
            setTimeout(() => {
              if (!pending.has(id)) return;
              pending.delete(id);
              innerReject(new Error(`Timed out waiting for CDP ${method}.`));
            }, 30_000);
          });
        },
        close() {
          socket.close();
        },
      });
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message ?? "CDP error"));
      else entry.resolve(message.result);
    });
    socket.addEventListener("error", () => reject(new Error("CDP websocket failed.")));
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Runtime.evaluate failed.");
  return result.result?.value;
}

async function waitFor(cdp, predicate, label, timeoutMs = 10_000) {
  const expression = `(${predicate.toString()})()`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression)) return;
    await delay(250);
  }
  const bodyTail = await evaluate(cdp, "document.body.innerText.slice(-2000)").catch(() => "");
  throw new Error(`Timed out waiting for ${label}.\n\nBody tail:\n${bodyTail}`);
}

async function clickButton(cdp, label) {
  const clicked = await evaluate(
    cdp,
    `
    (() => {
      const needle = ${JSON.stringify(label)};
      const buttons = [...document.querySelectorAll("button, [role='button'], a")].filter(isVisibleElement);
      const button =
        buttons.find((item) => item.textContent?.includes(needle)) ??
        buttons.find((item) => item.title?.includes(needle) || item.getAttribute("aria-label")?.includes(needle));
      if (!button) return false;
      button.scrollIntoView({ block: "center", inline: "nearest" });
      button.click();
      return true;
      function isVisibleElement(element) {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      }
    })()
  `,
  );
  if (!clicked) {
    const bodyHead = await evaluate(cdp, "document.body.innerText.slice(0, 2000)").catch(() => "");
    throw new Error(`Button not found: ${label}\n\nBody head:\n${bodyHead}`);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSelectedScenarios() {
  const accepted = new Set(["arxiv", "ffmpeg"]);
  const argValues = [];
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--scenario" || arg === "--scenarios") {
      argValues.push(args[index + 1] ?? "");
      index += 1;
    } else if (arg.startsWith("--scenario=")) {
      argValues.push(arg.slice("--scenario=".length));
    } else if (arg.startsWith("--scenarios=")) {
      argValues.push(arg.slice("--scenarios=".length));
    }
  }
  const values = [
    process.env.AMBIENT_PLUGIN_CHAT_REFRESH_SCENARIOS,
    ...argValues,
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const requested = values.length ? values : ["all"];
  const scenarios = new Set();
  for (const value of requested) {
    if (value === "all") {
      for (const scenario of accepted) scenarios.add(scenario);
      continue;
    }
    if (!accepted.has(value)) {
      throw new Error(`Unknown live plugin chat refresh scenario: ${value}. Expected one of: all, ${[...accepted].join(", ")}.`);
    }
    scenarios.add(value);
  }
  return scenarios;
}

function outputTail() {
  return `Electron output tail:\n${output.join("").slice(-8000)}`;
}

async function terminateDebugPortProcesses() {
  if (process.platform === "win32") return;
  await new Promise((resolve) => {
    const child = spawn("lsof", ["-ti", `tcp:${port}`], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.on("close", () => {
      const pids = stdout
        .split(/\s+/)
        .map((value) => Number(value))
        .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Already gone.
        }
      }
      resolve();
    });
  });
  await delay(300);
}

async function terminateProcessTree(child) {
  if (!child || child.killed) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }
  await delay(500);
}
