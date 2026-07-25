import {
  AmbientStreamFailureError,
  isRetryableAmbientProviderError,
  retryDelayForAttempt,
  type AmbientRetryPolicy,
} from "./aggressiveRetries";
import { readAmbientEventStreamText } from "./ambientStreamTransport";
import { normalizeAmbientBaseUrl } from "./ambientProviderFacade";

export interface AmbientChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
    text?: string;
  }>;
}

export interface AmbientChatCompletionRetryEvent {
  retryAttempt: number;
  maxRetries: number;
  delayMs: number;
  error: string;
  responseCharCount: number;
  fallbackToNonStream?: boolean;
}

export interface AmbientChatCompletionTransportTimeouts {
  preStreamResponseTimeoutMs: number;
  streamIdleTimeoutMs: number;
  streamContentIdleTimeoutMs: number;
}

const DEFAULT_AMBIENT_DIRECT_HELPER_PRE_STREAM_TIMEOUT_MS = 60_000;
const DEFAULT_AMBIENT_DIRECT_HELPER_STREAM_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_AMBIENT_DIRECT_HELPER_STREAM_CONTENT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_GMI_DIRECT_HELPER_PRE_STREAM_TIMEOUT_MS = 60_000;
const DEFAULT_GMI_DIRECT_HELPER_STREAM_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_GMI_DIRECT_HELPER_STREAM_CONTENT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_DIRECT_HELPER_NON_STREAM_RESPONSE_TIMEOUT_MS = 120_000;

export function ambientChatCompletionTransportTimeoutsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AmbientChatCompletionTransportTimeouts {
  const gmiCloud = isGmiCloudAmbientProvider(env);
  return {
    preStreamResponseTimeoutMs: positiveEnvNumber(
      env,
      "AMBIENT_DIRECT_HELPER_PRE_STREAM_TIMEOUT_MS",
      gmiCloud ? DEFAULT_GMI_DIRECT_HELPER_PRE_STREAM_TIMEOUT_MS : DEFAULT_AMBIENT_DIRECT_HELPER_PRE_STREAM_TIMEOUT_MS,
    ),
    streamIdleTimeoutMs: positiveEnvNumber(
      env,
      "AMBIENT_DIRECT_HELPER_STREAM_IDLE_TIMEOUT_MS",
      gmiCloud ? DEFAULT_GMI_DIRECT_HELPER_STREAM_IDLE_TIMEOUT_MS : DEFAULT_AMBIENT_DIRECT_HELPER_STREAM_IDLE_TIMEOUT_MS,
    ),
    streamContentIdleTimeoutMs: positiveEnvNumber(
      env,
      "AMBIENT_DIRECT_HELPER_STREAM_CONTENT_IDLE_TIMEOUT_MS",
      gmiCloud ? DEFAULT_GMI_DIRECT_HELPER_STREAM_CONTENT_IDLE_TIMEOUT_MS : DEFAULT_AMBIENT_DIRECT_HELPER_STREAM_CONTENT_IDLE_TIMEOUT_MS,
    ),
  };
}

