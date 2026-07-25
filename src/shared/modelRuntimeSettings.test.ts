import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_RUNTIME_SETTINGS,
  installedProviderSettingsKey,
  modelRuntimeProfilesFromSettings,
  modelRuntimeProvidersFromSettings,
  modelRuntimeSettingsWithInstalledProvider,
  normalizeModelRuntimeSettings,
} from "./modelRuntimeSettings";
import type { ModelProviderCapabilityProbeId } from "./modelProviderInstallTemplates";
import type { ModelRuntimeInstalledProvider } from "./threadTypes";

describe("modelRuntimeSettings", () => {
  it("keeps installed provider settings default-off and empty until Settings installs one", () => {
    expect(DEFAULT_MODEL_RUNTIME_SETTINGS.installedProviders).toEqual([]);
    expect(normalizeModelRuntimeSettings(undefined)).toEqual({
      aggressiveRetries: true,
      showPromptCacheStatus: false,
      providerPreStreamTimeoutMs: 45_000,
      providerStreamIdleTimeoutMs: 120_000,
      installedProviders: [],
    });
  });

  it("normalizes installed provider records while preserving exact custom provider and model ids", () => {
    const settings = normalizeModelRuntimeSettings({
      aggressiveRetries: false,
      showPromptCacheStatus: true,
      providerPreStreamTimeoutMs: 60_000,
      providerStreamIdleTimeoutMs: 30_000,
      installedProviders: [installedProvider({
        providerId: "customer-router",
        modelId: "CUSTOM/Router Model v2",
      })],
    });

    expect(settings.showPromptCacheStatus).toBe(true);
    expect(settings.installedProviders).toEqual([
      expect.objectContaining({
        schemaVersion: "ambient-model-runtime-installed-provider-v1",
        source: "settings-provider-onboarding",
        templateId: "generic-openai-compatible",
        enabled: true,
        provider: expect.objectContaining({
          id: "customer-router",
          label: "Customer Router",
        }),
        profile: expect.objectContaining({
          profileId: "customer-router:CUSTOM/Router Model v2",
          providerId: "customer-router",
          modelId: "CUSTOM/Router Model v2",
          selectableAsSubagent: true,
        }),
        endpoint: expect.objectContaining({
          schemaVersion: "ambient-model-runtime-installed-provider-endpoint-v1",
          compatibility: "openai-compatible",
          baseUrl: "https://provider.example/v1",
        }),
        secretRef: expect.objectContaining({
          ref: `ambient-secret-ref:v1:${"c".repeat(64)}`,
        }),
      }),
    ]);
    expect(modelRuntimeProvidersFromSettings(settings)).toEqual([
      expect.objectContaining({
        id: "customer-router",
        endpoint: expect.objectContaining({
          compatibility: "openai-compatible",
          baseUrl: "https://provider.example/v1",
        }),
      }),
    ]);
    expect(modelRuntimeProfilesFromSettings(settings).map((profile) => profile.modelId)).toEqual(["CUSTOM/Router Model v2"]);
  });

  it("defaults invalid prompt cache status visibility to off", () => {
    expect(normalizeModelRuntimeSettings({ showPromptCacheStatus: "yes" }).showPromptCacheStatus).toBe(false);
  });

  it("keeps disabled installed providers visible as unavailable runtime profiles", () => {
    const settings = normalizeModelRuntimeSettings({
      installedProviders: [installedProvider({
        providerId: "customer-router",
        modelId: "custom/disabled-model",
        enabled: false,
      })],
    });

    expect(modelRuntimeProfilesFromSettings(settings)).toEqual([
      expect.objectContaining({
        modelId: "custom/disabled-model",
        available: false,
        selectableAsMain: false,
        selectableAsSubagent: false,
        unavailableReason: "Installed provider is disabled in Settings.",
      }),
    ]);
  });

  it("does not trust Settings-installed profile flags without current probe evidence", () => {
    const staleSettings = normalizeModelRuntimeSettings({
      installedProviders: [installedProvider({
        providerId: "customer-router",
        modelId: "custom/stale-probes",
        passedProbeIds: ["streaming", "context_window", "latency", "error_shape"],
      })],
    });
    const missingReportSettings = normalizeModelRuntimeSettings({
      installedProviders: [installedProvider({
        providerId: "customer-router",
        modelId: "custom/missing-probe-report",
        omitProbeReport: true,
      })],
    });

    expect(modelRuntimeProfilesFromSettings(staleSettings)).toEqual([
      expect.objectContaining({
        modelId: "custom/stale-probes",
        available: false,
        selectableAsMain: false,
        selectableAsSubagent: false,
        unavailableReason: "Missing required capability probe: reliability.",
      }),
    ]);
    expect(modelRuntimeProfilesFromSettings(missingReportSettings)).toEqual([
      expect.objectContaining({
        modelId: "custom/missing-probe-report",
        available: false,
        selectableAsMain: false,
        selectableAsSubagent: false,
        unavailableReason: "Installed provider is missing capability probe report evidence.",
      }),
    ]);
  });

  it("redacts secret-shaped diagnostic text before provider settings are persisted", () => {
    const settings = normalizeModelRuntimeSettings({
      installedProviders: [installedProvider({
        providerId: "customer-router",
        modelId: "custom/secret-safe",
        providerLabel: "Router sk-labelsecret123456",
        note: "authorization=sk-note-secret-12345678",
        evidence: "Bearer sk-evidence-secret-12345678 accepted",
        endpointBaseUrl: "https://user:sk-url-secret-12345678@provider.example/v1?api_key=sk-query-secret-12345678#secret-token",
      })],
    });
    const serialized = JSON.stringify(settings);

    expect(serialized).not.toContain("sk-labelsecret");
    expect(serialized).not.toContain("sk-note-secret");
    expect(serialized).not.toContain("sk-evidence-secret");
    expect(serialized).not.toContain("sk-url-secret");
    expect(serialized).not.toContain("sk-query-secret");
    expect(settings.installedProviders[0].endpoint).toMatchObject({
      compatibility: "openai-compatible",
      baseUrl: "https://provider.example/v1",
    });
    expect(serialized).toContain("[REDACTED]");
  });

  it("merges Settings-installed provider updates by template, provider, and exact model id", () => {
    const first = installedProvider({
      providerId: "customer-router",
      modelId: "CUSTOM/Router Model v2",
      evidence: "first probe",
    });
    const second = installedProvider({
      providerId: "customer-router",
      modelId: "CUSTOM/Router Model v2",
      evidence: "second probe",
    });
    second.updatedAt = "2026-06-06T01:00:00.000Z";
    second.profile.label = "Updated Router Model";

    const next = modelRuntimeSettingsWithInstalledProvider(
      modelRuntimeSettingsWithInstalledProvider(undefined, first),
      second,
    );

    expect(next.installedProviders).toEqual([
      expect.objectContaining({
        updatedAt: "2026-06-06T01:00:00.000Z",
        profile: expect.objectContaining({
          modelId: "CUSTOM/Router Model v2",
          label: "Updated Router Model",
        }),
      }),
    ]);
    expect(installedProviderSettingsKey(next.installedProviders[0])).toBe("generic-openai-compatible:customer-router:CUSTOM/Router Model v2");
  });
});

