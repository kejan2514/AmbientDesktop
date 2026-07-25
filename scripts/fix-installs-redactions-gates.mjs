#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { liveRunSettledAfterCurrentSend } from "./web-research-live-state.mjs";
import {
  assertFixInstallsRedactionsProviderAllowed,
  fixInstallsRedactionsGateForScenario,
  fixInstallsRedactionsGatePrompt,
  fixInstallsRedactionsInstalledUsePrompt,
  newFixInstallsRedactionsReport,
} from "./fix-installs-redactions-gates-lib.mjs";

const repoRoot = process.cwd();
const defaultDogfoodModel = "example/model-id";
const appWaitTimeoutMs = 90_000;
const cdpCommandTimeoutMs = 20_000;
const chatTurnTimeoutMs = Number(process.env.AMBIENT_FIX_INSTALLS_REDACTIONS_CHAT_TIMEOUT_MS ?? 180_000);
const scenario = parseScenario(process.argv.slice(2));
const gate = fixInstallsRedactionsGateForScenario(scenario);
const implementedScenarios = new Set([
  "provider-setup-baseline",
  "redaction-ref-identity",
  "builder-registration-repair",
  "provider-device-timeout-profiles",
  "provider-catalog-onboarding-e2e",
]);
const resultsDir = join(repoRoot, "test-results", "fix-installs-redactions", scenario);
const latestReportPath = join(resultsDir, "latest.json");
const artifactDir = join(resultsDir, "artifacts");
const provider = assertFixInstallsRedactionsProviderAllowed({
  providerId: process.env.AMBIENT_PROVIDER || "ambient",
  modelId: dogfoodModelId(),
});
const report = newFixInstallsRedactionsReport(gate, {
  provider,
  git: {
    branch: gitValue(["rev-parse", "--abbrev-ref", "HEAD"]),
    commit: gitValue(["rev-parse", "HEAD"]),
  },
  workspacePath: undefined,
  userDataPath: undefined,
});

let scratch;
let app;
let cdp;
let dogfoodEnv;
let exitCode = 0;

try {
  await rm(latestReportPath, { force: true });
  await mkdir(artifactDir, { recursive: true });
  if (!implementedScenarios.has(scenario)) {
    throw new Error(`${scenario} gate is not implemented until its phase lands.`);
  }
  scratch = await createScratch();
  report.workspacePath = scratch.workspacePath;
  report.userDataPath = scratch.userDataPath;
  const seed = await seedWorkspace(scratch.workspacePath, scratch.userDataPath, gate);
  dogfoodEnv = buildDogfoodEnv({
    AMBIENT_E2E: "1",
    AMBIENT_DESKTOP_WORKSPACE: scratch.workspacePath,
    AMBIENT_E2E_USER_DATA: scratch.userDataPath,
    AMBIENT_FIX_INSTALLS_REDACTIONS_GATE: gate.id,
    ...(gate.scenario === "provider-device-timeout-profiles" || gate.scenario === "provider-catalog-onboarding-e2e"
      ? {
        AMBIENT_COMMAND_AVAILABLE_DEVICES: "mps,cpu",
        AMBIENT_COMMAND_RECOMMENDED_DEVICE: "mps",
      }
      : {}),
  });
  await run("pnpm", ["run", "prepare:electron-native"], dogfoodEnv);

  app = launchDesktop(scratch);
  cdp = await connectToElectron(dogfoodCdpPort(), app);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await setViewport(cdp, 1450, 940);
  await waitForText(cdp, "Ambient", appWaitTimeoutMs);

  await captureAgentBrowserEvidence(dogfoodCdpPort(), scenario, report);
  await installLiveCollector(cdp);
  report.checks.ambientApiKey = await assertAmbientKey(cdp);
  const threadId = await createThread(cdp, `Fix installs/redactions ${gate.id}`);
  report.threadId = threadId;
  const promptContext = promptContextForGate(gate, seed);
  const prompt = fixInstallsRedactionsGatePrompt(gate, promptContext);
  report.evidence.promptPreview = prompt.slice(0, 2000);
  addScenarioChecks(report, gate, seed, prompt);
  const turn = gate.scenario === "provider-catalog-onboarding-e2e"
    ? await runProviderCatalogOnboardingTurns(cdp, threadId, prompt, seed, report, gate)
    : await runChatTurn(cdp, threadId, prompt);
  if (gate.scenario !== "provider-catalog-onboarding-e2e") {
    report.evidence.toolNames = turn.toolNames;
    report.evidence.permissionRequests = turn.live?.permissionRequests ?? [];
    report.evidence.permissionApprovals = turn.live?.permissionApprovals ?? [];
    report.evidence.assistantTail = turn.lastAssistantText.slice(-1000);
    report.checks.finalMarkerObserved = normalizeAssistantMarker(turn.lastAssistantText) === gate.marker;
    if (!report.checks.finalMarkerObserved) {
      throw new Error(`${gate.id} final marker mismatch. Final assistant message: ${turn.lastAssistantText.slice(-1000)}`);
    }
  }
  await assertScenarioTurn(report, gate, seed, turn);
  report.artifacts = {
    finalScreenshot: await writeScreenshot(cdp, `${scenario}-final.png`),
  };
  report.status = "passed";
} catch (error) {
  exitCode = 1;
  report.status = "failed";
  report.error = error instanceof Error ? error.stack ?? error.message : String(error);
  if (cdp) {
    report.artifacts = {
      ...(report.artifacts ?? {}),
      failureScreenshot: await writeScreenshot(cdp, `${scenario}-failure.png`).catch((screenshotError) => ({
        error: screenshotError instanceof Error ? screenshotError.message : String(screenshotError),
      })),
    };
    report.bodyTail = await bodyText(cdp).then((text) => text.slice(-3000)).catch(() => undefined);
    report.liveTail = await getLiveState(cdp).catch(() => undefined);
  }
  process.stderr.write(`${report.error}\n`);
} finally {
  report.completedAt = new Date().toISOString();
  await writeJson(latestReportPath, report);
  if (cdp) cdp.close();
  if (app) await terminateProcessTree(app);
  if (dogfoodEnv) {
    try {
      await run("pnpm", ["run", "prepare:node-native"], dogfoodEnv);
    } catch (error) {
      exitCode = 1;
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    }
  }
  if (scratch) await cleanupScratch(scratch);
}

process.exit(exitCode);

function parseScenario(argv) {
  let parsed = "provider-setup-baseline";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--scenario") parsed = argv[++index];
    else if (arg.startsWith("--scenario=")) parsed = arg.slice("--scenario=".length);
    else throw new Error(`Unknown fix-installs-redactions gate argument: ${arg}`);
  }
  return parsed;
}

