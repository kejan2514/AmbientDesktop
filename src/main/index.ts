import { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, screen, shell } from "electron";
import electronUpdater from "electron-updater";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import packageJson from "../../package.json";
import { AgentRuntime, RUNTIME_RESET_INTERRUPTED_RUN_MESSAGE } from "./agent-runtime/agentRuntime";
import type { AgentRuntimeFeatures } from "./agent-runtime/agentRuntimeFeatures";
import { createAgentRuntimeFeatureFactory, type AgentRuntimeFeatureFactoryContext } from "./agent-runtime/agentRuntimeFeatureFactory";
import {
  archiveAmbientWorkflowPlaybook,
  describeAmbientWorkflowPlaybook,
  injectAmbientWorkflowPlaybook,
  restoreAmbientWorkflowPlaybookVersion,
  unarchiveAmbientWorkflowPlaybook,
  updateAmbientWorkflowPlaybook,
} from "./ambient/ambientWorkflows";
import { ambientRetryPolicyFromSettings } from "./ambient/aggressiveRetries";
import {
  AMBIENT_MODEL_DISCOVERY_REFRESH_INTERVAL_MS,
  discoverAmbientModelRuntimeProfiles,
} from "./ambient/ambientModelDiscovery";
import {
  ambientModelLimitObservationFromDiscoveredProfile,
  ambientModelLimitObservationFromOverflow,
  ambientModelLimitObservationKey,
  applyAmbientModelLimitObservation,
  applyAmbientModelLimitObservationToRegisteredProfile,
  mergeAmbientModelLimitObservation,
  readAmbientModelLimitObservations,
  writeAmbientModelLimitObservations,
  type AmbientModelLimitObservation,
  type AmbientProviderContextOverflow,
} from "./ambient/ambientModelLimits";
import { installAppLogCapture } from "./diagnostics/appLogs";
import { parseAmbientLaunchArgs } from "./desktop-shell/launchArgs";
import { localTextSubagentStartupFeatureFromEnv } from "./local-runtime/localTextSubagentStartupConfig";
import { isAmbientSubagentsEnabled, resolveAmbientFeatureFlags } from "../shared/featureFlags";
import {
  normalizeAmbientModelId,
  resolveAmbientModelRuntimeProfile,
  type AmbientModelRuntimeProfile,
} from "../shared/ambientModels";
import { createSubagentRuntimeStartupReconciliationService } from "./subagents/subagentRuntimeStartupReconciliationService";
import { installAppMenu } from "./desktop-shell/menu";
import { createDesktopAppearanceService } from "./desktop-shell/desktopAppearanceService";
import { createDesktopAppLifecycleService } from "./desktop-shell/desktopAppLifecycleService";
import {
  activeProjectBoardForState,
  activeProjectBoardThreadIdForStore,
  configureProjectBoardDesktopContextService,
  emitProjectBoardState,
  recordActiveProjectBoardExecutionReadinessBlocker,
} from "./project-board/projectBoardDesktopContextService";
import { createMainWindowBootstrapService } from "./desktop-shell/mainWindowBootstrapService";
import { createMainWindowRendererDiagnosticsService } from "./desktop-shell/mainWindowRendererDiagnosticsService";
import { createThreadMiniWindowService, isThreadMiniWindowRendererUrl } from "./desktop-shell/threadMiniWindowService";
import { createProjectRuntimeHostResolver } from "./project-runtime/projectRuntimeHostResolver";
import { createProjectRuntimeHostActivationService } from "./project-runtime/projectRuntimeHostActivationService";
import { createProjectRuntimeHostFactory } from "./project-runtime/projectRuntimeHostFactory";
import { createProjectRuntimeLifecycleService } from "./project-runtime/projectRuntimeLifecycleService";
import { createProjectRuntimeActiveThreadService } from "./project-runtime/projectRuntimeActiveThreadService";
import type { ProjectRuntimeHost as ProjectRuntimeHostContract } from "./project-runtime/projectRuntimeHost";
import { createProjectRuntimeThreadActionHostService } from "./project-runtime/projectRuntimeThreadActionHostService";
import { createProjectRuntimeWorkspaceSwitchService } from "./project-runtime/projectRuntimeWorkspaceSwitchService";
import {
  activeProjectSummary,
  createProjectRuntimeIpcContextService,
  initialActiveThreadIdForStore,
} from "./project-runtime/projectRuntimeIpcContextService";
import {
  applyProjectBoardIncrementalSynthesisFromRun,
  configureProjectBoardSynthesisDesktopService,
  requireProjectBoardForAction,
} from "./project-board/projectBoardSynthesisDesktopService";
import {
  configureProjectBoardProofDefaultsDesktopService,
  reviewFinishedProjectBoardRun,
} from "./project-board/projectBoardProofDefaultsDesktopService";
import { ProjectStore } from "./projectStore/projectStore";
import { configureProjectBoardDogfoodDesktopService } from "./project-board/projectBoardDogfoodDesktopService";
import { createWorkflowRecordingGlobalLibraryDesktopService } from "./workflow-recording/workflowRecordingGlobalLibraryDesktopService";
import { ProjectRegistry, normalizeWorkspacePath, readProjectSearchResults } from "./workspace/projectRegistry";
import { ensureWelcomeOnboardingProject, resolveWelcomeOnboardingAssetsPath } from "./workspace/welcomeOnboarding";
import { providerCatalogSettingsState } from "./provider/providerCatalog";
import { getAmbientProviderStatus } from "./provider/providerStatus";
import { saveModelProviderCredentialForSettings } from "./model-provider/modelProviderCredentialStore";
import { installModelProviderEndpointForSettings } from "./model-provider/modelProviderSettingsInstall";
import { DesktopUpdateService, desktopUpdateConfigFromEnv } from "./desktop-shell/updateService";
import { createAppMenuUpdateService } from "./desktop-shell/appMenuUpdateService";
import { createExternalNavigationService } from "./security/externalNavigationService";
import { createDesktopIpcTrustService } from "./security/desktopIpcTrustService";
import { createContainerRuntimeApplicationOpener } from "./container-runtime/containerRuntimeApplicationOpener";
import { createLocalFolderAllowlistGrantInput } from "./permissions/localFolderAllowlistGrants";
import { createSettingsRuntimeService } from "./settings/settingsRuntimeService";
import { createDesktopStateEventService } from "./desktop-shell/desktopStateEventService";
import { createDesktopStateSnapshotService } from "./desktop-shell/desktopStateSnapshotService";
import { LocalPreviewServerManager } from "./browser/localPreviewServer";
import { redactSensitiveText } from "./security/secretRedaction";
import { readSecretReference } from "./security/secretReferenceStore";
import { defaultNamedSecretStoreFilePath, NamedSecretStore } from "./security/namedSecretStore";
import { createNamedSecretDesktopService } from "./security/namedSecretDesktopService";
import { currentSecureStorageStatus, electronSecureSecretStore, secureStorageRepairGuidance } from "./security/secureSecretStore";
import { selectStartupWorkspacePath } from "./workspace/workspaceDefaults";
import { shouldStartAgentMemoryManagedEmbeddingsAfterSettingsUpdate } from "../shared/agentMemorySettings";
import type { DesktopEvent, DesktopState, ThinkingDisplaySettings } from "../shared/desktopTypes";
import type { LocalDeepResearchSettings, SttSettings } from "../shared/localRuntimeTypes";
import type { PlannerSettings } from "../shared/plannerTypes";
import type { ThreadSummary } from "../shared/threadTypes";
import type { SearchRoutingSettings } from "../shared/webResearchTypes";
import { emptyQueueState } from "../shared/messageDelivery";
import { clearImportedWorkspaceContext, clearImportedWorkspaceContextSync, resolveWorkspacePath } from "./workspace/workspaceFiles";
import { createActiveWorkspaceFileService } from "./workspace/activeWorkspaceFileService";
import { createWorkspaceContextCacheService } from "./workspace/workspaceContextCacheService";
import { createWorkspaceSearchDesktopService } from "./workspace/workspaceSearchDesktopService";
import { registerWorkspaceMediaProtocol, WorkspaceMediaServer } from "./workspace/workspaceMedia";
import { OfficePreviewService } from "./office/officePreviewService";
import { createOfficePreviewPublisher } from "./office/officePreviewPublisher";
import { commitGitPaths, getGitReview, getWorkspaceGitStatus } from "./workspace/workspaceGit";
import { createGitCheckpoint, latestGitCheckpoint } from "./git/gitCheckpoints";
import { attachExistingThreadWorktree, prepareThreadWorktree } from "./git/gitWorktrees";
import { createThreadWorkspaceGitService } from "./git/threadWorkspaceGitService";
import { TerminalService } from "./terminal/terminalService";
import { TerminalStartTokenStore } from "./terminal/terminalSessionTokens";
import { sampleLocalModelHostMemorySnapshot } from "./local-runtime/localModelResourceRegistry";
import { PermissionPromptService } from "./permissions/permissionPrompts";
import { PrivilegedCredentialPromptService } from "./privileged-action/privilegedCredentialPrompts";
import { SecureInputPromptService } from "./security/secureInputPrompts";
import { permissionGrantTargetHash } from "./permissions/permissionGrants";
import { createPermissionGrantRegistryDesktopService } from "./permissions/permissionGrantRegistryDesktopService";
import { AmbientPluginHost } from "./plugins/pluginHost";
import { createPluginDesktopService } from "./plugins/pluginDesktopService";
import { createProjectRuntimeMcpRuntimeService } from "./project-runtime/projectRuntimeMcpRuntimeService";
import {
  configureDesktopMcpInstallService,
  createMcpInstallCatalog,
  reconcileMcpContainerRuntimeOnStartup,
} from "./mcp/mcpDesktopInstallService";
import { McpToolBridge } from "./mcp/mcpToolBridge";
import { createPiToolingApprovalDetailFormatter } from "./agent-runtime/pi-package-tools/piToolingApprovalDetails";
import { selectAmbientCliPackageForRuntime as selectAmbientCliPackageForSecret } from "./agent-runtime/ambient-cli-package/agentRuntimeAmbientCliPackageSelection";
import { PluginAuthService } from "./plugins/pluginAuthService";
import {
  configureOrchestrationAutoDispatchService,
  createAutoDispatchState,
  scheduleAutoDispatch,
  stopAutoDispatch,
  workflowAutoDispatchDisabledMessage,
  type OrchestrationAutoDispatchState,
} from "./orchestration/orchestrationAutoDispatchService";
import {
  readOrchestrationBoardWithWorkflowReadiness,
  readOrchestrationWorkflowReadiness,
} from "./orchestration/orchestrationWorkflowReadiness";
import { reviewWorkflowArtifact } from "./workflow/workflowDashboard";
import {
  agentMemoryDefaultManagedEmbeddingAutoStartEnabled,
  agentMemoryDefaultManagedEmbeddingAutoStartEnabledForFeature,
  configureAgentMemoryDesktopService,
  getAgentMemoryDiagnostics,
  getAgentMemoryStarterStatus,
  runAgentMemoryStartupReconciliation,
  releaseAgentMemoryEmbeddingRuntimeForHost,
  startAgentMemoryManagedEmbeddingsAfterSettingsUpdate,
  stopAgentMemoryManagedEmbeddingsAfterSettingsUpdate,
} from "./memory/agentMemoryDesktopService";
import { BrowserService, managedChromeRevealBoundsForWorkArea, type ManagedChromeWindowBounds } from "./browser/browserService";
import { createBrowserDesktopStateService } from "./browser/browserDesktopStateService";
import { BrowserCredentialStore } from "./browser/browserCredentialStore";
import { InternalBrowserHost } from "./browser/internalBrowserHost";
import { compileWorkflowArtifact } from "./workflow-compiler/workflowCompilerService";
import { createWorkflowActiveRunRegistry } from "./workflow/workflowActiveRunRegistry";
import { buildWorkflowDebugRewriteContext } from "./workflow/workflowDebugRewrite";
import { createWorkflowDiscoveryDesktopService } from "./workflow-discovery/workflowDiscoveryDesktopService";
import { workspaceInventoryConnector, workspaceInventoryConnectorDescriptor } from "./workflow/workflowConnectors";
import { AmbientWorkflowExplorationProvider, runWorkflowThreadExploration } from "./workflow/workflowExplorationService";
import { workflowToolDescriptorsFromPluginRegistry } from "./workflow/workflowPluginCapabilities";
import { runWorkflowArtifact } from "./workflow/workflowRunService";
import { buildWorkflowRecoveryPlan } from "./workflow/workflowRecovery";
import { markStaleWorkflowRunForRecoveryIfNeeded } from "./workflow/workflowStaleRunRecovery";
import { createWorkflowTraceRetentionService } from "./workflow/workflowTraceRetention";
import { createWorkflowRuntimeFeatureActionsService } from "./workflow/workflowRuntimeFeatureActionsService";
import { SafeStorageWorkflowConnectorTokenVault } from "./workflow/workflowConnectorAuth";
import { googleWorkspaceOAuthProvidersFromEnv } from "./google-workspace/googleOAuthProvider";
import { createGoogleWorkspaceDesktopIntegrationService } from "./google-workspace/googleWorkspaceDesktopIntegrationService";
import { GoogleSidecarSupervisor } from "./google-workspace/googleSidecarSupervisor";
import { GoogleWorkspaceCliAdapter } from "./google-workspace/googleWorkspaceCliAdapter";
import { GoogleWorkspaceCliInstaller } from "./google-workspace/googleWorkspaceCliInstaller";
import { GoogleWorkspaceSetupService } from "./google-workspace/googleWorkspaceSetupService";
import { GoogleWorkspaceMethodBroker } from "./google-workspace/googleWorkspaceMethodBroker";
import {
  getActiveAmbientProviderBaseUrl,
  getActiveAmbientProviderId,
  readAmbientApiKey,
} from "./security/credentialStore";
import { LAMBDA_RLM_SOURCE_COMMIT, LAMBDA_RLM_SOURCE_PAPER, LAMBDA_RLM_SOURCE_REPOSITORY } from "./tool-runtime/lambdaRlm";
import { thirdPartyCreditAboutText, thirdPartyCredits } from "./desktop-shell/thirdPartyCredits";
import { createWindowStateService } from "./desktop-shell/windowState";
import {
  normalizePlannerSettings,
  normalizeLocalDeepResearchAppSettings,
  normalizeSearchRoutingSettings,
  normalizeThinkingDisplaySettings,
  readPlannerSettings,
  readThemePreference,
  readMediaPlaybackSettings,
  readLocalDeepResearchSettings,
  readSearchRoutingSettings,
  readSttSettings,
  readThinkingDisplaySettings,
  readVoiceSettings,
  writeMediaPlaybackSettings,
  writeLocalDeepResearchSettings,
  writePlannerSettings,
  writeSearchRoutingSettings,
  writeSttSettings,
  writeThinkingDisplaySettings,
  writeThemePreference,
} from "./desktop-shell/appAppearanceDefaultPreferences";
import { ambientLegacyUserDataPaths, hasRestorableWorkspaceState, migrateAmbientUserData } from "./desktop-shell/userDataMigration";
import { renderThreadMiniWindowHtml } from "./thread/threadMiniWindowHtml";
import { discoverAmbientCliPackages, runAmbientCliPackageCommand, searchAmbientCliCapabilities } from "./ambient-cli/ambientCliPackages";
import { hydrateWebResearchSettings } from "./web-research/webResearchSettingsHydration";
import { createVoiceArtifactDesktopService } from "./voice/voiceArtifactDesktopService";
import { createVoiceSettingsDesktopService, type VoiceSettingsDesktopService } from "./voice/voiceSettingsDesktopService";
import { createSttDesktopService } from "./stt/sttDesktopService";
import { createMiniCpmVisionDesktopService } from "./mini-cpm/miniCpmVisionDesktopService";
import { createLocalDeepResearchDesktopService } from "./local-deep-research/localDeepResearchDesktopService";
import { reconcileLocalDeepResearchInstallJob } from "./local-deep-research/localDeepResearchInstallService";
import { validatePlannerDurableHtmlFileInBrowser } from "./planner/plannerDurableBrowserValidation";
import { writePlannerDurableHtmlArtifact } from "./planner/plannerDurableHtml";
import { plannerDurableFallbackWarnings } from "./planner/plannerDurableRepair";
import { createPlannerDurableArtifactDesktopService } from "./planner/plannerDurableArtifactDesktopService";
import { registerMainIpcForDesktop } from "./mainIpcRuntimeDependencies";

