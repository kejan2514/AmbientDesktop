import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export const DEFAULT_WORKFLOW_UI_DOGFOOD_SHARED_SNAPSHOT_ROOT =
  "/Users/example/.ambient-hardening/snapshots/shared-secrets/example-shared-secrets";
const DEFAULT_WORKFLOW_UI_DOGFOOD_SHARED_SNAPSHOT_NAME = basename(DEFAULT_WORKFLOW_UI_DOGFOOD_SHARED_SNAPSHOT_ROOT);
const WORKFLOW_UI_DOGFOOD_SNAPSHOT_ROOT_ENV_VARS = [
  "AMBIENT_WORKFLOW_UI_DOGFOOD_SNAPSHOT_ROOT",
  "AMBIENT_WORKFLOW_UI_DOGFOOD_SHARED_SNAPSHOT_ROOT",
  "AMBIENT_SHARED_SECRETS_SNAPSHOT_ROOT",
  "AMBIENT_E2E_SHARED_SNAPSHOT_ROOT",
];
export const WORKFLOW_UI_DOGFOOD_SNAPSHOT_SHAPE_ERROR =
  "Snapshot copy requested, but the snapshot root did not contain userData/workspace directories or a workspace archive shape. Set AMBIENT_WORKFLOW_UI_DOGFOOD_SNAPSHOT_ROOT or AMBIENT_SHARED_SECRETS_SNAPSHOT_ROOT to a valid snapshot root, or disable snapshot mode.";

const GMI_CLOUD_DEFAULT_BASE_URL = "https://api.gmi-serving.com";
const DEFAULT_BOOTSTRAP_WATCHDOG_MS = "180000";
const GWS_VERSION = "v0.22.3";
const READ_ONLY_WRITE_TOOL_MESSAGES = new Set(["bash", "file_write", "google_workspace_call"]);
const OUTPUT_EVENT_PATTERN = /output|checkpoint|report|model/i;

export function normalizeWorkflowUiDogfoodProvider(rawProvider) {
  const raw = String(rawProvider ?? "").trim().toLowerCase();
  return ["gmi", "gmi-cloud", "gmicloud", "gmi_cloud"].includes(raw) ? "gmi-cloud" : raw === "ambient" ? "ambient" : "gmi-cloud";
}

export function workflowUiDogfoodProviderLabel(providerId) {
  return providerId === "gmi-cloud" ? "GMI Cloud" : "Ambient";
}

export function workflowUiDogfoodSnapshotPreflight(input = {}) {
  const selection = workflowUiDogfoodSnapshotRootSelection(input);
  const requested = selection.requested;
  const resolvedRoot = selection.selected?.path;
  const rootExists = selection.selected?.rootExists === true;
  const workspaceDirectory = selection.selected?.workspaceDirectory === true;
  const userDataDirectory = selection.selected?.userDataDirectory === true;
  const workspaceArchiveShape = selection.selected?.workspaceArchiveShape === true;
  const snapshotMode = selection.selected?.snapshotMode;
  const issues = [];
  if (requested && !rootExists) {
    issues.push("Snapshot copy requested, but the selected snapshot root does not exist.");
  } else if (requested && !snapshotMode) {
    issues.push(WORKFLOW_UI_DOGFOOD_SNAPSHOT_SHAPE_ERROR);
  }
  const status = !requested ? "not-requested" : !rootExists ? "missing" : snapshotMode ? "ready" : "invalid";

  return {
    ok: !requested || status === "ready",
    requested,
    status,
    snapshotMode: requested ? snapshotMode : "fresh-temp",
    snapshotRootLabel: requested && resolvedRoot ? basename(resolvedRoot) : undefined,
    snapshotRootPathDigest: requested && resolvedRoot
      ? createHash("sha256").update(resolvedRoot).digest("hex").slice(0, 12)
      : undefined,
    selectedRootSource: requested ? selection.selected?.source : undefined,
    candidateRoots: requested ? selection.candidates.map(redactedSnapshotRootCandidate) : undefined,
    checks: {
      rootExists,
      workspaceDirectory,
      userDataDirectory,
      workspaceArchiveShape,
    },
    issues,
    guidance: requested && status !== "ready"
      ? "Use a valid credentialed snapshot copy, set AMBIENT_WORKFLOW_UI_DOGFOOD_SNAPSHOT_ROOT or AMBIENT_SHARED_SECRETS_SNAPSHOT_ROOT, or disable AMBIENT_WORKFLOW_UI_DOGFOOD_USE_SHARED_SNAPSHOT for connector-free scenarios."
      : undefined,
  };
}

export function workflowUiDogfoodSelectedSnapshotRoot(input = {}) {
  const selection = workflowUiDogfoodSnapshotRootSelection(input);
  return selection.requested ? selection.selected?.path : undefined;
}

