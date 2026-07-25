import type { DesktopEvent } from "../../shared/desktopTypes";
import type { AmbientFeatureFlagSnapshot } from "../../shared/featureFlags";
import type { PermissionPromptResolution, PermissionRequest } from "../../shared/permissionTypes";
import type { ContextUsageSnapshot, ThreadSummary } from "../../shared/threadTypes";
import type { WorkflowPlanEditIntentKind } from "../../shared/workflowThreadPlanEdit";
import { AgentRuntimeActiveRunHandoffController } from "./agentRuntimeActiveRunHandoffController";
import type { AmbientCliSkillMountDiagnostics } from "./agentRuntimeAmbientCliSkillMount";
import {
  AgentRuntimeContextRecoveryController,
  type AgentRuntimeContextRecoveryCommitInput,
  type AgentRuntimeContextRecoverySession,
} from "./agentRuntimeContextRecoveryController";
import type { AgentRuntimeFeatures } from "./agentRuntimeFeatures";
import type { MutableTransientFileAuthorityRootStore } from "./agentRuntimeFileAuthority";
import { AgentRuntimeFileAuthorityController } from "./agentRuntimeFileAuthorityController";
import { AgentRuntimeGoalContinuationController } from "./agentRuntimeGoalContinuationController";
import type { LocalModelRuntimeManager } from "./agentRuntimeLocalRuntimeFacade";
import type { MessagingRemoteSurfaceCommandPendingProjectSwitch } from "./messaging/agentRuntimeMessagingRemoteSurfaceCommandApplyTools";
import type { AgentRuntimePiSession } from "./agentRuntimeSessionFactoryController";
import { AgentRuntimePlannerFinalizationController } from "./agentRuntimePlannerFinalizationController";
import { AgentRuntimePluginPermissionController } from "./agentRuntimePluginPermissionController";
import {
  AgentRuntimePromptExecutionController,
  type AgentRuntimePromptExecutionControllerOptions,
} from "./agentRuntimePromptExecutionController";
import {
  AgentRuntimePromptOutcomeController,
  type AgentRuntimePromptOutcomeCommitInput,
  type AgentRuntimePromptOutcomeControllerOptions,
} from "./agentRuntimePromptOutcomeController";
import { AgentRuntimeProviderRuntimeController } from "./agentRuntimeProviderRuntimeController";
import type { ProjectStore } from "./agentRuntimeProjectStoreFacade";
import { AgentRuntimeRemoteSurfaceRuntimeEventStore } from "./messaging/agentRuntimeRemoteSurfaceRuntimeEvents";
import { AgentRuntimeSendPreflightController } from "./agentRuntimeSendPreflightController";
import { AgentRuntimeSendPreparationController } from "./agentRuntimeSendPreparationController";
import { AgentRuntimeSessionRegistry } from "./agentRuntimeSessionRegistry";
import type { RuntimeAbortContextActiveRun } from "./runtimeAbortContext";
import type { RuntimePermissionWaitControl } from "./runtimePermissionWaitController";

type PiSession = AgentRuntimePiSession;

