#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const outputRoot = resolve(
  process.env.AMBIENT_KANBAN_UNIT_CONVERTER_SOURCE_AUTHORITY_OUT_DIR ||
    join(tmpdir(), "ambient-kanban-unit-converter-source-authority-gmi"),
);
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = join(outputRoot, "runs", runStamp);
const workspace = join(runRoot, "workspace");
const userData = join(runRoot, "userData");
const reportPath = resolve(process.env.AMBIENT_KANBAN_UNIT_CONVERTER_SOURCE_AUTHORITY_OUT || join(outputRoot, "latest.json"));
const sourceReviewScreenshotPath = join(runRoot, "phase6-source-authority-review.png");
const charterReviewScreenshotPath = join(runRoot, "phase6-source-authority-charter-review.png");
const finalCharterScreenshotPath = join(runRoot, "phase6-source-authority-final-charter.png");
const cdpPort = Number(process.env.AMBIENT_KANBAN_UNIT_CONVERTER_SOURCE_AUTHORITY_CDP_PORT || 0) || (await availablePort());
const reviewMaxElapsedMs = Number(process.env.AMBIENT_KANBAN_UNIT_CONVERTER_SOURCE_AUTHORITY_MAX_TIMEOUT_MS || 0) || 900_000;
const reviewIdleMs = Number(process.env.AMBIENT_KANBAN_UNIT_CONVERTER_SOURCE_AUTHORITY_IDLE_TIMEOUT_MS || 0) || 240_000;
const defaultRepoKeyFile = join(repoRoot, "ignored-provider-key-file.txt");
const defaultHomeCheckoutKeyFile = join(homedir(), "ambientCoder", "ignored-provider-key-file.txt");
const keyFile = resolve(
  process.env.GMI_CLOUD_API_KEY_FILE ||
    (existsSync(defaultRepoKeyFile) ? defaultRepoKeyFile : defaultHomeCheckoutKeyFile),
);
const defaultSnapshotWorkspace = join(homedir(), "Documents", "ambientCoderArchive");
const sourceWorkspace =
  process.env.AMBIENT_KANBAN_UNIT_CONVERTER_SOURCE_AUTHORITY_SNAPSHOT_WORKSPACE ||
  process.env.AMBIENT_DESKTOP_WORKSPACE ||
  (existsSync(defaultSnapshotWorkspace) ? defaultSnapshotWorkspace : "");
const sourceUserData =
  process.env.AMBIENT_KANBAN_UNIT_CONVERTER_SOURCE_AUTHORITY_SNAPSHOT_USER_DATA || process.env.AMBIENT_E2E_USER_DATA || "";
const generatedWorkflowReason = "Generated workflow scaffolding is excluded from board synthesis until explicitly promoted by the user";

const output = [];
let app;
let cdp;

