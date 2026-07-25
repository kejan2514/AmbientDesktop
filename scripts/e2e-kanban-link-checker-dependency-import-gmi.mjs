#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const outputRoot = resolve(process.env.AMBIENT_KANBAN_LINK_CHECKER_DEP_IMPORT_OUT_DIR || join(tmpdir(), "ambient-kanban-link-checker-dependency-import-gmi"));
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = join(outputRoot, "runs", runStamp);
const workspace = join(runRoot, "workspace");
const userData = join(runRoot, "userData");
const reportPath = resolve(process.env.AMBIENT_KANBAN_LINK_CHECKER_DEP_IMPORT_OUT || join(outputRoot, "latest.json"));
const boardScreenshotPath = join(runRoot, "phase4-link-checker-board.png");
const dependencyScreenshotPath = join(runRoot, "phase4-link-checker-dependency-artifacts.png");
const cdpPort = Number(process.env.AMBIENT_KANBAN_LINK_CHECKER_DEP_IMPORT_CDP_PORT || 0) || (await availablePort());
const workerIdleTimeoutMs = Number(process.env.AMBIENT_KANBAN_LINK_CHECKER_DEP_IMPORT_IDLE_TIMEOUT_MS || 0) || 240_000;
const workerRunMaxElapsedMs = Number(process.env.AMBIENT_KANBAN_LINK_CHECKER_DEP_IMPORT_MAX_TIMEOUT_MS || 0) || 900_000;
const defaultRepoKeyFile = join(repoRoot, "ignored-provider-key-file.txt");
const defaultHomeCheckoutKeyFile = join(homedir(), "ambientCoder", "ignored-provider-key-file.txt");
const keyFile = resolve(process.env.GMI_CLOUD_API_KEY_FILE || (existsSync(defaultRepoKeyFile) ? defaultRepoKeyFile : defaultHomeCheckoutKeyFile));
const defaultSnapshotWorkspace = join(homedir(), "Documents", "ambientCoderArchive");
const sourceWorkspace =
  process.env.AMBIENT_KANBAN_LINK_CHECKER_DEP_IMPORT_SNAPSHOT_WORKSPACE ||
  process.env.AMBIENT_DESKTOP_WORKSPACE ||
  (existsSync(defaultSnapshotWorkspace) ? defaultSnapshotWorkspace : "");
const sourceUserData = process.env.AMBIENT_KANBAN_LINK_CHECKER_DEP_IMPORT_SNAPSHOT_USER_DATA || process.env.AMBIENT_E2E_USER_DATA || "";

const cards = {
  fixtures: {
    key: "fixtures",
    title: `Phase 4 Gate A fixture docs ${runStamp}`,
    expectedFiles: ["docs/intro.md", "docs/guide.md", "docs/api.md", "tests/verify-fixture-docs.mjs"],
  },
  checker: {
    key: "checker",
    title: `Phase 4 Gate A markdown link checker ${runStamp}`,
    expectedFiles: ["check-links.mjs", "tests/verify-link-checker.mjs", "link-check-report.json"],
  },
};

const output = [];
let app;
let cdp;

