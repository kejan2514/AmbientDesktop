#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const outputRoot = resolve(
  process.env.AMBIENT_KANBAN_ADD_CARDS_AFTER_TICKETIZATION_OUT_DIR || join(tmpdir(), "ambient-kanban-add-cards-after-ticketization-gmi"),
);
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = join(outputRoot, "runs", runStamp);
const workspace = join(runRoot, "workspace");
const userData = join(runRoot, "userData");
const reportPath = resolve(process.env.AMBIENT_KANBAN_ADD_CARDS_AFTER_TICKETIZATION_OUT || join(outputRoot, "latest.json"));
const snapshotScreenshotPath = join(runRoot, "phase3-add-cards-snapshot-ticketized.png");
const sourceScopeScreenshotPath = join(runRoot, "phase3-add-cards-source-scope.png");
const proposalScreenshotPath = join(runRoot, "phase3-add-cards-proposal.png");
const finalScreenshotPath = join(runRoot, "phase3-add-cards-final-drafts.png");
const cdpPort = Number(process.env.AMBIENT_KANBAN_ADD_CARDS_AFTER_TICKETIZATION_CDP_PORT || 0) || (await availablePort());
const addCardsMaxElapsedMs = Number(process.env.AMBIENT_KANBAN_ADD_CARDS_AFTER_TICKETIZATION_MAX_TIMEOUT_MS || 0) || 900_000;
const addCardsIdleMs = Number(process.env.AMBIENT_KANBAN_ADD_CARDS_AFTER_TICKETIZATION_IDLE_TIMEOUT_MS || 0) || 240_000;
const defaultRepoKeyFile = join(repoRoot, "ignored-provider-key-file.txt");
const defaultHomeCheckoutKeyFile = join(homedir(), "ambientCoder", "ignored-provider-key-file.txt");
const keyFile = resolve(
  process.env.GMI_CLOUD_API_KEY_FILE ||
    (existsSync(defaultRepoKeyFile) ? defaultRepoKeyFile : defaultHomeCheckoutKeyFile),
);
const defaultSnapshotWorkspace = join(homedir(), "Documents", "ambientCoderArchive");
const sourceWorkspace =
  process.env.AMBIENT_KANBAN_ADD_CARDS_AFTER_TICKETIZATION_SNAPSHOT_WORKSPACE ||
  process.env.AMBIENT_DESKTOP_WORKSPACE ||
  (existsSync(defaultSnapshotWorkspace) ? defaultSnapshotWorkspace : "");
const sourceUserData =
  process.env.AMBIENT_KANBAN_ADD_CARDS_AFTER_TICKETIZATION_SNAPSHOT_USER_DATA || process.env.AMBIENT_E2E_USER_DATA || "";
const fixtureDir = "00-phase3-recipe-index";
const initialSourcePath = `${fixtureDir}/01-core-index-spec.md`;
const addedSourcePath = `${fixtureDir}/02-mobile-sharing-spec.md`;
const addedSourceTitle = "Recipe Index Mobile Sharing Spec";

const output = [];
let app;
let cdp;

