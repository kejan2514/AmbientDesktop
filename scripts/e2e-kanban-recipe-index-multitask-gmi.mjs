#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const outputRoot = resolve(process.env.AMBIENT_KANBAN_RECIPE_INDEX_OUT_DIR || join(tmpdir(), "ambient-kanban-recipe-index-multitask-gmi"));
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = join(outputRoot, "runs", runStamp);
const workspace = join(runRoot, "workspace");
const userData = join(runRoot, "userData");
const reportPath = resolve(process.env.AMBIENT_KANBAN_RECIPE_INDEX_OUT || join(outputRoot, "latest.json"));
const boardScreenshotPath = join(runRoot, "phase2-recipe-index-board.png");
const integrationScreenshotPath = join(runRoot, "phase2-recipe-index-integration.png");
const cdpPort = Number(process.env.AMBIENT_KANBAN_RECIPE_INDEX_CDP_PORT || 0) || (await availablePort());
const workerRunMaxElapsedMs = Number(process.env.AMBIENT_KANBAN_RECIPE_INDEX_RUN_MAX_TIMEOUT_MS || 0) || 1_800_000;
const workerIdleTimeoutMs = Number(process.env.AMBIENT_KANBAN_RECIPE_INDEX_RUN_IDLE_TIMEOUT_MS || 0) || 420_000;
const defaultRepoKeyFile = join(repoRoot, "ignored-provider-key-file.txt");
const defaultHomeCheckoutKeyFile = join(homedir(), "ambientCoder", "ignored-provider-key-file.txt");
const keyFile = resolve(
  process.env.GMI_CLOUD_API_KEY_FILE ||
    (existsSync(defaultRepoKeyFile) ? defaultRepoKeyFile : defaultHomeCheckoutKeyFile),
);
const defaultSnapshotWorkspace = join(homedir(), "Documents", "ambientCoderArchive");
const sourceWorkspace =
  process.env.AMBIENT_KANBAN_RECIPE_INDEX_SNAPSHOT_WORKSPACE ||
  process.env.AMBIENT_DESKTOP_WORKSPACE ||
  (existsSync(defaultSnapshotWorkspace) ? defaultSnapshotWorkspace : "");
const sourceUserData = process.env.AMBIENT_KANBAN_RECIPE_INDEX_SNAPSHOT_USER_DATA || process.env.AMBIENT_E2E_USER_DATA || "";

const cards = {
  fixtures: {
    key: "fixtures",
    title: "Recipe Index Gate: fixtures",
    expectedFiles: [
      "recipes/tomato-soup.md",
      "recipes/chickpea-salad.md",
      "recipes/oat-pancakes.md",
      "tests/verify-recipes.mjs",
    ],
  },
  generator: {
    key: "generator",
    title: "Recipe Index Gate: index generator",
    expectedFiles: ["build-index.mjs", "INDEX.md"],
  },
  verifier: {
    key: "verifier",
    title: "Recipe Index Gate: root verifier",
    expectedFiles: ["tests/verify-recipe-index.mjs"],
  },
};
const allRootDeliverables = [
  ...cards.fixtures.expectedFiles,
  ...cards.generator.expectedFiles,
  ...cards.verifier.expectedFiles,
];

const output = [];
let app;
let cdp;