try {
  if (!sourceWorkspace || !existsSync(sourceWorkspace)) {
    throw new Error("Set AMBIENT_KANBAN_LINK_CHECKER_DEP_IMPORT_SNAPSHOT_WORKSPACE to a local snapshot workspace directory.");
  }
  if (!existsSync(keyFile) && !process.env.GMI_CLOUD_API_KEY && !process.env.GMI_API_KEY) {
    throw new Error("Set GMI_CLOUD_API_KEY_FILE, GMI_CLOUD_API_KEY, or GMI_API_KEY before running the GMI dependency import gate.");
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

  const fixture = await approveRunAndVerifyCard(cardByKey.fixtures, cards.fixtures);
  const checker = await approveRunAndVerifyCard(cardByKey.checker, cards.checker, {
    descriptionIncludes: ["Dependency execution context:", "Ambient imports material files from available dependencies", "Declared import files: docs/intro.md"],
    descriptionExcludes: ["Copy the dependency", "Copy dependency", "sibling task workspace"],
    expectedDependencyFiles: ["docs/intro.md", "docs/guide.md", "docs/api.md"],
  });

  const linkCheckReport = await assertLinkCheckReport(join(checker.run.workspacePath, "link-check-report.json"));
  await assertDependencyImportBundle(checker.run, ["docs/intro.md", "docs/guide.md", "docs/api.md"]);
  await captureScreenshot(dependencyScreenshotPath);

  const report = {
    status: "passed",
    providerId: provider.providerId,
    usedGmiKeyFile: existsSync(keyFile),
    sourceWorkspace,
    usedSnapshotUserData: Boolean(sourceUserData && existsSync(sourceUserData)),
    runRoot,
    boardId: board.id,
    cards: [fixture, checker].map((item) => ({
      key: item.spec.key,
      cardId: item.card.id,
      taskId: item.card.orchestrationTaskId,
      runId: item.run.id,
      runStatus: item.run.status,
      runWorkspacePath: item.run.workspacePath,
      changedPaths: item.changedPaths,
      taskActions: item.taskActions,
      proofReview: item.reviewedCard.proofReview,
      dependencyArtifacts: item.dependencyArtifacts
        ? {
            artifactRoot: item.dependencyArtifacts.artifactRoot,
            importCount: item.dependencyArtifacts.imports.length,
            materialFiles: item.dependencyArtifacts.imports.flatMap((entry) => entry.materialFiles),
            skippedFiles: item.dependencyArtifacts.imports.flatMap((entry) => entry.skippedFiles),
            excludedFiles: item.dependencyArtifacts.imports.flatMap((entry) => entry.excludedFiles),
          }
        : undefined,
    })),
    linkCheckReport,
    screenshots: { board: boardScreenshotPath, dependencyArtifacts: dependencyScreenshotPath },
    assertions: [
      "Fixture docs card ran first and produced markdown docs plus a verifier as material Local Task artifacts",
      "Dependent link-checker card was ticketized only after fixture completion, so its Local Task prompt contained dependency artifact context",
      "Prepared dependent run imported fixture docs under .ambient/dependency-artifacts before worker execution",
      "Dependent task description preferred imported dependency artifacts and did not include raw sibling-workspace copy instructions",
      "Live GMI worker implemented and ran the markdown link checker against imported fixture docs",
      "Final dependent output included check-links.mjs, tests/verify-link-checker.mjs, and link-check-report.json with no broken links",
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
  if (!activeProject) throw new Error("No active project available for dependency import gate.");
  const stateWithBoard = activeProject.board
    ? initialState
    : await invoke("createProjectBoard", {
        projectId: activeProject.id,
        title: "Phase 4 Dependency Artifact Import Gate Board",
        summary: "Live Gate A proof for explicit dependency artifact imports.",
      });
  let board = boardFromState(stateWithBoard);
  if (board.status !== "active") {
    board = boardFromState(await invoke("updateProjectBoardStatus", { boardId: board.id, status: "active" }));
  }

  const fixtures = await createReadyCard(board.id, cards.fixtures.title, fixtureDocsDescription(), {
    priority: 1,
    labels: ["phase-4", "dependency-artifacts", "fixture-docs", "live-gmi"],
    blockedBy: [],
    acceptanceCriteria: [
      "Create three linked markdown fixture docs under docs/.",
      "Create tests/verify-fixture-docs.mjs and run it successfully.",
      "Report project-board proof with changedFiles covering all docs and the verifier.",
    ],
    testPlan: {
      unit: ["Run node tests/verify-fixture-docs.mjs."],
      integration: [],
      visual: [],
      manual: [],
    },
  });

  const checker = await createReadyCard(board.id, cards.checker.title, linkCheckerDescription(), {
    priority: 2,
    labels: ["phase-4", "dependency-artifacts", "link-checker", "live-gmi"],
    blockedBy: [fixtures.id],
    acceptanceCriteria: [
      "Use .ambient/dependency-artifacts/manifest.json as the fixture-doc source of truth.",
      "Implement check-links.mjs and tests/verify-link-checker.mjs.",
      "Run the checker against the imported dependency docs and write link-check-report.json.",
      "Report project-board proof with changedFiles covering only material checker outputs.",
    ],
    testPlan: {
      unit: ["Run node --check check-links.mjs and node tests/verify-link-checker.mjs."],
      integration: ["Run node check-links.mjs against the imported dependency docs and verify zero broken links."],
      visual: [],
      manual: [],
    },
  });

  board = boardFromState(await invoke("bootstrap"));
  return { board, cardByKey: { fixtures, checker } };
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
    phase: "Phase 4 Gate A",
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

function fixtureDocsDescription() {
  return [
    "Create deterministic markdown fixture docs in this card's writable task workspace. Do not modify the owning project root directly; the Integration Queue can apply deliverables later.",
    "",
    "Required files:",
    "- docs/intro.md with title '# Intro', links to guide.md and api.md, and a short product overview.",
    "- docs/guide.md with title '# Guide', a link back to intro.md, a link to api.md, and setup notes.",
    "- docs/api.md with title '# API', a link back to guide.md, and endpoint notes.",
    "- tests/verify-fixture-docs.mjs: dependency-free Node verifier that asserts all three docs exist and all relative links resolve.",
    "",
    "Verification command to run from the task workspace:",
    "- node tests/verify-fixture-docs.mjs",
    "",
    "Project-board reporting contract:",
    "- First, call native task_heartbeat with the immediate plan before editing files. If native task tools are unavailable, emit a fenced task_actions JSON fallback.",
    "- After writing and verifying files, call task_report_proof with changedFiles exactly including docs/intro.md, docs/guide.md, docs/api.md, and tests/verify-fixture-docs.mjs, and commands including node tests/verify-fixture-docs.mjs.",
    "- Then call task_complete only when those files and commands are complete.",
    "- Do not install dependencies, call network services, read secrets, or write outside the task workspace.",
  ].join("\n");
}

function linkCheckerDescription() {
  return [
    "Create a dependency-free markdown link checker in this card's writable task workspace. Do not modify the owning project root directly; the Integration Queue can apply deliverables later.",
    "",
    "Dependency artifact contract:",
    "- Use .ambient/dependency-artifacts/manifest.json as the source of truth for fixture docs from the completed dependency card.",
    "- Read the first import's filesRoot from that manifest and run the checker against the imported docs under filesRoot/docs.",
    "- Prefer imported dependency artifacts. If a fallback dependency workspace path appears in context, use it only for bounded inspection after the artifact manifest is missing or incomplete.",
    "- Runtime files under .ambient/ are not material deliverables. Do not report .ambient/dependency-artifacts in changedFiles.",
    "",
    "Required files:",
    "- check-links.mjs: dependency-free Node ESM script exporting checkMarkdownLinks(root). It scans markdown files, resolves relative .md links, returns checkedFiles and brokenLinks, and supports --root <path> --report <path>.",
    "- tests/verify-link-checker.mjs: dependency-free Node verifier that reads .ambient/dependency-artifacts/manifest.json, runs check-links.mjs against the imported docs, asserts zero broken links, and verifies link-check-report.json.",
    "- link-check-report.json: report generated by check-links.mjs against the imported dependency docs. It must include checkedFiles and brokenLinks.",
    "",
    "Verification commands to run from the task workspace:",
    "- node --check check-links.mjs",
    "- node check-links.mjs --root <filesRoot-from-.ambient/dependency-artifacts/manifest.json>/docs --report link-check-report.json",
    "- node tests/verify-link-checker.mjs",
    "",
    "Project-board reporting contract:",
    "- First, call native task_heartbeat with the immediate plan before editing files.",
    "- After writing and verifying files, call task_report_proof with changedFiles exactly including check-links.mjs, tests/verify-link-checker.mjs, and link-check-report.json, commands including all verification commands, and dependencyImports including the imported dependency filesRoot.",
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

  await invoke("prepareNextOrchestrationTasks");
  const { run: preparedRun } = await waitForPreparedOrStartedRun(ticketized.orchestrationTaskId, spec.title);
  const dependencyArtifacts = await dependencyArtifactsForPreparedRun(preparedRun, expectations.expectedDependencyFiles);
  if (preparedRun.status === "prepared") await invoke("startOrchestrationRun", { runId: preparedRun.id });
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
  return { spec, card: reviewedCard, run, taskActions, changedPaths, reviewedCard, dependencyArtifacts };
}

async function dependencyArtifactsForPreparedRun(run, expectedFiles = []) {
  const artifacts = run.proofOfWork?.dependencyArtifacts;
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
  const imported = manifest.imports[0];
  for (const file of expectedFiles) {
    await assertAbsoluteFile(join(imported.filesRoot, file), expectedNeedleForFile(file));
  }
  if ((imported.skippedFiles ?? []).length) throw new Error(`Dependency artifact import skipped files: ${imported.skippedFiles.join(", ")}`);
  return manifest;
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
  if (file === "docs/intro.md") return "# Intro";
  if (file === "docs/guide.md") return "# Guide";
  if (file === "docs/api.md") return "# API";
  if (file === "tests/verify-fixture-docs.mjs") return "";
  if (file === "check-links.mjs") return "checkMarkdownLinks";
  if (file === "tests/verify-link-checker.mjs") return "link-check-report.json";
  if (file === "link-check-report.json") return "brokenLinks";
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

async function assertLinkCheckReport(path) {
  const text = await assertAbsoluteFile(path, '"brokenLinks"');
  const report = JSON.parse(text);
  const brokenLinks = Array.isArray(report.brokenLinks) ? report.brokenLinks : [];
  if (brokenLinks.length > 0) throw new Error(`Link checker reported broken links: ${JSON.stringify(brokenLinks)}`);
  const checkedFiles = Array.isArray(report.checkedFiles) ? report.checkedFiles.map((item) => String(item)) : [];
  for (const file of ["intro.md", "guide.md", "api.md"]) {
    if (!checkedFiles.some((checked) => checked.endsWith(file))) {
      throw new Error(`Link checker report did not include ${file}. checkedFiles=${checkedFiles.join(", ")}`);
    }
  }
  return { checkedFiles, brokenLinks };
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
  if (/Local Task|proof|dependency artifact|artifact import|project-board|card|board|verification/i.test(message)) return "product";
  return "test harness";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