installAppLogCapture();

const { autoUpdater } = electronUpdater;
const lambdaRlmThirdPartyCreditSource = {
  commit: LAMBDA_RLM_SOURCE_COMMIT,
  paper: LAMBDA_RLM_SOURCE_PAPER,
  repository: LAMBDA_RLM_SOURCE_REPOSITORY,
};

let mainWindow: BrowserWindow | undefined;
let mediaPlaybackSettings = { generatedMediaAutoplay: false };
let thinkingDisplaySettings: ThinkingDisplaySettings = { mode: "transient", hideRunStatusCardAfterFirstMessage: true };
let plannerSettings: PlannerSettings = { autoFinalize: true };
let localDeepResearchSettings: LocalDeepResearchSettings = normalizeLocalDeepResearchAppSettings(undefined);
let searchRoutingSettings: SearchRoutingSettings = {};
let ambientDiscoveredModelProfiles: AmbientModelRuntimeProfile[] = [];
let ambientModelLimitObservationsLoaded = false;
const ambientModelLimitObservations = new Map<string, AmbientModelLimitObservation>();
let ambientModelDiscoveryTimer: ReturnType<typeof setInterval> | undefined;
type AmbientModelDiscoveryRefreshReason = "startup" | "interval" | "credentials-updated";
interface AmbientModelDiscoveryRequestIdentity {
  apiKey: string;
  baseUrl: string;
}

