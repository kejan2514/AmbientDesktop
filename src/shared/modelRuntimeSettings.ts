import type { AmbientModelRuntimeProfile, AmbientProviderDescriptor } from "./ambientModels";
import type { ModelRuntimeInstalledProvider, ModelRuntimeInstalledProviderSecretRef, ModelRuntimeSettings } from "./threadTypes";
import type {
  ModelProviderCapabilityDiagnostic,
  ModelProviderCapabilityEligibility,
  ModelProviderCapabilityProbeObservation,
  ModelProviderCapabilityProbeReport,
  ModelProviderCapabilityProbeStatus,
  ModelProviderEndpointCompatibility,
  ModelProviderSecretFlow,
} from "./modelProviderInstallTemplates";
import {
  MODEL_PROVIDER_CAPABILITY_ELIGIBILITY_SCHEMA_VERSION,
  MODEL_PROVIDER_CAPABILITY_PROBE_SCHEMA_VERSION,
  modelProviderInstallTemplateById,
  type ModelProviderCapabilityProbeId,
} from "./modelProviderInstallTemplates";

export const DEFAULT_MODEL_RUNTIME_PROVIDER_PRE_STREAM_TIMEOUT_MS = 45_000;
export const DEFAULT_MODEL_RUNTIME_PROVIDER_STREAM_IDLE_TIMEOUT_MS = 120_000;
export const MIN_MODEL_RUNTIME_PROVIDER_TIMEOUT_MS = 5_000;
export const MAX_MODEL_RUNTIME_PROVIDER_TIMEOUT_MS = 600_000;
export const MODEL_RUNTIME_INSTALLED_PROVIDER_SCHEMA_VERSION = "ambient-model-runtime-installed-provider-v1" as const;
export const MODEL_RUNTIME_INSTALLED_PROVIDER_SECRET_REF_SCHEMA_VERSION = "ambient-model-runtime-installed-provider-secret-ref-v1" as const;
export const MODEL_RUNTIME_INSTALLED_PROVIDER_ENDPOINT_SCHEMA_VERSION = "ambient-model-runtime-installed-provider-endpoint-v1" as const;

export const DEFAULT_MODEL_RUNTIME_SETTINGS: ModelRuntimeSettings = {
  aggressiveRetries: true,
  showPromptCacheStatus: false,
  providerPreStreamTimeoutMs: DEFAULT_MODEL_RUNTIME_PROVIDER_PRE_STREAM_TIMEOUT_MS,
  providerStreamIdleTimeoutMs: DEFAULT_MODEL_RUNTIME_PROVIDER_STREAM_IDLE_TIMEOUT_MS,
  installedProviders: [],
};

export function normalizeModelRuntimeTimeoutMs(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(
    MIN_MODEL_RUNTIME_PROVIDER_TIMEOUT_MS,
    Math.min(MAX_MODEL_RUNTIME_PROVIDER_TIMEOUT_MS, Math.round(value)),
  );
}

export function normalizeModelRuntimeSettings(value: unknown): ModelRuntimeSettings {
  const input = value && typeof value === "object" && !Array.isArray(value) ? (value as Partial<ModelRuntimeSettings>) : {};
  return {
    aggressiveRetries: typeof input.aggressiveRetries === "boolean" ? input.aggressiveRetries : DEFAULT_MODEL_RUNTIME_SETTINGS.aggressiveRetries,
    showPromptCacheStatus: typeof input.showPromptCacheStatus === "boolean"
      ? input.showPromptCacheStatus
      : DEFAULT_MODEL_RUNTIME_SETTINGS.showPromptCacheStatus,
    providerPreStreamTimeoutMs: normalizeModelRuntimeTimeoutMs(
      input.providerPreStreamTimeoutMs,
      DEFAULT_MODEL_RUNTIME_SETTINGS.providerPreStreamTimeoutMs,
    ),
    providerStreamIdleTimeoutMs: normalizeModelRuntimeTimeoutMs(
      input.providerStreamIdleTimeoutMs,
      DEFAULT_MODEL_RUNTIME_SETTINGS.providerStreamIdleTimeoutMs,
    ),
    installedProviders: Array.isArray(input.installedProviders)
      ? input.installedProviders.map(normalizeInstalledProvider).filter((provider): provider is ModelRuntimeInstalledProvider => Boolean(provider))
      : [],
  };
}

