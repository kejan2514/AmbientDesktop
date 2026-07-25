import { app, safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { registerSecretRedaction } from "./secretRedaction";
import { electronSecureSecretStore } from "./secureSecretStore";

const AMBIENT_API_KEY_ENV = "AMBIENT_API_KEY";
const AMBIENT_AGENT_API_KEY_ENV = "AMBIENT_AGENT_AMBIENT_API_KEY";
const AMBIENT_API_KEY_FILE_ENV = "AMBIENT_API_KEY_FILE";
const AMBIENT_AGENT_API_KEY_FILE_ENV = "AMBIENT_AGENT_AMBIENT_API_KEY_FILE";
const AMBIENT_PROVIDER_ENV = "AMBIENT_PROVIDER";
const AMBIENT_LLM_PROVIDER_ENV = "AMBIENT_LLM_PROVIDER";
const GMI_CLOUD_API_KEY_ENV = "GMI_CLOUD_API_KEY";
const GMI_API_KEY_ENV = "GMI_API_KEY";
const GMI_CLOUD_API_KEY_FILE_ENV = "GMI_CLOUD_API_KEY_FILE";
const GMI_CLOUD_BASE_URL_ENV = "GMI_CLOUD_BASE_URL";
const GMI_CLOUD_MODEL_ENV = "GMI_CLOUD_MODEL";
const startupEnvApiKey = process.env[AMBIENT_API_KEY_ENV] || process.env[AMBIENT_AGENT_API_KEY_ENV];
const startupGmiCloudApiKey = process.env[GMI_CLOUD_API_KEY_ENV] || process.env[GMI_API_KEY_ENV];
const ambientCredentialFileName = "ambient-api-key.enc";
const gmiCloudCredentialFileName = "gmi-cloud-api-key.enc";
const ambientDefaultApiKeyFile = "ignored-provider-key-file.txt";
const gmiCloudDefaultApiKeyFile = "ignored-provider-key-file.txt";
const ambientDefaultBaseUrl = "https://api.ambient.xyz";
const gmiCloudDefaultBaseUrl = "https://api.gmi-serving.com";
const defaultApiKeyTestTimeoutMs = 15_000;

export type AmbientCompatibleProviderId = "ambient" | "gmi-cloud";

export type AmbientApiKeySource = "saved" | "env" | "missing";

export interface AmbientApiKeyTestResult {
  ok: boolean;
  message: string;
}

export function readAmbientApiKey(): string | undefined {
  const providerId = getActiveAmbientProviderId();
  return rememberSecret(readSavedAmbientApiKey(providerId) || currentProviderApiKey(providerId));
}

export function getAmbientApiKeySource(): AmbientApiKeySource {
  const providerId = getActiveAmbientProviderId();
  if (readSavedAmbientApiKey(providerId)) return "saved";
  if (currentProviderApiKey(providerId)) return "env";
  return "missing";
}

export function saveAmbientApiKey(apiKey: string): void {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    throw new Error(`Paste a ${getActiveAmbientProviderLabel()} API key first.`);
  }
  const filePath = getCredentialFilePath(getActiveAmbientProviderId());
  if (!filePath) throw new Error("Secure credential storage path is unavailable.");
  const secureStore = electronSecureSecretStore({ appAvailable: true, safeStorage });
  secureStore.assertReady();
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, secureStore.encryptString(trimmed), { mode: 0o600 });
  registerSecretRedaction(trimmed);
}

export function clearSavedAmbientApiKey(): void {
  const filePath = getCredentialFilePath(getActiveAmbientProviderId());
  if (filePath && existsSync(filePath)) {
    rmSync(filePath, { force: true });
  }
}

