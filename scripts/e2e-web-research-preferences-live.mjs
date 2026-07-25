#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { snapshotHarnessWorkspace, writeHarnessTraceArtifacts } from "./harness-trace-artifacts.mjs";
import { liveRunSettledAfterCurrentSend } from "./web-research-live-state.mjs";

const port = Number(process.env.AMBIENT_WEB_RESEARCH_PREFS_CDP_PORT ?? 9496);
const timeoutMs = Number(process.env.AMBIENT_WEB_RESEARCH_PREFS_TIMEOUT_MS ?? 420_000);
const finalToken = "WEB_RESEARCH_PREF_UPDATE_LIVE_DONE";
const workspace = await mkdtemp(join(tmpdir(), "ambient-web-research-prefs-workspace-"));
const userData = await mkdtemp(join(tmpdir(), "ambient-web-research-prefs-user-data-"));
const output = [];
const children = new Set();
let appInstance;
let beforeWorkspace;

try {
  await mkdir(workspace, { recursive: true });
  beforeWorkspace = await snapshotHarnessWorkspace(workspace);
  const ambientApiKey = await readAmbientApiKey();
  if (!ambientApiKey) {
    throw new Error(
      "Set AMBIENT_API_KEY, AMBIENT_AGENT_AMBIENT_API_KEY, AMBIENT_API_KEY_FILE, or place ignored-provider-key-file.txt / ambient_api_key_u.txt near the repo.",
    );
  }
  appInstance = await launchApp(ambientApiKey);
  const summary = await runLivePreferenceSmoke(appInstance.cdp);
  console.log(JSON.stringify(summary, null, 2));
  console.log("Live web research preference smoke passed.");
} catch (error) {
  console.error(outputTail());
  throw error;
} finally {
  appInstance?.cdp.close();
  if (appInstance?.child) await terminateProcessTree(appInstance.child);
  for (const child of children) await terminateProcessTree(child);
  await terminateDebugPortProcesses();
  await rm(workspace, { recursive: true, force: true });
  await rm(userData, { recursive: true, force: true });
}

async function launchApp(ambientApiKey) {
  const child = spawn("pnpm", ["exec", "electron-vite", "dev", "--", `--remote-debugging-port=${port}`], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AMBIENT_PROVIDER: process.env.AMBIENT_PROVIDER ?? "ambient",
      AMBIENT_DESKTOP_WORKSPACE: workspace,
      AMBIENT_E2E: "1",
      AMBIENT_E2E_USER_DATA: userData,
      AMBIENT_CODEX_CURATED_MARKETPLACE_URL: "0",
      AMBIENT_PI_USER_SETTINGS_PATH: join(userData, "missing-pi-settings.json"),
      AMBIENT_API_KEY: ambientApiKey,
      AMBIENT_AGENT_AMBIENT_API_KEY: ambientApiKey,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));

  const target = await waitForTarget();
  await delay(750);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await waitFor(cdp, () => document.body?.innerText.includes("Ambient"), "main shell", 30_000);
  return { child, cdp };
}

