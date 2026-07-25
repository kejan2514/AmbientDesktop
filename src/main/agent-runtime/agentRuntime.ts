import type { BrowserWindow } from "electron";
import type { WorkflowPlanEditIntentKind } from "../../shared/workflowThreadPlanEdit";
import type { AgentRuntimeFeatures } from "./agentRuntimeFeatures";
import { abortSessionRun as abortPiSessionRun, type PiSessionFileCommitReason } from "./agentRuntimeSessionFacade";
import { commitAgentRuntimeThreadPiSessionFile } from "./agentRuntimeSessionFileCommit";
import type { DesktopEvent, CompactThreadInput, SendMessageInput, RecoverThreadContextInput } from "../../shared/desktopTypes";
import type { PermissionMode } from "../../shared/permissionTypes";
import type {
  CancelCallableWorkflowTaskInput,
  PauseCallableWorkflowTaskInput,
  CallableWorkflowTaskSummary,
  ResumeCallableWorkflowTaskInput,
} from "../../shared/workflowTypes";
import type {
  CancelSubagentRunInput,
  CloseSubagentRunInput,
  ResolveSubagentWaitBarrierInput,
  SubagentRunSummary,
  SubagentWaitBarrierResolutionResult,
} from "../../shared/subagentTypes";
import type { LocalModelRuntimeLifecycleActionInput, LocalModelRuntimeLifecycleActionResult } from "../../shared/localRuntimeTypes";
import type { ContextUsageSnapshot, ModelRuntimeSettings, ThreadSummary } from "../../shared/threadTypes";
import { resolveAmbientFeatureFlags, type AmbientFeatureFlagSnapshot } from "../../shared/featureFlags";
import type { AgentMemoryRuntimeSnapshot } from "../../shared/agentMemoryDiagnostics";
import type { AgentRuntimeContextRecoverySession } from "./agentRuntimeContextRecoveryController";
import type { RuntimeSessionRecoveryContext } from "./agentRuntimeAssistantRetryInput";
import {
  createAgentRuntimeControllerInitializer,
  type AgentRuntimeControllerRegistry,
  type AgentRuntimePermissionBridge,
} from "./agentRuntimeControllerInitializer";
import type { ProjectStore } from "./agentRuntimeProjectStoreFacade";
import { AmbientPluginHost, type PluginMcpRuntimeSnapshot } from "./agentRuntimePluginsFacade";
import { AmbientDownloadService } from "./agentRuntimeAmbientFacade";
import { AmbientCliPackageDescriptionState } from "./ambient-cli-package/agentRuntimeAmbientCliPackageDescriptionState";
import { workflowRecordingReviewSendInputForThread } from "./workflow-support/agentRuntimeWorkflowRecordingReviewRequest";
import { createAgentRuntimeDesktopEventCoalescer, type AgentRuntimeDesktopEventCoalescer } from "./agentRuntimeDesktopEventEmit";
import { AgentRuntimeSessionRegistry } from "./agentRuntimeSessionRegistry";
import type { AgentRuntimePiSession } from "./agentRuntimeSessionFactoryController";
import { type SubagentChildExecutionRecord } from "./agentRuntimeSubagentChildLifecycleCoordinator";
import type { RuntimeSendMessageInput } from "./agentRuntimeSendPreparationController";
import { type AmbientCliSkillMountDiagnostics } from "./agentRuntimeAmbientCliSkillMount";
import { AgentRuntimeInstallRouteGuard } from "./agentRuntimeInstallRouteGuard";
import { LocalModelRuntimeManager, type LocalModelRuntimeStatusSnapshot } from "./agentRuntimeLocalRuntimeFacade";
import { AmbientWorkflowDescriptionState } from "./ambient-workflow/agentRuntimeAmbientWorkflowDescriptionState";
import { generateAgentRuntimeThreadTitleIfNeeded } from "./agentRuntimeThreadTitleGeneration";
import {
  BrowserCredentialStore,
  BrowserService,
  LocalPreviewServerManager,
  refreshExternalFileBrowserTabs,
} from "./agentRuntimeBrowserFacade";
import { refreshAgentRuntimeBrowsersForArtifactChange } from "./browser-tools/agentRuntimeBrowserRefresh";
import type { GlmTokenizerStatus } from "./agentRuntimeTokenizationFacade";
import { type TransientFileAuthorityRoot } from "./agentRuntimeFileAuthority";
import { type RuntimePermissionWaitControl } from "./runtimePermissionWaitController";
import type { RuntimeAbortContextActiveRun } from "./runtimeAbortContext";
import { POST_TOOL_ABORT_GRACE_MS, runAgentRuntimeSendOrchestrator, type AgentRuntimeSendHooks } from "./agentRuntimeSendOrchestrator";
import type { SymphonyParentModePolicy, SymphonyParentModeVerifiedLaunch } from "./agentRuntimeSymphonyParentMode";

