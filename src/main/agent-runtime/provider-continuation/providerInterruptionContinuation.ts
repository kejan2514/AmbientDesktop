export const INCOMPLETE_TOOL_ARGUMENT_CONTINUATION_MAX_RETRIES = 2;
export const SHORT_INCOMPLETE_TOOL_ARGUMENT_CHAR_LIMIT = 512;
const PROVIDER_INTERRUPTION_RETRY_BACKOFF_MS = [1_000, 2_000, 3_000, 4_000, 5_000] as const;
const PROVIDER_INTERRUPTION_RETRY_MAX_DELAY_MS = 5_000;

export interface ProviderInterruptionContinuationBudgetTool {
  executionStarted: boolean;
  argumentComplete: boolean;
  inputChars?: number;
}

export interface ProviderInterruptionContinuationBudget {
  maxRetries: number;
  boundedByIncompleteToolArguments: boolean;
  reason?: "incomplete_tool_argument_stream";
}

export function providerInterruptionContinuationRetryBudget(input: {
  configuredMaxRetries: number;
  tools: readonly ProviderInterruptionContinuationBudgetTool[];
}): ProviderInterruptionContinuationBudget {
  const configuredMaxRetries = Math.max(0, Math.floor(input.configuredMaxRetries));
  const incompleteToolArgumentStreams = input.tools.filter((tool) => !tool.executionStarted && !tool.argumentComplete);
  const hasIncompleteToolArgumentStream = incompleteToolArgumentStreams.length > 0;
  if (!hasIncompleteToolArgumentStream) {
    return {
      maxRetries: configuredMaxRetries,
      boundedByIncompleteToolArguments: false,
    };
  }
  const allIncompleteArgumentStreamsAreShort = incompleteToolArgumentStreams.every((tool) => {
    const inputChars = typeof tool.inputChars === "number" && Number.isFinite(tool.inputChars) ? Math.max(0, Math.floor(tool.inputChars)) : 0;
    return inputChars > 0 && inputChars <= SHORT_INCOMPLETE_TOOL_ARGUMENT_CHAR_LIMIT;
  });
  if (allIncompleteArgumentStreamsAreShort) {
    return {
      maxRetries: configuredMaxRetries,
      boundedByIncompleteToolArguments: false,
    };
  }
  return {
    maxRetries: Math.min(configuredMaxRetries, INCOMPLETE_TOOL_ARGUMENT_CONTINUATION_MAX_RETRIES),
    boundedByIncompleteToolArguments: true,
    reason: "incomplete_tool_argument_stream",
  };
}

export function providerInterruptionContinuationRetryDelayMs(
  attempt: number,
  recoveryStateId = "provider-interruption",
): number {
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  const baseDelay = PROVIDER_INTERRUPTION_RETRY_BACKOFF_MS[
    Math.min(normalizedAttempt - 1, PROVIDER_INTERRUPTION_RETRY_BACKOFF_MS.length - 1)
  ];
  const jitterUnit = stableHash(`${recoveryStateId}:${normalizedAttempt}`) % 301;
  const jitterFactor = 0.85 + jitterUnit / 1_000;
  return Math.max(250, Math.min(PROVIDER_INTERRUPTION_RETRY_MAX_DELAY_MS, Math.round(baseDelay * jitterFactor)));
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
