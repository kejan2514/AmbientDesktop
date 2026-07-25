#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const outputRoot = resolve(process.env.AMBIENT_KANBAN_TODO_DEDUPER_BUNDLE_OUT_DIR || join(tmpdir(), "ambient-kanban-todo-deduper-implementation-bundle-gmi"));
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = join(outputRoot, "runs", runStamp);
const workspace = join(runRoot, "workspace");
const userData = join(runRoot, "userData");
const reportPath = resolve(process.env.AMBIENT_KANBAN_TODO_DEDUPER_BUNDLE_OUT || join(outputRoot, "latest.json"));
const boardScreenshotPath = join(runRoot, "phase4-todo-deduper-board.png");
const bundleScreenshotPath = join(runRoot, "phase4-todo-deduper-bundles.png");
const cdpPort = Number(process.env.AMBIENT_KANBAN_TODO_DEDUPER_BUNDLE_CDP_PORT || 0) || (await availablePort());
const workerIdleTimeoutMs = Number(process.env.AMBIENT_KANBAN_TODO_DEDUPER_BUNDLE_IDLE_TIMEOUT_MS || 0) || 240_000;
const workerRunMaxElapsedMs = Number(process.env.AMBIENT_KANBAN_TODO_DEDUPER_BUNDLE_MAX_TIMEOUT_MS || 0) || 900_000;
const defaultRepoKeyFile = join(repoRoot, "ignored-provider-key-file.txt");
const defaultHomeCheckoutKeyFile = join(homedir(), "ambientCoder", "ignored-provider-key-file.txt");
const keyFile = resolve(process.env.GMI_CLOUD_API_KEY_FILE || (existsSync(defaultRepoKeyFile) ? defaultRepoKeyFile : defaultHomeCheckoutKeyFile));
const defaultSnapshotWorkspace = join(homedir(), "Documents", "ambientCoderArchive");
const sourceWorkspace =
  process.env.AMBIENT_KANBAN_TODO_DEDUPER_BUNDLE_SNAPSHOT_WORKSPACE ||
  process.env.AMBIENT_DESKTOP_WORKSPACE ||
  (existsSync(defaultSnapshotWorkspace) ? defaultSnapshotWorkspace : "");
const sourceUserData = process.env.AMBIENT_KANBAN_TODO_DEDUPER_BUNDLE_SNAPSHOT_USER_DATA || process.env.AMBIENT_E2E_USER_DATA || "";

const cards = {
  fixtures: {
    key: "fixtures",
    title: `Phase 4 Gate B todo fixtures ${runStamp}`,
    expectedFiles: ["fixtures/todos.json", "fixtures/expected-unique.json", "tests/verify-todo-fixtures.mjs"],
  },
  implementation: {
    key: "implementation",
    title: `Phase 4 Gate B todo deduper implementation ${runStamp}`,
    expectedFiles: ["src/dedupeTodos.mjs", "dedupe-report.json"],
  },
  tests: {
    key: "tests",
    title: `Phase 4 Gate B todo deduper tests ${runStamp}`,
    expectedFiles: ["tests/dedupeTodos.test.mjs", "test-results/todo-deduper.json"],
  },
};

const output = [];
let app;
let cdp;

