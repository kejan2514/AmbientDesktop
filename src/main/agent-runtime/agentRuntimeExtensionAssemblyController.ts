import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

import type { WorkflowPlanEditIntentKind } from "../../shared/workflowThreadPlanEdit";
import type { ThreadSummary } from "../../shared/threadTypes";
import type { WorkspaceState } from "../../shared/workspaceTypes";
import type { WorkflowRecordingLibraryDescription } from "../../shared/workflowTypes";
import type { AmbientModelRuntimeProfile } from "../../shared/ambientModels";
import {
  createPrivilegedActionAdapter,
  privilegedActionAdapterSelectionFromEnv,
  type PrivilegedActionAdapter,
} from "./agentRuntimePrivilegedActionFacade";
import { discoverAmbientCliPackages } from "./agentRuntimeAmbientCliFacade";
import {
  type GoalCompletionBrowser,
  type GoalCompletionValidationInput,
  validateGoalCompletionArtifacts,
} from "./agentRuntimeGoalCompletionValidation";
import {
  createGoalModeToolExtension as createGoalModeToolsExtension,
  type GoalModeToolExtensionOptions,
} from "./agentRuntimeGoalModeTools";
import { createGitToolExtension as createGitToolsExtension } from "./agentRuntimeGitTools";
import {
  createManagedDownloadToolExtension as createManagedDownloadToolsExtension,
  type ManagedDownloadServiceLike,
} from "./agentRuntimeManagedDownloadTools";
import { createMediaToolExtension } from "./agentRuntimeMediaTools";
import type { AgentRuntimeModelContextExtensionFactoriesInput } from "./agentRuntimeModelContextController";
import { createPlannerModeExtension as createPlannerModeToolsExtension } from "./agentRuntimePlannerModeExtension";
import { createProviderCatalogToolExtension } from "./agentRuntimeProviderCatalogTools";
import { createProjectBoardTaskToolExtension as createProjectBoardTaskToolsExtension } from "./agentRuntimeProjectBoardTaskTools";
import type { PluginMcpToolRegistration } from "./agentRuntimePluginsFacade";
import {
  createSearchPreferenceToolExtension as createSearchPreferenceToolsExtension,
  type SearchPreferenceToolRegistrationOptions,
} from "./agentRuntimeSearchPreferenceTools";
import type {
  SymphonyParentModePolicy,
  SymphonyParentModeVerifiedLaunch,
} from "./agentRuntimeSymphonyParentMode";
import {
  createVisionToolExtension,
  type AgentRuntimeVisionToolExtensionOptions,
} from "./agentRuntimeVisionTools";
import {
  createPrivilegedActionToolsExtension,
  type AgentRuntimePrivilegedActionToolOptions,
} from "./privileged-action/agentRuntimePrivilegedActionTools";
import { writePrivilegedActionRedactedLog } from "./agentRuntimePrivilegedActionFacade";
import type { ProjectStore } from "./agentRuntimeProjectStoreFacade";
import type { AmbientProviderTransportChannel } from "../ambient/ambientProviderTransportActivity";

type ResolveExtensionAssemblyPermission = (
  input:
    | Parameters<SearchPreferenceToolRegistrationOptions["resolveFirstPartyPluginPermission"]>[0]
    | Parameters<AgentRuntimePrivilegedActionToolOptions["resolveFirstPartyPluginPermission"]>[0],
) => Promise<boolean> | boolean;