export function modelRuntimeProvidersFromSettings(settings: unknown): AmbientProviderDescriptor[] {
  return normalizeModelRuntimeSettings(settings).installedProviders.map((installed) =>
    cloneProviderDescriptor({
      ...installed.provider,
      ...(installed.endpoint ? { endpoint: installed.endpoint } : {}),
    })
  );
}

export function modelRuntimeProfilesFromSettings(settings: unknown): AmbientModelRuntimeProfile[] {
  return normalizeModelRuntimeSettings(settings).installedProviders.map((installed) => {
    const profile = cloneModelRuntimeProfile(installed.profile);
    if (!installed.enabled) return unavailableInstalledProviderProfile(profile, "Installed provider is disabled in Settings.");
    const mainBlockers = profile.selectableAsMain ? installedProviderProbeBlockers(installed, profile, "main") : [];
    const subagentBlockers = profile.selectableAsSubagent ? installedProviderProbeBlockers(installed, profile, "subagent") : [];
    const selectableAsMain = profile.selectableAsMain && mainBlockers.length === 0;
    const selectableAsSubagent = profile.selectableAsSubagent && subagentBlockers.length === 0;
    const available = selectableAsMain || selectableAsSubagent;
    return {
      ...profile,
      selectableAsMain,
      selectableAsSubagent,
      available,
      ...(!available
        ? { unavailableReason: firstInstalledProviderBlocker(mainBlockers, subagentBlockers) ?? "Installed provider capability probes did not prove eligibility." }
        : { unavailableReason: undefined }),
    };
  });
}

export function modelRuntimeSettingsWithInstalledProvider(
  settings: unknown,
  installedProvider: ModelRuntimeInstalledProvider,
): ModelRuntimeSettings {
  const current = normalizeModelRuntimeSettings(settings);
  const [installed] = normalizeModelRuntimeSettings({ installedProviders: [installedProvider] }).installedProviders;
  if (!installed) return current;
  const installedKey = installedProviderSettingsKey(installed);
  return normalizeModelRuntimeSettings({
    ...current,
    installedProviders: [
      ...current.installedProviders.filter((candidate) => installedProviderSettingsKey(candidate) !== installedKey),
      installed,
    ],
  });
}

export function installedProviderSettingsKey(installedProvider: ModelRuntimeInstalledProvider): string {
  return [
    installedProvider.templateId,
    installedProvider.provider.id,
    installedProvider.profile.modelId,
  ].join(":");
}

function normalizeInstalledProvider(value: unknown): ModelRuntimeInstalledProvider | undefined {
  if (!isRecord(value)) return undefined;
  const provider = normalizeProviderDescriptor(value.provider);
  const profile = normalizeModelRuntimeProfile(value.profile);
  if (!provider || !profile) return undefined;
  const templateId = stringValue(value.templateId);
  const installedAt = stringValue(value.installedAt);
  const updatedAt = stringValue(value.updatedAt);
  if (!templateId || !installedAt || !updatedAt) return undefined;
  const endpoint = normalizeEndpointConfig(value.endpoint);
  return {
    schemaVersion: MODEL_RUNTIME_INSTALLED_PROVIDER_SCHEMA_VERSION,
    source: "settings-provider-onboarding",
    templateId,
    enabled: typeof value.enabled === "boolean" ? value.enabled : true,
    installedAt,
    updatedAt,
    provider,
    profile,
    ...(endpoint ? { endpoint } : {}),
    ...(normalizeSecretRef(value.secretRef) ? { secretRef: normalizeSecretRef(value.secretRef) } : {}),
    ...(normalizeProbeReport(value.probeReport) ? { probeReport: normalizeProbeReport(value.probeReport) } : {}),
    ...(normalizeEligibility(value.eligibility) ? { eligibility: normalizeEligibility(value.eligibility) } : {}),
  };
}

function normalizeProviderDescriptor(value: unknown): AmbientProviderDescriptor | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringValue(value.id);
  const label = redactSecretLikeText(stringValue(value.label));
  const locality = value.locality === "local" ? "local" : value.locality === "cloud" ? "cloud" : undefined;
  const secretRequirement =
    value.secretRequirement === "ambient-managed" || value.secretRequirement === "user-secret" || value.secretRequirement === "none"
      ? value.secretRequirement
      : undefined;
  if (!id || !label || !locality || !secretRequirement) return undefined;
  const endpoint = normalizeEndpointConfig(value.endpoint);
  return {
    id,
    label,
    locality,
    secretRequirement,
    supportsStreaming: value.supportsStreaming === true,
    supportsTools: value.supportsTools === true,
    ...(endpoint ? { endpoint } : {}),
    notes: stringArray(value.notes).map(redactSecretLikeText),
  };
}

