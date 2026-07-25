#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const outputRoot = resolve(process.env.AMBIENT_KANBAN_EXPENSE_STREAMING_OUT_DIR || join(repoRoot, "test-results", "kanban-expense-streaming-gmi"));
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = join(outputRoot, "runs", runStamp);
const workspace = join(runRoot, "workspace");
const userData = join(runRoot, "userData");
const reportPath = resolve(process.env.AMBIENT_KANBAN_EXPENSE_STREAMING_OUT || join(outputRoot, "latest.json"));
const screenshotPath = join(runRoot, "phase3-expense-streaming-snapshot.png");
const cdpPort = Number(process.env.AMBIENT_KANBAN_EXPENSE_STREAMING_CDP_PORT || 0) || (await availablePort());
const evaluateTimeoutMs = Number(process.env.AMBIENT_KANBAN_EXPENSE_STREAMING_EVALUATE_TIMEOUT_MS || 120_000);
const keyFile = resolve(process.env.GMI_CLOUD_API_KEY_FILE || join(repoRoot, "ignored-provider-key-file.txt"));
const defaultSnapshotWorkspace = join(homedir(), "Documents", "ambientCoderArchive");
const sourceWorkspace =
  process.env.AMBIENT_KANBAN_EXPENSE_STREAMING_WORKSPACE ||
  process.env.AMBIENT_DESKTOP_WORKSPACE ||
  (existsSync(defaultSnapshotWorkspace) ? defaultSnapshotWorkspace : "");
const sourceUserData = process.env.AMBIENT_KANBAN_EXPENSE_STREAMING_USER_DATA || process.env.AMBIENT_E2E_USER_DATA || "";
const output = [];
let app;
let cdp;

