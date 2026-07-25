import { startTransition } from "react";
import type { Dispatch, SetStateAction } from "react";

import { normalizeAmbientModelId } from "../../shared/ambientModels";
import type { DesktopEvent, DesktopState, MenuCommand } from "../../shared/desktopTypes";
import type { AmbientCliSecretDialogInput } from "./AppCredentialDialogActions";
import { chatBrowserUserActionForThread } from "./AppChatChrome";
import { isAppDesktopEventStateReducerEvent, reduceAppDesktopEventState } from "./AppDesktopEventStateReducer";
import { desktopStateCommitDecision, desktopStateFreshnessDecision, desktopStateWithoutClearedGoal } from "./AppDesktopStateFreshness";
import { applyDocumentAppearance } from "./appearance";
import { localDeepResearchInstallProgressState, localDeepResearchSetupResultState } from "./AppLocalDeepResearchLifecycle";
import { isGoalCompletionMessage, messageKindForActivity } from "./AppMessages";
import {
  formatRuntimeActivity,
  runRetryStatsFromActivity,
  shouldRenderRuntimeActivityUpdate,
  type AppendRunActivityLine,
} from "./AppRunActivity";
import { coalesceWorkflowCompileProgress } from "./AppWorkflowRecording";
import {
  runtimeStatusIndicatorsAfterGoalUpdated,
  runtimeStatusIndicatorsAfterRunStatus,
  runtimeStatusIndicatorsAfterRuntimeActivity,
} from "./runtimeStatusIndicatorUiModel";
import type { useAppAutomationShellState } from "./AppAutomationShellState";
import type { createAppDesktopEventGuards } from "./AppDesktopEventGuards";
import type { useAppProviderRuntimeState } from "./AppProviderRuntimeState";
import type { useAppRightPanelState } from "./AppRightPanelState";
import type { useAppRunActivityState } from "./AppRunActivityState";
import type { useAppSecurityPromptState } from "./AppSecurityPromptState";
import type { useAppShellUiState } from "./AppShellUiState";
import type { useAppVoiceThreadControls } from "./AppVoiceThreadControls";
import type { useAppWorkflowRuntimeState } from "./AppWorkflowRuntimeState";
import type { useAppWorkspaceShellState } from "./AppWorkspaceShellState";

type AppDesktopEventGuardDependencies = Pick<
  ReturnType<typeof createAppDesktopEventGuards>,
  "desktopEventMatchesWorkspace" | "desktopEventMatchesActiveProject"
>;

type AppDesktopEventWorkspaceDependencies = Pick<
  ReturnType<typeof useAppWorkspaceShellState>,
  | "activeProjectRootRef"
  | "activeThreadIdRef"
  | "messageKindsRef"
  | "setBrowserRevision"
  | "setChatBrowserUserAction"
  | "setPluginCatalogRevision"
  | "setWorkspaceRevision"
>;

type AppDesktopEventRunDependencies = Pick<
  ReturnType<typeof useAppRunActivityState>,
  | "setActivity"
  | "setRetryStatsByThread"
  | "setRunStatus"
  | "setRuntimeStatusIndicatorsByThread"
  | "setThreadRunStatuses"
  | "runtimeActivityRenderStateRef"
>;

type AppDesktopEventShellDependencies = Pick<ReturnType<typeof useAppShellUiState>, "setScopedError">;

type AppDesktopEventSecurityDependencies = Pick<
  ReturnType<typeof useAppSecurityPromptState>,
  | "setPermissionAudit"
  | "setPermissionAuditRevision"
  | "setPermissionGrants"
  | "setPermissionRequests"
  | "setPrivilegedCredentialRequests"
  | "setSecureInputRequests"
>;

type AppDesktopEventProviderDependencies = Pick<
  ReturnType<typeof useAppProviderRuntimeState>,
  "setLocalDeepResearchSetup" | "setMcpContainerRuntimeInstallProgress" | "setMcpDefaultCapabilityInstallProgress"
>;

type AppDesktopEventWorkflowDependencies = Pick<
  ReturnType<typeof useAppWorkflowRuntimeState>,
  | "clearedGoalKeysRef"
  | "latestDesktopStateRevisionRef"
  | "setOrchestrationAutoRevision"
  | "setOrchestrationRevision"
  | "setWorkflowCompileProgress"
  | "setWorkflowDiscoveryProgress"
  | "setWorkflowExplorationProgressByThreadId"
  | "setWorkflowRevision"