export function workflowUiDogfoodSnapshotPreflightErrorMessage(preflight) {
  if (!preflight?.requested || preflight?.ok) return "";
  if (preflight.status === "missing") {
    return "Snapshot copy requested, but the selected snapshot root does not exist. Set AMBIENT_WORKFLOW_UI_DOGFOOD_SNAPSHOT_ROOT or AMBIENT_SHARED_SECRETS_SNAPSHOT_ROOT to a valid snapshot root, or disable snapshot mode.";
  }
  return WORKFLOW_UI_DOGFOOD_SNAPSHOT_SHAPE_ERROR;
}

export function workflowUiDogfoodLaunchEnvironment(input) {
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const providerId = normalizeWorkflowUiDogfoodProvider(env.AMBIENT_PROVIDER || env.AMBIENT_LLM_PROVIDER);
  const googleWorkspace = workflowUiDogfoodGoogleWorkspaceEnvironment(input);
  const providerEnv = {
    AMBIENT_PROVIDER: providerId,
    AMBIENT_DESKTOP_WORKSPACE: input.workspace,
    AMBIENT_E2E: "1",
    AMBIENT_E2E_USER_DATA: input.userData,
    AMBIENT_DESKTOP_BOOTSTRAP_WATCHDOG_MS: env.AMBIENT_DESKTOP_BOOTSTRAP_WATCHDOG_MS ?? DEFAULT_BOOTSTRAP_WATCHDOG_MS,
    ...googleWorkspace.env,
  };
  const credential = workflowUiDogfoodCredentialStatus({ env, cwd, providerId });

  if (providerId === "gmi-cloud") {
    providerEnv.GMI_CLOUD_BASE_URL = env.GMI_CLOUD_BASE_URL || GMI_CLOUD_DEFAULT_BASE_URL;
    if (!env.GMI_CLOUD_API_KEY && !env.GMI_API_KEY && !env.GMI_CLOUD_API_KEY_FILE && credential.defaultKeyFile) {
      providerEnv.GMI_CLOUD_API_KEY_FILE = credential.defaultKeyFile;
    }
  } else if (!env.AMBIENT_API_KEY && !env.AMBIENT_AGENT_AMBIENT_API_KEY && !env.AMBIENT_API_KEY_FILE && credential.defaultKeyFile) {
    providerEnv.AMBIENT_API_KEY_FILE = credential.defaultKeyFile;
  }

  return {
    providerId,
    providerLabel: workflowUiDogfoodProviderLabel(providerId),
    env: providerEnv,
    credentialConfigured: credential.configured,
    credentialSources: credential.sources,
    launchSummary: {
      providerId,
      providerLabel: workflowUiDogfoodProviderLabel(providerId),
      workspaceMode: input.snapshotMode ?? "fresh-temp",
      credentialConfigured: credential.configured,
      credentialSources: credential.sources,
      googleWorkspace: googleWorkspace.summary,
    },
  };
}

export function workflowUiDogfoodGoogleWorkspaceEnvironment(input) {
  const env = input.env ?? process.env;
  const snapshotRuntime = workflowUiDogfoodGwsSnapshotRuntime({
    env,
    homeDir: input.homeDir,
    gwsSnapshotRoot: input.gwsSnapshotRoot,
  });
  const binaryCandidate = firstExistingPath([
    { path: env.AMBIENT_GWS_CLI_PATH, source: "env:AMBIENT_GWS_CLI_PATH" },
    { path: env.GOOGLE_WORKSPACE_CLI_PATH, source: "env:GOOGLE_WORKSPACE_CLI_PATH" },
    { path: env.AMBIENT_WORKFLOW_UI_DOGFOOD_GWS_CLI_PATH, source: "env:AMBIENT_WORKFLOW_UI_DOGFOOD_GWS_CLI_PATH" },
    input.userData
      ? {
          path: join(input.userData, "tools", "google-workspace-cli", GWS_VERSION, `${process.platform}-${process.arch}`, "gws"),
          source: "user-data-managed-binary",
        }
      : undefined,
    snapshotRuntime?.binaryPath
      ? { path: snapshotRuntime.binaryPath, source: "gws-hardening-snapshot" }
      : undefined,
    {
      path: join(
        input.homeDir ?? homedir(),
        "Library",
        "Application Support",
        "Ambient Desktop",
        "tools",
        "google-workspace-cli",
        GWS_VERSION,
        `${process.platform}-${process.arch}`,
        "gws",
      ),
      source: "ambient-desktop-managed-binary",
    },
  ]);
  const configCandidate = firstExistingPath([
    { path: env.AMBIENT_GWS_CONFIG_ROOT, source: "env:AMBIENT_GWS_CONFIG_ROOT" },
    input.userData
      ? {
          path: join(input.userData, "google-workspace-cli"),
          source: "user-data-config",
        }
      : undefined,
    snapshotRuntime?.configRoot
      ? { path: snapshotRuntime.configRoot, source: "gws-hardening-snapshot" }
      : undefined,
  ]);

  const launchEnv = {};
  if (binaryCandidate && !firstNonEmpty(env.AMBIENT_GWS_CLI_PATH, env.GOOGLE_WORKSPACE_CLI_PATH)) {
    launchEnv.AMBIENT_GWS_CLI_PATH = binaryCandidate.path;
  }
  if (configCandidate && !firstNonEmpty(env.AMBIENT_GWS_CONFIG_ROOT)) {
    launchEnv.AMBIENT_GWS_CONFIG_ROOT = configCandidate.path;
  }

  return {
    env: launchEnv,
    summary: {
      status: binaryCandidate && configCandidate ? "configured" : "not-configured",
      binarySource: binaryCandidate?.source ?? "missing",
      configSource: configCandidate?.source ?? "missing",
      binaryConfigured: Boolean(binaryCandidate),
      configConfigured: Boolean(configCandidate),
    },
  };
}