try {
  if (!sourceWorkspace || !existsSync(sourceWorkspace)) {
    throw new Error("Set AMBIENT_KANBAN_ADD_CARDS_AFTER_TICKETIZATION_SNAPSHOT_WORKSPACE to a local snapshot workspace directory.");
  }
  if (!existsSync(keyFile) && !process.env.GMI_CLOUD_API_KEY && !process.env.GMI_API_KEY) {
    throw new Error("Set GMI_CLOUD_API_KEY_FILE, GMI_CLOUD_API_KEY, or GMI_API_KEY before running the GMI Add Cards after ticketization gate.");
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

  const seed = await createTicketizedRecipeSnapshotBoard();
  await openProjectBoard();
  await clickProjectBoardTab("Draft Inbox");
  await assertSnapshotPanel({
    label: "Snapshot ready",
    status: "Ready",
    detail: "Planner output is at a stable checkpoint.",
  });
  await clickButton("Create 1 Ready Task");
  await assertSnapshotPanel({
    label: "Snapshot ticketized",
    status: "Protected",
    detail: "A stable planning snapshot has already been converted to Local Tasks.",
  });
  await captureScreenshot(snapshotScreenshotPath);

  const protectedBefore = await protectedCardSnapshot(seed.boardId, seed.cardId);
  if (!protectedBefore.orchestrationTaskId) throw new Error("The chosen snapshot card was not ticketized before Add Cards.");
  const taskCountAfterTicketization = await projectBoardTaskCount(seed.boardId);
  if (taskCountAfterTicketization !== 1) {
    throw new Error(`Expected one Local Task immediately after ticketization, got ${taskCountAfterTicketization}.`);
  }

  await writeAddedRecipeSource();
  const sourceRefreshState = await invoke("refreshProjectBoardSources", { boardId: seed.boardId });
  let board = boardFromState(sourceRefreshState, seed.boardId);
  const refreshedSource = findSourceByPath(board, addedSourcePath);
  if (!refreshedSource) throw new Error(`Source refresh did not persist ${addedSourcePath}.`);
  const addCardsSource =
    refreshedSource.kind === "ignored" || refreshedSource.includeInSynthesis === false || refreshedSource.authorityRole === "ignored"
      ? findSourceByPath(await updateSourceForAddCards(refreshedSource.id, seed.boardId), addedSourcePath)
      : refreshedSource;
  if (!addCardsSource) throw new Error(`Unable to prepare ${addedSourcePath} as an included Add Cards source.`);
  if (addCardsSource.kind === "ignored" || addCardsSource.includeInSynthesis === false || addCardsSource.authorityRole === "ignored") {
    throw new Error(`${addedSourcePath} remained excluded from Add Cards after source refresh and reclassification.`);
  }

  await clickProjectBoardTab("Draft Inbox");
  await clickButton("Open Source Review");
  await waitFor(() => Boolean(document.querySelector(".project-board-source-review")), "source review panel");
  await waitFor((title) => document.querySelector(".project-board-source-review")?.textContent?.includes(title), addedSourceTitle, 60_000, addedSourceTitle);
  await selectSourceReviewItem(addedSourceTitle);
  await waitFor(
    (title) => {
      const detail = document.querySelector(".project-board-source-detail");
      const text = detail?.textContent || "";
      return text.includes(title) && text.includes("Elaborate Cards");
    },
    "selected source detail Add Cards flow",
    60_000,
    addedSourceTitle,
  );
  await captureScreenshot(sourceScopeScreenshotPath);

  const runIdsBeforeAddCards = board.synthesisRuns.map((run) => run.id);
  await clickSourceDetailElaborate();
  const addCardsRun = await waitForAddCardsRunTerminal(seed.boardId, runIdsBeforeAddCards);
  if (addCardsRun.status !== "succeeded") {
    throw new Error(`Add Cards source elaboration failed. Status=${addCardsRun.status}; error=${addCardsRun.error ?? "none"}.`);
  }

  board = await waitForState(async () => {
    const state = await invoke("bootstrap");
    const current = boardFromState(state, seed.boardId);
    const pending = current.proposals.find((proposal) => proposal.status === "pending");
    return pending?.cards.length ? current : undefined;
  }, "pending Add Cards proposal", 90_000);
  const pendingProposal = board.proposals.find((proposal) => proposal.status === "pending");
  if (!pendingProposal) throw new Error("Add Cards completed without a pending reviewable proposal.");
  const proposalAssertion = assertAdditiveProposalShape({ proposal: pendingProposal, protectedBefore, addCardsSource });
  await clickProjectBoardTab("Decisions");
  await waitFor(() => document.querySelector(".project-board-proposal-panel")?.textContent?.includes("Pi proposal"), "Decisions proposal panel");
  await captureScreenshot(proposalScreenshotPath);
  await acceptVisibleProposalCards(pendingProposal.id);
  await clickApplyVisibleProposal(pendingProposal.id);

  const finalBoard = await waitForState(async () => {
    const state = await invoke("bootstrap");
    const current = boardFromState(state, seed.boardId);
    const proposal = current.proposals.find((candidate) => candidate.id === pendingProposal.id);
    const additiveDrafts = additiveDraftCards(current, protectedBefore, addCardsSource);
    return proposal?.status === "applied" && additiveDrafts.length > 0 ? current : undefined;
  }, "applied Add Cards proposal and additive draft cards", 90_000);
  const finalAssertion = assertAdditiveBoundary({
    board: finalBoard,
    protectedBefore,
    addCardsSource,
    proposalId: pendingProposal.id,
  });
  await clickProjectBoardTab("Draft Inbox");
  await waitFor(
    ({ expectedTitles }) => {
      const text = document.querySelector(".project-board-draft-board")?.textContent || "";
      return expectedTitles.some((title) => text.includes(title));
    },
    "additive Draft Inbox cards",
    60_000,
    { expectedTitles: finalAssertion.additiveDraftTitles },
  );
  await captureScreenshot(finalScreenshotPath);

  const report = {
    status: "passed",
    providerId: provider.providerId,
    usedGmiKeyFile: existsSync(keyFile),
    sourceWorkspace,
    usedSnapshotUserData: Boolean(sourceUserData && existsSync(sourceUserData)),
    runRoot,
    workspace,
    boardId: seed.boardId,
    ticketizedCardId: seed.cardId,
    ticketizedTaskId: protectedBefore.orchestrationTaskId,
    taskCountAfterTicketization,
    taskCountAfterAddCardsApply: finalAssertion.taskCountAfterApply,
    initialSourcePath,
    addedSource: {
      id: addCardsSource.id,
      path: addCardsSource.path,
      kind: addCardsSource.kind,
      includeInSynthesis: addCardsSource.includeInSynthesis,
      authorityRole: addCardsSource.authorityRole,
      changeState: addCardsSource.changeState,
      contentHash: addCardsSource.contentHash,
    },
    addCardsRun: {
      id: addCardsRun.id,
      status: addCardsRun.status,
      stage: addCardsRun.stage,
      cardCount: addCardsRun.cardCount,
      questionCount: addCardsRun.questionCount,
      warningCount: addCardsRun.warningCount,
    },
    proposal: {
      id: pendingProposal.id,
      proposedCardCount: pendingProposal.cards.length,
      proposedTitles: pendingProposal.cards.map((card) => card.title),
      groundedCardCount: proposalAssertion.groundedCardCount,
    },
    additiveDrafts: finalAssertion.additiveDrafts,
    screenshots: {
      snapshotTicketized: snapshotScreenshotPath,
      sourceScope: sourceScopeScreenshotPath,
      proposal: proposalScreenshotPath,
      finalDraftInbox: finalScreenshotPath,
    },
    assertions: [
      "Desktop launched with the temporary GMI Cloud provider override without exposing the API key",
      "A completed planning snapshot was ticketized through the visible Draft Inbox Create Ready Tasks control",
      "A new source file was added only to a temp copy of the snapshot and refreshed into board source inventory",
      "The visible source inspector selected the new source and submitted a bounded GMI Add Cards source elaboration run",
      "Add Cards produced a reviewable pending proposal before any Draft Inbox mutation",
      "Proposal cards were reviewed and applied through visible Decisions UI controls",
      "The ticketized Local Task card kept its id, title, description, acceptance criteria, and Local Task link",
      "The applied output is additive Draft Inbox work with no duplicate Local Tasks and source provenance for the new file",
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
  await writeInitialRecipeSource();
}

async function sanitizeTempWorkspace() {
  for (const path of [
    ".ambient",
    ".ambient-codex",
    ".git",
    "coverage",
    "dist",
    "docs",
    "node_modules",
    "out",
    "recipes",
    "release",
    "test-results",
    "tests",
    fixtureDir,
  ]) {
    await rm(join(workspace, path), { recursive: true, force: true });
  }
  for (const path of ["ignored-provider-key-file.txt", "ignored-provider-key-file.txt", "brave_api_key.txt", ".env", ".env.local"]) {
    await rm(join(workspace, path), { force: true });
  }
  await removeCredentialNamedFiles(workspace, 3);
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

async function writeInitialRecipeSource() {
  await mkdir(join(workspace, fixtureDir), { recursive: true });
  await writeFile(
    join(workspace, initialSourcePath),
    [
      "# Recipe Index Core Spec",
      "",
      "Functional specification for the first recipe-index slice.",
      "",
      "Requirements:",
      "- Scan markdown recipes from a recipes/ directory.",
      "- Generate INDEX.md deterministically with recipe titles, tags, and ingredient counts.",
      "- Provide a dependency-free Node verification command for the generated index.",
      "",
      "Acceptance criteria:",
      "- The core Local Task owns build-index.mjs and INDEX.md.",
      "- Later mobile sharing, shopping list export, and share card work must be planned as additive cards.",
    ].join("\n"),
    "utf8",
  );
}

async function writeAddedRecipeSource() {
  await writeFile(
    join(workspace, addedSourcePath),
    [
      `# ${addedSourceTitle}`,
      "",
      "Functional specification for additive recipe-index work after the core snapshot has already been ticketized.",
      "",
      "New product requirements:",
      "- Add a shopping-list export path that turns selected recipes into grouped grocery sections.",
      "- Add a mobile share card preview with recipe title, tags, prep time, and copied share URL.",
      "- Keep these as separate follow-up cards unless one card would be materially clearer for review.",
      "",
      "Non-goals:",
      "- Do not rewrite the core recipe index Local Task.",
      "- Do not replace the existing INDEX.md generation card.",
      "- Do not create duplicate Local Tasks for already ticketized work.",
      "",
      "Proof expectations:",
      "- Proposed cards should include at least one local data-shape or rendering check.",
      "- Source references should cite this mobile sharing spec.",
    ].join("\n"),
    "utf8",
  );
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
      AMBIENT_PROJECT_BOARD_SYNTHESIS_MAX_TOOL_ROUNDS: process.env.AMBIENT_PROJECT_BOARD_SYNTHESIS_MAX_TOOL_ROUNDS ?? "6",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));
  const target = await waitForPageEndpoint(child);
  return { child, webSocketDebuggerUrl: target.webSocketDebuggerUrl };
}

async function createTicketizedRecipeSnapshotBoard() {
  const initialState = await invoke("bootstrap");
  const activeProject = initialState.projects.find((project) => project.path === initialState.workspace.path) ?? initialState.projects[0];
  if (!activeProject) throw new Error("No active project available for Add Cards after ticketization gate.");
  const stateWithBoard = activeProject.board
    ? initialState
    : await invoke("createProjectBoard", {
        projectId: activeProject.id,
        title: "Phase 3 Recipe Index Add Cards Gate Board",
        summary: "Live gate for source-scoped Add Cards after a ticketized planning snapshot.",
      });
  let board = boardFromState(stateWithBoard);
  if (board.status !== "active") {
    board = boardFromState(await invoke("updateProjectBoardStatus", { boardId: board.id, status: "active" }), board.id);
  }
  await invoke("seedProjectBoardSemanticIdleDogfood", { boardId: board.id });
  let state = await invoke("bootstrap");
  board = boardFromState(state, board.id);
  const card = board.cards.find((candidate) => candidate.sourceId === "synthesis:dogfood-foundation-shell");
  if (!card) throw new Error("Semantic-idle seed did not create the expected planning snapshot card.");
  const answeredAt = new Date().toISOString();
  const clarificationAnswers = (card.clarificationQuestions ?? []).map((question) => ({
    question,
    answer: "Use the deterministic recipe index core as the chosen Phase 3 ticketized snapshot card.",
    answeredAt,
  }));
  const updatedState = await invoke("updateProjectBoardCard", {
    cardId: card.id,
    title: "Build the recipe index core",
    description: "Scan recipe markdown and generate a deterministic INDEX.md. This is the first chosen planning snapshot card.",
    candidateStatus: "ready_to_create",
    phase: "Foundation",
    labels: ["phase-3", "recipe-index", "snapshot", "live-gmi"],
    blockedBy: [],
    sourceRefs: [initialSourcePath],
    clarificationAnswers,
    acceptanceCriteria: [
      "Core recipe index work is represented as exactly one ticketized Local Task.",
      "Later mobile sharing and shopping-list work remains additive Add Cards scope.",
    ],
    testPlan: {
      unit: ["Run node --check build-index.mjs."],
      integration: ["Run node build-index.mjs against markdown recipes."],
      visual: [],
      manual: ["Review INDEX.md for deterministic ordering."],
    },
  });
  board = boardFromState(updatedState, board.id);
  const updatedCard = board.cards.find((candidate) => candidate.id === card.id);
  if (updatedCard?.candidateStatus !== "ready_to_create") throw new Error("Recipe index snapshot card was not marked ready to create.");
  return { boardId: board.id, cardId: card.id };
}

async function updateSourceForAddCards(sourceId, boardId) {
  const state = await invoke("updateProjectBoardSource", {
    sourceId,
    kind: "functional_spec",
    includeInSynthesis: true,
  });
  return boardFromState(state, boardId);
}

async function openProjectBoard() {
  const opened = await evaluate(() => {
    if (document.querySelector(".project-board-workspace")) return true;
    const button = [...document.querySelectorAll("button")].find((item) => {
      const text = `${item.textContent || ""} ${item.getAttribute("aria-label") || ""} ${item.getAttribute("title") || ""}`;
      return /Open Board|Build Board|Project Kanban/i.test(text);
    });
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  });
  if (!opened) throw new Error("Unable to open Project Board.");
  await waitFor(() => Boolean(document.querySelector(".project-board-workspace")), "Project Board workspace");
}

async function clickProjectBoardTab(label) {
  await waitFor(() => Boolean(document.querySelector(".project-board-tabs")), "project board tabs");
  const clicked = await evaluate((tabLabel) => {
    const button = [...document.querySelectorAll(".project-board-tabs button")].find((item) => {
      const text = (item.textContent || "").replace(/\s+/g, " ").trim();
      return text === tabLabel || text.startsWith(tabLabel);
    });
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  }, label);
  if (!clicked) throw new Error(`Project board tab not found: ${label}`);
}

async function clickButton(label) {
  const clicked = await evaluate((buttonLabel) => {
    const button = [...document.querySelectorAll("button")].find((item) => {
      const text = `${item.textContent || ""} ${item.getAttribute("aria-label") || ""} ${item.getAttribute("title") || ""}`;
      return text.includes(buttonLabel) && !item.disabled;
    });
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  }, label);
  if (!clicked) throw new Error(`Enabled button not found: ${label}`);
}

async function assertSnapshotPanel({ label, status, detail }) {
  await waitFor(
    (expected) => {
      const panel = document.querySelector(".project-board-planning-snapshot-state");
      const text = panel?.textContent || "";
      return text.includes(expected.label) && text.includes(expected.status) && text.includes(expected.detail);
    },
    `planning snapshot panel: ${label}`,
    60_000,
    { label, status, detail },
  );
}

async function selectSourceReviewItem(title) {
  const selected = await evaluate((sourceTitle) => {
    const review = document.querySelector(".project-board-source-review");
    const item = [...(review?.querySelectorAll(".project-board-source-item") ?? [])].find((candidate) =>
      (candidate.textContent || "").includes(sourceTitle),
    );
    if (!(item instanceof HTMLElement)) return false;
    item.click();
    return true;
  }, title);
  if (!selected) throw new Error(`Unable to select source review item: ${title}`);
}

async function clickSourceDetailElaborate() {
  const clicked = await evaluate(() => {
    const detail = document.querySelector(".project-board-source-detail");
    const button = [...(detail?.querySelectorAll("button") ?? [])].find((item) => {
      const text = item.textContent || "";
      return text.includes("Elaborate Cards") && !item.disabled;
    });
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  });
  if (!clicked) throw new Error("Enabled source-detail Elaborate Cards button was not found.");
}

async function acceptVisibleProposalCards(proposalId) {
  let safety = 0;
  while (safety++ < 20) {
    const pendingCount = await proposalPendingCardCount(proposalId);
    if (pendingCount === 0) return;
    const clicked = await evaluate(() => {
      const pendingCard = [...document.querySelectorAll(".project-board-card.proposal-pending")].find((item) =>
        item.querySelector(".project-board-proposal-review"),
      );
      const button = [...(pendingCard?.querySelectorAll("button") ?? [])].find((item) => (item.textContent || "").trim() === "Accept" && !item.disabled);
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    });
    if (!clicked) throw new Error("No enabled Accept button found for pending proposal cards.");
    await waitForState(async () => {
      const nextCount = await proposalPendingCardCount(proposalId);
      return nextCount < pendingCount ? true : undefined;
    }, "proposal card acceptance", 30_000);
  }
  throw new Error("Proposal card acceptance exceeded safety limit.");
}

async function clickApplyVisibleProposal(proposalId) {
  await waitForState(async () => ((await proposalPendingCardCount(proposalId)) === 0 ? true : undefined), "all proposal cards reviewed", 30_000);
  const clicked = await evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((item) => {
      const text = (item.textContent || "").replace(/\s+/g, " ").trim();
      return /^Apply \d+ Cards?$/.test(text) && !item.disabled;
    });
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  });
  if (!clicked) throw new Error("Enabled Apply Cards proposal button was not found.");
}

