#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { snapshotHarnessWorkspace, writeHarnessTraceArtifacts } from "./harness-trace-artifacts.mjs";

const port = Number(process.env.AMBIENT_WEB_RESEARCH_BROKER_CDP_PORT ?? 9497);
const timeoutMs = Number(process.env.AMBIENT_WEB_RESEARCH_BROKER_TIMEOUT_MS ?? 300_000);
const scenario = process.env.AMBIENT_WEB_RESEARCH_BROKER_SCENARIO === "fetch" ? "fetch" : "search";
const installScrapling = process.env.AMBIENT_WEB_RESEARCH_BROKER_INSTALL_SCRAPLING === "1";
const scraplingWorkloadName = "ambient-scrapling";
const scenarioConfig = {
  search: {
    expectedTool: "web_research_search",
    finalToken: "WEB_RESEARCH_BROKER_SELECTION_LIVE_DONE",
    prompt: [
      "Find current public web information about the latest Node.js LTS release.",
      "This is an ordinary public knowledge retrieval request, not a browser UI task.",
      "Do not use shell commands, local files, MCP install tools, or preference update tools.",
      "When you have enough source context, answer exactly WEB_RESEARCH_BROKER_SELECTION_LIVE_DONE followed by one short sentence.",
    ],
  },
  fetch: {
    expectedTool: "web_research_fetch",
    finalToken: "WEB_RESEARCH_FETCH_SELECTION_LIVE_DONE",
    prompt: [
      "Read this known public URL and identify the release title from the page: https://nodejs.org/en/blog/release/v26.0.0",
      "This is an ordinary public URL read, not a browser UI task. Use the provided URL directly and do not search for another source.",
      "Do not use shell commands, local files, MCP install tools, preference update tools, or direct browser tools.",
      "When you have enough source context, answer exactly WEB_RESEARCH_FETCH_SELECTION_LIVE_DONE followed by one short sentence.",
    ],
  },
}[scenario];
const workspace = await mkdtemp(join(tmpdir(), "ambient-web-research-broker-workspace-"));
const userData = await mkdtemp(join(tmpdir(), "ambient-web-research-broker-user-data-"));
const output = [];
const children = new Set();
let appInstance;
let beforeWorkspace;
let installedScraplingForThisRun = false;

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
  const summary = await runLiveBrokerSelectionSmoke(appInstance.cdp);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Live web research ${scenario} broker selection smoke passed.`);
} catch (error) {
  console.error(outputTail());
  throw error;
} finally {
  if (installedScraplingForThisRun && appInstance?.cdp) {
    await uninstallScraplingDefaultCapability(appInstance.cdp).catch((error) => {
      console.error(`Failed to clean up live Scrapling workload: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
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

async function runLiveBrokerSelectionSmoke(cdp) {
  const state = await desktopState(cdp);
  if (!state.provider.hasApiKey) throw new Error("Ambient API key was not visible to the launched app.");
  const keyCheck = await evaluate(cdp, "window.ambientDesktop.testAmbientApiKey()");
  if (!keyCheck?.ok) throw new Error(`Ambient API key check failed: ${keyCheck?.message ?? "unknown error"}`);

  await installScraplingDefaultCapabilityIfRequested(cdp);
  await seedDefaultSearchPreference(cdp);
  await installLiveCollector(cdp);
  const completion = await runChatTurn(cdp, state.activeThreadId, scenarioConfig.prompt.join("\n"));

  const live = await getLiveState(cdp);
  if (!hasToolEvidence(live, scenarioConfig.expectedTool)) {
    throw new Error(`Expected ordinary public ${scenario} research to select ${scenarioConfig.expectedTool}. Live state: ${JSON.stringify(live)}`);
  }
  const directBrowserTools = directBrowserResearchTools(live);
  if (directBrowserTools.length > 0) {
    throw new Error(`Expected no direct browser research tools. Saw ${directBrowserTools.join(", ")}. Live state: ${JSON.stringify(live)}`);
  }
  if (completion.status === "completed" && !live.assistantTail.includes(scenarioConfig.finalToken)) {
    throw new Error(`Expected final token ${scenarioConfig.finalToken}. Live state: ${JSON.stringify(live)}`);
  }

  const finalState = await desktopState(cdp);
  const brokerToolMessages = (live.toolMessages ?? []).filter((message) => message.toolName === scenarioConfig.expectedTool);
  assertScenarioBrokerDetails(brokerToolMessages);
  const summary = {
    workspace,
    provider: state.provider.provider,
    model: process.env.AMBIENT_WEB_RESEARCH_BROKER_MODEL || state.settings.model,
    scenario,
    installedScrapling: installScrapling,
    status: completion.status,
    selectedBroker: true,
    expectedTool: scenarioConfig.expectedTool,
    directBrowserResearchTools: directBrowserTools,
    toolNames: live.toolNames,
    toolNameCounts: live.toolNameCounts,
    runtimeActivities: live.runtimeActivities,
    brokerToolMessages,
  };
  await writeHarnessTraceArtifacts({ workspace, beforeWorkspace, messages: finalState.messages, summary });
  return summary;
}

