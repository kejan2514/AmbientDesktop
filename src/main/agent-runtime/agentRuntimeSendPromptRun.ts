import type { SendMessageInput } from "../../shared/desktopTypes";
import type { PlannerPlanArtifact } from "../../shared/plannerTypes";
import type { ChatMessage, ThreadSummary } from "../../shared/threadTypes";
import type { AssistantFinalizationRetryState } from "./agentRuntimeAssistantRetryInput";
import type { AgentRuntimePromptExecutionController, AgentRuntimePromptExecutionSession } from "./agentRuntimePromptExecutionController";
import type { AgentRuntimePromptOutcomeController, AgentRuntimePromptOutcomeSession } from "./agentRuntimePromptOutcomeController";
import type { AgentRuntimeSendExecutionState, AgentRuntimeSendExecutionStateSession } from "./agentRuntimeSendExecutionState";
import type { AgentRuntimeSendPromptState } from "./agentRuntimeSendPromptState";
import { carrySymphonyParentModeVerifiedLaunch, type SymphonyParentModePolicy } from "./agentRuntimeSymphonyParentMode";
import type { RuntimeRunEventScope } from "./runtimeRunEventScope";

export type AgentRuntimeSendPromptRunSession = AgentRuntimePromptExecutionSession &
  AgentRuntimePromptOutcomeSession &
  AgentRuntimeSendExecutionStateSession;

export interface AgentRuntimeSendPromptRunInput<Session extends AgentRuntimeSendPromptRunSession> {
  sendInput: SendMessageInput;
  hooks: { awaitInternalRetryCompletion?: boolean };
  thread: ThreadSummary;
  runId: string;
  runWorkspacePath: string;
  promptContent: string;
  images: unknown[];
  piPreStreamTimeoutMs: number;
  piStreamIdleTimeoutMs: number;
  defaultToolExecutionIdleTimeoutMs: number;
  emptyAssistantStallTimeoutMs: number;
  assistantTerminalGraceMs: number;
  postToolContinuationIdleMs: number;
  postToolFinalizationIdleMs: number;
  postToolFinalizationTickMs: number;
  abortGraceMs: number;
  assistantFinalizationRetryMaxRetries: number;
  activeAssistantFinalizationRetry?: AssistantFinalizationRetryState | undefined;
  retrySourceUserMessageId?: string | undefined;
  interruptedToolCallRecoveryAttemptsUsed: number;
  interruptedToolCallRecoveryMaxRetries: number;
  canScheduleInterruptedToolCallRecovery: boolean;
  plannerFinalizationSources: PlannerPlanArtifact[];
  startedInPlannerMode: boolean;
  usesDedicatedReviewSession: boolean;
  hasWorkflowPlanEditIntent: boolean;
  runGoalId?: string | undefined;
  runGoalStartedAtMs: number;
  symphonyParentModePolicy?: SymphonyParentModePolicy | undefined;
  sendPromptState: AgentRuntimeSendPromptState;
  sendExecutionState: AgentRuntimeSendExecutionState;
  runEventScope: Pick<RuntimeRunEventScope, "emitRunEvent" | "finishPlannerFinalizationSources" | "isRunStoreActive" | "markRunActivity">;
  promptExecutions: Pick<AgentRuntimePromptExecutionController<Session>, "runPrompt">;
  promptOutcomes: Pick<AgentRuntimePromptOutcomeController, "finalizeSendAfterRun" | "handlePromptFailure" | "handlePromptSuccess">;
  createSession: () => Promise<Session>;
  setSession: (session: Session) => void;
  abortSessionRun: (session: Session, threadId: string) => Promise<void>;
  getMessages: () => ChatMessage[];
  getThread: () => ThreadSummary;
}