async function runProviderCatalogOnboardingTurns(cdpClient, registrationThreadId, registrationPrompt, seed, reportObject, gateConfig) {
  const registrationTurn = await runChatTurn(cdpClient, registrationThreadId, registrationPrompt);
  reportObject.evidence.registrationAssistantTail = registrationTurn.lastAssistantText.slice(-1000);
  reportObject.checks.registrationMarkerObserved = normalizeAssistantMarker(registrationTurn.lastAssistantText) === seed.registrationMarker;
  if (!reportObject.checks.registrationMarkerObserved) {
    throw new Error(`${gateConfig.id} registration marker mismatch. Final registration message: ${registrationTurn.lastAssistantText.slice(-1000)}`);
  }

  const installedUseThreadId = await createThread(cdpClient, `Fix installs/redactions ${gateConfig.id} installed use`);
  const installedUsePrompt = fixInstallsRedactionsInstalledUsePrompt(gateConfig, {
    packageName: seed.packageName,
    commandName: seed.commandName,
    outputPath: seed.installedRunOutputPath,
  });
  reportObject.evidence.installedUseThreadId = installedUseThreadId;
  reportObject.evidence.installedUsePromptPreview = installedUsePrompt.slice(0, 2000);
  reportObject.checks.providerCatalogInstalledUsePrompt = {
    searchToolNamed: installedUsePrompt.includes("ambient_cli_search"),
    describeToolNamed: installedUsePrompt.includes("ambient_cli_describe"),
    runToolNamed: installedUsePrompt.includes("ambient_cli"),
    outputPathVisible: installedUsePrompt.includes(seed.installedRunOutputPath),
    cpuRegressionIncluded: installedUsePrompt.includes('"cpu"'),
    shellUseProhibited: /Do not use shell, bash, browser tools/.test(installedUsePrompt),
    noLiteralRedactedPlaceholder: !installedUsePrompt.includes("[REDACTED]"),
  };
  const failedPromptChecks = Object.entries(reportObject.checks.providerCatalogInstalledUsePrompt)
    .filter(([, value]) => value !== true)
    .map(([key]) => key);
  if (failedPromptChecks.length) {
    throw new Error(`${gateConfig.id} installed-use prompt checks failed: ${failedPromptChecks.join(", ")}`);
  }

  const installedUseTurn = await runChatTurn(cdpClient, installedUseThreadId, installedUsePrompt);
  reportObject.evidence.installedUseAssistantTail = installedUseTurn.lastAssistantText.slice(-1000);
  reportObject.checks.finalMarkerObserved = normalizeAssistantMarker(installedUseTurn.lastAssistantText) === gateConfig.marker;
  if (!reportObject.checks.finalMarkerObserved) {
    throw new Error(`${gateConfig.id} final marker mismatch. Final installed-use message: ${installedUseTurn.lastAssistantText.slice(-1000)}`);
  }

  const permissionRequests = [
    ...(registrationTurn.live?.permissionRequests ?? []),
    ...(installedUseTurn.live?.permissionRequests ?? []),
  ];
  const permissionApprovals = [
    ...(registrationTurn.live?.permissionApprovals ?? []),
    ...(installedUseTurn.live?.permissionApprovals ?? []),
  ];
  const permissionApprovalErrors = [
    ...(registrationTurn.live?.permissionApprovalErrors ?? []),
    ...(installedUseTurn.live?.permissionApprovalErrors ?? []),
  ];
  const toolNames = [...new Set([...registrationTurn.toolNames, ...installedUseTurn.toolNames])];
  reportObject.evidence.toolNames = toolNames;
  reportObject.evidence.permissionRequests = permissionRequests;
  reportObject.evidence.permissionApprovals = permissionApprovals;
  reportObject.evidence.assistantTail = installedUseTurn.lastAssistantText.slice(-1000);
  return {
    threadId: registrationThreadId,
    toolNames,
    live: {
      permissionRequests,
      permissionApprovals,
      permissionApprovalErrors,
    },
    messages: [...registrationTurn.messages, ...installedUseTurn.messages],
    assistantText: [registrationTurn.assistantText, installedUseTurn.assistantText].join("\n"),
    lastAssistantText: installedUseTurn.lastAssistantText,
    registrationTurn,
    installedUseTurn,
  };
}

async function seedWorkspace(workspacePath, userDataPath, gateConfig) {
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(workspacePath, "README.md"), [
    "# Fix Installs And Redactions Gate Workspace",
    "",
    "This scratch workspace is used by live Ambient Desktop dogfood gates.",
    `${gateConfig.id} verifies ${gateConfig.title}.`,
  ].join("\n"), "utf8");
  if (gateConfig.scenario === "builder-registration-repair") {
    return seedBuilderRegistrationRepairWorkspace(workspacePath, userDataPath);
  }
  if (gateConfig.scenario === "provider-device-timeout-profiles") {
    return seedProviderDeviceTimeoutWorkspace(workspacePath, userDataPath);
  }
  if (gateConfig.scenario === "provider-catalog-onboarding-e2e") {
    return seedProviderCatalogOnboardingWorkspace(workspacePath, userDataPath);
  }
  if (gateConfig.scenario !== "redaction-ref-identity") return {};

  const ordinaryPath = join(workspacePath, "src", "index.ts");
  const sensitivePath = join(workspacePath, "ignored-provider-key-file.txt");
  await mkdir(dirname(ordinaryPath), { recursive: true });
  await writeFile(ordinaryPath, "export const phase = 'redaction-ref-identity';\n", "utf8");
  await writeFile(sensitivePath, "test-only placeholder; not a credential\n", "utf8");
  return {
    ordinaryPath,
    sensitivePath,
    sensitivePathAlias: sensitivePathAliasForGate(sensitivePath),
  };
}

async function seedBuilderRegistrationRepairWorkspace(workspacePath, userDataPath) {
  const packageName = "ambient-g2-repair";
  const relativeRootPath = "./.ambient/capability-builder/packages/ambient-g2-repair";
  const packageRoot = join(workspacePath, ".ambient", "capability-builder", "packages", packageName);
  const manifestPath = join(packageRoot, "capability-build.json");
  const managedManifestPath = join(
    userDataPath,
    "managed-installs",
    ".ambient",
    "capability-builder",
    "packages",
    packageName,
    "capability-build.json",
  );
  const staleInstalledPackageId = "ambient-g2-repair-stale-installed-copy";
  const staleInstalledSource = "./.ambient/cli-packages/generated/ambient-g2-repair-stale-installed-copy";
  const staleInstalledRef = "1111111111111111111111111111111111111111";
  await mkdir(join(packageRoot, "scripts"), { recursive: true });
  await writeJson(join(packageRoot, "ambient-cli.json"), {
    schemaVersion: "ambient-cli-package-v1",
    name: packageName,
    version: "0.1.0",
    description: "G2 registration repair gate fixture.",
    skills: "./SKILL.md",
    commands: {
      g2_repair_echo: {
        command: "node",
        args: ["./scripts/run.mjs"],
        cwd: "package",
        healthCheck: ["node", "./scripts/run.mjs", "--health"],
      },
    },
  });
  await writeFile(join(packageRoot, "SKILL.md"), [
    "# Ambient G2 Repair Fixture",
    "",
    "Use this fixture only for the registration metadata repair live gate.",
  ].join("\n"), "utf8");
  await writeFile(join(packageRoot, "scripts", "run.mjs"), [
    "#!/usr/bin/env node",
    "if (process.argv.includes('--health')) {",
    "  console.log('ok');",
    "  process.exit(0);",
    "}",
    "console.log('g2 repair fixture');",
  ].join("\n"), "utf8");
  await writeJson(manifestPath, {
    schemaVersion: "ambient-capability-builder-v1",
    name: packageName,
    version: "0.1.0",
    status: "registered",
    goal: "Exercise first-class stale registration metadata repair.",
    sourcePath: relativeRootPath,
    registeredAt: "2026-06-20T00:00:00.000Z",
    installedPackageId: staleInstalledPackageId,
    installedSource: staleInstalledSource,
    installedVersion: "0.1.0",
    refs: {
      latest: "2222222222222222222222222222222222222222",
      installed: staleInstalledRef,
      lastValidated: "3333333333333333333333333333333333333333",
      lastValidatedHash: "4444444444444444444444444444444444444444",
    },
  });
  return {
    packageName,
    sourcePath: relativeRootPath,
    packageRoot,
    manifestPath,
    managedManifestPath,
    staleInstalledPackageId,
    staleInstalledSource,
    staleInstalledRef,
  };
}

async function seedProviderDeviceTimeoutWorkspace(workspacePath, userDataPath) {
  const packageName = "ambient-g3-device-timeout";
  const relativeRootPath = "./.ambient/capability-builder/packages/ambient-g3-device-timeout";
  const packageRoot = join(workspacePath, ".ambient", "capability-builder", "packages", packageName);
  const managedPackageRoot = join(
    userDataPath,
    "managed-installs",
    ".ambient",
    "capability-builder",
    "packages",
    packageName,
  );
  await mkdir(join(packageRoot, "scripts"), { recursive: true });
  await mkdir(join(packageRoot, "tests"), { recursive: true });
  await writeJson(join(packageRoot, "ambient-cli.json"), {
    schemaVersion: "ambient-cli-package-v1",
    name: packageName,
    version: "0.1.0",
    description: "G3 provider device and timeout profile gate fixture.",
    skills: "./SKILL.md",
    commands: {
      g3_model_probe: {
        command: "node",
        args: ["./scripts/provider.mjs"],
        cwd: "package",
        healthCheck: ["node", "./scripts/provider.mjs", "--mode", "doctor", "--device", "cpu"],
        timeoutProfile: "modelColdStart",
        progressPatterns: ["Loading checkpoint", "Generating"],
        devicePolicy: {
          prefer: ["mps", "cuda", "cpu"],
          requireReasonWhenCpuForced: true,
        },
      },
    },
  });
  await writeFile(join(packageRoot, "SKILL.md"), [
    "# Ambient G3 Device Timeout Fixture",
    "",
    "Use this fixture only for the provider device and timeout profile live gate.",
  ].join("\n"), "utf8");
  await writeFile(join(packageRoot, "scripts", "provider.mjs"), [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "const deviceIndex = args.indexOf('--device');",
    "const selectedDevice = deviceIndex >= 0 ? args[deviceIndex + 1] : null;",
    "const payload = {",
    "  argv: args,",
    "  selectedDevice,",
    "  availableDevices: String(process.env.AMBIENT_COMMAND_AVAILABLE_DEVICES || '').split(',').filter(Boolean),",
    "  recommendedDevice: process.env.AMBIENT_COMMAND_RECOMMENDED_DEVICE || null,",
    "  expectedColdStartMs: 600000,",
    "  requiresLongRun: true",
    "};",
    "process.stdout.write('Loading checkpoint\\n');",
    "process.stdout.write('Generating\\n');",
    "process.stdout.write(JSON.stringify(payload));",
  ].join("\n"), "utf8");
  await writeFile(join(packageRoot, "tests", "smoke.test.mjs"), "process.stdout.write('smoke skipped in G3');\n", "utf8");
  await writeJson(join(packageRoot, "capability-build.json"), {
    schemaVersion: "ambient-capability-builder-v1",
    name: packageName,
    version: "0.1.0",
    status: "draft",
    goal: "Exercise provider device selection and timeout profiles.",
    sourcePath: relativeRootPath,
    refs: {
      latest: "5555555555555555555555555555555555555555",
    },
  });
  return {
    packageName,
    sourcePath: relativeRootPath,
    packageRoot,
    managedPackageRoot,
    logPath: join(packageRoot, "capability-validation-log.jsonl"),
    managedLogPath: join(managedPackageRoot, "capability-validation-log.jsonl"),
  };
}