export type { AgentRuntimeSendHooks } from "./agentRuntimeSendOrchestrator";

export {
  buildRuntimeProviderFailureDiagnostic,
  isAmbientProviderAuthFailure,
  runtimeProviderErrorDiagnostic,
  runtimeProviderFailureIdleSource,
} from "./provider-continuation/agentRuntimeProviderDiagnostics";
export type {
  PiStreamTraceReference,
  RuntimeProviderErrorDiagnostic,
  RuntimeProviderFailureDiagnostic,
  RuntimeProviderFailureIdleSource,
} from "./provider-continuation/agentRuntimeProviderDiagnostics";

type PiSession = AgentRuntimePiSession;

export type { AgentRuntimeGoogleWorkspaceTools } from "./agentRuntimeGoogleWorkspaceFacade";

type ActiveRun = RuntimeAbortContextActiveRun;

export const RUNTIME_RESET_INTERRUPTED_RUN_MESSAGE = "Run interrupted because the Ambient runtime reset before this turn finished.";
export const WORKSPACE_SWITCH_INTERRUPTED_RUN_MESSAGE =
  "Run interrupted because the active project changed before Ambient finished this turn.";

export {
  browserUserActionContinuationLinesFromToolContent,
  createPostToolContinuationRequest,
  postToolIdleContinuationPrompt,
  privilegedContinuationLinesFromToolContent,
  shouldDeliverPostToolContinuation,
  validatePostToolContinuationRequest,
} from "./post-tool/postToolContinuationScheduler";
export { ambientMcpBridgeActiveToolNamesForRecoveredTranscript } from "./mcp/agentRuntimeMcpRecoveredTranscript";
export { PLANNER_MODE_SYSTEM_PROMPT } from "./agentRuntimePlannerModeExtension";
export { localDeepResearchComposerPrompt, symphonyWorkflowComposerPrompt } from "./agentRuntimeComposerIntent";
export { piRetryOverridesFromModelRuntimeSettings, type PiRetryOverrides } from "./agentRuntimeRetrySettings";
export {
  hasRuntimeThreadSettingsUpdate,
  runtimeThreadSettingsUpdateFromSendInput,
  type RuntimeThreadSettingsUpdate,
} from "./agentRuntimeThreadSettingsUpdate";

