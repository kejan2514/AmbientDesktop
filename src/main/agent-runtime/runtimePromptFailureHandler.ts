import { promptCacheTelemetryFromUsage } from "../../shared/promptCacheTelemetry";
import {
  AmbientStreamFailureError,
  isRetryableAmbientProviderError,
  parseAmbientProviderContextOverflow,
} from "./agentRuntimeAmbientFacade";
import type { AmbientStreamFailureKind } from "./agentRuntimeAmbientFacade";
import type { AssistantFinalizationRetryReason } from "./agentRuntimeAssistantRetryInput";
import { shouldOpenApiKeyDialogForRuntimeError, formatRuntimeError as formatAgentRuntimeError } from "../agent-runtime/agentRuntimeErrorFormatting";
import { runtimeProviderErrorDiagnostic } from "./provider-continuation/agentRuntimeProviderDiagnostics";
import { runtimeProviderRetryStartingActivity } from "./provider-continuation/agentRuntimeProviderRetryActivity";
import { formatToolTranscript } from "./tools/agentRuntimeToolTranscript";
import { toolMessageMetadata } from "./tools/agentRuntimeToolMessageMetadata";
import { interruptedToolCallRecoveryFinalizationMessage } from "./interruptedToolCallRecoveryFinalization";
import {
  preOutputStreamStallRetryFinalizationMessage,
  providerContextOverflowRetryFinalizationMessage,
  providerErrorBeforeToolRetryFinalizationMessage,
} from "./providerRetryFinalization";
import { handleRuntimePromptProviderInterruption } from "./runtimePromptProviderInterruptionHandler";
import { streamWatchdogFinalizationMessage } from "./streamWatchdogFinalization";
import { terminalProviderFailureFinalizationMessage } from "./terminalProviderFailureFinalization";
import { isSymphonyParentModeMissingWorkflowTaskError } from "./agentRuntimeSymphonyParentMode";
import { symphonyParentModeRecoveryFinalizationMessage } from "./symphonyParentModeRecoveryFinalization";
import { finalAssistantMessageModel } from "./finalAssistantMessage";
import {
  callableWorkflowFinalizationBlockedActivity,
  subagentFinalizationBlockedActivity,
} from "./agentRuntimeFinalizationBlocking";
import type { RuntimePromptFailureHandlerInput } from "./runtimePromptFailureTypes";

export type { RuntimePromptFailureHandlerInput } from "./runtimePromptFailureTypes";

