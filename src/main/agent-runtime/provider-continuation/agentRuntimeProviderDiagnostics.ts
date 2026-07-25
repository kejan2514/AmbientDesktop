import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  AmbientStreamFailureError,
  isRetryableAmbientProviderError,
  parseAmbientProviderContextOverflow,
  type AmbientProviderContextOverflow,
  type AmbientStreamFailureKind,
} from "../agentRuntimeAmbientFacade";
import { redactSensitiveText } from "../agentRuntimeSecurityFacade";
import type { ProviderStatus } from "../../../shared/desktopTypes";
import type { ProviderInterruptionToolSnapshot } from "./agentRuntimeProviderContinuationHelpers";

export interface PiStreamTraceReference {
  path: string;
  eventCount: number;
  recentEventCount: number;
  reason: string;
  recordedAt: string;
  promptStartLine?: number;
  promptUserLine?: number;
  promptContentSha256?: string;
}

export interface RuntimeProviderErrorDiagnostic {
  name?: string;
  message: string;
  code?: string;
  type?: string;
  status?: string | number;
  statusCode?: string | number;
  requestId?: string;
  traceId?: string;
  retryAfter?: string | number;
  cause?: {
    name?: string;
    message: string;
  };
  headers?: Record<string, string>;
  bodyPreview?: string;
  detailPreview?: string;
  stackPreview?: string;
  contextOverflow?: AmbientProviderContextOverflow;
}

export type RuntimeProviderFailureIdleSource =
  | "pre_stream_response"
  | "stream_idle"
  | "stream_closed_before_done"
  | "provider_error_event"
  | "network_abort"
  | "user_abort";

export interface RuntimeProviderFailureDiagnostic {
  diagnosticId: string;
  providerId: string;
  providerLabel: string;
  model: string;
  kind: AmbientStreamFailureKind;
  message: string;
  occurredAt: string;
  runStartedAt: string;
  durationMs: number;
  error: RuntimeProviderErrorDiagnostic;
  httpStatus?: string | number;
  errorCode?: string;
  requestId?: string;
  traceId?: string;
  retryAfter?: string | number;
  providerErrorBodyPreview?: string;
  stream: {
    eventCount: number;
    approximatePayloadBytes: number;
    preStreamTimeoutMs: number;
    streamIdleTimeoutMs: number;
    firstEventAt?: string;
    firstEventType?: string;
    lastEventAt?: string;
    lastEventType?: string;
    idleSource: RuntimeProviderFailureIdleSource;
    firstVisibleTextAt?: string;
    firstToolArgumentAt?: string;
    firstToolExecutionStartedAt?: string;
    assistantOutputChars: number;
    thinkingOutputChars: number;
    currentAssistantFinalTextChars: number;
    semanticOutputSeen: boolean;
    receivedAnyText: boolean;
    trace?: PiStreamTraceReference;
  };
  retry: {
    scheduled: boolean;
    replaySafe: boolean;
    continuationSafe?: boolean;
    usesFreshSession?: boolean;
    attempt?: number;
    maxRetries?: number;
    reason?: string;
    delayMs?: number;
    providerRetryAttemptCount?: number;
    providerRetryLastError?: string;
  };
  transcript: {
    toolCallSeen: boolean;
    toolMessageCount: number;
    openToolCallCount: number;
    completedToolMessageCount: number;
    interruptedToolCalls?: ProviderInterruptionToolSnapshot[];
  };
  sessionFile?: string;
}

export function isAmbientProviderAuthFailure(
  diagnostic: RuntimeProviderErrorDiagnostic | undefined,
  provider: ProviderStatus,
): boolean {
  if (!provider.hasApiKey) return true;
  if (!diagnostic) return false;
  const status = diagnosticHttpStatus(diagnostic.status) ?? diagnosticHttpStatus(diagnostic.statusCode);
  if (status === 401 || status === 403) return true;
  const text = [
    diagnostic.message,
    diagnostic.code,
    diagnostic.type,
    diagnostic.cause?.message,
    diagnostic.detailPreview,
    diagnostic.bodyPreview,
  ].filter(Boolean).join("\n");
  return /\b(?:401|403|unauthori[sz]ed|forbidden|invalid(?:\s+\w+){0,4}\s+api\s*key|api\s*key(?:\s+\w+){0,4}\s+invalid|authentication\s+failed|missing\s+api\s*key)\b/i.test(text);
}

