import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildJudgePacket,
  buildJudgeSummary,
  mergeJudgeWithDeterministic,
  parseJudgeArgs,
  parseJsonObjectText,
  runHarnessJudge,
  validateJudgeObject,
} from "./harness-eval-judge.mjs";

describe("meta harness judge", () => {
  it("parses judge options", () => {
    expect(parseJudgeArgs(["--run-root", "test-results/harness-evals/run-1", "--limit=2", "--dry-run", "--resume"], {})).toMatchObject({
      runRoot: "test-results/harness-evals/run-1",
      limit: 2,
      dryRun: true,
      resume: true,
    });
  });

  it("validates strict judge output shape", () => {
    expect(validateJudgeObject(validJudge()).ok).toBe(true);
    expect(validateJudgeObject({ ...validJudge(), pass: "yes", score: 2 }).errors).toEqual(
      expect.arrayContaining(["pass must be boolean", "score must be a number between 0 and 1"]),
    );
  });

  it("keeps deterministic failures authoritative during merge", () => {
    const merged = mergeJudgeWithDeterministic(
      { deterministic: { passed: false } },
      { status: "valid", judge: { ...validJudge(), pass: true, score: 1 } },
    );

    expect(merged).toMatchObject({ pass: false, score: 0, reason: "deterministic-fail" });
  });

  it("builds redacted bounded judge packets from trial artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-harness-judge-packet-"));
    try {
      const trace = join(root, "traces", "bootstrap-scripts", "live-smoke", "trial-1");
      await mkdir(trace, { recursive: true });
      await writeFile(join(root, "config.json"), JSON.stringify({ runId: "run-1" }), "utf8");
      await writeFile(join(trace, "deterministic-score.json"), JSON.stringify({ evidence: ["stdout marker"] }), "utf8");
      await writeFile(join(trace, "summary.json"), JSON.stringify({ model: "zai-org/GLM-5.1-FP8", toolEventCount: 5 }), "utf8");
      await writeFile(join(trace, "changed-files.json"), JSON.stringify({ changes: [{ path: "README.md", status: "modified", after: { bytes: 12 } }] }), "utf8");
      await writeFile(join(trace, "tool-transcript.txt"), "bash\nok", "utf8");
      await writeFile(join(trace, "stdout.log"), `AMBIENT_API_KEY_FILE=<ignored-key-file>"x".repeat(5000)}`, "utf8");

      const packet = await buildJudgePacket({
        runRoot: root,
        config: { runId: "run-1" },
        row: {
          runId: "run-1",
          variant: "bootstrap-scripts",
          taskId: "live-smoke",
          trial: 1,
          status: "succeeded",
          artifactDir: trace,
          elapsedMs: 1000,
          metrics: { toolEventCount: 5 },
          deterministic: {
            passed: true,
            evidence: ["child process exited with code 0"],
            mutation: { evaluated: true, passed: true, unexpectedPaths: [], ignoredPaths: [".ambient/cli-packages/packages.json"] },
          },
        },
        candidateLabel: "candidate_a",
        includeTextPreviews: true,
        now: () => new Date("2026-05-09T00:00:00.000Z"),
      });

      expect(packet.candidateLabel).toBe("candidate_a");
      expect(packet.deterministic.passed).toBe(true);
      expect(packet.tracePreview.stdoutTail).not.toContain("supersecret");
      expect(packet.tracePreview.toolTranscriptTail).toContain("bash");
      expect(packet.deterministic.mutation).toMatchObject({ evaluated: true, passed: true, unexpectedPaths: [] });
      expect(packet.deterministic.changedFiles).toMatchObject({ count: 1, changes: [{ path: "README.md", status: "modified", bytes: 12 }] });
      expect(packet.tracePreview.stdoutTail.length).toBeLessThanOrEqual(4000);
      expect(packet.scriptSummary).toMatchObject({ model: "zai-org/GLM-5.1-FP8", toolEventCount: 5 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes dry-run judge outputs and summary", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-harness-judge-run-"));
    try {
      const runRoot = join(root, "run-1");
      const trace = join(runRoot, "traces", "baseline", "live-smoke", "trial-1");
      await mkdir(trace, { recursive: true });
      const result = {
        version: 1,
        runId: "run-1",
        variant: "baseline",
        taskId: "live-smoke",
        trial: 1,
        status: "succeeded",
        artifactDir: trace,
        elapsedMs: 1000,
        metrics: { toolEventCount: 5 },
        deterministic: { passed: true, failureCategory: null, evidence: ["ok"] },
      };
      await writeFile(join(runRoot, "config.json"), JSON.stringify({ runId: "run-1" }), "utf8");
      await writeFile(join(runRoot, "results.jsonl"), `${JSON.stringify(result)}\n`, "utf8");
      await writeFile(join(trace, "stdout.log"), "Live Ambient E2E smoke passed.\n", "utf8");

      const judged = await runHarnessJudge({
        runRoot,
        outputName: "judge-results.json",
        model: "test-model",
        baseUrl: "https://ambient.example/v1",
        dryRun: true,
        includeTextPreviews: true,
        cwd: root,
      });
      const packet = JSON.parse(await readFile(join(trace, "judge-packet.json"), "utf8"));
      const judgeResult = JSON.parse(await readFile(join(trace, "judge-result.json"), "utf8"));

      expect(judged.summary).toMatchObject({ runId: "run-1", judgedTrialCount: 1, recommendedVariant: "baseline" });
      expect(packet.candidateLabel).toBe("candidate_a");
      expect(judgeResult).toMatchObject({ status: "valid", merged: { pass: true } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resumes judging from existing per-trial judge-result artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-harness-judge-resume-"));
    try {
      const runRoot = join(root, "run-1");
      const trace1 = join(runRoot, "traces", "baseline", "live-smoke", "trial-1");
      const trace2 = join(runRoot, "traces", "baseline", "live-smoke", "trial-2");
      await mkdir(trace1, { recursive: true });
      await mkdir(trace2, { recursive: true });
      const result1 = resultRow({ runRoot, trial: 1, trace: trace1 });
      const result2 = resultRow({ runRoot, trial: 2, trace: trace2 });
      const existingJudge = {
        version: 1,
        generatedAt: "2026-05-09T00:00:00.000Z",
        runId: "run-1",
        candidateLabel: "candidate_a",
        variant: "baseline",
        taskId: "live-smoke",
        trial: 1,
        status: "valid",
        deterministicPassed: true,
        judge: { ...validJudge(), score: 0.95 },
        validationErrors: [],
        merged: { pass: true, score: 0.95, reason: "existing", localFactsAuthoritative: true },
      };
      await writeFile(join(runRoot, "config.json"), JSON.stringify({ runId: "run-1" }), "utf8");
      await writeFile(join(runRoot, "results.jsonl"), `${JSON.stringify(result1)}\n${JSON.stringify(result2)}\n`, "utf8");
      await writeFile(join(trace1, "judge-result.json"), JSON.stringify(existingJudge), "utf8");
      await writeFile(join(trace1, "stdout.log"), "Live Ambient E2E smoke passed.\n", "utf8");
      await writeFile(join(trace2, "stdout.log"), "Live Ambient E2E smoke passed.\n", "utf8");

      const judged = await runHarnessJudge({
        runRoot,
        outputName: "judge-results.jsonl",
        model: "test-model",
        baseUrl: "https://ambient.example/v1",
        dryRun: true,
        resume: true,
        includeTextPreviews: true,
        cwd: root,
      });
      const rows = (await readFile(join(runRoot, "judge-results.jsonl"), "utf8"))
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));

      expect(judged.resume).toEqual({ enabled: true, expected: 2, existing: 1, skipped: 1, executed: 1 });
      expect(rows.map((row) => row.trial)).toEqual([1, 2]);
      expect(rows[0].merged.score).toBe(0.95);
      expect(rows[1]).toMatchObject({ status: "valid", merged: { pass: true } });
      expect(await readFile(join(runRoot, "judge-summary.md"), "utf8")).toContain("Resume: skipped 1/2 completed judge result(s), executed 1.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses JSON object text with surrounding chatter", () => {
    expect(parseJsonObjectText(`Here:\n${JSON.stringify(validJudge())}\nDone`)).toMatchObject({ pass: true, score: 0.8 });
  });

  it("summarizes judged variants", () => {
    const summary = buildJudgeSummary({
      config: { runId: "run-1" },
      candidateLabels: new Map([
        ["baseline", "candidate_a"],
        ["bootstrap-scripts", "candidate_b"],
      ]),
      generatedAt: "2026-05-09T00:00:00.000Z",
      dryRun: false,
      judgeRows: [
        { variant: "baseline", candidateLabel: "candidate_a", status: "valid", deterministicPassed: true, merged: { pass: true, score: 0.6 }, judge: { ...validJudge(), score: 0.6 } },
        { variant: "bootstrap-scripts", candidateLabel: "candidate_b", status: "valid", deterministicPassed: true, merged: { pass: true, score: 0.9 }, judge: { ...validJudge(), score: 0.9 } },
      ],
    });

    expect(summary.recommendedVariant).toBe("bootstrap-scripts");
    expect(summary.candidateMap).toEqual({ candidate_a: "baseline", candidate_b: "bootstrap-scripts" });
  });
});

function validJudge() {
  return {
    pass: true,
    score: 0.8,
    failureCategory: null,
    unrelatedMutationRisk: "low",
    toolUseCoherence: "strong",
    contractAdherence: "strong",
    deterministicAgreement: "agrees",
    concerns: [],
    conciseRationale: "The trial satisfied the request with coherent tool use.",
  };
}

function resultRow({ runRoot, trial, trace }) {
  return {
    version: 1,
    runId: "run-1",
    variant: "baseline",
    taskId: "live-smoke",
    trial,
    status: "succeeded",
    artifactDir: trace ?? join(runRoot, "traces", "baseline", "live-smoke", `trial-${trial}`),
    elapsedMs: 1000,
    metrics: { toolEventCount: 5 },
    deterministic: { passed: true, failureCategory: null, evidence: ["ok"] },
  };
}