try {
  if (!sourceWorkspace || !existsSync(sourceWorkspace)) {
    throw new Error("Set AMBIENT_KANBAN_RECIPE_INDEX_SNAPSHOT_WORKSPACE to a local snapshot workspace directory.");
  }
  if (!existsSync(keyFile) && !process.env.GMI_CLOUD_API_KEY && !process.env.GMI_API_KEY) {
    throw new Error("Set GMI_CLOUD_API_KEY_FILE, GMI_CLOUD_API_KEY, or GMI_API_KEY before running the GMI Desktop Recipe Index gate.");
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

  const { board, cardByKey } = await createRecipeIndexBoardAndCards();
  await waitFor(() => document.body?.innerText.includes("Open Board"), "Open Board action");
  await clickButton("Open Board");
  await waitFor(() => document.querySelector(".project-board-tabs")?.textContent?.includes("Board"), "project board tabs");
  await clickProjectBoardTab("Board");
  await captureScreenshot(boardScreenshotPath);

  const runResults = [];
  const fixtures = await approveRunAndVerifyCard(cardByKey.fixtures, cards.fixtures);
  runResults.push(fixtures);
  const generator = await approveRunAndVerifyCard(cardByKey.generator, cards.generator, {
    requiredDependencyWorkspace: fixtures.run.workspacePath,
    expectedDependencyFiles: cards.fixtures.expectedFiles,
  });
  runResults.push(generator);
  const verifier = await approveRunAndVerifyCard(cardByKey.verifier, cards.verifier, {
    requiredDependencyWorkspace: generator.run.workspacePath,
    expectedDependencyFiles: cards.generator.expectedFiles,
  });
  runResults.push(verifier);

  await waitFor(() => document.body?.innerText.includes("Executable board closed; integration pending"), "closed board integration pending state", 180_000);
  await clickProjectBoardTab("Integration");
  await waitFor(() => document.querySelector(".project-board-integration-panel")?.textContent?.includes("Integration Queue"), "Integration panel selected");
  const pendingText = await waitForIntegrationQueue(runResults.map((item) => item.card.title));
  assertIncludes(pendingText, "3 pending", "Recipe Index integration pending count");
  for (const file of allRootDeliverables) assertIncludes(pendingText, file, `visible integration manifest for ${file}`);
  for (const file of allRootDeliverables) assertFileAbsent(file, `${file} should not exist in project root before visible integration`);

  await clickIntegrationAction(cards.fixtures.title, "Apply To Root");
  await waitForIntegrationStatus(cards.fixtures.title, "Integrated");
  await clickIntegrationAction(cards.generator.title, "Apply To Root");
  await waitForIntegrationStatus(cards.generator.title, "Integrated");
  await clickIntegrationAction(cards.verifier.title, "Apply To Root");
  await waitForIntegrationStatus(cards.verifier.title, "Integrated");

  await assertWorkspaceFile("recipes/tomato-soup.md", "# Tomato Soup");
  await assertWorkspaceFile("recipes/chickpea-salad.md", "# Chickpea Salad");
  await assertWorkspaceFile("recipes/oat-pancakes.md", "# Oat Pancakes");
  await assertWorkspaceFile("build-index.mjs", "buildRecipeIndex");
  await assertWorkspaceFile("INDEX.md", "Tomato Soup");
  await assertWorkspaceFile("tests/verify-recipe-index.mjs", "verifyRecipeIndexRoot");
  assertFileAbsent(".ambient/recipe-index-assembly", "runtime assembly should not be copied from task workspaces");

  const regenerate = await runCommand("node", ["build-index.mjs"], { cwd: workspace, timeoutMs: 60_000 });
  const verify = await runCommand("node", ["tests/verify-recipe-index.mjs"], { cwd: workspace, timeoutMs: 60_000 });
  await assertWorkspaceFile("INDEX.md", "Chickpea Salad");

  await captureScreenshot(integrationScreenshotPath);
  await clickProjectBoardTab("Board");
  await waitFor(() => document.body?.innerText.includes("Executable board closed; deliverables integrated"), "closed board deliverables integrated state", 180_000);

  const report = {
    status: "passed",
    providerId: provider.providerId,
    usedGmiKeyFile: existsSync(keyFile),
    sourceWorkspace,
    usedSnapshotUserData: Boolean(sourceUserData && existsSync(sourceUserData)),
    runRoot,
    boardId: board.id,
    cards: runResults.map((item) => ({
      key: item.spec.key,
      cardId: item.card.id,
      taskId: item.card.orchestrationTaskId,
      runId: item.run.id,
      runStatus: item.run.status,
      runWorkspacePath: item.run.workspacePath,
      changedPaths: item.changedPaths,
      taskActions: item.taskActions,
      proofReview: item.reviewedCard.proofReview,
    })),
    finalCommands: {
      regenerate: commandSummary(regenerate),
      verify: commandSummary(verify),
    },
    screenshots: { board: boardScreenshotPath, integration: integrationScreenshotPath },
    assertions: [
      "Three dependent Recipe Index cards ran as separate live GMI Local Tasks",
      "Dependent cards saw available dependency workspace context before running",
      "All runs produced durable project-board task actions and done proof reviews",
      "Visible Integration Queue applied fixture, generator, and verifier deliverables to the temp snapshot root",
      "Integrated root contains recipes, build-index.mjs, INDEX.md, and tests/verify-recipe-index.mjs",
      "Final root verification regenerated INDEX.md and passed tests/verify-recipe-index.mjs without copying from task worktrees",
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
    for (const name of ["SingletonCookie", "SingletonLock", "SingletonSocket"]) await rm(join(userData, name), { force: true });
  } else {
    await mkdir(userData, { recursive: true });
  }
  await sanitizeTempWorkspace();
  await writeHarnessWorkflow();
}

async function sanitizeTempWorkspace() {
  await rm(join(workspace, ".ambient"), { recursive: true, force: true });
  await rm(join(workspace, ".ambient-codex"), { recursive: true, force: true });
  await rm(join(workspace, "recipes"), { recursive: true, force: true });
  for (const path of ["ignored-provider-key-file.txt", "ignored-provider-key-file.txt", "brave_api_key.txt", ".env", ".env.local"]) {
    await rm(join(workspace, path), { force: true });
  }
  await removeCredentialNamedFiles(workspace, 3);
  for (const path of ["build-index.mjs", "INDEX.md", "tests/verify-recipes.mjs", "tests/verify-index-output.mjs", "tests/verify-recipe-index.mjs"]) {
    await rm(join(workspace, path), { force: true });
  }
}

async function removeCredentialNamedFiles(root, maxDepth) {
  if (maxDepth < 0) return;
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (isCredentialLikeFilename(entry.name)) {
      await rm(path, { recursive: entry.isDirectory(), force: true });
      continue;
    }
    if (entry.isDirectory() && !["node_modules", ".git"].includes(entry.name)) {
      await removeCredentialNamedFiles(path, maxDepth - 1);
    }
  }
}

function isCredentialLikeFilename(name) {
  const lower = name.toLowerCase();
  return lower === ".env" || lower.startsWith(".env.") || (lower.includes("api") && lower.includes("key"));
}

async function writeHarnessWorkflow() {
  const workflow = `---
version: 1
tracker:
  kind: local
  active_states: [ready]
  terminal_states: [done, canceled, duplicate]
  review_states: [review]
orchestration:
  auto_dispatch: false
  max_concurrent_agents: 1
  max_turns: 8
  poll_interval_ms: 30000
  stall_timeout_ms: 420000
workspace:
  strategy: directory
  root: .ambient-codex/orchestration/workspaces
  branch_prefix: ambient/
  cleanup_terminal_workspaces: false
  reuse_existing: true
agent:
  permission_mode: workspace
  extra_instructions: |
    This is a bounded Phase 2 Recipe Index multi-task integration gate. Do not inspect, print, summarize, or copy API keys, secret files, local-secrets folders, credentials, browser profiles, or environment values. Do not install packages or use network calls. Keep all writes inside the writable task workspace. Treat dependency workspaces listed in the card description as read-only source inputs.
proof_of_work:
  require_tests: true
  require_diff_summary: true
  require_screenshots: false
  max_summary_chars: 4000
---
Work on Local Task {{ task.identifier }} in {{ workspace.path }}.

Execution workspace contract:
- Writable task workspace: {{ workspace.path }}
- Owning project root: {{ task.projectPath }}
- Create, modify, delete, stage, and commit task files only inside the writable task workspace. Use paths relative to that workspace.
- Do not mutate the owning project root. The Project Board Integration Queue will apply accepted deliverables later.
- Read available dependency workspaces only when they are explicitly named in the Dependency execution context.
- Do not read or expose secret files, API key files, credential directories, browser profiles, or environment values.

Title: {{ task.title }}

Description:
{{ task.description }}

Complete the task in the prepared workspace. Keep the scope narrow, run the requested verification commands, and finish with project-board task actions that name the changed files and commands.
`;
  await writeFile(join(workspace, "WORKFLOW.md"), workflow, "utf8");
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
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));
  const target = await waitForPageEndpoint(child);
  return { child, webSocketDebuggerUrl: target.webSocketDebuggerUrl };
}