function workflowUiDogfoodGwsSnapshotRuntime(input) {
  const roots = uniqueStrings([
    input.env?.AMBIENT_WORKFLOW_UI_DOGFOOD_GWS_SNAPSHOT_ROOT,
    input.gwsSnapshotRoot,
    join(input.homeDir ?? homedir(), ".ambient-hardening", "snapshots", "google-workspace-cli"),
  ]);
  for (const root of roots) {
    for (const candidateRoot of workflowUiDogfoodGwsSnapshotRoots(root)) {
      const binaryPath = join(candidateRoot, "userData", "tools", "google-workspace-cli", GWS_VERSION, `${process.platform}-${process.arch}`, "gws");
      if (!existsSync(binaryPath)) continue;
      const configRoot = join(candidateRoot, "userData", "google-workspace-cli");
      return {
        binaryPath,
        configRoot: existsSync(configRoot) ? configRoot : undefined,
      };
    }
  }
  return undefined;
}

function workflowUiDogfoodGwsSnapshotRoots(root) {
  if (!root || !existsSync(root)) return [];
  const directBinary = join(root, "userData", "tools", "google-workspace-cli", GWS_VERSION, `${process.platform}-${process.arch}`, "gws");
  if (existsSync(directBinary)) return [root];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .sort((left, right) => basename(right).localeCompare(basename(left)));
}

function workflowUiDogfoodSnapshotRootSelection(input = {}) {
  const env = input.env ?? process.env;
  const explicitCandidates = workflowUiDogfoodExplicitSnapshotRootCandidates(input);
  const configuredRoot = explicitCandidates.length > 0;
  const requested = input.useSnapshot ?? (
    truthyWorkflowUiDogfoodEnv(env.AMBIENT_WORKFLOW_UI_DOGFOOD_USE_SHARED_SNAPSHOT) || configuredRoot
  );
  const candidates = !requested
    ? []
    : explicitCandidates.length > 0
      ? explicitCandidates
      : workflowUiDogfoodDefaultSnapshotRootCandidates(input);
  const inspected = candidates.map(inspectWorkflowUiDogfoodSnapshotRootCandidate);
  const selected = explicitCandidates.length > 0
    ? inspected[0]
    : inspected.find((candidate) => candidate.snapshotMode)
      ?? inspected.find((candidate) => candidate.rootExists)
      ?? inspected[0];
  return { requested, configuredRoot, candidates: inspected, selected };
}

function workflowUiDogfoodExplicitSnapshotRootCandidates(input = {}) {
  const env = input.env ?? process.env;
  return uniqueSnapshotRootCandidates([
    input.snapshotRoot ? { path: input.snapshotRoot, source: "input:snapshotRoot" } : undefined,
    ...WORKFLOW_UI_DOGFOOD_SNAPSHOT_ROOT_ENV_VARS.map((name) => (
      env[name] ? { path: env[name], source: `env:${name}` } : undefined
    )),
  ]);
}

function workflowUiDogfoodDefaultSnapshotRootCandidates(input = {}) {
  const homeDir = input.homeDir ?? homedir();
  const sharedSecretsRoot = join(homeDir, ".ambient-hardening", "snapshots", "shared-secrets");
  return uniqueSnapshotRootCandidates([
    {
      path: join(sharedSecretsRoot, DEFAULT_WORKFLOW_UI_DOGFOOD_SHARED_SNAPSHOT_NAME),
      source: "default:home-shared-secrets-primary",
    },
    ...workflowUiDogfoodSharedSecretsDirectoryCandidates(sharedSecretsRoot),
    {
      path: DEFAULT_WORKFLOW_UI_DOGFOOD_SHARED_SNAPSHOT_ROOT,
      source: "default:legacy-shared-secrets-primary",
    },
  ]);
}

function workflowUiDogfoodSharedSecretsDirectoryCandidates(sharedSecretsRoot) {
  if (!existsSync(sharedSecretsRoot)) return [];
  try {
    return readdirSync(sharedSecretsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        path: join(sharedSecretsRoot, entry.name),
        source: "default:home-shared-secrets-directory",
      }))
      .sort((left, right) => basename(right.path).localeCompare(basename(left.path)));
  } catch {
    return [];
  }
}

