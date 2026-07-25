import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  normalizeAmbientModelId,
  type AmbientModelRuntimeProfile,
  type AmbientModelRuntimeLimitMetadata,
} from "../../shared/ambientModels";
import { normalizeAmbientBaseUrl } from "./ambientProviderFacade";

export const PI_OPENAI_COMPAT_MAX_OUTPUT_TOKENS = 32_000;
export const AMBIENT_CONTEXT_SAFETY_MARGIN_TOKENS = 256;
export const AMBIENT_PROVIDER_OBSERVED_LIMIT_TTL_MS = 24 * 60 * 60 * 1000;
export const AMBIENT_DISCOVERED_LIMIT_TTL_MS = 6 * 60 * 60 * 1000;
export const AMBIENT_MODEL_LIMIT_OBSERVATIONS_FILENAME = "ambient-model-limit-observations.json";

export interface AmbientProviderContextOverflow {
  contextWindowTokens: number;
  requestedOutputTokens: number;
  inputTokens: number;
  requestedTotalTokens: number;
  parameter?: string;
  code?: string | number;
  message: string;
}

export interface AmbientModelLimitObservation {
  schemaVersion: "ambient-model-limit-observation-v1";
  providerId: "ambient";
  baseUrl: string;
  modelId: string;
  source: "discovered" | "provider-error";
  contextWindowTokens: number;
  maxOutputTokens?: number;
  requestedOutputTokens: number;
  observedAt: string;
  expiresAt: string;
  advertisedContextWindowTokens?: number;
}

interface AmbientModelLimitObservationFile {
  schemaVersion: "ambient-model-limit-observations-v1";
  observations: AmbientModelLimitObservation[];
}

export function ambientRequestedOutputTokens(maxOutputTokens: number | undefined): number {
  if (typeof maxOutputTokens !== "number" || !Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) {
    return PI_OPENAI_COMPAT_MAX_OUTPUT_TOKENS;
  }
  return Math.max(1, Math.min(Math.floor(maxOutputTokens), PI_OPENAI_COMPAT_MAX_OUTPUT_TOKENS));
}

export function ambientProviderInputTokenBudget(input: {
  contextWindowTokens: number;
  maxOutputTokens?: number;
  requestedOutputTokens?: number;
  configuredReserveTokens?: number;
  safetyMarginTokens?: number;
}): number {
  const contextWindowTokens = positiveInteger(input.contextWindowTokens) ?? 1;
  const requestedOutputTokens = positiveInteger(input.requestedOutputTokens) ?? ambientRequestedOutputTokens(input.maxOutputTokens);
  const safetyMarginTokens = nonNegativeInteger(input.safetyMarginTokens) ?? AMBIENT_CONTEXT_SAFETY_MARGIN_TOKENS;
  const outputReserveTokens = requestedOutputTokens + safetyMarginTokens;
  const configuredReserveTokens = nonNegativeInteger(input.configuredReserveTokens) ?? 0;
  return Math.max(1, contextWindowTokens - Math.max(outputReserveTokens, configuredReserveTokens));
}

export function parseAmbientProviderContextOverflow(error: unknown): AmbientProviderContextOverflow | undefined {
  const diagnosticText = ambientProviderErrorText(error);
  if (!diagnosticText) return undefined;
  const messageMatch = diagnosticText.match(
    /maximum context length is\s*([\d,]+)\s*tokens[\s\S]*?requested\s*([\d,]+)\s*output tokens[\s\S]*?prompt contains at least\s*([\d,]+)\s*input tokens[\s\S]*?total of at least\s*([\d,]+)\s*tokens/i,
  );
  if (!messageMatch) return undefined;
  const contextWindowTokens = tokenCount(messageMatch[1]);
  const requestedOutputTokens = tokenCount(messageMatch[2]);
  const inputTokens = tokenCount(messageMatch[3]);
  const requestedTotalTokens = tokenCount(messageMatch[4]);
  if (!contextWindowTokens || !requestedOutputTokens || !inputTokens || !requestedTotalTokens) return undefined;
  const parameter = diagnosticText.match(/\(parameter=([^,\s)]+)/i)?.[1];
  const codeText = diagnosticText.match(/"code"\s*:\s*(?:"([^"]+)"|(\d+))/i);
  const codeValue = codeText?.[1] ?? codeText?.[2];
  return {
    contextWindowTokens,
    requestedOutputTokens,
    inputTokens,
    requestedTotalTokens,
    ...(parameter ? { parameter } : {}),
    ...(codeValue ? { code: /^\d+$/.test(codeValue) ? Number(codeValue) : codeValue } : {}),
    message: diagnosticText,
  };
}

