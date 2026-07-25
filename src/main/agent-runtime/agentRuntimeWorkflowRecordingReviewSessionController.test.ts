import { describe, expect, it, vi } from "vitest";
import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { DesktopEvent } from "../../shared/desktopTypes";
import type { ThreadSummary } from "../../shared/threadTypes";
import {
  AgentRuntimeWorkflowRecordingReviewSessionController,
  type AgentRuntimeWorkflowRecordingReviewSessionControllerOptions,
  type AgentRuntimeWorkflowRecordingReviewSessionDependencies,
  type WorkflowRecordingReviewPiSession,
} from "./agentRuntimeWorkflowRecordingReviewSessionController";

interface CapturedResourceLoaderOptions {
  cwd: string;
  agentDir: string;
  settingsManager: unknown;
  agentsFilesOverride: (base: { agentsFiles: string[] }) => { agentsFiles: string[] };
  extensionFactories: unknown[];
}

describe("AgentRuntimeWorkflowRecordingReviewSessionController", () => {
  it("creates a dedicated workflow-recording review session with the existing Ambient setup contract", async () => {
    const thread = {
      id: "thread-review",
      workspacePath: "/workspace/project-alpha",
      model: "example/model-id",
      thinkingLevel: "medium",
    } as ThreadSummary;
    const model = {
      id: "example/model-id",
      contextWindow: 128_000,
    } as Model<"openai-completions">;
    const settingsManager = { applyOverrides: vi.fn() };
    const authStorage = { setRuntimeApiKey: vi.fn() };
    const resourceLoader = { reload: vi.fn(async () => undefined) };
    const session = {
      agent: {} as { toolExecution?: string },
      bindExtensions: vi.fn(async () => undefined),
    };
    const sessionManager = { kind: "session-manager" };
    const atomicSessionManager = { kind: "atomic-session-manager" };
    const customTools = { kind: "custom-tools" };
    const providerExtension = extensionFactory("provider");
    const productExtension = extensionFactory("product");
    const preflightExtension = extensionFactory("preflight");
    const reasoningExtension = extensionFactory("reasoning");
    const accountingExtension = extensionFactory("accounting");
    const finalizerExtension = extensionFactory("finalizer");

    const dependencies: Partial<AgentRuntimeWorkflowRecordingReviewSessionDependencies> = {
      randomUUID: vi.fn(() => "review-session-uuid"),
      mkdirSync: vi.fn(),
      getAmbientProviderStatus: vi.fn(() =>
        ({ baseUrl: "https://ambient.example.test", model: "provider-request-model" }) as ReturnType<
          AgentRuntimeWorkflowRecordingReviewSessionDependencies["getAmbientProviderStatus"]
        >,
      ),
      readAmbientApiKey: vi.fn(() => "ambient-api-key"),
      normalizeAmbientBaseUrl: vi.fn((baseUrl) => `normalized:${baseUrl}`),
      ambientModel: vi.fn(() => model) as unknown as AgentRuntimeWorkflowRecordingReviewSessionDependencies["ambientModel"],
      createSettingsManager: vi.fn(() => settingsManager),
      piRetryOverridesFromModelRuntimeSettings: vi.fn((settings) => ({
        maxRetries: 4,
        settings,
      }) as unknown as ReturnType<
        AgentRuntimeWorkflowRecordingReviewSessionDependencies["piRetryOverridesFromModelRuntimeSettings"]
      >),
      createAuthStorage: vi.fn(() => authStorage),
      createResourceLoader: vi.fn(() => resourceLoader),
      workspaceBoundedAgentContextFiles: vi.fn(({ contextFiles }) => [
        "bounded",
        ...contextFiles,
      ]) as unknown as AgentRuntimeWorkflowRecordingReviewSessionDependencies["workspaceBoundedAgentContextFiles"],
      createAmbientProviderExtension: vi.fn(() => providerExtension) as unknown as AgentRuntimeWorkflowRecordingReviewSessionDependencies["createAmbientProviderExtension"],
      createAmbientProductContextExtension: vi.fn(() => productExtension) as unknown as AgentRuntimeWorkflowRecordingReviewSessionDependencies["createAmbientProductContextExtension"],
      materializeToolResultExtensionFactory: vi.fn((factory, options) => ({
        factory,
        options,
        materialized: true,
      }) as unknown as ReturnType<
        AgentRuntimeWorkflowRecordingReviewSessionDependencies["materializeToolResultExtensionFactory"]
      >),
      materializeToolResultFinalizerExtensionFactory: vi.fn(() => finalizerExtension) as unknown as AgentRuntimeWorkflowRecordingReviewSessionDependencies["materializeToolResultFinalizerExtensionFactory"],
      createSessionManager: vi.fn(() => sessionManager),
      enableAtomicPiSessionPersistence: vi.fn(() => atomicSessionManager),
      createAgentSession: vi.fn(async () => ({ session: session as unknown as WorkflowRecordingReviewPiSession })),
      createWorkflowRecordingReviewTools: vi.fn(() => [{ name: "review-tool" }] as unknown as ReturnType<
        AgentRuntimeWorkflowRecordingReviewSessionDependencies["createWorkflowRecordingReviewTools"]
      >),
      materializeToolDefinitions: vi.fn(() => customTools) as unknown as AgentRuntimeWorkflowRecordingReviewSessionDependencies["materializeToolDefinitions"],
      activeToolNames: ["workflow_recording_review_read_draft", "workflow_recording_review_update_draft"],
    };
    const store = {
      getWorkspace: vi.fn(() => ({
        path: "/app/workspace",
        name: "app-workspace",
        statePath: "/state",
        sessionPath: "/sessions",
      })),
      getCompactionSettings: vi.fn(() => ({
        autoCompactionEnabled: true,
        reserveTokens: 1_234,
        keepRecentTokens: 5_678,
        hardPreflightPercent: 0.9,
      })),
      getModelRuntimeSettings: vi.fn(() => ({
        streamIdleTimeoutMs: 30_000,
      })),
      getThread: vi.fn(() => thread),
      updateWorkflowRecordingReviewDraft: vi.fn(() => ({ status: "stopped" })),
    } as unknown as AgentRuntimeWorkflowRecordingReviewSessionControllerOptions["store"];
    const emit = vi.fn();
    const recordContextUsageSnapshot = vi.fn();

    const controller = new AgentRuntimeWorkflowRecordingReviewSessionController({
      store,
      emit,
      createProviderCallContextPreflightExtension: vi.fn(() => preflightExtension),
      createModelReasoningPayloadExtension: vi.fn(() => reasoningExtension),
      createContextAccountingExtension: vi.fn(() => accountingExtension),
      recordContextUsageSnapshot,
      dependencies,
    });

    await expect(controller.createSession(thread)).resolves.toBe(session);

    expect(dependencies.getAmbientProviderStatus).toHaveBeenCalledWith("example/model-id");
    expect(dependencies.ambientModel).toHaveBeenCalledWith(
      "example/model-id",
      "normalized:https://ambient.example.test",
      undefined,
      { requestModelId: "provider-request-model" },
    );
    expect(dependencies.mkdirSync).toHaveBeenNthCalledWith(1, "/state/pi", { recursive: true });
    expect(dependencies.mkdirSync).toHaveBeenNthCalledWith(
      2,
      "/sessions/thread-review/workflow-recording-review/review-session-uuid",
      { recursive: true },
    );
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: {
        enabled: true,
        reserveTokens: 1_234,
        keepRecentTokens: 5_678,
      },
      retry: {
        maxRetries: 4,
        settings: {
          streamIdleTimeoutMs: 30_000,
          aggressiveRetries: true,
        },
      },
    });
    expect(authStorage.setRuntimeApiKey).toHaveBeenCalledWith("ambient", "ambient-api-key");

    const resourceLoaderOptions = vi.mocked(dependencies.createResourceLoader!).mock.calls[0][0] as CapturedResourceLoaderOptions;
    expect(resourceLoaderOptions).toMatchObject({
      cwd: "/workspace/project-alpha",
      agentDir: "/state/pi",
      settingsManager,
    });
    expect(resourceLoaderOptions.agentsFilesOverride({ agentsFiles: ["AGENTS.md"] })).toEqual({
      agentsFiles: ["bounded", "AGENTS.md"],
    });
    expect(resourceLoaderOptions.extensionFactories).toHaveLength(6);
    expect(resourceLoader.reload).toHaveBeenCalledTimes(1);

    expect(dependencies.createSessionManager).toHaveBeenCalledWith(
      "/workspace/project-alpha",
      "/sessions/thread-review/workflow-recording-review/review-session-uuid",
    );
    expect(dependencies.enableAtomicPiSessionPersistence).toHaveBeenCalledWith(sessionManager);
    expect(dependencies.createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/workspace/project-alpha",
      agentDir: "/state/pi",
      authStorage,
      model,
      resourceLoader,
      sessionManager: atomicSessionManager,
      settingsManager,
      thinkingLevel: "medium",
      customTools,
      activeTools: ["workflow_recording_review_read_draft", "workflow_recording_review_update_draft"],
      includeAllExtensionTools: false,
    }));
    expect(session.agent.toolExecution).toBe("sequential");
    expect(session.bindExtensions).toHaveBeenCalledWith({});
    expect(recordContextUsageSnapshot).toHaveBeenCalledWith(
      "thread-review",
      session,
      "Workflow recording review is using a dedicated Ambient session.",
    );

    const reviewToolOptions = vi.mocked(dependencies.createWorkflowRecordingReviewTools!).mock.calls[0][0];
    expect(reviewToolOptions.threadId).toBe("thread-review");
    expect(reviewToolOptions.getThread("thread-review")).toBe(thread);
    const draftUpdate = { intent: "draft" } as Parameters<
      typeof reviewToolOptions.updateWorkflowRecordingReviewDraft
    >[1];
    reviewToolOptions.updateWorkflowRecordingReviewDraft("thread-review", draftUpdate, {
      source: "pi_summary",
    });
    expect(store.updateWorkflowRecordingReviewDraft).toHaveBeenCalledWith(
      "thread-review",
      { intent: "draft" },
      { source: "pi_summary" },
    );
    const event = { type: "plugin-catalog-updated" } as DesktopEvent;
    reviewToolOptions.emit(event);
    expect(emit).toHaveBeenCalledWith(event);
  });
});

function extensionFactory(name: string): ExtensionFactory {
  return { name } as unknown as ExtensionFactory;
}