function uniqueSnapshotRootCandidates(candidates) {
  const seen = new Set();
  const unique = [];
  for (const candidate of candidates) {
    const path = firstNonEmpty(candidate?.path);
    if (!path) continue;
    const resolvedPath = resolve(path);
    if (seen.has(resolvedPath)) continue;
    seen.add(resolvedPath);
    unique.push({ path: resolvedPath, source: candidate.source });
  }
  return unique;
}

function inspectWorkflowUiDogfoodSnapshotRootCandidate(candidate) {
  const rootExists = existsSync(candidate.path);
  const workspaceDirectory = rootExists && existsSync(join(candidate.path, "workspace"));
  const userDataDirectory = rootExists && existsSync(join(candidate.path, "userData"));
  const sharedSnapshotShape = workspaceDirectory && userDataDirectory;
  const workspaceArchiveShape = rootExists && workflowUiDogfoodLooksLikeWorkspaceArchive(candidate.path);
  const snapshotMode = sharedSnapshotShape
    ? "shared-snapshot-temp-copy"
    : workspaceArchiveShape
      ? "workspace-archive-temp-copy"
      : undefined;
  return {
    ...candidate,
    rootExists,
    workspaceDirectory,
    userDataDirectory,
    workspaceArchiveShape,
    snapshotMode,
  };
}

function redactedSnapshotRootCandidate(candidate) {
  return {
    source: candidate.source,
    label: basename(candidate.path),
    pathDigest: createHash("sha256").update(candidate.path).digest("hex").slice(0, 12),
    rootExists: candidate.rootExists,
    workspaceDirectory: candidate.workspaceDirectory,
    userDataDirectory: candidate.userDataDirectory,
    workspaceArchiveShape: candidate.workspaceArchiveShape,
    snapshotMode: candidate.snapshotMode,
  };
}

function firstExistingPath(candidates) {
  for (const candidate of candidates) {
    const path = firstNonEmpty(candidate?.path);
    if (path && existsSync(path)) return { path: resolve(path), source: candidate.source };
  }
  return undefined;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text) return text;
  }
  return undefined;
}

function truthyWorkflowUiDogfoodEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function workflowUiDogfoodLooksLikeWorkspaceArchive(snapshotRoot) {
  return existsSync(join(snapshotRoot, "package.json")) || existsSync(join(snapshotRoot, "WORKFLOW.md")) || existsSync(join(snapshotRoot, ".ambient"));
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => firstNonEmpty(value)).filter(Boolean))];
}

export function workflowUiDogfoodCredentialStatus(input) {
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const providerId = input.providerId ?? normalizeWorkflowUiDogfoodProvider(env.AMBIENT_PROVIDER || env.AMBIENT_LLM_PROVIDER);
  const sources = [];
  let defaultKeyFile;

  if (providerId === "gmi-cloud") {
    if (env.GMI_CLOUD_API_KEY) sources.push("env:GMI_CLOUD_API_KEY");
    if (env.GMI_API_KEY) sources.push("env:GMI_API_KEY");
    if (env.GMI_CLOUD_API_KEY_FILE) sources.push("env:GMI_CLOUD_API_KEY_FILE");
    const candidate = join(cwd, "ignored-provider-key-file.txt");
    if (existsSync(candidate)) {
      defaultKeyFile = candidate;
      sources.push(`file:${basename(candidate)}`);
    }
  } else {
    if (env.AMBIENT_API_KEY) sources.push("env:AMBIENT_API_KEY");
    if (env.AMBIENT_AGENT_AMBIENT_API_KEY) sources.push("env:AMBIENT_AGENT_AMBIENT_API_KEY");
    if (env.AMBIENT_API_KEY_FILE) sources.push("env:AMBIENT_API_KEY_FILE");
    const candidate = join(cwd, "ignored-provider-key-file.txt");
    if (existsSync(candidate)) {
      defaultKeyFile = candidate;
      sources.push(`file:${basename(candidate)}`);
    }
  }

  return {
    providerId,
    configured: sources.length > 0,
    sources,
    defaultKeyFile,
  };
}