export function ambientModelLimitObservationFromOverflow(input: {
  baseUrl: string;
  modelId: string;
  overflow: AmbientProviderContextOverflow;
  advertisedContextWindowTokens?: number;
  now?: Date;
}): AmbientModelLimitObservation {
  const now = input.now ?? new Date();
  return normalizeAmbientModelLimitObservation({
    schemaVersion: "ambient-model-limit-observation-v1",
    providerId: "ambient",
    baseUrl: normalizeAmbientBaseUrl(input.baseUrl),
    modelId: normalizeAmbientModelId(input.modelId),
    source: "provider-error",
    contextWindowTokens: input.overflow.contextWindowTokens,
    requestedOutputTokens: input.overflow.requestedOutputTokens,
    observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + AMBIENT_PROVIDER_OBSERVED_LIMIT_TTL_MS).toISOString(),
    ...(positiveInteger(input.advertisedContextWindowTokens)
      ? { advertisedContextWindowTokens: positiveInteger(input.advertisedContextWindowTokens) }
      : {}),
  })!;
}

export function ambientModelLimitObservationFromDiscoveredProfile(input: {
  baseUrl: string;
  profile: AmbientModelRuntimeProfile;
  now?: Date;
}): AmbientModelLimitObservation | undefined {
  const contextWindowTokens = positiveInteger(input.profile.contextWindowTokens);
  if (!contextWindowTokens) return undefined;
  const now = input.now ?? new Date();
  return normalizeAmbientModelLimitObservation({
    schemaVersion: "ambient-model-limit-observation-v1",
    providerId: "ambient",
    baseUrl: normalizeAmbientBaseUrl(input.baseUrl),
    modelId: normalizeAmbientModelId(input.profile.modelId),
    source: "discovered",
    contextWindowTokens,
    ...(positiveInteger(input.profile.maxOutputTokens) ? { maxOutputTokens: positiveInteger(input.profile.maxOutputTokens) } : {}),
    requestedOutputTokens: ambientRequestedOutputTokens(input.profile.maxOutputTokens),
    observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + AMBIENT_DISCOVERED_LIMIT_TTL_MS).toISOString(),
    advertisedContextWindowTokens: contextWindowTokens,
  });
}

export function mergeAmbientModelLimitObservation(
  current: AmbientModelLimitObservation | undefined,
  next: AmbientModelLimitObservation,
): AmbientModelLimitObservation {
  if (!current) return next;
  if (ambientModelLimitObservationKey(current) !== ambientModelLimitObservationKey(next)) return next;
  if (next.source === "provider-error") return next;
  if (current.source === "provider-error" && !ambientModelLimitObservationExpired(current)) {
    return {
      ...current,
      advertisedContextWindowTokens: next.contextWindowTokens,
      ...(next.maxOutputTokens ? { maxOutputTokens: next.maxOutputTokens } : {}),
    };
  }
  return next;
}

export function applyAmbientModelLimitObservation(
  profile: AmbientModelRuntimeProfile,
  observation: AmbientModelLimitObservation | undefined,
  nowMs = Date.now(),
): AmbientModelRuntimeProfile {
  if (!observation || ambientModelLimitObservationExpired(observation, nowMs)) return profile;
  if (normalizeAmbientModelId(profile.modelId) !== normalizeAmbientModelId(observation.modelId)) return profile;
  const requestedOutputTokens = ambientRequestedOutputTokens(
    observation.maxOutputTokens ?? profile.maxOutputTokens,
  );
  const limitMetadata: AmbientModelRuntimeLimitMetadata = {
    source: observation.source,
    observedAt: observation.observedAt,
    expiresAt: observation.expiresAt,
    requestedOutputTokens,
    ...(observation.advertisedContextWindowTokens
      ? { advertisedContextWindowTokens: observation.advertisedContextWindowTokens }
      : {}),
  };
  return {
    ...profile,
    contextWindowTokens: observation.contextWindowTokens,
    ...(observation.maxOutputTokens ? { maxOutputTokens: observation.maxOutputTokens } : {}),
    limitMetadata,
    providerQuirks: uniqueStrings([
      ...profile.providerQuirks,
      observation.source === "provider-error"
        ? `Effective context limit ${observation.contextWindowTokens} was learned from a provider overflow response at ${observation.observedAt}.`
        : `Effective context limit ${observation.contextWindowTokens} was discovered from Ambient metadata at ${observation.observedAt}.`,
    ]),
  };
}

export function applyAmbientModelLimitObservationToRegisteredProfile(
  profile: AmbientModelRuntimeProfile,
  observation: AmbientModelLimitObservation,
  nowMs = Date.now(),
): AmbientModelRuntimeProfile | undefined {
  if (profile.providerId === "unknown") return undefined;
  return applyAmbientModelLimitObservation(profile, observation, nowMs);
}

