import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
import type { DesktopEvent } from "../../shared/desktopTypes";
import type { ContextUsageSnapshot, ThreadSummary } from "../../shared/threadTypes";
import type { WorkspaceState } from "../../shared/workspaceTypes";
import {
  ambientModel,
  createAmbientProviderExtension,
} from "./agentRuntimeAmbientFacade";
import { enableAtomicPiSessionPersistence, workspaceBoundedAgentContextFiles } from "./agentRuntimePiFacade";
import type { ProjectStore } from "./agentRuntimeProjectStoreFacade";
import {
  getAmbientProviderStatus,
  normalizeAmbientBaseUrl,
} from "./agentRuntimeProviderFacade";
import {
  piRetryOverridesFromModelRuntimeSettings,
} from "./agentRuntimeRetrySettings";
import { readAmbientApiKey } from "./agentRuntimeSecurityFacade";
import {
  materializeToolDefinitions,
  materializeToolResultFinalizerExtensionFactory,
  materializeToolResultExtensionFactory,
} from "./agentRuntimeToolRuntimeFacade";
import { createAmbientProductContextExtension } from "./agentRuntimeProductContextTools";
import {
  createWorkflowRecordingReviewTools,
  WORKFLOW_RECORDING_REVIEW_ACTIVE_TOOL_NAMES,
} from "./workflow-support/agentRuntimeWorkflowRecordingReviewTools";

export type WorkflowRecordingReviewPiSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

type WorkflowRecordingReviewSessionStore = Pick<
  ProjectStore,
  "getWorkspace" | "getCompactionSettings" | "getModelRuntimeSettings" | "getThread" | "updateWorkflowRecordingReviewDraft"
>;

type WorkflowRecordingReviewSettingsManager = Pick<ReturnType<typeof SettingsManager.create>, "applyOverrides">;
type WorkflowRecordingReviewAuthStorage = Pick<ReturnType<typeof AuthStorage.create>, "setRuntimeApiKey">;
type WorkflowRecordingReviewResourceLoader = Pick<InstanceType<typeof DefaultResourceLoader>, "reload">;

type WorkflowRecordingReviewCreateSessionInput = {
  cwd: string;
  agentDir: string;
  authStorage: unknown;
  model: Model<"openai-completions">;
  resourceLoader: unknown;
  sessionManager: unknown;
  settingsManager: unknown;
  thinkingLevel: ThreadSummary["thinkingLevel"];
  customTools: unknown;
  activeTools: string[];
  includeAllExtensionTools: boolean;
};

export interface AgentRuntimeWorkflowRecordingReviewSessionDependencies {
  randomUUID: () => string;
  mkdirSync: (path: string, options: { recursive: true }) => void;
  getAmbientProviderStatus: typeof getAmbientProviderStatus;
  readAmbientApiKey: typeof readAmbientApiKey;
  normalizeAmbientBaseUrl: typeof normalizeAmbientBaseUrl;
  ambientModel: typeof ambientModel;
  createSettingsManager: (workspacePath: string, agentDir: string) => WorkflowRecordingReviewSettingsManager;
  piRetryOverridesFromModelRuntimeSettings: typeof piRetryOverridesFromModelRuntimeSettings;
  createAuthStorage: (authPath: string) => WorkflowRecordingReviewAuthStorage;
  createResourceLoader: (options: unknown) => WorkflowRecordingReviewResourceLoader;
  workspaceBoundedAgentContextFiles: typeof workspaceBoundedAgentContextFiles;
  createAmbientProviderExtension: typeof createAmbientProviderExtension;
  createAmbientProductContextExtension: typeof createAmbientProductContextExtension;
  materializeToolResultExtensionFactory: typeof materializeToolResultExtensionFactory;
  materializeToolResultFinalizerExtensionFactory: typeof materializeToolResultFinalizerExtensionFactory;
  createSessionManager: (workspacePath: string, sessionPath: string) => unknown;
  enableAtomicPiSessionPersistence: (sessionManager: unknown) => unknown;
  createAgentSession: (input: WorkflowRecordingReviewCreateSessionInput) => Promise<{ session: WorkflowRecordingReviewPiSession }>;
  createWorkflowRecordingReviewTools: typeof createWorkflowRecordingReviewTools;
  materializeToolDefinitions: typeof materializeToolDefinitions;
  activeToolNames: readonly string[];
}

