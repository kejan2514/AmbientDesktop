import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AMBIENT_DEFAULT_MODEL } from "../../shared/ambientModels";
import { AGGRESSIVE_RETRY_BACKOFF_MS, aggressiveAmbientRetryPolicy, type AmbientRetryPolicy } from "./aggressiveRetries";
import { gmiCloudRequestModelId } from "./gmiCloudModelRouting";

export type LiveAmbientCompatibleProviderId = "ambient" | "gmi-cloud";

const gmiCloudDefaultBaseUrl = "https://api.gmi-serving.com";
const DEFAULT_AMBIENT_DIRECT_HELPER_PRE_STREAM_TIMEOUT_MS = 60_000;
const DEFAULT_AMBIENT_DIRECT_HELPER_STREAM_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_AMBIENT_DIRECT_HELPER_STREAM_CONTENT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_AMBIENT_DIRECT_HELPER_MAX_RETRIES = AGGRESSIVE_RETRY_BACKOFF_MS.length;
const DEFAULT_AMBIENT_DIRECT_HELPER_TEST_TIMEOUT_MS = 180_000;
const DEFAULT_GMI_DIRECT_HELPER_PRE_STREAM_TIMEOUT_MS = 60_000;
const DEFAULT_GMI_DIRECT_HELPER_STREAM_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_GMI_DIRECT_HELPER_STREAM_CONTENT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_GMI_DIRECT_HELPER_MAX_RETRIES = 3;
const DEFAULT_GMI_DIRECT_HELPER_TEST_TIMEOUT_MS = 180_000;

export interface LiveAmbientDirectHelperProfile {
  preStreamResponseTimeoutMs: number;
  streamIdleTimeoutMs: number;
  streamContentIdleTimeoutMs: number;
  retryPolicy: AmbientRetryPolicy;
  testTimeoutMs: number;
}

export function liveAmbientProviderId(env: NodeJS.ProcessEnv = process.env): LiveAmbientCompatibleProviderId {
  const raw = (env.AMBIENT_PROVIDER || env.AMBIENT_LLM_PROVIDER || "").trim().toLowerCase();
  return ["gmi", "gmi-cloud", "gmicloud", "gmi_cloud"].includes(raw) ? "gmi-cloud" : "ambient";
}

export function liveAmbientProviderLabel(env: NodeJS.ProcessEnv = process.env): string {
  return liveAmbientProviderId(env) === "gmi-cloud" ? "GMI Cloud" : "Ambient";
}

export function liveAmbientProviderBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (liveAmbientProviderId(env) === "gmi-cloud") return env.GMI_CLOUD_BASE_URL?.trim() || gmiCloudDefaultBaseUrl;
  return env.AMBIENT_BASE_URL?.trim() || env.AMBIENT_AGENT_AMBIENT_BASE_URL?.trim() || undefined;
}

export function liveAmbientProviderModel(input: {
  env?: NodeJS.ProcessEnv;
  preferredModelEnvNames?: string[];
  fallbackModel?: string;
} = {}): string {
  const env = input.env ?? process.env;
  let requestedModel: string | undefined;
  for (const name of input.preferredModelEnvNames ?? ["AMBIENT_WORKFLOW_MODEL", "AMBIENT_LIVE_MODEL"]) {
    const value = env[name]?.trim();
    if (value) {
      requestedModel = value;
      break;
    }
  }
  requestedModel ??= input.fallbackModel ?? AMBIENT_DEFAULT_MODEL;
  return liveAmbientProviderId(env) === "gmi-cloud"
    ? gmiCloudRequestModelId(requestedModel, env.GMI_CLOUD_MODEL)
    : requestedModel;
}

export function liveAmbientDirectHelperProfile(env: NodeJS.ProcessEnv = process.env): LiveAmbientDirectHelperProfile {
  const providerId = liveAmbientProviderId(env);
  const gmiCloud = providerId === "gmi-cloud";
  const preStreamResponseTimeoutMs = positiveEnvNumber(
    env,
    "AMBIENT_DIRECT_HELPER_LIVE_PRE_STREAM_TIMEOUT_MS",
    gmiCloud ? DEFAULT_GMI_DIRECT_HELPER_PRE_STREAM_TIMEOUT_MS : DEFAULT_AMBIENT_DIRECT_HELPER_PRE_STREAM_TIMEOUT_MS,
  );
  const streamIdleTimeoutMs = positiveEnvNumber(
    env,
    "AMBIENT_DIRECT_HELPER_LIVE_STREAM_IDLE_TIMEOUT_MS",
    gmiCloud ? DEFAULT_GMI_DIRECT_HELPER_STREAM_IDLE_TIMEOUT_MS : DEFAULT_AMBIENT_DIRECT_HELPER_STREAM_IDLE_TIMEOUT_MS,
  );
  const streamContentIdleTimeoutMs = positiveEnvNumber(
    env,
    "AMBIENT_DIRECT_HELPER_LIVE_STREAM_CONTENT_IDLE_TIMEOUT_MS",
    gmiCloud ? DEFAULT_GMI_DIRECT_HELPER_STREAM_CONTENT_IDLE_TIMEOUT_MS : DEFAULT_AMBIENT_DIRECT_HELPER_STREAM_CONTENT_IDLE_TIMEOUT_MS,
  );
  const maxRetries = nonNegativeEnvNumber(
    env,
    "AMBIENT_DIRECT_HELPER_LIVE_MAX_RETRIES",
    gmiCloud ? DEFAULT_GMI_DIRECT_HELPER_MAX_RETRIES : DEFAULT_AMBIENT_DIRECT_HELPER_MAX_RETRIES,
  );
  return {
    preStreamResponseTimeoutMs,
    streamIdleTimeoutMs,
    streamContentIdleTimeoutMs,
    retryPolicy: aggressiveAmbientRetryPolicy({
      maxRetries,
      backoffMs: AGGRESSIVE_RETRY_BACKOFF_MS.slice(0, Math.max(0, maxRetries)),
    }),
    testTimeoutMs: positiveEnvNumber(
      env,
      "AMBIENT_DIRECT_HELPER_LIVE_TEST_TIMEOUT_MS",
      gmiCloud ? DEFAULT_GMI_DIRECT_HELPER_TEST_TIMEOUT_MS : DEFAULT_AMBIENT_DIRECT_HELPER_TEST_TIMEOUT_MS,
    ),
  };
}