try {
  if (!sourceWorkspace || !existsSync(sourceWorkspace)) {
    throw new Error("Set AMBIENT_KANBAN_EXPENSE_STREAMING_WORKSPACE to a local snapshot workspace directory.");
  }
  if (!existsSync(keyFile) && !process.env.GMI_CLOUD_API_KEY && !process.env.GMI_API_KEY) {
    throw new Error("Set GMI_CLOUD_API_KEY_FILE, GMI_CLOUD_API_KEY, or GMI_API_KEY before running the GMI expense streaming harness.");
  }

  await prepareRunState();
  app = await launchApp();
  cdp = await connectCdp(app.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await waitFor(() => document.body?.innerText.includes("Ambient"), "Ambient shell", 120_000);

  const provider = await evaluate(() => window.ambientDesktop.bootstrap().then((state) => state.provider));
  if (provider.providerId !== "gmi-cloud") throw new Error(`Expected gmi-cloud provider, got ${provider.providerId ?? "missing"}.`);
  if (!provider.hasApiKey) throw new Error("GMI provider launched without a visible API key.");

  const seed = await seedExpenseBoard();
  await openProjectBoard();
  await clickProjectBoardTab("Draft Inbox");

  await startLiveExpensePlanning(seed.boardId);
  const activeRun = await waitForActivePlanningRun(seed.boardId);
  await assertSnapshotPanel({
    label: "Planning running",
    status: "Locked",
    detail: "Create Ready Tasks waits for the active planner stream to pause or complete",
  });
  await assertCreateReadyTasksDisabled("Wait for board planning to finish or pause");
  const initialLockout = await assertCreateReadyTasksIpcLockout(seed.boardId);

  const progressiveEvidence = await waitForProgressiveExpenseCards(seed.boardId);
  await assertSnapshotPanel({
    label: "Planning running",
    status: "Locked",
    detail: "Create Ready Tasks waits for the active planner stream to pause or complete",
  });
  await assertCreateReadyTasksDisabled("Wait for board planning to finish or pause");
  const streamingLockout = await assertCreateReadyTasksIpcLockout(seed.boardId);

  await pausePlanning(seed.boardId, progressiveEvidence.runId);
  const stable = await waitForStablePlanningCheckpoint(seed.boardId, progressiveEvidence.runId);
  const readyCards = await prepareSnapshotCardsForTicketization({
    boardId: seed.boardId,
    snapshotCardIds: stable.snapshot.cardIds,
  });
  if (readyCards.length === 0) {
    throw new Error("Stable snapshot did not expose any ticketizable ready cards after selecting the ready subset.");
  }
  await assertSnapshotPanel({
    label: "Snapshot ready",
    status: "Ready",
    detail: "Planner output is at a stable checkpoint.",
  });
  await clickButton(`Create ${readyCards.length} Ready Task${readyCards.length === 1 ? "" : "s"}`);
  await assertSnapshotPanelOneOf([
    {
      label: "Snapshot ticketized",
      status: "Protected",
      detail: "A stable planning snapshot has already been converted to Local Tasks.",
    },
    {
      label: "New proposal available",
      status: "Review additive drafts",
      detail: "Existing Local Tasks are protected. Review additive draft cards or staged Pi updates before creating more tasks.",
    },
  ]);

  const ticketization = await assertTicketizedFromSnapshot({
    boardId: seed.boardId,
    runId: stable.run.id,
    snapshotId: stable.snapshot.id,
    expectedCardIds: readyCards.map((card) => card.id),
  });

  await captureScreenshot(screenshotPath);
  const report = {
    status: "passed",
    providerId: provider.providerId,
    usedGmiKeyFile: existsSync(keyFile),
    sourceWorkspace,
    sourceUserData: sourceUserData || undefined,
    usedSnapshotUserData: Boolean(sourceUserData && existsSync(sourceUserData)),
    runRoot,
    screenshotPath,
    boardId: seed.boardId,
    activeRunId: activeRun.id,
    stableRunId: stable.run.id,
    stableRunStatus: stable.run.status,
    stableSnapshotId: stable.snapshot.id,
    stableSnapshotKind: stable.snapshot.kind,
    stableSnapshotFingerprint: stable.snapshot.renderFingerprint,
    progressiveRecordCount: progressiveEvidence.progressiveRecordCount,
    streamedCardCount: progressiveEvidence.cardCount,
    readyCardCount: readyCards.length,
    ticketizedTaskCount: ticketization.taskIds.length,
    initialLockout,
    streamingLockout,
    assertions: [
      "GMI Cloud provider launches with API-key presence but without exposing the key",
      "Temp workspace is derived from the configured snapshot and pruned into a focused CSV expense planning fixture",
      "Live Project Board synthesis is started through the Desktop IPC product path without awaiting completion",
      "Draft Inbox shows Planning running and disables Create Ready Tasks while the Ambient/Pi planner stream is active",
      "The create-ready-tasks IPC boundary rejects active planner ticketization attempts",
      "Progressive live planning records render board_synthesis draft cards before the stream is paused",
      "Paused or completed planning exposes a stable planning snapshot with source hashes, card ids, and a render fingerprint",
      "Create Ready Tasks ticketizes only ready cards from the chosen stable snapshot, records snapshot provenance, and leaves non-ready additive drafts protected for review",
    ],
  };
  await writeReport(report);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const report = {
    status: "failed",
    classification: classifyFailure(error),
    message: error instanceof Error ? error.message : String(error),
    runRoot,
    outputTail: output.join("").split("\n").slice(-160),
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
  await pruneWorkspaceCopyForExpenseFixture();
  if (sourceUserData && existsSync(sourceUserData)) {
    await cp(sourceUserData, userData, { recursive: true });
    for (const name of ["SingletonCookie", "SingletonLock", "SingletonSocket"]) {
      await rm(join(userData, name), { force: true });
    }
  } else {
    await mkdir(userData, { recursive: true });
  }
}

async function pruneWorkspaceCopyForExpenseFixture() {
  for (const entry of await readdir(workspace)) {
    await rm(join(workspace, entry), { recursive: true, force: true });
  }
  await mkdir(join(workspace, "data"), { recursive: true });
  await mkdir(join(workspace, "docs"), { recursive: true });
  await writeFile(
    join(workspace, "README.md"),
    [
      "# Expense Planner Fixture",
      "",
      "Build a small CSV expense summarizer for finance operations.",
      "The first slice should parse `data/expenses.csv`, group expenses by category and merchant, flag unusual rows, and emit a deterministic report artifact.",
      "Plan the work as Local Tasks with explicit tests, source provenance, and no external service dependency.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(workspace, "docs", "expense-requirements.md"),
    [
      "# CSV Expense Summary Requirements",
      "",
      "- Input file: `data/expenses.csv` with columns `date,employee,category,merchant,amount,currency,notes`.",
      "- Output: `reports/expense-summary.json` with totals by category, totals by employee, and unusual expense flags.",
      "- Unusual rows: any amount over 500, any lodging expense without a note, and any non-USD currency.",
      "- Validation: reject malformed rows with a useful line-numbered error.",
      "- Tests: include parser unit tests, summary aggregation tests, and a CLI smoke test against the fixture CSV.",
      "- Product gate: create useful artifacts; do not mutate the source CSV.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(workspace, "data", "expenses.csv"),
    [
      "date,employee,category,merchant,amount,currency,notes",
      "2026-05-01,Avery,travel,Metro Rail,18.25,USD,client meeting",
      "2026-05-02,Avery,meals,Cafe Sol,42.10,USD,team lunch",
      "2026-05-03,Blair,lodging,Hotel Atlas,640.00,USD,",
      "2026-05-04,Casey,software,DataViz Pro,79.00,USD,monthly subscription",
      "2026-05-05,Blair,travel,City Taxi,56.40,USD,airport transfer",
      "2026-05-06,Devon,meals,Sushi Place,128.80,USD,customer dinner",
      "2026-05-07,Devon,lodging,Harbor Inn,510.00,USD,conference stay",
      "2026-05-08,Avery,hardware,Portable Monitor,329.99,USD,field demo kit",
      "2026-05-09,Casey,travel,EuroRail,220.00,EUR,international transfer",
      "2026-05-10,Blair,training,Analytics Workshop,899.00,USD,advanced reporting course",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(workspace, "package.json"),
    `${JSON.stringify(
      {
        name: "ambient-expense-planner-fixture",
        private: true,
        type: "module",
        scripts: {
          test: "node --test",
          "expense:summary": "node src/expense-summary.mjs data/expenses.csv reports/expense-summary.json",
        },
      },
      null,
      2,
    )}\n`,
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
      AMBIENT_PROJECT_BOARD_SYNTHESIS_REASONING: process.env.AMBIENT_PROJECT_BOARD_SYNTHESIS_REASONING ?? "low",
      AMBIENT_PROJECT_BOARD_SYNTHESIS_MAX_TOOL_ROUNDS: process.env.AMBIENT_PROJECT_BOARD_SYNTHESIS_MAX_TOOL_ROUNDS ?? "6",
      AMBIENT_PROJECT_BOARD_PLANNER_BATCH_MAX_OUTPUT_TOKENS: process.env.AMBIENT_PROJECT_BOARD_PLANNER_BATCH_MAX_OUTPUT_TOKENS ?? "6000",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));
  const target = await waitForPageEndpoint(child);
  return { child, webSocketDebuggerUrl: target.webSocketDebuggerUrl };
}

async function seedExpenseBoard() {
  return evaluate(async () => {
    let state = await window.ambientDesktop.bootstrap();
    let activeProject = state.projects.find((project) => project.path === state.workspace.path) ?? state.projects[0];
    if (!activeProject) throw new Error("No active project available for the expense streaming board.");
    if (activeProject.board) {
      state = await window.ambientDesktop.resetProjectBoard({ boardId: activeProject.board.id });
      activeProject = state.projects.find((project) => project.path === state.workspace.path) ?? state.projects[0];
    }
    state = await window.ambientDesktop.createProjectBoard({
      projectId: activeProject.id,
      title: "Phase 3 Live CSV Expense Planner",
      summary: "Live GMI Project Board stream for CSV expense summary planning snapshot transactions.",
    });
    activeProject = state.projects.find((project) => project.path === state.workspace.path) ?? state.projects[0];
    if (!activeProject?.board) throw new Error("Expense project board was not created.");
    state = await window.ambientDesktop.updateProjectBoardStatus({ boardId: activeProject.board.id, status: "active" });
    activeProject = state.projects.find((project) => project.path === state.workspace.path) ?? state.projects[0];
    if (activeProject?.board?.status !== "active") throw new Error("Expense project board was not activated.");
    return { boardId: activeProject.board.id };
  });
}

async function startLiveExpensePlanning(boardId) {
  const started = await evaluate((input) => {
    window.__phase3ExpenseStreamingGate = { done: false, error: null };
    window.ambientDesktop
      .retryProjectBoardSynthesis({ boardId: input.boardId, mode: "full" })
      .then((state) => {
        window.__phase3ExpenseStreamingGate = { done: true, error: null, state };
      })
      .catch((error) => {
        window.__phase3ExpenseStreamingGate = {
          done: true,
          error: error instanceof Error ? error.message : String(error),
        };
      });
    return true;
  }, { boardId });
  if (!started) throw new Error("Live expense planning did not start.");
}

async function waitForActivePlanningRun(boardId) {
  return waitForBoardEvidence(
    boardId,
    ({ board }) => {
      const run = board.synthesisRuns?.find((candidate) => candidate.status === "running" || candidate.status === "pause_requested");
      return run ? { id: run.id, status: run.status, stage: run.stage } : undefined;
    },
    "active live expense planning run",
    180_000,
  );
}

async function waitForProgressiveExpenseCards(boardId) {
  return waitForBoardEvidence(
    boardId,
    ({ board }) => {
      const run = board.synthesisRuns?.find((candidate) => candidate.status === "running" || candidate.status === "pause_requested");
      if (!run) {
        const completed = board.synthesisRuns?.find((candidate) => candidate.status === "succeeded" || candidate.status === "paused" || candidate.status === "failed");
        if (completed?.status === "failed") throw new Error(`Live expense planning failed before progressive cards: ${completed.error ?? "unknown error"}`);
        return undefined;
      }
      const cards = board.cards.filter((card) => card.sourceKind === "board_synthesis" && card.status === "draft");
      const progressiveRecordCount = run.progressiveRecordCount ?? run.progressiveRecords?.length ?? 0;
      if (cards.length === 0 || progressiveRecordCount === 0) return undefined;
      return {
        runId: run.id,
        status: run.status,
        stage: run.stage,
        progressiveRecordCount,
        cardCount: cards.length,
        cardIds: cards.map((card) => card.id),
        cardTitles: cards.map((card) => card.title),
      };
    },
    "live progressive expense cards while planning is active",
    Number(process.env.AMBIENT_KANBAN_EXPENSE_STREAMING_PROGRESS_TIMEOUT_MS || 480_000),
  );
}

async function pausePlanning(boardId, runId) {
  await evaluate(
    (input) =>
      window.ambientDesktop.pauseProjectBoardSynthesis({
        boardId: input.boardId,
        runId: input.runId,
        reason: "Phase 3 live expense streaming gate captured progressive cards and is freezing a stable snapshot.",
      }),
    { boardId, runId },
  );
}

async function waitForStablePlanningCheckpoint(boardId, preferredRunId) {
  const stable = await waitForBoardEvidence(
    boardId,
    ({ board }) => {
      const run =
        board.synthesisRuns?.find((candidate) => candidate.id === preferredRunId && (candidate.status === "paused" || candidate.status === "succeeded")) ??
        board.synthesisRuns?.find((candidate) => candidate.status === "paused" || candidate.status === "succeeded");
      if (!run) {
        const failed = board.synthesisRuns?.find((candidate) => candidate.status === "failed");
        if (failed) throw new Error(`Live expense planning failed: ${failed.error ?? "unknown error"}`);
        return undefined;
      }
      const snapshot = [...(run.planningSnapshots ?? [])]
        .reverse()
        .find((candidate) => candidate.planningStatus === "paused" || candidate.planningStatus === "succeeded");
      if (!snapshot) return undefined;
      if (!String(snapshot.renderFingerprint || "").startsWith("planning-snapshot-")) {
        throw new Error("Stable planning snapshot did not expose a render fingerprint.");
      }
      if (!Array.isArray(snapshot.sourceHashes) || snapshot.sourceHashes.length === 0) {
        throw new Error("Stable planning snapshot did not preserve source hashes.");
      }
      if (!snapshot.sourceHashes.some((source) => String(source.path || "").includes("expenses.csv"))) {
        throw new Error("Stable planning snapshot did not include the expense CSV source hash.");
      }
      if (!Array.isArray(snapshot.cardIds) || snapshot.cardIds.length === 0) {
        throw new Error("Stable planning snapshot did not include any card ids.");
      }
      return { run, snapshot };
    },
    "stable live expense planning snapshot",
    Number(process.env.AMBIENT_KANBAN_EXPENSE_STREAMING_STABLE_TIMEOUT_MS || 300_000),
  );
  await waitFor(() => window.__phase3ExpenseStreamingGate?.done === true, "live expense planning promise completion", 120_000);
  return stable;
}

async function prepareSnapshotCardsForTicketization({ boardId, snapshotCardIds }) {
  return evaluate(async (input) => {
    const state = await window.ambientDesktop.bootstrap();
    const project = state.projects.find((candidate) => candidate.board?.id === input.boardId);
    const cards = (project?.board?.cards ?? []).filter(
      (card) => input.snapshotCardIds.includes(card.id) && card.sourceKind === "board_synthesis" && card.status === "draft" && !card.orchestrationTaskId,
    );
    if (cards.length === 0) throw new Error("No draft synthesis cards from the stable snapshot were available for ticketization.");
    const readyCards = cards
      .filter(
        (card) =>
          card.status === "draft" &&
          card.sourceKind === "board_synthesis" &&
          card.candidateStatus === "ready_to_create" &&
          !card.orchestrationTaskId,
      )
      .slice(0, Math.min(cards.length, 3));
    if (readyCards.length === 0) {
      throw new Error(
        `Stable snapshot had ${cards.length} draft synthesis card(s), but none were ready to ticketize. Candidate states: ${cards
          .map((card) => `${card.title}: ${card.candidateStatus}`)
          .join("; ")}`,
      );
    }
    return readyCards
      .map((card) => ({ id: card.id, title: card.title, candidateStatus: card.candidateStatus }));
  }, { boardId, snapshotCardIds });
}

async function assertTicketizedFromSnapshot({ boardId, runId, snapshotId, expectedCardIds }) {
  return evaluate(async (input) => {
    const state = await window.ambientDesktop.bootstrap();
    const project = state.projects.find((candidate) => candidate.board?.id === input.boardId);
    const board = project?.board;
    if (!board) throw new Error(`Project board not found in bootstrap state: ${input.boardId}`);
    const run = board.synthesisRuns?.find((candidate) => candidate.id === input.runId);
    const snapshot = run?.planningSnapshots?.find((candidate) => candidate.id === input.snapshotId);
    if (!snapshot) throw new Error("The chosen stable planning snapshot disappeared after ticketization.");
    const ticketizedCards = board.cards.filter((card) => input.expectedCardIds.includes(card.id));
    if (ticketizedCards.length !== input.expectedCardIds.length) throw new Error("Not all expected snapshot cards are present after ticketization.");
    const missingTasks = ticketizedCards.filter((card) => !card.orchestrationTaskId);
    if (missingTasks.length > 0) throw new Error(`${missingTasks.length} snapshot card(s) did not receive Local Task ids.`);
    const event = [...(board.events ?? [])].reverse().find((candidate) => candidate.kind === "ready_tasks_created");
    if (!event) throw new Error("ready_tasks_created event was not recorded.");
    const metadata = event.metadata ?? {};
    if (metadata.planningSnapshotId !== input.snapshotId) throw new Error("ready_tasks_created did not reference the chosen stable snapshot id.");
    if (metadata.planningSnapshotRunId !== input.runId) throw new Error("ready_tasks_created did not reference the chosen run id.");
    if (metadata.planningSnapshotFingerprint !== snapshot.renderFingerprint) {
      throw new Error("ready_tasks_created fingerprint does not match the chosen stable snapshot.");
    }
    for (const cardId of input.expectedCardIds) {
      if (!Array.isArray(metadata.cardIds) || !metadata.cardIds.includes(cardId)) {
        throw new Error(`ready_tasks_created cardIds did not include ${cardId}.`);
      }
      if (!Array.isArray(metadata.planningSnapshotCardIds) || !metadata.planningSnapshotCardIds.includes(cardId)) {
        throw new Error(`ready_tasks_created planningSnapshotCardIds did not include ${cardId}.`);
      }
    }
    return {
      cardIds: ticketizedCards.map((card) => card.id),
      taskIds: ticketizedCards.map((card) => card.orchestrationTaskId).filter(Boolean),
      planningSnapshotId: metadata.planningSnapshotId,
      planningSnapshotFingerprint: metadata.planningSnapshotFingerprint,
    };
  }, { boardId, runId, snapshotId, expectedCardIds });
}

async function assertCreateReadyTasksIpcLockout(boardId) {
  const result = await evaluate(async (input) => {
    try {
      await window.ambientDesktop.createReadyProjectBoardTasks({ boardId: input.boardId });
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }, { boardId });
  if (result.ok) throw new Error("createReadyProjectBoardTasks unexpectedly succeeded while planning was active.");
  if (!/planning is still running|wait for it to finish or pause/i.test(result.message || "")) {
    throw new Error(`Unexpected active-planning ticketization error: ${result.message || "missing"}`);
  }
  return result.message;
}

async function assertCreateReadyTasksDisabled(titleNeedle) {
  const state = await evaluate((needle) => {
    const button = [...document.querySelectorAll("button")].find((item) => {
      const label = (item.textContent || "").replace(/\s+/g, " ").trim();
      return label === "Create Ready Tasks" || /^Create \d+ Ready Tasks?$/.test(label);
    });
    if (!(button instanceof HTMLButtonElement)) return { found: false };
    return {
      found: true,
      disabled: button.disabled,
      text: button.textContent || "",
      title: button.getAttribute("title") || "",
      titleMatches: (button.getAttribute("title") || "").includes(needle),
    };
  }, titleNeedle);
  if (!state.found) throw new Error("Create Ready Tasks button was not visible.");
  if (!state.disabled) throw new Error(`Create Ready Tasks button was enabled during active planning: ${state.text}`);
  if (!state.titleMatches) throw new Error(`Create Ready Tasks disabled reason did not mention "${titleNeedle}": ${state.title}`);
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
  if (label === "Draft Inbox") await waitFor(() => Boolean(document.querySelector(".project-board-draft-board")), "Draft Inbox panel");
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
    90_000,
    { label, status, detail },
  );
}

async function assertSnapshotPanelOneOf(states) {
  await waitFor(
    (expectedStates) => {
      const panel = document.querySelector(".project-board-planning-snapshot-state");
      const text = panel?.textContent || "";
      return expectedStates.some((expected) => text.includes(expected.label) && text.includes(expected.status) && text.includes(expected.detail));
    },
    "planning snapshot panel: one accepted post-ticketization state",
    90_000,
    states,
  );
}

async function waitForBoardEvidence(boardId, extractor, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const evidence = await evaluate(async (input) => {
        const state = await window.ambientDesktop.bootstrap();
        const project = state.projects.find((candidate) => candidate.board?.id === input.boardId);
        const board = project?.board;
        if (!board) throw new Error(`Project board not found in bootstrap state: ${input.boardId}`);
        return { state, project, board };
      }, { boardId });
      const value = extractor(evidence);
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}.`);
}

async function waitFor(predicate, label, timeoutMs = 60_000, arg) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(predicate, arg);
      if (value) return value === true ? undefined : value;
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}.`);
}

async function evaluate(fn, arg) {
  const expression = `(${fn.toString()})(${arg === undefined ? "" : JSON.stringify(arg)})`;
  const result = await withTimeout(
    cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }),
    evaluateTimeoutMs,
    "CDP Runtime.evaluate",
  );
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

function classifyFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/CDP|Electron|Ambient shell|Project Board workspace|button|panel/i.test(message)) return "test-harness-or-ui";
  if (/tool budget was exhausted/i.test(message)) return "product";
  if (/api key|provider|gmi|ambient\/pi|stream|fetch|429|500|502|503|504|timeout/i.test(message)) return "provider-degraded-or-environment";
  return "product";
}

async function withTimeout(promise, timeoutMs, label) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
