import type { AgentMemoryRuntimeSnapshot } from "../../shared/agentMemoryDiagnostics";
import type { DesktopEvent } from "../../shared/desktopTypes";
import type { WorkflowPlanEditIntentKind } from "../../shared/workflowThreadPlanEdit";
import type { AgentRuntimeFeatures } from "./agentRuntimeFeatures";
import type { BrowserCredentialStore, BrowserService, LocalPreviewServerManager } from "./agentRuntimeBrowserFacade";
import type { AmbientCliSkillMountDiagnostics } from "./agentRuntimeAmbientCliSkillMount";
import type { AmbientCliPackageDescriptionState } from "./ambient-cli-package/agentRuntimeAmbientCliPackageDescriptionState";
import type { AmbientWorkflowDescriptionState } from "./ambient-workflow/agentRuntimeAmbientWorkflowDescriptionState";
import type { AgentRuntimeInstallRouteGuard } from "./agentRuntimeInstallRouteGuard";
import type { AgentRuntimeMcpToolOrchestration } from "./mcp/agentRuntimeMcpToolBridge";
import type { AgentRuntimeModelContextController } from "./agentRuntimeModelContextController";
import type { AgentRuntimeProviderRuntimeController } from "./agentRuntimeProviderRuntimeController";
import type { AmbientPluginHost } from "./agentRuntimePluginsFacade";
import type { ProjectStore } from "./agentRuntimeProjectStoreFacade";
import type { RuntimeSendMessageInput } from "./agentRuntimeSendPreparationController";
import { AgentRuntimeAsyncBashJobService, formatAsyncBashSnapshotForTool } from "./tools/agentRuntimeAsyncBashJobs";
import {
  AgentRuntimeAsyncLongContextJobService,
  formatAsyncLongContextOrphanedSnapshotForTool,
  formatAsyncLongContextSnapshotForTool,
} from "./tools/agentRuntimeAsyncLongContextJobs";
import { AgentRuntimeBrowserToolController } from "./agentRuntimeBrowserToolController";
import { AgentRuntimeExtensionAssemblyController } from "./agentRuntimeExtensionAssemblyController";
import { AgentRuntimeGoalContinuationController } from "./agentRuntimeGoalContinuationController";
import type { AgentRuntimeLocalDeepResearchController } from "./agentRuntimeLocalDeepResearchController";
import type { AgentRuntimeMessagingGatewayController } from "./agentRuntimeMessagingGatewayController";
import { AgentRuntimePluginSetupToolController } from "./agentRuntimePluginSetupToolController";
import type { AgentRuntimeWebResearchController } from "./agentRuntimeWebResearchController";
import { AgentRuntimeSessionFactoryController, type AgentRuntimePiSession } from "./agentRuntimeSessionFactoryController";
import { AgentRuntimeSessionRegistry } from "./agentRuntimeSessionRegistry";
import { AgentRuntimeSettingsSessionController } from "./agentRuntimeSettingsSessionController";
import { AgentRuntimeThreadWakeContinuationController } from "./agentRuntimeThreadWakeContinuationController";
import { AgentRuntimeToolRunnerController } from "./agentRuntimeToolRunnerController";

type BrowserToolOptions = ConstructorParameters<typeof AgentRuntimeBrowserToolController>[0];
type ExtensionAssemblyOptions = ConstructorParameters<typeof AgentRuntimeExtensionAssemblyController>[0];
type PluginSetupToolOptions = ConstructorParameters<typeof AgentRuntimePluginSetupToolController>[0];
type SessionFactoryOptions = ConstructorParameters<typeof AgentRuntimeSessionFactoryController>[0];
type ToolRunnerOptions = ConstructorParameters<typeof AgentRuntimeToolRunnerController>[0];

