#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expandTaskSelectors, runHarnessEval, TASK_CATALOG, TASK_PROFILES, tasksForProfile, VARIANT_IDS } from "./harness-eval.mjs";
import { runHarnessJudge } from "./harness-eval-judge.mjs";
import { runHarnessReport } from "./harness-eval-report.mjs";

const DEFAULT_OUTPUT_DIR = "test-results/harness-evals";
const DEFAULT_SEARCH_PROFILE = "search";
const DEFAULT_HOLDOUT_PROFILE = "holdout";
const DEFAULT_VARIANTS = ["baseline", "bootstrap-scripts", "bootstrap-tools"];
const DEFAULT_BASELINE = "baseline";
const DEFAULT_BASE_PORT = 9800;
const DEFAULT_MIN_IMPROVEMENT = 0.1;
const DEFAULT_HOLDOUT_MIN_IMPROVEMENT = 0;
const DEFAULT_LATE_HOLDOUT_MIN_IMPROVEMENT = 0;
const DEFAULT_MODEL = "example/model-id";
const DEFAULT_BASE_URL = "https://api.ambient.xyz/v1";

export function parseExperimentArgs(argv = process.argv.slice(2), env = process.env, now = () => new Date()) {
  const options = {
    runId: env.AMBIENT_HARNESS_EXPERIMENT_RUN_ID || buildExperimentRunId(now()),
    outputDir: env.AMBIENT_HARNESS_OUTPUT_DIR || DEFAULT_OUTPUT_DIR,
    searchProfile: env.AMBIENT_HARNESS_SEARCH_TASKS || env.AMBIENT_HARNESS_TASKS ? "custom" : env.AMBIENT_HARNESS_SEARCH_PROFILE || env.AMBIENT_HARNESS_TASK_PROFILE || DEFAULT_SEARCH_PROFILE,
    holdoutProfile: env.AMBIENT_HARNESS_HOLDOUT_TASKS ? "custom" : env.AMBIENT_HARNESS_HOLDOUT_PROFILE || DEFAULT_HOLDOUT_PROFILE,
    lateHoldoutProfile: env.AMBIENT_HARNESS_LATE_HOLDOUT_TASKS ? "custom" : env.AMBIENT_HARNESS_LATE_HOLDOUT_PROFILE || undefined,
    searchTasks: taskListFromEnv(env.AMBIENT_HARNESS_SEARCH_TASKS || env.AMBIENT_HARNESS_TASKS, env.AMBIENT_HARNESS_SEARCH_PROFILE || env.AMBIENT_HARNESS_TASK_PROFILE, DEFAULT_SEARCH_PROFILE),
    holdoutTasks: taskListFromEnv(env.AMBIENT_HARNESS_HOLDOUT_TASKS, env.AMBIENT_HARNESS_HOLDOUT_PROFILE, DEFAULT_HOLDOUT_PROFILE),
    lateHoldoutTasks: taskListFromEnv(env.AMBIENT_HARNESS_LATE_HOLDOUT_TASKS, env.AMBIENT_HARNESS_LATE_HOLDOUT_PROFILE, undefined),
    variants: listFromValue(env.AMBIENT_HARNESS_VARIANTS, DEFAULT_VARIANTS),
    baseline: env.AMBIENT_HARNESS_BASELINE || DEFAULT_BASELINE,
    trials: positiveInteger(env.AMBIENT_HARNESS_TRIALS, 1, "AMBIENT_HARNESS_TRIALS"),
    holdoutTrials: positiveInteger(env.AMBIENT_HARNESS_HOLDOUT_TRIALS, 1, "AMBIENT_HARNESS_HOLDOUT_TRIALS"),
    lateHoldoutTrials: positiveInteger(env.AMBIENT_HARNESS_LATE_HOLDOUT_TRIALS, 1, "AMBIENT_HARNESS_LATE_HOLDOUT_TRIALS"),
    basePort: positiveInteger(env.AMBIENT_HARNESS_BASE_PORT, DEFAULT_BASE_PORT, "AMBIENT_HARNESS_BASE_PORT"),
    minImprovement: numberValue(env.AMBIENT_HARNESS_REPORT_MIN_IMPROVEMENT, DEFAULT_MIN_IMPROVEMENT, "AMBIENT_HARNESS_REPORT_MIN_IMPROVEMENT"),
    minTrials: positiveInteger(env.AMBIENT_HARNESS_REPORT_MIN_TRIALS, 1, "AMBIENT_HARNESS_REPORT_MIN_TRIALS"),
    holdoutMinImprovement: numberValue(env.AMBIENT_HARNESS_HOLDOUT_MIN_IMPROVEMENT, DEFAULT_HOLDOUT_MIN_IMPROVEMENT, "AMBIENT_HARNESS_HOLDOUT_MIN_IMPROVEMENT"),
    holdoutMinTrials: positiveInteger(env.AMBIENT_HARNESS_HOLDOUT_MIN_TRIALS, 1, "AMBIENT_HARNESS_HOLDOUT_MIN_TRIALS"),
    lateHoldoutMinImprovement: numberValue(env.AMBIENT_HARNESS_LATE_HOLDOUT_MIN_IMPROVEMENT, DEFAULT_LATE_HOLDOUT_MIN_IMPROVEMENT, "AMBIENT_HARNESS_LATE_HOLDOUT_MIN_IMPROVEMENT"),
    lateHoldoutMinTrials: positiveInteger(env.AMBIENT_HARNESS_LATE_HOLDOUT_MIN_TRIALS, 1, "AMBIENT_HARNESS_LATE_HOLDOUT_MIN_TRIALS"),
    judgeModel: env.AMBIENT_HARNESS_JUDGE_MODEL || env.AMBIENT_LIVE_MODEL || DEFAULT_MODEL,
    judgeBaseUrl: normalizeAmbientBaseUrl(env.AMBIENT_BASE_URL || env.AMBIENT_AGENT_AMBIENT_BASE_URL),
    judgeLimit: positiveIntegerOrUndefined(env.AMBIENT_HARNESS_JUDGE_LIMIT, "AMBIENT_HARNESS_JUDGE_LIMIT"),
    apiKeyFile: env.AMBIENT_API_KEY_FILE || env.AMBIENT_AGENT_AMBIENT_API_KEY_FILE,
    dryRun: false,
    judgeDryRun: false,
    skipJudge: false,
    skipHoldout: false,
    skipLateHoldout: false,
    forceHoldout: false,
    failFast: false,
    failOnInvalidJudge: false,
    includeTextPreviews: true,
    resume: false,
    failOnReject: false,
    cwd: process.cwd(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const [flag, inlineValue] = raw.includes("=") ? raw.split(/=(.*)/s, 2) : [raw, undefined];
    const readValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} requires a value.`);
      return argv[index];
    };

    if (flag === "--") continue;
    else if (flag === "--run-id") options.runId = readValue();
    else if (flag === "--output-dir") options.outputDir = readValue();
    else if (flag === "--tasks" || flag === "--search-tasks") {
      options.searchProfile = "custom";
      options.searchTasks = expandTaskSelectors(listFromValue(readValue(), []));
    } else if (flag === "--holdout-tasks") {
      options.holdoutProfile = "custom";
      options.holdoutTasks = expandTaskSelectors(listFromValue(readValue(), []));
    } else if (flag === "--late-holdout-tasks") {
      options.lateHoldoutProfile = "custom";
      options.lateHoldoutTasks = expandTaskSelectors(listFromValue(readValue(), []));
    } else if (flag === "--search-profile") {
      options.searchProfile = readValue();
      options.searchTasks = tasksForProfile(options.searchProfile);
    } else if (flag === "--holdout-profile") {
      options.holdoutProfile = readValue();
      options.holdoutTasks = tasksForProfile(options.holdoutProfile);
    } else if (flag === "--late-holdout-profile") {
      options.lateHoldoutProfile = readValue();
      options.lateHoldoutTasks = tasksForProfile(options.lateHoldoutProfile);
    } else if (flag === "--variants") options.variants = listFromValue(readValue(), []);
    else if (flag === "--baseline") options.baseline = readValue();
    else if (flag === "--trials") options.trials = positiveInteger(readValue(), 1, "--trials");
    else if (flag === "--holdout-trials") options.holdoutTrials = positiveInteger(readValue(), 1, "--holdout-trials");
    else if (flag === "--late-holdout-trials") options.lateHoldoutTrials = positiveInteger(readValue(), 1, "--late-holdout-trials");
    else if (flag === "--base-port") options.basePort = positiveInteger(readValue(), DEFAULT_BASE_PORT, "--base-port");
    else if (flag === "--min-improvement") options.minImprovement = numberValue(readValue(), DEFAULT_MIN_IMPROVEMENT, "--min-improvement");
    else if (flag === "--min-trials") options.minTrials = positiveInteger(readValue(), 1, "--min-trials");
    else if (flag === "--holdout-min-improvement") options.holdoutMinImprovement = numberValue(readValue(), DEFAULT_HOLDOUT_MIN_IMPROVEMENT, "--holdout-min-improvement");
    else if (flag === "--holdout-min-trials") options.holdoutMinTrials = positiveInteger(readValue(), 1, "--holdout-min-trials");
    else if (flag === "--late-holdout-min-improvement") options.lateHoldoutMinImprovement = numberValue(readValue(), DEFAULT_LATE_HOLDOUT_MIN_IMPROVEMENT, "--late-holdout-min-improvement");
    else if (flag === "--late-holdout-min-trials") options.lateHoldoutMinTrials = positiveInteger(readValue(), 1, "--late-holdout-min-trials");
    else if (flag === "--judge-limit") options.judgeLimit = positiveIntegerOrUndefined(readValue(), "--judge-limit");
    else if (flag === "--model") options.judgeModel = readValue();
    else if (flag === "--base-url") options.judgeBaseUrl = normalizeAmbientBaseUrl(readValue());
    else if (flag === "--api-key-file") options.apiKeyFile = readValue();
    else if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--judge-dry-run") options.judgeDryRun = true;
    else if (flag === "--skip-judge") options.skipJudge = true;
    else if (flag === "--skip-holdout") options.skipHoldout = true;
    else if (flag === "--skip-late-holdout") options.skipLateHoldout = true;
    else if (flag === "--force-holdout") options.forceHoldout = true;
    else if (flag === "--fail-fast") options.failFast = true;
    else if (flag === "--fail-on-invalid-judge") options.failOnInvalidJudge = true;
    else if (flag === "--no-text-previews") options.includeTextPreviews = false;
    else if (flag === "--resume") options.resume = true;
    else if (flag === "--fail-on-reject") options.failOnReject = true;
    else if (flag === "--help" || flag === "-h") options.help = true;
    else throw new Error(`Unknown harness-experiment option: ${raw}`);
  }

  if (options.dryRun) options.judgeDryRun = true;
  validateExperimentOptions(options);
  return options;
}

export async function runHarnessExperiment(options, deps = {}) {
  const cwd = deps.cwd ?? options.cwd ?? process.cwd();
  const now = deps.now ?? (() => new Date());
  const runEval = deps.runEval ?? runHarnessEval;
  const runJudge = deps.runJudge ?? runHarnessJudge;
  const runReport = deps.runReport ?? runHarnessReport;
  const experimentRoot = resolve(cwd, options.outputDir, options.runId);
  const startedAt = now().toISOString();
  const apiKeySource = primeAmbientApiKey({ apiKeyFile: options.apiKeyFile, env: process.env, cwd });
  const manifest = {
    version: 1,
    runId: options.runId,
    startedAt,
    completedAt: undefined,
    cwd,
    experimentRoot,
    apiKeySource,
    config: serializableConfig(options),
    stages: [],
    finalDecision: undefined,
  };

  await mkdir(experimentRoot, { recursive: true });
  await writeExperimentArtifacts(experimentRoot, manifest);

  const searchStage = await runExperimentStage({
    name: "search",
    experimentRoot,
    tasks: options.searchTasks,
    variants: options.variants,
    trials: options.trials,
    basePort: options.basePort,
    minImprovement: options.minImprovement,
    minTrials: options.minTrials,
    options,
    now,
    cwd,
    runEval,
    runJudge,
    runReport,
  });
  manifest.stages.push(searchStage);
  await writeExperimentArtifacts(experimentRoot, manifest);

  const searchCandidate = pickHoldoutCandidate(searchStage.report, options.baseline, { force: options.forceHoldout });
  let holdoutStage;
  const shouldRunHoldout = Boolean(searchCandidate && options.holdoutTasks.length && !options.skipHoldout);
  if (shouldRunHoldout) {
    holdoutStage = await runExperimentStage({
      name: "holdout",
      experimentRoot,
      tasks: options.holdoutTasks,
      variants: [options.baseline, searchCandidate],
      trials: options.holdoutTrials,
      basePort: options.basePort + 1000,
      minImprovement: options.holdoutMinImprovement,
      minTrials: options.holdoutMinTrials,
      options,
      now,
      cwd,
      runEval,
      runJudge,
      runReport,
    });
    manifest.stages.push(holdoutStage);
  }
  await writeExperimentArtifacts(experimentRoot, manifest);

  const holdoutPromoted = Boolean(searchCandidate && holdoutStage && variantGateStatus(holdoutStage.report, searchCandidate) === "promote");
  let lateHoldoutStage;
  const lateHoldoutConfigured = Boolean(options.lateHoldoutTasks.length);
  const shouldRunLateHoldout = Boolean(holdoutPromoted && lateHoldoutConfigured && !options.skipLateHoldout);
  if (shouldRunLateHoldout) {
    lateHoldoutStage = await runExperimentStage({
      name: "late-holdout",
      experimentRoot,
      tasks: options.lateHoldoutTasks,
      variants: [options.baseline, searchCandidate],
      trials: options.lateHoldoutTrials,
      basePort: options.basePort + 2000,
      minImprovement: options.lateHoldoutMinImprovement,
      minTrials: options.lateHoldoutMinTrials,
      options,
      now,
      cwd,
      runEval,
      runJudge,
      runReport,
    });
    manifest.stages.push(lateHoldoutStage);
  }

  manifest.finalDecision = buildFinalDecision({
    baseline: options.baseline,
    searchStage,
    holdoutStage,
    lateHoldoutStage,
    skippedHoldout: Boolean(searchCandidate && !shouldRunHoldout),
    skippedLateHoldout: Boolean(holdoutPromoted && lateHoldoutConfigured && !shouldRunLateHoldout),
    lateHoldoutConfigured,
    holdoutCandidate: searchCandidate,
  });
  manifest.completedAt = now().toISOString();
  await writeExperimentArtifacts(experimentRoot, manifest);
  return { experimentRoot, manifest };
}

export async function runExperimentStage(input) {
  const runRoot = join(input.experimentRoot, input.name);
  const reportPath = join(runRoot, "decision-report.json");
  const stage = {
    name: input.name,
    runRoot,
    tasks: input.tasks,
    variants: input.variants,
    trials: input.trials,
    resumed: false,
    evalSkipped: false,
    judgeSkipped: Boolean(input.options.skipJudge),
    reportPath,
    markdownPath: join(runRoot, "decision-report.md"),
    report: undefined,
  };

  if (input.options.resume && existsSync(reportPath)) {
    stage.resumed = true;
    stage.evalSkipped = true;
    stage.judgeSkipped = true;
    stage.report = await readJson(reportPath);
    return summarizeStage(stage);
  }

  const hadResults = input.options.resume && existsSync(join(runRoot, "results.jsonl"));
  const evalResult = await input.runEval({
    tasks: input.tasks,
    variants: input.variants,
    trials: input.trials,
    outputDir: input.experimentRoot,
    runId: input.name,
    basePort: input.basePort,
    dryRun: input.options.dryRun,
    resume: input.options.resume,
    failFast: input.options.failFast,
    cwd: input.cwd,
  });
  stage.resume = evalResult?.resume;
  if (hadResults || (evalResult?.resume?.skipped ?? 0) > 0) stage.resumed = true;
  if (evalResult?.resume?.enabled && evalResult.resume.expected > 0 && evalResult.resume.executed === 0) {
    stage.evalSkipped = true;
  }

  if (!input.options.skipJudge) {
    const judgeRowsPath = join(runRoot, "judge-results.jsonl");
    const hadJudgeRows = input.options.resume && existsSync(judgeRowsPath);
    const judgeResult = await input.runJudge({
      runRoot,
      outputName: "judge-results.jsonl",
      model: input.options.judgeModel,
      baseUrl: input.options.judgeBaseUrl,
      limit: input.options.judgeLimit,
      dryRun: input.options.judgeDryRun,
      resume: input.options.resume,
      failOnInvalid: input.options.failOnInvalidJudge,
      includeTextPreviews: input.options.includeTextPreviews,
      cwd: input.cwd,
    });
    stage.judgeResume = judgeResult?.resume;
    if (hadJudgeRows || (judgeResult?.resume?.skipped ?? 0) > 0) stage.resumed = true;
    if (judgeResult?.resume?.enabled && judgeResult.resume.expected > 0 && judgeResult.resume.executed === 0) {
      stage.judgeSkipped = true;
    }
  }

  const reportResult = await input.runReport({
    runRoot,
    baseline: input.options.baseline,
    outputJson: "decision-report.json",
    outputMarkdown: "decision-report.md",
    minImprovement: input.minImprovement,
    minTrials: input.minTrials,
    cwd: input.cwd,
  });
  stage.report = reportResult.report;
  return summarizeStage(stage);
}

export function pickHoldoutCandidate(report, baseline, input = {}) {
  const recommendedVariant = report?.recommendedVariant;
  if (!recommendedVariant || recommendedVariant === baseline) {
    if (!input.force) return undefined;
    const fallback = report?.variants?.find((variant) => variant.role !== "baseline" && !["reject"].includes(variant.gate?.status));
    return fallback?.variant;
  }
  const recommended = report.variants?.find((variant) => variant.variant === recommendedVariant);
  if (!recommended || recommended.role === "baseline") return undefined;
  if (recommended.gate?.status === "promote") return recommended.variant;
  if (input.force && ["needs-more-evidence", "promote"].includes(recommended.gate?.status)) return recommended.variant;
  return undefined;
}

export function buildFinalDecision({ baseline, searchStage, holdoutStage, lateHoldoutStage, skippedHoldout, skippedLateHoldout, lateHoldoutConfigured, holdoutCandidate }) {
  const candidate = holdoutCandidate ?? pickHoldoutCandidate(searchStage.report, baseline, { force: true });
  const searchRecommendation = searchStage.report?.recommendation;
  if (!candidate) {
    return {
      status: "baseline",
      variant: baseline,
      reasons: ["Search stage did not identify a non-baseline frontier candidate."],
    };
  }
  if (searchRecommendation?.status !== "promote") {
    return {
      status: "needs-more-evidence",
      variant: candidate,
      reasons: [`Search gate returned ${searchRecommendation?.status ?? "unknown"} instead of promote.`],
    };
  }
  if (skippedHoldout || !holdoutStage) {
    return {
      status: "needs-holdout",
      variant: candidate,
      reasons: ["Search promoted a candidate, but holdout was not run."],
    };
  }
  const holdoutVariant = holdoutStage.report?.variants?.find((variant) => variant.variant === candidate);
  if (!holdoutVariant) {
    return {
      status: "needs-more-evidence",
      variant: candidate,
      reasons: ["Holdout report did not include the search candidate."],
    };
  }
  if (holdoutVariant.gate?.status === "promote") {
    if (lateHoldoutConfigured) {
      if (skippedLateHoldout || !lateHoldoutStage) {
        return {
          status: "needs-late-holdout",
          variant: candidate,
          reasons: ["Candidate passed search and holdout gates, but late holdout was not run."],
        };
      }
      const lateHoldoutVariant = lateHoldoutStage.report?.variants?.find((variant) => variant.variant === candidate);
      if (!lateHoldoutVariant) {
        return {
          status: "needs-more-evidence",
          variant: candidate,
          reasons: ["Late holdout report did not include the search candidate."],
        };
      }
      if (lateHoldoutVariant.gate?.status === "promote") {
        return {
          status: "promote",
          variant: candidate,
          reasons: ["Candidate passed search, holdout, and late-holdout gates."],
        };
      }
      if (lateHoldoutVariant.gate?.status === "reject") {
        return {
          status: "reject",
          variant: candidate,
          reasons: lateHoldoutVariant.gate.reasons,
        };
      }
      return {
        status: "needs-more-evidence",
        variant: candidate,
        reasons: lateHoldoutVariant.gate?.reasons ?? ["Late holdout gate did not promote the candidate."],
      };
    }
    return {
      status: "promote",
      variant: candidate,
      reasons: ["Candidate passed search and holdout gates."],
    };
  }
  if (holdoutVariant.gate?.status === "reject") {
    return {
      status: "reject",
      variant: candidate,
      reasons: holdoutVariant.gate.reasons,
    };
  }
  return {
    status: "needs-more-evidence",
    variant: candidate,
    reasons: holdoutVariant.gate?.reasons ?? ["Holdout gate did not promote the candidate."],
  };
}

function variantGateStatus(report, variant) {
  return report?.variants?.find((entry) => entry.variant === variant)?.gate?.status;
}

function summarizeStage(stage) {
  return {
    name: stage.name,
    runRoot: stage.runRoot,
    tasks: stage.tasks,
    variants: stage.variants,
    trials: stage.trials,
    resumed: stage.resumed,
    evalSkipped: stage.evalSkipped,
    judgeSkipped: stage.judgeSkipped,
    resume: stage.resume,
    judgeResume: stage.judgeResume,
    recommendedVariant: stage.report?.recommendedVariant,
    recommendation: stage.report?.recommendation,
    reportPath: stage.reportPath,
    markdownPath: stage.markdownPath,
    report: stage.report,
  };
}

async function writeExperimentArtifacts(experimentRoot, manifest) {
  await writeJson(join(experimentRoot, "experiment.json"), manifest);
  await writeFile(join(experimentRoot, "experiment-summary.md"), renderExperimentMarkdown(manifest), "utf8");
}

export function renderExperimentMarkdown(manifest) {
  const lines = [
    "# Meta-Harness Experiment",
    "",
    `Run ID: \`${manifest.runId}\``,
    `Started: \`${manifest.startedAt}\``,
    `Completed: \`${manifest.completedAt ?? "in progress"}\``,
    `API key source: \`${manifest.apiKeySource}\``,
    "",
    "## Final Decision",
    "",
    manifest.finalDecision
      ? `\`${manifest.finalDecision.status}\` \`${manifest.finalDecision.variant}\`: ${manifest.finalDecision.reasons.join(" ")}`
      : "`pending`: experiment is still running.",
    "",
    "## Stages",
    "",
    "| Stage | Variants | Tasks | Trials | Recommendation | Report |",
    "| --- | --- | --- | ---: | --- | --- |",
    ...manifest.stages.map((stage) => {
      const notes = [
        stage.recommendation?.status ?? "unknown",
        stage.resumed ? "resumed" : undefined,
        stage.evalSkipped ? "eval skipped" : undefined,
        stage.resume?.enabled && !stage.evalSkipped && stage.resume.skipped > 0 ? `eval resumed ${stage.resume.skipped}/${stage.resume.expected}` : undefined,
        stage.judgeSkipped ? "judge skipped" : undefined,
        stage.judgeResume?.enabled && !stage.judgeSkipped && stage.judgeResume.skipped > 0 ? `judge resumed ${stage.judgeResume.skipped}/${stage.judgeResume.expected}` : undefined,
      ]
        .filter(Boolean)
        .join(", ");
      return `| \`${stage.name}\` | ${stage.variants.map((variant) => `\`${variant}\``).join(", ")} | ${stage.tasks
        .map((task) => `\`${task}\``)
        .join(", ")} | ${stage.trials} | \`${stage.recommendedVariant ?? "none"}\` (${notes}) | \`${stage.markdownPath}\` |`;
    }),
    "",
    "## Config",
    "",
    "```json",
    JSON.stringify(manifest.config, null, 2),
    "```",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function primeAmbientApiKey({ apiKeyFile, env, cwd }) {
  if (env.AMBIENT_API_KEY?.trim() || env.AMBIENT_AGENT_AMBIENT_API_KEY?.trim()) return "env";
  const root = cwd || process.cwd();
  const candidates = [apiKeyFile, join(root, "ignored-provider-key-file.txt"), join(root, "..", "ambientCoder", "ignored-provider-key-file.txt")].filter(Boolean);
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      const key = readFileSync(file, "utf8").trim();
      if (!key) continue;
      env.AMBIENT_API_KEY = key;
      return apiKeyFile && resolve(file) === resolve(apiKeyFile) ? "api-key-file" : "ambient-api-key-file";
    } catch {
      // Try the next non-secret file path.
    }
  }
  return "missing";
}