function diagnosticHttpStatus(value: string | number | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function isContinuableAmbientProviderInterruption(error: unknown): boolean {
  if (error instanceof AmbientStreamFailureError) {
    if (error.kind === "pre_stream_timeout") return false;
    if (error.kind === "user_abort") return false;
    if (/\b(?:api key|unauthori[sz]ed|forbidden|invalid request|schema|validation|permission)\b/i.test(error.message)) return false;
    return true;
  }
  return isRetryableAmbientProviderError(error);
}

export function buildChatStreamInterruptionNotice(input: {
  message: string;
  toolMessageCount: number;
  semanticOutputSeen: boolean;
}): string {
  if (input.toolMessageCount > 0) {
    return [
      "Ambient/Pi stream interrupted after tool activity. Ambient did not replay the original request automatically because that could duplicate tool side effects.",
      input.message,
    ].join("\n\n");
  }
  if (input.semanticOutputSeen) {
    return [
      "Ambient/Pi stream interrupted after visible output. The request was not replayed automatically.",
      input.message,
    ].join("\n\n");
  }
  return ["Ambient/Pi stream interrupted.", input.message].join("\n\n");
}

export function runtimeProviderErrorDiagnostic(error: unknown): RuntimeProviderErrorDiagnostic {
  const object = error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  const response = objectValue(object, "response");
  const headers = providerDiagnosticHeaders(object, response);
  const requestId =
    firstDiagnosticString(object, ["requestId", "request_id", "xRequestId", "x-request-id", "correlationId", "correlation_id"]) ??
    firstDiagnosticHeader(headers, ["request-id", "x-request-id", "x-correlation-id", "correlation-id"]);
  const traceId =
    firstDiagnosticString(object, ["traceId", "trace_id", "xTraceId", "x-trace-id", "cfRay", "cf-ray"]) ??
    firstDiagnosticHeader(headers, ["trace-id", "x-trace-id", "traceparent", "cf-ray"]);
  const retryAfter =
    firstDiagnosticPrimitive(object, ["retryAfter", "retry_after"]) ?? firstDiagnosticHeader(headers, ["retry-after"]);
  const status = firstDiagnosticPrimitive(object, ["status"]) ?? firstDiagnosticPrimitive(response, ["status"]);
  const statusCode =
    firstDiagnosticPrimitive(object, ["statusCode", "httpStatus"]) ?? firstDiagnosticPrimitive(response, ["statusCode", "status"]);
  const cause = error instanceof Error && error.cause instanceof Error
    ? {
        ...(error.cause.name ? { name: error.cause.name } : {}),
        message: truncateDiagnosticText(error.cause.message, 500),
      }
    : undefined;
  const contextOverflow = parseAmbientProviderContextOverflow(error);
  const bodyPreview =
    firstDiagnosticString(object, ["body", "responseBody"]) ??
    firstDiagnosticString(response, ["body", "responseBody"]);
  const detailPreview =
    bodyPreview ??
    firstDiagnosticString(object, ["detail", "details", "data", "payload", "error"]) ??
    firstDiagnosticString(response, ["detail", "details", "data", "payload", "error"]);
  const stackPreview = error instanceof Error && error.stack
    ? truncateDiagnosticText(
        error.stack
          .split("\n")
          .slice(0, 4)
          .join("\n"),
        1_000,
      )
    : undefined;
  return {
    ...(error instanceof Error && error.name ? { name: error.name } : {}),
    message: truncateDiagnosticText(error instanceof Error ? error.message : String(error), 1_000),
    ...(firstDiagnosticString(object, ["code", "errorCode"]) ? { code: firstDiagnosticString(object, ["code", "errorCode"]) } : {}),
    ...(firstDiagnosticString(object, ["type", "errorType"]) ? { type: firstDiagnosticString(object, ["type", "errorType"]) } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(requestId ? { requestId } : {}),
    ...(traceId ? { traceId } : {}),
    ...(retryAfter !== undefined ? { retryAfter } : {}),
    ...(cause ? { cause } : {}),
    ...(contextOverflow ? { contextOverflow } : {}),
    ...(headers ? { headers } : {}),
    ...(bodyPreview ? { bodyPreview: truncateDiagnosticText(bodyPreview, 1_000) } : {}),
    ...(detailPreview ? { detailPreview: truncateDiagnosticText(detailPreview, 1_000) } : {}),
    ...(stackPreview ? { stackPreview } : {}),
  };
}

export function buildRuntimeProviderFailureDiagnostic(input: {
  providerStatus: ProviderStatus;
  kind: AmbientStreamFailureKind;
  message: string;
  runStartedAt: string;
  error: RuntimeProviderErrorDiagnostic;
  retryScheduled: boolean;
  replaySafe: boolean;
  continuationSafe?: boolean;
  usesFreshSession?: boolean;
  retryAttempt?: number;
  maxRetries?: number;
  retryReason?: string;
  retryDelayMs?: number;
  providerRetryAttemptCount?: number;
  providerRetryLastError?: string;
  stream: RuntimeProviderFailureDiagnostic["stream"];
  transcript: RuntimeProviderFailureDiagnostic["transcript"];
  sessionFile?: string;
}): RuntimeProviderFailureDiagnostic {
  const occurredAtDate = new Date();
  const durationMs = Math.max(0, occurredAtDate.getTime() - Date.parse(input.runStartedAt));
  const httpStatus = input.error.status ?? input.error.statusCode;
  const diagnosticId = `provider-failure-${occurredAtDate.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  return {
    diagnosticId,
    providerId: input.providerStatus.providerId,
    providerLabel: input.providerStatus.providerLabel,
    model: input.providerStatus.model,
    kind: input.kind,
    message: truncateDiagnosticText(input.message, 1_000),
    occurredAt: occurredAtDate.toISOString(),
    runStartedAt: input.runStartedAt,
    durationMs,
    error: input.error,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(input.error.code ? { errorCode: input.error.code } : {}),
    ...(input.error.requestId ? { requestId: input.error.requestId } : {}),
    ...(input.error.traceId ? { traceId: input.error.traceId } : {}),
    ...(input.error.retryAfter !== undefined ? { retryAfter: input.error.retryAfter } : {}),
    ...(input.error.bodyPreview ? { providerErrorBodyPreview: input.error.bodyPreview } : {}),
    stream: input.stream,
    retry: {
      scheduled: input.retryScheduled,
      replaySafe: input.replaySafe,
      ...(input.continuationSafe !== undefined ? { continuationSafe: input.continuationSafe } : {}),
      ...(input.usesFreshSession !== undefined ? { usesFreshSession: input.usesFreshSession } : {}),
      ...(input.retryAttempt !== undefined ? { attempt: input.retryAttempt } : {}),
      ...(input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {}),
      ...(input.retryReason ? { reason: input.retryReason } : {}),
      ...(input.retryDelayMs !== undefined ? { delayMs: input.retryDelayMs } : {}),
      ...(input.providerRetryAttemptCount !== undefined ? { providerRetryAttemptCount: input.providerRetryAttemptCount } : {}),
      ...(input.providerRetryLastError ? { providerRetryLastError: input.providerRetryLastError } : {}),
    },
    transcript: input.transcript,
    ...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
  };
}

function objectValue(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = record?.[key];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function providerDiagnosticHeaders(
  object: Record<string, unknown> | undefined,
  response: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  const headers = headersRecord(object?.headers) ?? headersRecord(response?.headers);
  if (!headers) return undefined;
  const diagnosticHeaders = Object.fromEntries(
    Object.entries(headers)
      .filter(([key]) => isDiagnosticHeaderKey(key))
      .map(([key, value]) => [key.toLowerCase(), truncateDiagnosticText(value, 500)]),
  );
  return Object.keys(diagnosticHeaders).length ? diagnosticHeaders : undefined;
}

function headersRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (typeof (value as { entries?: unknown }).entries === "function") {
    try {
      const entries = Array.from((value as { entries: () => Iterable<[unknown, unknown]> }).entries());
      return Object.fromEntries(
        entries
          .filter(([key, entryValue]) => typeof key === "string" && entryValue !== undefined)
          .map(([key, entryValue]) => [key as string, String(entryValue)]),
      );
    } catch {
      return undefined;
    }
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => typeof entryValue === "string" || typeof entryValue === "number")
      .map(([key, entryValue]) => [key, String(entryValue)]),
  );
}

function isDiagnosticHeaderKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized === "date" ||
    normalized === "content-type" ||
    normalized === "retry-after" ||
    normalized === "server" ||
    normalized === "cf-ray" ||
    normalized.includes("request-id") ||
    normalized.includes("correlation-id") ||
    normalized.includes("trace")
  );
}

function firstDiagnosticHeader(headers: Record<string, string> | undefined, keys: string[]): string | undefined {
  if (!headers) return undefined;
  for (const key of keys) {
    const value = headers[key.toLowerCase()];
    if (value?.trim()) return truncateDiagnosticText(value.trim(), 500);
  }
  return undefined;
}

export function runtimeProviderFailureIdleSource(kind: AmbientStreamFailureKind): RuntimeProviderFailureIdleSource {
  switch (kind) {
    case "pre_stream_timeout":
      return "pre_stream_response";
    case "stream_idle_timeout":
      return "stream_idle";
    case "stream_closed_before_done":
      return "stream_closed_before_done";
    case "provider_error_event":
      return "provider_error_event";
    case "network_abort":
      return "network_abort";
    case "user_abort":
      return "user_abort";
  }
}

export function normalizedPiEventType(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const type = (event as { type?: unknown }).type;
  return typeof type === "string" && type.trim() ? type.trim() : undefined;
}

export function countJsonlEntries(path: string): number | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line.trim()).length;
  } catch {
    return undefined;
  }
}

export function approximateDiagnosticPayloadBytes(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return 0;
  }
}

export function piStreamTraceEventDetails(event: unknown): Record<string, unknown> | undefined {
  if (!event || typeof event !== "object") return undefined;
  const record = event as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : undefined;
  if (type === "message_start" || type === "message_end") {
    const message = objectValue(record, "message");
    const role = typeof message?.role === "string" ? message.role : undefined;
    return compactDiagnosticObject({
      role,
      stopReason: firstDiagnosticPrimitive(message, ["stopReason"]),
      error: firstDiagnosticString(message, ["errorMessage"]),
      textChars: piMessageText(message).length,
      toolCallCount: piMessageToolCallCount(message),
      contentBlockCount: Array.isArray(message?.content) ? message.content.length : undefined,
    });
  }
  if (type === "message_update") {
    const update = objectValue(record, "assistantMessageEvent");
    const partial = objectValue(update, "partial");
    return compactDiagnosticObject({
      updateType: firstDiagnosticPrimitive(update, ["type"]),
      deltaChars: typeof update?.delta === "string" ? update.delta.length : undefined,
      textPreview: typeof update?.delta === "string" ? truncateDiagnosticText(redactSensitiveText(update.delta), 160) : undefined,
      partialRole: typeof partial?.role === "string" ? partial.role : undefined,
      toolCallId: firstDiagnosticPrimitive(update, ["toolCallId", "id"]),
      toolName: firstDiagnosticPrimitive(update, ["toolName", "name"]),
    });
  }
  if (type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end") {
    return compactDiagnosticObject({
      toolCallId: firstDiagnosticPrimitive(record, ["toolCallId", "id"]),
      toolName: firstDiagnosticPrimitive(record, ["toolName", "name"]),
      isError: Boolean(record.isError),
      status: firstDiagnosticPrimitive(record, ["status"]),
    });
  }
  if (type === "agent_end") {
    const messages = Array.isArray(record.messages) ? record.messages.filter((message) => message && typeof message === "object") as Record<string, unknown>[] : [];
    const assistantMessages = messages.filter((message) => message.role === "assistant");
    return compactDiagnosticObject({
      messageCount: messages.length,
      assistantCount: assistantMessages.length,
      assistantTextChars: assistantMessages.reduce((sum, message) => sum + piMessageText(message).length, 0),
      assistantToolCallCount: assistantMessages.reduce((sum, message) => sum + piMessageToolCallCount(message), 0),
    });
  }
  if (type === "queue_update") {
    return compactDiagnosticObject({
      steeringCount: Array.isArray(record.steering) ? record.steering.length : undefined,
      followUpCount: Array.isArray(record.followUp) ? record.followUp.length : undefined,
    });
  }
  if (type === "auto_retry_start" || type === "auto_retry_end") {
    return compactDiagnosticObject({
      attempt: firstDiagnosticPrimitive(record, ["attempt"]),
      maxAttempts: firstDiagnosticPrimitive(record, ["maxAttempts"]),
      delayMs: firstDiagnosticPrimitive(record, ["delayMs"]),
      success: typeof record.success === "boolean" ? record.success : undefined,
      error: firstDiagnosticString(record, ["errorMessage", "finalError"]),
    });
  }
  return undefined;
}

function compactDiagnosticObject(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const compact = Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== ""));
  return Object.keys(compact).length ? compact : undefined;
}

function piMessageText(message: Record<string, unknown> | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const record = block as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") return record.text;
      return "";
    })
    .join("");
}

function piMessageToolCallCount(message: Record<string, unknown> | undefined): number {
  const content = message?.content;
  if (!Array.isArray(content)) return 0;
  return content.filter((block) => block && typeof block === "object" && (block as Record<string, unknown>).type === "toolCall").length;
}

function firstDiagnosticString(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return truncateDiagnosticText(value, 1_000);
    if (value && typeof value === "object") {
      try {
        return truncateDiagnosticText(JSON.stringify(value), 1_000);
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

function firstDiagnosticPrimitive(record: Record<string, unknown> | undefined, keys: string[]): string | number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return redactSensitiveText(value.trim());
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function truncateDiagnosticText(value: string, maxChars: number): string {
  const redacted = redactSensitiveText(value.replace(/\s+$/g, ""));
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, Math.max(0, maxChars - 3))}...`;
}

export function compactToolInputPreview(input: string | undefined): string | undefined {
  const cleaned = redactSensitiveText(input?.replace(/\s+/g, " ").trim() ?? "");
  if (!cleaned) return undefined;
  return cleaned.length <= 240 ? cleaned : `${cleaned.slice(0, 237)}...`;
}