function assertScenarioBrokerDetails(messages) {
  const combined = messages.map((message) => String(message.content ?? "")).join("\n");
  if (scenario === "search" && !combined.includes("exa-mcp-default: succeeded")) {
    throw new Error(`Expected search broker attempt ledger to show Exa success. Broker messages: ${JSON.stringify(messages)}`);
  }
  if (scenario === "fetch") {
    const attemptLines = combined
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^\d+\.\s+/.test(line));
    const scraplingIndex = attemptLines.findIndex((line) => line.includes("scrapling-mcp-default"));
    const exaIndex = attemptLines.findIndex((line) => line.includes("exa-mcp-default"));
    if (installScrapling) {
      if (scraplingIndex < 0) {
        throw new Error(`Expected installed-MCP fetch broker ledger to mention Scrapling. Broker messages: ${JSON.stringify(messages)}`);
      }
      if (!attemptLines[scraplingIndex]?.includes("succeeded")) {
        throw new Error(`Expected installed-MCP fetch broker ledger to show Scrapling success. Broker messages: ${JSON.stringify(messages)}`);
      }
      if (exaIndex >= 0 && scraplingIndex > exaIndex) {
        throw new Error(`Expected installed-MCP fetch broker ledger to try Scrapling before Exa. Broker messages: ${JSON.stringify(messages)}`);
      }
      return;
    }
    if (scraplingIndex < 0 || exaIndex < 0) {
      throw new Error(`Expected fetch broker attempt ledger to mention Scrapling and Exa. Broker messages: ${JSON.stringify(messages)}`);
    }
    if (scraplingIndex > exaIndex) {
      throw new Error(`Expected fetch broker attempt ledger to try Scrapling before Exa. Broker messages: ${JSON.stringify(messages)}`);
    }
    if (!combined.includes("exa-mcp-default: succeeded")) {
      throw new Error(`Expected fetch broker attempt ledger to show Exa success before browser fallback. Broker messages: ${JSON.stringify(messages)}`);
    }
  }
}

async function installScraplingDefaultCapabilityIfRequested(cdp) {
  if (!installScrapling) return;
  if (scenario !== "fetch") {
    throw new Error("AMBIENT_WEB_RESEARCH_BROKER_INSTALL_SCRAPLING=1 is only supported for the fetch scenario.");
  }
  await installPermissionAutoApprover(cdp);
  const runtime = await evaluate(cdp, "window.ambientDesktop.getMcpContainerRuntimeStatus()");
  if (runtime?.status !== "ready") {
    throw new Error(`Cannot run installed-MCP broker smoke because the container runtime is not ready: ${JSON.stringify(runtime)}`);
  }
  await evaluate(
    cdp,
    `
    (() => {
      window.__ambientWebResearchBrokerSetup ??= {};
      window.__ambientWebResearchBrokerSetup.install = { done: false, ok: false };
      window.ambientDesktop.installMcpDefaultCapability({ capabilityId: "scrapling" })
        .then((result) => { window.__ambientWebResearchBrokerSetup.install = { done: true, ok: true, result }; })
        .catch((error) => {
          window.__ambientWebResearchBrokerSetup.install = {
            done: true,
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          };
        });
      return true;
    })()
  `,
  );
  const result = await waitForSetupOperation(cdp, "install", 360_000);
  if (!result?.ok) {
    throw new Error(`Scrapling default capability install failed: ${result?.message ?? "unknown error"}`);
  }
  const installResult = result.result;
  if (!["installed", "already-installed"].includes(installResult?.status)) {
    throw new Error(`Scrapling default capability install did not succeed: ${JSON.stringify(installResult)}`);
  }
  installedScraplingForThisRun = installResult.status === "installed" && installResult.adoptedExistingWorkload !== true;
  const installed = await evaluate(cdp, "window.ambientDesktop.listMcpInstalledServers()");
  const scrapling = (installed ?? []).find((server) => server.workloadName === "ambient-scrapling");
  if (!scrapling) {
    throw new Error(`Scrapling install completed but no ambient-scrapling installed server was visible: ${JSON.stringify(installed)}`);
  }
}