async function proposalPendingCardCount(proposalId) {
  const state = await invoke("bootstrap");
  const board = boardFromState(state);
  const proposal = board.proposals.find((candidate) => candidate.id === proposalId);
  if (!proposal) throw new Error(`Proposal disappeared: ${proposalId}`);
  return proposal.cards.filter((card) => card.reviewStatus === "pending").length;
}

async function waitForAddCardsRunTerminal(boardId, previousRunIds) {
  const previous = new Set(previousRunIds);
  const startedAt = Date.now();
  let lastActivityAt = Date.now();
  let lastSignature = "";
  while (Date.now() - startedAt < addCardsMaxElapsedMs) {
    const state = await invoke("bootstrap");
    const board = boardFromState(state, boardId);
    const run = board.synthesisRuns.find((candidate) => {
      if (previous.has(candidate.id)) return false;
      return candidate.events.some((event) => event.title === "Selected source scope" || event.metadata?.sourceElaboration === true);
    });
    if (run) {
      const signature = synthesisRunSignature(run);
      if (signature !== lastSignature) {
        lastSignature = signature;
        lastActivityAt = Date.now();
      }
      if (["succeeded", "failed", "paused", "abandoned"].includes(run.status)) return run;
      if (Date.now() - lastActivityAt > addCardsIdleMs) {
        throw new Error(`Add Cards run ${run.id} stalled for ${addCardsIdleMs.toLocaleString()}ms without visible state progress.`);
      }
    }
    await delay(1000);
  }
  throw new Error(`Timed out waiting for Add Cards source elaboration after ${addCardsMaxElapsedMs.toLocaleString()}ms.`);
}

