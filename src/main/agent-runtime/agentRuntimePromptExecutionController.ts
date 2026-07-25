import type { DesktopEvent } from "../../shared/desktopTypes";
import type { ThreadSummary } from "../../shared/threadTypes";
import type { RuntimePromptExecutionSession } from "./runtimePromptExecutionController";
import {
  createRuntimePromptControllerSetup,
  type RuntimePromptControllerSetupInput,
} from "./runtimePromptControllerSetup";
import type { RuntimePromptControlState } from "./runtimePromptControlState";
import {
  runRuntimePromptCompletionSetup,
  type RuntimePromptCompletionSetupInput,
} from "./runtimePromptCompletionSetup";
import type { RuntimePromptLifecycleControls } from "./runtimePromptLifecycleControls";
import type { RuntimePromptRunState } from "./runtimePromptRunState";
import {
  createRuntimePromptExecutionSetup,
} from "./runtimePromptExecutionSetup";
import {
  subscribeRuntimePromptEvents,
  type RuntimePromptEventSubscriptionInput,
} from "./runtimePromptEventSubscription";
import {
  createRuntimePromptStreamDispatcherSetup,
  type RuntimePromptStreamDispatcherSetupInput,
} from "./runtimePromptStreamDispatcherSetup";
import type { RuntimeProviderRetryState } from "./runtimeProviderRetryState";
import type { RuntimeQueuedMessageController } from "./runtimeQueuedMessageController";
import type { RuntimeStreamActivityTracker } from "./runtimeStreamActivityTracker";
import type { RuntimeStreamTraceState } from "./runtimeStreamTraceState";
import type { RuntimeStreamWatchdogController } from "./runtimeStreamWatchdogController";
import type { RuntimeTextOutputState } from "./runtimeTextOutputState";
import type { RuntimeAssistantTerminalCompletion } from "./runtimeAssistantTerminalCompletion";
import type { RuntimeEmptyAssistantStallWatchdog } from "./runtimeEmptyAssistantStallWatchdog";
import type { RuntimeToolArgumentWatchdog } from "./runtimeToolArgumentWatchdog";
import {
  createRuntimeToolEventDispatcherSetup,
  type RuntimeToolEventDispatcherSetupInput,
} from "./runtimeToolEventDispatcherSetup";
import type { RuntimeToolExecutionWatchdog } from "./runtimeToolExecutionWatchdog";
import type { RuntimeToolMessageController } from "./runtimeToolMessageController";
import type { RuntimePermissionWaitController } from "./runtimePermissionWaitController";
import type { RuntimeOpenToolFailureReason } from "./openToolFailureUpdates";
import { subscribeAmbientProviderTransportActivity } from "../ambient/ambientProviderTransportActivity";
import { resolveAdaptivePiPreStreamTimeoutMs } from "./agentRuntimeTimeouts";

export interface AgentRuntimePromptExecutionSession extends RuntimePromptExecutionSession {
  steer(prompt: string): Promise<unknown>;
  subscribe(handler: (event: unknown) => void): () => void;
}

export interface AgentRuntimePromptExecutionControllerOptions<
  Session extends AgentRuntimePromptExecutionSession,
> {
  preflightBeforePrompt: (input: {
    thread: ThreadSummary;
    session: Session;
    promptContent: string;
    setActiveRunStatus: RuntimePromptLifecycleControls["setActiveRunStatus"];
    isRunStoreActive: () => boolean;
    emitRunEvent: (event: DesktopEvent) => void;
  }) => Promise<void>;
  abortSessionRun: (session: Session, threadId: string) => Promise<void>;
  removeActiveSessionIfCurrent: (threadId: string, session: Session) => void;
  recordContextUsageSnapshot: (threadId: string, session: Session, message?: string) => unknown;
  refreshBrowsersForArtifactChange: (
    threadId: string,
    workspacePath: string,
    artifactPath: string,
  ) => unknown;
  createPromptControllerSetup?: typeof createRuntimePromptControllerSetup;
  createPromptStreamDispatcherSetup?: typeof createRuntimePromptStreamDispatcherSetup;
  createToolEventDispatcherSetup?: typeof createRuntimeToolEventDispatcherSetup;
  subscribePromptEvents?: typeof subscribeRuntimePromptEvents;
  createPromptExecutionSetup?: typeof createRuntimePromptExecutionSetup;
  runPromptCompletionSetup?: (
    input: RuntimePromptCompletionSetupInput<Session>,
  ) => Promise<{ finalizedAfterToolIdle: boolean }>;
}