export interface AgentRuntimePromptPipelineControllerOptions {
  store: ProjectStore;
  features: AgentRuntimeFeatures;
  sessions: AgentRuntimeSessionRegistry<PiSession>;
  activeRuns: {
    has: (threadId: string) => boolean;
    set: (threadId: string, run: RuntimeAbortContextActiveRun) => unknown;
    delete: (threadId: string) => unknown;
  };
  activeRunIds: {
    get: (threadId: string) => string | undefined;
    set: (threadId: string, runId: string) => unknown;
    delete: (threadId: string) => unknown;
  };
  ambientCliSkillMountDiagnostics: Map<string, AmbientCliSkillMountDiagnostics>;
  localModelRuntimeManager: LocalModelRuntimeManager;
  providerRuntime: AgentRuntimeProviderRuntimeController;
  remoteSurfaceRuntimeEvents: AgentRuntimeRemoteSurfaceRuntimeEventStore;
  goalContinuations: AgentRuntimeGoalContinuationController;
  transientFileAuthorityRoots: MutableTransientFileAuthorityRootStore;
  permissionWaitControls: Map<string, RuntimePermissionWaitControl>;
  permissions: {
    request: (
      request: Omit<PermissionRequest, "id">,
      options?: { onRequest?: (request: PermissionRequest) => void },
    ) => Promise<PermissionPromptResolution>;
  };
  timeouts: {
    workflowRecordingReviewStreamIdleTimeoutMs: number;
    chatPiEmptyAssistantStallTimeoutMs: number;
    defaultInterruptedToolCallRecoveryMaxRetries: number;
    localToolIdleTimeoutMs: () => number;
  };
  callbacks: {
    applyThreadModelSettings: (threadId: string) => Promise<unknown>;
    clearWorkflowPlanEditIntent: (threadId: string) => void;
    commitThreadPiSessionFile: (
      input: AgentRuntimeContextRecoveryCommitInput | AgentRuntimePromptOutcomeCommitInput,
    ) => Promise<ThreadSummary | undefined>;
    completePendingProjectSwitch: (
      projectSwitch: MessagingRemoteSurfaceCommandPendingProjectSwitch,
      input: { threadId: string; workspacePath: string },
    ) => unknown;
    currentFeatureFlagSnapshot: () => AmbientFeatureFlagSnapshot;
    emit: (event: DesktopEvent) => void;
    generateTitleIfNeeded: (thread: ThreadSummary, prompt: string) => void;
    getRunRecord: (runId: string) => ReturnType<ProjectStore["getRunRecord"]> | undefined;
    getSession: (thread: ThreadSummary) => Promise<PiSession>;
    preflightBeforePrompt: AgentRuntimePromptExecutionControllerOptions<PiSession>["preflightBeforePrompt"];
    abortSessionRun: AgentRuntimePromptExecutionControllerOptions<PiSession>["abortSessionRun"];
    recordContextUsageSnapshot: (threadId: string, session: PiSession, message?: string) => ContextUsageSnapshot;
    refreshBrowsersForArtifactChange: (threadId: string, workspacePath: string, artifactPath: string) => Promise<void>;
    resolveCallableWorkflowFinalizationBlock: AgentRuntimePromptOutcomeControllerOptions["resolveCallableWorkflowFinalizationBlock"];
    resolveSubagentFinalizationBlock: AgentRuntimePromptOutcomeControllerOptions["resolveSubagentFinalizationBlock"];
    recordCallableWorkflowFinalizationBlockedParentMailbox: AgentRuntimePromptOutcomeControllerOptions["recordCallableWorkflowFinalizationBlockedParentMailbox"];
    recordSubagentFinalizationBlockedParentMailbox: AgentRuntimePromptOutcomeControllerOptions["recordSubagentFinalizationBlockedParentMailbox"];
    send: AgentRuntimePromptOutcomeControllerOptions["send"];
    setWorkflowPlanEditIntent: (threadId: string, intent: WorkflowPlanEditIntentKind, workflowThreadId: string) => void;
    suppressCallableWorkflowParentAssistantMessages: AgentRuntimePromptOutcomeControllerOptions["suppressCallableWorkflowParentAssistantMessages"];
    takePendingProjectSwitch: (threadId: string) => unknown;
    deletePendingProjectSwitch: (threadId: string) => void;
  };
}