async function runLivePreferenceSmoke(cdp) {
  const state = await desktopState(cdp);
  if (!state.provider.hasApiKey) throw new Error("Ambient API key was not visible to the launched app.");
  const keyCheck = await evaluate(cdp, "window.ambientDesktop.testAmbientApiKey()");
  if (!keyCheck?.ok) throw new Error(`Ambient API key check failed: ${keyCheck?.message ?? "unknown error"}`);

  await seedNonDefaultSearchPreference(cdp);
  const beforeSettings = await searchSettings(cdp);
  if (beforeSettings.webResearch?.preferences?.search?.[0] !== "ambient-browser") {
    throw new Error(`Expected non-default browser-first seed. Settings: ${JSON.stringify(beforeSettings)}`);
  }

  await installLiveCollector(cdp);
  const completion = await runChatTurn(cdp, state.activeThreadId, [
    "Reset the global Search & Web public search provider preference to Ambient's default provider order.",
    "Use the first-class web research preference update tool for the persistent settings change with action=reset_search_defaults.",
    "Do not use the legacy ambient_search_preference_update compatibility alias.",
    "Do not use browser tools, shell, file tools, or MCP tools.",
    `After the preference tool result is available, answer exactly ${finalToken}.`,
  ].join("\n"));

  const live = await getLiveState(cdp);
  const afterSettings = await searchSettings(cdp);
  const searchOrder = afterSettings.webResearch?.preferences?.search ?? [];
  if (!hasToolEvidence(live, "web_research_preferences_update")) {
    throw new Error(`Expected web_research_preferences_update tool call. Live state: ${JSON.stringify(live)}`);
  }
  if (calledToolByMetadata(live, "ambient_search_preference_update")) {
    throw new Error(`Expected no legacy ambient_search_preference_update calls. Live state: ${JSON.stringify(live)}`);
  }
  if (searchOrder[0] !== "exa-mcp-default" || searchOrder[1] !== "ambient-browser") {
    throw new Error(`Expected default Exa -> browser search order after reset. Settings: ${JSON.stringify(afterSettings)} Live state: ${JSON.stringify(live)}`);
  }
  if (afterSettings.webResearch?.fallbackPolicy?.allowBrowserFallback !== true) {
    throw new Error(`Expected browser fallback to be allowed after reset. Settings: ${JSON.stringify(afterSettings)}`);
  }
  if (!completion.providerStalledAfterTool && !live.assistantTail.includes(finalToken)) {
    throw new Error(`Expected final token ${finalToken}. Live state: ${JSON.stringify(live)}`);
  }

  const finalState = await desktopState(cdp);
  const summary = {
    workspace,
    provider: state.provider.provider,
    model: process.env.AMBIENT_WEB_RESEARCH_PREFS_MODEL || state.settings.model,
    toolNames: live.toolNames,
    toolNameCounts: live.toolNameCounts,
    beforeSearchOrder: beforeSettings.webResearch?.preferences?.search ?? [],
    afterSearchOrder: searchOrder,
    browserFallbackAllowed: afterSettings.webResearch?.fallbackPolicy?.allowBrowserFallback,
    providerFinalization: completion.providerStalledAfterTool ? "stalled-after-tool" : "completed",
    runtimeActivities: live.runtimeActivities,
    toolMessages: live.toolMessages,
  };
  await writeHarnessTraceArtifacts({ workspace, beforeWorkspace, messages: finalState.messages, summary });
  return summary;
}

async function seedNonDefaultSearchPreference(cdp) {
  return evaluate(
    cdp,
    `
    window.ambientDesktop.updateSearchRoutingSettings({
      webResearch: {
        schemaVersion: "ambient-web-research-provider-stack-v1",
        providers: [
          { providerId: "exa-mcp-default", label: "Exa Search", kind: "remote-mcp", roles: ["search", "fetch"], status: "enabled" },
          { providerId: "ambient-browser", label: "Ambient Browser", kind: "built-in-browser", roles: ["search", "fetch", "interactive_browser"], status: "enabled" },
          { providerId: "scrapling-mcp-default", label: "Scrapling", kind: "toolhive-mcp", roles: ["fetch"], status: "enabled" }
        ],
        preferences: {
          search: ["ambient-browser", "exa-mcp-default"],
          fetch: ["scrapling-mcp-default", "exa-mcp-default", "ambient-browser"],
          interactive_browser: ["ambient-browser"]
        },
        fallbackPolicy: { allowBrowserFallback: false },
        updatedAt: "2026-05-26T00:00:00.000Z"
      }
    })
  `,
  );
}

async function searchSettings(cdp) {
  return evaluate(cdp, "window.ambientDesktop.bootstrap().then((state) => state.settings.search)");
}