export interface AgentRuntimeExtensionAssemblyControllerOptions {
  store: ProjectStore;
  activeRuns: ReadonlyMap<string, unknown>;
  finalizeCompletedThreadGoal: GoalModeToolExtensionOptions["finalizeCompletedThreadGoal"];
  emitGoalUpdated: GoalModeToolExtensionOptions["emit"];
  browser: GoalCompletionBrowser;
  openLocalPreview: NonNullable<GoalCompletionValidationInput["openLocalPreview"]>;
  workflowPlanEditIntentByThreadId: ReadonlyMap<string, WorkflowPlanEditIntentKind>;
  downloadService: ManagedDownloadServiceLike;
  readSearchSettings: SearchPreferenceToolRegistrationOptions["readSettings"];
  updateSearchSettings: SearchPreferenceToolRegistrationOptions["updateSettings"];
  resolveFirstPartyPluginPermission: ResolveExtensionAssemblyPermission;
  privilegedActionAdapter?: PrivilegedActionAdapter;
  requestPrivilegedCredential: AgentRuntimePrivilegedActionToolOptions["requestPrivilegedCredential"];
  runCapabilityBuilderValidationWithPermission: AgentRuntimePrivilegedActionToolOptions["runCapabilityBuilderValidationWithPermission"];
  createModelContextExtensionFactories: (
    input: AgentRuntimeModelContextExtensionFactoriesInput,
  ) => ExtensionFactory[];
  createInterruptedToolCallRecoveryToolExtension: (
    threadId: string,
    workspace: WorkspaceState,
  ) => ExtensionFactory;
  createToolRunnerExtension: (
    threadId: string,
    workspace: WorkspaceState,
    options?: { interruptedToolCallRecoveryToolsAvailable?: boolean },
  ) => ExtensionFactory;
  createVoiceSettingsToolExtension: (threadId: string, workspace: WorkspaceState) => ExtensionFactory;
  createSttSettingsToolExtension: (threadId: string, workspace: WorkspaceState) => ExtensionFactory;
  getThreadForVision: AgentRuntimeVisionToolExtensionOptions["getThread"];
  getLatestBrowserScreenshotArtifact: (
    threadId: string,
  ) => ReturnType<NonNullable<AgentRuntimeVisionToolExtensionOptions["getLatestBrowserScreenshotArtifact"]>>;
  vision: AgentRuntimeVisionToolExtensionOptions["vision"];
  createLocalDeepResearchToolExtension: (threadId: string, workspace: WorkspaceState) => ExtensionFactory;
  createLocalRuntimeToolExtension: (workspace: WorkspaceState) => ExtensionFactory;
  createMessagingGatewayToolExtension: (threadId: string, workspace: WorkspaceState) => ExtensionFactory;
  createWebResearchToolExtension: (threadId: string, workspace: WorkspaceState) => ExtensionFactory;
  createLambdaRlmToolExtension: (
    threadId: string,
    workspace: WorkspaceState,
    model: Model<"openai-completions">,
    apiKey: string | undefined,
  ) => ExtensionFactory;
  createBrowserToolExtension: (threadId: string, workspace: WorkspaceState) => ExtensionFactory;
  createPluginInstallToolExtension: (
    threadId: string,
    workspace: WorkspaceState,
    model: Model<"openai-completions">,
    apiKey: string | undefined,
  ) => ExtensionFactory;
  createGoogleWorkspaceSetupToolExtension: (workspace: WorkspaceState) => ExtensionFactory;
  createWorkflowNativeToolExtension: (threadId: string, workspace: WorkspaceState) => ExtensionFactory;
  createPluginMcpToolExtension: (
    threadId: string,
    workspace: WorkspaceState,
    pluginMcpTools: PluginMcpToolRegistration[],
  ) => ExtensionFactory;
  createCallableWorkflowToolExtension: (
    threadId: string,
    workspace: WorkspaceState,
    initialRecordedWorkflowPlaybooks: readonly WorkflowRecordingLibraryDescription[],
    childCallableWorkflowToolNames: readonly string[],
    symphonyParentModePolicy?: SymphonyParentModePolicy,
    symphonyParentModeVerifiedLaunch?: SymphonyParentModeVerifiedLaunch,
  ) => ExtensionFactory;
  createSubagentToolExtension: (
    threadId: string,
    pluginMcpTools: readonly PluginMcpToolRegistration[],
  ) => ExtensionFactory;
  createPermissionGateExtension: (threadId: string, workspace: WorkspaceState) => ExtensionFactory;
}