export interface AgentRuntimeServiceControllerOptions {
  store: ProjectStore;
  browser: BrowserService;
  browserCredentials: BrowserCredentialStore;
  features: AgentRuntimeFeatures;
  permissions: PluginSetupToolOptions["permissions"];
  sessions: AgentRuntimeSessionRegistry<AgentRuntimePiSession>;
  activeRuns: Map<string, unknown>;
  activeRunIds: Map<string, string>;
  ambientCliSkillMountDiagnostics: Map<string, AmbientCliSkillMountDiagnostics>;
  ambientCliPackageDescriptionState: AmbientCliPackageDescriptionState;
  ambientWorkflowDescriptionState: AmbientWorkflowDescriptionState;
  workflowPlanEditIntentByThreadId: Map<string, WorkflowPlanEditIntentKind>;
  workflowPlanEditWorkflowThreadByThreadId: Map<string, string>;
  tencentMemoryRuntimeSnapshots: Map<string, AgentMemoryRuntimeSnapshot>;
  localPreviewServers: LocalPreviewServerManager;
  downloadService: ExtensionAssemblyOptions["downloadService"];
  pluginHost: AmbientPluginHost;
  mcpToolOrchestration: AgentRuntimeMcpToolOrchestration;
  modelContext: AgentRuntimeModelContextController;
  providerRuntime: AgentRuntimeProviderRuntimeController;
  messagingGateway: AgentRuntimeMessagingGatewayController;
  webResearch: AgentRuntimeWebResearchController;
  localDeepResearch: AgentRuntimeLocalDeepResearchController;
  installRouteGuard: AgentRuntimeInstallRouteGuard;
  callbacks: {
    commitThreadPiSessionFile: SessionFactoryOptions["commitThreadPiSessionFile"];
    createCallableWorkflowToolExtension: ExtensionAssemblyOptions["createCallableWorkflowToolExtension"];
    createInterruptedToolCallRecoveryToolExtension: ExtensionAssemblyOptions["createInterruptedToolCallRecoveryToolExtension"];
    createPermissionGateExtension: ExtensionAssemblyOptions["createPermissionGateExtension"];
    createSubagentToolExtension: ExtensionAssemblyOptions["createSubagentToolExtension"];
    currentFeatureFlagSnapshot: SessionFactoryOptions["getFeatureFlagSnapshot"];
    emit: (event: DesktopEvent) => void;
    ensurePluginMcpToolTrusted: PluginSetupToolOptions["ensurePluginMcpToolTrusted"];
    fileAuthorityRootPathsForThread: ToolRunnerOptions["fileAuthorityRootPathsForThread"];
    includeWorkspaceRootAuthorityForThread: ToolRunnerOptions["includeWorkspaceRootAuthorityForThread"];
    recordContextUsageSnapshot: SessionFactoryOptions["recordContextUsageSnapshot"];
    recordUnavailableContextUsageSnapshot: SessionFactoryOptions["recordUnavailableContextUsageSnapshot"];
    requestFileAuthorityForThread: ToolRunnerOptions["requestFileAuthorityForThread"];
    markPluginToolsStale: PluginSetupToolOptions["markPluginToolsStale"];
    resolveFirstPartyPluginPermission: PluginSetupToolOptions["resolveFirstPartyPluginPermission"] &
      ExtensionAssemblyOptions["resolveFirstPartyPluginPermission"];
    resolveToolCallPermission: SessionFactoryOptions["resolveToolCallPermission"];
    revokePluginGrantsForLabels: PluginSetupToolOptions["revokePluginGrantsForLabels"];
    runCapabilityBuilderValidationWithPermission: NonNullable<ExtensionAssemblyOptions["runCapabilityBuilderValidationWithPermission"]>;
    send: (input: RuntimeSendMessageInput) => Promise<void>;
    tryRouteBrowserContentThroughScrapling: BrowserToolOptions["tryRouteBrowserContentThroughScrapling"];
  };
}

