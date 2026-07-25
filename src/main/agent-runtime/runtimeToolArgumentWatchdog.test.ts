import { describe, expect, it, vi } from "vitest";
import type { DesktopEvent } from "../../shared/desktopTypes";
import type { ToolArgumentProgressSnapshot } from "../../shared/threadTypes";
import { createRuntimeToolArgumentWatchdog } from "./runtimeToolArgumentWatchdog";

function progressSnapshot(overrides: Partial<ToolArgumentProgressSnapshot> = {}): ToolArgumentProgressSnapshot {
  return {
    toolCallId: "tool-call-1",
    toolName: "write",
    argumentStartedAt: "2026-06-15T00:00:00.000Z",
    argumentUpdatedAt: "2026-06-15T00:00:05.000Z",
    argumentElapsedMs: 5_000,
    argumentComplete: false,
    inputChars: 120,
    lastDeltaChars: 0,
    totalDeltaChars: 120,
    maxDeltaChars: 120,
    observedArgumentChars: 120,
    argumentEventCount: 2,
    toolcallDeltaCount: 1,
    meaningfulGrowthCount: 1,
    lastMeaningfulGrowthMsAgo: 30_000,
    lastEventType: "toolcall_delta",
    phase: "argument_stream",
    uiStatus: "write is preparing input.",
    ...overrides,
  } as ToolArgumentProgressSnapshot;
}

function baseInput(overrides: Record<string, unknown> = {}) {
  const emitted: DesktopEvent[] = [];
  let timeoutMessage: string | undefined;
  const progress = {
    nextActiveArgumentStallDelayMs: vi.fn(() => 1_000 as number | undefined),
    stalledActiveArgument: vi.fn(() => progressSnapshot() as ToolArgumentProgressSnapshot | undefined),
  };
  return {
    threadId: "thread-1",
    idleTimeoutMs: 30_000,
    progress,
    isRunStoreActive: vi.fn(() => true),
    isPermissionWaiting: vi.fn(() => false),
    isToolExecutionActive: vi.fn(() => false),
    isStreamTimedOut: vi.fn(() => false),
    isToolExecutionTimedOut: vi.fn(() => false),
    markStreamTimedOut: vi.fn(),
    setStreamTimeoutMessage: vi.fn((message: string) => {
      timeoutMessage = message;
    }),
    forceInterruptedToolCallRecovery: vi.fn((snapshot: ToolArgumentProgressSnapshot) => snapshot),
    persistPiStreamTrace: vi.fn(() => ({
      path: "/tmp/pi-stream-trace.jsonl",
      eventCount: 2,
      recentEventCount: 2,
      reason: "timeout",
      recordedAt: "2026-06-15T00:00:30.000Z",
    })),
    getState: vi.fn(() => ({
      outputChars: 12,
      thinkingChars: 3,
      streamEventCount: 4,
    })),
    abortSessionRun: vi.fn(),
    signalStreamWatchdogTimeout: vi.fn(),
    emitRunEvent: vi.fn((event: DesktopEvent) => {
      emitted.push(event);
    }),
    emitted,
    get timeoutMessage() {
      return timeoutMessage;
    },
    ...overrides,
  };
}

