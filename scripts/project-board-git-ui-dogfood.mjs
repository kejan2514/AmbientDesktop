#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const cdpCommandTimeoutMs = Number(process.env.AMBIENT_PROJECT_BOARD_GIT_UI_CDP_TIMEOUT_MS || 0) || 20_000;
const port = await findOpenPort(Number(process.env.AMBIENT_PROJECT_BOARD_GIT_UI_CDP_PORT || 0) || 0);
const runRoot = join(process.cwd(), "test-results", "project-board-git-ui-dogfood");
const remotePath = join(runRoot, "remote.git");
const seedPath = join(runRoot, "seed");
const cloneAPath = join(runRoot, "clone-a-collaborator");
const cloneBPath = join(runRoot, "clone-b-app");
const userData = join(runRoot, "user-data");
const resultsDir = join(runRoot, "results");
const output = [];
const ambientApiKey = await readAmbientApiKey();
const liveObjectiveContinuation = process.env.AMBIENT_PROJECT_BOARD_GIT_UI_LIVE_OBJECTIVE_CONTINUATION === "1";
let appInstance;

try {
  await rm(runRoot, { recursive: true, force: true });
  await mkdir(resultsDir, { recursive: true });
  await seedTwoCloneRepository();

  appInstance = await launchApp(cloneBPath);
  const cdp = appInstance.cdp;
  await setViewport(cdp, 1680, 1050);
  await waitFor(cdp, () => document.body?.innerText.includes("Ambient"), "Ambient shell");

  const initial = await createInitialBoard(cdp);
  await invoke(cdp, "commitProjectBoardGitArtifacts", { boardId: initial.board.id, message: "Seed project board UI dogfood artifacts" });
  await invoke(cdp, "pushProjectBoardGitArtifacts", { boardId: initial.board.id });

  await writeCollaboratorHandoff(initial);
  const localBoard = await markLocalControlsCardInProgress(cdp, initial.controlsCard.id);
  assert(
    localBoard.cards.find((card) => card.id === initial.controlsCard.id)?.status === "in_progress",
    "Expected clone B controls card to be in progress before pulling collaborator artifacts.",
  );

  await waitFor(cdp, () => [...document.querySelectorAll("button")].some((button) => button.textContent?.includes("Open Board")), "Open Board button");
  await clickButton(cdp, "Open Board");
  await waitFor(cdp, () => document.querySelector(".project-board-workspace")?.textContent?.includes("Project board"), "project board workspace");
  await waitFor(cdp, () => [...document.querySelectorAll("button")].some((button) => button.textContent?.includes("Pull Board") && !button.disabled), "Pull Board enabled");
  await clickButton(cdp, "Pull Board");
  await waitFor(cdp, () => document.querySelector(".project-board-projection-review")?.textContent?.includes("Resolve pulled card conflicts"), "pull conflict review");
  await waitFor(cdp, () => document.querySelector(".project-board-projection-review")?.textContent?.includes("execution proof/handoff"), "pulled runtime review row");
  await waitFor(cdp, () => document.querySelector(".project-board-projection-review")?.textContent?.includes("Pi worker task action task_heartbeat"), "pulled task-action event row");

  const pullReviewBeforeApply = await projectionReviewSnapshot(cdp);
  await clickProjectionReviewResolution(cdp, "Implement ship controls", "Keep local");
  await clickProjectionReviewResolution(cdp, "Create PixiJS shell", "Apply pulled");
  await waitFor(cdp, () => document.querySelector(".project-board-projection-review")?.textContent?.includes("re-export this local card as an overlay"), "keep-local overlay consequence");
  await waitFor(cdp, () => [...document.querySelectorAll("button")].some((button) => button.textContent?.includes("Apply Resolved Pull") && !button.disabled), "Apply Resolved Pull enabled");
  await captureScreenshot(cdp, "01-pull-review.png");

  await evaluate(cdp, "window.confirm = () => true");
  await clickButton(cdp, "Apply Resolved Pull");
  await waitFor(cdp, () => !document.querySelector(".project-board-projection-review"), "pull review dismissed after apply", 30_000);

  const applied = await currentBoard(cdp);
  const appliedControls = applied.cards.find((card) => card.id === initial.controlsCard.id);
  const appliedFoundation = requireCard(applied, initial.foundationCard.id);
  const followUp = applied.cards.find((card) => card.sourceKind === "run_follow_up");
  const pulledTaskActionEvents =
    applied.events?.filter((event) => typeof event.metadata?.action === "string" && String(event.metadata.action).startsWith("task_")) ?? [];
  assert(appliedControls?.status === "in_progress", `Expected local controls card to remain in progress, got ${appliedControls?.status ?? "missing"}.`);
  assert(
    appliedControls?.claim?.status === "expired" && appliedControls.claim.expirationRecorded !== true,
    `Expected pulled stale controls claim to be visible before recovery, got ${JSON.stringify(appliedControls?.claim ?? null)}.`,
  );
  assert(applied.executionArtifacts?.length === 1, `Expected one pulled execution artifact, got ${applied.executionArtifacts?.length ?? 0}.`);
  assert(followUp?.title.includes("resize regression"), `Expected pulled handoff follow-up card, got ${followUp?.title ?? "missing"}.`);
  const objectiveCard = applied.cards.find((card) => card.sourceId === "objective:swimlane-filter-shortcuts");
  assert(objectiveCard, "Expected pulled objective Add Cards artifact to create an objective card.");
  assert(
    objectiveCard.objectiveProvenance?.objective === "Add accessible swimlane filtering follow-up cards from the source scan.",
    `Expected objective provenance to survive the pull/apply path, got ${JSON.stringify(objectiveCard.objectiveProvenance ?? null)}.`,
  );
  assert(
    objectiveCard.objectiveProvenance?.groundingMode === "source_scan" &&
      objectiveCard.objectiveProvenance.sourceRefCount === 1 &&
      objectiveCard.objectiveProvenance.weakGrounding === false,
    `Expected source-scan grounded objective provenance, got ${JSON.stringify(objectiveCard.objectiveProvenance ?? null)}.`,
  );
  assert(
    objectiveCard.sourceRefs?.includes("KANBAN_ACCESSIBILITY.md"),
    `Expected pulled objective card to preserve human-readable source path lineage, got ${JSON.stringify(objectiveCard.sourceRefs ?? [])}.`,
  );
  assert(
    pulledTaskActionEvents.some((event) => event.metadata?.action === "task_heartbeat"),
    `Expected pulled task-action events to include task_heartbeat, got ${pulledTaskActionEvents.map((event) => event.metadata?.action).join(", ") || "none"}.`,
  );
  assert(
    appliedFoundation.claim?.status === "active" && (appliedFoundation.claimConflicts?.length ?? 0) === 1,
    `Expected pulled foundation claim conflict before recovery, got ${JSON.stringify({
      claim: appliedFoundation.claim ?? null,
      conflicts: appliedFoundation.claimConflicts ?? [],
    })}.`,
  );

  const afterConflictState = await invoke(cdp, "resolveProjectBoardGitCardClaimConflicts", {
    boardId: initial.board.id,
    cardId: initial.foundationCard.id,
  });
  const afterConflict = boardFromState(afterConflictState);
  const resolvedFoundation = requireCard(afterConflict, initial.foundationCard.id);
  assert(
    resolvedFoundation.claim?.status === "active" &&
      resolvedFoundation.claim.agentId === "collaborator-foundation-owner" &&
      (resolvedFoundation.claimConflicts?.length ?? 0) === 0,
    `Expected competing foundation claim to be resolved while preserving the first owner, got ${JSON.stringify({
      claim: resolvedFoundation.claim ?? null,
      conflicts: resolvedFoundation.claimConflicts ?? [],
    })}.`,
  );

  const afterExpireState = await invoke(cdp, "expireProjectBoardGitCardClaim", { boardId: initial.board.id, cardId: initial.controlsCard.id });
  const afterExpire = boardFromState(afterExpireState);
  const expiredControls = requireCard(afterExpire, initial.controlsCard.id);
  assert(
    expiredControls.claim?.status === "expired" && expiredControls.claim.expirationRecorded === true,
    `Expected stale controls claim expiry to be recorded through the app boundary, got ${JSON.stringify(expiredControls.claim ?? null)}.`,
  );
  const afterClaimState = await invoke(cdp, "claimProjectBoardGitCard", { boardId: initial.board.id, cardId: initial.controlsCard.id });
  const afterClaim = boardFromState(afterClaimState);
  const claimedControls = requireCard(afterClaim, initial.controlsCard.id);
  assert(
    claimedControls.claim?.status === "active" && claimedControls.claim.ownedByLocal === true,
    `Expected recovered controls card to be claimed by this desktop, got ${JSON.stringify(claimedControls.claim ?? null)}.`,
  );

  await clickButton(cdp, "Board");
  await waitFor(cdp, () => document.querySelector(".project-board-workspace")?.textContent?.includes("Claimed here"), "recovered claim visible on board");
  await captureScreenshot(cdp, "02-claim-recovery.png");

  await clickButton(cdp, "PM Review");
  await waitFor(cdp, () => document.querySelector(".project-board-proposal-history")?.textContent?.includes("Pulled execution review"), "PM Review pulled execution section");
  await waitFor(cdp, () => document.body.innerText.includes("Shell is ready for controls"), "PM Review pulled handoff summary");
  await captureScreenshot(cdp, "03-pm-review.png");

  await clickButton(cdp, "Draft Inbox");
  await waitFor(cdp, () => document.querySelector(".project-board-draft-board")?.textContent?.includes("Add resize regression coverage"), "Draft Inbox pulled follow-up");
  await captureScreenshot(cdp, "04-draft-inbox-follow-up.png");
  await waitFor(cdp, () => document.querySelector(".project-board-draft-board")?.textContent?.includes("Add swimlane filter shortcuts"), "Draft Inbox pulled objective card");
  await waitFor(cdp, () => document.querySelector(".project-board-draft-board")?.textContent?.includes("Add Cards objective"), "Draft Inbox objective provenance");
  await waitFor(cdp, () => document.querySelector(".project-board-draft-board")?.textContent?.includes("Source-scan grounded"), "Draft Inbox source-scan grounding");
  await captureScreenshot(cdp, "05-draft-inbox-objective-card.png");
  const liveObjectiveContinuationResult = liveObjectiveContinuation
    ? await runLiveObjectiveContinuation(cdp, initial.board.id, objectiveCard)
    : {
        skipped: true,
        reason: "Set AMBIENT_PROJECT_BOARD_GIT_UI_LIVE_OBJECTIVE_CONTINUATION=1 to ask Pi for a net-new objective card after in-app handoff adoption.",
      };

  await writeFile(
    join(resultsDir, "manifest.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        remotePath,
        cloneA: cloneAPath,
        cloneB: cloneBPath,
        boardId: initial.board.id,
        localCard: {
          id: claimedControls.id,
          title: claimedControls.title,
          status: claimedControls.status,
          orchestrationTaskId: claimedControls.orchestrationTaskId,
          claim: claimedControls.claim,
        },
        staleClaimRecovery: {
          before: appliedControls.claim,
          afterExpiry: expiredControls.claim,
          afterClaim: claimedControls.claim,
        },
        claimConflictRecovery: {
          before: {
            active: appliedFoundation.claim,
            conflicts: appliedFoundation.claimConflicts,
          },
          after: {
            active: resolvedFoundation.claim,
            conflicts: resolvedFoundation.claimConflicts,
          },
        },
        pulledRuntimeArtifactCount: applied.executionArtifacts?.length ?? 0,
        pulledTaskActionEventCount: pulledTaskActionEvents.length,
        pulledTaskActions: pulledTaskActionEvents.map((event) => ({ kind: event.kind, title: event.title, action: event.metadata?.action })),
        pulledFollowUp: followUp
          ? {
              id: followUp.id,
              title: followUp.title,
              candidateStatus: followUp.candidateStatus,
              blockedBy: followUp.blockedBy,
            }
          : undefined,
        pulledObjectiveCard: objectiveCard
          ? {
              id: objectiveCard.id,
              title: objectiveCard.title,
              candidateStatus: objectiveCard.candidateStatus,
              blockedBy: objectiveCard.blockedBy,
              sourceRefs: objectiveCard.sourceRefs,
              objectiveProvenance: objectiveCard.objectiveProvenance,
            }
          : undefined,
        liveObjectiveContinuation: liveObjectiveContinuationResult,
        pullReviewBeforeApply,
        conclusion:
          "Card-first conflict resolution was sufficient for this dogfood: clone B kept active local card work while importing clone A task-action audit events, proof/handoff runtime artifacts, a stale claim, a true competing claim, a handoff follow-up candidate, and an objective Add Cards artifact with source-path lineage. Stale ownership was recovered through the app boundary by recording expiry and reclaiming the card; competing ownership was recovered by expiring the later losing claim while preserving the earliest active owner; objective provenance stayed visible in Draft Inbox after the pull/apply flow. When the live continuation lane is enabled, Pi must add a net-new objective proposal without recreating the inherited objective card.",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log(`Project board Git UI dogfood passed. Results: ${resultsDir}`);
} catch (error) {
  await writeFile(join(resultsDir, "electron-output.log"), output.join(""), "utf8").catch(() => undefined);
  throw error;
} finally {
  if (appInstance?.child) await terminateProcessTree(appInstance.child);
}

async function runLiveObjectiveContinuation(cdp, boardId, inheritedObjectiveCard) {
  const objective =
    "Add one net-new objective card for keyboard shortcut discoverability or help text. Do not recreate the inherited Add swimlane filter shortcuts card, and do not rebuild the existing board shell.";
  const before = await currentBoard(cdp);
  const previousProposalIds = new Set((before.proposals ?? []).map((proposal) => proposal.id));
  const previousRunIds = new Set((before.synthesisRuns ?? []).map((run) => run.id));
  const attempts = [];
  let outcome;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await startLiveObjectiveContinuation(cdp, { boardId, objective });
    outcome = await waitForLiveObjectiveContinuationOutcome(cdp, {
      boardId,
      previousProposalIds,
      previousRunIds,
    });
    if (outcome.proposal) {
      attempts.push({
        attempt,
        status: "proposal_ready",
        runId: outcome.run?.id,
        proposalId: outcome.proposal.id,
        runStatus: outcome.run?.status,
        runStage: outcome.run?.stage,
      });
      break;
    }
    attempts.push({
      attempt,
      status: "retryable_failure",
      runId: outcome.run?.id,
      runStatus: outcome.run?.status,
      runStage: outcome.run?.stage,
      error: outcome.error,
    });
    if (outcome.run?.id) previousRunIds.add(outcome.run.id);
    if (attempt === 2 || !isRetryableLiveObjectiveContinuationError(outcome.error)) {
      throw new Error(`Live objective continuation failed after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${outcome.error}`);
    }
  }
  const proposal = outcome?.proposal;
  const run = outcome?.run;
  assert(proposal, `Expected live objective continuation to produce a proposal, attempts: ${JSON.stringify(attempts)}.`);
  const inheritedTitle = inheritedObjectiveCard.title.toLowerCase();
  const continuationCards = proposal.cards.filter((card) => card.sourceId !== inheritedObjectiveCard.sourceId);
  assert(continuationCards.length > 0, "Expected live objective continuation to propose at least one card beyond the inherited objective card.");
  assert(
    proposal.cards.every((card) => card.title.trim().toLowerCase() !== inheritedTitle),
    `Live objective continuation recreated inherited card title ${inheritedObjectiveCard.title}: ${JSON.stringify(proposal.cards.map((card) => card.title))}.`,
  );
  assert(
    proposal.cards.every((card) => card.sourceId !== inheritedObjectiveCard.sourceId),
    `Live objective continuation reused inherited source id ${inheritedObjectiveCard.sourceId}.`,
  );
  const continuationText = JSON.stringify(proposal.cards).toLowerCase();
  assert(
    /shortcut|discover|help|keyboard/.test(continuationText),
    `Expected live objective continuation to target shortcut/help/keyboard discoverability, got ${JSON.stringify(proposal.cards)}.`,
  );
  assert(
    !continuationText.includes("basic kanban board shell"),
    `Live objective continuation should not recreate the basic board shell: ${JSON.stringify(proposal.cards)}.`,
  );
  const provenance = proposal.cards.find((card) => card.objectiveProvenance)?.objectiveProvenance;
  assert(
    provenance?.objective === objective,
    `Expected live continuation proposal cards to preserve objective provenance, got ${JSON.stringify(provenance ?? null)}.`,
  );
  const firstContinuationTitle = continuationCards[0]?.title ?? proposal.cards[0].title;
  await clickButton(cdp, "PM Review");
  await waitForBodyText(cdp, firstContinuationTitle, "PM Review live objective continuation");
  await captureScreenshot(cdp, "06-pm-review-live-objective-continuation.png");
  return {
    skipped: false,
    objective,
    proposalId: proposal.id,
    runId: run?.id,
    runStatus: run?.status,
    runStage: run?.stage,
    model: proposal.model,
    durationMs: proposal.durationMs,
    promptCharCount: run?.promptCharCount,
    responseCharCount: run?.responseCharCount,
    cardCount: proposal.cards.length,
    attempts,
    proposedCards: proposal.cards.map((card) => ({
      sourceId: card.sourceId,
      title: card.title,
      candidateStatus: card.candidateStatus,
      sourceRefs: card.sourceRefs,
      objectiveProvenance: card.objectiveProvenance,
    })),
  };
}

async function startLiveObjectiveContinuation(cdp, input) {
  await evaluate(
    cdp,
    [
      "window.__projectBoardGitUiLiveContinuationError = null;",
      "window.ambientDesktop.refineProjectBoardSynthesis(",
      JSON.stringify({ boardId: input.boardId, mode: "source_elaboration", objective: input.objective }),
      ").catch((error) => { window.__projectBoardGitUiLiveContinuationError = String(error && error.message ? error.message : error); });",
      "true",
    ].join(""),
  );
}

async function waitForLiveObjectiveContinuationOutcome(cdp, { boardId, previousProposalIds, previousRunIds }) {
  return waitForState(
    cdp,
    async () => {
      const board = await currentBoard(cdp);
      const run = latestNewSynthesisRun(board, previousRunIds);
      const proposal = latestNewPendingProposal(board, previousProposalIds);
      if (proposal && proposal.boardId === boardId && proposal.cards.length > 0 && (!run || run.status === "succeeded" || run.proposalId === proposal.id)) {
        return { board, proposal, run };
      }
      if (run?.status === "failed") return { board, run, error: run.error || run.events?.at(-1)?.summary || "unknown live continuation failure" };
      const detachedError = await evaluate(cdp, "window.__projectBoardGitUiLiveContinuationError || null").catch(() => null);
      if (detachedError) return { board, run, error: detachedError };
      return undefined;
    },
    "live objective continuation proposal",
    900_000,
  ).catch(async (error) => {
    const board = await currentBoard(cdp).catch(() => undefined);
    const run = board ? latestNewSynthesisRun(board, previousRunIds) : undefined;
    const detachedError = await evaluate(cdp, "window.__projectBoardGitUiLiveContinuationError || null").catch(() => null);
    return {
      board,
      run,
      error: detachedError || run?.error || error.message || String(error),
    };
  });
}

function isRetryableLiveObjectiveContinuationError(error) {
  return /cards must be an array|valid progressive|candidate cards|validation|schema|records/i.test(String(error ?? ""));
}

function latestNewPendingProposal(board, previousProposalIds) {
  return [...(board.proposals ?? [])]
    .filter((proposal) => proposal.status === "pending" && !previousProposalIds.has(proposal.id))
    .sort((left, right) => Date.parse(right.updatedAt ?? right.createdAt ?? "") - Date.parse(left.updatedAt ?? left.createdAt ?? ""))
    .at(0);
}

function latestNewSynthesisRun(board, previousRunIds) {
  return [...(board.synthesisRuns ?? [])]
    .filter((run) => !previousRunIds.has(run.id))
    .sort((left, right) => Date.parse(right.updatedAt ?? right.createdAt ?? "") - Date.parse(left.updatedAt ?? left.createdAt ?? ""))
    .at(0);
}

async function seedTwoCloneRepository() {
  await mkdir(seedPath, { recursive: true });
  await mkdir(remotePath, { recursive: true });
  await runCommand("git", ["init", "--bare"], remotePath);
  await runCommand("git", ["init", "-b", "main"], seedPath);
  await configureGitIdentity(seedPath);
  await writeFile(
    join(seedPath, "GAME_DESIGN.md"),
    [
      "# Starship UI Dogfood",
      "",
      "Build a PixiJS-style browser game slice with a shell, stable resize behavior, keyboard controls, and explicit proof.",
      "The first collaborator handoff should unblock controls and create a resize regression follow-up when proof is incomplete.",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(seedPath, "KANBAN_ACCESSIBILITY.md"),
    [
      "# Kanban Accessibility Notes",
      "",
      "Add objective-driven cards for keyboard movement, swimlane filtering, and shortcut discoverability.",
      "Swimlane filtering must preserve focus and should not recreate existing keyboard movement cards.",
    ].join("\n"),
    "utf8",
  );
  await runCommand("git", ["add", "GAME_DESIGN.md", "KANBAN_ACCESSIBILITY.md"], seedPath);
  await runCommand("git", ["commit", "-m", "Seed starship UI dogfood"], seedPath);
  await runCommand("git", ["remote", "add", "origin", remotePath], seedPath);
  await runCommand("git", ["push", "-u", "origin", "main"], seedPath);
  await runCommand("git", ["clone", "-b", "main", remotePath, cloneAPath], runRoot);
  await runCommand("git", ["clone", "-b", "main", remotePath, cloneBPath], runRoot);
  await configureGitIdentity(cloneAPath);
  await configureGitIdentity(cloneBPath);
}

async function createInitialBoard(cdp) {
  let state = await invoke(cdp, "createProjectBoard", {
    workspacePath: cloneBPath,
    title: "Git UI Dogfood Board",
    summary: "Two-clone app-boundary dogfood for pulled handoffs and local active-card preservation.",
  });
  let board = boardFromState(state);
  state = await invoke(cdp, "updateProjectBoardStatus", { boardId: board.id, status: "active" });
  board = boardFromState(state);

  const foundationCard = await createReadyCandidate(cdp, board.id, {
    title: "Create PixiJS shell",
    description: "Create the browser game shell, one canvas, renderer lifecycle, resize behavior, and visible starfield proof.",
    priority: 1,
    phase: "Foundation",
    labels: ["foundation", "pixijs", "proof"],
    blockedBy: [],
    acceptanceCriteria: ["One canvas mounts.", "Resize behavior is stable.", "A visible starfield proof artifact exists."],
    testPlan: {
      unit: ["Cover renderer lifecycle helpers."],
      integration: ["Run the app startup smoke."],
      visual: ["Capture a nonblank canvas screenshot."],
      manual: ["Resize the window and confirm the scene remains stable."],
    },
  });
  const controlsCard = await createReadyCandidate(cdp, board.id, {
    title: "Implement ship controls",
    description: "Add keyboard input, movement bounds, and deterministic ship state after the shell handoff lands.",
    priority: 2,
    phase: "Core Gameplay",
    labels: ["controls", "player-ship"],
    blockedBy: [foundationCard.id],
    acceptanceCriteria: ["Keyboard input moves the ship.", "Movement state is testable.", "Controls remain inside the playable area."],
    testPlan: {
      unit: ["Cover ship movement math."],
      integration: ["Run an input smoke test."],
      visual: [],
      manual: ["Try keyboard controls in the browser."],
    },
  });
  state = await invoke(cdp, "createReadyProjectBoardTasks", { boardId: board.id });
  board = boardFromState(state);
  return {
    board,
    foundationCard: requireCard(board, foundationCard.id),
    controlsCard: requireCard(board, controlsCard.id),
  };
}

async function createReadyCandidate(cdp, boardId, cardInput) {
  const before = await currentBoard(cdp);
  const beforeIds = new Set(before.cards.map((card) => card.id));
  const createdState = await invoke(cdp, "createProjectBoardCard", {
    boardId,
    title: cardInput.title,
    description: cardInput.description,
  });
  let board = boardFromState(createdState);
  const created = board.cards.find((card) => !beforeIds.has(card.id));
  assert(created, `Expected manual candidate to be created for ${cardInput.title}.`);
  board = boardFromState(
    await invoke(cdp, "updateProjectBoardCard", {
      cardId: created.id,
      title: cardInput.title,
      description: cardInput.description,
      candidateStatus: "ready_to_create",
      priority: cardInput.priority,
      phase: cardInput.phase,
      labels: cardInput.labels,
      blockedBy: cardInput.blockedBy,
      acceptanceCriteria: cardInput.acceptanceCriteria,
      testPlan: cardInput.testPlan,
      clarificationQuestions: [],
    }),
  );
  return requireCard(board, created.id);
}

async function writeCollaboratorHandoff(initial) {
  await runCommand("git", ["pull", "--ff-only"], cloneAPath);
  const cards = await readCardArtifacts(cloneAPath);
  const foundation = cards.find((card) => card.cardId === initial.foundationCard.id);
  const controls = cards.find((card) => card.cardId === initial.controlsCard.id);
  assert(foundation, "Expected clone A to have foundation card artifact.");
  assert(controls, "Expected clone A to have controls card artifact.");
  const now = "2026-05-09T12:10:00.000Z";
  foundation.status = "review";
  foundation.updatedAt = now;
  controls.status = "ready";
  controls.title = "Implement ship controls after collaborator shell proof";
  controls.updatedAt = "2026-05-09T12:05:00.000Z";
  await writeCardArtifact(cloneAPath, foundation);
  await writeCardArtifact(cloneAPath, controls);
  await writeBoardEventArtifact(
    cloneAPath,
    staleClaimBoardEvent({
      boardId: initial.board.id,
      cardId: controls.cardId,
      runId: "run-stale-controls-claim",
      agentId: "collaborator-stale-desktop",
      createdAt: "2026-05-09T11:40:00.000Z",
      leaseUntil: "2026-05-09T11:45:00.000Z",
    }),
  );
  await writeBoardEventArtifact(
    cloneAPath,
    claimBoardEvent({
      boardId: initial.board.id,
      cardId: foundation.cardId,
      runId: "run-foundation-winning-claim",
      agentId: "collaborator-foundation-owner",
      displayName: "Foundation owner desktop",
      createdAt: "2026-05-09T12:02:00.000Z",
      leaseUntil: "2099-05-09T12:17:00.000Z",
      summary: "A collaborator has the earliest active claim for foundation proof follow-up.",
    }),
  );
  await writeBoardEventArtifact(
    cloneAPath,
    claimBoardEvent({
      boardId: initial.board.id,
      cardId: foundation.cardId,
      runId: "run-foundation-losing-claim",
      agentId: "collaborator-competing-desktop",
      displayName: "Competing desktop",
      createdAt: "2026-05-09T12:03:00.000Z",
      leaseUntil: "2099-05-09T12:18:00.000Z",
      summary: "A later collaborator claim should be recorded as a conflict and then expired by the app.",
    }),
  );
  await writeRunArtifacts({
    projectRoot: cloneAPath,
    boardId: initial.board.id,
    cardId: foundation.cardId,
    runId: "run-foundation-ui-dogfood",
    createdAt: now,
  });
  await writeObjectiveCardArtifact({
    projectRoot: cloneAPath,
    boardId: initial.board.id,
    blockedByCardId: controls.cardId,
    createdAt: "2026-05-09T12:12:00.000Z",
  });
  await runCommand("git", ["add", ".ambient/board"], cloneAPath);
  await runCommand("git", ["commit", "-m", "Collaborator completes shell handoff"], cloneAPath);
  await runCommand("git", ["push"], cloneAPath);
}

async function writeObjectiveCardArtifact({ projectRoot, boardId, blockedByCardId, createdAt }) {
  await writeCardArtifact(projectRoot, {
    schemaVersion: 1,
    cardId: "card-objective-swimlane-filter-shortcuts",
    boardId,
    title: "Add swimlane filter shortcuts",
    description:
      "Continue the objective-driven Add Cards workflow by adding keyboard shortcuts and focus handling for swimlane filtering without recreating inherited keyboard movement work.",
    status: "draft",
    candidateStatus: "ready_to_create",
    priority: 3,
    phase: "Accessibility",
    labels: ["kanban", "accessibility", "objective"],
    blockedBy: [blockedByCardId],
    unresolvedBlockers: [],
    acceptanceCriteria: ["Users can focus swimlane filters from the keyboard.", "Shortcut behavior is documented and testable."],
    testPlan: {
      unit: ["Cover filter shortcut state transitions."],
      integration: ["Run a keyboard navigation smoke over swimlane filtering."],
      visual: [],
      manual: ["Verify keyboard-only filtering in the app."],
    },
    sourceKind: "board_synthesis",
    sourceId: "objective:swimlane-filter-shortcuts",
    sourceRefs: [
      {
        path: "KANBAN_ACCESSIBILITY.md",
        note: "Objective Add Cards source-scan grounding path from collaborator clone.",
      },
    ],
    clarificationQuestions: [],
    clarificationAnswers: [],
    objectiveProvenance: {
      objective: "Add accessible swimlane filtering follow-up cards from the source scan.",
      groundingMode: "source_scan",
      selectedSourceIds: [],
      sourceRefCount: 1,
      weakGrounding: false,
    },
    createdAt,
    updatedAt: createdAt,
  });
}

async function markLocalControlsCardInProgress(cdp, controlsCardId) {
  let board = await currentBoard(cdp);
  const controls = requireCard(board, controlsCardId);
  assert(controls.orchestrationTaskId, "Expected controls card to be ticketized before marking local work active.");
  await invoke(cdp, "updateOrchestrationTask", { id: controls.orchestrationTaskId, state: "in_progress" });
  board = await waitForState(
    cdp,
    async () => {
      const next = await currentBoard(cdp);
      return next.cards.find((card) => card.id === controlsCardId)?.status === "in_progress" ? next : undefined;
    },
    "local controls card in-progress state",
    15_000,
  );
  return board;
}

async function readCardArtifacts(projectRoot) {
  const cardsRoot = join(projectRoot, ".ambient", "board", "cards");
  const entries = await readdir(cardsRoot);
  const cards = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    cards.push(JSON.parse(await readFile(join(cardsRoot, entry), "utf8")));
  }
  return cards;
}

async function writeCardArtifact(projectRoot, card) {
  await writeFile(join(projectRoot, ".ambient", "board", "cards", `${card.cardId}.json`), `${JSON.stringify(card, null, 2)}\n`, "utf8");
}

async function writeRunArtifacts({ projectRoot, boardId, cardId, runId, createdAt }) {
  const root = join(projectRoot, ".ambient", "board", "runs", runId);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        runId,
        boardId,
        cardId,
        status: "completed",
        agentId: "collaborator-desktop",
        piSessionId: "sessions/foundation-ui-dogfood.json",
        workspaceBranch: "board/foundation-ui-dogfood",
        startedAt: "2026-05-09T12:00:00.000Z",
        updatedAt: createdAt,
        completedAt: createdAt,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(root, "proof.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        runId,
        boardId,
        cardId,
        summary: "Created the PixiJS shell and captured proof sufficient for controls to proceed.",
        commands: ["pnpm test", "pnpm run test:visual"],
        changedFiles: ["src/main.ts", "src/game/shell.ts"],
        screenshots: ["test-results/shell-proof.png"],
        browserTraces: [],
        visualChecks: [{ name: "canvas", status: "passed", detail: "Nonblank canvas captured." }],
        manualChecks: ["Resized the window and confirmed the starfield remained stable."],
        createdAt,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(root, "handoff.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        runId,
        boardId,
        cardId,
        summary: "Shell is ready for controls, with one resize-proof follow-up.",
        completed: ["Mounted one canvas.", "Added renderer lifecycle.", "Captured nonblank shell proof."],
        remaining: ["Controls can proceed.", "Resize proof should get a regression test."],
        risks: ["Resize proof is partly manual."],
        followUps: [
          {
            title: "Add resize regression coverage",
            reason: "The collaborator verified resize manually, but the board should track automated resize regression coverage.",
            blockedBy: [],
          },
        ],
        createdAt,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const taskActions = [
    {
      actionId: "collab-heartbeat",
      action: "task_heartbeat",
      createdAt: "2026-05-09T12:01:00.000Z",
      summary: "Collaborator started shell proof before editing the game shell.",
      completed: [],
      remaining: ["Create shell proof artifacts", "Report proof", "Hand off controls"],
      nextStep: "Capture shell proof for downstream controls work.",
    },
    {
      actionId: "collab-proof",
      action: "task_report_proof",
      createdAt: "2026-05-09T12:08:00.000Z",
      summary: "Collaborator captured shell proof and resize evidence.",
      commands: ["pnpm test", "pnpm run test:visual"],
      changedFiles: ["src/main.ts", "src/game/shell.ts"],
      screenshots: ["test-results/shell-proof.png"],
      browserTraces: [],
      visualChecks: [{ name: "canvas", status: "passed", detail: "Nonblank canvas captured." }],
      manualChecks: ["Resized the window and confirmed the starfield remained stable."],
    },
    {
      actionId: "collab-handoff",
      action: "task_report_handoff",
      createdAt,
      summary: "Shell is ready for controls, with one resize-proof follow-up.",
      completed: ["Mounted one canvas.", "Added renderer lifecycle.", "Captured nonblank shell proof."],
      remaining: ["Controls can proceed.", "Resize proof should get a regression test."],
      risks: ["Resize proof is partly manual."],
      followUps: [
        {
          title: "Add resize regression coverage",
          reason: "The collaborator verified resize manually, but the board should track automated resize regression coverage.",
          blockedBy: [],
        },
      ],
    },
  ];
  for (const action of taskActions) {
    await writeBoardEventArtifact(projectRoot, taskActionBoardEvent({ boardId, cardId, runId, action }));
  }
}

function staleClaimBoardEvent({ boardId, cardId, runId, agentId, createdAt, leaseUntil }) {
  return claimBoardEvent({
    boardId,
    cardId,
    runId,
    agentId,
    displayName: "Stale collaborator desktop",
    createdAt,
    leaseUntil,
    summary: "A collaborator claimed this controls card and then stopped heartbeating before the lease expired.",
  });
}

function claimBoardEvent({ boardId, cardId, runId, agentId, displayName, createdAt, leaseUntil, summary }) {
  return {
    schemaVersion: 1,
    eventId: `evt-${runId}`,
    boardId,
    type: "card.claimed",
    entityKind: "card",
    entityId: cardId,
    actor: { kind: "ambient-desktop", agentId, displayName },
    createdAt,
    payload: {
      cardId,
      runId,
      agentId,
      leaseUntil,
      leaseMs: 5 * 60 * 1000,
      summary,
    },
  };
}

function taskActionBoardEvent({ boardId, cardId, runId, action }) {
  return {
    schemaVersion: 1,
    eventId: `evt-${runId}-${action.actionId}`,
    boardId,
    type: action.action === "task_report_handoff" ? "run.handoff_created" : action.action === "task_block" ? "run.blocked" : action.action === "task_complete" ? "run.completed" : "run.progress",
    entityKind: "run",
    entityId: runId,
    actor: { kind: "pi-worker", displayName: "Collaborator Pi worker", piSessionId: "sessions/foundation-ui-dogfood.json" },
    createdAt: action.createdAt,
    payload: {
      cardId,
      runId,
      actionId: action.actionId,
      action: action.action,
      title: taskActionTitle(action.action),
      summary: action.summary ?? action.reason ?? action.title ?? action.action,
      taskToolAction: action,
    },
  };
}

function taskActionTitle(action) {
  if (action === "task_heartbeat") return "Task heartbeat";
  if (action === "task_report_proof") return "Proof reported";
  if (action === "task_report_handoff") return "Task handoff";
  if (action === "task_complete") return "Task complete";
  if (action === "task_block") return "Task blocked";
  if (action === "task_create_followup") return "Follow-up created";
  return action;
}

async function writeBoardEventArtifact(projectRoot, event) {
  const path = join(projectRoot, boardEventArtifactPath(event));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(event, null, 2)}\n`, "utf8");
}

function boardEventArtifactPath(event) {
  const date = new Date(event.createdAt);
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const timestamp = event.createdAt.replace(/[^A-Za-z0-9]/g, "");
  return join(".ambient", "board", "events", year, month, day, `${timestamp}-${event.eventId}.json`);
}

async function currentBoard(cdp) {
  return boardFromState(await invoke(cdp, "bootstrap"));
}

function boardFromState(state) {
  const project = state.projects.find((candidate) => candidate.path === state.workspace.path);
  if (!project?.board) throw new Error(`Expected active project ${state.workspace.path} to have a project board.`);
  return project.board;
}

function requireCard(board, cardId) {
  const card = board.cards.find((candidate) => candidate.id === cardId);
  if (!card) throw new Error(`Expected board card ${cardId}.`);
  return card;
}

async function projectionReviewSnapshot(cdp) {
  return evaluate(
    cdp,
    `(() => {
      const review = document.querySelector(".project-board-projection-review");
      return {
        text: review?.textContent?.replace(/\\s+/g, " ").trim() ?? "",
        rows: [...document.querySelectorAll(".project-board-projection-review-item")].map((row) => ({
          className: row.className,
          text: row.textContent?.replace(/\\s+/g, " ").trim() ?? "",
        })),
      };
    })()`,
  );
}

async function launchApp(workspacePath) {
  const child = spawn("pnpm", ["exec", "electron-vite", "dev", "--", `--remote-debugging-port=${port}`], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AMBIENT_DESKTOP_WORKSPACE: workspacePath,
      AMBIENT_E2E: "1",
      AMBIENT_E2E_USER_DATA: userData,
      AMBIENT_E2E_SKIP_PROJECT_BOARD_SOURCE_REFRESH: "1",
      AMBIENT_API_KEY: ambientApiKey ?? process.env.AMBIENT_API_KEY ?? "",
      AMBIENT_AGENT_AMBIENT_API_KEY: ambientApiKey ?? process.env.AMBIENT_AGENT_AMBIENT_API_KEY ?? "",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));
  const target = await waitForTarget(port);
  const browserCdp = await connectCdpWithRetry(target.webSocketDebuggerUrl, "Electron browser CDP");
  const pageTarget = await waitForPageTarget(browserCdp);
  const attached = await browserCdp.send("Target.attachToTarget", {
    targetId: pageTarget.targetId,
    flatten: true,
  });
  return { child, cdp: browserCdp.session(attached.sessionId) };
}

async function invoke(cdp, method, input) {
  const args = input === undefined ? "()" : `(${JSON.stringify(input)})`;
  return evaluate(cdp, `window.ambientDesktop.${method}${args}`);
}

async function clickButton(cdp, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const clicked = await evaluate(
      cdp,
      `(() => {
        const needle = ${JSON.stringify(label)}.toLowerCase();
        const button = [...document.querySelectorAll("button")]
          .find((item) => (item.textContent || item.title || item.getAttribute("aria-label") || "").toLowerCase().includes(needle) && !item.disabled);
        if (!button) return false;
        button.click();
        return true;
      })()`,
    );
    if (clicked) return;
    await delay(200);
  }
  const buttons = await evaluate(
    cdp,
    `[...document.querySelectorAll("button")].map((button) => ({ text: button.textContent?.replace(/\\s+/g, " ").trim(), title: button.title, disabled: button.disabled })).slice(0, 50)`,
  ).catch(() => []);
  throw new Error(`Could not click enabled button "${label}". Buttons: ${JSON.stringify(buttons)}`);
}

async function clickProjectionReviewResolution(cdp, rowText, label) {
  const clicked = await evaluate(
    cdp,
    `(() => {
      const rowNeedle = ${JSON.stringify(rowText)};
      const labelNeedle = ${JSON.stringify(label)};
      const row = [...document.querySelectorAll(".project-board-projection-review-item")]
        .find((item) => item.textContent?.includes(rowNeedle));
      const button = row
        ? [...row.querySelectorAll(".project-board-projection-resolution-actions button")]
            .find((item) => item.textContent?.trim() === labelNeedle && !item.disabled)
        : undefined;
      if (!button) return false;
      button.click();
      return true;
    })()`,
  );
  if (!clicked) throw new Error(`Projection review resolution not found: ${rowText} / ${label}`);
}

async function captureScreenshot(cdp, name) {
  const result = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  if (!result.data || result.data.length < 10_000) throw new Error(`${name} screenshot was unexpectedly small.`);
  await writeFile(join(resultsDir, name), Buffer.from(result.data, "base64"));
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Runtime.evaluate failed.");
  }
  return result.result?.value;
}

async function waitFor(cdp, predicate, label, timeoutMs = 20_000) {
  const expression = `(${predicate.toString()})()`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression)) return;
    await delay(150);
  }
  const bodyTail = await evaluate(cdp, "document.body.innerText.slice(-3000)").catch(() => "");
  throw new Error(`Timed out waiting for ${label}.\n\nBody tail:\n${bodyTail}`);
}

async function waitForBodyText(cdp, text, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  const expression = `document.body.innerText.includes(${JSON.stringify(text)})`;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression)) return;
    await delay(150);
  }
  const bodyTail = await evaluate(cdp, "document.body.innerText.slice(-3000)").catch(() => "");
  throw new Error(`Timed out waiting for ${label} text ${JSON.stringify(text)}.\n\nBody tail:\n${bodyTail}`);
}

async function waitForState(_cdp, read, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function setViewport(cdp, width, height) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function waitForTarget(cdpPort) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetchWithTimeout(`http://127.0.0.1:${cdpPort}/json/version`, 2_000);
      const target = await response.json();
      if (target?.webSocketDebuggerUrl) return target;
    } catch {
      // App not listening yet.
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for Electron browser CDP endpoint.");
}

async function waitForPageTarget(cdp) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const targets = await cdp.send("Target.getTargets").catch(() => ({ targetInfos: [] }));
    const pageTarget =
      targets.targetInfos?.find((item) => item.type === "page" && !item.url.startsWith("devtools://")) ??
      targets.targetInfos?.find((item) => item.type === "page");
    if (pageTarget?.targetId) return pageTarget;
    await delay(250);
  }
  throw new Error("Timed out waiting for Electron page CDP target.");
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function connectCdpWithRetry(url, label) {
  const deadline = Date.now() + 120_000;
  let lastError;
  while (Date.now() < deadline) {
    let cdp;
    try {
      cdp = await connectCdp(url);
      await cdp.send("Target.getTargets");
      return cdp;
    } catch (error) {
      lastError = error;
      cdp?.close();
      await delay(500);
    }
  }
  throw new Error(`Timed out connecting to ${label}${lastError ? `: ${lastError.message}` : ""}.`);
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let nextId = 1;
    const pending = new Map();
    let opened = false;
    const rejectPending = (error) => {
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    };
    const send = (method, params = {}, sessionId) => {
      if (socket.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error(`CDP websocket is not open for ${method}.`));
      }
      const id = nextId++;
      const message = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      socket.send(JSON.stringify(message));
      return new Promise((innerResolve, innerReject) => {
        pending.set(id, { resolve: innerResolve, reject: innerReject });
        setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          innerReject(new Error(`Timed out waiting for CDP ${method}.`));
        }, cdpCommandTimeoutMs);
      });
    };
    socket.addEventListener("open", () => {
      opened = true;
      resolve({
        send,
        session(sessionId) {
          return {
            send(method, params = {}) {
              return send(method, params, sessionId);
            },
            close() {
              socket.close();
            },
          };
        },
        close() {
          socket.close();
        },
      });
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message ?? "CDP error"));
      else entry.resolve(message.result);
    });
    socket.addEventListener("error", () => {
      const error = new Error("CDP websocket failed.");
      if (!opened) reject(error);
      rejectPending(error);
    });
    socket.addEventListener("close", () => {
      const error = new Error("CDP websocket closed.");
      if (!opened) reject(error);
      rejectPending(error);
    });
  });
}

