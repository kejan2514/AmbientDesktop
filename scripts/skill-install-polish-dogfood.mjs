#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repoRoot = process.cwd();
const resultsDir = join(repoRoot, "test-results", "skill-install-polish");
const latestReportPath = join(resultsDir, "latest.json");
const defaultProvider = "ambient";
const defaultModel = "example/model-id";
const appWaitTimeoutMs = 90_000;
const liveTurnTimeoutMs = Number(process.env.AMBIENT_SKILL_INSTALL_POLISH_LIVE_TIMEOUT_MS ?? 240_000);
const cdpCommandTimeoutMs = 20_000;
const liveMarker = "SKILL_INSTALL_POLISH_LIVE_OK";

let scratch;
let dogfoodEnv;
let app;
let cdp;
let report = {
  scenario: "skill-install-polish",
  status: "running",
  startedAt: new Date().toISOString(),
  git: {
    branch: gitValue(["rev-parse", "--abbrev-ref", "HEAD"]),
    commit: gitValue(["rev-parse", "HEAD"]),
  },
  provider: {
    providerId: process.env.AMBIENT_PROVIDER || defaultProvider,
    modelId: process.env.AMBIENT_LIVE_MODEL || process.env.GMI_CLOUD_MODEL || process.env.AMBIENT_MODEL || defaultModel,
  },
  checks: {},
  artifacts: {},
};

try {
  await rm(latestReportPath, { force: true });
  await mkdir(resultsDir, { recursive: true });
  scratch = await createScratch();
  dogfoodEnv = buildDogfoodEnv(scratch);
  await run("pnpm", ["run", "prepare:node-native"], dogfoodEnv);
  report.checks.contractScenarios = await runContractScenarios(dogfoodEnv);
  report.artifacts.contractScenarios = outputPathRelative(contractScenariosReportPath());
  await run("pnpm", ["run", "prepare:electron-native"], dogfoodEnv);

  app = launchDesktop(scratch, dogfoodEnv);
  cdp = await connectToElectron(dogfoodCdpPort(), app);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await setViewport(cdp, 1500, 950);
  await waitForText(cdp, "Ambient", appWaitTimeoutMs);
  await waitForText(cdp, expectedProviderLabel(), appWaitTimeoutMs);
  await installLiveCollector(cdp);

  const threadId = await createDogfoodThread(cdp);
  report.threadId = threadId;
  report.checks.liveTurn = await runLiveModelTurn(cdp, threadId);
  report.artifacts.liveTurnScreenshot = await writeScreenshot(cdp, "live-turn.png");
  report.checks.slashCatalog = await verifySlashCatalog(cdp);
  report.artifacts.slashCatalogScreenshot = await writeScreenshot(cdp, "slash-catalog.png");
  report.checks.continuationLabels = await verifyContinuationLabels(cdp, threadId);
  report.artifacts.continuationLabelsScreenshot = await writeScreenshot(cdp, "continuation-labels.png");
  report.checks.routeGuardSurface = await verifyRouteGuardSurface();

  report.status = "passed";
  report.completedAt = new Date().toISOString();
  await writeReport(report);
  console.log(`Skill install polish dogfood passed. Results: ${outputPathRelative(latestReportPath)}`);
} catch (error) {
  const failure = error instanceof Error ? error : new Error(String(error));
  report.status = "failed";
  report.completedAt = new Date().toISOString();
  report.error = failure.stack ?? failure.message;
  if (cdp) {
    report.artifacts.failureScreenshot = await writeScreenshot(cdp, "failure.png").catch((screenshotError) => ({
      error: screenshotError instanceof Error ? screenshotError.message : String(screenshotError),
    }));
    report.bodyTail = await bodyText(cdp).then((text) => text.slice(-4000)).catch(() => undefined);
    report.liveCollector = await getLiveState(cdp).catch(() => undefined);
  }
  await writeReport(report).catch(() => undefined);
  console.error(failure.stack ?? failure.message);
  process.exitCode = 1;
} finally {
  cdp?.close?.();
  await terminateProcessTree(app);
  if (dogfoodEnv) {
    try {
      await run("pnpm", ["run", "prepare:node-native"], dogfoodEnv);
    } catch (error) {
      process.exitCode = 1;
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    }
  }
  if (scratch && process.env.AMBIENT_SKILL_INSTALL_POLISH_KEEP_SCRATCH !== "1") {
    await rm(scratch.root, { recursive: true, force: true }).catch(() => undefined);
  } else if (scratch) {
    console.error(`Keeping skill install polish dogfood scratch: ${scratch.root}`);
  }
}

