import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";

import type { DesktopEvent } from "../../shared/desktopTypes";
import { isAgentMemoryActiveForThread } from "../../shared/agentMemorySettings";
import type { AgentMemoryRuntimeSnapshot } from "../../shared/agentMemoryDiagnostics";
import {
  isAmbientSubagentsEnabled,
  isAmbientTencentDbMemoryEnabled,
  type AmbientFeatureFlagSnapshot,
} from "../../shared/featureFlags";
import {
  normalizeAmbientModelId,
  resolveAmbientModelRuntimeProfile,
  type AmbientModelRuntimeProfile,
} from "../../shared/ambientModels";
import type { ContextUsageSnapshot, ThreadSummary } from "../../shared/threadTypes";
import type { WorkspaceState } from "../../shared/workspaceTypes";
import {
  attachAmbientProviderTransportChannelForSession,
  bindAmbientProviderTransportChannel,
  createAmbientProviderTransportChannel,
} from "../ambient/ambientProviderTransportActivity";
import {
  AMBIENT_DEFAULT_ACTIVE_TOOL_NAMES,
  ambientModel,
  createAmbientToolRouterTools,
} from "./agentRuntimeAmbientFacade";
import {
  discoverAmbientCliPackages,
  ensureFirstPartyAmbientCliPackages,
} from "./agentRuntimeAmbientCliFacade";
import {
  resolveAmbientCliSkillMount,
  type AmbientCliSkillMountDiagnostics,
} from "./agentRuntimeAmbientCliSkillMount";
import type { AgentRuntimeFeatures } from "./agentRuntimeFeatures";
import type { RuntimeSessionRecoveryContext } from "./agentRuntimeAssistantRetryInput";
import {
  CALLABLE_WORKFLOW_CATALOG_DESCRIBE_TOOL_NAME,
  CALLABLE_WORKFLOW_CATALOG_SEARCH_TOOL_NAME,
  callableWorkflowActiveToolNamesForThread,
} from "./agentRuntimeCallableWorkflowFacade";
import {
  callableWorkflowRecordedPlaybooks,
} from "./agentRuntimeCallableWorkflowTools";
import type { AgentRuntimeExtensionAssemblyController } from "./agentRuntimeExtensionAssemblyController";
import {
  loadAgentRuntimeTencentMemoryModules,
} from "./agentRuntimeMemoryFacade";
import type { AgentRuntimeMcpToolOrchestration } from "./mcp/agentRuntimeMcpToolBridge";
import { ambientMcpBridgeActiveToolNamesForRecoveredTranscript } from "./mcp/agentRuntimeMcpRecoveredTranscript";
import type { AgentRuntimeProviderRuntimeController } from "./agentRuntimeProviderRuntimeController";
import { getAmbientProviderStatus, normalizeAmbientBaseUrl } from "./agentRuntimeProviderFacade";
import type { ProjectStore } from "./agentRuntimeProjectStoreFacade";
import {
  AmbientPluginHost,
  discoverAgentRuntimeSkillPaths,
} from "./agentRuntimePluginsFacade";
import { workspaceBoundedAgentContextFiles } from "./agentRuntimePiFacade";
import { enableAtomicPiSessionPersistence } from "./agentRuntimePiFacade";
import {
  activeToolNamesForAgentRuntimeSession,
  recoveryToolNamesForSessionRecovery,
} from "./agentRuntimeRecoveryToolActivation";
import {
  piRetryOverridesFromModelRuntimeSettings,
} from "./agentRuntimeRetrySettings";
import { readAmbientApiKey } from "./agentRuntimeSecurityFacade";
import type { PiSessionFileCommitReason } from "./agentRuntimeSessionFacade";
import {
  getRestorableRecoverySessionFile,
} from "./agentRuntimeSessionFacade";
import { AgentRuntimeSessionRegistry } from "./agentRuntimeSessionRegistry";
import {
  activeToolNamesForSymphonyParentMode,
  type SymphonyParentModePolicy,
  type SymphonyParentModeVerifiedLaunch,
} from "./agentRuntimeSymphonyParentMode";
import {
  materializeToolDefinitions,
  materializeToolResultFinalizerExtensionFactory,
  materializeToolResultExtensionFactory,
} from "./agentRuntimeToolRuntimeFacade";
import {
  ambientSubagentActiveToolNamesForThread,
  ambientSubagentRegisteredToolNamesForThread,
  resolveAgentRuntimeActiveToolNamesForThread,
  subagentChildCallableWorkflowToolNamesFromSnapshots,
} from "./agentRuntimeSubagentsFacade";
import { GOAL_MODE_TOOL_NAMES } from "./agentRuntimeGoalRuntime";
import {
  projectBoardNativeTaskToolDefinitions,
} from "./agentRuntimeProjectBoardFacade";
import {
  RECOVERY_READ_TOOL_NAME,
} from "./agentRuntimeInterruptedRecoveryTools";
import {
  visibleTranscriptRecoveryDefaultSessionSeedMessages,
  visibleTranscriptRecoveryMissingSessionPlan,
  visibleTranscriptRecoverySessionOpenFailurePlan,
  visibleTranscriptRecoverySessionOpenUnavailablePlan,
  visibleTranscriptRecoverySessionSeedDecision,
  visibleTranscriptRecoverySessionTranscriptContext,
  visibleTranscriptRecoveryUnavailableContextMessages,
} from "./recovery/compactionSummary";

