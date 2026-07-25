#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  assertWorkflowUiDogfoodEvidence,
  connectorEndMessages,
  desktopToolEndMessages,
  outputSignalCount,
  workflowUiDogfoodCredentialStatus,
  workflowUiDogfoodLaunchEnvironment,
  workflowUiDogfoodSelectedSnapshotRoot,
  workflowUiDogfoodSnapshotPreflight,
  workflowUiDogfoodSnapshotPreflightErrorMessage,
} from "./workflow-ui-dogfood-contract.mjs";
import { workflowDiscoveryProgress, workflowThreadFromFolders } from "./workflow-agent-thread-ui-dogfood-lib.mjs";
import { createWorkflowAgentThreadUiConnectorScenarios } from "./workflow-agent-thread-ui-connector-scenarios.mjs";
import { createWorkflowAgentThreadUiLocalScenarios } from "./workflow-agent-thread-ui-local-scenarios.mjs";
import { createWorkflowAgentThreadUiPublicScenarios } from "./workflow-agent-thread-ui-public-scenarios.mjs";

const args = new Set(process.argv.slice(2));
const keepArtifacts = args.has("--keep");
const scenarioName = valueForArg("--scenario") || process.env.AMBIENT_WORKFLOW_UI_DOGFOOD_SCENARIO || "vocabulary-quiz";
const planDslCompilerDogfood =
  envFlag(process.env.AMBIENT_WORKFLOW_PLAN_DSL_COMPILER) || envFlag(process.env.AMBIENT_WORKFLOW_PLAN_DSL_ENABLED);
const harnessName =
  valueForArg("--harness") || process.env.AMBIENT_WORKFLOW_UI_DOGFOOD_HARNESS_NAME || `workflow-agent-thread-ui-dogfood/${scenarioName}`;
const startedAt = new Date().toISOString();
const harnessRunId = safeFilePart(
  process.env.AMBIENT_WORKFLOW_UI_DOGFOOD_HARNESS_ID || `${scenarioName}-${startedAt.replace(/[:.]/g, "-")}-${process.pid}`,
);
const port = Number(valueForArg("--port") || process.env.AMBIENT_WORKFLOW_UI_DOGFOOD_CDP_PORT || 9647);
const dogfoodTimeoutMs = Number(process.env.AMBIENT_WORKFLOW_UI_DOGFOOD_TIMEOUT_MS || 1_800_000);
const liveStepTimeoutMs = Number(process.env.AMBIENT_WORKFLOW_UI_DOGFOOD_STEP_TIMEOUT_MS || 900_000);
const providerIdleRetryLimit = Number(process.env.AMBIENT_WORKFLOW_UI_DOGFOOD_PROVIDER_IDLE_RETRIES || 2);
const providerIdleRetryBaseDelayMs = Number(process.env.AMBIENT_WORKFLOW_UI_DOGFOOD_PROVIDER_IDLE_RETRY_BASE_MS || 5_000);
const forcedPermissionMode = permissionModeForValue(
  valueForArg("--permission-mode") || process.env.AMBIENT_WORKFLOW_UI_DOGFOOD_PERMISSION_MODE,
);
const stateDirs = await createDogfoodStateDirs();
const workspace = stateDirs.workspace;
const userData = stateDirs.userData;
const launchConfig = workflowUiDogfoodLaunchEnvironment({
  env: process.env,
  cwd: process.cwd(),
  workspace,
  userData,
  snapshotMode: stateDirs.snapshotMode,
});
const reportRoot = resolve("test-results", "workflow-agent-thread-ui-dogfood");
const scenarioReportRoot = join(reportRoot, scenarioName);
const harnessReportRoot = join(reportRoot, "runs", harnessRunId);
const screenshotsDir = join(harnessReportRoot, "screenshots");
const maxRetainedRunEvents = Number(process.env.AMBIENT_WORKFLOW_UI_DOGFOOD_MAX_RUN_EVENTS || 420);
const appOutput = [];
const children = new Set();
let app;
let report;

const scenarios = {
  ...createWorkflowAgentThreadUiLocalScenarios({ workspace, planDslCompilerDogfood }),
  ...createWorkflowAgentThreadUiConnectorScenarios({ planDslCompilerDogfood }),
  ...createWorkflowAgentThreadUiPublicScenarios({ planDslCompilerDogfood }),
};

const scenario = scenarios[scenarioName];
if (!scenario) {
  throw new Error(`Unknown scenario "${scenarioName}". Available scenarios: ${Object.keys(scenarios).join(", ")}`);
}

function runLimitsForScenario() {
  return scenario.runLimits ?? { idleTimeoutMs: 120_000 };
}

async function createDogfoodStateDirs() {
  const workspacePath = await mkdtemp(join(tmpdir(), `ambient-workflow-ui-dogfood-${scenarioName}-`));
  const userDataPath = await mkdtemp(join(tmpdir(), "ambient-workflow-ui-user-data-"));
  const snapshotPreflight = workflowUiDogfoodSnapshotPreflight({ env: process.env });
  if (!snapshotPreflight.requested) return { workspace: workspacePath, userData: userDataPath, snapshotMode: "fresh-temp" };
  if (!snapshotPreflight.ok) throw new Error(workflowUiDogfoodSnapshotPreflightErrorMessage(snapshotPreflight));

  const snapshotRoot = workflowUiDogfoodSelectedSnapshotRoot({ env: process.env });
  if (!snapshotRoot) throw new Error(workflowUiDogfoodSnapshotPreflightErrorMessage(snapshotPreflight));
  const snapshotWorkspace = join(snapshotRoot, "workspace");
  const snapshotUserData = join(snapshotRoot, "userData");
  if (snapshotPreflight.snapshotMode === "shared-snapshot-temp-copy") {
    await replaceDirectoryFromSnapshot(snapshotWorkspace, workspacePath);
    await replaceDirectoryFromSnapshot(snapshotUserData, userDataPath);
    return snapshotStateDirs({ workspacePath, userDataPath, snapshotRoot, snapshotMode: "shared-snapshot-temp-copy" });
  }

  if (snapshotPreflight.snapshotMode === "workspace-archive-temp-copy") {
    await replaceDirectoryFromSnapshot(snapshotRoot, workspacePath);
    return snapshotStateDirs({ workspacePath, userDataPath, snapshotRoot, snapshotMode: "workspace-archive-temp-copy" });
  }

  throw new Error(workflowUiDogfoodSnapshotPreflightErrorMessage(snapshotPreflight));
}

async function replaceDirectoryFromSnapshot(source, destination) {
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true, force: true, errorOnExist: false });
}

function snapshotStateDirs({ workspacePath, userDataPath, snapshotRoot, snapshotMode }) {
  return {
    workspace: workspacePath,
    userData: userDataPath,
    snapshotMode,
    snapshotRootLabel: basename(snapshotRoot),
    snapshotRootPathDigest: createHash("sha256").update(resolve(snapshotRoot)).digest("hex").slice(0, 12),
  };
}

async function normalizeDogfoodProjectRegistry(userDataRoot, workspacePath) {
  const registryPath = join(userDataRoot, "projects.json");
  if (!existsSync(registryPath)) return;
  let registry;
  try {
    registry = JSON.parse(await readFile(registryPath, "utf8"));
  } catch {
    registry = { version: 1 };
  }
  await writeFile(registryPath, `${JSON.stringify({ ...registry, version: 1, paths: [workspacePath] }, null, 2)}\n`, "utf8");
}