describe("createRuntimeToolArgumentWatchdog", () => {
  it("emits a stream timeout activity, persists a trace, aborts, and signals completion when arguments stall", () => {
    vi.useFakeTimers();
    try {
      const recovered = progressSnapshot({
        interruptedToolCallRecovery: {
          version: 1,
          status: "recoverable",
          runId: "run-1",
          toolCallId: "tool-call-1",
          toolName: "write",
          source: "raw_tool_input",
          thresholdChars: 10_000,
          capturedChars: 120,
          observedArgumentChars: 120,
          updatedAt: "2026-06-15T00:00:30.000Z",
          parseStatus: "valid_json",
          argumentPath: "/tmp/recovered-args.json",
          workspaceRelativeArgumentPath: "recovered-args.json",
          argumentSha256: "abc123",
          suffixPreview: "",
          resumeInstruction: "Continue the interrupted tool call.",
        },
      });
      const input = baseInput({
        forceInterruptedToolCallRecovery: vi.fn(() => recovered),
      });
      const watchdog = createRuntimeToolArgumentWatchdog(input);

      watchdog.schedule();
      vi.advanceTimersByTime(1_000);

      expect(input.markStreamTimedOut).toHaveBeenCalledTimes(1);
      expect(input.timeoutMessage).toBe(
        "Ambient/Pi tool argument stream for write stalled after 30000ms without meaningful argument growth.",
      );
      expect(input.persistPiStreamTrace).toHaveBeenCalledWith(input.timeoutMessage);
      expect(input.abortSessionRun).toHaveBeenCalledTimes(1);
      expect(input.signalStreamWatchdogTimeout).toHaveBeenCalledTimes(1);
      expect(input.emitted).toContainEqual(expect.objectContaining({
        type: "runtime-activity",
        activity: expect.objectContaining({
          kind: "stream",
          status: "timeout",
          outputChars: 12,
          thinkingChars: 3,
          idleElapsedMs: 30_000,
          idleTimeoutMs: 30_000,
          diagnostic: expect.objectContaining({
            timeoutMode: "tool_argument_no_growth",
            toolCallId: "tool-call-1",
            toolName: "write",
            streamEventCount: 4,
            interruptedToolCallRecovery: recovered.interruptedToolCallRecovery,
            trace: expect.objectContaining({
              path: "/tmp/pi-stream-trace.jsonl",
            }),
          }),
        }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not schedule while permission wait or tool execution is active", () => {
    vi.useFakeTimers();
    try {
      let permissionWaiting = true;
      let toolExecutionActive = false;
      const input = baseInput({
        isPermissionWaiting: vi.fn(() => permissionWaiting),
        isToolExecutionActive: vi.fn(() => toolExecutionActive),
      });
      const watchdog = createRuntimeToolArgumentWatchdog(input);

      watchdog.schedule();
      vi.advanceTimersByTime(30_000);
      expect(input.abortSessionRun).not.toHaveBeenCalled();

      permissionWaiting = false;
      toolExecutionActive = true;
      watchdog.schedule();
      vi.advanceTimersByTime(30_000);
      expect(input.abortSessionRun).not.toHaveBeenCalled();

      toolExecutionActive = false;
      watchdog.schedule();
      vi.advanceTimersByTime(1_000);
      expect(input.abortSessionRun).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reschedules when the timer fires but no active argument is stalled yet", () => {
    vi.useFakeTimers();
    try {
      const input = baseInput();
      input.progress.nextActiveArgumentStallDelayMs
        .mockReturnValueOnce(1_000)
        .mockReturnValueOnce(500);
      input.progress.stalledActiveArgument
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(progressSnapshot());
      const watchdog = createRuntimeToolArgumentWatchdog(input);

      watchdog.schedule();
      vi.advanceTimersByTime(1_000);
      expect(input.abortSessionRun).not.toHaveBeenCalled();
      vi.advanceTimersByTime(500);

      expect(input.progress.nextActiveArgumentStallDelayMs).toHaveBeenCalledTimes(2);
      expect(input.abortSessionRun).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps partial tool arguments alive while raw transport activity continues", () => {
    vi.useFakeTimers();
    try {
      const input = baseInput();
      const watchdog = createRuntimeToolArgumentWatchdog(input);

      watchdog.schedule();
      vi.advanceTimersByTime(500);
      watchdog.refreshOnTransportActivity();
      vi.advanceTimersByTime(29_999);
      expect(input.abortSessionRun).not.toHaveBeenCalled();

      watchdog.refreshOnTransportActivity();
      vi.advanceTimersByTime(29_999);
      expect(input.abortSessionRun).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(input.abortSessionRun).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not schedule after a stream or tool-execution timeout has already won", () => {
    vi.useFakeTimers();
    try {
      const input = baseInput({
        isStreamTimedOut: vi.fn(() => true),
      });
      const watchdog = createRuntimeToolArgumentWatchdog(input);

      watchdog.schedule();
      vi.advanceTimersByTime(30_000);

      expect(input.progress.nextActiveArgumentStallDelayMs).not.toHaveBeenCalled();
      expect(input.abortSessionRun).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a scheduled stall timer", () => {
    vi.useFakeTimers();
    try {
      const input = baseInput();
      const watchdog = createRuntimeToolArgumentWatchdog(input);

      watchdog.schedule();
      watchdog.clear();
      vi.advanceTimersByTime(1_000);

      expect(input.abortSessionRun).not.toHaveBeenCalled();
      expect(input.signalStreamWatchdogTimeout).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
