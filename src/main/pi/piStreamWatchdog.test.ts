import { describe, expect, it, vi } from "vitest";
import { createPiStreamWatchdog } from "./piStreamWatchdog";

describe("createPiStreamWatchdog", () => {
  it("fires after a full idle window with no reset", () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      createPiStreamWatchdog({ idleTimeoutMs: 1000, onTimeout });

      vi.advanceTimersByTime(999);
      expect(onTimeout).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onTimeout).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the idle window when stream activity arrives", () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const watchdog = createPiStreamWatchdog({ idleTimeoutMs: 1000, onTimeout });

      vi.advanceTimersByTime(800);
      watchdog.reset();
      vi.advanceTimersByTime(800);
      expect(onTimeout).not.toHaveBeenCalled();
      vi.advanceTimersByTime(200);
      expect(onTimeout).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a separate pre-stream timeout until the first stream activity", () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const watchdog = createPiStreamWatchdog({ preStreamTimeoutMs: 2000, idleTimeoutMs: 1000, onTimeout });

      vi.advanceTimersByTime(1500);
      expect(onTimeout).not.toHaveBeenCalled();
      watchdog.reset();
      vi.advanceTimersByTime(999);
      expect(onTimeout).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onTimeout).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("can extend the pre-stream window before transport activity starts", () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const watchdog = createPiStreamWatchdog({ preStreamTimeoutMs: 1000, idleTimeoutMs: 500, onTimeout });

      vi.advanceTimersByTime(800);
      watchdog.resetPreStream(2000);
      vi.advanceTimersByTime(1999);
      expect(onTimeout).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onTimeout).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes the active pre-stream window rather than switching to idle", () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const watchdog = createPiStreamWatchdog({ preStreamTimeoutMs: 2000, idleTimeoutMs: 500, onTimeout });

      watchdog.pause();
      watchdog.resume();
      vi.advanceTimersByTime(1999);
      expect(onTimeout).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onTimeout).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire after stop", () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const watchdog = createPiStreamWatchdog({ idleTimeoutMs: 1000, onTimeout });

      watchdog.stop();
      vi.advanceTimersByTime(1000);
      expect(onTimeout).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses and resumes the idle window", () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const watchdog = createPiStreamWatchdog({ idleTimeoutMs: 1000, onTimeout });

      vi.advanceTimersByTime(800);
      watchdog.pause();
      vi.advanceTimersByTime(5_000);
      expect(onTimeout).not.toHaveBeenCalled();

      watchdog.resume();
      vi.advanceTimersByTime(999);
      expect(onTimeout).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onTimeout).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the idle window paused until nested pauses are fully resumed", () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const watchdog = createPiStreamWatchdog({ idleTimeoutMs: 1000, onTimeout });

      watchdog.pause();
      watchdog.pause();
      vi.advanceTimersByTime(2_000);
      watchdog.resume();
      vi.advanceTimersByTime(2_000);
      expect(onTimeout).not.toHaveBeenCalled();

      watchdog.resume();
      vi.advanceTimersByTime(1_000);
      expect(onTimeout).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("can unblock a runtime race when aborting the provider stream does not settle the prompt", async () => {
    vi.useFakeTimers();
    let watchdog: ReturnType<typeof createPiStreamWatchdog> | undefined;
    try {
      let resolveTimeout: ((value: "stream-timeout") => void) | undefined;
      const timeoutCompletion = new Promise<"stream-timeout">((resolve) => {
        resolveTimeout = resolve;
      });
      const neverSettles = new Promise<"prompt">(() => undefined);
      watchdog = createPiStreamWatchdog({
        idleTimeoutMs: 1000,
        onTimeout: () => resolveTimeout?.("stream-timeout"),
      });
      const race = Promise.race([neverSettles, timeoutCompletion]);

      vi.advanceTimersByTime(1000);
      await expect(race).resolves.toBe("stream-timeout");
    } finally {
      watchdog?.stop();
      vi.useRealTimers();
    }
  });
});