export function createAgentRuntimeServiceControllers({
  activeRunIds,
  activeRuns,
  ambientCliPackageDescriptionState,
  ambientCliSkillMountDiagnostics,
  ambientWorkflowDescriptionState,
  browser,
  browserCredentials,
  callbacks,
  downloadService,
  features,
  installRouteGuard,
  localPreviewServers,
  localDeepResearch,
  mcpToolOrchestration,
  messagingGateway,
  modelContext,
  permissions,
  pluginHost,
  providerRuntime,
  sessions,
  store,
  tencentMemoryRuntimeSnapshots,
  webResearch,
  workflowPlanEditIntentByThreadId,
  workflowPlanEditWorkflowThreadByThreadId,
}: AgentRuntimeServiceControllerOptions) {
  const asyncBashJobsRef: { current?: AgentRuntimeAsyncBashJobService } = {};
  const asyncLongContextJobsRef: { current?: AgentRuntimeAsyncLongContextJobService } = {};
  const goalContinuationsRef: { current?: AgentRuntimeGoalContinuationController } = {};
  const threadWakeContinuationsRef: { current?: AgentRuntimeThreadWakeContinuationController } = {};
  const resolveAsyncBashJobs = (): AgentRuntimeAsyncBashJobService => {
    const asyncBashJobs = asyncBashJobsRef.current;
    if (!asyncBashJobs) throw new Error("Async bash jobs were used before initialization.");
    return asyncBashJobs;
  };
  const resolveAsyncLongContextJobs = (): AgentRuntimeAsyncLongContextJobService => {
    const asyncLongContextJobs = asyncLongContextJobsRef.current;
    if (!asyncLongContextJobs) throw new Error("Async long-context jobs were used before initialization.");
    return asyncLongContextJobs;
  };
  const resolveGoalContinuations = (): AgentRuntimeGoalContinuationController => {
    const goalContinuations = goalContinuationsRef.current;
    if (!goalContinuations) throw new Error("Goal continuations were used before initialization.");
    return goalContinuations;
  };
  const resolveThreadWakeContinuations = (): AgentRuntimeThreadWakeContinuationController => {
    const threadWakeContinuations = threadWakeContinuationsRef.current;
    if (!threadWakeContinuations) throw new Error("Thread wake continuations were used before initialization.");
    return threadWakeContinuations;
  };

  const toolRunner = new AgentRuntimeToolRunnerController({
    store,
    asyncBashJobs: resolveAsyncBashJobs,
    getRunId: (threadId) => activeRunIds.get(threadId),
    scheduleThreadWake: async (input) => {
      const wake = resolveThreadWakeContinuations().schedule({
        threadId: input.threadId,
        dueAt: input.dueAt,
        reason: input.reason,
        jobId: input.jobId,
        operationKey: input.operationKey,
        payload: input.payload,
      });
      return {
        wakeId: wake.id,
        threadId: wake.threadId,
        dueAt: wake.dueAt,
        reason: wake.reason,
        jobId: wake.jobId,
        operationKey: wake.operationKey,
        supersedesWakeIds: wake.supersedesWakeIds,
      };
    },
    cancelThreadWake: async (input) => {
      const wake = resolveThreadWakeContinuations().cancel({
        threadId: input.threadId,
        wakeId: input.wakeId,
      });
      return {
        wakeId: wake.id,
        threadId: wake.threadId,
        status: wake.status,
        reason: wake.resolutionReason,
        operationKey: wake.operationKey,
      };
    },
    resolveThreadWake: async (input) => {
      const wake = resolveThreadWakeContinuations().resolve({
        threadId: input.threadId,
        wakeId: input.wakeId,
        reason: input.reason,
      });
      return {
        wakeId: wake.id,
        threadId: wake.threadId,
        status: wake.status,
        reason: wake.resolutionReason,
        operationKey: wake.operationKey,
      };
    },
    fileAuthorityRootPathsForThread: (threadId, access) => callbacks.fileAuthorityRootPathsForThread(threadId, access),
    includeWorkspaceRootAuthorityForThread: (threadId) => callbacks.includeWorkspaceRootAuthorityForThread(threadId),
    requestFileAuthorityForThread: (threadId, workspace, request) => callbacks.requestFileAuthorityForThread(threadId, workspace, request),
    emit: (event) => callbacks.emit(event),
  });
  const browserTools = new AgentRuntimeBrowserToolController({
    store,
    browser,
    browserCredentials,
    localPreviewServers,
    enableBrowserLoginBroker: () => features.browserLoginBroker !== false,
    getRunId: (threadId) => activeRunIds.get(threadId),
    tryRouteBrowserContentThroughScrapling: (input) => callbacks.tryRouteBrowserContentThroughScrapling(input),
    emit: (event) => callbacks.emit(event),
  });
  const pluginSetupTools = new AgentRuntimePluginSetupToolController({
    store,
    browser,
    permissions,
    asyncLongContextJobs: resolveAsyncLongContextJobs,
    getRunId: (threadId) => activeRunIds.get(threadId),
    pluginHost,
    mcpToolOrchestration,
    installRouteGuard,
    ambientCliPackageDescriptionState,
    ambientWorkflowDescriptionState,
    providerRuntime,
    workflowPlanEditIntentByThreadId,
    workflowPlanEditWorkflowThreadByThreadId,
    features: {
      mcp: features.mcp,
      googleWorkspace: features.googleWorkspace,
      workflowNativeTools: features.workflowNativeTools,
      search: features.search,
      workflowRecordings: features.workflowRecordings,
    },
    fileAuthorityRootPathsForThread: (threadId, access) => callbacks.fileAuthorityRootPathsForThread(threadId, access),
    includeWorkspaceRootAuthorityForThread: (threadId) => callbacks.includeWorkspaceRootAuthorityForThread(threadId),
    requestFileAuthority: (threadId, workspace, request) => callbacks.requestFileAuthorityForThread(threadId, workspace, request),
    resolveFirstPartyPluginPermission: (input) => callbacks.resolveFirstPartyPluginPermission(input),
    ensurePluginMcpToolTrusted: (threadId, workspace, registration) =>
      callbacks.ensurePluginMcpToolTrusted(threadId, workspace, registration),
    revokePluginGrantsForLabels: (labels) => callbacks.revokePluginGrantsForLabels(labels),
    markPluginToolsStale: (threadId) => callbacks.markPluginToolsStale(threadId),
    emitBrowserState: () => browserTools.emitBrowserState(),
    recordBrowserAudit: (threadId, toolName, risk, detail) => browserTools.recordBrowserAudit(threadId, toolName, risk, detail),
    getFeatureFlagSnapshot: () => callbacks.currentFeatureFlagSnapshot(),
    emit: (event) => callbacks.emit(event),
  });
  const extensionAssembly = new AgentRuntimeExtensionAssemblyController({
    store,
    activeRuns,
    finalizeCompletedThreadGoal: (goal) => resolveGoalContinuations().finalizeCompletedThreadGoal(goal),
    emitGoalUpdated: (event) => callbacks.emit(event),
    browser,
    openLocalPreview: (input) => localPreviewServers.open(input),
    workflowPlanEditIntentByThreadId,
    downloadService,
    readSearchSettings: () => features.search?.readSettings(),
    updateSearchSettings: features.search?.updateSettings ? (input) => features.search!.updateSettings!(input) : undefined,
    resolveFirstPartyPluginPermission: (input) => callbacks.resolveFirstPartyPluginPermission(input),
    privilegedActionAdapter: features.privilegedActionAdapter,
    requestPrivilegedCredential: features.privilegedCredentials?.request,
    runCapabilityBuilderValidationWithPermission: (input) => callbacks.runCapabilityBuilderValidationWithPermission(input),
    createModelContextExtensionFactories: (input) => modelContext.createModelContextExtensionFactories(input),
    createInterruptedToolCallRecoveryToolExtension: (threadId, workspace) =>
      callbacks.createInterruptedToolCallRecoveryToolExtension(threadId, workspace),
    createToolRunnerExtension: (threadId, workspace, options) => toolRunner.createToolRunnerExtension(threadId, workspace, options),
    createVoiceSettingsToolExtension: (threadId, workspace) => providerRuntime.createVoiceSettingsToolExtension(threadId, workspace),
    createSttSettingsToolExtension: (threadId, workspace) => providerRuntime.createSttSettingsToolExtension(threadId, workspace),
    getThreadForVision: (id) => store.getThread(id),
    getLatestBrowserScreenshotArtifact: (threadId) => browserTools.getLatestBrowserScreenshotArtifact(threadId),
    vision: features.vision,
    createLocalDeepResearchToolExtension: (threadId, workspace) => localDeepResearch.createToolExtension(threadId, workspace),
    createLocalRuntimeToolExtension: (workspace) => providerRuntime.createLocalRuntimeToolExtension(workspace),
    createMessagingGatewayToolExtension: (threadId, workspace) => messagingGateway.createMessagingGatewayToolExtension(threadId, workspace),
    createWebResearchToolExtension: (threadId, workspace) => webResearch.createWebResearchToolExtension(threadId, workspace),
    createLambdaRlmToolExtension: (threadId, workspace, model, apiKey) =>
      pluginSetupTools.createLambdaRlmToolExtension(threadId, workspace, model, apiKey),
    createBrowserToolExtension: (threadId, workspace) => browserTools.createBrowserToolExtension(threadId, workspace),
    createPluginInstallToolExtension: (threadId, workspace, model, apiKey) =>
      pluginSetupTools.createPluginInstallToolExtension(threadId, workspace, model, apiKey),
    createGoogleWorkspaceSetupToolExtension: (workspace) => pluginSetupTools.createGoogleWorkspaceSetupToolExtension(workspace),
    createWorkflowNativeToolExtension: (threadId, workspace) => pluginSetupTools.createWorkflowNativeToolExtension(threadId, workspace),
    createPluginMcpToolExtension: (threadId, workspace, registrations) =>
      pluginSetupTools.createPluginMcpToolExtension(threadId, workspace, registrations),
    createCallableWorkflowToolExtension: (
      threadId,
      workspace,
      initialRecordedWorkflowPlaybooks,
      childCallableWorkflowToolNames,
      symphonyParentModePolicy,
      symphonyParentModeVerifiedLaunch,
    ) =>
      callbacks.createCallableWorkflowToolExtension(
        threadId,
        workspace,
        initialRecordedWorkflowPlaybooks,
        childCallableWorkflowToolNames,
        symphonyParentModePolicy,
        symphonyParentModeVerifiedLaunch,
      ),
    createSubagentToolExtension: (threadId, pluginMcpTools) => callbacks.createSubagentToolExtension(threadId, pluginMcpTools),
    createPermissionGateExtension: (threadId, workspace) => callbacks.createPermissionGateExtension(threadId, workspace),
  });
  const sessionFactory = new AgentRuntimeSessionFactoryController({
    store,
    sessions,
    pluginHost,
    extensionAssembly,
    mcpToolOrchestration,
    providerRuntime,
    features,
    ambientCliSkillMountDiagnostics,
    tencentMemoryRuntimeSnapshots,
    getFeatureFlagSnapshot: () => callbacks.currentFeatureFlagSnapshot(),
    commitThreadPiSessionFile: (input) => callbacks.commitThreadPiSessionFile(input),
    recordContextUsageSnapshot: (threadId, session, message) => callbacks.recordContextUsageSnapshot(threadId, session, message),
    recordUnavailableContextUsageSnapshot: (thread, message) => callbacks.recordUnavailableContextUsageSnapshot(thread, message),
    resolveToolCallPermission: (threadId, workspace, toolName, toolInput) =>
      callbacks.resolveToolCallPermission(threadId, workspace, toolName, toolInput),
    emit: (event) => callbacks.emit(event),
  });
  const asyncBashJobs = new AgentRuntimeAsyncBashJobService({
    onSnapshot: (snapshot) => toolRunner.upsertAsyncBashToolMessage(snapshot),
  });
  asyncBashJobsRef.current = asyncBashJobs;
  const asyncLongContextJobs = new AgentRuntimeAsyncLongContextJobService({
    onSnapshot: (snapshot) => toolRunner.upsertAsyncLongContextToolMessage(snapshot),
  });
  asyncLongContextJobsRef.current = asyncLongContextJobs;
  const goalContinuations = new AgentRuntimeGoalContinuationController({
    store,
    hasActiveRun: (threadId) => activeRuns.has(threadId),
    send: (input) => callbacks.send(input as RuntimeSendMessageInput),
    emit: (event) => callbacks.emit(event),
  });
  goalContinuationsRef.current = goalContinuations;
  const threadWakeContinuations = new AgentRuntimeThreadWakeContinuationController({
    store,
    hasActiveRun: (threadId) => activeRuns.has(threadId),
    send: (input) => callbacks.send(input as RuntimeSendMessageInput),
    emit: (event) => callbacks.emit(event),
    asyncBashSnapshotText: (threadId, jobId) => {
      try {
        return formatAsyncBashSnapshotForTool(
          asyncBashJobs.snapshotForThread(threadId, jobId, {
            maxBytes: 12_000,
          }),
        );
      } catch {
        return undefined;
      }
    },
    asyncLongContextSnapshotText: (threadId, jobId) => {
      try {
        return formatAsyncLongContextSnapshotForTool(
          asyncLongContextJobs.snapshotForThread(threadId, jobId, {
            maxBytes: 12_000,
          }),
        );
      } catch {
        return formatAsyncLongContextOrphanedSnapshotForTool(threadId, jobId);
      }
    },
  });
  threadWakeContinuationsRef.current = threadWakeContinuations;
  const settingsSessions = new AgentRuntimeSettingsSessionController({
    sessions,
    activeRuns,
    ambientCliSkillMountDiagnostics,
    tencentMemoryRuntimeSnapshots,
    getThread: (threadId) => store.getThread(threadId),
    switchSessionToThreadModel: (thread, session) => sessionFactory.switchSessionToThreadModel(thread, session),
    recordUnavailableContextUsageSnapshot: (thread, message) =>
      callbacks.recordUnavailableContextUsageSnapshot(thread, message),
    emit: (event) => callbacks.emit(event),
  });

  return {
    asyncBashJobs,
    asyncLongContextJobs,
    browserTools,
    extensionAssembly,
    goalContinuations,
    pluginSetupTools,
    sessionFactory,
    settingsSessions,
    threadWakeContinuations,
    toolRunner,
  };
}

export type AgentRuntimeServiceControllers = ReturnType<typeof createAgentRuntimeServiceControllers>;
