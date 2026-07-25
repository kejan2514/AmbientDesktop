#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const outputRoot = resolve(
  process.env.AMBIENT_KANBAN_HEALTH_REPORT_ARTIFACT_PROMOTION_OUT_DIR ||
    join(tmpdir(), "ambient-kanban-health-report-artifact-promotion-gmi"),
);
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = join(outputRoot, "runs", runStamp);
const workspace = join(runRoot, "workspace");
const userData = join(runRoot, "userData");
const reportPath = resolve(process.env.AMBIENT_KANBAN_HEALTH_REPORT_ARTIFACT_PROMOTION_OUT || join(outputRoot, "latest.json"));
const sourceReviewBeforeScreenshotPath = join(runRoot, "phase6-health-report-before-promotion.png");
const sourceReviewAfterScreenshotPath = join(runRoot, "phase6-health-report-after-promotion.png");
const sourcePickerScreenshotPath = join(runRoot, "phase6-health-report-source-picker.png");
const proposalScreenshotPath = join(runRoot, "phase6-health-report-add-cards-proposal.png");
const cdpPort = Number(process.env.AMBIENT_KANBAN_HEALTH_REPORT_ARTIFACT_PROMOTION_CDP_PORT || 0) || (await availablePort());
const addCardsMaxElapsedMs = Number(process.env.AMBIENT_KANBAN_HEALTH_REPORT_ARTIFACT_PROMOTION_MAX_TIMEOUT_MS || 0) || 900_000;
const addCardsIdleMs = Number(process.env.AMBIENT_KANBAN_HEALTH_REPORT_ARTIFACT_PROMOTION_IDLE_TIMEOUT_MS || 0) || 240_000;
const defaultRepoKeyFile = join(repoRoot, "ignored-provider-key-file.txt");
const defaultHomeCheckoutKeyFile = join(homedir(), "ambientCoder", "ignored-provider-key-file.txt");
const keyFile = resolve(
  process.env.GMI_CLOUD_API_KEY_FILE ||
    (existsSync(defaultRepoKeyFile) ? defaultRepoKeyFile : defaultHomeCheckoutKeyFile),
);
const defaultSnapshotWorkspace = join(homedir(), "Documents", "ambientCoderArchive");
const sourceWorkspace =
  process.env.AMBIENT_KANBAN_HEALTH_REPORT_ARTIFACT_PROMOTION_SNAPSHOT_WORKSPACE ||
  process.env.AMBIENT_DESKTOP_WORKSPACE ||
  (existsSync(defaultSnapshotWorkspace) ? defaultSnapshotWorkspace : "");
const sourceUserData =
  process.env.AMBIENT_KANBAN_HEALTH_REPORT_ARTIFACT_PROMOTION_SNAPSHOT_USER_DATA || process.env.AMBIENT_E2E_USER_DATA || "";
const generatedReportReason = "Generated report artifacts are excluded from board synthesis until explicitly promoted by the user";
const healthReportPath = "reports/workspace-health-report.md";

const output = [];
let app;
let cdp;