export interface AgentRuntimeExtensionAssemblyInput {
  thread: ThreadSummary;
  workspace: WorkspaceState;
  model: Model<"openai-completions">;
  modelProfile?: AmbientModelRuntimeProfile;
  apiKey: string | undefined;
  tencentMemoryExtension?: ExtensionFactory;
  interruptedToolCallRecoveryToolsAvailable: boolean;
  pluginMcpTools: PluginMcpToolRegistration[];
  callableWorkflowToolNames: readonly string[];
  subagentRegisteredToolNames: readonly string[];
  initialCallableWorkflowRecordedPlaybooks: readonly WorkflowRecordingLibraryDescription[];
  childCallableWorkflowToolNames: readonly string[];
  symphonyParentModePolicy?: SymphonyParentModePolicy;
  symphonyParentModeVerifiedLaunch?: SymphonyParentModeVerifiedLaunch;
  getRunningModel?: () => Model<"openai-completions"> | undefined;
  providerTransportChannel?: AmbientProviderTransportChannel;
}

export class AgentRuntimeExtensionAssemblyController {
  constructor(private readonly options: AgentRuntimeExtensionAssemblyControllerOptions) {}

  createExtensionFactories(input: AgentRuntimeExtensionAssemblyInput): ExtensionFactory[] {
    const { thread, workspace, model, apiKey } = input;
    return [
      ...this.options.createModelContextExtensionFactories({
        thread,
        workspace,
        model,
        modelProfile: input.modelProfile,
        apiKey,
        getRunningModel: input.getRunningModel,
        providerTransportChannel: input.providerTransportChannel,
      }),
      ...(input.tencentMemoryExtension ? [input.tencentMemoryExtension] : []),
      this.createGoalModeToolExtension(thread.id),
      this.options.createInterruptedToolCallRecoveryToolExtension(thread.id, workspace),
      this.options.createToolRunnerExtension(thread.id, workspace, {
        interruptedToolCallRecoveryToolsAvailable: input.interruptedToolCallRecoveryToolsAvailable,
      }),
      this.createProjectBoardTaskToolExtension(thread.id),
      createMediaToolExtension(workspace),
      this.options.createVoiceSettingsToolExtension(thread.id, workspace),
      this.options.createSttSettingsToolExtension(thread.id, workspace),
      createVisionToolExtension({
        threadId: thread.id,
        workspace,
        getThread: this.options.getThreadForVision,
        getLatestBrowserScreenshotArtifact: () => this.options.getLatestBrowserScreenshotArtifact(thread.id),
        vision: this.options.vision,
      }),
      this.options.createLocalDeepResearchToolExtension(thread.id, workspace),
      this.options.createLocalRuntimeToolExtension(workspace),
      this.createManagedDownloadToolExtension(workspace),
      createProviderCatalogToolExtension(),
      this.options.createMessagingGatewayToolExtension(thread.id, workspace),
      this.options.createWebResearchToolExtension(thread.id, workspace),
      this.createSearchPreferenceToolExtension(thread.id, workspace),
      this.createGitToolExtension(thread.id, workspace),
      this.createPrivilegedActionToolExtension(thread.id, workspace),
      this.options.createLambdaRlmToolExtension(thread.id, workspace, model, apiKey),
      this.options.createBrowserToolExtension(thread.id, workspace),
      this.options.createPluginInstallToolExtension(thread.id, workspace, model, apiKey),
      this.options.createGoogleWorkspaceSetupToolExtension(workspace),
      this.options.createWorkflowNativeToolExtension(thread.id, workspace),
      this.options.createPluginMcpToolExtension(thread.id, workspace, input.pluginMcpTools),
      ...(input.callableWorkflowToolNames.length
        ? [
          this.options.createCallableWorkflowToolExtension(
            thread.id,
            workspace,
            input.initialCallableWorkflowRecordedPlaybooks,
            input.childCallableWorkflowToolNames,
            input.symphonyParentModePolicy,
            input.symphonyParentModeVerifiedLaunch,
          ),
        ]
        : []),
      ...(input.subagentRegisteredToolNames.length
        ? [this.options.createSubagentToolExtension(thread.id, input.pluginMcpTools)]
        : []),
      this.createPlannerModeExtension(thread.id),
      this.options.createPermissionGateExtension(thread.id, workspace),
    ];
  }

