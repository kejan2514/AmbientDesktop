import { describe, expect, it } from "vitest";

import {
  FIX_INSTALLS_REDACTIONS_GATES,
  assertFixInstallsRedactionsProviderAllowed,
  fixInstallsRedactionsGateForScenario,
  fixInstallsRedactionsGatePrompt,
  fixInstallsRedactionsInstalledUsePrompt,
  fixInstallsRedactionsLatestArtifactPath,
  newFixInstallsRedactionsReport,
} from "./fix-installs-redactions-gates-lib.mjs";

describe("fix-installs-redactions gates", () => {
  it("defines the phased Electron dogfood gate contract", () => {
    expect(FIX_INSTALLS_REDACTIONS_GATES.map((gate) => gate.id)).toEqual(["G0", "G1", "G2", "G3", "G4"]);
    expect(FIX_INSTALLS_REDACTIONS_GATES.map((gate) => gate.scenario)).toEqual([
      "provider-setup-baseline",
      "redaction-ref-identity",
      "builder-registration-repair",
      "provider-device-timeout-profiles",
      "provider-catalog-onboarding-e2e",
    ]);
    expect(FIX_INSTALLS_REDACTIONS_GATES.every((gate) => gate.artifactPath.endsWith("/latest.json"))).toBe(true);
  });

  it("routes scenarios to latest artifacts used by run-electron-dogfood", () => {
    expect(fixInstallsRedactionsLatestArtifactPath("builder-registration-repair")).toBe(
      "test-results/fix-installs-redactions/builder-registration-repair/latest.json",
    );
    expect(() => fixInstallsRedactionsLatestArtifactPath("unknown")).toThrow(/Unsupported/);
  });

  it("keeps live gates on Ambient Kimi and rejects degraded Example Model", () => {
    expect(assertFixInstallsRedactionsProviderAllowed({
      providerId: "ambient",
      modelId: "example/model-id",
    })).toEqual({
      providerId: "ambient",
      modelId: "example/model-id",
    });
    expect(() => assertFixInstallsRedactionsProviderAllowed({
      providerId: "gmi-cloud",
      modelId: "example/model-id",
    })).toThrow(/AMBIENT_PROVIDER=ambient/);
    expect(() => assertFixInstallsRedactionsProviderAllowed({
      providerId: "ambient",
      modelId: "zai-org/glm-5.1",
    })).toThrow(/Example Model/);
  });

  it("builds a baseline prompt and report without exposing secrets", () => {
    const gate = fixInstallsRedactionsGateForScenario("provider-setup-baseline");
    expect(fixInstallsRedactionsGatePrompt(gate)).toContain("Do not call tools");
    const report = newFixInstallsRedactionsReport(gate, {
      provider: { providerId: "ambient", modelId: "example/model-id" },
      git: { branch: "branch", commit: "abc" },
      workspacePath: "/tmp/workspace",
      userDataPath: "/tmp/userData",
    });
    expect(JSON.stringify(report)).not.toContain("API_KEY");
    expect(report.evidence).toMatchObject({
      agentBrowserCommands: [],
      screenshots: [],
      snapshots: [],
      toolNames: [],
    });
  });

  it("builds a path identity prompt with ordinary paths and opaque aliases", () => {
    const gate = fixInstallsRedactionsGateForScenario("redaction-ref-identity");
    const prompt = fixInstallsRedactionsGatePrompt(gate, {
      ordinaryPath: "/tmp/workspace/src/index.ts",
      sensitivePathAlias: "<sensitive-path-ref:v1:0123456789abcdef>",
    });

    expect(prompt).toContain("/tmp/workspace/src/index.ts");
    expect(prompt).toContain("<sensitive-path-ref:v1:0123456789abcdef>");
    expect(prompt).toContain("not filesystem paths");
    expect(prompt).not.toContain("ignored-provider-key-file.txt");
    expect(prompt).not.toContain("[REDACTED]");
    expect(() => fixInstallsRedactionsGatePrompt(gate)).toThrow(/context\.ordinaryPath/);
  });

  it("builds a registration repair prompt that requires the typed Builder recovery path", () => {
    const gate = fixInstallsRedactionsGateForScenario("builder-registration-repair");
    const prompt = fixInstallsRedactionsGatePrompt(gate, {
      packageName: "ambient-g2-repair",
      sourcePath: "./.ambient/capability-builder/packages/ambient-g2-repair",
      staleInstalledPackageId: "stale-installed-id",
      staleInstalledSource: "./.ambient/cli-packages/generated/stale-installed-id",
    });

    expect(prompt).toContain("ambient_capability_builder_history");
    expect(prompt).toContain("ambient_capability_builder_repair_registration_metadata");
    expect(prompt).toContain("installed present is no");
    expect(prompt).toContain("Do not edit capability-build.json through shell");
    expect(prompt).toContain("FIX_INSTALLS_REDACTIONS_G2_REGISTRATION_REPAIR_OK");
    expect(() => fixInstallsRedactionsGatePrompt(gate)).toThrow(/context\.packageName/);
  });

  it("builds a provider device timeout prompt that requires Builder validation", () => {
    const gate = fixInstallsRedactionsGateForScenario("provider-device-timeout-profiles");
    const prompt = fixInstallsRedactionsGatePrompt(gate, {
      packageName: "ambient-g3-device-timeout",
      sourcePath: "./.ambient/capability-builder/packages/ambient-g3-device-timeout",
    });

    expect(prompt).toContain("ambient_capability_builder_validate");
    expect(prompt).toContain("includeSmokeTests=false");
    expect(prompt).toContain("--device cpu");
    expect(prompt).toContain("Do not use shell, bash, generic file tools");
    expect(prompt).toContain("FIX_INSTALLS_REDACTIONS_G3_DEVICE_TIMEOUT_OK");
    expect(() => fixInstallsRedactionsGatePrompt(gate)).toThrow(/context\.packageName/);
  });

  it("builds a provider catalog onboarding prompt with typed repair, validation, and registration", () => {
    const gate = fixInstallsRedactionsGateForScenario("provider-catalog-onboarding-e2e");
    const prompt = fixInstallsRedactionsGatePrompt(gate, {
      packageName: "ambient-g4-tinystyler",
      sourcePath: "./.ambient/capability-builder/packages/ambient-g4-tinystyler",
      staleInstalledPackageId: "stale-installed-id",
      catalogDisplayName: "TinyStyler writing-style transfer",
      registrationMarker: "FIX_INSTALLS_REDACTIONS_G4_REGISTERED",
    });

    expect(prompt).toContain("installerShape custom-cli");
    expect(prompt).toContain("ambient_capability_builder_history");
    expect(prompt).toContain("ambient_capability_builder_repair_registration_metadata");
    expect(prompt).toContain("ambient_capability_builder_validate");
    expect(prompt).toContain("ambient_capability_builder_register");
    expect(prompt).toContain("sourcePath above are authoritative");
    expect(prompt).toContain("continue with this exact sourcePath");
    expect(prompt).toContain("Do not call any list-files tool");
    expect(prompt).toContain("Do not call ambient_cli in this turn");
    expect(prompt).toContain("ordinary workspace paths must remain visible");
    expect(prompt).toContain("FIX_INSTALLS_REDACTIONS_G4_REGISTERED");
    expect(prompt).not.toContain("[REDACTED]");
    expect(() => fixInstallsRedactionsGatePrompt(gate)).toThrow(/context\.packageName/);
  });

  it("builds a provider catalog installed-use prompt for a fresh Ambient CLI turn", () => {
    const gate = fixInstallsRedactionsGateForScenario("provider-catalog-onboarding-e2e");
    const prompt = fixInstallsRedactionsInstalledUsePrompt(gate, {
      packageName: "ambient-g4-tinystyler",
      commandName: "tinystyler_transfer",
      outputPath: "/tmp/workspace/g4-installed-transfer.txt",
    });

    expect(prompt).toContain("ambient_cli_search");
    expect(prompt).toContain("ambient_cli_describe");
    expect(prompt).toContain("ambient_cli with packageName ambient-g4-tinystyler");
    expect(prompt).toContain("/tmp/workspace/g4-installed-transfer.txt");
    expect(prompt).toContain('"--device","cpu"');
    expect(prompt).toContain("Pass that args array exactly");
    expect(prompt).toContain("Desktop's deterministic devicePolicy boundary");
    expect(prompt).toContain("FIX_INSTALLS_REDACTIONS_G4_ONBOARDING_OK");
    expect(prompt).not.toContain("[REDACTED]");
    expect(() => fixInstallsRedactionsInstalledUsePrompt(fixInstallsRedactionsGateForScenario("provider-setup-baseline"))).toThrow(/only defined/);
  });
});
