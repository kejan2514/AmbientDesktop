import { describe, expect, it, vi } from "vitest";

import {
  createRuntimePromptControllerSetup,
  type RuntimePromptControllerSetupInput,
} from "./runtimePromptControllerSetup";
import type { RuntimeToolExecutionWatchdog } from "./runtimeToolExecutionWatchdog";
import type { RuntimeToolArgumentWatchdog } from "./runtimeToolArgumentWatchdog";
import type { RuntimeEmptyAssistantStallWatchdog } from "./runtimeEmptyAssistantStallWatchdog";
import type { RuntimeAssistantTerminalCompletion } from "./runtimeAssistantTerminalCompletion";
import type {
  RuntimePostToolContinuationController,
  RuntimePostToolContinuationResult,
} from "./runtimePostToolContinuationController";
import type { RuntimePromptRunState } from "./runtimePromptRunState";
import type { PromptCompletion } from "./post-tool/postToolFinalization";

function pendingPromise<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function createInput(overrides: Partial<RuntimePromptControllerSetupInput> = {}) {
  const toolExecutionWatchdog: RuntimeToolExecutionWatchdog = {
    active: vi.fn(() => undefined),
    count: vi.fn(() => 0),
    isActive: vi.fn(() => false),
    isTimedOut: vi.fn(() => false),
    timeoutMessage: vi.fn(() => undefined),
    clear: vi.fn(),
    schedule: vi.fn(),
    begin: vi.fn(),
    mark: vi.fn(),
    finish: vi.fn(),
  };
  const toolArgumentWatchdog: RuntimeToolArgumentWatchdog = {
    clear: vi.fn(),
    schedule: vi.fn(),
    refreshOnTransportActivity: vi.fn(),
  };
  const emptyAssistantStallWatchdog: RuntimeEmptyAssistantStallWatchdog = {
    clear: vi.fn(),
    schedule: vi.fn(),
    refreshOnStreamActivity: vi.fn(),
  };
  const assistantTerminalCompletion: RuntimeAssistantTerminalCompletion = {
    completion: pendingPromise(),
    graceMs: vi.fn(() => 250),
    isArmed: vi.fn(() => false),
    clear: vi.fn(),
    schedule: vi.fn(),
    resetOnActivity: vi.fn(),
  };
  const promptRunState: RuntimePromptRunState = {
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
      runtimeError: undefined,
      finalizedAfterToolIdle: false,
      lastCompletedTool: undefined,
      assistantTextObservedAfterLastToolEnd: false,
      lastAssistantTerminalEvent: undefined,
      assistantTerminalCleanupDiagnostic: undefined,
      assistantTerminalCleanupInProgress: false,
    })),
  };
  const postToolContinuation: RuntimePostToolContinuationController = {
    markEvent: vi.fn(),
    markAgentEnd: vi.fn(),
    markToolStart: vi.fn(),
    markToolEnd: vi.fn(),
    wait: vi.fn(() => pendingPromise<PromptCompletion>()),
    stop: vi.fn(),
    request: vi.fn(() => Promise.resolve("continued" as RuntimePostToolContinuationResult)),
    extendToFinalizationWindow: vi.fn(() => false),
    idleMs: vi.fn(() => 500),
    attempts: vi.fn(() => 0),
  };

  const input: RuntimePromptControllerSetupInput = {
    threadId: "thread-1",
    runId: "run-1",
    defaultToolExecutionIdleTimeoutMs: 15_000,
    toolArgumentIdleTimeoutMs: 30_000,
    emptyAssistantStallTimeoutMs: 2_000,
    assistantTerminalGraceMs: 250,
    postToolContinuationIdleMs: 500,
    postToolFinalizationIdleMs: 750,
    postToolFinalizationTickMs: 25,
    assistantFinalizationRetryMaxRetries: 2,
    isRunStoreActive: vi.fn(() => true),
    isPermissionWaiting: vi.fn(() => false),
    pauseStreamWatchdog: vi.fn(),
    resumeStreamWatchdog: vi.fn(),
    resetStreamWatchdog: vi.fn(),
    abortSessionRun: vi.fn(),
    signalToolExecutionTimeout: vi.fn(),
    signalStreamWatchdogTimeout: vi.fn(),
    streamWatchdogCompletion: pendingPromise(),
    isStreamTimedOut: vi.fn(() => false),
    markStreamTimedOut: vi.fn(),
    setStreamTimeoutMessage: vi.fn(),
    streamTimeoutMessage: vi.fn(() => "stream timed out"),
    persistPiStreamTrace: vi.fn(() => undefined),
    toolArgumentProgress: {
      nextActiveArgumentStallDelayMs: vi.fn(() => undefined),
      stalledActiveArgument: vi.fn(() => undefined),
    },
    forceInterruptedToolCallRecovery: vi.fn((snapshot) => snapshot),
    getOutputChars: vi.fn(() => 10),
    getThinkingChars: vi.fn(() => 4),
    hasAssistantText: vi.fn(() => true),
    getAssistantStartCount: vi.fn(() => 1),
    getReceivedAnyText: vi.fn(() => true),
    getCurrentAssistantReceivedText: vi.fn(() => false),
    getCurrentAssistantFinalText: vi.fn(() => "done"),
    getStreamEventCount: vi.fn(() => 3),
    getSessionFile: vi.fn(() => "session.jsonl"),
    getMessages: vi.fn(() => []),
    getRunEventSeq: vi.fn(() => 7),
    steerContinuation: vi.fn(() => Promise.resolve()),
    finalizeAssistantTerminalRun: vi.fn(() => Promise.resolve()),
    emitRunEvent: vi.fn(),
    createToolExecutionWatchdog: vi.fn(() => toolExecutionWatchdog),
    createToolArgumentWatchdog: vi.fn(() => toolArgumentWatchdog),
    createEmptyAssistantStallWatchdog: vi.fn(() => emptyAssistantStallWatchdog),
    createAssistantTerminalCompletion: vi.fn(() => assistantTerminalCompletion),
    createPromptRunState: vi.fn(() => promptRunState),
    createPostToolContinuationController: vi.fn(() => postToolContinuation),
    ...overrides,
  };

  return {
    input,
    toolExecutionWatchdog,
    toolArgumentWatchdog,
    emptyAssistantStallWatchdog,
    assistantTerminalCompletion,
    promptRunState,
    postToolContinuation,
  };
}