export function ambientModelLimitObservationKey(input: Pick<AmbientModelLimitObservation, "baseUrl" | "modelId">): string {
  return `${normalizeAmbientBaseUrl(input.baseUrl)}::${normalizeAmbientModelId(input.modelId)}`;
}

export function ambientModelLimitObservationExpired(
  observation: AmbientModelLimitObservation,
  nowMs = Date.now(),
): boolean {
  const expiresAtMs = Date.parse(observation.expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs;
}

export function readAmbientModelLimitObservations(userDataPath: string, nowMs = Date.now()): AmbientModelLimitObservation[] {
  try {
    const payload = JSON.parse(readFileSync(ambientModelLimitObservationPath(userDataPath), "utf8")) as unknown;
    if (!isRecord(payload) || payload.schemaVersion !== "ambient-model-limit-observations-v1" || !Array.isArray(payload.observations)) {
      return [];
    }
    return payload.observations
      .map(normalizeAmbientModelLimitObservation)
      .filter((item): item is AmbientModelLimitObservation => item !== undefined && !ambientModelLimitObservationExpired(item, nowMs));
  } catch {
    return [];
  }
}

export function writeAmbientModelLimitObservations(
  userDataPath: string,
  observations: readonly AmbientModelLimitObservation[],
  nowMs = Date.now(),
): void {
  const path = ambientModelLimitObservationPath(userDataPath);
  const normalized = observations
    .map(normalizeAmbientModelLimitObservation)
    .filter((item): item is AmbientModelLimitObservation => item !== undefined && !ambientModelLimitObservationExpired(item, nowMs));
  const payload: AmbientModelLimitObservationFile = {
    schemaVersion: "ambient-model-limit-observations-v1",
    observations: normalized,
  };
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
}

export function ambientModelLimitObservationPath(userDataPath: string): string {
  return join(userDataPath, AMBIENT_MODEL_LIMIT_OBSERVATIONS_FILENAME);
}

function normalizeAmbientModelLimitObservation(value: unknown): AmbientModelLimitObservation | undefined {
  if (!isRecord(value) || value.schemaVersion !== "ambient-model-limit-observation-v1") return undefined;
  const baseUrl = stringValue(value.baseUrl);
  const modelId = stringValue(value.modelId);
  const contextWindowTokens = positiveInteger(value.contextWindowTokens);
  const requestedOutputTokens = positiveInteger(value.requestedOutputTokens);
  const observedAt = stringValue(value.observedAt);
  const expiresAt = stringValue(value.expiresAt);
  if (
    value.providerId !== "ambient" ||
    (value.source !== "discovered" && value.source !== "provider-error") ||
    !baseUrl ||
    !modelId ||
    !contextWindowTokens ||
    !requestedOutputTokens ||
    !observedAt ||
    !expiresAt ||
    !Number.isFinite(Date.parse(observedAt)) ||
    !Number.isFinite(Date.parse(expiresAt))
  ) {
    return undefined;
  }
  return {
    schemaVersion: "ambient-model-limit-observation-v1",
    providerId: "ambient",
    baseUrl: normalizeAmbientBaseUrl(baseUrl),
    modelId: normalizeAmbientModelId(modelId),
    source: value.source,
    contextWindowTokens,
    ...(positiveInteger(value.maxOutputTokens) ? { maxOutputTokens: positiveInteger(value.maxOutputTokens) } : {}),
    requestedOutputTokens,
    observedAt,
    expiresAt,
    ...(positiveInteger(value.advertisedContextWindowTokens)
      ? { advertisedContextWindowTokens: positiveInteger(value.advertisedContextWindowTokens) }
      : {}),
  };
}

function ambientProviderErrorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const seenObjects = new WeakSet<object>();
  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    parts.push(normalized);
  };
  if (error instanceof Error) {
    push(error.message);
    push(error.cause instanceof Error ? error.cause.message : undefined);
  } else {
    push(error);
  }
  const visit = (value: unknown, depth: number) => {
    if (depth > 3 || !isRecord(value) || seenObjects.has(value)) return;
    seenObjects.add(value);
    push(value.message);
    push(value.body);
    push(value.detail);
    for (const key of ["error", "response", "data", "cause", "details", "payload"]) {
      visit(value[key], depth + 1);
    }
  };
  visit(error, 0);
  return parts.join("\n");
}

function tokenCount(value: string | undefined): number | undefined {
  if (!value) return undefined;
  return positiveInteger(Number(value.replace(/,/g, "")));
}

function positiveInteger(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return Math.floor(numeric);
}

function nonNegativeInteger(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric) || numeric < 0) return undefined;
  return Math.floor(numeric);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}