async function seedProviderCatalogOnboardingWorkspace(workspacePath, userDataPath) {
  const packageName = "ambient-g4-tinystyler";
  const commandName = "tinystyler_transfer";
  const relativeRootPath = "./.ambient/capability-builder/packages/ambient-g4-tinystyler";
  const packageRoot = join(workspacePath, ".ambient", "capability-builder", "packages", packageName);
  const managedPackageRoot = join(
    userDataPath,
    "managed-installs",
    ".ambient",
    "capability-builder",
    "packages",
    packageName,
  );
  const catalogContractPath = join(workspacePath, "provider-catalog", "tinystyler-contract.json");
  const manifestPath = join(packageRoot, "capability-build.json");
  const installedRunOutputPath = join(workspacePath, "g4-installed-transfer.txt");
  const staleInstalledPackageId = "ambient-g4-tinystyler-stale-installed-copy";
  const staleInstalledSource = "./.ambient/cli-packages/imported/ambient-g4-tinystyler-stale-installed-copy";
  const staleInstalledRef = "6666666666666666666666666666666666666666";

  await mkdir(join(packageRoot, "scripts"), { recursive: true });
  await mkdir(join(packageRoot, "tests"), { recursive: true });
  await writeJson(catalogContractPath, {
    id: "writing.tinystyler",
    displayName: "TinyStyler writing-style transfer",
    installerShape: "custom-cli",
    providerKind: "local",
    capabilityArea: "writing-style-transfer",
    requiredCommands: ["tinystyler_doctor", "tinystyler_profile", "tinystyler_transfer"],
    outputFileArtifacts: ["json", "txt"],
    devicePolicy: { prefer: ["mps", "cuda", "cpu"], requireReasonWhenCpuForced: true },
    timeoutProfiles: { doctor: "modelColdStart", transfer: "liveGeneration" },
  });
  await writeJson(join(packageRoot, "ambient-cli.json"), {
    schemaVersion: "ambient-cli-package-v1",
    name: packageName,
    version: "0.1.0",
    description: "G4 TinyStyler-like provider catalog onboarding fixture.",
    skills: "./SKILL.md",
    artifacts: {
      outputTypes: ["json", "txt"],
      policy: "Profile metadata is JSON and transfer output is text; validation must create both artifact types.",
    },
    responseFormats: ["json", "text"],
    commands: {
      tinystyler_doctor: {
        command: "node",
        args: ["./scripts/tinystyler.mjs", "--command", "doctor"],
        cwd: "package",
        healthCheck: ["node", "./scripts/tinystyler.mjs", "--command", "doctor", "--device", "cpu"],
        timeoutProfile: "modelColdStart",
        progressPatterns: ["Loading checkpoint", "Model ready"],
        devicePolicy: {
          prefer: ["mps", "cuda", "cpu"],
          requireReasonWhenCpuForced: true,
        },
      },
      tinystyler_profile: {
        command: "node",
        args: ["./scripts/tinystyler.mjs", "--command", "profile"],
        cwd: "package",
        healthCheck: ["node", "./scripts/tinystyler.mjs", "--command", "profile", "--output", "validation-artifacts/g4-profile.json"],
        timeoutProfile: "quickProbe",
      },
      tinystyler_transfer: {
        command: "node",
        args: ["./scripts/tinystyler.mjs", "--command", "transfer"],
        cwd: "package",
        healthCheck: [
          "node",
          "./scripts/tinystyler.mjs",
          "--command",
          "transfer",
          "--source",
          "Ambient setup gate.",
          "--profile",
          "validation-artifacts/g4-profile.json",
          "--output",
          "validation-artifacts/g4-transfer.txt",
          "--device",
          "cpu",
        ],
        timeoutProfile: "liveGeneration",
        progressPatterns: ["Generating style transfer"],
        devicePolicy: {
          prefer: ["mps", "cuda", "cpu"],
          requireReasonWhenCpuForced: true,
        },
      },
    },
  });
  await writeFile(join(packageRoot, "SKILL.md"), [
    "# Ambient G4 TinyStyler Fixture",
    "",
    "Use this fixture only for the provider catalog onboarding live gate.",
    "Call tinystyler_doctor before profile or transfer setup when checking runtime readiness.",
    "Call tinystyler_profile to create a compact reusable style profile artifact.",
    "Call tinystyler_transfer to produce the final text artifact.",
  ].join("\n"), "utf8");
  await writeFile(join(packageRoot, "scripts", "tinystyler.mjs"), [
    "#!/usr/bin/env node",
    "import { mkdirSync, writeFileSync } from 'node:fs';",
    "import { dirname, resolve } from 'node:path';",
    "",
    "const args = process.argv.slice(2);",
    "const value = (flag, fallback) => {",
    "  const index = args.indexOf(flag);",
    "  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;",
    "};",
    "const command = value('--command', 'doctor');",
    "const selectedDevice = value('--device', process.env.AMBIENT_COMMAND_RECOMMENDED_DEVICE || null);",
    "const availableDevices = String(process.env.AMBIENT_COMMAND_AVAILABLE_DEVICES || '').split(',').filter(Boolean);",
    "const payload = {",
    "  ok: true,",
    "  command,",
    "  selectedDevice,",
    "  availableDevices,",
    "  recommendedDevice: process.env.AMBIENT_COMMAND_RECOMMENDED_DEVICE || null,",
    "  expectedColdStartMs: command === 'doctor' ? 600000 : 180000,",
    "  requiresLongRun: command === 'doctor' || command === 'transfer'",
    "};",
    "",
    "if (command === 'doctor') {",
    "  console.log('Loading checkpoint');",
    "  console.log('Model ready');",
    "  console.log(JSON.stringify(payload));",
    "  process.exit(0);",
    "}",
    "",
    "const output = value('--output', command === 'profile' ? 'validation-artifacts/g4-profile.json' : 'validation-artifacts/g4-transfer.txt');",
    "const outputPath = resolve(process.cwd(), output);",
    "mkdirSync(dirname(outputPath), { recursive: true });",
    "",
    "if (command === 'profile') {",
    "  const profile = { provider: 'TinyStyler', profileId: 'g4-profile', examples: 2, selectedDevice };",
    "  writeFileSync(outputPath, `${JSON.stringify(profile, null, 2)}\\n`);",
    "  console.log(JSON.stringify({ ...payload, outputPath }));",
    "  process.exit(0);",
    "}",
    "",
    "if (command === 'transfer') {",
    "  console.log('Generating style transfer');",
    "  const source = value('--source', 'Ambient setup gate.');",
    "  writeFileSync(outputPath, `TinyStyler transfer (${selectedDevice || 'auto'}): ${source}\\n`);",
    "  console.log(JSON.stringify({ ...payload, outputPath }));",
    "  process.exit(0);",
    "}",
    "",
    "console.error(`Unsupported TinyStyler command: ${command}`);",
    "process.exit(2);",
  ].join("\n"), "utf8");
  await writeFile(join(packageRoot, "tests", "smoke.test.mjs"), [
    "import { spawnSync } from 'node:child_process';",
    "",
    "const result = spawnSync(process.execPath, [",
    "  'scripts/tinystyler.mjs',",
    "  '--command',",
    "  'transfer',",
    "  '--source',",
    "  'Smoke setup gate.',",
    "  '--profile',",
    "  'validation-artifacts/g4-profile.json',",
    "  '--output',",
    "  'validation-artifacts/g4-smoke-transfer.txt'",
    "], { cwd: process.cwd(), encoding: 'utf8', env: process.env });",
    "if (result.status !== 0) {",
    "  process.stderr.write(result.stderr || result.stdout);",
    "  process.exit(result.status || 1);",
    "}",
    "process.stdout.write(result.stdout);",
  ].join("\n"), "utf8");
  await writeJson(manifestPath, {
    schemaVersion: "ambient-capability-builder-v1",
    name: packageName,
    version: "0.1.0",
    status: "registered",
    goal: "Onboard TinyStyler writing-style transfer from provider catalog through repair, validation, registration, and installed use.",
    installerShape: "custom-cli",
    kind: "writing-style-transfer",
    provider: "TinyStyler",
    locality: "local",
    outputArtifactTypes: ["json", "txt"],
    sourcePath: relativeRootPath,
    registeredAt: "2026-06-20T00:00:00.000Z",
    installedPackageId: staleInstalledPackageId,
    installedSource: staleInstalledSource,
    installedVersion: "0.1.0",
    refs: {
      latest: "7777777777777777777777777777777777777777",
      installed: staleInstalledRef,
    },
  });
  const gitSha = initializeFixtureGit(packageRoot);

  return {
    packageName,
    commandName,
    sourcePath: relativeRootPath,
    packageRoot,
    managedPackageRoot,
    manifestPath,
    managedManifestPath: join(managedPackageRoot, "capability-build.json"),
    logPath: join(packageRoot, "capability-validation-log.jsonl"),
    managedLogPath: join(managedPackageRoot, "capability-validation-log.jsonl"),
    catalogDisplayName: "TinyStyler writing-style transfer",
    catalogContractPath,
    installedRunOutputPath,
    staleInstalledPackageId,
    staleInstalledSource,
    staleInstalledRef,
    gitSha,
    registrationMarker: "FIX_INSTALLS_REDACTIONS_G4_REGISTERED",
  };
}