export function assertWorkflowUiDogfoodEvidence(detail, options = {}) {
  const expectConfig = options.expectConfig ?? {};
  const scenarioName = options.scenarioName ?? "workflow-ui-dogfood";
  const maxRetainedRunEvents = Number.isFinite(options.maxRetainedRunEvents) ? options.maxRetainedRunEvents : 420;
  const events = detail.events ?? [];
  const modelCalls = detail.modelCalls ?? [];
  const checkpoints = detail.checkpoints ?? [];
  const failures = [];
  const desktopToolEnds = desktopToolEndMessages(detail);
  const connectorEnds = connectorEndMessages(detail);
  const documentRenderEnds = documentRenderEndEvents(detail);
  const toolMessageCounts = desktopToolEnds.reduce((counts, message) => {
    counts[message] = (counts[message] ?? 0) + 1;
    return counts;
  }, {});
  const connectorMessageCounts = connectorEnds.reduce((counts, message) => {
    counts[message] = (counts[message] ?? 0) + 1;
    return counts;
  }, {});
  const runtimeInputRequests = events.filter((event) => event.type === "workflow.input.required").length;
  const runtimeInputResponses = events.filter((event) => event.type === "workflow.input.received").length;
  const approvalRequests = events.filter((event) => event.type === "approval.required").length;
  const approvalResponses = events.filter((event) => event.type === "approval.approved").length;
  const outputSignals = outputSignalCount(detail);
  const outputReadyEvents = events.filter((event) => event.type === "workflow.output.ready");
  const finalOutput = collectFinalOutputEvidence(detail);
  const failedModelCalls = modelCalls.filter((call) => call.status !== "succeeded");
  const recoveryEvents = events.filter((event) => event.type.startsWith("workflow.recovery."));
  const recoveryActionCounts = recoveryEvents.reduce((counts, event) => {
    const action = String(event.data?.action ?? event.message ?? "");
    if (action) counts[action] = (counts[action] ?? 0) + 1;
    return counts;
  }, {});
  const skippedRecoveryEvents = recoveryEvents.filter((event) => event.type === "workflow.recovery.skipped_item");
  const allowedWriteToolMessages = new Set((expectConfig.allowedWriteToolMessages ?? []).map((message) => String(message)));
  const allowedWriteConnectorMessages = new Set((expectConfig.allowedWriteConnectorMessages ?? []).map((message) => String(message)));
  const unintendedWriteTools = expectConfig.noUnintendedWrites === false
    ? []
    : desktopToolEnds.filter((message) => READ_ONLY_WRITE_TOOL_MESSAGES.has(message) && !allowedWriteToolMessages.has(message));
  const unintendedWriteConnectors = expectConfig.noUnintendedWrites === false
    ? []
    : events
        .filter((event) => event.type === "connector.end")
        .filter((event) => String(event.data?.sideEffects ?? "") === "write_external")
        .map((event) => String(event.message ?? ""))
        .filter((message) => message && !allowedWriteConnectorMessages.has(message));

  if (events.length > maxRetainedRunEvents) failures.push(`run retained ${events.length} events; expected <= ${maxRetainedRunEvents}`);
  if (modelCalls.length < (expectConfig.minModelCalls ?? 0)) {
    failures.push(`expected at least ${expectConfig.minModelCalls} model calls, saw ${modelCalls.length}`);
  }
  if (Number.isFinite(expectConfig.maxModelCalls) && modelCalls.length > expectConfig.maxModelCalls) {
    failures.push(`expected at most ${expectConfig.maxModelCalls} model calls, saw ${modelCalls.length}`);
  }
  if (checkpoints.length < (expectConfig.minCheckpoints ?? 0)) {
    failures.push(`expected at least ${expectConfig.minCheckpoints} checkpoints, saw ${checkpoints.length}`);
  }
  if (runtimeInputRequests < (expectConfig.minRuntimeInputs ?? 0)) {
    failures.push(`expected at least ${expectConfig.minRuntimeInputs} runtime input requests, saw ${runtimeInputRequests}`);
  }
  if (runtimeInputResponses < (expectConfig.minRuntimeInputResponses ?? 0)) {
    failures.push(`expected at least ${expectConfig.minRuntimeInputResponses} runtime input responses, saw ${runtimeInputResponses}`);
  }
  if (approvalRequests < (expectConfig.minApprovalRequests ?? 0)) {
    failures.push(`expected at least ${expectConfig.minApprovalRequests} approval requests, saw ${approvalRequests}`);
  }
  if (approvalResponses < (expectConfig.minApprovalResponses ?? 0)) {
    failures.push(`expected at least ${expectConfig.minApprovalResponses} approval responses, saw ${approvalResponses}`);
  }
  if (outputSignals < (expectConfig.minOutputSignals ?? 0)) {
    failures.push(`expected at least ${expectConfig.minOutputSignals} output/checkpoint/model signals, saw ${outputSignals}`);
  }
  if (documentRenderEnds.length < (expectConfig.minDocumentRenderEnds ?? 0)) {
    failures.push(`expected at least ${expectConfig.minDocumentRenderEnds} document render completion(s), saw ${documentRenderEnds.length}`);
  }
  if (recoveryEvents.length < (expectConfig.minRecoveryEvents ?? 0)) {
    failures.push(`expected at least ${expectConfig.minRecoveryEvents} recovery events, saw ${recoveryEvents.length}`);
  }
  if (skippedRecoveryEvents.length < (expectConfig.minRecoverySkippedItems ?? 0)) {
    failures.push(`expected at least ${expectConfig.minRecoverySkippedItems} skipped recovery item(s), saw ${skippedRecoveryEvents.length}`);
  }
  if (expectConfig.requireFinalOutput !== false && outputReadyEvents.length === 0) {
    failures.push("expected at least one workflow.output.ready event for final output inspection");
  }
  if (expectConfig.requireFinalOutput !== false && finalOutput.charCount < (expectConfig.minFinalOutputChars ?? 80)) {
    failures.push(`expected final output evidence with at least ${expectConfig.minFinalOutputChars ?? 80} chars, saw ${finalOutput.charCount}`);
  }
  if (failedModelCalls.length > 0 && expectConfig.allowFailedModelCalls !== true) {
    failures.push(`expected all retained model calls to succeed; saw ${failedModelCalls.length} failed/invalid call(s)`);
  }
  if (unintendedWriteTools.length > 0) {
    failures.push(`read-only UI dogfood observed unintended write-capable tool(s): ${[...new Set(unintendedWriteTools)].join(", ")}`);
  }
  if (unintendedWriteConnectors.length > 0) {
    failures.push(`read-only UI dogfood observed unintended write-capable connector(s): ${[...new Set(unintendedWriteConnectors)].join(", ")}`);
  }

  for (const required of expectConfig.requiredToolMessages ?? []) {
    if (!desktopToolEnds.includes(required)) failures.push(`expected desktop tool "${required}" to run; saw ${desktopToolEnds.join(", ") || "none"}`);
  }
  for (const requiredGroup of expectConfig.requiredAnyToolMessages ?? []) {
    const values = Array.isArray(requiredGroup) ? requiredGroup.map(String) : [String(requiredGroup)];
    if (!values.some((message) => desktopToolEnds.includes(message))) {
      failures.push(`expected one of desktop tools ${values.join(", ")} to run; saw ${desktopToolEnds.join(", ") || "none"}`);
    }
  }
  for (const preferred of expectConfig.preferredToolMessages ?? []) {
    if (!desktopToolEnds.includes(preferred)) failures.push(`expected preferred desktop tool "${preferred}" to run; saw ${desktopToolEnds.join(", ") || "none"}`);
  }
  for (const family of expectConfig.requiredToolFamilies ?? []) {
    if (!desktopToolEnds.some((message) => message.startsWith(family))) failures.push(`expected a "${family}" desktop tool family event; saw ${desktopToolEnds.join(", ") || "none"}`);
  }
  for (const forbidden of expectConfig.forbiddenToolMessages ?? []) {
    if (desktopToolEnds.includes(forbidden)) failures.push(`did not expect desktop tool "${forbidden}" in this scenario`);
  }
  for (const family of expectConfig.forbiddenToolFamilies ?? []) {
    if (desktopToolEnds.some((message) => message.startsWith(family))) failures.push(`did not expect a "${family}" desktop tool family event in this scenario`);
  }
  for (const [message, expectedCount] of Object.entries(expectConfig.exactToolMessageCounts ?? {})) {
    const actualCount = toolMessageCounts[message] ?? 0;
    if (actualCount !== expectedCount) {
      failures.push(`expected desktop tool "${message}" to run exactly ${expectedCount} time(s), saw ${actualCount}`);
    }
  }
  for (const [message, maxCount] of Object.entries(expectConfig.maxToolMessageCounts ?? {})) {
    const actualCount = toolMessageCounts[message] ?? 0;
    if (actualCount > maxCount) {
      failures.push(`expected desktop tool "${message}" to run at most ${maxCount} time(s), saw ${actualCount}`);
    }
  }
  if (connectorEnds.length < (expectConfig.minConnectorEnds ?? 0)) {
    failures.push(`expected at least ${expectConfig.minConnectorEnds} connector completion(s), saw ${connectorEnds.length}`);
  }
  if (Number.isFinite(expectConfig.maxConnectorEnds) && connectorEnds.length > expectConfig.maxConnectorEnds) {
    failures.push(`expected at most ${expectConfig.maxConnectorEnds} connector completion(s), saw ${connectorEnds.length}`);
  }
  for (const required of expectConfig.requiredConnectorMessages ?? []) {
    if (!connectorEnds.includes(required)) failures.push(`expected connector "${required}" to run; saw ${connectorEnds.join(", ") || "none"}`);
  }
  for (const preferred of expectConfig.preferredConnectorMessages ?? []) {
    if (!connectorEnds.includes(preferred)) failures.push(`expected preferred connector "${preferred}" to run; saw ${connectorEnds.join(", ") || "none"}`);
  }
  for (const family of expectConfig.requiredConnectorFamilies ?? []) {
    if (!connectorEnds.some((message) => message.startsWith(family))) failures.push(`expected a "${family}" connector family event; saw ${connectorEnds.join(", ") || "none"}`);
  }
  for (const forbidden of expectConfig.forbiddenConnectorMessages ?? []) {
    if (connectorEnds.includes(forbidden)) failures.push(`did not expect connector "${forbidden}" in this scenario`);
  }
  for (const family of expectConfig.forbiddenConnectorFamilies ?? []) {
    if (connectorEnds.some((message) => message.startsWith(family))) failures.push(`did not expect a "${family}" connector family event in this scenario`);
  }
  for (const [message, expectedCount] of Object.entries(expectConfig.exactConnectorMessageCounts ?? {})) {
    const actualCount = connectorMessageCounts[message] ?? 0;
    if (actualCount !== expectedCount) {
      failures.push(`expected connector "${message}" to run exactly ${expectedCount} time(s), saw ${actualCount}`);
    }
  }
  for (const [message, minCount] of Object.entries(expectConfig.minConnectorMessageCounts ?? {})) {
    const actualCount = connectorMessageCounts[message] ?? 0;
    if (actualCount < minCount) {
      failures.push(`expected connector "${message}" to run at least ${minCount} time(s), saw ${actualCount}`);
    }
  }
  for (const [message, maxCount] of Object.entries(expectConfig.maxConnectorMessageCounts ?? {})) {
    const actualCount = connectorMessageCounts[message] ?? 0;
    if (actualCount > maxCount) {
      failures.push(`expected connector "${message}" to run at most ${maxCount} time(s), saw ${actualCount}`);
    }
  }
  for (const contractId of expectConfig.requiredEvidenceContracts ?? []) {
    if (contractId === "gmail.metadata_search_only") {
      if (!connectorEnds.includes("google.gmail.search")) failures.push("expected Gmail metadata evidence contract to include google.gmail.search");
      const forbiddenGmailDetailOps = [
        "google.gmail.readThread",
        "google.gmail.readAttachment",
        "google.gmail.createDraft",
        "google.gmail.updateDraft",
        "google.gmail.deleteDraft",
        "google.gmail.sendDraft",
      ];
      const observedForbidden = forbiddenGmailDetailOps.filter((message) => connectorEnds.includes(message));
      if (observedForbidden.length > 0) failures.push(`Gmail metadata evidence contract observed forbidden detail/write connector(s): ${observedForbidden.join(", ")}`);
      const outputMentionsMetadataShape = /\b(metadata|id|ids|thread|threadid|threadids|snippet|headers?)\b/i.test(finalOutput.normalizedText);
      if (!outputMentionsMetadataShape) failures.push("Gmail metadata evidence contract expected final output to describe metadata shape or identifiers");
    } else if (contractId === "read_only.no_writes") {
      const writeLikeConnectorEnds = connectorEnds.filter((message) => /\.(?:create|update|delete|send|share|write|modify|label|draft)/i.test(message));
      if (unintendedWriteTools.length > 0) {
        failures.push(`read-only evidence contract observed write-capable desktop tool(s): ${[...new Set(unintendedWriteTools)].join(", ")}`);
      }
      if (unintendedWriteConnectors.length > 0 || writeLikeConnectorEnds.length > 0) {
        failures.push(
          `read-only evidence contract observed write-capable connector(s): ${[...new Set([...unintendedWriteConnectors, ...writeLikeConnectorEnds])].join(", ")}`,
        );
      }
    } else {
      failures.push(`unknown required evidence contract ${contractId}`);
    }
  }
  for (const format of expectConfig.requiredDocumentRenderFormats ?? []) {
    if (!documentRenderEnds.some((event) => String(event.data?.format ?? "").toLowerCase() === String(format).toLowerCase())) {
      const seen = documentRenderEnds.map((event) => String(event.data?.format ?? "unknown")).join(", ") || "none";
      failures.push(`expected document render format "${format}", saw ${seen}`);
    }
  }
  for (const action of expectConfig.requiredRecoveryActions ?? []) {
    if (!recoveryActionCounts[action]) failures.push(`expected recovery action "${action}" to run; saw ${Object.keys(recoveryActionCounts).join(", ") || "none"}`);
  }
  for (const itemKey of expectConfig.requiredSkippedItemKeys ?? []) {
    if (!skippedRecoveryEvents.some((event) => String(event.itemKey ?? event.data?.itemKey ?? event.message ?? "").includes(String(itemKey)))) {
      failures.push(`expected skipped recovery item "${itemKey}"`);
    }
  }
  const finalOutputFailureStart = failures.length;
  for (const term of expectConfig.requiredFinalOutputTerms ?? []) {
    if (!finalOutput.normalizedText.includes(String(term).toLowerCase())) failures.push(`expected final output to include "${term}"`);
  }
  for (const terms of expectConfig.requiredFinalOutputAnyTerms ?? []) {
    const values = Array.isArray(terms) ? terms : [terms];
    if (!values.some((term) => finalOutput.normalizedText.includes(String(term).toLowerCase()))) {
      failures.push(`expected final output to include one of: ${values.join(", ")}`);
    }
  }
  if (failures.length > finalOutputFailureStart) {
    failures.push(
      `final output evidence: ${finalOutput.charCount} chars from ${finalOutput.sources.join(", ") || "no sources"}; preview: ${
        finalOutput.text.slice(0, 500) || "(empty)"
      }`,
    );
  }

  if (failures.length) throw new Error(`Scenario evidence assertions failed for ${scenarioName}:\n- ${failures.join("\n- ")}`);
  return {
    passed: true,
    desktopToolEnds,
    toolMessageCounts,
    connectorEnds,
    connectorMessageCounts,
    documentRenderEnds: documentRenderEnds.map((event) => ({
      message: event.message,
      format: event.data?.format,
      path: event.data?.path,
      bytes: event.data?.bytes,
    })),
    eventCount: events.length,
    modelCalls: modelCalls.length,
    checkpoints: checkpoints.length,
    runtimeInputRequests,
    runtimeInputResponses,
    approvalRequests,
    approvalResponses,
    outputSignals,
    recoveryEvents: recoveryEvents.length,
    recoveryActionCounts,
    skippedRecoveryItems: skippedRecoveryEvents.map((event) => String(event.itemKey ?? event.data?.itemKey ?? event.message ?? "")).filter(Boolean),
    finalOutput: {
      charCount: finalOutput.charCount,
      signalCount: outputReadyEvents.length,
      formats: finalOutput.formats,
      sources: finalOutput.sources,
    },
  };
}

