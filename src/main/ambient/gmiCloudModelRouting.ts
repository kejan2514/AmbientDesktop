import {
  AMBIENT_DEFAULT_MODEL,
  AMBIENT_GLM_5_2_FP8_MODEL,
  normalizeAmbientModelId,
} from "../../shared/ambientModels";

export const GMI_CLOUD_GLM_5_2_FP8_MODEL = "zai-org/GLM-5.2-FP8";

const GMI_CLOUD_REQUEST_MODEL_BY_AMBIENT_MODEL = new Map<string, string>([
  [AMBIENT_GLM_5_2_FP8_MODEL, GMI_CLOUD_GLM_5_2_FP8_MODEL],
]);

export function gmiCloudRequestModelId(requestedModelId: string, explicitOverride?: string): string {
  const override = explicitOverride?.trim();
  if (override) return override;
  const canonicalModelId = normalizeAmbientModelId(requestedModelId || AMBIENT_DEFAULT_MODEL);
  return GMI_CLOUD_REQUEST_MODEL_BY_AMBIENT_MODEL.get(canonicalModelId) ?? canonicalModelId;
}