export async function runAgentRuntimeSendPromptRun<Session extends AgentRuntimeSendPromptRunSession>(
  input: AgentRuntimeSendPromptRunInput<Session>,
): Promise<void> {
  const { sendPromptState, sendExecutionState, runEventScope } = input;
  const {
    promptLifecycleControls,
    promptControlState,
    outputState,
    streamTraceState,
    providerRetryState,
    pendingFollowUps,
    runtimeMessages,
    queuedMessages,
    piStreamActivity,
    resolveActiveRunSettled,
    currentPiStreamFailureKind,
    currentPiStreamTimeoutMessage,
    recordPiStreamTraceEvent,
    persistPiStreamTrace,
    chatStreamInterruptionDiagnostic,
    chatStreamInterruptionNotice,
  } = sendPromptState;
  const {
    assistantFinalizationRetryAttemptsUsedFor,
    assistantFinalizationRetryNextAttemptFor,
    canScheduleAssistantFinalizationRetryFor,
    sessionRecoveryForCurrentSession,
    persistCurrentSessionPointerForRetry,
    createAssistantFinalizationRetryInput,
    createInterruptedToolCallRecoveryInput,
  } = sendPromptState.assistantRetryPlanning;
  const {
    toolArgumentProgress,
    startedToolCallIds,
    toolMessages,
    toolRecovery,
    permissionWaits,
    collectOpenProviderInterruptionToolSnapshots,
    createProviderContinuationState,
    persistProviderContinuationState,
    createProviderInterruptionContinuationInput,
    sendSessionLifecycle,
    cleanupCurrentSession,
    isAbortRequested,
    currentSubagentParentControlAbortIntent,
    finishParentRun,
    consumeSubagentParentControlAbort,
    requestSubagentParentControlAbort,
    markOpenToolMessagesFailed,
    interruptedToolCallRecovery,
    persistToolArgumentDiagnostics,
    forceInterruptedToolCallRecovery,
  } = sendExecutionState;
  const { emitRunEvent, finishPlannerFinalizationSources, isRunStoreActive, markRunActivity } = runEventScope;
  let session: Session | undefined;

  try {
    session = await input.createSession();
    input.setSession(session);
    if (!isRunStoreActive()) return;
    if (isAbortRequested()) {
      await input.abortSessionRun(session, input.sendInput.threadId);
      throw new Error("Run stopped.");
    }

    const promptExecutionResult = await input.promptExecutions.runPrompt({
      thread: input.thread,
      runId: input.runId,
      session,
      promptContent: input.promptContent,
      images: input.images,
      preStreamTimeoutMs: input.piPreStreamTimeoutMs,
      streamIdleTimeoutMs: input.piStreamIdleTimeoutMs,
      defaultToolExecutionIdleTimeoutMs: input.defaultToolExecutionIdleTimeoutMs,
      emptyAssistantStallTimeoutMs: input.emptyAssistantStallTimeoutMs,
      assistantTerminalGraceMs: input.assistantTerminalGraceMs,
      postToolContinuationIdleMs: input.postToolContinuationIdleMs,
      postToolFinalizationIdleMs: input.postToolFinalizationIdleMs,
      postToolFinalizationTickMs: input.postToolFinalizationTickMs,
      abortGraceMs: input.abortGraceMs,
      assistantFinalizationRetryMaxRetries: input.assistantFinalizationRetryMaxRetries,
      isRunStoreActive,
      permissionWaits,
      promptControlState,
      promptLifecycleControls,
      streamTimeoutMessage: currentPiStreamTimeoutMessage,
      persistPiStreamTrace,
      toolArgumentProgress,
      forceInterruptedToolCallRecovery,
      outputState,
      runtimeMessages,
      getMessages: input.getMessages,
      queuedMessages,
      streamActivity: piStreamActivity,
      streamTraceState,
      providerRetryState,
      toolMessages,
      toolRecovery,
      startedToolCallIds,
      markRunActivity,
      recordPiStreamTraceEvent,
      requestSubagentParentControlAbort,
      setStreamWatchdog: sendPromptState.setStreamWatchdog,
      setToolExecutionWatchdog: sendExecutionState.setToolExecutionWatchdog,
      setToolArgumentWatchdog: sendExecutionState.setToolArgumentWatchdog,
      setEmptyAssistantStallWatchdog: sendPromptState.setEmptyAssistantStallWatchdog,
      setAssistantTerminalCompletion: sendPromptState.setAssistantTerminalCompletion,
      setMarkOpenToolMessagesFailed: sendExecutionState.setMarkOpenToolMessagesFailed,
      emitRunEvent,
    });
    if (!promptExecutionResult.completed) return;
    if (!session) throw new Error("Ambient/Pi prompt completed without an active session.");

    const providerRetry = providerRetryState.snapshot();
    const promptRunState = promptExecutionResult.promptRunState;
    const promptRun = promptRunState.snapshot();
    const symphonyParentModeVerifiedLaunch =
      sendSessionLifecycle.resolveAndStoreCurrentSymphonyParentModeVerifiedLaunch();
    sendSessionLifecycle.assertRequiredSymphonyParentModeLaunch(symphonyParentModeVerifiedLaunch);
    const promptSuccess = await input.promptOutcomes.handlePromptSuccess({
      sendInput: input.sendInput,
      runId: input.runId,
      runWorkspacePath: input.runWorkspacePath,
      startedInPlannerMode: input.startedInPlannerMode,
      session,
      runtimeMessages,
      toolMessages,
      plannerFinalizationSources: input.plannerFinalizationSources,
      runtimeError: promptRun.runtimeError,
      abortRequested: isAbortRequested(),
      finalizedAfterToolIdle: promptRun.finalizedAfterToolIdle,
      currentThinkingFinalText: outputState.currentThinkingFinalText(),
      currentAssistantFinalText: outputState.currentAssistantFinalText(),
      receivedAnyText: outputState.receivedAnyText(),
      pendingEmptyResponseRetryDelayMs: pendingFollowUps.pendingEmptyResponseRetryDelayMs(),
      activeRetryReason: input.activeAssistantFinalizationRetry?.reason,
      retrySourceUserMessageId: input.retrySourceUserMessageId,
      lastAssistantTerminalEvent: promptRun.lastAssistantTerminalEvent,
      assistantTerminalCleanupDiagnostic: promptRun.assistantTerminalCleanupDiagnostic,
      subagentParentControlAbortIntent: currentSubagentParentControlAbortIntent(),
      providerRetryBeforeVisibleOutput: providerRetry.providerRetryBeforeVisibleOutput,
      providerRetryRecovered: providerRetry.providerRetryRecovered,
      providerRetryAttemptCount: providerRetry.providerRetryAttemptCount,
      providerRetryLastError: providerRetry.providerRetryLastError,
      usesDedicatedReviewSession: input.usesDedicatedReviewSession,
      symphonyParentModeVerifiedLaunch,
      assistantFinalizationRetryMaxRetries: input.assistantFinalizationRetryMaxRetries,
      canScheduleAssistantFinalizationRetryFor,
      assistantFinalizationRetryAttemptsUsedFor,
      assistantFinalizationRetryNextAttemptFor,
      createAssistantFinalizationRetryInput,
      consumeSubagentParentControlAbort,
      cleanupCurrentSession,
      finishPlannerFinalizationSources,
      finishParentRun,
      emitRunEvent,
    });
    pendingFollowUps.applyPromptSuccess({
      ...promptSuccess,
      pendingEmptyResponseRetry: carrySymphonyParentModeVerifiedLaunch(
        promptSuccess.pendingEmptyResponseRetry,
        symphonyParentModeVerifiedLaunch,
      ),
    });
  } catch (error) {
    const symphonyParentModeVerifiedLaunch =
      sendSessionLifecycle.refreshStoredSymphonyParentModeVerifiedLaunch();
    await input.promptOutcomes.handlePromptFailure({
      error,
      session,
      sendInput: input.sendInput,
      runId: input.runId,
      runWorkspacePath: input.runWorkspacePath,
      usesDedicatedReviewSession: input.usesDedicatedReviewSession,
      activeAssistantFinalizationRetry: input.activeAssistantFinalizationRetry,
      assistantFinalizationRetryMaxRetries: input.assistantFinalizationRetryMaxRetries,
      interruptedToolCallRecoveryAttemptsUsed: input.interruptedToolCallRecoveryAttemptsUsed,
      interruptedToolCallRecoveryMaxRetries: input.interruptedToolCallRecoveryMaxRetries,
      canScheduleInterruptedToolCallRecovery: input.canScheduleInterruptedToolCallRecovery,
      pendingEmptyResponseRetryDelayMs: pendingFollowUps.pendingEmptyResponseRetryDelayMs(),
      retrySourceUserMessageId: input.retrySourceUserMessageId,
      runtimeMessages,
      toolMessages,
      toolArgumentProgress,
      interruptedToolCallRecovery,
      startedToolCallIds,
      abortRequested: isAbortRequested,
      streamWatchdogTimedOut: promptControlState.isStreamTimedOut,
      currentPiStreamFailureKind,
      currentAssistantFinalText: outputState.currentAssistantFinalText,
      currentThinkingFinalText: outputState.currentThinkingFinalText,
      receivedAnyText: outputState.receivedAnyText,
      subagentParentControlAbortIntent: currentSubagentParentControlAbortIntent,
      isRunStoreActive,
      consumeSubagentParentControlAbort,
      persistPiStreamTrace,
      canScheduleAssistantFinalizationRetryFor,
      assistantFinalizationRetryAttemptsUsedFor,
      assistantFinalizationRetryNextAttemptFor,
      sessionRecoveryForCurrentSession,
      createAssistantFinalizationRetryInput,
      createInterruptedToolCallRecoveryInput,
      collectOpenProviderInterruptionToolSnapshots,
      createProviderContinuationState,
      persistProviderContinuationState,
      persistCurrentSessionPointerForRetry,
      createProviderInterruptionContinuationInput,
      setPendingEmptyResponseRetry: pendingFollowUps.setPendingEmptyResponseRetry,
      setPendingInterruptedToolCallRecoveryFollowUp: pendingFollowUps.setPendingInterruptedToolCallRecoveryFollowUp,
      setPendingProviderInterruptionContinuation: pendingFollowUps.setPendingProviderInterruptionContinuation,
      providerRetryAttemptCount: providerRetryState.providerRetryAttemptCount,
      setProviderRetryAttemptCount: providerRetryState.setProviderRetryAttemptCount,
      setProviderRetryLastError: providerRetryState.setProviderRetryLastError,
      cleanupCurrentSession,
      markOpenToolMessagesFailed,
      persistToolArgumentDiagnostics,
      finishPlannerFinalizationSources,
      finishParentRun,
      getThread: input.getThread,
      symphonyParentModePolicy: input.symphonyParentModePolicy,
      symphonyParentModeVerifiedLaunch,
      chatStreamInterruptionDiagnostic,
      chatStreamInterruptionNotice,
      emitRunEvent,
    });
  } finally {
    const pendingFollowUpsSnapshot = pendingFollowUps.snapshot();
    await input.promptOutcomes.finalizeSendAfterRun({
      sendInput: input.sendInput,
      hooks: input.hooks,
      runId: input.runId,
      runWorkspacePath: input.runWorkspacePath,
      runGoalId: input.runGoalId,
      runGoalStartedAtMs: input.runGoalStartedAtMs,
      promptContent: input.promptContent,
      currentAssistantFinalText: outputState.currentAssistantFinalText(),
      assistantOutputChars: outputState.assistantOutputChars(),
      currentThinkingFinalText: outputState.currentThinkingFinalText(),
      thinkingOutputChars: outputState.thinkingOutputChars(),
      abortRequested: isAbortRequested(),
      pendingPlannerRepairFollowUp: pendingFollowUpsSnapshot.pendingPlannerRepairFollowUp,
      pendingEmptyResponseRetry: pendingFollowUpsSnapshot.pendingEmptyResponseRetry,
      pendingInterruptedToolCallRecoveryFollowUp: pendingFollowUpsSnapshot.pendingInterruptedToolCallRecoveryFollowUp,
      pendingProviderInterruptionContinuation: pendingFollowUpsSnapshot.pendingProviderInterruptionContinuation,
      pendingEmptyResponseRetryDelayMs: pendingFollowUpsSnapshot.pendingEmptyResponseRetryDelayMs,
      usesDedicatedReviewSession: input.usesDedicatedReviewSession,
      session,
      hasWorkflowPlanEditIntent: input.hasWorkflowPlanEditIntent,
      isRunStoreActive,
      cleanupCurrentSession,
      emitRunEvent,
      toolArgumentWatchdog: sendExecutionState.toolArgumentWatchdog(),
      toolExecutionWatchdog: sendExecutionState.toolExecutionWatchdog(),
      queuedMessages,
      toolMessages,
      resolveActiveRunSettled,
    });
  }
}
