import { existsSync } from "node:fs";
import type { PermissionMode } from "../../shared/permissionTypes";
import type { SendMessageInput } from "../../shared/desktopTypes";
import type { MessageDelivery } from "../../shared/threadTypes";

export type AssistantFinalizationRetryReason =
  | "empty_assistant_response"
  | "pre_output_stream_stall"
  | "provider_error_before_tool_execution"
  | "provider_context_overflow"
  | "provider_interruption_continuation";

export interface AssistantFinalizationRetryState {
  sourceUserMessageId: string;
  attempt: number;
  maxRetries: number;
  reason: AssistantFinalizationRetryReason;
  recoveryStateId?: string;
}

export interface RuntimeSessionRecoveryContext {
  kind:
    | "fresh_session_after_pre_output_stream_stall"
    | "fresh_session_after_provider_error_before_tool_execution"
    | "interrupted_tool_call_recovery"
    | "provider_interruption_continuation";
  reason: string;
  previousSessionFile?: string;
  previousSessionFileExists?: boolean;
  providerContinuationStateId?: string;
}

export function buildRuntimeSessionRecoveryContext(input: {
  kind: RuntimeSessionRecoveryContext["kind"];
  reason: string;
  previousSessionFile?: string;
  fileExists?: (path: string) => boolean;
  providerContinuationStateId?: string;
}): RuntimeSessionRecoveryContext {
  const previousSessionFile = input.previousSessionFile;
  return {
    kind: input.kind,
    reason: input.reason,
    ...(previousSessionFile ? { previousSessionFile } : {}),
    ...(previousSessionFile ? { previousSessionFileExists: (input.fileExists ?? existsSync)(previousSessionFile) } : {}),
    ...(input.providerContinuationStateId ? { providerContinuationStateId: input.providerContinuationStateId } : {}),
  };
}

export type AssistantFinalizationRetrySendInput =
  SendMessageInput & {
    internal: true;
    permissionMode: PermissionMode;
    retryOfMessageId: string;
    delivery: Extract<MessageDelivery, "prompt">;
    preserveActiveThread: true;
    sessionRecovery?: RuntimeSessionRecoveryContext;
    assistantFinalizationRetry: AssistantFinalizationRetryState;
  };

export function assistantFinalizationRetryAttemptsUsedForReason(
  activeRetry: AssistantFinalizationRetryState | undefined,
  reason: AssistantFinalizationRetryReason,
  maxRetries: number,
  recoveryStateId?: string,
): number {
  if (activeRetry?.reason !== reason) return 0;
  if (recoveryStateId && activeRetry.recoveryStateId !== recoveryStateId) return 0;
  return Math.min(activeRetry.attempt, maxRetries);
}

export function buildAssistantFinalizationRetryInput(input: {
  baseInput: SendMessageInput;
  permissionMode: PermissionMode;
  retrySourceUserMessageId: string;
  attempt: number;
  maxRetries: number;
  reason: AssistantFinalizationRetryReason;
  sessionRecovery?: RuntimeSessionRecoveryContext;
  recoveryStateId?: string;
}): AssistantFinalizationRetrySendInput {
  return {
    ...input.baseInput,
    internal: true,
    permissionMode: input.permissionMode,
    retryOfMessageId: input.retrySourceUserMessageId,
    delivery: "prompt",
    preserveActiveThread: true,
    ...(input.sessionRecovery ? { sessionRecovery: input.sessionRecovery } : {}),
    assistantFinalizationRetry: {
      sourceUserMessageId: input.retrySourceUserMessageId,
      attempt: input.attempt,
      maxRetries: input.maxRetries,
      reason: input.reason,
      ...(input.recoveryStateId ? { recoveryStateId: input.recoveryStateId } : {}),
    },
  };
}