try {
  if (!sourceWorkspace || !existsSync(sourceWorkspace)) {
    throw new Error("Set AMBIENT_KANBAN_TODO_DEDUPER_BUNDLE_SNAPSHOT_WORKSPACE to a local snapshot workspace directory.");
  }
  if (!existsSync(keyFile) && !process.env.GMI_CLOUD_API_KEY && !process.env.GMI_API_KEY) {
    throw new Error("Set GMI_CLOUD_API_KEY_FILE, GMI_CLOUD_API_KEY, or GMI_API_KEY before running the GMI Todo Deduper bundle gate.");
  }

  await prepareRunState();
  app = await launchApp();
  cdp = await connectCdp(app.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await waitFor(() => document.body?.innerText.includes("Ambient"), "Ambient shell", 120_000);

  const initialState = await invoke("bootstrap");
  const provider = initialState.provider;
  if (provider.providerId !== "gmi-cloud") throw new Error(`Expected gmi-cloud provider, got ${provider.providerId ?? "missing"}.`);
  if (!provider.hasApiKey) throw new Error("GMI provider launched without a visible API key.");
  await invoke("setOrchestrationAutoDispatchEnabled", { enabled: false }).catch(() => undefined);

  const { board, cardByKey } = await createBoardAndCards();
  await openProjectBoard();
  await clickProjectBoardTab("Board");
  await captureScreenshot(boardScreenshotPath);

  const fixtures = await approveRunAndVerifyCard(cardByKey.fixtures, cards.fixtures);
  const implementation = await approveRunAndVerifyCard(cardByKey.implementation, cards.implementation, {
    expectedDependencyFiles: ["fixtures/todos.json", "fixtures/expected-unique.json"],
  });
  const tests = await approveRunAndVerifyCard(cardByKey.tests, cards.tests, {
    useUiStart: true,
    descriptionIncludes: [
      "Dependency execution context:",
      "Ambient imports material files from available dependencies",
      "Declared import files: fixtures/todos.json",
      "Declared import files: src/dedupeTodos.mjs",
    ],
    descriptionExcludes: ["reconstruct code from prose", "rewrite the implementation from description"],
    expectedDependencyFiles: ["fixtures/todos.json", "fixtures/expected-unique.json", "src/dedupeTodos.mjs"],
    expectedImportCount: 2,
  });

  const testSummary = await assertTodoDeduperTestResult(join(tests.run.workspacePath, "test-results", "todo-deduper.json"));
  const dependencyManifest = await assertDependencyImportBundle(tests.run, ["fixtures/todos.json", "fixtures/expected-unique.json", "src/dedupeTodos.mjs"]);
  await captureScreenshot(bundleScreenshotPath);

  const report = {
    status: "passed",
    providerId: provider.providerId,
    usedGmiKeyFile: existsSync(keyFile),
    sourceWorkspace,
    usedSnapshotUserData: Boolean(sourceUserData && existsSync(sourceUserData)),
    runRoot,
    boardId: board.id,
    cards: [fixtures, implementation, tests].map((item) => ({
      key: item.spec.key,
      cardId: item.card.id,
      taskId: item.card.orchestrationTaskId,
      runId: item.run.id,
      runStatus: item.run.status,
      runWorkspacePath: item.run.workspacePath,
      changedPaths: item.changedPaths,
      taskActions: item.taskActions,
      proofReview: item.reviewedCard.proofReview,
      dependencyArtifacts: summarizeDependencyArtifacts(item.dependencyArtifacts),
    })),
    testSummary,
    testDependencyImportCount: dependencyManifest.imports.length,
    screenshots: { board: boardScreenshotPath, dependencyBundles: bundleScreenshotPath },
    assertions: [
      "Fixture and implementation cards completed before the test card was prepared",
      "Implementation card consumed imported fixture artifacts and published src/dedupeTodos.mjs",
      "Final test card was prepared and started through visible Desktop UI controls",
      "Final test card started with both fixture and implementation dependency bundles available under .ambient/dependency-artifacts",
      "Final tests imported implementation code from the implementation bundle instead of reconstructing it from prose",
      "Final test-results/todo-deduper.json proves dedupe output matched the expected unique fixture set",
    ],
  };
  await writeReport(report);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const report = {
    status: "failed",
    classification: classifyHarnessFailure(error),
    message: error instanceof Error ? error.message : String(error),
    runRoot,
    outputTail: output.join("").split("\n").slice(-180),
  };
  await writeReport(report).catch(() => undefined);
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  cdp?.close();
  if (app?.child) await terminateProcess(app.child);
}

async function prepareRunState() {
  await rm(runRoot, { recursive: true, force: true });
  await mkdir(runRoot, { recursive: true });
  await cp(sourceWorkspace, workspace, { recursive: true });
  if (sourceUserData && existsSync(sourceUserData)) {
    await cp(sourceUserData, userData, { recursive: true });
    for (const name of ["SingletonCookie", "SingletonLock", "SingletonSocket"]) {
      await rm(join(userData, name), { force: true });
    }
  } else {
    await mkdir(userData, { recursive: true });
  }
}

async function launchApp() {
  const child = spawn("pnpm", ["exec", "electron-vite", "dev", "--remoteDebuggingPort", String(cdpPort)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AMBIENT_PROVIDER: "gmi-cloud",
      GMI_CLOUD_API_KEY_FILE: keyFile,
      AMBIENT_DESKTOP_WORKSPACE: workspace,
      AMBIENT_E2E: "1",
      AMBIENT_E2E_USER_DATA: userData,
      AMBIENT_DESKTOP_BOOTSTRAP_WATCHDOG_MS: process.env.AMBIENT_DESKTOP_BOOTSTRAP_WATCHDOG_MS ?? "180000",
      AMBIENT_E2E_SKIP_PROJECT_BOARD_SOURCE_REFRESH: "1",
      AMBIENT_CODEX_CURATED_MARKETPLACE_URL: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));
  const target = await waitForPageEndpoint(child);
  return { child, webSocketDebuggerUrl: target.webSocketDebuggerUrl };
}

async function createBoardAndCards() {
  const initialState = await invoke("bootstrap");
  const activeProject = initialState.projects.find((project) => project.path === initialState.workspace.path) ?? initialState.projects[0];
  if (!activeProject) throw new Error("No active project available for Todo Deduper bundle gate.");
  const stateWithBoard = activeProject.board
    ? initialState
    : await invoke("createProjectBoard", {
        projectId: activeProject.id,
        title: "Phase 4 Todo Deduper Implementation Bundle Gate Board",
        summary: "Live Gate B proof for fixture and implementation dependency bundles.",
      });
  let board = boardFromState(stateWithBoard);
  if (board.status !== "active") {
    board = boardFromState(await invoke("updateProjectBoardStatus", { boardId: board.id, status: "active" }));
  }

  const fixtures = await createReadyCard(board.id, cards.fixtures.title, fixtureDescription(), {
    priority: 1,
    labels: ["phase-4", "dependency-artifacts", "todo-deduper", "fixtures", "live-gmi"],
    blockedBy: [],
    acceptanceCriteria: [
      "Create duplicate todo fixture data and expected unique output.",
      "Create a verifier that checks duplicates and expected unique ids.",
      "Report project-board proof with fixture files and verifier in changedFiles.",
    ],
    testPlan: {
      unit: ["Run node tests/verify-todo-fixtures.mjs."],
      integration: [],
      visual: [],
      manual: [],
    },
  });

  const implementation = await createReadyCard(board.id, cards.implementation.title, implementationDescription(), {
    priority: 2,
    labels: ["phase-4", "dependency-artifacts", "todo-deduper", "implementation", "live-gmi"],
    blockedBy: [fixtures.id],
    acceptanceCriteria: [
      "Use imported fixture artifacts as implementation input.",
      "Create src/dedupeTodos.mjs exporting dedupeTodos.",
      "Run the implementation against imported fixtures and write dedupe-report.json.",
    ],
    testPlan: {
      unit: ["Run node --check src/dedupeTodos.mjs."],
      integration: ["Run src/dedupeTodos.mjs or a small Node command against imported fixture todos."],
      visual: [],
      manual: [],
    },
  });

  const tests = await createReadyCard(board.id, cards.tests.title, testsDescription(), {
    priority: 3,
    labels: ["phase-4", "dependency-artifacts", "todo-deduper", "tests", "live-gmi"],
    blockedBy: [fixtures.id, implementation.id],
    acceptanceCriteria: [
      "Read both fixture and implementation imports from .ambient/dependency-artifacts/manifest.json.",
      "Create tests/dedupeTodos.test.mjs that imports dedupeTodos from the implementation bundle.",
      "Run the tests from this prepared task workspace and write test-results/todo-deduper.json.",
    ],
    testPlan: {
      unit: ["Run node tests/dedupeTodos.test.mjs."],
      integration: ["Verify dedupe output against the imported fixture expected-unique data."],
      visual: [],
      manual: [],
    },
  });

  board = boardFromState(await invoke("bootstrap"));
  return { board, cardByKey: { fixtures, implementation, tests } };
}

async function createReadyCard(boardId, title, description, fields) {
  let board = boardFromState(await invoke("bootstrap"));
  const beforeIds = new Set(board.cards.map((card) => card.id));
  let state = await invoke("createProjectBoardCard", {
    boardId,
    title,
    description: description.slice(0, 1000),
  });
  board = boardFromState(state);
  const created = board.cards.find((card) => !beforeIds.has(card.id) && card.sourceKind === "manual");
  if (!created) throw new Error(`Manual card was not created: ${title}`);
  state = await invoke("updateProjectBoardCard", {
    cardId: created.id,
    title,
    description,
    candidateStatus: "ready_to_create",
    priority: fields.priority,
    phase: "Phase 4 Gate B",
    labels: fields.labels,
    blockedBy: fields.blockedBy,
    acceptanceCriteria: fields.acceptanceCriteria,
    testPlan: fields.testPlan,
    clarificationQuestions: [],
  });
  board = boardFromState(state);
  const ready = board.cards.find((card) => card.id === created.id);
  if (!ready || ready.candidateStatus !== "ready_to_create") throw new Error(`Card did not become ready_to_create: ${title}`);
  return ready;
}

function fixtureDescription() {
  return [
    "Create deterministic Todo Deduper fixture files in this card's writable task workspace. Do not modify the owning project root directly.",
    "",
    "Required files:",
    "- fixtures/todos.json: JSON array with five todo objects. Include duplicates by id: alpha appears twice and gamma appears twice. Each object must have id, title, and completed.",
    "- fixtures/expected-unique.json: JSON array with the first occurrence of each unique id in original order: alpha, beta, gamma.",
    "- tests/verify-todo-fixtures.mjs: dependency-free Node verifier that reads both fixture files, asserts duplicate source ids, expected unique ids, and valid object fields.",
    "",
    "Verification command to run from the task workspace:",
    "- node tests/verify-todo-fixtures.mjs",
    "",
    "Project-board reporting contract:",
    "- First, call native task_heartbeat with the immediate plan before editing files. If native task tools are unavailable, emit a fenced task_actions JSON fallback.",
    "- After writing and verifying files, call task_report_proof with changedFiles exactly including fixtures/todos.json, fixtures/expected-unique.json, and tests/verify-todo-fixtures.mjs, and commands including node tests/verify-todo-fixtures.mjs.",
    "- Then call task_complete only when those files and commands are complete.",
    "- Do not install dependencies, call network services, read secrets, or write outside the task workspace.",
  ].join("\n");
}

function implementationDescription() {
  return [
    "Create a dependency-free Todo Deduper implementation in this card's writable task workspace. Do not modify the owning project root directly.",
    "",
    "Dependency artifact contract:",
    "- Read .ambient/dependency-artifacts/manifest.json and use the imported fixture bundle's filesRoot as the source of fixture data.",
    "- Use imported fixture files for implementation verification. Do not copy from raw sibling task workspaces.",
    "- Runtime files under .ambient/ are not material deliverables. Do not report .ambient/dependency-artifacts in changedFiles.",
    "",
    "Required files:",
    "- src/dedupeTodos.mjs: dependency-free Node ESM module exporting dedupeTodos(todos). It must keep the first todo for each id in input order and preserve object fields.",
    "- dedupe-report.json: report generated by running dedupeTodos against the imported fixtures. It must include sourceCount, uniqueCount, uniqueIds, matchedExpected, and implementationImportSource.",
    "",
    "Verification commands to run from the task workspace:",
    "- node --check src/dedupeTodos.mjs",
    "- node src/dedupeTodos.mjs --input <fixture-filesRoot>/fixtures/todos.json --expected <fixture-filesRoot>/fixtures/expected-unique.json --report dedupe-report.json",
    "",
    "Project-board reporting contract:",
    "- First, call native task_heartbeat with the immediate plan before editing files.",
    "- After writing and verifying files, call task_report_proof with changedFiles exactly including src/dedupeTodos.mjs and dedupe-report.json, commands including both verification commands, and dependencyImports including the imported fixture filesRoot.",
    "- Then call task_complete only when those files and commands are complete.",
    "- Do not install dependencies, call network services, read secrets, or write outside the task workspace.",
  ].join("\n");
}

function testsDescription() {
  return [
    "Create Todo Deduper tests in this card's writable task workspace. Do not modify the owning project root directly.",
    "",
    "Dependency artifact contract:",
    "- Read .ambient/dependency-artifacts/manifest.json and locate both imported bundles: one with fixtures/todos.json and one with src/dedupeTodos.mjs.",
    "- Import dedupeTodos directly from the implementation bundle filesRoot. Do not reconstruct, rewrite, or reimplement the deduper from prose.",
    "- Read fixture inputs directly from the fixture bundle filesRoot. Keep all test outputs inside this task workspace.",
    "- Runtime files under .ambient/ are not material deliverables. Do not report .ambient/dependency-artifacts in changedFiles.",
    "",
    "Required files:",
    "- tests/dedupeTodos.test.mjs: dependency-free Node ESM test that reads .ambient/dependency-artifacts/manifest.json, imports dedupeTodos from the implementation bundle, reads fixture todos/expected-unique, asserts exact output equality, and writes test-results/todo-deduper.json.",
    "- test-results/todo-deduper.json: JSON proof report with passed true, sourceCount 5, uniqueCount 3, uniqueIds ['alpha','beta','gamma'], implementationBundle path, fixtureBundle path, and matchedExpected true.",
    "",
    "Verification command to run from the task workspace:",
    "- node tests/dedupeTodos.test.mjs",
    "",
    "Project-board reporting contract:",
    "- First, call native task_heartbeat with the immediate plan before editing files.",
    "- After writing and verifying files, call task_report_proof with changedFiles exactly including tests/dedupeTodos.test.mjs and test-results/todo-deduper.json, commands including node tests/dedupeTodos.test.mjs, and dependencyImports including both imported bundle filesRoot paths.",
    "- Then call task_complete only when those files and commands are complete.",
    "- Do not install dependencies, call network services, read secrets, or write outside the task workspace.",
  ].join("\n");
}

async function approveRunAndVerifyCard(card, spec, expectations = {}) {
  const state = await invoke("approveProjectBoardCard", { cardId: card.id });
  const board = boardFromState(state);
  const ticketized = board.cards.find((candidate) => candidate.id === card.id);
  if (!ticketized?.orchestrationTaskId) throw new Error(`${spec.title} was not ticketized into a Local Task.`);

  const task = await waitForTask(ticketized.orchestrationTaskId);
  const taskDescription = String(task.description || "");
  for (const text of expectations.descriptionIncludes ?? []) {
    if (!taskDescription.includes(text)) throw new Error(`${spec.title} task description did not include expected text: ${text}`);
  }
  for (const text of expectations.descriptionExcludes ?? []) {
    if (taskDescription.includes(text)) throw new Error(`${spec.title} task description included forbidden text: ${text}`);
  }

  const { run: preparedRun } = expectations.useUiStart
    ? await prepareRunViaUi(ticketized.orchestrationTaskId, spec.title)
    : await prepareRunViaBridge(ticketized.orchestrationTaskId, spec.title);
  const dependencyArtifacts = await dependencyArtifactsForPreparedRun(preparedRun, expectations.expectedDependencyFiles, expectations.expectedImportCount);
  const run = expectations.useUiStart ? await startRunViaUi(preparedRun.id, spec.title) : await startRunViaBridge(preparedRun.id, spec.title);

  if (run.status !== "completed") {
    throw new Error(`${spec.title} Local Task did not complete. Status=${run.status}; error=${run.error ?? "none"}.`);
  }
  const reviewedCard = await waitForCardProofReview(ticketized.id, spec.title);
  const taskActions = taskActionObservation(run.proofOfWork);
  if (taskActions.count <= 0) throw new Error(`${spec.title} completed without project-board task actions.`);
  if (taskActions.terminalCount <= 0) throw new Error(`${spec.title} completed without a terminal project-board task action.`);
  const changedPaths = meaningfulChangedPaths(run.proofOfWork);
  for (const file of spec.expectedFiles) {
    if (!changedPaths.includes(file)) {
      throw new Error(`${spec.title} proof did not report expected deliverable ${file}. Reported: ${changedPaths.join(", ") || "none"}.`);
    }
    await assertAbsoluteFile(join(run.workspacePath, file), expectedNeedleForFile(file));
  }
  if (reviewedCard.proofReview?.status !== "done") {
    throw new Error(`${spec.title} proof review did not close as done. Review=${JSON.stringify(reviewedCard.proofReview)}`);
  }
  return { spec, card: reviewedCard, run, taskActions, changedPaths, reviewedCard, dependencyArtifacts };
}

async function prepareRunViaBridge(taskId, title) {
  await invoke("prepareNextOrchestrationTasks");
  return waitForPreparedOrStartedRun(taskId, title);
}

async function startRunViaBridge(runId, title) {
  const prepared = await latestRun(runId);
  if (prepared.status === "prepared") await invoke("startOrchestrationRun", { runId });
  return waitForTerminalRun(runId, title);
}

async function prepareRunViaUi(taskId, title) {
  await reloadRendererForFreshBoardState(`preparing ${title}`);
  await openProjectBoard();
  await clickProjectBoardTab("Board");
  await clickButton("Prepare Runs");
  return waitForPreparedOrStartedRun(taskId, title);
}

async function startRunViaUi(runId, title) {
  await openProjectBoard();
  await clickProjectBoardTab("Board");
  await waitFor(() => document.body?.innerText.includes("Start Run") || document.body?.innerText.includes("Start run"), `visible Start Run control for ${title}`, 120_000);
  await clickButton("Start Run");
  return waitForTerminalRun(runId, title);
}

async function latestRun(runId) {
  const board = await invoke("listOrchestrationBoard");
  const run = board.runs.find((candidate) => candidate.id === runId);
  if (!run) throw new Error(`Orchestration run disappeared: ${runId}`);
  return run;
}

async function dependencyArtifactsForPreparedRun(run, expectedFiles = [], expectedImportCount) {
  const artifacts = run.proofOfWork?.dependencyArtifacts;
  if (expectedImportCount !== undefined && artifacts?.imports?.length !== expectedImportCount) {
    throw new Error(`Prepared run ${run.id} expected ${expectedImportCount} dependency imports, got ${artifacts?.imports?.length ?? 0}.`);
  }
  if (!expectedFiles.length) return artifacts;
  if (!artifacts?.imports?.length) throw new Error(`Prepared run ${run.id} did not record dependency artifact imports.`);
  const materialFiles = artifacts.imports.flatMap((entry) => entry.materialFiles ?? []);
  for (const file of expectedFiles) {
    if (!materialFiles.includes(file)) throw new Error(`Dependency artifact import for ${run.id} did not include ${file}. Imported: ${materialFiles.join(", ")}`);
  }
  await assertDependencyImportBundle(run, expectedFiles);
  return artifacts;
}

async function assertDependencyImportBundle(run, expectedFiles) {
  const manifestPath = join(run.workspacePath, ".ambient", "dependency-artifacts", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!manifest.imports?.length) throw new Error(`Dependency artifact manifest had no imports: ${manifestPath}`);
  for (const file of expectedFiles) {
    const imported = manifest.imports.find((entry) => (entry.materialFiles ?? []).includes(file));
    if (!imported) throw new Error(`Dependency artifact manifest did not include ${file}.`);
    await assertAbsoluteFile(join(imported.filesRoot, file), expectedNeedleForFile(file));
  }
  const skipped = manifest.imports.flatMap((entry) => entry.skippedFiles ?? []);
  if (skipped.length) throw new Error(`Dependency artifact import skipped files: ${skipped.join(", ")}`);
  return manifest;
}

async function assertTodoDeduperTestResult(path) {
  const text = await assertAbsoluteFile(path, '"passed"');
  const report = JSON.parse(text);
  if (report.passed !== true) throw new Error(`Todo deduper test report did not pass: ${text}`);
  if (report.sourceCount !== 5) throw new Error(`Expected sourceCount 5, got ${report.sourceCount}`);
  if (report.uniqueCount !== 3) throw new Error(`Expected uniqueCount 3, got ${report.uniqueCount}`);
  const uniqueIds = Array.isArray(report.uniqueIds) ? report.uniqueIds.map(String) : [];
  if (uniqueIds.join(",") !== "alpha,beta,gamma") throw new Error(`Unexpected uniqueIds: ${uniqueIds.join(",")}`);
  if (report.matchedExpected !== true) throw new Error(`matchedExpected was not true: ${text}`);
  if (!String(report.implementationBundle || "").includes(".ambient/dependency-artifacts")) {
    throw new Error(`Test report did not identify the implementation bundle: ${text}`);
  }
  if (!String(report.fixtureBundle || "").includes(".ambient/dependency-artifacts")) {
    throw new Error(`Test report did not identify the fixture bundle: ${text}`);
  }
  return {
    passed: report.passed,
    sourceCount: report.sourceCount,
    uniqueCount: report.uniqueCount,
    uniqueIds,
    matchedExpected: report.matchedExpected,
    implementationBundle: report.implementationBundle,
    fixtureBundle: report.fixtureBundle,
  };
}

function summarizeDependencyArtifacts(artifacts) {
  if (!artifacts) return undefined;
  return {
    artifactRoot: artifacts.artifactRoot,
    importCount: artifacts.imports.length,
    materialFiles: artifacts.imports.flatMap((entry) => entry.materialFiles),
    skippedFiles: artifacts.imports.flatMap((entry) => entry.skippedFiles),
    excludedFiles: artifacts.imports.flatMap((entry) => entry.excludedFiles),
  };
}

async function waitForTask(taskId) {
  return waitForState(
    async () => {
      const board = await invoke("listOrchestrationBoard");
      return board.tasks.find((candidate) => candidate.id === taskId);
    },
    `Local Task ${taskId}`,
    60_000,
  );
}

async function waitForPreparedOrStartedRun(taskId, title) {
  return waitForState(
    async () => {
      const board = await invoke("listOrchestrationBoard");
      const run = board.runs.find((candidate) => candidate.taskId === taskId && ["prepared", "running", "completed", "failed", "stalled", "canceled"].includes(candidate.status));
      return run ? { board, run } : undefined;
    },
    `prepared or started Local Task run for ${title}`,
    300_000,
  );
}

async function waitForTerminalRun(runId, title) {
  const startedAt = Date.now();
  let lastActivityAt = Date.now();
  let lastSignature = "";
  while (true) {
    const board = await invoke("listOrchestrationBoard");
    const run = board.runs.find((candidate) => candidate.id === runId);
    if (!run) throw new Error(`Orchestration run disappeared: ${runId}`);
    const signature = orchestrationRunProgressSignature(run);
    if (signature !== lastSignature) {
      lastSignature = signature;
      lastActivityAt = Date.now();
    }
    if (["completed", "failed", "stalled", "canceled"].includes(run.status)) return run;
    if (Date.now() - lastActivityAt > workerIdleTimeoutMs) {
      throw new Error(`Timed out waiting for terminal ${title} Local Task run; no run progress was observed for ${workerIdleTimeoutMs.toLocaleString()}ms.`);
    }
    if (Date.now() - startedAt > workerRunMaxElapsedMs) {
      throw new Error(`Timed out waiting for terminal ${title} Local Task run after ${workerRunMaxElapsedMs.toLocaleString()}ms total elapsed.`);
    }
    await delay(1000);
  }
}

function orchestrationRunProgressSignature(run) {
  const proof = run.proofOfWork && typeof run.proofOfWork === "object" ? run.proofOfWork : {};
  return [
    run.id,
    run.status,
    run.lastEventAt,
    run.finishedAt,
    run.error,
    proof.messageCount,
    proof.assistantMessageCount,
    proof.toolMessageCount,
    proof.outputCharCount,
    proof.lastActivityAt,
    proof.lastAssistantText,
    taskActionObservation(proof).count,
  ].join("|");
}

async function waitForCardProofReview(cardId, title) {
  return waitForState(
    async () => {
      const state = await invoke("bootstrap");
      const board = boardFromState(state);
      const card = board.cards.find((candidate) => candidate.id === cardId);
      return card?.proofReview ? card : undefined;
    },
    `${title} card proof review`,
    240_000,
  );
}

function taskActionObservation(proof) {
  const actions = Array.isArray(proof?.taskToolActions) ? proof.taskToolActions : [];
  const countsByAction = {};
  for (const action of actions) {
    const key = typeof action?.action === "string" ? action.action : "unknown";
    countsByAction[key] = (countsByAction[key] ?? 0) + 1;
  }
  const terminalCount = actions.filter((action) =>
    ["task_block", "task_complete", "task_create_followup", "task_report_proof", "task_report_handoff"].includes(action?.action),
  ).length;
  return { count: actions.length, terminalCount, countsByAction };
}

function meaningfulChangedPaths(proof) {
  const actions = Array.isArray(proof?.taskToolActions) ? proof.taskToolActions : [];
  return uniqueStrings([
    ...stringsFromUnknownArray(proof?.changedFiles),
    ...actions.flatMap((action) => stringsFromUnknownArray(action?.changedFiles)),
  ]).filter((file) => file && !file.startsWith(".ambient/") && !file.startsWith(".ambient-codex/") && !file.startsWith("node_modules/"));
}

function stringsFromUnknownArray(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (item && typeof item === "object") {
      for (const key of ["path", "file", "name", "command"]) {
        if (typeof item[key] === "string") return [item[key]];
      }
    }
    return [];
  });
}

