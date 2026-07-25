import { describe, expect, it } from "vitest";
import {
  AMBIENT_DEFAULT_MODEL,
  AMBIENT_GLM_5_2_FP8_MODEL,
} from "../../shared/ambientModels";
import {
  GMI_CLOUD_GLM_5_2_FP8_MODEL,
  gmiCloudRequestModelId,
} from "./gmiCloudModelRouting";

describe("gmiCloudRequestModelId", () => {
  it("maps the canonical Ambient GLM 5.2 id to GMI Cloud's routing id", () => {
    expect(gmiCloudRequestModelId(AMBIENT_GLM_5_2_FP8_MODEL)).toBe(GMI_CLOUD_GLM_5_2_FP8_MODEL);
    expect(gmiCloudRequestModelId("glm-5.1")).toBe(GMI_CLOUD_GLM_5_2_FP8_MODEL);
  });

  it("preserves models whose provider id already matches GMI Cloud", () => {
    expect(gmiCloudRequestModelId(AMBIENT_DEFAULT_MODEL)).toBe(AMBIENT_DEFAULT_MODEL);
    expect(gmiCloudRequestModelId("custom/gmi-model")).toBe("custom/gmi-model");
  });

  it("lets an explicit GMI Cloud model override win without Ambient normalization", () => {
    expect(gmiCloudRequestModelId(AMBIENT_GLM_5_2_FP8_MODEL, " vendor/Exact-Model ")).toBe(
      "vendor/Exact-Model",
    );
  });
});