export interface RunAgentRuntimePromptExecutionInput<Session extends AgentRuntimePromptExecutionSession> {
  thread: ThreadSummary;
  runId: string;
  session: Session;
  promptContent: string;
  images: unknown[];
  preStreamTimeoutMs: number;
  streamIdleTimeoutMs: number;
  defaultToolExecutionIdleTimeoutMs: number;
  emptyAssistantStallTimeoutMs: number;
  assistantTerminalGraceMs: number;
  postToolContinuationIdleMs: number;
  postToolFinalizationIdleMs: number;
  postToolFinalizationTickMs: number;
  abortGraceMs: number;
  assistantFinalizationRetryMaxRetries: number;
  isRunStoreActive: () => boolean;
  permissionWaits: Pick<RuntimePermissionWaitController, "isWaiting">;
  promptControlState: RuntimePromptControlState;
  promptLifecycleControls: RuntimePromptLifecycleControls;
  streamTimeoutMessage: () => string;
  persistPiStreamTrace: RuntimePromptControllerSetupInput["persistPiStreamTrace"];
  toolArgumentProgress: RuntimeToolEventDispatcherSetupInput["toolArgumentProgress"] &
    RuntimePromptControllerSetupInput["toolArgumentProgress"];
  forceInterruptedToolCallRecovery: RuntimePromptControllerSetupInput["forceInterruptedToolCallRecovery"];
  outputState: RuntimeTextOutputState;
  runtimeMessages: RuntimePromptStreamDispatcherSetupInput["runtimeMessages"];
  getMessages: RuntimePromptControllerSetupInput["getMessages"];
  queuedMessages: Pick<RuntimeQueuedMessageController, "flushPending" | "reconcileQueueUpdate">;
  streamActivity: RuntimeStreamActivityTracker;
  streamTraceState: RuntimeStreamTraceState;
  providerRetryState: RuntimeProviderRetryState;
  toolMessages: RuntimeToolMessageController;
  toolRecovery: RuntimeToolEventDispatcherSetupInput["toolRecovery"];
  startedToolCallIds: Set<string>;
  markRunActivity: () => boolean;
  recordPiStreamTraceEvent: RuntimePromptEventSubscriptionInput["recordPiStreamTraceEvent"];
  requestSubagentParentControlAbort: RuntimeToolEventDispatcherSetupInput["requestSubagentParentControlAbort"];
  setStreamWatchdog: (watchdog: RuntimeStreamWatchdogController) => void;
  setToolExecutionWatchdog: (watchdog: RuntimeToolExecutionWatchdog) => void;
  setToolArgumentWatchdog: (watchdog: RuntimeToolArgumentWatchdog) => void;
  setEmptyAssistantStallWatchdog: (watchdog: RuntimeEmptyAssistantStallWatchdog) => void;
  setAssistantTerminalCompletion: (completion: RuntimeAssistantTerminalCompletion) => void;
  setMarkOpenToolMessagesFailed: (handler: (reason: RuntimeOpenToolFailureReason) => void) => void;
  emitRunEvent: (event: DesktopEvent) => void;
}

export interface RunAgentRuntimePromptExecutionResult {
  completed: boolean;
  promptRunState: RuntimePromptRunState;
}

export class AgentRuntimePromptExecutionController<
  Session extends AgentRuntimePromptExecutionSession,