async function installLiveCollector(cdp) {
  await evaluate(
    cdp,
    `
    (() => {
      window.__ambientWebResearchPrefs?.unsubscribe?.();
      window.__ambientWebResearchPrefs = {
        statuses: [],
        toolMessageIds: [],
        toolNames: [],
        toolNameCounts: {},
        runtimeActivities: [],
        toolMessages: [],
        assistantTail: "",
        sawRunStart: false,
        sawRunIdle: false,
        lastStatusAtMs: 0,
        sendResolved: true,
        error: undefined,
      };
      window.__ambientWebResearchPrefs.unsubscribe = window.ambientDesktop.onEvent((event) => {
        if (event.type === "run-status") {
          window.__ambientWebResearchPrefs.lastStatusAtMs = Date.now();
          window.__ambientWebResearchPrefs.statuses.push(event.status);
          if (event.status !== "idle") window.__ambientWebResearchPrefs.sawRunStart = true;
          if (window.__ambientWebResearchPrefs.sawRunStart && event.status === "idle") window.__ambientWebResearchPrefs.sawRunIdle = true;
        }
        if (event.type === "runtime-activity") {
          window.__ambientWebResearchPrefs.runtimeActivities.push({
            kind: event.activity?.kind,
            status: event.activity?.status,
            toolName: event.activity?.toolName ?? event.activity?.details?.toolName,
            message: event.activity?.message,
            outputChars: event.activity?.outputChars,
            thinkingChars: event.activity?.thinkingChars,
            idleElapsedMs: event.activity?.idleElapsedMs,
            idleTimeoutMs: event.activity?.idleTimeoutMs,
          });
          window.__ambientWebResearchPrefs.runtimeActivities = window.__ambientWebResearchPrefs.runtimeActivities.slice(-16);
        }
        if (event.type === "message-delta") {
          window.__ambientWebResearchPrefs.assistantTail = (window.__ambientWebResearchPrefs.assistantTail + String(event.delta ?? "")).slice(-4000);
        }
        if ((event.type === "message-created" || event.type === "message-updated") && event.message?.role === "tool") {
          const toolName = String(event.message.metadata?.toolName ?? "");
          if (!toolName) return;
          const messageId = event.message.id === undefined || event.message.id === null ? "" : String(event.message.id);
          const toolMessageKey = messageId || \`\${toolName}:\${window.__ambientWebResearchPrefs.toolNames.length}\`;
          if (window.__ambientWebResearchPrefs.toolMessageIds.includes(toolMessageKey)) return;
          window.__ambientWebResearchPrefs.toolMessageIds.push(toolMessageKey);
          window.__ambientWebResearchPrefs.toolNames.push(toolName);
          window.__ambientWebResearchPrefs.toolNameCounts[toolName] = (window.__ambientWebResearchPrefs.toolNameCounts[toolName] ?? 0) + 1;
          window.__ambientWebResearchPrefs.toolMessages.push({
            toolName,
            metadata: event.message.metadata ?? {},
            content: String(event.message.content ?? "").slice(0, 4000),
          });
          window.__ambientWebResearchPrefs.toolMessages = window.__ambientWebResearchPrefs.toolMessages.slice(-12);
        }
        if (event.type === "error") window.__ambientWebResearchPrefs.error = event.message;
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
      const live = window.__ambientWebResearchPrefs;
      const state = await window.ambientDesktop.bootstrap();
      live.sawRunStart = false;
      live.sawRunIdle = false;
      live.lastStatusAtMs = 0;
      live.sendResolved = false;
      live.error = undefined;
      live.runtimeActivities = [];
      window.ambientDesktop.sendMessage({
        threadId: ${JSON.stringify(threadId)},
        content: ${JSON.stringify(content)},
        permissionMode: "full-access",
        collaborationMode: "agent",
        model: ${JSON.stringify(process.env.AMBIENT_WEB_RESEARCH_PREFS_MODEL ?? "")} || state.settings.model,
        thinkingLevel: "minimal",
      })
        .then(() => { live.sendResolved = true; })
        .catch((error) => { live.error = error instanceof Error ? error.message : String(error); });
      return true;
    })()
  `,
  );
  return waitForLiveCompletion(cdp, timeoutMs);
}