function promptContextForGate(gateConfig, seed) {
  if (gateConfig.scenario === "builder-registration-repair") {
    return {
      packageName: seed.packageName,
      sourcePath: seed.sourcePath,
      staleInstalledPackageId: seed.staleInstalledPackageId,
      staleInstalledSource: seed.staleInstalledSource,
    };
  }
  if (gateConfig.scenario === "provider-device-timeout-profiles") {
    return {
      packageName: seed.packageName,
      sourcePath: seed.sourcePath,
    };
  }
  if (gateConfig.scenario === "provider-catalog-onboarding-e2e") {
    return {
      packageName: seed.packageName,
      sourcePath: seed.sourcePath,
      staleInstalledPackageId: seed.staleInstalledPackageId,
      catalogDisplayName: seed.catalogDisplayName,
      registrationMarker: seed.registrationMarker,
    };
  }
  if (gateConfig.scenario !== "redaction-ref-identity") return {};
  return {
    ordinaryPath: seed.ordinaryPath,
    sensitivePathAlias: seed.sensitivePathAlias,
  };
}

function addScenarioChecks(reportObject, gateConfig, seed, prompt) {
  if (gateConfig.scenario === "provider-catalog-onboarding-e2e") {
    reportObject.checks.providerCatalogPrompt = {
      packageNameVisible: prompt.includes(seed.packageName),
      sourcePathVisible: prompt.includes(seed.sourcePath),
      catalogNameVisible: prompt.includes(seed.catalogDisplayName),
      staleInstalledIdVisible: prompt.includes(seed.staleInstalledPackageId),
      repairToolNamed: prompt.includes("ambient_capability_builder_repair_registration_metadata"),
      validateToolNamed: prompt.includes("ambient_capability_builder_validate"),
      registerToolNamed: prompt.includes("ambient_capability_builder_register"),
      ambientCliDeferred: prompt.includes("Do not call ambient_cli in this turn"),
      listFilesBlowupProhibited: prompt.includes("Do not call any list-files tool"),
      ordinaryPathsVisible: prompt.includes("ordinary workspace paths must remain visible"),
      noLiteralRedactedPlaceholder: !prompt.includes("[REDACTED]"),
    };
    const failed = Object.entries(reportObject.checks.providerCatalogPrompt)
      .filter(([, value]) => value !== true)
      .map(([key]) => key);
    if (failed.length) {
      throw new Error(`${gateConfig.id} provider catalog prompt checks failed: ${failed.join(", ")}`);
    }
    return;
  }
  if (gateConfig.scenario === "provider-device-timeout-profiles") {
    reportObject.checks.deviceTimeoutPrompt = {
      packageNameVisible: prompt.includes(seed.packageName),
      sourcePathVisible: prompt.includes(seed.sourcePath),
      validateToolNamed: prompt.includes("ambient_capability_builder_validate"),
      shellUseProhibited: /Do not use shell, bash, generic file tools/.test(prompt),
      oldCpuRegressionMentioned: prompt.includes("--device cpu"),
    };
    const failed = Object.entries(reportObject.checks.deviceTimeoutPrompt)
      .filter(([, value]) => value !== true)
      .map(([key]) => key);
    if (failed.length) {
      throw new Error(`${gateConfig.id} device timeout prompt checks failed: ${failed.join(", ")}`);
    }
    return;
  }
  if (gateConfig.scenario === "builder-registration-repair") {
    reportObject.checks.registrationRepairPrompt = {
      packageNameVisible: prompt.includes(seed.packageName),
      sourcePathVisible: prompt.includes(seed.sourcePath),
      staleInstalledIdVisible: prompt.includes(seed.staleInstalledPackageId),
      historyToolNamed: prompt.includes("ambient_capability_builder_history"),
      repairToolNamed: prompt.includes("ambient_capability_builder_repair_registration_metadata"),
      shellMetadataEditProhibited: /Do not edit capability-build\.json through shell/.test(prompt),
    };
    const failed = Object.entries(reportObject.checks.registrationRepairPrompt)
      .filter(([, value]) => value !== true)
      .map(([key]) => key);
    if (failed.length) {
      throw new Error(`${gateConfig.id} registration repair prompt checks failed: ${failed.join(", ")}`);
    }
    return;
  }
  if (gateConfig.scenario !== "redaction-ref-identity") return;
  reportObject.checks.pathIdentity = {
    ordinaryPathVisibleInPrompt: prompt.includes(seed.ordinaryPath),
    sensitiveAliasVisibleInPrompt: prompt.includes(seed.sensitivePathAlias),
    sensitiveRawPathHiddenFromPrompt: !prompt.includes(seed.sensitivePath),
    noLiteralRedactedPlaceholder: !prompt.includes("[REDACTED]"),
  };
  const failed = Object.entries(reportObject.checks.pathIdentity)
    .filter(([, value]) => value !== true)
    .map(([key]) => key);
  if (failed.length) {
    throw new Error(`${gateConfig.id} path identity prompt checks failed: ${failed.join(", ")}`);
  }
}

async function assertScenarioTurn(reportObject, gateConfig, seed, turn) {
  if (gateConfig.scenario === "provider-catalog-onboarding-e2e") {
    await assertProviderCatalogOnboardingTurn(reportObject, gateConfig, seed, turn);
    return;
  }
  if (gateConfig.scenario === "provider-device-timeout-profiles") {
    await assertProviderDeviceTimeoutTurn(reportObject, gateConfig, seed, turn);
    return;
  }
  if (gateConfig.scenario === "builder-registration-repair") {
    await assertBuilderRegistrationRepairTurn(reportObject, gateConfig, seed, turn);
    return;
  }
  reportObject.checks.noToolCalls = turn.toolNames.length === 0;
  if (!reportObject.checks.noToolCalls) {
    throw new Error(`${gateConfig.id} gate expected no tool calls, saw: ${turn.toolNames.join(", ")}`);
  }
}

