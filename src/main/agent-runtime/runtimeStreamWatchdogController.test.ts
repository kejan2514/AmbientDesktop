import { describe, expect, it, vi } from "vitest";
import type { DesktopEvent } from "../../shared/desktopTypes";
import {
  createRuntimeStreamWatchdogController,
  type RuntimeStreamWatchdogState,
} from "./runtimeStreamWatchdogController";

function baseInput(overrides: Record<string, unknown> = {}) {
  const emitted: DesktopEvent[] = [];
  let timeoutMessage: string | undefined;
  const state: RuntimeStreamWatchdogState = {
    outputChars: 0,
    thinkingChars: 0,
    streamEventCount: 0,
  };
  return {
    threadId: "thread-1",
    preStreamTimeoutMs: 1_500,
    idleTimeoutMs: 1_000,
    isRunStoreActive: vi.fn(() => true),
    shouldPauseForExternalActivity: vi.fn(() => false),
    markStreamTimedOut: vi.fn(),
    setStreamTimeoutMessage: vi.fn((message: string) => {
      timeoutMessage = message;
    }),
    persistPiStreamTrace: vi.fn(() => ({
      path: "/tmp/pi-stream-trace.jsonl",
      eventCount: state.streamEventCount,
      recentEventCount: state.streamEventCount,
      reason: "timeout",
      recordedAt: "2026-06-15T00:00:30.000Z",
    })),
    getState: vi.fn(() => state),
    abortSessionRun: vi.fn(),
    signalStreamWatchdogTimeout: vi.fn(),
    emitRunEvent: vi.fn((event: DesktopEvent) => {
      emitted.push(event);
    }),
    emitted,
    state,
    get timeoutMessage() {
      return timeoutMessage;
    },
    ...overrides,
  };
}

describe("createRuntimeStreamWatchdogController", () => {
  it("emits a pre-stream timeout activity, persists a trace, aborts, and signals completion", () => {
    vi.useFakeTimers();
    try {
      const input = baseInput();
      const watchdog = createRuntimeStreamWatchdogController(input);

      vi.advanceTimersByTime(1_500);

      expect(input.markStreamTimedOut).toHaveBeenCalledTimes(1);
      expect(input.timeoutMessage).toBe("Ambient/Pi did not start streaming within 1500ms.");
      expect(input.persistPiStreamTrace).toHaveBeenCalledWith(input.timeoutMessage);
      expect(input.abortSessionRun).toHaveBeenCalledTimes(1);
      expect(input.signalStreamWatchdogTimeout).toHaveBeenCalledTimes(1);
      expect(input.emitted).toContainEqual(expect.objectContaining({
        type: "runtime-activity",
        activity: expect.objectContaining({
          kind: "stream",
          status: "timeout",
          outputChars: 0,
          thinkingChars: 0,
          idleElapsedMs: 1_500,
          idleTimeoutMs: 1_500,
          message: "Ambient/Pi did not start streaming within 1500ms.",
          diagnostic: expect.objectContaining({
            trace: expect.objectContaining({
              path: "/tmp/pi-stream-trace.jsonl",
            }),
          }),
        }),
      }));
      watchdog.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits an idle stream timeout after stream activity resets the watchdog", () => {
    vi.useFakeTimers();
    try {
      const input = baseInput();
      const watchdog = createRuntimeStreamWatchdogController(input);

      vi.advanceTimersByTime(500);
      input.state.outputChars = 12;
      input.state.thinkingChars = 4;
      input.state.streamEventCount = 3;
      watchdog.reset();
      vi.advanceTimersByTime(1_000);

      expect(input.timeoutMessage).toBe("Ambient/Pi stream stalled after 1000ms without stream activity.");
      expect(input.abortSessionRun).toHaveBeenCalledTimes(1);
      expect(input.signalStreamWatchdogTimeout).toHaveBeenCalledTimes(1);
      expect(input.emitted).toContainEqual(expect.objectContaining({
        type: "runtime-activity",
        activity: expect.objectContaining({
          kind: "stream",
          status: "timeout",
          outputChars: 12,
          thinkingChars: 4,
          idleElapsedMs: 1_000,
          idleTimeoutMs: 1_000,
          message: "Ambient/Pi stream stalled after 1000ms without stream activity.",
        }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats raw transport activity as liveness without inventing semantic events", () => {
    vi.useFakeTimers();
    try {
      const input = baseInput();
      const watchdog = createRuntimeStreamWatchdogController(input);

      vi.advanceTimersByTime(1_400);
      watchdog.markTransportActivity();
      expect(input.state.streamEventCount).toBe(0);
      vi.advanceTimersByTime(999);
      expect(input.abortSessionRun).not.toHaveBeenCalled();
      watchdog.markTransportActivity();
      vi.advanceTimersByTime(1_000);

      expect(input.timeoutMessage).toBe("Ambient/Pi stream stalled after 1000ms without stream activity.");
      expect(input.abortSessionRun).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses an adaptive pre-stream deadline until response transport begins", () => {
    vi.useFakeTimers();
    try {
      const input = baseInput();
      const watchdog = createRuntimeStreamWatchdogController(input);

      watchdog.setPreStreamTimeoutMs(3_000);
      vi.advanceTimersByTime(2_999);
      expect(input.abortSessionRun).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);

      expect(input.timeoutMessage).toBe("Ambient/Pi did not start streaming within 3000ms.");
      expect(input.abortSessionRun).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses instead of timing out while permission or tool activity is active", () => {
    vi.useFakeTimers();
    try {
      let externalActivity = true;
      const input = baseInput({
        shouldPauseForExternalActivity: vi.fn(() => externalActivity),
      });
      const watchdog = createRuntimeStreamWatchdogController(input);

      vi.advanceTimersByTime(1_500);
      expect(input.abortSessionRun).not.toHaveBeenCalled();
      expect(input.signalStreamWatchdogTimeout).not.toHaveBeenCalled();

      externalActivity = false;
      input.state.streamEventCount = 1;
      watchdog.reset();
      watchdog.resume();
      vi.advanceTimersByTime(1_000);

      expect(input.timeoutMessage).toBe("Ambient/Pi stream stalled after 1000ms without stream activity.");
      expect(input.abortSessionRun).toHaveBeenCalledTimes(1);
      expect(input.signalStreamWatchdogTimeout).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("can be paused immediately when an external wait is already active", () => {
    vi.useFakeTimers();
    try {
      let externalActivity = true;
      const input = baseInput({
        shouldPauseForExternalActivity: vi.fn(() => externalActivity),
      });
      const watchdog = createRuntimeStreamWatchdogController(input);

      watchdog.pauseIfNeeded();
      vi.advanceTimersByTime(5_000);
      expect(input.abortSessionRun).not.toHaveBeenCalled();

      externalActivity = false;
      watchdog.resume();
      vi.advanceTimersByTime(1_500);
      expect(input.abortSessionRun).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