function synthesisRunSignature(run) {
  return [
    run.id,
    run.status,
    run.stage,
    run.updatedAt,
    run.completedAt,
    run.error,
    run.cardCount,
    run.questionCount,
    run.warningCount,
    run.responseCharCount,
    run.progressiveRecordCount,
    run.events.length,
  ].join("|");
}

async function protectedCardSnapshot(boardId, cardId) {
  const state = await invoke("bootstrap");
  const board = boardFromState(state, boardId);
  const card = board.cards.find((candidate) => candidate.id === cardId);
  if (!card) throw new Error(`Protected card not found: ${cardId}`);
  const task = card.orchestrationTaskId ? await waitForTask(card.orchestrationTaskId) : undefined;
  return {
    cardId: card.id,
    sourceId: card.sourceId,
    title: card.title,
    description: card.description,
    acceptanceCriteria: card.acceptanceCriteria,
    testPlan: card.testPlan,
    sourceRefs: card.sourceRefs,
    status: card.status,
    candidateStatus: card.candidateStatus,
    orchestrationTaskId: card.orchestrationTaskId,
    taskTitle: task?.title,
    taskDescription: task?.description,
  };
}

async function waitForTask(taskId) {
  return waitForState(async () => {
    const board = await invoke("listOrchestrationBoard");
    return board.tasks.find((candidate) => candidate.id === taskId);
  }, `Local Task ${taskId}`, 60_000);
}