function emitMainWindowDesktopEvent(event: DesktopEvent): void {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  const webContents = window.webContents;
  if (webContents.isDestroyed() || webContents.isCrashed()) return;
  try {
    webContents.send("desktop:event", event);
  } catch (error) {
    console.warn(`Dropped desktop event after renderer became unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let sttSettings: SttSettings = {
  enabled: false,
  spokenLanguage: "English",
  microphone: {},
  mode: "push-to-talk" as const,
  autoSendAfterTranscription: true,
  silenceFinalizeSeconds: 0.8,
  noSpeechGate: {
    enabled: true,
    rmsThresholdDbfs: -55,
  },
  bargeIn: {
    stopTtsOnSpeech: true,
    queueWhileAgentRuns: true,
  },
};
const workspaceMediaServer = new WorkspaceMediaServer((workspacePath) => Boolean(projectRuntimeHostForKnownWorkspacePath(workspacePath)));
let officePreviewService: OfficePreviewService | undefined;

let projectRegistry: ProjectRegistry;
const permissions = new PermissionPromptService(() => mainWindow);
const privilegedCredentials = new PrivilegedCredentialPromptService(() => mainWindow);
const secureInputs = new SecureInputPromptService(() => mainWindow);
const browserLoginBrokerEnabled = process.env.AMBIENT_BROWSER_LOGIN_BROKER !== "0";
const ambientLaunchArgs = parseAmbientLaunchArgs(process.argv.slice(1));
const localTextSubagentStartup = localTextSubagentStartupFeatureFromEnv(process.env);
const desktopAppearanceService = createDesktopAppearanceService({
  appPath: () => app.getAppPath(),
  cwd: () => process.cwd(),
  dockSetIcon: (iconPath) => app.dock?.setIcon(iconPath),
  existsSync,
  mainWindow: () => mainWindow,
  platform: () => process.platform,
  resourcesPath: () => process.resourcesPath,
  setNativeThemeSource: (preference) => {
    nativeTheme.themeSource = preference;
  },
  systemPrefersDark: () => nativeTheme.shouldUseDarkColors,
  userDataPath: () => app.getPath("userData"),
});
const {
  appearancePreferencesPath,
  applyThemePreference,
  currentAppearance,
  currentBackgroundColor,
  currentResolvedTheme,
  publishAppearanceUpdated,
  resolveAppIconPath,
  resolveBuiltOutputPath,
  setDockIcon,
} = desktopAppearanceService;
const desktopIpcTrustService = createDesktopIpcTrustService({
  ipcMain,
  mainWindow: () => mainWindow,
  rendererUrl: () => process.env.ELECTRON_RENDERER_URL,
  builtRendererUrl: () => pathToFileURL(resolveBuiltOutputPath("renderer", "index.html")),
});
const { assertTrustedMainWindowIpc, handleIpc, isTrustedRendererUrl } = desktopIpcTrustService;
for (const warning of localTextSubagentStartup.warnings) {
  console.warn(`[startup] Local text sub-agent runtime disabled: ${warning}`);
}
let pluginHost: AmbientPluginHost;
let pluginAuthService: PluginAuthService;
let googleSidecarSupervisor: GoogleSidecarSupervisor | undefined;
let googleWorkspaceCliAdapter: GoogleWorkspaceCliAdapter;
let googleWorkspaceCliInstaller: GoogleWorkspaceCliInstaller;
let googleWorkspaceSetupService: GoogleWorkspaceSetupService;
let googleWorkspaceMethodBroker: GoogleWorkspaceMethodBroker;
let activeThreadId = "";
const desktopUpdateService = new DesktopUpdateService(
  autoUpdater,
  desktopUpdateConfigFromEnv({
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    appPath: process.execPath,
    releaseChannel: process.env.AMBIENT_RELEASE_CHANNEL,
  }),
  (update) => emitMainWindowDesktopEvent({ type: "update-status", update }),
);
const appMenuUpdateService = createAppMenuUpdateService<BrowserWindow>({
  checkForUpdates: () => desktopUpdateService.checkForUpdates("manual"),
  getWindow: () => mainWindow,
  showMessageBox: async (window, options) => {
    if (window) {
      await dialog.showMessageBox(window, options);
      return;
    }
    await dialog.showMessageBox(options);
  },
});
const googleWorkspaceDesktopIntegrationService = createGoogleWorkspaceDesktopIntegrationService({
  env: process.env,
  cliAdapter: () => googleWorkspaceCliAdapter,
  cliInstaller: () => googleWorkspaceCliInstaller,
  setupService: () => googleWorkspaceSetupService,
  pluginAuthService: () => pluginAuthService,
  sidecarSupervisor: () => googleSidecarSupervisor,
  workspaceConnectorDescriptors: () => [workspaceInventoryConnectorDescriptor()],
});
const {
  firstPartyWorkflowConnectorAccountAuthorizer,
  firstPartyWorkflowConnectorDescriptors,
  firstPartyWorkflowConnectorRegistrations,
  readFirstPartyGoogleIntegration,
  redactGoogleWorkspaceSetupState,
  refreshGoogleWorkspaceConnectorMode,
} = googleWorkspaceDesktopIntegrationService;
const windowStateService = createWindowStateService<BrowserWindow>({
  appVersion: () => app.getVersion(),
  userDataPath: () => app.getPath("userData"),
  displayWorkAreas: () => screen.getAllDisplays().map((display) => display.workArea),
  primaryDisplayWorkArea: () => screen.getPrimaryDisplay().workArea,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timeout) => clearTimeout(timeout),
  warn: (message) => console.warn(message),
});
const projectRuntimeMcpRuntimeService = createProjectRuntimeMcpRuntimeService<ProjectRuntimeHost>({
  pluginMcpRuntimeSnapshots: () => pluginHost.pluginMcpRuntimeSnapshots(),
  projectRuntimeHosts: () => projectRuntimeHostList(),
});
const { allPluginMcpRuntimeSnapshots, restartProjectRuntimeMcpRuntime, stopProjectRuntimeMcpRuntime } = projectRuntimeMcpRuntimeService;
const pluginDesktopService = createPluginDesktopService<ProjectRuntimeHost, ProjectStore>({
  defaultStore: () => store,
  defaultHost: () => requireActiveProjectRuntimeHost(),
  pluginHost: () => pluginHost,
  allPluginMcpRuntimeSnapshots,
  currentFeatureFlagSnapshot: (targetStore) => currentFeatureFlagSnapshot(targetStore),
  getAgentMemoryDiagnostics: (host) => getAgentMemoryDiagnostics(host),
  getAgentMemoryStarterStatus: (host) => getAgentMemoryStarterStatus(host),
  searchAmbientCliCapabilities,
});
const {
  ambientCliCapabilityGrantsForWorkflowRequest,
  createMainDiagnosticSource,
  pluginMcpRegistrationsForThread,
  pluginStateReaderForStore,
  readAmbientPluginRegistry,
  readCodexHostedMarketplaceReport,
  readCodexPluginCatalog,
  revokePluginGrantsForLabels,
} = pluginDesktopService;
const workflowDiscoveryDesktopService = createWorkflowDiscoveryDesktopService<ProjectStore, ThreadSummary>({
  defaultStore: () => store,
  defaultContext: () => activeProjectIpcContext(),
  readAmbientApiKey,
  retryPolicyFromSettings: (input) => ambientRetryPolicyFromSettings(input),
  pluginMcpRegistrationsForThread: (thread, targetStore) => pluginMcpRegistrationsForThread(thread, targetStore),
  connectorDescriptors: () => firstPartyWorkflowConnectorDescriptors(),
  searchRoutingSettings: () => searchRoutingSettings,
  requestPermission: (request) => permissions.request(request),
});
const {
  ambientRetryPolicyFromCurrentSettings,
  createWorkflowDiscoveryProvider,
  ensureWorkflowPluginTrusted,
  workflowDiscoveryPolicyContextForCapabilityLookup,
} = workflowDiscoveryDesktopService;
const projectRuntimeHostFactory = createProjectRuntimeHostFactory({
  createProjectStore: () => new ProjectStore(),
  createInternalBrowserHost: (hostStore: ProjectStore) =>
    new InternalBrowserHost(
      () => hostStore.getWorkspace(),
      () => mainWindow,
    ),
  createBrowserService: (hostStore: ProjectStore, hostInternalBrowser: InternalBrowserHost, onStateChanged) =>
    new BrowserService(() => hostStore.getWorkspace(), hostInternalBrowser, {
      browserLoginBrokerAvailable: browserLoginBrokerEnabled,
      managedChromeRevealBounds: managedChromeRevealBoundsForAmbientWindow,
      onStateChanged,
    }),
  onBrowserServiceStateChanged: (hostBrowser: BrowserService) => {
    if (activeHost?.browserService === hostBrowser) emitBrowserState();
  },
  createBrowserCredentialStore: (hostStore: ProjectStore) =>
    new BrowserCredentialStore(() => hostStore.getWorkspace(), electronSecureSecretStore({ appAvailable: true })),
  createTerminalService: (workspacePath: string) => new TerminalService(() => mainWindow, workspacePath),
  initialActiveThreadIdForStore: (hostStore: ProjectStore) => initialActiveThreadIdForStore(hostStore),
  createRuntime: ({ store: hostStore, browserService: hostBrowser, browserCredentialStore: hostBrowserCredentials, activeThreadId }) =>
    new AgentRuntime(
      hostStore,
      hostBrowser,
      hostBrowserCredentials,
      () => mainWindow,
      {
        request: (request) => permissions.request(request),
        denyThread: (threadId) => permissions.denyThread(threadId),
        listPending: () => permissions.listPending(),
        respond: (id, response) => permissions.respond(id, response),
      },
      createAgentRuntimeFeatures({
        store: hostStore,
        browserService: hostBrowser,
        activeThreadId,
      }),
    ),
  createAutoDispatchState: (enabled: boolean) => createAutoDispatchState(enabled),
  createHost: ({
    workspace,
    store: hostStore,
    internalBrowserHost: hostInternalBrowser,
    browserService: hostBrowser,
    browserCredentialStore: hostBrowserCredentials,
    runtime: hostRuntime,
    terminals: hostTerminals,
    activeThreadId: initialHostThreadId,
    autoDispatch,
  }) => ({
    workspacePath: workspace.path,
    store: hostStore,
    internalBrowserHost: hostInternalBrowser,
    browserService: hostBrowser,
    browserCredentialStore: hostBrowserCredentials,
    runtime: hostRuntime,
    terminals: hostTerminals,
    activeThreadId: initialHostThreadId,
    autoDispatch,
  }),
});
const projectRuntimeHostActivationService = createProjectRuntimeHostActivationService<ProjectRuntimeHost>({
  normalizeWorkspacePath,
  createProjectRuntimeHost: (workspacePath, options) => projectRuntimeHostFactory.createProjectRuntimeHost(workspacePath, options),
  runStartupReconciliation: (reason, host) => runProjectRuntimeStartupReconciliation(reason, host),
  registerProjectWorkspacePath: (workspacePath) => projectRegistry.register(workspacePath),
  onActiveHostChanged: (host) => syncActiveProjectRuntimeHost(host),
});
const { activateProjectRuntimeHost, ensureProjectRuntimeHostForWorkspacePath, projectRuntimeHostForWorkspacePath, projectRuntimeHostList } =
  projectRuntimeHostActivationService;
const projectRuntimeHostResolver = createProjectRuntimeHostResolver<ProjectRuntimeHost, ProjectStore>({
  normalizeWorkspacePath,
  projectRuntimeHostList: () => projectRuntimeHostList(),
  activeProjectRuntimeHost: () => projectRuntimeHostActivationService.activeProjectRuntimeHost(),
  requireActiveProjectRuntimeHost: () => requireActiveProjectRuntimeHost(),
  ensureProjectRuntimeHostForWorkspacePath: (workspacePath) => ensureProjectRuntimeHostForWorkspacePath(workspacePath),
  listRegisteredProjectPaths: () => projectRegistry.listRegisteredPaths(),
  existsSync,
  createProjectStore: () => {
    const targetStore = new ProjectStore();
    return {
      store: targetStore,
      openWorkspace: (workspacePath, options) => targetStore.openWorkspace(workspacePath, options),
      close: () => targetStore.close(),
    };
  },
});
const {
  projectRuntimeHostForTerminal,
  projectRuntimeHostForThread,
  requireProjectRuntimeHostForThread,
  requireProjectRuntimeHostForStoreRecord,
  requireProjectRuntimeHostForWorkflowThread,
  requireProjectRuntimeHostForWorkflowRecording,
  requireProjectRuntimeHostForWorkflowLabRun,
  requireProjectRuntimeHostForWorkflowDiscoveryQuestion,
  requireProjectRuntimeHostForWorkflowVersion,
  projectRuntimeHostForKnownWorkspacePath,
  requireProjectRuntimeHostForPermissionGrantInput,
  requireProjectRuntimeHostForPermissionGrant,
  requireProjectRuntimeHostForAutomationThread,
  requireProjectRuntimeHostForAutomationSchedule,
  requireProjectRuntimeHostForAutomationScheduleTarget,
  requireProjectRuntimeHostForWorkflowRevision,
  requireProjectRuntimeHostForWorkflowArtifact,
  requireProjectRuntimeHostForPlannerPlanArtifact,
  requireProjectRuntimeHostForMessageVoiceState,
  projectRuntimeHostForWorkflowRun,
  requireProjectRuntimeHostForWorkflowRun,
  requireProjectRuntimeHostForCallableWorkflowTask,
  requireProjectRuntimeHostForSubagentRun,
  requireProjectRuntimeHostForSubagentWaitBarrier,
  requireProjectRuntimeHostForOrchestrationTask,
  requireProjectRuntimeHostForOrchestrationRun,
  requireProjectRuntimeHostForOrchestrationWorkspace,
} = projectRuntimeHostResolver;
const projectRuntimeThreadActionHostService = createProjectRuntimeThreadActionHostService<ProjectRuntimeHost>({
  normalizeWorkspacePath,
  projectRuntimeHostForThread,
  ensureProjectRuntimeHostForWorkspacePath,
  resolveRegisteredProjectPathForHost: (projectId, fallbackHost) => resolveRegisteredProjectPathForHost(projectId, fallbackHost),
  requireActiveProjectRuntimeHost: () => requireActiveProjectRuntimeHost(),
});
const { requireProjectRuntimeHostForThreadAction } = projectRuntimeThreadActionHostService;
const sttDesktopService = createSttDesktopService<ProjectRuntimeHost, ProjectStore>({
  activeProjectRuntimeHost: () => requireActiveProjectRuntimeHost(),
  activeThreadIdForHost,
  activeWorkspacePath: () => activeWorkspacePath(),
  emitDesktopState: () => emitDesktopState(),
  emitDesktopEvent: emitMainWindowDesktopEvent,
  emitRuntimeFeatureStateUpdated,
  getSttSettings: () => sttSettings,
  normalizeWorkspacePath,
  requireProjectRuntimeHostForThread,
  runner: runAmbientCliPackageCommand,
  setSttSettings: (next) => {
    sttSettings = next;
  },
  settingsPath: () => appearancePreferencesPath(),
  writeSttSettings,
});
const {
  activeVoiceSttContextForProjectHost,
  cancelSttTranscription,
  clearSttRuntimes,
  currentSttQueueState,
  disposeSttRuntimeForWorkspace,
  listSttDiagnostics,
  listSttProvidersWithValidation,
  setSttTtsSpeaking,
  setupSttProvider,
  transcribeSttAudio,
  updateSttSettings,
} = sttDesktopService;
const voiceArtifactBudgetBridge: {
  enforceVoiceArtifactBudget?: (workspacePath: string, targetStore: ProjectStore) => Promise<void>;
} = {};
const voiceSettingsDesktopService: VoiceSettingsDesktopService<ProjectStore> = createVoiceSettingsDesktopService<ProjectStore>({
  activeWorkspacePath: () => activeWorkspacePath(),
  defaultStore: () => store,
  emitDesktopState: () => emitDesktopState(),
  enforceVoiceArtifactBudget: (workspacePath, targetStore) => {
    const enforceVoiceArtifactBudget = voiceArtifactBudgetBridge.enforceVoiceArtifactBudget;
    if (!enforceVoiceArtifactBudget) throw new Error("Voice artifact budget service is not initialized.");
    return enforceVoiceArtifactBudget(workspacePath, targetStore);
  },
  settingsPath: () => appearancePreferencesPath(),
});
const {
  listEmbeddingProvidersForSettings,
  listVoiceProviders,
  listVoiceProvidersWithCachedVoices,
  listVoiceSettingsAudit,
  readVoiceSettings: readCurrentVoiceSettings,
  refreshVoiceProviderCatalog,
  resolveVoiceProviderWorkspacePath,
  setVoiceSettings,
  updateVoiceSettings,
} = voiceSettingsDesktopService;
const localDeepResearchDesktopService = createLocalDeepResearchDesktopService({
  activeWorkspacePath: () => activeVoiceSttContextForProjectHost().workspacePath,
  discoverAmbientCliCatalog: (workspacePath) => discoverAmbientCliPackages(workspacePath, { includeHealth: false }),
  discoverWebResearchMcpProviderTools: async (workspacePath) => {
    try {
      const { toolHive, catalog } = createMcpInstallCatalog();
      const bridge = new McpToolBridge({
        catalog,
        toolHive,
        workspacePath,
      });
      return bridge.searchTools({ limit: 50, refresh: false });
    } catch {
      return [];
    }
  },
  emitDesktopEvent: emitMainWindowDesktopEvent,
  getLocalDeepResearchSettings: () => localDeepResearchSettings,
  getSearchRoutingSettings: () => searchRoutingSettings,
  listEmbeddingProvidersForSettings: () => listEmbeddingProvidersForSettings(),
  listVoiceProvidersWithCachedVoices: () => listVoiceProvidersWithCachedVoices(),
  showMessageBox: (options) => (mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options)),
});
const { listLocalDeepResearchRunsForSettings, setupLocalDeepResearch } = localDeepResearchDesktopService;
const miniCpmVisionDesktopService = createMiniCpmVisionDesktopService({
  activeWorkspacePath: () => activeVoiceSttContextForProjectHost().workspacePath,
  env: process.env,
});
const { analyzeMiniCpmVision, setupMiniCpmVision } = miniCpmVisionDesktopService;
const projectRuntimeLifecycleService = createProjectRuntimeLifecycleService<ProjectRuntimeHost>({
  defaultRuntimeResetReason: RUNTIME_RESET_INTERRUPTED_RUN_MESSAGE,
  normalizeWorkspacePath,
  projectRuntimeHostList: () => projectRuntimeHostList(),
  activeProjectRuntimeHost: () => projectRuntimeHostActivationService.activeProjectRuntimeHost(),
  projectRuntimeHostForWorkspacePath: (workspacePath) => projectRuntimeHostForWorkspacePath(workspacePath),
  removeProjectRuntimeHost: (workspacePath) => projectRuntimeHostActivationService.removeProjectRuntimeHost(workspacePath),
  clearProjectRuntimeHosts: () => projectRuntimeHostActivationService.clearProjectRuntimeHosts(),
  clearSttRuntimes,
  clearActiveProjectRuntimeHost: () => projectRuntimeHostActivationService.clearActiveProjectRuntimeHost(),
  stopAutoDispatch: (reason, host) => stopAutoDispatch(reason, host),
  disposeSttRuntimeForWorkspace,
  releaseAgentMemoryEmbeddingRuntimeForHost: (host, reason) => releaseAgentMemoryEmbeddingRuntimeForHost(host, reason),
  shutdownPluginMcpServers: () => pluginHost?.shutdownPluginMcpServers(),
  shutdownPluginMcpServersForWorkspace: (workspacePath) => pluginHost.shutdownPluginMcpServersForWorkspace(workspacePath),
  warn: (message) => console.warn(message),
});
const { resetRuntimeAndPluginServers, resetProjectRuntimeAndPluginServers, disposeProjectRuntimeHost, disposeAllProjectRuntimeHosts } =
  projectRuntimeLifecycleService;
const desktopStateSnapshotService = createDesktopStateSnapshotService<ProjectStore>({
  activeThreadId: () => activeThreadId,
  setActiveThreadId: (threadId) => {
    setActiveThreadId(threadId);
  },
  store: () => store,
  appInfo: () => ({
    name: app.getName(),
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    build: {
      channel: process.env.AMBIENT_RELEASE_CHANNEL || (app.isPackaged ? "release" : "development"),
      ...(process.env.AMBIENT_BUILD_COMMIT ? { commit: process.env.AMBIENT_BUILD_COMMIT } : {}),
    },
    piVersions: {
      piAi: packageVersion("@mariozechner/pi-ai"),
      piCodingAgent: packageVersion("@mariozechner/pi-coding-agent"),
    },
    update: desktopUpdateService.getState(),
    thirdPartyCredits: thirdPartyCredits(lambdaRlmThirdPartyCreditSource),
  }),
  appearance: () => currentAppearance(),
  workspaceStateForThread: (thread, targetStore) => workspaceStateForThread(thread, targetStore),
  currentFeatureFlagSnapshot: (targetStore) => currentFeatureFlagSnapshot(targetStore),
  isSubagentUiEnabled: (featureFlagSnapshot) => isAmbientSubagentsEnabled(featureFlagSnapshot),
  providerCatalog: () => providerCatalogSettingsState(),
  activeProjectBoardForState: (targetStore, threadId) => activeProjectBoardForState(targetStore, threadId),
  activeProjectSummary: (workspace, threads, board) => activeProjectSummary(workspace, threads, board),
  listProjects: (workspacePath, activeProject) => projectRegistry.listProjects(workspacePath, activeProject),
  listGlobalWorkflowAgentFolders: () => listGlobalWorkflowAgentFolders(),
  listGlobalWorkflowRecordingLibrary: (input) => listGlobalWorkflowRecordingLibrary(input),
  settingsSlots: () => ({
    voiceSettingsAudit: listVoiceSettingsAudit(),
    thinkingDisplay: thinkingDisplaySettings,
    media: mediaPlaybackSettings,
    planner: plannerSettings,
    search: searchRoutingSettings,
    localDeepResearch: localDeepResearchSettings,
    voice: readCurrentVoiceSettings(),
    stt: sttSettings,
  }),
  currentModelRuntimeCatalog: (generatedAt, targetStore) => currentModelRuntimeCatalog(generatedAt, targetStore),
  providerStatus: (model) => getAmbientProviderStatus(model),
  secureStorageStatus: () => currentSecureStorageStatus({ appAvailable: true }),
  secureStorageRepair: () => secureStorageRepairGuidance(currentSecureStorageStatus({ appAvailable: true })),
  namedSecrets: () => namedSecretStore?.list() ?? [],
  queueState: (threadId) => emptyQueueState(threadId),
  sttQueueState: (workspacePath) => currentSttQueueState(workspacePath),
  sttDiagnostics: (workspacePath) => listSttDiagnostics(workspacePath),
});
const desktopStateEventService = createDesktopStateEventService<ProjectStore, ProjectRuntimeHost>({
  activeThreadId: () => activeThreadId,
  activeWorkspacePath: () => activeWorkspacePath(),
  defaultStore: () => store,
  emitDesktopEvent: emitMainWindowDesktopEvent,
  isActiveProjectRuntimeHost: (host) => isActiveProjectRuntimeHost(host),
  readState: (threadId, options) => readState(threadId, options),
});
const {
  emitDesktopState,
  emitOrchestrationUpdated,
  emitPermissionAuditCreated,
  emitPermissionGrantCreated,
  emitPermissionGrantRevoked,
  emitPlannerPlanArtifactUpdated,
  emitPluginCatalogUpdated,
  emitProjectScopedEvent,
  emitProjectStateIfActive,
  emitThreadUpdated,
  emitWorkflowEvent,
  emitWorkflowRecordingLibraryStateChanged,
  emitWorkflowUpdated,
  permissionGrantWorkspacePath,
  readStateForProjectHostAction,
} = desktopStateEventService;
const subagentRuntimeStartupReconciliationService = createSubagentRuntimeStartupReconciliationService<ProjectStore, ProjectRuntimeHost>({
  currentFeatureFlagSnapshot: (targetStore) => currentFeatureFlagSnapshot(targetStore),
  emitProjectScopedEvent,
  warn: (message) => console.warn(message),
});
const permissionGrantRegistryDesktopService = createPermissionGrantRegistryDesktopService<ProjectStore, ProjectRuntimeHost>({
  defaultStore: () => store,
  activeThreadId: () => activeThreadId,
  activeThreadIdForHost,
  initialActiveThreadIdForStore,
  projectRuntimeHostForStore,
  requester: permissions,
  emitPermissionGrantCreated,
});
const { requestPermissionWithGrantRegistry } = permissionGrantRegistryDesktopService;
const plannerDurableArtifactDesktopService = createPlannerDurableArtifactDesktopService<ProjectRuntimeHost, ProjectStore>({
  requireProjectRuntimeHostForPlannerPlanArtifact,
  emitPlannerPlanArtifactUpdated,
  emitProjectStateIfActive,
  writePlannerDurableHtmlArtifact,
  plannerDurableFallbackWarnings,
  validatePlannerDurableHtmlFileInBrowser,
  commitGitPaths,
  warn: (message) => console.warn(message),
});
const { generatePlannerDurableArtifact } = plannerDurableArtifactDesktopService;
const browserDesktopStateService = createBrowserDesktopStateService<
  ThreadSummary,
  ReturnType<ProjectStore["addPermissionAudit"]>,
  Awaited<ReturnType<BrowserService["getState"]>>,
  ProjectStore,
  ProjectRuntimeHost
>({
  activeHost: () => requireActiveProjectRuntimeHost(),
  activeThreadIdForHost,
  emitDesktopEvent: emitMainWindowDesktopEvent,
  emitPermissionAuditCreated,
});
const { emitBrowserState, emitBrowserStateForHost, recordBrowserControlAudit, recordBrowserProfileAudit, withBrowserState } =
  browserDesktopStateService;
const workflowTraceRetentionService = createWorkflowTraceRetentionService<ProjectRuntimeHost>({
  projectRuntimeHostList: () => projectRuntimeHostList(),
  emitWorkflowUpdated,
  setTimeout,
  clearTimeout,
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
});
const { stopWorkflowTraceRetentionSweep, scheduleWorkflowTraceRetentionSweep, runWorkflowTraceRetentionSweep } =
  workflowTraceRetentionService;
const workspaceContextCacheService = createWorkspaceContextCacheService<ProjectRuntimeHost, ProjectStore>({
  projectRuntimeHostList: () => projectRuntimeHostList(),
  activeStore: () => store,
  clearImportedWorkspaceContext,
  clearImportedWorkspaceContextSync,
  warn: (message) => console.warn(message),
});
const { clearImportedWorkspaceContextCache, clearImportedWorkspaceContextCacheSync } = workspaceContextCacheService;
const projectRuntimeWorkspaceSwitchService = createProjectRuntimeWorkspaceSwitchService<ProjectRuntimeHost, DesktopState>({
  activateProjectRuntimeHost: (workspacePath) => activateProjectRuntimeHost(workspacePath),
  clearImportedWorkspaceContextCacheSync: (reason) => clearImportedWorkspaceContextCacheSync(reason),
  runWorkflowTraceRetentionSweep: (reason, host) => runWorkflowTraceRetentionSweep(reason, host),
  scheduleWorkflowTraceRetentionSweep,
  scheduleAutoDispatch: (delayMs, host) => scheduleAutoDispatch(delayMs, host),
  registerProjectWorkspacePath: (workspacePath) => projectRegistry.register(workspacePath),
  initialActiveThreadId: () => initialActiveThreadId(),
  setActiveThreadId: (threadId) => setActiveThreadId(threadId),
  readState: (threadId) => readState(threadId),
});
const { switchWorkspace } = projectRuntimeWorkspaceSwitchService;
const projectRuntimeIpcContextService = createProjectRuntimeIpcContextService<
  ProjectRuntimeHost,
  ProjectStore,
  BrowserService,
  DesktopState,
  ReturnType<typeof buildWorkflowDebugRewriteContext>
>({
  activeThreadId: () => activeThreadId,
  defaultStore: () => store,
  activeProjectRuntimeHost: () => projectRuntimeHostActivationService.activeProjectRuntimeHost(),
  requireActiveProjectRuntimeHost: () => requireActiveProjectRuntimeHost(),
  ensureProjectRuntimeHostForWorkspacePath: (workspacePath) => ensureProjectRuntimeHostForWorkspacePath(workspacePath),
  requireProjectRuntimeHostForWorkflowArtifact: (artifactId) => requireProjectRuntimeHostForWorkflowArtifact(artifactId),
  requireProjectRuntimeHostForWorkflowDiscoveryQuestion: (questionId) => requireProjectRuntimeHostForWorkflowDiscoveryQuestion(questionId),
  requireProjectRuntimeHostForWorkflowRevision: (revisionId) => requireProjectRuntimeHostForWorkflowRevision(revisionId),
  requireProjectRuntimeHostForWorkflowRun: (runId) => requireProjectRuntimeHostForWorkflowRun(runId),
  requireProjectRuntimeHostForWorkflowThread: (workflowThreadId) => requireProjectRuntimeHostForWorkflowThread(workflowThreadId),
  activeThreadIdForHost: (host) => activeThreadIdForHost(host),
  setProjectHostActiveThreadId: (host, threadId) => setProjectHostActiveThreadId(host, threadId),
  activeProjectBoardForState: (targetStore, threadId) => activeProjectBoardForState(targetStore, threadId),
  activeProjectBoardThreadIdForStore: (targetStore) => activeProjectBoardThreadIdForStore(targetStore),
  buildWorkflowDebugRewriteContext: (targetStore, input) => buildWorkflowDebugRewriteContext(targetStore, input),
  createProjectStore: () => {
    const targetStore = new ProjectStore();
    return {
      store: targetStore,
      openWorkspace: (workspacePath) => targetStore.openWorkspace(workspacePath),
      close: () => targetStore.close(),
    };
  },
  emitState: (state) => mainWindow?.webContents.send("desktop:event", { type: "state", state }),
  ensureDirectory: (workspacePath) => mkdirSync(workspacePath, { recursive: true }),
  homePath: () => app.getPath("home"),
  normalizeWorkspacePath,
  projectRegistry: () => projectRegistry,
  switchWorkspace: (workspacePath) => switchWorkspace(workspacePath),
});
const {
  activeProjectIpcContext,
  createProjectWorkspaceForRuntime,
  listRuntimeProjects,
  resolveRegisteredProjectPathForHost,
  switchProjectWorkspaceForRuntime,
  workflowAgentIpcContextForDiscoveryQuestion,
  workflowAgentIpcContextForWorkflowThread,
  workflowArtifactIpcContext,
  workflowArtifactIpcContextForHost,
  workflowCompileIpcContext,
  workflowDebugRewriteIpcContext,
  workflowProjectIpcContext,
} = projectRuntimeIpcContextService;
const workspaceSearchDesktopService = createWorkspaceSearchDesktopService<ProjectStore, ProjectRuntimeHost>({
  activeProjectBoardForState,
  activeProjectBoardThreadIdForStore,
  activeProjectSummary,
  activeThreadIdForHost,
  projectRegistry: () => projectRegistry,
  readProjectSearchResults,
  requireActiveProjectRuntimeHost: () => requireActiveProjectRuntimeHost(),
  requireProjectRuntimeHostForThread,
});
const { searchWorkspace } = workspaceSearchDesktopService;
const mainWindowRendererDiagnosticsService = createMainWindowRendererDiagnosticsService<ProjectRuntimeHost, BrowserWindow>({
  activeProjectRuntimeHost: () => projectRuntimeHostActivationService.activeProjectRuntimeHost(),
  activeThreadIdForHost: (host) => activeThreadIdForHost(host),
  userDataPath: () => app.getPath("userData"),
  rendererUrl: () => process.env.ELECTRON_RENDERER_URL,
  rendererIndexPath: () => resolveBuiltOutputPath("renderer", "index.html"),
  redactSensitiveText,
  now: () => new Date(),
  nowMs: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
});
const { recordRendererDiagnosticBreadcrumb, installMainWindowDiagnostics, loadMainWindowRenderer } = mainWindowRendererDiagnosticsService;
const containerRuntimeApplicationOpener = createContainerRuntimeApplicationOpener({
  platform: process.platform,
  log: (message) => console.log(message),
});
const { openContainerRuntimeApplication, runMacOpen } = containerRuntimeApplicationOpener;
const externalNavigationService = createExternalNavigationService<ProjectRuntimeHost>({
  platform: process.platform,
  openExternal: (url) => shell.openExternal(url),
  openMacApplication: (args) => runMacOpen(args),
  recordRendererDiagnosticBreadcrumb,
  requireActiveProjectRuntimeHost: () => requireActiveProjectRuntimeHost(),
  activeThreadIdForHost: (host) => activeThreadIdForHost(host),
  navigateLocalUrlInAmbientBrowser: (host, url) => withBrowserState(host, host.browserService.navigate({ url, profileMode: "isolated" })),
  revealActiveBrowser: (host) => host.browserService.revealActiveBrowser(),
  recordBrowserControlAudit,
  emitBrowserStateForHost,
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
});
const {
  installExternalNavigationGuards,
  isGoogleWorkspaceSetupUrl,
  isLoopbackWebUrl,
  openAllowedExternalUrl,
  openGoogleWorkspaceUrl,
  openRendererLocalUrlInAmbientBrowser,
  parseExternalOpenUrl,
} = externalNavigationService;
const settingsRuntimeService = createSettingsRuntimeService<ProjectRuntimeHost>({
  appearancePreferencesPath: () => appearancePreferencesPath(),
  setThemePreferenceState: (preference) => applyThemePreference(preference),
  publishAppearanceUpdated,
  requireActiveProjectRuntimeHost: () => requireActiveProjectRuntimeHost(),
  currentFeatureFlagSnapshot: (targetStore) => currentFeatureFlagSnapshot(targetStore),
  emitDesktopState,
  emitProjectStateIfActive: (host) => emitProjectStateIfActive(host),
  memoryLifecycle: {
    defaultManagedEmbeddingAutoStartEnabled: (settings, targetStore) =>
      agentMemoryDefaultManagedEmbeddingAutoStartEnabled(settings, targetStore),
    defaultManagedEmbeddingAutoStartEnabledForFeature: (settings, featureEnabled) =>
      agentMemoryDefaultManagedEmbeddingAutoStartEnabledForFeature(settings, featureEnabled),
    shouldStartManagedEmbeddingsAfterSettingsUpdate: (previous, next) =>
      shouldStartAgentMemoryManagedEmbeddingsAfterSettingsUpdate(previous, next),
    startManagedEmbeddingsAfterSettingsUpdate: (host, targetStore) =>
      startAgentMemoryManagedEmbeddingsAfterSettingsUpdate(host, targetStore),
    stopManagedEmbeddingsAfterSettingsUpdate: (host, targetStore) => stopAgentMemoryManagedEmbeddingsAfterSettingsUpdate(host, targetStore),
  },
  mediaPlaybackSettings: {
    get: () => mediaPlaybackSettings,
    set: (value) => {
      mediaPlaybackSettings = value;
    },
  },
  thinkingDisplaySettings: {
    get: () => thinkingDisplaySettings,
    set: (value) => {
      thinkingDisplaySettings = value;
    },
  },
  plannerSettings: {
    get: () => plannerSettings,
    set: (value) => {
      plannerSettings = value;
    },
  },
  searchRoutingSettings: {
    get: () => searchRoutingSettings,
    set: (value) => {
      searchRoutingSettings = value;
    },
  },
  localDeepResearchSettings: {
    get: () => localDeepResearchSettings,
    set: (value) => {
      localDeepResearchSettings = value;
    },
  },
  normalizeThinkingDisplaySettings,
  normalizePlannerSettings,
  normalizeSearchRoutingSettings,
  normalizeLocalDeepResearchAppSettings,
  writeThemePreference,
  writeMediaPlaybackSettings,
  writeThinkingDisplaySettings,
  writePlannerSettings,
  writeSearchRoutingSettings,
  writeLocalDeepResearchSettings,
  saveModelProviderCredentialForSettingsImpl: saveModelProviderCredentialForSettings,
  installModelProviderEndpointForSettingsImpl: installModelProviderEndpointForSettings,
  readSecretReferenceImpl: readSecretReference,
  discoverAmbientCliCatalogForSearchRouting: (workspacePath) => discoverAmbientCliPackages(workspacePath, { includeHealth: false }),
  discoverMcpToolsForSearchRouting: async (workspacePath) => {
    const { toolHive, catalog } = createMcpInstallCatalog();
    const bridge = new McpToolBridge({
      catalog,
      toolHive,
      workspacePath,
    });
    return bridge.searchTools({ limit: 50, refresh: false });
  },
  hydrateWebResearchSettingsImpl: (input) => hydrateWebResearchSettings(input as Parameters<typeof hydrateWebResearchSettings>[0]),
});
const {
  hydrateSearchRoutingSettingsForActiveWorkspace,
  installModelProviderEndpoint,
  runLocalModelRuntimeLifecycleAction,
  saveModelProviderCredential,
  setThemePreference,
  updateFeatureFlagSettings,
  updateLocalDeepResearchSettings,
  updateMediaPlaybackSettings,
  updateMemorySettings,
  updateModelRuntimeSettings,
  updatePlannerSettings,
  updateSearchRoutingSettings,
  updateThinkingDisplaySettings,
} = settingsRuntimeService;
const mainWindowBootstrapService = createMainWindowBootstrapService<ProjectRuntimeHost, BrowserWindow>({
  isDarwin: process.platform === "darwin",
  startupWorkspacePath: () => startupWorkspacePath(),
  activateProjectRuntimeHost: (workspacePath) => activateProjectRuntimeHost(workspacePath),
  clearManagedVoiceArtifactCache: (reason, workspacePath, targetStore) =>
    clearManagedVoiceArtifactCache(reason, workspacePath, targetStore),
  clearImportedWorkspaceContextCache: (reason) => clearImportedWorkspaceContextCache(reason),
  runWorkflowTraceRetentionSweep: (reason, host) => runWorkflowTraceRetentionSweep(reason, host),
  scheduleWorkflowTraceRetentionSweep,
  scheduleAutoDispatch: (delayMs, host) => scheduleAutoDispatch(delayMs, host),
  registerProjectWorkspacePath: (workspacePath) => projectRegistry.register(workspacePath),
  ensureWelcomeOnboardingProject: () =>
    ensureWelcomeOnboardingProject({
      userDataPath: app.getPath("userData"),
      projectRegistry,
      createProjectStore: () => new ProjectStore(),
      assetsSourcePath: resolveWelcomeOnboardingAssetsPath([
        process.resourcesPath ? join(process.resourcesPath, "welcome-onboarding") : undefined,
        join(app.getAppPath(), "resources", "welcome-onboarding"),
        join(process.cwd(), "resources", "welcome-onboarding"),
      ]),
    }),
  resolveAppIconPath,
  readWindowState: () => windowStateService.readWindowState(),
  setDockIcon,
  currentBackgroundColor: () => currentBackgroundColor(),
  preloadPath: () => resolveBuiltOutputPath("preload", "index.cjs"),
  createBrowserWindow: (options) => new BrowserWindow(options),
  setMainWindow: (window) => {
    mainWindow = window;
  },
  mainWindow: () => mainWindow,
  ensureWindowVisible: (window) => windowStateService.ensureWindowVisible(window),
  trackWindowState: (window) => windowStateService.trackWindowState(window),
  installExternalNavigationGuards: (window) =>
    installExternalNavigationGuards(window, {
      source: "main-window",
      allowNavigation: isTrustedRendererUrl,
    }),
  installMainWindowDiagnostics,
  loadMainWindowRenderer,
});
const { createWindow, showOrCreateMainWindow } = mainWindowBootstrapService;
const threadMiniWindowService = createThreadMiniWindowService<BrowserWindow>({
  platform: process.platform,
  currentTheme: () => currentResolvedTheme(),
  thinkingDisplayMode: () => thinkingDisplaySettings.mode,
  renderThreadMiniWindowHtml,
  resolveAppIconPath,
  currentBackgroundColor: () => currentBackgroundColor(),
  createBrowserWindow: (options) => new BrowserWindow(options),
  installExternalNavigationGuards: (window) =>
    installExternalNavigationGuards(window, {
      source: "thread-mini-window",
      allowNavigation: isThreadMiniWindowRendererUrl,
    }),
});
const { openThreadMiniWindow } = threadMiniWindowService;
const desktopAppLifecycleService = createDesktopAppLifecycleService({
  app,
  isDarwin: process.platform === "darwin",
  startDesktopUpdateService: () => desktopUpdateService.start(),
  disposeDesktopUpdateService: () => desktopUpdateService.dispose(),
  installAppMenu: () =>
    installAppMenu(() => mainWindow, {
      onCheckForUpdates: () => {
        void appMenuUpdateService.checkForUpdatesFromAppMenu();
      },
    }),
  showOrCreateMainWindow: () => showOrCreateMainWindow(),
  reconcileMcpContainerRuntimeOnStartup,
  reconcileLocalDeepResearchInstallJob: () => reconcileLocalDeepResearchInstallJob(undefined),
  clearManagedVoiceArtifactCaches: (reason) => clearManagedVoiceArtifactCachesForRuntimeHostsSync(reason),
  clearImportedWorkspaceContextCache: (reason) => clearImportedWorkspaceContextCacheSync(reason),
  closeLocalPreviewServers: () => rendererLocalPreviewServers.closeAll(),
  stopWorkflowTraceRetentionSweep,
  disposeAllProjectRuntimeHosts,
  shutdownPluginMcpServers: () => pluginHost?.shutdownPluginMcpServers(),
  disposeGoogleSidecarSupervisor: () => googleSidecarSupervisor?.dispose(),
  denyAllPermissions: () => permissions.denyAll(),
  quitApp: () => app.quit(),
  warn: (message) => console.warn(message),
});
const { startPostWindowStartupLifecycle, installShutdownHandlers } = desktopAppLifecycleService;
const workflowRecordingGlobalLibraryDesktopService = createWorkflowRecordingGlobalLibraryDesktopService<ProjectRuntimeHost, ProjectStore>({
  normalizeWorkspacePath,
  projectRuntimeHostList: () => projectRuntimeHostList(),
  activeProjectRuntimeHost: () => projectRuntimeHostActivationService.activeProjectRuntimeHost(),
  activeStore: () => store,
  listRegisteredProjectPaths: () => projectRegistry.listRegisteredPaths(),
  existsSync,
  createProjectStore: () => {
    const targetStore = new ProjectStore();
    return {
      store: targetStore,
      openWorkspace: (workspacePath, options) => targetStore.openWorkspace(workspacePath, options),
      close: () => targetStore.close(),
    };
  },
  requireProjectRuntimeHostForWorkflowRecording,
  emitWorkflowRecordingLibraryStateChanged,
  describeAmbientWorkflowPlaybook,
  injectAmbientWorkflowPlaybook,
  updateAmbientWorkflowPlaybook,
  archiveAmbientWorkflowPlaybook,
  unarchiveAmbientWorkflowPlaybook,
  restoreAmbientWorkflowPlaybookVersion,
  warn: (message) => console.warn(message),
});
const {
  listGlobalWorkflowRecordingLibrary,
  listGlobalWorkflowAgentFolders,
  searchGlobalAmbientWorkflowPlaybooks,
  describeGlobalAmbientWorkflowPlaybook,
  injectGlobalAmbientWorkflowPlaybook,
  updateGlobalAmbientWorkflowPlaybook,
  archiveGlobalAmbientWorkflowPlaybook,
  unarchiveGlobalAmbientWorkflowPlaybook,
  restoreGlobalAmbientWorkflowPlaybookVersion,
} = workflowRecordingGlobalLibraryDesktopService;
const activeWorkflowRunRegistry = createWorkflowActiveRunRegistry<ProjectRuntimeHost>({
  normalizeWorkspacePath,
  projectRuntimeHostForKnownWorkspacePath,
  projectRuntimeHostForWorkspacePath,
});
const threadWorkspaceGitService = createThreadWorkspaceGitService<ProjectRuntimeHost, ProjectStore>({
  activeThread: () => store.getThread(activeThreadId),
  activeStore: () => store,
  requireActiveProjectRuntimeHost,
  activeThreadIdForHost,
  prepareThreadWorktree,
  attachExistingThreadWorktree,
  getWorkspaceGitStatus,
  createGitCheckpoint,
  latestGitCheckpoint,
  getGitReview,
});
const {
  activeGitContextForProjectHost,
  attachWorktreeForThread,
  createAndRecordCheckpoint,
  prepareWorktreeForThread,
  readGitReviewForProjectHost,
  threadWorkingDirectory,
} = threadWorkspaceGitService;
const workflowRuntimeFeatureActionsService = createWorkflowRuntimeFeatureActionsService<ProjectStore, BrowserService>({
  defaultContext: () => activeRuntimeFeatureHostContext(),
  activeWorkflowRunController: activeWorkflowRunRegistry.activeWorkflowRunController,
  ambientCliCapabilityGrantsForWorkflowRequest,
  buildWorkflowRecoveryPlan,
  compileWorkflowArtifact,
  connectorAccountAuthorizer: () => firstPartyWorkflowConnectorAccountAuthorizer(),
  connectorDescriptors: () => firstPartyWorkflowConnectorDescriptors(),
  connectorRegistrations: () => firstPartyWorkflowConnectorRegistrations(),
  createExplorationProvider: ({ apiKey, baseUrl, retryPolicy }) =>
    new AmbientWorkflowExplorationProvider({
      apiKey,
      baseUrl,
      retryPolicy,
    }),
  emitDesktopEvent: emitMainWindowDesktopEvent,
  emitWorkflowEvent,
  emitWorkflowUpdated,
  ensureWorkflowPluginTrusted,
  forgetActiveWorkflowRunsForController: activeWorkflowRunRegistry.forgetActiveWorkflowRunsForController,
  listPluginMcpRegistrationsForThread: pluginMcpRegistrationsForThread,
  listPluginRegistry: (workspacePath, targetStore) => pluginHost.listRegistry(workspacePath, pluginStateReaderForStore(targetStore)),
  markStaleWorkflowRunForRecoveryIfNeeded,
  pluginCaller: (plan, invocation, options) => pluginHost.callCodexPluginMcpTool(plan, invocation, options),
  providerStatus: (model) => getAmbientProviderStatus(model),
  readAmbientApiKey,
  rememberActiveWorkflowRun: activeWorkflowRunRegistry.rememberActiveWorkflowRun,
  requestPermissionWithGrantRegistry,
  retryPolicy: (targetStore) => ambientRetryPolicyFromCurrentSettings(targetStore),
  reviewWorkflowArtifact,
  runWorkflowArtifact,
  runWorkflowThreadExploration,
  searchRoutingSettings: () => searchRoutingSettings,
  toolDescriptorsFromPluginRegistry: workflowToolDescriptorsFromPluginRegistry,
  workspaceInventoryConnector,
  workspaceStateForThread: (thread, targetStore) => workspaceStateForThread(thread, targetStore),
});
configureDesktopMcpInstallService({
  activeThreadIdForHost: (host) => activeThreadIdForHost(host as ProjectRuntimeHost),
  emitMainWindowDesktopEvent,
  emitPluginCatalogUpdated,
  getAppVersion: () => packageJson.version,
  getUserDataPath: () => app.getPath("userData"),
  openContainerRuntimeApplication,
  permissionGrantTargetHash,
  requestPermissionWithGrantRegistry: (request, input) =>
    requestPermissionWithGrantRegistry(request, input as Parameters<typeof requestPermissionWithGrantRegistry>[1]),
});
configureAgentMemoryDesktopService({
  activeThreadIdForHost: (host) => activeThreadIdForHost(host as ProjectRuntimeHost),
  currentFeatureFlagSnapshot: (targetStore) => currentFeatureFlagSnapshot(targetStore as ProjectStore),
  emitProjectStateIfActive: (host, threadId) => emitProjectStateIfActive(host as ProjectRuntimeHost, threadId),
  normalizeWorkspacePath,
  requireActiveProjectRuntimeHost: () => requireActiveProjectRuntimeHost(),
  updateFeatureFlagSettings: (input, host, options) => updateFeatureFlagSettings(input, host as ProjectRuntimeHost, options),
  updateMemorySettings: (input, host, options) => updateMemorySettings(input, host as ProjectRuntimeHost, options),
});
configureOrchestrationAutoDispatchService({
  activeThreadIdForHost: (host) => activeThreadIdForHost(host as ProjectRuntimeHost),
  callPluginMcpTool: (plan, invocation, options) => pluginHost.callCodexPluginMcpTool(plan as never, invocation as never, options as never),
  emitDesktopEvent: (event) => mainWindow?.webContents.send("desktop:event", event),
  emitPermissionAuditCreated,
  emitProjectScopedEvent: (host, event) => emitProjectScopedEvent(host as ProjectRuntimeHost, event),
  emitProjectStateIfActive: (host, threadId) => emitProjectStateIfActive(host as ProjectRuntimeHost, threadId),
  ensureWorkflowPluginTrusted: (thread, registration, targetStore) =>
    ensureWorkflowPluginTrusted(thread, registration as never, targetStore),
  firstPartyWorkflowConnectorAccountAuthorizer,
  firstPartyWorkflowConnectorRegistrations,
  forgetActiveWorkflowRun: activeWorkflowRunRegistry.forgetActiveWorkflowRun,
  listPluginMcpRegistrationsForThread: pluginMcpRegistrationsForThread,
  listPluginRegistry: (workspacePath, targetStore) => pluginHost.listRegistry(workspacePath, pluginStateReaderForStore(targetStore)),
  prepareWorktreeForThread,
  recordActiveProjectBoardExecutionReadinessBlocker,
  rememberActiveWorkflowRun: activeWorkflowRunRegistry.rememberActiveWorkflowRun,
  requestPermissionWithGrantRegistry,
  requireActiveProjectRuntimeHost: () => requireActiveProjectRuntimeHost(),
  reviewFinishedProjectBoardRun,
});
configureProjectBoardDesktopContextService({
  store: () => store,
  activeThreadId: () => activeThreadId,
  activeThreadIdForHost: (host) => activeThreadIdForHost(host as ProjectRuntimeHost),
  projectRuntimeHostForStore: (targetStore) => projectRuntimeHostForStore(targetStore as ProjectStore),
  requireProjectRuntimeHostForStoreRecord: (assertRecordExists) => requireProjectRuntimeHostForStoreRecord(assertRecordExists),
  requireActiveProjectRuntimeHost: () => requireActiveProjectRuntimeHost(),
  ensureProjectRuntimeHostForWorkspacePath: (workspacePath) => ensureProjectRuntimeHostForWorkspacePath(workspacePath),
  resolveRegisteredProjectPathForHost: (projectId, host) => resolveRegisteredProjectPathForHost(projectId, host as ProjectRuntimeHost),
  emitDesktopState,
  emitProjectStateIfActive: (host) => emitProjectStateIfActive(host as ProjectRuntimeHost),
  emitOrchestrationUpdated,
  readState: () => readState(),
  readStateForProjectHostAction: (host) => readStateForProjectHostAction(host as ProjectRuntimeHost),
  readOrchestrationWorkflowReadiness,
  workflowAutoDispatchDisabledMessage,
});
configureProjectBoardSynthesisDesktopService({
  store: () => store,
  emitProjectBoardState: (targetStore, host) => emitProjectBoardState(targetStore, host as ProjectRuntimeHost | undefined),
  emitProjectStateIfActive: (host) => emitProjectStateIfActive(host as ProjectRuntimeHost),
  readStateForProjectHostAction: (host) => readStateForProjectHostAction(host as ProjectRuntimeHost),
});
configureProjectBoardProofDefaultsDesktopService({
  store: () => store,
  emitDesktopState,
});
configureProjectBoardDogfoodDesktopService({
  applyProjectBoardIncrementalSynthesisFromRun,
  emitProjectStateIfActive: (host) => emitProjectStateIfActive(host as ProjectRuntimeHost),
  readStateForProjectHostAction: (host) => readStateForProjectHostAction(host as ProjectRuntimeHost),
  requireProjectBoardForAction,
  reviewFinishedProjectBoardRun,
});

const agentRuntimeFeatureFactory = createAgentRuntimeFeatureFactory<ProjectStore, BrowserService>({
  browserLoginBrokerEnabled,
  defaultStore: () => store,
  emitRuntimeFeatureStateUpdated,
  readFeatureFlagSnapshot: (targetStore) => currentFeatureFlagSnapshot(targetStore),
  userDataPath: () => app.getPath("userData"),
  appVersion: packageJson.version,
  env: process.env,
  localModelHostMemory: () => sampleLocalModelHostMemorySnapshot(),
  modelRuntime: (targetStore) => ({
    catalog: (generatedAt) => currentModelRuntimeCatalog(generatedAt ?? new Date().toISOString(), targetStore),
    resolveModelRuntimeProfile: (modelId) => currentModelRuntimeProfile(modelId, targetStore),
    learnProviderContextLimit: ({ modelId, overflow }) =>
      learnAmbientProviderContextLimit(modelId, overflow, targetStore),
  }),
  googleWorkspace: {
    readIntegration: () => readFirstPartyGoogleIntegration(),
    installCli: async () => {
      const install = await googleWorkspaceCliInstaller.install();
      refreshGoogleWorkspaceConnectorMode();
      return install;
    },
    startSetup: (input) => googleWorkspaceSetupService.start(input),
    importOAuthClient: (input) => googleWorkspaceSetupService.importOAuthClientConfig(input),
    cancelSetup: () => googleWorkspaceSetupService.cancel(),
    validate: (input) => googleWorkspaceSetupService.validate(input),
    searchMethods: (input) => googleWorkspaceMethodBroker.searchMethods(input),
    describeMethod: (input) => googleWorkspaceMethodBroker.describeMethod(input),
    resolveAccountHint: (accountHint) => googleWorkspaceSetupService.resolveAccountHintForCall(accountHint),
    call: (input) => googleWorkspaceMethodBroker.call(input),
    materializeFile: (input) => googleWorkspaceMethodBroker.materializeFile(input),
  },
  workflowNativeTools: {
    connectorDescriptors: () => firstPartyWorkflowConnectorDescriptors(),
    connectorRegistrations: () => firstPartyWorkflowConnectorRegistrations(),
    connectorAccountAuthorizer: () => firstPartyWorkflowConnectorAccountAuthorizer(),
  },
  localTextSubagents: localTextSubagentStartup.feature
    ? {
        resolveModelRuntimeProfile: localTextSubagentStartup.feature.resolveModelRuntimeProfile,
        resolveRuntimeForMain: localTextSubagentStartup.feature.resolveRuntimeForMain,
        resolveRuntimeForLaunch: localTextSubagentStartup.feature.resolveRuntimeForLaunch,
        resolveRuntime: localTextSubagentStartup.feature.resolveRuntime,
      }
    : undefined,
  readSearchSettings: () => searchRoutingSettings,
  updateSearchSettings: (input, options) => updateSearchRoutingSettings(input, options),
  readLocalDeepResearchSettings: () => localDeepResearchSettings,
  updateLocalDeepResearchSettings: (input, options) => updateLocalDeepResearchSettings(input, options),
  readMediaPlaybackSettings: () => mediaPlaybackSettings,
  updateMediaPlaybackSettings: (input, options) => updateMediaPlaybackSettings(input, options),
  readPlannerSettings: () => plannerSettings,
  updatePlannerSettings: (input, options) => updatePlannerSettings(input, options),
  listProjects: (targetStore) => listRuntimeProjects(targetStore),
  createProject: (input, targetStore) => createProjectWorkspaceForRuntime(input, targetStore),
  switchProject: (input) => switchProjectWorkspaceForRuntime(input),
  workflowAgents: {
    runExploration: (input, context) => workflowRuntimeFeatureActionsService.runExploration(input, context),
    compilePreview: (input, context) => workflowRuntimeFeatureActionsService.compilePreview(input, context),
    reviewArtifact: (input, context) => workflowRuntimeFeatureActionsService.reviewArtifact(input, context),
    cancelRun: (input, context) => workflowRuntimeFeatureActionsService.cancelRun(input, context),
    recoverRun: (input, context) => workflowRuntimeFeatureActionsService.recoverRun(input, context),
  },
  workflowRecordings: {
    search: (input) => searchGlobalAmbientWorkflowPlaybooks(input),
    describe: (input) => describeGlobalAmbientWorkflowPlaybook(input),
    inject: (input) => injectGlobalAmbientWorkflowPlaybook(input),
    update: (input) => updateGlobalAmbientWorkflowPlaybook(input),
    archive: (input) => archiveGlobalAmbientWorkflowPlaybook(input),
    unarchive: (input) => unarchiveGlobalAmbientWorkflowPlaybook(input),
    restoreVersion: (input) => restoreGlobalAmbientWorkflowPlaybookVersion(input),
  },
  readVoiceSettings: () => readCurrentVoiceSettings(),
  updateVoiceSettings: (input, audit, options) => updateVoiceSettings(input, audit, options),
  listVoiceProviders: (workspacePath) => listVoiceProviders(workspacePath),
  enforceVoiceArtifactBudget: (workspacePath, targetStore) => enforceVoiceArtifactBudget(workspacePath, targetStore),
  createMediaUrl: (input) => workspaceMediaServer.createUrl(input),
  readSttSettings: () => sttSettings,
  updateSttSettings: (input, options) => updateSttSettings(input, options),
  listSttProviders: (workspacePath) => listSttProvidersWithValidation(workspacePath),
  privilegedCredentials: {
    request: (input) => privilegedCredentials.request(input),
  },
  secureInputs: {
    request: (input) => secureInputs.request(input),
  },
});

type ProjectRuntimeHost = ProjectRuntimeHostContract<
  ProjectStore,
  InternalBrowserHost,
  BrowserService,
  BrowserCredentialStore,
  AgentRuntime,
  TerminalService,
  OrchestrationAutoDispatchState
>;

type RuntimeFeatureHostContext = AgentRuntimeFeatureFactoryContext<ProjectStore, BrowserService>;

let activeHost: ProjectRuntimeHost | undefined;
let store: ProjectStore;
let browserService: BrowserService;
let namedSecretStore: NamedSecretStore;
const namedSecretDesktopService = createNamedSecretDesktopService({
  namedSecretStore: () => namedSecretStore,
  emitDesktopState: () => emitDesktopState(),
});
const { saveNamedSecret, updateNamedSecret, deleteNamedSecret, brokerNamedSecretToLocalFixture, exportNamedSecretMetadata } =
  namedSecretDesktopService;
const projectRuntimeActiveThreadService = createProjectRuntimeActiveThreadService<ProjectStore, ProjectRuntimeHost>({
  activeHost: () => activeHost,
  activeStore: () => store,
  getActiveThreadId: () => activeThreadId,
  initialActiveThreadIdForStore: (targetStore) => initialActiveThreadIdForStore(targetStore),
  setActiveThreadIdState: (threadId) => {
    activeThreadId = threadId;
  },
});
const rendererLocalPreviewServers = new LocalPreviewServerManager();
const officePreviewPublisher = createOfficePreviewPublisher({
  renderer: () => officePreviewService,
  createMediaUrl: (input) => workspaceMediaServer.createUrl(input),
});
const { createOfficePreview } = officePreviewPublisher;
const activeWorkspaceFileService = createActiveWorkspaceFileService<ThreadSummary, ProjectStore, ProjectRuntimeHost>({
  activeHost: () => requireActiveProjectRuntimeHost(),
  activeThreadIdForHost,
  activeWorkspacePath: () => activeWorkspacePath(),
  defaultStore: () => store,
  getAppPath: (name) => app.getPath(name),
  normalizePath: normalizeWorkspacePath,
  pathExists: existsSync,
  realpath: (path) => realpathSync.native(path),
  createMediaUrl: (input) => workspaceMediaServer.createUrl(input),
  createOfficePreview: (input) => createOfficePreview(input),
});
const {
  activeWorkspaceFileContextForProjectHost,
  readActiveLocalFilePreview,
  readActiveWorkspaceFile,
  resolveCanonicalLocalFilePath,
  resolveLocalFilePath,
  localPathInsideActiveWorkspace,
  localPathVisibleToThread,
  workspacePathForRelativeArtifactPath,
} = activeWorkspaceFileService;
function createThreadLocalFolderAllowlistGrant(folderPath: string, context: ReturnType<typeof activeWorkspaceFileContextForProjectHost>) {
  const grant = context.targetStore.createPermissionGrant(
    createLocalFolderAllowlistGrantInput({
      folderPath,
      threadId: context.threadId,
      workspacePath: context.workspacePath,
      permissionMode: context.thread.permissionMode,
    }),
  );
  emitPermissionGrantCreated(grant, context.targetStore.getWorkspace().path);
  return grant;
}
const voiceArtifactDesktopService = createVoiceArtifactDesktopService<ProjectRuntimeHost, ProjectStore>({
  activeProjectRuntimeHost: () => requireActiveProjectRuntimeHost(),
  activeStore: () => store,
  activeThreadIdForHost,
  activeWorkspacePath: () => activeWorkspacePath(),
  artifactCacheMaxBytes: () => Math.max(0, Math.floor(readCurrentVoiceSettings().artifactCacheMaxMb) * 1024 * 1024),
  createMediaUrl: (input) => workspaceMediaServer.createUrl(input),
  emitProjectStateIfActive,
  emitRuntimeFeatureStateUpdated,
  getVoiceSettings: () => readCurrentVoiceSettings(),
  projectRuntimeHostList,
  providerSummaryForThread: (thread) => {
    const provider = getAmbientProviderStatus(thread.model);
    return {
      model: thread.model,
      apiKey: readAmbientApiKey(),
      baseUrl: provider.baseUrl,
    };
  },
  requireProjectRuntimeHostForMessageVoiceState,
  requireProjectRuntimeHostForThread,
  resolveVoiceProviderWorkspacePath,
  resolveWorkspacePath,
  runner: runAmbientCliPackageCommand,
  shouldEmitRuntimeFeatureStateUpdated: () => Boolean(mainWindow && activeThreadId),
  showItemInFolder: (path) => shell.showItemInFolder(path),
  warn: (message) => console.warn(message),
});
const {
  clearManagedVoiceArtifactCache,
  clearManagedVoiceArtifactCachesForRuntimeHostsSync,
  clearMessageVoiceArtifact,
  enforceVoiceArtifactBudget,
  inspectVoiceArtifacts,
  pruneVoiceArtifacts,
  regenerateMessageVoice,
  revealMessageVoiceArtifact,
} = voiceArtifactDesktopService;
voiceArtifactBudgetBridge.enforceVoiceArtifactBudget = enforceVoiceArtifactBudget;
const piToolingApprovalDetailFormatter = createPiToolingApprovalDetailFormatter({
  workspacePath: () => store.getWorkspace().path,
});
const { formatPiExtensionSandboxInstallApprovalDetail, formatPiPrivilegedInstallApprovalDetail, formatPiResourceCountsForPermission } =
  piToolingApprovalDetailFormatter;

function currentFeatureFlagSnapshot(targetStore: ProjectStore = store) {
  return resolveAmbientFeatureFlags({
    settings: targetStore.getFeatureFlagSettings(),
    startup: ambientLaunchArgs.featureFlags,
  });
}

function currentModelRuntimeCatalog(generatedAt: string, targetStore: ProjectStore = store) {
  return targetStore.getModelRuntimeCatalog(generatedAt, currentRuntimeModelProfiles());
}

function currentRuntimeModelProfiles(): AmbientModelRuntimeProfile[] {
  ensureAmbientModelLimitObservationsLoaded();
  const runtimeProfiles = [
    ...ambientDiscoveredModelProfiles,
    ...(localTextSubagentStartup.feature ? [localTextSubagentStartup.feature.profile] : []),
  ];
  if (getActiveAmbientProviderId() !== "ambient") return runtimeProfiles;
  const activeAmbientBaseUrl = getActiveAmbientProviderBaseUrl("ambient") ?? "https://api.ambient.xyz";
  const observedStaticProfiles = [...ambientModelLimitObservations.values()]
    .filter((observation) => ambientModelLimitObservationKey(observation) === ambientModelLimitObservationKey({
      baseUrl: activeAmbientBaseUrl,
      modelId: observation.modelId,
    }))
    .filter((observation) => !runtimeProfiles.some(
      (profile) => normalizeAmbientModelId(profile.modelId) === normalizeAmbientModelId(observation.modelId),
    ))
    .flatMap((observation) => {
      const registeredProfile = resolveAmbientModelRuntimeProfile(observation.modelId);
      const observedProfile = applyAmbientModelLimitObservationToRegisteredProfile(registeredProfile, observation);
      return observedProfile ? [observedProfile] : [];
    });
  return [...runtimeProfiles.map(applyCurrentAmbientModelLimitObservation), ...observedStaticProfiles];
}

function currentModelRuntimeProfile(modelId?: string, targetStore: ProjectStore = store): AmbientModelRuntimeProfile {
  const normalizedModelId = normalizeAmbientModelId(modelId);
  const profile = currentModelRuntimeCatalog(new Date().toISOString(), targetStore).profiles.find(
    (candidate) => normalizeAmbientModelId(candidate.modelId) === normalizedModelId,
  );
  return profile ?? resolveAmbientModelRuntimeProfile(normalizedModelId);
}

function startAmbientModelDiscoveryRefresh(): void {
  if (ambientModelDiscoveryTimer) return;
  void refreshAmbientModelDiscovery("startup");
  ambientModelDiscoveryTimer = setInterval(() => {
    void refreshAmbientModelDiscovery("interval");
  }, AMBIENT_MODEL_DISCOVERY_REFRESH_INTERVAL_MS);
  ambientModelDiscoveryTimer.unref?.();
}

function stopAmbientModelDiscoveryRefresh(): void {
  if (!ambientModelDiscoveryTimer) return;
  clearInterval(ambientModelDiscoveryTimer);
  ambientModelDiscoveryTimer = undefined;
}

async function refreshAmbientModelDiscovery(reason: AmbientModelDiscoveryRefreshReason): Promise<void> {
  const requestIdentity = currentAmbientModelDiscoveryRequestIdentity();
  if (!requestIdentity) {
    clearAmbientDiscoveredModelProfiles(
      reason,
      getActiveAmbientProviderId() === "ambient" ? "Ambient API key is unavailable" : "active provider is not Ambient",
    );
    return;
  }

  try {
    const discovery = await discoverAmbientModelRuntimeProfiles({
      apiKey: requestIdentity.apiKey,
      baseUrl: requestIdentity.baseUrl,
    });
    if (!ambientModelDiscoveryRequestIdentityMatches(requestIdentity)) {
      console.log(`[models] Ignored stale Ambient model discovery result for ${reason}.`);
      return;
    }
    const nextProfiles = discovery.profiles;
    let effectiveLimitChanged = false;
    for (const profile of nextProfiles) {
      const observation = ambientModelLimitObservationFromDiscoveredProfile({
        baseUrl: requestIdentity.baseUrl,
        profile,
      });
      if (observation && recordAmbientModelLimitObservation(observation, { persist: false, refreshSessions: false })) {
        effectiveLimitChanged = true;
      }
    }
    persistAmbientModelLimitObservations();
    const changed = effectiveLimitChanged ||
      ambientModelDiscoverySignature(nextProfiles) !== ambientModelDiscoverySignature(ambientDiscoveredModelProfiles);
    ambientDiscoveredModelProfiles = nextProfiles;
    if (changed) {
      refreshLoadedRuntimeModelProfiles();
      emitDesktopState();
    }
    console.log(
      `[models] Refreshed Ambient model catalog from /v1/models for ${reason}: ${discovery.readyModelCount}/${discovery.receivedModelCount} ready, ${nextProfiles.length} runtime profile(s).`,
    );
  } catch (error) {
    console.warn(`[models] Ambient model discovery failed for ${reason}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function currentAmbientModelDiscoveryRequestIdentity(): AmbientModelDiscoveryRequestIdentity | undefined {
  if (getActiveAmbientProviderId() !== "ambient") return undefined;
  const apiKey = readAmbientApiKey();
  if (!apiKey) return undefined;
  const baseUrl = getActiveAmbientProviderBaseUrl("ambient");
  if (!baseUrl) return undefined;
  return {
    apiKey,
    baseUrl,
  };
}

function ambientModelDiscoveryRequestIdentityMatches(identity: AmbientModelDiscoveryRequestIdentity): boolean {
  const current = currentAmbientModelDiscoveryRequestIdentity();
  return Boolean(current && current.apiKey === identity.apiKey && current.baseUrl === identity.baseUrl);
}

function clearAmbientDiscoveredModelProfiles(reason: AmbientModelDiscoveryRefreshReason, detail: string): void {
  if (!ambientDiscoveredModelProfiles.length) return;
  ambientDiscoveredModelProfiles = [];
  emitDesktopState();
  console.log(`[models] Cleared discovered Ambient model catalog for ${reason}: ${detail}.`);
}

function ambientModelDiscoverySignature(profiles: readonly AmbientModelRuntimeProfile[]): string {
  return JSON.stringify(
    profiles.map((profile) => ({
      modelId: profile.modelId,
      label: profile.label,
      selectableAsMain: profile.selectableAsMain,
      selectableAsSubagent: profile.selectableAsSubagent,
      contextWindowTokens: profile.contextWindowTokens,
      maxOutputTokens: profile.maxOutputTokens,
      toolUse: profile.toolUse,
      structuredOutput: profile.structuredOutput,
      supportsVision: profile.supportsVision,
      supportsAudio: profile.supportsAudio,
      reasoning: profile.reasoningCapability?.payloadStrategy,
    })),
  );
}

function applyCurrentAmbientModelLimitObservation(profile: AmbientModelRuntimeProfile): AmbientModelRuntimeProfile {
  if (getActiveAmbientProviderId() !== "ambient") return profile;
  const baseUrl = getActiveAmbientProviderBaseUrl("ambient") ?? "https://api.ambient.xyz";
  const observation = ambientModelLimitObservations.get(ambientModelLimitObservationKey({
    baseUrl,
    modelId: profile.modelId,
  }));
  return applyAmbientModelLimitObservation(profile, observation);
}

function learnAmbientProviderContextLimit(
  modelId: string,
  overflow: AmbientProviderContextOverflow,
  targetStore: ProjectStore,
): AmbientModelRuntimeProfile {
  ensureAmbientModelLimitObservationsLoaded();
  if (getActiveAmbientProviderId() !== "ambient") {
    throw new Error("Provider context-limit learning is only available for the Ambient provider.");
  }
  const baseUrl = getActiveAmbientProviderBaseUrl("ambient") ?? "https://api.ambient.xyz";
  const advertisedProfile = currentModelRuntimeCatalog(new Date().toISOString(), targetStore).profiles.find(
    (profile) => normalizeAmbientModelId(profile.modelId) === normalizeAmbientModelId(modelId),
  ) ?? resolveAmbientModelRuntimeProfile(modelId);
  const observation = ambientModelLimitObservationFromOverflow({
    baseUrl,
    modelId,
    overflow,
    advertisedContextWindowTokens:
      advertisedProfile.limitMetadata?.advertisedContextWindowTokens ?? advertisedProfile.contextWindowTokens,
  });
  recordAmbientModelLimitObservation(observation, { persist: true, refreshSessions: true });
  emitDesktopState();
  return applyAmbientModelLimitObservation(advertisedProfile, observation);
}

function ensureAmbientModelLimitObservationsLoaded(): void {
  if (ambientModelLimitObservationsLoaded || !app.isReady()) return;
  ambientModelLimitObservationsLoaded = true;
  for (const observation of readAmbientModelLimitObservations(app.getPath("userData"))) {
    ambientModelLimitObservations.set(ambientModelLimitObservationKey(observation), observation);
  }
}

function recordAmbientModelLimitObservation(
  observation: AmbientModelLimitObservation,
  options: { persist: boolean; refreshSessions: boolean },
): boolean {
  ensureAmbientModelLimitObservationsLoaded();
  const key = ambientModelLimitObservationKey(observation);
  const current = ambientModelLimitObservations.get(key);
  const merged = mergeAmbientModelLimitObservation(current, observation);
  const changed = ambientModelLimitRuntimeSignature(current) !== ambientModelLimitRuntimeSignature(merged);
  ambientModelLimitObservations.set(key, merged);
  if (options.persist) persistAmbientModelLimitObservations();
  if (options.refreshSessions && changed) refreshLoadedRuntimeModelProfiles();
  return changed;
}

function ambientModelLimitRuntimeSignature(observation: AmbientModelLimitObservation | undefined): string {
  if (!observation) return "";
  return JSON.stringify({
    source: observation.source,
    contextWindowTokens: observation.contextWindowTokens,
    maxOutputTokens: observation.maxOutputTokens,
    requestedOutputTokens: observation.requestedOutputTokens,
    advertisedContextWindowTokens: observation.advertisedContextWindowTokens,
  });
}

function persistAmbientModelLimitObservations(): void {
  if (!app.isReady()) return;
  writeAmbientModelLimitObservations(app.getPath("userData"), [...ambientModelLimitObservations.values()]);
}

function refreshLoadedRuntimeModelProfiles(): void {
  for (const host of projectRuntimeHostList()) {
    host.runtime.refreshModelRuntimeProfiles();
  }
}

function setActiveThreadId(threadId: string): string {
  return projectRuntimeActiveThreadService.setActiveThreadId(threadId);
}

function setProjectHostActiveThreadId(host: ProjectRuntimeHost, threadId: string): string {
  const selectedThreadId = projectRuntimeActiveThreadService.setProjectHostActiveThreadId(host, threadId);
  host.runtime.warmThreadSessionInBackground(selectedThreadId, { reason: "thread-selected" });
  return selectedThreadId;
}

function activeThreadIdForHost(host: ProjectRuntimeHost): string {
  return projectRuntimeActiveThreadService.activeThreadIdForHost(host);
}

function activeRuntimeFeatureHostContext(): RuntimeFeatureHostContext {
  return {
    store,
    browserService,
    activeThreadId: () => activeThreadId,
  };
}

function syncActiveProjectRuntimeHost(host: ProjectRuntimeHost | undefined): void {
  activeHost = host;
  if (!host) return;
  store = host.store;
  browserService = host.browserService;
  setActiveThreadId(host.activeThreadId);
  host.runtime.warmThreadSessionInBackground(host.activeThreadId, { reason: "active-project-sync" });
}

function createAgentRuntimeFeatures(context?: RuntimeFeatureHostContext): AgentRuntimeFeatures {
  return agentRuntimeFeatureFactory(context);
}

function managedChromeRevealBoundsForAmbientWindow(): ManagedChromeWindowBounds {
  const display =
    mainWindow && !mainWindow.isDestroyed()
      ? screen.getDisplayMatching(mainWindow.getBounds())
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return managedChromeRevealBoundsForWorkArea(display.workArea);
}

function runSubagentRuntimeStartupReconciliation(reason: "project-runtime-created", host: ProjectRuntimeHost): void {
  subagentRuntimeStartupReconciliationService.runSubagentRuntimeStartupReconciliation(reason, host);
}

function runProjectRuntimeStartupReconciliation(reason: "project-runtime-created", host: ProjectRuntimeHost): void {
  runSubagentRuntimeStartupReconciliation(reason, host);
  runAgentMemoryStartupReconciliation(reason, host);
  host.runtime.warmThreadSessionInBackground(host.activeThreadId, { reason });
}

function projectRuntimeHostForStore(targetStore: ProjectStore): ProjectRuntimeHost | undefined {
  return projectRuntimeHostList().find((host) => host.store === targetStore);
}

function emitRuntimeFeatureStateUpdated(targetStore: ProjectStore): void {
  const host = projectRuntimeHostForStore(targetStore);
  if (host) {
    if (isActiveProjectRuntimeHost(host)) emitProjectStateIfActive(host, activeThreadIdForHost(host));
    return;
  }
  if (targetStore === store) emitDesktopState();
}

const terminalStartTokens = new TerminalStartTokenStore();

async function readCurrentOrchestrationBoard(targetStore: ProjectStore = store) {
  return readOrchestrationBoardWithWorkflowReadiness(targetStore.getWorkspace().path, targetStore.listOrchestrationBoard());
}

function startupWorkspacePath(): string {
  return selectStartupWorkspacePath({
    explicitWorkspace: process.env.AMBIENT_DESKTOP_WORKSPACE,
    cwd: process.cwd(),
    isPackaged: app.isPackaged,
    userDataPath: app.getPath("userData"),
    registeredWorkspacePaths: projectRegistry.listRegisteredPaths().filter((workspacePath) => existsSync(workspacePath)),
    hasRestorableWorkspaceState,
  });
}

function readState(threadId = activeThreadId, options: { markActiveRead?: boolean } = {}): DesktopState {
  return desktopStateSnapshotService.readState(threadId, options);
}

function packageVersion(name: string): string {
  const dependencies = packageJson as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  return dependencies.dependencies?.[name] ?? dependencies.devDependencies?.[name] ?? "unknown";
}

function workspaceStateForThread(thread = store.getThread(activeThreadId), targetStore: ProjectStore = store) {
  const workspace = targetStore.getWorkspace();
  return {
    path: thread.workspacePath,
    name: thread.workspacePath === workspace.path ? workspace.name : `${workspace.name} worktree`,
    statePath: workspace.statePath,
    sessionPath: workspace.sessionPath,
  };
}

function activeWorkspacePath(): string {
  return projectRuntimeActiveThreadService.activeWorkspacePath();
}

function initialActiveThreadId(): string {
  return projectRuntimeActiveThreadService.initialActiveThreadId();
}

function requireActiveProjectRuntimeHost(): ProjectRuntimeHost {
  const host = projectRuntimeHostActivationService.activeProjectRuntimeHost();
  if (!host) throw new Error("No active project runtime host.");
  return host;
}

function isActiveProjectRuntimeHost(host: ProjectRuntimeHost): boolean {
  return projectRuntimeHostActivationService.activeProjectRuntimeHost() === host;
}

function refreshSecureStorageStatus() {
  const status = currentSecureStorageStatus({ appAvailable: true });
  const result = { status, guidance: secureStorageRepairGuidance(status) };
  emitDesktopState();
  return result;
}

function registerIpc(): void {
  registerMainIpcForDesktop({
    AmbientWorkflowExplorationProvider,
    activeGitContextForProjectHost,
    activeHost,
    activeThreadId,
    activeThreadIdForHost,
    activeVoiceSttContextForProjectHost,
    activeWorkflowRunController: activeWorkflowRunRegistry.activeWorkflowRunController,
    activeWorkflowRunHost: activeWorkflowRunRegistry.activeWorkflowRunHost,
    activeWorkspaceFileContextForProjectHost,
    allPluginMcpRuntimeSnapshots,
    ambientCliCapabilityGrantsForWorkflowRequest,
    ambientRetryPolicyFromCurrentSettings,
    ambientRetryPolicyFromSettings,
    analyzeMiniCpmVision,
    app,
    assertTrustedMainWindowIpc,
    attachWorktreeForThread,
    browserLoginBrokerEnabled,
    buildWorkflowDebugRewriteContext,
    buildWorkflowRecoveryPlan,
    cancelSttTranscription,
    getAgentMemoryDiagnostics,
    getAgentMemoryStarterStatus,
    clearMessageVoiceArtifact,
    compileWorkflowArtifact,
    createAndRecordCheckpoint,
    createThreadLocalFolderAllowlistGrant,
    createMainDiagnosticSource,
    createMcpInstallCatalog,
    createWorkflowDiscoveryProvider,
    currentFeatureFlagSnapshot,
    desktopUpdateService,
    dialog,
    deleteNamedSecret,
    discoverAmbientCliPackages,
    disposeProjectRuntimeHost,
    emitBrowserStateForHost,
    emitMainWindowDesktopEvent,
    emitOrchestrationUpdated,
    emitPermissionAuditCreated,
    emitPermissionGrantCreated,
    emitPermissionGrantRevoked,
    emitPlannerPlanArtifactUpdated,
    emitPluginCatalogUpdated,
    emitProjectScopedEvent,
    emitProjectStateIfActive,
    emitRuntimeFeatureStateUpdated,
    emitThreadUpdated,
    emitWorkflowEvent,
    emitWorkflowRecordingLibraryStateChanged,
    emitWorkflowUpdated,
    ensureProjectRuntimeHostForWorkspacePath,
    ensureWorkflowPluginTrusted,
    existsSync,
    firstPartyWorkflowConnectorAccountAuthorizer,
    firstPartyWorkflowConnectorDescriptors,
    firstPartyWorkflowConnectorRegistrations,
    forgetActiveWorkflowRunsForController: activeWorkflowRunRegistry.forgetActiveWorkflowRunsForController,
    formatPiExtensionSandboxInstallApprovalDetail,
    formatPiPrivilegedInstallApprovalDetail,
    formatPiResourceCountsForPermission,
    generatePlannerDurableArtifact,
    getAmbientProviderStatus,
    getWorkspaceGitStatus,
    googleWorkspaceCliInstaller,
    googleWorkspaceSetupService,
    handleIpc,
    hydrateSearchRoutingSettingsForActiveWorkspace,
    initialActiveThreadIdForStore,
    inspectVoiceArtifacts,
    installModelProviderEndpoint,
    isActiveProjectRuntimeHost,
    isGoogleWorkspaceSetupUrl,
    isLoopbackWebUrl,
    join,
    listGlobalWorkflowAgentFolders,
    listGlobalWorkflowRecordingLibrary,
    listLocalDeepResearchRunsForSettings,
    listSttProvidersWithValidation,
    listVoiceProvidersWithCachedVoices,
    mainWindow,
    markStaleWorkflowRunForRecoveryIfNeeded,
    mkdirSync,
    normalizeWorkspacePath,
    officePreviewService,
    openAllowedExternalUrl,
    openContainerRuntimeApplication,
    openGoogleWorkspaceUrl,
    openRendererLocalUrlInAmbientBrowser,
    openThreadMiniWindow,
    packageJson,
    parseExternalOpenUrl,
    permissionGrantTargetHash,
    permissionGrantWorkspacePath,
    permissions,
    pluginHost,
    pluginMcpRegistrationsForThread,
    pluginStateReaderForStore,
    prepareWorktreeForThread,
    privilegedCredentials,
    projectRegistry,
    projectBoardDesktopIpcHostDependencies: {
      emitProjectStateIfActive,
      readStateForProjectHostAction,
      requireProjectRuntimeHostForOrchestrationTask,
      requireProjectRuntimeHostForPlannerPlanArtifact,
      scheduleAutoDispatch,
      setProjectHostActiveThreadId,
    },
    projectRuntimeHostForTerminal,
    projectRuntimeHostForWorkflowRun,
    projectRuntimeHostForWorkspacePath,
    pruneVoiceArtifacts,
    readActiveLocalFilePreview,
    readActiveWorkspaceFile,
    readAmbientApiKey,
    readAmbientPluginRegistry,
    readCodexHostedMarketplaceReport,
    readCodexPluginCatalog,
    readCurrentOrchestrationBoard,
    readFirstPartyGoogleIntegration,
    readGitReviewForProjectHost,
    readOrchestrationWorkflowReadiness,
    readState,
    readStateForProjectHostAction,
    recordActiveProjectBoardExecutionReadinessBlocker,
    recordBrowserControlAudit,
    recordBrowserProfileAudit,
    redactGoogleWorkspaceSetupState,
    refreshAmbientModelDiscovery: () => refreshAmbientModelDiscovery("credentials-updated"),
    refreshGoogleWorkspaceConnectorMode,
    refreshSecureStorageStatus,
    refreshVoiceProviderCatalog,
    regenerateMessageVoice,
    rememberActiveWorkflowRun: activeWorkflowRunRegistry.rememberActiveWorkflowRun,
    rendererLocalPreviewServers,
    requestPermissionWithGrantRegistry,
    requireActiveProjectRuntimeHost,
    requireProjectRuntimeHostForAutomationSchedule,
    requireProjectRuntimeHostForAutomationScheduleTarget,
    requireProjectRuntimeHostForAutomationThread,
    requireProjectRuntimeHostForCallableWorkflowTask,
    requireProjectRuntimeHostForOrchestrationRun,
    requireProjectRuntimeHostForOrchestrationTask,
    requireProjectRuntimeHostForOrchestrationWorkspace,
    requireProjectRuntimeHostForPermissionGrant,
    requireProjectRuntimeHostForPermissionGrantInput,
    requireProjectRuntimeHostForPlannerPlanArtifact,
    requireProjectRuntimeHostForSubagentRun,
    requireProjectRuntimeHostForSubagentWaitBarrier,
    requireProjectRuntimeHostForThread,
    requireProjectRuntimeHostForThreadAction,
    requireProjectRuntimeHostForWorkflowArtifact,
    requireProjectRuntimeHostForWorkflowLabRun,
    requireProjectRuntimeHostForWorkflowRecording,
    requireProjectRuntimeHostForWorkflowRevision,
    requireProjectRuntimeHostForWorkflowRun,
    requireProjectRuntimeHostForWorkflowThread,
    requireProjectRuntimeHostForWorkflowVersion,
    resetProjectRuntimeAndPluginServers,
    resetRuntimeAndPluginServers,
    resolveCanonicalLocalFilePath,
    localPathVisibleToThread,
    localPathInsideActiveWorkspace,
    resolveLocalFilePath,
    resolveRegisteredProjectPathForHost,
    restartProjectRuntimeMcpRuntime,
    revealMessageVoiceArtifact,
    reviewFinishedProjectBoardRun,
    reviewWorkflowArtifact,
    revokePluginGrantsForLabels,
    runLocalModelRuntimeLifecycleAction,
    runWorkflowArtifact,
    runWorkflowThreadExploration,
    brokerNamedSecretToLocalFixture,
    saveModelProviderCredential,
    saveNamedSecret,
    searchRoutingSettings,
    searchWorkspace,
    secureInputs,
    selectAmbientCliPackageForSecret,
    setProjectHostActiveThreadId,
    setSttTtsSpeaking,
    setThemePreference,
    setupLocalDeepResearch,
    setupMiniCpmVision,
    setupSttProvider,
    shell,
    stopProjectRuntimeMcpRuntime,
    store,
    switchWorkspace,
    terminalStartTokens,
    threadWorkingDirectory,
    transcribeSttAudio,
    updateFeatureFlagSettings,
    updateMemorySettings,
    updateLocalDeepResearchSettings,
    updateMediaPlaybackSettings,
    updateModelRuntimeSettings,
    updateNamedSecret,
    updatePlannerSettings,
    updateSearchRoutingSettings,
    updateSttSettings,
    updateThinkingDisplaySettings,
    updateVoiceSettings,
    exportNamedSecretMetadata,
    withBrowserState,
    workflowAgentIpcContextForDiscoveryQuestion,
    workflowAgentIpcContextForWorkflowThread,
    workflowArtifactIpcContext,
    workflowArtifactIpcContextForHost,
    workflowCompileIpcContext,
    workflowDebugRewriteIpcContext,
    workflowDiscoveryPolicyContextForCapabilityLookup,
    workflowProjectIpcContext,
    workflowToolDescriptorsFromPluginRegistry,
    workspaceInventoryConnector,
    workspacePathForRelativeArtifactPath,
    workspaceStateForThread,
  });
}

app.setName("Ambient Desktop");
if (process.env.AMBIENT_E2E_USER_DATA && !app.isReady()) {
  mkdirSync(process.env.AMBIENT_E2E_USER_DATA, { recursive: true });
  app.setPath("userData", process.env.AMBIENT_E2E_USER_DATA);
}

export async function startAmbientDesktopApp(): Promise<void> {
  await startApp();
}

async function startApp(): Promise<void> {
  const userDataPath = app.getPath("userData");
  namedSecretStore = new NamedSecretStore({
    filePath: defaultNamedSecretStoreFilePath(userDataPath),
    currentWorkspacePath: () => activeWorkspacePath(),
    globalWorkspacePath: join(userDataPath, "named-secrets", "global-scope"),
  });
  const migration = migrateAmbientUserData({
    currentUserDataPath: userDataPath,
    legacyUserDataPaths: ambientLegacyUserDataPaths(userDataPath),
  });
  if (migration.importedProjectPaths.length > 0 || migration.copiedFiles.length > 0) {
    console.log(
      `[startup] Migrated Ambient Desktop user data: ${migration.importedProjectPaths.length} project path(s), ${migration.copiedFiles.length} file(s).`,
    );
  }
  applyThemePreference(await readThemePreference(appearancePreferencesPath()));
  mediaPlaybackSettings = await readMediaPlaybackSettings(appearancePreferencesPath());
  thinkingDisplaySettings = await readThinkingDisplaySettings(appearancePreferencesPath());
  plannerSettings = await readPlannerSettings(appearancePreferencesPath());
  localDeepResearchSettings = await readLocalDeepResearchSettings(appearancePreferencesPath());
  searchRoutingSettings = await readSearchRoutingSettings(appearancePreferencesPath());
  setVoiceSettings(await readVoiceSettings(appearancePreferencesPath()));
  sttSettings = await readSttSettings(appearancePreferencesPath());
  nativeTheme.on("updated", publishAppearanceUpdated);
  const googleOAuthProviders = googleWorkspaceOAuthProvidersFromEnv(process.env);
  googleWorkspaceCliInstaller = new GoogleWorkspaceCliInstaller({
    toolsRoot: join(userDataPath, "tools"),
  });
  officePreviewService = new OfficePreviewService({
    cacheRoot: join(userDataPath, "office-previews"),
    env: process.env,
  });
  googleWorkspaceCliAdapter = new GoogleWorkspaceCliAdapter({
    appUserDataPath: userDataPath,
    env: process.env,
    managedBinaryPath: () => googleWorkspaceCliInstaller.binaryPath(),
    onDiagnostic: (entry) => {
      const details = entry.details ? ` ${JSON.stringify(entry.details)}` : "";
      console[entry.level === "error" ? "error" : entry.level === "warning" ? "warn" : "log"](`[google-gws] ${entry.message}${details}`);
    },
  });
  refreshGoogleWorkspaceConnectorMode();
  googleWorkspaceSetupService = new GoogleWorkspaceSetupService({
    adapter: googleWorkspaceCliAdapter,
    accountsPath: join(userDataPath, "google-workspace-cli", "accounts.json"),
    env: process.env,
    openExternal: openGoogleWorkspaceUrl,
  });
  await googleWorkspaceSetupService.loadAccounts();
  googleWorkspaceMethodBroker = new GoogleWorkspaceMethodBroker(googleWorkspaceCliAdapter, {
    resolveAccountHint: (accountHint) => googleWorkspaceSetupService.resolveAccountHintForCall(accountHint),
  });
  pluginAuthService = new PluginAuthService({
    providers: googleOAuthProviders,
    tokenVault: new SafeStorageWorkflowConnectorTokenVault(
      join(userDataPath, "plugin-auth", "tokens.json"),
      electronSecureSecretStore({ appAvailable: true }),
    ),
  });
  if (googleWorkspaceDesktopIntegrationService.connectorMode() === "ambient_oauth") {
    googleSidecarSupervisor = new GoogleSidecarSupervisor({
      appRoot: process.cwd(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      onDiagnostic: (entry) => {
        const details = entry.details ? ` ${JSON.stringify(entry.details)}` : "";
        console[entry.level === "error" ? "error" : entry.level === "warning" ? "warn" : "log"](
          `[google-sidecar] ${entry.message}${details}`,
        );
      },
    });
  }
  pluginHost = new AmbientPluginHost({
    pluginAuth: pluginAuthService,
  });
  app.setAboutPanelOptions({
    applicationName: "Ambient Desktop",
    applicationVersion: app.getVersion(),
    version: `Electron ${process.versions.electron ?? "unknown"}`,
    website: "https://ambient.xyz",
    credits: thirdPartyCredits(lambdaRlmThirdPartyCreditSource).map(thirdPartyCreditAboutText).join("\n\n"),
  });
  projectRegistry = new ProjectRegistry(join(userDataPath, "projects.json"));
  setDockIcon(resolveAppIconPath());
  registerIpc();
  registerWorkspaceMediaProtocol(protocol, workspaceMediaServer);
  await createWindow();
  startAmbientModelDiscoveryRefresh();
  startPostWindowStartupLifecycle();
}

app.on("before-quit", stopAmbientModelDiscoveryRefresh);
installShutdownHandlers();
