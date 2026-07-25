import { Activity, Brain, ChevronDown, Download, KeyRound, Play, RefreshCw, RotateCw, ShieldAlert, ShieldCheck, Square, Trash2, Wrench, Zap } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { AgentMemoryEmbeddingLifecycleActionKind, AgentMemoryEmbeddingLifecycleActionResult, AgentMemoryOperationStatus, AgentMemoryStorageDiagnostics } from "../../shared/agentMemoryDiagnostics";
import { AGENT_MEMORY_PRIVACY_DISCLOSURE_LINES } from "../../shared/agentMemoryPrivacy";
import type { AgentMemoryMode } from "../../shared/agentMemorySettings";
import { agentMemoryStarterPrimaryAction } from "../../shared/agentMemoryStarter";
import type { AgentMemoryStarterNextAction, AgentMemoryStarterOperationKind, AgentMemoryStarterOperationResult, AgentMemoryStarterStatus } from "../../shared/agentMemoryStarter";
import { ambientModelLabel } from "../../shared/ambientModels";
import type { DesktopState, ThinkingDisplayMode } from "../../shared/desktopTypes";
import type { NamedSecretKind, NamedSecretScope } from "../../shared/namedSecretTypes";
import type { ContextUsageSnapshot, ThinkingLevel } from "../../shared/threadTypes";
import type { ModelProviderCredentialSaveDraftModel, ModelProviderEndpointInstallDraft } from "./modelProviderOnboardingUiModel";
import type { ModelRuntimeCatalogSettingsModel } from "./modelRuntimeCatalogUiModel";
import { modelReasoningControlModel, type ModelReasoningControlModel } from "./modelReasoningUiModel";
import {
  MODEL_RUNTIME_PROVIDER_TIMEOUT_OPTIONS_MS,
  ModelRuntimeCatalogDiagnostics,
  SubagentMaturityDiagnostics,
  formatDurationMs,
  formatMemoryBytes,
  formatTimelineTime,
} from "./RightPanelSettingsRuntime";
import type { ApiKeyStatus } from "./RightPanelSettingsRuntime";
import { SettingsRow, SettingsSection } from "./RightPanelSettingsPrimitives";
import { thinkingDisplayModeLabel } from "./thinkingDisplayUiModel";

type SettingsRowVisible = (sectionId: string, rowId: string) => boolean;
type MaybePromise<T = unknown> = T | Promise<T>;

const thinkingDisplayOptions: ThinkingDisplayMode[] = ["off", "transient", "full"];
const agentMemoryModeOptions: AgentMemoryMode[] = ["enabled_all", "per_thread", "disabled"];
const namedSecretKinds: NamedSecretKind[] = ["generic", "api-key", "token", "password", "login", "ssh-password"];
const namedSecretScopes: NamedSecretScope[] = ["workspace", "global"];

function secureStorageStatusForState(state: DesktopState): DesktopState["secureStorage"] {
  return state.secureStorage ?? {
    status: "blocked",
    platform: "other",
    reason: "unavailable",
    message: "Secure credential storage status has not loaded yet.",
  };
}

function namedSecretsForState(state: DesktopState): DesktopState["namedSecrets"] {
  return state.namedSecrets ?? [];
}

function contextUsagePresentation(snapshot: ContextUsageSnapshot | undefined, settings: DesktopState["settings"]["compaction"]) {
  if (!snapshot) {
    return {
      tone: "unknown",
      label: "Context ?",
      percent: undefined,
      title: "Context usage has not been reported for this thread yet.",
    };
  }
  if (snapshot.source === "unknown-after-compaction") {
    return {
      tone: "unknown",
      label: "Context ?",
      percent: undefined,
      title: "Compaction completed. Ambient will know the refreshed context size after the next response.",
    };
  }
  if (snapshot.source === "unavailable" || snapshot.percent === undefined) {
    return {
      tone: "unknown",
      label: "Context ?",
      percent: undefined,
      title: snapshot.diagnostics?.message ?? "Context usage is not available for this thread.",
    };
  }
  const rounded = Math.max(0, Math.round(snapshot.percent));
  const tone = rounded >= settings.hardPreflightPercent ? "danger" : rounded >= settings.softWarningPercent ? "warning" : "ok";
  const tokens = snapshot.tokens !== undefined ? `${snapshot.tokens.toLocaleString()} tokens` : "token count unavailable";
  const contextWindow = snapshot.contextWindow !== undefined ? `${snapshot.contextWindow.toLocaleString()} window` : "window unavailable";
  return {
    tone,
    label: `Context ${rounded}%`,
    percent: snapshot.percent,
    title: `${tokens} of ${contextWindow}. Source: ${snapshot.source}. Compactions: ${snapshot.compactionCount}.`,
  };
}
function SegmentedThinkingDisplay({
  value,
  onChange,
}: {
  value: ThinkingDisplayMode;
  onChange: (value: ThinkingDisplayMode) => void;
}) {
  return (
    <div className="permission-toggle thinking-display-toggle">
      {thinkingDisplayOptions.map((option) => (
        <button type="button" key={option} className={value === option ? "selected" : ""} onClick={() => onChange(option)}>
          <Brain size={14} />
          {thinkingDisplayModeLabel(option)}
        </button>
      ))}
    </div>
  );
}

function SegmentedModelReasoning({
  model,
  onChange,
}: {
  model: Extract<ModelReasoningControlModel, { kind: "selectable" }>;
  onChange: (value: ThinkingLevel) => void;
}) {
  return (
    <div className="permission-toggle model-reasoning-toggle">
      {model.options.map((option) => (
        <button type="button" key={option.value} className={model.value === option.value ? "selected" : ""} onClick={() => onChange(option.value)}>
          <Brain size={14} />
          {option.label}
        </button>
      ))}
    </div>
  );
}