async function projectBoardTaskCount(boardId) {
  const state = await invoke("bootstrap");
  const board = boardFromState(state, boardId);
  return board.cards.filter((card) => Boolean(card.orchestrationTaskId)).length;
}

function assertAdditiveProposalShape({ proposal, protectedBefore, addCardsSource }) {
  if (proposal.cards.length === 0) throw new Error("Add Cards proposal did not contain cards.");
  const duplicateTitle = proposal.cards.find((card) => normalized(card.title) === normalized(protectedBefore.title));
  if (duplicateTitle) throw new Error(`Add Cards proposal duplicated the ticketized card title: ${duplicateTitle.title}`);
  const duplicateSource = proposal.cards.find((card) => card.sourceId === protectedBefore.sourceId);
  if (duplicateSource) throw new Error(`Add Cards proposal reused the ticketized card source id: ${duplicateSource.sourceId}`);
  const groundedCards = proposal.cards.filter((card) => proposalCardGroundedInSource(card, addCardsSource));
  const scopedCards = proposal.cards.filter((card) => card.objectiveProvenance?.selectedSourceIds?.includes(addCardsSource.id));
  if (groundedCards.length === 0 && scopedCards.length === 0) {
    throw new Error(`No Add Cards proposal card cited or carried provenance for ${addCardsSource.path ?? addCardsSource.id}.`);
  }
  return { groundedCardCount: groundedCards.length || scopedCards.length };
}