export async function callAmbientChatCompletionTextWithRetries(input: {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  label: string;
  requestBody: Record<string, unknown>;
  retryPolicy?: AmbientRetryPolicy;
  waitForRetry?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  retryPartialStreamFailures?: boolean;
  nonStreamFallback?: {
    enabled?: boolean;
    afterStreamFailureCount?: number;
  };
  preStreamResponseTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  streamContentIdleTimeoutMs?: number;
  signal?: AbortSignal;
  validateResponseText?: (text: string) => void;
  onResponseChars?: (responseCharCount: number) => void;
  onRetry?: (event: AmbientChatCompletionRetryEvent) => void;
}): Promise<string> {
  const retryPolicy = input.retryPolicy?.enabled ? input.retryPolicy : undefined;
  const maxAttempts = retryPolicy ? retryPolicy.maxRetries + 1 : 1;
  const nonStreamFallbackAfterStreamFailureCount = input.nonStreamFallback?.enabled
    ? Math.max(1, Math.floor(input.nonStreamFallback.afterStreamFailureCount ?? 2))
    : undefined;
  let lastError: unknown;
  let forceNonStream = false;
  let streamFailureCount = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let responseCharCount = 0;
    const requestBody = forceNonStream ? { ...input.requestBody, stream: false } : input.requestBody;
    try {
      return await callAmbientChatCompletionTextOnce({
        apiKey: input.apiKey,
        baseUrl: input.baseUrl,
        fetchImpl: input.fetchImpl,
        label: input.label,
        requestBody,
        preStreamResponseTimeoutMs: input.preStreamResponseTimeoutMs,
        streamIdleTimeoutMs: input.streamIdleTimeoutMs,
        streamContentIdleTimeoutMs: input.streamContentIdleTimeoutMs,
        signal: input.signal,
        validateResponseText: input.validateResponseText,
        onResponseChars: (nextResponseCharCount) => {
          responseCharCount = nextResponseCharCount;
          input.onResponseChars?.(nextResponseCharCount);
        },
      });
    } catch (error) {
      lastError = error;
      const replayablePartialStreamFailure =
        input.retryPartialStreamFailures === true && isRetryablePartialAmbientChatCompletionStreamFailure(error);
      const replayableValidationFailure = error instanceof AmbientChatCompletionValidationError;
      const streamFallbackEligible =
        requestBody.stream === true &&
        (isRetryableAmbientChatCompletionStreamFailure(error, { retryPartialStreamFailures: input.retryPartialStreamFailures === true }) ||
          replayableValidationFailure);
      if (
        !retryPolicy ||
        input.signal?.aborted ||
        attempt >= maxAttempts ||
        (responseCharCount > 0 && !replayablePartialStreamFailure && !replayableValidationFailure) ||
        (!replayablePartialStreamFailure && !replayableValidationFailure && !isRetryableAmbientProviderError(error))
      ) {
        throw error;
      }
      if (streamFallbackEligible) streamFailureCount += 1;
      const fallbackToNonStream =
        !forceNonStream &&
        nonStreamFallbackAfterStreamFailureCount !== undefined &&
        streamFailureCount >= nonStreamFallbackAfterStreamFailureCount;
      const retryAttempt = attempt;
      const delayMs = retryDelayForAttempt(retryPolicy, retryAttempt);
      input.onRetry?.({
        retryAttempt,
        maxRetries: maxAttempts - 1,
        delayMs,
        error: errorMessage(error),
        responseCharCount,
        fallbackToNonStream,
      });
      await (input.waitForRetry ?? waitForAmbientChatCompletionRetry)(delayMs, input.signal);
      if (fallbackToNonStream) forceNonStream = true;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function callAmbientChatCompletionTextOnce(input: {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  label: string;
  requestBody: Record<string, unknown>;
  preStreamResponseTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  streamContentIdleTimeoutMs?: number;
  signal?: AbortSignal;
  validateResponseText?: (text: string) => void;
  onResponseChars?: (responseCharCount: number) => void;
}): Promise<string> {
  const streamResponse = input.requestBody.stream !== false;
  const nonStreamResponseTimeoutMs = nonStreamFallbackResponseTimeoutMs(input);
  const response = await fetchAmbientChatCompletionResponse({
    ...input,
    responseTimeoutMs: streamResponse ? input.preStreamResponseTimeoutMs : nonStreamResponseTimeoutMs,
    responseTimeoutMessage: streamResponse
      ? undefined
      : `${input.label} did not return a non-stream response within ${nonStreamResponseTimeoutMs.toLocaleString()}ms.`,
  });
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, " ").trim();
    throw new Error(detail ? `${input.label} failed (${response.status}): ${detail.slice(0, 240)}` : `${input.label} failed (${response.status}).`);
  }
  const text = await readAmbientChatCompletionText(response, {
    label: input.label,
    streamIdleTimeoutMs: input.streamIdleTimeoutMs,
    streamContentIdleTimeoutMs: input.streamContentIdleTimeoutMs,
    signal: input.signal,
    onResponseChars: input.onResponseChars,
  });
  if (input.validateResponseText) {
    try {
      input.validateResponseText(text);
    } catch (error) {
      throw new AmbientChatCompletionValidationError(input.label, text.length, error);
    }
  }
  return text;
}

export class AmbientChatCompletionValidationError extends Error {
  readonly responseCharCount: number;

  constructor(label: string, responseCharCount: number, cause: unknown) {
    super(`${label} response validation failed: ${errorMessage(cause)}`, cause === undefined ? undefined : { cause });
    this.name = "AmbientChatCompletionValidationError";
    this.responseCharCount = responseCharCount;
  }
}

export function isAmbientChatCompletionValidationError(error: unknown): error is AmbientChatCompletionValidationError {
  return error instanceof AmbientChatCompletionValidationError;
}

function nonStreamFallbackResponseTimeoutMs(input: {
  preStreamResponseTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  streamContentIdleTimeoutMs?: number;
}): number {
  return Math.max(
    positiveOptionalTimeoutMs(input.preStreamResponseTimeoutMs) ?? 0,
    positiveOptionalTimeoutMs(input.streamIdleTimeoutMs) ?? 0,
    positiveOptionalTimeoutMs(input.streamContentIdleTimeoutMs) ?? 0,
    DEFAULT_DIRECT_HELPER_NON_STREAM_RESPONSE_TIMEOUT_MS,
  );
}