async function createScratch() {
  const root = await mkdtemp(join(tmpdir(), "ambient-skill-install-polish-dogfood-"));
  const workspacePath = join(root, "workspace");
  const userDataPath = join(root, "userData");
  await mkdir(workspacePath, { recursive: true });
  await mkdir(userDataPath, { recursive: true });
  const sourceUserData = sourceUserDataPath();
  if (sourceUserData) await cp(sourceUserData, userDataPath, { recursive: true, force: true });
  await writeFile(
    join(workspacePath, "README.md"),
    "# Skill Install Polish Dogfood\n\nDisposable workspace for slash command and continuation label validation.\n",
    "utf8",
  );
  return { root, workspacePath, userDataPath };
}

function sourceUserDataPath() {
  const value = process.env.AMBIENT_SKILL_INSTALL_POLISH_SOURCE_USER_DATA || process.env.AMBIENT_E2E_USER_DATA;
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!existsSync(trimmed)) throw new Error(`Configured source userData path does not exist: ${trimmed}`);
  return trimmed;
}

function buildDogfoodEnv(input) {
  return cleanChildEnv({
    ...process.env,
    ...providerEnv(process.env),
    ...ambientApiKeyEnv(),
    AMBIENT_E2E: "1",
    AMBIENT_DESKTOP_WORKSPACE: input.workspacePath,
    AMBIENT_E2E_USER_DATA: input.userDataPath,
  });
}

function providerEnv(env) {
  const providerId = env.AMBIENT_PROVIDER || defaultProvider;
  const modelId = env.AMBIENT_LIVE_MODEL || env.GMI_CLOUD_MODEL || env.AMBIENT_MODEL || defaultModel;
  return providerId === "gmi-cloud"
    ? { AMBIENT_PROVIDER: providerId, GMI_CLOUD_MODEL: modelId }
    : { AMBIENT_PROVIDER: providerId, AMBIENT_LIVE_MODEL: modelId };
}

function launchDesktop(input, env) {
  return spawn("pnpm", ["exec", "electron-vite", "dev", "--", `--remote-debugging-port=${dogfoodCdpPort()}`], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: {
      ...env,
      AMBIENT_E2E: "1",
      AMBIENT_DESKTOP_WORKSPACE: input.workspacePath,
      AMBIENT_E2E_USER_DATA: input.userDataPath,
    },
  });
}

async function createDogfoodThread(cdpClient) {
  const result = await evaluate(cdpClient, async (model) => {
    await window.ambientDesktop.updateFeatureFlagSettings({ slashCommands: true });
    await window.ambientDesktop.updateThinkingDisplaySettings({ mode: "transient", showRunStatusCard: false });
    const state = await window.ambientDesktop.createThread({
      permissionMode: "full-access",
      collaborationMode: "agent",
      model,
      thinkingLevel: "minimal",
    });
    const threadId = state.activeThreadId;
    await window.ambientDesktop.updateThread({ threadId, title: "Skill install polish dogfood" });
    await window.ambientDesktop.selectThread(threadId);
    return { threadId };
  }, dogfoodModelId());
  assert(result?.threadId, `createThread did not return thread id: ${JSON.stringify(result)}`);
  return result.threadId;
}