export type AgentRuntimePiSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

type AgentRuntimeSessionFactoryProviderRuntime = Pick<
  AgentRuntimeProviderRuntimeController,
  | "listEmbeddingProvidersForTools"
  | "prepareEmbeddingProviderRuntimeForMemory"
  | "startEmbeddingProviderRuntimeForMemory"
>;
type AgentRuntimePiSessionModel = NonNullable<AgentRuntimePiSession["model"]>;

export interface AgentRuntimeSessionFactoryControllerOptions {
  store: ProjectStore;
  sessions: AgentRuntimeSessionRegistry<AgentRuntimePiSession>;
  pluginHost: AmbientPluginHost;
  extensionAssembly: AgentRuntimeExtensionAssemblyController;
  mcpToolOrchestration: AgentRuntimeMcpToolOrchestration;
  providerRuntime: AgentRuntimeSessionFactoryProviderRuntime;
  features: AgentRuntimeFeatures;
  ambientCliSkillMountDiagnostics: Map<string, AmbientCliSkillMountDiagnostics>;
  tencentMemoryRuntimeSnapshots: Map<string, AgentMemoryRuntimeSnapshot>;
  getFeatureFlagSnapshot: () => AmbientFeatureFlagSnapshot;
  commitThreadPiSessionFile: (input: {
    threadId: string;
    sessionFile?: string;
    currentPiSessionFile?: string | null;
    reason: PiSessionFileCommitReason;
    emit: (event: DesktopEvent) => void;
  }) => Promise<ThreadSummary | undefined>;
  recordContextUsageSnapshot: (
    threadId: string,
    session: AgentRuntimePiSession,
    message?: string,
  ) => ContextUsageSnapshot;
  recordUnavailableContextUsageSnapshot: (
    thread: ThreadSummary,
    message: string,
  ) => ContextUsageSnapshot;
  resolveToolCallPermission: (
    threadId: string,
    workspace: WorkspaceState,
    toolName: string,
    rawToolInput: unknown,
  ) => Promise<{ reason: string } | undefined>;
  emit: (event: DesktopEvent) => void;
}

export class AgentRuntimeSessionFactoryController {
  constructor(private readonly options: AgentRuntimeSessionFactoryControllerOptions) {}

