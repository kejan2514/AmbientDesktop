#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotHarnessWorkspace, writeHarnessTraceArtifacts } from "./harness-trace-artifacts.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputRoot = resolve(process.env.AMBIENT_LOCAL_DEEP_RESEARCH_LIVE_OUT_DIR || join(repoRoot, "test-results", "local-deep-research-live"));
const runRoot = join(outputRoot, "runs", runStamp);
const workspace = join(runRoot, "workspace");
const userData = join(tmpdir(), `ambient-local-deep-research-user-data-${runStamp}`);
const traceDir = join(runRoot, "trace");
const latestSummaryPath = join(outputRoot, "latest.json");
const managedRoot = resolve(process.env.AMBIENT_LOCAL_DEEP_RESEARCH_MANAGED_ROOT || repoRoot);
const providerId = process.env.AMBIENT_PROVIDER || process.env.AMBIENT_LOCAL_DEEP_RESEARCH_LIVE_PROVIDER || "ambient";
const port = Number(process.env.AMBIENT_LOCAL_DEEP_RESEARCH_LIVE_CDP_PORT || 0) || (await findOpenPort());
const timeoutMs = Number(process.env.AMBIENT_LOCAL_DEEP_RESEARCH_LIVE_TIMEOUT_MS || 0) || 900_000;
const electronTargetTimeoutMs = Number(process.env.AMBIENT_LOCAL_DEEP_RESEARCH_ELECTRON_TARGET_TIMEOUT_MS || 0) || 90_000;
const liveRunMaxToolCalls = positiveIntegerEnv("AMBIENT_LOCAL_DEEP_RESEARCH_LIVE_MAX_TOOL_CALLS", 14);
const liveRunMaxTurns = positiveIntegerEnv("AMBIENT_LOCAL_DEEP_RESEARCH_LIVE_MAX_TURNS", 16);
const finalToken = "LOCAL_DEEP_RESEARCH_LIVE_DONE";
const blockedFinalToken = "LOCAL_DEEP_RESEARCH_LIVE_BLOCKED_DONE";
const output = [];
const children = new Set();
let appInstance;
let beforeWorkspace;
let lastCdpProbe;