export interface AgentRuntimeWorkflowRecordingReviewSessionControllerOptions {
  store: WorkflowRecordingReviewSessionStore;
  emit: (event: DesktopEvent) => void;
  createProviderCallContextPreflightExtension: (
    threadId: string,
    workspacePath: string,
    model: Model<"openai-completions">,
  ) => ExtensionFactory;
  createModelReasoningPayloadExtension: (threadId: string, model: Model<"openai-completions">) => ExtensionFactory;
  createContextAccountingExtension: (threadId: string, model: Model<"openai-completions">) => ExtensionFactory;
  recordContextUsageSnapshot: (
    threadId: string,
    session: WorkflowRecordingReviewPiSession,
    message?: string,
  ) => ContextUsageSnapshot;
  dependencies?: Partial<AgentRuntimeWorkflowRecordingReviewSessionDependencies>;
}

const defaultWorkflowRecordingReviewSessionDependencies: AgentRuntimeWorkflowRecordingReviewSessionDependencies = {
  randomUUID,
  mkdirSync,
  getAmbientProviderStatus,
  readAmbientApiKey,
  normalizeAmbientBaseUrl,
  ambientModel,
  createSettingsManager: (workspacePath, agentDir) => SettingsManager.create(workspacePath, agentDir),
  piRetryOverridesFromModelRuntimeSettings,
  createAuthStorage: (authPath) => AuthStorage.create(authPath),
  createResourceLoader: (options) =>
    new DefaultResourceLoader(options as ConstructorParameters<typeof DefaultResourceLoader>[0]),
  workspaceBoundedAgentContextFiles,
  createAmbientProviderExtension,
  createAmbientProductContextExtension,
  materializeToolResultExtensionFactory,
  materializeToolResultFinalizerExtensionFactory,
  createSessionManager: (workspacePath, sessionPath) => SessionManager.create(workspacePath, sessionPath),
  enableAtomicPiSessionPersistence: (sessionManager) =>
    enableAtomicPiSessionPersistence(sessionManager as SessionManager),
  createAgentSession: (input) => createAgentSession(input as Parameters<typeof createAgentSession>[0]),
  createWorkflowRecordingReviewTools,
  materializeToolDefinitions,
  activeToolNames: WORKFLOW_RECORDING_REVIEW_ACTIVE_TOOL_NAMES,
};

export class AgentRuntimeWorkflowRecordingReviewSessionController {
  private readonly dependencies: AgentRuntimeWorkflowRecordingReviewSessionDependencies;

  constructor(private readonly options: AgentRuntimeWorkflowRecordingReviewSessionControllerOptions) {
    this.dependencies = {
      ...defaultWorkflowRecordingReviewSessionDependencies,
      ...options.dependencies,
    };
  }