  createGoalModeToolExtension(threadId: string): ExtensionFactory {
    return createGoalModeToolsExtension({
      threadId,
      store: this.options.store,
      hasActiveRun: () => this.options.activeRuns.has(threadId),
      finalizeCompletedThreadGoal: this.options.finalizeCompletedThreadGoal,
      emit: this.options.emitGoalUpdated,
      validateGoalCompletion: (goal) => {
        const thread = this.options.store.getThread(threadId);
        return validateGoalCompletionArtifacts({
          goal,
          thread,
          messages: this.options.store.listMessages(threadId),
          browser: this.options.browser,
          openLocalPreview: this.options.openLocalPreview,
        });
      },
    });
  }

  private createProjectBoardTaskToolExtension(threadId: string): ExtensionFactory {
    return createProjectBoardTaskToolsExtension({
      threadId,
      store: this.options.store,
    });
  }

  private createManagedDownloadToolExtension(workspace: WorkspaceState): ExtensionFactory {
    return createManagedDownloadToolsExtension({
      workspace,
      downloadService: this.options.downloadService,
    });
  }

  createSearchPreferenceToolExtension(threadId: string, workspace: WorkspaceState): ExtensionFactory {
    return createSearchPreferenceToolsExtension({
      threadId,
      workspace,
      getThread: (id) => this.options.store.getThread(id),
      readSettings: this.options.readSearchSettings,
      updateSettings: this.options.updateSearchSettings,
      discoverAmbientCliPackages,
      resolveFirstPartyPluginPermission: async (input) =>
        this.options.resolveFirstPartyPluginPermission(input),
    });
  }

  private createGitToolExtension(threadId: string, workspace: WorkspaceState): ExtensionFactory {
    return createGitToolsExtension({
      workspace,
      projectRoot: () => this.options.store.getWorkspace().path,
      threadWorktree: () => this.options.store.getThread(threadId).gitWorktree,
    });
  }

  createPrivilegedActionToolExtension(threadId: string, workspace: WorkspaceState): ExtensionFactory {
    return createPrivilegedActionToolsExtension({
      threadId,
      workspace,
      getThread: (id) => this.options.store.getThread(id),
      privilegedActionAdapter: () => this.privilegedActionAdapter(),
      resolveFirstPartyPluginPermission: async (input) =>
        this.options.resolveFirstPartyPluginPermission(input),
      requestPrivilegedCredential: this.options.requestPrivilegedCredential,
      writePrivilegedActionRedactedLog,
      runCapabilityBuilderValidationWithPermission: this.options.runCapabilityBuilderValidationWithPermission,
    });
  }

  private privilegedActionAdapter(): PrivilegedActionAdapter {
    return this.options.privilegedActionAdapter ?? createPrivilegedActionAdapter({
      adapter: privilegedActionAdapterSelectionFromEnv(),
      credentialRehearsalAvailable: Boolean(this.options.requestPrivilegedCredential),
    });
  }

  createPlannerModeExtension(threadId: string): ExtensionFactory {
    return createPlannerModeToolsExtension({
      threadId,
      getThread: (id) => this.options.store.getThread(id),
      getPlanEditIntentKind: () => this.options.workflowPlanEditIntentByThreadId.get(threadId),
    });
  }
}
