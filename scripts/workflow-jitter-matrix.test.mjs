import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWorkflowJitterMatrixPromotionCandidates,
  classifyWorkflowJitterMatrixAttempt,
  defaultWorkflowJitterMatrixTasks,
  renderWorkflowJitterMatrixMarkdown,
  resolveGmiCloudKeyFileForChildEnv,
  resolveWorkflowJitterMatrixTasks,
  runWorkflowJitterMatrix,
  workflowJitterMatrixExitCode,
  writeWorkflowJitterMatrixReport,
} from "./workflow-jitter-matrix.mjs";

describe("workflow jitter matrix", () => {
  it("classifies pass, provider degradation, environment skip, and product failure rows", () => {
    expect(classifyWorkflowJitterMatrixAttempt({ exitCode: 0, stdout: "ok", stderr: "" })).toMatchObject({
      status: "passed",
      providerHealth: "healthy",
    });
    expect(
      classifyWorkflowJitterMatrixAttempt({
        exitCode: 1,
        stdout: "",
        stderr: "Ambient/Pi stream stalled after 30000ms without stream activity.",
      }),
    ).toMatchObject({
      status: "provider_degraded",
      matchedPattern: "stream_idle",
      retryable: true,
    });
    expect(
      classifyWorkflowJitterMatrixAttempt({
        exitCode: 1,
        stdout: "",
        stderr: "Set GMI_CLOUD_API_KEY, GMI_API_KEY, GMI_CLOUD_API_KEY_FILE, or provide ignored-provider-key-file.txt for live Workflow Agent dogfood.",
      }),
    ).toMatchObject({
      status: "environment_skipped",
      matchedPattern: "missing_provider_key",
      retryable: false,
    });
    expect(
      classifyWorkflowJitterMatrixAttempt({
        exitCode: 1,
        stdout: "Workflow Agent UI dogfood classification: environment/snapshot issue",
        stderr: "Snapshot copy requested, but the selected snapshot root does not exist.",
      }),
    ).toMatchObject({
      status: "environment_skipped",
      matchedPattern: "credentialed_snapshot_missing",
      retryable: false,
    });
    expect(classifyWorkflowJitterMatrixAttempt({ exitCode: 1, stdout: "", stderr: "Expected graph node source mapping to exist" })).toMatchObject({
      status: "product_or_test_failure",
      retryable: false,
    });
  });

  it("resolves profiles, explicit task selections, and live smoke expansion", () => {
    const tasks = defaultWorkflowJitterMatrixTasks();
    expect(resolveWorkflowJitterMatrixTasks({ tasks, profile: "phase8-smoke" }).map((task) => task.id)).toEqual([
      "model-tolerance-mock",
      "workflow-ir-path-jitter",
      "workflow-path-registry-jitter",
      "workflow-ui-comprehension",
      "workflow-program-core",
    ]);
    expect(resolveWorkflowJitterMatrixTasks({ tasks, profile: "phase8-smoke", includeLive: true }).map((task) => task.id)).toContain(
      "ui-dogfood-vocabulary-quiz",
    );
    const releaseTaskIds = resolveWorkflowJitterMatrixTasks({ tasks, profile: "release" }).map((task) => task.id);
    expect(releaseTaskIds).toEqual(
      expect.arrayContaining([
        "model-tolerance-live-compile-prompts",
        "ui-dogfood-gmail-20-metadata-readonly-validation",
        "ui-dogfood-downloads-document-categorization",
        "ui-dogfood-flaky-browser-recovery",
      ]),
    );
    expect(releaseTaskIds.filter((id) => id.startsWith("ui-dogfood-"))).toHaveLength(10);
    expect(resolveWorkflowJitterMatrixTasks({ tasks, taskIds: ["workflow-ir-path-jitter,workflow-program-core"] }).map((task) => task.id)).toEqual([
      "workflow-ir-path-jitter",
      "workflow-program-core",
    ]);
    expect(() => resolveWorkflowJitterMatrixTasks({ tasks, taskIds: ["missing-task"] })).toThrow(/Unknown workflow jitter matrix task/);
  });

  it("resolves GMI key file paths for live child tasks outside the current worktree", () => {
    expect(
      resolveGmiCloudKeyFileForChildEnv({
        env: { GMI_CLOUD_API_KEY_FILE: "/explicit/gmi-key.txt" },
        repoRoot: "/tmp/worktree",
        homeDir: "/Users/tester",
        existsSync: () => false,
      }),
    ).toBe("/explicit/gmi-key.txt");

    expect(
      resolveGmiCloudKeyFileForChildEnv({
        env: {},
        repoRoot: "/tmp/ambient-plan-slice",
        homeDir: "/Users/tester",
        existsSync: (candidate) => candidate === "/Users/tester/Documents/ambientCoder/ignored-provider-key-file.txt",
      }),
    ).toBe("/Users/tester/Documents/ambientCoder/ignored-provider-key-file.txt");

    expect(
      resolveGmiCloudKeyFileForChildEnv({
        env: {},
        repoRoot: "/tmp/ambient-plan-slice",
        homeDir: "/Users/tester",
        existsSync: () => false,
      }),
    ).toBe("/tmp/ambient-plan-slice/ignored-provider-key-file.txt");
  });

  it("retries provider-degraded rows and keeps product failures terminal", async () => {
    const calls = [];
    const { summary } = await runWorkflowJitterMatrix({
      generatedAt: "2026-05-19T00:00:00.000Z",
      runId: "unit-retry",
      sourceRevision: { gitHead: "abc123", dirty: false },
      outputDir: false,
      concurrency: 2,
      retries: 1,
      retryBaseMs: 0,
      tasks: [
        {
          id: "provider-then-pass",
          label: "Provider then pass",
          axis: "provider",
          tier: "live",
          command: "fixture",
          args: ["provider"],
        },
        {
          id: "product-failure",
          label: "Product failure",
          axis: "compiler",
          tier: "deterministic",
          command: "fixture",
          args: ["product"],
        },
      ],
      sleep: async () => undefined,
      runCommand: async (input) => {
        calls.push(input);
        if (input.args[0] === "provider" && calls.filter((call) => call.args[0] === "provider").length === 1) {
          return { exitCode: 1, stdout: "", stderr: "Ambient/Pi stream stalled after 30000ms without stream activity." };
        }
        if (input.args[0] === "provider") return { exitCode: 0, stdout: "ok", stderr: "" };
        return { exitCode: 1, stdout: "", stderr: "Expected workflow output card to exist" };
      },
    });

    expect(summary).toMatchObject({
      taskCount: 2,
      passedCount: 1,
      providerDegradedCount: 0,
      productOrTestFailureCount: 1,
      livePromptVariantCount: 0,
      liveDogfoodRunCount: 0,
      sourceRevision: { gitHead: "abc123", dirty: false },
    });
    expect(summary.tasks.find((task) => task.id === "provider-then-pass")?.attempts).toHaveLength(2);
    expect(summary.tasks.find((task) => task.id === "product-failure")?.attempts).toHaveLength(1);
    expect(workflowJitterMatrixExitCode(summary)).toBe(1);
  });

  it("writes latest, immutable, history, and operator markdown reports", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "workflow-jitter-matrix-"));
    const summary = {
      schemaVersion: 1,
      generatedAt: "2026-05-19T01:02:03.004Z",
      runId: "2026-05-19T01-02-03.004Z",
      sourceRevision: { gitHead: "abc123", dirty: false },
      profile: "phase8-smoke",
      totalWallClockMs: 1234,
      concurrency: 2,
      retryLimit: 1,
      taskCount: 1,
      deterministicCount: 1,
      liveCount: 0,
      passedCount: 1,
      providerDegradedCount: 0,
      environmentSkippedCount: 0,
      productOrTestFailureCount: 0,
      tasks: [
        {
          id: "workflow-ir-path-jitter",
          label: "Workflow IR path jitter",
          axis: "ir",
          tier: "deterministic",
          command: "pnpm",
          args: ["run", "test:workflow-ir-path-jitter"],
          status: "passed",
          providerHealth: "healthy",
          reason: "Command completed successfully.",
          totalWallClockMs: 1234,
          attempts: [
            {
              attempt: 1,
              status: "passed",
              classification: { status: "passed" },
              exitCode: 0,
              durationMs: 1234,
              stdoutChars: 2,
              stderrChars: 0,
              logPath: join(outputDir, "logs", "workflow-ir-path-jitter.log"),
            },
          ],
        },
      ],
    };

    const first = await writeWorkflowJitterMatrixReport(summary, outputDir);
    const second = await writeWorkflowJitterMatrixReport(summary, outputDir);
    expect(first.latestJsonPath).toBe(join(outputDir, "latest.json"));
    expect(first.latestMarkdownPath).toBe(join(outputDir, "latest.md"));
    expect(first.runJsonPath).toMatch(/runs\/2026-05-19T01-02-03.004Z\.json$/);
    expect(second.runJsonPath).toMatch(/runs\/2026-05-19T01-02-03.004Z-2\.json$/);
    expect(await readFile(first.latestMarkdownPath, "utf8")).toContain("Workflow Jitter Matrix");
    expect(await readFile(first.latestMarkdownPath, "utf8")).toContain("Source revision: abc123");
    expect(await readFile(first.runMarkdownPath, "utf8")).toContain("Workflow IR path jitter");

    const latest = JSON.parse(await readFile(first.latestJsonPath, "utf8"));
    expect(latest).toMatchObject({ passedCount: 1, profile: "phase8-smoke", sourceRevision: { gitHead: "abc123", dirty: false } });
    const historyRows = (await readFile(first.historyPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(historyRows).toHaveLength(2);
    expect(historyRows[0]).toMatchObject({ taskCount: 1, passedCount: 1, runId: "2026-05-19T01-02-03.004Z", sourceRevision: { gitHead: "abc123", dirty: false } });
  });

  it("fingerprints product failures and writes promotion candidate artifacts with recurrence counts", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "workflow-jitter-matrix-"));
    const failedTask = {
      id: "ui-dogfood-public-source-browser",
      label: "Public source browser workflow UI dogfood",
      axis: "ui_state",
      tier: "live",
      command: "node",
      args: ["scripts/workflow-agent-thread-ui-dogfood.mjs", "--scenario=public-source-browser"],
      envKeys: ["AMBIENT_PROVIDER", "GMI_CLOUD_API_KEY_FILE"],
      status: "product_or_test_failure",
      providerHealth: "unknown",
      reason: "Expected graph node source mapping to exist at /Users/example/tmp/run-123 after 42142ms.",
      totalWallClockMs: 42142,
      attempts: [
        {
          attempt: 1,
          status: "product_or_test_failure",
          classification: { status: "product_or_test_failure" },
          exitCode: 1,
          durationMs: 42142,
          stdoutChars: 12,
          stderrChars: 44,
          logPath: join(outputDir, "logs", "failure.log"),
        },
      ],
    };
    const summary = {
      schemaVersion: 1,
      generatedAt: "2026-05-19T02:00:00.000Z",
      runId: "promotion-run",
      sourceRevision: { gitHead: "abc123", dirty: false },
      profile: "phase8-smoke",
      totalWallClockMs: 42142,
      concurrency: 1,
      retryLimit: 0,
      taskCount: 1,
      deterministicCount: 0,
      liveCount: 1,
      passedCount: 0,
      providerDegradedCount: 0,
      environmentSkippedCount: 0,
      productOrTestFailureCount: 1,
      tasks: [failedTask],
    };

    const firstCandidate = buildWorkflowJitterMatrixPromotionCandidates(summary)[0];
    const equivalentPathVariant = buildWorkflowJitterMatrixPromotionCandidates({
      ...summary,
      tasks: [{ ...failedTask, reason: "Expected graph node source mapping to exist at /tmp/other-run after 99999ms." }],
    })[0];
    expect(firstCandidate.fingerprint).toBe(equivalentPathVariant.fingerprint);
    expect(firstCandidate).toMatchObject({
      priority: "watch",
      suggestedFixture: "src/renderer/src/workflowJitterRegression.ui_dogfood_public_source_browser.test.ts",
      replay: expect.objectContaining({
        sourceRevision: { gitHead: "abc123", dirty: false },
        matrixCommand: expect.stringContaining("node scripts/workflow-jitter-matrix.mjs --task=ui-dogfood-public-source-browser --retries=0"),
        directCommand: "node scripts/workflow-agent-thread-ui-dogfood.mjs --scenario=public-source-browser",
        matrixReplay: {
          command: "node",
          args: expect.arrayContaining(["scripts/workflow-jitter-matrix.mjs", "--task=ui-dogfood-public-source-browser", "--retries=0"]),
          cwd: ".",
          taskIds: ["ui-dogfood-public-source-browser"],
          retries: 0,
          outputDir: expect.stringContaining("test-results/workflow-jitter-matrix/replay/ui-dogfood-public-source-browser"),
        },
        directReplay: {
          command: "node",
          args: ["scripts/workflow-agent-thread-ui-dogfood.mjs", "--scenario=public-source-browser"],
          cwd: ".",
        },
        envKeys: ["AMBIENT_PROVIDER", "GMI_CLOUD_API_KEY_FILE"],
        scenario: "public-source-browser",
      }),
    });
    expect(firstCandidate.replay.matrixCommand).toContain(firstCandidate.id);

    const first = await writeWorkflowJitterMatrixReport(summary, outputDir);
    expect(first.promotionCandidatePaths).toHaveLength(1);
    const promotionMarkdown = await readFile(first.promotionCandidatePaths[0], "utf8");
    expect(promotionMarkdown).toContain("Workflow Jitter Matrix Promotion Candidate");
    expect(promotionMarkdown).toContain("## Replay");
    expect(promotionMarkdown).toContain("Matrix replay:");
    const promotionJson = JSON.parse(await readFile(first.promotionCandidatePaths[0].replace(/\.md$/, ".json"), "utf8"));
    expect(promotionJson.candidate.replay).toMatchObject({
      taskId: "ui-dogfood-public-source-browser",
      sourceRevision: { gitHead: "abc123", dirty: false },
      scenario: "public-source-browser",
    });

    const second = await writeWorkflowJitterMatrixReport({ ...summary, runId: "promotion-run-2" }, outputDir);
    const latest = JSON.parse(await readFile(second.latestJsonPath, "utf8"));
    expect(latest.promotionCandidates[0]).toMatchObject({
      recurrenceCount: 2,
      priority: "promote",
      nextAction: "Promote this recurring live/product failure into a deterministic regression before closing Phase 8.",
    });
    const fingerprintRows = (await readFile(second.fingerprintHistoryPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(fingerprintRows).toHaveLength(2);
    expect(fingerprintRows[0].fingerprint).toBe(fingerprintRows[1].fingerprint);
  });

  it("keeps live rows advisory unless require-live or promotion gate is set", () => {
    const summary = {
      taskCount: 1,
      passedCount: 0,
      providerDegradedCount: 1,
      environmentSkippedCount: 0,
      productOrTestFailureCount: 0,
      tasks: [{ tier: "live", status: "provider_degraded" }],
    };
    expect(workflowJitterMatrixExitCode(summary)).toBe(0);
    expect(workflowJitterMatrixExitCode(summary, { requireLive: true })).toBe(1);
    expect(workflowJitterMatrixExitCode(summary, { promotionGate: true })).toBe(1);
    expect(renderWorkflowJitterMatrixMarkdown({ ...summary, generatedAt: "now", runId: "run", profile: "phase8", concurrency: 1, retryLimit: 0 })).toContain(
      "Provider-degraded/inconclusive: 1",
    );
  });

  it("preflights credentialed workflow UI dogfood snapshots before spawning doomed live rows", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "workflow-jitter-snapshot-"));
    try {
      const missingRoot = join(tempRoot, "missing-snapshot");
      const { summary } = await runWorkflowJitterMatrix({
        generatedAt: "2026-05-19T03:00:00.000Z",
        runId: "missing-snapshot",
        sourceRevision: { gitHead: "abc123", dirty: false },
        outputDir: false,
        tasks: [
          {
            id: "ui-dogfood-gmail-20-metadata-readonly-validation",
            label: "Gmail metadata read-only validation workflow UI dogfood",
            axis: "ui_state",
            tier: "live",
            command: process.execPath,
            args: ["scripts/workflow-agent-thread-ui-dogfood.mjs", "--scenario=gmail-20-metadata-readonly-validation"],
            env: {
              AMBIENT_WORKFLOW_UI_DOGFOOD_USE_SHARED_SNAPSHOT: "1",
              AMBIENT_WORKFLOW_UI_DOGFOOD_SNAPSHOT_ROOT: missingRoot,
            },
            liveDogfoodRunUnits: 1,
            liveFamily: "connector",
          },
        ],
        runCommand: async () => {
          throw new Error("snapshot preflight should skip before spawning the task");
        },
      });

      expect(summary).toMatchObject({
        taskCount: 1,
        passedCount: 0,
        environmentSkippedCount: 1,
        productOrTestFailureCount: 0,
      });
      expect(summary.tasks[0]).toMatchObject({
        status: "environment_skipped",
        matchedPattern: "credentialed_snapshot_missing",
        attempts: [],
        environmentBlocker: {
          kind: "credentialed_snapshot_missing",
          preflight: {
            status: "missing",
            selectedRootSource: "env:AMBIENT_WORKFLOW_UI_DOGFOOD_SNAPSHOT_ROOT",
            snapshotRootLabel: "missing-snapshot",
          },
        },
      });
      expect(summary.environmentBlockers).toEqual([
        expect.objectContaining({
          kind: "credentialed_snapshot_missing",
          affectedTaskCount: 1,
          taskIds: ["ui-dogfood-gmail-20-metadata-readonly-validation"],
        }),
      ]);
      expect(workflowJitterMatrixExitCode(summary, { requireLive: true })).toBe(1);
      expect(JSON.stringify(summary)).not.toContain(missingRoot);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