async function createRecipeIndexBoardAndCards() {
  const initialState = await invoke("bootstrap");
  const activeProject = initialState.projects.find((project) => project.path === initialState.workspace.path) ?? initialState.projects[0];
  if (!activeProject) throw new Error("No active project available for Recipe Index gate.");
  const stateWithBoard = await invoke("createProjectBoard", {
    projectId: activeProject.id,
    title: "Phase 2 Recipe Index Multi-Task Gate Board",
    summary: "Live execution gate for applying dependent Recipe Index Local Task deliverables into the project root.",
  });
  let board = boardFromState(stateWithBoard);
  if (board.status !== "active") {
    board = boardFromState(await invoke("updateProjectBoardStatus", { boardId: board.id, status: "active" }));
  }

  const fixtures = await createReadyCard(board.id, cards.fixtures.title, recipeFixturesDescription(), {
    priority: 1,
    labels: ["phase-2", "recipe-index", "fixtures", "integration-gate", "live-gmi"],
    blockedBy: [],
    acceptanceCriteria: [
      "Create three recipe markdown fixtures under recipes/ and tests/verify-recipes.mjs in the writable task workspace.",
      "Run node tests/verify-recipes.mjs successfully from the task workspace.",
      "Report project-board proof with changedFiles covering all fixture files and the verifier.",
    ],
    testPlan: {
      unit: ["Run node tests/verify-recipes.mjs."],
      integration: [],
      visual: [],
      manual: [],
    },
  });

  const generator = await createReadyCard(board.id, cards.generator.title, indexGeneratorDescription(), {
    priority: 2,
    labels: ["phase-2", "recipe-index", "generator", "integration-gate", "live-gmi"],
    blockedBy: [fixtures.id],
    acceptanceCriteria: [
      "Use the available recipe fixture dependency workspace as read-only input.",
      "Create build-index.mjs and INDEX.md in the writable task workspace.",
      "Copy dependency recipe inputs under .ambient/dependency-recipes for task-local testing, then run node --check build-index.mjs and node build-index.mjs against that copied runtime directory.",
      "Report project-board proof with changedFiles covering build-index.mjs and INDEX.md.",
    ],
    testPlan: {
      unit: ["Run node --check build-index.mjs."],
      integration: ["Run node build-index.mjs --recipes-dir .ambient/dependency-recipes --out INDEX.md."],
      visual: [],
      manual: [],
    },
  });

  const verifier = await createReadyCard(board.id, cards.verifier.title, rootVerifierDescription(), {
    priority: 3,
    labels: ["phase-2", "recipe-index", "verifier", "integration-gate", "live-gmi"],
    blockedBy: [fixtures.id, generator.id],
    acceptanceCriteria: [
      "Use available fixture and generator dependency workspaces as read-only input.",
      "Create tests/verify-recipe-index.mjs in the writable task workspace.",
      "Assemble dependency outputs under .ambient/recipe-index-assembly for task-local testing only.",
      "Run node --check tests/verify-recipe-index.mjs and node tests/verify-recipe-index.mjs --root .ambient/recipe-index-assembly.",
      "Report project-board proof with changedFiles covering tests/verify-recipe-index.mjs.",
    ],
    testPlan: {
      unit: ["Run node --check tests/verify-recipe-index.mjs."],
      integration: ["Run node tests/verify-recipe-index.mjs --root .ambient/recipe-index-assembly."],
      visual: [],
      manual: [],
    },
  });

  board = boardFromState(await invoke("bootstrap"));
  return { board, cardByKey: { fixtures, generator, verifier } };
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
    phase: "Phase 2 Gate B",
    labels: fields.labels,
    blockedBy: fields.blockedBy,
    acceptanceCriteria: fields.acceptanceCriteria,
    testPlan: fields.testPlan,
    clarificationQuestions: [],
  });
  board = boardFromState(state);
  const ready = board.cards.find((card) => card.id === created.id);
  if (!ready) throw new Error(`Ready card disappeared after update: ${title}`);
  return ready;
}