try {
  if (!sourceWorkspace || !existsSync(sourceWorkspace)) {
    throw new Error("Set AMBIENT_KANBAN_UNIT_CONVERTER_SOURCE_AUTHORITY_SNAPSHOT_WORKSPACE to a local snapshot workspace directory.");
  }
  if (!existsSync(keyFile) && !process.env.GMI_CLOUD_API_KEY && !process.env.GMI_API_KEY) {
    throw new Error("Set GMI_CLOUD_API_KEY_FILE, GMI_CLOUD_API_KEY, or GMI_API_KEY before running the GMI source-authority gate.");
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
  let board = await waitForBoardWithSources();
  await clickProjectBoardTab("Charter");
  await waitFor(() => Boolean(document.querySelector(".project-board-source-review")), "source review panel");

  const refreshCountBefore = sourceRefreshEventCount(board);
  await clickButton("Refresh Sources");
  board = await waitForState(async () => {
    const current = boardFromState(await invoke("bootstrap"));
    const refreshed = sourceRefreshEventCount(current) > refreshCountBefore || sourceAuthoritySnapshot(current);
    return refreshed && sourceAuthoritySnapshot(current) ? current : undefined;
  }, "visible source refresh with authority snapshot", 180_000);
  const sourceAuthority = assertSourceAuthority(board);
  await assertVisibleSourceAuthority();
  await captureScreenshot(sourceReviewScreenshotPath);
  board = await waitForNoRunningSynthesisRuns("source refresh");

  await answerKickoffQuestions([
    "Build the browser unit converter described by PROJECT.md.",
    "PROJECT.md is the authoritative product source. Generated WORKFLOW.md scaffolding stays excluded unless I explicitly promote it.",
    "Ask only when PROJECT.md leaves conversion behavior ambiguous.",
    "Require deterministic conversion tests plus a browser smoke proof for visible behavior.",
    "Plan source-grounded cards in dependency order: data model, conversion engine, UI, and tests.",
  ]);
  board = await waitForNoRunningSynthesisRuns("saved kickoff answers before charter review");
  const runIdsBeforeReview = new Set(board.synthesisRuns.map((run) => run.id));
  await clickButton("Review Answers With Pi");
  const reviewRun = await waitForCharterReviewRunTerminal(runIdsBeforeReview);
  if (reviewRun.status !== "succeeded") {
    throw new Error(`Charter review did not succeed. Status=${reviewRun.status}; error=${reviewRun.error ?? "none"}.`);
  }
  await clickProjectBoardTab("Decisions");
  await waitFor(
    () => {
      const text = document.querySelector(".project-board-tab-panel")?.textContent || "";
      return /PM review|Charter|readiness|proposal/i.test(text);
    },
    "visible charter review result",
    90_000,
  );
  await captureScreenshot(charterReviewScreenshotPath);

  await clickProjectBoardTab("Charter");
  await clickButton("Activate Board");
  const finalBoard = await waitForState(async () => {
    const current = boardFromState(await invoke("bootstrap"));
    return current.status === "active" && current.charter ? current : undefined;
  }, "active charter after visible activation", 60_000);
  const charterAuthority = assertCharterAuthority(finalBoard);
  await clickProjectBoardTab("Charter");
  await waitFor(
    () => {
      const text = document.querySelector(".project-board-tab-panel")?.textContent || "";
      return text.includes("PROJECT.md") && text.includes("Active project charter");
    },
    "visible active charter authority",
    60_000,
  );
  await captureScreenshot(finalCharterScreenshotPath);

  const report = {
    status: "passed",
    providerId: provider.providerId,
    usedGmiKeyFile: existsSync(keyFile),
    sourceWorkspace,
    usedSnapshotUserData: Boolean(sourceUserData && existsSync(sourceUserData)),
    runRoot,
    workspace,
    boardId: finalBoard.id,
    sources: sourceAuthority,
    charter: charterAuthority,
    reviewRun: {
      id: reviewRun.id,
      status: reviewRun.status,
      stage: reviewRun.stage,
      cardCount: reviewRun.cardCount,
      questionCount: reviewRun.questionCount,
      warningCount: reviewRun.warningCount,
      sourceScanIncludedCount: reviewRun.events.find((event) => event.stage === "source_scan")?.metadata?.includedSourceCount,
      sourceClassificationCandidateCount: reviewRun.events.find((event) => event.stage === "source_classification")?.metadata?.sourceCount,
    },
    screenshots: {
      sourceReview: sourceReviewScreenshotPath,
      charterReview: charterReviewScreenshotPath,
      finalCharter: finalCharterScreenshotPath,
    },
    assertions: [
      "Desktop launched with the temporary GMI Cloud provider override without exposing the API key",
      "The harness used a temp copy of the snapshot workspace before writing PROJECT.md and generated WORKFLOW.md fixtures",
      "Build Board, Refresh Sources, kickoff answers, Review Answers With Pi, and Activate Board were driven through visible Project Board controls",
      "PROJECT.md remained included with primary authority",
      "Generated WORKFLOW.md remained visible but excluded with ignored authority and the deterministic generated-workflow reason",
      "Pi source classification did not promote the locked generated WORKFLOW.md source",
      "The visible charter review completed successfully through GMI",
      "The activated charter cites PROJECT.md as the authoritative source and excludes WORKFLOW.md from the source corpus and project summary",
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
  await writeUnitConverterSources();
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
    if (entry.isDirectory() && !["node_modules", ".git"].includes(entry.name)) {
      await removeCredentialNamedFiles(path, maxDepth - 1);
    }
  }
}

function isCredentialLikeFilename(name) {
  const lower = name.toLowerCase();
  return lower === ".env" || lower.startsWith(".env.") || (lower.includes("api") && lower.includes("key"));
}

async function writeUnitConverterSources() {
  await writeFile(
    join(workspace, "PROJECT.md"),
    [
      "# Unit Converter Project",
      "",
      "Functional specification for a browser unit converter.",
      "",
      "Requirements:",
      "- Provide length conversions for meters, kilometers, miles, and feet.",
      "- Provide weight conversions for kilograms and pounds.",
      "- Provide temperature conversions for Celsius and Fahrenheit.",
      "- Update conversion results immediately as users edit the value, source unit, or target unit.",
      "- Display rounded results to four decimal places while preserving numeric correctness in the conversion engine.",
      "",
      "Proof expectations:",
      "- Unit tests must cover at least one conversion in each category.",
      "- A browser smoke proof must show a visible conversion result for 10 kilometers to miles.",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(workspace, "WORKFLOW.md"),
    [
      "# WORKFLOW",
      "",
      "Generated by Ambient.",
      "",
      "This generated workflow scaffold is intentionally not the product authority.",
      "",
      "Workflow scaffold:",
      "- Build an unrelated team chat bot.",
      "- Prefer chat rooms, message history, and emoji reactions.",
      "- Do not mention unit conversion requirements.",
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
    throw new Error(`Enabled button not found: ${label}. Visible buttons: ${buttons.slice(0, 40).join(" | ")}`);
  }
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

async function waitForBoardWithSources() {
  return waitForState(async () => {
    const board = boardFromState(await invoke("bootstrap"));
    return sourceAuthoritySnapshot(board) ? board : undefined;
  }, "board with PROJECT.md and generated WORKFLOW.md sources", 240_000);
}

async function waitForCharterReviewRunTerminal(previousRunIds) {
  const startedAt = Date.now();
  let lastActivityAt = Date.now();
  let lastSignature = "";
  while (Date.now() - startedAt < reviewMaxElapsedMs) {
    const state = await invoke("bootstrap");
    const board = boardFromState(state);
    const run = board.synthesisRuns.find((candidate) => {
      if (previousRunIds.has(candidate.id)) return false;
      return candidate.events.some((event) => event.summary?.includes("charter review") || event.metadata?.reviewReport === true);
    });
    if (run) {
      const signature = synthesisRunSignature(run);
      if (signature !== lastSignature) {
        lastSignature = signature;
        lastActivityAt = Date.now();
      }
      if (["succeeded", "failed", "paused", "abandoned"].includes(run.status)) return run;
      if (Date.now() - lastActivityAt > reviewIdleMs) {
        throw new Error(`Charter review run ${run.id} stalled for ${reviewIdleMs.toLocaleString()}ms without visible state progress.`);
      }
    }
    await delay(1000);
  }
  throw new Error(`Timed out waiting for charter review after ${reviewMaxElapsedMs.toLocaleString()}ms.`);
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

function sourceAuthoritySnapshot(board) {
  const project = findSourceByPath(board, "PROJECT.md");
  const workflow = findSourceByPath(board, "WORKFLOW.md");
  if (!project || !workflow) return undefined;
  return { project, workflow };
}

function assertSourceAuthority(board) {
  const snapshot = sourceAuthoritySnapshot(board);
  if (!snapshot) throw new Error("Expected PROJECT.md and WORKFLOW.md in board source inventory.");
  const { project, workflow } = snapshot;
  if (project.includeInSynthesis === false || project.authorityRole === "ignored") {
    throw new Error(`PROJECT.md was not included as source authority: ${JSON.stringify(project)}`);
  }
  if (workflow.includeInSynthesis !== false || workflow.authorityRole !== "ignored") {
    throw new Error(`Generated WORKFLOW.md was not demoted: ${JSON.stringify(workflow)}`);
  }
  if (!String(workflow.classificationReason || "").includes(generatedWorkflowReason)) {
    throw new Error(`Generated WORKFLOW.md did not record generated authority reason: ${workflow.classificationReason ?? "none"}`);
  }
  if (workflow.classifiedBy === "ambient_pi") {
    throw new Error("Generated WORKFLOW.md was classified by Pi even though deterministic authority should lock it before Pi sees candidates.");
  }
  return {
    project: sourceReport(project),
    workflow: sourceReport(workflow),
  };
}

function assertCharterAuthority(board) {
  const charter = board.charter;
  if (!charter) throw new Error("Expected active charter.");
  const authoritativeSources = charter.sourcePolicy?.authoritativeSources;
  if (!Array.isArray(authoritativeSources) || !authoritativeSources.includes("PROJECT.md")) {
    throw new Error(`Charter did not cite PROJECT.md as authoritative: ${JSON.stringify(charter.sourcePolicy)}`);
  }
  if (authoritativeSources.includes("WORKFLOW.md")) {
    throw new Error(`Charter incorrectly promoted generated WORKFLOW.md: ${JSON.stringify(charter.sourcePolicy)}`);
  }
  if (!charter.markdown.includes("Unit Converter Project (functional_spec: PROJECT.md)")) {
    throw new Error("Charter source corpus did not include PROJECT.md.");
  }
  if (charter.markdown.includes("Generated workflow (workflow_artifact: WORKFLOW.md)")) {
    throw new Error("Charter source corpus included the generated WORKFLOW.md scaffold.");
  }
  const sourceCoverage = charter.projectSummary?.sourceCoverage ?? [];
  if (!sourceCoverage.some((item) => String(item).includes("PROJECT.md"))) {
    throw new Error(`Project summary did not cite PROJECT.md: ${JSON.stringify(sourceCoverage)}`);
  }
  if (sourceCoverage.some((item) => String(item).includes("WORKFLOW.md"))) {
    throw new Error(`Project summary cited generated WORKFLOW.md: ${JSON.stringify(sourceCoverage)}`);
  }
  return {
    goal: charter.goal,
    authoritativeSources,
    sourceCoverage,
    projectSummaryGenerator: charter.projectSummary?.generator,
  };
}

async function assertVisibleSourceAuthority() {
  await waitFor(
    () => {
      const text = document.querySelector(".project-board-source-review")?.textContent || "";
      return text.includes("PROJECT.md") && text.includes("WORKFLOW.md") && text.includes("Ignored for synthesis");
    },
    "visible source authority labels",
    60_000,
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

function sourceRefreshEventCount(board) {
  return (board.events ?? []).filter((event) => event.kind === "sources_refreshed").length;
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
        .slice(0, 80),
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
  if (/gmi|provider|api key|stream|rate|timeout|timed out|stalled/i.test(message)) return "provider-degraded-or-timeout";
  if (/WORKFLOW|PROJECT|source authority|source classification|promotion|source corpus|Project summary|authoritative/i.test(message)) return "product";
  if (/source review|kickoff|button|cdp|electron|Ambient shell|spawn|exited|websocket|Expected active project to have a project board/i.test(message)) {
    return "environment-or-harness";
  }
  return "unknown";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