function normalizeModelRuntimeProfile(value: unknown): AmbientModelRuntimeProfile | undefined {
  if (!isRecord(value) || value.schemaVersion !== "ambient-model-runtime-profile-v1") return undefined;
  const profileId = stringValue(value.profileId);
  const providerId = stringValue(value.providerId);
  const modelId = stringValue(value.modelId);
  const label = redactSecretLikeText(stringValue(value.label));
  const locality = value.locality === "local" ? "local" : value.locality === "cloud" ? "cloud" : undefined;
  const toolUse =
    value.toolUse === "none" || value.toolUse === "ambient-tools" || value.toolUse === "mcp-compatible"
      ? value.toolUse
      : undefined;
  const structuredOutput =
    value.structuredOutput === "none" || value.structuredOutput === "json-mode" || value.structuredOutput === "schema"
      ? value.structuredOutput
      : undefined;
  const costClass =
    value.costClass === "included" || value.costClass === "metered" || value.costClass === "local"
      ? value.costClass
      : undefined;
  const trustClass =
    value.trustClass === "ambient-managed" || value.trustClass === "user-configured" || value.trustClass === "local-user-managed"
      ? value.trustClass
      : undefined;
  const privacyLabel = redactSecretLikeText(stringValue(value.privacyLabel));
  if (!profileId || !providerId || !modelId || !label || !locality || !toolUse || !structuredOutput || !costClass || !trustClass || !privacyLabel) {
    return undefined;
  }
  return {
    schemaVersion: "ambient-model-runtime-profile-v1",
    profileId,
    providerId,
    modelId,
    label,
    selectableAsMain: value.selectableAsMain === true,
    selectableAsSubagent: value.selectableAsSubagent === true,
    available: value.available === true,
    ...(optionalString(value.unavailableReason) ? { unavailableReason: redactSecretLikeText(optionalString(value.unavailableReason) ?? "") } : {}),
    ...(positiveInteger(value.contextWindowTokens) ? { contextWindowTokens: positiveInteger(value.contextWindowTokens) } : {}),
    ...(positiveInteger(value.maxOutputTokens) ? { maxOutputTokens: positiveInteger(value.maxOutputTokens) } : {}),
    ...(normalizeModelRuntimeLimitMetadata(value.limitMetadata)
      ? { limitMetadata: normalizeModelRuntimeLimitMetadata(value.limitMetadata) }
      : {}),
    supportsStreaming: value.supportsStreaming === true,
    toolUse,
    structuredOutput,
    supportsVision: value.supportsVision === true,
    supportsAudio: value.supportsAudio === true,
    locality,
    costClass,
    trustClass,
    privacyLabel,
    ...(memoryClass(value.memoryClass) ? { memoryClass: memoryClass(value.memoryClass) } : {}),
    ...(positiveInteger(value.estimatedResidentMemoryBytes) ? { estimatedResidentMemoryBytes: positiveInteger(value.estimatedResidentMemoryBytes) } : {}),
    providerQuirks: stringArray(value.providerQuirks).map(redactSecretLikeText),
  };
}

function normalizeSecretRef(value: unknown): ModelRuntimeInstalledProviderSecretRef | undefined {
  if (!isRecord(value)) return undefined;
  const flow = secretFlow(value.flow);
  if (!flow) return undefined;
  return {
    schemaVersion: MODEL_RUNTIME_INSTALLED_PROVIDER_SECRET_REF_SCHEMA_VERSION,
    flow,
    configured: value.configured === true,
    ...(optionalString(value.label) ? { label: redactSecretLikeText(optionalString(value.label) ?? "") } : {}),
    ...(optionalString(value.ref) ? { ref: redactSecretLikeText(optionalString(value.ref) ?? "") } : {}),
  };
}