function uniqueStrings(values) {
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

function expectedNeedleForFile(file) {
  if (file === "fixtures/todos.json") return "alpha";
  if (file === "fixtures/expected-unique.json") return "gamma";
  if (file === "tests/verify-todo-fixtures.mjs") return "";
  if (file === "src/dedupeTodos.mjs") return "dedupeTodos";
  if (file === "dedupe-report.json") return "matchedExpected";
  if (file === "tests/dedupeTodos.test.mjs") return "dedupeTodos";
  if (file === "test-results/todo-deduper.json") return '"passed"';
  return "";
}

async function openProjectBoard() {
  if (await evaluate(() => Boolean(document.querySelector(".project-board-tabs"))).catch(() => false)) return;
  await waitFor(() => document.body?.innerText.includes("Open Board"), "Open Board action");
  await clickButton("Open Board");
  await waitFor(() => document.querySelector(".project-board-tabs")?.textContent?.includes("Board"), "project board tabs");
}

async function clickProjectBoardTab(label) {
  await evaluate((tabLabel) => {
    const button = [...document.querySelectorAll(".project-board-tabs button")].find((item) => item.querySelector("span")?.textContent?.trim() === tabLabel);
    if (!button) throw new Error(`Project board tab not found: ${tabLabel}`);
    button.click();
  }, label);
}

async function reloadRendererForFreshBoardState(label) {
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitFor(
    () => document.readyState === "complete" && Boolean(window.ambientDesktop) && Boolean(document.body?.innerText.includes("Ambient")),
    `renderer reload for ${label}`,
    120_000,
  );
  await waitFor(
    async () => {
      const bridge = window.ambientDesktop;
      if (!bridge?.bootstrap) return false;
      const state = await bridge.bootstrap();
      return Boolean(state?.projects?.length);
    },
    `fresh Desktop bootstrap state for ${label}`,
    120_000,
  );
}

async function describeButtons(label) {
  return evaluate((buttonLabel) => {
    const needle = String(buttonLabel).toLowerCase();
    return [...document.querySelectorAll("button")]
      .map((item) => {
        const rect = item.getBoundingClientRect();
        const haystack = [item.textContent || "", item.getAttribute("aria-label") || "", item.getAttribute("title") || ""].join(" ").toLowerCase();
        return {
          text: (item.textContent || "").trim().replace(/\s+/g, " "),
          ariaLabel: item.getAttribute("aria-label") || "",
          title: item.getAttribute("title") || "",
          disabled: item.disabled || item.getAttribute("aria-disabled") === "true",
          visible: rect.width > 0 && rect.height > 0 && getComputedStyle(item).visibility !== "hidden" && getComputedStyle(item).display !== "none",
          matches: haystack.includes(needle),
        };
      })
      .filter((item) => item.matches);
  }, label);
}

async function waitForVisibleEnabledButton(label, timeoutMs = 60_000) {
  const started = Date.now();
  let lastCandidates = [];
  while (Date.now() - started < timeoutMs) {
    lastCandidates = await describeButtons(label);
    if (lastCandidates.some((candidate) => candidate.visible && !candidate.disabled)) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for enabled visible ${label} button; candidates=${JSON.stringify(lastCandidates)}`);
}

async function clickButton(label) {
  await waitForVisibleEnabledButton(label);
  await evaluate((buttonLabel) => {
    const needle = String(buttonLabel).toLowerCase();
    const button = [...document.querySelectorAll("button")].find((item) => {
      const haystack = [item.textContent || "", item.getAttribute("aria-label") || "", item.getAttribute("title") || ""].join(" ").toLowerCase();
      const rect = item.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(item).visibility !== "hidden" && getComputedStyle(item).display !== "none";
      const disabled = item.disabled || item.getAttribute("aria-disabled") === "true";
      return haystack.includes(needle) && visible && !disabled;
    });
    if (!button) throw new Error(`Enabled visible button not found after wait: ${buttonLabel}`);
    button.click();
  }, label);
}

async function captureScreenshot(path) {
  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(screenshot.data, "base64"));
}

async function assertAbsoluteFile(path, needle) {
  const text = await readFile(path, "utf8").catch((error) => {
    throw new Error(`Expected file at ${path}: ${error.message}`);
  });
  if (needle && !text.includes(needle)) throw new Error(`Expected ${path} to contain ${needle}.`);
  return text;
}

function boardFromState(state) {
  const activeProject = state.projects.find((project) => project.path === state.workspace.path) ?? state.projects[0];
  if (!activeProject?.board) throw new Error("No project board available in Desktop state.");
  return activeProject.board;
}

async function invoke(method, args) {
  return evaluate(
    async ({ method: methodName, args: methodArgs }) => {
      const bridge = window.ambientDesktop;
      if (!bridge || typeof bridge[methodName] !== "function") throw new Error(`ambientDesktop.${methodName} is unavailable`);
      return methodArgs === undefined ? bridge[methodName]() : bridge[methodName](methodArgs);
    },
    { method, args },
  );
}

async function evaluate(fn, arg) {
  const expression = `(${fn})(${JSON.stringify(arg)})`;
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: 120_000,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Evaluation failed");
  }
  return result.result.value;
}

async function waitFor(predicate, label, timeoutMs = 60_000, arg) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      if (await evaluate(predicate, arg)) return true;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

async function waitForState(fn, label, timeoutMs = 60_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

async function connectCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out connecting to CDP websocket")), 30_000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("CDP websocket connection failed"));
    });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data.toString());
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() {
      socket.close();
    },
  };
}

async function waitForPageEndpoint(child) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited early with code ${child.exitCode}. Output:\n${output.join("").slice(-4000)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      const targets = await response.json();
      const target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl) ?? targets.find((item) => item.webSocketDebuggerUrl);
      if (target) return target;
    } catch {
      // Dev server not listening yet.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for Electron CDP endpoint. Output:\n${output.join("").slice(-4000)}`);
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function writeReport(report) {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function terminateProcess(child) {
  if (child.exitCode !== null) return;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(5000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }),
  ]);
}

function classifyHarnessFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/Expected gmi-cloud|API key|provider|Ambient\/Pi|stream|model|rate|timeout/i.test(message)) return "provider-degraded";
  if (/CDP|Electron|Timed out waiting for Ambient shell|websocket|dev server/i.test(message)) return "environment/snapshot issue";
  if (/Local Task|proof|dependency artifact|artifact import|project-board|card|board|verification|deduper|bundle/i.test(message)) return "product";
  return "test harness";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
