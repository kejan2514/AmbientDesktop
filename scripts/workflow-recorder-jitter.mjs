#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const args = new Set(argv);
const profile = optionValue(argv, "--profile") ?? "smoke";
const seeds = Math.max(1, Math.floor(Number(optionValue(argv, "--seeds") ?? "8")));
const outputPath = resolve(optionValue(argv, "--out") ?? join(repoRoot, "test-results", "workflow-recorder-jitter", "latest.json"));
const jsonOutput = args.has("--json");
const includeLive = args.has("--include-live") || args.has("--run-live") || profile === "live-smoke";
const generatedAt = new Date().toISOString();
const runId = `workflow-recorder-${generatedAt.replace(/[:.]/g, "-")}`;
const gitHead = await currentGitHead();
const trackedStatusLines = await currentGitTrackedStatusLines();
const archivePath = args.has("--no-archive")
  ? undefined
  : resolve(optionValue(argv, "--archive-out") ?? join(dirname(outputPath), "runs", `${runId}.json`));
const liveRecorderScenarioIds = [
  "web-research-date-night",
  "browser-navigation-proof",
  "gmail-summary-metadata",
  "local-file-classification",
  "ambient-cli-preflight",
];

if (!["smoke", "live-smoke"].includes(profile)) {
  throw new Error(`Unknown Workflow Recorder jitter profile "${profile}". Known profiles: smoke, live-smoke`);
}

const tasks = [
  commandTask({
    id: "recorder-release-native",
    label: "Workflow Recorder native end-to-end release fixture",
    tier: "deterministic",
    command: "bash",
    args: [
      "scripts/test-node-native.sh",
      "src/main/workflow-recording/workflowRecorderReleaseGate.test.ts",
      "src/main/ambient/ambientWorkflows.test.ts",
      "src/main/workflow-recording/workflowRecorder.test.ts",
    ],
  }),
  commandTask({
    id: "recorder-ui-model",
    label: "Workflow Recorder UI model and injected playbook chip",
    tier: "deterministic",
    command: "pnpm",
    args: ["exec", "vitest", "run", "src/renderer/src/workflowRecorderUiModel.test.ts"],
  }),
  commandTask({
    id: "recorder-tool-metadata",
    label: "Workflow Recorder direct tools, metadata, router, and planner allowances",
    tier: "deterministic",
    command: "pnpm",
    args: [
      "exec",
      "vitest",
      "run",
      "src/main/pi/piEventMapper.test.ts",
      "src/main/desktop-tools/desktopToolRegistry.test.ts",
      "src/main/ambient/ambientToolRouter.test.ts",
      "src/main/planner/plannerMode.test.ts",
    ],
  }),
  planSanityTask(),
];

if (includeLive) tasks.push(liveGmiSmokeTask());

const results = [];
for (const task of tasks) {
  const result = await task.run();
  results.push(result);
  if (result.status !== "passed") break;
}

