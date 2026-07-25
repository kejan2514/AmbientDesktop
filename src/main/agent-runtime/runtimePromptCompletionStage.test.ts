import { describe, expect, it, vi } from "vitest";

import {
  runRuntimePromptCompletionStage,
  type RuntimePromptCompletionStageInput,
} from "./runtimePromptCompletionStage";
import type { RuntimeStreamWatchdogController } from "./runtimeStreamWatchdogController";
import type { PromptCompletion } from "./post-tool/postToolFinalization";
import type { RuntimePostToolContinuationResult } from "./runtimePostToolContinuationController";

function pendingPromise<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function createInput(overrides: Partial<RuntimePromptCompletionStageInput> = {}) {
  const streamWatchdog: RuntimeStreamWatchdogController = {
    pause: vi.fn(),
    resume: vi.fn(),
    reset: vi.fn(),
    markTransportActivity: vi.fn(),
    setPreStreamTimeoutMs: vi.fn(),
    stop: vi.fn(),
    pauseIfNeeded: vi.fn(),
  };
  const input: RuntimePromptCompletionStageInput = {
    threadId: "thread-1",
    preStreamTimeoutMs: 3_000,
    idleTimeoutMs: 30_000,
    isRunStoreActive: vi.fn(() => true),
    isPermissionWaiting: vi.fn(() => false),
    isToolExecutionActive: vi.fn(() => false),
    markStreamTimedOut: vi.fn(),
    setStreamTimeoutMessage: vi.fn(),
    persistPiStreamTrace: vi.fn(() => undefined),
    getStreamState: vi.fn(() => ({
      outputChars: 7,
      thinkingChars: 2,
      streamEventCount: 4,
    })),
    abortSessionRun: vi.fn(() => Promise.resolve()),
    signalStreamWatchdogTimeout: vi.fn(),
    emitRunEvent: vi.fn(),
    setStreamWatchdog: vi.fn(),
    markQueueReady: vi.fn(),
    flushPendingQueuedMessages: vi.fn(() => Promise.resolve()),
    promptCompletion: Promise.resolve("prompt"),
    postToolContinuation: {
      wait: vi.fn(() => pendingPromise<PromptCompletion>()),
      request: vi.fn(() => Promise.resolve("stopped" as RuntimePostToolContinuationResult)),
      extendToFinalizationWindow: vi.fn(() => false),
      stop: vi.fn(),
    },
    assistantTerminalCompletion: {
      completion: pendingPromise(),
      clear: vi.fn(),
    },
    streamWatchdogCompletion: pendingPromise(),
    hasLastCompletedTool: vi.fn(() => false),
    assistantTextObservedAfterLastToolEnd: vi.fn(() => false),
    isStreamTimedOut: vi.fn(() => false),
    streamTimeoutMessage: vi.fn(() => "Ambient/Pi stream stalled after 30000 ms without stream activity."),
    isToolExecutionTimedOut: vi.fn(() => false),
    toolExecutionTimeoutMessage: vi.fn(() => undefined),
    finalizeAssistantTerminalRun: vi.fn(() => Promise.resolve()),
    waitForPromptAfterAbort: vi.fn(() => Promise.resolve()),
    clearEmptyAssistantStallWatchdog: vi.fn(),
    clearToolArgumentWatchdog: vi.fn(),
    clearToolExecutionWatchdog: vi.fn(),
    unsubscribePromptEvents: vi.fn(),
    createStreamWatchdog: vi.fn(() => streamWatchdog),
    runPromptCompletionLoop: vi.fn(async (loopInput) => {
      loopInput.cleanup();
      return { finalizedAfterToolIdle: true };
    }),
    ...overrides,
  };
  return { input, streamWatchdog };
}