  async switchSessionToThreadModel(thread: ThreadSummary, session: AgentRuntimePiSession): Promise<void> {
    const provider = getAmbientProviderStatus(thread.model);
    const model = ambientModel(
      thread.model,
      normalizeAmbientBaseUrl(provider.baseUrl),
      this.resolveModelRuntimeProfile(thread.model),
      { requestModelId: provider.model },
    );
    if (!sessionModelDescriptorMatches(session.model, model)) {
      attachAmbientProviderTransportChannelForSession(model, session);
      await session.setModel(model);
    }
    session.setThinkingLevel(thread.thinkingLevel);
    this.options.sessions.clearRuntimeSettingsStale(thread.id);
    this.options.recordContextUsageSnapshot(
      thread.id,
      session,
      "Context usage refreshed after the model changed.",
    );
    if (session.sessionFile) {
      await this.options.commitThreadPiSessionFile({
        threadId: thread.id,
        sessionFile: session.sessionFile,
        currentPiSessionFile: this.options.store.getThread(thread.id).piSessionFile,
        reason: "model-changed",
        emit: (event) => this.options.emit(event),
      });
    }
  }

  async getSession(
    thread: ThreadSummary,
    recovery?: RuntimeSessionRecoveryContext,
    symphonyParentModePolicy?: SymphonyParentModePolicy | undefined,
    symphonyParentModeVerifiedLaunch?: SymphonyParentModeVerifiedLaunch | undefined,
  ): Promise<AgentRuntimePiSession> {
    const existingPlan = this.options.sessions.reusableSessionPlan({
      threadId: thread.id,
      symphonyParentModePolicy,
      symphonyParentModeVerifiedLaunch,
    });
    if (existingPlan.kind !== "missing") {
      if (existingPlan.kind === "stale") {
        existingPlan.session.dispose();
        this.options.sessions.delete(thread.id);
      } else {
        const existing = existingPlan.session;
        const provider = getAmbientProviderStatus(thread.model);
        const targetModel = ambientModel(
          thread.model,
          normalizeAmbientBaseUrl(provider.baseUrl),
          this.resolveModelRuntimeProfile(thread.model),
          { requestModelId: provider.model },
        );
        if (!sessionModelDescriptorMatches(existing.model, targetModel)) {
          await this.switchSessionToThreadModel(thread, existing);
        }
        existing.setThinkingLevel(thread.thinkingLevel);
        return existing;
      }
    }
    this.options.sessions.clearStale(thread.id);

    const appWorkspace = this.options.store.getWorkspace();
    const workspace: WorkspaceState = {
      path: thread.workspacePath,
      name: basename(thread.workspacePath) || thread.workspacePath,
      statePath: appWorkspace.statePath,
      sessionPath: appWorkspace.sessionPath,
    };
    const featureFlagSnapshot = this.options.getFeatureFlagSnapshot();
    const subagentRegisteredToolNames = ambientSubagentRegisteredToolNamesForThread(thread, featureFlagSnapshot);
    const subagentToolNames = ambientSubagentActiveToolNamesForThread(thread, featureFlagSnapshot);
    const subagentToolScopeSnapshots =
      thread.kind === "subagent_child" && thread.subagentRunId
        ? this.options.store.listSubagentToolScopeSnapshots(thread.subagentRunId)
        : [];
    const childCallableWorkflowToolNames = subagentChildCallableWorkflowToolNamesFromSnapshots(subagentToolScopeSnapshots);
    const initialCallableWorkflowRecordedPlaybooks = isAmbientSubagentsEnabled(featureFlagSnapshot)
      ? callableWorkflowRecordedPlaybooks(this.options.store)
      : [];
    const callableWorkflowToolNames = callableWorkflowActiveToolNamesForThread({
      thread,
      featureFlagSnapshot,
      recordedWorkflowPlaybooks: initialCallableWorkflowRecordedPlaybooks,
      childCallableWorkflowToolNames,
    });
    const memorySettings = this.options.store.getMemorySettings();
    const tencentMemoryActive = isAgentMemoryActiveForThread({
      featureEnabled: isAmbientTencentDbMemoryEnabled(featureFlagSnapshot),
      settings: memorySettings,
      threadMemoryEnabled: Boolean(thread.memoryEnabled),
      threadKind: thread.kind,
      storageHealthy: this.options.features.memory?.storageHealthy?.() ?? true,
    });
    const provider = getAmbientProviderStatus(thread.model);
    const apiKey = readAmbientApiKey();
    const modelProfile = this.resolveModelRuntimeProfile(thread.model);
    const model = ambientModel(
      thread.model,
      normalizeAmbientBaseUrl(provider.baseUrl),
      modelProfile,
      { requestModelId: provider.model },
    );
    const providerTransportChannel = createAmbientProviderTransportChannel(model);
    let tencentMemoryExtension: ExtensionFactory | undefined;
    let memoryToolNames: string[] = [];
    if (tencentMemoryActive) {
      const {
        createTencentDbMemoryRuntimeForThread,
        createTencentDbMemoryPiExtension,
        createAmbientTencentMemoryPiLlmDelegate,
      } = await loadAgentRuntimeTencentMemoryModules();
      const runWithAmbientPi = this.options.features.memory?.runWithAmbientPi ?? createAmbientTencentMemoryPiLlmDelegate({
        workspacePath: workspace.path,
        statePath: workspace.statePath,
        threadId: thread.id,
        model,
        apiKey,
      });
      const tencentMemoryRuntime = createTencentDbMemoryRuntimeForThread({
        thread,
        workspace,
        featureFlagSnapshot,
        memorySettings,
        storageHealthy: this.options.features.memory?.storageHealthy?.() ?? true,
        loadCoreConstructor: this.options.features.memory?.loadTencentMemoryCore,
        runWithAmbientPi,
        listEmbeddingProviders: (workspacePath) => this.options.providerRuntime.listEmbeddingProvidersForTools(workspacePath),
        prepareEmbeddingProviderRuntime: (input) =>
          this.options.providerRuntime.prepareEmbeddingProviderRuntimeForMemory(input, workspace.path),
        startEmbeddingProviderRuntime: (input) =>
          this.options.providerRuntime.startEmbeddingProviderRuntimeForMemory(input, workspace.path),
        defaultModelRef: thread.model,
        onSnapshot: (snapshot) => this.options.tencentMemoryRuntimeSnapshots.set(thread.id, snapshot),
      });
      if (tencentMemoryRuntime) {
        tencentMemoryExtension = createTencentDbMemoryPiExtension({
          runtime: tencentMemoryRuntime,
          ...(memorySettings.shortTermOffloadEnabled
            ? {
                shortTermOffload: {
                  enabled: true,
                  getMessages: () => this.options.store.listMessages(thread.id),
                },
              }
            : {}),
        });
        memoryToolNames = [...tencentMemoryRuntime.activeToolNames];
      }
    }

    const agentDir = join(workspace.statePath, "pi");
    const piSessionDir = join(workspace.sessionPath, thread.id);
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(piSessionDir, { recursive: true });

    const settingsManager = SettingsManager.create(workspace.path, agentDir);
    const compactionSettings = this.options.store.getCompactionSettings();
    const retryOverrides = piRetryOverridesFromModelRuntimeSettings(this.options.store.getModelRuntimeSettings());
    settingsManager.applyOverrides({
      compaction: {
        enabled: compactionSettings.autoCompactionEnabled,
        reserveTokens: compactionSettings.reserveTokens,
        keepRecentTokens: compactionSettings.keepRecentTokens,
      },
      ...(retryOverrides ? { retry: retryOverrides } : {}),
    });
    const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
    if (apiKey) authStorage.setRuntimeApiKey("ambient", apiKey);
    if (this.options.features.ambientCli?.autoInstallFirstParty !== false) {
      await ensureFirstPartyAmbientCliPackages(workspace.path, {
        onStatus: (status) => {
          if (status.status === "failed") {
            console.warn(`[ambient-cli] Failed to install first-party package ${status.packageName}: ${status.error}`);
            return;
          }
          if (status.status === "installed") {
            console.log(`[ambient-cli] Installed first-party package ${status.packageName}.`);
          }
        },
      });
    }
    const skillDiscovery = await discoverAgentRuntimeSkillPaths({
      workspacePath: workspace.path,
      pluginHost: this.options.pluginHost,
      store: this.options.store,
    });
    const enabledPlugins = skillDiscovery.enabledPlugins;
    const cliCatalog = await discoverAmbientCliPackages(workspace.path, { includeHealth: false }).catch(() => ({ packages: [], errors: [] }));
    const cliSkillMount = resolveAmbientCliSkillMount({
      cliSkillPaths: skillDiscovery.ambientCliSkillPaths,
      installedCliPackageCount: cliCatalog.packages.filter((pkg) => pkg.installed).length,
    });
    this.options.ambientCliSkillMountDiagnostics.set(thread.id, {
      lazyModeEnabled: cliSkillMount.lazyModeEnabled,
      installedCliPackageCount: cliSkillMount.installedCliPackageCount,
      eagerCliSkillCount: cliSkillMount.eagerCliSkillCount,
      mountedCliSkillCount: cliSkillMount.mountedCliSkillCount,
    });
    const pluginMcpTools = await this.options.pluginHost.buildCodexPluginMcpToolRegistrations(enabledPlugins, {
      permissionMode: thread.permissionMode,
      workspacePath: workspace.path,
    });
    const interruptedToolCallRecoveryToolNames = recoveryToolNamesForSessionRecovery(recovery);
    const interruptedToolCallRecoveryToolsAvailable = interruptedToolCallRecoveryToolNames.length > 0;
    const sessionForModelStatus: { current?: AgentRuntimePiSession } = {};
    const extensionFactories = this.options.extensionAssembly.createExtensionFactories({
      thread,
      workspace,
      model,
      modelProfile,
      apiKey,
      tencentMemoryExtension,
      interruptedToolCallRecoveryToolsAvailable,
      pluginMcpTools,
      callableWorkflowToolNames,
      subagentRegisteredToolNames,
      initialCallableWorkflowRecordedPlaybooks,
      childCallableWorkflowToolNames,
      symphonyParentModePolicy,
      symphonyParentModeVerifiedLaunch,
      getRunningModel: () => sessionForModelStatus.current?.model,
      providerTransportChannel,
    });

    const resourceLoader = new DefaultResourceLoader({
      cwd: workspace.path,
      agentDir,
      settingsManager,
      agentsFilesOverride: (base) => ({
        agentsFiles: workspaceBoundedAgentContextFiles({
          contextFiles: base.agentsFiles,
          workspacePath: workspace.path,
          agentDir,
        }),
      }),
      additionalSkillPaths: [
        ...skillDiscovery.pluginSkillPaths,
        ...skillDiscovery.piSkillPaths,
        ...cliSkillMount.mountedCliSkillPaths,
      ],
      extensionFactories: [
        ...extensionFactories.map((factory) =>
          materializeToolResultExtensionFactory(factory, { workspacePath: workspace.path }),
        ),
        materializeToolResultFinalizerExtensionFactory({ workspacePath: workspace.path }),
      ],
    });
    await resourceLoader.reload();

    const recoveryTranscriptContext = visibleTranscriptRecoverySessionTranscriptContext(
      this.options.store.listMessages(thread.id),
    );
    const { recoveryTranscriptMessages } = recoveryTranscriptContext;
    const restorableSession = getRestorableRecoverySessionFile({
      threadSessionFile: thread.piSessionFile,
      recoverySessionFile: recovery?.kind === "provider_interruption_continuation" ? recovery.previousSessionFile : undefined,
      sessionDir: piSessionDir,
    });
    const restorableSessionFile = restorableSession.sessionFile;
    const seedDecision = visibleTranscriptRecoverySessionSeedDecision({
      threadSessionFile: thread.piSessionFile,
      restorableSessionFile,
      hasRecovery: Boolean(recovery),
      recoveryTranscriptMessages,
    });
    let shouldSeedVisibleTranscript = seedDecision.shouldSeedVisibleTranscript;
    const missingSessionPlan = visibleTranscriptRecoveryMissingSessionPlan({
      threadSessionFile: thread.piSessionFile,
      restorableSessionFile,
      forceFreshSessionForRecovery: seedDecision.forceFreshSessionForRecovery,
      hasVisibleTranscript: recoveryTranscriptContext.hasVisibleTranscript,
    });
    if (missingSessionPlan.kind === "clear-thread-session-file") {
      this.options.store.updateThreadSettings(thread.id, { piSessionFile: null });
    } else if (missingSessionPlan.kind === "unavailable-context") {
      const unavailableContext = visibleTranscriptRecoveryUnavailableContextMessages({
        kind: missingSessionPlan.unavailableContextKind,
      });
      const snapshot = this.options.recordUnavailableContextUsageSnapshot(thread, unavailableContext.snapshotMessage);
      this.options.emit({ type: "context-usage-updated", snapshot });
      throw new Error(unavailableContext.errorMessage);
    }
    let sessionManager: SessionManager;
    try {
      sessionManager = restorableSessionFile
        ? SessionManager.open(restorableSessionFile, piSessionDir, workspace.path)
        : SessionManager.create(workspace.path, piSessionDir);
    } catch (error) {
      const openFailurePlan = visibleTranscriptRecoverySessionOpenFailurePlan({
        hasRecovery: Boolean(recovery),
        threadSessionFile: thread.piSessionFile,
        restorableSessionFile,
        recoveryTranscriptMessages,
      });
      if (openFailurePlan.kind === "recoverable") {
        if (openFailurePlan.shouldClearThreadSessionFile) {
          this.options.store.updateThreadSettings(thread.id, { piSessionFile: null });
        }
        shouldSeedVisibleTranscript = openFailurePlan.shouldSeedVisibleTranscript;
        sessionManager = SessionManager.create(workspace.path, piSessionDir);
      } else {
        const unavailablePlan = visibleTranscriptRecoverySessionOpenUnavailablePlan({
          hasVisibleTranscript: recoveryTranscriptContext.hasVisibleTranscript,
          sessionErrorMessage: error instanceof Error ? error.message : String(error),
        });
        if (unavailablePlan.kind === "unavailable-context") {
          const { unavailableContext } = unavailablePlan;
          const snapshot = this.options.recordUnavailableContextUsageSnapshot(
            thread,
            unavailableContext.snapshotMessage,
          );
          this.options.emit({ type: "context-usage-updated", snapshot });
          // Preserve the legacy user-facing error string while keeping the caught open failure out of chat text.
          // eslint-disable-next-line preserve-caught-error
          throw new Error(unavailableContext.errorMessage);
        }
        this.options.store.updateThreadSettings(thread.id, { piSessionFile: null });
        sessionManager = SessionManager.create(workspace.path, piSessionDir);
      }
    }
    enableAtomicPiSessionPersistence(sessionManager);

    const sessionForAmbientToolRouter: { current?: AgentRuntimePiSession } = {};
    const ambientToolRouterTools = createAmbientToolRouterTools({
      getSession: () => sessionForAmbientToolRouter.current,
      getInstalledMcpSearchAliases: () => this.options.mcpToolOrchestration.installedMcpSearchAliases(workspace),
      authorizeToolCall: async (toolName, toolInput) => {
        const blocked = await this.options.resolveToolCallPermission(thread.id, workspace, toolName, toolInput);
        if (blocked) throw new Error(blocked.reason);
      },
    });
    const pluginMcpToolNames = pluginMcpTools.map((tool) => tool.registeredName);
    const projectBoardTaskToolNames = projectBoardNativeTaskToolDefinitions().map((tool) => tool.name);
    const agentRuntimeActiveTools = resolveAgentRuntimeActiveToolNamesForThread({
      thread,
      defaultActiveToolNames: [...AMBIENT_DEFAULT_ACTIVE_TOOL_NAMES, ...memoryToolNames],
      goalModeToolNames: GOAL_MODE_TOOL_NAMES,
      subagentToolNames,
      callableWorkflowToolNames,
      pluginMcpToolNames,
      projectBoardTaskToolNames,
      subagentToolScopeSnapshots,
    });
    const transcriptRehydratedToolNames = thread.kind === "subagent_child"
      ? []
      : ambientMcpBridgeActiveToolNamesForRecoveredTranscript(recoveryTranscriptMessages);
    const sessionActiveTools = activeToolNamesForAgentRuntimeSession({
      agentRuntimeActiveTools,
      recoveryToolNames: interruptedToolCallRecoveryToolNames,
      transcriptRehydratedToolNames,
    });
    const callableWorkflowConductorToolNames = symphonyParentModePolicy
      ? [
          CALLABLE_WORKFLOW_CATALOG_SEARCH_TOOL_NAME,
          CALLABLE_WORKFLOW_CATALOG_DESCRIBE_TOOL_NAME,
          ...(symphonyParentModeVerifiedLaunch ? [] : [symphonyParentModePolicy.expectedWorkflowToolName]),
        ]
      : callableWorkflowToolNames;
    const activeTools = activeToolNamesForSymphonyParentMode({
      activeToolNames: sessionActiveTools,
      policy: symphonyParentModePolicy,
      conductorToolNames: [
        ...callableWorkflowConductorToolNames,
        ...interruptedToolCallRecoveryToolNames.filter((toolName) => toolName === RECOVERY_READ_TOOL_NAME),
      ],
    });
    const { session } = await createAgentSession({
      cwd: workspace.path,
      agentDir,
      authStorage,
      model,
      resourceLoader,
      sessionManager,
      settingsManager,
      thinkingLevel: thread.thinkingLevel,
      customTools: materializeToolDefinitions(ambientToolRouterTools, { workspacePath: workspace.path }),
      activeTools,
      includeAllExtensionTools: false,
    });
    sessionForAmbientToolRouter.current = session;
    sessionForModelStatus.current = session;
    bindAmbientProviderTransportChannel(session, providerTransportChannel);
    session.agent.toolExecution = "sequential";
    await session.bindExtensions({});
    this.options.sessions.set({
      threadId: thread.id,
      session,
      symphonyParentModePolicy,
      symphonyParentModeVerifiedLaunch,
    });
    if (session.sessionFile && session.sessionFile !== thread.piSessionFile) {
      await this.options.commitThreadPiSessionFile({
        threadId: thread.id,
        sessionFile: session.sessionFile,
        currentPiSessionFile: thread.piSessionFile,
        reason: "session-created",
        emit: (event) => this.options.emit(event),
      });
    }
    if (shouldSeedVisibleTranscript) {
      const recoverySeedMessages = visibleTranscriptRecoveryDefaultSessionSeedMessages({
        thread,
        visibleMessages: recoveryTranscriptMessages,
        recovery,
        recoveredAt: new Date().toISOString(),
      });
      await session.sendCustomMessage(recoverySeedMessages.customMessage, { triggerTurn: false, deliverAs: "nextTurn" });
      const recoveryMessage = this.options.store.addMessage(recoverySeedMessages.systemMessage);
      this.options.emit({ type: "message-created", message: recoveryMessage });
    }
    this.options.recordContextUsageSnapshot(thread.id, session);
    return session;
  }