const report = {
  schemaVersion: 1,
  runId,
  generatedAt,
  ...(archivePath ? { archivePath } : {}),
  profile,
  seedCount: seeds,
  provider: process.env.AMBIENT_PROVIDER ?? "unset",
  source: {
    gitHead,
    trackedDirty: trackedStatusLines.length > 0,
    trackedStatusLines,
  },
  taskCount: results.length,
  passedCount: results.filter((task) => task.status === "passed").length,
  liveCount: results.filter((task) => task.tier === "live" && task.status === "passed").length,
  liveScenarioCount: results
    .filter((task) => task.tier === "live" && task.status === "passed")
    .reduce((total, task) => total + Math.max(0, Math.floor(Number(task.scenarioCount ?? 0))), 0),
  tasks: results,
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (archivePath) {
  await mkdir(dirname(archivePath), { recursive: true });
  await writeFile(archivePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    JSON.stringify(
      {
        status: report.passedCount === report.taskCount ? "passed" : "attention",
        profile: report.profile,
        seedCount: report.seedCount,
        provider: report.provider,
        passed: `${report.passedCount}/${report.taskCount}`,
        outputPath,
      },
      null,
      2,
    ),
  );
}

if (report.passedCount !== report.taskCount) process.exitCode = 1;

function commandTask(input) {
  return {
    id: input.id,
    tier: input.tier,
    async run() {
      const started = Date.now();
      try {
        await runCommand(input.command, input.args, {
          cwd: repoRoot,
          env: { ...process.env, AMBIENT_PROVIDER: process.env.AMBIENT_PROVIDER ?? "gmi-cloud", ...(input.env ?? {}) },
        });
        return {
          id: input.id,
          label: input.label,
          tier: input.tier,
          status: "passed",
          durationMs: Date.now() - started,
          command: `${input.command} ${input.args.join(" ")}`,
          ...(input.report ?? {}),
        };
      } catch (error) {
        return {
          id: input.id,
          label: input.label,
          tier: input.tier,
          status: "failed",
          durationMs: Date.now() - started,
          command: `${input.command} ${input.args.join(" ")}`,
          ...(input.report ?? {}),
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

function liveGmiSmokeTask() {
  return commandTask({
    id: "recorder-live-gmi-smoke",
    label: "Workflow Recorder live GMI/Pi five-scenario matrix smoke",
    tier: "live",
    command: "bash",
    args: ["scripts/test-node-native.sh", "src/main/workflow-recording/workflowRecorderLiveSmoke.test.ts"],
    env: {
      AMBIENT_PROVIDER: "gmi-cloud",
      AMBIENT_WORKFLOW_RECORDER_LIVE: "1",
      GMI_CLOUD_API_KEY_FILE: process.env.GMI_CLOUD_API_KEY_FILE ?? join(repoRoot, "ignored-provider-key-file.txt"),
    },
    report: {
      scenarioCount: liveRecorderScenarioIds.length,
      scenarioIds: liveRecorderScenarioIds,
    },
  });
}

function planSanityTask() {
  return {
    id: "recorder-html-plan-sanity",
    tier: "deterministic",
    async run() {
      const started = Date.now();
      const html = await readFile(join(repoRoot, "workflowRecorder.html"), "utf8");
      const required = [
        "Phase 6: Dogfood and release gate",
        "workflow-recorder-jitter.mjs",
        "workflow-recorder-release-gate.mjs",
        "recorder release gate passes deterministic",
      ];
      const missing = required.filter((marker) => !html.includes(marker));
      return {
        id: "recorder-html-plan-sanity",
        label: "workflowRecorder.html Phase 6 release gate markers",
        tier: "deterministic",
        status: missing.length ? "failed" : "passed",
        durationMs: Date.now() - started,
        ...(missing.length ? { message: `Missing plan marker(s): ${missing.join(", ")}` } : {}),
      };
    },
  };
}

function runCommand(command, commandArgs, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
    });
    child.on("error", rejectRun);
    child.on("close", (code, signal) => {
      if (code === 0) resolveRun({ code, signal });
      else rejectRun(new Error(`${command} ${commandArgs.join(" ")} failed with code=${code ?? "none"} signal=${signal ?? "none"}`));
    });
  });
}

async function currentGitHead() {
  try {
    const result = await runCommandCapture("git", ["rev-parse", "HEAD"], { cwd: repoRoot, env: process.env });
    return result.stdout.trim();
  } catch {
    return "unknown";
  }
}

async function currentGitTrackedStatusLines() {
  try {
    const result = await runCommandCapture("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repoRoot, env: process.env });
    return result.stdout.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  } catch {
    return [];
  }
}

function runCommandCapture(command, commandArgs, options) {
  return new Promise((resolveRun, rejectRun) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", rejectRun);
    child.on("close", (code, signal) => {
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) resolveRun(result);
      else rejectRun(new Error(`${command} ${commandArgs.join(" ")} failed with code=${code ?? "none"} signal=${signal ?? "none"}`));
    });
  });
}

function optionValue(values, name) {
  const direct = values.find((value) => value.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : undefined;
}