function normalizeEndpointConfig(value: unknown): ModelRuntimeInstalledProvider["endpoint"] | undefined {
  if (!isRecord(value) || value.schemaVersion !== MODEL_RUNTIME_INSTALLED_PROVIDER_ENDPOINT_SCHEMA_VERSION) return undefined;
  const compatibility = endpointCompatibility(value.compatibility);
  const baseUrl = normalizedEndpointBaseUrl(value.baseUrl);
  if (!compatibility || !baseUrl) return undefined;
  return {
    schemaVersion: MODEL_RUNTIME_INSTALLED_PROVIDER_ENDPOINT_SCHEMA_VERSION,
    compatibility,
    baseUrl,
    ...(optionalString(value.anthropicVersion) ? { anthropicVersion: redactSecretLikeText(optionalString(value.anthropicVersion) ?? "") } : {}),
  };
}

function normalizeProbeReport(value: unknown): ModelProviderCapabilityProbeReport | undefined {
  if (!isRecord(value) || value.schemaVersion !== MODEL_PROVIDER_CAPABILITY_PROBE_SCHEMA_VERSION) return undefined;
  const templateId = stringValue(value.templateId);
  const providerId = stringValue(value.providerId);
  const modelId = stringValue(value.modelId);
  const generatedAt = stringValue(value.generatedAt);
  if (!templateId || !providerId || !modelId || !generatedAt || !Array.isArray(value.observations)) return undefined;
  return {
    schemaVersion: MODEL_PROVIDER_CAPABILITY_PROBE_SCHEMA_VERSION,
    templateId,
    providerId,
    modelId,
    generatedAt,
    observations: value.observations.map(normalizeProbeObservation).filter((observation): observation is ModelProviderCapabilityProbeObservation => Boolean(observation)),
  };
}

function normalizeProbeObservation(value: unknown): ModelProviderCapabilityProbeObservation | undefined {
  if (!isRecord(value)) return undefined;
  const probeId = stringValue(value.probeId);
  const status = probeStatus(value.status);
  const measuredAt = stringValue(value.measuredAt);
  if (!probeId || !status || !measuredAt) return undefined;
  return {
    probeId: probeId as ModelProviderCapabilityProbeObservation["probeId"],
    status,
    measuredAt,
    ...(nonNegativeNumber(value.latencyMs) !== undefined ? { latencyMs: nonNegativeNumber(value.latencyMs) } : {}),
    ...(value.value !== undefined ? { value: secretSafeValue(value.value) } : {}),
    ...(optionalString(value.evidence) ? { evidence: redactSecretLikeText(optionalString(value.evidence) ?? "") } : {}),
    ...(optionalString(value.error) ? { error: redactSecretLikeText(optionalString(value.error) ?? "") } : {}),
  };
}

function normalizeEligibility(value: unknown): ModelProviderCapabilityEligibility | undefined {
  if (!isRecord(value) || value.schemaVersion !== MODEL_PROVIDER_CAPABILITY_ELIGIBILITY_SCHEMA_VERSION) return undefined;
  const providerId = stringValue(value.providerId);
  const modelId = stringValue(value.modelId);
  const templateId = stringValue(value.templateId);
  if (!providerId || !modelId || !templateId || !Array.isArray(value.diagnostics)) return undefined;
  return {
    schemaVersion: MODEL_PROVIDER_CAPABILITY_ELIGIBILITY_SCHEMA_VERSION,
    providerId,
    modelId,
    templateId,
    eligibleAsMain: value.eligibleAsMain === true,
    eligibleAsSubagent: value.eligibleAsSubagent === true,
    mainBlockers: stringArray(value.mainBlockers).map(redactSecretLikeText),
    subagentBlockers: stringArray(value.subagentBlockers).map(redactSecretLikeText),
    warnings: stringArray(value.warnings).map(redactSecretLikeText),
    diagnostics: value.diagnostics.map(normalizeDiagnostic).filter((diagnostic): diagnostic is ModelProviderCapabilityDiagnostic => Boolean(diagnostic)),
  };
}

function normalizeDiagnostic(value: unknown): ModelProviderCapabilityDiagnostic | undefined {
  if (!isRecord(value)) return undefined;
  const probeId = stringValue(value.probeId);
  const status = value.status === "missing" ? "missing" : probeStatus(value.status);
  const message = optionalString(value.message);
  if (!probeId || !status || !message) return undefined;
  return {
    probeId: probeId as ModelProviderCapabilityDiagnostic["probeId"],
    requiredForMain: value.requiredForMain === true,
    requiredForSubagent: value.requiredForSubagent === true,
    status,
    message: redactSecretLikeText(message),
  };
}

