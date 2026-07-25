import type {
  UpdateMediaPlaybackSettingsInput,
  UpdatePlannerSettingsInput,
  UpdateSttSettingsInput,
  UpdateVoiceSettingsInput,
} from "../../shared/desktopTypes";
import type { ProjectSummary } from "../../shared/projectBoardTypes";
import type { PlannerSettings } from "../../shared/plannerTypes";
import type {
  PrivilegedActionNativeRequest,
  PrivilegedCredentialPromptResolution,
  SecureInputPromptResolution,
} from "../../shared/permissionTypes";
import type {
  AmbientFeatureFlagSnapshot,
} from "../../shared/featureFlags";
import type {
  EmbeddingProviderCandidate,
  LocalDeepResearchSettings,
  LocalDeepResearchSmokeResult,
  LocalDeepResearchValidationResult,
  LocalModelHostMemorySnapshot,
  MediaPlaybackSettings,
  MiniCpmVisionAnalysisResult,
  MiniCpmVisionAnalyzeInput,
  MiniCpmVisionSetupInput,
  MiniCpmVisionSetupResult,
  SttProviderCandidate,
  SttSettings,
  VoiceProviderCandidate,
  VoiceSettings,
  VoiceSettingsAuditSource,
} from "../../shared/localRuntimeTypes";
import type { ThreadSummary } from "../../shared/threadTypes";
import type {
  SearchRoutingSettings,
} from "../../shared/webResearchTypes";
import type { WorkflowAgentThreadSummary, WorkflowRecoveryAction } from "../../shared/workflowTypes";
import type { WorkspaceMediaUrlInput } from "../../shared/workspaceMedia";
import type {
  AmbientModelRuntimeCatalog,
  AmbientModelRuntimeProfile,
} from "../../shared/ambientModels";
import type { AmbientProviderContextOverflow } from "./agentRuntimeAmbientFacade";
import type {
  AmbientTencentMemoryLlmDelegate,
  TencentMemoryCoreConstructorLoader,
} from "./agentRuntimeMemoryFacade";
import type { AgentRuntimeGoogleWorkspaceTools } from "./agentRuntimeGoogleWorkspaceFacade";
import type { AmbientCliVoiceRunner } from "./agentRuntimeVoiceFacade";
import type { AmbientCliSttRunner } from "./agentRuntimeSttFacade";
import type { AnalyzeMiniCpmVisionInputOptions, SetupMiniCpmVisionProviderOptions } from "./agentRuntimeMiniCpmFacade";
import type {
  AmbientWorkflowPlaybookDescription,
  AmbientWorkflowPlaybookInjection,
  AmbientWorkflowsArchiveInput,
  AmbientWorkflowsDescribeInput,
  AmbientWorkflowsInjectInput,
  AmbientWorkflowsRestoreVersionInput,
  AmbientWorkflowsSearchInput,
  AmbientWorkflowsSearchResponse,
  AmbientWorkflowsUnarchiveInput,
  AmbientWorkflowsUpdateInput,
} from "./agentRuntimeAmbientFacade";
import type {
  CreateLocalTextSubagentRuntimeAdapterOptions,
  LocalTextRuntimeManagerLike,
  LocalTextSubagentRuntimeConfig,
} from "./agentRuntimeLocalRuntimeFacade";
import type {
  LocalDeepResearchInstallRequest,
  LocalDeepResearchInstallServiceResult,
  LocalDeepResearchManagedAssetDetection,
  LocalDeepResearchRunRequest,
  LocalDeepResearchRunServiceResult,
  LocalDeepResearchSetupContract,
  LocalDeepResearchSetupInput,
  LocalDeepResearchSmokeRequest,
} from "./agentRuntimeLocalDeepResearchFacade";
import type { LocalLlamaResidentProcess } from "./agentRuntimeLocalLlamaFacade";
import type { PrivilegedActionAdapter } from "./agentRuntimePrivilegedActionFacade";
import type { PlannerDurableHtmlBrowserValidator } from "./agentRuntimePlannerFacade";
import type { WorkflowConnectorAccountAuthorizer, WorkflowConnectorDescriptor, WorkflowConnectorRegistration } from "./agentRuntimeWorkflowFacade";

export interface VoiceSettingsAuditContext {
  source: VoiceSettingsAuditSource;
  toolName?: string;
  threadId?: string;
  summary?: string;
}