try {
  await mkdir(screenshotsDir, { recursive: true });
  await writeFile(
    join(workspace, "README.md"),
    [
      "# Workflow Agent Thread UI Dogfood",
      "",
      `Scenario: ${scenarioName}`,
      "",
      "This workspace is created by scripts/workflow-agent-thread-ui-dogfood.mjs.",
    ].join("\n"),
    "utf8",
  );
  await normalizeDogfoodProjectRegistry(userData, workspace);
  await scenario.seedWorkspace?.(workspace);

  app = await launchApp();
  report = await runDogfood(app.cdp);
  await writeReport(report);
  console.log(JSON.stringify(compactReport(report), null, 2));
  console.log(`Workflow Agent thread UI dogfood passed. Report: ${join(scenarioReportRoot, "latest.json")}`);
} catch (error) {
  const failureEvidence = app?.cdp
    ? await collectFailureEvidence(app.cdp).catch((evidenceError) => ({ error: String(evidenceError?.message ?? evidenceError) }))
    : undefined;
  const errorMessageText = error instanceof Error ? error.message : String(error);
  const failureReport = {
    scenario: scenarioName,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: false,
    harness: harnessReportMetadata(),
    classification: classifyDogfoodFailure(errorMessageText, failureEvidence),
    error: errorMessageText,
    workspace,
    userData,
    failureEvidence,
    appOutputTail: outputTail(),
    partialReport: report,
  };
  await writeReport(failureReport);
  console.error(outputTail());
  throw error;
} finally {
  if (app) {
    app.cdp.close();
    await terminateProcessTree(app.child);
  }
  for (const child of children) await terminateProcessTree(child);
  if (!keepArtifacts) {
    await rm(workspace, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
}

async function runDogfood(cdp) {
  const deadline = Date.now() + dogfoodTimeoutMs;
  await waitFor(cdp, () => document.body?.innerText.includes("Ambient"), "Ambient shell", 45_000);
  const state = await desktopState(cdp);
  const providerId = state?.provider?.providerId;
  if (providerId && providerId !== launchConfig.providerId) {
    throw new Error(`Expected ${launchConfig.providerLabel} provider (${launchConfig.providerId}), got ${providerId}.`);
  }
  const credentialStatus = workflowUiDogfoodCredentialStatus({
    env: process.env,
    cwd: process.cwd(),
    providerId: launchConfig.providerId,
  });
  if (!state?.provider?.hasApiKey && !credentialStatus.configured) {
    throw new Error(
      launchConfig.providerId === "gmi-cloud"
        ? "GMI Cloud API key is missing. Configure GMI_CLOUD_API_KEY, GMI_API_KEY, GMI_CLOUD_API_KEY_FILE, or the ignored ignored-provider-key-file.txt file."
        : "Ambient API key is missing. Configure AMBIENT_API_KEY, AMBIENT_AGENT_AMBIENT_API_KEY, AMBIENT_API_KEY_FILE, or the ignored ignored-provider-key-file.txt file.",
    );
  }
  if (!state?.provider?.hasApiKey) {
    throw new Error(`${launchConfig.providerLabel} API key was configured for launch but was not visible to the app.`);
  }
  if (state?.provider?.hasApiKey) {
    const keyCheck = await evaluate(cdp, "window.ambientDesktop.testAmbientApiKey()", { timeoutMs: 45_000 });
    if (keyCheck && keyCheck.ok === false) {
      throw new Error(`${launchConfig.providerLabel} API key check failed: ${keyCheck.message ?? "unknown provider error"}`);
    }
  }
  await ensureScenarioPermissionMode(cdp, state);

  await clickButtonText(cdp, "Workflow Agents");
  await waitFor(cdp, () => document.body?.innerText.includes("New Workflow"), "Workflow Agents shell", 45_000);

  const discovery = await liveStep(
    cdp,
    "start discovery",
    `window.ambientDesktop.startWorkflowDiscovery(${JSON.stringify({
      title: scenario.title,
      initialRequest: scenario.request,
      projectPath: workspace,
      traceMode: "production",
    })})`,
  );
  let thread = discovery.thread;
  thread = await ensureWorkflowThreadPermissionMode(cdp, thread);
  await syncWorkflowUi(cdp, discovery.folders);
  await selectThreadInUi(cdp, thread.title);

  thread = await answerDiscoveryQuestions(cdp, thread, deadline);
  thread = await requireDiscoveryReadyForCompile(cdp, thread);
  await selectThreadInUi(cdp, thread.title);

  const compileDashboard = await compileWorkflowPreviewStep(cdp, thread);
  const artifact = latestArtifactForThread(compileDashboard, thread.id);
  if (!artifact) throw new Error(`Compile completed but no artifact was created for workflow thread ${thread.id}.`);
  if (!["ready_for_preview", "approved"].includes(artifact.status)) {
    throw new Error(`Compiled artifact ${artifact.id} has unexpected status ${artifact.status}.`);
  }
  const sourceAssertions = await assertScenarioSource(artifact);

  await refreshWorkflowUi(cdp);
  await selectThreadInUi(cdp, thread.title);
  await captureMode(cdp, "Build", "build-after-compile");

  const approvedDashboard =
    artifact.status === "approved"
      ? compileDashboard
      : await liveStep(
          cdp,
          "approve workflow preview",
          `window.ambientDesktop.reviewWorkflowArtifact(${JSON.stringify({ artifactId: artifact.id, decision: "approved" })})`,
        );
  const approvedArtifact = latestArtifactForThread(approvedDashboard, thread.id) ?? artifact;

  const firstRunDashboard = await liveStep(
    cdp,
    "run approved workflow",
    `window.ambientDesktop.runWorkflowArtifact(${JSON.stringify({
      artifactId: approvedArtifact.id,
      mode: "execute",
      runtime: "workflow",
      runLimits: runLimitsForScenario(),
    })})`,
  );
  let latestRun = latestRunForArtifact(firstRunDashboard, approvedArtifact.id);
  if (!latestRun) throw new Error(`Run completed without a run record for artifact ${approvedArtifact.id}.`);
  let detail = await getRunDetail(cdp, latestRun.id);
  let recoveryTrace;
  if (scenario.recovery) {
    ({ latestRun, detail, recoveryTrace } = await exerciseGraphRecovery(cdp, approvedArtifact, latestRun, detail));
  } else {
    ({ latestRun, detail } = await resumeRuntimePauses(cdp, approvedArtifact, latestRun, detail));
  }
  if (latestRun.status !== "succeeded") {
    throw new Error(
      `Expected workflow run to succeed after ${scenario.recovery ? "graph recovery" : "runtime input resume"}, got ${latestRun.status}: ${latestRun.error ?? "no error"}`,
    );
  }
  const scenarioAssertions = assertScenarioEvidence(detail);

  await liveStep(
    cdp,
    "create disabled workflow schedule",
    `window.ambientDesktop.createAutomationSchedule(${JSON.stringify({
      targetKind: "workflow_thread",
      targetId: thread.id,
      preset: "daily",
      timezone: "America/Phoenix",
      enabled: false,
      skipIfActive: true,
      runLimits: runLimitsForScenario(),
    })})`,
    { timeoutMs: 60_000 },
  );

  await refreshWorkflowUi(cdp);
  await selectThreadInUi(cdp, thread.title);
  const buildMetrics = await captureMode(cdp, "Build", "build-narrow");
  const runsMetrics = await captureMode(cdp, "Runs", "runs-narrow");
  const schedulesMetrics = await captureMode(cdp, "Schedules", "schedules-narrow");
  const uiAssertions = assertCompactMetrics({ buildMetrics, runsMetrics, schedulesMetrics });

  const finalState = await desktopState(cdp);
  const schedules = await evaluate(cdp, "window.ambientDesktop.listAutomationSchedules()", { timeoutMs: 60_000 });
  const graphSnapshots = await evaluate(
    cdp,
    `window.ambientDesktop.listWorkflowGraphSnapshots(${JSON.stringify({ workflowThreadId: thread.id })})`,
    { timeoutMs: 60_000 },
  );

  return {
    ok: true,
    scenario: scenarioName,
    harness: harnessReportMetadata(),
    startedAt,
    finishedAt: new Date().toISOString(),
    workspace,
    thread: pick(thread, ["id", "title", "phase", "status", "traceMode"]),
    permissionMode:
      scenarioPermissionMode() ?? finalState.threads?.find((candidate) => candidate.id === finalState.activeThreadId)?.permissionMode,
    artifact: pick(approvedArtifact, ["id", "title", "status", "sourcePath"]),
    manifest: manifestEvidence(approvedArtifact.manifest),
    run: pick(latestRun, ["id", "status", "error", "reportPath", "startedAt", "updatedAt", "completedAt"]),
    launch: launchConfig.launchSummary,
    sourceAssertions,
    abstractionContract: sourceAssertions?.abstractionContract,
    runEvidence: {
      events: detail.events.length,
      modelCalls: detail.modelCalls.length,
      checkpoints: detail.checkpoints.length,
      approvals: detail.approvals.length,
      outputSignals: outputSignalCount(detail),
      runtimeInputRequests: detail.events.filter((event) => event.type === "workflow.input.required").length,
      runtimeInputResponses: detail.events.filter((event) => event.type === "workflow.input.received").length,
      approvalRequests: detail.events.filter((event) => event.type === "approval.required").length,
      approvalResponses: detail.events.filter((event) => event.type === "approval.approved").length,
      desktopToolEnds: desktopToolEndMessages(detail),
      connectorEnds: connectorEndMessages(detail),
      recoveryEvents: detail.events.filter((event) => event.type.startsWith("workflow.recovery.")).length,
    },
    recoveryTrace,
    scenarioAssertions,
    discovery: {
      questions: thread.discoveryQuestions.length,
      answered: thread.discoveryQuestions.filter((question) => question.answer).length,
      ambientQuestions: thread.discoveryQuestions.filter((question) => question.provider === "ambient").length,
      graphNodes: thread.graph?.nodes?.length ?? 0,
    },
    schedule: {
      total: Array.isArray(schedules) ? schedules.length : 0,
      forThread: Array.isArray(schedules)
        ? schedules.filter((schedule) => schedule.targetKind === "workflow_thread" && schedule.targetId === thread.id).length
        : 0,
    },
    graphSnapshots: Array.isArray(graphSnapshots) ? graphSnapshots.length : 0,
    uiAssertions,
    screenshots: [buildMetrics.screenshot, runsMetrics.screenshot, schedulesMetrics.screenshot],
    appOutputTail: outputTail(),
    finalWorkflowThreadCount: finalState.workflowAgentFolders?.flatMap((folder) => folder.threads ?? []).length ?? 0,
  };
}

async function answerDiscoveryQuestions(cdp, initialThread, deadline) {
  let thread = initialThread;
  for (let round = 0; round < 8; round += 1) {
    if (Date.now() > deadline) throw new Error("Timed out while answering discovery questions.");
    thread = await latestWorkflowThreadFromUi(cdp, thread);
    thread = await resolveDiscoveryAccessRequests(cdp, thread, deadline);
    thread = await latestWorkflowThreadFromUi(cdp, thread);
    const pending = (thread.discoveryQuestions ?? []).filter((question) => !question.answer);
    if (pending.length === 0) return thread;
    const progress = workflowDiscoveryProgress(thread);
    const progressLine = `[dogfood] discovery answer round ${round + 1}: ${progress.answered}/${progress.questions} answered, ${progress.pendingAccessRequests} pending access requests`;
    appOutput.push(`${progressLine}\n`);
    console.log(progressLine);
    for (const question of pending) {
      thread = await latestWorkflowThreadFromUi(cdp, thread);
      const latestQuestion = (thread.discoveryQuestions ?? []).find((candidate) => candidate.id === question.id) ?? question;
      if (latestQuestion.answer) continue;
      const choice = chooseDiscoveryChoice(latestQuestion);
      const payload = choice
        ? { questionId: latestQuestion.id, choiceId: choice.id }
        : { questionId: latestQuestion.id, freeform: "Use the simplest read-only, model-first workflow shape and keep outputs concise." };
      const result = await liveStep(
        cdp,
        `answer discovery question ${latestQuestion.id}`,
        `window.ambientDesktop.answerWorkflowDiscoveryQuestion(${JSON.stringify(payload)})`,
      );
      thread = result.thread;
      await syncWorkflowUi(cdp, result.folders);
      thread = await latestWorkflowThreadFromUi(cdp, thread);
      thread = await resolveDiscoveryAccessRequests(cdp, thread, deadline);
    }
  }
  thread = await latestWorkflowThreadFromUi(cdp, thread);
  const progress = workflowDiscoveryProgress(thread);
  throw new Error(
    `Discovery still has ${progress.unanswered} unanswered question(s) and ${progress.pendingAccessRequests} pending access request(s) after 8 rounds for thread ${thread.id}.`,
  );
}

async function resolveDiscoveryAccessRequests(cdp, initialThread, deadline) {
  let thread = initialThread;
  for (let round = 0; round < 24; round += 1) {
    if (Date.now() > deadline) throw new Error("Timed out while resolving discovery access requests.");
    const pending = pendingDiscoveryAccessRequests(thread);
    if (pending.length === 0) return thread;
    const { question, request } = pending[0];
    const response = discoveryAccessResponseForScenario(request);
    const result = await liveStep(
      cdp,
      `resolve discovery access ${request.id}`,
      `window.ambientDesktop.resolveWorkflowDiscoveryAccessRequest(${JSON.stringify({
        questionId: question.id,
        accessRequestId: request.id,
        response,
      })})`,
    );
    thread = result.thread;
    await syncWorkflowUi(cdp, result.folders);
    thread = await latestWorkflowThreadFromUi(cdp, thread);
  }
  throw new Error(`Discovery still has pending access requests after 24 resolutions for thread ${thread.id}.`);
}

async function latestWorkflowThreadFromUi(cdp, thread) {
  const folders = await evaluate(cdp, "window.ambientDesktop.listWorkflowAgentFolders()", { timeoutMs: 60_000 });
  return workflowThreadFromFolders(folders, thread.id) ?? thread;
}

async function requireDiscoveryReadyForCompile(cdp, thread) {
  const latest = await latestWorkflowThreadFromUi(cdp, thread);
  const progress = workflowDiscoveryProgress(latest);
  if (progress.unanswered > 0 || progress.pendingAccessRequests > 0) {
    throw new Error(
      `Workflow discovery is not ready to compile for thread ${latest.id}: ${progress.answered}/${progress.questions} answered, ${progress.pendingAccessRequests} pending access request(s).`,
    );
  }
  return latest;
}

function pendingDiscoveryAccessRequests(thread) {
  const pending = [];
  for (const question of thread.discoveryQuestions ?? []) {
    for (const request of question.accessRequests ?? []) {
      if (request.status === "pending") pending.push({ question, request });
    }
  }
  return pending;
}

function discoveryAccessResponseForScenario(request) {
  const allowedCapabilities = new Set(scenario.allowDiscoveryAccessCapabilities ?? []);
  if (allowedCapabilities.has(request.capability)) {
    return Array.isArray(request.reusableScopes) && request.reusableScopes.includes("workflow_thread") ? "always_workflow" : "allow_once";
  }
  return "deny";
}

async function compileWorkflowPreviewStep(cdp, thread) {
  const beforeArtifactIds = await evaluate(
    cdp,
    `(async () => {
      const dashboard = await window.ambientDesktop.listWorkflowDashboard();
      return dashboard.artifacts.filter((artifact) => artifact.workflowThreadId === ${JSON.stringify(thread.id)}).map((artifact) => artifact.id);
    })()`,
    { timeoutMs: 60_000 },
  );
  const knownArtifactIds = Array.isArray(beforeArtifactIds) ? beforeArtifactIds : [];
  return liveStep(
    cdp,
    "compile workflow preview",
    `window.ambientDesktop.compileWorkflowPreview(${JSON.stringify({
      userRequest: scenario.request,
      workflowThreadId: thread.id,
    })})`,
    {
      recoverExpression: `(async () => {
        const dashboard = await window.ambientDesktop.listWorkflowDashboard();
        const known = new Set(${JSON.stringify(knownArtifactIds)});
        const artifact = dashboard.artifacts.find((candidate) =>
          candidate.workflowThreadId === ${JSON.stringify(thread.id)} &&
          !known.has(candidate.id) &&
          ["ready_for_preview", "approved"].includes(candidate.status)
        );
        if (!artifact) return null;
        const run = dashboard.runs.find((candidate) => candidate.artifactId === artifact.id && ["previewed", "succeeded", "running"].includes(candidate.status));
        return run ? dashboard : null;
      })()`,
      recoveryLabel: "persisted workflow preview artifact",
    },
  );
}

function chooseDiscoveryChoice(question) {
  const choices = question.choices ?? [];
  if (!choices.length) return undefined;
  const preferred = scenario.answerPreference ?? [];
  const scored = choices.map((choice, index) => {
    const text = `${choice.label ?? ""} ${choice.description ?? ""}`.toLowerCase();
    const score =
      (choice.recommended ? 100 : 0) +
      preferred.reduce((sum, term) => sum + (text.includes(term.toLowerCase()) ? 20 : 0), 0) -
      (scenarioName === "vocabulary-quiz" && /browser|web|network|search|connector/i.test(text) ? 25 : 0) -
      index;
    return { choice, score };
  });
  scored.sort((left, right) => right.score - left.score);
  return scored[0]?.choice;
}

async function liveStep(cdp, label, expression, options = {}) {
  const timeoutMs = options.timeoutMs ?? liveStepTimeoutMs;
  const retryLimit = Math.max(0, Math.floor(options.providerIdleRetries ?? providerIdleRetryLimit));
  let lastError;
  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    const started = Date.now();
    const attemptSuffix = attempt > 0 ? ` retry ${attempt}/${retryLimit}` : "";
    const startLine = `[dogfood] ${label}${attemptSuffix} started; timeout ${Math.round(timeoutMs / 1000)}s`;
    appOutput.push(`${startLine}\n`);
    console.log(startLine);
    try {
      const operationId = await startRendererOperation(cdp, expression);
      const result = await waitForRendererOperation(cdp, operationId, {
        label,
        timeoutMs,
        recoverExpression: options.recoverExpression,
        recoveryLabel: options.recoveryLabel,
      });
      const completeLine = `[dogfood] ${label}${attemptSuffix} completed in ${Date.now() - started}ms`;
      appOutput.push(`${completeLine}\n`);
      console.log(completeLine);
      return result;
    } catch (error) {
      lastError = error;
      const failureLine = `[dogfood] ${label}${attemptSuffix} failed in ${Date.now() - started}ms`;
      appOutput.push(`${failureLine}\n`);
      console.error(failureLine);
      if (attempt < retryLimit && isProviderIdleStartError(error)) {
        const retryDelayMs = Math.min(60_000, providerIdleRetryBaseDelayMs * 2 ** attempt);
        const retryLine = `[dogfood] ${label} retrying after provider idle/no-stream failure in ${Math.round(retryDelayMs / 1000)}s`;
        appOutput.push(`${retryLine}\n`);
        console.warn(retryLine);
        await delay(retryDelayMs);
        continue;
      }
      throw new Error(`${label} failed after ${Date.now() - started}ms: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`${label} failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function startRendererOperation(cdp, expression, options = {}) {
  const operationId = `workflow-dogfood-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return evaluate(
    cdp,
    `(() => {
      const id = ${JSON.stringify(operationId)};
      const operations = (window.__ambientWorkflowDogfoodOps ||= {});
      operations[id] = { status: "pending", startedAt: Date.now() };
      Promise.resolve()
        .then(() => (${expression}))
        .then(
          (result) => {
            operations[id] = { ...operations[id], status: "fulfilled", result, finishedAt: Date.now() };
          },
          (error) => {
            operations[id] = {
              ...operations[id],
              status: "rejected",
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
              finishedAt: Date.now(),
            };
          },
        );
      return id;
    })()`,
    { timeoutMs: options.timeoutMs ?? 120_000 },
  );
}

async function waitForRendererOperation(cdp, operationId, options) {
  const started = Date.now();
  let pollFailures = 0;
  let lastRecovered;
  let lastRecoveryPollAt = 0;
  while (Date.now() - started < options.timeoutMs) {
    let operation;
    try {
      operation = await evaluate(
        cdp,
        `(() => {
          const item = window.__ambientWorkflowDogfoodOps?.[${JSON.stringify(operationId)}];
          if (!item) return { status: "missing", error: "Renderer operation was not found." };
          if (item.status === "fulfilled") {
            delete window.__ambientWorkflowDogfoodOps[${JSON.stringify(operationId)}];
            return { status: "fulfilled", result: item.result };
          }
          if (item.status === "rejected") {
            delete window.__ambientWorkflowDogfoodOps[${JSON.stringify(operationId)}];
            return { status: "rejected", error: item.error, stack: item.stack };
          }
          return { status: "pending", startedAt: item.startedAt };
        })()`,
        { timeoutMs: 60_000 },
      );
    } catch (error) {
      pollFailures += 1;
      if (pollFailures <= 3) {
        const warning = `[dogfood] ${options.label} renderer poll did not respond (${error instanceof Error ? error.message : String(error)}); continuing until overall timeout`;
        appOutput.push(`${warning}\n`);
        console.warn(warning);
      }
      if (options.recoverExpression) {
        try {
          const recovered = await evaluate(cdp, options.recoverExpression, { timeoutMs: 60_000 });
          if (recovered) {
            const recoveryLine = `[dogfood] ${options.label} recovered from ${options.recoveryLabel ?? "observable app state"}`;
            appOutput.push(`${recoveryLine}\n`);
            console.warn(recoveryLine);
            return recovered;
          }
        } catch {
          // A busy renderer can miss a recovery poll too; the outer live-step timeout is the authority.
        }
      }
      await delay(1_000);
      continue;
    }
    if (operation?.status === "fulfilled") return operation.result;
    if (operation?.status === "rejected" || operation?.status === "missing") {
      throw new Error(operation.error ?? `${options.label} renderer operation failed.`);
    }
    if (options.recoverExpression && Date.now() - started > 30_000 && Date.now() - lastRecoveryPollAt > 10_000) {
      lastRecoveryPollAt = Date.now();
      try {
        const recovered = await evaluate(cdp, options.recoverExpression, { timeoutMs: 60_000 });
        if (recovered) {
          lastRecovered = recovered;
          if (Date.now() - started < Math.max(60_000, options.timeoutMs - 60_000)) {
            const recoveryLine = `[dogfood] ${options.label} recovered from ${options.recoveryLabel ?? "observable app state"}`;
            appOutput.push(`${recoveryLine}\n`);
            console.warn(recoveryLine);
            return recovered;
          }
        }
      } catch {
        // A busy renderer can miss a recovery poll too; the outer live-step timeout is the authority.
      }
    }
    await delay(1_000);
  }
  if (lastRecovered) {
    const recoveryLine = `[dogfood] ${options.label} recovered from ${options.recoveryLabel ?? "observable app state"} after operation timeout`;
    appOutput.push(`${recoveryLine}\n`);
    console.warn(recoveryLine);
    return lastRecovered;
  }
  throw new Error(`${options.label} did not finish within ${options.timeoutMs}ms`);
}

function isProviderIdleStartError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /without stream activity|did not start streaming|Discovery is paused until Ambient access|\b429\b|rate limit|Upstream request failed/i.test(
    message,
  );
}

async function captureMode(cdp, mode, name) {
  const modeName = mode.toLowerCase();
  const alreadyInMode = await evaluate(cdp, `Boolean(document.querySelector('[data-mode="${modeName}"]'))`, { timeoutMs: 10_000 });
  if (!alreadyInMode) await clickText(cdp, mode);
  await waitFor(
    cdp,
    (modeName, modeLabel) => Boolean(document.querySelector(`[data-mode="${modeName}"]`) || document.body?.innerText.includes(modeLabel)),
    `${mode} mode`,
    45_000,
    [mode.toLowerCase(), mode],
  );
  if (modeName === "build") {
    await waitFor(
      cdp,
      () => {
        const text = document.body?.innerText.toLowerCase() ?? "";
        return text.includes("compile audit") && text.includes("prompt modules") && text.includes("validator");
      },
      "Build compile audit summary",
      45_000,
    );
  }
  await setNarrowWorkflowSplit(cdp);
  await delay(500);
  const metrics = await evaluate(
    cdp,
    `(() => {
      const mode = ${JSON.stringify(mode.toLowerCase())};
      const root = document.querySelector('[data-mode="' + mode + '"]');
      const rail = root?.querySelector('.workflow-build-rail, .workflow-runs-rail, .workflow-schedules-rail');
      const shell = root?.querySelector('.workflow-build-shell, .workflow-runs-shell, .workflow-schedules-shell');
      const panelBody = root?.querySelector('.workflow-build-panel-body, .workflow-runs-panel-body, .workflow-schedules-panel-body');
      const diagram = document.querySelector('.workflow-persistent-diagram-pane');
      const overflowX = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth;
      const rootText = root?.innerText ?? document.body.innerText ?? '';
      const activePanel =
        panelBody?.getAttribute('data-workflow-build-panel') ||
        panelBody?.getAttribute('data-workflow-runs-panel') ||
        root?.querySelector('[id^="schedules-"]')?.id ||
        '';
      return {
        mode,
        rootWidth: root ? Math.round(root.getBoundingClientRect().width) : 0,
        railDisplay: rail ? getComputedStyle(rail).display : '',
        railOverflowX: rail ? getComputedStyle(rail).overflowX : '',
        railButtonCount: rail ? rail.querySelectorAll('button').length : 0,
        shellColumns: shell ? getComputedStyle(shell).gridTemplateColumns : '',
        activePanel,
        diagramVisible: Boolean(diagram && diagram.getBoundingClientRect().width > 120 && diagram.getBoundingClientRect().height > 120),
        overflowX,
        visibleChars: rootText.length,
        compileAuditVisible:
          mode === "build"
            ? (() => {
                const text = rootText.toLowerCase();
                return text.includes("compile audit") && text.includes("prompt modules") && text.includes("validator");
              })()
            : undefined,
      };
    })()`,
  );
  const screenshot = await captureScreenshot(cdp, name);
  return { ...metrics, screenshot };
}

function assertCompactMetrics({ buildMetrics, runsMetrics, schedulesMetrics }) {
  const modes = [buildMetrics, runsMetrics, schedulesMetrics];
  const failures = [];
  for (const metric of modes) {
    if (metric.rootWidth <= 0) failures.push(`${metric.mode}: root missing`);
    if (metric.rootWidth > 760) failures.push(`${metric.mode}: expected compact root width <= 760, got ${metric.rootWidth}`);
    if (metric.railDisplay !== "flex") failures.push(`${metric.mode}: expected compact rail display flex, got ${metric.railDisplay}`);
    if (!metric.diagramVisible) failures.push(`${metric.mode}: persistent diagram is not visible`);
    if (metric.overflowX > 24) failures.push(`${metric.mode}: page has ${metric.overflowX}px horizontal overflow`);
    if (metric.visibleChars > 120_000)
      failures.push(`${metric.mode}: page text is too large (${metric.visibleChars} chars), likely flooding UI`);
  }
  if (!buildMetrics.compileAuditVisible) failures.push("build: compile audit summary is not visible");
  if (failures.length) throw new Error(`Compact V3 UI assertions failed:\n- ${failures.join("\n- ")}`);
  return {
    passed: true,
    modes: modes.map((metric) =>
      pick(metric, [
        "mode",
        "rootWidth",
        "railDisplay",
        "railOverflowX",
        "railButtonCount",
        "activePanel",
        "overflowX",
        "visibleChars",
        "compileAuditVisible",
      ]),
    ),
  };
}

async function selectThreadInUi(cdp, title) {
  await ensureWorkflowAgentsShell(cdp);
  await clickText(cdp, title);
  await waitFor(
    cdp,
    (needle) => Boolean(document.body?.innerText.includes(needle) && document.querySelector(".workflow-discovery-layout")),
    "workflow thread selected",
    45_000,
    [title],
  );
}

async function ensureWorkflowAgentsShell(cdp) {
  const alreadyThere = await evaluate(
    cdp,
    `Boolean(document.body?.innerText?.includes("Workflow Agents") && document.body?.innerText?.includes("New Workflow"))`,
    { timeoutMs: 10_000 },
  );
  if (!alreadyThere) {
    await clickButtonText(cdp, "Workflow Agents");
  }
  await waitFor(
    cdp,
    () => Boolean(document.body?.innerText?.includes("Workflow Agents") && document.body?.innerText?.includes("New Workflow")),
    "Workflow Agents shell",
    45_000,
  );
}

async function setNarrowWorkflowSplit(cdp) {
  await evaluate(
    cdp,
    `(() => {
      document.querySelectorAll('.workflow-discovery-layout').forEach((layout) => {
        layout.style.setProperty('--workflow-split-primary', '520px');
      });
    })()`,
  );
}

async function syncWorkflowUi(cdp, folders) {
  await evaluate(cdp, `window.ambientDesktop.emitE2eEvent?.(${JSON.stringify({ type: "workflow-updated" })})`, { timeoutMs: 30_000 });
  if (folders) {
    const state = await desktopState(cdp);
    await evaluate(cdp, `window.ambientDesktop.emitE2eEvent?.(${JSON.stringify({ type: "state", state })})`, { timeoutMs: 30_000 });
  }
}

async function refreshWorkflowUi(cdp) {
  await evaluate(cdp, `window.ambientDesktop.emitE2eEvent?.(${JSON.stringify({ type: "workflow-updated" })})`, { timeoutMs: 30_000 });
  await delay(300);
}

async function getRunDetail(cdp, runId) {
  return evaluate(cdp, `window.ambientDesktop.getWorkflowRunDetail(${JSON.stringify({ runId })})`, { timeoutMs: 60_000 });
}

async function resumeRuntimePauses(cdp, artifact, initialRun, initialDetail) {
  let latestRun = initialRun;
  let detail = initialDetail;
  const resumeTimeoutMs = scenario.resumeTimeoutMs ?? liveStepTimeoutMs;
  for (let attempt = 0; attempt < 6 && (latestRun.status === "needs_input" || latestRun.status === "paused"); attempt += 1) {
    const input = latestUnansweredInput(detail);
    if (input) {
      const resumedDashboard = await liveStep(
        cdp,
        `resume workflow from runtime input ${attempt + 1}`,
        `window.ambientDesktop.runWorkflowArtifact(${JSON.stringify({
          artifactId: artifact.id,
          mode: "execute",
          runtime: "workflow",
          resumeFromRunId: latestRun.id,
          runLimits: runLimitsForScenario(),
          userInputs: [
            {
              requestId: input.requestId,
              ...(input.choiceId ? { choiceId: input.choiceId } : {}),
              text: input.answerText ?? scenario.runtimeAnswer,
            },
          ],
        })})`,
        {
          timeoutMs: resumeTimeoutMs,
          recoverExpression: completedRunDashboardRecoverExpression(artifact.id, latestRun.id),
          recoveryLabel: "persisted resumed workflow run",
        },
      );
      latestRun = latestRunForArtifact(resumedDashboard, artifact.id) ?? latestRun;
      detail = await getRunDetail(cdp, latestRun.id);
      continue;
    }

    const approval = latestPendingApproval(detail);
    if (approval) {
      detail = await liveStep(
        cdp,
        `approve workflow review item ${attempt + 1}`,
        `window.ambientDesktop.resolveWorkflowApproval(${JSON.stringify({ runId: latestRun.id, approvalId: approval.id, decision: "approved" })})`,
      );
      const resumedDashboard = await liveStep(
        cdp,
        `resume workflow from review item ${attempt + 1}`,
        `window.ambientDesktop.runWorkflowArtifact(${JSON.stringify({
          artifactId: artifact.id,
          mode: "execute",
          runtime: "workflow",
          resumeFromRunId: latestRun.id,
          runLimits: runLimitsForScenario(),
        })})`,
        {
          timeoutMs: resumeTimeoutMs,
          recoverExpression: completedRunDashboardRecoverExpression(artifact.id, latestRun.id),
          recoveryLabel: "persisted resumed workflow run",
        },
      );
      latestRun = latestRunForArtifact(resumedDashboard, artifact.id) ?? latestRun;
      detail = await getRunDetail(cdp, latestRun.id);
      continue;
    }

    throw new Error(
      `Run ${latestRun.id} paused with status ${latestRun.status} but no unanswered workflow.input.required event or pending review item was retained.`,
    );
  }
  return { latestRun, detail };
}

function completedRunDashboardRecoverExpression(artifactId, resumeFromRunId) {
  return `(async () => {
    const dashboard = await window.ambientDesktop.listWorkflowDashboard();
    const runs = dashboard.runs
      .filter((candidate) => candidate.artifactId === ${JSON.stringify(artifactId)})
      .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
    const latest = runs[0];
    if (!latest) return null;
    if (latest.status === "running" || latest.status === "queued") return null;
    if (latest.id === ${JSON.stringify(resumeFromRunId)} && (latest.status === "needs_input" || latest.status === "paused")) return null;
    return dashboard;
  })()`;
}

async function exerciseGraphRecovery(cdp, artifact, initialRun, initialDetail) {
  let latestRun = initialRun;
  let detail = initialDetail;
  if (latestRun.status === "needs_input" || latestRun.status === "paused") {
    ({ latestRun, detail } = await resumeRuntimePauses(cdp, artifact, latestRun, detail));
  }
  if (latestRun.status !== "failed") {
    throw new Error(`Recovery scenario expected the first workflow run to fail with an actionable graph event, got ${latestRun.status}.`);
  }

  const screenshots = [];
  const actions = [];
  const visible = await assertGraphRecoveryUiVisible(cdp, scenario.recovery);
  screenshots.push(visible.screenshot);

  for (const [index, action] of scenario.recovery.actions.entries()) {
    const event = selectRecoveryEvent(detail, action);
    if (!event) {
      throw new Error(
        `Could not find an actionable failed event for recovery action ${action}. Event tail: ${eventTail(detail).join(" | ")}`,
      );
    }
    const dashboard = await liveStep(
      cdp,
      `recover workflow with ${action}`,
      `window.ambientDesktop.recoverWorkflowRun(${JSON.stringify({
        runId: latestRun.id,
        eventId: event.id,
        action,
        graphNodeId: event.graphNodeId ?? event.data?.graphNodeId,
        itemKey: event.itemKey ?? event.data?.itemKey,
        allowUnapproved: artifact.status !== "approved",
      })})`,
    );
    latestRun = latestRunForArtifact(dashboard, artifact.id) ?? latestRun;
    detail = await getRunDetail(cdp, latestRun.id);
    if (latestRun.status === "needs_input" || latestRun.status === "paused") {
      ({ latestRun, detail } = await resumeRuntimePauses(cdp, artifact, latestRun, detail));
    }
    const capture = await captureMode(cdp, "Runs", `recovery-${action}-${index + 1}`);
    screenshots.push(capture.screenshot);
    actions.push({
      action,
      sourceRunId: event.runId,
      sourceEventId: event.id,
      sourceEventType: event.type,
      graphNodeId: event.graphNodeId ?? event.data?.graphNodeId,
      itemKey: event.itemKey ?? event.data?.itemKey,
      resultRunId: latestRun.id,
      resultStatus: latestRun.status,
      resultError: latestRun.error,
    });
    if (latestRun.status === "succeeded" && index < scenario.recovery.actions.length - 1) {
      throw new Error(
        `Recovery action ${action} succeeded before all required recovery actions ran; expected ${scenario.recovery.actions.slice(index + 1).join(", ")} to remain actionable.`,
      );
    }
  }

  return {
    latestRun,
    detail,
    recoveryTrace: {
      actions,
      screenshots,
      eventCounts: eventCountsByType(detail.events),
    },
  };
}

async function assertGraphRecoveryUiVisible(cdp, recovery) {
  const metrics = await captureMode(cdp, "Runs", "recovery-before");
  const bodyText = await evaluate(cdp, "document.body?.innerText ?? ''", { timeoutMs: 30_000 });
  const requiredTerms = recovery.requiredVisibleTerms ?? recovery.actions ?? [];
  const missing = requiredTerms.filter((term) => !bodyText.toLowerCase().includes(String(term).toLowerCase()));
  if (missing.length) {
    throw new Error(`Recovery UI did not expose expected action term(s): ${missing.join(", ")}. Screenshot: ${metrics.screenshot.path}`);
  }
  return metrics;
}

function selectRecoveryEvent(detail, action) {
  const candidates = [...(detail.events ?? [])]
    .reverse()
    .filter((event) => isRecoverableFailureEvent(event))
    .filter((event) => !String(event.type ?? "").startsWith("workflow.recovery."))
    .filter((event) => event.type !== "workflow.failed");
  if (action === "skip_item") {
    return candidates.find((event) => recoveryItemKey(event)) ?? candidates[0];
  }
  return candidates.find((event) => event.graphNodeId ?? event.data?.graphNodeId) ?? candidates[0];
}

function isRecoverableFailureEvent(event) {
  return event?.type === "workflow.failed" || /\.error$|\.failed$|\.invalid$/.test(String(event?.type ?? ""));
}

function recoveryItemKey(event) {
  const value = event?.itemKey ?? event?.data?.itemKey;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function eventTail(detail) {
  return (detail.events ?? [])
    .slice(-12)
    .map(
      (event) =>
        `${event.seq}:${event.type}:${event.graphNodeId ?? event.data?.graphNodeId ?? ""}:${event.itemKey ?? event.data?.itemKey ?? ""}:${event.message ?? ""}`,
    );
}

function eventCountsByType(events) {
  return (events ?? []).reduce((counts, event) => {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
    return counts;
  }, {});
}

function latestPendingApproval(detail) {
  return (detail.approvals ?? []).filter((approval) => approval.status === "pending").slice(-1)[0];
}

function latestUnansweredInput(detail) {
  const answered = new Set(
    (detail.events ?? [])
      .filter((event) => event.type === "workflow.input.received")
      .map((event) => String(event.data?.requestId ?? event.message ?? "")),
  );
  const event = (detail.events ?? [])
    .filter((candidate) => candidate.type === "workflow.input.required")
    .filter((candidate) => !answered.has(String(candidate.data?.id ?? candidate.message ?? "")))
    .sort((left, right) => right.seq - left.seq)[0];
  if (!event) return undefined;
  const choices = Array.isArray(event.data?.choices) ? event.data.choices : [];
  const selectedChoice = chooseRuntimeInputChoice(choices, event.message ?? event.data?.prompt);
  return {
    requestId: String(event.data?.id),
    choiceId: selectedChoice?.id ? String(selectedChoice.id) : undefined,
    answerText: selectedChoice?.value ? String(selectedChoice.value) : selectedChoice?.label ? String(selectedChoice.label) : undefined,
    prompt: event.message ?? event.data?.prompt,
  };
}

function chooseRuntimeInputChoice(choices, prompt) {
  if (!choices.length) return undefined;
  const preferred = [
    ...(scenario.runtimeChoicePreference ?? []),
    "looks good",
    "proceed",
    "continue",
    "approve",
    "approved",
    "yes",
    "done",
  ];
  const negative = ["adjust", "revise", "change", "cancel", "reject", "skip", "stop", "abort"];
  const promptText = String(prompt ?? "").toLowerCase();
  const scored = choices.map((choice, index) => {
    const text = `${choice.id ?? ""} ${choice.label ?? ""} ${choice.value ?? ""} ${choice.description ?? ""}`.toLowerCase();
    const positiveScore = preferred.reduce((sum, term) => sum + (text.includes(term.toLowerCase()) ? 20 : 0), 0);
    const negativeScore = negative.reduce((sum, term) => sum + (text.includes(term.toLowerCase()) ? 25 : 0), 0);
    const promptMatchScore = promptText.includes("adjust") && /looks good|proceed|approve|continue/.test(text) ? 20 : 0;
    return { choice, score: positiveScore + promptMatchScore - negativeScore - index };
  });
  scored.sort((left, right) => right.score - left.score);
  return scored[0]?.choice ?? choices[0];
}

function latestArtifactForThread(dashboard, threadId) {
  return (dashboard?.artifacts ?? [])
    .filter((artifact) => artifact.workflowThreadId === threadId)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
}

function latestRunForArtifact(dashboard, artifactId) {
  return (dashboard?.runs ?? [])
    .filter((run) => run.artifactId === artifactId)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
}

function assertScenarioEvidence(detail) {
  return assertWorkflowUiDogfoodEvidence(detail, {
    scenarioName,
    expectConfig: scenario.expect ?? {},
    maxRetainedRunEvents: scenario.maxRetainedRunEvents ?? maxRetainedRunEvents,
  });
}

async function assertScenarioSource(artifact) {
  const expectConfig = scenario.sourceExpect ?? {};
  const abstractionContract = scenario.abstractionContract;
  if (!scenario.sourceExpect && !abstractionContract) return undefined;
  if (!artifact.sourcePath)
    throw new Error(`Scenario ${scenarioName} requires generated source inspection, but artifact ${artifact.id} has no sourcePath.`);
  const source = await readFile(artifact.sourcePath, "utf8");
  const failures = [];
  for (const term of expectConfig.requiredTerms ?? []) {
    if (!source.includes(term)) failures.push(`expected generated source to include ${JSON.stringify(term)}`);
  }
  for (const terms of expectConfig.requiredAnyTerms ?? []) {
    if (!terms.some((term) => source.includes(term))) {
      failures.push(`expected generated source to include one of ${terms.map((term) => JSON.stringify(term)).join(", ")}`);
    }
  }
  for (const term of expectConfig.forbiddenTerms ?? []) {
    if (source.includes(term)) failures.push(`generated source must not include ${JSON.stringify(term)}`);
  }
  const manifestAssertions = assertArtifactManifest(
    artifact.manifest,
    mergeArtifactExpectation(expectConfig.manifest, abstractionContract?.manifest),
    failures,
  );
  const promptAssemblyAssertions = await assertArtifactPromptAssembly(
    artifact,
    mergeArtifactExpectation(expectConfig.promptAssembly, abstractionContract?.promptAssembly),
    failures,
  );
  const compileContextAssertions = await assertArtifactCompileContext(
    artifact,
    mergeArtifactExpectation(expectConfig.compileContext, abstractionContract?.compileContext),
    failures,
  );
  const validationReportAssertions = await assertArtifactValidationReport(
    artifact,
    mergeArtifactExpectation(expectConfig.validationReport, abstractionContract?.validationReport),
    failures,
  );
  const sourceAssertions = {
    passed: true,
    sourcePath: artifact.sourcePath,
    requiredTerms: expectConfig.requiredTerms ?? [],
    requiredAnyTerms: expectConfig.requiredAnyTerms ?? [],
    forbiddenTerms: expectConfig.forbiddenTerms ?? [],
    manifest: manifestAssertions,
    promptAssembly: promptAssemblyAssertions,
    compileContext: compileContextAssertions,
    validationReport: validationReportAssertions,
  };
  const abstractionContractAssertions = assertScenarioAbstractionContract(abstractionContract, sourceAssertions, failures);
  if (failures.length) {
    throw new Error(`Scenario ${scenarioName} generated source failed provenance gates: ${failures.join("; ")}`);
  }
  return {
    ...sourceAssertions,
    abstractionContract: abstractionContractAssertions,
  };
}

function mergeArtifactExpectation(primary, secondary) {
  if (!primary && !secondary) return undefined;
  const merged = { ...(secondary ?? {}), ...(primary ?? {}) };
  for (const key of [
    "requiredTools",
    "forbiddenTools",
    "requiredModuleIds",
    "forbiddenModuleIds",
    "forbiddenModuleFragments",
    "requiredRecipeIds",
    "forbiddenRecipeIds",
    "requiredRejectedRecipeIds",
    "requiredPolicyImplicationIds",
    "requiredValidatorIds",
    "requiredConnectorOperations",
    "forbiddenConnectorOperations",
  ]) {
    merged[key] = uniqueExpectationStrings(secondary?.[key], primary?.[key]);
    if (merged[key].length === 0) delete merged[key];
  }
  merged.requiredAnyTools = uniqueExpectationGroups(secondary?.requiredAnyTools, primary?.requiredAnyTools);
  if (merged.requiredAnyTools.length === 0) delete merged.requiredAnyTools;
  return merged;
}

function uniqueExpectationStrings(...values) {
  return [...new Set(values.flatMap((value) => (Array.isArray(value) ? value.map((item) => String(item)) : [])))];
}

function uniqueExpectationGroups(...values) {
  const groups = [];
  const seen = new Set();
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const group of value) {
      const normalized = (Array.isArray(group) ? group : [group]).map((item) => String(item));
      if (normalized.length === 0) continue;
      const key = JSON.stringify(normalized);
      if (seen.has(key)) continue;
      seen.add(key);
      groups.push(normalized);
    }
  }
  return groups;
}

function assertScenarioAbstractionContract(contract, sourceAssertions, failures) {
  if (!contract) return undefined;
  const promptAssembly = sourceAssertions.promptAssembly;
  const compileContext = sourceAssertions.compileContext;
  const validationReport = sourceAssertions.validationReport;
  const manifest = sourceAssertions.manifest;

  if (contract.promptAssembly && !promptAssembly) failures.push(`abstraction contract ${contract.id} expected prompt assembly metadata`);
  if (contract.compileContext && !compileContext) failures.push(`abstraction contract ${contract.id} expected compile context metadata`);
  if (contract.validationReport && !validationReport)
    failures.push(`abstraction contract ${contract.id} expected validation report metadata`);
  if (contract.manifest && !manifest) failures.push(`abstraction contract ${contract.id} expected manifest metadata`);

  const promptMetadata = promptAssemblyMetadataText(promptAssembly);
  for (const fragment of contract.forbiddenPromptAssemblyMetadataFragments ?? []) {
    if (promptMetadata.includes(String(fragment).toLowerCase())) {
      failures.push(
        `abstraction contract ${contract.id} prompt assembly metadata must not include fixture fragment ${JSON.stringify(fragment)}`,
      );
    }
  }

  return {
    passed: true,
    id: contract.id,
    contractType: contract.contractType,
    proves: contract.proves ?? [],
    promptAssembly: promptAssembly
      ? {
          moduleCount: promptAssembly.moduleCount,
          moduleIds: promptAssembly.moduleIds,
          requiredModuleIds: contract.promptAssembly?.requiredModuleIds ?? [],
          forbiddenModuleFragments: contract.promptAssembly?.forbiddenModuleFragments ?? [],
          forbiddenMetadataFragments: contract.forbiddenPromptAssemblyMetadataFragments ?? [],
        }
      : undefined,
    compileContext: compileContext
      ? {
          selectedRecipeIds: compileContext.selectedRecipeIds,
          rejectedRecipeIds: compileContext.rejectedRecipeIds,
          policyImplicationIds: compileContext.policyImplicationIds,
          requiredRecipeIds: contract.compileContext?.requiredRecipeIds ?? [],
          requiredRejectedRecipeIds: contract.compileContext?.requiredRejectedRecipeIds ?? [],
        }
      : undefined,
    validationReport: validationReport
      ? {
          status: validationReport.status,
          validatorIds: validationReport.validatorIds,
          mutationPolicy: validationReport.evidence?.mutationPolicy,
          connectorOperations: validationReport.evidence?.connectorOperations ?? [],
          connectorWriteOperationCount: validationReport.evidence?.connectorWriteOperationCount,
        }
      : undefined,
    manifest: manifest
      ? {
          mutationPolicy: manifest.mutationPolicy,
          tools: manifest.tools,
          connectors:
            manifest.connectors?.map((connector) => ({
              connectorId: connector.connectorId,
              scopes: connector.scopes,
              operations: connector.operations,
            })) ?? [],
        }
      : undefined,
  };
}

function promptAssemblyMetadataText(promptAssembly) {
  const modules = promptAssembly?.moduleSummaries ?? [];
  return modules
    .flatMap((module) => [
      module.id,
      module.layer,
      module.scope,
      module.reason,
      ...(module.ruleIds ?? []),
      ...(module.selectedRecipeIds ?? []),
      ...(module.selectedToolNames ?? []),
      ...(module.selectedConnectorIds ?? []),
    ])
    .join("\n")
    .toLowerCase();
}

async function assertArtifactValidationReport(artifact, expectConfig, failures) {
  if (!expectConfig) return undefined;
  const validationReportPath = join(dirname(artifact.sourcePath), "validation-report.json");
  let validationReport;
  try {
    validationReport = JSON.parse(await readFile(validationReportPath, "utf8"));
  } catch (error) {
    failures.push(`expected validation report metadata at ${validationReportPath}: ${error.message}`);
    return undefined;
  }
  if (expectConfig.status && validationReport.status !== expectConfig.status) {
    failures.push(`expected validation report status ${expectConfig.status}, saw ${validationReport.status ?? "none"}`);
  }
  const validatorIds = Array.isArray(validationReport.validators)
    ? validationReport.validators.map((validator) => String(validator.id ?? ""))
    : [];
  for (const required of expectConfig.requiredValidatorIds ?? []) {
    if (!validatorIds.includes(required)) failures.push(`expected validation report validator ${required}`);
  }
  const failedValidatorIds = Array.isArray(validationReport.validators)
    ? validationReport.validators.filter((validator) => validator.status === "failed").map((validator) => String(validator.id ?? ""))
    : [];
  if (expectConfig.forbidFailedValidators && failedValidatorIds.length > 0) {
    failures.push(`expected no failed validators, saw ${failedValidatorIds.join(", ")}`);
  }
  const evidence = validationReport.evidence && typeof validationReport.evidence === "object" ? validationReport.evidence : {};
  if (expectConfig.mutationPolicy && evidence.mutationPolicy !== expectConfig.mutationPolicy) {
    failures.push(`expected validation report mutationPolicy ${expectConfig.mutationPolicy}, saw ${evidence.mutationPolicy ?? "none"}`);
  }
  if (typeof expectConfig.maxConnectorWriteOperationCount === "number") {
    const writeCount = Array.isArray(evidence.connectorWriteOperations) ? evidence.connectorWriteOperations.length : 0;
    if (writeCount > expectConfig.maxConnectorWriteOperationCount) {
      failures.push(`expected at most ${expectConfig.maxConnectorWriteOperationCount} connector write operations, saw ${writeCount}`);
    }
  }
  if (typeof expectConfig.maxConnectorCalls === "number") {
    const maxConnectorCalls = typeof evidence.maxConnectorCalls === "number" ? evidence.maxConnectorCalls : Number.POSITIVE_INFINITY;
    if (maxConnectorCalls > expectConfig.maxConnectorCalls) {
      failures.push(`expected validation report maxConnectorCalls <= ${expectConfig.maxConnectorCalls}, saw ${maxConnectorCalls}`);
    }
  }
  const connectorOperationNames = Array.isArray(evidence.connectorOperations)
    ? evidence.connectorOperations.map((operation) => `${operation.connectorId}.${operation.operation}`)
    : [];
  for (const required of expectConfig.requiredConnectorOperations ?? []) {
    if (!connectorOperationNames.includes(required)) failures.push(`expected validation report connector operation ${required}`);
  }
  for (const forbidden of expectConfig.forbiddenConnectorOperations ?? []) {
    if (connectorOperationNames.includes(forbidden)) failures.push(`validation report must not include connector operation ${forbidden}`);
  }
  return {
    path: validationReportPath,
    status: validationReport.status,
    validatorIds,
    failedValidatorIds,
    evidence: {
      mutationPolicy: evidence.mutationPolicy,
      maxConnectorCalls: evidence.maxConnectorCalls,
      connectorWriteOperationCount: Array.isArray(evidence.connectorWriteOperations) ? evidence.connectorWriteOperations.length : 0,
      connectorOperations: connectorOperationNames,
    },
  };
}

async function assertArtifactPromptAssembly(artifact, expectConfig, failures) {
  if (!expectConfig) return undefined;
  const promptAssemblyPath = join(dirname(artifact.sourcePath), "prompt-assembly.json");
  let promptAssembly;
  try {
    promptAssembly = JSON.parse(await readFile(promptAssemblyPath, "utf8"));
  } catch (error) {
    failures.push(`expected prompt assembly metadata at ${promptAssemblyPath}: ${error.message}`);
    return undefined;
  }
  const moduleIds = Array.isArray(promptAssembly.modules) ? promptAssembly.modules.map((module) => String(module.id ?? "")) : [];
  const moduleSummaries = Array.isArray(promptAssembly.modules)
    ? promptAssembly.modules.map((module) => ({
        id: String(module.id ?? ""),
        layer: String(module.layer ?? ""),
        scope: String(module.scope ?? ""),
        reason: String(module.reason ?? ""),
        ruleIds: Array.isArray(module.ruleIds) ? module.ruleIds.map((id) => String(id)) : [],
        selectedRecipeIds: Array.isArray(module.selectedRecipeIds) ? module.selectedRecipeIds.map((id) => String(id)) : [],
        selectedToolNames: Array.isArray(module.selectedToolNames) ? module.selectedToolNames.map((name) => String(name)) : [],
        selectedConnectorIds: Array.isArray(module.selectedConnectorIds) ? module.selectedConnectorIds.map((id) => String(id)) : [],
      }))
    : [];
  if (!moduleIds.length) failures.push("expected prompt assembly modules to be recorded");
  for (const required of expectConfig.requiredModuleIds ?? []) {
    if (!moduleIds.includes(required)) failures.push(`expected prompt assembly module ${required}`);
  }
  for (const forbidden of expectConfig.forbiddenModuleIds ?? []) {
    if (moduleIds.includes(forbidden)) failures.push(`prompt assembly must not include module ${forbidden}`);
  }
  for (const fragment of expectConfig.forbiddenModuleFragments ?? []) {
    const match = moduleIds.find((moduleId) => moduleId.includes(fragment));
    if (match) failures.push(`prompt assembly module ${match} must not include forbidden fragment ${fragment}`);
  }
  return {
    path: promptAssemblyPath,
    moduleCount: moduleIds.length,
    moduleIds,
    moduleSummaries,
    requiredModuleIds: expectConfig.requiredModuleIds ?? [],
    forbiddenModuleFragments: expectConfig.forbiddenModuleFragments ?? [],
  };
}

async function assertArtifactCompileContext(artifact, expectConfig, failures) {
  if (!expectConfig) return undefined;
  const compileContextPath = join(dirname(artifact.sourcePath), "compile-context.json");
  let compileContext;
  try {
    compileContext = JSON.parse(await readFile(compileContextPath, "utf8"));
  } catch (error) {
    failures.push(`expected compile context metadata at ${compileContextPath}: ${error.message}`);
    return undefined;
  }
  const selectedRecipeIds = Array.isArray(compileContext.selectedRecipes)
    ? compileContext.selectedRecipes.map((recipe) => String(recipe.id ?? ""))
    : [];
  const recipeSelection =
    compileContext.recipeSelection && typeof compileContext.recipeSelection === "object" ? compileContext.recipeSelection : undefined;
  const rejectedRecipeIds = Array.isArray(recipeSelection?.rejected)
    ? recipeSelection.rejected.map((recipe) => String(recipe.id ?? ""))
    : [];
  const policyImplicationIds = Array.isArray(recipeSelection?.policyImplications)
    ? recipeSelection.policyImplications.map((implication) => String(implication.id ?? ""))
    : [];
  for (const required of expectConfig.requiredRecipeIds ?? []) {
    if (!selectedRecipeIds.includes(required)) failures.push(`expected compile context selected recipe ${required}`);
  }
  for (const forbidden of expectConfig.forbiddenRecipeIds ?? []) {
    if (selectedRecipeIds.includes(forbidden)) failures.push(`compile context must not include selected recipe ${forbidden}`);
  }
  for (const required of expectConfig.requiredRejectedRecipeIds ?? []) {
    if (!rejectedRecipeIds.includes(required)) failures.push(`expected compile context rejected recipe ${required}`);
  }
  for (const required of expectConfig.requiredPolicyImplicationIds ?? []) {
    if (!policyImplicationIds.includes(required)) failures.push(`expected compile context recipe policy implication ${required}`);
  }
  if (typeof expectConfig.minSelectedRecipeCount === "number" && selectedRecipeIds.length < expectConfig.minSelectedRecipeCount) {
    failures.push(`expected at least ${expectConfig.minSelectedRecipeCount} selected recipes, saw ${selectedRecipeIds.length}`);
  }
  if (typeof expectConfig.maxSelectedRecipeCount === "number" && selectedRecipeIds.length > expectConfig.maxSelectedRecipeCount) {
    failures.push(`expected at most ${expectConfig.maxSelectedRecipeCount} selected recipes, saw ${selectedRecipeIds.length}`);
  }
  if (typeof expectConfig.minRejectedRecipeCount === "number" && rejectedRecipeIds.length < expectConfig.minRejectedRecipeCount) {
    failures.push(`expected at least ${expectConfig.minRejectedRecipeCount} rejected recipes, saw ${rejectedRecipeIds.length}`);
  }
  return {
    path: compileContextPath,
    selectedRecipeIds,
    rejectedRecipeIds,
    policyImplicationIds,
    requiredRecipeIds: expectConfig.requiredRecipeIds ?? [],
    requiredRejectedRecipeIds: expectConfig.requiredRejectedRecipeIds ?? [],
  };
}

function assertArtifactManifest(manifest, expectConfig, failures) {
  if (!expectConfig) return undefined;
  if (!manifest || typeof manifest !== "object") {
    failures.push("expected artifact manifest to be inspectable");
    return undefined;
  }
  if (expectConfig.mutationPolicy && manifest.mutationPolicy !== expectConfig.mutationPolicy) {
    failures.push(`expected manifest mutationPolicy ${expectConfig.mutationPolicy}, saw ${manifest.mutationPolicy ?? "none"}`);
  }
  const tools = Array.isArray(manifest.tools) ? manifest.tools : [];
  for (const required of expectConfig.requiredTools ?? []) {
    if (!tools.includes(required)) failures.push(`expected manifest tool ${required}`);
  }
  for (const requiredGroup of expectConfig.requiredAnyTools ?? []) {
    const values = Array.isArray(requiredGroup) ? requiredGroup.map(String) : [String(requiredGroup)];
    if (!values.some((tool) => tools.includes(tool))) failures.push(`expected one of manifest tools ${values.join(", ")}`);
  }
  for (const forbidden of expectConfig.forbiddenTools ?? []) {
    if (tools.includes(forbidden)) failures.push(`manifest must not grant tool ${forbidden}`);
  }
  const connectors = Array.isArray(manifest.connectors) ? manifest.connectors : [];
  for (const expected of expectConfig.connectors ?? []) {
    const grant = connectors.find((candidate) => candidate.connectorId === expected.connectorId);
    if (!grant) {
      failures.push(`expected manifest connector grant ${expected.connectorId}`);
      continue;
    }
    for (const operation of expected.requiredOperations ?? []) {
      if (!Array.isArray(grant.operations) || !grant.operations.includes(operation)) {
        failures.push(`expected manifest connector ${expected.connectorId} operation ${operation}`);
      }
    }
    for (const operation of expected.forbiddenOperations ?? []) {
      if (Array.isArray(grant.operations) && grant.operations.includes(operation)) {
        failures.push(`manifest connector ${expected.connectorId} must not grant operation ${operation}`);
      }
    }
    for (const scope of expected.requiredScopes ?? []) {
      if (!Array.isArray(grant.scopes) || !grant.scopes.includes(scope)) {
        failures.push(`expected manifest connector ${expected.connectorId} scope ${scope}`);
      }
    }
    for (const scope of expected.forbiddenScopes ?? []) {
      if (Array.isArray(grant.scopes) && grant.scopes.includes(scope)) {
        failures.push(`manifest connector ${expected.connectorId} must not grant scope ${scope}`);
      }
    }
  }
  return manifestEvidence(manifest);
}

function manifestEvidence(manifest) {
  if (!manifest || typeof manifest !== "object") return undefined;
  return {
    mutationPolicy: manifest.mutationPolicy,
    tools: Array.isArray(manifest.tools) ? manifest.tools : [],
    connectors: Array.isArray(manifest.connectors)
      ? manifest.connectors.map((connector) => ({
          connectorId: connector.connectorId,
          accountId: connector.accountId,
          scopes: connector.scopes,
          operations: connector.operations,
          dataRetention: connector.dataRetention,
        }))
      : [],
    maxToolCalls: manifest.maxToolCalls,
    maxConnectorCalls: manifest.maxConnectorCalls,
    maxModelCalls: manifest.maxModelCalls,
  };
}

async function launchApp() {
  const child = spawn("pnpm", ["exec", "electron-vite", "dev", "--remoteDebuggingPort", String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...launchConfig.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  child.stdout.on("data", (chunk) => appOutput.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => appOutput.push(chunk.toString("utf8")));
  const target = await waitForPageEndpoint(port);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await command(cdp, "Page.enable");
  await command(cdp, "Runtime.enable");
  await command(cdp, "Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 920,
    deviceScaleFactor: 1,
    mobile: false,
  });
  return { child, cdp };
}

async function desktopState(cdp) {
  return evaluate(cdp, "window.ambientDesktop.bootstrap()", { timeoutMs: 60_000 });
}

async function ensureScenarioPermissionMode(cdp, state) {
  const permissionMode = scenarioPermissionMode();
  if (!permissionMode) return;
  const activeThreadId = state?.activeThreadId;
  if (!activeThreadId)
    throw new Error(`Scenario ${scenarioName} requires ${permissionMode} permission mode but the active thread id is unavailable.`);
  const activeThread = state.threads?.find((thread) => thread.id === activeThreadId);
  if (activeThread?.permissionMode === permissionMode) return;
  await liveStep(
    cdp,
    `set scenario permission mode ${permissionMode}`,
    `window.ambientDesktop.requestThreadPermissionModeChange(${JSON.stringify({
      threadId: activeThreadId,
      permissionMode,
      reason: `Workflow UI dogfood scenario ${scenarioName} requires deterministic ${permissionMode} validation in temp snapshot state.`,
    })})`,
    { timeoutMs: 60_000 },
  );
}

async function ensureWorkflowThreadPermissionMode(cdp, thread) {
  const permissionMode = scenarioPermissionMode();
  if (!permissionMode) return thread;
  const ensuredThread = await liveStep(
    cdp,
    `ensure workflow chat thread for ${permissionMode}`,
    `window.ambientDesktop.ensureWorkflowAgentChatThread(${JSON.stringify({ workflowThreadId: thread.id })})`,
    { timeoutMs: 60_000 },
  );
  const chatThreadId = ensuredThread?.chatThreadId;
  if (!chatThreadId) throw new Error(`Workflow thread ${thread.id} did not expose an associated chat thread for ${permissionMode} mode.`);
  await liveStep(
    cdp,
    `set workflow chat permission mode ${permissionMode}`,
    `window.ambientDesktop.requestThreadPermissionModeChange(${JSON.stringify({
      threadId: chatThreadId,
      permissionMode,
      reason: `Workflow UI dogfood scenario ${scenarioName} runs the workflow chat thread in deterministic ${permissionMode} mode.`,
    })})`,
    { timeoutMs: 60_000 },
  );
  return ensuredThread;
}

async function clickButtonText(cdp, text) {
  await clickText(cdp, text, { buttonOnly: true });
}

async function clickText(cdp, text, options = {}) {
  const result = await evaluate(
    cdp,
    `(() => {
      const text = ${JSON.stringify(text)};
      const buttonOnly = ${JSON.stringify(Boolean(options.buttonOnly))};
      const candidates = Array.from(document.querySelectorAll(buttonOnly ? 'button, [role="button"]' : 'button, [role="button"], a, [data-panel-target], .thread-list-item, .task-row, article'));
      const exact = candidates.find((el) => (el.textContent || '').trim() === text);
      const partial = candidates.find((el) => (el.textContent || '').includes(text));
      const target = exact || partial;
      if (!target) return { clicked: false, candidates: candidates.slice(0, 25).map((el) => (el.textContent || '').trim()).filter(Boolean) };
      target.scrollIntoView({ block: 'center', inline: 'center' });
      target.click();
      return { clicked: true, text: (target.textContent || '').trim().slice(0, 120) };
    })()`,
    { timeoutMs: 30_000 },
  );
  if (!result?.clicked) {
    throw new Error(`Could not click text "${text}". Visible candidates: ${(result?.candidates ?? []).join(" | ")}`);
  }
}

async function captureScreenshot(cdp, name) {
  const response = await command(cdp, "Page.captureScreenshot", { format: "png", fromSurface: true });
  const bytes = Buffer.from(response.data, "base64");
  const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}.png`;
  const path = join(screenshotsDir, fileName);
  await writeFile(path, bytes);
  return {
    name,
    path,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function collectFailureEvidence(cdp) {
  const ui = await evaluate(
    cdp,
    `(() => ({
      title: document.title,
      url: location.href,
      bodyTextPreview: document.body?.innerText?.slice(0, 8000) ?? "",
      activeMode: document.querySelector('[data-mode]')?.getAttribute('data-mode') ?? "",
      activeBuildPanel: document.querySelector('[data-workflow-build-panel]')?.getAttribute('data-workflow-build-panel') ?? "",
      activeRunsPanel: document.querySelector('[data-workflow-runs-panel]')?.getAttribute('data-workflow-runs-panel') ?? "",
      hasDiagram: Boolean(document.querySelector('.workflow-persistent-diagram-pane')),
      visibleChars: document.body?.innerText?.length ?? 0,
      textHotspots: Array.from(document.querySelectorAll('[data-mode], section, article, main, aside'))
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          id: element.id || "",
          className: typeof element.className === "string" ? element.className.slice(0, 160) : "",
          dataMode: element.getAttribute("data-mode") || "",
          dataPanel:
            element.getAttribute("data-workflow-build-panel") ||
            element.getAttribute("data-workflow-runs-panel") ||
            element.getAttribute("data-workflow-schedules-panel") ||
            "",
          chars: (element.innerText || "").length,
        }))
        .filter((entry) => entry.chars > 0)
        .sort((a, b) => b.chars - a.chars)
        .slice(0, 12),
    }))()`,
    { timeoutMs: 30_000 },
  );
  const screenshot = await captureScreenshot(cdp, "failure");
  return { ui, screenshot };
}

async function evaluate(cdp, expression, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const response = await command(
    cdp,
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: timeoutMs,
    },
    timeoutMs,
  );
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text || response.exceptionDetails.exception?.description || "Runtime.evaluate failed");
  }
  return response.result?.value;
}

async function waitFor(cdp, predicate, description, timeoutMs = 30_000, args = []) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await evaluate(cdp, `(${predicate.toString()})(...${JSON.stringify(args)})`, {
        timeoutMs: Math.min(10_000, timeoutMs),
      });
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`);
}

async function waitForPageEndpoint(debugPort) {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_500);
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: controller.signal });
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Electron is still starting.
    } finally {
      clearTimeout(timer);
    }
    await delay(300);
  }
  throw new Error(`Timed out waiting for Electron CDP endpoint on port ${debugPort}.`);
}

async function connectCdp(url) {
  const ws = new WebSocket(url);
  await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`Timed out connecting to ${url}`)), 15_000);
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolvePromise();
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      (event) => {
        clearTimeout(timer);
        rejectPromise(new Error(`CDP websocket error: ${event.message ?? "unknown"}`));
      },
      { once: true },
    );
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
    if (!payload.id) return;
    const entry = pending.get(payload.id);
    if (!entry) return;
    pending.delete(payload.id);
    clearTimeout(entry.timer);
    if (payload.error) entry.reject(new Error(payload.error.message));
    else entry.resolve(payload.result ?? {});
  });
  return {
    close: () => ws.close(),
    send(method, params = {}, timeoutMs = 30_000) {
      const messageId = ++id;
      ws.send(JSON.stringify({ id: messageId, method, params }));
      return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          pending.delete(messageId);
          rejectPromise(new Error(`${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(messageId, { resolve: resolvePromise, reject: rejectPromise, timer });
      });
    },
  };
}