async function assertProviderCatalogOnboardingTurn(reportObject, gateConfig, seed, turn) {
  const registrationToolNames = turn.registrationTurn?.toolNames ?? [];
  const installedUseToolNames = turn.installedUseTurn?.toolNames ?? [];
  const registrationForbiddenPattern = /(?:^|_)(?:bash|shell|browser|file_write|write_file|edit_file|file_read|read_file|file_list|list_files|apply_patch|package_install|package_uninstall|capability_builder_list_files|ambient_cli|ambient_cli_search|ambient_cli_describe)(?:$|_)/i;
  const installedForbiddenPattern = /(?:^|_)(?:bash|shell|browser|file_write|write_file|edit_file|file_read|read_file|file_list|list_files|apply_patch|package_install|package_uninstall|capability_builder)(?:$|_)/i;
  const registrationForbiddenTools = registrationToolNames.filter((toolName) => registrationForbiddenPattern.test(toolName));
  const installedForbiddenTools = installedUseToolNames.filter((toolName) => installedForbiddenPattern.test(toolName));
  reportObject.checks.providerCatalogTools = {
    historyToolCalled: registrationToolNames.includes("ambient_capability_builder_history"),
    repairToolCalled: registrationToolNames.includes("ambient_capability_builder_repair_registration_metadata"),
    previewToolCalled: registrationToolNames.includes("ambient_capability_builder_preview"),
    validateToolCalled: registrationToolNames.includes("ambient_capability_builder_validate"),
    registerToolCalled: registrationToolNames.includes("ambient_capability_builder_register"),
    ambientCliSearchCalled: installedUseToolNames.includes("ambient_cli_search"),
    ambientCliDescribeCalled: installedUseToolNames.includes("ambient_cli_describe"),
    ambientCliRunCalled: installedUseToolNames.includes("ambient_cli"),
    registrationForbiddenToolsAbsent: registrationForbiddenTools.length === 0,
    installedForbiddenToolsAbsent: installedForbiddenTools.length === 0,
    registrationForbiddenTools,
    installedForbiddenTools,
    noLiteralRedactedPlaceholder: !String(turn.assistantText ?? "").includes("[REDACTED]"),
  };

  const permissionApprovals = turn.live?.permissionApprovals ?? [];
  const permissionErrors = turn.live?.permissionApprovalErrors ?? [];
  reportObject.checks.providerCatalogPermission = {
    repairPermissionApproved: permissionApprovals.some((request) => request.toolName === "ambient_capability_builder_repair_registration_metadata"),
    validatePermissionApproved: permissionApprovals.some((request) => request.toolName === "ambient_capability_builder_validate"),
    registerPermissionApproved: permissionApprovals.some((request) => request.toolName === "ambient_capability_builder_register"),
    ambientCliPermissionApproved: permissionApprovals.some((request) => request.toolName === "ambient_cli"),
    approvalErrorsAbsent: permissionErrors.length === 0,
    approvalErrors: permissionErrors,
  };

  const manifestPath = existsSync(seed.managedManifestPath) ? seed.managedManifestPath : seed.manifestPath;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const validationArtifacts = Array.isArray(manifest.lastValidationArtifacts) ? manifest.lastValidationArtifacts : [];
  reportObject.evidence.providerCatalogManifestPath = outputPathRelative(manifestPath);
  reportObject.checks.providerCatalogManifest = {
    statusRegistered: manifest.status === "registered",
    installerShapeCustomCli: manifest.installerShape === "custom-cli",
    providerTinyStyler: manifest.provider === "TinyStyler",
    registrationRepairTimestampPreserved: typeof manifest.registrationRepairedAt === "string" && manifest.registrationRepairedAt.length > 0,
    staleInstalledPackageIdPreserved: manifest.staleInstalledPackageId === seed.staleInstalledPackageId,
    installedPackageIdUpdated: typeof manifest.installedPackageId === "string" && manifest.installedPackageId !== seed.staleInstalledPackageId,
    installedSourceUpdated: typeof manifest.installedSource === "string" && manifest.installedSource !== seed.staleInstalledSource,
    refsInstalledNotStale: manifest.refs?.installed !== seed.staleInstalledRef,
    lastValidatedHashWritten: typeof manifest.refs?.lastValidatedHash === "string" && manifest.refs.lastValidatedHash.length > 0,
    validationArtifactsIncludeJson: validationArtifacts.some((artifact) => String(artifact.path ?? "").endsWith(".json")),
    validationArtifactsIncludeTxt: validationArtifacts.some((artifact) => String(artifact.path ?? "").endsWith(".txt")),
  };

  const logPath = existsSync(seed.managedLogPath) ? seed.managedLogPath : seed.logPath;
  if (!existsSync(logPath)) {
    throw new Error(`${gateConfig.id} expected validation log at ${logPath}`);
  }
  const logLines = (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean);
  const entries = logLines.map((line) => JSON.parse(line));
  const doctorEntry = entries.find((entry) => entry.source === "healthCheck" && entry.commandName === "tinystyler_doctor");
  const profileEntry = entries.find((entry) => entry.source === "healthCheck" && entry.commandName === "tinystyler_profile");
  const transferEntry = entries.find((entry) => entry.source === "healthCheck" && entry.commandName === "tinystyler_transfer");
  const smokeEntry = entries.find((entry) => entry.source === "smokeTest");
  reportObject.evidence.providerCatalogValidationLogPath = outputPathRelative(logPath);
  reportObject.evidence.providerCatalogValidationCommands = entries.map((entry) => ({
    source: entry.source,
    commandName: entry.commandName,
    status: entry.status,
    timeoutProfile: entry.timeoutProfile,
    deviceSelection: entry.deviceSelection,
  }));
  reportObject.checks.providerCatalogValidation = {
    doctorHealthSucceeded: doctorEntry?.status === "succeeded",
    profileHealthSucceeded: profileEntry?.status === "succeeded",
    transferHealthSucceeded: transferEntry?.status === "succeeded",
    smokeSucceeded: smokeEntry?.status === "succeeded",
    doctorUsesLongProfile: doctorEntry?.timeoutProfile === "modelColdStart" && Number(doctorEntry?.timeoutMs ?? 0) > 120_000,
    transferUsesLongProfile: transferEntry?.timeoutProfile === "liveGeneration" && Number(transferEntry?.timeoutMs ?? 0) > 120_000,
    doctorSelectedMps: doctorEntry?.deviceSelection?.selectedDevice === "mps",
    transferSelectedMps: transferEntry?.deviceSelection?.selectedDevice === "mps",
    doctorCpuOverridePrevented: doctorEntry?.deviceSelection?.cpuOverridePrevented === true,
    transferCpuOverridePrevented: transferEntry?.deviceSelection?.cpuOverridePrevented === true,
    doctorStdoutReportsMps: String(doctorEntry?.stdoutPreview ?? "").includes('"selectedDevice":"mps"'),
    transferStdoutReportsMps: String(transferEntry?.stdoutPreview ?? "").includes('"selectedDevice":"mps"'),
    transferProgressObserved: (transferEntry?.matchedProgressPatterns ?? []).includes("Generating style transfer"),
  };

  const output = await stat(seed.installedRunOutputPath).catch(() => undefined);
  const outputText = output ? await readFile(seed.installedRunOutputPath, "utf8") : "";
  const ambientCliToolText = (turn.installedUseTurn?.messages ?? [])
    .filter((message) => message.role === "tool" && message.metadata?.toolName === "ambient_cli")
    .map((message) => String(message.content ?? ""))
    .join("\n");
  reportObject.evidence.providerCatalogInstalledOutputPath = output ? outputPathRelative(seed.installedRunOutputPath) : undefined;
  reportObject.checks.providerCatalogInstalledUse = {
    outputFileCreated: Boolean(output?.isFile()),
    outputFileNonEmpty: Number(output?.size ?? 0) > 0,
    outputFileReportsMps: outputText.includes("(mps)"),
    ambientCliReportsMps: ambientCliToolText.includes('"selectedDevice":"mps"'),
    ambientCliReportsCpuOverridePrevented: ambientCliToolText.includes('"cpuOverridePrevented":true'),
    ambientCliUsesLongProfile: ambientCliToolText.includes("Timeout profile: liveGeneration"),
  };

  const failed = [
    ...Object.entries(reportObject.checks.providerCatalogTools)
      .filter(([key, value]) => !key.endsWith("ForbiddenTools") && value !== true)
      .map(([key]) => `tools.${key}`),
    ...Object.entries(reportObject.checks.providerCatalogPermission)
      .filter(([key, value]) => key !== "approvalErrors" && value !== true)
      .map(([key]) => `permission.${key}`),
    ...Object.entries(reportObject.checks.providerCatalogManifest)
      .filter(([, value]) => value !== true)
      .map(([key]) => `manifest.${key}`),
    ...Object.entries(reportObject.checks.providerCatalogValidation)
      .filter(([, value]) => value !== true)
      .map(([key]) => `validation.${key}`),
    ...Object.entries(reportObject.checks.providerCatalogInstalledUse)
      .filter(([, value]) => value !== true)
      .map(([key]) => `installedUse.${key}`),
  ];
  if (failed.length) {
    throw new Error(`${gateConfig.id} provider catalog onboarding checks failed: ${failed.join(", ")}. tools=${turn.toolNames.join(", ")}`);
  }
}