async function waitForLiveCompletion(cdp, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const live = await getLiveState(cdp);
    if (live.error) throw new Error(live.error);
    if (liveRunSettledAfterCurrentSend(live, { idleGraceMs: 2_000 })) return { providerStalledAfterTool: false };
    if (streamStalled(live) && hasToolEvidence(live, "web_research_preferences_update")) {
      const settings = await searchSettings(cdp).catch(() => undefined);
      const searchOrder = settings?.webResearch?.preferences?.search ?? [];
      if (searchOrder[0] === "exa-mcp-default" && searchOrder[1] === "ambient-browser") {
        return { providerStalledAfterTool: true };
      }
    }
    await delay(1_000);
  }
  const live = await getLiveState(cdp);
  throw new Error(`Timed out waiting for live web research preference chat turn. collector=${JSON.stringify(live)}`);
}

async function getLiveState(cdp) {
  return evaluate(
    cdp,
    `
    (() => {
      const live = window.__ambientWebResearchPrefs;
      return live ? {
        statuses: live.statuses,
        toolNames: live.toolNames,
        toolNameCounts: live.toolNameCounts,
        toolMessageCount: live.toolNames.length,
        toolMessages: live.toolMessages,
        runtimeActivities: live.runtimeActivities,
        assistantTail: live.assistantTail,
        sawRunStart: live.sawRunStart,
        sawRunIdle: live.sawRunIdle,
        lastStatusAtMs: live.lastStatusAtMs,
        sendResolved: live.sendResolved,
        error: live.error,
      } : undefined;
    })()
  `,
  );
}

function hasToolEvidence(live, toolName) {
  if (live.toolNames?.includes(toolName)) return true;
  return JSON.stringify([live.toolMessages ?? [], live.runtimeActivities ?? []]).includes(toolName);
}

function calledToolByMetadata(live, toolName) {
  if (live.toolNames?.includes(toolName)) return true;
  return (live.toolMessages ?? []).some((message) => {
    const metadata = message.metadata ?? {};
    return metadata.wrappedTool === toolName || metadata.resultDetails?.toolName === toolName || metadata.targetToolName === toolName;
  });
}

function streamStalled(live) {
  return (live.runtimeActivities ?? []).some((activity) =>
    activity.status === "timeout" || String(activity.message ?? "").includes("stream stalled")
  );
}

async function desktopState(cdp) {
  return evaluate(cdp, "window.ambientDesktop.bootstrap()");
}

async function readAmbientApiKey() {
  const existing = process.env.AMBIENT_API_KEY || process.env.AMBIENT_AGENT_AMBIENT_API_KEY;
  if (existing?.trim()) return existing.trim();
  const candidates = [
    process.env.AMBIENT_API_KEY_FILE,
    join(process.cwd(), "ambient_api_key_u.txt"),
    join(process.cwd(), "ignored-provider-key-file.txt"),
    join(dirname(process.cwd()), "ambient_api_key_u.txt"),
    join(dirname(process.cwd()), "ignored-provider-key-file.txt"),
    join(dirname(dirname(process.cwd())), "ambient_api_key_u.txt"),
    join(dirname(dirname(process.cwd())), "ignored-provider-key-file.txt"),
    join(homedir(), "ambient_api_key_u.txt"),
    join(homedir(), "ignored-provider-key-file.txt"),
    "/Users/example/Documents/ambientCoder/ambient_api_key_u.txt",
    "/Users/example/Documents/ambientCoder/ignored-provider-key-file.txt",
    "/Users/example/Documents/New project 3/ambient_api_key_u.txt",
    "/Users/example/Documents/New project 3/ignored-provider-key-file.txt",
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
  const deadline = Date.now() + 45_000;
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