export async function testAmbientApiKey(
  apiKey?: string,
  baseUrl?: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<AmbientApiKeyTestResult> {
  const providerLabel = getActiveAmbientProviderLabel();
  const key = (apiKey || readAmbientApiKey() || "").trim();
  if (!key) {
    return { ok: false, message: `Paste a ${providerLabel} API key first.` };
  }

  const endpoint = `${normalizeAmbientBaseUrl(baseUrl)}/models`;
  const timeoutMs = apiKeyTestTimeoutMs(options.timeoutMs);
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`${providerLabel} API key test timed out after ${timeoutMs.toLocaleString()}ms.`));
  }, timeoutMs);
  timeout.unref?.();
  try {
    const response = await (options.fetchImpl ?? fetch)(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (response.ok) {
      return { ok: true, message: `${providerLabel} API key connected.` };
    }
    const body = (await response.text()).replace(/\s+/g, " ").trim();
    return {
      ok: false,
      message: body
        ? `${providerLabel} rejected the key (${response.status}): ${body.slice(0, 180)}`
        : `${providerLabel} rejected the key (${response.status}).`,
    };
  } catch (error) {
    if (timedOut) {
      return { ok: false, message: `${providerLabel} API key test timed out after ${timeoutMs.toLocaleString()}ms.` };
    }
    return {
      ok: false,
      message: error instanceof Error ? error.message : `Could not reach ${providerLabel}.`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function getActiveAmbientProviderId(): AmbientCompatibleProviderId {
  const raw = (process.env[AMBIENT_PROVIDER_ENV] || process.env[AMBIENT_LLM_PROVIDER_ENV] || "").trim().toLowerCase();
  if (["gmi", "gmi-cloud", "gmicloud", "gmi_cloud"].includes(raw)) return "gmi-cloud";
  return "ambient";
}

export function getActiveAmbientProviderLabel(providerId = getActiveAmbientProviderId()): string {
  return providerId === "gmi-cloud" ? "GMI Cloud" : "Ambient";
}

export function getActiveAmbientProviderBaseUrl(providerId = getActiveAmbientProviderId()): string | undefined {
  if (providerId === "gmi-cloud") return process.env[GMI_CLOUD_BASE_URL_ENV] || gmiCloudDefaultBaseUrl;
  return process.env.AMBIENT_BASE_URL || process.env.AMBIENT_AGENT_AMBIENT_BASE_URL || ambientDefaultBaseUrl;
}

export function getActiveAmbientProviderModelOverride(providerId = getActiveAmbientProviderId()): string | undefined {
  if (providerId === "gmi-cloud") return process.env[GMI_CLOUD_MODEL_ENV];
  return undefined;
}

function readSavedAmbientApiKey(providerId: AmbientCompatibleProviderId): string | undefined {
  const filePath = getCredentialFilePath(providerId);
  if (!filePath) return undefined;
  if (!existsSync(filePath)) return undefined;
  try {
    return electronSecureSecretStore({ appAvailable: true, safeStorage }).decryptString(readFileSync(filePath));
  } catch (error) {
    console.warn("Failed to decrypt saved Ambient API key", error);
    return undefined;
  }
}

function getCredentialFilePath(providerId: AmbientCompatibleProviderId): string | undefined {
  if (typeof app?.getPath !== "function") return undefined;
  return join(app.getPath("userData"), providerId === "gmi-cloud" ? gmiCloudCredentialFileName : ambientCredentialFileName);
}

function currentProviderApiKey(providerId: AmbientCompatibleProviderId): string | undefined {
  return providerId === "gmi-cloud" ? currentGmiCloudApiKey() : currentAmbientEnvApiKey();
}

function currentAmbientEnvApiKey(): string | undefined {
  return (
    process.env[AMBIENT_API_KEY_ENV] ||
    process.env[AMBIENT_AGENT_API_KEY_ENV] ||
    readApiKeyFile(process.env[AMBIENT_API_KEY_FILE_ENV]) ||
    readApiKeyFile(process.env[AMBIENT_AGENT_API_KEY_FILE_ENV]) ||
    readApiKeyFile(join(process.cwd(), ambientDefaultApiKeyFile)) ||
    startupEnvApiKey
  );
}

function currentGmiCloudApiKey(): string | undefined {
  return (
    process.env[GMI_CLOUD_API_KEY_ENV] ||
    process.env[GMI_API_KEY_ENV] ||
    readApiKeyFile(process.env[GMI_CLOUD_API_KEY_FILE_ENV]) ||
    readApiKeyFileCandidates([
      join(process.cwd(), gmiCloudDefaultApiKeyFile),
      join(dirname(process.cwd()), gmiCloudDefaultApiKeyFile),
      join(dirname(process.cwd()), "ambientCoder", gmiCloudDefaultApiKeyFile),
      join(homedir(), "ambientCoder", gmiCloudDefaultApiKeyFile),
      join(homedir(), "Documents", "ambientCoder", gmiCloudDefaultApiKeyFile),
    ]) ||
    startupGmiCloudApiKey
  );
}

function readApiKeyFileCandidates(filePaths: string[]): string | undefined {
  for (const filePath of filePaths) {
    const value = readApiKeyFile(filePath);
    if (value) return value;
  }
  return undefined;
}

function readApiKeyFile(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  if (!existsSync(filePath)) return undefined;
  try {
    const value = readFileSync(filePath, "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function apiKeyTestTimeoutMs(override: number | undefined): number {
  const envValue = Number(process.env.AMBIENT_API_KEY_TEST_TIMEOUT_MS);
  const value = override ?? (Number.isFinite(envValue) && envValue > 0 ? envValue : defaultApiKeyTestTimeoutMs);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : defaultApiKeyTestTimeoutMs;
}

function rememberSecret(value: string | undefined): string | undefined {
  if (value) registerSecretRedaction(value);
  return value;
}

function normalizeAmbientBaseUrl(baseUrl?: string): string {
  const root = (baseUrl || getActiveAmbientProviderBaseUrl() || ambientDefaultBaseUrl).replace(/\/+$/, "");
  return root.endsWith("/v1") ? root : `${root}/v1`;
}