async function assertBuilderRegistrationRepairTurn(reportObject, gateConfig, seed, turn) {
  const toolNames = turn.toolNames;
  const forbiddenToolPattern = /(?:^|_)(?:bash|shell|file_write|write_file|edit_file|apply_patch|package_install|package_uninstall|capability_builder_register|capability_builder_unregister)(?:$|_)/i;
  const forbiddenTools = toolNames.filter((toolName) => forbiddenToolPattern.test(toolName));
  reportObject.checks.registrationRepairTools = {
    historyToolCalled: toolNames.includes("ambient_capability_builder_history"),
    repairToolCalled: toolNames.includes("ambient_capability_builder_repair_registration_metadata"),
    forbiddenMetadataEditToolsAbsent: forbiddenTools.length === 0,
    forbiddenTools,
  };
  const permissionApprovals = turn.live?.permissionApprovals ?? [];
  const permissionErrors = turn.live?.permissionApprovalErrors ?? [];
  reportObject.checks.registrationRepairPermission = {
    repairPermissionApproved: permissionApprovals.some((request) => request.toolName === "ambient_capability_builder_repair_registration_metadata"),
    approvalErrorsAbsent: permissionErrors.length === 0,
    approvalErrors: permissionErrors,
  };
  const repairedManifestPath = existsSync(seed.managedManifestPath) ? seed.managedManifestPath : seed.manifestPath;
  const manifest = JSON.parse(await readFile(repairedManifestPath, "utf8"));
  reportObject.evidence.registrationRepairManifestPath = outputPathRelative(repairedManifestPath);
  reportObject.checks.registrationRepairMetadata = {
    statusUnregistered: manifest.status === "unregistered",
    installedPackageIdCleared: manifest.installedPackageId === null,
    installedSourceCleared: manifest.installedSource === null,
    installedVersionCleared: manifest.installedVersion === null,
    refsInstalledCleared: manifest.refs?.installed === null,
    staleInstalledPackageIdPreserved: manifest.staleInstalledPackageId === seed.staleInstalledPackageId,
    staleInstalledSourcePreserved: manifest.staleInstalledSource === seed.staleInstalledSource,
    staleInstalledRefPreserved: manifest.staleInstalledRef === seed.staleInstalledRef,
    registrationRepairTimestampWritten: typeof manifest.registrationRepairedAt === "string" && manifest.registrationRepairedAt.length > 0,
    registrationRepairReasonWritten: typeof manifest.registrationRepairReason === "string" && manifest.registrationRepairReason.length > 0,
  };
  const failed = [
    ...Object.entries(reportObject.checks.registrationRepairTools)
      .filter(([key, value]) => key !== "forbiddenTools" && value !== true)
      .map(([key]) => `tools.${key}`),
    ...Object.entries(reportObject.checks.registrationRepairPermission)
      .filter(([key, value]) => key !== "approvalErrors" && value !== true)
      .map(([key]) => `permission.${key}`),
    ...Object.entries(reportObject.checks.registrationRepairMetadata)
      .filter(([, value]) => value !== true)
      .map(([key]) => `metadata.${key}`),
  ];
  if (failed.length) {
    throw new Error(`${gateConfig.id} registration repair checks failed: ${failed.join(", ")}. tools=${toolNames.join(", ")}`);
  }
}

async function assertProviderDeviceTimeoutTurn(reportObject, gateConfig, seed, turn) {
  const toolNames = turn.toolNames;
  const forbiddenToolPattern = /(?:^|_)(?:bash|shell|file_write|write_file|edit_file|apply_patch|package_install|package_uninstall|capability_builder_register|capability_builder_unregister)(?:$|_)/i;
  const forbiddenTools = toolNames.filter((toolName) => forbiddenToolPattern.test(toolName));
  reportObject.checks.deviceTimeoutTools = {
    validateToolCalled: toolNames.includes("ambient_capability_builder_validate"),
    forbiddenToolsAbsent: forbiddenTools.length === 0,
    forbiddenTools,
  };
  const permissionApprovals = turn.live?.permissionApprovals ?? [];
  const permissionErrors = turn.live?.permissionApprovalErrors ?? [];
  reportObject.checks.deviceTimeoutPermission = {
    validatePermissionApproved: permissionApprovals.some((request) => request.toolName === "ambient_capability_builder_validate"),
    approvalErrorsAbsent: permissionErrors.length === 0,
    approvalErrors: permissionErrors,
  };
  const logPath = existsSync(seed.managedLogPath) ? seed.managedLogPath : seed.logPath;
  if (!existsSync(logPath)) {
    throw new Error(`${gateConfig.id} expected validation log at ${logPath}`);
  }
  const logLines = (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean);
  const entries = logLines.map((line) => JSON.parse(line));
  const healthEntry = entries.find((entry) => entry.source === "healthCheck" && entry.commandName === "g3_model_probe");
  reportObject.evidence.deviceTimeoutValidationLogPath = outputPathRelative(logPath);
  reportObject.evidence.deviceTimeoutHealthEntry = healthEntry;
  reportObject.checks.deviceTimeoutValidation = {
    healthEntryPresent: Boolean(healthEntry),
    statusSucceeded: healthEntry?.status === "succeeded",
    timeoutProfileLong: ["modelColdStart", "liveGeneration"].includes(healthEntry?.timeoutProfile),
    timeoutOverOldHardCap: Number(healthEntry?.timeoutMs ?? 0) > 120_000,
    idleTimeoutRecorded: Number(healthEntry?.idleTimeoutMs ?? 0) > 0,
    selectedMps: healthEntry?.deviceSelection?.selectedDevice === "mps",
    requestedCpuRecorded: healthEntry?.deviceSelection?.requestedDevice === "cpu",
    cpuOverridePrevented: healthEntry?.deviceSelection?.cpuOverridePrevented === true,
    commandDoesNotForceCpu: !(healthEntry?.args ?? []).includes("cpu"),
    commandUsesMps: (healthEntry?.args ?? []).includes("mps"),
    stdoutReportsMps: String(healthEntry?.stdoutPreview ?? "").includes('"selectedDevice":"mps"'),
    progressObserved: (healthEntry?.matchedProgressPatterns ?? []).includes("Loading checkpoint"),
  };
  const failed = [
    ...Object.entries(reportObject.checks.deviceTimeoutTools)
      .filter(([key, value]) => key !== "forbiddenTools" && value !== true)
      .map(([key]) => `tools.${key}`),
    ...Object.entries(reportObject.checks.deviceTimeoutPermission)
      .filter(([key, value]) => key !== "approvalErrors" && value !== true)
      .map(([key]) => `permission.${key}`),
    ...Object.entries(reportObject.checks.deviceTimeoutValidation)
      .filter(([, value]) => value !== true)
      .map(([key]) => `validation.${key}`),
  ];
  if (failed.length) {
    throw new Error(`${gateConfig.id} device timeout checks failed: ${failed.join(", ")}. tools=${toolNames.join(", ")}`);
  }
}

function sensitivePathAliasForGate(pathValue) {
  const normalized = pathValue.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `<sensitive-path-ref:v1:${digest}>`;
}

async function captureAgentBrowserEvidence(port, scenarioName, reportObject) {
  const session = `fix-installs-redactions-${scenarioName}-${process.pid}`;
  await runAgentBrowser(["--session", session, "connect", String(port)], reportObject);
  const snapshot = await runAgentBrowser(["--session", session, "snapshot", "-i"], reportObject);
  const snapshotPath = join(artifactDir, `${scenarioName}-snapshot.txt`);
  await writeFile(snapshotPath, snapshot.stdout, "utf8");
  reportObject.evidence.snapshots.push(outputPathRelative(snapshotPath));
  const screenshotPath = join(artifactDir, `${scenarioName}-agent-browser.png`);
  await runAgentBrowser(["--session", session, "screenshot", screenshotPath], reportObject);
  reportObject.evidence.screenshots.push(outputPathRelative(screenshotPath));
}

async function runAgentBrowser(args, reportObject) {
  const fullArgs = ["exec", "agent-browser", ...args];
  const result = spawnSync("pnpm", fullArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 45_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record = {
    command: ["pnpm", ...fullArgs].join(" "),
    exitCode: result.status,
    stdoutPreview: String(result.stdout ?? "").slice(0, 1000),
    stderrPreview: String(result.stderr ?? "").slice(0, 1000),
  };
  reportObject.evidence.agentBrowserCommands.push(record);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`agent-browser command failed (${record.command}): ${record.stderrPreview || record.stdoutPreview}`);
  }
  return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

async function assertAmbientKey(cdpClient) {
  const hasEnvKey = Boolean(process.env.AMBIENT_API_KEY?.trim() || process.env.AMBIENT_AGENT_AMBIENT_API_KEY?.trim());
  const hasKeyFile = existsSync(ambientApiKeyFilePath());
  const result = await evaluate(cdpClient, async () => {
    if (!window.ambientDesktop.testAmbientApiKey) return { ok: true, skipped: true };
    return window.ambientDesktop.testAmbientApiKey();
  });
  if (!result?.ok && !hasEnvKey && !hasKeyFile) {
    throw new Error(`Ambient API key check failed: ${result?.message ?? "unknown error"}`);
  }
  return {
    rendererSavedKeyOk: result?.ok === true,
    envKeyConfigured: hasEnvKey,
    keyFileConfigured: hasKeyFile,
    skipped: result?.skipped === true,
  };
}

