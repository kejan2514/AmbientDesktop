const DEFAULT_WORKFLOW_RECORDING_REVIEW_STREAM_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_CHAT_PI_EMPTY_ASSISTANT_STALL_TIMEOUT_MS = 120_000;
const DEFAULT_POST_TOOL_CONTINUATION_IDLE_MS = 15_000;
const DEFAULT_POST_TOOL_FINALIZATION_TICK_MS = 1_000;
const ADAPTIVE_PRE_STREAM_TOKEN_STEP = 16_000;
const ADAPTIVE_PRE_STREAM_STEP_MS = 10_000;
const ADAPTIVE_PRE_STREAM_BASE_MS = 30_000;
const ADAPTIVE_PRE_STREAM_MAX_MS = 180_000;

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(resolve, ms))]);
}

export function resolveWorkflowRecordingReviewStreamIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AMBIENT_WORKFLOW_RECORDING_REVIEW_STREAM_IDLE_TIMEOUT_MS;
  if (!raw) return DEFAULT_WORKFLOW_RECORDING_REVIEW_STREAM_IDLE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_WORKFLOW_RECORDING_REVIEW_STREAM_IDLE_TIMEOUT_MS;
  return Math.max(5_000, Math.floor(parsed));
}

export function resolveChatPiEmptyAssistantStallTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  if (env.AMBIENT_E2E !== "1") return DEFAULT_CHAT_PI_EMPTY_ASSISTANT_STALL_TIMEOUT_MS;
  const raw = env.AMBIENT_CHAT_PI_EMPTY_ASSISTANT_STALL_TIMEOUT_MS;
  if (!raw) return DEFAULT_CHAT_PI_EMPTY_ASSISTANT_STALL_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CHAT_PI_EMPTY_ASSISTANT_STALL_TIMEOUT_MS;
  return Math.max(1_000, Math.floor(parsed));
}

export function resolvePostToolContinuationIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  if (env.AMBIENT_E2E !== "1") return DEFAULT_POST_TOOL_CONTINUATION_IDLE_MS;
  const raw = env.AMBIENT_POST_TOOL_CONTINUATION_IDLE_MS;
  if (!raw) return DEFAULT_POST_TOOL_CONTINUATION_IDLE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_POST_TOOL_CONTINUATION_IDLE_MS;
  return Math.max(50, Math.floor(parsed));
}

export function resolvePostToolFinalizationTickMs(env: NodeJS.ProcessEnv = process.env): number {
  if (env.AMBIENT_E2E !== "1") return DEFAULT_POST_TOOL_FINALIZATION_TICK_MS;
  const raw = env.AMBIENT_POST_TOOL_FINALIZATION_TICK_MS;
  if (!raw) return DEFAULT_POST_TOOL_FINALIZATION_TICK_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_POST_TOOL_FINALIZATION_TICK_MS;
  return Math.max(25, Math.floor(parsed));
}

export function piStreamStartTimeoutMessage(timeoutMs: number): string {
  return `Ambient/Pi did not start streaming within ${timeoutMs}ms.`;
}

export function piStreamStallTimeoutMessage(timeoutMs: number): string {
  return `Ambient/Pi stream stalled after ${timeoutMs}ms without stream activity.`;
}

export function resolveAdaptivePiPreStreamTimeoutMs(input: {
  configuredTimeoutMs: number;
  inputTokens: number;
  thinkingLevel?: string;
}): number {
  const configuredTimeoutMs = Math.max(1, Math.floor(input.configuredTimeoutMs));
  const inputTokens = Math.max(0, Math.floor(input.inputTokens));
  const tokenSteps = Math.ceil(inputTokens / ADAPTIVE_PRE_STREAM_TOKEN_STEP);
  const reasoningAllowanceMs = input.thinkingLevel === "xhigh" ? 20_000 : input.thinkingLevel === "high" ? 10_000 : 0;
  const adaptiveTimeoutMs = Math.min(
    ADAPTIVE_PRE_STREAM_MAX_MS,
    ADAPTIVE_PRE_STREAM_BASE_MS + tokenSteps * ADAPTIVE_PRE_STREAM_STEP_MS + reasoningAllowanceMs,
  );
  return Math.max(configuredTimeoutMs, adaptiveTimeoutMs);
}