async function configureGitIdentity(root) {
  await runCommand("git", ["config", "user.email", "ambient@example.test"], root);
  await runCommand("git", ["config", "user.name", "Ambient Test"], root);
}

async function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
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
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed with ${exitCode}: ${stderr || stdout}`));
    });
  });
}

async function findOpenPort(preferredPort) {
  if (preferredPort) {
    try {
      await probePort(preferredPort);
      return preferredPort;
    } catch {
      // Fall through to an ephemeral port.
    }
  }
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const portNumber = typeof address === "object" && address ? address.port : undefined;
      server.close(() => {
        if (!portNumber) reject(new Error("Could not allocate a CDP port."));
        else resolve(portNumber);
      });
    });
    server.on("error", reject);
  });
}

function probePort(portNumber) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(portNumber, "127.0.0.1", () => server.close(resolve));
    server.on("error", reject);
  });
}

async function readAmbientApiKey() {
  if (process.env.AMBIENT_API_KEY) return process.env.AMBIENT_API_KEY;
  if (process.env.AMBIENT_AGENT_AMBIENT_API_KEY) return process.env.AMBIENT_AGENT_AMBIENT_API_KEY;
  const candidates = [
    process.env.AMBIENT_API_KEY_FILE,
    join(process.cwd(), "ignored-provider-key-file.txt"),
    join(process.cwd(), "..", "ignored-provider-key-file.txt"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const value = (await readFile(candidate, "utf8")).trim();
      if (value) return value;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

async function terminateProcessTree(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise((resolve) => proc.once("exit", resolve));
  try {
    if (process.platform === "win32") proc.kill("SIGTERM");
    else process.kill(-proc.pid, "SIGTERM");
  } catch {
    proc.kill("SIGTERM");
  }
  await Promise.race([exited, delay(5_000)]);
  if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
