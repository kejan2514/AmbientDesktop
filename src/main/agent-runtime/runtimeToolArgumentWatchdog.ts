import type { DesktopEvent } from "../../shared/desktopTypes";
import type { ToolArgumentProgressSnapshot } from "../../shared/threadTypes";
import type { PiStreamTraceReference } from "./provider-continuation/agentRuntimeProviderDiagnostics";

export interface RuntimeToolArgumentProgressSource {
  nextActiveArgumentStallDelayMs(timeoutMs: number): number | undefined;
  stalledActiveArgument(timeoutMs: number): ToolArgumentProgressSnapshot | undefined;
}

export interface RuntimeToolArgumentWatchdogState {
  outputChars: number;
  thinkingChars: number;
  streamEventCount: number;
}

export interface RuntimeToolArgumentWatchdogInput {
  threadId: string;
  idleTimeoutMs: number;
  progress: RuntimeToolArgumentProgressSource;
  isRunStoreActive: () => boolean;
  isPermissionWaiting: () => boolean;
  isToolExecutionActive: () => boolean;
  isStreamTimedOut: () => boolean;
  isToolExecutionTimedOut: () => boolean;
  markStreamTimedOut: () => void;
  setStreamTimeoutMessage: (message: string) => void;
  forceInterruptedToolCallRecovery: (snapshot: ToolArgumentProgressSnapshot) => ToolArgumentProgressSnapshot;
  persistPiStreamTrace: (message: string) => PiStreamTraceReference | undefined;
  getState: () => RuntimeToolArgumentWatchdogState;
  abortSessionRun: () => void;
  signalStreamWatchdogTimeout: () => void;
  emitRunEvent: (event: DesktopEvent) => void;
  setTimeout?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface RuntimeToolArgumentWatchdog {
  clear: () => void;
  schedule: () => void;
  refreshOnTransportActivity: () => void;
}

export function createRuntimeToolArgumentWatchdog(
  input: RuntimeToolArgumentWatchdogInput,
): RuntimeToolArgumentWatchdog {
  const scheduleTimeout = input.setTimeout ?? setTimeout;
  const clearScheduledTimeout = input.clearTimeout ?? clearTimeout;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const timeoutMessage = (snapshot: ToolArgumentProgressSnapshot): string =>
    `Ambient/Pi tool argument stream for ${snapshot.toolName} stalled after ${input.idleTimeoutMs}ms without meaningful argument growth.`;

  const clear = () => {
    if (idleTimer) clearScheduledTimeout(idleTimer);
    idleTimer = undefined;
  };

  const signalTimeout = (snapshot: ToolArgumentProgressSnapshot) => {
    if (!input.isRunStoreActive() || input.isStreamTimedOut() || input.isToolExecutionTimedOut()) return;
    const progressWithRecovery = input.forceInterruptedToolCallRecovery(snapshot);
    const idleElapsedMs = progressWithRecovery.lastMeaningfulGrowthMsAgo ?? progressWithRecovery.argumentElapsedMs;
    input.markStreamTimedOut();
    const message = timeoutMessage(progressWithRecovery);
    input.setStreamTimeoutMessage(message);
    const trace = input.persistPiStreamTrace(message);
    clear();
    const state = input.getState();
    input.emitRunEvent({
      type: "runtime-activity",
      activity: {
        threadId: input.threadId,
        kind: "stream",
        status: "timeout",
        outputChars: state.outputChars,
        thinkingChars: state.thinkingChars,
        idleElapsedMs,
        idleTimeoutMs: input.idleTimeoutMs,
        message,
        diagnostic: {
          timeoutMode: "tool_argument_no_growth",
          toolCallId: progressWithRecovery.toolCallId,
          toolName: progressWithRecovery.toolName,
          observedArgumentChars: progressWithRecovery.observedArgumentChars,
          inputChars: progressWithRecovery.inputChars,
          argumentElapsedMs: progressWithRecovery.argumentElapsedMs,
          lastMeaningfulGrowthMsAgo: progressWithRecovery.lastMeaningfulGrowthMsAgo,
          interruptedToolCallRecovery: progressWithRecovery.interruptedToolCallRecovery,
          streamEventCount: state.streamEventCount,
          ...(trace ? { trace } : {}),
        },
      },
    });
    input.abortSessionRun();
    input.signalStreamWatchdogTimeout();
  };

  const checkForStall = () => {
    idleTimer = undefined;
    if (!input.isRunStoreActive() || input.isPermissionWaiting() || input.isToolExecutionActive()) {
      schedule();
      return;
    }
    const stalled = input.progress.stalledActiveArgument(input.idleTimeoutMs);
    if (!stalled) {
      schedule();
      return;
    }
    signalTimeout(stalled);
  };

  const schedule = () => {
    clear();
    if (
      input.isPermissionWaiting() ||
      input.isToolExecutionActive() ||
      input.isStreamTimedOut() ||
      input.isToolExecutionTimedOut()
    ) {
      return;
    }
    const delayMs = input.progress.nextActiveArgumentStallDelayMs(input.idleTimeoutMs);
    if (delayMs === undefined) return;
    idleTimer = scheduleTimeout(checkForStall, delayMs);
  };

  const refreshOnTransportActivity = () => {
    if (!idleTimer) return;
    clear();
    idleTimer = scheduleTimeout(checkForStall, input.idleTimeoutMs);
  };

  return {
    clear,
    schedule,
    refreshOnTransportActivity,
  };
}