function command(cdp, method, params = {}, timeoutMs = 30_000) {
  return cdp.send(method, params, timeoutMs);
}

async function terminateProcessTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    // Process already exited.
  }
  await delay(1200);
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    // Process already exited.
  }
}

async function writeReport(data) {
  await mkdir(scenarioReportRoot, { recursive: true });
  await mkdir(harnessReportRoot, { recursive: true });
  await mkdir(reportRoot, { recursive: true });
  await writeFile(join(harnessReportRoot, "report.json"), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await writeFile(join(scenarioReportRoot, "latest.json"), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await writeFile(join(reportRoot, `${scenarioName}.json`), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await writeFile(join(reportRoot, "latest.json"), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function compactReport(data) {
  const abstractionContract = data.abstractionContract ?? data.sourceAssertions?.abstractionContract;
  return {
    ok: data.ok,
    scenario: data.scenario,
    harness: data.harness,
    launch: data.launch,
    thread: data.thread?.title,
    artifact: data.artifact?.title,
    runStatus: data.run?.status,
    runEvidence: data.runEvidence,
    scenarioAssertions: data.scenarioAssertions?.passed,
    abstractionContract: abstractionContract
      ? {
          id: abstractionContract.id,
          contractType: abstractionContract.contractType,
          promptModules: abstractionContract.promptAssembly?.moduleIds,
          selectedRecipes: abstractionContract.compileContext?.selectedRecipeIds,
          validators: abstractionContract.validationReport?.validatorIds,
          mutationPolicy: abstractionContract.manifest?.mutationPolicy ?? abstractionContract.validationReport?.mutationPolicy,
        }
      : undefined,
    uiAssertions: data.uiAssertions?.passed,
    screenshots: (data.screenshots ?? []).map((shot) => basename(shot.path)),
  };
}

function classifyDogfoodFailure(errorMessageText, failureEvidence) {
  const text = `${errorMessageText}\n${JSON.stringify(failureEvidence ?? {})}`;
  if (/llama-server was not found|AMBIENT_MINICPM_V_LLAMA_SERVER|MiniCPM-V runtime|needs-runtime/i.test(text)) {
    return "environment/snapshot issue";
  }
  if (
    /Workflow connector is not available|not_configured|connecting|expired|revoked|Google.*not configured|Gmail.*not configured|Gmail.*not available|OAuth|connector auth/i.test(
      text,
    )
  ) {
    return "environment/snapshot issue";
  }
  if (/\b429\b|rate limit|did not start streaming|stream stalled|provider idle|no-stream/i.test(text)) {
    return "provider-degraded";
  }
  if (
    /timed out waiting|CDP|Electron|Runtime\.evaluate|renderer poll|Could not find an actionable failed event|permission prompt/i.test(text)
  ) {
    return "test harness failure";
  }
  if (
    /Scenario evidence assertions failed|generated source failed provenance gates|Expected workflow run to succeed|Compile failed|workflow run .* failed/i.test(
      text,
    )
  ) {
    return "product failure";
  }
  return "unclassified";
}

function harnessReportMetadata() {
  return {
    name: harnessName,
    runId: harnessRunId,
    reportPath: join(harnessReportRoot, "report.json"),
    scenarioLatestPath: join(scenarioReportRoot, "latest.json"),
    snapshotMode: stateDirs.snapshotMode,
    snapshotRootLabel: stateDirs.snapshotRootLabel,
    snapshotRootPathDigest: stateDirs.snapshotRootPathDigest,
    pathsAreMachineLocal: true,
  };
}

function safeFilePart(value) {
  return (
    String(value)
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 140) || "workflow-ui-dogfood-run"
  );
}

function outputTail() {
  return appOutput.join("").split("\n").slice(-160).join("\n");
}

function pick(value, keys) {
  if (!value) return undefined;
  return Object.fromEntries(keys.map((key) => [key, value[key]]).filter(([, item]) => item !== undefined));
}

function valueForArg(name) {
  const prefix = `${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

function envFlag(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

function permissionModeForValue(value) {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const normalized = String(value).trim();
  if (normalized === "full-access" || normalized === "workspace") return normalized;
  throw new Error(`Unsupported workflow UI dogfood permission mode ${JSON.stringify(value)}. Expected full-access or workspace.`);
}

function scenarioPermissionMode() {
  return forcedPermissionMode ?? scenario.permissionMode;
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