function serializableConfig(options) {
  return {
    outputDir: options.outputDir,
    searchTasks: options.searchTasks,
    holdoutTasks: options.holdoutTasks,
    lateHoldoutTasks: options.lateHoldoutTasks,
    searchProfile: options.searchProfile,
    holdoutProfile: options.holdoutProfile,
    lateHoldoutProfile: options.lateHoldoutProfile,
    variants: options.variants,
    baseline: options.baseline,
    trials: options.trials,
    holdoutTrials: options.holdoutTrials,
    lateHoldoutTrials: options.lateHoldoutTrials,
    basePort: options.basePort,
    minImprovement: options.minImprovement,
    minTrials: options.minTrials,
    holdoutMinImprovement: options.holdoutMinImprovement,
    holdoutMinTrials: options.holdoutMinTrials,
    lateHoldoutMinImprovement: options.lateHoldoutMinImprovement,
    lateHoldoutMinTrials: options.lateHoldoutMinTrials,
    judgeModel: options.judgeModel,
    judgeBaseUrl: options.judgeBaseUrl,
    judgeLimit: options.judgeLimit,
    dryRun: options.dryRun,
    judgeDryRun: options.judgeDryRun,
    skipJudge: options.skipJudge,
    skipHoldout: options.skipHoldout,
    skipLateHoldout: options.skipLateHoldout,
    forceHoldout: options.forceHoldout,
    failFast: options.failFast,
    failOnInvalidJudge: options.failOnInvalidJudge,
    includeTextPreviews: options.includeTextPreviews,
    resume: options.resume,
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function validateExperimentOptions(options) {
  if (options.help) return;
  validateTaskList("search task", options.searchTasks);
  validateTaskList("holdout task", options.holdoutTasks);
  validateTaskList("late holdout task", options.lateHoldoutTasks);
  if (!options.variants.length) throw new Error("At least one variant is required.");
  for (const variant of options.variants) {
    if (!VARIANT_IDS.includes(variant)) throw new Error(`Unknown harness variant "${variant}". Valid variants: ${VARIANT_IDS.join(", ")}`);
  }
  if (!options.variants.includes(options.baseline)) throw new Error(`Baseline variant "${options.baseline}" must be included in --variants.`);
}

function validateTaskList(label, tasks) {
  if (!tasks.length) return;
  for (const task of tasks) {
    if (!TASK_CATALOG[task]) throw new Error(`Unknown harness ${label} "${task}". Valid tasks: ${Object.keys(TASK_CATALOG).join(", ")}`);
  }
}

function taskListFromEnv(taskValue, profileValue, fallbackProfile) {
  if (profileValue) return tasksForProfile(profileValue);
  return expandTaskSelectors(listFromValue(taskValue, TASK_PROFILES[fallbackProfile] ?? []));
}

function listFromValue(value, fallback) {
  if (value === undefined || value === "") return [...fallback];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function positiveInteger(value, fallback, label) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function positiveIntegerOrUndefined(value, label) {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function numberValue(value, fallback, label) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative number.`);
  return parsed;
}

function normalizeAmbientBaseUrl(baseUrl) {
  const root = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return root.endsWith("/v1") ? root : `${root}/v1`;
}

function buildExperimentRunId(date) {
  return `meta-harness-experiment-${date.toISOString().replace(/[:.]/g, "-")}`;
}

function printUsage() {
  console.log(`Usage: node scripts/harness-experiment.mjs [options]

Runs a search suite, optional Ambient judge pass, decision report, and auto-holdout
for the promoted frontier candidate.

Options:
  --search-profile search
  --holdout-profile holdout
  --late-holdout-profile late-holdout
  --search-tasks live-smoke,node-benchmark,plugin-arxiv
  --holdout-tasks workflow-graph-review
  --late-holdout-tasks project-board-dogfood
  --variants baseline,bootstrap-scripts,bootstrap-tools
  --trials 1
  --holdout-trials 1
  --late-holdout-trials 1
  --run-id meta-harness-manual
  --output-dir test-results/harness-evals
  --base-port 9800
  --baseline baseline
  --min-improvement 0.1
  --holdout-min-improvement 0
  --late-holdout-min-improvement 0
  --model example/model-id
  --base-url https://api.ambient.xyz/v1
  --api-key-file /path/to/ignored-provider-key-file.txt
  --dry-run
  --judge-dry-run
  --skip-judge
  --skip-holdout
  --skip-late-holdout
  --force-holdout
  --resume
  --fail-fast
  --fail-on-invalid-judge
  --fail-on-reject
`);
}

async function main() {
  const options = parseExperimentArgs();
  if (options.help) {
    printUsage();
    return;
  }
  const result = await runHarnessExperiment(options);
  console.log(JSON.stringify({ experimentRoot: result.experimentRoot, finalDecision: result.manifest.finalDecision }, null, 2));
  if (options.failOnReject && ["reject", "needs-more-evidence", "needs-holdout", "needs-late-holdout"].includes(result.manifest.finalDecision?.status)) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