function positiveOptionalTimeoutMs(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

async function fetchAmbientChatCompletionResponse(input: {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  label: string;
  requestBody: Record<string, unknown>;
  preStreamResponseTimeoutMs?: number;
  responseTimeoutMs?: number;
  responseTimeoutMessage?: string;
  signal?: AbortSignal;
}): Promise<Response> {
  const responseTimeoutMs = Math.max(1, Math.floor(input.responseTimeoutMs ?? input.preStreamResponseTimeoutMs ?? 60_000));
  const controller = new AbortController();
  const onAbort = () => {
    controller.abort(
      new AmbientStreamFailureError(
        "user_abort",
        input.signal?.reason instanceof Error ? input.signal.reason.message : `${input.label} request was canceled.`,
        { cause: input.signal?.reason },
      ),
    );
  };
  const timeout = setTimeout(
    () =>
      controller.abort(
        new AmbientStreamFailureError(
          "pre_stream_timeout",
          input.responseTimeoutMessage ?? `${input.label} did not start streaming within ${responseTimeoutMs.toLocaleString()}ms.`,
        ),
      ),
    responseTimeoutMs,
  );
  try {
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener("abort", onAbort, { once: true });
    return await (input.fetchImpl ?? fetch)(`${normalizeAmbientBaseUrl(input.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify(input.requestBody),
    });
  } catch (error) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      throw reason instanceof Error ? reason : new Error(String(reason || `${input.label} request was aborted.`));
    }
    throw new AmbientStreamFailureError("network_abort", `${input.label} request failed before response: ${errorMessage(error)}`, { cause: error });
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onAbort);
  }
}

async function readAmbientChatCompletionText(
  response: Response,
  input: {
    label: string;
    streamIdleTimeoutMs?: number;
    streamContentIdleTimeoutMs?: number;
    signal?: AbortSignal;
    onResponseChars?: (responseCharCount: number) => void;
  },
): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const payload = (await response.json()) as AmbientChatCompletionResponse;
    const content = payload.choices?.[0]?.message?.content ?? payload.choices?.[0]?.text ?? "";
    input.onResponseChars?.(content.length);
    return content;
  }
  if (!response.body) return "";
  return readAmbientEventStreamText(response.body, {
    idleTimeoutMs: input.streamIdleTimeoutMs ?? 120_000,
    contentIdleTimeoutMs: input.streamContentIdleTimeoutMs,
    signal: input.signal,
    onText: (_text, responseCharCount) => input.onResponseChars?.(responseCharCount),
    stalledMessage: ({ idleTimeoutMs, responseCharCount }) =>
      `${input.label} stream stalled after ${idleTimeoutMs.toLocaleString()}ms without streaming events ` +
      `(${responseCharCount.toLocaleString()} response characters received).`,
    contentStalledMessage: ({ contentIdleTimeoutMs, responseCharCount }) =>
      `${input.label} stream stalled after ${contentIdleTimeoutMs.toLocaleString()}ms without model content ` +
      `(${responseCharCount.toLocaleString()} response characters received).`,
  });
}

function waitForAmbientChatCompletionRetry(ms: number, signal?: AbortSignal): Promise<void> {
  const delayMs = Math.max(0, Math.floor(ms));
  if (delayMs === 0) {
    if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Ambient retry canceled."));
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timeout) clearTimeout(timeout);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Ambient retry canceled."));
    };
    timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isGmiCloudAmbientProvider(env: NodeJS.ProcessEnv): boolean {
  const raw = (env.AMBIENT_PROVIDER || env.AMBIENT_LLM_PROVIDER || "").trim().toLowerCase();
  return ["gmi", "gmi-cloud", "gmicloud", "gmi_cloud"].includes(raw);
}

function positiveEnvNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function isRetryablePartialAmbientChatCompletionStreamFailure(error: unknown): boolean {
  return isRetryableAmbientChatCompletionStreamFailure(error, { retryPartialStreamFailures: true }) && (error.responseCharCount ?? 0) > 0;
}

function isRetryableAmbientChatCompletionStreamFailure(
  error: unknown,
  input: { retryPartialStreamFailures: boolean },
): error is AmbientStreamFailureError {
  if (!(error instanceof AmbientStreamFailureError)) return false;
  if (error.kind === "user_abort" || error.kind === "pre_stream_timeout" || error.toolCallSeen) return false;
  if (!["stream_idle_timeout", "stream_closed_before_done"].includes(error.kind)) return false;
  if (error.semanticOutputSeen && !input.retryPartialStreamFailures) return false;
  return true;
}