>;

type AppDesktopEventAutomationDependencies = Pick<ReturnType<typeof useAppAutomationShellState>, "setSelectedWorkflowAgentThreadId">;

type AppDesktopEventRightPanelDependencies = Pick<ReturnType<typeof useAppRightPanelState>, "openMcpRuntimeSettings">;

type AppDesktopEventVoiceDependencies = Pick<ReturnType<typeof useAppVoiceThreadControls>, "setActiveVoiceMessageId">;

export type AppDesktopEventHandlerDependencies = AppDesktopEventAutomationDependencies &
  AppDesktopEventGuardDependencies &
  AppDesktopEventProviderDependencies &
  AppDesktopEventRightPanelDependencies &
  AppDesktopEventRunDependencies &
  AppDesktopEventSecurityDependencies &
  AppDesktopEventShellDependencies &
  AppDesktopEventVoiceDependencies &
  AppDesktopEventWorkspaceDependencies &
  AppDesktopEventWorkflowDependencies & {
    appendRunActivityLine: AppendRunActivityLine;
    appendThinkingDeltaLine: (messageId: string, delta: string) => void;
    handleMenuCommand: (command: MenuCommand) => void | Promise<void>;
    openAmbientCliSecretDialog: (input: AmbientCliSecretDialogInput) => void;
    openApiKeyDialog: () => void | Promise<void>;
    rememberClearedGoal: (threadId: string, goalId: string | undefined) => void;
    rememberCommittedDesktopState: (next: DesktopState) => void;
    scheduleSttProviderRefresh: (delayMs: number, reason: string) => void;
    scheduleVoiceProviderRefresh: (delayMs: number, reason: string) => void;
    setState: Dispatch<SetStateAction<DesktopState | undefined>>;
    triggerGoalCompletionCelebration: (messageId: string) => void;
  };

export type AppDesktopEventHandlerDependencyGroups = {
  automationShellState: AppDesktopEventAutomationDependencies;
  desktopEventGuards: AppDesktopEventGuardDependencies;
  providerRuntimeState: AppDesktopEventProviderDependencies;
  rightPanelState: AppDesktopEventRightPanelDependencies;
  runActivityState: AppDesktopEventRunDependencies;
  securityPromptState: AppDesktopEventSecurityDependencies;
  shellUiState: AppDesktopEventShellDependencies;
  voiceThreadControls: AppDesktopEventVoiceDependencies;
  workspaceShellState: AppDesktopEventWorkspaceDependencies;
  workflowRuntimeState: AppDesktopEventWorkflowDependencies;
} & Pick<
  AppDesktopEventHandlerDependencies,
  | "appendRunActivityLine"
  | "appendThinkingDeltaLine"
  | "handleMenuCommand"
  | "openAmbientCliSecretDialog"
  | "openApiKeyDialog"
  | "rememberClearedGoal"
  | "rememberCommittedDesktopState"
  | "scheduleSttProviderRefresh"
  | "scheduleVoiceProviderRefresh"
  | "setState"
  | "triggerGoalCompletionCelebration"
>;

export function createAppDesktopEventHandlerDependencies({
  automationShellState,
  desktopEventGuards,
  providerRuntimeState,
  rightPanelState,
  runActivityState,
  securityPromptState,
  shellUiState,
  voiceThreadControls,
  workspaceShellState,
  workflowRuntimeState,
  ...callbacks
}: AppDesktopEventHandlerDependencyGroups): AppDesktopEventHandlerDependencies {
  return {
    ...automationShellState,
    ...desktopEventGuards,
    ...providerRuntimeState,
    ...rightPanelState,
    ...runActivityState,
    ...securityPromptState,
    ...shellUiState,
    ...voiceThreadControls,
    ...workspaceShellState,
    ...workflowRuntimeState,
    ...callbacks,
  };
}

