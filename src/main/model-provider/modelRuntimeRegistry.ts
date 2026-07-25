import {
  AMBIENT_MODEL_RUNTIME_PROFILES,
  AMBIENT_PROVIDER_DESCRIPTORS,
  ambientModelRuntimeCatalogFromProfiles,
  normalizeAmbientModelId,
  type AmbientModelProviderId,
  type AmbientModelRuntimeCatalog,
  type AmbientModelRuntimeCatalogValidationIssue,
  type AmbientModelRuntimeProfile,
  type AmbientProviderDescriptor,
} from "../../shared/ambientModels";

export type ModelRuntimeRegistryValidationIssue = AmbientModelRuntimeCatalogValidationIssue;

export interface ModelRuntimeRegistry {
  schemaVersion: "ambient-model-runtime-registry-v1";
  listProviderDescriptors(): readonly AmbientProviderDescriptor[];
  listModelProfiles(): readonly AmbientModelRuntimeProfile[];
  listSelectableMainProfiles(): readonly AmbientModelRuntimeProfile[];
  listSelectableSubagentProfiles(): readonly AmbientModelRuntimeProfile[];
  getProviderDescriptor(providerId: AmbientModelProviderId): AmbientProviderDescriptor;
  resolveProfile(modelId?: string): AmbientModelRuntimeProfile;
  validate(): ModelRuntimeRegistryValidationIssue[];
  toCatalog(generatedAt?: string): AmbientModelRuntimeCatalog;
}

export function createDefaultModelRuntimeRegistry(): ModelRuntimeRegistry {
  return createModelRuntimeRegistry({
    providers: AMBIENT_PROVIDER_DESCRIPTORS,
    profiles: AMBIENT_MODEL_RUNTIME_PROFILES,
  });
}

export function createModelRuntimeCatalog(input: {
  generatedAt?: string;
  providers?: readonly AmbientProviderDescriptor[];
  staticProfiles?: readonly AmbientModelRuntimeProfile[];
  runtimeProfiles?: readonly AmbientModelRuntimeProfile[];
} = {}): AmbientModelRuntimeCatalog {
  const providers = modelRuntimeProvidersWithRuntimeOverrides(AMBIENT_PROVIDER_DESCRIPTORS, input.providers ?? []);
  const profiles = modelRuntimeProfilesWithRuntimeOverrides(
    input.staticProfiles ?? AMBIENT_MODEL_RUNTIME_PROFILES,
    input.runtimeProfiles ?? [],
  );
  return createModelRuntimeRegistry({ providers, profiles }).toCatalog(input.generatedAt);
}

export function modelRuntimeProvidersWithRuntimeOverrides(
  staticProviders: readonly AmbientProviderDescriptor[],
  runtimeProviders: readonly AmbientProviderDescriptor[],
): AmbientProviderDescriptor[] {
  const byProviderId = new Map<string, AmbientProviderDescriptor>();
  for (const provider of staticProviders) byProviderId.set(provider.id, cloneProviderDescriptor(provider));
  for (const provider of runtimeProviders) byProviderId.set(provider.id, cloneProviderDescriptor(provider));
  return [...byProviderId.values()];
}

export function modelRuntimeProfilesWithRuntimeOverrides(
  staticProfiles: readonly AmbientModelRuntimeProfile[],
  runtimeProfiles: readonly AmbientModelRuntimeProfile[],
): AmbientModelRuntimeProfile[] {
  const byModelId = new Map<string, AmbientModelRuntimeProfile>();
  for (const profile of staticProfiles) byModelId.set(profile.modelId, cloneModelRuntimeProfile(profile));
  for (const profile of runtimeProfiles) byModelId.set(profile.modelId, cloneModelRuntimeProfile(profile));
  return [...byModelId.values()];
}