> {
  constructor(
    private readonly options: AgentRuntimePromptExecutionControllerOptions<Session>,
  ) {}

  async runPrompt(input: RunAgentRuntimePromptExecutionInput<Session>): Promise<RunAgentRuntimePromptExecutionResult> {
    let streamWatchdog: RuntimeStreamWatchdogController | undefined;
    let pendingPreStreamTimeoutMs: number | undefined;
    let pendingTransportActivity = false;
    let finalizeAssistantTerminalRun: (pendingCompletion?: Promise<unknown>) => Promise<void> = async () => {
      throw new Error("Assistant terminal finalization requested before prompt start.");
    };
    const promptControllers = (this.options.createPromptControllerSetup ?? createRuntimePromptControllerSetup)({
      threadId: input.thread.id,
      runId: input.runId,
      defaultToolExecutionIdleTimeoutMs: input.defaultToolExecutionIdleTimeoutMs,
      toolArgumentIdleTimeoutMs: input.streamIdleTimeoutMs,
      emptyAssistantStallTimeoutMs: input.emptyAssistantStallTimeoutMs,
      assistantTerminalGraceMs: input.assistantTerminalGraceMs,
      postToolContinuationIdleMs: input.postToolContinuationIdleMs,
      postToolFinalizationIdleMs: input.postToolFinalizationIdleMs,
      postToolFinalizationTickMs: input.postToolFinalizationTickMs,
      assistantFinalizationRetryMaxRetries: input.assistantFinalizationRetryMaxRetries,
      isRunStoreActive: input.isRunStoreActive,
      isPermissionWaiting: () => input.permissionWaits.isWaiting(),
      pauseStreamWatchdog: () => {
        streamWatchdog?.pause();
      },
      resumeStreamWatchdog: () => {
        streamWatchdog?.resume();
      },
      resetStreamWatchdog: () => {
        streamWatchdog?.reset();
      },
      abortSessionRun: () => {
        void this.options.abortSessionRun(input.session, input.thread.id).catch(() => undefined);
      },
      signalToolExecutionTimeout: input.promptLifecycleControls.signalToolExecutionTimeout,
      signalStreamWatchdogTimeout: input.promptLifecycleControls.signalStreamWatchdogTimeout,
      streamWatchdogCompletion: input.promptLifecycleControls.streamWatchdogCompletion,
      isStreamTimedOut: input.promptControlState.isStreamTimedOut,
      markStreamTimedOut: input.promptControlState.markStreamTimedOut,
      setStreamTimeoutMessage: input.promptControlState.setStreamWatchdogTimeoutMessage,
      streamTimeoutMessage: input.streamTimeoutMessage,
      persistPiStreamTrace: input.persistPiStreamTrace,
      toolArgumentProgress: input.toolArgumentProgress,
      forceInterruptedToolCallRecovery: input.forceInterruptedToolCallRecovery,
      getOutputChars: input.outputState.assistantOutputChars,
      getThinkingChars: input.outputState.thinkingOutputChars,
      hasAssistantText: input.outputState.hasAssistantText,
      getAssistantStartCount: input.runtimeMessages.assistantStartCount,
      getReceivedAnyText: input.outputState.receivedAnyText,
      getCurrentAssistantReceivedText: input.outputState.currentAssistantReceivedText,
      getCurrentAssistantFinalText: input.outputState.currentAssistantFinalText,
      getStreamEventCount: () => input.streamActivity.snapshot().eventCount,
      getSessionFile: () => input.session.sessionFile,
      getMessages: input.getMessages,
      getRunEventSeq: input.promptControlState.runEventSeq,
      steerContinuation: (prompt) => input.session.steer(prompt),
      finalizeAssistantTerminalRun: (pendingCompletion) => finalizeAssistantTerminalRun(pendingCompletion),
      emitRunEvent: input.emitRunEvent,
    } satisfies RuntimePromptControllerSetupInput);

    input.setToolExecutionWatchdog(promptControllers.toolExecutionWatchdog);
    input.setToolArgumentWatchdog(promptControllers.toolArgumentWatchdog);
    input.setEmptyAssistantStallWatchdog(promptControllers.emptyAssistantStallWatchdog);
    input.setAssistantTerminalCompletion(promptControllers.assistantTerminalCompletion);
    await this.options.preflightBeforePrompt({
      thread: input.thread,
      session: input.session,
      promptContent: input.promptContent,
      setActiveRunStatus: input.promptLifecycleControls.setActiveRunStatus,
      isRunStoreActive: input.isRunStoreActive,
      emitRunEvent: input.emitRunEvent,
    });
    if (!input.isRunStoreActive()) {
      return { completed: false, promptRunState: promptControllers.promptRunState };
    }

    const markPiStreamActivity = (forceProgress = false, event?: unknown) => {
      input.streamActivity.markActivity(forceProgress, event);
    };
    const streamEventDispatcher = (
      this.options.createPromptStreamDispatcherSetup ?? createRuntimePromptStreamDispatcherSetup
    )({
      threadId: input.thread.id,
      assistantTerminalGraceMs: input.assistantTerminalGraceMs,
      outputState: input.outputState,
      promptRunState: promptControllers.promptRunState,
      providerRetryState: input.providerRetryState,
      runtimeMessages: input.runtimeMessages,
      emptyAssistantStallWatchdog: promptControllers.emptyAssistantStallWatchdog,
      assistantTerminalCompletion: promptControllers.assistantTerminalCompletion,
      postToolContinuation: promptControllers.postToolContinuation,
      toolMessages: input.toolMessages,
      markPiStreamActivity: () => markPiStreamActivity(),
      setActiveRunStatus: input.promptLifecycleControls.setActiveRunStatus,
      reconcileQueueUpdate: input.queuedMessages.reconcileQueueUpdate,
      recordContextUsageSnapshot: (snapshotMessage) => {
        this.options.recordContextUsageSnapshot(input.thread.id, input.session, snapshotMessage);
      },
      emitRunEvent: input.emitRunEvent,
    } satisfies RuntimePromptStreamDispatcherSetupInput);
    input.setMarkOpenToolMessagesFailed((reason) => {
      if (input.toolMessages.markOpenToolMessagesFailed(reason) > 0) {
        input.toolRecovery.persistToolArgumentDiagnostics(true);
      }
    });
    const toolEventDispatcher = (
      this.options.createToolEventDispatcherSetup ?? createRuntimeToolEventDispatcherSetup
    )({
      threadId: input.thread.id,
      runId: input.runId,
      workspacePath: input.thread.workspacePath,
      permissionMode: input.thread.permissionMode,
      toolMessages: input.toolMessages,
      runtimeMessages: input.runtimeMessages,
      outputState: input.outputState,
      toolArgumentProgress: input.toolArgumentProgress,
      toolArgumentWatchdog: promptControllers.toolArgumentWatchdog,
      toolExecutionWatchdog: promptControllers.toolExecutionWatchdog,
      postToolContinuation: promptControllers.postToolContinuation,
      startedToolCallIds: input.startedToolCallIds,
      emptyAssistantStallWatchdog: promptControllers.emptyAssistantStallWatchdog,
      assistantTerminalCompletion: promptControllers.assistantTerminalCompletion,
      streamTraceState: input.streamTraceState,
      toolRecovery: input.toolRecovery,
      promptLifecycleControls: input.promptLifecycleControls,
      promptRunState: promptControllers.promptRunState,
      requestSubagentParentControlAbort: input.requestSubagentParentControlAbort,
      refreshBrowsersForArtifactChange: (threadId, workspacePath, artifactPath) =>
        this.options.refreshBrowsersForArtifactChange(threadId, workspacePath, artifactPath),
    } satisfies RuntimeToolEventDispatcherSetupInput);

    const unsubscribe = (this.options.subscribePromptEvents ?? subscribeRuntimePromptEvents)({
      subscribe: (handler) => input.session.subscribe(handler),
      markRunActivity: input.markRunActivity,
      incrementRunEventSeq: input.promptControlState.incrementRunEventSeq,
      markPostToolEvent: promptControllers.postToolContinuation.markEvent,
      recordPiStreamTraceEvent: input.recordPiStreamTraceEvent,
      markPiStreamActivity,
      streamEventDispatcher,
      toolEventDispatcher,
    });

    const unsubscribeProviderTransport = subscribeAmbientProviderTransportActivity(input.session, (activity) => {
      if (activity.kind === "request_prepared") {
        const timeoutMs = resolveAdaptivePiPreStreamTimeoutMs({
          configuredTimeoutMs: input.preStreamTimeoutMs,
          inputTokens: activity.inputTokens,
          thinkingLevel: input.thread.thinkingLevel,
        });
        if (streamWatchdog) streamWatchdog.setPreStreamTimeoutMs(timeoutMs);
        else pendingPreStreamTimeoutMs = timeoutMs;
        return;
      }
      promptControllers.emptyAssistantStallWatchdog.refreshOnStreamActivity();
      promptControllers.toolArgumentWatchdog.refreshOnTransportActivity();
      if (streamWatchdog) streamWatchdog.markTransportActivity();
      else pendingTransportActivity = true;
    });

    const promptExecution = (this.options.createPromptExecutionSetup ?? createRuntimePromptExecutionSetup)({
      threadId: input.thread.id,
      session: input.session,
      promptContent: input.promptContent,
      images: input.images,
      promptControlState: input.promptControlState,
      streamTimeoutMessage: input.streamTimeoutMessage,
      streamTraceState: input.streamTraceState,
      assistantTerminalCompletion: promptControllers.assistantTerminalCompletion,
      outputState: input.outputState,
      streamIdleTimeoutMs: input.streamIdleTimeoutMs,
      abortGraceMs: input.abortGraceMs,
      promptRunState: promptControllers.promptRunState,
      abortSessionRun: (cleanupSession, threadId) =>
        this.options.abortSessionRun(cleanupSession as Session, threadId),
      removeActiveSessionIfCurrent: (cleanupSession) => {
        this.options.removeActiveSessionIfCurrent(input.thread.id, cleanupSession as Session);
      },
      emitRunEvent: input.emitRunEvent,
    });
    finalizeAssistantTerminalRun = promptExecution.finalizeAssistantTerminalRun;
    const promptCompletionLoop = await (this.options.runPromptCompletionSetup ?? runRuntimePromptCompletionSetup)({
      threadId: input.thread.id,
      preStreamTimeoutMs: input.preStreamTimeoutMs,
      idleTimeoutMs: input.streamIdleTimeoutMs,
      session: input.session,
      isRunStoreActive: input.isRunStoreActive,
      permissionWaits: input.permissionWaits,
      toolExecutionWatchdog: promptControllers.toolExecutionWatchdog,
      toolArgumentWatchdog: promptControllers.toolArgumentWatchdog,
      emptyAssistantStallWatchdog: promptControllers.emptyAssistantStallWatchdog,
      promptControlState: input.promptControlState,
      persistPiStreamTrace: input.persistPiStreamTrace,
      outputState: input.outputState,
      streamActivity: input.streamActivity,
      abortSessionRun: this.options.abortSessionRun,
      promptLifecycleControls: input.promptLifecycleControls,
      emitRunEvent: input.emitRunEvent,
      setStreamWatchdog: (controller) => {
        streamWatchdog = controller;
        if (pendingPreStreamTimeoutMs !== undefined) {
          controller.setPreStreamTimeoutMs(pendingPreStreamTimeoutMs);
        }
        if (pendingTransportActivity) controller.markTransportActivity();
        input.setStreamWatchdog(controller);
      },
      queuedMessages: input.queuedMessages,
      promptExecution,
      postToolContinuation: promptControllers.postToolContinuation,
      assistantTerminalCompletion: promptControllers.assistantTerminalCompletion,
      promptRunState: promptControllers.promptRunState,
      streamTimeoutMessage: input.streamTimeoutMessage,
      finalizeAssistantTerminalRun: () => finalizeAssistantTerminalRun(),
      unsubscribePromptEvents: () => {
        unsubscribeProviderTransport();
        unsubscribe();
      },
    });
    promptControllers.promptRunState.setFinalizedAfterToolIdle(promptCompletionLoop.finalizedAfterToolIdle);
    return {
      completed: input.isRunStoreActive(),
      promptRunState: promptControllers.promptRunState,
    };
  }
}