function recipeFixturesDescription() {
  return [
    "Create deterministic recipe fixtures in this card's writable task workspace. Do not modify the owning project root directly; the Integration Queue must apply deliverables later.",
    "",
    "Required files:",
    "- recipes/tomato-soup.md with title '# Tomato Soup', ingredient list, tags line containing 'soup' and 'vegetarian', and source note.",
    "- recipes/chickpea-salad.md with title '# Chickpea Salad', ingredient list, tags line containing 'salad' and 'vegan', and source note.",
    "- recipes/oat-pancakes.md with title '# Oat Pancakes', ingredient list, tags line containing 'breakfast' and 'vegetarian', and source note.",
    "- tests/verify-recipes.mjs: dependency-free Node fs/assert verifier for exactly these three recipe fixtures. It must check titles, ingredient sections, tags, and source notes.",
    "",
    "Verification command to run from the task workspace:",
    "- node tests/verify-recipes.mjs",
    "",
    "Project-board reporting contract:",
    "- First, call native task_heartbeat with the immediate plan before editing files. If native task tools are unavailable, emit a fenced task_actions JSON fallback.",
    "- After writing and verifying files, call task_report_proof with changedFiles exactly including recipes/tomato-soup.md, recipes/chickpea-salad.md, recipes/oat-pancakes.md, and tests/verify-recipes.mjs, and commands including node tests/verify-recipes.mjs.",
    "- Then call task_complete only when those files and commands are complete.",
    "- Do not install dependencies, call network services, read secrets, or write outside the task workspace.",
  ].join("\n");
}