describe("runRuntimePromptCompletionStage", () => {
  it("creates and exposes the stream watchdog before opening the queue gate", async () => {
    const { input, streamWatchdog } = createInput();

    await expect(runRuntimePromptCompletionStage(input)).resolves.toEqual({
      finalizedAfterToolIdle: true,
    });

    expect(input.createStreamWatchdog).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        preStreamTimeoutMs: 3_000,
        idleTimeoutMs: 30_000,
        isRunStoreActive: input.isRunStoreActive,
        markStreamTimedOut: input.markStreamTimedOut,
        setStreamTimeoutMessage: input.setStreamTimeoutMessage,
        persistPiStreamTrace: input.persistPiStreamTrace,
        getState: input.getStreamState,
        signalStreamWatchdogTimeout: input.signalStreamWatchdogTimeout,
        emitRunEvent: input.emitRunEvent,
      }),
    );
    expect(input.setStreamWatchdog).toHaveBeenCalledWith(streamWatchdog);
    expect(streamWatchdog.pauseIfNeeded).toHaveBeenCalledTimes(1);
    expect(input.markQueueReady).toHaveBeenCalledTimes(1);
    expect(input.flushPendingQueuedMessages).toHaveBeenCalledTimes(1);
    expect(vi.mocked(input.setStreamWatchdog).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(streamWatchdog.pauseIfNeeded).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(streamWatchdog.pauseIfNeeded).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(input.markQueueReady).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(input.markQueueReady).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(input.flushPendingQueuedMessages).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(input.flushPendingQueuedMessages).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(input.runPromptCompletionLoop!).mock.invocationCallOrder[0],
    );
  });

  it("passes prompt completion policy inputs through to the loop", async () => {
    const { input } = createInput();

    await runRuntimePromptCompletionStage(input);

    expect(input.runPromptCompletionLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        promptCompletion: input.promptCompletion,
        postToolContinuation: input.postToolContinuation,
        assistantTerminalCompletion: input.assistantTerminalCompletion.completion,
        streamWatchdogCompletion: input.streamWatchdogCompletion,
        hasLastCompletedTool: input.hasLastCompletedTool,
        assistantTextObservedAfterLastToolEnd: input.assistantTextObservedAfterLastToolEnd,
        isStreamTimedOut: input.isStreamTimedOut,
        streamTimeoutMessage: input.streamTimeoutMessage,
        isToolExecutionTimedOut: input.isToolExecutionTimedOut,
        toolExecutionTimeoutMessage: input.toolExecutionTimeoutMessage,
        finalizeAssistantTerminalRun: input.finalizeAssistantTerminalRun,
        abortSessionRun: input.abortSessionRun,
        waitForPromptAfterAbort: input.waitForPromptAfterAbort,
      }),
    );
  });

  it("cleans up prompt controllers through the prompt loop cleanup callback", async () => {
    const { input, streamWatchdog } = createInput();

    await runRuntimePromptCompletionStage(input);

    expect(input.assistantTerminalCompletion.clear).toHaveBeenCalledTimes(1);
    expect(input.clearEmptyAssistantStallWatchdog).toHaveBeenCalledTimes(1);
    expect(input.clearToolArgumentWatchdog).toHaveBeenCalledTimes(1);
    expect(input.clearToolExecutionWatchdog).toHaveBeenCalledTimes(1);
    expect(streamWatchdog.stop).toHaveBeenCalledTimes(1);
    expect(input.postToolContinuation.stop).toHaveBeenCalledTimes(1);
    expect(input.unsubscribePromptEvents).toHaveBeenCalledTimes(1);
  });

  it("pauses for either permission waits or active tool execution", async () => {
    const { input } = createInput({
      isPermissionWaiting: vi.fn(() => false),
      isToolExecutionActive: vi.fn(() => true),
    });

    await runRuntimePromptCompletionStage(input);

    const watchdogInput = vi.mocked(input.createStreamWatchdog!).mock.calls[0][0];
    expect(watchdogInput.shouldPauseForExternalActivity()).toBe(true);
    expect(input.isPermissionWaiting).toHaveBeenCalledTimes(1);
    expect(input.isToolExecutionActive).toHaveBeenCalledTimes(1);

    vi.mocked(input.isPermissionWaiting).mockReturnValue(true);
    vi.mocked(input.isToolExecutionActive).mockReturnValue(false);

    expect(watchdogInput.shouldPauseForExternalActivity()).toBe(true);
  });

  it("uses a fire-and-forget abort for stream watchdog timeout handling", async () => {
    const { input } = createInput({
      abortSessionRun: vi.fn(() => Promise.reject(new Error("already aborted"))),
    });

    await runRuntimePromptCompletionStage(input);

    const watchdogInput = vi.mocked(input.createStreamWatchdog!).mock.calls[0][0];
    expect(() => watchdogInput.abortSessionRun()).not.toThrow();
    await Promise.resolve();
    expect(input.abortSessionRun).toHaveBeenCalledTimes(1);
  });
});