function cloneProviderDescriptor(provider: AmbientProviderDescriptor): AmbientProviderDescriptor {
  return {
    ...provider,
    ...(provider.endpoint ? { endpoint: { ...provider.endpoint } } : {}),
    notes: [...provider.notes],
  };
}

function cloneModelRuntimeProfile(profile: AmbientModelRuntimeProfile): AmbientModelRuntimeProfile {
  return {
    ...profile,
    ...(profile.limitMetadata ? { limitMetadata: { ...profile.limitMetadata } } : {}),
    providerQuirks: [...profile.providerQuirks],
  };
}

function normalizeModelRuntimeLimitMetadata(value: unknown): AmbientModelRuntimeProfile["limitMetadata"] | undefined {
  if (!isRecord(value)) return undefined;
  const source = value.source === "static" || value.source === "discovered" || value.source === "provider-error"
    ? value.source
    : undefined;
  const requestedOutputTokens = positiveInteger(value.requestedOutputTokens);
  if (!source || !requestedOutputTokens) return undefined;
  return {
    source,
    requestedOutputTokens,
    ...(optionalString(value.observedAt) ? { observedAt: optionalString(value.observedAt) } : {}),
    ...(optionalString(value.expiresAt) ? { expiresAt: optionalString(value.expiresAt) } : {}),
    ...(positiveInteger(value.advertisedContextWindowTokens)
      ? { advertisedContextWindowTokens: positiveInteger(value.advertisedContextWindowTokens) }
      : {}),
  };
}

function unavailableInstalledProviderProfile(
  profile: AmbientModelRuntimeProfile,
  unavailableReason: string,
): AmbientModelRuntimeProfile {
  return {
    ...profile,
    available: false,
    selectableAsMain: false,
    selectableAsSubagent: false,
    unavailableReason,
  };
}

function installedProviderProbeBlockers(
  installed: ModelRuntimeInstalledProvider,
  profile: AmbientModelRuntimeProfile,
  scope: "main" | "subagent",
): string[] {
  const blockers = installedProviderEvidenceIdentityBlockers(installed, profile);
  const template = modelProviderInstallTemplateById(installed.templateId);
  if (!template) {
    blockers.push(`Unknown model provider install template: ${installed.templateId}.`);
  }
  const eligibility = installed.eligibility;
  if (eligibility) {
    const eligibleForScope = scope === "main" ? eligibility.eligibleAsMain : eligibility.eligibleAsSubagent;
    if (!eligibleForScope) {
      const scopeBlockers = scope === "main" ? eligibility.mainBlockers : eligibility.subagentBlockers;
      blockers.push(...scopeBlockers);
      if (scopeBlockers.length === 0) blockers.push(`Capability probe eligibility did not approve ${scope} use.`);
    }
  }
  if (!installed.probeReport || !template) return uniqueStrings(blockers);

  const observationsByProbeId = new Map(installed.probeReport.observations.map((observation) => [observation.probeId, observation]));
  for (const probeId of requiredProbeIdsForInstalledProvider(template, profile, scope)) {
    const observation = observationsByProbeId.get(probeId);
    if (observation?.status === "passed") continue;
    blockers.push(capabilityProbeBlocker(probeId, observation));
  }
  return uniqueStrings(blockers);
}

function installedProviderEvidenceIdentityBlockers(
  installed: ModelRuntimeInstalledProvider,
  profile: AmbientModelRuntimeProfile,
): string[] {
  const blockers: string[] = [];
  if (!installed.probeReport) {
    blockers.push("Installed provider is missing capability probe report evidence.");
  } else {
    if (installed.probeReport.templateId !== installed.templateId) {
      blockers.push(`Capability probe report template ${installed.probeReport.templateId} does not match ${installed.templateId}.`);
    }
    if (installed.probeReport.providerId !== profile.providerId) {
      blockers.push(`Capability probe report provider ${installed.probeReport.providerId} does not match profile provider ${profile.providerId}.`);
    }
    if (installed.probeReport.modelId !== profile.modelId) {
      blockers.push(`Capability probe report model ${installed.probeReport.modelId} does not match profile model ${profile.modelId}.`);
    }
  }

  if (!installed.eligibility) {
    blockers.push("Installed provider is missing capability probe eligibility evidence.");
  } else {
    if (installed.eligibility.templateId !== installed.templateId) {
      blockers.push(`Capability eligibility template ${installed.eligibility.templateId} does not match ${installed.templateId}.`);
    }
    if (installed.eligibility.providerId !== profile.providerId) {
      blockers.push(`Capability eligibility provider ${installed.eligibility.providerId} does not match profile provider ${profile.providerId}.`);
    }
    if (installed.eligibility.modelId !== profile.modelId) {
      blockers.push(`Capability eligibility model ${installed.eligibility.modelId} does not match profile model ${profile.modelId}.`);
    }
  }
  return blockers;
}