async function uninstallScraplingDefaultCapability(cdp) {
  await installPermissionAutoApprover(cdp);
  await evaluate(
    cdp,
    `
    (() => {
      window.__ambientWebResearchBrokerSetup ??= {};
      window.__ambientWebResearchBrokerSetup.uninstall = { done: false, ok: false };
      window.ambientDesktop.uninstallMcpServer({ workloadName: ${JSON.stringify(scraplingWorkloadName)} })
        .then((result) => { window.__ambientWebResearchBrokerSetup.uninstall = { done: true, ok: true, result }; })
        .catch((error) => {
          window.__ambientWebResearchBrokerSetup.uninstall = {
            done: true,
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          };
        });
      return true;
    })()
  `,
  );
  const result = await waitForSetupOperation(cdp, "uninstall", 180_000);
  if (!result?.ok) {
    throw new Error(result?.message ?? "unknown MCP uninstall error");
  }
  return result.result;
}

async function waitForSetupOperation(cdp, operation, maxMs) {
  const deadline = Date.now() + maxMs;
  let lastSetupPermissions;
  while (Date.now() < deadline) {
    lastSetupPermissions = await evaluate(cdp, "window.__ambientWebResearchBrokerSetupPermissions").catch(() => undefined);
    if (lastSetupPermissions?.error) throw new Error(`Scrapling setup permission response failed: ${lastSetupPermissions.error}`);
    const state = await evaluate(
      cdp,
      `
      (() => window.__ambientWebResearchBrokerSetup?.[${JSON.stringify(operation)}] ?? { done: false })()
    `,
    );
    if (state?.done) return state;
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for Scrapling ${operation}. setupPermissions=${JSON.stringify(lastSetupPermissions)}`);
}

async function installPermissionAutoApprover(cdp) {
  return evaluate(
    cdp,
    `
    (() => {
      window.__ambientWebResearchBrokerSetupPermissions?.unsubscribe?.();
      window.__ambientWebResearchBrokerSetupPermissions = {
        approved: 0,
        error: undefined,
      };
      window.__ambientWebResearchBrokerSetupPermissions.unsubscribe = window.ambientDesktop.onEvent((event) => {
        if (event.type !== "permission-request") return;
        const request = event.request ?? {};
        const text = [request.title, request.message, request.detail, request.toolName, request.grantTargetLabel].filter(Boolean).join("\\n");
        if (request.risk !== "plugin-tool" || !/Scrapling|ambient_mcp_default_capability_install|ambient_mcp_server_uninstall|ambient-scrapling/i.test(text)) return;
        window.__ambientWebResearchBrokerSetupPermissions.approved += 1;
        window.ambientDesktop.respondPermissionRequest(request.id, "allow_once").catch((error) => {
          window.__ambientWebResearchBrokerSetupPermissions.error = error instanceof Error ? error.message : String(error);
        });
      });
      return true;
    })()
  `,
  );
}

async function seedDefaultSearchPreference(cdp) {
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
          search: ["exa-mcp-default", "ambient-browser"],
          fetch: ["scrapling-mcp-default", "exa-mcp-default", "ambient-browser"],
          interactive_browser: ["ambient-browser"]
        },
        fallbackPolicy: { allowBrowserFallback: true },
        updatedAt: "2026-05-26T00:00:00.000Z"
      }
    })
  `,
  );
}