async function createThread(cdpClient, title) {
  const threadId = await evaluate(cdpClient, async (threadTitle, model) => {
    const state = await window.ambientDesktop.bootstrap();
    const next = await window.ambientDesktop.createThread({
      permissionMode: "workspace",
      collaborationMode: "agent",
      model: model || state.settings.model,
      thinkingLevel: "minimal",
    });
    const id = next.activeThreadId;
    if (window.ambientDesktop.updateThread) {
      await window.ambientDesktop.updateThread({ threadId: id, title: threadTitle });
    }
    await window.ambientDesktop.selectThread(id);
    return id;
  }, title, dogfoodModelId());
  assert(threadId, "createThread did not return an active thread id.");
  return threadId;
}

async function runChatTurn(cdpClient, threadId, content) {
  await resetLiveCollector(cdpClient);
  await evaluate(cdpClient, async (input) => {
    const live = window.__ambientFixInstallsRedactionsGate;
    const state = await window.ambientDesktop.bootstrap();
    await window.ambientDesktop.selectThread(input.threadId);
    window.ambientDesktop.sendMessage({
      threadId: input.threadId,
      content: input.content,
      permissionMode: "workspace",
      collaborationMode: "agent",
      model: input.model || state.settings.model,
      thinkingLevel: "minimal",
    })
      .then(() => {
        live.sendResolved = true;
      })
      .catch((error) => {
        live.error = error instanceof Error ? error.message : String(error);
      });
    return true;
  }, { threadId, content, model: dogfoodModelId() });
  await waitForLiveCompletion(cdpClient, chatTurnTimeoutMs);
  const state = await evaluate(cdpClient, async (id) => {
    await window.ambientDesktop.selectThread(id);
    return window.ambientDesktop.bootstrap();
  }, threadId);
  const live = await getLiveState(cdpClient);
  const messages = (state.messages ?? []).filter((message) => message.threadId === threadId);
  const toolNames = [
    ...(live?.toolNames ?? []),
    ...messages
      .filter((message) => message.role === "tool")
      .map((message) => String(message.metadata?.toolName ?? ""))
      .filter(Boolean),
  ];
  const assistantMessages = messages.filter((message) => message.role === "assistant" && message.metadata?.kind !== "thinking");
  const assistantText = assistantMessages.map((message) => message.content).join("\n");
  const lastAssistantText = assistantMessages.at(-1)?.content ?? "";
  return { threadId, assistantText, lastAssistantText, toolNames: [...new Set(toolNames)], live, messages };
}

async function installLiveCollector(cdpClient) {
  await evaluate(cdpClient, () => {
    window.__ambientFixInstallsRedactionsGate?.unsubscribe?.();
    window.__ambientFixInstallsRedactionsGate = {
      statuses: [],
      toolNames: [],
      runtimeActivities: [],
      assistantTail: "",
      sawRunStart: false,
      sawRunIdle: false,
      lastStatusAtMs: 0,
      sendResolved: true,
      error: undefined,
      permissionRequests: [],
      permissionApprovals: [],
      permissionApprovalErrors: [],
    };
    window.__ambientFixInstallsRedactionsGate.unsubscribe = window.ambientDesktop.onEvent((event) => {
      const live = window.__ambientFixInstallsRedactionsGate;
      if (event.type === "run-status") {
        live.lastStatusAtMs = Date.now();
        live.statuses.push(event.status);
        if (event.status !== "idle") live.sawRunStart = true;
        if (live.sawRunStart && event.status === "idle") live.sawRunIdle = true;
      }
      if (event.type === "runtime-activity") {
        live.runtimeActivities.push({
          kind: event.activity?.kind,
          status: event.activity?.status,
          toolName: event.activity?.toolName ?? event.activity?.details?.toolName,
          message: event.activity?.message,
        });
        live.runtimeActivities = live.runtimeActivities.slice(-40);
      }
      if (event.type === "message-delta") {
        live.assistantTail = (live.assistantTail + String(event.delta ?? "")).slice(-8000);
      }
      if ((event.type === "message-created" || event.type === "message-updated") && event.message?.role === "tool") {
        const toolName = String(event.message.metadata?.toolName ?? "");
        if (toolName) live.toolNames.push(toolName);
      }
      if (event.type === "permission-request") {
        const request = event.request ?? {};
        const text = [
          request.title,
          request.message,
          request.detail,
          request.toolName,
          request.grantTargetLabel,
        ].filter(Boolean).join("\n");
        live.permissionRequests.push({
          id: request.id,
          risk: request.risk,
          toolName: request.toolName,
          title: request.title,
          grantTargetLabel: request.grantTargetLabel,
        });
        live.permissionRequests = live.permissionRequests.slice(-20);
        const approvedBuilderTool = request.risk === "plugin-tool" &&
          /ambient_capability_builder_repair_registration_metadata|Registration Metadata Repair|Repair Capability Builder registration metadata|ambient_capability_builder_validate|Capability Builder Validate|Validate Capability Builder|ambient_capability_builder_register|Capability Builder Register|Register Ambient capability/i.test(text);
        const approvedAmbientCliRun = request.toolName === "ambient_cli" &&
          (request.risk === "plugin-tool" || request.risk === "workspace-command") &&
          /(?:^|\s)ambient_cli(?:\s|$)|Run Ambient CLI/im.test(text);
        if (request.id && (approvedBuilderTool || approvedAmbientCliRun)) {
          live.permissionApprovals.push({
            id: request.id,
            toolName: request.toolName,
            title: request.title,
          });
          window.ambientDesktop.respondPermissionRequest(request.id, "allow_once").catch((error) => {
            live.permissionApprovalErrors.push(error instanceof Error ? error.message : String(error));
          });
        }
      }
      if (event.type === "error") live.error = event.message;
    });
    return true;
  });
}

async function resetLiveCollector(cdpClient) {
  await evaluate(cdpClient, () => {
    const live = window.__ambientFixInstallsRedactionsGate;
    if (!live) return false;
    live.statuses = [];
    live.toolNames = [];
    live.runtimeActivities = [];
    live.assistantTail = "";
    live.sawRunStart = false;
    live.sawRunIdle = false;
    live.lastStatusAtMs = 0;
    live.sendResolved = false;
    live.error = undefined;
    live.permissionRequests = [];
    live.permissionApprovals = [];
    live.permissionApprovalErrors = [];
    return true;
  });
}

async function waitForLiveCompletion(cdpClient, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const live = await getLiveState(cdpClient);
    if (live?.error) throw new Error(live.error);
    if (liveRunSettledAfterCurrentSend(live, { idleGraceMs: 1_500 })) return;
    await delay(1_000);
  }
  const live = await getLiveState(cdpClient);
  throw new Error(`Timed out waiting for fix-installs-redactions gate chat turn. collector=${JSON.stringify(live)}`);
}

async function getLiveState(cdpClient) {
  return evaluate(cdpClient, () => {
    const live = window.__ambientFixInstallsRedactionsGate;
    return live ? {
      statuses: live.statuses,
      toolNames: live.toolNames,
      runtimeActivities: live.runtimeActivities,
      assistantTail: live.assistantTail,
      sawRunStart: live.sawRunStart,
      sawRunIdle: live.sawRunIdle,
      lastStatusAtMs: live.lastStatusAtMs,
      sendResolved: live.sendResolved,
      error: live.error,
      permissionRequests: live.permissionRequests,
      permissionApprovals: live.permissionApprovals,
      permissionApprovalErrors: live.permissionApprovalErrors,
    } : undefined;
  });
}

function launchDesktop(input) {
  return spawn("pnpm", [
    "exec",
    "electron-vite",
    "dev",
    "--",
    `--remote-debugging-port=${dogfoodCdpPort()}`,
  ], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: cleanChildEnv(dogfoodEnv ?? buildDogfoodEnv({
      AMBIENT_E2E: "1",
      AMBIENT_DESKTOP_WORKSPACE: input.workspacePath,
      AMBIENT_E2E_USER_DATA: input.userDataPath,
      AMBIENT_FIX_INSTALLS_REDACTIONS_GATE: gate.id,
    })),
  });
}

