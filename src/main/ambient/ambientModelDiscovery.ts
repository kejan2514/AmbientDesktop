import {
  AMBIENT_GLM_5_2_FP8_MODEL,
  AMBIENT_KIMI_K2_7_CODE_MODEL,
  AMBIENT_PROVIDER_AMBIENT,
  normalizeAmbientModelId,
  resolveAmbientModelReasoningCapability,
  resolveAmbientModelRuntimeProfile,
  type AmbientModelReasoningCapability,
  type AmbientModelRuntimeProfile,
} from "../../shared/ambientModels";
import { normalizeAmbientBaseUrl } from "./ambientProviderFacade";

export const AMBIENT_MODEL_DISCOVERY_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
export const AMBIENT_MODEL_DISCOVERY_DEFAULT_TIMEOUT_MS = 15_000;

export interface AmbientModelDiscoveryResult {
  endpoint: string;
  receivedModelCount: number;
  readyModelCount: number;
  profiles: AmbientModelRuntimeProfile[];
}

export interface DiscoverAmbientModelRuntimeProfilesInput {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface AmbientModelEndpointRecord {
  id?: unknown;
  name?: unknown;
  input_modalities?: unknown;
  output_modalities?: unknown;
  context_length?: unknown;
  max_output_length?: unknown;
  supported_features?: unknown;
  supported_sampling_parameters?: unknown;
  hugging_face_id?: unknown;
  is_ready?: unknown;
  ready?: unknown;
  status?: unknown;
}

export async function discoverAmbientModelRuntimeProfiles(
  input: DiscoverAmbientModelRuntimeProfilesInput,
): Promise<AmbientModelDiscoveryResult> {
  const key = input.apiKey.trim();
  if (!key) throw new Error("Ambient API key is required for model discovery.");

  const endpoint = `${normalizeAmbientBaseUrl(input.baseUrl)}/models`;
  const timeoutMs = discoveryTimeoutMs(input.timeoutMs);
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Ambient model discovery timed out after ${timeoutMs.toLocaleString()}ms.`));
  }, timeoutMs);
  timeout.unref?.();

  try {
    const response = await (input.fetchImpl ?? fetch)(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = (await response.text()).replace(/\s+/g, " ").trim();
      throw new Error(body ? `Ambient model discovery failed (${response.status}): ${body.slice(0, 180)}` : `Ambient model discovery failed (${response.status}).`);
    }
    const payload = await response.json();
    return ambientModelDiscoveryResultFromPayload(endpoint, payload);
  } catch (error) {
    if (timedOut) throw new Error(`Ambient model discovery timed out after ${timeoutMs.toLocaleString()}ms.`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function ambientModelDiscoveryResultFromPayload(endpoint: string, payload: unknown): AmbientModelDiscoveryResult {
  const records = endpointRecords(payload);
  const readyRecords = records.filter(isReadyModelRecord);
  return {
    endpoint,
    receivedModelCount: records.length,
    readyModelCount: readyRecords.length,
    profiles: readyRecords.map(ambientModelRuntimeProfileFromEndpointRecord).filter(isPresent),
  };
}

function ambientModelRuntimeProfileFromEndpointRecord(record: AmbientModelEndpointRecord): AmbientModelRuntimeProfile | undefined {
  const rawModelId = stringValue(record.id);
  if (!rawModelId) return undefined;
  const modelId = normalizeAmbientModelId(rawModelId);
  const base = resolveAmbientModelRuntimeProfile(modelId);
  const features = lowerStringSet(record.supported_features);
  const inputModalities = lowerStringSet(record.input_modalities);
  const selectable = features.has("tools");
  const contextWindowTokens = positiveInteger(record.context_length);
  const maxOutputTokens = positiveInteger(record.max_output_length);
  const observedAt = new Date().toISOString();
  const label = stringValue(record.name) ?? base.label;
  const reasoningCapability = discoveredReasoningCapability(modelId, features);
  const inheritedQuirks = base.providerId === AMBIENT_PROVIDER_AMBIENT ? base.providerQuirks : [];
  const providerQuirks = [
    `Discovered from the Ambient /v1/models endpoint as ${rawModelId}.`,
    ...(stringValue(record.hugging_face_id) ? [`Ambient metadata reports Hugging Face id ${stringValue(record.hugging_face_id)}.`] : []),
    ...inheritedQuirks,
  ];

  return {
    ...base,
    profileId: `${AMBIENT_PROVIDER_AMBIENT}:${modelId}`,
    providerId: AMBIENT_PROVIDER_AMBIENT,
    modelId,
    label,
    selectableAsMain: selectable,
    selectableAsSubagent: selectable,
    available: true,
    unavailableReason: undefined,
    ...(contextWindowTokens ? { contextWindowTokens } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(contextWindowTokens
      ? {
          limitMetadata: {
            source: "discovered" as const,
            requestedOutputTokens: Math.min(maxOutputTokens ?? 32_000, 32_000),
            advertisedContextWindowTokens: contextWindowTokens,
            observedAt,
          },
        }
      : {}),
    supportsStreaming: true,
    toolUse: selectable ? "ambient-tools" : "none",
    structuredOutput: features.has("structured_outputs") ? "schema" : features.has("json_mode") ? "json-mode" : "none",
    supportsVision: inputModalities.has("image") || inputModalities.has("video"),
    supportsAudio: inputModalities.has("audio"),
    locality: "cloud",
    costClass: "included",
    trustClass: "ambient-managed",
    privacyLabel: "Ambient managed cloud model",
    memoryClass: "remote",
    reasoningCapability,
    providerQuirks: uniqueStrings(providerQuirks),
  };
}

function discoveredReasoningCapability(modelId: string, features: ReadonlySet<string>): AmbientModelReasoningCapability {
  if (!features.has("reasoning")) return resolveAmbientModelReasoningCapability("ambient/no-reasoning-contract");
  if (modelId === AMBIENT_GLM_5_2_FP8_MODEL) return resolveAmbientModelReasoningCapability(AMBIENT_GLM_5_2_FP8_MODEL);
  if (modelId === AMBIENT_KIMI_K2_7_CODE_MODEL || modelId.startsWith("moonshotai/kimi-")) {
    return resolveAmbientModelReasoningCapability(AMBIENT_KIMI_K2_7_CODE_MODEL);
  }
  return resolveAmbientModelReasoningCapability(modelId);
}

function endpointRecords(payload: unknown): AmbientModelEndpointRecord[] {
  if (!isRecord(payload)) return [];
  const data = Array.isArray(payload.data) ? payload.data : [];
  return data.filter(isRecord) as AmbientModelEndpointRecord[];
}

function isReadyModelRecord(record: AmbientModelEndpointRecord): boolean {
  if (record.is_ready === false || record.ready === false) return false;
  if (record.is_ready === true) return true;
  if (record.ready === true) return true;
  return typeof record.status === "string" && record.status.toLowerCase() === "ready";
}

function lowerStringSet(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.toLowerCase()));
}

function positiveInteger(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
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

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

function discoveryTimeoutMs(override: number | undefined): number {
  const value = override ?? AMBIENT_MODEL_DISCOVERY_DEFAULT_TIMEOUT_MS;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : AMBIENT_MODEL_DISCOVERY_DEFAULT_TIMEOUT_MS;
}