function installedProvider(input: {
  providerId: string;
  modelId: string;
  providerLabel?: string;
  note?: string;
  evidence?: string;
  enabled?: boolean;
  endpointBaseUrl?: string;
  passedProbeIds?: readonly ModelProviderCapabilityProbeId[];
  omitProbeReport?: boolean;
  omitEligibility?: boolean;
}): ModelRuntimeInstalledProvider {
  const passedProbeIds = input.passedProbeIds ?? [
    "streaming",
    "context_window",
    "structured_json",
    "schema_output",
    "tool_use",
    "latency",
    "error_shape",
    "reliability",
  ];
  return {
    schemaVersion: "ambient-model-runtime-installed-provider-v1",
    source: "settings-provider-onboarding",
    templateId: "generic-openai-compatible",
    enabled: input.enabled ?? true,
    installedAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
    provider: {
      id: input.providerId,
      label: input.providerLabel ?? "Customer Router",
      locality: "cloud",
      secretRequirement: "user-secret",
      supportsStreaming: true,
      supportsTools: true,
      notes: [input.note ?? "Installed from Settings provider onboarding."],
    },
    profile: {
      schemaVersion: "ambient-model-runtime-profile-v1",
      profileId: `${input.providerId}:${input.modelId}`,
      providerId: input.providerId,
      modelId: input.modelId,
      label: input.modelId,
      selectableAsMain: true,
      selectableAsSubagent: true,
      available: true,
      contextWindowTokens: 128_000,
      supportsStreaming: true,
      toolUse: "ambient-tools",
      structuredOutput: "schema",
      supportsVision: false,
      supportsAudio: false,
      locality: "cloud",
      costClass: "metered",
      trustClass: "user-configured",
      privacyLabel: "User configured cloud provider",
      memoryClass: "remote",
      providerQuirks: ["Configured through Settings provider onboarding."],
    },
    endpoint: {
      schemaVersion: "ambient-model-runtime-installed-provider-endpoint-v1",
      compatibility: "openai-compatible",
      baseUrl: input.endpointBaseUrl ?? "https://provider.example/v1",
    },
    secretRef: {
      schemaVersion: "ambient-model-runtime-installed-provider-secret-ref-v1",
      flow: "ambient_cli_secret_request",
      configured: true,
      label: "Desktop secret request",
      ref: `ambient-secret-ref:v1:${"c".repeat(64)}`,
    },
    ...(!input.omitProbeReport ? { probeReport: {
      schemaVersion: "ambient-model-provider-capability-probe-v1",
      templateId: "generic-openai-compatible",
      providerId: input.providerId,
      modelId: input.modelId,
      generatedAt: "2026-06-06T00:00:00.000Z",
      observations: passedProbeIds.map((probeId) => ({
        probeId,
        status: "passed",
        measuredAt: "2026-06-06T00:00:01.000Z",
        evidence: input.evidence ?? "Endpoint returned streaming evidence.",
      })),
    } } : {}),
    ...(!input.omitEligibility ? { eligibility: {
      schemaVersion: "ambient-model-provider-capability-eligibility-v1",
      providerId: input.providerId,
      modelId: input.modelId,
      templateId: "generic-openai-compatible",
      eligibleAsMain: true,
      eligibleAsSubagent: true,
      mainBlockers: [],
      subagentBlockers: [],
      warnings: [],
      diagnostics: passedProbeIds.map((probeId) => ({
        probeId,
        requiredForMain: ["streaming", "context_window", "latency", "error_shape", "reliability"].includes(probeId),
        requiredForSubagent: ["streaming", "context_window", "structured_json", "schema_output", "tool_use", "latency", "error_shape", "reliability"].includes(probeId),
        status: "passed",
        message: `Capability probe ${probeId} passed.`,
      })),
    } } : {}),
  };
}
