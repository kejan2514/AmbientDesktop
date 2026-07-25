import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveAmbientModelRuntimeProfile } from "../../shared/ambientModels";
import {
  ambientModelLimitObservationFromDiscoveredProfile,
  ambientModelLimitObservationFromOverflow,
  ambientProviderInputTokenBudget,
  ambientRequestedOutputTokens,
  applyAmbientModelLimitObservation,
  applyAmbientModelLimitObservationToRegisteredProfile,
  mergeAmbientModelLimitObservation,
  parseAmbientProviderContextOverflow,
  readAmbientModelLimitObservations,
  writeAmbientModelLimitObservations,
} from "./ambientModelLimits";

const exactOverflow = new Error(
  '400 {"error":{"message":"This model\'s maximum context length is 101376 tokens. However, you requested 32000 output tokens and your prompt contains at least 69377 input tokens, for a total of at least 101377 tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=69377)","type":"BadRequestError","param":"input_tokens","code":400}}',
);

describe("Ambient effective model limits", () => {
  it("matches Pi's OpenAI-compatible default output request cap", () => {
    expect(ambientRequestedOutputTokens(202_752)).toBe(32_000);
    expect(ambientRequestedOutputTokens(8_192)).toBe(8_192);
    expect(ambientRequestedOutputTokens(undefined)).toBe(32_000);
  });

  it("reserves requested output and a safety margin from the combined provider window", () => {
    expect(ambientProviderInputTokenBudget({
      contextWindowTokens: 101_376,
      requestedOutputTokens: 32_000,
      configuredReserveTokens: 16_384,
      safetyMarginTokens: 256,
    })).toBe(69_120);
  });

  it("parses the provider's structured combined-token overflow", () => {
    expect(parseAmbientProviderContextOverflow(exactOverflow)).toMatchObject({
      contextWindowTokens: 101_376,
      requestedOutputTokens: 32_000,
      inputTokens: 69_377,
      requestedTotalTokens: 101_377,
      parameter: "input_tokens",
      code: 400,
    });
  });

  it("does not classify unrelated provider 400 responses as context overflows", () => {
    expect(parseAmbientProviderContextOverflow(new Error("400 invalid request schema"))).toBeUndefined();
  });

  it("parses the same overflow from nested provider response data", () => {
    expect(parseAmbientProviderContextOverflow({
      response: {
        status: 400,
        data: {
          error: {
            message: "This model's maximum context length is 101376 tokens. However, you requested 32000 output tokens and your prompt contains at least 69377 input tokens, for a total of at least 101377 tokens.",
            code: 400,
          },
        },
      },
    })).toMatchObject({ contextWindowTokens: 101_376, requestedOutputTokens: 32_000 });
  });

  it("keeps a fresh provider-observed bound when discovery advertises a larger window", () => {
    const now = new Date("2026-07-21T12:00:00.000Z");
    const profile = resolveAmbientModelRuntimeProfile("zai-org/GLM-5.2-FP8");
    const providerObserved = ambientModelLimitObservationFromOverflow({
      baseUrl: "https://api.ambient.xyz/v1",
      modelId: profile.modelId,
      overflow: parseAmbientProviderContextOverflow(exactOverflow)!,
      advertisedContextWindowTokens: profile.contextWindowTokens,
      now,
    });
    const discovered = ambientModelLimitObservationFromDiscoveredProfile({
      baseUrl: "https://api.ambient.xyz/v1",
      profile,
      now: new Date(now.getTime() + 60_000),
    })!;

    const merged = mergeAmbientModelLimitObservation(providerObserved, discovered);
    expect(merged).toMatchObject({
      source: "provider-error",
      contextWindowTokens: 101_376,
      advertisedContextWindowTokens: 202_752,
    });
    expect(applyAmbientModelLimitObservation(profile, merged, now.getTime() + 120_000)).toMatchObject({
      contextWindowTokens: 101_376,
      limitMetadata: {
        source: "provider-error",
        requestedOutputTokens: 32_000,
        advertisedContextWindowTokens: 202_752,
      },
    });
  });

  it("does not recreate a discovered model as an invalid unknown-provider profile before rediscovery", () => {
    const now = new Date("2026-07-21T12:00:00.000Z");
    const unknownProfile = resolveAmbientModelRuntimeProfile("deepseek/deepseek-v4-flash");
    const observation = ambientModelLimitObservationFromDiscoveredProfile({
      baseUrl: "https://api.ambient.xyz/v1",
      profile: {
        ...unknownProfile,
        providerId: "ambient",
        contextWindowTokens: 131_072,
        maxOutputTokens: 16_384,
      },
      now,
    })!;

    expect(applyAmbientModelLimitObservationToRegisteredProfile(
      unknownProfile,
      observation,
      now.getTime(),
    )).toBeUndefined();
  });

  it("persists only normalized, unexpired, secret-free observations", () => {
    const userDataPath = mkdtempSync(join(tmpdir(), "ambient-model-limits-"));
    const now = new Date("2026-07-21T12:00:00.000Z");
    const observation = ambientModelLimitObservationFromOverflow({
      baseUrl: "https://api.ambient.xyz/v1",
      modelId: "zai-org/GLM-5.2-FP8",
      overflow: parseAmbientProviderContextOverflow(exactOverflow)!,
      now,
    });

    writeAmbientModelLimitObservations(userDataPath, [observation], now.getTime());
    expect(readAmbientModelLimitObservations(userDataPath, now.getTime())).toEqual([observation]);
    const persisted = readFileSync(join(userDataPath, "ambient-model-limit-observations.json"), "utf8");
    expect(persisted).not.toContain("apiKey");
    expect(persisted).not.toContain("Bearer");
  });
});