describe("createRuntimePromptControllerSetup", () => {
  it("creates and returns the prompt runtime controllers", () => {
    const harness = createInput();

    const setup = createRuntimePromptControllerSetup(harness.input);

    expect(setup).toEqual({
      toolExecutionWatchdog: harness.toolExecutionWatchdog,
      toolArgumentWatchdog: harness.toolArgumentWatchdog,
      emptyAssistantStallWatchdog: harness.emptyAssistantStallWatchdog,
      assistantTerminalCompletion: harness.assistantTerminalCompletion,
      promptRunState: harness.promptRunState,
      postToolContinuation: harness.postToolContinuation,
    });
  });

  it("wires tool watchdogs to stream watchdog controls and timeout state", () => {
    const harness = createInput();

    createRuntimePromptControllerSetup(harness.input);

    expect(harness.input.createToolExecutionWatchdog).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        defaultIdleTimeoutMs: 15_000,
        isRunStoreActive: harness.input.isRunStoreActive,
        isPermissionWaiting: harness.input.isPermissionWaiting,
        pauseStreamWatchdog: harness.input.pauseStreamWatchdog,
        resumeStreamWatchdog: harness.input.resumeStreamWatchdog,
        abortSessionRun: harness.input.abortSessionRun,
        signalToolExecutionTimeout: harness.input.signalToolExecutionTimeout,
        emitRunEvent: harness.input.emitRunEvent,
      }),
    );
    expect(harness.input.createToolArgumentWatchdog).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        idleTimeoutMs: 30_000,
        progress: harness.input.toolArgumentProgress,
        isRunStoreActive: harness.input.isRunStoreActive,
        isPermissionWaiting: harness.input.isPermissionWaiting,
        isToolExecutionActive: harness.toolExecutionWatchdog.isActive,
        isStreamTimedOut: harness.input.isStreamTimedOut,
        isToolExecutionTimedOut: harness.toolExecutionWatchdog.isTimedOut,
        markStreamTimedOut: harness.input.markStreamTimedOut,
        setStreamTimeoutMessage: harness.input.setStreamTimeoutMessage,
        forceInterruptedToolCallRecovery: harness.input.forceInterruptedToolCallRecovery,
        persistPiStreamTrace: harness.input.persistPiStreamTrace,
        abortSessionRun: harness.input.abortSessionRun,
        signalStreamWatchdogTimeout: harness.input.signalStreamWatchdogTimeout,
        emitRunEvent: harness.input.emitRunEvent,
      }),
    );
  });

  it("builds watchdog state snapshots from live accessors", () => {
    const harness = createInput();

    createRuntimePromptControllerSetup(harness.input);

    const toolArgumentInput = vi.mocked(harness.input.createToolArgumentWatchdog!).mock.calls[0][0];
    const emptyAssistantInput = vi.mocked(harness.input.createEmptyAssistantStallWatchdog!).mock.calls[0][0];

    expect(toolArgumentInput.getState()).toEqual({
      outputChars: 10,
      thinkingChars: 4,
      streamEventCount: 3,
    });
    expect(emptyAssistantInput.getState()).toEqual({
      outputChars: 10,
      thinkingChars: 4,
      assistantStartCount: 1,
      receivedAnyText: true,
      currentAssistantReceivedText: false,
      currentAssistantFinalText: "done",
      streamEventCount: 3,
      sessionFile: "session.jsonl",
    });
  });

  it("wires assistant terminal completion and post-tool continuation through prompt run state", () => {
    const harness = createInput();

    createRuntimePromptControllerSetup(harness.input);

    expect(harness.input.createAssistantTerminalCompletion).toHaveBeenCalledWith({
      defaultGraceMs: 250,
      hasAssistantText: harness.input.hasAssistantText,
    });
    expect(harness.input.createPostToolContinuationController).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        runId: "run-1",
        continuationIdleMs: 500,
        finalizationIdleMs: 750,
        tickMs: 25,
        streamIdleTimeoutMs: 30_000,
        maxAttempts: 2,
        getOutputChars: harness.input.getOutputChars,
        getThinkingChars: harness.input.getThinkingChars,
        getMessages: harness.input.getMessages,
        getLastCompletedTool: harness.promptRunState.lastCompletedTool,
        getRunEventSeq: harness.input.getRunEventSeq,
        resetStreamWatchdog: harness.input.resetStreamWatchdog,
        assistantTerminalCompletion: harness.assistantTerminalCompletion.completion,
        streamWatchdogCompletion: harness.input.streamWatchdogCompletion,
        isStreamTimedOut: harness.input.isStreamTimedOut,
        streamTimeoutMessage: harness.input.streamTimeoutMessage,
        isToolExecutionTimedOut: harness.toolExecutionWatchdog.isTimedOut,
        toolExecutionTimeoutMessage: harness.toolExecutionWatchdog.timeoutMessage,
        steerContinuation: harness.input.steerContinuation,
        finalizeAssistantTerminalRun: harness.input.finalizeAssistantTerminalRun,
        emitRunEvent: harness.input.emitRunEvent,
      }),
    );
  });
});
