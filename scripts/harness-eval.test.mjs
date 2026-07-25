import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  buildFrontier,
  buildTrialArtifactIndex,
  evaluateMutationPolicy,
  expandTaskSelectors,
  extractLastJsonObject,
  parseHarnessEvalArgs,
  redactArtifactText,
  runHarnessEval,
  scoreTaskResult,
  TASK_CATALOG,
  TASK_PROFILES,
  tasksForProfile,
} from "./harness-eval.mjs";

describe("meta harness eval runner helpers", () => {
  it("parses task, variant, trial, and dry-run options", () => {
    const options = parseHarnessEvalArgs(
      ["--tasks=live-smoke,long-context-qa", "--variants", "baseline,bootstrap-min", "--trials", "2", "--dry-run", "--resume", "--run-id", "fixed"],
      {},
      () => new Date("2026-05-09T00:00:00.000Z"),
    );

    expect(options).toMatchObject({
      tasks: ["live-smoke", "long-context-qa"],
      variants: ["baseline", "bootstrap-min"],
      trials: 2,
      dryRun: true,
      resume: true,
      runId: "fixed",
    });
  });

  it("rejects unknown task and variant ids", () => {
    expect(() => parseHarnessEvalArgs(["--tasks=unknown"], {})).toThrow("Unknown harness task");
    expect(() => parseHarnessEvalArgs(["--variants=weird"], {})).toThrow("Unknown harness variant");
  });

  it("expands task profiles and mixed task selectors", () => {
    expect(tasksForProfile("quick")).toEqual(["live-smoke"]);
    expect(TASK_PROFILES.search).toEqual(["live-smoke", "node-benchmark", "long-context-qa", "plugin-arxiv", "app-build-html-calculator"]);
    expect(TASK_PROFILES.holdout).toEqual(["workflow-graph-review"]);
    expect(expandTaskSelectors(["quick", "workflow-graph-review"])).toEqual(["live-smoke", "workflow-graph-review"]);
    expect(parseHarnessEvalArgs(["--profile=holdout"], {}).tasks).toEqual(["workflow-graph-review"]);
  });

  it("extracts the last pretty-printed JSON object from noisy output", () => {
    const output = [
      "vite log {not json}",
      "{",
      '  "workspace": "/tmp/a",',
      '  "messageDeltaCount": 3,',
      '  "nested": { "ok": true }',
      "}",
      "Live Ambient E2E smoke passed.",
    ].join("\n");

    expect(extractLastJsonObject(output)).toEqual({
      workspace: "/tmp/a",
      messageDeltaCount: 3,
      nested: { ok: true },
    });
  });

  it("keeps deterministic facts authoritative for task scoring", () => {
    const pass = scoreTaskResult(
      TASK_CATALOG["live-smoke"],
      { exitCode: 0, timedOut: false, elapsedMs: 100, stdout: "Live Ambient E2E smoke passed." },
      { toolEventCount: 2 },
    );
    const fail = scoreTaskResult(
      TASK_CATALOG["live-smoke"],
      { exitCode: 0, timedOut: false, elapsedMs: 100, stdout: "no marker" },
      { toolEventCount: 2 },
    );

    expect(pass).toMatchObject({ passed: true, failureCategory: null });
    expect(fail).toMatchObject({ passed: false, failureCategory: "missing-success-marker" });
  });

  it("enforces task mutation policy while ignoring managed Ambient setup", () => {
    const mutation = evaluateMutationPolicy(
      { requireTrace: true, allowedPathPatterns: ["README.md", "src/**"] },
      {
        changes: [
          { path: "README.md", status: "modified" },
          { path: "src/textStats.js", status: "added" },
          { path: ".ambient/cli-packages/imported/youtube-transcript-1/SKILL.md", status: "added" },
          { path: "notes.txt", status: "added" },
        ],
      },
    );

    expect(mutation).toMatchObject({
      evaluated: true,
      passed: false,
      allowedCount: 2,
      ignoredCount: 1,
      unexpectedPaths: ["notes.txt"],
    });

    const scored = scoreTaskResult(
      TASK_CATALOG["node-benchmark"],
      { exitCode: 0, timedOut: false, elapsedMs: 100, stdout: "Live Ambient coding benchmark passed." },
      {},
      mutation,
    );
    expect(scored).toMatchObject({ passed: false, failureCategory: "unexpected-mutation" });
  });

  it("gates html app-build mutations to generated calculator files", () => {
    const policy = TASK_CATALOG["app-build-html-calculator"].mutationPolicy;

    expect(policy).toMatchObject({ requireTrace: true });

    expect(
      evaluateMutationPolicy(policy, {
        changes: [
          { path: "package.json", status: "added" },
          { path: "index.html", status: "added" },
          { path: "src/calculator.js", status: "added" },
          { path: "src/styles.css", status: "added" },
          { path: "test/calculator.test.js", status: "added" },
          { path: "style.css", status: "added" },
        ],
      }),
    ).toMatchObject({
      evaluated: true,
      passed: true,
      allowedCount: 6,
      unexpectedPaths: [],
    });

    const mutation = evaluateMutationPolicy(policy, {
      changes: [
        { path: "package.json", status: "added" },
        { path: "package-lock.json", status: "added" },
        { path: "README.md", status: "modified" },
        { path: "src/calculator.js", status: "added" },
      ],
    });

    expect(mutation).toMatchObject({
      evaluated: true,
      passed: false,
      unexpectedPaths: ["README.md", "package-lock.json"],
    });
    expect(
      scoreTaskResult(
        TASK_CATALOG["app-build-html-calculator"],
        { exitCode: 0, timedOut: false, elapsedMs: 100, stdout: "Live Ambient app-build benchmark passed." },
        { status: "passed" },
        mutation,
      ),
    ).toMatchObject({ passed: false, failureCategory: "unexpected-mutation" });
  });

  it("requires mutation traces for workflow and project-board holdouts", () => {
    expect(TASK_CATALOG["workflow-graph-review"].mutationPolicy).toMatchObject({
      requireTrace: true,
      allowedPathPatterns: [],
    });
    expect(
      scoreTaskResult(
        TASK_CATALOG["workflow-graph-review"],
        { exitCode: 0, timedOut: false, elapsedMs: 100, stdout: "" },
        {},
        evaluateMutationPolicy(TASK_CATALOG["workflow-graph-review"].mutationPolicy, undefined),
      ),
    ).toMatchObject({ passed: false, failureCategory: "mutation-trace-missing" });

    const projectBoardPolicy = TASK_CATALOG["project-board-dogfood"].mutationPolicy;
    expect(projectBoardPolicy).toMatchObject({ requireTrace: true });
    expect(
      evaluateMutationPolicy(projectBoardPolicy, {
        changes: [
          { path: "task-workspace/src/runtime-split-progress.ts", status: "added" },
          { path: "task-workspace/test/runtime-split-progress.test.ts", status: "added" },
          { path: "task-workspace/docs/runtime-split-notes.md", status: "added" },
          { path: "project-root/.ambient-codex/state.sqlite", status: "modified" },
        ],
      }),
    ).toMatchObject({
      evaluated: true,
      passed: true,
      allowedCount: 3,
      ignoredCount: 1,
      unexpectedPaths: [],
    });

    const mutation = evaluateMutationPolicy(projectBoardPolicy, {
      changes: [
        { path: "task-workspace/src/runtime-split-progress.ts", status: "added" },
        { path: "task-workspace/package.json", status: "modified" },
      ],
    });
    expect(mutation).toMatchObject({
      evaluated: true,
      passed: false,
      unexpectedPaths: ["task-workspace/package.json"],
    });
    expect(
      scoreTaskResult(
        TASK_CATALOG["project-board-dogfood"],
        { exitCode: 0, timedOut: false, elapsedMs: 100, stdout: "{}" },
        { status: "passed" },
        mutation,
      ),
    ).toMatchObject({ passed: false, failureCategory: "unexpected-mutation" });
  });

  it("can require a parsed summary status for noisy dogfood tasks", () => {
    const pass = scoreTaskResult(TASK_CATALOG["project-board-dogfood"], { exitCode: 0, timedOut: false, elapsedMs: 100, stdout: "{}" }, { status: "passed" });
    const attention = scoreTaskResult(TASK_CATALOG["project-board-dogfood"], { exitCode: 0, timedOut: false, elapsedMs: 100, stdout: "{}" }, { status: "attention" });

    expect(pass).toMatchObject({ passed: true, failureCategory: null });
    expect(attention).toMatchObject({ passed: false, failureCategory: "summary-status-mismatch" });
  });

  it("aggregates frontier rows by variant and task", () => {
    const frontier = buildFrontier([
      trial("baseline", "live-smoke", true, 1000, 10),
      trial("baseline", "node-benchmark", false, 3000, 30),
      trial("bootstrap-scripts", "live-smoke", true, 900, 8),
      trial("bootstrap-scripts", "node-benchmark", true, 2000, 20),
    ]);

    expect(frontier.recommendedVariant).toBe("bootstrap-scripts");
    expect(frontier.variants[0]).toMatchObject({
      variant: "bootstrap-scripts",
      trialCount: 2,
      passed: 2,
      passRate: 1,
      medianElapsedMs: 1450,
      medianToolEventCount: 14,
    });
    expect(frontier.variants[1].tasks["node-benchmark"]).toMatchObject({ passed: 0, failed: 1 });
  });

  it("redacts known secret values and env-shaped secrets in artifacts", () => {
    const redacted = redactArtifactText("AMBIENT_API_KEY_FILE=<ignored-key-file> and literal-real-secret", ["literal-real-secret"]);

    expect(redacted).toBe("AMBIENT_API_KEY_FILE=<ignored-key-file> and [redacted secret]");
  });

  it("persists planned rows during dry runs for downstream judge/report stages", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-harness-eval-"));
    const result = await runHarnessEval(
      parseHarnessEvalArgs(["--tasks=live-smoke", "--variants=baseline,bootstrap-scripts", "--dry-run", "--run-id=dry"], {}),
      { cwd: root },
    );

    const rows = (await readFile(join(result.runRoot, "results.jsonl"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.status)).toEqual(["planned", "planned"]);
  });

  it("resumes live eval runs by skipping completed trial rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-harness-eval-resume-"));
    const runRoot = join(root, "out", "resume-live");
    await mkdir(runRoot, { recursive: true });
    await writeFile(
      join(runRoot, "results.jsonl"),
      `${JSON.stringify({
        version: 1,
        runId: "resume-live",
        variant: "baseline",
        taskId: "live-smoke",
        trial: 1,
        status: "succeeded",
        elapsedMs: 123,
        artifactDir: join(runRoot, "traces", "baseline", "live-smoke", "trial-1"),
        metrics: { toolEventCount: 9 },
        deterministic: { passed: true, failureCategory: null, evidence: ["existing pass"] },
      })}\n`,
      "utf8",
    );
    const spawnedTrials = [];

    const result = await runHarnessEval(
      parseHarnessEvalArgs(["--tasks=live-smoke", "--variants=baseline", "--trials=2", "--output-dir=out", "--run-id=resume-live", "--resume"], {}),
      {
        cwd: root,
        spawn: fakeSuccessfulSpawn(spawnedTrials),
      },
    );

    const rows = (await readFile(join(runRoot, "results.jsonl"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));

    expect(spawnedTrials).toEqual(["2"]);
    expect(result.resume).toEqual({ enabled: true, expected: 2, existing: 1, skipped: 1, executed: 1 });
    expect(rows.map((row) => row.trial)).toEqual([1, 2]);
    expect(rows.map((row) => row.deterministic.passed)).toEqual([true, true]);
    expect(await readFile(join(runRoot, "summary.md"), "utf8")).toContain("Resume: skipped 1/2 completed trial(s), executed 1.");
  });

  it("writes task-specific env overrides without a synthetic undefined port", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-harness-eval-"));
    const result = await runHarnessEval(
      parseHarnessEvalArgs(["--tasks=app-build-html-calculator,workflow-graph-review", "--variants=baseline", "--dry-run", "--run-id=dry-env"], {}),
      { cwd: root },
    );

    const rows = (await readFile(join(result.runRoot, "results.jsonl"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));

    expect(rows[0].envOverrides).toMatchObject({
      AMBIENT_HARNESS_VARIANT: "baseline",
      AMBIENT_APP_BUILDS_SCENARIOS: "html-calculator",
      AMBIENT_APP_BUILDS_CDP_PORT: "9601",
    });
    expect(rows[1].envOverrides).toMatchObject({
      AMBIENT_HARNESS_VARIANT: "baseline",
      AMBIENT_HARNESS_RUN_ID: "dry-env",
      AMBIENT_HARNESS_TASK_ID: "workflow-graph-review",
      AMBIENT_HARNESS_TRIAL: "1",
    });
    expect(rows[1].envOverrides.AMBIENT_HARNESS_TRACE_DIR).toContain("traces/baseline/workflow-graph-review/trial-1");
    expect(rows[1].envOverrides).not.toHaveProperty("undefined");
  });

  it("indexes per-trial trace artifacts for downstream judge packets", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-harness-artifacts-"));
    const traceDir = join(root, "traces", "baseline", "live-smoke", "trial-1");
    await mkdir(traceDir, { recursive: true });
    await writeFile(join(traceDir, "stdout.log"), "ok", "utf8");
    await writeFile(join(traceDir, "tool-transcript.txt"), "tool output", "utf8");

    const index = await buildTrialArtifactIndex(traceDir, root);

    expect(index.files.map((file) => file.path)).toEqual(["stdout.log", "tool-transcript.txt"]);
    expect(index.files[0].relativePath).toBe("traces/baseline/live-smoke/trial-1/stdout.log");
  });
});

function trial(variant, taskId, passed, elapsedMs, toolEventCount) {
  return {
    variant,
    taskId,
    trial: 1,
    elapsedMs,
    metrics: { toolEventCount },
    deterministic: { passed },
  };
}

function fakeSuccessfulSpawn(spawnedTrials) {
  return (_command, _args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 12345;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => undefined;

    setImmediate(async () => {
      spawnedTrials.push(options.env.AMBIENT_HARNESS_TRIAL);
      await writeFile(
        join(options.env.AMBIENT_HARNESS_TRACE_DIR, "changed-files.json"),
        `${JSON.stringify({ changes: [{ path: "ambient-live-smoke.txt", status: "added" }] })}\n`,
        "utf8",
      );
      child.stdout.write(`${JSON.stringify({ messageDeltaCount: 2, toolEventCount: 4 })}\n`);
      child.stdout.write("Live Ambient E2E smoke passed.\n");
      child.stdout.end();
      child.stderr.end();
      child.exitCode = 0;
      child.emit("close", 0, null);
    });

    return child;
  };
}
