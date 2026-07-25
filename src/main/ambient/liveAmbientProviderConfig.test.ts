import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AMBIENT_GLM_5_2_FP8_MODEL,
} from "../../shared/ambientModels";
import {
  applyLiveAmbientProviderApiKeyEnv,
  liveAmbientDirectHelperProfile,
  liveAmbientProviderBaseUrl,
  liveAmbientProviderId,
  liveAmbientProviderLabel,
  liveAmbientProviderModel,
  readLiveAmbientProviderApiKey,
} from "./liveAmbientProviderConfig";
import { GMI_CLOUD_GLM_5_2_FP8_MODEL } from "./gmiCloudModelRouting";

describe("liveAmbientProviderConfig", () => {
  let tempRoot = "";

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "ambient-live-provider-config-"));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("uses Ambient-compatible defaults when no override is active", () => {
    const env = { AMBIENT_API_KEY: "ambient-test-key", AMBIENT_WORKFLOW_MODEL: "ambient-model" } as NodeJS.ProcessEnv;

    expect(liveAmbientProviderId(env)).toBe("ambient");
    expect(liveAmbientProviderLabel(env)).toBe("Ambient");
    expect(liveAmbientProviderBaseUrl(env)).toBeUndefined();
    expect(liveAmbientProviderModel({ env })).toBe("ambient-model");
    expect(readLiveAmbientProviderApiKey({ env, cwd: tempRoot })).toBe("ambient-test-key");
  });

  it("finds the user-suffixed Ambient key file before the legacy local key filename", () => {
    writeFileSync(join(tempRoot, "ambient_api_key_u.txt"), "ambient-user-key\n", { mode: 0o600 });
    writeFileSync(join(tempRoot, "ignored-provider-key-file.txt"), "ambient-legacy-key\n", { mode: 0o600 });

    expect(readLiveAmbientProviderApiKey({ env: {} as NodeJS.ProcessEnv, cwd: tempRoot })).toBe("ambient-user-key");
  });

  it("keeps supported local API key filenames ignored by git", () => {
    const gitignore = readFileSync(resolve(process.cwd(), ".gitignore"), "utf8");

    expect(gitignore).toMatch(/^ambient_api_key\.txt$/m);
    expect(gitignore).toMatch(/^ambient_api_key_u\.txt$/m);
    expect(gitignore).toMatch(/^gmicloud-api-key\.txt$/m);
  });

  it("uses GMI Cloud env, base URL, model override, and key file when requested", () => {
    const keyPath = join(tempRoot, "gmi-key.txt");
    writeFileSync(keyPath, "gmi-test-key\n", { mode: 0o600 });
    const env = {
      AMBIENT_PROVIDER: "gmi-cloud",
      GMI_CLOUD_API_KEY_FILE: keyPath,
      GMI_CLOUD_BASE_URL: "https://example.gmi.test/v1",
      GMI_CLOUD_MODEL: "gmi-test-model",
      AMBIENT_WORKFLOW_MODEL: "ambient-test-model",
    } as NodeJS.ProcessEnv;

    expect(liveAmbientProviderId(env)).toBe("gmi-cloud");
    expect(liveAmbientProviderLabel(env)).toBe("GMI Cloud");
    expect(liveAmbientProviderBaseUrl(env)).toBe("https://example.gmi.test/v1");
    expect(liveAmbientProviderModel({ env })).toBe("gmi-test-model");
    expect(readLiveAmbientProviderApiKey({ env, cwd: tempRoot })).toBe("gmi-test-key");
  });

  it("uses a bounded direct-helper profile for GMI Cloud live smoke tests", () => {
    const env = { AMBIENT_PROVIDER: "gmi-cloud" } as NodeJS.ProcessEnv;

    const profile = liveAmbientDirectHelperProfile(env);

    expect(profile).toMatchObject({
      preStreamResponseTimeoutMs: 60_000,
      streamIdleTimeoutMs: 120_000,
      streamContentIdleTimeoutMs: 120_000,
      testTimeoutMs: 180_000,
    });
    expect(profile.retryPolicy).toMatchObject({
      enabled: true,
      maxRetries: 3,
      backoffMs: [1_000, 2_000, 3_000],
      providerMaxRetryDelayMs: 5_000,
    });
  });

  it("maps canonical Ambient model ids to GMI Cloud request ids", () => {
    expect(liveAmbientProviderModel({
      env: { AMBIENT_PROVIDER: "gmi-cloud" } as NodeJS.ProcessEnv,
      fallbackModel: AMBIENT_GLM_5_2_FP8_MODEL,
    })).toBe(GMI_CLOUD_GLM_5_2_FP8_MODEL);
  });

  it("allows direct-helper live timeout overrides", () => {
    const env = {
      AMBIENT_PROVIDER: "gmi-cloud",
      AMBIENT_DIRECT_HELPER_LIVE_PRE_STREAM_TIMEOUT_MS: "3456",
      AMBIENT_DIRECT_HELPER_LIVE_STREAM_IDLE_TIMEOUT_MS: "4567",
      AMBIENT_DIRECT_HELPER_LIVE_STREAM_CONTENT_IDLE_TIMEOUT_MS: "5678",
      AMBIENT_DIRECT_HELPER_LIVE_MAX_RETRIES: "2",
      AMBIENT_DIRECT_HELPER_LIVE_TEST_TIMEOUT_MS: "45678",
    } as NodeJS.ProcessEnv;

    const profile = liveAmbientDirectHelperProfile(env);

    expect(profile).toMatchObject({
      preStreamResponseTimeoutMs: 3456,
      streamIdleTimeoutMs: 4567,
      streamContentIdleTimeoutMs: 5678,
      testTimeoutMs: 45_678,
    });
    expect(profile.retryPolicy).toMatchObject({
      maxRetries: 2,
      backoffMs: [1_000, 2_000],
    });
  });

  it("allows direct-helper live retries to be disabled for narrow diagnostics", () => {
    const profile = liveAmbientDirectHelperProfile({
      AMBIENT_PROVIDER: "gmi-cloud",
      AMBIENT_DIRECT_HELPER_LIVE_MAX_RETRIES: "0",
    } as NodeJS.ProcessEnv);

    expect(profile.retryPolicy).toMatchObject({
      enabled: false,
      maxRetries: 0,
      backoffMs: [],
    });
  });

  it("binds live API keys to the active provider-specific environment variables", () => {
    const gmiEnv = { AMBIENT_PROVIDER: "gmi" } as NodeJS.ProcessEnv;
    applyLiveAmbientProviderApiKeyEnv("gmi-runtime-key", gmiEnv);
    expect(gmiEnv.GMI_CLOUD_API_KEY).toBe("gmi-runtime-key");
    expect(gmiEnv.GMI_API_KEY).toBe("gmi-runtime-key");
    expect(gmiEnv.AMBIENT_API_KEY).toBeUndefined();

    const ambientEnv = {} as NodeJS.ProcessEnv;
    applyLiveAmbientProviderApiKeyEnv("ambient-runtime-key", ambientEnv);
    expect(ambientEnv.AMBIENT_API_KEY).toBe("ambient-runtime-key");
    expect(ambientEnv.AMBIENT_AGENT_AMBIENT_API_KEY).toBe("ambient-runtime-key");
    expect(ambientEnv.GMI_CLOUD_API_KEY).toBeUndefined();
  });
});