  async createSession(thread: ThreadSummary): Promise<WorkflowRecordingReviewPiSession> {
    const workspace = this.workspaceForThread(thread);
    const provider = this.dependencies.getAmbientProviderStatus(thread.model);
    const apiKey = this.dependencies.readAmbientApiKey();
    const agentDir = join(workspace.statePath, "pi");
    const reviewSessionDir = join(workspace.sessionPath, thread.id, "workflow-recording-review", this.dependencies.randomUUID());
    this.dependencies.mkdirSync(agentDir, { recursive: true });
    this.dependencies.mkdirSync(reviewSessionDir, { recursive: true });

    const model = this.dependencies.ambientModel(
      thread.model,
      this.dependencies.normalizeAmbientBaseUrl(provider.baseUrl),
      undefined,
      { requestModelId: provider.model },
    );
    const settingsManager = this.dependencies.createSettingsManager(workspace.path, agentDir);
    this.applySessionSettings(settingsManager);

    const authStorage = this.dependencies.createAuthStorage(join(agentDir, "auth.json"));
    if (apiKey) authStorage.setRuntimeApiKey("ambient", apiKey);
    const resourceLoader = this.createResourceLoader({ thread, workspace, agentDir, model, settingsManager });
    await resourceLoader.reload();

    const { session } = await this.dependencies.createAgentSession({
      cwd: workspace.path,
      agentDir,
      authStorage,
      model,
      resourceLoader,
      sessionManager: this.dependencies.enableAtomicPiSessionPersistence(
        this.dependencies.createSessionManager(workspace.path, reviewSessionDir),
      ),
      settingsManager,
      thinkingLevel: thread.thinkingLevel,
      customTools: this.dependencies.materializeToolDefinitions(
        this.dependencies.createWorkflowRecordingReviewTools({
          threadId: thread.id,
          getThread: (id) => this.options.store.getThread(id),
          updateWorkflowRecordingReviewDraft: (id, draft, options) =>
            this.options.store.updateWorkflowRecordingReviewDraft(id, draft, options),
          emit: (event) => this.options.emit(event),
        }),
        { workspacePath: workspace.path },
      ),
      activeTools: [...this.dependencies.activeToolNames],
      includeAllExtensionTools: false,
    });
    session.agent.toolExecution = "sequential";
    await session.bindExtensions({});
    this.options.recordContextUsageSnapshot(
      thread.id,
      session,
      "Workflow recording review is using a dedicated Ambient session.",
    );
    return session;
  }

  private workspaceForThread(thread: ThreadSummary): WorkspaceState {
    const appWorkspace = this.options.store.getWorkspace();
    return {
      path: thread.workspacePath,
      name: basename(thread.workspacePath) || thread.workspacePath,
      statePath: appWorkspace.statePath,
      sessionPath: appWorkspace.sessionPath,
    };
  }

  private applySessionSettings(settingsManager: WorkflowRecordingReviewSettingsManager): void {
    const compactionSettings = this.options.store.getCompactionSettings();
    const retryOverrides = this.dependencies.piRetryOverridesFromModelRuntimeSettings({
      ...this.options.store.getModelRuntimeSettings(),
      aggressiveRetries: true,
    });
    settingsManager.applyOverrides({
      compaction: {
        enabled: compactionSettings.autoCompactionEnabled,
        reserveTokens: compactionSettings.reserveTokens,
        keepRecentTokens: compactionSettings.keepRecentTokens,
      },
      ...(retryOverrides ? { retry: retryOverrides } : {}),
    });
  }

  private createResourceLoader(input: {
    thread: ThreadSummary;
    workspace: WorkspaceState;
    agentDir: string;
    model: Model<"openai-completions">;
    settingsManager: WorkflowRecordingReviewSettingsManager;
  }): WorkflowRecordingReviewResourceLoader {
    const extensionFactories = [
      this.dependencies.createAmbientProviderExtension(input.model),
      this.dependencies.createAmbientProductContextExtension(),
      this.options.createProviderCallContextPreflightExtension(input.thread.id, input.workspace.path, input.model),
      this.options.createModelReasoningPayloadExtension(input.thread.id, input.model),
      this.options.createContextAccountingExtension(input.thread.id, input.model),
    ].map((factory) =>
      this.dependencies.materializeToolResultExtensionFactory(factory, { workspacePath: input.workspace.path }),
    );
    extensionFactories.push(
      this.dependencies.materializeToolResultFinalizerExtensionFactory({ workspacePath: input.workspace.path }),
    );
    return this.dependencies.createResourceLoader({
      cwd: input.workspace.path,
      agentDir: input.agentDir,
      settingsManager: input.settingsManager,
      agentsFilesOverride: (base: { agentsFiles: Parameters<typeof workspaceBoundedAgentContextFiles>[0]["contextFiles"] }) => ({
        agentsFiles: this.dependencies.workspaceBoundedAgentContextFiles({
          contextFiles: base.agentsFiles,
          workspacePath: input.workspace.path,
          agentDir: input.agentDir,
        }),
      }),
      extensionFactories,
    });
  }
}
