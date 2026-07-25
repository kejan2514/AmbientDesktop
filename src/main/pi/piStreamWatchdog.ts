export interface PiStreamWatchdog {
  reset(): void;
  resetPreStream(timeoutMs: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
}

export function createPiStreamWatchdog(input: {
  idleTimeoutMs: number;
  preStreamTimeoutMs?: number;
  onTimeout: () => void;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}): PiStreamWatchdog {
  const setTimeoutImpl = input.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = input.clearTimeoutImpl ?? clearTimeout;
  const idleTimeoutMs = Math.max(1, Math.floor(input.idleTimeoutMs));
  const preStreamTimeoutMs = Math.max(1, Math.floor(input.preStreamTimeoutMs ?? idleTimeoutMs));
  let stopped = false;
  let pauseDepth = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let currentTimeoutMs = preStreamTimeoutMs;

  const schedule = (timeoutMs: number) => {
    currentTimeoutMs = timeoutMs;
    if (stopped || pauseDepth > 0) return;
    if (timer) clearTimeoutImpl(timer);
    timer = setTimeoutImpl(() => {
      timer = undefined;
      if (!stopped && pauseDepth === 0) input.onTimeout();
    }, timeoutMs);
  };

  const clear = () => {
    if (timer) clearTimeoutImpl(timer);
    timer = undefined;
  };

  schedule(preStreamTimeoutMs);

  return {
    reset() {
      if (stopped) return;
      schedule(idleTimeoutMs);
    },
    resetPreStream(timeoutMs) {
      if (stopped) return;
      schedule(Math.max(1, Math.floor(timeoutMs)));
    },
    pause() {
      if (stopped) return;
      pauseDepth += 1;
      clear();
    },
    resume() {
      if (stopped || pauseDepth === 0) return;
      pauseDepth -= 1;
      if (pauseDepth === 0) schedule(currentTimeoutMs);
    },
    stop() {
      stopped = true;
      pauseDepth = 0;
      clear();
    },
  };
}
