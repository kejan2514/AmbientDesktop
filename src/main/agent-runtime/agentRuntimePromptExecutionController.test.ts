import { describe, expect, it, vi } from "vitest";

import type { DesktopEvent } from "../../shared/desktopTypes";
import type { ThreadSummary } from "../../shared/threadTypes";
import {
  AgentRuntimePromptExecutionController,
  type AgentRuntimePromptExecutionControllerOptions,
  type AgentRuntimePromptExecutionSession,
} from "./agentRuntimePromptExecutionController";
import type { RuntimePromptCompletionSetupInput } from "./runtimePromptCompletionSetup";
import type { RuntimePromptControllerSetup } from "./runtimePromptControllerSetup";
import { createRuntimePromptControlState } from "./runtimePromptControlState";
import type { RuntimePromptExecutionController } from "./runtimePromptExecutionController";
import type { RuntimePromptStreamDispatcherSetupInput } from "./runtimePromptStreamDispatcherSetup";
import { createRuntimeProviderRetryState } from "./runtimeProviderRetryState";
import type { RuntimeStreamWatchdogController } from "./runtimeStreamWatchdogController";
import { createRuntimeTextOutputState } from "./runtimeTextOutputState";
import type { RuntimeToolEventDispatcherSetupInput } from "./runtimeToolEventDispatcherSetup";
import {
  bindAmbientProviderTransportChannel,
  type AmbientProviderTransportActivity,
} from "../ambient/ambientProviderTransportActivity";

const createdAt = "2026-06-19T00:00:00.000Z";

interface TestSession extends AgentRuntimePromptExecutionSession {
  id: string;
}

function thread(): ThreadSummary {
  return {
    id: "thread-1",
    title: "Thread",
    createdAt,
    updatedAt: createdAt,
    model: "ambient-preview",
    thinkingLevel: "medium",
    permissionMode: "full-access",
    collaborationMode: "agent",
    workspacePath: "/workspace",
    memoryEnabled: false,
  } as ThreadSummary;
}

function session(): TestSession {
  return {
    id: "session-1",
    sessionFile: "/tmp/session.jsonl",
    isStreaming: true,
    prompt: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    subscribe: vi.fn(() => vi.fn()),
    dispose: vi.fn(),
  };
}

function promptControllers(): RuntimePromptControllerSetup {
  return {
    toolExecutionWatchdog: {
      begin: vi.fn(),
      mark: vi.fn(),
      finish: vi.fn(),
      isActive: vi.fn(() => false),
      isTimedOut: vi.fn(() => false),
      timeoutMessage: vi.fn(() => undefined),
      clear: vi.fn(),
    },
    toolArgumentWatchdog: {
      schedule: vi.fn(),
      clear: vi.fn(),
      refreshOnTransportActivity: vi.fn(),
    },
    emptyAssistantStallWatchdog: {
      schedule: vi.fn(),
      clear: vi.fn(),
      refreshOnStreamActivity: vi.fn(),
    },
    assistantTerminalCompletion: {
      schedule: vi.fn(),
      resetOnActivity: vi.fn(),
      clear: vi.fn(),
      completion: new Promise(() => undefined),
      graceMs: vi.fn(() => 250),
    },
    promptRunState: {
      runtimeError: vi.fn(() => undefined),
      setRuntimeError: vi.fn(),
      finalizedAfterToolIdle: vi.fn(() => false),
      setFinalizedAfterToolIdle: vi.fn(),
      lastCompletedTool: vi.fn(() => undefined),
      setLastCompletedTool: vi.fn(),
      hasLastCompletedTool: vi.fn(() => false),
      assistantTextObservedAfterLastToolEnd: vi.fn(() => false),
      setAssistantTextObservedAfterLastToolEnd: vi.fn(),
      markAssistantTextNotObservedAfterLastToolEnd: vi.fn(),
      lastAssistantTerminalEvent: vi.fn(() => undefined),
      setLastAssistantTerminalEvent: vi.fn(),
      assistantTerminalCleanupDiagnostic: vi.fn(() => undefined),
      setAssistantTerminalCleanupDiagnostic: vi.fn(),
      assistantTerminalCleanupInProgress: vi.fn(() => false),
      markAssistantTerminalCleanupInProgress: vi.fn(),
      shouldIgnoreAssistantTerminalCleanupError: vi.fn(() => false),
      snapshot: vi.fn(() => ({
        finalizedAfterToolIdle: true,
        assistantTextObservedAfterLastToolEnd: false,
        assistantTerminalCleanupInProgress: false,
      })),
    },
    postToolContinuation: {
      markEvent: vi.fn(),
      markToolStart: vi.fn(),
      markToolEnd: vi.fn(),
      markAgentEnd: vi.fn(),
      wait: vi.fn(),
      request: vi.fn(),
      extendToFinalizationWindow: vi.fn(() => false),
      stop: vi.fn(),
    },
  } as unknown as RuntimePromptControllerSetup;
}