export function createModelRuntimeRegistry(input: {
  providers: readonly AmbientProviderDescriptor[];
  profiles: readonly AmbientModelRuntimeProfile[];
}): ModelRuntimeRegistry {
  const providers = input.providers.map(cloneProviderDescriptor);
  const profiles = input.profiles.map(cloneModelRuntimeProfile);
  const issues = validateModelRuntimeRegistry({ providers, profiles });
  if (issues.length > 0) {
    throw new Error(`Invalid model runtime registry: ${issues.map((issue) => issue.message).join(" ")}`);
  }
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const profileByModelId = new Map(profiles.map((profile) => [profile.modelId, profile]));

  return {
    schemaVersion: "ambient-model-runtime-registry-v1",
    listProviderDescriptors: () => providers.map(cloneProviderDescriptor),
    listModelProfiles: () => profiles.map(cloneModelRuntimeProfile),
    listSelectableMainProfiles: () => profiles.filter((profile) => profile.available && profile.selectableAsMain).map(cloneModelRuntimeProfile),
    listSelectableSubagentProfiles: () => profiles.filter((profile) => profile.available && profile.selectableAsSubagent).map(cloneModelRuntimeProfile),
    getProviderDescriptor: (providerId) => {
      const provider = providerById.get(providerId);
      if (!provider) throw new Error(`Unknown Ambient model provider: ${providerId}`);
      return cloneProviderDescriptor(provider);
    },
    resolveProfile: (modelId) => {
      const normalized = normalizeAmbientModelId(modelId);
      const profile = profileByModelId.get(normalized);
      return profile ? cloneModelRuntimeProfile(profile) : unknownModelRuntimeProfile(normalized);
    },
    validate: () => validateModelRuntimeRegistry({ providers, profiles }),
    toCatalog: (generatedAt) => ambientModelRuntimeCatalogFromProfiles({
      generatedAt,
      providers,
      profiles,
      validationIssues: validateModelRuntimeRegistry({ providers, profiles }),
    }),
  };
}

export function validateModelRuntimeRegistry(input: {
  providers: readonly AmbientProviderDescriptor[];
  profiles: readonly AmbientModelRuntimeProfile[];
}): ModelRuntimeRegistryValidationIssue[] {
  const issues: ModelRuntimeRegistryValidationIssue[] = [];
  const providerIds = new Set<string>();
  for (const provider of input.providers) {
    if (providerIds.has(provider.id)) {
      issues.push(issue({ providerId: provider.id, field: "id", message: `Duplicate Ambient model provider id: ${provider.id}.` }));
    }
    providerIds.add(provider.id);
    if (!provider.label.trim()) {
      issues.push(issue({ providerId: provider.id, field: "label", message: `Provider ${provider.id} must have a label.` }));
    }
  }

  const profileIds = new Set<string>();
  const modelIds = new Set<string>();
  for (const profile of input.profiles) {
    if (profile.schemaVersion !== "ambient-model-runtime-profile-v1") {
      issues.push(issue({ profileId: profile.profileId, field: "schemaVersion", message: `Profile ${profile.profileId} has unsupported schema version ${profile.schemaVersion}.` }));
    }
    if (profileIds.has(profile.profileId)) {
      issues.push(issue({ profileId: profile.profileId, field: "profileId", message: `Duplicate model runtime profile id: ${profile.profileId}.` }));
    }
    profileIds.add(profile.profileId);
    if (modelIds.has(profile.modelId)) {
      issues.push(issue({ profileId: profile.profileId, field: "modelId", message: `Duplicate model id in runtime registry: ${profile.modelId}.` }));
    }
    modelIds.add(profile.modelId);
    const provider = input.providers.find((candidate) => candidate.id === profile.providerId);
    if (!provider) {
      issues.push(issue({ profileId: profile.profileId, providerId: profile.providerId, field: "providerId", message: `Profile ${profile.profileId} references unknown provider ${profile.providerId}.` }));
      continue;
    }
    if (provider.locality !== profile.locality) {
      issues.push(issue({ profileId: profile.profileId, providerId: profile.providerId, field: "locality", message: `Profile ${profile.profileId} locality ${profile.locality} does not match provider ${profile.providerId} locality ${provider.locality}.` }));
    }
    if (profile.selectableAsSubagent && !profile.supportsStreaming) {
      issues.push(issue({ profileId: profile.profileId, field: "supportsStreaming", message: `Profile ${profile.profileId} is selectable as a sub-agent but does not support streaming.` }));
    }
    if (!profile.label.trim()) {
      issues.push(issue({ profileId: profile.profileId, field: "label", message: `Profile ${profile.profileId} must have a label.` }));
    }
  }

  return issues;
}

function issue(input: ModelRuntimeRegistryValidationIssue): ModelRuntimeRegistryValidationIssue {
  return input;
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

function unknownModelRuntimeProfile(modelId: string): AmbientModelRuntimeProfile {
  return {
    schemaVersion: "ambient-model-runtime-profile-v1",
    profileId: `unknown:${modelId}`,
    providerId: "unknown",
    modelId,
    label: `${modelId} (unavailable)`,
    selectableAsMain: false,
    selectableAsSubagent: false,
    available: false,
    unavailableReason: "Model is not registered in this Ambient Desktop build.",
    supportsStreaming: false,
    toolUse: "none",
    structuredOutput: "none",
    supportsVision: false,
    supportsAudio: false,
    locality: "cloud",
    costClass: "metered",
    trustClass: "user-configured",
    privacyLabel: "Unknown provider",
    providerQuirks: ["Preserved from stored settings or transcript; not eligible for new runs until registered."],
  };
}