export async function handleRuntimePromptFailure(input: RuntimePromptFailureHandlerInput): Promise<void> {
  if (!input.isRunStoreActive()) return;
  await input.consumeSubagentParentControlAbort();
  input.runtimeMessages.completePromptCacheTelemetryIfPending(promptCacheTelemetryFromUsage(undefined));
  const providerErrorDiagnostic = runtimeProviderErrorDiagnostic(input.error);
  if (shouldOpenApiKeyDialogForRuntimeError(providerErrorDiagnostic)) {
    input.emitRunEvent({ type: "open-api-key-dialog" });
  }
  const message = providerErrorDiagnostic.message;
  if (input.streamWatchdogTimedOut() || input.error instanceof AmbientStreamFailureError) {
    input.persistPiStreamTrace(message);
  }
  const callableWorkflowFailureBlock = !input.abortRequested()
    ? input.resolveCallableWorkflowFinalizationBlock?.()
    : undefined;
  if (callableWorkflowFailureBlock) {
    const failureKind: AmbientStreamFailureKind = input.streamWatchdogTimedOut()
      ? input.currentPiStreamFailureKind()
      : input.error instanceof AmbientStreamFailureError
        ? input.error.kind
        : "provider_error_event";
    input.persistPiStreamTrace(message);
    const streamInterruptionDiagnostic = input.chatStreamInterruptionDiagnostic(message, {
      kind: failureKind,
      retryScheduled: false,
      replaySafe: false,
      providerErrorDiagnostic,
      completedToolMessageCount: input.toolMessages.size(),
      receivedAnyText: input.receivedAnyText(),
    });
    const subagentFailureBlock = input.resolveSubagentFinalizationBlock?.();
    input.cleanupCurrentSession({ clearPersistedSessionFileIfCurrent: true });
    input.runtimeMessages.finishCurrentThinkingMessage("error", input.currentThinkingFinalText());
    input.runtimeMessages.suppressCurrentThinkingMessage("error");
    input.markOpenToolMessagesFailed(
      "Parent finalization stopped after launching a blocking callable workflow. Ambient is waiting for the workflow task instead of preserving parent output.",
    );
    const subagentMailboxEvents = subagentFailureBlock
      ? input.recordSubagentFinalizationBlockedParentMailbox?.(subagentFailureBlock) ?? []
      : [];
    const mailboxEvent = input.recordCallableWorkflowFinalizationBlockedParentMailbox?.(callableWorkflowFailureBlock);
    const currentAssistantVisibleContent = input.runtimeMessages.currentMessageContent(
      input.runtimeMessages.currentAssistantMessageId(),
      input.currentAssistantFinalText(),
    );
    const parentFinalizationBlockMessage = [
      subagentFailureBlock?.message,
      callableWorkflowFailureBlock.message,
    ].filter((item): item is string => Boolean(item)).join("\n\n");
    const finalAssistant = finalAssistantMessageModel({
      currentAssistantVisibleContent,
      abortRequested: false,
      abortMessage: "Run stopped.",
      receivedAnyText: input.receivedAnyText(),
      finalizedAfterToolIdle: false,
      awaitingInputAfterTools: false,
      emptyAssistantResponse: false,
      retryEmptyAssistantResponse: false,
      emptyResponseText: "",
      assistantTerminalCleanupInterrupted: false,
      parentFinalizationBlockMessage,
      subagentFinalizationBlock: subagentFailureBlock,
      subagentFinalizationParentMailboxEventIds: subagentMailboxEvents.map((event) => event.id),
      callableWorkflowFinalizationBlock: callableWorkflowFailureBlock,
      callableWorkflowFinalizationParentMailboxEventId: mailboxEvent?.id,
      providerRetryBeforeVisibleOutput: false,
      providerRetryRecovered: false,
      providerRetryAttemptCount: input.providerRetryAttemptCount(),
      discardProviderRetrySession: false,
    });
    const fallback = input.runtimeMessages.replaceCurrentAssistant(finalAssistant.content, {
      ...finalAssistant.metadata,
      providerErrorDiagnostic,
      piStreamInterruption: streamInterruptionDiagnostic,
    });
    input.suppressCallableWorkflowParentAssistantMessages?.(callableWorkflowFailureBlock, {
      preserveMessageId: fallback.id,
    });
    input.runtimeMessages.suppressAssistantMessagesExceptCurrent("error");
    input.emitRunEvent({ type: "thread-updated", thread: input.getThread() });
    input.finishPlannerFinalizationSources("failed", {
      error: finalAssistant.finalizationErrorText,
      workflowState: "failed",
    });
    input.finishParentRun("error", finalAssistant.finalizationErrorText);
    input.emitRunEvent({ type: "message-updated", message: fallback });
    if (subagentFailureBlock) {
      input.emitRunEvent({
        type: "runtime-activity",
        activity: subagentFinalizationBlockedActivity({
          threadId: input.threadId,
          outputChars: currentAssistantVisibleContent.length,
          block: subagentFailureBlock,
        }),
      });
    }
    input.emitRunEvent({
      type: "runtime-activity",
      activity: callableWorkflowFinalizationBlockedActivity({
        threadId: input.threadId,
        outputChars: currentAssistantVisibleContent.length,
        block: callableWorkflowFailureBlock,
      }),
    });
    input.emitRunEvent({ type: "run-status", threadId: input.threadId, status: "error" });
    input.emitRunEvent({
      type: "error",
      message: finalAssistant.finalizationErrorText,
      threadId: input.threadId,
      workspacePath: input.workspacePath,
    });
    return;
  }
  if (isSymphonyParentModeMissingWorkflowTaskError(input.error)) {
    input.cleanupCurrentSession({ clearPersistedSessionFileIfCurrent: true });
    input.runtimeMessages.finishCurrentThinkingMessage("error", input.currentThinkingFinalText());
    input.markOpenToolMessagesFailed("Symphony parent mode stopped before a callable workflow launch was verified.");
    const recoveryFinalization = symphonyParentModeRecoveryFinalizationMessage({
      message,
      policy: input.symphonyParentModePolicy,
    });
    const fallback = input.runtimeMessages.replaceCurrentAssistant(
      recoveryFinalization.content,
      recoveryFinalization.metadata,
    );
    input.finishPlannerFinalizationSources("failed", { error: message, workflowState: "failed" });
    input.finishParentRun("error", message);
    input.emitRunEvent({ type: "message-updated", message: fallback });
    input.emitRunEvent({ type: "run-status", threadId: input.threadId, status: "error" });
    input.emitRunEvent({ type: "error", message, threadId: input.threadId, workspacePath: input.workspacePath });
    return;
  }
  const providerContextOverflow = parseAmbientProviderContextOverflow(input.error);
  const providerContextOverflowRetryReason: AssistantFinalizationRetryReason = "provider_context_overflow";
  const providerContextOverflowAttemptsUsed = input.assistantFinalizationRetryAttemptsUsedFor(
    providerContextOverflowRetryReason,
  );
  const canRecoverProviderContextOverflow =
    Boolean(providerContextOverflow) &&
    Boolean(input.recoverProviderContextOverflow) &&
    !input.abortRequested() &&
    providerContextOverflowAttemptsUsed < 1 &&
    Boolean(input.retrySourceUserMessageId) &&
    !input.receivedAnyText() &&
    !input.currentAssistantFinalText().trim() &&
    input.toolMessages.size() === 0 &&
    input.startedToolCallIds.size === 0;
  if (canRecoverProviderContextOverflow && providerContextOverflow && input.retrySourceUserMessageId) {
    try {
      const learned = await input.recoverProviderContextOverflow!(providerContextOverflow);
      const retryAttempt = providerContextOverflowAttemptsUsed + 1;
      input.setPendingEmptyResponseRetry(input.createAssistantFinalizationRetryInput(providerContextOverflowRetryReason));
      input.setProviderRetryAttemptCount(Math.max(input.providerRetryAttemptCount(), retryAttempt));
      input.setProviderRetryLastError(message);
      input.runtimeMessages.finishCurrentThinkingMessage("done", input.currentThinkingFinalText());
      const retryFinalization = providerContextOverflowRetryFinalizationMessage({
        retryAttempt,
        effectiveContextWindowTokens: learned.effectiveContextWindowTokens,
        requestedOutputTokens: learned.requestedOutputTokens,
      });
      const fallback = input.runtimeMessages.replaceCurrentAssistant(
        retryFinalization.content,
        retryFinalization.metadata,
      );
      input.finishParentRun("done");
      input.emitRunEvent({ type: "message-updated", message: fallback });
      input.emitRunEvent({ type: "run-status", threadId: input.threadId, status: "idle" });
      return;
    } catch (recoveryError) {
      console.warn(
        `Ambient provider context overflow recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
      );
    }
  }
  const preOutputStreamStallRetryReason: AssistantFinalizationRetryReason = "pre_output_stream_stall";
  const preOutputStreamStall =
    input.streamWatchdogTimedOut() &&
    !input.receivedAnyText() &&
    input.toolMessages.size() === 0 &&
    !input.currentAssistantFinalText().trim();
  const retryPreOutputStreamStall =
    preOutputStreamStall &&
    input.canScheduleAssistantFinalizationRetryFor(preOutputStreamStallRetryReason);
  if (retryPreOutputStreamStall && input.retrySourceUserMessageId) {
    const preOutputStreamStallRetryNextAttempt = input.assistantFinalizationRetryNextAttemptFor(preOutputStreamStallRetryReason);
    input.cleanupCurrentSession({ clearPersistedSessionFileIfCurrent: true });
    input.setPendingEmptyResponseRetry(input.createAssistantFinalizationRetryInput(
      preOutputStreamStallRetryReason,
      input.sessionRecoveryForCurrentSession(
        "fresh_session_after_pre_output_stream_stall",
        "Ambient/Pi stalled before any assistant output or tool activity, so Ambient retried with a fresh Pi session.",
      ),
    ));
    input.runtimeMessages.finishCurrentThinkingMessage("done", input.currentThinkingFinalText());
    const retryFinalization = preOutputStreamStallRetryFinalizationMessage({
      retryAttempt: preOutputStreamStallRetryNextAttempt,
      maxRetries: input.assistantFinalizationRetryMaxRetries,
      retryDelayMs: input.pendingEmptyResponseRetryDelayMs,
      receivedAnyText: input.receivedAnyText(),
      streamInterruptionDiagnostic: input.chatStreamInterruptionDiagnostic(message, {
        retryScheduled: true,
        replaySafe: true,
        providerErrorDiagnostic,
      }),
    });
    const fallback = input.runtimeMessages.replaceCurrentAssistant(retryFinalization.content, retryFinalization.metadata);
    input.finishParentRun("done");
    input.emitRunEvent({ type: "message-updated", message: fallback });
    input.emitRunEvent({ type: "run-status", threadId: input.threadId, status: "idle" });
    return;
  }

  const recoverableInterruptedToolCalls = !input.abortRequested()
    ? input.interruptedToolCallRecovery.recoverable()
    : [];
  if (recoverableInterruptedToolCalls.length > 0) {
    const failureKind: AmbientStreamFailureKind = input.streamWatchdogTimedOut()
      ? input.currentPiStreamFailureKind()
      : input.error instanceof AmbientStreamFailureError
        ? input.error.kind
        : "provider_error_event";
    const willContinue = input.canScheduleInterruptedToolCallRecovery;
    const openToolCalls = input.collectOpenProviderInterruptionToolSnapshots();
    const completedToolMessageCount = Math.max(0, input.toolMessages.size() - openToolCalls.length);
    const continuationState = input.persistProviderContinuationState(input.createProviderContinuationState({
      message,
      kind: failureKind,
      retryScheduled: willContinue,
      replaySafe: true,
      retryAttempt: willContinue
        ? input.interruptedToolCallRecoveryAttemptsUsed + 1
        : input.interruptedToolCallRecoveryAttemptsUsed,
      maxRetries: input.interruptedToolCallRecoveryMaxRetries,
      retryReason: "interrupted_tool_call_recovery",
      openToolCalls,
      completedToolMessageCount,
      receivedAnyText: input.receivedAnyText(),
    }));
    if (willContinue) {
      input.setPendingInterruptedToolCallRecoveryFollowUp(input.createInterruptedToolCallRecoveryInput(recoverableInterruptedToolCalls));
    }
    input.cleanupCurrentSession();
    input.runtimeMessages.finishCurrentThinkingMessage("done", input.currentThinkingFinalText());
    for (const snapshot of recoverableInterruptedToolCalls) {
      const messageId = input.toolMessages.messageId(snapshot.toolCallId);
      if (!messageId) continue;
      const inputContent = input.toolMessages.inputContent(snapshot.toolCallId) ?? "";
      const longformInputPreview = input.toolMessages.longformInputPreview(snapshot.toolCallId);
      const editInputPreview = input.toolMessages.editInputPreview(snapshot.toolCallId);
      const progress = input.toolArgumentProgress.current(snapshot.toolCallId);
      const progressWithRecovery = progress ? { ...progress, interruptedToolCallRecovery: snapshot } : undefined;
      const updated = input.replaceToolMessage(
        messageId,
        formatToolTranscript(
          snapshot.toolName,
          "interrupted",
          inputContent,
          `Stream interrupted before execution. Partial arguments saved at ${snapshot.workspaceRelativeArgumentPath}.`,
        ),
        toolMessageMetadata(
          "error",
          snapshot.toolCallId,
          snapshot.toolName,
          snapshot.argumentPath,
          undefined,
          longformInputPreview,
          editInputPreview,
          progressWithRecovery,
        ),
      );
      input.emitRunEvent({ type: "message-updated", message: updated });
    }
    input.persistToolArgumentDiagnostics(true);
    const recoveryFinalization = interruptedToolCallRecoveryFinalizationMessage({
      message,
      snapshots: recoverableInterruptedToolCalls,
      willContinue,
      continuationState,
      streamInterruptionDiagnostic: input.chatStreamInterruptionDiagnostic(message, {
        kind: failureKind,
        retryScheduled: willContinue,
        replaySafe: true,
        providerErrorDiagnostic,
      }),
      retryAttempt: willContinue
        ? input.interruptedToolCallRecoveryAttemptsUsed + 1
        : input.interruptedToolCallRecoveryAttemptsUsed,
      maxRetries: input.interruptedToolCallRecoveryMaxRetries,
    });
    const fallback = input.runtimeMessages.replaceCurrentAssistant(recoveryFinalization.content, recoveryFinalization.metadata);
    if (!willContinue) {
      input.finishPlannerFinalizationSources("failed", { error: message, workflowState: "failed" });
    }
    input.finishParentRun(willContinue ? "done" : "error", willContinue ? undefined : message);
    input.emitRunEvent({ type: "message-updated", message: fallback });
    input.emitRunEvent({ type: "run-status", threadId: input.threadId, status: willContinue ? "idle" : "error" });
    if (!willContinue) input.emitRunEvent({ type: "error", message, threadId: input.threadId, workspacePath: input.workspacePath });
    return;
  }

  const providerErrorRetryReason: AssistantFinalizationRetryReason = "provider_error_before_tool_execution";
  const retryProviderErrorBeforeToolExecution =
    !input.abortRequested() &&
    !input.streamWatchdogTimedOut() &&
    input.canScheduleAssistantFinalizationRetryFor(providerErrorRetryReason) &&
    isRetryableAmbientProviderError(input.error) &&
    !input.receivedAnyText() &&
    !input.currentAssistantFinalText().trim() &&
    input.toolMessages.size() === 0 &&
    input.startedToolCallIds.size === 0;
  if (retryProviderErrorBeforeToolExecution && input.retrySourceUserMessageId) {
    const providerErrorRetryNextAttempt = input.assistantFinalizationRetryNextAttemptFor(providerErrorRetryReason);
    input.cleanupCurrentSession({ clearPersistedSessionFileIfCurrent: true });
    input.setPendingEmptyResponseRetry(input.createAssistantFinalizationRetryInput(
      providerErrorRetryReason,
      input.sessionRecoveryForCurrentSession(
        "fresh_session_after_provider_error_before_tool_execution",
        "Ambient/Pi failed before assistant output or tool execution, so Ambient retried with a fresh Pi session.",
      ),
    ));
    input.setProviderRetryAttemptCount(Math.max(input.providerRetryAttemptCount(), providerErrorRetryNextAttempt));
    input.setProviderRetryLastError(message);
    input.runtimeMessages.finishCurrentThinkingMessage("done", input.currentThinkingFinalText());
    input.markOpenToolMessagesFailed("Ambient/Pi stream failed before this tool executed. Retrying the request with a fresh session.");
    input.emitRunEvent({
      type: "runtime-activity",
      activity: runtimeProviderRetryStartingActivity({
        threadId: input.threadId,
        attempt: providerErrorRetryNextAttempt,
        maxAttempts: input.assistantFinalizationRetryMaxRetries,
        delayMs: input.pendingEmptyResponseRetryDelayMs,
        message: `Provider failed before tool execution: ${message}`,
      }),
    });
    const retryFinalization = providerErrorBeforeToolRetryFinalizationMessage({
      retryAttempt: providerErrorRetryNextAttempt,
      maxRetries: input.assistantFinalizationRetryMaxRetries,
      retryDelayMs: input.pendingEmptyResponseRetryDelayMs,
      streamInterruptionDiagnostic: input.chatStreamInterruptionDiagnostic(message, {
        kind: "provider_error_event",
        retryScheduled: true,
        replaySafe: true,
        retryUsesFreshSession: true,
        retryAttempt: providerErrorRetryNextAttempt,
        maxRetries: input.assistantFinalizationRetryMaxRetries,
        retryReason: "provider_error_before_tool_execution",
        retryDelayMs: input.pendingEmptyResponseRetryDelayMs,
        providerErrorDiagnostic,
        receivedAnyText: input.receivedAnyText(),
      }),
    });
    const fallback = input.runtimeMessages.replaceCurrentAssistant(retryFinalization.content, retryFinalization.metadata);
    input.finishParentRun("done");
    input.emitRunEvent({ type: "message-updated", message: fallback });
    input.emitRunEvent({ type: "run-status", threadId: input.threadId, status: "idle" });
    return;
  }

  if (await handleRuntimePromptProviderInterruption(input, { message, providerErrorDiagnostic, preOutputStreamStall })) {
    return;
  }

  if (input.streamWatchdogTimedOut()) {
    const status = input.abortRequested() ? "aborted" : "error";
    input.runtimeMessages.finishCurrentThinkingMessage(status, input.currentThinkingFinalText());
    input.markOpenToolMessagesFailed(input.abortRequested() ? "Run stopped before this tool completed." : "Ambient/Pi stream interrupted before this tool completed.");
    const currentAssistantVisibleContent = input.runtimeMessages.currentMessageContent(
      input.runtimeMessages.currentAssistantMessageId(),
      input.currentAssistantFinalText(),
    );
    const streamWatchdogFinalization = streamWatchdogFinalizationMessage({
      status,
      currentAssistantVisibleContent,
      interruptionNotice: input.chatStreamInterruptionNotice(message),
      streamInterruptionDiagnostic: input.chatStreamInterruptionDiagnostic(message, { providerErrorDiagnostic }),
    });
    const fallback = input.runtimeMessages.replaceCurrentAssistant(
      streamWatchdogFinalization.content,
      streamWatchdogFinalization.metadata,
    );
    input.finishPlannerFinalizationSources("failed", { error: input.abortRequested() ? "Run stopped." : message, workflowState: "failed" });
    input.finishParentRun(status, input.abortRequested() ? undefined : message);
    input.emitRunEvent({ type: "message-updated", message: fallback });
    input.emitRunEvent({ type: "run-status", threadId: input.threadId, status: input.abortRequested() ? "idle" : "error" });
    if (!input.abortRequested()) input.emitRunEvent({ type: "error", message, threadId: input.threadId, workspacePath: input.workspacePath });
    return;
  }

  const status = input.abortRequested() ? "aborted" : "error";
  input.runtimeMessages.finishCurrentThinkingMessage(status, input.currentThinkingFinalText());
  input.markOpenToolMessagesFailed(input.abortRequested() ? "Run stopped before this tool completed." : "Ambient/Pi provider failed before this tool completed.");
  const abortMessage = input.subagentParentControlAbortIntent()?.message ?? "Run stopped.";
  const finalProviderInterruption = input.abortRequested()
    ? undefined
    : input.chatStreamInterruptionDiagnostic(message, {
        kind: input.error instanceof AmbientStreamFailureError ? input.error.kind : "provider_error_event",
        providerErrorDiagnostic,
      });
  const terminalProviderFailureFinalization = terminalProviderFailureFinalizationMessage({
    status,
    abortRequested: input.abortRequested(),
    abortMessage,
    providerErrorContent: input.abortRequested() ? "" : formatAgentRuntimeError(message, providerErrorDiagnostic),
    providerErrorDiagnostic,
    streamInterruptionDiagnostic: finalProviderInterruption,
    subagentParentControlAbortIntent: input.subagentParentControlAbortIntent(),
  });
  const fallback = input.runtimeMessages.replaceCurrentAssistant(
    terminalProviderFailureFinalization.content,
    terminalProviderFailureFinalization.metadata,
  );
  input.finishPlannerFinalizationSources("failed", { error: input.abortRequested() ? abortMessage : message, workflowState: "failed" });
  input.finishParentRun(status, input.abortRequested() ? undefined : message);
  input.emitRunEvent({ type: "message-updated", message: fallback });
  input.emitRunEvent({ type: "run-status", threadId: input.threadId, status: input.abortRequested() ? "idle" : "error" });
  if (!input.abortRequested()) input.emitRunEvent({ type: "error", message, threadId: input.threadId, workspacePath: input.workspacePath });
}
