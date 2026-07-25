#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
const DEFAULT_PROVIDER = "gmi-cloud";
const DEFAULT_BOOTSTRAP_WATCHDOG_MS = "180000";
const DEFAULT_SCENARIOS = [
  "project-board-long-names-desktop",
  "project-board-draft-detail-open",
  "project-board-pm-review-open",
  "local-tasks-long-names-compact",
  "local-tasks-edit-card-open",
];

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const options = parseOptions(process.argv.slice(2), process.env);
  validateOptions(options);
  await assertDirectory(options.sourceUserData, "source user data");
  await assertDirectory(options.sourceWorkspace, "source workspace");
  await prepareRunRoot(options);
  const credential = resolveProviderCredential(options.providerId, process.env);
  const collectorArgs = buildCollectorArgs(options);
  const childEnv = buildCollectorEnv(options, credential);

  if (options.dryRun) {
    await writeReviewReports(options, {
      status: "dry-run",
      dryRun: true,
      providerId: options.providerId,
      credentialSources: credential.sources,
      sourceUserData: options.sourceUserData,
      sourceWorkspace: options.sourceWorkspace,
      runRoot: options.runRoot,
      userData: options.userData,
      workspace: options.workspace,
      resultsDir: options.resultsDir,
      fixtureRoot: options.fixtureRoot,
      collector: redactedCollectorCommand(collectorArgs),
    });
    console.log(`Live-seeded UI review dry run prepared at ${options.runRoot}`);
    return;
  }

  await copyDirectory(options.sourceUserData, options.userData, "user data");
  await copyDirectory(options.sourceWorkspace, options.workspace, "workspace");
  const childResult = await runCollector(collectorArgs, childEnv);
  const uiModelSummary = await readUiModelSummary(options.resultsDir);
  const reportStatus = childResult.exitCode !== 0 ? "failed" : uiModelSummary?.violationCount > 0 ? "attention" : "passed";

  await writeReviewReports(options, {
    status: reportStatus,
    dryRun: false,
    providerId: options.providerId,
    credentialSources: credential.sources,
    sourceUserData: options.sourceUserData,
    sourceWorkspace: options.sourceWorkspace,
    runRoot: options.runRoot,
    userData: options.userData,
    workspace: options.workspace,
    resultsDir: options.resultsDir,
    fixtureRoot: options.fixtureRoot,
    collector: redactedCollectorCommand(collectorArgs),
    uiModel: uiModelSummary,
    exitCode: childResult.exitCode,
    signal: childResult.signal,
  });

  if (reportStatus === "passed") {
    console.log("Live-seeded UI review passed with no deterministic UI-model findings.");
  } else if (reportStatus === "attention") {
    console.log("Live-seeded UI review completed with UI-model findings; inspect the generated report before deciding whether to fixture or fix them.");
  } else {
    process.exitCode = childResult.exitCode || 1;
  }
}

function parseOptions(argv, env) {
  const outputRoot = resolve(repoRoot, valueArg(argv, "--output-root") ?? join("test-results", "ui-model-live-seeded"));
  const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runRoot = resolve(repoRoot, valueArg(argv, "--run-root") ?? join(outputRoot, "runs", runStamp));
  const scenarioValues = valuesArg(argv, "--scenario");
  const profile = valueArg(argv, "--profile");
  const allProfiles = flagArg(argv, "--all-profiles");
  const dryRun = flagArg(argv, "--dry-run");
  const overwrite = flagArg(argv, "--overwrite");
  const isolateScenarios = flagArg(argv, "--isolate-scenarios");
  const providerId = normalizeProvider(valueArg(argv, "--provider") ?? env.AMBIENT_PROVIDER ?? env.AMBIENT_LLM_PROVIDER ?? DEFAULT_PROVIDER);

  return {
    dryRun,
    overwrite,
    isolateScenarios,
    providerId,
    outputRoot,
    latestSummaryPath: resolve(repoRoot, valueArg(argv, "--summary") ?? join(outputRoot, "latest.json")),
    runRoot,
    sourceUserData: resolveRequiredPath(valueArg(argv, "--source-user-data") ?? env.AMBIENT_LIVE_SEEDED_USER_DATA ?? env.AMBIENT_E2E_USER_DATA),
    sourceWorkspace: resolveRequiredPath(valueArg(argv, "--source-workspace") ?? env.AMBIENT_LIVE_SEEDED_WORKSPACE ?? env.AMBIENT_DESKTOP_WORKSPACE),
    userData: join(runRoot, "userData"),
    workspace: join(runRoot, "workspace"),
    resultsDir: resolve(repoRoot, valueArg(argv, "--results-dir") ?? join(runRoot, "ui-model")),
    fixtureRoot: resolve(repoRoot, valueArg(argv, "--fixture-root") ?? join(runRoot, "ui-model-fixture")),
    scenarios: scenarioValues.length > 0 ? scenarioValues : profile || allProfiles ? [] : DEFAULT_SCENARIOS,
    profile: allProfiles ? "core,stress,interaction" : profile,
  };
}