export class AgentRuntime {
  private activeRuns = new Map<string, ActiveRun>();
  private activeRunIds = new Map<string, string>();
  private subagentChildExecutions = new Map<string, SubagentChildExecutionRecord>();
  private callableWorkflowTaskAbortControllers = new Map<string, AbortController>();
  private callableWorkflowRunTaskIds = new Map<string, string>();
  private workflowPlanEditIntentByThreadId = new Map<string, WorkflowPlanEditIntentKind>();
  private workflowPlanEditWorkflowThreadByThreadId = new Map<string, string>();
  private readonly sessions = new AgentRuntimeSessionRegistry<PiSession>();
  private readonly ambientCliSkillMountDiagnostics = new Map<string, AmbientCliSkillMountDiagnostics>();
  private readonly ambientCliPackageDescriptionState = new AmbientCliPackageDescriptionState();
  private readonly ambientWorkflowDescriptionState = new AmbientWorkflowDescriptionState();
  private readonly controllers: AgentRuntimeControllerRegistry;
  private readonly pluginHost = new AmbientPluginHost();
  private readonly localPreviewServers = new LocalPreviewServerManager();
  private readonly downloadService = new AmbientDownloadService();
  private readonly localModelRuntimeManager = new LocalModelRuntimeManager();
  private readonly permissionWaitControls = new Map<string, RuntimePermissionWaitControl>();
  private readonly installRouteGuard = new AgentRuntimeInstallRouteGuard();
  private readonly transientFileAuthorityRoots = new Map<string, TransientFileAuthorityRoot[]>();
  private readonly tencentMemoryRuntimeSnapshots = new Map<string, AgentMemoryRuntimeSnapshot>();
  private readonly sessionWarmups = new Map<string, Promise<void>>();
  private readonly warmedSessionPermissionModeByThreadId = new Map<string, PermissionMode>();
  private sessionWarmupGeneration = 0;
  private readonly desktopEventCoalescer: AgentRuntimeDesktopEventCoalescer;
  private lastRendererSendFailureAt = 0;

