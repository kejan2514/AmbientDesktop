#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggressiveRetriesGmiReleaseGatePassed,
  buildAggressiveRetriesPressureHistoryEntry,
  buildAggressiveRetriesGmiReleaseGateReport,
} from "./aggressive-retries-release-gate-gmi-live-lib.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(process.env.AMBIENT_AGGRESSIVE_RETRIES_RELEASE_GATE_OUT_DIR || join(repoRoot, "test-results", "aggressive-retries-release-gate-gmi"));
const runtimeToggleOutDir = resolve(process.env.AMBIENT_AGGRESSIVE_RETRIES_GMI_OUT_DIR || join(outputRoot, "runtime-toggle"));
const directHelperOutDir = resolve(process.env.AMBIENT_PROJECT_BOARD_PHASE8_GATE_OUT_DIR || join(outputRoot, "direct-helper"));
const runtimeToggleReportPath = join(runtimeToggleOutDir, "latest.json");
const directHelperReportPath = join(directHelperOutDir, "latest-phase8.json");
const outputPath = resolve(process.env.AMBIENT_AGGRESSIVE_RETRIES_RELEASE_GATE_OUT || join(outputRoot, "latest.json"));
const triagePath = resolve(process.env.AMBIENT_AGGRESSIVE_RETRIES_RELEASE_GATE_TRIAGE_OUT || join(outputRoot, "latest-triage.json"));
const pressureHistoryPath = resolve(
  process.env.AMBIENT_AGGRESSIVE_RETRIES_RELEASE_GATE_PRESSURE_HISTORY ||
    join(outputRoot, "pressure-history.jsonl"),
);
const startedAt = new Date().toISOString();
const runStamp = startedAt.replace(/[:.]/g, "-");
const logsRoot = resolve(process.env.AMBIENT_AGGRESSIVE_RETRIES_RELEASE_GATE_LOG_DIR || join(outputRoot, "logs", runStamp));
const runtimeToggleTimeoutMs = readTimeoutMs("AMBIENT_AGGRESSIVE_RETRIES_RELEASE_GATE_RUNTIME_TIMEOUT_MS", 600_000);
const directHelperRetryTimeoutMs = readTimeoutMs("AMBIENT_AGGRESSIVE_RETRIES_RELEASE_GATE_DIRECT_HELPER_TIMEOUT_MS", 1_800_000);
const recoveryPressureThreshold = readPositiveInteger(
  "AMBIENT_AGGRESSIVE_RETRIES_RELEASE_GATE_RECOVERY_PRESSURE_THRESHOLD",
  5,
);
const failOnRetryPressure = readBoolean("AMBIENT_AGGRESSIVE_RETRIES_RELEASE_GATE_FAIL_ON_RECOVERY_PRESSURE");
const repeatedPressureThreshold = readPositiveInteger(
  "AMBIENT_AGGRESSIVE_RETRIES_RELEASE_GATE_REPEATED_PRESSURE_THRESHOLD",
  2,
);
const failOnRepeatedPressure = readBoolean("AMBIENT_AGGRESSIVE_RETRIES_RELEASE_GATE_FAIL_ON_REPEATED_PRESSURE");
const pressureHistoryLimit = readPositiveInteger("AMBIENT_AGGRESSIVE_RETRIES_RELEASE_GATE_PRESSURE_HISTORY_LIMIT", 20);

await mkdir(outputRoot, { recursive: true });
await mkdir(logsRoot, { recursive: true });
const childEnv = buildChildEnv();
preflight(childEnv);

const runtimeToggle = await runLane({
  label: "runtime-toggle",
  command: "pnpm",
  args: ["run", "test:aggressive-retries-gmi-live"],
  env: {
    ...childEnv,
    AMBIENT_AGGRESSIVE_RETRIES_GMI_OUT_DIR: runtimeToggleOutDir,
  },
  reportPath: runtimeToggleReportPath,
  timeoutMs: runtimeToggleTimeoutMs,
});

const directHelperRetry = await runLane({
  label: "direct-helper-retry",
  command: "pnpm",
  args: ["run", "test:project-board-release-gate:direct-helper-retry-live"],
  env: {
    ...childEnv,
    AMBIENT_PROJECT_BOARD_PHASE8_GATE_OUT_DIR: directHelperOutDir,
    AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_OUT_DIR: join(directHelperOutDir, "direct-helper-smoke"),
  },
  reportPath: directHelperReportPath,
  timeoutMs: directHelperRetryTimeoutMs,
});