function validateOptions(options) {
  if (!options.sourceUserData) {
    throw new Error(
      "Pass --source-user-data=<path> or set AMBIENT_LIVE_SEEDED_USER_DATA / AMBIENT_E2E_USER_DATA to a snapshot userData directory.",
    );
  }
  if (!options.sourceWorkspace) {
    throw new Error(
      "Pass --source-workspace=<path> or set AMBIENT_LIVE_SEEDED_WORKSPACE / AMBIENT_DESKTOP_WORKSPACE to a snapshot workspace directory.",
    );
  }
  if (options.providerId !== "gmi-cloud" && options.providerId !== "ambient") {
    throw new Error(`Unsupported live-seeded provider: ${options.providerId}`);
  }
  if (!options.profile && options.scenarios.length === 0) {
    throw new Error("No live-seeded scenarios selected.");
  }
}

async function prepareRunRoot(options) {
  if (existsSync(options.runRoot)) {
    if (!options.overwrite) {
      throw new Error(`Run root already exists: ${options.runRoot}. Pass --overwrite to replace it.`);
    }
    await rm(options.runRoot, { recursive: true, force: true });
  }
  await mkdir(options.runRoot, { recursive: true });
  await mkdir(dirname(options.latestSummaryPath), { recursive: true });
}

async function assertDirectory(path, label) {
  const entry = await stat(path).catch(() => undefined);
  if (!entry?.isDirectory()) throw new Error(`Expected ${label} directory to exist: ${path}`);
}

async function copyDirectory(source, destination, label) {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
  console.log(`Copied live-seeded ${label} snapshot into ${destination}`);
}

function resolveProviderCredential(providerId, env) {
  const sources = [];
  const credentialEnv = {};
  if (providerId === "gmi-cloud") {
    if (env.GMI_CLOUD_API_KEY) {
      credentialEnv.GMI_CLOUD_API_KEY = env.GMI_CLOUD_API_KEY;
      sources.push("env:GMI_CLOUD_API_KEY");
    }
    if (env.GMI_API_KEY) {
      credentialEnv.GMI_API_KEY = env.GMI_API_KEY;
      sources.push("env:GMI_API_KEY");
    }
    if (env.GMI_CLOUD_API_KEY_FILE) {
      credentialEnv.GMI_CLOUD_API_KEY_FILE = env.GMI_CLOUD_API_KEY_FILE;
      sources.push("env:GMI_CLOUD_API_KEY_FILE");
    } else if (!env.GMI_CLOUD_API_KEY && !env.GMI_API_KEY) {
      const defaultKeyFile = join(repoRoot, "ignored-provider-key-file.txt");
      if (existsSync(defaultKeyFile)) {
        credentialEnv.GMI_CLOUD_API_KEY_FILE = defaultKeyFile;
        sources.push(`file:${basename(defaultKeyFile)}`);
      }
    }
    if (env.GMI_CLOUD_BASE_URL) credentialEnv.GMI_CLOUD_BASE_URL = env.GMI_CLOUD_BASE_URL;
    if (env.GMI_CLOUD_MODEL) credentialEnv.GMI_CLOUD_MODEL = env.GMI_CLOUD_MODEL;
    if (sources.length === 0) {
      throw new Error(
        "Configure GMI_CLOUD_API_KEY, GMI_API_KEY, GMI_CLOUD_API_KEY_FILE, or the ignored ignored-provider-key-file.txt file before running live-seeded UI review.",
      );
    }
    return { env: credentialEnv, sources };
  }

  if (env.AMBIENT_API_KEY) {
    credentialEnv.AMBIENT_API_KEY = env.AMBIENT_API_KEY;
    sources.push("env:AMBIENT_API_KEY");
  }
  if (env.AMBIENT_AGENT_AMBIENT_API_KEY) {
    credentialEnv.AMBIENT_AGENT_AMBIENT_API_KEY = env.AMBIENT_AGENT_AMBIENT_API_KEY;
    sources.push("env:AMBIENT_AGENT_AMBIENT_API_KEY");
  }
  if (env.AMBIENT_API_KEY_FILE) {
    credentialEnv.AMBIENT_API_KEY_FILE = env.AMBIENT_API_KEY_FILE;
    sources.push("env:AMBIENT_API_KEY_FILE");
  } else if (!env.AMBIENT_API_KEY && !env.AMBIENT_AGENT_AMBIENT_API_KEY) {
    const defaultKeyFile = join(repoRoot, "ignored-provider-key-file.txt");
    if (existsSync(defaultKeyFile)) {
      credentialEnv.AMBIENT_API_KEY_FILE = defaultKeyFile;
      sources.push(`file:${basename(defaultKeyFile)}`);
    }
  }
  if (sources.length === 0) {
    throw new Error(
      "Configure AMBIENT_API_KEY, AMBIENT_AGENT_AMBIENT_API_KEY, AMBIENT_API_KEY_FILE, or the ignored ignored-provider-key-file.txt file before running live-seeded UI review.",
    );
  }
  return { env: credentialEnv, sources };
}