describe("AgentRuntimePromptExecutionController", () => {
  it("routes prompt execution through focused runtime owners", async () => {
    const testSession = session();
    const transportListeners = new Set<(activity: AmbientProviderTransportActivity) => void>();
    const publishTransportActivity = (activity: AmbientProviderTransportActivity) => {
      for (const listener of transportListeners) listener(activity);
    };
    bindAmbientProviderTransportChannel(testSession, {
      publish: publishTransportActivity,
      subscribe: (listener) => {
        transportListeners.add(listener);
        return () => transportListeners.delete(listener);
      },
    });
    const controllers = promptControllers();
    const streamInputs: RuntimePromptStreamDispatcherSetupInput[] = [];
    const toolInputs: RuntimeToolEventDispatcherSetupInput[] = [];
    const completionInputs: RuntimePromptCompletionSetupInput<TestSession>[] = [];
    const promptExecutionInputs: Array<{ removeActiveSessionIfCurrent: (session: TestSession) => void }> = [];
    const promptExecution: RuntimePromptExecutionController = {
      promptCompletion: Promise.resolve("prompt"),
      finalizeAssistantTerminalRun: vi.fn(async () => undefined),
      waitForPromptAfterAbort: vi.fn(async () => "prompt"),
    };
    const unsubscribe = vi.fn();
    const options: AgentRuntimePromptExecutionControllerOptions<TestSession> = {
      preflightBeforePrompt: vi.fn(async () => undefined),
      abortSessionRun: vi.fn(async () => undefined),
      removeActiveSessionIfCurrent: vi.fn(),
      recordContextUsageSnapshot: vi.fn(),
      refreshBrowsersForArtifactChange: vi.fn(),
      createPromptControllerSetup: vi.fn(() => controllers),
      createPromptStreamDispatcherSetup: vi.fn((input) => {
        streamInputs.push(input);
        return { handle: vi.fn(() => false) };
      }),
      createToolEventDispatcherSetup: vi.fn((input) => {
        toolInputs.push(input);
        return { handle: vi.fn(() => false) };
      }),
      subscribePromptEvents: vi.fn((input) => {
        input.subscribe(vi.fn());
        return unsubscribe;
      }),
      createPromptExecutionSetup: vi.fn((input) => {
        promptExecutionInputs.push(input as { removeActiveSessionIfCurrent: (session: TestSession) => void });
        return promptExecution;
      }),
      runPromptCompletionSetup: vi.fn(async (input) => {
        completionInputs.push(input);
        publishTransportActivity({ kind: "request_prepared", inputTokens: 69_377 });
        publishTransportActivity({ kind: "body", bytes: 12 });
        return { finalizedAfterToolIdle: true };
      }),
    };
    const setStreamWatchdog = vi.fn();
    const setToolExecutionWatchdog = vi.fn();
    const setToolArgumentWatchdog = vi.fn();
    const setEmptyAssistantStallWatchdog = vi.fn();
    const setAssistantTerminalCompletion = vi.fn();
    const setMarkOpenToolMessagesFailed = vi.fn();
    const toolMessages = {
      markOpenToolMessagesFailed: vi.fn(() => 1),
    };
    const outputState = createRuntimeTextOutputState();
    const runtimeMessages = {
      assistantStartCount: vi.fn(() => 0),
      finishCurrentThinkingMessage: vi.fn(),
    } as unknown as RuntimePromptStreamDispatcherSetupInput["runtimeMessages"];
    const toolRecovery = {
      rememberToolIntent: vi.fn(),
      trackInterruptedToolCallRecovery: vi.fn(),
      markInterruptedToolCallNoLongerRecoverable: vi.fn(),
      persistToolArgumentDiagnostics: vi.fn(),
    };

    const result = await new AgentRuntimePromptExecutionController(options).runPrompt({
      thread: thread(),
      runId: "run-1",
      session: testSession,
      promptContent: "hello Pi",
      images: [{ path: "image.png" }],
      preStreamTimeoutMs: 3_000,
      streamIdleTimeoutMs: 30_000,
      defaultToolExecutionIdleTimeoutMs: 30_000,
      emptyAssistantStallTimeoutMs: 2_000,
      assistantTerminalGraceMs: 250,
      postToolContinuationIdleMs: 500,
      postToolFinalizationIdleMs: 500,
      postToolFinalizationTickMs: 50,
      abortGraceMs: 1_000,
      assistantFinalizationRetryMaxRetries: 3,
      isRunStoreActive: vi.fn(() => true),
      permissionWaits: { isWaiting: vi.fn(() => false) },
      promptControlState: createRuntimePromptControlState(),
      promptLifecycleControls: {
        streamWatchdogCompletion: new Promise(() => undefined),
        setActiveRunStatus: vi.fn(),
        signalStreamWatchdogTimeout: vi.fn(),
        signalToolExecutionTimeout: vi.fn(),
        signalParentControlAbort: vi.fn(),
      },
      streamTimeoutMessage: vi.fn(() => "stream timed out"),
      persistPiStreamTrace: vi.fn(() => undefined),
      toolArgumentProgress: {
        current: vi.fn(),
        recordArgumentEvent: vi.fn(),
        markExecutionStart: vi.fn(),
        markExecutionEnd: vi.fn(),
        nextActiveArgumentStallDelayMs: vi.fn(() => undefined),
        stalledActiveArgument: vi.fn(() => undefined),
      },
      forceInterruptedToolCallRecovery: vi.fn((snapshot) => snapshot),
      outputState,
      runtimeMessages,
      getMessages: vi.fn(() => []),
      queuedMessages: {
        flushPending: vi.fn(async () => undefined),
        reconcileQueueUpdate: vi.fn(),
      },
      streamActivity: {
        markActivity: vi.fn(),
        snapshot: vi.fn(() => ({
          eventCount: 0,
          approximatePayloadBytes: 0,
          lastActivityAtMs: 0,
        })),
      },
      streamTraceState: {
        markFirstToolArgumentObserved: vi.fn(),
        markFirstToolExecutionObserved: vi.fn(),
      } as unknown as Parameters<
        AgentRuntimePromptExecutionController<TestSession>["runPrompt"]
      >[0]["streamTraceState"],
      providerRetryState: createRuntimeProviderRetryState(),
      toolMessages: toolMessages as unknown as Parameters<
        AgentRuntimePromptExecutionController<TestSession>["runPrompt"]
      >[0]["toolMessages"],
      toolRecovery: toolRecovery as unknown as Parameters<
        AgentRuntimePromptExecutionController<TestSession>["runPrompt"]
      >[0]["toolRecovery"],
      startedToolCallIds: new Set(),
      markRunActivity: vi.fn(() => true),
      recordPiStreamTraceEvent: vi.fn(),
      requestSubagentParentControlAbort: vi.fn(),
      setStreamWatchdog,
      setToolExecutionWatchdog,
      setToolArgumentWatchdog,
      setEmptyAssistantStallWatchdog,
      setAssistantTerminalCompletion,
      setMarkOpenToolMessagesFailed,
      emitRunEvent: vi.fn((_event: DesktopEvent) => undefined),
    });

    expect(result.completed).toBe(true);
    expect(result.promptRunState).toBe(controllers.promptRunState);
    expect(options.preflightBeforePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        thread: expect.objectContaining({ id: "thread-1" }),
        session: testSession,
        promptContent: "hello Pi",
      }),
    );
    expect(setToolExecutionWatchdog).toHaveBeenCalledWith(controllers.toolExecutionWatchdog);
    expect(setToolArgumentWatchdog).toHaveBeenCalledWith(controllers.toolArgumentWatchdog);
    expect(setEmptyAssistantStallWatchdog).toHaveBeenCalledWith(controllers.emptyAssistantStallWatchdog);
    expect(setAssistantTerminalCompletion).toHaveBeenCalledWith(controllers.assistantTerminalCompletion);
    expect(controllers.promptRunState.setFinalizedAfterToolIdle).toHaveBeenCalledWith(true);

    streamInputs[0]!.recordContextUsageSnapshot("snapshot message");
    expect(options.recordContextUsageSnapshot).toHaveBeenCalledWith("thread-1", testSession, "snapshot message");
    toolInputs[0]!.refreshBrowsersForArtifactChange("thread-1", "/workspace", "artifact.html");
    expect(options.refreshBrowsersForArtifactChange).toHaveBeenCalledWith("thread-1", "/workspace", "artifact.html");
    expect(toolInputs[0]!.runtimeMessages).toBe(runtimeMessages);
    expect(toolInputs[0]!.outputState).toBe(outputState);

    const streamWatchdog = {
      reset: vi.fn(),
      markTransportActivity: vi.fn(),
      setPreStreamTimeoutMs: vi.fn(),
      pause: vi.fn(),
      pauseIfNeeded: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
      clear: vi.fn(),
    } as RuntimeStreamWatchdogController;
    completionInputs[0]!.setStreamWatchdog(streamWatchdog);
    expect(streamWatchdog.setPreStreamTimeoutMs).toHaveBeenCalledWith(80_000);
    expect(streamWatchdog.markTransportActivity).toHaveBeenCalledTimes(1);
    expect(controllers.emptyAssistantStallWatchdog.refreshOnStreamActivity).toHaveBeenCalledTimes(1);
    expect(controllers.toolArgumentWatchdog.refreshOnTransportActivity).toHaveBeenCalledTimes(1);
    expect(setStreamWatchdog).toHaveBeenCalledWith(streamWatchdog);
    completionInputs[0]!.unsubscribePromptEvents();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(transportListeners.size).toBe(0);
    await completionInputs[0]!.finalizeAssistantTerminalRun();
    expect(promptExecution.finalizeAssistantTerminalRun).toHaveBeenCalledTimes(1);
    promptExecutionInputs[0]!.removeActiveSessionIfCurrent(testSession);
    expect(options.removeActiveSessionIfCurrent).toHaveBeenCalledWith("thread-1", testSession);

    const markOpenToolMessagesFailed = setMarkOpenToolMessagesFailed.mock.calls[0]![0];
    markOpenToolMessagesFailed("Ambient/Pi provider failed before this tool completed.");
    expect(toolMessages.markOpenToolMessagesFailed).toHaveBeenCalledWith(
      "Ambient/Pi provider failed before this tool completed.",
    );
    expect(toolRecovery.persistToolArgumentDiagnostics).toHaveBeenCalledWith(true);
    expect(testSession.subscribe).toHaveBeenCalledTimes(1);
  });
});