function indexGeneratorDescription() {
  return [
    "Create the Recipe Index generator in this card's writable task workspace. Do not modify the owning project root directly; the Integration Queue must apply deliverables later.",
    "",
    "Dependency contract:",
    "- Use the available dependency workspace for the fixtures card as read-only input. The dependency context lists its exact workspace path and changed recipe files.",
    "- Copy the dependency recipe files into .ambient/dependency-recipes inside this task workspace before running shell verification. Permission policy may block shell commands that read dependency workspace paths directly.",
    "- Runtime copies under .ambient/ are not material deliverables. Do not report .ambient/dependency-recipes in changedFiles.",
    "",
    "Required files:",
    "- build-index.mjs: dependency-free Node ESM script exporting buildRecipeIndex. It scans markdown recipes, extracts title, ingredient count, and tags, and writes a deterministic INDEX.md. Defaults: --recipes-dir recipes --out INDEX.md. It must also accept --recipes-dir <path> and --out <path>.",
    "- INDEX.md: generated from the dependency recipe fixtures. It must include Recipe Index heading plus Tomato Soup, Chickpea Salad, and Oat Pancakes entries.",
    "",
    "Verification commands to run from the task workspace:",
    "- node --check build-index.mjs",
    "- node build-index.mjs --recipes-dir .ambient/dependency-recipes --out INDEX.md",
    "",
    "Project-board reporting contract:",
    "- First, call native task_heartbeat with the immediate plan before editing files.",
    "- After writing and verifying files, call task_report_proof with changedFiles exactly including build-index.mjs and INDEX.md, and commands including both verification commands.",
    "- Then call task_complete only when those files and commands are complete.",
    "- Do not install dependencies, call network services, read secrets, or write outside the task workspace.",
  ].join("\n");
}