export function desktopToolEndMessages(detail) {
  return (detail.events ?? [])
    .filter((event) => event.type === "desktop-tool.end")
    .map((event) => String(event.message ?? ""))
    .filter(Boolean);
}

export function connectorEndMessages(detail) {
  return (detail.events ?? [])
    .filter((event) => event.type === "connector.end")
    .map((event) => String(event.message ?? ""))
    .filter(Boolean);
}

export function documentRenderEndEvents(detail) {
  return (detail.events ?? []).filter((event) => event.type === "document.render.end");
}

export function outputSignalCount(detail) {
  return (detail.events ?? []).filter((event) => OUTPUT_EVENT_PATTERN.test(`${event.type} ${event.message ?? ""}`)).length;
}

function collectFinalOutputEvidence(detail) {
  const texts = [];
  const formats = new Set();
  const sources = [];
  for (const event of detail.events ?? []) {
    if (event.type !== "workflow.output.ready") continue;
    const evidence = outputTextFromValue(event.data);
    if (evidence.text) texts.push(evidence.text);
    for (const format of evidence.formats) formats.add(format);
    sources.push(`event:${event.id ?? event.seq ?? "output"}`);
  }
  for (const checkpoint of detail.checkpoints ?? []) {
    if (!/final[-_]output|output|report|html|markdown|summary/i.test(checkpoint.key)) continue;
    const evidence = outputTextFromValue(checkpoint.valuePreview);
    if (evidence.text) texts.push(evidence.text);
    for (const format of evidence.formats) formats.add(format);
    sources.push(`checkpoint:${checkpoint.key}`);
  }
  const text = texts.join("\n\n").trim();
  return {
    text,
    normalizedText: text.toLowerCase(),
    charCount: text.length,
    formats: [...formats].sort(),
    sources: [...new Set(sources)].slice(0, 8),
  };
}