  constructor(
    private readonly store: ProjectStore,
    private readonly browser: BrowserService,
    private readonly browserCredentials: BrowserCredentialStore,
    private readonly getWindow: () => BrowserWindow | undefined,
    private readonly permissions: AgentRuntimePermissionBridge,
    private readonly features: AgentRuntimeFeatures = {},
  ) {
    this.desktopEventCoalescer = createAgentRuntimeDesktopEventCoalescer({
      getWindow: () => this.getWindow(),
      store: this.store,
      lastRendererSendFailureAt: () => this.lastRendererSendFailureAt,
      setLastRendererSendFailureAt: (value) => {
        this.lastRendererSendFailureAt = value;
      },
    });
    this.controllers = createAgentRuntimeControllerInitializer({
      store: this.store,
      browser: this.browser,
      browserCredentials: this.browserCredentials,
      permissions: this.permissions,
      features: this.features,
      sessions: this.sessions,
      activeRuns: this.activeRuns,
      activeRunIds: this.activeRunIds,
      subagentChildExecutions: this.subagentChildExecutions,
      callableWorkflowTaskAbortControllers: this.callableWorkflowTaskAbortControllers,
      callableWorkflowRunTaskIds: this.callableWorkflowRunTaskIds,
      workflowPlanEditIntentByThreadId: this.workflowPlanEditIntentByThreadId,
      workflowPlanEditWorkflowThreadByThreadId: this.workflowPlanEditWorkflowThreadByThreadId,
      ambientCliSkillMountDiagnostics: this.ambientCliSkillMountDiagnostics,
      ambientCliPackageDescriptionState: this.ambientCliPackageDescriptionState,
      ambientWorkflowDescriptionState: this.ambientWorkflowDescriptionState,
      tencentMemoryRuntimeSnapshots: this.tencentMemoryRuntimeSnapshots,
      localPreviewServers: this.localPreviewServers,
      downloadService: this.downloadService,
      pluginHost: this.pluginHost,
      permissionWaitControls: this.permissionWaitControls,
      localModelRuntimeManager: this.localModelRuntimeManager,
      installRouteGuard: this.installRouteGuard,
      transientFileAuthorityRoots: this.transientFileAuthorityRoots,
      callbacks: {
        abortChildThread: this.abort.bind(this),
        abortSessionRun: (session, threadId) => this.abortSessionRunForThread(session, threadId),
        applyThreadModelSettings: (threadId) => this.applyThreadModelSettings(threadId),
        commitThreadPiSessionFile: (input) => this.commitThreadPiSessionFile(input),
        createCallableWorkflowToolExtension: (
          threadId,
          workspace,
          initialRecordedWorkflowPlaybooks = [],
          childCallableWorkflowToolNames = [],
          symphonyParentModePolicy,
          symphonyParentModeVerifiedLaunch,
        ) =>
          this.controllers.callableWorkflows.createToolExtension(
            threadId,
            workspace,
            initialRecordedWorkflowPlaybooks,
            childCallableWorkflowToolNames,
            symphonyParentModePolicy,
            symphonyParentModeVerifiedLaunch,
          ),
        createInterruptedToolCallRecoveryToolExtension: (threadId, workspace) =>
          this.controllers.toolPermissions.createInterruptedToolCallRecoveryToolExtension(threadId, workspace),
        createPermissionGateExtension: (threadId, workspace) =>
          this.controllers.toolPermissions.createPermissionGateExtension(threadId, workspace),
        createSubagentToolExtension: (threadId, pluginMcpTools) =>
          this.controllers.subagentToolExtensions.createToolExtension(threadId, pluginMcpTools),
        currentFeatureFlagSnapshot: () => this.currentFeatureFlagSnapshot(),
        emit: (event) => this.emit(event),
        emitBrowserState: () => this.controllers.browserTools.emitBrowserState(),
        emitCallableWorkflowTaskUpdated: (task) => this.emit({ type: "callable-workflow-task-updated", task }),
        ensurePluginMcpToolTrusted: (threadId, workspace, registration) =>
          this.controllers.pluginPermissions.ensurePluginMcpToolTrusted(threadId, workspace, registration),
        fileAuthorityRootPathsForThread: (threadId, access) =>
          this.controllers.toolPermissions.fileAuthorityRootPathsForThread(threadId, access),
        generateTitleIfNeeded: (thread, prompt) => this.generateTitleIfNeeded(thread, prompt),
        getSession: (thread, recovery, symphonyParentModePolicy, symphonyParentModeVerifiedLaunch) =>
          this.getSession(thread, recovery, symphonyParentModePolicy, symphonyParentModeVerifiedLaunch),
        includeWorkspaceRootAuthorityForThread: (threadId) =>
          this.controllers.toolPermissions.includeWorkspaceRootAuthorityForThread(threadId),
        markPluginToolsStale: (threadId) => this.markPluginToolsStale(threadId),
        prepareBrowserToolProfile: (input, sourceThreadId, onUpdate) =>
          this.controllers.browserTools.prepareBrowserToolProfile(input, sourceThreadId, onUpdate),
        prepareSubagentChildWorktree: (run) => this.controllers.subagentToolExtensions.prepareChildWorktree(run),
        recordBrowserAudit: (threadId, toolName, risk, detail) =>
          this.controllers.browserTools.recordBrowserAudit(threadId, toolName, risk, detail),
        recordCallableWorkflowFinalizationBlockedParentMailbox: (threadId, runId, block) =>
          this.controllers.finalizationCoordinator.recordCallableWorkflowFinalizationBlockedParentMailbox(threadId, runId, block),
        recordContextUsageSnapshot: (threadId, session, message) =>
          this.controllers.contextRecovery.recordContextUsageSnapshot(threadId, session as AgentRuntimeContextRecoverySession, message),
        recordSubagentFinalizationBlockedParentMailbox: (threadId, runId, block) =>
          this.controllers.finalizationCoordinator.recordSubagentFinalizationBlockedParentMailbox(threadId, runId, block),
        refreshBrowsersForArtifactChange: (threadId, workspacePath, artifactPath) =>
          this.refreshBrowsersForArtifactChange(threadId, workspacePath, artifactPath),
        requestFileAuthorityForThread: (threadId, workspace, request) =>
          this.controllers.toolPermissions.requestFileAuthorityForThread(threadId, workspace, request),
        resolveCallableWorkflowFinalizationBlock: (threadId, runId, verifiedLaunch) =>
          this.controllers.finalizationCoordinator.callableWorkflowFinalizationBlock(threadId, runId, verifiedLaunch),
        resolveFirstPartyPluginPermission: (input) => this.controllers.pluginPermissions.resolveFirstPartyPluginPermission(input),
        resolveLocalRuntimeOwnershipForForcedAction: (request) => this.controllers.localRuntimeOwnership.resolveForForcedAction(request),
        resolveLocalRuntimeOwnershipForRestartPlan: (plan) => this.controllers.localRuntimeOwnership.resolveForRestartPlan(plan),
        resolveLocalRuntimeOwnershipForStopPlan: (plan) => this.controllers.localRuntimeOwnership.resolveForStopPlan(plan),
        resolveSubagentFinalizationBlock: (threadId, runId) =>
          this.controllers.finalizationCoordinator.subagentFinalizationBarrierBlock(threadId, runId),
        resolveSubagentModelRuntimeProfile: (modelId) => this.controllers.subagentToolExtensions.resolveModelRuntimeProfile(modelId),
        resolveToolCallPermission: (threadId, workspace, toolName, rawToolInput) =>
          this.controllers.toolPermissions.resolveToolCallPermission(threadId, workspace, toolName, rawToolInput),
        revokeMcpPermissionGrantsForDescriptorDrift: (input) =>
          this.controllers.pluginPermissions.revokeMcpPermissionGrantsForDescriptorDrift(input),
        revokePluginGrantsForLabels: (labelPrefixes) => this.controllers.pluginPermissions.revokePluginGrantsForLabels(labelPrefixes),
        runCapabilityBuilderValidationWithPermission: (input) =>
          this.controllers.pluginSetupTools.runCapabilityBuilderValidationWithPermission(input),
        send: (input, hooks) => this.send(input, hooks),
        suppressCallableWorkflowParentAssistantMessages: (block, options) =>
          this.controllers.finalizationCoordinator.suppressCallableWorkflowParentAssistantMessages(block, options),
        tryRouteBrowserContentThroughScrapling: (input) => this.controllers.webResearch.tryRouteBrowserContentThroughScrapling(input),
        unavailableContextUsageSnapshot: (thread, message) =>
          this.controllers.contextRecovery.unavailableContextUsageSnapshot(thread, message),
      },
    });
  }