export function createAgentRuntimePromptPipelineControllers({
  activeRunIds,
  activeRuns,
  ambientCliSkillMountDiagnostics,
  callbacks,
  features,
  goalContinuations,
  localModelRuntimeManager,
  permissionWaitControls,
  permissions,
  providerRuntime,
  remoteSurfaceRuntimeEvents,
  sessions,
  store,
  timeouts,
  transientFileAuthorityRoots,
}: AgentRuntimePromptPipelineControllerOptions) {
  const contextRecovery = new AgentRuntimeContextRecoveryController({
    store,
    hasActiveRun: (threadId) => activeRuns.has(threadId),
    getActiveSession: (threadId) => sessions.get(threadId) as AgentRuntimeContextRecoverySession | undefined,
    deleteActiveSession: (threadId) => sessions.delete(threadId),
    getSession: async (thread) => callbacks.getSession(thread) as Promise<AgentRuntimeContextRecoverySession>,
    commitThreadPiSessionFile: (input) => callbacks.commitThreadPiSessionFile(input),
    ambientCliSkillMountForThread: (threadId) => ambientCliSkillMountDiagnostics.get(threadId),
    resolveModelRuntimeProfile: (modelId) => features.modelRuntime?.resolveModelRuntimeProfile?.(modelId),
    emit: (event) => callbacks.emit(event),
  });
  const plannerFinalization = new AgentRuntimePlannerFinalizationController({
    store,
    durableBrowserValidator: features.planner?.durableBrowserValidator,
    refreshBrowsersForArtifactChange: (threadId, workspacePath, artifactPath) =>
      callbacks.refreshBrowsersForArtifactChange(threadId, workspacePath, artifactPath),
    send: (followUp) => callbacks.send(followUp),
    emit: (event) => callbacks.emit(event),
  });
  const sendPreparation = new AgentRuntimeSendPreparationController({
    store,
    getFeatureFlagSnapshot: () => callbacks.currentFeatureFlagSnapshot(),
    readSearchSettings: () => features.search?.readSettings(),
    plannerFinalizationSourceArtifactsForPrompt: (threadId, prompt) =>
      plannerFinalization.plannerFinalizationSourceArtifactsForPrompt(threadId, prompt),
    deletePendingProjectSwitch: (threadId) => callbacks.deletePendingProjectSwitch(threadId),
    setWorkflowPlanEditIntent: (threadId, intent, workflowThreadId) =>
      callbacks.setWorkflowPlanEditIntent(threadId, intent, workflowThreadId),
    generateTitleIfNeeded: (thread, prompt) => callbacks.generateTitleIfNeeded(thread, prompt),
    emit: (event) => callbacks.emit(event),
    workflowRecordingReviewStreamIdleTimeoutMs: timeouts.workflowRecordingReviewStreamIdleTimeoutMs,
    chatPiEmptyAssistantStallTimeoutMs: timeouts.chatPiEmptyAssistantStallTimeoutMs,
    defaultInterruptedToolCallRecoveryMaxRetries: timeouts.defaultInterruptedToolCallRecoveryMaxRetries,
    localToolIdleTimeoutMs: timeouts.localToolIdleTimeoutMs,
  });
  const sendPreflight = new AgentRuntimeSendPreflightController({
    store,
    features,
    fallbackRuntimeManager: localModelRuntimeManager,
    getFeatureFlagSnapshot: () => callbacks.currentFeatureFlagSnapshot(),
    setActiveRun: (threadId, run) => activeRuns.set(threadId, run as RuntimeAbortContextActiveRun),
    deleteActiveRun: (threadId) => {
      activeRuns.delete(threadId);
    },
    setActiveRunId: (threadId, runId) => {
      activeRunIds.set(threadId, runId);
    },
    deleteActiveRunId: (threadId) => {
      activeRunIds.delete(threadId);
    },
    emit: (event) => callbacks.emit(event),
  });
  const activeRunHandoff = new AgentRuntimeActiveRunHandoffController({
    store,
    getFeatureFlagSnapshot: () => callbacks.currentFeatureFlagSnapshot(),
    applyThreadModelSettings: (threadId) => callbacks.applyThreadModelSettings(threadId),
    resolveModelRuntimeProfile: (modelId) => sendPreflight.resolveMainModelRuntimeProfile(modelId),
    modelContentForSendInput: (activeRunInput) => sendPreparation.modelContentForSendInput(activeRunInput),
    emit: (event) => callbacks.emit(event),
  });
  const promptOutcomes = new AgentRuntimePromptOutcomeController({
    getThread: (threadId) => store.getThread(threadId),
    updateThreadSettings: (threadId, settings) => store.updateThreadSettings(threadId, settings),
    replaceMessage: (messageId, content, metadata) => store.replaceMessage(messageId, content, metadata),
    commitThreadPiSessionFile: (input) => callbacks.commitThreadPiSessionFile(input),
    recordContextUsageSnapshot: (threadId, session) => callbacks.recordContextUsageSnapshot(threadId, session as PiSession),
    createPlannerPlanArtifactFromMessage: (message, options) =>
      plannerFinalization.createPlannerPlanArtifactFromMessage(message, options),
    resolveSubagentFinalizationBlock: (threadId, runId) => callbacks.resolveSubagentFinalizationBlock(threadId, runId),
    resolveCallableWorkflowFinalizationBlock: (threadId, runId, verifiedLaunch) =>
      callbacks.resolveCallableWorkflowFinalizationBlock(threadId, runId, verifiedLaunch),
    recordSubagentFinalizationBlockedParentMailbox: (threadId, runId, block) =>
      callbacks.recordSubagentFinalizationBlockedParentMailbox(threadId, runId, block),
    recordCallableWorkflowFinalizationBlockedParentMailbox: (threadId, runId, block) =>
      callbacks.recordCallableWorkflowFinalizationBlockedParentMailbox(threadId, runId, block),
    suppressCallableWorkflowParentAssistantMessages: (block, options) =>
      callbacks.suppressCallableWorkflowParentAssistantMessages(block, options),
    recordVoiceDispatch: (message) => providerRuntime.recordVoiceDispatch(message),
    clearActiveRun: (threadId) => {
      activeRuns.delete(threadId);
    },
    clearActiveRunId: (threadId) => {
      activeRunIds.delete(threadId);
    },
    clearPermissionWaitControl: (threadId) => {
      permissionWaitControls.delete(threadId);
    },
    clearWorkflowPlanEditIntent: (threadId) => callbacks.clearWorkflowPlanEditIntent(threadId),
    takePendingProjectSwitch: (threadId) => callbacks.takePendingProjectSwitch(threadId),
    updateRuntimeEvent: (eventId, patch) => remoteSurfaceRuntimeEvents.update(eventId, patch),
    scheduleProjectSwitchCompletion: (projectSwitch, switchInput) => {
      setTimeout(() => {
        void callbacks.completePendingProjectSwitch(projectSwitch as MessagingRemoteSurfaceCommandPendingProjectSwitch, switchInput);
      }, 0);
    },
    getRunRecord: (runId) => callbacks.getRunRecord(runId),
    accountFinishedGoalRun: (input) => goalContinuations.accountFinishedGoalRun(input),
    scheduleGoalContinuation: (threadId, goalId, delayMs) => goalContinuations.scheduleGoalContinuation(threadId, goalId, delayMs),
    schedulePlannerDurableRepairFollowUp: (followUp, workspacePath) =>
      plannerFinalization.schedulePlannerDurableRepairFollowUp(followUp, workspacePath),
    send: (followUp, followUpHooks) => callbacks.send(followUp, followUpHooks),
    emitError: (message, threadId, workspacePath) => callbacks.emit({ type: "error", message, threadId, workspacePath }),
    learnProviderContextLimit: features.modelRuntime?.learnProviderContextLimit,
  });
  const promptExecutions = new AgentRuntimePromptExecutionController<PiSession>({
    preflightBeforePrompt: (preflightInput) => callbacks.preflightBeforePrompt(preflightInput),
    abortSessionRun: (executionSession, threadId) => callbacks.abortSessionRun(executionSession, threadId),
    removeActiveSessionIfCurrent: (threadId, executionSession) => {
      if (sessions.get(threadId) === executionSession) sessions.delete(threadId);
    },
    recordContextUsageSnapshot: (threadId, executionSession, snapshotMessage) =>
      callbacks.recordContextUsageSnapshot(threadId, executionSession, snapshotMessage),
    refreshBrowsersForArtifactChange: (threadId, workspacePath, artifactPath) =>
      callbacks.refreshBrowsersForArtifactChange(threadId, workspacePath, artifactPath),
  });
  const fileAuthority = new AgentRuntimeFileAuthorityController({
    store,
    transientRoots: transientFileAuthorityRoots,
    requestPermission: (request, options) => permissions.request(request, options),
    beginPermissionWait: (threadId, wait) => permissionWaitControls.get(threadId)?.begin(wait),
    activeRunId: (threadId) => activeRunIds.get(threadId),
    emit: (event) => callbacks.emit(event),
  });
  const pluginPermissions = new AgentRuntimePluginPermissionController({
    store,
    requestPermission: (request, options) => permissions.request(request, options),
    beginPermissionWait: (threadId, wait) => permissionWaitControls.get(threadId)?.begin(wait),
    activeRunId: (threadId) => activeRunIds.get(threadId),
    emit: (event) => callbacks.emit(event),
  });

  return {
    activeRunHandoff,
    contextRecovery,
    fileAuthority,
    plannerFinalization,
    pluginPermissions,
    promptExecutions,
    promptOutcomes,
    sendPreflight,
    sendPreparation,
  };
}

export type AgentRuntimePromptPipelineControllers = ReturnType<typeof createAgentRuntimePromptPipelineControllers>;