function requiredProbeIdsForInstalledProvider(
  template: NonNullable<ReturnType<typeof modelProviderInstallTemplateById>>,
  profile: AmbientModelRuntimeProfile,
  scope: "main" | "subagent",
): ModelProviderCapabilityProbeId[] {
  const base = scope === "main" ? template.requiredProbeIdsForMain : template.requiredProbeIdsForSubagent;
  if (scope === "main") return uniqueProbeIds(base);
  return uniqueProbeIds([
    ...base,
    ...structuredOutputProbeIds(profile.structuredOutput),
    ...(profile.toolUse === "none" ? [] : ["tool_use" as const]),
    ...(profile.supportsVision ? ["image_input" as const] : []),
    ...(profile.locality === "local" ? ["health" as const, "local_memory" as const, "reliability" as const] : []),
  ]);
}

function structuredOutputProbeIds(structuredOutput: AmbientModelRuntimeProfile["structuredOutput"]): ModelProviderCapabilityProbeId[] {
  if (structuredOutput === "schema") return ["structured_json", "schema_output"];
  if (structuredOutput === "json-mode") return ["structured_json"];
  return [];
}

function capabilityProbeBlocker(
  probeId: ModelProviderCapabilityProbeId,
  observation: ModelProviderCapabilityProbeObservation | undefined,
): string {
  if (!observation) return `Missing required capability probe: ${probeId}.`;
  if (observation.status === "failed") return `Capability probe ${probeId} failed${observation.error ? `: ${observation.error}` : "."}`;
  if (observation.status === "skipped") return `Capability probe ${probeId} was skipped.`;
  return `Capability probe ${probeId} is ${observation.status}.`;
}

function firstInstalledProviderBlocker(
  mainBlockers: readonly string[],
  subagentBlockers: readonly string[],
): string | undefined {
  return mainBlockers[0] ?? subagentBlockers[0];
}

function uniqueProbeIds(ids: readonly ModelProviderCapabilityProbeId[]): ModelProviderCapabilityProbeId[] {
  return [...new Set(ids)];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

function secretSafeValue(value: unknown): unknown {
  if (typeof value === "string") return redactSecretLikeText(value);
  if (Array.isArray(value)) return value.map(secretSafeValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, secretSafeValue(nested)]));
  }
  return value;
}

function normalizedEndpointBaseUrl(value: unknown): string | undefined {
  const raw = optionalString(value);
  if (!raw) return undefined;
  const redacted = redactSecretLikeText(raw);
  try {
    const url = new URL(redacted);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return redacted.replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

function redactSecretLikeText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\b(api[_-]?key|authorization|x-api-key|token|secret)\s*[:=]\s*([^\s,;]+)/gi, "$1=[REDACTED]");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalString(value: unknown): string | undefined {
  const text = stringValue(value);
  return text ? text : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function memoryClass(value: unknown): AmbientModelRuntimeProfile["memoryClass"] | undefined {
  return value === "remote" || value === "small-local" || value === "medium-local" || value === "large-local"
    ? value
    : undefined;
}

function secretFlow(value: unknown): ModelProviderSecretFlow | undefined {
  return value === "ambient-managed" || value === "ambient_cli_secret_request" || value === "ambient_cli_env_bind" || value === "none"
    ? value
    : undefined;
}

function endpointCompatibility(value: unknown): Exclude<ModelProviderEndpointCompatibility, "local-text"> | undefined {
  return value === "ambient-compatible" || value === "openai-compatible" || value === "anthropic-compatible"
    ? value
    : undefined;
}

function probeStatus(value: unknown): ModelProviderCapabilityProbeStatus | undefined {
  return value === "passed" || value === "failed" || value === "skipped" || value === "unknown" ? value : undefined;
}
