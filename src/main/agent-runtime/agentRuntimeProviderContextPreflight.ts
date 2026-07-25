import { closeSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

import {
  estimateTokensFromBytes,
  summarizeProviderPayload,
  type ProviderPayloadAccounting,
} from "../../shared/contextAccounting";
import {
  AMBIENT_CONTEXT_SAFETY_MARGIN_TOKENS,
  ambientProviderInputTokenBudget,
} from "./agentRuntimeAmbientFacade";
import {
  materializeTextOutput,
  materializedTextNotice,
  type MaterializedTextOutput,
} from "./agentRuntimeToolRuntimeFacade";

export const DEFAULT_PROVIDER_CONTEXT_TEXT_PREVIEW_CHARS = 8_192;
export const DEFAULT_PROVIDER_CONTEXT_OFFLOAD_TEXT_CHARS = 16_384;
const DRY_RUN_NOTICE_CHARS = 700;
const BLOCK_REPORT_PREVIEW_CHARS = 4_096;
const CIRCULAR_JSON_OVERHEAD_BYTES = 64;
const EXISTING_NOTICE_VALIDATION_CHARS = 4_096;

export interface ProviderContextPreflightBudget {
  contextWindow: number;
  reserveTokens: number;
  hardPreflightPercent: number;
  requestedOutputTokens?: number;
  safetyMarginTokens?: number;
}

export interface ProviderContextPreflightOptions extends ProviderContextPreflightBudget {
  workspacePath: string;
  textPreviewChars?: number;
  offloadTextChars?: number;
  getContextWindow?: () => number | undefined;
}

export interface ProviderContextMaterializedOutput {
  messageIndex: number;
  role: string;
  path: string;
  label: string;
  totalChars: number;
  previewChars: number;
  redacted: boolean;
  redactionCount: number;
  artifactPath?: string;
  artifactBytes?: number;
}

export interface ProviderPayloadContextProtectionEstimate {
  beforeBytes: number;
  afterBytes: number;
  beforeTokens: number;
  afterTokens: number;
  largeTextCount: number;
  largestTextChars: number;
}

export interface ProviderPayloadContextMaterializationResult {
  payload: unknown;
  changed: boolean;
  blocked: boolean;
  before: ProviderPayloadAccounting;
  after: ProviderPayloadAccounting;
  materializedOutputs: ProviderContextMaterializedOutput[];
  blockArtifactPath?: string;
}

export interface ProviderCallContextPreflightSession {
  sessionFile?: string;
  sessionManager?: {
    buildSessionContext?: () => { messages?: unknown[] };
    getEntries?: () => unknown[];
  };
}

export interface RunProviderCallContextPreflightBeforePromptInput extends ProviderContextPreflightOptions {
  threadId: string;
  session: ProviderCallContextPreflightSession;
  promptContent: string;
}

export interface ProviderContextPreflightBlockErrorDetails {
  threadId: string;
  workspacePath: string;
  sessionFile?: string;
  budgetTokens: number;
  estimate: ProviderPayloadContextProtectionEstimate;
  artifactPath?: string;
  largeTextHint: string;
}

export class ProviderContextPreflightBlockError extends Error {
  readonly details: ProviderContextPreflightBlockErrorDetails;

  constructor(message: string, details: ProviderContextPreflightBlockErrorDetails) {
    super(message);
    this.name = "ProviderContextPreflightBlockError";
    this.details = details;
    Object.setPrototypeOf(this, ProviderContextPreflightBlockError.prototype);
  }
}

export function isProviderContextPreflightBlockError(error: unknown): error is ProviderContextPreflightBlockError {
  if (error instanceof ProviderContextPreflightBlockError) return true;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message.includes("Ambient/Pi provider call blocked before streaming") && message.includes("protected context");
}

interface ProviderTextPart {
  messageIndex: number;
  role: string;
  path: string;
  label: string;
  text: string;
}

interface ReplaceProviderPayloadTextResult {
  payload: unknown;
  changed: boolean;
  outputs: ProviderContextMaterializedOutput[];
}

interface NormalizedProviderContextOptions {
  textPreviewChars: number;
  offloadTextChars: number;
}

export function createProviderCallContextPreflightExtension(options: ProviderContextPreflightOptions): ExtensionFactory {
  return (pi) => {
    (pi as any).on("before_provider_request", async (event: any) => {
      let requestOptions = options;
      try {
        requestOptions = providerContextPreflightOptionsForRequest(options, event.payload);
        const result = await materializeProviderPayloadContext({
          payload: event.payload,
          options: requestOptions,
        });
        return result.changed ? result.payload : undefined;
      } catch (error) {
        return providerContextMaterializationFailurePayload(event.payload, requestOptions, error);
      }
    });
  };
}

export async function runProviderCallContextPreflightBeforePrompt(
  input: RunProviderCallContextPreflightBeforePromptInput,
): Promise<void> {
  const payload = providerContextPayloadFromSession(input.session, input.promptContent);
  if (!payload) return;

  const estimate = estimateProviderPayloadContextProtection(payload, input);
  const budgetTokens = providerContextPreflightTokenBudget(input);
  if (estimate.afterTokens <= budgetTokens) return;

  const report = providerContextBlockReport({
    threadId: input.threadId,
    sessionFile: input.session.sessionFile,
    budgetTokens,
    estimate,
  });
  const reportArtifact = await materializeTextOutput(input.workspacePath, {
    label: "provider-context-preflight-block",
    text: report,
    maxPreviewChars: BLOCK_REPORT_PREVIEW_CHARS,
    alwaysWriteArtifact: true,
  });
  const artifactHint = reportArtifact.artifactPath ? ` Diagnostic artifact: ${reportArtifact.artifactPath}.` : "";
  const largeTextHint = estimate.largeTextCount > 0
    ? ` ${estimate.largeTextCount} oversized text part(s) were eligible for deterministic offload, but the protected context is still too large.`
    : " No single oversized text part was available for deterministic offload.";
  const message =
    `Ambient/Pi provider call blocked before streaming because the protected context is estimated at ${formatCount(estimate.afterTokens)} tokens, above the ${formatCount(budgetTokens)} token safety budget.${largeTextHint}${artifactHint} Compact or start a fresh thread, then use file_read or long_context_process for large artifacts instead of replaying the full transcript.`;
  throw new ProviderContextPreflightBlockError(message, {
    threadId: input.threadId,
    workspacePath: input.workspacePath,
    sessionFile: input.session.sessionFile,
    budgetTokens,
    estimate,
    artifactPath: reportArtifact.artifactPath,
    largeTextHint,
  });
}

export async function materializeProviderPayloadContext(input: {
  payload: unknown;
  options: ProviderContextPreflightOptions;
}): Promise<ProviderPayloadContextMaterializationResult> {
  const before = summarizeProviderPayload(input.payload);
  const replacement = await replaceProviderPayloadText(input.payload, input.options, async (part, options) => {
    const preserved = providerContextPreservedMaterializedReplacement(part, options.textPreviewChars, input.options.workspacePath);
    if (preserved) return preserved;
    const output = await materializeTextOutput(input.options.workspacePath, {
      label: part.label,
      text: part.text,
      maxPreviewChars: options.textPreviewChars,
    });
    return {
      text: providerContextMaterializedText(part, output),
      output,
    };
  });
  const payload = replacement.changed ? replacement.payload : input.payload;
  const protectedAccounting = summarizeProviderPayload(payload);
  const originalBytes = estimateUnboundedJsonByteLength(input.payload);
  const protectedBytes = estimateUnboundedJsonByteLength(payload);
  const protectedTokens = estimateTokensFromBytes(protectedBytes);
  const budgetTokens = providerContextPreflightTokenBudget(input.options);
  if (protectedTokens > budgetTokens) {
    const estimate: ProviderPayloadContextProtectionEstimate = {
      beforeBytes: originalBytes,
      afterBytes: protectedBytes,
      beforeTokens: estimateTokensFromBytes(originalBytes),
      afterTokens: protectedTokens,
      largeTextCount: replacement.outputs.length,
      largestTextChars: replacement.outputs.reduce((largest, output) => Math.max(largest, output.totalChars), 0),
    };
    const reportArtifact = await materializeTextOutput(input.options.workspacePath, {
      label: "provider-context-preflight-provider-payload-block",
      text: providerContextBlockReport({
        threadId: "provider-payload",
        budgetTokens,
        estimate,
      }),
      maxPreviewChars: BLOCK_REPORT_PREVIEW_CHARS,
      alwaysWriteArtifact: true,
    });
    const blockedPayload = providerContextBlockedPayload(payload, {
      budgetTokens,
      protectedTokens,
      artifactPath: reportArtifact.artifactPath,
    });
    return {
      payload: blockedPayload,
      changed: true,
      blocked: true,
      before,
      after: summarizeProviderPayload(blockedPayload),
      materializedOutputs: replacement.outputs,
      blockArtifactPath: reportArtifact.artifactPath,
    };
  }
  return {
    payload,
    changed: replacement.changed,
    blocked: false,
    before,
    after: protectedAccounting,
    materializedOutputs: replacement.outputs,
  };
}

export function estimateProviderPayloadContextProtection(
  payload: unknown,
  options: Partial<Pick<ProviderContextPreflightOptions, "workspacePath" | "textPreviewChars" | "offloadTextChars">> = {},
): ProviderPayloadContextProtectionEstimate {
  const beforeBytes = estimateUnboundedJsonByteLength(payload);
  const normalized = normalizeProviderContextOptions(options);
  const dryPayload = replaceProviderPayloadTextSync(payload, normalized, (part) => {
    const preserved = providerContextPreservedMaterializedReplacement(part, normalized.textPreviewChars, options.workspacePath);
    return preserved?.text ?? providerContextDryRunText(part, normalized.textPreviewChars);
  });
  const afterBytes = estimateUnboundedJsonByteLength(dryPayload.payload);
  return {
    beforeBytes,
    afterBytes,
    beforeTokens: estimateTokensFromBytes(beforeBytes),
    afterTokens: estimateTokensFromBytes(afterBytes),
    largeTextCount: dryPayload.largeTextCount,
    largestTextChars: dryPayload.largestTextChars,
  };
}

export function providerContextPreflightTokenBudget(input: ProviderContextPreflightBudget): number {
  const contextWindow = Math.max(1, Math.floor(input.contextWindow));
  const reserveBudget = input.requestedOutputTokens === undefined
    ? Math.max(1, contextWindow - Math.max(0, Math.floor(input.reserveTokens)))
    : ambientProviderInputTokenBudget({
        contextWindowTokens: contextWindow,
        requestedOutputTokens: input.requestedOutputTokens,
        configuredReserveTokens: input.reserveTokens,
        safetyMarginTokens: input.safetyMarginTokens ?? AMBIENT_CONTEXT_SAFETY_MARGIN_TOKENS,
      });
  const hardPreflightPercent = input.hardPreflightPercent > 0 ? input.hardPreflightPercent : 100;
  const percentBudget = Math.max(1, Math.floor(contextWindow * (hardPreflightPercent / 100)));
  return Math.min(reserveBudget, percentBudget);
}

export function estimateUnboundedJsonByteLength(value: unknown): number {
  return estimateUnboundedJsonByteLengthInternal(value, new WeakSet<object>());
}

function providerContextPreflightOptionsForRequest(
  options: ProviderContextPreflightOptions,
  payload?: unknown,
): ProviderContextPreflightOptions {
  const payloadRecord = objectRecord(payload);
  const requestedOutputTokens = numberField(payloadRecord?.max_completion_tokens) ?? numberField(payloadRecord?.max_tokens);
  return {
    ...options,
    contextWindow: numberField(options.getContextWindow?.()) ?? options.contextWindow,
    ...(requestedOutputTokens ? { requestedOutputTokens } : {}),
  };
}

async function replaceProviderPayloadText(
  payload: unknown,
  rawOptions: Pick<ProviderContextPreflightOptions, "textPreviewChars" | "offloadTextChars">,
  replace: (
    part: ProviderTextPart,
    options: NormalizedProviderContextOptions,
  ) => Promise<{ text: string; output: MaterializedTextOutput }>,
): Promise<ReplaceProviderPayloadTextResult> {
  const options = normalizeProviderContextOptions(rawOptions);
  const record = objectRecord(payload);
  const messages = Array.isArray(record?.messages) ? record.messages : undefined;
  if (!record || !messages) return { payload, changed: false, outputs: [] };

  let changed = false;
  const outputs: ProviderContextMaterializedOutput[] = [];
  const nextMessages: unknown[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const result = await replaceProviderMessageText(messages[index], index, options, replace);
    nextMessages.push(result.message);
    changed = changed || result.changed;
    outputs.push(...result.outputs);
  }

  return {
    payload: changed ? { ...record, messages: nextMessages } : payload,
    changed,
    outputs,
  };
}

function replaceProviderPayloadTextSync(
  payload: unknown,
  options: NormalizedProviderContextOptions,
  replace: (part: ProviderTextPart) => string,
): { payload: unknown; changed: boolean; largeTextCount: number; largestTextChars: number } {
  const record = objectRecord(payload);
  const messages = Array.isArray(record?.messages) ? record.messages : undefined;
  if (!record || !messages) {
    return {
      payload,
      changed: false,
      largeTextCount: 0,
      largestTextChars: 0,
    };
  }

  let changed = false;
  let largeTextCount = 0;
  let largestTextChars = 0;
  const nextMessages = messages.map((message, index) => {
    const result = replaceProviderMessageTextSync(message, index, options, replace);
    changed = changed || result.changed;
    largeTextCount += result.largeTextCount;
    largestTextChars = Math.max(largestTextChars, result.largestTextChars);
    return result.message;
  });
  return {
    payload: changed ? { ...record, messages: nextMessages } : payload,
    changed,
    largeTextCount,
    largestTextChars,
  };
}

async function replaceProviderMessageText(
  message: unknown,
  messageIndex: number,
  options: NormalizedProviderContextOptions,
  replace: (
    part: ProviderTextPart,
    options: NormalizedProviderContextOptions,
  ) => Promise<{ text: string; output: MaterializedTextOutput }>,
): Promise<{ message: unknown; changed: boolean; outputs: ProviderContextMaterializedOutput[] }> {
  const record = objectRecord(message);
  if (!record) return { message, changed: false, outputs: [] };

  const role = stringField(record.role) ?? "message";
  if (!isOffloadableProviderMessage(record)) return { message, changed: false, outputs: [] };
  const content = record.content;
  if (typeof content === "string") {
    const part = providerTextPart({ messageIndex, role, path: `messages[${messageIndex}].content`, text: content });
    if (!shouldOffloadText(part.text, options)) return { message, changed: false, outputs: [] };
    const replacement = await replace(part, options);
    return {
      message: { ...record, content: replacement.text },
      changed: true,
      outputs: [providerContextMaterializedOutput(part, replacement.output)],
    };
  }

  if (!Array.isArray(content)) return { message, changed: false, outputs: [] };
  let changed = false;
  const outputs: ProviderContextMaterializedOutput[] = [];
  const nextContent: unknown[] = [];
  for (let index = 0; index < content.length; index += 1) {
    const item = content[index];
    const itemRecord = objectRecord(item);
    if (!itemRecord || typeof itemRecord.text !== "string" || !isProviderTextContentRecord(itemRecord)) {
      nextContent.push(item);
      continue;
    }
    const part = providerTextPart({
      messageIndex,
      role,
      path: `messages[${messageIndex}].content[${index}].text`,
      text: itemRecord.text,
      itemIndex: index,
    });
    if (!shouldOffloadText(part.text, options)) {
      nextContent.push(item);
      continue;
    }
    const replacement = await replace(part, options);
    nextContent.push({ ...itemRecord, text: replacement.text });
    outputs.push(providerContextMaterializedOutput(part, replacement.output));
    changed = true;
  }
  return {
    message: changed ? { ...record, content: nextContent } : message,
    changed,
    outputs,
  };
}

function replaceProviderMessageTextSync(
  message: unknown,
  messageIndex: number,
  options: NormalizedProviderContextOptions,
  replace: (part: ProviderTextPart) => string,
): { message: unknown; changed: boolean; largeTextCount: number; largestTextChars: number } {
  const record = objectRecord(message);
  if (!record) return { message, changed: false, largeTextCount: 0, largestTextChars: 0 };

  const role = stringField(record.role) ?? "message";
  if (!isOffloadableProviderMessage(record)) return { message, changed: false, largeTextCount: 0, largestTextChars: 0 };
  const content = record.content;
  if (typeof content === "string") {
    const part = providerTextPart({ messageIndex, role, path: `messages[${messageIndex}].content`, text: content });
    if (!shouldOffloadText(part.text, options)) return { message, changed: false, largeTextCount: 0, largestTextChars: 0 };
    return {
      message: { ...record, content: replace(part) },
      changed: true,
      largeTextCount: 1,
      largestTextChars: part.text.length,
    };
  }

  if (!Array.isArray(content)) return { message, changed: false, largeTextCount: 0, largestTextChars: 0 };
  let changed = false;
  let largeTextCount = 0;
  let largestTextChars = 0;
  const nextContent = content.map((item, index) => {
    const itemRecord = objectRecord(item);
    if (!itemRecord || typeof itemRecord.text !== "string" || !isProviderTextContentRecord(itemRecord)) return item;
    const part = providerTextPart({
      messageIndex,
      role,
      path: `messages[${messageIndex}].content[${index}].text`,
      text: itemRecord.text,
      itemIndex: index,
    });
    if (!shouldOffloadText(part.text, options)) return item;
    changed = true;
    largeTextCount += 1;
    largestTextChars = Math.max(largestTextChars, part.text.length);
    return { ...itemRecord, text: replace(part) };
  });
  return {
    message: changed ? { ...record, content: nextContent } : message,
    changed,
    largeTextCount,
    largestTextChars,
  };
}

function providerContextPayloadFromSession(
  session: ProviderCallContextPreflightSession,
  promptContent: string,
): { messages: unknown[] } | undefined {
  const context = session.sessionManager?.buildSessionContext?.();
  const contextMessages = Array.isArray(context?.messages) ? context.messages : undefined;
  const fallbackEntries = contextMessages ? undefined : session.sessionManager?.getEntries?.();
  const messages = contextMessages ?? (Array.isArray(fallbackEntries) ? fallbackEntries : undefined);
  if (!messages) return undefined;
  return {
    messages: [
      ...messages,
      {
        role: "user",
        content: promptContent,
      },
    ],
  };
}

function providerTextPart(input: {
  messageIndex: number;
  role: string;
  path: string;
  text: string;
  itemIndex?: number;
}): ProviderTextPart {
  const suffix = input.itemIndex === undefined ? "content" : `content-${input.itemIndex}`;
  return {
    ...input,
    label: `provider-context-${input.role}-${input.messageIndex}-${suffix}`,
  };
}

function shouldOffloadText(text: string, options: NormalizedProviderContextOptions): boolean {
  return text.length > options.offloadTextChars;
}

function providerContextMaterializedText(part: ProviderTextPart, output: MaterializedTextOutput): string {
  const notice = materializedTextNotice(part.label, output);
  return [output.text, notice].filter((line): line is string => Boolean(line)).join("\n\n");
}

function providerContextPreservedMaterializedReplacement(
  part: ProviderTextPart,
  previewChars: number,
  workspacePath: string | undefined,
): { text: string; output: MaterializedTextOutput } | undefined {
  const existing = existingMaterializedTextNotice(part.text, workspacePath);
  if (!existing) return undefined;
  const preview = part.text.slice(0, previewChars);
  return {
    text: [
      preview,
      `[context-preflight] ${part.label} was already materialized; direct provider preview was reduced from ${formatCount(part.text.length)} to ${formatCount(preview.length)} chars while preserving the original artifact path.`,
      existing.notice,
    ].join("\n\n"),
    output: {
      text: preview,
      truncated: true,
      totalChars: existing.totalChars ?? part.text.length,
      previewChars: preview.length,
      redacted: existing.redacted,
      redactionCount: 0,
      artifactPath: existing.artifactPath,
      artifactBytes: existing.artifactBytes,
    },
  };
}

function providerContextDryRunText(part: ProviderTextPart, previewChars: number): string {
  return [
    part.text.slice(0, previewChars),
    `[context-preflight] ${part.label} is ${formatCount(part.text.length)} chars and will be materialized before the Ambient/Pi provider call. Full text is omitted from direct provider context; use file_read or long_context_process on the emitted artifact.`,
    "x".repeat(DRY_RUN_NOTICE_CHARS),
  ].join("\n\n");
}

function providerContextMaterializedOutput(
  part: ProviderTextPart,
  output: MaterializedTextOutput,
): ProviderContextMaterializedOutput {
  return {
    messageIndex: part.messageIndex,
    role: part.role,
    path: part.path,
    label: part.label,
    totalChars: output.totalChars,
    previewChars: output.previewChars,
    redacted: output.redacted,
    redactionCount: output.redactionCount,
    artifactPath: output.artifactPath,
    artifactBytes: output.artifactBytes,
  };
}

function providerContextBlockReport(input: {
  threadId?: string;
  sessionFile?: string;
  budgetTokens: number;
  estimate: ProviderPayloadContextProtectionEstimate;
}): string {
  return [
    "Ambient/Pi provider context preflight blocked a request.",
    input.threadId ? `Thread: ${input.threadId}` : undefined,
    input.sessionFile ? `Session file: ${input.sessionFile}` : undefined,
    `Safety budget tokens: ${input.budgetTokens}`,
    `Estimated original tokens: ${input.estimate.beforeTokens}`,
    `Estimated protected tokens: ${input.estimate.afterTokens}`,
    `Estimated original bytes: ${input.estimate.beforeBytes}`,
    `Estimated protected bytes: ${input.estimate.afterBytes}`,
    `Oversized text parts eligible for offload: ${input.estimate.largeTextCount}`,
    `Largest oversized text chars: ${input.estimate.largestTextChars}`,
    "",
    "Next steps:",
    "- Compact the thread or start a fresh thread before retrying.",
    "- Use file_read for exact artifact text.",
    "- Use long_context_process for summarization or querying of large artifacts.",
    "- Avoid replaying full generated dependency trees or legacy raw tool outputs into provider context.",
  ].filter((line): line is string => line !== undefined).join("\n");
}

function providerContextBlockedPayload(
  payload: unknown,
  input: { budgetTokens: number; protectedTokens: number; artifactPath?: string; failureReason?: string },
): unknown {
  const record = objectRecord(payload) ?? {};
  const blocked = { ...record };
  delete blocked.tools;
  delete blocked.tool_choice;
  delete blocked.functions;
  delete blocked.function_call;
  delete blocked.tool_stream;
  delete blocked.parallel_tool_calls;
  delete blocked.max_completion_tokens;
  blocked.temperature = 0;
  blocked.max_tokens = Math.min(numberField(record.max_tokens) ?? numberField(record.max_completion_tokens) ?? 512, 512);
  blocked.messages = [{
    role: "user",
    content: [
      "Ambient/Pi provider context preflight blocked this turn before sending the original context.",
      input.failureReason,
      `Provider payload estimate: ${formatCount(input.protectedTokens)} tokens.`,
      `Safety budget: ${formatCount(input.budgetTokens)} tokens.`,
      input.artifactPath ? `Diagnostic artifact: ${input.artifactPath}` : undefined,
      "Compact or start a fresh thread, then use file_read or long_context_process for large artifacts instead of replaying the full transcript.",
    ].filter((line): line is string => Boolean(line)).join("\n"),
  }];
  return blocked;
}

function providerContextMaterializationFailurePayload(
  payload: unknown,
  options: ProviderContextPreflightOptions,
  error: unknown,
): unknown {
  return providerContextBlockedPayload(payload, {
    budgetTokens: providerContextPreflightTokenBudget(options),
    protectedTokens: estimateTokensFromBytes(estimateUnboundedJsonByteLength(payload)),
    failureReason: `Provider context materialization failed (${errorName(error)}) before the request could be safely reduced.`,
  });
}

function normalizeProviderContextOptions(
  options: Pick<ProviderContextPreflightOptions, "textPreviewChars" | "offloadTextChars">,
): NormalizedProviderContextOptions {
  const textPreviewChars = positiveInteger(options.textPreviewChars, DEFAULT_PROVIDER_CONTEXT_TEXT_PREVIEW_CHARS);
  return {
    textPreviewChars,
    offloadTextChars: Math.max(textPreviewChars, positiveInteger(options.offloadTextChars, DEFAULT_PROVIDER_CONTEXT_OFFLOAD_TEXT_CHARS)),
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback;
}

function isProviderTextContentRecord(record: Record<string, unknown>): boolean {
  const type = stringField(record.type);
  return type === undefined || type === "text" || type === "input_text" || type === "output_text";
}

function isOffloadableProviderMessage(record: Record<string, unknown>): boolean {
  const role = stringField(record.role);
  return (
    role === "toolResult" ||
    role === "tool" ||
    stringField(record.toolCallId) !== undefined ||
    stringField(record.tool_call_id) !== undefined ||
    stringField(record.toolName) !== undefined
  );
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function existingMaterializedTextNotice(text: string, workspacePath: string | undefined): {
  notice: string;
  artifactPath: string;
  totalChars?: number;
  artifactBytes?: number;
  redacted: boolean;
} | undefined {
  if (!workspacePath) return undefined;
  const artifactMatches = Array.from(text.matchAll(/^Full output saved at: (.+)$/gm));
  const artifactMatch = artifactMatches[artifactMatches.length - 1];
  const artifactPath = artifactMatch?.[1]?.trim();
  if (!isAmbientToolOutputArtifactPath(artifactPath)) return undefined;

  const artifactIndex = artifactMatch.index ?? text.lastIndexOf(`Full output saved at: ${artifactPath}`);
  const noticeStart = text.lastIndexOf("[truncated]", artifactIndex);
  const notice = noticeStart >= 0 ? text.slice(noticeStart).trim() : `Full output saved at: ${artifactPath}`;
  if (!notice.includes("Structured next step:")) return undefined;
  if (!notice.includes(`"artifactPath":"${artifactPath}"`) && !notice.includes(`"artifactPath": "${artifactPath}"`)) {
    return undefined;
  }
  const preview = noticeStart >= 0 ? text.slice(0, noticeStart).replace(/\s+$/u, "") : "";
  if (!workspaceArtifactStartsWith(workspacePath, artifactPath, preview)) return undefined;

  const summary = notice.match(/preview is ([\d,]+) of ([\d,]+) chars(?:, ([\d,]+) bytes)?\./);
  return {
    notice,
    artifactPath,
    totalChars: parseNoticeInteger(summary?.[2]),
    artifactBytes: parseNoticeInteger(summary?.[3]),
    redacted: notice.includes("Sensitive values were redacted"),
  };
}

function workspaceArtifactStartsWith(workspacePath: string, artifactPath: string, preview: string): boolean {
  const absolutePath = workspaceArtifactAbsolutePath(workspacePath, artifactPath);
  if (!absolutePath) return false;
  const expected = Buffer.from(preview.slice(0, EXISTING_NOTICE_VALIDATION_CHARS));
  if (expected.length === 0) return false;

  let fd: number | undefined;
  try {
    fd = openSync(absolutePath, "r");
    const buffer = Buffer.alloc(expected.length);
    const bytesRead = readSync(fd, buffer, 0, expected.length, 0);
    return bytesRead === expected.length && buffer.equals(expected);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Closing a validation read is best-effort; failed validation already falls back to rematerializing.
      }
    }
  }
}

function workspaceArtifactAbsolutePath(workspacePath: string, artifactPath: string): string | undefined {
  if (!isAmbientToolOutputArtifactPath(artifactPath)) return undefined;
  try {
    const workspaceRoot = realpathSync(workspacePath);
    const toolOutputsRoot = realpathSync(resolve(workspaceRoot, ".ambient", "tool-outputs"));
    const absolutePath = resolve(workspaceRoot, artifactPath);
    if (!absolutePath.startsWith(`${resolve(workspaceRoot, ".ambient", "tool-outputs")}${sep}`)) return undefined;
    const realArtifactPath = realpathSync(absolutePath);
    return realArtifactPath.startsWith(`${toolOutputsRoot}${sep}`) ? realArtifactPath : undefined;
  } catch {
    return undefined;
  }
}

function isAmbientToolOutputArtifactPath(artifactPath: string | undefined): artifactPath is string {
  if (!artifactPath || isAbsolute(artifactPath)) return false;
  const segments = artifactPath.split(/[\\/]+/u);
  return (
    segments.length > 2 &&
    segments[0] === ".ambient" &&
    segments[1] === "tool-outputs" &&
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function parseNoticeInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value.replace(/,/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : typeof error;
}

function estimateUnboundedJsonByteLengthInternal(value: unknown, seen: WeakSet<object>): number {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return 0;
  if (value === null) return 4;
  if (typeof value === "string") return Buffer.byteLength(value) + 2;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return Buffer.byteLength(String(value));
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return CIRCULAR_JSON_OVERHEAD_BYTES;
    seen.add(value);
    const bytes = 2 + Math.max(0, value.length - 1) + value.reduce(
      (total, item) => total + estimateUnboundedJsonByteLengthInternal(item, seen),
      0,
    );
    seen.delete(value);
    return bytes;
  }
  if (typeof value === "object") {
    if (seen.has(value)) return CIRCULAR_JSON_OVERHEAD_BYTES;
    seen.add(value);
    const entries = Object.entries(value as Record<string, unknown>);
    const bytes = (
      2 +
      Math.max(0, entries.length - 1) +
      entries.reduce(
        (total, [key, item]) => total + Buffer.byteLength(key) + 3 + estimateUnboundedJsonByteLengthInternal(item, seen),
        0,
      )
    );
    seen.delete(value);
    return bytes;
  }
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 0;
  }
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString();
}