async function installLiveCollector(cdp) {
  await evaluate(
    cdp,
    `
    (() => {
      window.__ambientWebResearchBroker?.unsubscribe?.();
      window.__ambientWebResearchBroker = {
        statuses: [],
        toolMessageIds: [],
        toolNames: [],
        toolNameCounts: {},
        runtimeActivities: [],
        toolMessages: [],
        assistantTail: "",
        sawRunStart: false,
        sawRunIdle: false,
        sendResolved: true,
        error: undefined,
      };
      window.__ambientWebResearchBroker.unsubscribe = window.ambientDesktop.onEvent((event) => {
        const live = window.__ambientWebResearchBroker;
        if (event.type === "run-status") {
          live.statuses.push(event.status);
          if (event.status !== "idle") live.sawRunStart = true;
          if (live.sawRunStart && event.status === "idle") live.sawRunIdle = true;
        }
        if (event.type === "runtime-activity") {
          live.runtimeActivities.push({
            kind: event.activity?.kind,
            status: event.activity?.status,
            toolName: event.activity?.toolName ?? event.activity?.details?.toolName,
            message: event.activity?.message,
            outputChars: event.activity?.outputChars,
            thinkingChars: event.activity?.thinkingChars,
            idleElapsedMs: event.activity?.idleElapsedMs,
            idleTimeoutMs: event.activity?.idleTimeoutMs,
          });
          live.runtimeActivities = live.runtimeActivities.slice(-20);
        }
        if (event.type === "message-delta") {
          live.assistantTail = (live.assistantTail + String(event.delta ?? "")).slice(-4000);
        }
        if ((event.type === "message-created" || event.type === "message-updated") && event.message?.role === "tool") {
          const toolName = String(event.message.metadata?.toolName ?? "");
          if (!toolName) return;
          const messageId = event.message.id === undefined || event.message.id === null ? "" : String(event.message.id);
          const key = messageId || \`\${toolName}:\${live.toolNames.length}\`;
          const existingIndex = live.toolMessageIds.indexOf(key);
          const payload = {
            id: key,
            toolName,
            metadata: event.message.metadata ?? {},
            content: String(event.message.content ?? "").slice(0, 4000),
          };
          if (existingIndex >= 0) {
            live.toolMessages[existingIndex] = payload;
            return;
          }
          live.toolMessageIds.push(key);
          live.toolNames.push(toolName);
          live.toolNameCounts[toolName] = (live.toolNameCounts[toolName] ?? 0) + 1;
          live.toolMessages.push(payload);
          live.toolMessages = live.toolMessages.slice(-16);
        }
        if (event.type === "error") live.error = event.message;
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
      const live = window.__ambientWebResearchBroker;
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
        model: ${JSON.stringify(process.env.AMBIENT_WEB_RESEARCH_BROKER_MODEL ?? "")} || state.settings.model,
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
    const browserTools = directBrowserResearchTools(live);
    if (browserTools.length > 0 && !hasToolEvidence(live, scenarioConfig.expectedTool)) {
      throw new Error(`Direct browser research tool selected before broker: ${browserTools.join(", ")}. Live state: ${JSON.stringify(live)}`);
    }
    if (live.sawRunIdle && live.sendResolved) return { status: "completed" };
    if (streamStalled(live) && hasToolEvidence(live, scenarioConfig.expectedTool)) {
      return { status: "selected-but-provider-stalled" };
    }
    await delay(1_000);
  }
  const live = await getLiveState(cdp);
  throw new Error(`Timed out waiting for live web research broker selection chat turn. collector=${JSON.stringify(live)}`);
}

async function getLiveState(cdp) {
  return evaluate(
    cdp,
    `
    (() => {
      const live = window.__ambientWebResearchBroker;
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

function directBrowserResearchTools(live) {
  const names = new Set(live.toolNames ?? []);
  for (const message of live.toolMessages ?? []) {
    if (message.toolName) names.add(message.toolName);
    const metadata = message.metadata ?? {};
    if (metadata.wrappedTool) names.add(String(metadata.wrappedTool));
    if (metadata.resultDetails?.toolName) names.add(String(metadata.resultDetails.toolName));
  }
  return ["browser_search", "browser_content"].filter((toolName) => names.has(toolName));
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

async function waitFor(cdp, predicate, label, maxWaitMs = 10_000) {
  const expression = `(${predicate.toString()})()`;
  const deadline = Date.now() + maxWaitMs;
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