try {
  if (!sourceWorkspace || !existsSync(sourceWorkspace)) {
    throw new Error("Set AMBIENT_KANBAN_HEALTH_REPORT_ARTIFACT_PROMOTION_SNAPSHOT_WORKSPACE to a local snapshot workspace directory.");
  }
  if (!existsSync(keyFile) && !process.env.GMI_CLOUD_API_KEY && !process.env.GMI_API_KEY) {
    throw new Error("Set GMI_CLOUD_API_KEY_FILE, GMI_CLOUD_API_KEY, or GMI_API_KEY before running the GMI artifact-promotion gate.");
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

  await openOrBuildProjectBoard();
  await waitForBoardWithProjectSource();
  await answerKickoffQuestions([
    "Use PROJECT.md as the durable workspace-health charter.",
    "Generated reports are not authoritative until I explicitly promote them in Source Review.",
    "Ask only when remediation priority or proof scope is ambiguous.",
    "Require deterministic proof for every generated remediation card.",
    "Plan small, source-grounded follow-up cards from explicitly promoted artifacts only.",
  ]);
  await clickButton("Activate Board");
  let board = await waitForState(async () => {
    const current = boardFromState(await invoke("bootstrap"));
    return current.status === "active" && current.charter ? current : undefined;
  }, "active charter", 90_000);
  await waitForNoRunningSynthesisRuns("activation");

  await writeGeneratedHealthReport();
  await clickProjectBoardTab("Charter");
  await waitFor(() => Boolean(document.querySelector(".project-board-source-review")), "source review panel");
  await clickButton("Refresh Sources");
  board = await waitForState(async () => {
    const current = boardFromState(await invoke("bootstrap"));
    return findSourceByPath(current, healthReportPath) ? current : undefined;
  }, "generated health report source after refresh", 180_000);
  await waitForNoRunningSynthesisRuns("report source refresh");
  const beforePromotion = assertReportDemoted(board);
  await assertVisibleReportState("Ignored for synthesis");
  await captureScreenshot(sourceReviewBeforeScreenshotPath);

  await includeHealthReportThroughVisibleSourceReview();
  board = await waitForState(async () => {
    const current = boardFromState(await invoke("bootstrap"));
    const source = findSourceByPath(current, healthReportPath);
    return source?.includeInSynthesis === true && source.authorityRole !== "ignored" && source.classifiedBy === "user" ? current : undefined;
  }, "explicit report promotion", 60_000);
  const afterPromotion = assertReportPromoted(board);
  await assertVisibleReportState("Included in synthesis");
  await captureScreenshot(sourceReviewAfterScreenshotPath);

  await clickProjectBoardTab("Draft");
  await clickButton("Add Cards From Sources");
  await waitFor(() => (document.body?.innerText || "").includes("Choose source scope"), "Add Cards source picker");
  await clickButton("Clear");
  await clickSourceFilter("Report");
  await clickButton("Select Visible");
  await fillSourcePickerObjective(
    "Create remediation cards only from the explicitly promoted workspace health report. Each card must cite reports/workspace-health-report.md and the source promotion decision.",
  );
  await captureScreenshot(sourcePickerScreenshotPath);

  board = boardFromState(await invoke("bootstrap"));
  const runIdsBeforeAddCards = new Set(board.synthesisRuns.map((run) => run.id));
  await clickButton("Elaborate");
  const addCardsRun = await waitForAddCardsRunTerminal(runIdsBeforeAddCards);
  if (addCardsRun.status !== "succeeded") {
    throw new Error(`Add Cards from promoted report did not succeed. Status=${addCardsRun.status}; error=${addCardsRun.error ?? "none"}.`);
  }

  const finalBoard = boardFromState(await invoke("bootstrap"));
  const proposalEvidence = assertPromotedReportProposal(finalBoard, afterPromotion.id);
  await clickProjectBoardTab("Decisions");
  await waitFor(
    () => {
      const text = document.querySelector(".project-board-tab-panel")?.textContent || document.body?.innerText || "";
      return text.includes("Proposal ready") && text.includes("Accept") && text.includes("Add Cards provenance");
    },
    "visible Add Cards proposal",
    90_000,
  );
  await captureScreenshot(proposalScreenshotPath);

  const report = {
    status: "passed",
    providerId: provider.providerId,
    usedGmiKeyFile: existsSync(keyFile),
    sourceWorkspace,
    usedSnapshotUserData: Boolean(sourceUserData && existsSync(sourceUserData)),
    runRoot,
    workspace,
    boardId: finalBoard.id,
    sources: {
      beforePromotion,
      afterPromotion,
    },
    addCardsRun: {
      id: addCardsRun.id,
      status: addCardsRun.status,
      stage: addCardsRun.stage,
      cardCount: addCardsRun.cardCount,
      questionCount: addCardsRun.questionCount,
      selectedSourceIds: addCardsRun.events.find((event) => event.title === "Selected source scope")?.metadata?.selectedSourceIds,
    },
    proposal: proposalEvidence,
    screenshots: {
      sourceReviewBeforePromotion: sourceReviewBeforeScreenshotPath,
      sourceReviewAfterPromotion: sourceReviewAfterScreenshotPath,
      sourcePicker: sourcePickerScreenshotPath,
      proposal: proposalScreenshotPath,
    },
    assertions: [
      "Desktop launched with the temporary GMI Cloud provider override without exposing the API key",
      "The harness used a temp copy of the snapshot workspace before writing project and generated report fixtures",
      "A generated workspace health report artifact was refreshed through visible Source Review and stayed ignored before promotion",
      "The report was promoted through the visible Include control, recording a user source update",
      "Add Cards From Sources was opened through the visible Draft Inbox button",
      "The Report filter and Select Visible controls scoped Add Cards to the promoted report source",
      "The GMI Add Cards run completed and produced proposal cards grounded in the selected promoted report source",
      "Proposal card provenance cites the selected source id and at least one source ref resolves to the promoted report artifact",
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
    domSnapshot: await safeDomSnapshot(),
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
  await writeProjectCharterSource();
}

async function sanitizeTempWorkspace() {
  for (const entry of await readdir(workspace, { withFileTypes: true }).catch(() => [])) {
    await rm(join(workspace, entry.name), { recursive: entry.isDirectory(), force: true });
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
    if (entry.isDirectory() && !["node_modules", ".git"].includes(entry.name)) await removeCredentialNamedFiles(path, maxDepth - 1);
  }
}

function isCredentialLikeFilename(name) {
  const lower = name.toLowerCase();
  return lower === ".env" || lower.startsWith(".env.") || (lower.includes("api") && lower.includes("key"));
}

async function writeProjectCharterSource() {
  await writeFile(
    join(workspace, "PROJECT.md"),
    [
      "# Workspace Health Follow-Up",
      "",
      "Functional specification for a board that turns explicitly promoted health reports into remediation work.",
      "",
      "Requirements:",
      "- Treat PROJECT.md as the initial charter authority.",
      "- Treat generated health reports as review inventory until the user promotes one.",
      "- After promotion, generate small remediation cards with source-grounded proof expectations.",
    ].join("\n"),
    "utf8",
  );
}

async function writeGeneratedHealthReport() {
  await mkdir(join(workspace, "reports"), { recursive: true });
  await writeFile(
    join(workspace, healthReportPath),
    [
      "# Workspace Health Report",
      "",
      "Generated by Ambient.",
      "",
      "Generated report artifact for source health and project-board remediation.",
      "",
      "Findings:",
      "- Accessibility: add keyboard navigation smoke coverage for Project Board source controls.",
      "- Reliability: add a deterministic source-promotion regression for generated artifacts.",
      "- Evidence: require Add Cards proposals to cite the promoted report artifact and promotion decision.",
      "",
      "Recommended cards:",
      "- Add a source review keyboard smoke proof.",
      "- Add a generated report promotion regression.",
      "- Add Add Cards provenance inspection coverage.",
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
      AMBIENT_CODEX_CURATED_MARKETPLACE_URL: "0",
      AMBIENT_PROJECT_BOARD_SYNTHESIS_MAX_TOOL_ROUNDS: process.env.AMBIENT_PROJECT_BOARD_SYNTHESIS_MAX_TOOL_ROUNDS ?? "4",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));
  const target = await waitForPageEndpoint(child);
  return { child, webSocketDebuggerUrl: target.webSocketDebuggerUrl };
}

async function openOrBuildProjectBoard() {
  const action = await evaluate(() => {
    if (document.querySelector(".project-board-workspace")) return "already-open";
    const button = [...document.querySelectorAll("button")].find((item) => {
      const text = `${item.textContent || ""} ${item.getAttribute("aria-label") || ""} ${item.getAttribute("title") || ""}`;
      return /Build Board|Open Board|Project Kanban/i.test(text) && !item.disabled;
    });
    if (!(button instanceof HTMLElement)) return "";
    const text = `${button.textContent || ""} ${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""}`;
    button.click();
    return /Build Board/i.test(text) ? "build-clicked" : "opened";
  });
  if (!action) throw new Error("Unable to open or build Project Board through visible UI.");
  await waitFor(() => Boolean(document.querySelector(".project-board-workspace")), "Project Board workspace");
  if (action === "build-clicked") return;
  const state = await invoke("bootstrap");
  const activeProject = state.projects.find((candidate) => candidate.path === state.workspace.path) ?? state.projects[0];
  if (activeProject?.board) return;
  const alreadyBuilding = await evaluate(() => {
    const text = document.querySelector(".project-board-workspace")?.textContent || document.body?.innerText || "";
    return /Creating project board|scanning sources|\bBuilding\b/i.test(text);
  });
  if (alreadyBuilding) return;
  await clickButton("Build Board");
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
  if (!clicked) {
    const buttons = await visibleButtonLabels().catch(() => []);
    throw new Error(`Enabled button not found: ${label}. Visible buttons: ${buttons.slice(0, 50).join(" | ")}`);
  }
}

async function clickSourceFilter(label) {
  const clicked = await evaluate((filterLabel) => {
    const button = [...document.querySelectorAll(".project-board-source-counts button")].find((item) =>
      (item.textContent || "").replace(/\s+/g, " ").trim().startsWith(filterLabel),
    );
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  }, label);
  if (!clicked) throw new Error(`Source filter not found: ${label}`);
}

async function includeHealthReportThroughVisibleSourceReview() {
  const clicked = await evaluate((path) => {
    const item = [...document.querySelectorAll(".project-board-source-item")].find((candidate) => (candidate.textContent || "").includes(path));
    if (!(item instanceof HTMLElement)) return false;
    const button = [...item.querySelectorAll("button")].find((candidate) => (candidate.textContent || "").includes("Include") && !candidate.disabled);
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  }, healthReportPath);
  if (!clicked) throw new Error("Visible Include control for generated health report was not found.");
}

async function fillSourcePickerObjective(objective) {
  await evaluate(() => {
    const textarea = document.querySelector(".project-board-add-cards-objective textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("Add Cards objective textarea not found.");
    textarea.focus();
    textarea.value = "";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await cdp.send("Input.insertText", { text: objective });
}

async function answerKickoffQuestions(answers) {
  await clickProjectBoardTab("Charter");
  for (const [index, answer] of answers.entries()) {
    await waitFor(() => Boolean(document.querySelector(".project-board-question textarea")), `kickoff question ${index + 1}`, 60_000);
    await evaluate(() => {
      const textarea = document.querySelector(".project-board-question textarea");
      if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("Kickoff textarea not found.");
      textarea.focus();
      textarea.value = "";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await cdp.send("Input.insertText", { text: answer });
    await clickButton(index >= answers.length - 1 ? "Finish Questions" : "Next");
    await waitFor(
      (expectedAnswered) => {
        const text = document.querySelector(".project-board-kickoff")?.textContent || "";
        return text.includes(`${expectedAnswered} answered`) || text.includes("Ready to activate");
      },
      `kickoff answer ${index + 1} saved`,
      60_000,
      index + 1,
    );
  }
  await waitFor(() => (document.querySelector(".project-board-kickoff")?.textContent || "").includes("Ready to activate"), "ready to activate");
}

async function waitForBoardWithProjectSource() {
  return waitForState(async () => {
    const board = boardFromState(await invoke("bootstrap"));
    return findSourceByPath(board, "PROJECT.md") ? board : undefined;
  }, "board with PROJECT.md source", 240_000);
}

async function waitForAddCardsRunTerminal(previousRunIds) {
  const startedAt = Date.now();
  let lastActivityAt = Date.now();
  let lastSignature = "";
  while (Date.now() - startedAt < addCardsMaxElapsedMs) {
    const board = boardFromState(await invoke("bootstrap"));
    const run = board.synthesisRuns.find((candidate) => {
      if (previousRunIds.has(candidate.id)) return false;
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
  throw new Error(`Timed out waiting for Add Cards after ${addCardsMaxElapsedMs.toLocaleString()}ms.`);
}

async function waitForNoRunningSynthesisRuns(label, timeoutMs = 180_000) {
  return waitForState(async () => {
    const current = boardFromState(await invoke("bootstrap"));
    return current.synthesisRuns.every((run) => !["queued", "running"].includes(run.status)) ? current : undefined;
  }, `no running synthesis runs after ${label}`, timeoutMs);
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

function assertReportDemoted(board) {
  const source = findSourceByPath(board, healthReportPath);
  if (!source) throw new Error("Expected generated health report source.");
  if (source.kind !== "report_artifact" || source.includeInSynthesis !== false || source.authorityRole !== "ignored") {
    throw new Error(`Generated report was not demoted before promotion: ${JSON.stringify(source)}`);
  }
  if (!String(source.classificationReason || "").includes(generatedReportReason)) {
    throw new Error(`Generated report did not record generated-report authority reason: ${source.classificationReason ?? "none"}`);
  }
  if (source.classifiedBy === "ambient_pi") {
    throw new Error("Generated report was classified by Pi before explicit promotion.");
  }
  return sourceReport(source);
}

function assertReportPromoted(board) {
  const source = findSourceByPath(board, healthReportPath);
  if (!source) throw new Error("Expected promoted health report source.");
  if (source.kind !== "report_artifact" || source.includeInSynthesis !== true || source.authorityRole === "ignored" || source.classifiedBy !== "user") {
    throw new Error(`Generated report was not explicitly promoted: ${JSON.stringify(source)}`);
  }
  if (!String(source.classificationReason || "").includes("User included report_artifact source")) {
    throw new Error(`Promoted report did not record a user promotion reason: ${source.classificationReason ?? "none"}`);
  }
  const promotionEvent = (board.events ?? []).find(
    (event) => event.kind === "source_updated" && event.entityId === source.id && event.metadata?.includeInSynthesis === true,
  );
  if (!promotionEvent) throw new Error("Promoted report did not record a source_updated promotion event.");
  return { ...sourceReport(source), promotionEventId: promotionEvent.id, promotionEventTitle: promotionEvent.title };
}

function assertPromotedReportProposal(board, reportSourceId) {
  const proposal = [...(board.proposals ?? [])]
    .reverse()
    .find((candidate) => candidate.cards.some((card) => card.objectiveProvenance?.selectedSourceIds?.includes(reportSourceId)));
  if (!proposal) throw new Error("No Add Cards proposal cited the promoted report source id.");
  if (proposal.cards.length === 0) throw new Error("Add Cards proposal contained no cards.");
  const cards = proposal.cards.map((card) => ({
    sourceId: card.sourceId,
    title: card.title,
    sourceRefs: card.sourceRefs ?? [],
    objectiveProvenance: card.objectiveProvenance,
  }));
  const citedReportArtifact = cards.some((card) =>
    card.sourceRefs.some((ref) => sourceRefMatchesReport(ref, reportSourceId)) ||
    card.objectiveProvenance?.selectedSourceIds?.includes(reportSourceId),
  );
  if (!citedReportArtifact) {
    throw new Error(`Proposal cards did not cite the promoted report artifact: ${JSON.stringify(cards)}`);
  }
  const weakGroundingCount = cards.filter((card) => card.objectiveProvenance?.weakGrounding).length;
  if (weakGroundingCount > 0) throw new Error(`Proposal contained ${weakGroundingCount} weak-grounded card(s) for the promoted report.`);
  return {
    id: proposal.id,
    status: proposal.status,
    cardCount: proposal.cards.length,
    reportSourceId,
    cards,
  };
}

function sourceRefMatchesReport(ref, reportSourceId) {
  const normalized = String(ref).toLowerCase();
  return normalized.includes(reportSourceId.toLowerCase()) || normalized.includes(healthReportPath) || normalized.includes("workspace health report");
}

async function assertVisibleReportState(label) {
  await waitFor(
    (expectedLabel) => {
      const text = document.querySelector(".project-board-source-review")?.textContent || "";
      return text.includes("Workspace Health Report") && text.includes("reports/workspace-health-report.md") && text.includes(expectedLabel);
    },
    `visible report state ${label}`,
    60_000,
    label,
  );
}

function sourceReport(source) {
  return {
    id: source.id,
    path: source.path,
    kind: source.kind,
    sourceKey: source.sourceKey,
    contentHash: source.contentHash,
    changeState: source.changeState,
    classifiedBy: source.classifiedBy,
    authorityRole: source.authorityRole,
    includeInSynthesis: source.includeInSynthesis,
    relevance: source.relevance,
    classificationReason: source.classificationReason,
  };
}

function findSourceByPath(board, path) {
  return board.sources.find((source) => source.path === path || source.path?.endsWith(path));
}

function boardFromState(state) {
  const project = state.projects.find((candidate) => candidate.path === state.workspace.path) ?? state.projects[0];
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

async function visibleButtonLabels() {
  return evaluate(() =>
    [...document.querySelectorAll("button")]
      .map((item) => ({
        text: (item.textContent || "").replace(/\s+/g, " ").trim(),
        title: item.getAttribute("title") || "",
        aria: item.getAttribute("aria-label") || "",
        disabled: item.disabled,
      }))
      .filter((item) => item.text || item.title || item.aria)
      .map((item) => `${item.disabled ? "[disabled] " : ""}${item.text || item.aria || item.title}`),
  );
}

async function safeDomSnapshot() {
  if (!cdp) return undefined;
  try {
    return await evaluate(() => ({
      bodyText: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 3000),
      buttons: [...document.querySelectorAll("button")]
        .map((item) => ({
          text: (item.textContent || "").replace(/\s+/g, " ").trim(),
          title: item.getAttribute("title") || "",
          aria: item.getAttribute("aria-label") || "",
          disabled: item.disabled,
        }))
        .slice(0, 100),
    }));
  } catch {
    return undefined;
  }
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
  if (/report|promotion|source authority|source classification|Add Cards|proposal|source ref|ground/i.test(message)) return "product";
  if (/source review|kickoff|button|cdp|electron|Ambient shell|spawn|exited|websocket|Expected active project to have a project board/i.test(message)) {
    return "environment-or-harness";
  }
  if (/provider|api key|stream|rate|timeout|timed out|stalled/i.test(message)) return "provider-degraded-or-timeout";
  return "unknown";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