export function toolEventActivityMessage(details: unknown): string | undefined {
  const record = details && typeof details === "object" && !Array.isArray(details) ? (details as Record<string, unknown>) : undefined;
  const direct = typeof record?.activityMessage === "string" && record.activityMessage.trim() ? record.activityMessage.trim() : undefined;
  if (direct) return direct;
  const status =
    record?.localDeepResearchStatus && typeof record.localDeepResearchStatus === "object" && !Array.isArray(record.localDeepResearchStatus)
      ? (record.localDeepResearchStatus as Record<string, unknown>)
      : undefined;
  for (const key of ["activityMessage", "message"]) {
    const value = status?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function toolEventCouldAffectSpeechProviderState(details: unknown): boolean {
  const record = details && typeof details === "object" && !Array.isArray(details) ? (details as Record<string, unknown>) : undefined;
  const toolName = typeof record?.toolName === "string" ? record.toolName.toLowerCase() : "";
  return (
    toolName === "ambient_cli_package_install" ||
    toolName === "ambient_cli_package_install_pi_catalog" ||
    toolName === "ambient_cli_package_uninstall" ||
    toolName === "ambient_cli_env_bind" ||
    toolName === "ambient_cli_secret_request" ||
    toolName === "ambient_capability_builder_register" ||
    toolName === "ambient_capability_builder_unregister" ||
    toolName === "ambient_capability_builder_repair_registration_metadata"
  );
}

export function thinkingActivityTextFromMessageContent(content: string): string | undefined {
  const normalized = content.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
  if (!normalized) return undefined;
  return normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
}

export function handleAppDesktopEvent(event: DesktopEvent, deps: AppDesktopEventHandlerDependencies): void {
  if (event.type === "state") {
    const nextState = desktopStateWithoutClearedGoal(event.state, deps.clearedGoalKeysRef.current);
    const freshness = desktopStateFreshnessDecision(deps.latestDesktopStateRevisionRef.current, nextState);
    if (!freshness.apply) return;
    deps.latestDesktopStateRevisionRef.current = freshness.latestRevision;
    // Full desktop snapshots can be large while board synthesis streams; keep them interruptible
    // so local input, scrolling, and close/tab clicks stay responsive.
    startTransition(() => {
      deps.setState((current) => {
        const decision = desktopStateCommitDecision(
          deps.latestDesktopStateRevisionRef.current,
          nextState,
          deps.clearedGoalKeysRef.current,
          current,
        );
        if (!decision.apply) return current;
        deps.rememberCommittedDesktopState(decision.state);
        return decision.state;
      });
    });
    return;
  }
  if (
    event.type === "thread-goal-cleared" &&
    event.threadId === deps.activeThreadIdRef.current &&
    deps.desktopEventMatchesActiveProject(event)
  ) {
    deps.rememberClearedGoal(event.threadId, event.goalId);
  }
  if (event.type === "appearance-updated") {
    applyDocumentAppearance(event.appearance);
    deps.setState((current) => (current ? { ...current, appearance: event.appearance } : current));
    return;
  }
  if (event.type === "run-status") {
    if (!deps.desktopEventMatchesActiveProject(event)) return;
    deps.setRuntimeStatusIndicatorsByThread((current) =>
      runtimeStatusIndicatorsAfterRunStatus(current, {
        threadId: event.threadId,
        status: event.status,
        now: Date.now(),
      }),
    );
    if (event.status === "starting") delete deps.runtimeActivityRenderStateRef.current[event.threadId];
    deps.setThreadRunStatuses((statuses) =>
      statuses[event.threadId] === event.status ? statuses : { ...statuses, [event.threadId]: event.status },
    );
    if (event.status === "starting") deps.appendRunActivityLine("Starting Ambient session.", "state", {}, event.threadId);
    if (event.status === "streaming") deps.appendRunActivityLine("Waiting for model output.", "state", {}, event.threadId);
    if (event.status === "tool") deps.appendRunActivityLine("Tool execution is in progress.", "tool", {}, event.threadId);
    if (event.status === "compacting") deps.appendRunActivityLine("Compacting context before continuing.", "state", {}, event.threadId);
    if (event.status === "retrying") deps.appendRunActivityLine("Retrying after a recoverable model error.", "state", {}, event.threadId);
    if (event.threadId === deps.activeThreadIdRef.current) {
      deps.setRunStatus((current) => (current === event.status ? current : event.status));
      if (event.status === "idle" || event.status === "error") deps.setActivity(undefined);
    }
    return;
  }
  if (event.type === "runtime-activity") {
    if (!deps.desktopEventMatchesActiveProject(event)) return;
    deps.setRuntimeStatusIndicatorsByThread((current) =>
      runtimeStatusIndicatorsAfterRuntimeActivity(current, event.activity, Date.now()),
    );
    if (event.activity.kind === "retry") {
      const retryActivity = event.activity;
      deps.setRetryStatsByThread((current) => ({
        ...current,
        [retryActivity.threadId]: runRetryStatsFromActivity(current[retryActivity.threadId], retryActivity),
      }));
    }
    const activityText = formatRuntimeActivity(event.activity);
    const now = Date.now();
    const shouldRenderActivity = shouldRenderRuntimeActivityUpdate({
      activity: event.activity,
      now,
      previous: deps.runtimeActivityRenderStateRef.current[event.activity.threadId],
      text: activityText,
    });
    if (shouldRenderActivity) {
      deps.runtimeActivityRenderStateRef.current[event.activity.threadId] = { text: activityText, renderedAt: now };
      deps.appendRunActivityLine(
        activityText,
        event.activity.kind === "retry" ||
          (event.activity.kind === "stream" && event.activity.status === "timeout") ||
          (event.activity.kind === "tool" && event.activity.status === "timeout")
          ? "error"
          : "state",
        {},
        event.activity.threadId,
      );
    }
    if (shouldRenderActivity && event.activity.threadId === deps.activeThreadIdRef.current) deps.setActivity(event.activity);
    return;
  }
  if (event.type === "thread-goal-updated") {
    if (!deps.desktopEventMatchesActiveProject(event)) return;
    deps.setRuntimeStatusIndicatorsByThread((current) => runtimeStatusIndicatorsAfterGoalUpdated(current, event.goal, Date.now()));
    if (event.goal.threadId === deps.activeThreadIdRef.current && event.goal.status !== "active") {
      deps.setActivity((current) => (current?.kind === "goal" && current.goalId === event.goal.goalId ? undefined : current));
    }
  }
  if (event.type === "mcp-container-runtime-install-progress") {
    if (!deps.desktopEventMatchesActiveProject(event)) return;
    deps.setMcpContainerRuntimeInstallProgress(event.progress);
    return;
  }
  if (event.type === "mcp-default-capability-install-progress") {
    if (!deps.desktopEventMatchesActiveProject(event)) return;
    deps.setMcpDefaultCapabilityInstallProgress(event.progress);
    return;
  }
  if (event.type === "local-deep-research-install-progress") {
    if (!deps.desktopEventMatchesActiveProject(event)) return;
    deps.setLocalDeepResearchSetup((current) => localDeepResearchInstallProgressState(current, event.progress));
    return;
  }
  if (event.type === "local-deep-research-setup-updated") {
    if (!deps.desktopEventMatchesActiveProject(event)) return;
    deps.setLocalDeepResearchSetup((current) => localDeepResearchSetupResultState(event.result, current));
    return;
  }
  if (event.type === "context-usage-updated") {
    if (!deps.desktopEventMatchesActiveProject(event)) return;
    deps.setState((current) => {
      if (!current || current.activeThreadId !== event.snapshot.threadId) return current;
      if (
        event.snapshot.modelId === undefined ||
        normalizeAmbientModelId(event.snapshot.modelId) !== normalizeAmbientModelId(current.settings.model)
      ) {
        return current;
      }
      return { ...current, contextUsage: event.snapshot };
    });
    return;
  }
  if (event.type === "error") {
    if (event.threadId && event.threadId !== deps.activeThreadIdRef.current) return;
    if (event.workspacePath && event.workspacePath !== deps.activeProjectRootRef.current) return;
    deps.setScopedError(
      event.message,
      event.threadId || event.workspacePath ? { threadId: event.threadId, workspacePath: event.workspacePath } : undefined,
    );
    return;
  }
  if (event.type === "open-api-key-dialog") {
    void deps.openApiKeyDialog();
    return;
  }
  if (event.type === "mcp-container-runtime-setup-needed") {
    if (!deps.desktopEventMatchesActiveProject(event)) return;
    deps.openMcpRuntimeSettings();
    return;
  }
  if (event.type === "ambient-cli-secret-requested") {
    deps.openAmbientCliSecretDialog({
      packageId: event.packageId,
      packageName: event.packageName,
      builderSourcePath: event.builderSourcePath,
      mcpServerId: event.mcpServerId,
      mcpCandidateId: event.mcpCandidateId,
      mcpCandidateRef: event.mcpCandidateRef,
      envName: event.envName,
    });
    return;
  }
  if (event.type === "menu-command") {
    void deps.handleMenuCommand(event.command);
    return;
  }
  if (event.type === "permission-request") {
    const request = {
      ...event.request,
      ...(!event.request.workspacePath && event.workspacePath ? { workspacePath: event.workspacePath } : {}),
    };
    deps.setPermissionRequests((requests) => (requests.some((existing) => existing.id === request.id) ? requests : [...requests, request]));
    return;
  }
  if (event.type === "permission-resolved") {
    deps.setPermissionRequests((requests) => requests.filter((request) => request.id !== event.id));
    return;
  }
  if (event.type === "privileged-credential-request") {
    const request = {
      ...event.request,
      ...(!event.request.workspacePath && event.workspacePath ? { workspacePath: event.workspacePath } : {}),
    };
    deps.setPrivilegedCredentialRequests((requests) =>
      requests.some((existing) => existing.id === request.id) ? requests : [...requests, request],
    );
    return;
  }
  if (event.type === "privileged-credential-resolved") {
    deps.setPrivilegedCredentialRequests((requests) => requests.filter((request) => request.id !== event.id));
    return;
  }
  if (event.type === "secure-input-request") {
    const request = {
      ...event.request,
      ...(!event.request.workspacePath && event.workspacePath ? { workspacePath: event.workspacePath } : {}),
    };
    deps.setSecureInputRequests((requests) =>
      requests.some((existing) => existing.id === request.id) ? requests : [...requests, request],
    );
    return;
  }
  if (event.type === "secure-input-resolved") {
    deps.setSecureInputRequests((requests) => requests.filter((request) => request.id !== event.id));
    return;
  }
  if (event.type === "permission-audit-created") {
    if (!deps.desktopEventMatchesActiveProject(event)) return;
    deps.setPermissionAuditRevision((revision) => revision + 1);
    return;
  }
  if (event.type === "permission-grant-created" || event.type === "permission-grant-revoked") {
    if (!deps.desktopEventMatchesActiveProject(event)) return;
    deps.setPermissionAuditRevision((revision) => revision + 1);
    return;
  }
  if (event.type === "e2e-permission-fixture") {
    if (event.grants) deps.setPermissionGrants(event.grants);
    if (event.audit) deps.setPermissionAudit(event.audit);
    return;
  }
  if (event.type === "plugin-catalog-updated") {
    if (!deps.desktopEventMatchesActiveProject(event)) return;
    deps.setPluginCatalogRevision((revision) => revision + 1);
    deps.scheduleVoiceProviderRefresh(150, "plugin catalog updated");
    deps.scheduleSttProviderRefresh(150, "plugin catalog updated");
    return;
  }
  if (event.type === "browser-updated") {
    if (!deps.desktopEventMatchesActiveProject(event)) return;
    deps.setChatBrowserUserAction(chatBrowserUserActionForThread(event.state.userAction, deps.activeThreadIdRef.current));
    deps.setBrowserRevision((revision) => revision + 1);
    return;
  }
  if (event.type === "tool-event") {
    if (!deps.desktopEventMatchesActiveProject(event)) return;
    const baseLabel =
      event.details?.pluginName && event.details.toolName
        ? `${event.details.pluginName}: ${event.details.toolName}`
        : event.label || "tool";
    const label = event.artifactPath ? `${baseLabel} for ${event.artifactPath}` : baseLabel;
    const argumentStatus = event.details?.toolArgumentProgress?.uiStatus;
    const toolActivityMessage = toolEventActivityMessage(event.details);
    if (event.status === "running")
      deps.appendRunActivityLine(toolActivityMessage ?? argumentStatus ?? `Running ${label}.`, "tool", {}, event.threadId);
    if (event.status === "done") deps.appendRunActivityLine(`${label} completed.`, "tool", {}, event.threadId);
    if (event.status === "error") deps.appendRunActivityLine(`${label} failed.`, "error", {}, event.threadId);
    if (event.status === "done" || event.status === "error") {
      deps.setWorkspaceRevision((revision) => revision + 1);
      if (toolEventCouldAffectSpeechProviderState(event.details)) {
        deps.scheduleVoiceProviderRefresh(500, `provider state tool ${event.status}`);
        deps.scheduleSttProviderRefresh(500, `provider state tool ${event.status}`);
      }
    }
    return;
  }
  if (event.type === "orchestration-updated") {
    if (!deps.desktopEventMatchesActiveProject(event)) return;
    deps.setOrchestrationRevision((revision) => revision + 1);
    return;
  }
  if (event.type === "orchestration-auto-dispatch-updated") {
    if (!deps.desktopEventMatchesActiveProject(event)) return;
    deps.setOrchestrationAutoRevision((revision) => revision + 1);
    return;
  }
  if (event.type === "workflow-updated") {
    if (!deps.desktopEventMatchesActiveProject(event)) return;
    deps.setWorkflowRevision((revision) => revision + 1);
    return;
  }
  if (event.type === "workflow-discovery-progress") {
    if (!deps.desktopEventMatchesActiveProject(event)) return;
    deps.setWorkflowDiscoveryProgress(event.progress);
    deps.setSelectedWorkflowAgentThreadId((current) => current ?? event.progress.workflowThreadId);
    if (event.progress.phase !== "model" || event.progress.status !== "running") deps.setWorkflowRevision((revision) => revision + 1);
    return;
  }
  if (event.type === "workflow-exploration-progress") {
    if (!deps.desktopEventMatchesActiveProject(event)) return;
    deps.setWorkflowExplorationProgressByThreadId((current) => ({ ...current, [event.progress.workflowThreadId]: event.progress }));
    deps.setSelectedWorkflowAgentThreadId((current) => current ?? event.progress.workflowThreadId);
    return;
  }
  if (event.type === "workflow-compile-progress") {
    if (!deps.desktopEventMatchesActiveProject(event)) return;
    deps.setWorkflowCompileProgress((current) => coalesceWorkflowCompileProgress(current, event.progress));
    return;
  }
  if (event.type === "workflow-run-started") {
    if (!deps.desktopEventMatchesActiveProject(event)) return;
    if (event.workflowThreadId) deps.setSelectedWorkflowAgentThreadId(event.workflowThreadId);
    deps.setWorkflowRevision((revision) => revision + 1);
    return;
  }
  if (
    event.type === "message-created" &&
    deps.desktopEventMatchesActiveProject(event) &&
    event.message.threadId === deps.activeThreadIdRef.current
  ) {
    deps.messageKindsRef.current[event.message.id] = messageKindForActivity(event.message);
    if (isGoalCompletionMessage(event.message)) {
      deps.appendRunActivityLine("Goal completed and cleared.", "state", { dedupe: false });
      deps.triggerGoalCompletionCelebration(event.message.id);
    } else if (event.message.metadata?.kind === "thinking") deps.appendRunActivityLine("Receiving Ambient reasoning.", "thinking");
    else if (event.message.role === "assistant" && !event.message.content.trim())
      deps.appendRunActivityLine("Ambient response channel opened.");
  }
  if (event.type === "message-delta") {
    if (!deps.desktopEventMatchesActiveProject(event)) return;
    const kind = deps.messageKindsRef.current[event.messageId];
    if (kind === "thinking") deps.appendThinkingDeltaLine(event.messageId, event.delta);
    if (kind === "assistant") deps.appendRunActivityLine("Streaming response text.");
  }
  if (
    event.type === "message-updated" &&
    deps.desktopEventMatchesActiveProject(event) &&
    event.message.threadId === deps.activeThreadIdRef.current
  ) {
    deps.messageKindsRef.current[event.message.id] = messageKindForActivity(event.message);
    if (event.message.metadata?.kind === "thinking") {
      const thinkingText = thinkingActivityTextFromMessageContent(event.message.content);
      if (thinkingText) deps.appendRunActivityLine(thinkingText, "thinking", { dedupe: true });
    }
  }
  if (event.type === "stt-stop-tts-requested") {
    if (!event.workspacePath || event.workspacePath === deps.activeProjectRootRef.current) deps.setActiveVoiceMessageId(undefined);
    return;
  }
  if (!isAppDesktopEventStateReducerEvent(event)) return;
  deps.setState((current) =>
    reduceAppDesktopEventState({
      current,
      event,
      clearedGoalKeys: deps.clearedGoalKeysRef.current,
      desktopEventMatchesWorkspace: deps.desktopEventMatchesWorkspace,
    }),
  );
}
