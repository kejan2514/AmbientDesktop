import type { DesktopEvent } from "../../shared/desktopTypes";
import type { PiStreamTraceReference } from "./provider-continuation/agentRuntimeProviderDiagnostics";
import { runtimePiStreamTimeoutActivity } from "../agent-runtime/agentRuntimeStreamState";
import { piStreamStallTimeoutMessage, piStreamStartTimeoutMessage } from "../agent-runtime/agentRuntimeTimeouts";
import { createPiStreamWatchdog, type PiStreamWatchdog } from "./agentRuntimePiFacade";

export interface RuntimeStreamWatchdogState {
  outputChars: number;
  thinkingChars: number;
  streamEventCount: number;
}

export interface RuntimeStreamWatchdogControllerInput {
  threadId: string;
  preStreamTimeoutMs: number;
  idleTimeoutMs: number;
  isRunStoreActive: () => boolean;
  shouldPauseForExternalActivity: () => boolean;
  markStreamTimedOut: () => void;
  setStreamTimeoutMessage: (message: string) => void;
  persistPiStreamTrace: (message: string) => PiStreamTraceReference | undefined;
  getState: () => RuntimeStreamWatchdogState;
  abortSessionRun: () => void;
  signalStreamWatchdogTimeout: () => void;
  emitRunEvent: (event: DesktopEvent) => void;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export interface RuntimeStreamWatchdogController {
  pause: () => void;
  resume: () => void;
  reset: () => void;
  markTransportActivity: () => void;
  setPreStreamTimeoutMs: (timeoutMs: number) => void;
  stop: () => void;
  pauseIfNeeded: () => void;
}

export function createRuntimeStreamWatchdogController(
  input: RuntimeStreamWatchdogControllerInput,
): RuntimeStreamWatchdogController {
  let transportStarted = false;
  let preStreamTimeoutMs = input.preStreamTimeoutMs;

  const handleTimeout = () => {
    if (!input.isRunStoreActive()) return;
    if (input.shouldPauseForExternalActivity()) {
      watchdog.pause();
      return;
    }
    const state = input.getState();
    const timeoutMs = transportStarted ? input.idleTimeoutMs : preStreamTimeoutMs;
    const message = transportStarted
      ? piStreamStallTimeoutMessage(input.idleTimeoutMs)
      : piStreamStartTimeoutMessage(preStreamTimeoutMs);
    input.markStreamTimedOut();
    input.setStreamTimeoutMessage(message);
    const trace = input.persistPiStreamTrace(message);
    input.emitRunEvent({
      type: "runtime-activity",
      activity: runtimePiStreamTimeoutActivity({
        threadId: input.threadId,
        outputChars: state.outputChars,
        thinkingChars: state.thinkingChars,
        timeoutMs,
        message,
        ...(trace ? { trace } : {}),
      }),
    });
    input.abortSessionRun();
    input.signalStreamWatchdogTimeout();
  };

  const watchdog: PiStreamWatchdog = createPiStreamWatchdog({
    preStreamTimeoutMs: input.preStreamTimeoutMs,
    idleTimeoutMs: input.idleTimeoutMs,
    onTimeout: handleTimeout,
    setTimeoutImpl: input.setTimeout,
    clearTimeoutImpl: input.clearTimeout,
  });

  return {
    pause: () => watchdog.pause(),
    resume: () => watchdog.resume(),
    reset: () => {
      transportStarted = true;
      watchdog.reset();
    },
    markTransportActivity: () => {
      transportStarted = true;
      watchdog.reset();
    },
    setPreStreamTimeoutMs: (timeoutMs) => {
      if (transportStarted) return;
      preStreamTimeoutMs = Math.max(1, Math.floor(timeoutMs));
      watchdog.resetPreStream(preStreamTimeoutMs);
    },
    stop: () => watchdog.stop(),
    pauseIfNeeded: () => {
      if (input.shouldPauseForExternalActivity()) watchdog.pause();
    },
  };
}