function assertAdditiveBoundary({ board, protectedBefore, addCardsSource, proposalId }) {
  const protectedAfter = board.cards.find((card) => card.id === protectedBefore.cardId);
  if (!protectedAfter) throw new Error("Ticketized card disappeared after Add Cards proposal apply.");
  const protectedFields = {
    title: protectedAfter.title,
    description: protectedAfter.description,
    acceptanceCriteria: protectedAfter.acceptanceCriteria,
    testPlan: protectedAfter.testPlan,
    sourceRefs: protectedAfter.sourceRefs,
    status: protectedAfter.status,
    candidateStatus: protectedAfter.candidateStatus,
    orchestrationTaskId: protectedAfter.orchestrationTaskId,
  };
  const expectedFields = {
    title: protectedBefore.title,
    description: protectedBefore.description,
    acceptanceCriteria: protectedBefore.acceptanceCriteria,
    testPlan: protectedBefore.testPlan,
    sourceRefs: protectedBefore.sourceRefs,
    status: protectedBefore.status,
    candidateStatus: protectedBefore.candidateStatus,
    orchestrationTaskId: protectedBefore.orchestrationTaskId,
  };
  if (JSON.stringify(protectedFields) !== JSON.stringify(expectedFields)) {
    throw new Error(`Ticketized card mutated after Add Cards apply.\nBefore: ${JSON.stringify(expectedFields)}\nAfter: ${JSON.stringify(protectedFields)}`);
  }
  const duplicateProtectedSource = board.cards.filter((card) => card.sourceId === protectedBefore.sourceId);
  if (duplicateProtectedSource.length !== 1) {
    throw new Error(`Expected one card for protected source ${protectedBefore.sourceId}, got ${duplicateProtectedSource.length}.`);
  }
  const taskCountAfterApply = board.cards.filter((card) => Boolean(card.orchestrationTaskId)).length;
  if (taskCountAfterApply !== 1) throw new Error(`Add Cards apply created duplicate Local Tasks; task count is ${taskCountAfterApply}.`);
  const additiveCards = additiveDraftCards(board, protectedBefore, addCardsSource);
  if (additiveCards.length === 0) throw new Error("Add Cards proposal apply did not produce additive Draft Inbox cards.");
  const proposal = board.proposals.find((candidate) => candidate.id === proposalId);
  if (proposal?.status !== "applied") throw new Error(`Expected proposal ${proposalId} to be applied, got ${proposal?.status ?? "missing"}.`);
  const event = board.events?.find((candidate) => candidate.kind === "synthesis_proposal_applied" && candidate.entityId === proposalId);
  if (!event) throw new Error("Add Cards proposal apply event was not recorded.");
  return {
    taskCountAfterApply,
    additiveDraftTitles: additiveCards.map((card) => card.title),
    additiveDrafts: additiveCards.map((card) => ({
      id: card.id,
      sourceId: card.sourceId,
      title: card.title,
      candidateStatus: card.candidateStatus,
      sourceRefs: card.sourceRefs,
      objectiveProvenance: card.objectiveProvenance,
    })),
  };
}