  private currentFeatureFlagSnapshot(): AmbientFeatureFlagSnapshot {
    return this.features.featureFlags?.readSnapshot() ?? resolveAmbientFeatureFlags({ settings: this.store.getFeatureFlagSettings() });
  }

  private async commitThreadPiSessionFile(input: {
    threadId: string;
    sessionFile?: string;
    currentPiSessionFile?: string | null;
    reason: PiSessionFileCommitReason;
    emit: (event: DesktopEvent) => void;
  }): Promise<ThreadSummary | undefined> {
    return commitAgentRuntimeThreadPiSessionFile(input, {
      updateThreadSettings: (threadId, settings) => this.store.updateThreadSettings(threadId, settings),
    });
  }

  private async abortSessionRunForThread(session: PiSession, threadId: string): Promise<void> {
    await abortPiSessionRun(session, {
      graceMs: POST_TOOL_ABORT_GRACE_MS,
      onStalled: () => this.sessions.delete(threadId),
    });
  }

  async requestWorkflowRecordingReview(input: { threadId: string; feedback?: string }): Promise<void> {
    const thread = this.store.getThread(input.threadId);
    const reviewInput: RuntimeSendMessageInput = workflowRecordingReviewSendInputForThread(thread, {
      feedback: input.feedback,
    });
    await this.send(reviewInput);
  }

  async warmThreadSession(threadId: string, options: { reason?: string } = {}): Promise<void> {
    if (this.activeRuns.has(threadId) || this.sessions.get(threadId)) return;
    const existingWarmup = this.sessionWarmups.get(threadId);
    if (existingWarmup) return existingWarmup;

    const warmup = this.createThreadSessionWarmup(threadId, this.sessionWarmupGeneration);
    this.sessionWarmups.set(threadId, warmup);
    try {
      await warmup;
    } finally {
      if (this.sessionWarmups.get(threadId) === warmup) this.sessionWarmups.delete(threadId);
    }
  }