try {
  ensureProviderCredentialEnv();
  await rm(runRoot, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  beforeWorkspace = await snapshotHarnessWorkspace(workspace);
  appInstance = await launchApp();
  const summary = await runLiveLocalDeepResearchSmoke(appInstance.cdp);
  await writeLiveSummary(summary);
  console.log(JSON.stringify(summary, null, 2));
  console.log("Live Local Deep Research Ambient/Pi smoke passed.");
} catch (error) {
  const summary = localDeepResearchLiveSummaryFromError(error);
  if (summary) {
    await writeLiveSummary(summary);
    console.error(`Live Local Deep Research Ambient/Pi smoke blocked. Summary: ${latestSummaryPath}`);
  }
  console.error(outputTail());
  throw error;
} finally {
  appInstance?.cdp.close();
  if (appInstance?.child) await terminateProcessTree(appInstance.child);
  for (const child of children) await terminateProcessTree(child);
  await terminateDebugPortProcesses();
  await rm(userData, { recursive: true, force: true });
}

function ensureProviderCredentialEnv() {
  if (providerId === "gmi-cloud") {
    ensureGmiCredentialEnv();
    return;
  }
  ensureAmbientCredentialEnv();
}

function ensureAmbientCredentialEnv() {
  if (process.env.AMBIENT_API_KEY || process.env.AMBIENT_AGENT_AMBIENT_API_KEY || process.env.AMBIENT_API_KEY_FILE || process.env.AMBIENT_AGENT_AMBIENT_API_KEY_FILE) return;
  const candidates = [
    join(repoRoot, "ambient_api_key_u.txt"),
    join(repoRoot, "ignored-provider-key-file.txt"),
    "/Users/example/Documents/ambientCoder/ambient_api_key_u.txt",
    "/Users/example/Documents/ambientCoder/ignored-provider-key-file.txt",
  ];
  const keyFile = candidates.find((candidate) => existsSync(candidate));
  if (keyFile) {
    process.env.AMBIENT_API_KEY_FILE = keyFile;
    return;
  }
  throw new Error("Configure AMBIENT_API_KEY, AMBIENT_AGENT_AMBIENT_API_KEY, AMBIENT_API_KEY_FILE, or the ignored ignored-provider-key-file.txt file before running this live smoke.");
}

function ensureGmiCredentialEnv() {
  if (process.env.GMI_CLOUD_API_KEY || process.env.GMI_API_KEY || process.env.GMI_CLOUD_API_KEY_FILE) return;
  const candidates = [
    join(repoRoot, "ignored-provider-key-file.txt"),
    "/Users/example/Documents/ambientCoder/ignored-provider-key-file.txt",
  ];
  const keyFile = candidates.find((candidate) => existsSync(candidate));
  if (keyFile) {
    process.env.GMI_CLOUD_API_KEY_FILE = keyFile;
    return;
  }
  throw new Error("Configure GMI_CLOUD_API_KEY, GMI_API_KEY, GMI_CLOUD_API_KEY_FILE, or the ignored ignored-provider-key-file.txt file before running this live smoke.");
}

async function launchApp() {
  const child = spawn("pnpm", ["exec", "electron-vite", "dev", "--", `--remote-debugging-port=${port}`], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AMBIENT_PROVIDER: providerId,
      AMBIENT_E2E: "1",
      AMBIENT_E2E_USER_DATA: userData,
      AMBIENT_DESKTOP_WORKSPACE: workspace,
      AMBIENT_MANAGED_INSTALL_ROOT: managedRoot,
      AMBIENT_DESKTOP_BOOTSTRAP_WATCHDOG_MS: process.env.AMBIENT_DESKTOP_BOOTSTRAP_WATCHDOG_MS ?? "180000",
      AMBIENT_PI_USER_SETTINGS_PATH: join(userData, "missing-pi-settings.json"),
      AMBIENT_CODEX_CURATED_MARKETPLACE_URL: "0",
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

  const target = await waitForTarget(() => childExit);
  await delay(750);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await waitFor(cdp, () => document.body?.innerText.includes("Ambient"), "main shell", 45_000);
  return { child, cdp };
}

async function runLiveLocalDeepResearchSmoke(cdp) {
  await installLiveCollector(cdp);
  const initialState = await desktopState(cdp);
  if (initialState.provider.providerId !== providerId) {
    throw new Error(`Expected ${providerId} provider, got ${initialState.provider.providerId}.`);
  }
  if (!initialState.provider.hasApiKey) throw new Error(`${providerId} API key was not visible to the launched app.`);
  const keyCheck = await evaluate(cdp, "window.ambientDesktop.testAmbientApiKey()");
  if (!keyCheck?.ok) throw new Error(`${providerId} API key check failed: ${keyCheck?.message ?? "unknown error"}`);

  await seedDefaultSearchPreference(cdp);
  let preflight = await evaluate(cdp, "window.ambientDesktop.setupLocalDeepResearch({ action: 'status' })");
  if (preflight.setupStatus !== "ready" && process.env.AMBIENT_LOCAL_DEEP_RESEARCH_LIVE_INSTALL === "1") {
    preflight = await evaluate(cdp, "window.ambientDesktop.setupLocalDeepResearch({ action: 'install' })", 1_500_000);
  }
  if (preflight.setupStatus !== "ready") {
    const piBlockedPreflight = preflight.setupStatus === "blocked"
      ? await runBlockedPreflightPiSmoke(cdp, { initialState, preflight })
      : undefined;
    const summary = blockedPreflightLiveSummary({ initialState, preflight, piBlockedPreflight });
    throw localDeepResearchLivePreflightBlockedError(summary, [
      `Local Deep Research preflight was not ready. status=${preflight.setupStatus}`,
      `blockerKind=${summary.blockerKind}`,
      `blockers=${JSON.stringify(summary.blockers)}`,
      `managedRoot=${preflight.managedAssets?.managedRoot}`,
      `summary=${latestSummaryPath}`,
      localDeepResearchPreflightRetryAdvice(preflight),
    ].join(" "));
  }

  const nextState = await evaluate(cdp, "window.ambientDesktop.createThread()");
  const threadId = nextState.activeThreadId;
  if (!threadId) throw new Error("Creating a fresh Local Deep Research smoke thread did not produce an active thread id.");
  const model = process.env.AMBIENT_LOCAL_DEEP_RESEARCH_LIVE_MODEL || providerModelEnv() || nextState.provider.model || nextState.settings.model;
  const completion = await sendPromptAndWait(cdp, {
    threadId,
    model,
    content: localDeepResearchPrompt(),
  });

  const live = await getLiveState(cdp);
  assertNoDirectResearchBypass(live);
  assertNoLocalRuntimeLifecycleMutation(live);
  const runtimeStatusMessage = latestToolMessage(live, "ambient_local_model_runtime_status");
  const setupMessage = latestToolMessage(live, "ambient_local_deep_research_setup");
  const runMessage = latestToolMessage(live, "ambient_local_deep_research_run");
  if (!runtimeStatusMessage) throw new Error(`Pi did not call ambient_local_model_runtime_status. Live state: ${JSON.stringify(live)}`);
  if (!setupMessage) throw new Error(`Pi did not call ambient_local_deep_research_setup. Live state: ${JSON.stringify(live)}`);
  if (!runMessage) throw new Error(`Pi did not call ambient_local_deep_research_run. Live state: ${JSON.stringify(live)}`);
  assertToolCalledBefore(live, "ambient_local_model_runtime_status", "ambient_local_deep_research_setup");
  assertToolCalledBefore(live, "ambient_local_deep_research_setup", "ambient_local_deep_research_run");
  const setupDetails = setupDetailsFromMessage(setupMessage);
  const runDetails = await runDetailsFromMessage(runMessage);
  assertSetupDetails(setupDetails, setupMessage);
  assertRunDetails(runDetails, runMessage);
  if (completion.status === "completed" && !live.assistantTail.includes(finalToken)) {
    throw new Error(`Expected final token ${finalToken}. Live state: ${JSON.stringify(live)}`);
  }

  const citationUrls = citationUrlsFromRunDetails(runDetails);
  const finalState = await desktopState(cdp);
  const summary = {
    schemaVersion: "ambient-local-deep-research-live-smoke-v1",
    status: "passed",
    createdAt: new Date().toISOString(),
    workspace,
    managedRoot,
    provider: nextState.provider.providerId,
    model,
    completionStatus: completion.status,
    setupStatus: setupDetails.setupStatus,
    preflightAction: preflight.action,
    runtimeStatus: runtimeStatusSummaryFromMessage(runtimeStatusMessage),
    validationStatus: setupDetails.validation?.status,
    runStatus: runDetails.status,
    runBudget: {
      maxToolCalls: liveRunMaxToolCalls,
      maxTurns: liveRunMaxTurns,
    },
    modelProfileId: runDetails.modelProfileId,
    contextTokens: runDetails.contextTokens,
    providerSnapshot: runDetails.providerSnapshot,
    citationUrls: citationUrls.slice(0, 12),
    toolExecutionCount: Array.isArray(runDetails.toolExecutions) ? runDetails.toolExecutions.length : undefined,
    toolExecutionNames: Array.isArray(runDetails.toolExecutions) ? runDetails.toolExecutions.map((execution) => execution?.call?.name).filter(Boolean) : [],
    artifacts: runDetails.artifacts,
    llamaServer: runDetails.llamaServer ? {
      profileId: runDetails.llamaServer.profileId,
      modelPath: runDetails.llamaServer.modelPath,
      runtimeBinaryPath: runDetails.llamaServer.runtimeBinaryPath,
      logPath: runDetails.llamaServer.logPath,
    } : undefined,
    runtimeActivities: live.runtimeActivities,
    toolNames: observedToolNames(live),
    rawToolNames: live.toolNames,
  };
  const trace = await writeHarnessTraceArtifacts({
    traceDir,
    workspace,
    beforeWorkspace,
    messages: finalState.messages,
    events: live.events,
    summary,
  });
  return { ...summary, trace: trace?.preview };
}

async function runBlockedPreflightPiSmoke(cdp, input) {
  const nextState = await evaluate(cdp, "window.ambientDesktop.createThread()");
  const threadId = nextState.activeThreadId;
  if (!threadId) throw new Error("Creating a fresh blocked-preflight Local Deep Research smoke thread did not produce an active thread id.");
  const model = process.env.AMBIENT_LOCAL_DEEP_RESEARCH_LIVE_MODEL || providerModelEnv() || nextState.provider.model || nextState.settings.model;
  const completion = await sendPromptAndWait(cdp, {
    threadId,
    model,
    content: localDeepResearchBlockedPreflightPrompt(input.preflight),
    expectedFinalToken: blockedFinalToken,
  });
  const live = await getLiveState(cdp);
  assertNoDirectResearchBypass(live);
  assertNoLocalRuntimeLifecycleMutation(live);
  if ((live.toolNames ?? []).includes("ambient_local_deep_research_run")) {
    throw new Error(`Pi called ambient_local_deep_research_run during blocked-preflight smoke. Live state: ${JSON.stringify(live)}`);
  }
  const runtimeStatusMessage = latestToolMessage(live, "ambient_local_model_runtime_status");
  const setupMessage = latestToolMessage(live, "ambient_local_deep_research_setup");
  if (!runtimeStatusMessage) throw new Error(`Pi did not inspect runtime status before blocked Local Deep Research setup. Live state: ${JSON.stringify(live)}`);
  if (!setupMessage) throw new Error(`Pi did not call Local Deep Research setup during blocked-preflight smoke. Live state: ${JSON.stringify(live)}`);
  assertToolCalledBefore(live, "ambient_local_model_runtime_status", "ambient_local_deep_research_setup");
  const setupDetails = setupDetailsFromMessage(setupMessage);
  if (setupDetails.setupStatus === "ready") {
    throw new Error(`Expected blocked-preflight setup to remain non-ready. details=${JSON.stringify(setupDetails)} message=${JSON.stringify(setupMessage)}`);
  }
  const runtimeStatus = runtimeStatusSummaryFromMessage(runtimeStatusMessage);
  assertRuntimeStatusNextSafeActionEvidence(runtimeStatus);
  if (completion.status === "completed" && !live.assistantTail.includes(blockedFinalToken)) {
    throw new Error(`Expected final token ${blockedFinalToken}. Live state: ${JSON.stringify(live)}`);
  }
  const finalState = await desktopState(cdp);
  const summary = {
    status: "completed",
    threadId,
    model,
    completionStatus: completion.status,
    toolNames: observedToolNames(live),
    rawToolNames: live.toolNames,
    runtimeStatusBeforeSetup: true,
    setupStatus: setupDetails.setupStatus,
    blockers: compactStringArray(setupDetails.blockers, 20),
    runtimeStatus,
    setup: {
      providerSnapshot: safeProviderSnapshot(setupDetails.providerSnapshot),
      localModelResources: safeLocalModelResources(setupDetails.localModelResources),
      localRuntimeInventory: safeLocalRuntimeInventory(setupDetails.localRuntimeInventory),
    },
    runtimeActivities: live.runtimeActivities,
  };
  const trace = await writeHarnessTraceArtifacts({
    traceDir,
    workspace,
    beforeWorkspace,
    messages: finalState.messages,
    events: live.events,
    summary,
  });
  return { ...summary, trace: trace?.preview };
}

function providerModelEnv() {
  return providerId === "gmi-cloud"
    ? process.env.GMI_CLOUD_MODEL
    : process.env.AMBIENT_MODEL || process.env.AMBIENT_WORKFLOW_MODEL;
}

function localDeepResearchLivePreflightBlockedError(summary, message) {
  const error = new Error(message);
  error.name = "LocalDeepResearchLivePreflightBlockedError";
  error.summary = summary;
  return error;
}

function localDeepResearchLiveSummaryFromError(error) {
  const summary = error?.summary;
  if (summary?.schemaVersion === "ambient-local-deep-research-live-smoke-v1") return summary;
  return undefined;
}

async function writeLiveSummary(summary) {
  await mkdir(outputRoot, { recursive: true });
  await mkdir(runRoot, { recursive: true });
  await writeFile(latestSummaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(join(runRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

function blockedPreflightLiveSummary(input) {
  const preflight = input.preflight ?? {};
  const blockerKind = classifyLocalDeepResearchPreflightBlocker(preflight);
  const inventory = safeLocalRuntimeInventory(preflight.localRuntimeInventory);
  return {
    schemaVersion: "ambient-local-deep-research-live-smoke-v1",
    status: "blocked",
    createdAt: new Date().toISOString(),
    blockerKind,
    workspace,
    managedRoot,
    provider: input.initialState?.provider?.providerId,
    setupStatus: preflight.setupStatus,
    preflightAction: preflight.action,
    modelProfileId: preflight.modelSelection?.profile?.id ?? preflight.modelSelection?.profileId,
    contextTokens: preflight.modelSelection?.contextTokens,
    blockers: compactStringArray(preflight.blockers, 20),
    warnings: compactStringArray(preflight.warnings, 12),
    nextActions: compactStringArray(preflight.nextActions, 12),
    providerSnapshot: safeProviderSnapshot(preflight.providerSnapshot),
    localModelResources: safeLocalModelResources(preflight.localModelResources),
    localRuntimeInventory: inventory,
    untrackedRuntimeBlockers: (inventory?.entries ?? []).filter((entry) => entry.trackingStatus === "untracked" || entry.stopDecision?.untracked),
    ...(input.piBlockedPreflight ? { piBlockedPreflight: input.piBlockedPreflight } : {}),
    retryAdvice: localDeepResearchPreflightRetryAdvice(preflight),
  };
}

function classifyLocalDeepResearchPreflightBlocker(preflight) {
  const blockers = compactStringArray(preflight?.blockers, 50).map((blocker) => blocker.toLowerCase());
  const rows = Array.isArray(preflight?.localRuntimeInventory?.entries) ? preflight.localRuntimeInventory.entries : [];
  if (rows.some((entry) => entry?.trackingStatus === "untracked" || entry?.stopDecision?.untracked)) return "untracked-local-runtime";
  if (blockers.some((blocker) => blocker.includes("untracked") || blocker.includes("not safe to stop"))) return "untracked-local-runtime";
  if (preflight?.setupStatus === "needs-install") return "needs-install";
  if (blockers.some((blocker) => blocker.includes("memory") || blocker.includes("resident"))) return "memory-policy";
  if (blockers.some((blocker) => blocker.includes("search") || blocker.includes("fetch") || blocker.includes("provider"))) return "provider-routing";
  return "setup-blocked";
}

function safeProviderSnapshot(snapshot) {
  if (!snapshot) return undefined;
  return {
    capturedAt: snapshot.capturedAt,
    activeProviderId: snapshot.activeProvider?.providerId,
    providerOrder: compactStringArray(snapshot.providerOrder, 20),
    searchOrder: compactStringArray(snapshot.searchOrder, 20),
    fetchOrder: compactStringArray(snapshot.fetchOrder, 20),
    browserFallback: Boolean(snapshot.fallbackPolicy?.allowBrowserFallback),
  };
}

function safeLocalModelResources(resources) {
  if (!resources) return undefined;
  const policy = resources.policyDecision;
  const utilization = projectedSystemMemoryUtilization(policy);
  return {
    capturedAt: resources.capturedAt,
    activeCount: resources.activeCount,
    activeEstimatedResidentMemoryBytes: resources.activeEstimatedResidentMemoryBytes,
    activeActualResidentMemoryBytes: resources.activeActualResidentMemoryBytes,
    policyDecision: policy ? {
      outcome: policy.outcome,
      reason: policy.reason,
      ...(utilization !== undefined ? { projectedSystemMemoryUtilization: utilization } : {}),
      ...(policy.maxProjectedMemoryUtilization !== undefined ? { maxProjectedMemoryUtilization: policy.maxProjectedMemoryUtilization } : {}),
      projectedFreeMemoryBytes: policy.projectedFreeMemoryBytes,
      ...(policy.projectedFreeMemoryRatio !== undefined ? { projectedFreeMemoryRatio: policy.projectedFreeMemoryRatio } : {}),
      ...(policy.minFreeMemoryRatioAfterLaunch !== undefined ? { minFreeMemoryRatioAfterLaunch: policy.minFreeMemoryRatioAfterLaunch } : {}),
      requestedEstimatedResidentMemoryBytes: policy.requestedEstimatedResidentMemoryBytes,
      activeActualResidentMemoryBytes: policy.activeActualResidentMemoryBytes,
      activeEstimatedResidentMemoryBytes: policy.activeEstimatedResidentMemoryBytes,
    } : undefined,
  };
}

function safeLocalRuntimeInventory(inventory) {
  if (!inventory) return undefined;
  const entries = Array.isArray(inventory.entries) ? inventory.entries : [];
  const policy = inventory.memoryPolicy;
  const utilization = projectedSystemMemoryUtilization(policy);
  return {
    capturedAt: inventory.capturedAt,
    activeLeaseCount: Array.isArray(inventory.activeLeases) ? inventory.activeLeases.length : 0,
    memoryPolicy: policy ? {
      outcome: policy.outcome,
      reason: policy.reason,
      ...(utilization !== undefined ? { projectedSystemMemoryUtilization: utilization } : {}),
      ...(policy.maxProjectedMemoryUtilization !== undefined ? { maxProjectedMemoryUtilization: policy.maxProjectedMemoryUtilization } : {}),
      projectedFreeMemoryBytes: policy.projectedFreeMemoryBytes,
      ...(policy.projectedFreeMemoryRatio !== undefined ? { projectedFreeMemoryRatio: policy.projectedFreeMemoryRatio } : {}),
      ...(policy.minFreeMemoryRatioAfterLaunch !== undefined ? { minFreeMemoryRatioAfterLaunch: policy.minFreeMemoryRatioAfterLaunch } : {}),
    } : undefined,
    entries: entries.slice(0, 30).map(safeLocalRuntimeInventoryEntry),
    truncated: entries.length > 30,
  };
}

function projectedSystemMemoryUtilization(policy) {
  const value = finiteNumber(policy?.projectedSystemMemoryUtilization)
    ?? finiteNumber(policy?.projectedUtilizationPercent);
  if (value === undefined) return undefined;
  return value > 1 && value <= 100 ? value / 100 : value;
}

function safeLocalRuntimeInventoryEntry(entry) {
  return {
    id: entry.id,
    capability: entry.capability,
    providerId: entry.providerId,
    modelRuntimeId: entry.modelRuntimeId,
    modelProfileId: entry.modelProfileId,
    modelId: entry.modelId,
    trackingStatus: entry.trackingStatus,
    running: entry.running,
    pid: entry.pid,
    endpoint: entry.endpoint,
    estimatedResidentMemoryBytes: entry.estimatedResidentMemoryBytes,
    actualResidentMemoryBytes: entry.actualResidentMemoryBytes,
    memorySampledAt: entry.memorySampledAt,
    owners: Array.isArray(entry.owners) ? entry.owners.slice(0, 12).map(safeLocalRuntimeOwner) : [],
    leaseState: entry.leaseState,
    stopDecision: safeStopDecision(entry.stopDecision),
    lifecycleDecision: entry.lifecycleDecision ? {
      stop: safeLifecycleActionDecision(entry.lifecycleDecision.stop),
      restart: safeLifecycleActionDecision(entry.lifecycleDecision.restart),
      load: safeLifecycleActionDecision(entry.lifecycleDecision.load),
      unload: safeLifecycleActionDecision(entry.lifecycleDecision.unload),
    } : undefined,
    providerLifecycle: entry.providerLifecycle ? {
      providerKind: entry.providerLifecycle.providerKind,
      packageId: entry.providerLifecycle.packageId,
      packageName: entry.providerLifecycle.packageName,
      actions: ["start", "stop", "restart"].filter((action) => Boolean(entry.providerLifecycle[action])),
    } : undefined,
    startedAt: entry.startedAt,
    lastUsedAt: entry.lastUsedAt,
    lastHeartbeatAt: entry.lastHeartbeatAt,
  };
}

function safeLocalRuntimeOwner(owner) {
  return {
    leaseId: owner.leaseId,
    parentThreadId: owner.parentThreadId,
    subagentThreadId: owner.subagentThreadId,
    displayName: owner.displayName,
    status: owner.status,
    lastHeartbeatAt: owner.lastHeartbeatAt,
  };
}

function safeStopDecision(decision) {
  if (!decision) return undefined;
  return {
    ordinaryStopAllowed: decision.ordinaryStopAllowed,
    reason: decision.reason,
    blockerLeaseIds: compactStringArray(decision.blockerLeaseIds, 20),
    affectedSubagents: Array.isArray(decision.affectedSubagents) ? decision.affectedSubagents.slice(0, 12) : [],
    forceTerminationAllowed: decision.forceTerminationAllowed,
    forceRequiresSubagentCancellation: decision.forceRequiresSubagentCancellation,
    untracked: decision.untracked,
  };
}

function safeLifecycleActionDecision(decision) {
  if (!decision) return undefined;
  return {
    allowed: decision.allowed,
    reason: decision.reason,
    blockerLeaseIds: compactStringArray(decision.blockerLeaseIds, 20),
    affectedSubagents: Array.isArray(decision.affectedSubagents) ? decision.affectedSubagents.slice(0, 12) : [],
    forceAllowed: decision.forceAllowed,
    forceRequiresSubagentCancellation: decision.forceRequiresSubagentCancellation,
    untracked: decision.untracked,
  };
}

function compactStringArray(value, limit) {
  return (Array.isArray(value) ? value : [])
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter(Boolean)
    .slice(0, limit);
}

function localDeepResearchPrompt() {
  return [
    "This is a live product validation for Ambient Desktop Local Deep Research.",
    "The exact tools are already available. Do not search for tools, discover MCP servers, or inspect installed packages.",
    "Follow these steps exactly:",
    "1. Call ambient_local_model_runtime_status with includeStopped=true and limit=10.",
    "2. Call ambient_local_deep_research_setup with action=validate.",
    "3. If setup is ready, call ambient_local_deep_research_run once.",
    "4. Do not call browser_search, browser_content, web_research_search, web_research_fetch, bash, file tools, install tools, or MCP install tools directly.",
    "5. After the Local Deep Research run tool returns, reply exactly LOCAL_DEEP_RESEARCH_LIVE_DONE followed by one short sentence with the run status and artifact path.",
    "",
    "Use this question for the run tool:",
    "Using current public web sources, compare the latest Node.js LTS release line with the latest stable Python 3 release. Search first, then visit at least one official Node.js source and one official Python source. Produce a concise synthesis with a Sources line that includes the literal citation URLs.",
    "",
    `Use maxToolCalls=${liveRunMaxToolCalls} and maxTurns=${liveRunMaxTurns} for the run tool.`,
  ].join("\n");
}

function localDeepResearchBlockedPreflightPrompt(preflight) {
  return [
    "This is a live product validation for Ambient Desktop Local Deep Research blocked-preflight handling.",
    "The exact tools are already available. Do not search for tools, discover MCP servers, inspect installed packages, or start/stop/restart any local model runtime.",
    "Follow these steps exactly:",
    "1. Call ambient_local_model_runtime_status with includeStopped=true and limit=10.",
    "2. Call ambient_local_deep_research_setup with action=status.",
    "3. If setup is blocked or needs install, do not call ambient_local_deep_research_run.",
    "4. Reply exactly LOCAL_DEEP_RESEARCH_LIVE_BLOCKED_DONE followed by one short sentence naming the setup status and the first blocker.",
    "",
    `The first-party preflight immediately before this chat reported setupStatus=${String(preflight?.setupStatus ?? "unknown")}.`,
  ].join("\n");
}

function positiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function localDeepResearchPreflightRetryAdvice(preflight) {
  if (preflight?.setupStatus === "needs-install") {
    return "Set AMBIENT_LOCAL_DEEP_RESEARCH_LIVE_INSTALL=1 to let the harness install the selected Q4/Q8 profile before running.";
  }
  const blockers = Array.isArray(preflight?.blockers) ? preflight.blockers.filter(Boolean) : [];
  if (blockers.length > 0) {
    return "Resolve the reported setup blockers before rerunning; installing assets will not bypass runtime, provider, or memory-policy blockers. Use Local Models or ambient_local_model_runtime_status to inspect resident runtimes.";
  }
  return "Inspect the setup result before rerunning; enable AMBIENT_LOCAL_DEEP_RESEARCH_LIVE_INSTALL=1 only when the status is needs-install.";
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
        updatedAt: "2026-05-28T00:00:00.000Z"
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
      window.__ambientLocalDeepResearchLive?.unsubscribe?.();
      window.__ambientLocalDeepResearchLive = {
        statuses: [],
        events: [],
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
      window.__ambientLocalDeepResearchLive.unsubscribe = window.ambientDesktop.onEvent((event) => {
        const live = window.__ambientLocalDeepResearchLive;
        live.events.push(event);
        live.events = live.events.slice(-250);
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
          live.runtimeActivities = live.runtimeActivities.slice(-80);
        }
        if (event.type === "message-delta") {
          live.assistantTail = (live.assistantTail + String(event.delta ?? "")).slice(-8000);
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
            content: String(event.message.content ?? "").slice(0, 12000),
          };
          if (existingIndex >= 0) {
            live.toolMessages[existingIndex] = payload;
            return;
          }
          live.toolMessageIds.push(key);
          live.toolNames.push(toolName);
          live.toolNameCounts[toolName] = (live.toolNameCounts[toolName] ?? 0) + 1;
          live.toolMessages.push(payload);
          live.toolMessages = live.toolMessages.slice(-24);
        }
        if (event.type === "error") live.error = event.message;
      });
      return true;
    })()
  `,
  );
}

async function sendPromptAndWait(cdp, input) {
  await evaluate(
    cdp,
    `
    (async () => {
      const live = window.__ambientLocalDeepResearchLive;
      live.sawRunStart = false;
      live.sawRunIdle = false;
      live.sendResolved = false;
      live.error = undefined;
      live.runtimeActivities = [];
      window.ambientDesktop.sendMessage({
        threadId: ${JSON.stringify(input.threadId)},
        content: ${JSON.stringify(input.content)},
        permissionMode: "full-access",
        collaborationMode: "agent",
        model: ${JSON.stringify(input.model)},
        thinkingLevel: "minimal",
      })
        .then(() => { live.sendResolved = true; })
        .catch((error) => { live.error = error instanceof Error ? error.message : String(error); });
      return true;
    })()
  `,
  );
  return waitForLiveCompletion(cdp, timeoutMs, input.expectedFinalToken ?? finalToken);
}

async function waitForLiveCompletion(cdp, maxMs, expectedFinalToken = finalToken) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const live = await getLiveState(cdp);
    if (live.error) throw new Error(live.error);
    assertNoDirectResearchBypass(live);
    assertNoLocalRuntimeLifecycleMutation(live);
    if (live.sawRunIdle && live.sendResolved && live.assistantTail.includes(expectedFinalToken)) return { status: "completed" };
    if (streamStalled(live) && latestToolMessage(live, "ambient_local_deep_research_run")) {
      return { status: "run-tool-completed-provider-stalled" };
    }
    await delay(1_000);
  }
  const live = await getLiveState(cdp);
  throw new Error(`Timed out waiting for live Local Deep Research chat turn. collector=${JSON.stringify(live)}`);
}

async function getLiveState(cdp) {
  return evaluate(
    cdp,
    `
    (() => {
      const live = window.__ambientLocalDeepResearchLive;
      return live ? {
        statuses: live.statuses,
        events: live.events,
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

function assertNoDirectResearchBypass(live) {
  const forbidden = ["bash", "shell"];
  const names = directObservedToolNames(live);
  const seen = forbidden.filter((toolName) => names.has(toolName));
  if (seen.length) throw new Error(`Expected Pi to use only Local Deep Research tools, saw direct bypass tools: ${seen.join(", ")}.`);
}

function assertNoLocalRuntimeLifecycleMutation(live) {
  const forbidden = [
    "ambient_local_model_runtime_start",
    "ambient_local_model_runtime_stop",
    "ambient_local_model_runtime_restart",
  ];
  const names = directObservedToolNames(live);
  const seen = forbidden.filter((toolName) => names.has(toolName));
  if (seen.length) throw new Error(`Expected Pi to inspect local runtimes without lifecycle mutation tools, saw: ${seen.join(", ")}.`);
}

function directObservedToolNames(live) {
  const names = new Set(live?.toolNames ?? []);
  for (const message of live?.toolMessages ?? []) {
    const metadata = message?.metadata ?? {};
    const rawDetails = rawToolResultDetails(message);
    for (const name of [
      message?.toolName,
      metadata.toolName,
      metadata.wrappedTool,
      rawDetails?.wrappedTool,
      rawDetails?.toolName,
    ]) {
      if (typeof name === "string" && name.trim()) names.add(name.trim());
    }
  }
  return names;
}

function assertToolCalledBefore(live, firstToolName, secondToolName) {
  const toolNames = observedToolNames(live);
  const firstIndex = toolNames.indexOf(firstToolName);
  const secondIndex = toolNames.indexOf(secondToolName);
  if (firstIndex < 0 || secondIndex < 0 || firstIndex > secondIndex) {
    throw new Error(`Expected ${firstToolName} before ${secondToolName}. toolNames=${JSON.stringify(toolNames)}`);
  }
}

function assertRuntimeStatusNextSafeActionEvidence(runtimeStatus) {
  const untrackedCount = Number(runtimeStatus?.summary?.untrackedCount ?? 0);
  if (untrackedCount <= 0) return;
  const nextSafeActions = runtimeStatus?.policyHandoff?.nextSafeActions ?? [];
  const hasUntrackedAction = nextSafeActions.some((action) =>
    action?.action === "ask-user-to-stop-untracked" &&
    action?.safety === "external" &&
    action?.untracked === true
  );
  if (!hasUntrackedAction) {
    throw new Error(`Runtime status reported ${untrackedCount} untracked runtime(s) without ask-user-to-stop-untracked next safe action. runtimeStatus=${JSON.stringify(runtimeStatus)}`);
  }
}

function observedToolNames(live) {
  const names = [];
  for (const message of live?.toolMessages ?? []) {
    const routedNames = toolNamesForMessage(message).filter((name) => name !== "ambient_tool_call");
    names.push(routedNames[0] ?? message.toolName);
  }
  return names.filter(Boolean);
}

function toolNamesForMessage(message) {
  const metadata = message?.metadata ?? {};
  const rawDetails = rawToolResultDetails(message);
  const nestedDetails = rawDetails?.resultDetails && typeof rawDetails.resultDetails === "object" ? rawDetails.resultDetails : undefined;
  return [
    message?.toolName,
    metadata.toolName,
    metadata.wrappedTool,
    rawDetails?.wrappedTool,
    rawDetails?.toolName,
    nestedDetails?.wrappedTool,
    nestedDetails?.toolName,
  ]
    .map((name) => typeof name === "string" ? name.trim() : "")
    .filter(Boolean);
}

function assertSetupDetails(details, message) {
  if (details.setupStatus !== "ready") {
    throw new Error(`Local Deep Research setup tool was not ready. details=${JSON.stringify(details)} message=${JSON.stringify(message)}`);
  }
  if (details.validation?.status !== "passed") {
    throw new Error(`Expected setup validation to pass. details=${JSON.stringify(details)} message=${JSON.stringify(message)}`);
  }
}

function assertRunDetails(details, message) {
  const gracefullyExhaustedBudget = details.status === "tool-budget-exceeded" &&
    details.toolBudget?.exhausted === true &&
    Number(details.toolBudget?.remainingToolCalls) === 0 &&
    String(details.finalText ?? "").includes("Local Deep Research Evidence Packet");
  if (details.status !== "completed" && !gracefullyExhaustedBudget) {
    throw new Error(`Local Deep Research run did not complete. details=${JSON.stringify(details)} message=${JSON.stringify(message)}`);
  }
  if (!details.providerSnapshot?.searchOrder?.length || !details.providerSnapshot?.fetchOrder?.length) {
    throw new Error(`Run did not capture usable provider snapshot. details=${JSON.stringify(details)}`);
  }
  const executions = Array.isArray(details.toolExecutions) ? details.toolExecutions : [];
  const names = executions.map((execution) => execution?.call?.name).filter(Boolean);
  if (!names.includes("search") || !names.includes("visit")) {
    throw new Error(`Expected at least one search and one visit execution. names=${JSON.stringify(names)} details=${JSON.stringify(details)}`);
  }
  const selectedProviders = executions.map((execution) => execution?.result?.selectedProvider).filter(Boolean);
  if (!selectedProviders.length) throw new Error(`Expected selected providers in Local Deep Research tool executions. details=${JSON.stringify(details)}`);
  const citationUrls = citationUrlsFromRunDetails(details);
  const hasOfficialNode = citationUrls.some((url) => /(^|\.)nodejs\.org\//i.test(hostWithPath(url)));
  const hasOfficialPython = citationUrls.some((url) => /(^|\.)python\.org\//i.test(hostWithPath(url)));
  if (!hasOfficialNode || !hasOfficialPython) {
    throw new Error(`Expected official Node.js and Python citation URLs in final synthesis or captured run evidence. urls=${JSON.stringify(citationUrls.slice(0, 20))} finalText=${String(details.finalText ?? "").slice(0, 1000)}`);
  }
  if (!details.artifacts?.jsonPath || !details.artifacts?.markdownPath) {
    throw new Error(`Run did not report JSON and Markdown artifacts. details=${JSON.stringify(details)}`);
  }
}

function citationUrlsFromRunDetails(details) {
  const executions = Array.isArray(details.toolExecutions) ? details.toolExecutions : [];
  const textParts = [
    String(details.finalText ?? ""),
    ...executions.flatMap((execution) => [
      stringToolArgument(execution?.call?.arguments?.url),
      String(execution?.result?.text ?? ""),
    ]),
  ];
  return [...new Set(textParts.flatMap(extractUrls))];
}

function extractUrls(text) {
  return [...String(text).matchAll(/https?:\/\/[^\s<>"']+/gi)]
    .map((match) => match[0].replace(/[)\].,;:]+$/g, ""))
    .filter(Boolean);
}

function hostWithPath(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function stringToolArgument(value) {
  return typeof value === "string" ? value : "";
}

function latestToolMessage(live, toolName) {
  return [...(live?.toolMessages ?? [])].reverse().find((message) => message.toolName === toolName);
}

function setupDetailsFromMessage(message) {
  const details = toolResultDetails(message);
  if (details.setupStatus || details.validation) return details;
  const content = String(message?.content ?? "");
  const setupStatus = content.match(/Local Deep Research setup status:\s*(ready|needs-install|blocked)\./i)?.[1];
  return {
    setupStatus: setupStatus ?? (/Setup status:\s*ready\./i.test(content) || /setup status:\s*ready\./i.test(content) ? "ready" : undefined),
    validation: /Local Deep Research validation passed\./i.test(content) ? { status: "passed" } : undefined,
    blockers: sectionItemsFromContent(content, "Blockers"),
  };
}

function runtimeStatusSummaryFromMessage(message) {
  const details = toolResultDetails(message);
  const content = String(message?.content ?? "");
  return {
    status: details.status,
    capturedAt: details.capturedAt,
    summary: details.summary ? {
      runtimeCount: details.summary.runtimeCount,
      runningCount: details.summary.runningCount,
      activeLeaseCount: details.summary.activeLeaseCount,
      stopBlockedCount: details.summary.stopBlockedCount,
      restartBlockedCount: details.summary.restartBlockedCount,
      untrackedCount: details.summary.untrackedCount,
      staleLeaseCount: details.summary.staleLeaseCount,
      releasedLeaseCount: details.summary.releasedLeaseCount,
      crashedLeaseCount: details.summary.crashedLeaseCount,
      activeEstimatedResidentMemoryBytes: details.summary.activeEstimatedResidentMemoryBytes,
      activeActualResidentMemoryBytes: details.summary.activeActualResidentMemoryBytes,
      memoryPolicyOutcome: details.summary.memoryPolicyOutcome,
      memoryPolicyReason: details.summary.memoryPolicyReason,
    } : runtimeStatusSummaryFromContent(content),
    localRuntimeInventory: safeLocalRuntimeInventory(details.inventory),
    policyHandoff: safeLocalRuntimePolicyHandoff(details.policyHandoff, content),
  };
}

function safeLocalRuntimePolicyHandoff(handoff, content = "") {
  if (!handoff) {
    const nextSafeActions = nextSafeActionsFromContent(content);
    return nextSafeActions.length ? { nextSafeActions } : undefined;
  }
  return {
    schemaVersion: handoff.schemaVersion,
    runtimeCount: handoff.runtimeCount,
    runningCount: handoff.runningCount,
    activeLeaseCount: handoff.activeLeaseCount,
    blockedActionCount: handoff.blockedActionCount,
    stopBlockedRuntimeIds: compactStringArray(handoff.stopBlockedRuntimeIds, 30),
    restartBlockedRuntimeIds: compactStringArray(handoff.restartBlockedRuntimeIds, 30),
    untrackedRuntimeIds: compactStringArray(handoff.untrackedRuntimeIds, 30),
    nextSafeActions: Array.isArray(handoff.nextSafeActions)
      ? handoff.nextSafeActions.slice(0, 30).map(safeLocalRuntimeNextSafeAction)
      : nextSafeActionsFromContent(content),
  };
}

function safeLocalRuntimeNextSafeAction(action) {
  return {
    action: action.action,
    safety: action.safety,
    reason: action.reason,
    runtimeEntryId: action.runtimeEntryId,
    runtimeId: action.runtimeId,
    capability: action.capability,
    toolName: action.toolName,
    toolParams: action.toolParams,
    blockerLeaseIds: compactStringArray(action.blockerLeaseIds, 20),
    affectedSubagents: Array.isArray(action.affectedSubagents) ? action.affectedSubagents.slice(0, 12) : [],
    untracked: action.untracked,
  };
}

function nextSafeActionsFromContent(content) {
  return sectionItemsFromContent(content, "Next safe actions")
    .map((line) => {
      const match = line.match(/^(safe|requires-approval|blocked|external)\s+([a-z-]+)(?:\s+for\s+(.+?))?:\s+([\s\S]*)$/i);
      return match ? {
        safety: match[1],
        action: match[2],
        runtimeEntryId: match[3],
        reason: match[4],
        untracked: /untracked/i.test(line),
      } : {
        action: "inspect-status",
        safety: "safe",
        reason: line,
      };
    });
}

function runtimeStatusSummaryFromContent(content) {
  const summaryMatch = content.match(/Local model runtime status:\s*(\d+)\s+runtime[^;]*;\s*(\d+)\s+running;\s*(\d+)\s+active leases\./i);
  const blockersMatch = content.match(/Lifecycle blockers:\s*stop\s+(\d+);\s*restart\s+(\d+);\s*untracked processes:\s*(\d+)\./i);
  const memoryPolicy = content.match(/Memory policy:\s*([a-z-]+)\s*-\s*([^\n]+)/i);
  if (!summaryMatch && !blockersMatch && !memoryPolicy) return undefined;
  return {
    runtimeCount: Number(summaryMatch?.[1] ?? 0),
    runningCount: Number(summaryMatch?.[2] ?? 0),
    activeLeaseCount: Number(summaryMatch?.[3] ?? 0),
    stopBlockedCount: Number(blockersMatch?.[1] ?? 0),
    restartBlockedCount: Number(blockersMatch?.[2] ?? 0),
    untrackedCount: Number(blockersMatch?.[3] ?? 0),
    memoryPolicyOutcome: memoryPolicy?.[1],
    memoryPolicyReason: memoryPolicy?.[2]?.trim(),
  };
}

function sectionItemsFromContent(content, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`${escaped}:\\n([\\s\\S]*?)(?:\\n[A-Z][A-Za-z ]+:|$)`, "i"));
  if (!match) return [];
  return match[1]
    .split("\n")
    .map((line) => line.trim().replace(/^-\s*/, ""))
    .filter(Boolean)
    .slice(0, 20);
}

async function runDetailsFromMessage(message) {
  const details = toolResultDetails(message);
  if (details.status && Array.isArray(details.toolExecutions)) return details;
  const content = String(message?.content ?? "");
  const artifactMatch = content.match(/Artifacts:\s+([^\s]+\.md)\s+and\s+([^\s]+\.json)\./i);
  const markdownPath = artifactMatch?.[1];
  const jsonPath = artifactMatch?.[2];
  if (jsonPath) {
    const artifact = await readWorkspaceArtifactJson(jsonPath);
    if (artifact) {
      return {
        status: artifact.run?.status,
        setupStatus: artifact.run?.setupStatus ?? artifact.setup?.status,
        modelProfileId: artifact.run?.modelProfileId,
        contextTokens: artifact.run?.contextTokens,
        providerSnapshot: artifact.run?.providerSnapshot,
        toolExecutions: artifact.run?.toolExecutions,
        finalText: artifact.run?.finalText,
        artifacts: {
          jsonPath,
          ...(markdownPath ? { markdownPath } : {}),
          ...(artifact.__resolvedPath ? { resolvedJsonPath: artifact.__resolvedPath } : {}),
        },
        llamaServer: artifact.llamaServer,
      };
    }
  }
  return {
    status: content.match(/Local Deep Research\s+([a-z-]+)\./i)?.[1],
    modelProfileId: content.match(/Model:\s*([^;]+);/i)?.[1],
    contextTokens: Number(content.match(/context:\s*(\d+)/i)?.[1] ?? NaN) || undefined,
    providerSnapshot: {
      searchOrder: routeFromContent(content, "Search route snapshot"),
      fetchOrder: routeFromContent(content, "Fetch route snapshot"),
    },
    toolExecutions: Array.from({ length: Number(content.match(/Tool calls:\s*(\d+)/i)?.[1] ?? 0) }, () => ({})),
    finalText: content,
    artifacts: {
      ...(jsonPath ? { jsonPath } : {}),
      ...(markdownPath ? { markdownPath } : {}),
    },
  };
}

function toolResultDetails(message) {
  const details = rawToolResultDetails(message);
  return details?.resultDetails && typeof details.resultDetails === "object"
    ? details.resultDetails
    : details;
}

function rawToolResultDetails(message) {
  return message?.metadata?.toolResultDetails ?? message?.metadata?.resultDetails ?? {};
}

function routeFromContent(content, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const value = content.match(new RegExp(`${escaped}:\\s*([^\\n]+)`, "i"))?.[1]?.trim();
  if (!value || value === "none") return [];
  return value.split(/\s*->\s*/).map((item) => item.trim()).filter(Boolean);
}

async function readWorkspaceArtifactJson(relativePath) {
  for (const candidate of await workspaceArtifactCandidates(relativePath)) {
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8"));
      return { ...parsed, __resolvedPath: candidate };
    } catch {
      // Try the next possible project/worktree root.
    }
  }
  return undefined;
}

async function workspaceArtifactCandidates(relativePath) {
  const candidates = [join(workspace, relativePath)];
  const worktreeRoot = join(workspace, ".ambient-codex", "worktrees");
  const entries = await readdir(worktreeRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) candidates.push(join(worktreeRoot, entry.name, relativePath));
  }
  return candidates;
}

function streamStalled(live) {
  return (live.runtimeActivities ?? []).some((activity) =>
    activity.status === "timeout" || String(activity.message ?? "").includes("stream stalled")
  );
}

async function desktopState(cdp) {
  return evaluate(cdp, "window.ambientDesktop.bootstrap()");
}

async function waitForTarget(childExit) {
  const deadline = Date.now() + electronTargetTimeoutMs;
  while (Date.now() < deadline) {
    const exit = childExit?.();
    if (exit) throw new Error(`Electron exited before CDP target was ready: ${JSON.stringify(exit)}. ${outputTail()}`);
    try {
      const version = await fetchJsonWithTimeout(`http://127.0.0.1:${port}/json/version`, 2_000);
      const targets = await fetchJsonWithTimeout(`http://127.0.0.1:${port}/json/list`, 2_000);
      lastCdpProbe = {
        checkedAt: new Date().toISOString(),
        port,
        browser: version?.Browser,
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
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for Electron CDP target. Last probe: ${JSON.stringify(lastCdpProbe ?? {})}`);
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
        send(method, params = {}, timeoutMs = 30_000) {
          const id = nextId++;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((innerResolve, innerReject) => {
            const timeout = setTimeout(() => {
              if (!pending.has(id)) return;
              pending.delete(id);
              innerReject(new Error(`Timed out waiting for CDP ${method}.`));
            }, timeoutMs);
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

async function evaluate(cdp, expression, timeoutMs = 30_000) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, timeoutMs);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Runtime.evaluate failed.");
  }
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

function findOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const selectedPort = typeof address === "object" && address ? address.port : undefined;
      server.close(() => {
        if (!selectedPort) reject(new Error("Could not allocate an open port."));
        else resolve(selectedPort);
      });
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function outputTail() {
  return `Electron output tail:\n${output.join("").slice(-8000)}`;
}

async function terminateDebugPortProcesses() {
  if (process.platform === "win32") return;
  await new Promise((resolvePromise) => {
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
      resolvePromise();
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
