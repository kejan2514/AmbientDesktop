import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  assertWorkflowUiDogfoodEvidence,
  workflowUiDogfoodLaunchEnvironment,
  workflowUiDogfoodSelectedSnapshotRoot,
  workflowUiDogfoodSnapshotPreflight,
  workflowUiDogfoodSnapshotPreflightErrorMessage,
} from "./workflow-ui-dogfood-contract.mjs";
import { workflowDiscoveryProgress, workflowThreadFromFolders } from "./workflow-agent-thread-ui-dogfood-lib.mjs";

const execFileAsync = promisify(execFile);
const workflowUiDogfoodSourcePaths = [
  "./workflow-agent-thread-ui-dogfood.mjs",
  "./workflow-agent-thread-ui-local-scenarios.mjs",
  "./workflow-agent-thread-ui-connector-scenarios.mjs",
  "./workflow-agent-thread-ui-public-scenarios.mjs",
];

describe("Workflow Agent V3 UI dogfood harness", () => {
  it("stays syntactically valid as a standalone Electron harness", async () => {
    await Promise.all(
      workflowUiDogfoodSourcePaths.map((sourcePath) =>
        expect(execFileAsync(process.execPath, ["--check", new URL(sourcePath, import.meta.url).pathname])).resolves.toBeTruthy(),
      ),
    );
    await expect(
      execFileAsync(process.execPath, ["--check", new URL("./workflow-agent-thread-ui-dogfood-matrix.mjs", import.meta.url).pathname]),
    ).resolves.toBeTruthy();
  });

  it("covers the live narrow-split Workflow Agent lifecycle", async () => {
    const source = await readWorkflowUiDogfoodSourceSurface();
    const matrixSource = await readFile(new URL("./workflow-agent-thread-ui-dogfood-matrix.mjs", import.meta.url), "utf8");
    const contractSource = await readFile(new URL("./workflow-ui-dogfood-contract.mjs", import.meta.url), "utf8");

    expect(source).toContain("workflowUiDogfoodLaunchEnvironment");
    expect(source).toContain("workflowUiDogfoodCredentialStatus");
    expect(contractSource).toContain("AMBIENT_PROVIDER");
    expect(source).toContain("gmi-cloud");
    expect(source).toContain("GMI Cloud API key is missing");
    expect(contractSource).toContain("AMBIENT_WORKFLOW_UI_DOGFOOD_USE_SHARED_SNAPSHOT");
    expect(source).toContain("shared-snapshot-temp-copy");
    expect(source).toContain("workspace-archive-temp-copy");
    expect(source).toContain("workflowUiDogfoodSnapshotPreflight");
    expect(contractSource).toContain("workflowUiDogfoodLooksLikeWorkspaceArchive");
    expect(source).toContain("startWorkflowDiscovery");
    expect(source).toContain("answerWorkflowDiscoveryQuestion");
    expect(source).toContain("compileWorkflowPreview");
    expect(source).toContain("reviewWorkflowArtifact");
    expect(source).toContain("runWorkflowArtifact");
    expect(source).toContain("createAutomationSchedule");
    expect(source).toContain("workflow.input.required");
    expect(source).toContain("workflow.input.received");
    expect(source).toContain("resumeRuntimePauses");
    expect(source).toContain("exerciseGraphRecovery");
    expect(source).toContain("recoverWorkflowRun");
    expect(source).toContain("assertGraphRecoveryUiVisible");
    expect(source).toContain("requiredVisibleTerms");
    expect(source).toContain("selectRecoveryEvent");
    expect(source).toContain("ensureScenarioPermissionMode");
    expect(source).toContain("ensureWorkflowThreadPermissionMode");
    expect(source).toContain("ensureWorkflowAgentChatThread");
    expect(source).toContain("AMBIENT_WORKFLOW_UI_DOGFOOD_PERMISSION_MODE");
    expect(source).toContain("scenarioPermissionMode");
    expect(source).toContain("requestThreadPermissionModeChange");
    expect(source).toContain('startsWith("workflow.recovery.")');
    expect(source).toContain("resolveWorkflowApproval");
    expect(source).toContain("latestPendingApproval");
    expect(source).toContain("runLimitsForScenario");
    expect(source).not.toContain("maxRunMs: null");
    expect(source).toContain('scenario.recovery ? "graph recovery" : "runtime input resume"');
    expect(source).toContain("runtimeChoicePreference");
    expect(source).toContain("chooseRuntimeInputChoice");
    expect(source).toContain("looks good");
    expect(source).toContain("proceed");
    expect(source).toContain("answerText");
    expect(source).toContain("assertScenarioEvidence");
    expect(source).toContain("assertScenarioSource");
    expect(source).toContain("assertScenarioAbstractionContract");
    expect(source).toContain("sourceExpect");
    expect(source).toContain("abstractionContract");
    expect(source).toContain("forbiddenPromptAssemblyMetadataFragments");
    expect(source).toContain("promptAssemblyMetadataText");
    expect(matrixSource).toContain('"vocabulary-quiz", "public-source-browser", "local-file-classifier"');
    expect(matrixSource).toContain("AMBIENT_WORKFLOW_UI_DOGFOOD_PERMISSION_MODE");
    expect(matrixSource).toContain("compactPromptAssembly");
    expect(matrixSource).toContain("compactCompileContext");
    expect(matrixSource).toContain("compactValidationReport");
    expect(matrixSource).toContain("compactAbstractionContract");
    expect(matrixSource).toContain("compactHarness");
    expect(matrixSource).toContain("compactLaunchSummary");
    expect(matrixSource).toContain("workspaceMode");
    expect(matrixSource).toContain("googleWorkspace");
    expect(matrixSource).toContain("workflowUiDogfoodSnapshotPreflight");
    expect(matrixSource).toContain("safeFilePart(suiteArg)");
    expect(matrixSource).toContain("-matrix-latest.json");
    expect(source).toContain("minFinalOutputChars");
    expect(source).toContain("requiredFinalOutputAnyTerms");
    expect(source).toContain("desktopToolEndMessages");
    expect(source).toContain("AMBIENT_WORKFLOW_UI_DOGFOOD_MAX_RUN_EVENTS");
    expect(source).toContain('captureMode(cdp, "Build"');
    expect(source).toContain('captureMode(cdp, "Runs"');
    expect(source).toContain('captureMode(cdp, "Schedules"');
    expect(source).toContain("--workflow-split-primary");
    expect(source).toContain("visibleChars > 120_000");
    expect(source).toContain("collectFailureEvidence");
    expect(source).toContain("classifyDogfoodFailure");
    expect(source).toContain("environment/snapshot issue");
    expect(source).toContain("ensureWorkflowAgentsShell");
    expect(source).toContain("AMBIENT_WORKFLOW_UI_DOGFOOD_PROVIDER_IDLE_RETRIES");
    expect(source).toContain("AMBIENT_WORKFLOW_UI_DOGFOOD_PROVIDER_IDLE_RETRY_BASE_MS");
    expect(source).toContain("isProviderIdleStartError");
    expect(source).toContain("\\b429\\b");
    expect(source).toContain("retrying after provider idle/no-stream failure in");
    expect(source).toContain("startRendererOperation");
    expect(source).toContain("waitForRendererOperation");
    expect(source).toContain("latestWorkflowThreadFromUi");
    expect(source).toContain("requireDiscoveryReadyForCompile");
    expect(source).toContain("workflowDiscoveryProgress");
    expect(source).toContain("discovery answer round");
    expect(source).toContain("options.timeoutMs ?? 120_000");
    expect(source).toContain("{ timeoutMs: 60_000 }");
    expect(source).toContain("renderer poll did not respond");
    expect(source).toContain("continuing until overall timeout");
    expect(source).toContain("__ambientWorkflowDogfoodOps");
    expect(source).toContain("recoverExpression");
    expect(source).toContain("persisted workflow preview artifact");
    expect(source).toContain("[dogfood] ${label}${attemptSuffix} started");
    expect(source).toContain("900_000");
    expect(source).toContain('"test-results"');
    expect(source).toContain('"workflow-agent-thread-ui-dogfood"');
    expect(source).toContain("scenarioReportRoot");
    expect(source).toContain("harnessName");
    expect(source).toContain("harnessRunId");
    expect(source).toContain("harnessReportRoot");
    expect(source).toContain("harnessReportMetadata");
    expect(source).toContain("AMBIENT_WORKFLOW_UI_DOGFOOD_HARNESS_ID");
    expect(source).toContain("pathsAreMachineLocal");
  });

  it("refreshes workflow discovery progress from canonical folder state", () => {
    const staleThread = {
      id: "workflow-thread-1",
      discoveryQuestions: [
        { id: "scope", answer: { choiceId: "single" } },
        { id: "data", answer: { choiceId: "model-only" } },
        { id: "role", answer: { choiceId: "ambient" } },
      ],
    };
    const latestThread = {
      id: "workflow-thread-1",
      discoveryQuestions: [
        ...staleThread.discoveryQuestions,
        { id: "side-effects" },
        { id: "error-handling", accessRequests: [{ id: "grant-1", status: "pending" }] },
      ],
    };

    expect(workflowThreadFromFolders([{ id: "home", threads: [latestThread] }], staleThread.id)).toBe(latestThread);
    expect(workflowDiscoveryProgress(latestThread)).toEqual({
      questions: 5,
      answered: 3,
      unanswered: 2,
      pendingAccessRequests: 1,
    });
  });

  it("defaults live UI dogfood launches to GMI Cloud without reading or embedding secret values", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "workflow-ui-contract-"));
    try {
      await writeFile(join(tempRoot, "ignored-provider-key-file.txt"), "secret-value-that-must-not-appear\n", "utf8");
      const launch = workflowUiDogfoodLaunchEnvironment({
        env: {},
        cwd: tempRoot,
        workspace: "/tmp/workflow-ui-workspace",
        userData: "/tmp/workflow-ui-user-data",
        snapshotMode: "fresh-temp",
      });

      expect(launch).toMatchObject({
        providerId: "gmi-cloud",
        credentialConfigured: true,
        launchSummary: {
          providerId: "gmi-cloud",
          providerLabel: "GMI Cloud",
          workspaceMode: "fresh-temp",
          credentialConfigured: true,
        },
      });
      expect(launch.env).toMatchObject({
        AMBIENT_PROVIDER: "gmi-cloud",
        AMBIENT_DESKTOP_WORKSPACE: "/tmp/workflow-ui-workspace",
        AMBIENT_E2E_USER_DATA: "/tmp/workflow-ui-user-data",
        GMI_CLOUD_API_KEY_FILE: join(tempRoot, "ignored-provider-key-file.txt"),
      });
      expect(JSON.stringify(launch.launchSummary)).not.toContain("secret-value-that-must-not-appear");
      expect(JSON.stringify(launch.env)).not.toContain("secret-value-that-must-not-appear");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("wires validated GWS snapshots into Desktop launches without mutating source credentials", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "workflow-ui-gws-contract-"));
    try {
      const userData = join(tempRoot, "user-data");
      const userDataConfigRoot = join(userData, "google-workspace-cli");
      const gwsSnapshotRoot = join(tempRoot, "gws-snapshots");
      const snapshot = join(gwsSnapshotRoot, "primary-mac-gws-validated-test");
      const snapshotBinary = join(
        snapshot,
        "userData",
        "tools",
        "google-workspace-cli",
        "v0.22.3",
        `${process.platform}-${process.arch}`,
        "gws",
      );
      const snapshotConfigRoot = join(snapshot, "userData", "google-workspace-cli");
      await mkdir(userDataConfigRoot, { recursive: true });
      await mkdir(join(snapshotBinary, ".."), { recursive: true });
      await mkdir(snapshotConfigRoot, { recursive: true });
      await writeFile(join(userDataConfigRoot, "accounts.json"), '{"accounts":[{"accountId":"default"}]}\n', "utf8");
      await writeFile(snapshotBinary, "#!/bin/sh\n", "utf8");

      const launch = workflowUiDogfoodLaunchEnvironment({
        env: {},
        cwd: tempRoot,
        workspace: "/tmp/workflow-ui-workspace",
        userData,
        snapshotMode: "shared-snapshot-temp-copy",
        gwsSnapshotRoot,
      });

      expect(launch.env).toMatchObject({
        AMBIENT_GWS_CLI_PATH: snapshotBinary,
        AMBIENT_GWS_CONFIG_ROOT: userDataConfigRoot,
      });
      expect(launch.launchSummary.googleWorkspace).toMatchObject({
        status: "configured",
        binarySource: "gws-hardening-snapshot",
        configSource: "user-data-config",
        binaryConfigured: true,
        configConfigured: true,
      });
      expect(JSON.stringify(launch.launchSummary)).not.toContain("accounts");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses the managed Ambient Desktop GWS binary when the copied snapshot only contains config", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "workflow-ui-gws-managed-binary-"));
    try {
      const homeDir = join(tempRoot, "home");
      const userData = join(tempRoot, "user-data");
      const userDataConfigRoot = join(userData, "google-workspace-cli");
      const managedBinary = join(
        homeDir,
        "Library",
        "Application Support",
        "Ambient Desktop",
        "tools",
        "google-workspace-cli",
        "v0.22.3",
        `${process.platform}-${process.arch}`,
        "gws",
      );
      await mkdir(userDataConfigRoot, { recursive: true });
      await mkdir(join(managedBinary, ".."), { recursive: true });
      await writeFile(join(userDataConfigRoot, "accounts.json"), '{"accounts":[{"accountId":"default"}]}\n', "utf8");
      await writeFile(managedBinary, "#!/bin/sh\n", "utf8");

      const launch = workflowUiDogfoodLaunchEnvironment({
        env: {},
        cwd: tempRoot,
        workspace: "/tmp/workflow-ui-workspace",
        userData,
        snapshotMode: "shared-snapshot-temp-copy",
        homeDir,
      });

      expect(launch.env).toMatchObject({
        AMBIENT_GWS_CLI_PATH: managedBinary,
        AMBIENT_GWS_CONFIG_ROOT: userDataConfigRoot,
      });
      expect(launch.launchSummary.googleWorkspace).toMatchObject({
        status: "configured",
        binarySource: "ambient-desktop-managed-binary",
        configSource: "user-data-config",
      });
      expect(JSON.stringify(launch.launchSummary)).not.toContain("accounts");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("preflights shared snapshot copies without exposing credential contents", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "workflow-ui-snapshot-preflight-"));
    try {
      const missingRoot = join(tempRoot, "missing-snapshot");
      const missing = workflowUiDogfoodSnapshotPreflight({
        env: {
          AMBIENT_WORKFLOW_UI_DOGFOOD_USE_SHARED_SNAPSHOT: "1",
          AMBIENT_WORKFLOW_UI_DOGFOOD_SNAPSHOT_ROOT: missingRoot,
        },
      });
      expect(missing).toMatchObject({
        ok: false,
        requested: true,
        status: "missing",
        snapshotRootLabel: "missing-snapshot",
        checks: {
          rootExists: false,
          workspaceDirectory: false,
          userDataDirectory: false,
          workspaceArchiveShape: false,
        },
      });
      expect(workflowUiDogfoodSnapshotPreflightErrorMessage(missing)).toContain("Snapshot copy requested");
      expect(JSON.stringify(missing)).not.toContain(missingRoot);

      const sharedRoot = join(tempRoot, "primary-shared-snapshot");
      await mkdir(join(sharedRoot, "workspace"), { recursive: true });
      await mkdir(join(sharedRoot, "userData"), { recursive: true });
      await writeFile(join(sharedRoot, "userData", "secret-marker.txt"), "secret-value-that-must-not-appear\n", "utf8");

      const ready = workflowUiDogfoodSnapshotPreflight({
        env: { AMBIENT_WORKFLOW_UI_DOGFOOD_SNAPSHOT_ROOT: sharedRoot },
      });
      expect(ready).toMatchObject({
        ok: true,
        requested: true,
        status: "ready",
        snapshotMode: "shared-snapshot-temp-copy",
        snapshotRootLabel: "primary-shared-snapshot",
        selectedRootSource: "env:AMBIENT_WORKFLOW_UI_DOGFOOD_SNAPSHOT_ROOT",
        checks: {
          rootExists: true,
          workspaceDirectory: true,
          userDataDirectory: true,
          workspaceArchiveShape: false,
        },
      });
      expect(ready.snapshotRootPathDigest).toMatch(/^[a-f0-9]{12}$/);
      expect(ready.candidateRoots).toEqual([
        expect.objectContaining({
          source: "env:AMBIENT_WORKFLOW_UI_DOGFOOD_SNAPSHOT_ROOT",
          label: "primary-shared-snapshot",
          pathDigest: expect.stringMatching(/^[a-f0-9]{12}$/),
          snapshotMode: "shared-snapshot-temp-copy",
        }),
      ]);
      expect(JSON.stringify(ready)).not.toContain(sharedRoot);
      expect(JSON.stringify(ready)).not.toContain("secret-value-that-must-not-appear");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("accepts shared snapshot root aliases and keeps the selected runtime root internal", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "workflow-ui-snapshot-alias-"));
    try {
      const sharedRoot = join(tempRoot, "alias-shared-snapshot");
      await mkdir(join(sharedRoot, "workspace"), { recursive: true });
      await mkdir(join(sharedRoot, "userData"), { recursive: true });

      const env = { AMBIENT_SHARED_SECRETS_SNAPSHOT_ROOT: sharedRoot };
      const ready = workflowUiDogfoodSnapshotPreflight({ env });

      expect(ready).toMatchObject({
        ok: true,
        requested: true,
        status: "ready",
        selectedRootSource: "env:AMBIENT_SHARED_SECRETS_SNAPSHOT_ROOT",
        snapshotRootLabel: "alias-shared-snapshot",
      });
      expect(workflowUiDogfoodSelectedSnapshotRoot({ env })).toBe(sharedRoot);
      expect(JSON.stringify(ready)).not.toContain(sharedRoot);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("discovers bounded home shared snapshots when snapshot mode is requested", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "workflow-ui-snapshot-home-"));
    try {
      const homeDir = join(tempRoot, "home");
      const sharedSecretsRoot = join(homeDir, ".ambient-hardening", "snapshots", "shared-secrets");
      const staleRoot = join(sharedSecretsRoot, "2026-04-01-invalid");
      const readyRoot = join(sharedSecretsRoot, "2026-06-10-ready");
      await mkdir(staleRoot, { recursive: true });
      await mkdir(join(readyRoot, "workspace"), { recursive: true });
      await mkdir(join(readyRoot, "userData"), { recursive: true });
      await writeFile(join(readyRoot, "userData", "secret-marker.txt"), "do-not-print\n", "utf8");

      const env = { AMBIENT_WORKFLOW_UI_DOGFOOD_USE_SHARED_SNAPSHOT: "1" };
      const ready = workflowUiDogfoodSnapshotPreflight({ env, homeDir });

      expect(ready).toMatchObject({
        ok: true,
        requested: true,
        status: "ready",
        snapshotMode: "shared-snapshot-temp-copy",
        snapshotRootLabel: "2026-06-10-ready",
        selectedRootSource: "default:home-shared-secrets-directory",
      });
      expect(workflowUiDogfoodSelectedSnapshotRoot({ env, homeDir })).toBe(readyRoot);
      expect(ready.candidateRoots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "default:home-shared-secrets-directory",
            label: "2026-06-10-ready",
            snapshotMode: "shared-snapshot-temp-copy",
          }),
        ]),
      );
      expect(JSON.stringify(ready)).not.toContain(readyRoot);
      expect(JSON.stringify(ready)).not.toContain("do-not-print");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("writes suite-specific blocked matrix artifacts when credentialed snapshot preflight fails", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "workflow-ui-matrix-preflight-"));
    try {
      const scriptPath = new URL("./workflow-agent-thread-ui-dogfood-matrix.mjs", import.meta.url).pathname;
      let error;
      try {
        await execFileAsync(process.execPath, [scriptPath, "--suite=phase1-live"], {
          cwd: tempRoot,
          env: {
            ...process.env,
            AMBIENT_WORKFLOW_UI_DOGFOOD_USE_SHARED_SNAPSHOT: "1",
            AMBIENT_WORKFLOW_UI_DOGFOOD_SNAPSHOT_ROOT: join(tempRoot, "missing-snapshot"),
          },
        });
      } catch (caught) {
        error = caught;
      }

      expect(error?.code).toBe(1);
      expect(error?.stderr).toContain("Workflow Agent UI dogfood classification: environment/snapshot issue");

      const matrixPath = join(tempRoot, "test-results", "workflow-agent-thread-ui-dogfood", "matrix-latest.json");
      const suiteMatrixPath = join(tempRoot, "test-results", "workflow-agent-thread-ui-dogfood", "phase1-live-matrix-latest.json");
      const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
      const suiteMatrix = JSON.parse(await readFile(suiteMatrixPath, "utf8"));
      expect(suiteMatrix).toEqual(matrix);
      expect(matrix).toMatchObject({
        ok: false,
        blocked: true,
        classification: "environment/snapshot issue",
        suite: "phase1-live",
        scenarios: [
          "gmail-20-metadata-readonly-validation",
          "downloads-document-categorization",
          "public-source-browser",
          "current-web-recipe-report",
        ],
        results: [],
        preflight: {
          ok: false,
          requested: true,
          status: "missing",
          snapshotRootLabel: "missing-snapshot",
        },
        failure: {
          scenario: "gmail-20-metadata-readonly-validation",
          ok: false,
          exitCode: 1,
          classification: "environment/snapshot issue",
          runStatus: "not-started",
        },
      });
      expect(JSON.stringify(matrix)).not.toContain(join(tempRoot, "missing-snapshot"));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("requires inspectable final workflow output for UI dogfood product gates", () => {
    const baseDetail = {
      events: [workflowEvent({ type: "workflow.start" }), workflowEvent({ type: "ambient.call.end", message: "study-card" })],
      modelCalls: [{ status: "succeeded" }],
      checkpoints: [{ key: "draft", valuePreview: "short" }],
    };

    expect(() =>
      assertWorkflowUiDogfoodEvidence(baseDetail, {
        scenarioName: "missing-output",
        expectConfig: { minModelCalls: 1, minOutputSignals: 1 },
      }),
    ).toThrow(/workflow\.output\.ready/);

    const passed = assertWorkflowUiDogfoodEvidence(
      {
        ...baseDetail,
        events: [
          ...baseDetail.events,
          workflowEvent({
            type: "workflow.output.ready",
            message: "Final study card",
            data: {
              html: "<article><h1>Definition</h1><p>The meaning is precise.</p><p>Example sentence one.</p><p>Example sentence two.</p></article>",
            },
          }),
        ],
      },
      {
        scenarioName: "final-output",
        expectConfig: {
          minModelCalls: 1,
          minOutputSignals: 1,
          minFinalOutputChars: 80,
          requiredFinalOutputAnyTerms: [
            ["definition", "meaning"],
            ["example", "sentence"],
          ],
        },
      },
    );

    expect(passed).toMatchObject({
      passed: true,
      finalOutput: {
        signalCount: 1,
        formats: ["html"],
      },
    });
    expect(passed.finalOutput.charCount).toBeGreaterThanOrEqual(80);

    expect(() =>
      assertWorkflowUiDogfoodEvidence(
        {
          ...baseDetail,
          events: [
            ...baseDetail.events,
            workflowEvent({
              type: "workflow.output.ready",
              message: "Structured final output",
              data: {
                disclaimer: "metadata-only and read-only",
                themes: [{ name: "Status updates", count: 2 }],
                skippedCount: 0,
                partialNote: "",
                coverage: { totalRetrieved: 2, truncated: false },
              },
            }),
          ],
        },
        {
          scenarioName: "structured-final-output",
          expectConfig: {
            minModelCalls: 1,
            minOutputSignals: 1,
            requiredFinalOutputTerms: ["metadata-only", "read-only"],
            requiredFinalOutputAnyTerms: [["coverage"], ["skipped", "partial"]],
          },
        },
      ),
    ).not.toThrow();
  });

  it("keeps write-capable workflow tools explicit per scenario", () => {
    const detail = {
      events: [
        workflowEvent({ type: "workflow.start" }),
        workflowEvent({ type: "desktop-tool.end", message: "file_read" }),
        workflowEvent({ type: "desktop-tool.end", message: "file_write" }),
        workflowEvent({ type: "ambient.call.end", message: "classifications" }),
        workflowEvent({
          type: "workflow.output.ready",
          message: "Classification report",
          data: {
            html: "<table><tr><td>family events</td></tr><tr><td>admin permit</td></tr><tr><td>learning vocabulary</td></tr></table>",
          },
        }),
      ],
      modelCalls: [{ status: "succeeded" }],
      checkpoints: [{ key: "normalized_file_evidence", valuePreview: "admin permit, family events, learning vocabulary" }],
    };

    expect(() =>
      assertWorkflowUiDogfoodEvidence(detail, {
        scenarioName: "write-not-declared",
        expectConfig: { minModelCalls: 1, minOutputSignals: 1, minFinalOutputChars: 80 },
      }),
    ).toThrow(/file_write/);

    expect(
      assertWorkflowUiDogfoodEvidence(detail, {
        scenarioName: "staged-artifact-write",
        expectConfig: {
          minModelCalls: 1,
          minCheckpoints: 1,
          minOutputSignals: 1,
          minFinalOutputChars: 80,
          requiredToolMessages: ["file_read", "file_write"],
          allowedWriteToolMessages: ["file_write"],
          requiredFinalOutputAnyTerms: [
            ["family", "events"],
            ["admin", "permit"],
            ["learning", "vocabulary"],
          ],
        },
      }),
    ).toMatchObject({
      passed: true,
      desktopToolEnds: ["file_read", "file_write"],
    });
  });

  it("supports one-of desktop tool evidence requirements", () => {
    const detail = {
      events: [
        workflowEvent({ type: "workflow.start" }),
        workflowEvent({ type: "desktop-tool.end", message: "browser_content" }),
        workflowEvent({
          type: "workflow.output.ready",
          message: "Browser report",
          data: { html: "<p>example domain source evidence from iana reserved pages</p>" },
        }),
      ],
      modelCalls: [{ status: "succeeded" }],
      checkpoints: [{ key: "browser_source_evidence", valuePreview: "example domain" }],
    };

    expect(
      assertWorkflowUiDogfoodEvidence(detail, {
        scenarioName: "browser-read-equivalent",
        expectConfig: {
          minModelCalls: 1,
          minCheckpoints: 1,
          minOutputSignals: 1,
          minFinalOutputChars: 20,
          requiredAnyToolMessages: [["browser_nav", "browser_content"]],
        },
      }),
    ).toMatchObject({
      passed: true,
      desktopToolEnds: ["browser_content"],
    });

    expect(() =>
      assertWorkflowUiDogfoodEvidence(detail, {
        scenarioName: "browser-read-missing",
        expectConfig: {
          minModelCalls: 1,
          minOutputSignals: 1,
          minFinalOutputChars: 20,
          requiredAnyToolMessages: [["browser_nav", "browser_search"]],
        },
      }),
    ).toThrow(/expected one of desktop tools browser_nav, browser_search/);
  });

  it("requires rendered PDF evidence before staged local PDF writes pass", () => {
    const detail = {
      events: [
        workflowEvent({ type: "workflow.start", seq: 0 }),
        ...Array.from({ length: 10 }, (_, index) => workflowEvent({ type: "desktop-tool.end", message: "browser_search", seq: index + 1 })),
        workflowEvent({
          type: "document.render.end",
          message: "Render Scottsdale PDF",
          seq: 20,
          data: {
            format: "pdf",
            path: "Documents/scottsdale-real-estate-research-report.pdf",
            bytes: 4096,
          },
        }),
        workflowEvent({ type: "approval.required", message: "approval-1-write-report", seq: 21 }),
        workflowEvent({ type: "approval.approved", message: "approval-1-write-report", seq: 22 }),
        workflowEvent({ type: "desktop-tool.end", message: "file_write", seq: 23 }),
        workflowEvent({ type: "ambient.call.end", message: "Scottsdale synthesis", seq: 24 }),
        workflowEvent({
          type: "workflow.output.ready",
          message: "Scottsdale PDF ready",
          seq: 25,
          data: {
            markdown: [
              "# Scottsdale real estate PDF",
              "",
              "PDF artifact: Documents/scottsdale-real-estate-research-report.pdf",
              "",
              "Coverage: 100 source candidates, 82 unique sources, current source freshness as of 2026-05-17.",
              "Citations and source provenance include market reports, housing inventory, prices, zoning, short-term rental rules, schools/taxes, and nearby-city comparisons.",
              "The staged local write was approved; no unintended writes or external mutations were performed.",
            ].join("\n"),
          },
        }),
      ],
      modelCalls: [{ status: "succeeded" }],
      checkpoints: [{ key: "scottsdaleSourceCoverage", valuePreview: JSON.stringify({ candidates: 100, unique: 82, pdf: true }) }],
    };
    const expectConfig = {
      minModelCalls: 1,
      maxModelCalls: 20,
      minCheckpoints: 1,
      minOutputSignals: 1,
      minApprovalRequests: 1,
      minApprovalResponses: 1,
      minDocumentRenderEnds: 1,
      requiredDocumentRenderFormats: ["pdf"],
      minFinalOutputChars: 320,
      requiredToolMessages: ["browser_search", "file_write"],
      exactToolMessageCounts: { browser_search: 10, file_write: 1 },
      allowedWriteToolMessages: ["file_write"],
      requiredFinalOutputTerms: ["Scottsdale", "PDF"],
      requiredFinalOutputAnyTerms: [
        ["real estate", "housing", "market"],
        ["source", "sources", "citation", "citations", "provenance"],
        ["current", "freshness", "date", "2026"],
        ["coverage", "candidate", "unique", "partial", "skipped"],
        ["approved", "staged", "write", "no unintended"],
        ["Documents/scottsdale-real-estate-research-report.pdf", "scottsdale-real-estate-research-report.pdf"],
      ],
    };

    expect(() =>
      assertWorkflowUiDogfoodEvidence(
        {
          ...detail,
          events: detail.events.filter((event) => event.type !== "document.render.end"),
        },
        {
          scenarioName: "scottsdale-pdf-missing-render",
          expectConfig,
        },
      ),
    ).toThrow(/document render/);

    expect(
      assertWorkflowUiDogfoodEvidence(detail, {
        scenarioName: "scottsdale-real-estate-100-source-pdf",
        expectConfig,
      }),
    ).toMatchObject({
      passed: true,
      toolMessageCounts: {
        browser_search: 10,
        file_write: 1,
      },
      approvalRequests: 1,
      approvalResponses: 1,
      documentRenderEnds: [expect.objectContaining({ format: "pdf", path: "Documents/scottsdale-real-estate-research-report.pdf" })],
    });
  });

  it("requires current movie search evidence and preference review before recommendation gates pass", () => {
    const searchEvents = Array.from({ length: 4 }, (_, index) =>
      workflowEvent({ type: "desktop-tool.end", message: "browser_search", seq: index + 1 }),
    );
    const detail = {
      events: [
        workflowEvent({ type: "workflow.start", seq: 0 }),
        ...searchEvents,
        workflowEvent({ type: "workflow.input.required", message: "Choose movie-night preference", seq: 10 }),
        workflowEvent({ type: "workflow.input.received", message: "balanced-date-night", seq: 11, data: { choiceId: "balanced" } }),
        workflowEvent({ type: "ambient.call.end", message: "Movie option extraction", seq: 12 }),
        workflowEvent({ type: "ambient.call.end", message: "Movie night recommendation", seq: 13 }),
        workflowEvent({
          type: "workflow.output.ready",
          message: "Movie recommendation ready",
          seq: 14,
          data: {
            markdown: [
              "# Scottsdale movie tonight recommendation",
              "",
              "Recommendation: go if current showtimes still match the preferred window; otherwise choose the lower-friction alternative.",
              "Showtime facts are separated from review opinions. Reviews and ratings are labeled as opinion signals, while theater parking, travel friction, runtime, and genre are decision criteria.",
              "Sources/provenance: current public URLs from the showtime, reviews, ratings, and theater logistics searches.",
              "Freshness: checked for 2026-05-17 in America/Phoenix. Caveat: partial or skipped coverage is possible when a current showtime page is unavailable.",
            ].join("\n"),
          },
        }),
      ],
      modelCalls: [{ status: "succeeded" }, { status: "succeeded" }],
      checkpoints: [
        {
          key: "movieNightEvidence",
          valuePreview: JSON.stringify({
            sourceCount: 40,
            currentDate: "2026-05-17",
            location: "Scottsdale",
            preference: "balanced",
          }),
        },
      ],
    };
    const expectConfig = {
      minModelCalls: 1,
      maxModelCalls: 8,
      minCheckpoints: 1,
      minOutputSignals: 1,
      minRuntimeInputs: 1,
      minRuntimeInputResponses: 1,
      minFinalOutputChars: 420,
      requiredToolMessages: ["browser_search"],
      exactToolMessageCounts: { browser_search: 4 },
      forbiddenToolMessages: ["file_write", "browser_nav", "browser_content", "google_workspace_call"],
      requiredFinalOutputTerms: ["Scottsdale", "tonight", "movie"],
      requiredFinalOutputAnyTerms: [
        ["recommend", "recommendation", "go", "no-go"],
        ["showtime", "showtimes", "currently playing"],
        ["review", "reviews", "rating", "ratings"],
        ["source", "sources", "citation", "citations", "provenance", "url", "https://"],
        ["freshness", "current", "date", "2026", "America/Phoenix"],
        ["theater", "parking", "travel", "runtime", "genre"],
        [
          "partial",
          "skipped",
          "unavailable",
          "uncertainty",
          "caveat",
          "coverage gap",
          "coverage gaps",
          "missing",
          "not available",
          "unconfirmed",
          "stale",
        ],
      ],
    };

    expect(() =>
      assertWorkflowUiDogfoodEvidence(
        {
          ...detail,
          events: detail.events.filter((event, index) => !(event.message === "browser_search" && index === 4)),
        },
        {
          scenarioName: "movie-tonight-missing-search-page",
          expectConfig,
        },
      ),
    ).toThrow(/browser_search/);

    expect(() =>
      assertWorkflowUiDogfoodEvidence(
        {
          ...detail,
          events: detail.events.filter((event) => event.type !== "workflow.input.required"),
        },
        {
          scenarioName: "movie-tonight-missing-preference-review",
          expectConfig,
        },
      ),
    ).toThrow(/runtime input/);

    expect(
      assertWorkflowUiDogfoodEvidence(detail, {
        scenarioName: "movie-tonight-recommendation",
        expectConfig,
      }),
    ).toMatchObject({
      passed: true,
      toolMessageCounts: {
        browser_search: 4,
      },
      runtimeInputRequests: 1,
      runtimeInputResponses: 1,
    });
  });

  it("treats connector reads, pagination counts, and connector writes as product gates", () => {
    const detail = {
      events: [
        workflowEvent({ type: "workflow.start" }),
        workflowEvent({
          type: "connector.end",
          message: "google.gmail.search",
          data: { sideEffects: "read_personal_data", personalData: true, dataRetention: "redacted_audit" },
        }),
        workflowEvent({
          type: "connector.end",
          message: "google.gmail.readThread",
          seq: 2,
          data: { sideEffects: "read_personal_data", personalData: true, dataRetention: "redacted_audit" },
        }),
        workflowEvent({ type: "ambient.call.end", message: "gmail categories", seq: 3 }),
        workflowEvent({
          type: "workflow.output.ready",
          message: "Gmail categories",
          seq: 4,
          data: {
            markdown: [
              "# Gmail read-only categories",
              "",
              "Read-only coverage: observed 2 messages across Gmail search and thread metadata.",
              "",
              "| Category | Count | Example provenance |",
              "| --- | ---: | --- |",
              "| Customer follow-up | 1 | thread t1, message m1, internal date 2026-05-16 |",
              "| Newsletters | 1 | thread t2, message m2, internal date 2026-05-15 |",
              "",
              "No Gmail writes or mutations were performed. Partial coverage would be reported if fewer than 300 messages were available.",
            ].join("\n"),
          },
        }),
      ],
      modelCalls: [{ status: "succeeded" }],
      checkpoints: [{ key: "gmailCoverage", valuePreview: JSON.stringify({ searchPages: 1, readThreads: 2, readOnly: true }) }],
    };
    const expectConfig = {
      minModelCalls: 1,
      minCheckpoints: 1,
      minOutputSignals: 1,
      minConnectorEnds: 2,
      minFinalOutputChars: 240,
      requiredConnectorMessages: ["google.gmail.search", "google.gmail.readThread"],
      minConnectorMessageCounts: { "google.gmail.search": 1, "google.gmail.readThread": 1 },
      maxConnectorMessageCounts: { "google.gmail.search": 3, "google.gmail.readThread": 300 },
      forbiddenConnectorMessages: [
        "google.gmail.createDraft",
        "google.gmail.updateDraft",
        "google.gmail.deleteDraft",
        "google.gmail.sendDraft",
      ],
      requiredFinalOutputTerms: ["read-only"],
      requiredFinalOutputAnyTerms: [
        ["category", "bucket"],
        ["count", "messages", "threads"],
        ["example", "evidence", "provenance"],
        ["partial", "coverage", "observed"],
      ],
    };

    expect(() =>
      assertWorkflowUiDogfoodEvidence(
        {
          ...detail,
          events: [
            ...detail.events,
            workflowEvent({
              type: "connector.end",
              message: "google.gmail.createDraft",
              seq: 5,
              data: { sideEffects: "write_external", personalData: true, dataRetention: "redacted_audit" },
            }),
          ],
        },
        {
          scenarioName: "gmail-write-leak",
          expectConfig,
        },
      ),
    ).toThrow(/write-capable connector|createDraft/);

    expect(() =>
      assertWorkflowUiDogfoodEvidence(
        {
          ...detail,
          events: detail.events.filter((event) => event.message !== "google.gmail.readThread"),
        },
        {
          scenarioName: "gmail-missing-detail-read",
          expectConfig,
        },
      ),
    ).toThrow(/google\.gmail\.readThread/);

    expect(
      assertWorkflowUiDogfoodEvidence(detail, {
        scenarioName: "gmail-300-readonly-categorization",
        expectConfig,
      }),
    ).toMatchObject({
      passed: true,
      connectorEnds: ["google.gmail.search", "google.gmail.readThread"],
      connectorMessageCounts: {
        "google.gmail.search": 1,
        "google.gmail.readThread": 1,
      },
    });
  });

  it("enforces Gmail 1000 metadata-first connector budgets and review gates", () => {
    const searchEvents = Array.from({ length: 10 }, (_, index) =>
      workflowEvent({
        type: "connector.end",
        message: "google.gmail.search",
        seq: index + 1,
        data: { sideEffects: "read_personal_data", personalData: true, dataRetention: "redacted_audit", pageIndex: index },
      }),
    );
    const detail = {
      events: [
        workflowEvent({ type: "workflow.start", seq: 0 }),
        ...searchEvents,
        workflowEvent({
          type: "workflow.input.required",
          message: "Review low-confidence metadata-only follow-up candidates",
          seq: 20,
          data: { choices: [{ id: "metadata_only", label: "Keep metadata-only" }] },
        }),
        workflowEvent({ type: "workflow.input.received", message: "metadata_only", seq: 21, data: { choiceId: "metadata_only" } }),
        workflowEvent({ type: "ambient.call.end", message: "metadata categories", seq: 22 }),
        workflowEvent({
          type: "workflow.output.ready",
          message: "Gmail metadata categories",
          seq: 23,
          data: {
            markdown: [
              "# Gmail metadata-only read-only categories",
              "",
              "Coverage: observed 1,000 metadata records across 10 Gmail search pages. No full bodies, attachments, drafts, sends, label changes, or other Gmail mutations were performed.",
              "",
              "| Category | Count | Example provenance |",
              "| --- | ---: | --- |",
              "| Customer follow-up | 250 | thread t1, message m1, internal date 2026-05-16 |",
              "| Newsletters | 300 | thread t2, message m2, internal date 2026-05-15 |",
              "",
              "Partial or skipped coverage would be reported here. Follow-up detail-read candidates require a separate approval/review step before any body reads.",
            ].join("\n"),
          },
        }),
      ],
      modelCalls: Array.from({ length: 45 }, (_, index) => ({ id: `model-${index + 1}`, status: "succeeded" })),
      checkpoints: [
        { key: "gmailMetadataCoverage", valuePreview: JSON.stringify({ searchPages: 10, metadataOnly: true, readOnly: true }) },
      ],
    };
    const expectConfig = {
      minModelCalls: 1,
      maxModelCalls: 50,
      minRuntimeInputs: 1,
      minRuntimeInputResponses: 1,
      minCheckpoints: 1,
      minOutputSignals: 1,
      minConnectorEnds: 1,
      maxConnectorEnds: 10,
      minFinalOutputChars: 300,
      requiredConnectorMessages: ["google.gmail.search"],
      minConnectorMessageCounts: { "google.gmail.search": 1 },
      maxConnectorMessageCounts: { "google.gmail.search": 10, "google.gmail.readThread": 0 },
      exactConnectorMessageCounts: { "google.gmail.readThread": 0 },
      forbiddenConnectorMessages: [
        "google.gmail.readThread",
        "google.gmail.createDraft",
        "google.gmail.updateDraft",
        "google.gmail.deleteDraft",
        "google.gmail.sendDraft",
      ],
      requiredFinalOutputTerms: ["metadata-only", "read-only"],
      requiredFinalOutputAnyTerms: [
        ["category", "bucket"],
        ["count", "messages", "threads"],
        ["example", "evidence", "provenance"],
        ["follow-up", "detail-read", "approval", "review"],
      ],
    };

    expect(() =>
      assertWorkflowUiDogfoodEvidence(
        {
          ...detail,
          events: [
            ...detail.events,
            workflowEvent({
              type: "connector.end",
              message: "google.gmail.readThread",
              seq: 24,
              data: { sideEffects: "read_personal_data", personalData: true, dataRetention: "redacted_audit" },
            }),
          ],
        },
        {
          scenarioName: "gmail-1000-body-read-leak",
          expectConfig,
        },
      ),
    ).toThrow(/readThread|at most 10 connector/);

    expect(
      assertWorkflowUiDogfoodEvidence(detail, {
        scenarioName: "gmail-1000-metadata-first-gate",
        expectConfig,
      }),
    ).toMatchObject({
      passed: true,
      connectorMessageCounts: {
        "google.gmail.search": 10,
      },
      runtimeInputRequests: 1,
      runtimeInputResponses: 1,
    });
  });

  it("allows Gmail metadata/read-only proof to come from structured connector evidence", () => {
    const detail = {
      events: [
        workflowEvent({ type: "workflow.start", seq: 0 }),
        workflowEvent({
          type: "connector.end",
          message: "google.gmail.search",
          seq: 1,
          data: { sideEffects: "read_personal_data", personalData: true, dataRetention: "redacted_audit" },
        }),
        workflowEvent({ type: "ambient.call.end", message: "metadata themes", seq: 2 }),
        workflowEvent({
          type: "workflow.output.ready",
          message: "Gmail themes",
          seq: 3,
          data: {
            markdown:
              "Themes: insufficient coverage for theme extraction. Input contains 17 messages with only id and threadId fields, so categories are low confidence.",
          },
        }),
      ],
      modelCalls: [{ status: "succeeded" }],
      checkpoints: [{ key: "checkpoint-report", valuePreview: "17 messages with only id and threadId fields" }],
    };

    expect(
      assertWorkflowUiDogfoodEvidence(detail, {
        scenarioName: "gmail-20-structured-metadata-evidence",
        expectConfig: {
          minModelCalls: 1,
          minCheckpoints: 1,
          minOutputSignals: 1,
          minFinalOutputChars: 80,
          requiredConnectorMessages: ["google.gmail.search"],
          maxConnectorMessageCounts: { "google.gmail.search": 1, "google.gmail.readThread": 0 },
          requiredEvidenceContracts: ["gmail.metadata_search_only", "read_only.no_writes"],
          requiredFinalOutputAnyTerms: [
            ["theme", "category", "bucket"],
            ["messages", "threads"],
            ["coverage", "insufficient", "partial"],
          ],
        },
      }),
    ).toMatchObject({
      passed: true,
      connectorMessageCounts: {
        "google.gmail.search": 1,
      },
    });
  });

  it("enforces Google transcript connector provenance and long-context routing", () => {
    const detail = {
      events: [
        workflowEvent({ type: "workflow.start", seq: 0 }),
        workflowEvent({
          type: "connector.end",
          message: "google.calendar.listEvents",
          seq: 1,
          data: { sideEffects: "read_personal_data", personalData: true, dataRetention: "redacted_audit" },
        }),
        workflowEvent({
          type: "connector.end",
          message: "google.drive.search",
          seq: 2,
          data: { sideEffects: "read_personal_data", personalData: true, dataRetention: "redacted_audit" },
        }),
        workflowEvent({
          type: "connector.end",
          message: "google.drive.readFile",
          seq: 3,
          data: { sideEffects: "read_personal_data", personalData: true, dataRetention: "redacted_audit" },
        }),
        workflowEvent({ type: "desktop-tool.end", message: "long_context_process", seq: 4 }),
        workflowEvent({ type: "ambient.call.end", message: "transcript action report", seq: 5 }),
        workflowEvent({
          type: "workflow.output.ready",
          message: "Google transcript action items",
          seq: 6,
          data: {
            markdown: [
              "# Google meeting transcript action items",
              "",
              "Read-only coverage: searched Calendar events and Drive transcript files for the two-week window. No Google data was modified.",
              "",
              "| Action item | Owner | Due date | Source provenance |",
              "| --- | --- | --- | --- |",
              "| Send launch notes | Priya | unknown | Calendar event evt-1, Drive file file-1 |",
              "",
              "Decisions: approved launch scope. Unresolved questions: confirm analytics owner.",
              "Skipped/missing coverage: one meeting had no transcript file; partial coverage is reported with source event and file provenance.",
            ].join("\n"),
          },
        }),
      ],
      modelCalls: [{ status: "succeeded" }],
      checkpoints: [
        {
          key: "googleTranscriptCoverage",
          valuePreview: JSON.stringify({ calendarEvents: 10, driveCandidates: 4, transcriptReads: 3, readOnly: true }),
        },
      ],
    };
    const expectConfig = {
      minModelCalls: 1,
      maxModelCalls: 3,
      minCheckpoints: 1,
      minOutputSignals: 1,
      minConnectorEnds: 3,
      maxConnectorEnds: 7,
      minFinalOutputChars: 360,
      requiredToolMessages: ["long_context_process"],
      exactToolMessageCounts: { long_context_process: 1 },
      requiredConnectorMessages: ["google.calendar.listEvents", "google.drive.search", "google.drive.readFile"],
      minConnectorMessageCounts: { "google.calendar.listEvents": 1, "google.drive.search": 1, "google.drive.readFile": 1 },
      maxConnectorMessageCounts: { "google.calendar.listEvents": 2, "google.drive.search": 3, "google.drive.readFile": 2 },
      forbiddenConnectorMessages: [
        "google.calendar.createEvent",
        "google.drive.createFile",
        "google.drive.updateFile",
        "google.drive.trashFile",
      ],
      requiredFinalOutputTerms: [],
      requiredFinalOutputAnyTerms: [
        ["read-only", "read only", "read only statement"],
        ["action item", "action items"],
        ["decision", "decisions"],
        ["unresolved", "question"],
        ["source", "provenance", "event", "file"],
        ["skipped", "missing", "coverage", "partial"],
      ],
    };

    expect(() =>
      assertWorkflowUiDogfoodEvidence(
        {
          ...detail,
          events: detail.events.filter((event) => event.message !== "long_context_process"),
        },
        {
          scenarioName: "google-transcript-missing-long-context",
          expectConfig,
        },
      ),
    ).toThrow(/long_context_process/);

    expect(() =>
      assertWorkflowUiDogfoodEvidence(
        {
          ...detail,
          events: [
            ...detail.events,
            workflowEvent({
              type: "connector.end",
              message: "google.drive.createFile",
              seq: 7,
              data: { sideEffects: "write_external", personalData: true, dataRetention: "redacted_audit" },
            }),
          ],
        },
        {
          scenarioName: "google-transcript-write-leak",
          expectConfig,
        },
      ),
    ).toThrow(/write-capable connector|createFile/);

    expect(
      assertWorkflowUiDogfoodEvidence(detail, {
        scenarioName: "google-transcript-action-items",
        expectConfig,
      }),
    ).toMatchObject({
      passed: true,
      desktopToolEnds: ["long_context_process"],
      connectorMessageCounts: {
        "google.calendar.listEvents": 1,
        "google.drive.search": 1,
        "google.drive.readFile": 1,
      },
    });
  });

  it("requires metadata-only Downloads categorization evidence", () => {
    const detail = {
      events: [
        workflowEvent({ type: "workflow.start" }),
        workflowEvent({ type: "desktop-tool.end", message: "local_directory_list" }),
        workflowEvent({ type: "ambient.call.end", message: "downloads categories" }),
        workflowEvent({
          type: "workflow.output.ready",
          message: "Downloads categorization report",
          data: {
            markdown: [
              "# Downloads categories",
              "",
              "## Finance",
              "- tax-receipts-2025.pdf",
              "- budget-summary.xlsx",
              "- Receipts/parking-permit-receipt.txt",
              "",
              "## Travel",
              "- family-road-trip-itinerary.md",
              "",
              "## Learning",
              "- vocabulary-practice-notes.txt",
              "",
              "## Household",
              "- home-insurance-policy.pdf",
              "",
              "## Recipes",
              "- Recipes/soup-night.md",
              "",
              "## Skipped metadata",
              "- ignored hidden or secret-like entries: .hidden-download-cache and credentials.txt",
            ].join("\n"),
          },
        }),
      ],
      modelCalls: [{ status: "succeeded" }],
      checkpoints: [
        {
          key: "normalized_directory_inventory",
          valuePreview: JSON.stringify({
            tool: "local_directory_list",
            maxDepth: 2,
            maxEntries: 40,
            visible: ["tax-receipts-2025.pdf", "family-road-trip-itinerary.md", "vocabulary-practice-notes.txt"],
            skipped: [".hidden-download-cache", "credentials.txt"],
          }),
        },
      ],
    };
    const expectConfig = {
      minModelCalls: 1,
      minCheckpoints: 1,
      minOutputSignals: 1,
      minFinalOutputChars: 220,
      requiredToolMessages: ["local_directory_list"],
      exactToolMessageCounts: { local_directory_list: 1 },
      forbiddenToolMessages: [
        "local_file_read",
        "file_read",
        "file_write",
        "bash",
        "browser_search",
        "browser_nav",
        "browser_content",
        "google_workspace_call",
      ],
      forbiddenToolFamilies: ["browser_"],
      requiredFinalOutputTerms: ["hidden", "secret"],
      requiredFinalOutputAnyTerms: [
        ["finance", "tax", "receipt", "budget"],
        ["travel", "itinerary", "trip"],
        ["learning", "vocabulary"],
        ["household", "insurance", "home"],
        ["recipe", "food", "meal"],
        ["skipped", "ignored", "hidden", "secret"],
      ],
    };

    expect(() =>
      assertWorkflowUiDogfoodEvidence(
        {
          ...detail,
          events: [...detail.events, workflowEvent({ type: "desktop-tool.end", message: "local_file_read", seq: 2 })],
        },
        {
          scenarioName: "downloads-overread",
          expectConfig,
        },
      ),
    ).toThrow(/local_file_read/);

    expect(() =>
      assertWorkflowUiDogfoodEvidence(
        {
          ...detail,
          events: [...detail.events, workflowEvent({ type: "desktop-tool.end", message: "local_directory_list", seq: 2 })],
        },
        {
          scenarioName: "downloads-duplicate-inventory",
          expectConfig,
        },
      ),
    ).toThrow(/exactly 1 time/);

    expect(
      assertWorkflowUiDogfoodEvidence(detail, {
        scenarioName: "downloads-document-categorization",
        expectConfig,
      }),
    ).toMatchObject({
      passed: true,
      desktopToolEnds: ["local_directory_list"],
      toolMessageCounts: {
        local_directory_list: 1,
      },
    });
  });

  it("requires MiniCPM visual evidence for Downloads image categorization", () => {
    const visualEvents = Array.from({ length: 10 }, (_, index) =>
      workflowEvent({
        type: "desktop-tool.end",
        message: "ambient_visual_analyze",
        seq: index + 2,
        id: `ambient_visual_analyze-${index + 1}`,
      }),
    );
    const detail = {
      events: [
        workflowEvent({ type: "workflow.start" }),
        workflowEvent({ type: "desktop-tool.end", message: "local_directory_list" }),
        ...visualEvents,
        workflowEvent({ type: "ambient.call.end", message: "image categories", seq: 20 }),
        workflowEvent({
          type: "workflow.output.ready",
          message: "Downloads image categorization report",
          seq: 21,
          data: {
            markdown: [
              "# Downloads image categories",
              "",
              "Coverage: all 10 selected images analyzed with visual observations.",
              "",
              "| Category | Items | Evidence |",
              "| --- | --- | --- |",
              "| Workflow UI | image-01-workflow-discovery.png, image-02-workflow-diagram.png, image-03-compile-progress.png, image-04-recovery-cards.png, image-06-schedule-targeting.png | visible workflow panels, diagram nodes, compile status, recovery controls, and schedule settings |",
              "| Git review | image-07-git-summary.png | branch and review status panes |",
              "| Plugin import | image-08-plugin-import.png | plugin package/import candidate UI |",
              "| Project board | image-09-project-board.png | board/planning columns and task cards |",
              "| Browser picker | image-10-browser-picker.png | browser profile picker UI |",
            ].join("\n"),
          },
        }),
      ],
      modelCalls: [{ status: "succeeded" }],
      checkpoints: [
        {
          key: "visual_image_evidence",
          valuePreview: JSON.stringify({
            selectedImages: Array.from({ length: 10 }, (_, index) => `image-${String(index + 1).padStart(2, "0")}.png`),
            visualEvidenceCount: 10,
            skipped: [".hidden-camera-roll.png", "credentials-photo.png"],
          }),
        },
      ],
    };
    const expectConfig = {
      minModelCalls: 1,
      minCheckpoints: 1,
      minOutputSignals: 1,
      minFinalOutputChars: 320,
      requiredToolMessages: ["local_directory_list", "ambient_visual_analyze"],
      exactToolMessageCounts: { local_directory_list: 1, ambient_visual_analyze: 10 },
      forbiddenToolMessages: [
        "local_file_read",
        "file_read",
        "file_write",
        "bash",
        "browser_search",
        "browser_nav",
        "browser_content",
        "google_workspace_call",
        "ambient_visual_minicpm_setup",
      ],
      forbiddenToolFamilies: ["browser_"],
      requiredFinalOutputTerms: ["10", "visual"],
      requiredFinalOutputAnyTerms: [
        ["workflow", "diagram", "compile", "recovery", "schedule"],
        ["git", "branch", "review"],
        ["plugin", "import", "package"],
        ["project", "board", "planning"],
        ["browser", "picker", "profile"],
        ["coverage", "analyzed", "all 10"],
      ],
    };

    expect(() =>
      assertWorkflowUiDogfoodEvidence(
        {
          ...detail,
          events: detail.events.filter((event) => event.message !== "ambient_visual_analyze" || event.id !== "ambient_visual_analyze-10"),
        },
        {
          scenarioName: "downloads-image-missing-visual",
          expectConfig,
        },
      ),
    ).toThrow(/ambient_visual_analyze/);

    expect(() =>
      assertWorkflowUiDogfoodEvidence(
        {
          ...detail,
          events: [...detail.events, workflowEvent({ type: "desktop-tool.end", message: "file_read", seq: 22 })],
        },
        {
          scenarioName: "downloads-image-overread",
          expectConfig,
        },
      ),
    ).toThrow(/file_read/);

    expect(
      assertWorkflowUiDogfoodEvidence(detail, {
        scenarioName: "downloads-image-categorization",
        expectConfig,
      }),
    ).toMatchObject({
      passed: true,
      toolMessageCounts: {
        local_directory_list: 1,
        ambient_visual_analyze: 10,
      },
    });
  });

  it("inspects sibling objects in structured final outputs for coverage terms", () => {
    const passed = assertWorkflowUiDogfoodEvidence(
      {
        events: [
          workflowEvent({ type: "workflow.start" }),
          workflowEvent({ type: "ambient.call.end", message: "classifications" }),
          workflowEvent({
            type: "workflow.output.ready",
            message: "Workflow output ready.",
            data: {
              classifications: [
                { file: "dogfood-notes/admin.md", tags: ["admin"], rationale: "permit receipts appointments" },
                { file: "dogfood-notes/family-events.md", tags: ["family", "scheduling"], rationale: "pool day and hikes" },
                { file: "dogfood-notes/learning.md", tags: ["learning"], rationale: "vocabulary practice and reading" },
              ],
              htmlPath: ".checkpoints/classification-report.html",
            },
          }),
        ],
        modelCalls: [{ status: "succeeded" }],
        checkpoints: [{ key: "final-output", valuePreview: JSON.stringify({ report: "admin family learning" }) }],
      },
      {
        scenarioName: "structured-output-coverage",
        expectConfig: {
          minModelCalls: 1,
          minOutputSignals: 1,
          minFinalOutputChars: 160,
          requiredFinalOutputAnyTerms: [
            ["family", "events"],
            ["admin", "permit"],
            ["learning", "vocabulary"],
          ],
        },
      },
    );

    expect(passed.finalOutput.sources).toEqual(["event:workflow.output.ready-1", "checkpoint:final-output"]);
    expect(passed.finalOutput.charCount).toBeGreaterThanOrEqual(160);
  });

  it("requires recovery provenance for flaky browser/search dogfood gates", () => {
    const detail = {
      events: [
        workflowEvent({ type: "workflow.start" }),
        workflowEvent({ type: "desktop-tool.end", message: "browser_nav" }),
        workflowEvent({ type: "desktop-tool.end", message: "browser_content" }),
        workflowEvent({ type: "workflow.recovery.start", message: "retry_step", data: { action: "retry_step" } }),
        workflowEvent({ type: "workflow.recovery.failed", message: "retry_step", data: { action: "retry_step" } }),
        workflowEvent({ type: "workflow.recovery.start", message: "skip_item", data: { action: "skip_item" } }),
        workflowEvent({
          type: "workflow.recovery.skipped_item",
          message: "fetch sources",
          data: { action: "skip_item", itemKey: "bad-source" },
        }),
        workflowEvent({ type: "workflow.recovery.completed", message: "skip_item", data: { action: "skip_item" } }),
        workflowEvent({
          type: "workflow.output.ready",
          message: "Partial coverage report",
          data: {
            html: "<article><h1>Partial coverage</h1><p>bad-source was skipped because it was unreachable.</p><p>example domain evidence and IANA reserved-domain evidence remain in the final report.</p></article>",
          },
        }),
      ],
      modelCalls: [{ status: "succeeded" }],
      checkpoints: [
        { key: "partialCoverage", valuePreview: JSON.stringify({ skipped: ["bad-source"], retained: ["example-source", "iana-source"] }) },
      ],
    };

    expect(() =>
      assertWorkflowUiDogfoodEvidence(
        { ...detail, events: detail.events.filter((event) => event.type !== "workflow.recovery.skipped_item") },
        {
          scenarioName: "flaky-missing-skip",
          expectConfig: {
            minModelCalls: 1,
            minCheckpoints: 1,
            minOutputSignals: 1,
            minRecoveryEvents: 4,
            minRecoverySkippedItems: 1,
            requiredRecoveryActions: ["retry_step", "skip_item"],
            requiredSkippedItemKeys: ["bad-source"],
          },
        },
      ),
    ).toThrow(/skipped recovery/);

    expect(
      assertWorkflowUiDogfoodEvidence(detail, {
        scenarioName: "flaky-browser-recovery",
        expectConfig: {
          minModelCalls: 1,
          minCheckpoints: 1,
          minOutputSignals: 1,
          minFinalOutputChars: 150,
          minRecoveryEvents: 4,
          minRecoverySkippedItems: 1,
          requiredRecoveryActions: ["retry_step", "skip_item"],
          requiredSkippedItemKeys: ["bad-source"],
          requiredToolFamilies: ["browser_"],
          requiredFinalOutputAnyTerms: [
            ["partial coverage", "partial"],
            ["bad-source", "unreachable", "skipped"],
            ["example", "domain"],
            ["iana", "reserved"],
          ],
        },
      }),
    ).toMatchObject({
      passed: true,
      recoveryActionCounts: {
        retry_step: 2,
        skip_item: 3,
      },
      skippedRecoveryItems: ["bad-source"],
    });
  });

  it("can run the Phase 7 abstraction scenarios as a matrix", async () => {
    const source = await readFile(new URL("./workflow-agent-thread-ui-dogfood-matrix.mjs", import.meta.url), "utf8");

    expect(source).toContain('"phase0-live": ["vocabulary-quiz", "local-file-classifier"]');
    expect(source).toContain('"phase7-abstraction": ["vocabulary-quiz", "public-source-browser", "local-file-classifier"]');
    expect(source).toContain('"vocabulary-quiz", "public-source-browser", "local-file-classifier"');
    expect(source).toContain("workflow-agent-thread-ui-dogfood.mjs");
    expect(source).toContain('valueForArg("--suite")');
    expect(source).toContain("resolveScenarios()");
    expect(source).toContain("--scenario=${scenario}");
    expect(source).toContain("matrix-latest.json");
    expect(source).toContain("AMBIENT_WORKFLOW_UI_DOGFOOD_PROVIDER_IDLE_RETRIES");
    expect(source).toContain("AMBIENT_WORKFLOW_COMPILER_NO_OUTPUT_THINKING_TIMEOUT_MS");
    expect(source).toContain("AMBIENT_WORKFLOW_COMPILER_NO_OUTPUT_THINKING_CHARS");
    expect(source).toContain("scenarioAssertions");
    expect(source).toContain("uiAssertions");
    expect(source).toContain("desktopToolEnds");
    expect(source).toContain("promptAssembly");
    expect(source).toContain("compileContext");
    expect(source).toContain("finalOutput");
    expect(source).toContain("abstractionContract");
  });
});

async function readWorkflowUiDogfoodSourceSurface() {
  const sources = await Promise.all(
    workflowUiDogfoodSourcePaths.map((sourcePath) => readFile(new URL(sourcePath, import.meta.url), "utf8")),
  );
  const source = sources.join("\n");
  const compactSource = source.replace(/\s+/g, " ").replace(/\[\s+/g, "[").replace(/\s+\]/g, "]").replace(/,\]/g, "]");
  return `${source}\n${compactSource}`;
}

function workflowEvent(input) {
  return {
    id: input.id ?? `${input.type}-1`,
    runId: "run-1",
    artifactId: "artifact-1",
    seq: input.seq ?? 1,
    type: input.type,
    createdAt: "2026-05-17T00:00:00.000Z",
    message: input.message,
    data: input.data,
  };
}