async function verifySlashCatalog(cdpClient) {
  const directCatalog = await waitForSlashCatalogReady(cdpClient);
  const cliEntry = directCatalog.entries.find((entry) => entry.sourceKind === "ambient-cli" && entry.availability === "available") ??
    directCatalog.entries.find((entry) => entry.sourceKind === "ambient-cli");
  assert(cliEntry, `Bare slash catalog did not include any Ambient CLI entries: ${JSON.stringify(directCatalog.groups ?? [])}`);
  const cliQuery = cliEntry.command.replace(/^\//, "");
  const filtered = await evaluate(cdpClient, async (query) => window.ambientDesktop.searchSlashCommands({
    query,
    mode: "query",
    includeUnavailable: true,
    limit: 50,
    kinds: ["app", "skill", "workflow", "callable-workflow"],
  }), cliQuery);
  assert(filtered.entries.some((entry) => entry.id === cliEntry.id), `Filtered slash query ${cliQuery} did not include ${cliEntry.command}.`);

  await setTextAreaValue(cdpClient, ".composer-input-wrap textarea", "/");
  await waitForSlashPopover(cdpClient, (state) => state.open && state.optionCount > 12 && state.scrollable);
  const barePopover = await collectSlashPopover(cdpClient);
  await setTextAreaValue(cdpClient, ".composer-input-wrap textarea", `/${cliQuery}`);
  await waitForSlashPopover(cdpClient, (state) => state.commands.includes(cliEntry.command));
  const filteredPopover = await collectSlashPopover(cdpClient);
  await setTextAreaValue(cdpClient, ".composer-input-wrap textarea", "");
  return {
    directCatalogCount: directCatalog.entries.length,
    directCatalogHasMore: Boolean(directCatalog.hasMore),
    directGroups: directCatalog.groups,
    cliEntry: {
      id: cliEntry.id,
      command: cliEntry.command,
      title: cliEntry.title,
      sourceKind: cliEntry.sourceKind,
      availability: cliEntry.availability,
    },
    filteredCount: filtered.entries.length,
    barePopover,
    filteredPopover,
  };
}

async function waitForSlashCatalogReady(cdpClient, timeoutMs = 30_000) {
  const started = Date.now();
  let latest;
  while (Date.now() - started < timeoutMs) {
    latest = await evaluate(cdpClient, async () => window.ambientDesktop.searchSlashCommands({
      query: "",
      mode: "catalog",
      includeUnavailable: true,
      limit: 80,
    }));
    const entries = latest?.entries ?? [];
    if (entries.length > 12 && entries.some((entry) => entry.sourceKind === "ambient-cli")) return latest;
    await delay(500);
  }
  throw new Error(`Timed out waiting for Ambient CLI slash catalog entries. Latest: ${JSON.stringify({
    entryCount: latest?.entries?.length ?? 0,
    groups: latest?.groups ?? [],
    diagnostics: latest?.diagnostics ?? [],
  })}`);
}

async function runLiveModelTurn(cdpClient, threadId) {
  await resetLiveCollector(cdpClient);
  const prompt = [
    "Your next action must be a tool call to ambient_model_status with JSON input {\"purpose\":\"skill-install-polish-dogfood\"}.",
    "Do not write words before the tool call.",
    `After the tool returns, reply exactly ${liveMarker}.`,
  ].join("\n");
  await evaluate(cdpClient, async (input) => {
    const live = window.__ambientSkillInstallPolishDogfood;
    await window.ambientDesktop.selectThread(input.threadId);
    window.ambientDesktop.sendMessage({
      threadId: input.threadId,
      content: input.prompt,
      permissionMode: "full-access",
      collaborationMode: "agent",
      model: input.model,
      thinkingLevel: "minimal",
    })
      .then(() => {
        live.sendResolved = true;
      })
      .catch((error) => {
        live.error = error instanceof Error ? error.message : String(error);
      });
    return true;
  }, { threadId, prompt, model: dogfoodModelId() });
  const completion = await waitForLiveTurnCompletion(cdpClient, threadId, liveTurnTimeoutMs);
  assert(completion.toolDone, `ambient_model_status did not complete: ${JSON.stringify(completion.live)}`);
  assert(completion.assistantText.includes(liveMarker), `Assistant did not emit ${liveMarker}. Tail: ${completion.assistantText.slice(-1000)}`);
  return {
    toolDone: completion.toolDone,
    assistantHasMarker: completion.assistantText.includes(liveMarker),
    statuses: completion.live.statuses,
    runtimeActivities: completion.live.runtimeActivities.slice(-12),
    messageCount: completion.messages.length,
  };
}

async function waitForLiveTurnCompletion(cdpClient, threadId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = {};
  while (Date.now() < deadline) {
    const live = await getLiveState(cdpClient);
    if (live?.error) throw new Error(live.error);
    const state = await threadState(cdpClient, threadId);
    const assistantText = state.messages
      .filter((message) => message.role === "assistant" && message.metadata?.kind !== "thinking")
      .map((message) => message.content)
      .join("\n");
    const toolDone = state.messages.some((message) =>
      message.role === "tool" &&
      message.metadata?.toolName === "ambient_model_status" &&
      message.metadata?.status === "done"
    );
    latest = { live, messages: state.messages, assistantText, toolDone };
    if (toolDone && assistantText.includes(liveMarker)) return latest;
    await delay(1000);
  }
  throw new Error(`Timed out waiting for live model status turn: ${JSON.stringify({
    live: latest.live,
    assistantTail: latest.assistantText?.slice(-1000),
    toolDone: latest.toolDone,
  })}`);
}

async function verifyContinuationLabels(cdpClient, threadId) {
  const wake = await showContinuationSource(cdpClient, threadId, {
    status: "continuing",
    message: "Continuing scheduled check-in: Skill install polish wake.",
    continuationSource: "thread-wake",
  }, "thread-wake", "Scheduled wake");
  const postTool = await showContinuationSource(cdpClient, threadId, {
    status: "continuing",
    message: "Continue the interrupted tool call from the saved partial arguments.",
    continuationSource: "post-tool-continuation",
  }, "post-tool-continuation", "Continuing after tool output");
  const goal = await evaluate(cdpClient, async (id) => window.ambientDesktop.setThreadGoal({
    threadId: id,
    objective: "Verify skill install polish continuation labels.",
    status: "active",
  }), threadId);
  assert(goal?.goalId, `setThreadGoal did not return a goal: ${JSON.stringify(goal)}`);
  const goalStrip = await showContinuationSource(cdpClient, threadId, {
    status: "continuing",
    message: "Continuing goal...",
    goalId: goal.goalId,
    continuationSource: "goal-continuation",
  }, "goal-continuation", "Continuing goal");
  await emitE2eEvent(cdpClient, {
    type: "runtime-activity",
    activity: {
      threadId,
      kind: "compaction",
      status: "starting",
      reason: "overflow",
    },
  });
  await waitForRuntimeStrip(cdpClient, "compaction", "Compacting context");
  const compaction = await collectRuntimeStrips(cdpClient);
  await emitE2eEvent(cdpClient, { type: "run-status", threadId, status: "idle" });
  return { wake, postTool, goal: goalStrip, compaction };
}

async function showContinuationSource(cdpClient, threadId, activity, expectedKind, expectedTitle) {
  await emitE2eEvent(cdpClient, {
    type: "runtime-activity",
    activity: {
      threadId,
      kind: "goal",
      ...activity,
    },
  });
  await emitE2eEvent(cdpClient, { type: "run-status", threadId, status: "starting" });
  await waitForRuntimeStrip(cdpClient, expectedKind, expectedTitle);
  const strips = await collectRuntimeStrips(cdpClient);
  await emitE2eEvent(cdpClient, { type: "run-status", threadId, status: "idle" });
  return strips;
}

async function verifyRouteGuardSurface() {
  const routingDescriptors = await readFile(join(repoRoot, "src/main/desktop-tools/desktopToolRoutingDescriptors.ts"), "utf8");
  const installGuard = await readFile(join(repoRoot, "src/main/agent-runtime/agentRuntimeInstallRouteGuard.ts"), "utf8");
  const capabilityDescriptor = await readFile(join(repoRoot, "src/main/desktop-tools/desktopToolCapabilityBuilderDescriptors.ts"), "utf8");
  const ambientCliDescriptor = await readFile(join(repoRoot, "src/main/desktop-tools/desktopToolAmbientCliDescriptors.ts"), "utf8");
  const checks = {
    routesPiCatalogToWrappedInstall: routingDescriptors.includes("ambient_cli_package_install_pi_catalog"),
    routesGeneratedWrappersToBuilder: routingDescriptors.includes("ambient_capability_builder_plan"),
    discouragesRawPiInstall: /Do not recommend raw sandboxed Pi extension install|raw Pi install/i.test(routingDescriptors),
    rawPiRootGuardPresent: installGuard.includes("Ambient raw Pi install root guard blocked"),
    wrappedPiInstallToolPresent: ambientCliDescriptor.includes("ambient_cli_package_install_pi_catalog"),
    builderPlanToolPresent: capabilityDescriptor.includes("ambient_capability_builder_plan"),
  };
  const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  assert(failed.length === 0, `Route guard surface missing checks: ${failed.join(", ")}`);
  return checks;
}

async function runContractScenarios(env) {
  const outputPath = contractScenariosReportPath();
  await rm(outputPath, { force: true });
  await run("pnpm", ["exec", "vitest", "run", "scripts/skill-install-polish-contract-scenarios.test.ts"], {
    ...env,
    AMBIENT_SKILL_INSTALL_POLISH_CONTRACT_OUT: outputPath,
  });
  const parsed = JSON.parse(await readFile(outputPath, "utf8"));
  assert(parsed?.status === "passed", `Contract scenario report did not pass: ${JSON.stringify(parsed)}`);
  return parsed;
}

function contractScenariosReportPath() {
  return join(resultsDir, "contract-scenarios.json");
}

async function installLiveCollector(cdpClient) {
  await evaluate(cdpClient, () => {
    if (window.__ambientSkillInstallPolishDogfood?.unsubscribe) {
      window.__ambientSkillInstallPolishDogfood.unsubscribe();
    }
    const live = {
      statuses: [],
      runtimeActivities: [],
      toolEvents: [],
      error: undefined,
      sendResolved: false,
      unsubscribe: undefined,
    };
    live.unsubscribe = window.ambientDesktop.onEvent((event) => {
      if (event.type === "run-status") {
        live.statuses.push(event.status);
        live.statuses = live.statuses.slice(-80);
      }
      if (event.type === "runtime-activity") {
        live.runtimeActivities.push(event.activity);
        live.runtimeActivities = live.runtimeActivities.slice(-80);
      }
      if (event.type === "tool-call-created" || event.type === "tool-call-updated" || event.type === "tool-result") {
        live.toolEvents.push(event);
        live.toolEvents = live.toolEvents.slice(-120);
      }
    });
    window.__ambientSkillInstallPolishDogfood = live;
  });
}

async function resetLiveCollector(cdpClient) {
  await evaluate(cdpClient, () => {
    const live = window.__ambientSkillInstallPolishDogfood;
    if (!live) return;
    live.statuses = [];
    live.runtimeActivities = [];
    live.toolEvents = [];
    live.error = undefined;
    live.sendResolved = false;
  });
}

async function getLiveState(cdpClient) {
  return evaluate(cdpClient, () => {
    const live = window.__ambientSkillInstallPolishDogfood;
    if (!live) return undefined;
    return {
      statuses: live.statuses,
      runtimeActivities: live.runtimeActivities,
      toolEvents: live.toolEvents,
      error: live.error,
      sendResolved: live.sendResolved,
    };
  });
}

async function threadState(cdpClient, threadId) {
  return evaluate(cdpClient, async (id) => {
    await window.ambientDesktop.selectThread(id);
    const state = await window.ambientDesktop.bootstrap();
    return {
      activeThreadId: state.activeThreadId,
      messages: (state.messages ?? []).filter((message) => message.threadId === id),
    };
  }, threadId);
}

async function collectSlashPopover(cdpClient) {
  return evaluate(cdpClient, () => {
    const popover = document.querySelector(".slash-command-popover");
    const options = [...document.querySelectorAll(".slash-command-option")];
    const groups = [...document.querySelectorAll(".slash-command-group-label")].map((element) => element.textContent?.trim() ?? "");
    const commands = options
      .map((option) => option.querySelector("strong")?.textContent?.trim() ?? "")
      .filter(Boolean);
    return {
      open: popover instanceof HTMLElement,
      optionCount: options.length,
      groupLabels: groups,
      commands,
      scrollable: popover instanceof HTMLElement ? popover.scrollHeight > popover.clientHeight + 2 : false,
      text: popover instanceof HTMLElement ? popover.innerText : "",
    };
  });
}

async function waitForSlashPopover(cdpClient, predicate, timeoutMs = 20_000) {
  const started = Date.now();
  let latest;
  while (Date.now() - started < timeoutMs) {
    latest = await collectSlashPopover(cdpClient);
    if (predicate(latest)) return latest;
    await delay(250);
  }
  throw new Error(`Timed out waiting for slash popover. Latest: ${JSON.stringify(latest)}`);
}

async function collectRuntimeStrips(cdpClient) {
  return evaluate(cdpClient, () => [...document.querySelectorAll(".runtime-status-strip")].map((strip) => ({
    kind: strip.getAttribute("data-runtime-status-kind"),
    phase: strip.getAttribute("data-runtime-status-phase"),
    text: strip.textContent?.replace(/\s+/g, " ").trim() ?? "",
  })));
}

async function waitForRuntimeStrip(cdpClient, kind, text, timeoutMs = 15_000) {
  const started = Date.now();
  let latest = [];
  while (Date.now() - started < timeoutMs) {
    latest = await collectRuntimeStrips(cdpClient);
    if (latest.some((strip) => strip.kind === kind && strip.text.includes(text))) return latest;
    await delay(250);
  }
  throw new Error(`Timed out waiting for runtime strip kind=${kind} text=${text}. Latest: ${JSON.stringify(latest)}`);
}

async function emitE2eEvent(cdpClient, event) {
  await evaluate(cdpClient, async (input) => {
    if (typeof window.ambientDesktop.emitE2eEvent !== "function") throw new Error("Missing E2E desktop event bridge.");
    await window.ambientDesktop.emitE2eEvent(input);
  }, event);
}

async function connectToElectron(port, launchedApp) {
  const started = Date.now();
  let lastOutput = "";
  launchedApp.stdout?.on("data", (chunk) => {
    lastOutput = `${lastOutput}${chunk.toString()}`.slice(-4000);
  });
  launchedApp.stderr?.on("data", (chunk) => {
    lastOutput = `${lastOutput}${chunk.toString()}`.slice(-4000);
  });
  while (Date.now() - started < 60_000) {
    if (launchedApp.exitCode !== null) throw new Error(`Electron exited before CDP was available.\n${lastOutput}`);
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
    send(method, params = {}) {
      const id = nextId++;
      const ready = socket.readyState === WebSocket.OPEN
        ? Promise.resolve()
        : new Promise((resolveReady, rejectReady) => {
          const timeout = setTimeout(() => rejectReady(new Error(`Timed out waiting for CDP socket open after ${cdpCommandTimeoutMs}ms.`)), cdpCommandTimeoutMs);
          socket.addEventListener("open", () => {
            clearTimeout(timeout);
            resolveReady();
          }, { once: true });
          socket.addEventListener("error", () => {
            clearTimeout(timeout);
            rejectReady(new Error("CDP socket failed to open"));
          }, { once: true });
        });
      return ready.then(() => new Promise((resolveCommand, rejectCommand) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          rejectCommand(new Error(`Timed out waiting for CDP ${method} after ${cdpCommandTimeoutMs}ms.`));
        }, cdpCommandTimeoutMs);
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

async function evaluate(cdpClient, fn, ...args) {
  const expression = `(${fn.toString()})(...${JSON.stringify(args)})`;
  const result = await cdpClient.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(`Runtime.evaluate failed: ${JSON.stringify(result.exceptionDetails)}`);
  return result.result?.value;
}

async function setTextAreaValue(cdpClient, selector, value) {
  await evaluate(cdpClient, (targetSelector, nextValue) => {
    const textarea = document.querySelector(targetSelector);
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error(`Missing textarea ${targetSelector}`);
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, nextValue);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }, selector, value);
}

async function setViewport(cdpClient, width, height) {
  await cdpClient.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function waitForText(cdpClient, text, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if ((await bodyText(cdpClient)).includes(text)) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for text: ${text}`);
}

async function bodyText(cdpClient) {
  return evaluate(cdpClient, () => document.body.innerText);
}

async function writeScreenshot(cdpClient, name) {
  await mkdir(resultsDir, { recursive: true });
  const result = await cdpClient.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const outputPath = join(resultsDir, name);
  await writeFile(outputPath, Buffer.from(result.data, "base64"));
  return outputPathRelative(outputPath);
}

async function writeReport(input) {
  await mkdir(dirname(latestReportPath), { recursive: true });
  await writeFile(latestReportPath, `${JSON.stringify(input, null, 2)}\n`, "utf8");
}

async function run(command, args, env) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env,
  });
  const [code, signal] = await once(child, "exit");
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed with ${signal ?? code}.`);
}

async function terminateProcessTree(processRef) {
  if (!processRef || processRef.exitCode !== null || processRef.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && processRef.pid) process.kill(-processRef.pid, "SIGTERM");
    else processRef.kill("SIGTERM");
  } catch {
    try {
      processRef.kill("SIGTERM");
    } catch {
      return;
    }
  }
  const exited = await waitForExit(processRef, 5000);
  if (!exited) {
    try {
      if (process.platform !== "win32" && processRef.pid) process.kill(-processRef.pid, "SIGKILL");
      else processRef.kill("SIGKILL");
    } catch {
      // Process already exited.
    }
  }
}

async function waitForExit(processRef, timeoutMs) {
  if (processRef.exitCode !== null || processRef.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    processRef.once("exit", () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

function dogfoodCdpPort() {
  const raw = process.env.AMBIENT_HARNESS_CDP_PORT || process.env.AMBIENT_SUBAGENT_DESKTOP_DOGFOOD_CDP_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`AMBIENT_HARNESS_CDP_PORT is required; got ${raw || "missing"}.`);
  }
  return port;
}

function dogfoodModelId() {
  return process.env.AMBIENT_LIVE_MODEL || process.env.GMI_CLOUD_MODEL || process.env.AMBIENT_MODEL || defaultModel;
}

function expectedProviderLabel() {
  return process.env.AMBIENT_PROVIDER === "gmi-cloud" ? "GMI Cloud API" : "Ambient API";
}

function ambientApiKeyEnv() {
  if (process.env.AMBIENT_API_KEY || process.env.AMBIENT_AGENT_AMBIENT_API_KEY) return {};
  const keyFilePath = ambientApiKeyFilePath();
  return keyFilePath
    ? {
        AMBIENT_API_KEY_FILE: keyFilePath,
        AMBIENT_AGENT_AMBIENT_API_KEY_FILE: keyFilePath,
      }
    : {};
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

function gitValue(args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function cleanChildEnv(env) {
  const next = { ...env };
  delete next.NODE_OPTIONS;
  delete next.VITEST;
  return next;
}

function outputPathRelative(path) {
  const absolute = resolve(path);
  return absolute.startsWith(`${repoRoot}/`) ? absolute.slice(repoRoot.length + 1) : absolute;
}