async function connectToElectron(port, child) {
  const started = Date.now();
  let lastOutput = "";
  child.stdout?.on("data", (chunk) => {
    lastOutput = `${lastOutput}${chunk.toString()}`.slice(-8000);
  });
  child.stderr?.on("data", (chunk) => {
    lastOutput = `${lastOutput}${chunk.toString()}`.slice(-8000);
  });
  while (Date.now() - started < 60_000) {
    if (child.exitCode !== null) {
      throw new Error(`Electron exited before CDP was available.\n${lastOutput}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
        if (page?.webSocketDebuggerUrl) return createCdpClient(page.webSocketDebuggerUrl);
      }
    } catch {
      // Keep polling until Electron exposes the debugger endpoint.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for Electron CDP on port ${port}.\n${lastOutput}`);
}

function createCdpClient(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (typeof message.id !== "number") return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message || "CDP command failed"));
    else waiter.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const waiter of pending.values()) waiter.reject(new Error("CDP socket closed"));
    pending.clear();
  });
  return {
    send(method, params = {}, options = {}) {
      const id = nextId++;
      const timeoutMs = options.timeoutMs ?? cdpCommandTimeoutMs;
      const ready = socket.readyState === WebSocket.OPEN
        ? Promise.resolve()
        : new Promise((resolveReady, rejectReady) => {
          const timeout = setTimeout(() => {
            rejectReady(new Error(`Timed out waiting for CDP socket open after ${timeoutMs}ms.`));
          }, timeoutMs);
          socket.addEventListener("open", () => {
            clearTimeout(timeout);
            resolveReady();
          }, { once: true });
          socket.addEventListener("error", () => {
            clearTimeout(timeout);
            rejectReady(new Error("CDP socket failed to open."));
          }, { once: true });
        });
      return ready.then(() => new Promise((resolveSend, rejectSend) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          rejectSend(new Error(`Timed out waiting for CDP ${method} after ${timeoutMs}ms.`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timeout);
            resolveSend(value);
          },
          reject: (error) => {
            clearTimeout(timeout);
            rejectSend(error);
          },
        });
        socket.send(JSON.stringify({ id, method, params }));
      }));
    },
    close() {
      socket.close();
    },
  };
}

async function waitForText(cdpClient, text, timeoutMs) {
  await waitFor(cdpClient, (expected) => document.body.innerText.includes(expected), timeoutMs, text);
}

async function waitFor(cdpClient, predicate, timeoutMs, ...args) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      if (await evaluate(cdpClient, predicate, ...args)) return;
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  const body = await bodyText(cdpClient).catch(() => "");
  throw new Error(`Timed out waiting for Electron UI condition.${lastError ? ` Last error: ${lastError.message}` : ""}\n\nBody tail:\n${body.slice(-2000)}`);
}

async function evaluate(cdpClient, fnOrExpression, ...args) {
  const expression = typeof fnOrExpression === "function"
    ? `(${fnOrExpression.toString()})(...${JSON.stringify(args)})`
    : String(fnOrExpression);
  const result = await cdpClient.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(`Runtime.evaluate failed: ${JSON.stringify(result.exceptionDetails)}`);
  return result.result?.value;
}

async function bodyText(cdpClient) {
  return evaluate(cdpClient, () => document.body.innerText);
}

async function setViewport(cdpClient, width, height) {
  await cdpClient.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function writeScreenshot(cdpClient, name) {
  await mkdir(artifactDir, { recursive: true });
  const result = await cdpClient.send("Page.captureScreenshot", { format: "png", fromSurface: true }, { timeoutMs: 30_000 });
  const outputPath = join(artifactDir, name);
  await writeFile(outputPath, Buffer.from(result.data, "base64"));
  return outputPathRelative(outputPath);
}

async function createScratch() {
  const root = await mkdtemp(join(tmpdir(), "ambient-fix-installs-redactions-"));
  const workspacePath = resolve(join(root, "workspace"));
  const userDataPath = resolve(join(root, "userData"));
  await mkdir(workspacePath, { recursive: true });
  await mkdir(userDataPath, { recursive: true });
  return { root, workspacePath, userDataPath };
}

async function cleanupScratch(input) {
  if (process.env.AMBIENT_FIX_INSTALLS_REDACTIONS_KEEP_SCRATCH === "1") {
    process.stdout.write(`Fix installs/redactions gate scratch retained at ${input.root}\n`);
    return;
  }
  await rm(input.root, { recursive: true, force: true });
}

async function terminateProcessTree(child) {
  if (child.exitCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    // Best effort cleanup.
  }
  const exited = await Promise.race([
    new Promise((resolveExit) => child.once("exit", () => resolveExit(true))),
    delay(8_000).then(() => false),
  ]);
  if (exited) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    // Best effort cleanup.
  }
}

async function run(command, args, env) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: cleanChildEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stdout += text;
    process.stdout.write(text);
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderr += text;
    process.stderr.write(text);
  });
  const [code, signal] = await new Promise((resolveExit) => {
    child.once("exit", (exitCode, exitSignal) => resolveExit([exitCode, exitSignal]));
  });
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${signal ?? code}.\n${stderr || stdout}`);
  }
  return { stdout, stderr };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function buildDogfoodEnv(overrides) {
  const next = {
    ...process.env,
    ...overrides,
    AMBIENT_PROVIDER: provider.providerId,
    AMBIENT_LIVE_MODEL: provider.modelId,
  };
  const keyFile = ambientApiKeyFilePath();
  if (existsSync(keyFile)) {
    if (!next.AMBIENT_API_KEY && !next.AMBIENT_API_KEY_FILE) next.AMBIENT_API_KEY_FILE = keyFile;
    if (!next.AMBIENT_AGENT_AMBIENT_API_KEY && !next.AMBIENT_AGENT_AMBIENT_API_KEY_FILE) {
      next.AMBIENT_AGENT_AMBIENT_API_KEY_FILE = keyFile;
    }
  }
  return cleanChildEnv(next);
}

function dogfoodModelId() {
  return process.env.AMBIENT_LIVE_MODEL || process.env.AMBIENT_MODEL || defaultDogfoodModel;
}

function dogfoodCdpPort() {
  const parsed = Number(process.env.AMBIENT_HARNESS_CDP_PORT || process.env.AMBIENT_SUBAGENT_DESKTOP_DOGFOOD_CDP_PORT);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 19813;
}

function ambientApiKeyFilePath() {
  if (process.env.AMBIENT_API_KEY_FILE) return process.env.AMBIENT_API_KEY_FILE;
  const candidates = [
    join(repoRoot, "ambient_api_key_u.txt"),
    join(repoRoot, "ignored-provider-key-file.txt"),
    join(dirname(repoRoot), "ambient_api_key_u.txt"),
    join(dirname(repoRoot), "ignored-provider-key-file.txt"),
    join(dirname(repoRoot), "ambientCoder", "ambient_api_key_u.txt"),
    join(dirname(repoRoot), "ambientCoder", "ignored-provider-key-file.txt"),
    join(dirname(dirname(repoRoot)), "ambient_api_key_u.txt"),
    join(dirname(dirname(repoRoot)), "ignored-provider-key-file.txt"),
    join(homedir(), "Documents", "ambientCoder", "ambient_api_key_u.txt"),
    join(homedir(), "Documents", "ambientCoder", "ignored-provider-key-file.txt"),
    join(homedir(), "Documents", "New project 3", "ambient_api_key_u.txt"),
    join(homedir(), "Documents", "New project 3", "ignored-provider-key-file.txt"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  let current = repoRoot;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(current, "ignored-provider-key-file.txt");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return join(repoRoot, "ignored-provider-key-file.txt");
}

function cleanChildEnv(env) {
  const next = { ...env };
  delete next.NODE_OPTIONS;
  delete next.VITEST;
  return next;
}

function outputPathRelative(path) {
  const rel = relative(repoRoot, path);
  return rel && !rel.startsWith("..") ? rel : path;
}

function gitValue(args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function initializeFixtureGit(rootPath) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Ambient Gate",
    GIT_AUTHOR_EMAIL: "ambient-gate@example.invalid",
    GIT_COMMITTER_NAME: "Ambient Gate",
    GIT_COMMITTER_EMAIL: "ambient-gate@example.invalid",
  };
  for (const args of [
    ["init", "-q"],
    ["add", "."],
    ["commit", "--no-gpg-sign", "-q", "-m", "Initial provider catalog fixture"],
  ]) {
    const fullArgs = ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args];
    const result = spawnSync("git", fullArgs, {
      cwd: rootPath,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      throw new Error(`git ${fullArgs.join(" ")} failed for fixture package: ${result.stderr || result.stdout}`);
    }
  }
  const revArgs = ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "rev-parse", "HEAD"];
  const rev = spawnSync("git", revArgs, {
    cwd: rootPath,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (rev.status !== 0) {
    throw new Error(`git rev-parse HEAD failed for fixture package: ${rev.stderr || rev.stdout}`);
  }
  return rev.stdout.trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeAssistantMarker(text) {
  return String(text ?? "").trim();
}