function buildCollectorArgs(options) {
  const args = [
    "--experimental-websocket",
    "scripts/ui-model/collect-ui-model.mjs",
    `--results-dir=${options.resultsDir}`,
    `--fixture-root=${options.fixtureRoot}`,
  ];
  if (options.isolateScenarios) args.push("--isolate-scenarios");
  if (options.profile) args.push(`--profile=${options.profile}`);
  for (const scenario of options.scenarios) args.push(`--scenario=${scenario}`);
  return args;
}

function buildCollectorEnv(options, credential) {
  return {
    ...process.env,
    ...credential.env,
    AMBIENT_PROVIDER: options.providerId,
    AMBIENT_E2E: "1",
    AMBIENT_E2E_USER_DATA: options.userData,
    AMBIENT_DESKTOP_WORKSPACE: options.workspace,
    AMBIENT_UI_MODEL_USER_DATA: options.userData,
    AMBIENT_UI_MODEL_WORKSPACE: options.workspace,
    AMBIENT_DESKTOP_BOOTSTRAP_WATCHDOG_MS: process.env.AMBIENT_DESKTOP_BOOTSTRAP_WATCHDOG_MS ?? DEFAULT_BOOTSTRAP_WATCHDOG_MS,
  };
}

function runCollector(args, env) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env,
      stdio: "inherit",
    });
    child.once("exit", (exitCode, signal) => resolveRun({ exitCode: exitCode ?? 1, signal }));
  });
}

async function readUiModelSummary(resultsDir) {
  const summaryPath = join(resultsDir, "summary.json");
  const text = await readFile(summaryPath, "utf8").catch(() => undefined);
  if (!text) return undefined;
  const summary = JSON.parse(text);
  return {
    scenarioCount: summary.scenarioCount,
    violationCount: summary.violationCount,
    gateFailureCount: summary.gateFailureCount,
    reportOnly: summary.reportOnly,
    zeroBaseline: summary.zeroBaseline,
    generatedAt: summary.generatedAt,
  };
}

async function writeReviewReports(options, report) {
  const fullReport = {
    version: 1,
    generatedAt: new Date().toISOString(),
    ...report,
  };
  const text = `${JSON.stringify(fullReport, null, 2)}\n`;
  await writeFile(join(options.runRoot, "live-seeded-review.json"), text, "utf8");
  await writeFile(options.latestSummaryPath, text, "utf8");
}

function redactedCollectorCommand(args) {
  return {
    cwd: repoRoot,
    command: [process.execPath, ...args],
    env: {
      AMBIENT_PROVIDER: "set",
      AMBIENT_UI_MODEL_USER_DATA: "set",
      AMBIENT_UI_MODEL_WORKSPACE: "set",
      AMBIENT_E2E_USER_DATA: "set",
      AMBIENT_DESKTOP_WORKSPACE: "set",
      GMI_CLOUD_API_KEY: process.env.GMI_CLOUD_API_KEY ? "set" : undefined,
      GMI_API_KEY: process.env.GMI_API_KEY ? "set" : undefined,
      GMI_CLOUD_API_KEY_FILE: process.env.GMI_CLOUD_API_KEY_FILE || existsSync(join(repoRoot, "ignored-provider-key-file.txt")) ? "set" : undefined,
      AMBIENT_API_KEY: process.env.AMBIENT_API_KEY ? "set" : undefined,
      AMBIENT_AGENT_AMBIENT_API_KEY: process.env.AMBIENT_AGENT_AMBIENT_API_KEY ? "set" : undefined,
      AMBIENT_API_KEY_FILE: process.env.AMBIENT_API_KEY_FILE || existsSync(join(repoRoot, "ignored-provider-key-file.txt")) ? "set" : undefined,
    },
  };
}

function normalizeProvider(raw) {
  const provider = String(raw ?? "").trim().toLowerCase();
  if (["gmi", "gmi-cloud", "gmicloud", "gmi_cloud"].includes(provider)) return "gmi-cloud";
  if (provider === "ambient") return "ambient";
  return provider || DEFAULT_PROVIDER;
}

function resolveRequiredPath(value) {
  if (!value) return undefined;
  return resolve(repoRoot, value);
}

function flagArg(argv, name) {
  return argv.includes(name);
}

function valueArg(argv, name) {
  for (const arg of argv) {
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1).trim();
  }
  return undefined;
}

function valuesArg(argv, name) {
  const values = [];
  for (const arg of argv) {
    if (!arg.startsWith(`${name}=`)) continue;
    values.push(...arg.slice(name.length + 1).split(",").map((item) => item.trim()).filter(Boolean));
  }
  return values;
}
