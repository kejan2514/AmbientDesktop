import type { ProviderStatus } from "../../shared/desktopTypes";
import { AMBIENT_DEFAULT_MODEL, normalizeAmbientModelId } from "../../shared/ambientModels";
import {
  getActiveAmbientProviderBaseUrl,
  getActiveAmbientProviderId,
  getActiveAmbientProviderLabel,
  getActiveAmbientProviderModelOverride,
  getAmbientApiKeySource,
  readAmbientApiKey,
} from "./providerSecurityFacade";
import { gmiCloudRequestModelId } from "../ambient/gmiCloudModelRouting";

export function getAmbientProviderStatus(model = AMBIENT_DEFAULT_MODEL): ProviderStatus {
  const providerId = getActiveAmbientProviderId();
  const source = getAmbientApiKeySource();
  const canonicalModel = normalizeAmbientModelId(model);
  const providerModel = providerId === "gmi-cloud"
    ? gmiCloudRequestModelId(canonicalModel, getActiveAmbientProviderModelOverride(providerId))
    : canonicalModel;
  return {
    providerId,
    providerLabel: getActiveAmbientProviderLabel(providerId),
    debugOverride: providerId !== "ambient",
    baseUrl: normalizeAmbientBaseUrl(getActiveAmbientProviderBaseUrl(providerId)),
    model: providerModel,
    hasApiKey: Boolean(readAmbientApiKey()),
    source,
    storage: source === "saved" ? "os-encrypted" : source === "env" ? "environment" : "none",
  };
}

export function normalizeAmbientBaseUrl(baseUrl?: string): string {
  const root = (baseUrl || getActiveAmbientProviderBaseUrl() || "https://api.ambient.xyz").replace(/\/+$/, "");
  return root.endsWith("/v1") ? root : `${root}/v1`;
}