  warmThreadSessionInBackground(threadId: string, options: { reason?: string } = {}): void {
    void this.warmThreadSession(threadId, options).catch((error) => {
      const reason = options.reason ? ` for ${options.reason}` : "";
      console.warn(`[agent-runtime] Failed to warm thread session${reason}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async createThreadSessionWarmup(threadId: string, generation: number): Promise<void> {
    if (this.activeRuns.has(threadId) || this.sessions.get(threadId)) return;
    const thread = this.store.getThread(threadId);
    if (thread.kind === "subagent_child" || this.activeRuns.has(threadId) || this.sessions.get(threadId)) return;
    if (generation !== this.sessionWarmupGeneration) return;
    const session = await this.controllers.sessionFactory.getSession(thread);
    if (generation !== this.sessionWarmupGeneration && this.sessions.get(threadId) === session) {
      this.sessions.delete(threadId);
      this.warmedSessionPermissionModeByThreadId.delete(threadId);
      session.dispose();
      return;
    }
    this.warmedSessionPermissionModeByThreadId.set(threadId, thread.permissionMode);
  }

  private invalidateSessionWarmups(): void {
    this.sessionWarmupGeneration += 1;
    for (const threadId of this.warmedSessionPermissionModeByThreadId.keys()) {
      const session = this.sessions.get(threadId);
      if (session) {
        this.sessions.delete(threadId);
        session.dispose();
      }
    }
    this.warmedSessionPermissionModeByThreadId.clear();
  }

  private async getSession(
    thread: ThreadSummary,
    recovery?: RuntimeSessionRecoveryContext,
    symphonyParentModePolicy?: SymphonyParentModePolicy | undefined,
    symphonyParentModeVerifiedLaunch?: SymphonyParentModeVerifiedLaunch | undefined,
  ): Promise<PiSession> {
    const warmup = this.sessionWarmups.get(thread.id);
    if (warmup) {
      await warmup.catch(() => undefined);
    }
    let existingSession = this.sessions.get(thread.id);
    const warmedPermissionMode = this.warmedSessionPermissionModeByThreadId.get(thread.id);
    if (existingSession && warmedPermissionMode && warmedPermissionMode !== thread.permissionMode) {
      existingSession.dispose();
      this.sessions.delete(thread.id);
      this.warmedSessionPermissionModeByThreadId.delete(thread.id);
      existingSession = undefined;
    }
    if (recovery && existingSession) {
      existingSession.dispose();
      this.sessions.delete(thread.id);
      this.warmedSessionPermissionModeByThreadId.delete(thread.id);
    }
    const session = await this.controllers.sessionFactory.getSession(
      thread,
      recovery,
      symphonyParentModePolicy,
      symphonyParentModeVerifiedLaunch,
    );
    this.warmedSessionPermissionModeByThreadId.delete(thread.id);
    return session;
  }

  async send(input: SendMessageInput, hooks: AgentRuntimeSendHooks = {}): Promise<void> {
    await runAgentRuntimeSendOrchestrator<PiSession>({
      sendInput: input,
      hooks,
      store: this.store,
      activeRuns: this.activeRuns,
      activeRunIds: this.activeRunIds,
      sessions: this.sessions,
      permissionWaitControls: this.permissionWaitControls,
      permissions: this.permissions,
      activeRunHandoff: this.controllers.activeRunHandoff,
      sendPreparation: this.controllers.sendPreparation,
      sendPreflight: this.controllers.sendPreflight,
      promptExecutions: this.controllers.promptExecutions,
      promptOutcomes: this.controllers.promptOutcomes,
      subagentStopCascade: this.controllers.subagentStopCascade,
      getFeatureFlagSnapshot: () => this.currentFeatureFlagSnapshot(),
      createWorkflowRecordingReviewSession: (thread) => this.controllers.workflowRecordingReviewSessions.createSession(thread),
      getSession: (thread, recovery, symphonyParentModePolicy, symphonyParentModeVerifiedLaunch) =>
        this.getSession(thread, recovery, symphonyParentModePolicy, symphonyParentModeVerifiedLaunch),
      commitThreadPiSessionFile: (commitInput) => this.commitThreadPiSessionFile(commitInput),
      abortSessionRun: (session, threadId) => this.abortSessionRunForThread(session, threadId),
      emit: (event) => this.emit(event),
    });
  }

  continueGoalIfIdle(threadId: string, expectedGoalId: string, delayMs = 0): void {
    this.controllers.goalContinuations.continueGoalIfIdle(threadId, expectedGoalId, delayMs);
  }

  async abort(threadId: string, options: { skipSubagentChildCancellation?: boolean } = {}): Promise<void> {
    await this.controllers.runLifecycle.abort(threadId, options);
  }

  interruptActiveRuns(reason = RUNTIME_RESET_INTERRUPTED_RUN_MESSAGE): number {
    return this.controllers.runLifecycle.interruptActiveRuns(reason);
  }

  applyRuntimeSettings(settings: ModelRuntimeSettings): {
    disposedSessions: number;
    deferredSessions: number;
    disposedThreadIds: string[];
    deferredThreadIds: string[];
  } {
    this.invalidateSessionWarmups();
    return this.controllers.settingsSessions.applyRuntimeSettings(settings);
  }

  applyFeatureFlags(_snapshot: AmbientFeatureFlagSnapshot): {
    disposedSessions: number;
    deferredSessions: number;
    disposedThreadIds: string[];
    deferredThreadIds: string[];
  } {
    this.invalidateSessionWarmups();
    return this.controllers.settingsSessions.applyFeatureFlags(_snapshot);
  }

  applyMemorySettings(): {
    disposedSessions: number;
    deferredSessions: number;
    disposedThreadIds: string[];
    deferredThreadIds: string[];
  } {
    this.invalidateSessionWarmups();
    return this.controllers.settingsSessions.applyMemorySettings();
  }

  async applyThreadModelSettings(threadId: string): Promise<{
    switchedSessions: number;
    deferredSessions: number;
    switchedThreadIds: string[];
    deferredThreadIds: string[];
  }> {
    this.invalidateSessionWarmups();
    return this.controllers.settingsSessions.applyThreadModelSettings(threadId);
  }

  applyThreadMemorySettings(threadId: string): {
    disposedSessions: number;
    deferredSessions: number;
    disposedThreadIds: string[];
    deferredThreadIds: string[];
  } {
    this.invalidateSessionWarmups();
    return this.controllers.settingsSessions.applyThreadMemorySettings(threadId);
  }

  listAgentMemoryRuntimeSnapshots(): AgentMemoryRuntimeSnapshot[] {
    return this.controllers.settingsSessions.listAgentMemoryRuntimeSnapshots();
  }

  async getContextUsage(threadId: string): Promise<ContextUsageSnapshot> {
    return this.controllers.contextRecovery.getContextUsage(threadId);
  }

  async compactThread(input: CompactThreadInput): Promise<ContextUsageSnapshot> {
    return this.controllers.contextRecovery.compactThread(input);
  }

  async recoverThreadContext(input: RecoverThreadContextInput): Promise<ContextUsageSnapshot> {
    return this.controllers.contextRecovery.recoverThreadContext(input);
  }

  resetSessions(): void {
    this.invalidateSessionWarmups();
    this.controllers.runLifecycle.resetSessions();
  }

  async shutdownPluginMcpServers(): Promise<void> {
    await this.controllers.runLifecycle.shutdownPluginMcpServers();
  }

  pluginMcpRuntimeSnapshots(): PluginMcpRuntimeSnapshot[] {
    return this.controllers.runLifecycle.pluginMcpRuntimeSnapshots();
  }

  restartPluginMcpRuntime(key: string): Promise<PluginMcpRuntimeSnapshot[] | undefined> {
    return this.controllers.runLifecycle.restartPluginMcpRuntime(key);
  }

  stopPluginMcpRuntime(key: string): Promise<PluginMcpRuntimeSnapshot[] | undefined> {
    return this.controllers.runLifecycle.stopPluginMcpRuntime(key);
  }

  tokenizerStatus(): GlmTokenizerStatus {
    return this.controllers.glmTokenizer.getStatus();
  }

  private generateTitleIfNeeded(thread: ThreadSummary, prompt: string): void {
    generateAgentRuntimeThreadTitleIfNeeded({
      thread,
      prompt,
      workspaceName: this.store.getWorkspace().name,
      modelRuntimeSettings: this.store.getModelRuntimeSettings(),
      getThread: (threadId) => this.store.getThread(threadId),
      updateThreadTitle: (threadId, title) => this.store.updateThreadTitle(threadId, title),
      emit: (event) => this.emit(event),
    });
  }

  async resolveSubagentWaitBarrier(input: ResolveSubagentWaitBarrierInput): Promise<SubagentWaitBarrierResolutionResult> {
    return this.controllers.subagentActions.resolveWaitBarrier(input);
  }

  async cancelSubagentRun(input: CancelSubagentRunInput): Promise<SubagentRunSummary> {
    return this.controllers.subagentActions.cancelRun(input);
  }

  closeSubagentRun(input: CloseSubagentRunInput): SubagentRunSummary {
    return this.controllers.subagentActions.closeRun(input);
  }

  async cancelCallableWorkflowTask(input: CancelCallableWorkflowTaskInput): Promise<CallableWorkflowTaskSummary> {
    return this.controllers.callableWorkflows.cancelTask(input);
  }

  pauseCallableWorkflowTask(input: PauseCallableWorkflowTaskInput): CallableWorkflowTaskSummary {
    return this.controllers.callableWorkflows.pauseTask(input);
  }

  async resumeCallableWorkflowTask(input: ResumeCallableWorkflowTaskInput): Promise<CallableWorkflowTaskSummary> {
    return this.controllers.callableWorkflows.resumeTask(input);
  }

  private markPluginToolsStale(threadId: string): void {
    this.invalidateSessionWarmups();
    this.sessions.markPluginToolsStale(threadId);
    this.emit({ type: "plugin-catalog-updated" });
  }

  refreshModelRuntimeProfiles(): {
    disposedSessions: number;
    deferredSessions: number;
    disposedThreadIds: string[];
    deferredThreadIds: string[];
  } {
    this.invalidateSessionWarmups();
    return this.controllers.settingsSessions.applyModelRuntimeProfiles();
  }

  async runLocalModelRuntimeLifecycleAction(input: LocalModelRuntimeLifecycleActionInput): Promise<LocalModelRuntimeLifecycleActionResult> {
    return this.controllers.providerRuntime.runLocalModelRuntimeLifecycleAction(input);
  }

  readLocalModelRuntimeStatus(workspacePath = this.store.getWorkspace().path): Promise<LocalModelRuntimeStatusSnapshot> {
    return this.controllers.providerRuntime.readLocalModelRuntimeStatus(workspacePath);
  }

  private async refreshBrowsersForArtifactChange(threadId: string, workspacePath: string, artifactPath: string): Promise<void> {
    return refreshAgentRuntimeBrowsersForArtifactChange(
      { threadId, workspacePath, artifactPath },
      {
        refreshWorkspaceArtifact: (input) => this.browser.refreshWorkspaceArtifact(input),
        refreshExternalFileBrowserTabs,
        emitBrowserState: () => this.controllers.browserTools.emitBrowserState(),
        emit: (event) => this.emit(event),
      },
    );
  }

  private emit(event: DesktopEvent): void {
    this.desktopEventCoalescer.emit(event);
  }
}

export { shouldOpenApiKeyDialogForRuntimeError } from "./agentRuntimeErrorFormatting";
export { BrowserToolTimeoutError, browserToolTimeoutMs, withBrowserToolHeartbeat } from "./browser-tools/agentRuntimeBrowserToolHeartbeat";
export { assistantFinalizationRetryAttemptsUsedForReason } from "./agentRuntimeAssistantRetryInput";
