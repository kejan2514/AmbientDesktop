import { randomUUID } from "node:crypto";
import type { ChatMessage } from "../../shared/threadTypes";
import { AmbientStreamFailureError } from "./agentRuntimeAmbientFacade";
import type { AmbientStreamFailureKind } from "./agentRuntimeAmbientFacade";
import type { AssistantFinalizationRetryReason } from "./agentRuntimeAssistantRetryInput";
import type { RuntimePromptFailureHandlerInput } from "./runtimePromptFailureTypes";
import type { RuntimeProviderErrorDiagnostic } from "./provider-continuation/agentRuntimeProviderDiagnostics";
import { isContinuableAmbientProviderInterruption } from "./provider-continuation/agentRuntimeProviderDiagnostics";
import { runtimeProviderRetryStartingActivity } from "./provider-continuation/agentRuntimeProviderRetryActivity";
import {
  providerInterruptionContinuationRetryBudget,
  providerInterruptionContinuationRetryDelayMs,
} from "./provider-continuation/providerInterruptionContinuation";
import {
  providerInterruptionFinalizationMessage,
  providerInterruptionRecoveryFailureFinalizationMessage,
} from "./providerInterruptionFinalization";

interface RuntimePromptProviderInterruptionHandlerContext {
  message: string;
  providerErrorDiagnostic: RuntimeProviderErrorDiagnostic;
  preOutputStreamStall: boolean;
}