function outputTextFromValue(value) {
  const parsed = typeof value === "string" ? parseJsonIfPossible(value) : value;
  const formats = new Set();
  const texts = [];
  collectOutputText(parsed, texts, formats, 0);
  return { text: texts.join("\n").trim(), formats: [...formats] };
}

function collectOutputText(value, texts, formats, depth) {
  if (value === undefined || value === null || depth > 5) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (looksLikeHtml(trimmed)) formats.add("html");
    else if (looksLikeMarkdown(trimmed)) formats.add("markdown");
    else formats.add("text");
    texts.push(trimmed);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    texts.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 12)) collectOutputText(item, texts, formats, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const record = value;
  const preferredKeys = ["html", "markdown", "report", "summary", "outputSummary", "text", "content", "result", "output", "definition", "examples"];
  const beforePreferredTextCount = texts.length;
  for (const key of preferredKeys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) collectOutputText(record[key], texts, formats, depth + 1);
  }
  if (texts.length > beforePreferredTextCount && depth > 0) return;
  for (const [key, nested] of Object.entries(record).slice(0, 16)) {
    if (/raw|base64|image|screenshot/i.test(key)) continue;
    texts.push(readableOutputKey(key));
    collectOutputText(nested, texts, formats, depth + 1);
  }
}

function readableOutputKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
}

function parseJsonIfPossible(value) {
  const trimmed = value.trim();
  if (!trimmed || !/^[{["]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function looksLikeHtml(value) {
  return /^\s*<!doctype html/i.test(value) || /^\s*<html[\s>]/i.test(value) || /<\/(?:div|section|article|p|h[1-6]|table|ul|ol|li|span|strong|em|b)>/i.test(value);
}

function looksLikeMarkdown(value) {
  return /^\s{0,3}#/m.test(value) || /^\s*[-*]\s+/m.test(value) || /\n\n/.test(value);
}
