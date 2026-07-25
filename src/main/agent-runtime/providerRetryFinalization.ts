import type { ChatStreamInterruptionDiagnostic } from "../agent-runtime/agentRuntimeSendStreamDiagnostics";

export interface PreOutputStreamStallRetryFinalizationInput {
  retryAttempt: number;
  maxRetries: number;
  retryDelayMs: number;
  receivedAnyText: boolean;
  streamInterruptionDiagnostic: ChatStreamInterruptionDiagnostic;
}

export interface ProviderErrorBeforeToolRetryFinalizationInput {
  retryAttempt: number;
  maxRetries: number;
  retryDelayMs: number;
  streamInterruptionDiagnostic: ChatStreamInterruptionDiagnostic;
}

export interface ProviderContextOverflowRetryFinalizationInput {
  retryAttempt: number;
  effectiveContextWindowTokens: number;
  requestedOutputTokens: number;
}

export interface ProviderRetryFinalizationMessageModel {
  content: string;
  metadata: Record<string, unknown>;
}

export function preOutputStreamStallRetryFinalizationMessage(
  input: PreOutputStreamStallRetryFinalizationInput,
): ProviderRetryFinalizationMessageModel {
  return {
    content: `Ambient/Pi stream stalled before assistant output. Retrying assistant finalization attempt ${input.retryAttempt}/${input.maxRetries} with a fresh session.`,
    metadata: {
      status: "done",
      runtime: "pi",
      provider: "ambient",
      retryingStreamStall: true,
      piStreamTimeout: {
        ...input.streamInterruptionDiagnostic,
        retryScheduled: true,
        retryUsesFreshSession: true,
        retryAttempt: input.retryAttempt,
        maxRetries: input.maxRetries,
        retryReason: "pre_output_stream_stall",
        retryDelayMs: input.retryDelayMs,
        receivedAnyText: input.receivedAnyText,
      },
    },
  };
}

export function providerErrorBeforeToolRetryFinalizationMessage(
  input: ProviderErrorBeforeToolRetryFinalizationInput,
): ProviderRetryFinalizationMessageModel {
  return {
    content: `Ambient/Pi provider failed before any tool executed. Retrying attempt ${input.retryAttempt}/${input.maxRetries} with a fresh session.`,
    metadata: {
      status: "done",
      runtime: "pi",
      provider: "ambient",
      retryingProviderError: true,
      piStreamInterruption: {
        ...input.streamInterruptionDiagnostic,
      },
    },
  };
}

export function providerContextOverflowRetryFinalizationMessage(
  input: ProviderContextOverflowRetryFinalizationInput,
): ProviderRetryFinalizationMessageModel {
  return {
    content:
      `Ambient learned the provider's effective ${input.effectiveContextWindowTokens.toLocaleString()}-token context limit, compacted the session, and is retrying the request once with ${input.requestedOutputTokens.toLocaleString()} output tokens reserved.`,
    metadata: {
      status: "done",
      runtime: "pi",
      provider: "ambient",
      retryingProviderContextOverflow: true,
      retryAttempt: input.retryAttempt,
      maxRetries: 1,
      effectiveContextWindowTokens: input.effectiveContextWindowTokens,
      requestedOutputTokens: input.requestedOutputTokens,
    },
  };
}
