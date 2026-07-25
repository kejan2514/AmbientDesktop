import { describe, expect, it } from "vitest";
import {
  AMBIENT_DEFAULT_MODEL,
  AMBIENT_GLM_5_1_FP8_MODEL,
  AMBIENT_GLM_5_2_FP8_MODEL,
  resolveAmbientModelRuntimeProfile,
} from "../../shared/ambientModels";
import { ambientModel, createAmbientProviderExtension } from "./ambientProviderModel";
import { GMI_CLOUD_GLM_5_2_FP8_MODEL } from "./gmiCloudModelRouting";

describe("ambientProviderModel", () => {
  it("builds the Ambient Pi model descriptor", () => {
    expect(ambientModel("glm-5.1", "https://ambient.example/v1")).toEqual({
      id: AMBIENT_GLM_5_2_FP8_MODEL,
      name: "GLM 5.2",
      api: "openai-completions",
      provider: "ambient",
      baseUrl: "https://ambient.example/v1",
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        zaiToolStream: true,
      },
      reasoning: true,
      thinkingLevelMap: {
        minimal: "high",
        low: "high",
        medium: "high",
        high: "max",
        xhigh: "max",
      },
      input: ["text"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: 202752,
      maxTokens: 32000,
    });
    expect(ambientModel("glm-5.1", "https://ambient.example/v1").compat).not.toHaveProperty("thinkingFormat");
  });

  it("omits ZAI request controls from the Kimi descriptor while keeping hidden reasoning enabled", () => {
    expect(ambientModel(AMBIENT_DEFAULT_MODEL, "https://ambient.example/v1")).toMatchObject({
      id: AMBIENT_DEFAULT_MODEL,
      name: "Kimi K2.7 Code",
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        zaiToolStream: true,
      },
      reasoning: true,
      input: ["text", "image"],
    });
    expect(ambientModel(AMBIENT_DEFAULT_MODEL, "https://ambient.example/v1").compat).not.toHaveProperty("thinkingFormat");
    expect(ambientModel(AMBIENT_DEFAULT_MODEL, "https://ambient.example/v1")).not.toHaveProperty("thinkingLevelMap");
  });

  it("preserves reasoning compatibility defaults for unregistered Ambient-compatible models", () => {
    const model = ambientModel("custom/model", "https://ambient.example/v1");

    expect(model).toMatchObject({
      id: "custom/model",
      compat: {
        supportsDeveloperRole: false,
        zaiToolStream: true,
      },
      reasoning: true,
    });
    expect(model.compat).not.toHaveProperty("supportsReasoningEffort");
    expect(model.compat).not.toHaveProperty("thinkingFormat");
    expect(model).not.toHaveProperty("thinkingLevelMap");
  });

  it("uses a runtime profile for discovered Ambient-compatible models", () => {
    const model = ambientModel("moonshotai/kimi-k2.6", "https://ambient.example/v1", {
      ...resolveAmbientModelRuntimeProfile(AMBIENT_DEFAULT_MODEL),
      profileId: "ambient:moonshotai/kimi-k2.6",
      modelId: "moonshotai/kimi-k2.6",
      label: "Kimi K2.6",
      supportsVision: true,
    });

    expect(model).toMatchObject({
      id: "moonshotai/kimi-k2.6",
      name: "Kimi K2.6",
      compat: {
        supportsReasoningEffort: false,
      },
      input: ["text", "image"],
      contextWindow: 262144,
      maxTokens: 32000,
    });
  });

  it("uses a provider request id without losing canonical model capabilities", () => {
    expect(
      ambientModel(
        AMBIENT_GLM_5_2_FP8_MODEL,
        "https://gmi.example/v1",
        resolveAmbientModelRuntimeProfile(AMBIENT_GLM_5_2_FP8_MODEL),
        { requestModelId: GMI_CLOUD_GLM_5_2_FP8_MODEL },
      ),
    ).toMatchObject({
      id: GMI_CLOUD_GLM_5_2_FP8_MODEL,
      name: "GLM 5.2",
      contextWindow: 202752,
      maxTokens: 32000,
      compat: {
        supportsReasoningEffort: true,
      },
    });
  });

  it("advertises image input only for vision-capable Ambient models", () => {
    expect(ambientModel(AMBIENT_DEFAULT_MODEL, "https://ambient.example/v1").input).toEqual(["text", "image"]);
    expect(ambientModel(AMBIENT_GLM_5_1_FP8_MODEL, "https://ambient.example/v1").input).toEqual(["text"]);
  });

  it("registers the Ambient provider with Pi", () => {
    const model = ambientModel(AMBIENT_DEFAULT_MODEL, "https://ambient.example/v1");
    const registrations: Array<{ providerId: string; provider: unknown }> = [];
    const pi = {
      registerProvider(providerId: string, provider: unknown) {
        registrations.push({ providerId, provider });
      },
    };

    createAmbientProviderExtension(model)(pi as never);

    expect(registrations).toEqual([
      {
        providerId: "ambient",
        provider: {
          baseUrl: "https://ambient.example/v1",
          apiKey: "AMBIENT_API_KEY",
          api: "openai-completions",
          models: [model],
        },
      },
    ]);
  });
});
