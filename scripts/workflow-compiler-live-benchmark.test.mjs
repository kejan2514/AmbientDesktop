import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyWorkflowCompilerLiveBenchmarkAttempt,
  defaultWorkflowCompilerLiveBenchmarkTasks,
  renderWorkflowCompilerLiveBenchmarkMarkdown,
  runWorkflowCompilerLiveBenchmarks,
  selectWorkflowCompilerLiveBenchmarkTasks,
  writeWorkflowCompilerLiveBenchmarkReport,
  workflowCompilerLiveBenchmarkExitCode,
} from "./workflow-compiler-live-benchmark-lib.mjs";

describe("workflow compiler live benchmark harness", () => {
  it("classifies provider, environment, product, and success outcomes", () => {
    expect(classifyWorkflowCompilerLiveBenchmarkAttempt({ exitCode: 0, stdout: "ok", stderr: "" })).toMatchObject({
      status: "passed",
      providerHealth: "healthy",
    });
    expect(classifyWorkflowCompilerLiveBenchmarkAttempt({ exitCode: 1, stdout: "", stderr: "429 Upstream request failed" })).toMatchObject({
      status: "provider_degraded",
      providerHealth: "degraded",
      retryable: true,
      matchedPattern: "rate_limit",
    });
    expect(
      classifyWorkflowCompilerLiveBenchmarkAttempt({
        exitCode: 1,
        stdout: "",
        stderr: "Ambient/Pi stream stalled after 30000ms without stream activity.",
      }),
    ).toMatchObject({
      status: "provider_degraded",
      matchedPattern: "stream_idle",
    });
    expect(
      classifyWorkflowCompilerLiveBenchmarkAttempt({
        exitCode: 1,
        stdout: "",
        stderr: "Ambient/Pi workflow request exceeded the 120000ms absolute timeout.",
      }),
    ).toMatchObject({
      status: "provider_degraded",
      matchedPattern: "provider_absolute_timeout",
      retryable: true,
    });
    expect(classifyWorkflowCompilerLiveBenchmarkAttempt({ exitCode: 1, stdout: "", stderr: "Set AMBIENT_API_KEY for live Workflow Agent dogfood." })).toMatchObject({
      status: "skipped",
      retryable: false,
      matchedPattern: "missing_provider_key",
    });
    expect(classifyWorkflowCompilerLiveBenchmarkAttempt({ exitCode: 1, stdout: "", stderr: "Set GMI_CLOUD_API_KEY, GMI_API_KEY, GMI_CLOUD_API_KEY_FILE, or provide ignored-provider-key-file.txt for live Workflow Agent dogfood." })).toMatchObject({
      status: "skipped",
      retryable: false,
      matchedPattern: "missing_provider_key",
    });
    expect(classifyWorkflowCompilerLiveBenchmarkAttempt({ exitCode: 1, stdout: "", stderr: "No Google Workspace account is configured for this live dogfood." })).toMatchObject({
      status: "skipped",
      matchedPattern: "missing_google_auth",
    });
    expect(classifyWorkflowCompilerLiveBenchmarkAttempt({ exitCode: 255, stdout: "Tests 1 passed", stderr: "node-gyp failed to rebuild '/repo/node_modules/node-pty'" })).toMatchObject({
      status: "skipped",
      matchedPattern: "native_rebuild",
    });
    expect(classifyWorkflowCompilerLiveBenchmarkAttempt({ exitCode: 1, stdout: "", stderr: "Expected Google account provenance in generated manifest." })).toMatchObject({
      status: "product_or_test_failure",
    });
    expect(
      classifyWorkflowCompilerLiveBenchmarkAttempt({
        exitCode: 1,
        stdout: "",
        stderr: "Scenario local-file-classifier generated source failed provenance gates: expected at most 0 selected recipes, saw 1",
      }),
    ).toMatchObject({
      status: "product_or_test_failure",
      providerHealth: "healthy",
      matchedPattern: "provenance_gate",
    });
    expect(classifyWorkflowCompilerLiveBenchmarkAttempt({ exitCode: 1, stdout: "", stderr: "Desktop tool timed out after 30000ms: browser_nav" })).toMatchObject({
      status: "product_or_test_failure",
      matchedPattern: "desktop_tool_timeout",
    });
    expect(
      classifyWorkflowCompilerLiveBenchmarkAttempt({
        exitCode: 1,
        stdout: "",
        stderr: "WorkflowProgramIR repair response failed deterministic validation; user-choice-required",
      }),
    ).toMatchObject({
      status: "product_or_test_failure",
      matchedPattern: "compile_repair_user_choice",
    });
    expect(
      classifyWorkflowCompilerLiveBenchmarkAttempt({
        exitCode: 1,
        stdout: "",
        stderr: "Scenario evidence assertions failed for gmail-20: expected final output to include one of: metadata-only",
      }),
    ).toMatchObject({
      status: "product_or_test_failure",
      matchedPattern: "evidence_assertion",
    });
    expect(
      classifyWorkflowCompilerLiveBenchmarkAttempt({
        exitCode: 1,
        stdout: "",
        stderr: "FAIL Workflow Agent dogfood > runs a Drive file-evidence report workflow through the real Google wrapper\nError: Test timed out in 900000ms.",
      }),
    ).toMatchObject({
      status: "provider_degraded",
      matchedPattern: "live_test_timeout",
      retryable: false,
    });
    expect(classifyWorkflowCompilerLiveBenchmarkAttempt({ exitCode: 1, stdout: "", stderr: "Expected graph node source mapping to exist" })).toMatchObject({
      status: "product_or_test_failure",
      retryable: false,
    });
  });

  it("retries provider-degraded rows but does not retry product failures", async () => {
    const calls = [];
    const { summary } = await runWorkflowCompilerLiveBenchmarks({
      generatedAt: "2026-05-15T00:00:00.000Z",
      concurrency: 1,
      retries: 1,
      retryBaseMs: 0,
      tasks: [
        {
          id: "provider-then-pass",
          label: "Provider then pass",
          description: "fixture",
          command: "pnpm",
          args: ["test"],
        },
        {
          id: "product-failure",
          label: "Product failure",
          description: "fixture",
          command: "pnpm",
          args: ["test"],
        },
      ],
      sleep: async () => undefined,
      runCommand: async (input) => {
        calls.push(input);
        if (calls.length === 1) return { exitCode: 1, stdout: "", stderr: "Ambient/Pi stream stalled after 30000ms without stream activity." };
        if (calls.length === 2) return { exitCode: 0, stdout: "ok", stderr: "" };
        return { exitCode: 1, stdout: "", stderr: "Expected workflow output card to exist" };
      },
    });

    expect(summary).toMatchObject({
      taskCount: 2,
      passedCount: 1,
      productOrTestFailureCount: 1,
      providerDegradedCount: 0,
    });
    expect(summary.tasks[0].attempts).toHaveLength(2);
    expect(summary.tasks[1].attempts).toHaveLength(1);
  });

  it("selects tasks and renders operator-facing provider-health rows", () => {
    const tasks = defaultWorkflowCompilerLiveBenchmarkTasks();
    expect(selectWorkflowCompilerLiveBenchmarkTasks(tasks, ["pi-transport-tool-call,scottsdale-live-compile"]).map((task) => task.id)).toEqual([
      "pi-transport-tool-call",
      "scottsdale-live-compile",
    ]);
    expect(() => selectWorkflowCompilerLiveBenchmarkTasks(tasks, ["missing-task"])).toThrow(/Unknown workflow compiler live benchmark task/);

    const markdown = renderWorkflowCompilerLiveBenchmarkMarkdown({
      generatedAt: "2026-05-15T00:00:00.000Z",
      taskCount: 1,
      passedCount: 0,
      providerDegradedCount: 1,
      skippedCount: 0,
      productOrTestFailureCount: 0,
      tasks: [
        {
          id: "scottsdale-live-compile",
          label: "Scottsdale live compile",
          status: "provider_degraded",
          providerHealth: "degraded",
          reason: "Ambient/Pi stream did not produce usable output within the idle window.",
          command: "bash",
          args: ["scripts/test-node-native.sh"],
          totalWallClockMs: 1200,
          attempts: [{ attempt: 1, classification: { status: "provider_degraded" }, exitCode: 1, durationMs: 1200, stdoutChars: 0, stderrChars: 80 }],
        },
      ],
    });
    expect(markdown).toContain("Workflow Compiler Live Benchmark");
    expect(markdown).toContain("Provider-degraded/inconclusive: 1");
    expect(markdown).toContain("Scottsdale live compile");
  });

  it("keeps provider-degraded rows nonfatal unless live is required", () => {
    const summary = {
      taskCount: 1,
      passedCount: 0,
      providerDegradedCount: 1,
      skippedCount: 0,
      productOrTestFailureCount: 0,
      tasks: [],
    };
    expect(workflowCompilerLiveBenchmarkExitCode(summary)).toBe(0);
    expect(workflowCompilerLiveBenchmarkExitCode(summary, { requireLive: true })).toBe(1);
    expect(workflowCompilerLiveBenchmarkExitCode({ ...summary, providerDegradedCount: 0, productOrTestFailureCount: 1 })).toBe(1);
  });

  it("writes latest, immutable run reports, and append-only history", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "workflow-live-bench-"));
    const summary = {
      generatedAt: "2026-05-16T01:02:03.004Z",
      taskCount: 1,
      passedCount: 1,
      providerDegradedCount: 0,
      skippedCount: 0,
      productOrTestFailureCount: 0,
      retryLimit: 2,
      concurrency: 4,
      totalWallClockMs: 1234,
      tasks: [
        {
          id: "pi-transport-tool-call",
          label: "Pi transport forced tool call",
          status: "passed",
          providerHealth: "healthy",
          reason: "Command completed successfully.",
          command: "pnpm",
          args: ["exec", "vitest"],
          totalWallClockMs: 1234,
          attempts: [{ attempt: 1, classification: { status: "passed" }, exitCode: 0, durationMs: 1234, stdoutChars: 2, stderrChars: 0 }],
        },
      ],
    };

    const first = await writeWorkflowCompilerLiveBenchmarkReport(summary, outputDir);
    const second = await writeWorkflowCompilerLiveBenchmarkReport(summary, outputDir);

    expect(first.jsonPath).toBe(join(outputDir, "live-latest.json"));
    expect(first.markdownPath).toBe(join(outputDir, "live-latest.md"));
    expect(first.runJsonPath).toMatch(/live-runs\/2026-05-16T01-02-03.004Z\.json$/);
    expect(first.runMarkdownPath).toMatch(/live-runs\/2026-05-16T01-02-03.004Z\.md$/);
    expect(first.logDirPath).toBe(join(outputDir, "live-logs", "2026-05-16T01-02-03.004Z"));
    expect(second.runJsonPath).toMatch(/live-runs\/2026-05-16T01-02-03.004Z-2\.json$/);

    const latest = JSON.parse(await readFile(first.jsonPath, "utf8"));
    expect(latest).toMatchObject({ generatedAt: summary.generatedAt, passedCount: 1 });
    expect(await readFile(first.runMarkdownPath, "utf8")).toContain("Workflow Compiler Live Benchmark");

    const historyRows = (await readFile(first.historyPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(historyRows).toHaveLength(2);
    expect(historyRows[0]).toMatchObject({
      schemaVersion: 1,
      generatedAt: summary.generatedAt,
      runId: "2026-05-16T01-02-03.004Z",
      taskCount: 1,
      passedCount: 1,
      retryLimit: 2,
      concurrency: 4,
      logDirPath: join(outputDir, "live-logs", "2026-05-16T01-02-03.004Z"),
    });
    expect(historyRows[1].runId).toBe("2026-05-16T01-02-03.004Z-2");
  });

  it("keeps attempt logs scoped to each immutable live run", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "workflow-live-bench-"));
    const task = {
      id: "same-live-task",
      label: "Same live task",
      description: "fixture",
      command: "fixture",
      args: ["run"],
    };
    let stdout = "first run output";
    const first = await runWorkflowCompilerLiveBenchmarks({
      outputDir,
      generatedAt: "2026-05-16T02:00:00.000Z",
      tasks: [task],
      runCommand: async () => ({ exitCode: 0, stdout, stderr: "" }),
    });

    stdout = "second run output";
    const second = await runWorkflowCompilerLiveBenchmarks({
      outputDir,
      generatedAt: "2026-05-16T02:00:01.000Z",
      tasks: [task],
      runCommand: async () => ({ exitCode: 0, stdout, stderr: "" }),
    });

    const firstLogPath = first.summary.tasks[0].attempts[0].logPath;
    const secondLogPath = second.summary.tasks[0].attempts[0].logPath;
    expect(first.summary.runId).toBe("2026-05-16T02-00-00.000Z");
    expect(second.summary.runId).toBe("2026-05-16T02-00-01.000Z");
    expect(firstLogPath).toContain("live-logs/2026-05-16T02-00-00.000Z/same-live-task-attempt-1.log");
    expect(secondLogPath).toContain("live-logs/2026-05-16T02-00-01.000Z/same-live-task-attempt-1.log");
    expect(first.paths.logDirPath).toBe(join(outputDir, "live-logs", "2026-05-16T02-00-00.000Z"));
    expect(second.paths.logDirPath).toBe(join(outputDir, "live-logs", "2026-05-16T02-00-01.000Z"));
    expect(await readFile(firstLogPath, "utf8")).toContain("first run output");
    expect(await readFile(secondLogPath, "utf8")).toContain("second run output");

    const firstReport = JSON.parse(await readFile(first.paths.runJsonPath, "utf8"));
    expect(firstReport.tasks[0].attempts[0].logPath).toBe(firstLogPath);
    expect(await readFile(first.paths.runMarkdownPath, "utf8")).toContain("live-logs/2026-05-16T02-00-00.000Z/same-live-task-attempt-1.log");
  });

  it("does not run tasks from the same exclusive group concurrently", async () => {
    let activeExclusive = 0;
    let maxActiveExclusive = 0;
    await runWorkflowCompilerLiveBenchmarks({
      generatedAt: "2026-05-15T00:00:00.000Z",
      concurrency: 3,
      retries: 0,
      tasks: [
        { id: "a", label: "A", description: "fixture", command: "native-a", args: ["test"], exclusiveGroup: "native" },
        { id: "b", label: "B", description: "fixture", command: "native-b", args: ["test"], exclusiveGroup: "native" },
        { id: "c", label: "C", description: "fixture", command: "free", args: ["test"] },
      ],
      runCommand: async (input) => {
        if (input.command.startsWith("native-")) {
          activeExclusive += 1;
          maxActiveExclusive = Math.max(maxActiveExclusive, activeExclusive);
          await new Promise((resolve) => setTimeout(resolve, 5));
          activeExclusive -= 1;
        }
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    });

    expect(maxActiveExclusive).toBe(1);
  });
});