function rootVerifierDescription() {
  return [
    "Create the root verifier for the Recipe Index bundle in this card's writable task workspace. Do not modify the owning project root directly; the Integration Queue must apply deliverables later.",
    "",
    "Dependency contract:",
    "- Use the available fixture dependency workspace and generator dependency workspace as read-only inputs. The dependency context lists exact workspace paths and changed files.",
    "- For task-local testing only, assemble those dependency outputs under .ambient/recipe-index-assembly inside this task workspace, then run the verifier against that assembly. Runtime assembly files under .ambient/ are not material deliverables.",
    "",
    "Required file:",
    "- tests/verify-recipe-index.mjs: dependency-free Node ESM verifier exporting verifyRecipeIndexRoot(root). It defaults to process.cwd(), also accepts --root <path>, verifies recipes/, build-index.mjs, INDEX.md, all three recipe titles/tags, and checks that running build-index.mjs against the recipe directory produces an index containing all three titles.",
    "",
    "Verification commands to run from the task workspace:",
    "- node --check tests/verify-recipe-index.mjs",
    "- node tests/verify-recipe-index.mjs --root .ambient/recipe-index-assembly",
    "",
    "Project-board reporting contract:",
    "- First, call native task_heartbeat with the immediate plan before editing files.",
    "- After writing and verifying files, call task_report_proof with changedFiles exactly including tests/verify-recipe-index.mjs, and commands including both verification commands.",
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
  if (expectations.requiredDependencyWorkspace && !String(task.description || "").includes(expectations.requiredDependencyWorkspace)) {
    throw new Error(`${spec.title} task description did not include required dependency workspace ${expectations.requiredDependencyWorkspace}.`);
  }
  if (expectations.expectedDependencyFiles) {
    for (const file of expectations.expectedDependencyFiles) {
      if (!String(task.description || "").includes(file)) {
        throw new Error(`${spec.title} task description did not include dependency changed file ${file}.`);
      }
    }
  }

  await invokeDetached("prepareNextOrchestrationTasks", undefined, "__kanbanRecipePrepareError");
  const { run: preparedRun } = await waitForPreparedOrStartedRun(ticketized.orchestrationTaskId, spec.title);
  if (preparedRun.status === "prepared") {
    await invokeDetached("startOrchestrationRun", { runId: preparedRun.id }, "__kanbanRecipeRunStartError");
  }
  const run = await waitForTerminalRun(preparedRun.id, spec.title);
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
  return { spec, card: reviewedCard, run, taskActions, changedPaths, reviewedCard };
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
      const detachedError = await detachedErrorText();
      if (detachedError) throw new Error(`Local Task preparation failed: ${detachedError}`);
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
    const detachedError = await detachedErrorText();
    if (detachedError) throw new Error(`Local Task start failed: ${detachedError}`);
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
  const paths = new Set();
  const collect = (value) => {
    if (typeof value === "string") {
      const cleaned = value.trim().replace(/^[MADRCU?! ]+\s+/, "").replace(/^\.\//, "");
      if (cleaned) paths.add(cleaned);
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const key of ["path", "file", "name"]) collect(value[key]);
  };
  if (Array.isArray(proof?.changedFiles)) proof.changedFiles.forEach(collect);
  if (Array.isArray(proof?.toolChangedFiles)) proof.toolChangedFiles.forEach(collect);
  if (Array.isArray(proof?.taskToolActions)) {
    for (const action of proof.taskToolActions) {
      if (Array.isArray(action?.changedFiles)) action.changedFiles.forEach(collect);
    }
  }
  return [...paths].sort();
}

function expectedNeedleForFile(file) {
  if (file === "recipes/tomato-soup.md") return "# Tomato Soup";
  if (file === "recipes/chickpea-salad.md") return "# Chickpea Salad";
  if (file === "recipes/oat-pancakes.md") return "# Oat Pancakes";
  if (file === "tests/verify-recipes.mjs") return "Tomato Soup";
  if (file === "build-index.mjs") return "buildRecipeIndex";
  if (file === "INDEX.md") return "Recipe Index";
  if (file === "tests/verify-recipe-index.mjs") return "verifyRecipeIndexRoot";
  return "";
}

async function waitForIntegrationQueue(titles) {
  await waitFor(
    (itemTitles) => itemTitles.every((title) => document.querySelector(".project-board-integration-panel")?.textContent?.includes(title)),
    "Recipe Index deliverable queue items",
    90_000,
    titles,
  );
  return elementText(".project-board-integration-panel");
}

async function detachedErrorText() {
  return evaluate(() => window.__kanbanRecipePrepareError || window.__kanbanRecipeRunStartError || null).catch(() => null);
}

async function invoke(method, input) {
  return evaluate(
    ({ method: targetMethod, input: targetInput }) => {
      const fn = window.ambientDesktop?.[targetMethod];
      if (typeof fn !== "function") throw new Error(`ambientDesktop method not found: ${targetMethod}`);
      return targetInput === undefined ? fn() : fn(targetInput);
    },
    { method, input },
  );
}

async function invokeDetached(method, input, errorSlot) {
  return evaluate(
    ({ method: targetMethod, input: targetInput, errorSlot: slot }) => {
      window[slot] = null;
      const fn = window.ambientDesktop?.[targetMethod];
      if (typeof fn !== "function") throw new Error(`ambientDesktop method not found: ${targetMethod}`);
      Promise.resolve(targetInput === undefined ? fn() : fn(targetInput)).catch((error) => {
        window[slot] = String(error && error.message ? error.message : error);
      });
      return true;
    },
    { method, input, errorSlot },
  );
}

function boardFromState(state) {
  const project = state.projects.find((candidate) => candidate.path === state.workspace.path);
  if (!project?.board) throw new Error("Expected active project to have a project board.");
  return project.board;
}

async function clickProjectBoardTab(label) {
  await evaluate((tabLabel) => {
    const button = [...document.querySelectorAll(".project-board-tabs button")].find((item) => item.querySelector("span")?.textContent?.trim() === tabLabel);
    if (!button) throw new Error(`Project board tab not found: ${tabLabel}`);
    button.click();
  }, label);
}

async function clickButton(label) {
  await evaluate((buttonLabel) => {
    const button = [...document.querySelectorAll("button")].find((item) => {
      const visible = item.textContent || "";
      const aria = item.getAttribute("aria-label") || "";
      const title = item.getAttribute("title") || "";
      return visible.includes(buttonLabel) || aria.includes(buttonLabel) || title.includes(buttonLabel);
    });
    if (!button) throw new Error(`Button not found: ${buttonLabel}`);
    button.click();
  }, label);
}

async function clickIntegrationAction(title, actionLabel) {
  await evaluate(
    ({ title: itemTitle, actionLabel: label }) => {
      const item = [...document.querySelectorAll(".project-board-proof-review-item")].find((candidate) => candidate.textContent?.includes(itemTitle));
      if (!item) throw new Error(`Integration queue item not found: ${itemTitle}`);
      const button = [...item.querySelectorAll("button")].find((candidate) => (candidate.textContent || "").includes(label));
      if (!button) throw new Error(`Integration action ${label} not found for ${itemTitle}`);
      button.click();
    },
    { title, actionLabel },
  );
}

async function waitForIntegrationStatus(title, status) {
  await waitFor(
    ({ title: itemTitle, status: expectedStatus }) =>
      [...document.querySelectorAll(".project-board-proof-review-item")].some((candidate) => candidate.textContent?.includes(itemTitle) && candidate.textContent?.includes(expectedStatus)),
    `${title} ${status}`,
    60_000,
    { title, status },
  );
}

async function elementText(selector) {
  return evaluate((targetSelector) => document.querySelector(targetSelector)?.textContent || "", selector);
}

async function assertWorkspaceFile(relativePath, expectedText) {
  await assertAbsoluteFile(join(workspace, relativePath), expectedText);
}

async function assertAbsoluteFile(path, expectedText) {
  const content = await readFile(path, "utf8");
  if (expectedText) assertIncludes(content, expectedText, path);
}

function assertFileAbsent(relativePath, label) {
  if (existsSync(join(workspace, relativePath))) throw new Error(label);
}

function assertIncludes(text, expected, label) {
  if (!text.includes(expected)) throw new Error(`Expected ${label} to include ${JSON.stringify(expected)}. Text was: ${text.slice(0, 1000)}`);
}

async function runCommand(command, args, options) {
  const startedAt = Date.now();
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const timeout = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);
  const exit = await new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  clearTimeout(timeout);
  const result = {
    command: [command, ...args].join(" "),
    cwd: options.cwd,
    code: exit.code,
    signal: exit.signal,
    stdout,
    stderr,
    durationMs: Date.now() - startedAt,
  };
  if (exit.code !== 0) {
    throw new Error(`Command failed: ${result.command}\nstdout:\n${stdout.slice(-4000)}\nstderr:\n${stderr.slice(-4000)}`);
  }
  return result;
}

function commandSummary(result) {
  return {
    command: result.command,
    code: result.code,
    durationMs: result.durationMs,
    stdoutTail: result.stdout.split("\n").slice(-10).join("\n"),
    stderrTail: result.stderr.split("\n").slice(-10).join("\n"),
  };
}

async function waitFor(predicate, label, timeoutMs = 60_000, arg) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(predicate, arg)) return;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}.`);
}

async function waitForState(producer, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await producer();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}.`);
}