function additiveDraftCards(board, protectedBefore, addCardsSource) {
  return board.cards.filter((card) => {
    if (card.id === protectedBefore.cardId) return false;
    if (card.sourceKind !== "board_synthesis") return false;
    if (card.status !== "draft") return false;
    if (card.orchestrationTaskId) return false;
    return proposalCardGroundedInSource(card, addCardsSource) || card.objectiveProvenance?.selectedSourceIds?.includes(addCardsSource.id);
  });
}

function proposalCardGroundedInSource(card, source) {
  const refs = [...(card.sourceRefs ?? []), card.description ?? "", card.title ?? ""].map((item) => normalized(item));
  const path = normalized(source.path ?? "");
  const title = normalized(source.title ?? "");
  return refs.some((ref) => (path && ref.includes(path)) || (title && ref.includes(title)) || ref.includes("shopping") || ref.includes("share"));
}

function findSourceByPath(board, path) {
  return board.sources.find((source) => source.path === path || source.path?.endsWith(path));
}

function boardFromState(state, boardId) {
  const project = boardId
    ? state.projects.find((candidate) => candidate.board?.id === boardId)
    : state.projects.find((candidate) => candidate.path === state.workspace.path) ?? state.projects[0];
  if (!project?.board) throw new Error("Expected active project to have a project board.");
  return project.board;
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
  if (/source review|source detail|source picker|button|cdp|electron|Ambient shell|spawn|exited|websocket/i.test(message)) return "environment-or-harness";
  if (/gmi|provider|api key|stream|rate|timeout|timed out|stalled/i.test(message)) return "provider-degraded-or-timeout";
  if (/Add Cards|proposal|ticketized|Local Task|source|Draft Inbox|Project board|card|snapshot|mutation|duplicate/i.test(message)) return "product";
  return "unknown";
}

function normalized(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