export function readLiveAmbientProviderApiKey(input: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  purpose?: string;
} = {}): string {
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const providerId = liveAmbientProviderId(env);
  const value = providerId === "gmi-cloud" ? readGmiCloudApiKey(env, cwd) : readAmbientApiKey(env, cwd);
  if (value) return value;
  const purpose = input.purpose ? ` for ${input.purpose}` : "";
  throw new Error(
    providerId === "gmi-cloud"
      ? `Set GMI_CLOUD_API_KEY, GMI_API_KEY, GMI_CLOUD_API_KEY_FILE, or provide ignored-provider-key-file.txt${purpose}.`
      : `Set AMBIENT_API_KEY, AMBIENT_AGENT_AMBIENT_API_KEY, AMBIENT_API_KEY_FILE, or provide ignored-provider-key-file.txt${purpose}.`,
  );
}

export function applyLiveAmbientProviderApiKeyEnv(apiKey: string, env: NodeJS.ProcessEnv = process.env): void {
  const trimmed = apiKey.trim();
  if (!trimmed) return;
  if (liveAmbientProviderId(env) === "gmi-cloud") {
    env.GMI_CLOUD_API_KEY = trimmed;
    env.GMI_API_KEY = trimmed;
  } else {
    env.AMBIENT_API_KEY = trimmed;
    env.AMBIENT_AGENT_AMBIENT_API_KEY = trimmed;
  }
}

function readAmbientApiKey(env: NodeJS.ProcessEnv, cwd: string): string | undefined {
  return (
    env.AMBIENT_API_KEY?.trim() ||
    env.AMBIENT_AGENT_AMBIENT_API_KEY?.trim() ||
    readKeyFile(env.AMBIENT_API_KEY_FILE) ||
    readKeyFileCandidates([
      join(cwd, "ambient_api_key_u.txt"),
      join(cwd, "ignored-provider-key-file.txt"),
      join(dirname(cwd), "ambient_api_key_u.txt"),
      join(dirname(cwd), "ignored-provider-key-file.txt"),
      join(dirname(cwd), "ambientCoder", "ambient_api_key_u.txt"),
      join(dirname(cwd), "ambientCoder", "ignored-provider-key-file.txt"),
      join(dirname(dirname(cwd)), "ambient_api_key_u.txt"),
      join(dirname(dirname(cwd)), "ignored-provider-key-file.txt"),
      join(homedir(), "Documents", "ambientCoder", "ambient_api_key_u.txt"),
      join(homedir(), "Documents", "ambientCoder", "ignored-provider-key-file.txt"),
      join(homedir(), "Documents", "New project 3", "ambient_api_key_u.txt"),
      join(homedir(), "Documents", "New project 3", "ignored-provider-key-file.txt"),
    ])
  );
}

function readGmiCloudApiKey(env: NodeJS.ProcessEnv, cwd: string): string | undefined {
  return (
    env.GMI_CLOUD_API_KEY?.trim() ||
    env.GMI_API_KEY?.trim() ||
    readKeyFile(env.GMI_CLOUD_API_KEY_FILE) ||
    readKeyFileCandidates([
      join(cwd, "ignored-provider-key-file.txt"),
      join(dirname(cwd), "ignored-provider-key-file.txt"),
      join(dirname(cwd), "ambientCoder", "ignored-provider-key-file.txt"),
      join(homedir(), "Documents", "ambientCoder", "ignored-provider-key-file.txt"),
      join(homedir(), "Documents", "New project 3", "ignored-provider-key-file.txt"),
    ])
  );
}

function readKeyFileCandidates(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    const value = readKeyFile(candidate);
    if (value) return value;
  }
  return undefined;
}

function readKeyFile(filePath: string | undefined): string | undefined {
  const candidate = filePath?.trim();
  if (!candidate || !existsSync(candidate)) return undefined;
  try {
    return readFileSync(candidate, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function positiveEnvNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeEnvNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}