  private resolveModelRuntimeProfile(modelId?: string): AmbientModelRuntimeProfile {
    return (
      this.options.features.modelRuntime?.resolveModelRuntimeProfile?.(modelId) ??
      this.options.features.localTextSubagents?.resolveModelRuntimeProfile?.(modelId) ??
      resolveAmbientModelRuntimeProfile(modelId)
    );
  }
}

function sessionModelDescriptorMatches(
  current: AgentRuntimePiSession["model"] | undefined,
  target: Model<"openai-completions">,
): boolean {
  if (normalizeAmbientModelId(current?.id) !== normalizeAmbientModelId(target.id)) return false;
  if (!hasComparableSessionModelDescriptor(current)) return true;
  return modelDescriptorFingerprint(current) === modelDescriptorFingerprint(target);
}

function hasComparableSessionModelDescriptor(
  model: AgentRuntimePiSession["model"] | undefined,
): model is AgentRuntimePiSessionModel {
  if (!model) return false;
  return typeof model.name === "string" || typeof model.contextWindow === "number" || Array.isArray(model.input);
}

function modelDescriptorFingerprint(model: AgentRuntimePiSessionModel | Model<"openai-completions">): string {
  return JSON.stringify({
    id: normalizeAmbientModelId(model.id),
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    input: model.input,
    compat: model.compat,
    thinkingLevelMap: "thinkingLevelMap" in model ? model.thinkingLevelMap : undefined,
  });
}