async function evaluate(fn, arg) {
  const expression = `(${fn.toString()})(${arg === undefined ? "" : JSON.stringify(arg)})`;
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(description || "Runtime.evaluate failed.");
  }
  return result.result?.value;
}

async function captureScreenshot(path) {
  await mkdir(dirname(path), { recursive: true });
  const result = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(path, Buffer.from(result.data, "base64"));
}

async function connectCdp(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const callbacks = pending.get(message.id);
    if (!callbacks) return;
    pending.delete(message.id);
    if (message.error) callbacks.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else callbacks.resolve(message.result ?? {});
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP websocket failed to open.")), { once: true });
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() {
      ws.close();
    },
  };
}

async function waitForPageEndpoint(child) {
  const deadline = Date.now() + 120_000;
  let lastTargets = [];
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited before exposing CDP. Output tail:\n${output.join("").split("\n").slice(-80).join("\n")}`);
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      const targets = await response.json();
      if (Array.isArray(targets)) {
        lastTargets = targets;
        const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl && !String(target.url || "").startsWith("devtools://"));
        if (page) return page;
      }
    } catch {
      // CDP is not ready yet.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for Electron CDP page target. Last targets: ${JSON.stringify(lastTargets)}`);
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("No port allocated."))));
    });
    server.on("error", reject);
  });
}

async function terminateProcess(child) {
  if (child.exitCode !== null || child.signalCode) return;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(5_000)]);
  if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
}

async function writeReport(report) {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function classifyHarnessFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/gmi|provider|api key|stream|rate|timeout/i.test(message)) return "provider-degraded-or-timeout";
  if (/Local Task|proof|Integration|deliverable|Recipe Index|recipe|card|board|verification/i.test(message)) return "product";
  if (/cdp|electron|Ambient shell|spawn|exited/i.test(message)) return "environment-or-harness";
  return "unknown";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