export interface AgentRuntimeFeatures {
  localModelHostMemory?: () => LocalModelHostMemorySnapshot;
  localModelResidentProcesses?: (workspacePath: string) => Promise<LocalLlamaResidentProcess[]> | LocalLlamaResidentProcess[];
  browserLoginBroker?: boolean;
  featureFlags?: {
    readSnapshot: () => AmbientFeatureFlagSnapshot;
  };
  memory?: {
    loadTencentMemoryCore?: TencentMemoryCoreConstructorLoader;
    runWithAmbientPi?: AmbientTencentMemoryLlmDelegate;
    storageHealthy?: () => boolean;
  };
  mcp?: {
    userDataPath: string;
    appVersion?: string;
    env?: NodeJS.ProcessEnv;
  };
  ambientCli?: {
    autoInstallFirstParty?: boolean;
  };
  modelRuntime?: {
    catalog?: (generatedAt?: string) => AmbientModelRuntimeCatalog;
    resolveModelRuntimeProfile?: (modelId?: string) => AmbientModelRuntimeProfile;
    learnProviderContextLimit?: (input: {
      modelId: string;
      overflow: AmbientProviderContextOverflow;
    }) => AmbientModelRuntimeProfile;
  };
  googleWorkspace?: AgentRuntimeGoogleWorkspaceTools;
  workflowNativeTools?: {
    connectorDescriptors?: () => WorkflowConnectorDescriptor[];
    connectorRegistrations?: () => WorkflowConnectorRegistration[];
    connectorAccountAuthorizer?: () => WorkflowConnectorAccountAuthorizer | undefined;
  };
  voice?: {
    readSettings: () => VoiceSettings;
    updateSettings?: (input: UpdateVoiceSettingsInput, audit?: VoiceSettingsAuditContext) => Promise<VoiceSettings> | VoiceSettings;
    listProviders?: (workspacePath: string) => Promise<VoiceProviderCandidate[]> | VoiceProviderCandidate[];
    testRunner?: AmbientCliVoiceRunner;
    onStateUpdated?: () => void;
    enforceArtifactBudget?: (workspacePath: string) => Promise<void> | void;
    createMediaUrl?: (input: WorkspaceMediaUrlInput) => string;
  };
  embeddings?: {
    listProviders?: (workspacePath: string) => Promise<EmbeddingProviderCandidate[]> | EmbeddingProviderCandidate[];
  };
  stt?: {
    readSettings: () => SttSettings;
    updateSettings?: (input: UpdateSttSettingsInput) => Promise<SttSettings> | SttSettings;
    listProviders?: (workspacePath: string) => Promise<SttProviderCandidate[]> | SttProviderCandidate[];
    testRunner?: AmbientCliSttRunner;
  };
  vision?: {
    setupMiniCpm?: (workspacePath: string, input: MiniCpmVisionSetupInput, options?: SetupMiniCpmVisionProviderOptions) => Promise<MiniCpmVisionSetupResult> | MiniCpmVisionSetupResult;
    analyzeMiniCpm?: (workspacePath: string, input: MiniCpmVisionAnalyzeInput, options?: AnalyzeMiniCpmVisionInputOptions) => Promise<MiniCpmVisionAnalysisResult> | MiniCpmVisionAnalysisResult;
  };
  localDeepResearch?: {
    readSettings?: () => LocalDeepResearchSettings;
    updateSettings?: (input: LocalDeepResearchSettings) => Promise<LocalDeepResearchSettings> | LocalDeepResearchSettings;
    buildSetupContract?: (workspacePath: string, input: LocalDeepResearchSetupInput) => Promise<LocalDeepResearchSetupContract> | LocalDeepResearchSetupContract;
    install?: (input: LocalDeepResearchInstallRequest) => Promise<LocalDeepResearchInstallServiceResult> | LocalDeepResearchInstallServiceResult;
    smoke?: (input: LocalDeepResearchSmokeRequest) => Promise<LocalDeepResearchSmokeResult> | LocalDeepResearchSmokeResult;
    validate?: (input: {
      workspacePath: string;
      setup: LocalDeepResearchSetupContract;
      managedAssets: LocalDeepResearchManagedAssetDetection;
    }) => Promise<LocalDeepResearchValidationResult> | LocalDeepResearchValidationResult;
    run?: (input: LocalDeepResearchRunRequest) => Promise<LocalDeepResearchRunServiceResult> | LocalDeepResearchRunServiceResult;
  };
  localTextSubagents?: {
    resolveModelRuntimeProfile?: (modelId?: string) => AmbientModelRuntimeProfile;
    resolveRuntimeForMain?: (input: {
      thread: ThreadSummary;
      runId: string;
      model: AmbientModelRuntimeProfile;
      prompt: string;
    }) => LocalTextSubagentRuntimeConfig | undefined;
    resolveRuntimeForLaunch?: CreateLocalTextSubagentRuntimeAdapterOptions["resolveRuntimeForLaunch"];
    resolveRuntime?: CreateLocalTextSubagentRuntimeAdapterOptions["resolveRuntime"];
    runtimeManager?: LocalTextRuntimeManagerLike;
    buildResourceRegistry?: CreateLocalTextSubagentRuntimeAdapterOptions["buildResourceRegistry"];
    buildResourceRegistryForLaunch?: CreateLocalTextSubagentRuntimeAdapterOptions["buildResourceRegistryForLaunch"];
    buildPrompt?: CreateLocalTextSubagentRuntimeAdapterOptions["buildPrompt"];
    fetchImpl?: typeof fetch;
    now?: () => Date;
  };
  symphonyLaunchContracts?: {
    resolve: (contractId: string) => unknown;
  };
  media?: {
    readSettings: () => MediaPlaybackSettings;
    updateSettings?: (input: UpdateMediaPlaybackSettingsInput) => Promise<MediaPlaybackSettings> | MediaPlaybackSettings;
  };
  search?: {
    readSettings: () => SearchRoutingSettings;
    updateSettings?: (input: SearchRoutingSettings) => Promise<SearchRoutingSettings> | SearchRoutingSettings;
  };
  projects?: {
    listProjects?: () => ProjectSummary[];
    createProject?: (input: { name?: string; workspacePath?: string; reason: string }) => Promise<ProjectSummary> | ProjectSummary;
    switchProject?: (input: { workspacePath: string; reason: string }) => Promise<void> | void;
  };
  workflowAgents?: {
    runExploration?: (input: { workflowThreadId: string; reason: string }) => Promise<{
      thread: WorkflowAgentThreadSummary;
      traceId?: string;
      graphSnapshotId?: string;
      text?: string;
    }>;
    compilePreview?: (input: { workflowThreadId: string; reason: string }) => Promise<{
      thread: WorkflowAgentThreadSummary;
      artifactId?: string;
      runId?: string;
      text?: string;
    }>;
    reviewArtifact?: (input: {
      workflowThreadId: string;
      artifactId: string;
      decision: "approved" | "rejected";
      reason: string;
    }) => Promise<{
      thread: WorkflowAgentThreadSummary;
      artifactId: string;
      artifactStatus: string;
      changed: boolean;
      text?: string;
    }>;
    cancelRun?: (input: { workflowThreadId: string; runId: string; reason: string }) => Promise<{
      thread: WorkflowAgentThreadSummary;
      runId: string;
      runStatus?: string;
      changed: boolean;
      text?: string;
    }>;
    recoverRun?: (input: {
      workflowThreadId: string;
      runId: string;
      eventId: string;
      action: WorkflowRecoveryAction;
      graphNodeId?: string;
      itemKey?: string;
      reason: string;
    }) => Promise<{
      thread: WorkflowAgentThreadSummary;
      runId: string;
      runStatus?: string;
      changed: boolean;
      text?: string;
    }>;
  };
  workflowRecordings?: {
    search?: (input: AmbientWorkflowsSearchInput) => Promise<AmbientWorkflowsSearchResponse> | AmbientWorkflowsSearchResponse;
    describe?: (input: AmbientWorkflowsDescribeInput) => Promise<AmbientWorkflowPlaybookDescription> | AmbientWorkflowPlaybookDescription;
    inject?: (input: AmbientWorkflowsInjectInput) => Promise<AmbientWorkflowPlaybookInjection> | AmbientWorkflowPlaybookInjection;
    update?: (input: AmbientWorkflowsUpdateInput) => Promise<AmbientWorkflowPlaybookDescription> | AmbientWorkflowPlaybookDescription;
    archive?: (input: AmbientWorkflowsArchiveInput) => Promise<AmbientWorkflowPlaybookDescription> | AmbientWorkflowPlaybookDescription;
    unarchive?: (input: AmbientWorkflowsUnarchiveInput) => Promise<AmbientWorkflowPlaybookDescription> | AmbientWorkflowPlaybookDescription;
    restoreVersion?: (input: AmbientWorkflowsRestoreVersionInput) => Promise<AmbientWorkflowPlaybookDescription> | AmbientWorkflowPlaybookDescription;
  };
  privilegedCredentials?: {
    request: (input: PrivilegedActionNativeRequest) => Promise<PrivilegedCredentialPromptResolution>;
  };
  secureInputs?: {
    request: (input: {
      threadId?: string;
      workspacePath?: string;
      requestId?: string;
      title: string;
      message: string;
      detail: string;
      inputLabel: string;
      inputKind: "telegram_login_code" | "telegram_password" | "generic_secret";
      inputMode: "text" | "password";
      providerId?: string;
      profileId?: string;
    }) => Promise<SecureInputPromptResolution>;
  };
  privilegedActionAdapter?: PrivilegedActionAdapter;
  planner?: {
    readSettings?: () => PlannerSettings;
    updateSettings?: (input: UpdatePlannerSettingsInput) => Promise<PlannerSettings> | PlannerSettings;
    durableBrowserValidator?: PlannerDurableHtmlBrowserValidator;
  };
}
