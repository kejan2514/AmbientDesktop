import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import {
  normalizeAmbientModelId,
  resolveAmbientModelReasoningCapability,
  resolveAmbientModelRuntimeProfile,
  type AmbientModelRuntimeProfile,
} from "../../shared/ambientModels";
import { ambientRequestedOutputTokens } from "./ambientModelLimits";

export function ambientModel(
  modelId: string,
  baseUrl: string,
  runtimeProfile?: AmbientModelRuntimeProfile,
  transport?: { requestModelId?: string },
): Model<"openai-completions"> {
  const normalizedModelId = normalizeAmbientModelId(modelId);
  const requestModelId = transport?.requestModelId?.trim() || normalizedModelId;
  const profile =
    runtimeProfile && normalizeAmbientModelId(runtimeProfile.modelId) === normalizedModelId
      ? runtimeProfile
      : resolveAmbientModelRuntimeProfile(normalizedModelId);
  const reasoningCapability = profile.reasoningCapability ?? resolveAmbientModelReasoningCapability(normalizedModelId);
  const thinkingLevelMap =
    reasoningCapability.payloadStrategy === "zai-reasoning-effort" && reasoningCapability.effortByThinkingLevel
      ? { ...reasoningCapability.effortByThinkingLevel }
      : undefined;
  const reasoningCompat =
    reasoningCapability.payloadStrategy === "zai-reasoning-effort"
      ? { supportsReasoningEffort: true }
      : reasoningCapability.payloadStrategy === "omit-reasoning-controls"
        ? { supportsReasoningEffort: false }
        : {};
  return {
    id: requestModelId,
    name: profile.label,
    api: "openai-completions",
    provider: "ambient",
    baseUrl,
    compat: {
      supportsDeveloperRole: false,
      zaiToolStream: true,
      ...reasoningCompat,
    },
    reasoning: true,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: profile.supportsVision ? ["text", "image"] : ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: profile.contextWindowTokens ?? 200000,
    maxTokens: ambientRequestedOutputTokens(profile.maxOutputTokens),
  };
}

export function createAmbientProviderExtension(model: Model<"openai-completions">): ExtensionFactory {
  return (pi) => {
    pi.registerProvider("ambient", {
      baseUrl: model.baseUrl,
      apiKey: "AMBIENT_API_KEY",
      api: "openai-completions",
      models: [model],
    });
  };
}