const completedAt = new Date().toISOString();
const pressureHistory = await readPressureHistory(pressureHistoryPath, pressureHistoryLimit);
const report = buildAggressiveRetriesGmiReleaseGateReport({
  startedAt,
  completedAt,
  outputRoot,
  triagePath,
  pressureHistoryPath,
  recoveryPressureThreshold,
  failOnRetryPressure,
  pressureHistory,
  repeatedPressureThreshold,
  failOnRepeatedPressure,
  runtimeToggle,
  directHelperRetry,
});
await mkdir(dirname(outputPath), { recursive: true });
await mkdir(dirname(triagePath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
await writeFile(triagePath, JSON.stringify(report.releaseDecision.failureTriage, null, 2), "utf8");
await appendPressureHistoryEntry(pressureHistoryPath, report);
console.log(
  JSON.stringify(
    {
      status: report.status,
      outputPath,
      triagePath,
      failureTriage: report.releaseDecision.failureTriage,
      stabilitySignals: {
        status: report.releaseDecision.stabilitySignals?.status,
        recoveryPressureThreshold: report.releaseDecision.recoveryPressureThreshold,
        pressureScenarioCount: report.releaseDecision.stabilitySignals?.pressureScenarioCount,
        advisoryIssues: report.releaseDecision.advisoryIssues,
        directHelperRetryScenarios: report.releaseDecision.stabilitySignals?.directHelperRetryScenarios,
      },
      pressureTrend: {
        status: report.releaseDecision.pressureTrend?.status,
        repeatedPressureThreshold: report.releaseDecision.repeatedPressureThreshold,
        historyRunCount: report.releaseDecision.pressureTrend?.historyRunCount,
        repeatedPressureScenarioCount: report.releaseDecision.pressureTrend?.repeatedPressureScenarioCount,
        repeatedPressureScenarios: report.releaseDecision.pressureTrend?.repeatedPressureScenarios,
        pressureHistoryPath,
      },
      runtimeToggle: {
        status: report.runtimeToggle.status,
        exitCode: report.runtimeToggle.exitCode,
        timedOut: report.runtimeToggle.timedOut,
        providerId: report.runtimeToggle.providerId,
        baselineTokenSeen: report.runtimeToggle.baselineTokenSeen,
        toggledTokenSeen: report.runtimeToggle.toggledTokenSeen,
        runtimeSettingsActivity: report.runtimeToggle.runtimeSettingsActivity,
        reportPath: report.runtimeToggle.reportPath,
        stdoutPath: report.runtimeToggle.stdoutPath,
        stderrPath: report.runtimeToggle.stderrPath,
      },
      directHelperRetry: {
        status: report.directHelperRetry.status,
        exitCode: report.directHelperRetry.exitCode,
        timedOut: report.directHelperRetry.timedOut,
        gateStatus: report.directHelperRetry.gateStatus,
        required: report.directHelperRetry.required,
        observed: report.directHelperRetry.directHelperRetryObserved,
        scenarioCount: report.directHelperRetry.scenarioCount,
        sourceClassificationComplete: report.directHelperRetry.sourceClassificationComplete,
        charterSummaryComplete: report.directHelperRetry.charterSummaryComplete,
        proofJudgmentComplete: report.directHelperRetry.proofJudgmentComplete,
        reportPath: report.directHelperRetry.reportPath,
        stdoutPath: report.directHelperRetry.stdoutPath,
        stderrPath: report.directHelperRetry.stderrPath,
      },
      diagnosticArtifacts: report.releaseDecision.diagnosticArtifacts,
      blockingIssues: report.releaseDecision.blockingIssues,
      nextSlice: report.releaseDecision.nextSlice,
    },
    null,
    2,
  ),
);

if (!aggressiveRetriesGmiReleaseGatePassed(report)) process.exitCode = 1;

function buildChildEnv() {
  const env = {
    ...process.env,
    AMBIENT_PROVIDER: "gmi-cloud",
  };
  copyFallback(env, "AMBIENT_AGGRESSIVE_RETRIES_SNAPSHOT_USER_DATA", [
    "AMBIENT_E2E_USER_DATA",
    "AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_SNAPSHOT_USER_DATA",
  ]);
  copyFallback(env, "AMBIENT_AGGRESSIVE_RETRIES_SNAPSHOT_WORKSPACE", [
    "AMBIENT_DESKTOP_WORKSPACE",
    "AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_SNAPSHOT_WORKSPACE",
  ]);
  copyFallback(env, "AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_SNAPSHOT_USER_DATA", [
    "AMBIENT_E2E_USER_DATA",
    "AMBIENT_AGGRESSIVE_RETRIES_SNAPSHOT_USER_DATA",
  ]);
  copyFallback(env, "AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_SNAPSHOT_WORKSPACE", [
    "AMBIENT_DESKTOP_WORKSPACE",
    "AMBIENT_AGGRESSIVE_RETRIES_SNAPSHOT_WORKSPACE",
  ]);
  return env;
}

function copyFallback(env, target, sources) {
  if (env[target]) return;
  for (const source of sources) {
    if (env[source]) {
      env[target] = env[source];
      return;
    }
  }
}

function preflight(env) {
  const missing = [];
  requireDirectory(env.AMBIENT_AGGRESSIVE_RETRIES_SNAPSHOT_USER_DATA, "AMBIENT_AGGRESSIVE_RETRIES_SNAPSHOT_USER_DATA", missing);
  requireDirectory(env.AMBIENT_AGGRESSIVE_RETRIES_SNAPSHOT_WORKSPACE, "AMBIENT_AGGRESSIVE_RETRIES_SNAPSHOT_WORKSPACE", missing);
  requireDirectory(env.AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_SNAPSHOT_USER_DATA, "AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_SNAPSHOT_USER_DATA", missing);
  requireDirectory(env.AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_SNAPSHOT_WORKSPACE, "AMBIENT_PROJECT_BOARD_DIRECT_HELPER_RETRY_SNAPSHOT_WORKSPACE", missing);
  if (!hasGmiCredential(env)) {
    missing.push("GMI Cloud credential env or ignored ignored-provider-key-file.txt");
  }
  if (missing.length > 0) {
    throw new Error(`Cannot run aggressive retries GMI release gate; configure: ${missing.join(", ")}.`);
  }
}

function requireDirectory(path, label, missing) {
  if (!path || !existsSync(path)) missing.push(label);
}

function hasGmiCredential(env) {
  return Boolean(env.GMI_CLOUD_API_KEY || env.GMI_API_KEY || env.GMI_CLOUD_API_KEY_FILE || existsSync(join(repoRoot, "ignored-provider-key-file.txt")));
}

async function runLane(input) {
  const started = new Date();
  const stdoutPath = join(logsRoot, `${input.label}.stdout.log`);
  const stderrPath = join(logsRoot, `${input.label}.stderr.log`);
  console.log(`Starting aggressive retries ${input.label} lane: ${input.command} ${input.args.join(" ")}`);
  const result = await runCommand({
    command: input.command,
    args: input.args,
    env: input.env,
    stdoutPath,
    stderrPath,
    timeoutMs: input.timeoutMs,
  });
  const completed = new Date();
  return {
    command: `${input.command} ${input.args.join(" ")}`,
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    timeoutMs: input.timeoutMs,
    durationMs: completed.getTime() - started.getTime(),
    reportPath: input.reportPath,
    stdoutPath,
    stderrPath,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    stdoutTail: result.stdoutTail,
    stderrTail: result.stderrTail,
    report: await readOptionalJson(input.reportPath),
  };
}

function runCommand(input) {
  return new Promise((resolveRun) => {
    const stdoutStream = createWriteStream(input.stdoutPath, { flags: "w" });
    const stderrStream = createWriteStream(input.stderrPath, { flags: "w" });
    const stdoutTail = createOutputTail();
    const stderrTail = createOutputTail();
    const redact = createOutputRedactor(input.env);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    const child = spawn(input.command, input.args, {
      cwd: repoRoot,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const timer =
      input.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            const message = `\nAggressive retries release gate lane timed out after ${input.timeoutMs}ms; terminating process tree.\n`;
            stderrTail.push(message);
            stderrBytes += Buffer.byteLength(message);
            stderrStream.write(message);
            process.stderr.write(message);
            terminateProcessTree(child).catch((error) => {
              const cleanupMessage = `Failed to terminate timed-out lane: ${error instanceof Error ? error.message : String(error)}\n`;
              stderrTail.push(cleanupMessage);
              stderrBytes += Buffer.byteLength(cleanupMessage);
              stderrStream.write(cleanupMessage);
              process.stderr.write(cleanupMessage);
            });
          }, input.timeoutMs)
        : undefined;
    child.stdout.on("data", (chunk) => {
      const text = redact(chunk.toString("utf8"));
      stdoutBytes += Buffer.byteLength(text);
      stdoutTail.push(text);
      stdoutStream.write(text);
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = redact(chunk.toString("utf8"));
      stderrBytes += Buffer.byteLength(text);
      stderrTail.push(text);
      stderrStream.write(text);
      process.stderr.write(text);
    });
    child.on("error", (error) => {
      const message = `${error instanceof Error ? error.message : String(error)}\n`;
      stderrBytes += Buffer.byteLength(message);
      stderrTail.push(message);
      stderrStream.write(message);
      process.stderr.write(message);
      finish(1, undefined).catch((finishError) => {
        process.stderr.write(`Failed to finalize failed lane: ${finishError instanceof Error ? finishError.message : String(finishError)}\n`);
      });
    });
    child.on("close", (code, signal) => {
      finish(code, signal).catch((error) => {
        process.stderr.write(`Failed to finalize closed lane: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    });

    async function finish(code, signal) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stdoutStream.end();
      stderrStream.end();
      await Promise.all([waitForStreamClose(stdoutStream), waitForStreamClose(stderrStream)]);
      resolveRun({
        code: code ?? (timedOut ? 1 : 1),
        signal: signal ?? undefined,
        timedOut,
        stdoutBytes,
        stderrBytes,
        stdoutTail: stdoutTail.value(),
        stderrTail: stderrTail.value(),
      });
    }
  });
}

function readTimeoutMs(envName, fallbackMs) {
  const raw = process.env[envName] || process.env.AMBIENT_AGGRESSIVE_RETRIES_RELEASE_GATE_LANE_TIMEOUT_MS;
  const parsed = Number(raw || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallbackMs;
}

function readPositiveInteger(envName, fallback) {
  const parsed = Number(process.env[envName] || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function readBoolean(envName) {
  return /^(1|true|yes|on)$/i.test(String(process.env[envName] || ""));
}

async function readOptionalJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function readPressureHistory(path, limit) {
  try {
    const text = await readFile(path, "utf8");
    const entries = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    return entries.slice(-limit);
  } catch {
    return [];
  }
}

async function appendPressureHistoryEntry(path, report) {
  try {
    await mkdir(dirname(path), { recursive: true });
    const entry = buildAggressiveRetriesPressureHistoryEntry(report);
    await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    console.error(
      `Could not append aggressive retries pressure history at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function waitForStreamClose(stream) {
  if (stream.closed) return Promise.resolve();
  return new Promise((resolve) => stream.once("close", resolve));
}

async function terminateProcessTree(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise((resolve) => proc.once("exit", resolve));
  try {
    if (process.platform === "win32") proc.kill("SIGTERM");
    else process.kill(-proc.pid, "SIGTERM");
  } catch {
    proc.kill("SIGTERM");
  }
  await Promise.race([exited, delay(1_500)]);
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    if (process.platform === "win32") proc.kill("SIGKILL");
    else process.kill(-proc.pid, "SIGKILL");
  } catch {
    proc.kill("SIGKILL");
  }
  await Promise.race([exited, delay(500)]);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createOutputRedactor(env) {
  const secretValues = [env.GMI_CLOUD_API_KEY, env.GMI_API_KEY].filter((value) => typeof value === "string" && value.length >= 8);
  return (text) => {
    let redacted = text;
    for (const secret of secretValues) redacted = redacted.split(secret).join("[redacted]");
    return redacted;
  };
}

function createOutputTail(limit = 20_000) {
  let text = "";
  return {
    push(chunk) {
      text = `${text}${chunk}`.slice(-limit);
    },
    value() {
      return text;
    },
  };
}
