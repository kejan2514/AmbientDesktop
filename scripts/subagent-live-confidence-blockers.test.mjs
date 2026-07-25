import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSubagentLiveConfidenceEvidence,
  buildSubagentLiveConfidencePlan,
  renderSubagentLiveConfidenceMarkdown,
  runBoundedCommand,
  runSubagentLiveConfidence,
} from "./subagent-live-confidence-lib.mjs";
import {
  callableWorkflowDogfoodArtifact,
  callableWorkflowRehydrationArtifact,
  liveSmokeArtifact,
  liveWorkflowArtifact,
  waitForPidFile,
  waitForProcessExit,
  workflowUiBroaderDogfoodMatrixArtifact,
} from "./subagent-live-confidence-test-fixtures.mjs";

describe("sub-agent live confidence blockers and reports", () => {
  it("classifies missing GMI credentials as an environmental blocker without secret leakage", () => {
    const evidence = buildSubagentLiveConfidenceEvidence({
      plan: buildSubagentLiveConfidencePlan({
        command: {
          executable: "pnpm",
          args: ["run", "test:subagents:live"],
          display: "GMI_CLOUD_API_KEY_FILE=/secret/path pnpm run test:subagents:live",
        },
      }),
      startedAt: "2026-06-10T23:00:00.000Z",
      completedAt: "2026-06-10T23:01:00.000Z",
      commandResult: {
        exitCode: 1,
        stdout: "",
        stderr:
          "Set GMI_CLOUD_API_KEY, GMI_API_KEY, GMI_CLOUD_API_KEY_FILE, or provide ignored-provider-key-file.txt for sub-agent Pi tool live smoke.",
      },
      liveSmokeArtifact: undefined,
    });

    expect(evidence.status).toBe("blocked");
    expect(evidence.closeoutAnswer.kind).toBe("blocked");
    expect(evidence.classifiedBlockers).toEqual([
      expect.objectContaining({
        kind: "credential_missing",
        classifiedAsEnvironmental: true,
      }),
    ]);
    expect(JSON.stringify(evidence)).not.toContain("/secret/path");
  });

  it("classifies timeouts as retryable live environmental blockers", () => {
    const evidence = buildSubagentLiveConfidenceEvidence({
      plan: buildSubagentLiveConfidencePlan(),
      startedAt: "2026-06-10T23:00:00.000Z",
      completedAt: "2026-06-10T23:10:00.000Z",
      commandResult: { exitCode: 1, timedOut: true, stdout: "partial", stderr: "" },
      liveSmokeArtifact: liveSmokeArtifact(),
    });

    expect(evidence.status).toBe("blocked");
    expect(evidence.classifiedBlockers).toEqual([
      expect.objectContaining({
        kind: "network",
        summary: expect.stringContaining("exceeded the configured timeout"),
      }),
    ]);
    expect(renderSubagentLiveConfidenceMarkdown(evidence)).toContain("network:");
  });

  it("classifies interrupted live runs as harness blockers", () => {
    const evidence = buildSubagentLiveConfidenceEvidence({
      plan: buildSubagentLiveConfidencePlan({ sliceKind: "workflow_symphony" }),
      startedAt: "2026-06-10T23:00:00.000Z",
      completedAt: "2026-06-10T23:01:00.000Z",
      commandResult: {
        exitCode: 1,
        interrupted: true,
        interruptSignal: "SIGTERM",
        stdout: "partial live output",
        stderr: "",
      },
      liveWorkflowArtifact: liveWorkflowArtifact(),
    });

    expect(evidence.status).toBe("blocked");
    expect(evidence.classifiedBlockers).toEqual([
      expect.objectContaining({
        kind: "harness_interrupted",
        summary: expect.stringContaining("SIGTERM"),
        classifiedAsEnvironmental: true,
      }),
    ]);
    expect(renderSubagentLiveConfidenceMarkdown(evidence)).toContain("harness_interrupted:");
  });

  it("cleans up a spawned process tree when the live runner is aborted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "subagent-live-abort-"));
    const pidPath = join(dir, "pids.txt");
    const controller = new AbortController();
    const script = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      `const pidPath = ${JSON.stringify(pidPath)};`,
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "fs.writeFileSync(pidPath, `${process.pid}\\n${child.pid}\\n`);",
      "setInterval(() => {}, 1000);",
    ].join(" ");

    const run = runBoundedCommand(
      {
        executable: process.execPath,
        args: ["-e", script],
        display: "node nested live-confidence abort fixture",
      },
      {
        timeoutMs: 30_000,
        abortSignal: controller.signal,
      },
    );
    const [parentPid, childPid] = await waitForPidFile(pidPath);

    controller.abort({ signal: "SIGINT" });
    const result = await run;

    expect(result).toMatchObject({
      exitCode: 1,
      timedOut: false,
      interrupted: true,
      interruptSignal: "SIGINT",
    });
    await waitForProcessExit(parentPid);
    await waitForProcessExit(childPid);
  });

  it("classifies missing worktree dependencies as an environmental blocker", () => {
    const evidence = buildSubagentLiveConfidenceEvidence({
      plan: buildSubagentLiveConfidencePlan({ sliceKind: "local_runtime" }),
      startedAt: "2026-06-10T23:00:00.000Z",
      completedAt: "2026-06-10T23:01:00.000Z",
      commandResult: {
        exitCode: 254,
        stdout: [
          'ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "vitest" not found',
          "Local package.json exists, but node_modules missing, did you mean to install?",
        ].join("\n"),
        stderr: "",
      },
      liveLocalRuntimeArtifact: undefined,
      liveLocalRuntimeGateArtifact: undefined,
    });

    expect(evidence.status).toBe("blocked");
    expect(evidence.closeoutAnswer).toMatchObject({
      kind: "blocked",
      summary: expect.stringContaining("missing local package dependencies"),
    });
    expect(evidence.classifiedBlockers).toEqual([
      expect.objectContaining({
        kind: "dependency_missing",
        classifiedAsEnvironmental: true,
        nextStep: expect.stringContaining("pnpm install --frozen-lockfile"),
      }),
    ]);
    expect(evidence.productIssues).toEqual([]);
    expect(renderSubagentLiveConfidenceMarkdown(evidence)).toContain("dependency_missing:");
  });

  it("classifies native rebuild collisions as environmental instead of product failures", () => {
    const evidence = buildSubagentLiveConfidenceEvidence({
      plan: buildSubagentLiveConfidencePlan({ sliceKind: "desktop_dogfood" }),
      startedAt: "2026-06-10T23:00:00.000Z",
      completedAt: "2026-06-10T23:01:00.000Z",
      commandResult: {
        exitCode: 1,
        stdout: "",
        stderr: "gyp ERR! ENOENT: no such file or directory, lstat '/repo/node_modules/.pnpm/better-sqlite3/build/node_gyp_bins'",
      },
    });

    expect(evidence.status).toBe("blocked");
    expect(evidence.classifiedBlockers).toEqual([
      expect.objectContaining({
        kind: "native_rebuild_collision",
        classifiedAsEnvironmental: true,
      }),
    ]);
    expect(evidence.productIssues).toEqual([]);
    expect(renderSubagentLiveConfidenceMarkdown(evidence)).toContain("native_rebuild_collision:");
  });

  it("classifies missing first-party workflow connector snapshots as environmental blockers", () => {
    const evidence = buildSubagentLiveConfidenceEvidence({
      plan: buildSubagentLiveConfidencePlan({ sliceKind: "workflow_symphony_broader" }),
      startedAt: "2026-06-10T23:00:00.000Z",
      completedAt: "2026-06-10T23:03:00.000Z",
      commandResult: {
        exitCode: 1,
        stdout:
          "Workflow Agent UI dogfood classification: environment/snapshot issue\nSnapshot copy requested, but the snapshot root did not contain userData/workspace directories.",
        stderr:
          "Workflow connector is not available: Gmail (google.gmail) is not_configured; Google Drive (google.drive) is not_configured. Connect the requested account or launch with a credentialed snapshot before compiling this workflow.",
      },
      liveWorkflowArtifact: liveWorkflowArtifact(),
      liveWorkflowUiDogfoodArtifact: {
        ...workflowUiBroaderDogfoodMatrixArtifact(),
        ok: false,
        results: [],
        failure: {
          scenario: "gmail-20-metadata-readonly-validation",
          classification: "environment/snapshot issue",
        },
      },
      liveCallableWorkflowDogfoodArtifact: callableWorkflowDogfoodArtifact(),
      liveCallableWorkflowRehydrationArtifact: callableWorkflowRehydrationArtifact(),
    });

    expect(evidence.status).toBe("blocked");
    expect(evidence.classifiedBlockers).toEqual([
      expect.objectContaining({
        kind: "credentialed_snapshot_missing",
        classifiedAsEnvironmental: true,
        nextStep: expect.stringContaining("credentialed Ambient snapshot"),
      }),
    ]);
    expect(evidence.capabilitiesObserved).toEqual(
      expect.arrayContaining([
        "workflow_launch",
        "ambient_runtime_call",
        "artifact_link",
        "checkpoint_output",
        "mutating_child_workflow",
        "child_scoped_approval",
        "isolated_child_worktree",
        "parent_blocking_workflow",
        "denied_workflow_scope",
        "workflow_task_rehydration",
        "child_workflow_provenance",
      ]),
    );
    expect(evidence.capabilitiesObserved).not.toContain("workflow_agent_ui_dogfood");
    expect(evidence.capabilitiesObserved).not.toContain("phase1_workflow_ui_dogfood");
    expect(evidence.productIssues).toEqual([]);
    expect(renderSubagentLiveConfidenceMarkdown(evidence)).toContain("credentialed_snapshot_missing:");
  });

  it("classifies non-environmental failures as product issues", () => {
    const evidence = buildSubagentLiveConfidenceEvidence({
      plan: buildSubagentLiveConfidencePlan(),
      startedAt: "2026-06-10T23:00:00.000Z",
      completedAt: "2026-06-10T23:01:00.000Z",
      commandResult: { exitCode: 1, stdout: "assertion failed", stderr: "" },
      liveSmokeArtifact: { ...liveSmokeArtifact(), childAssistantText: "missing sentinel" },
    });

    expect(evidence.status).toBe("failed");
    expect(evidence.productIssues).toEqual([
      expect.objectContaining({
        severity: "p1",
        owner: "subagents",
      }),
    ]);
  });

  it("writes JSON, Markdown, and sanitized command output artifacts", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "subagent-live-confidence-"));
    const outputPath = join(outputDir, "latest.json");
    const report = await runSubagentLiveConfidence({
      outputPath,
      startedAt: "2026-06-10T23:00:00.000Z",
      completedAt: "2026-06-10T23:01:00.000Z",
      liveSmokeArtifact: liveSmokeArtifact(),
      runCommand: async () => ({
        exitCode: 0,
        stdout: "GMI_CLOUD_API_KEY=sk-test-secret",
        stderr: "",
      }),
    });

    expect(report.status).toBe("passed");
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({ status: "passed" });
    expect(await readFile(outputPath.replace(/\.json$/i, ".md"), "utf8")).toContain("Sub-Agent Live Confidence");
    expect(await readFile(outputPath.replace(/\.json$/i, ".md"), "utf8")).toContain("## Hypothesis");
    expect(await readFile(outputPath.replace(/\.json$/i, ".md"), "utf8")).toContain("Closeout: saw_live");
    expect(await readFile(outputPath.replace(/\.json$/i, ".stdout.txt"), "utf8")).toContain("GMI_CLOUD_API_KEY=<redacted>");
  });
});