function NamedSecretVault({ state }: { state: DesktopState }) {
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [kind, setKind] = useState<NamedSecretKind>("generic");
  const [scope, setScope] = useState<NamedSecretScope>("workspace");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const secureStorage = secureStorageStatusForState(state);
  const namedSecrets = namedSecretsForState(state);
  const storageReady = secureStorage.status === "ready";

  async function save() {
    setBusy("save");
    setStatus(undefined);
    try {
      await window.ambientDesktop.saveNamedSecret({
        label,
        value,
        kind,
        scope,
        ...(notes.trim() ? { notes } : {}),
      });
      setLabel("");
      setValue("");
      setNotes("");
      setStatus("Saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Save failed");
    } finally {
      setBusy(undefined);
    }
  }

  async function remove(id: string) {
    setBusy(id);
    setStatus(undefined);
    try {
      await window.ambientDesktop.deleteNamedSecret({ id });
      setStatus("Deleted");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Delete failed");
    } finally {
      setBusy(undefined);
    }
  }

  async function broker(id: string) {
    setBusy(`broker:${id}`);
    setStatus(undefined);
    try {
      const result = await window.ambientDesktop.brokerNamedSecretToLocalFixture({
        id,
        target: "local-fixture",
        purpose: "settings local fixture verification",
      });
      setStatus(result.delivered ? "Fixture delivered" : "Fixture not delivered");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Fixture failed");
    } finally {
      setBusy(undefined);
    }
  }

  async function exportMetadata() {
    setBusy("export");
    setStatus(undefined);
    try {
      const exported = await window.ambientDesktop.exportNamedSecretMetadata();
      setStatus(`${exported.secrets.length.toLocaleString()} rehydration task${exported.secrets.length === 1 ? "" : "s"}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Export failed");
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className={`voice-provider-diagnostics ${storageReady ? "info" : "warning"}`}>
      <div className="voice-provider-diagnostics-header">
        <strong>Named secrets</strong>
        <span>{namedSecrets.length.toLocaleString()}</span>
      </div>
      <div className="named-secret-form">
        <label className="setting-field">
          <span>Label</span>
          <input className="panel-input" value={label} onChange={(event) => setLabel(event.target.value)} disabled={!storageReady || Boolean(busy)} />
        </label>
        <label className="setting-field">
          <span>Value</span>
          <input
            className="panel-input"
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            disabled={!storageReady || Boolean(busy)}
          />
        </label>
        <div className="named-secret-grid">
          <label className="setting-field">
            <span>Kind</span>
            <select className="settings-select compact" value={kind} onChange={(event) => setKind(event.target.value as NamedSecretKind)} disabled={!storageReady || Boolean(busy)}>
              {namedSecretKinds.map((option) => (
                <option key={option} value={option}>{namedSecretKindLabel(option)}</option>
              ))}
            </select>
          </label>
          <label className="setting-field">
            <span>Scope</span>
            <select className="settings-select compact" value={scope} onChange={(event) => setScope(event.target.value as NamedSecretScope)} disabled={!storageReady || Boolean(busy)}>
              {namedSecretScopes.map((option) => (
                <option key={option} value={option}>{option === "global" ? "Global" : "Workspace"}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="setting-field">
          <span>Notes</span>
          <input className="panel-input" value={notes} onChange={(event) => setNotes(event.target.value)} disabled={!storageReady || Boolean(busy)} />
        </label>
        <div className="panel-action-row compact">
          <button type="button" className="panel-button mini primary" disabled={!storageReady || !label.trim() || value.length === 0 || Boolean(busy)} onClick={() => void save()}>
            <KeyRound size={14} />
            {busy === "save" ? "Saving" : "Save"}
          </button>
          <button type="button" className="panel-button mini" disabled={Boolean(busy)} onClick={() => void exportMetadata()}>
            <Download size={14} />
            Metadata
          </button>
        </div>
      </div>
      {namedSecrets.length > 0 && (
        <ul className="named-secret-list">
          {namedSecrets.map((secret) => (
            <li key={secret.id}>
              <div>
                <strong>{secret.label}</strong>
                <small>{namedSecretKindLabel(secret.kind)} · {secret.scope} · {formatTimelineTime(secret.updatedAt)}</small>
              </div>
              <div className="panel-action-row compact">
                <button type="button" className="panel-button mini" disabled={Boolean(busy)} onClick={() => void broker(secret.id)}>
                  <ShieldCheck size={14} />
                  {busy === `broker:${secret.id}` ? "Sending" : "Fixture"}
                </button>
                <button type="button" className="panel-button mini danger" disabled={Boolean(busy)} onClick={() => void remove(secret.id)}>
                  <Trash2 size={14} />
                  {busy === secret.id ? "Deleting" : "Delete"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {status && <p className={`panel-status ${/failed|blocked|unavailable|required|not found/i.test(status) ? "error" : "success"}`}>{status}</p>}
      {!storageReady && (
        <small>
          <ShieldAlert size={13} /> {secureStorage.message}
        </small>
      )}
    </div>
  );
}

function namedSecretKindLabel(kind: NamedSecretKind): string {
  if (kind === "api-key") return "API key";
  if (kind === "ssh-password") return "SSH password";
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}


export type RightPanelModelModeSettingsSectionProps = {
  state: DesktopState;
  settingsRowVisible: SettingsRowVisible;
  modelCatalogSettings: ModelRuntimeCatalogSettingsModel;
  modelProviderInstallDraft: ModelProviderEndpointInstallDraft;
  modelProviderCredentialValue: string;
  modelProviderCredentialSave: ModelProviderCredentialSaveDraftModel;
  modelProviderCredentialBusy: boolean;
  modelProviderCredentialStatus?: ApiKeyStatus;
  modelProviderInstallBusy: boolean;
  modelProviderInstallStatus?: ApiKeyStatus;
  subagentsFlagValue: string;
  subagentsFlagDescription: string;
  persistentSubagentsEnabled: boolean;
  slashCommandsFlagValue: string;
  slashCommandsFlagDescription: string;
  persistentSlashCommandsEnabled: boolean;
  memoryFlagValue: string;
  memoryFlagDescription: string;
  persistentMemoryFeatureEnabled: boolean;
  activeThreadMemoryEnabled: boolean;
  activeThreadMemoryToggleDisabled: boolean;
  agentMemoryDiagnostics?: AgentMemoryStorageDiagnostics;
  agentMemoryDiagnosticsLoading: boolean;
  agentMemoryDiagnosticsError?: string;
  agentMemoryEmbeddingActionLoading?: AgentMemoryEmbeddingLifecycleActionKind;
  agentMemoryEmbeddingActionResult?: AgentMemoryEmbeddingLifecycleActionResult;
  agentMemoryEmbeddingActionError?: string;
  agentMemoryStarterStatus?: AgentMemoryStarterStatus;
  agentMemoryStarterLoading: boolean;
  agentMemoryStarterError?: string;
  agentMemoryStarterOperationLoading?: AgentMemoryStarterOperationKind;
  agentMemoryStarterOperationResult?: AgentMemoryStarterOperationResult;
  agentMemoryClearConfirming: boolean;
  agentMemoryClearLoading: boolean;
  agentMemoryClearStatus?: { kind: "success" | "error"; message: string };
  subagentMaturity: DesktopState["subagentMaturity"];
  subagentMaturityEvidence: DesktopState["subagentMaturityEvidence"];
  setModelProviderInstallDraft: (draft: ModelProviderEndpointInstallDraft) => void;
  setModelProviderCredentialValue: (value: string) => void;
  saveModelProviderCredentialFromSettings: () => MaybePromise;
  installModelProviderEndpointFromSettings: () => MaybePromise;
  loadAgentMemoryStarterStatus: () => MaybePromise;
  enableAgentMemoryStarterFromSettings: (targetMode?: AgentMemoryMode) => MaybePromise;
  repairAgentMemoryStarterFromSettings: () => MaybePromise;
  disableAgentMemoryStarterFromSettings: () => MaybePromise;
  requestAgentMemoryClearFromSettings: () => MaybePromise;
  cancelAgentMemoryClearFromSettings: () => MaybePromise;
  confirmAgentMemoryClearFromSettings: () => MaybePromise;
  onThinkingDisplaySettingsChange: (thinkingDisplay: DesktopState["settings"]["thinkingDisplay"]) => void;
  onThinkingLevelChange: (thinkingLevel: ThinkingLevel) => void;
  onFeatureFlagSettingsChange: (featureFlags: DesktopState["settings"]["featureFlags"]) => void;
  onMemorySettingsChange: (memory: DesktopState["settings"]["memory"]) => void;
  onActiveThreadMemoryEnabledChange: (enabled: boolean) => void;
  onRefreshAgentMemoryDiagnostics: () => MaybePromise;
  onRunAgentMemoryEmbeddingLifecycleAction: (action: AgentMemoryEmbeddingLifecycleActionKind) => void;
  onModelRuntimeSettingsChange: (modelRuntime: DesktopState["settings"]["modelRuntime"]) => void;
  onPlannerSettingsChange: (planner: DesktopState["settings"]["planner"]) => void;
};

function AgentMemoryDiagnosticsSummary({ diagnostics }: { diagnostics: AgentMemoryStorageDiagnostics }) {
  const latestRecall = latestAgentMemoryOperation(diagnostics, "lastRecall");
  const latestCapture = latestAgentMemoryOperation(diagnostics, "lastCapture");
  const latestSearch = latestAgentMemoryOperation(diagnostics, "lastSearch");
  const native = diagnostics.nativePreflight;
  const tone = diagnostics.status === "healthy"
    ? "success"
    : diagnostics.status === "error"
      ? "error"
      : diagnostics.status === "needs_attention"
        ? "warning"
        : "info";
  return (
    <div className={`voice-provider-diagnostics ${tone}`}>
      <div className="voice-provider-diagnostics-header">
        <strong>{agentMemoryStatusLabel(diagnostics.status)}</strong>
        <span>{formatTimelineTime(diagnostics.checkedAt)}</span>
      </div>
      <small>{diagnostics.message}</small>
      <ul>
        <li>Storage: {diagnostics.dataDirExists ? `${diagnostics.fileCount.toLocaleString()} files, ${formatMemoryBytes(diagnostics.totalBytes)}` : "not created"} · {diagnostics.dataDir}</li>
        <li>Storage schema: {diagnostics.storageSchemaStatus}{diagnostics.storageSchemaVersion ? ` · ${diagnostics.storageSchemaVersion}` : ""}</li>
        <li>Threads: {diagnostics.activeThreadCount.toLocaleString()} active, {diagnostics.threadEnabledCount.toLocaleString()} enabled by thread toggle</li>
        <li>Settings: feature {diagnostics.featureEnabled ? "on" : "off"}, global {diagnostics.settingsEnabled ? "on" : "off"}, new-thread default {diagnostics.defaultThreadEnabled ? "on" : "off"}</li>
        <li>Embeddings: {diagnostics.embedding.status}{diagnostics.embedding.modelId ? ` · ${diagnostics.embedding.modelId}` : ""}{diagnostics.embedding.modelProfileId ? ` · ${diagnostics.embedding.modelProfileId}` : ""}{diagnostics.embedding.dimensions ? ` · ${diagnostics.embedding.dimensions} dims` : ""}</li>
        <li>Runtime snapshots: {diagnostics.runtimeSnapshots.length.toLocaleString()} · recall {operationStatusLabel(latestRecall)} · capture {operationStatusLabel(latestCapture)} · search {operationStatusLabel(latestSearch)}</li>
        <li>Native preflight: {native ? `${native.status} · ${native.message}` : "not checked"}</li>
        <li>Raw memory content: {diagnostics.rawContentIncluded ? "included" : "not included"}</li>
      </ul>
    </div>
  );
}

function AgentMemoryPolicyDiagnostics({
  memoryMode,
  memoryFlagValue,
  persistentMemoryFeatureEnabled,
  activeThreadMemoryEnabled,
  activeThreadMemoryToggleDisabled,
  defaultThreadEnabled,
  managedEmbeddingsEnabled,
  managedEmbeddingsAutoStart,
}: {
  memoryMode: AgentMemoryMode;
  memoryFlagValue: string;
  persistentMemoryFeatureEnabled: boolean;
  activeThreadMemoryEnabled: boolean;
  activeThreadMemoryToggleDisabled: boolean;
  defaultThreadEnabled: boolean;
  managedEmbeddingsEnabled: boolean;
  managedEmbeddingsAutoStart: boolean;
}) {
  return (
    <div className="voice-provider-diagnostics info">
      <div className="voice-provider-diagnostics-header">
        <strong>Memory policy diagnostics</strong>
        <span>{agentMemoryModeLabel(memoryMode)}</span>
      </div>
      <ul>
        <li>Feature gate: {persistentMemoryFeatureEnabled ? "on" : "off"} · {memoryFlagValue}</li>
        <li>Derived global setting: {memoryMode === "disabled" ? "off" : "on"}</li>
        <li>Derived new-thread default: {defaultThreadEnabled ? "on" : "off"}</li>
        <li>Active thread flag: {activeThreadMemoryToggleDisabled ? "unavailable" : activeThreadMemoryEnabled ? "on" : "off"}</li>
        <li>Managed embeddings: {managedEmbeddingsEnabled ? "on" : "off"} · auto-start {managedEmbeddingsAutoStart ? "on" : "off"}</li>
      </ul>
    </div>
  );
}

function AgentMemoryStarterCard({
  status,
  loading,
  error,
  operationLoading,
  operationResult,
  memoryMode,
  actionsDisabled,
  onModeChange,
  onRefresh,
  onEnable,
  onRepair,
  onDisable,
}: {
  status?: AgentMemoryStarterStatus;
  loading: boolean;
  error?: string;
  operationLoading?: AgentMemoryStarterOperationKind;
  operationResult?: AgentMemoryStarterOperationResult;
  memoryMode: AgentMemoryMode;
  actionsDisabled: boolean;
  onModeChange: (mode: AgentMemoryMode) => MaybePromise;
  onRefresh: () => MaybePromise;
  onEnable: () => MaybePromise;
  onRepair: () => MaybePromise;
  onDisable: () => MaybePromise;
}) {
  const busy = loading || Boolean(operationLoading);
  const tone = error
    ? "error"
    : status?.state === "ready"
      ? "success"
      : status?.state === "needs_repair" || status?.state === "setup_required"
        ? "warning"
        : "info";
  const setupAction = agentMemoryStarterSetupAction(status);
  const setupOperation = agentMemoryStarterOperationForAction(setupAction);
  const setupActionBusy = Boolean(setupOperation && operationLoading === setupOperation);
  const setupButtonLabel = setupActionBusy ? "Working" : agentMemoryStarterRepairButtonLabel(status, setupAction);
  const operationLogPreview = operationResult ? agentMemoryStarterOperationLogPreview(operationResult) : [];
  const repairDisabled = actionsDisabled || busy || !agentMemoryStarterCanRepair(status, setupAction);
  return (
    <div className={`voice-provider-diagnostics ${tone}`}>
      <div className="voice-provider-diagnostics-header">
        <strong>Agent Memory</strong>
        <span>{loading ? "Checking" : agentMemoryStarterStateLabel(status?.state)}</span>
      </div>
      <label className="setting-field">
        <span>Memory mode</span>
        <select
          className="settings-select compact agent-memory-mode-select"
          value={memoryMode}
          disabled={busy}
          aria-label="Agent Memory mode"
          onChange={(event) => {
            const nextMode = event.target.value as AgentMemoryMode;
            if (actionsDisabled && nextMode !== "disabled") return;
            void onModeChange(nextMode);
          }}
        >
          {agentMemoryModeOptions.map((mode) => (
            <option key={mode} value={mode} disabled={actionsDisabled && mode !== "disabled"}>{agentMemoryModeLabel(mode)}</option>
          ))}
        </select>
      </label>
      <small>{agentMemoryStarterMessage(status, error)}</small>
      {status && (
        <ul>
          <li>Policy: {agentMemoryModeLabel(status.settings.memory.mode)}</li>
          <li>Health: {agentMemoryStarterStateLabel(status.state)}</li>
          <li>Thread scope: {agentMemoryThreadScopeLabel(status)}</li>
          {status.blockers[0] && <li>Blocker: {status.blockers[0].message}</li>}
          {status.nextActions[0] && <li>Next: {agentMemoryStarterActionLabel(status.nextActions[0])}</li>}
        </ul>
      )}
      <div className="panel-action-row compact">
        <button type="button" className="panel-button mini" disabled={busy} aria-label="Refresh Agent Memory starter status" onClick={() => void onRefresh()}>
          <RefreshCw size={14} />
          {loading ? "Refreshing" : "Refresh"}
        </button>
        <button
          type="button"
          className="panel-button mini"
          disabled={repairDisabled}
          aria-label="Repair Agent Memory health"
          onClick={() => void runAgentMemoryStarterAction(setupAction, { onEnable, onRepair, onDisable })}
        >
          {setupActionBusy ? <RefreshCw size={14} /> : agentMemoryStarterActionIcon(setupAction)}
          {setupButtonLabel}
        </button>
      </div>
      {operationResult && (
        <div className="agent-memory-starter-operation-log" aria-label="Agent Memory operation log">
          <small>
            Last {agentMemoryStarterOperationLabel(operationResult.operation).toLowerCase()}: {agentMemoryStarterStateLabel(operationResult.status.state)} · {formatTimelineTime(operationResult.completedAt)}
          </small>
          {operationLogPreview.length > 0 && (
            <ul>
              {operationLogPreview.map((entry) => (
                <li key={`${entry.at}:${entry.step}:${entry.status}`}>
                  <span>{entry.step}</span>: {agentMemoryStarterOperationLogStatusLabel(entry.status)} - {entry.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function agentMemoryStarterSetupAction(status?: AgentMemoryStarterStatus): AgentMemoryStarterNextAction | undefined {
  if (!status) return undefined;
  return agentMemoryStarterPrimaryAction(status) ??
    (status.state === "needs_repair" && status.nextActions.includes("disable") ? "disable" : undefined);
}

export function agentMemoryStarterOperationForAction(action?: AgentMemoryStarterNextAction): AgentMemoryStarterOperationKind | undefined {
  if (action === "enable") return "enable";
  if (action === "disable") return "disable";
  if (action === "install" || action === "repair" || action === "start" || action === "retry_preflight") return "repair";
  return undefined;
}

function runAgentMemoryStarterAction(
  action: AgentMemoryStarterNextAction | undefined,
  handlers: {
    onEnable: () => MaybePromise;
    onRepair: () => MaybePromise;
    onDisable: () => MaybePromise;
  },
): MaybePromise | undefined {
  const operation = agentMemoryStarterOperationForAction(action);
  if (operation === "enable") return handlers.onEnable();
  if (operation === "disable") return handlers.onDisable();
  if (operation === "repair") return handlers.onRepair();
  return undefined;
}

function agentMemoryStarterActionIcon(action?: AgentMemoryStarterNextAction): ReactNode {
  if (action === "start") return <Play size={14} />;
  if (action === "disable") return <Square size={14} />;
  if (action === "enable") return <Zap size={14} />;
  return <Wrench size={14} />;
}

export function agentMemoryStarterSetupActionLabel(action?: AgentMemoryStarterNextAction): string {
  if (action === "enable") return "Enable";
  if (action === "disable") return "Disable";
  if (action === "install") return "Install";
  if (action === "start") return "Start";
  if (action === "retry_preflight") return "Retry";
  return "Repair";
}

export function agentMemoryModeLabel(mode: AgentMemoryMode): string {
  if (mode === "enabled_all") return "Enabled globally";
  if (mode === "per_thread") return "Available per thread";
  return "Disabled";
}

function agentMemoryThreadScopeLabel(status: AgentMemoryStarterStatus): string {
  if (status.settings.memory.mode === "enabled_all") return "all threads";
  if (status.settings.memory.mode === "disabled") return "no threads";
  return status.threadScope.activeThreadMemoryEnabled ? "this thread on" : "this thread off";
}

function agentMemoryStarterCanRepair(
  status: AgentMemoryStarterStatus | undefined,
  action: AgentMemoryStarterNextAction | undefined,
): boolean {
  if (!status || status.state === "ready" || status.state === "off") return false;
  return Boolean(action && action !== "clear_memory" && action !== "open_logs");
}

function agentMemoryStarterRepairButtonLabel(
  status: AgentMemoryStarterStatus | undefined,
  action: AgentMemoryStarterNextAction | undefined,
): string {
  if (!status || !agentMemoryStarterCanRepair(status, action)) return "Repair";
  if (action === "start") return "Start";
  if (action === "install") return "Repair";
  if (action === "retry_preflight") return "Repair";
  if (action === "disable") return "Repair";
  if (action === "enable") return "Repair";
  return agentMemoryStarterSetupActionLabel(action);
}

function AgentMemoryEmbeddingHealthCard({
  diagnostics,
  embeddingsEnabled,
  actionLoading,
  actionResult,
  actionError,
  onAction,
  showControls = true,
}: {
  diagnostics?: AgentMemoryStorageDiagnostics;
  embeddingsEnabled: boolean;
  actionLoading?: AgentMemoryEmbeddingLifecycleActionKind;
  actionResult?: AgentMemoryEmbeddingLifecycleActionResult;
  actionError?: string;
  onAction: (action: AgentMemoryEmbeddingLifecycleActionKind) => void;
  showControls?: boolean;
}) {
  const embedding = diagnostics?.embedding;
  const running = embedding?.running === true;
  const tone = embedding?.status === "ready"
    ? "success"
    : embedding?.status === "error"
      ? "error"
      : embedding?.status === "unavailable" || embedding?.status === "keyword_fallback"
        ? "warning"
        : "info";
  const busy = Boolean(actionLoading);
  return (
    <div className={`voice-provider-diagnostics ${tone}`}>
      <div className="voice-provider-diagnostics-header">
        <strong>Embeddings endpoint</strong>
        <span>{agentMemoryEmbeddingStatusLabel(embedding?.status)}</span>
      </div>
      <small>{embedding?.message ?? "No embedding endpoint diagnostics have been loaded yet."}</small>
      <ul>
        <li>Endpoint: {embedding?.endpoint ?? "not running"}</li>
        <li>Provider: {embedding?.packageName ?? embedding?.providerId ?? "Ambient managed"}{embedding?.providerCapabilityId ? ` · ${embedding.providerCapabilityId}` : ""}</li>
        <li>Model: {embedding?.modelId ?? "unknown"}{embedding?.modelProfileId ? ` · ${embedding.modelProfileId}` : ""}{embedding?.dimensions ? ` · ${embedding.dimensions} dims` : ""}</li>
        <li>Runtime: {embedding?.runtimeStatus ?? "unknown"}{embedding?.runtimeId ? ` · ${embedding.runtimeId}` : ""} · {running ? "running" : "stopped"}</li>
        <li>Preflight: {embedding?.preflightEnabled ? "on" : "off"} · timeout {embedding?.timeoutMs ? formatDurationMs(embedding.timeoutMs) : "unknown"} · reindex {embedding?.reindexStatus ?? "unknown"}</li>
        {embedding?.lastError && <li>Error: {embedding.lastError}</li>}
        {embedding?.missingHints?.length ? <li>Missing: {embedding.missingHints[0]}</li> : null}
      </ul>
      {showControls && (
        <div className="panel-action-row compact">
          <EmbeddingLifecycleButton action="check" icon={<Activity size={14} />} label="Check" disabled={!embeddingsEnabled || busy} loading={actionLoading} onAction={onAction} />
          <EmbeddingLifecycleButton action="start" icon={<Play size={14} />} label="Start" disabled={!embeddingsEnabled || busy || running} loading={actionLoading} onAction={onAction} />
          <EmbeddingLifecycleButton action="restart" icon={<RotateCw size={14} />} label="Restart" disabled={!embeddingsEnabled || busy} loading={actionLoading} onAction={onAction} />
          <EmbeddingLifecycleButton action="stop" icon={<Square size={14} />} label="Stop" disabled={busy || !running} loading={actionLoading} onAction={onAction} />
        </div>
      )}
      {actionResult && (
        <small>
          Last {embeddingLifecycleActionLabel(actionResult.action).toLowerCase()}: {actionResult.status} · {actionResult.message} · {formatTimelineTime(actionResult.checkedAt)}
        </small>
      )}
      {actionError && <p className="panel-status error">{actionError}</p>}
      {!embeddingsEnabled && <small>Managed embeddings are disabled.</small>}
    </div>
  );
}

function EmbeddingLifecycleButton({
  action,
  icon,
  label,
  disabled,
  loading,
  onAction,
}: {
  action: AgentMemoryEmbeddingLifecycleActionKind;
  icon: ReactNode;
  label: string;
  disabled: boolean;
  loading?: AgentMemoryEmbeddingLifecycleActionKind;
  onAction: (action: AgentMemoryEmbeddingLifecycleActionKind) => void;
}) {
  const active = loading === action;
  return (
    <button type="button" className="panel-button mini" disabled={disabled} aria-label={`${label} managed memory embeddings`} onClick={() => onAction(action)}>
      {active ? <RefreshCw size={14} /> : icon}
      {active ? "Working" : label}
    </button>
  );
}

function agentMemoryStarterStateLabel(state: AgentMemoryStarterStatus["state"] | undefined): string {
  if (state === "off") return "Off";
  if (state === "setup_required") return "Setup required";
  if (state === "installing") return "Setting up";
  if (state === "starting") return "Starting";
  if (state === "ready") return "Ready";
  if (state === "needs_repair") return "Needs repair";
  if (state === "disabling") return "Disabling";
  return "Unknown";
}

function agentMemoryStarterMessage(status: AgentMemoryStarterStatus | undefined, error: string | undefined): string {
  if (error) return error;
  if (!status) return "Starter status has not been loaded yet.";
  if (status.blockers[0]) return status.blockers[0].message;
  if (status.state === "ready") return "Memory and managed embeddings are ready.";
  if (status.state === "off") return "Agent Memory is off.";
  return status.nextActions[0] ? `Next action: ${agentMemoryStarterActionLabel(status.nextActions[0])}.` : "Agent Memory setup is in progress.";
}

function agentMemoryStarterActionLabel(action: AgentMemoryStarterStatus["nextActions"][number]): string {
  if (action === "enable") return "Enable";
  if (action === "install") return "Install assets";
  if (action === "repair") return "Repair";
  if (action === "start") return "Start endpoint";
  if (action === "retry_preflight") return "Retry preflight";
  if (action === "open_logs") return "Open logs";
  if (action === "disable") return "Disable";
  return "Clear memory";
}

function agentMemoryStarterOperationLabel(operation: AgentMemoryStarterOperationKind): string {
  if (operation === "enable") return "Enable";
  if (operation === "repair") return "Repair";
  if (operation === "disable") return "Disable";
  return "Status";
}

export function agentMemoryStarterOperationLogPreview(
  result: Pick<AgentMemoryStarterOperationResult, "log">,
): AgentMemoryStarterOperationResult["log"] {
  const important = result.log.filter((entry) =>
    entry.step === "resident-cleanup" ||
    entry.step === "start-embeddings" ||
    entry.step === "stop-embeddings" ||
    entry.status === "blocked" ||
    entry.status === "failed"
  );
  return (important.length > 0 ? important : result.log).slice(-6);
}

function agentMemoryStarterOperationLogStatusLabel(status: AgentMemoryStarterOperationResult["log"][number]["status"]): string {
  if (status === "started") return "started";
  if (status === "skipped") return "skipped";
  if (status === "passed") return "passed";
  if (status === "blocked") return "blocked";
  if (status === "failed") return "failed";
  return status;
}

function latestAgentMemoryOperation(
  diagnostics: AgentMemoryStorageDiagnostics,
  key: "lastRecall" | "lastCapture" | "lastSearch",
): AgentMemoryOperationStatus | undefined {
  return diagnostics.runtimeSnapshots
    .map((snapshot) => snapshot[key])
    .filter((status): status is AgentMemoryOperationStatus => Boolean(status))
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))[0];
}

function operationStatusLabel(status: AgentMemoryOperationStatus | undefined): string {
  if (!status) return "none";
  const total = typeof status.total === "number" ? ` (${status.total.toLocaleString()})` : "";
  const strategy = status.strategy ? ` · ${status.strategy}` : "";
  return `${status.status}${total}${strategy}`;
}

function agentMemoryStatusLabel(status: AgentMemoryStorageDiagnostics["status"]): string {
  if (status === "needs_attention") return "Needs attention";
  return status.replace(/_/g, " ");
}

function agentMemoryEmbeddingStatusLabel(status: AgentMemoryStorageDiagnostics["embedding"]["status"] | undefined): string {
  if (!status) return "Not checked";
  if (status === "keyword_fallback") return "Keyword fallback";
  return status.replace(/_/g, " ");
}

function embeddingLifecycleActionLabel(action: AgentMemoryEmbeddingLifecycleActionKind): string {
  if (action === "check") return "Check";
  if (action === "start") return "Start";
  if (action === "stop") return "Stop";
  return "Restart";
}

type ModelProviderSettingsRowsProps = Pick<RightPanelModelModeSettingsSectionProps,
  | "state"
  | "settingsRowVisible"
  | "modelCatalogSettings"
  | "modelProviderInstallDraft"
  | "modelProviderCredentialValue"
  | "modelProviderCredentialSave"
  | "modelProviderCredentialBusy"
  | "modelProviderCredentialStatus"
  | "modelProviderInstallBusy"
  | "modelProviderInstallStatus"
  | "setModelProviderInstallDraft"
  | "setModelProviderCredentialValue"
  | "saveModelProviderCredentialFromSettings"
  | "installModelProviderEndpointFromSettings"
>;

function ModelProviderSettingsRows({
  state,
  settingsRowVisible,
  modelCatalogSettings,
  modelProviderInstallDraft,
  modelProviderCredentialValue,
  modelProviderCredentialSave,
  modelProviderCredentialBusy,
  modelProviderCredentialStatus,
  modelProviderInstallBusy,
  modelProviderInstallStatus,
  setModelProviderInstallDraft,
  setModelProviderCredentialValue,
  saveModelProviderCredentialFromSettings,
  installModelProviderEndpointFromSettings,
}: ModelProviderSettingsRowsProps) {
  const namedSecrets = namedSecretsForState(state);
  return (
    <>
      {settingsRowVisible("model-mode", "model-mode.model") && (
        <SettingsRow
          label="Model"
          value={state.provider.debugOverride ? `${state.provider.providerLabel} · ${ambientModelLabel(state.settings.model)}` : ambientModelLabel(state.settings.model)}
          description={state.provider.debugOverride ? `Startup provider override is routing Ambient-compatible calls to ${state.provider.baseUrl}.` : undefined}
        />
      )}
      {settingsRowVisible("model-mode", "model-mode.model-catalog") && (
        <SettingsRow
          label="Runtime catalog"
          value={modelCatalogSettings.statusLabel}
          description={modelCatalogSettings.summary}
        >
          <ModelRuntimeCatalogDiagnostics
            model={modelCatalogSettings}
            installDraft={modelProviderInstallDraft}
            credentialValue={modelProviderCredentialValue}
            credentialModel={modelProviderCredentialSave}
            credentialBusy={modelProviderCredentialBusy}
            credentialStatus={modelProviderCredentialStatus}
            installBusy={modelProviderInstallBusy}
            installStatus={modelProviderInstallStatus}
            onInstallDraftChange={setModelProviderInstallDraft}
            onCredentialValueChange={setModelProviderCredentialValue}
            onSaveCredential={() => void saveModelProviderCredentialFromSettings()}
            onInstallEndpoint={() => void installModelProviderEndpointFromSettings()}
          />
        </SettingsRow>
      )}
      {settingsRowVisible("model-mode", "model-mode.named-secrets") && (
        <SettingsRow
          label="Named secrets"
          value={`${namedSecrets.length.toLocaleString()} configured`}
          description="Store named credentials for brokered use without exposing values to chat or transcripts."
        >
          <NamedSecretVault state={state} />
        </SettingsRow>
      )}
    </>
  );
}

type CollaborationModeSettingsRowsProps = Pick<RightPanelModelModeSettingsSectionProps,
  | "state"
  | "settingsRowVisible"
  | "subagentsFlagValue"
  | "subagentsFlagDescription"
  | "persistentSubagentsEnabled"
  | "slashCommandsFlagValue"
  | "slashCommandsFlagDescription"
  | "persistentSlashCommandsEnabled"
  | "subagentMaturity"
  | "subagentMaturityEvidence"
  | "onThinkingDisplaySettingsChange"
  | "onThinkingLevelChange"
  | "onFeatureFlagSettingsChange"
>;

function CollaborationModeSettingsRows({
  state,
  settingsRowVisible,
  subagentsFlagValue,
  subagentsFlagDescription,
  persistentSubagentsEnabled,
  slashCommandsFlagValue,
  slashCommandsFlagDescription,
  persistentSlashCommandsEnabled,
  subagentMaturity,
  subagentMaturityEvidence,
  onThinkingDisplaySettingsChange,
  onThinkingLevelChange,
  onFeatureFlagSettingsChange,
}: CollaborationModeSettingsRowsProps) {
  const modelReasoning = modelReasoningControlModel(state.settings.model, state.settings.thinkingLevel);
  return (
    <>
      {settingsRowVisible("model-mode", "model-mode.mode") && (
        <SettingsRow
          label="Mode"
          value={state.settings.collaborationMode === "planner" ? "Planner" : "Agent"}
          description={state.settings.collaborationMode === "planner" ? "Read-only planning tools" : "Normal implementation tools"}
        />
      )}
      {settingsRowVisible("model-mode", "model-mode.thinking-display") && (
        <SettingsRow
          label="Thinking display"
          value={thinkingDisplayModeLabel(state.settings.thinkingDisplay.mode)}
          description="Controls how saved Ambient/Pi thinking appears in chats. Thinking remains preserved for session recreation."
        >
          <SegmentedThinkingDisplay
            value={state.settings.thinkingDisplay.mode}
            onChange={(mode) => onThinkingDisplaySettingsChange({ ...state.settings.thinkingDisplay, mode })}
          />
        </SettingsRow>
      )}
      {modelReasoning.kind !== "hidden" && settingsRowVisible("model-mode", "model-mode.reasoning-mode") && (
        <SettingsRow
          label="Reasoning mode"
          value={modelReasoning.label}
          description={modelReasoning.settingsDescription}
        >
          {modelReasoning.kind === "selectable" ? (
            <SegmentedModelReasoning model={modelReasoning} onChange={onThinkingLevelChange} />
          ) : (
            <div className="voice-provider-diagnostics info">
              <div className="voice-provider-diagnostics-header">
                <strong>{modelReasoning.label}</strong>
                <span>{ambientModelLabel(state.settings.model)}</span>
              </div>
              <small>{modelReasoning.tooltip}</small>
            </div>
          )}
        </SettingsRow>
      )}
      {settingsRowVisible("model-mode", "model-mode.run-status-card") && (
        <SettingsRow
          label="Detailed run card"
          value={state.settings.thinkingDisplay.hideRunStatusCardAfterFirstMessage ? "First message only" : "Always shown"}
          description="Shows the detailed Ambient working card for the first message in a thread, then relies on the compact status strip unless disabled."
        >
          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={state.settings.thinkingDisplay.hideRunStatusCardAfterFirstMessage}
              onChange={(event) =>
                onThinkingDisplaySettingsChange({
                  ...state.settings.thinkingDisplay,
                  hideRunStatusCardAfterFirstMessage: event.target.checked,
                })
              }
            />
            <span>Hide after first assistant reply</span>
          </label>
        </SettingsRow>
      )}
      {settingsRowVisible("model-mode", "model-mode.subagents") && (
        <SettingsRow
          label="Experimental sub-agents"
          value={subagentsFlagValue}
          description={subagentsFlagDescription}
        >
          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={persistentSubagentsEnabled}
              onChange={(event) => onFeatureFlagSettingsChange({ ...state.settings.featureFlags, subagents: event.target.checked })}
            />
            <span>{persistentSubagentsEnabled ? "Enabled" : "Off"}</span>
          </label>
          <SubagentMaturityDiagnostics maturity={subagentMaturity} evidence={subagentMaturityEvidence} />
        </SettingsRow>
      )}
      {settingsRowVisible("model-mode", "model-mode.slash-commands") && (
        <SettingsRow
          label="Slash command skills"
          value={slashCommandsFlagValue}
          description={slashCommandsFlagDescription}
        >
          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={persistentSlashCommandsEnabled}
              onChange={(event) =>
                onFeatureFlagSettingsChange({
                  ...state.settings.featureFlags,
                  slashCommands: event.target.checked,
                })
              }
            />
            <span>{persistentSlashCommandsEnabled ? "Enabled" : "Off"}</span>
          </label>
        </SettingsRow>
      )}
    </>
  );
}

type AgentMemorySettingsRowProps = Pick<RightPanelModelModeSettingsSectionProps,
  | "state"
  | "settingsRowVisible"
  | "memoryFlagValue"
  | "memoryFlagDescription"
  | "persistentMemoryFeatureEnabled"
  | "activeThreadMemoryEnabled"
  | "activeThreadMemoryToggleDisabled"
  | "agentMemoryDiagnostics"
  | "agentMemoryDiagnosticsLoading"
  | "agentMemoryDiagnosticsError"
  | "agentMemoryEmbeddingActionLoading"
  | "agentMemoryEmbeddingActionResult"
  | "agentMemoryEmbeddingActionError"
  | "agentMemoryStarterStatus"
  | "agentMemoryStarterLoading"
  | "agentMemoryStarterError"
  | "agentMemoryStarterOperationLoading"
  | "agentMemoryStarterOperationResult"
  | "agentMemoryClearConfirming"
  | "agentMemoryClearLoading"
  | "agentMemoryClearStatus"
  | "loadAgentMemoryStarterStatus"
  | "enableAgentMemoryStarterFromSettings"
  | "repairAgentMemoryStarterFromSettings"
  | "disableAgentMemoryStarterFromSettings"
  | "requestAgentMemoryClearFromSettings"
  | "cancelAgentMemoryClearFromSettings"
  | "confirmAgentMemoryClearFromSettings"
  | "onMemorySettingsChange"
  | "onRefreshAgentMemoryDiagnostics"
  | "onRunAgentMemoryEmbeddingLifecycleAction"
>;

function AgentMemorySettingsRow({
  state,
  settingsRowVisible,
  memoryFlagValue,
  memoryFlagDescription,
  persistentMemoryFeatureEnabled,
  activeThreadMemoryEnabled,
  activeThreadMemoryToggleDisabled,
  agentMemoryDiagnostics,
  agentMemoryDiagnosticsLoading,
  agentMemoryDiagnosticsError,
  agentMemoryEmbeddingActionLoading,
  agentMemoryEmbeddingActionResult,
  agentMemoryEmbeddingActionError,
  agentMemoryStarterStatus,
  agentMemoryStarterLoading,
  agentMemoryStarterError,
  agentMemoryStarterOperationLoading,
  agentMemoryStarterOperationResult,
  agentMemoryClearConfirming,
  agentMemoryClearLoading,
  agentMemoryClearStatus,
  loadAgentMemoryStarterStatus,
  enableAgentMemoryStarterFromSettings,
  repairAgentMemoryStarterFromSettings,
  disableAgentMemoryStarterFromSettings,
  requestAgentMemoryClearFromSettings,
  cancelAgentMemoryClearFromSettings,
  confirmAgentMemoryClearFromSettings,
  onMemorySettingsChange,
  onRefreshAgentMemoryDiagnostics,
  onRunAgentMemoryEmbeddingLifecycleAction,
}: AgentMemorySettingsRowProps) {
  async function changeAgentMemoryMode(mode: AgentMemoryMode) {
    if (mode === state.settings.memory.mode && mode !== "disabled") {
      await repairAgentMemoryStarterFromSettings();
      return;
    }
    if (mode === "disabled") {
      await disableAgentMemoryStarterFromSettings();
      return;
    }
    await enableAgentMemoryStarterFromSettings(mode);
  }

  return (
    <>
      {settingsRowVisible("model-mode", "model-mode.agent-memory") && (
        <SettingsRow
          label="Agent Memory"
          value={agentMemoryModeLabel(state.settings.memory.mode)}
          description="Controls whether Agent Memory is available globally, per thread, or off."
        >
          <AgentMemoryStarterCard
            status={agentMemoryStarterStatus}
            loading={agentMemoryStarterLoading}
            error={agentMemoryStarterError}
            operationLoading={agentMemoryStarterOperationLoading}
            operationResult={agentMemoryStarterOperationResult}
            memoryMode={state.settings.memory.mode}
            actionsDisabled={memoryFlagValue === "Forced off"}
            onModeChange={changeAgentMemoryMode}
            onRefresh={loadAgentMemoryStarterStatus}
            onEnable={enableAgentMemoryStarterFromSettings}
            onRepair={repairAgentMemoryStarterFromSettings}
            onDisable={disableAgentMemoryStarterFromSettings}
          />
          <div className="voice-provider-diagnostics info">
            <div className="voice-provider-diagnostics-header">
              <strong>Memory privacy</strong>
            </div>
            <ul>
              {AGENT_MEMORY_PRIVACY_DISCLOSURE_LINES.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <details className="settings-disclosure">
            <summary>
              <span className="settings-disclosure-title">
                <ChevronDown size={14} />
                <strong>Advanced controls</strong>
              </span>
              <small>{memoryFlagValue}</small>
            </summary>
            <div className="settings-disclosure-body">
              <small>{memoryFlagDescription}</small>
              <label className="setting-toggle">
                <input
                  type="checkbox"
                  aria-label="Agent Memory short-term offload"
                  checked={state.settings.memory.shortTermOffloadEnabled}
                  onChange={(event) =>
                    onMemorySettingsChange({
                      ...state.settings.memory,
                      shortTermOffloadEnabled: event.target.checked,
                    })
                  }
                />
                <span>Short-term offload</span>
              </label>
              <AgentMemoryPolicyDiagnostics
                memoryMode={state.settings.memory.mode}
                memoryFlagValue={memoryFlagValue}
                persistentMemoryFeatureEnabled={persistentMemoryFeatureEnabled}
                activeThreadMemoryEnabled={activeThreadMemoryEnabled}
                activeThreadMemoryToggleDisabled={activeThreadMemoryToggleDisabled}
                defaultThreadEnabled={state.settings.memory.defaultThreadEnabled}
                managedEmbeddingsEnabled={state.settings.memory.embeddings.enabled}
                managedEmbeddingsAutoStart={state.settings.memory.embeddings.autoStartProvider}
              />
              <AgentMemoryEmbeddingHealthCard
                diagnostics={agentMemoryDiagnostics}
                embeddingsEnabled={state.settings.memory.embeddings.enabled}
                actionLoading={agentMemoryEmbeddingActionLoading}
                actionResult={agentMemoryEmbeddingActionResult}
                actionError={agentMemoryEmbeddingActionError}
                onAction={onRunAgentMemoryEmbeddingLifecycleAction}
                showControls={false}
              />
            </div>
          </details>
          <div className="panel-action-row">
            <button type="button" className="panel-button mini" disabled={agentMemoryDiagnosticsLoading} onClick={onRefreshAgentMemoryDiagnostics}>
              {agentMemoryDiagnosticsLoading ? "Refreshing" : "Refresh diagnostics"}
            </button>
            <button
              type="button"
              className="panel-button mini danger"
              disabled={agentMemoryClearLoading || agentMemoryClearConfirming}
              onClick={requestAgentMemoryClearFromSettings}
            >
              {agentMemoryClearLoading ? "Clearing" : "Clear memory"}
            </button>
          </div>
          {agentMemoryClearConfirming && !agentMemoryClearLoading && (
            <>
              <p className="panel-status info">Confirm clearing this workspace's Agent Memory store. Chat transcripts and workspace files are not edited.</p>
              <div className="panel-action-row">
                <button type="button" className="panel-button mini danger" onClick={confirmAgentMemoryClearFromSettings}>
                  Confirm clear
                </button>
                <button type="button" className="panel-button mini" onClick={cancelAgentMemoryClearFromSettings}>
                  Cancel
                </button>
              </div>
            </>
          )}
          {agentMemoryClearStatus && <p className={`panel-status ${agentMemoryClearStatus.kind}`}>{agentMemoryClearStatus.message}</p>}
          {agentMemoryDiagnosticsError && <p className="panel-status error">{agentMemoryDiagnosticsError}</p>}
          {agentMemoryDiagnostics
            ? <AgentMemoryDiagnosticsSummary diagnostics={agentMemoryDiagnostics} />
            : (
                <small>
                  Diagnostics are loaded on demand and include only status, counters, storage metadata, native preflight, and runtime snapshots.
                </small>
              )}
          </SettingsRow>
      )}
    </>
  );
}

type ModelRuntimeSettingsRowsProps = Pick<RightPanelModelModeSettingsSectionProps,
  | "state"
  | "settingsRowVisible"
  | "onModelRuntimeSettingsChange"
  | "onPlannerSettingsChange"
>;

function ModelRuntimeSettingsRows({
  state,
  settingsRowVisible,
  onModelRuntimeSettingsChange,
  onPlannerSettingsChange,
}: ModelRuntimeSettingsRowsProps) {
  const contextUsage = contextUsagePresentation(state.contextUsage, state.settings.compaction);
  return (
    <>
      {settingsRowVisible("model-mode", "model-mode.aggressive-retries") && (
        <SettingsRow
          label="Aggressive retries"
          value={state.settings.modelRuntime.aggressiveRetries ? "Up to 10 retries" : "Off"}
          description="Retries transient Ambient/Pi provider failures with short backoff. Active Pi sessions are recreated when this changes."
        >
          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={state.settings.modelRuntime.aggressiveRetries}
              onChange={(event) => onModelRuntimeSettingsChange({ ...state.settings.modelRuntime, aggressiveRetries: event.target.checked })}
            />
            <span>{state.settings.modelRuntime.aggressiveRetries ? "Up to 10 retries" : "Off"}</span>
          </label>
        </SettingsRow>
      )}
      {settingsRowVisible("model-mode", "model-mode.prompt-cache-status") && (
        <SettingsRow
          label="Show prompt cache status"
          value={state.settings.modelRuntime.showPromptCacheStatus ? "Shown" : "Hidden"}
          description="Shows provider-reported prompt-cache hits, misses, or unknown status on assistant and visible thinking messages."
        >
          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={state.settings.modelRuntime.showPromptCacheStatus}
              onChange={(event) => onModelRuntimeSettingsChange({ ...state.settings.modelRuntime, showPromptCacheStatus: event.target.checked })}
            />
            <span>{state.settings.modelRuntime.showPromptCacheStatus ? "Shown" : "Hidden"}</span>
          </label>
        </SettingsRow>
      )}
      {settingsRowVisible("model-mode", "model-mode.provider-idle-timeout") && (
        <SettingsRow
          label="Provider stream idle retry"
          value={formatDurationMs(state.settings.modelRuntime.providerStreamIdleTimeoutMs)}
          description="Retries only after the selected window passes with no response bytes or keepalives, Pi events, assistant text, or tool argument growth."
        >
          <select
            className="automation-select"
            aria-label="Provider stream idle retry timeout"
            value={state.settings.modelRuntime.providerStreamIdleTimeoutMs}
            onChange={(event) =>
              onModelRuntimeSettingsChange({
                ...state.settings.modelRuntime,
                providerStreamIdleTimeoutMs: Number(event.target.value),
              })
            }
          >
            {MODEL_RUNTIME_PROVIDER_TIMEOUT_OPTIONS_MS.map((timeoutMs) => (
              <option key={timeoutMs} value={timeoutMs}>
                {formatDurationMs(timeoutMs)}
              </option>
            ))}
          </select>
        </SettingsRow>
      )}
      {settingsRowVisible("model-mode", "model-mode.provider-pre-stream-timeout") && (
        <SettingsRow
          label="Pre-stream response timeout"
          value={formatDurationMs(state.settings.modelRuntime.providerPreStreamTimeoutMs)}
          description="Applies before response headers or the first valid Ambient/Pi stream event arrives."
        >
          <select
            className="automation-select"
            aria-label="Pre-stream response timeout"
            value={state.settings.modelRuntime.providerPreStreamTimeoutMs}
            onChange={(event) =>
              onModelRuntimeSettingsChange({
                ...state.settings.modelRuntime,
                providerPreStreamTimeoutMs: Number(event.target.value),
              })
            }
          >
            {MODEL_RUNTIME_PROVIDER_TIMEOUT_OPTIONS_MS.map((timeoutMs) => (
              <option key={timeoutMs} value={timeoutMs}>
                {formatDurationMs(timeoutMs)}
              </option>
            ))}
          </select>
        </SettingsRow>
      )}
      {settingsRowVisible("model-mode", "model-mode.planner") && (
        <SettingsRow
          label="Planner finalization"
          value={state.settings.planner.autoFinalize ? "Automatic" : "Manual"}
          description="When enabled, answering the last required planner question starts final plan generation."
        >
          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={state.settings.planner.autoFinalize}
              onChange={(event) => onPlannerSettingsChange({ ...state.settings.planner, autoFinalize: event.target.checked })}
            />
            <span>Auto-finalize after required questions</span>
          </label>
        </SettingsRow>
      )}
      {settingsRowVisible("model-mode", "model-mode.context") && (
        <SettingsRow
          label="Context"
          value={contextUsage.label}
          description={contextUsage.title}
        />
      )}
      {settingsRowVisible("model-mode", "model-mode.compaction") && (
        <SettingsRow label="Compaction" value={state.settings.compaction.autoCompactionEnabled ? "Automatic" : "Manual only"}>
          <small>
            Reserve {state.settings.compaction.reserveTokens.toLocaleString()} · keep recent{" "}
            {state.settings.compaction.keepRecentTokens.toLocaleString()} · warning {state.settings.compaction.softWarningPercent}% · hard{" "}
            {state.settings.compaction.hardPreflightPercent}%
          </small>
        </SettingsRow>
      )}
    </>
  );
}

export function RightPanelModelModeSettingsSection(props: RightPanelModelModeSettingsSectionProps) {
  const { state } = props;
  return (
    <SettingsSection
      id="model-mode"
      title="Model & Mode"
      description="Current model, collaboration mode, context usage, and compaction behavior."
      badges={<span className="settings-section-badge">{state.settings.collaborationMode === "planner" ? "Planner" : "Agent"}</span>}
    >
      <ModelProviderSettingsRows {...props} />
      <CollaborationModeSettingsRows {...props} />
      <AgentMemorySettingsRow {...props} />
      <ModelRuntimeSettingsRows {...props} />
    </SettingsSection>
  );
}