export async function handleRuntimePromptProviderInterruption(
  input: RuntimePromptFailureHandlerInput,
  context: RuntimePromptProviderInterruptionHandlerContext,
): Promise<boolean> {
  const { message, providerErrorDiagnostic, preOutputStreamStall } = context;
  const providerInterruptionRetryReason: AssistantFinalizationRetryReason = "provider_interruption_continuation";
  const shouldHandleProviderInterruption =
    !input.abortRequested() &&
    !preOutputStreamStall &&
    Boolean(input.retrySourceUserMessageId) &&
    isContinuableAmbientProviderInterruption(input.error) &&
    !input.usesDedicatedReviewSession;
  if (!shouldHandleProviderInterruption || !input.retrySourceUserMessageId) return false;

  const providerInterruptionStateId =
    input.activeAssistantFinalizationRetry?.reason === providerInterruptionRetryReason && input.activeAssistantFinalizationRetry.recoveryStateId
      ? input.activeAssistantFinalizationRetry.recoveryStateId
      : `provider-continuation-${randomUUID()}`;
  try {
    const failureKind: AmbientStreamFailureKind = input.streamWatchdogTimedOut()
      ? input.currentPiStreamFailureKind()
      : input.error instanceof AmbientStreamFailureError
        ? input.error.kind
        : "provider_error_event";
    const openToolCalls = input.collectOpenProviderInterruptionToolSnapshots();
    const retryBudget = providerInterruptionContinuationRetryBudget({
      configuredMaxRetries: input.assistantFinalizationRetryMaxRetries,
      tools: openToolCalls,
    });
    const providerInterruptionAttemptsUsed = input.assistantFinalizationRetryAttemptsUsedFor(
      providerInterruptionRetryReason,
      providerInterruptionStateId,
    );
    const providerInterruptionRetryNextAttempt = providerInterruptionAttemptsUsed + 1;
    const providerInterruptionRetryDelayMs = providerInterruptionContinuationRetryDelayMs(
      providerInterruptionRetryNextAttempt,
      providerInterruptionStateId,
    );
    let willContinue = providerInterruptionAttemptsUsed < retryBudget.maxRetries;
    let continuationSetupError: string | undefined;
    const completedToolMessageCount = Math.max(0, input.toolMessages.size() - openToolCalls.length);
    const replaySafeOpenToolCalls =
      openToolCalls.length > 0 && openToolCalls.every((tool) => !tool.executionStarted && tool.argumentComplete);
    let continuationState = input.persistProviderContinuationState(input.createProviderContinuationState({
      message,
      kind: failureKind,
      retryScheduled: willContinue,
      replaySafe: replaySafeOpenToolCalls,
      continuationSafe: true,
      retryUsesFreshSession: false,
      retryAttempt: willContinue ? providerInterruptionRetryNextAttempt : providerInterruptionAttemptsUsed,
      maxRetries: retryBudget.maxRetries,
      retryReason: "provider_interruption_continuation",
      retryDelayMs: providerInterruptionRetryDelayMs,
      openToolCalls,
      completedToolMessageCount,
      receivedAnyText: input.receivedAnyText(),
      stateId: providerInterruptionStateId,
    }));
    if (willContinue) {
      try {
        await input.persistCurrentSessionPointerForRetry("provider-continuation");
        input.setPendingProviderInterruptionContinuation(input.createProviderInterruptionContinuationInput({
          message,
          diagnostic: providerErrorDiagnostic,
          tools: openToolCalls,
          completedToolMessageCount,
          continuationState,
        }));
      } catch (setupError) {
        continuationSetupError = setupError instanceof Error ? setupError.message : String(setupError);
        willContinue = false;
        input.setPendingProviderInterruptionContinuation(undefined);
        continuationState = input.persistProviderContinuationState(input.createProviderContinuationState({
          message: `${message}\nContinuation setup failed: ${continuationSetupError}`,
          kind: failureKind,
          retryScheduled: false,
          replaySafe: replaySafeOpenToolCalls,
          continuationSafe: false,
          retryUsesFreshSession: false,
          retryAttempt: providerInterruptionAttemptsUsed,
          maxRetries: retryBudget.maxRetries,
          retryReason: "provider_interruption_continuation",
          retryDelayMs: providerInterruptionRetryDelayMs,
          openToolCalls,
          completedToolMessageCount,
          receivedAnyText: input.receivedAnyText(),
          stateId: providerInterruptionStateId,
        }));
      }
    }
    input.setProviderRetryAttemptCount(Math.max(
      input.providerRetryAttemptCount(),
      willContinue ? providerInterruptionRetryNextAttempt : providerInterruptionAttemptsUsed,
    ));
    input.setProviderRetryLastError(continuationSetupError ? `${message}; continuation setup failed: ${continuationSetupError}` : message);
    input.cleanupCurrentSession();
    input.runtimeMessages.finishCurrentThinkingMessage(willContinue ? "done" : "error", input.currentThinkingFinalText());
    try {
      input.markOpenToolMessagesFailed(({ executionStarted }) =>
        executionStarted
          ? willContinue
            ? "Ambient/Pi provider failed after this tool may have started. Ambient is continuing from the transcript so Pi can verify state before retrying."
            : "Ambient/Pi provider failed after this tool may have started. Ambient stopped this turn so the transcript can be inspected."
          : willContinue
            ? "Ambient/Pi provider failed before this tool executed. Ambient is continuing from the transcript."
            : continuationSetupError
              ? `Ambient/Pi provider failed before this tool executed. Ambient could not schedule continuation: ${continuationSetupError}`
              : "Ambient/Pi provider failed before this tool executed. Ambient exhausted the bounded continuation budget for incomplete tool arguments.",
      );
    } catch (toolMarkError) {
      console.warn(`Failed to mark open tool messages interrupted: ${toolMarkError instanceof Error ? toolMarkError.message : String(toolMarkError)}`);
    }
    if (willContinue) {
      input.emitRunEvent({
        type: "runtime-activity",
        activity: runtimeProviderRetryStartingActivity({
          threadId: input.threadId,
          attempt: providerInterruptionRetryNextAttempt,
          maxAttempts: retryBudget.maxRetries,
          delayMs: providerInterruptionRetryDelayMs,
          message: `Provider interrupted the stream; continuing from transcript: ${message}`,
        }),
      });
    }
    const currentAssistantVisibleContent = input.runtimeMessages.currentMessageContent(
      input.runtimeMessages.currentAssistantMessageId(),
      input.currentAssistantFinalText(),
    );
    const providerInterruptionFinalization = providerInterruptionFinalizationMessage({
      currentAssistantVisibleContent,
      message,
      diagnostic: providerErrorDiagnostic,
      tools: openToolCalls,
      completedToolMessageCount,
      attempt: willContinue ? providerInterruptionRetryNextAttempt : providerInterruptionAttemptsUsed,
      maxRetries: retryBudget.maxRetries,
      willContinue,
      continuationSetupError,
      retryBudgetReason: retryBudget.reason,
      continuationState,
      streamInterruptionDiagnostic: input.chatStreamInterruptionDiagnostic(message, {
        kind: failureKind,
        retryScheduled: willContinue,
        replaySafe: replaySafeOpenToolCalls,
        continuationSafe: willContinue,
        retryUsesFreshSession: false,
        retryAttempt: willContinue ? providerInterruptionRetryNextAttempt : providerInterruptionAttemptsUsed,
        maxRetries: retryBudget.maxRetries,
        retryReason: "provider_interruption_continuation",
        retryDelayMs: providerInterruptionRetryDelayMs,
        providerErrorDiagnostic,
        interruptedToolCalls: openToolCalls,
        completedToolMessageCount,
        receivedAnyText: input.receivedAnyText(),
      }),
    });
    const fallback = input.runtimeMessages.replaceCurrentAssistant(
      providerInterruptionFinalization.content,
      providerInterruptionFinalization.metadata,
    );
    if (!willContinue) {
      input.finishPlannerFinalizationSources("failed", {
        error: continuationSetupError ? `${message}; ${continuationSetupError}` : message,
        workflowState: "failed",
      });
    }
    input.finishParentRun(willContinue ? "done" : "error", willContinue ? undefined : continuationSetupError ? `${message}; ${continuationSetupError}` : message);
    input.emitRunEvent({ type: "message-updated", message: fallback });
    input.emitRunEvent({ type: "run-status", threadId: input.threadId, status: willContinue ? "idle" : "error" });
    if (!willContinue) {
      input.emitRunEvent({
        type: "error",
        message: continuationSetupError ? `${message}; ${continuationSetupError}` : message,
        threadId: input.threadId,
        workspacePath: input.workspacePath,
      });
    }
  } catch (recoveryError) {
    const recoveryMessage = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
    const fallbackMessage = `${message}\nProvider interruption recovery failed: ${recoveryMessage}`;
    try {
      input.runtimeMessages.finishCurrentThinkingMessage("error", input.currentThinkingFinalText());
    } catch {
      // Keep timeout finalization moving even if a secondary message update fails.
    }
    try {
      input.markOpenToolMessagesFailed(`Ambient/Pi stream interrupted, and recovery finalization failed: ${recoveryMessage}`);
    } catch (toolMarkError) {
      console.warn(`Failed to mark open tool messages after recovery failure: ${toolMarkError instanceof Error ? toolMarkError.message : String(toolMarkError)}`);
    }
    let fallback: ChatMessage | undefined;
    try {
      const currentAssistantVisibleContent = input.runtimeMessages.currentMessageContent(
        input.runtimeMessages.currentAssistantMessageId(),
        input.currentAssistantFinalText(),
      );
      const recoveryFailureFinalization = providerInterruptionRecoveryFailureFinalizationMessage({
        currentAssistantVisibleContent,
        interruptionNotice: input.chatStreamInterruptionNotice(fallbackMessage),
        streamInterruptionDiagnostic: input.chatStreamInterruptionDiagnostic(fallbackMessage, { providerErrorDiagnostic }),
      });
      fallback = input.runtimeMessages.replaceCurrentAssistant(
        recoveryFailureFinalization.content,
        recoveryFailureFinalization.metadata,
      );
    } catch (messageError) {
      console.warn(`Failed to write provider interruption fallback message: ${messageError instanceof Error ? messageError.message : String(messageError)}`);
    }
    input.finishPlannerFinalizationSources("failed", { error: fallbackMessage, workflowState: "failed" });
    try {
      input.finishParentRun("error", fallbackMessage);
    } catch (finishError) {
      console.warn(`Failed to finish provider interruption run: ${finishError instanceof Error ? finishError.message : String(finishError)}`);
    }
    if (fallback) input.emitRunEvent({ type: "message-updated", message: fallback });
    input.emitRunEvent({ type: "run-status", threadId: input.threadId, status: "error" });
    input.emitRunEvent({ type: "error", message: fallbackMessage, threadId: input.threadId, workspacePath: input.workspacePath });
  }
  return true;
}
