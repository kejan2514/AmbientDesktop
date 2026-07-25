#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { deflateSync, inflateSync } from "node:zlib";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createVisualWorkflowFixtures } from "./e2e-visual-smoke-workflow-fixtures.mjs";
import { runProjectBoardVisualSmoke } from "./e2e-visual-smoke-project-board.mjs";

const port = await availablePort(Number(process.env.AMBIENT_VISUAL_CDP_PORT ?? 9486));
const browserFixturePort = await availablePort(Number(process.env.AMBIENT_VISUAL_BROWSER_FIXTURE_PORT ?? 9496));
const cdpCommandTimeoutMs = Number(process.env.AMBIENT_VISUAL_CDP_TIMEOUT_MS || 0) || 15_000;
const resultsDir = join(process.cwd(), "test-results", "visual");
const fixtureRoot = join(process.cwd(), "test-results", "visual-fixture");
const baselineDir = join(process.cwd(), "test", "visual-baselines");
const diffDir = join(resultsDir, "diffs");
const workspace = join(fixtureRoot, "ambient-visual-workspace");
const codexPluginCache = join(fixtureRoot, "codex-plugin-cache");
const userData = join(fixtureRoot, "user-data");
const chromeProfile = join(fixtureRoot, "chrome-profile");
const piPackageGalleryPath = join(workspace, "pi-package-gallery.html");
const remoteCodexMarketplacePath = join(workspace, "remote-codex-marketplace.json");
const baseScenarioNames = [
  "01-main-shell",
  "01a-project-board",
  "01c-project-board-proof-warning",
  "02-progress-tool-artifact",
  "02a-remote-surface-activation-cards",
  "03-artifact-preview",
  "04-git-summary",
  "04a-git-pr-status",
  "04b-git-branch-menu",
  "04c-git-review",
  "05-plugin-import-candidate",
  "05a-workflow-discovery",
  "05c-workflow-compile-progress",
  "05d-workflow-compile-failure",
  "05b-workflow-agent-diagram",
  "05e-workflow-recovery-cards",
  "05f-workflow-revision-diff",
  "05k-workflow-plan-edit-chat",
  "05r-workflow-source-mapping-focus",
  "05l-workflow-runtime-input",
  "05m-workflow-rendered-outputs",
  "05g-workflow-schedule-targeting",
  "05j-workflow-schedule-focus",
  "05n-workflow-schedules-overview-narrow",
  "05o-workflow-schedules-history-narrow",
  "05p-workflow-schedules-grants-narrow",
  "05q-workflow-runs-thread-scoped",
  "05i-workflow-schedule-grant-action",
  "05h-workflow-permission-grant-prompt",
  "06-compact-layout",
  "06a-settings-search",
  "06c-settings-remote-entrypoint",
  "06b-settings-narrow",
  "07-browser-profile-copy",
  "08-browser-picker-active",
];
const visualThemePreference = parseVisualThemePreference();
const scenarioPrefix = visualThemePreference === "dark" ? "dark-" : "";
const scenarioNames = baseScenarioNames.map((scenario) => `${scenarioPrefix}${scenario}`);
const updateBaselines = process.argv.includes("--update-baseline") || process.env.AMBIENT_UPDATE_VISUAL_BASELINES === "1";
const compareBaselines = process.argv.includes("--compare-baseline") || process.argv.includes("--full") || process.env.AMBIENT_COMPARE_VISUAL_BASELINES === "1";
const usesGmiCloudProvider = process.env.AMBIENT_PROVIDER === "gmi-cloud" || process.env.AMBIENT_LLM_PROVIDER === "gmi-cloud";
const ambientApiKey = await readAmbientApiKey();
if (!ambientApiKey && !usesGmiCloudProvider) {
  throw new Error("Set AMBIENT_API_KEY, AMBIENT_AGENT_AMBIENT_API_KEY, AMBIENT_API_KEY_FILE, or place ignored-provider-key-file.txt near the repo before running visual Workflow Agent smoke.");
}
const output = [];
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
let appInstance;
let browserFixtureServer;
const appChildren = new Set();
const {
  emitE2eEvent,
  emitWorkflowCompileProgressFixture,
  seedWorkflowDiscoveryThread,
  seedWorkflowRecoveryVisual,
  assertWorkflowDebugRewriteClickUsesGraphEvent,
  seedWorkflowRevisionVisual,
  seedWorkflowPlanEditChatVisual,
  seedWorkflowSourceMappingVisual,
  seedWorkflowRuntimeInputOutputVisual,
  seedWorkflowScheduleVisual,
  emitWorkflowPermissionPromptVisual,
} = createVisualWorkflowFixtures({ evaluate, delay, clickButton, waitFor });

try {
  await rm(fixtureRoot, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(codexPluginCache, { recursive: true });
  await mkdir(userData, { recursive: true });
  await mkdir(chromeProfile, { recursive: true });
  await seedWorkspace(workspace);
  await seedCodexPluginCache(codexPluginCache);
  await seedChromeProfile(chromeProfile);
  await seedRemoteCodexMarketplace(remoteCodexMarketplacePath);
  await rm(resultsDir, { recursive: true, force: true });
  await mkdir(resultsDir, { recursive: true });
  appInstance = await launchApp();
  const cdp = appInstance.cdp;

  await setViewport(cdp, 1440, 900);
  await waitFor(cdp, () => document.body?.innerText.includes("Ambient"), "main shell");
  await setVisualTheme(cdp);
  await installVisualStabilizers(cdp);
  await waitFor(
    cdp,
    () => {
      const button = [...document.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === "Add Plan to Board");
      return Boolean(button?.disabled && button.title.includes("Build a project board"));
    },
    "visual add plan toolbar disabled before board",
  );
  await captureVisual(cdp, "01-main-shell");

  await runProjectBoardVisualSmoke({
    cdp,
    workspace,
    evaluate,
    emitE2eEvent,
    waitFor,
    clickButton,
    clickProjectionReviewResolution,
    clickProjectBoardTab,
    clickEnabledButtonInRow,
    assertProjectBoardProofScopeWarningsStable,
    captureVisual,
    delay,
    assertProjectBoardButtonsHaveTooltips,
    clickProjectBoardCard,
    clickProjectBoardActiveCardDetailTab,
    clickProjectBoardDialogButton,
    clickProjectBoardKickoffButton,
    createProjectBoardLinkedTask,
  });
  await injectProgressToolArtifactState(cdp);
  await waitFor(cdp, () => document.querySelector(".run-activity-card")?.textContent?.includes("Observed"), "progress card");
  await waitFor(cdp, () => document.querySelector(".artifact-strip")?.textContent?.includes("Preview notes.md"), "artifact strip");
  await captureVisual(cdp, "02-progress-tool-artifact");

  await injectRemoteSurfaceActivationCardsState(cdp);
  await waitFor(cdp, () => document.querySelectorAll(".tool-remote-activation").length >= 3, "remote surface activation cards");
  await captureVisual(cdp, "02a-remote-surface-activation-cards");

  await clickButton(cdp, "Preview notes.md");
  await waitFor(cdp, () => document.body.innerText.includes("Visual Smoke Notes"), "artifact preview");
  await captureVisual(cdp, "03-artifact-preview");

  await clickButton(cdp, "Diff");
  await waitFor(cdp, () => document.querySelector(".git-codex-summary-card")?.textContent?.includes("files changed"), "git summary card");
  await captureVisual(cdp, "04-git-summary");
  await evaluate(cdp, `document.querySelector(".git-pr-card")?.scrollIntoView({ block: "center" })`);
  await waitFor(cdp, () => document.querySelector(".git-pr-card")?.textContent?.includes("Pull request"), "git PR status card");
  await captureVisual(cdp, "04a-git-pr-status");
  await evaluate(cdp, `document.querySelector(".panel-body")?.scrollTo({ top: 0 })`);
  await clickButton(cdp, "Switch Git branch");
  await waitFor(cdp, () => document.querySelector(".git-branch-search input") && document.body.innerText.includes("Create branch"), "git branch menu");
  await captureVisual(cdp, "04b-git-branch-menu");
  await clickButton(cdp, "Close Git branch menu");
  await clickButton(cdp, "Review");
  await waitFor(cdp, () => document.querySelector(".git-review-toolbar")?.textContent?.includes("Stage all"), "git review toolbar");
  await captureVisual(cdp, "04c-git-review");

  await clickButton(cdp, "Plugins");
  await waitFor(cdp, () => document.body.innerText.includes("Plugins known"), "visual plugin home");
  await clickButton(cdp, "Marketplace");
  await waitFor(cdp, () => document.body.innerText.includes("Browser Use"), "visual plugin import candidate");
  await waitFor(cdp, () => document.body.innerText.includes("Ambient Browser adapter"), "visual plugin adapter label");
  await waitFor(cdp, () => document.body.innerText.includes("Remote Helper"), "visual remote plugin candidate");
  await waitFor(cdp, () => document.body.innerText.includes("Remote marketplace"), "visual remote plugin label");
  await captureVisual(cdp, "05-plugin-import-candidate");

  await clickButton(cdp, "Workflow Agents");
  await waitFor(cdp, () => document.body.innerText.includes("Workflow Agents") && document.body.innerText.includes("New Workflow"), "visual workflow agents shell");
  await clickButton(cdp, "New Workflow");
  await waitFor(cdp, () => document.body.innerText.includes("Skip discovery and compile"), "visual new workflow pane");
  const workflowDiscoveryState = await seedWorkflowDiscoveryThread(cdp);
  await clickWorkflowAgentThread(cdp, "Visual Discovery Workflow");
  await emitE2eEvent(cdp, { type: "state", state: workflowDiscoveryState });
  await waitFor(cdp, () => document.body.innerText.includes("Workflow Discovery locked on"), "visual workflow discovery mode", 180_000);
  await waitFor(cdp, () => document.querySelector(".workflow-discovery-questions")?.textContent?.includes("What should trigger"), "visual workflow discovery questions", 180_000);
  await waitFor(cdp, () => document.querySelectorAll(".workflow-agent-diagram-pane .workflow-agent-node").length >= 4, "visual workflow discovery diagram nodes");
  await captureVisual(cdp, "05a-workflow-discovery");
  await emitWorkflowCompileProgressFixture(cdp, "running");
  await waitFor(cdp, () => document.querySelector(".workflow-compile-activity")?.textContent?.includes("Response: 4,096 chars"), "visual workflow compile streaming progress");
  await evaluate(cdp, `document.querySelector(".workflow-compile-activity")?.scrollIntoView({ block: "center" })`);
  await captureVisual(cdp, "05c-workflow-compile-progress");
  await emitWorkflowCompileProgressFixture(cdp, "failed");
  await waitFor(cdp, () => document.querySelector(".workflow-compile-activity")?.textContent?.includes("Compile failed"), "visual workflow compile failure");
  await evaluate(cdp, `document.querySelector(".workflow-compile-activity")?.scrollIntoView({ block: "center" })`);
  await captureVisual(cdp, "05d-workflow-compile-failure");
  await clickButton(cdp, "New Workflow");
  await waitFor(cdp, () => document.body.innerText.includes("Skip discovery and compile"), "visual new workflow pane after discovery");
  await clickButton(cdp, "Create sample");
  await waitFor(cdp, () => document.body.innerText.includes("Workflow Agent tool bridge preview"), "visual workflow sample");
  await clickButton(cdp, "Workflow Agent tool bridge preview");
  await waitFor(cdp, () => document.querySelector(".workflow-agent-diagram-pane")?.textContent?.includes("Workflow Diagram"), "visual workflow diagram pane");
  await waitFor(cdp, () => document.querySelectorAll(".workflow-agent-diagram-pane .workflow-agent-node").length >= 4, "visual workflow diagram nodes");
  await evaluate(cdp, `document.querySelector(".workflow-agent-diagram-pane")?.scrollIntoView({ block: "center" })`);
  await captureVisual(cdp, "05b-workflow-agent-diagram");
  const recoveryFixture = await seedWorkflowRecoveryVisual(cdp, "Workflow Agent tool bridge preview");
  await waitFor(cdp, () => document.querySelector(".workflow-agent-data-cards")?.textContent?.includes("Retry step"), "visual workflow retry action");
  await waitFor(cdp, () => document.querySelector(".workflow-agent-data-cards")?.textContent?.includes("Resume from checkpoint"), "visual workflow checkpoint action");
  await waitFor(cdp, () => document.querySelector(".workflow-agent-data-cards")?.textContent?.includes("Skip item"), "visual workflow skip action");
  await waitFor(cdp, () => document.querySelector(".workflow-agent-data-cards")?.textContent?.includes("Ask Ambient to debug"), "visual workflow debug action");
  await evaluate(cdp, `document.querySelector(".workflow-agent-data-cards")?.scrollIntoView({ block: "center" })`);
  await captureVisual(cdp, "05e-workflow-recovery-cards");
  await seedWorkflowRevisionVisual(cdp, recoveryFixture);
  await waitFor(cdp, () => document.querySelector(".workflow-revision-panel")?.textContent?.includes("Proposed revision"), "visual workflow proposed revision");
  await waitFor(cdp, () => document.querySelector(".workflow-revision-panel")?.textContent?.includes("Apply revision"), "visual workflow revision apply action");
  await waitFor(cdp, () => document.querySelector(".workflow-revision-detail-list")?.textContent?.includes("Added node"), "visual workflow revision graph detail");
  await waitFor(cdp, () => document.querySelector(".workflow-revision-source-preview")?.textContent?.includes("ambient.checkpoint"), "visual workflow revision source preview");
  await evaluate(cdp, `document.querySelector(".workflow-revision-panel")?.scrollIntoView({ block: "center" })`);
  await captureVisual(cdp, "05f-workflow-revision-diff");
  await seedWorkflowPlanEditChatVisual(cdp, recoveryFixture);
  await waitFor(cdp, () => Boolean(document.querySelector('.workflow-build-rail [data-panel-target="build-overview"].active')), "visual workflow build rail overview active");
  await waitFor(cdp, () => Boolean(document.querySelector(".workflow-persistent-diagram-pane .workflow-agent-diagram-pane")), "visual workflow persistent diagram pane");
  await assertWorkflowWorkspaceCompactLayout(cdp, {
    workspaceSelector: ".workflow-build-workspace",
    railSelector: ".workflow-build-rail",
    shellSelector: ".workflow-build-shell",
    label: "build workspace",
  });
  await waitFor(cdp, () => document.querySelector("#build-overview")?.textContent?.includes("Pi session active"), "visual workflow design session active");
  await waitFor(cdp, () => document.querySelector(".workflow-thread-transcript")?.textContent?.includes("You asked Pi"), "visual workflow plan edit user card");
  await waitFor(cdp, () => document.querySelector(".workflow-thread-transcript")?.textContent?.includes("Pi answered"), "visual workflow plan edit assistant card");
  await waitFor(cdp, () => document.querySelector(".workflow-thread-transcript")?.textContent?.includes("Pi inspected workflow context"), "visual workflow native read tool card");
  await waitFor(cdp, () => document.querySelector(".workflow-thread-transcript")?.textContent?.includes("Pi is responding in Workflow Chat."), "visual workflow chat streaming placeholder");
  await waitFor(cdp, () => document.querySelector(".workflow-thread-transcript")?.textContent?.includes("Streaming"), "visual workflow plan edit streaming status");
  await waitFor(cdp, () => document.querySelector(".workflow-exploration-overview-card")?.textContent?.includes("Exploration recommended before compile"), "visual workflow exploration recommendation card");
  await evaluate(
    cdp,
    `(() => {
      const card = document.querySelector(".workflow-exploration-overview-card");
      const button = [...card?.querySelectorAll("button") ?? []].find((item) => item.textContent?.trim() === "Skip");
      button?.click();
    })()`,
  );
  await waitFor(cdp, () => Boolean(document.querySelector('.workflow-build-rail [data-panel-target="build-exploration"].active')), "visual workflow exploration rail active");
  await waitFor(cdp, () => document.querySelector("#build-exploration")?.textContent?.includes("Exploration skipped for this compile"), "visual workflow exploration skipped state");
  await waitFor(cdp, () => document.querySelector("#build-exploration")?.textContent?.includes("Compile without exploration"), "visual workflow skipped exploration compile action");
  await evaluate(cdp, `document.querySelector('.workflow-build-rail [data-panel-target="build-overview"]')?.click()`);
  await waitFor(cdp, () => Boolean(document.querySelector('.workflow-build-rail [data-panel-target="build-overview"].active')), "visual workflow returns to chat after exploration skip");
  await waitFor(cdp, () => document.querySelector(".workflow-thread-transcript")?.textContent?.includes("Inspect diagram"), "visual workflow revision panel jump");
  await seedWorkflowSourceMappingVisual(cdp, recoveryFixture);
  await evaluate(cdp, `document.querySelector('.workflow-thread-transcript [data-panel-action-target="source"]')?.click()`);
  await waitFor(cdp, () => Boolean(document.querySelector('.workflow-build-rail [data-panel-target="build-source"].active')), "visual workflow transcript action opens source rail");
  await waitFor(cdp, () => Boolean(document.querySelector("#build-source .workflow-review-program-inspector")), "visual workflow transcript source panel focused");
  await waitFor(cdp, () => Boolean(document.querySelector("#build-source .workflow-source-mapping-row.interactive")), "visual workflow source mapping rows");
  await evaluate(cdp, `document.querySelector("#build-source .workflow-source-mapping-row.interactive")?.click()`);
  await waitFor(cdp, () => Boolean(document.querySelector("#build-source .workflow-source-selection-proof")), "visual workflow source mapping selection proof");
  await captureVisual(cdp, "05r-workflow-source-mapping-focus");
  await evaluate(cdp, `document.querySelector('.workflow-build-rail [data-panel-target="build-overview"]')?.click()`);
  await waitFor(cdp, () => Boolean(document.querySelector('.workflow-build-rail [data-panel-target="build-overview"].active')), "visual workflow transcript action returns to chat rail");
  await evaluate(cdp, `document.querySelector(".workflow-chat-first-scroll")?.scrollTo({ top: 10000 })`);
  await waitFor(
    cdp,
    () => (document.querySelector(".workflow-chat-first-scroll")?.scrollTop ?? 0) > 0 && Boolean(document.querySelector(".workflow-persistent-diagram-pane .workflow-agent-diagram-pane")),
    "visual workflow chat internal scroll keeps diagram mounted",
  );
  await evaluate(cdp, `document.querySelector(".workflow-thread-transcript")?.scrollIntoView({ block: "center" })`);
  await captureVisual(cdp, "05k-workflow-plan-edit-chat");
  await seedWorkflowRuntimeInputOutputVisual(cdp, recoveryFixture);
  await waitFor(cdp, () => document.querySelector(".workflow-thread-transcript")?.textContent?.includes("Workflow needs input"), "visual workflow runtime input touchpoint");
  await waitFor(cdp, () => document.querySelector(".workflow-thread-transcript")?.textContent?.includes("Inspect outputs"), "visual workflow output touchpoint");
  await evaluate(cdp, `document.querySelector('.workflow-thread-transcript [data-panel-action-target="runtime_input"]')?.click()`);
  await waitFor(cdp, () => document.querySelector("#runs-input")?.textContent?.includes("Review classifications before applying labels"), "visual workflow runtime input panel");
  await waitFor(
    cdp,
    () => document.querySelector("#runs-input")?.textContent?.includes("/visual/workflows/recovery/output/classification-preview.html"),
    "visual workflow runtime input attached artifact path",
  );
  await evaluate(cdp, `document.querySelector("#runs-input")?.scrollIntoView({ block: "center" })`);
  await captureVisual(cdp, "05l-workflow-runtime-input");
  await evaluate(cdp, `document.querySelector('.workflow-build-rail [data-panel-target="build-overview"]')?.click()`);
  await waitFor(cdp, () => Boolean(document.querySelector('.workflow-build-rail [data-panel-target="build-overview"].active')), "visual workflow overview before output focus");
  await evaluate(
    cdp,
    `(() => {
      const button = [...document.querySelectorAll('.workflow-thread-transcript [data-panel-action-target="outputs"]')]
        .find((item) => item.textContent?.includes("Inspect outputs"));
      button?.click();
      return Boolean(button);
    })()`,
  );
  await waitFor(cdp, () => document.querySelector("#runs-outputs")?.textContent?.includes("Checkpoint final_output"), "visual workflow rendered output checkpoint");
  await waitFor(cdp, () => document.querySelector("#runs-outputs")?.textContent?.includes("File classifications"), "visual workflow rendered output markdown");
  await evaluate(cdp, `document.querySelector("#runs-outputs")?.scrollIntoView({ block: "center" })`);
  await captureVisual(cdp, "05m-workflow-rendered-outputs");
  await evaluate(cdp, `document.querySelector('.workflow-build-rail [data-panel-target="build-overview"]')?.click()`);
  await waitFor(cdp, () => Boolean(document.querySelector('.workflow-build-rail [data-panel-target="build-overview"].active')), "visual workflow returns to overview after output focus");
  await seedWorkflowScheduleVisual(cdp, recoveryFixture);
  await waitFor(
    cdp,
    () => {
      const controls = document.querySelector('[data-workflow-review-section="review_controls"]');
      return controls?.textContent?.includes("Validate version") && controls.textContent.includes("Dry run") && controls.textContent.includes("Run");
    },
    "visual workflow review controls grouped",
  );
  await waitFor(cdp, () => document.querySelector(".workflow-review-workspace")?.textContent?.includes("Schedule latest approved"), "visual workflow schedule controls");
  await waitFor(cdp, () => document.querySelector(".workflow-review-workspace")?.textContent?.includes("Drifted from created v3 to latest approved v4"), "visual workflow schedule drift");
  await waitFor(cdp, () => document.querySelector(".workflow-review-workspace")?.textContent?.includes("Pinned to v3"), "visual workflow pinned schedule");
  await waitFor(cdp, () => document.querySelector(".workflow-review-workspace")?.textContent?.includes("Recent unattended runs"), "visual workflow recent scheduled run history");
  await waitFor(cdp, () => document.querySelector(".workflow-review-workspace")?.textContent?.includes("Latest Paused"), "visual workflow paused schedule history");
  await evaluate(cdp, `document.querySelector(".workflow-review-workspace .workflow-version-list")?.scrollIntoView({ block: "center" })`);
  await captureVisual(cdp, "05g-workflow-schedule-targeting");
  await clickWorkflowReviewScheduleAction(cdp);
  await waitFor(cdp, () => Boolean(document.querySelector('.workflow-schedules-workspace[data-mode="schedules"]')), "visual workflow schedules workspace");
  await assertWorkflowWorkspaceCompactLayout(cdp, {
    workspaceSelector: ".workflow-schedules-workspace",
    railSelector: ".workflow-schedules-rail",
    shellSelector: ".workflow-schedules-shell",
    label: "schedules workspace",
  });
  await evaluate(cdp, `document.querySelector('.workflow-schedules-rail [data-panel-target="schedules-overview"]')?.click()`);
  await setViewport(cdp, 960, 760);
  await waitFor(cdp, () => document.querySelector("#schedules-overview")?.textContent?.includes("Idle timeout"), "visual workflow schedules overview run limits");
  await waitFor(cdp, () => document.querySelector("#schedules-overview")?.textContent?.includes("Use manifest cap"), "visual workflow schedules overview total cap");
  await evaluate(cdp, `document.querySelector("#schedules-overview")?.scrollIntoView({ block: "start" })`);
  await captureVisual(cdp, "05n-workflow-schedules-overview-narrow");
  await evaluate(cdp, `document.querySelector('.workflow-schedules-rail [data-panel-target="schedules-history"]')?.click()`);
  await waitFor(cdp, () => document.querySelector("#schedules-history")?.textContent?.includes("Exception ledger"), "visual workflow schedules history exception ledger");
  await waitFor(cdp, () => document.querySelector("#schedules-history")?.textContent?.includes("Run-limit override"), "visual workflow schedules history run limits");
  await waitFor(cdp, () => document.querySelector("#schedules-history")?.textContent?.includes("Reschedule..."), "visual workflow schedules history reschedule action");
  await waitFor(cdp, () => document.querySelector("#schedules-history")?.textContent?.includes("No cap next"), "visual workflow schedules history no cap action");
  await evaluate(cdp, `document.querySelector("#schedules-history")?.scrollIntoView({ block: "start" })`);
  await captureVisual(cdp, "05o-workflow-schedules-history-narrow");
  await evaluate(cdp, `document.querySelector('.workflow-schedules-rail [data-panel-target="schedules-grants"]')?.click()`);
  await waitFor(cdp, () => document.querySelector("#schedules-grants")?.textContent?.includes("reusable grant"), "visual workflow schedules grants readiness");
  await waitFor(cdp, () => document.querySelector("#schedules-grants")?.textContent?.includes("Full Access"), "visual workflow schedules grants full access receipts");
  await evaluate(cdp, `document.querySelector("#schedules-grants")?.scrollIntoView({ block: "start" })`);
  await captureVisual(cdp, "05p-workflow-schedules-grants-narrow");
  await setViewport(cdp, 1440, 900);
  await clickButton(cdp, "Runs");
  await waitFor(cdp, () => Boolean(document.querySelector('.workflow-runs-workspace[data-mode="runs"]')), "visual workflow thread runs workspace");
  await waitFor(cdp, () => document.querySelector("#runs-live")?.textContent?.includes("Run Console"), "visual workflow thread runs live panel");
  await waitFor(cdp, () => document.querySelector(".workflow-thread-run-list")?.textContent?.includes("Scheduled"), "visual workflow thread scheduled run row");
  await assertWorkflowWorkspaceCompactLayout(cdp, {
    workspaceSelector: ".workflow-runs-workspace",
    railSelector: ".workflow-runs-rail",
    shellSelector: ".workflow-runs-shell",
    rowSelector: ".workflow-thread-run-row",
    label: "runs workspace",
  });
  await evaluate(cdp, `document.querySelector(".workflow-runs-workspace")?.scrollIntoView({ block: "start" });`);
  await captureVisual(cdp, "05q-workflow-runs-thread-scoped");
  await clickScheduledRunScheduleAction(cdp);
  await waitFor(cdp, () => document.querySelector(".workflow-schedules-workspace")?.textContent?.includes("Scheduled run history"), "visual focused workflow schedule pane");
  await waitFor(cdp, () => document.querySelector("#schedules-history")?.textContent?.includes("Latest approved"), "visual focused workflow schedule series");
  await evaluate(cdp, `document.querySelector("#schedules-history")?.scrollIntoView({ block: "center" });`);
  await delay(100);
  await captureVisual(cdp, "05j-workflow-schedule-focus");
  await clickWorkflowAgentThread(cdp, "Workflow Agent tool bridge preview");
  await seedWorkflowScheduleVisual(cdp, recoveryFixture);
  await waitFor(cdp, () => document.querySelector(".workflow-review-workspace")?.textContent?.includes("Schedule latest approved"), "visual workflow review after schedule focus");
  await emitE2eEvent(cdp, { type: "e2e-permission-fixture", grants: [], audit: [] });
  await waitFor(cdp, () => document.querySelector(".workflow-review-workspace")?.textContent?.includes("Allow scheduled reads"), "visual workflow schedule grant action");
  await evaluate(cdp, `document.querySelector(".workflow-review-workspace .workflow-version-list")?.scrollIntoView({ block: "center" })`);
  await captureVisual(cdp, "05i-workflow-schedule-grant-action");
  await emitWorkflowPermissionPromptVisual(cdp, recoveryFixture);
  await waitFor(cdp, () => document.querySelector(".permission-dialog")?.textContent?.includes("Always for this workflow"), "visual workflow permission prompt reusable workflow scope");
  await waitFor(cdp, () => document.querySelector(".permission-dialog")?.textContent?.includes("Always for this workspace"), "visual workflow permission prompt reusable workspace scope");
  await captureVisual(cdp, "05h-workflow-permission-grant-prompt");
  await clickButton(cdp, "Deny");
  await waitFor(cdp, () => !document.querySelector(".permission-dialog"), "visual workflow permission prompt closed");

  await clickButton(cdp, "Plugins");
  await waitFor(cdp, () => document.body.innerText.includes("Plugins known"), "visual plugin home after workflow diagram");
  await clickButton(cdp, "Sources");
  await waitFor(cdp, () => document.body.innerText.includes("Configured remote marketplace"), "visual plugin sources");
  await clickButton(cdp, "Inspect Pi packages");
  await waitFor(cdp, () => document.body.innerText.includes("Visual Pi Package"), "visual Pi package metadata");
  await waitFor(cdp, () => document.body.innerText.includes("pi-mcp-adapter"), "visual Pi gallery package");

  await setViewport(cdp, 880, 720);
  await waitFor(cdp, () => {
    const panel = document.querySelector(".right-panel");
    return !panel || getComputedStyle(panel).display === "none";
  }, "compact layout hides panel");
  await captureVisual(cdp, "06-compact-layout");

  await setViewport(cdp, 1440, 900);
  await waitFor(cdp, () => {
    const panel = document.querySelector(".right-panel");
    return Boolean(panel && getComputedStyle(panel).display !== "none");
  }, "wide layout shows panel");
  await runSettingsUxRefreshVisualSmoke(cdp);
  await clickButton(cdp, "Browser");
  await waitFor(cdp, () => document.body.innerText.includes("Agent browser"), "visual browser panel");
  await clickButton(cdp, "Copy profile");
  await waitFor(cdp, () => document.body.innerText.includes("Copy Chrome profile?"), "visual browser profile copy dialog");
  await captureVisual(cdp, "07-browser-profile-copy");
  await evaluate(
    cdp,
    `(() => {
      const button = [...document.querySelectorAll(".modal-backdrop button")]
        .find((item) => item.textContent?.trim() === "Cancel");
      button?.click();
      return Boolean(button);
    })()`,
  );
  await waitFor(cdp, () => !document.body.innerText.includes("Copy Chrome profile?"), "visual browser profile copy dialog closed");

  await evaluate(
    cdp,
    "window.ambientDesktop.setBrowserViewBounds({ x: 760, y: 250, width: 520, height: 260, visible: true })",
  );
  await evaluate(cdp, "window.ambientDesktop.startBrowser({ profileMode: 'isolated' })");
  const browserFixtureUrl = await startBrowserFixtureServer();
  await evaluate(cdp, `window.ambientDesktop.navigateBrowser({ url: ${JSON.stringify(browserFixtureUrl)} })`);
  await evaluate(
    cdp,
    `(() => {
      window.__ambientVisualPickResult = undefined;
      window.ambientDesktop.pickBrowser({ prompt: "Select the visual smoke heading", profileMode: "isolated" })
        .then((result) => { window.__ambientVisualPickResult = result; });
      return true;
    })()`,
  );
  await waitFor(
    cdp,
    () =>
      document.body.innerText.includes("Ambient is waiting for your browser selection") &&
      document.body.innerText.includes("Select the visual smoke heading"),
    "visual browser picker active state",
  );
  await captureVisual(cdp, "08-browser-picker-active");
  await evaluate(cdp, "window.ambientDesktop.cancelBrowserPick()");

  await clickButton(cdp, "Workflow Agents");
  await waitFor(cdp, () => document.body.innerText.includes("Workflow Agents") && document.body.innerText.includes("New Workflow"), "visual workflow agents shell before debug click dogfood");
  await clickWorkflowAgentThread(cdp, "Workflow Agent tool bridge preview");
  const debugClickFixture = await seedWorkflowRecoveryVisual(cdp, "Workflow Agent tool bridge preview");
  await assertWorkflowDebugRewriteClickUsesGraphEvent(cdp, debugClickFixture);

  await writeVisualManifest();
  if (updateBaselines) await updateVisualBaselines();
  if (compareBaselines) await compareVisualBaselines();
} catch (error) {
  console.error(outputTail());
  throw error;
} finally {
  if (appInstance) {
    appInstance.cdp.close();
  }
  if (browserFixtureServer) await new Promise((resolve) => browserFixtureServer.close(resolve));
  for (const child of [...appChildren]) await terminateProcessTree(child);
  await terminateDebugPortProcesses();
  await rm(fixtureRoot, { recursive: true, force: true });
}

console.log(`Visual smoke screenshots written to ${resultsDir}`);

function parseVisualThemePreference() {
  const cliValue = process.argv.find((arg) => arg.startsWith("--theme="))?.slice("--theme=".length);
  const raw = cliValue || process.env.AMBIENT_VISUAL_THEME || "light";
  if (raw === "light" || raw === "dark" || raw === "system") return raw;
  throw new Error(`Unsupported visual theme: ${raw}. Use light, dark, or system.`);
}

async function setVisualTheme(cdp) {
  await evaluate(cdp, `window.__ambientVisualThemePreference = ${JSON.stringify(visualThemePreference)}`);
  await evaluate(
    cdp,
    `window.ambientDesktop.setThemePreference({ themePreference: ${JSON.stringify(visualThemePreference)} })`,
  );
  await waitFor(
    cdp,
    () => document.documentElement.dataset.themePreference === window.__ambientVisualThemePreference,
    `${visualThemePreference} visual theme`,
  );
}

async function seedWorkspace(root) {
  await writeFile(join(root, "notes.md"), "# Visual Smoke Notes\n\nThis file verifies artifact preview flow.\n", "utf8");
  await writeFile(
    join(root, "sample.html"),
    "<!doctype html><title>Visual Browser Picker</title><main><h1>Visual smoke heading</h1><button data-testid=\"primary-action\">Primary action</button></main>",
    "utf8",
  );
  await writeFile(join(root, "tracked.txt"), "tracked base\n", "utf8");
  await writeFile(join(root, "staged.txt"), "staged base\n", "utf8");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "visual-pi-package",
        version: "0.2.0",
        description: "Visual Pi Package",
        keywords: ["pi-package"],
        pi: {
          skills: ["./skills"],
          prompts: ["./prompts/review.md"],
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    piPackageGalleryPath,
    [
      '<article data-package-card="true" data-package-name="pi-mcp-adapter" data-package-search="pi-mcp-adapter mcp adapter"',
      'data-package-types="extension" data-package-downloads="13452" data-package-date="1777058467893" data-package-path="/packages/pi-mcp-adapter">',
      '<p class="packages-desc">MCP adapter extension for Pi.</p>',
      '<span class="meta-chip packages-badge" data-type="extension">extension</span>',
      "</article>",
    ].join("\n"),
    "utf8",
  );
  await runCommand("git", ["init"], root);
  await runCommand("git", ["add", "notes.md", "tracked.txt", "staged.txt", "package.json"], root);
  await runCommand("git", ["-c", "user.name=Ambient Visual", "-c", "user.email=visual@example.test", "commit", "-m", "seed"], root);
  await runCommand("git", ["branch", "visual/branch"], root);
  await writeFile(join(root, "tracked.txt"), "tracked base\nvisual dirty line\n", "utf8");
  await writeFile(join(root, "staged.txt"), "staged base\nvisual staged line\n", "utf8");
  await runCommand("git", ["add", "staged.txt"], root);
  await writeFile(join(root, "untracked.txt"), "visual untracked line\n", "utf8");
}

async function seedCodexPluginCache(root) {
  const pluginRoot = join(root, "openai-bundled", "browser-use", "0.1.0-alpha1");
  await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
  await mkdir(join(pluginRoot, "skills", "browser-use"), { recursive: true });
  await writeFile(
    join(pluginRoot, ".codex-plugin", "plugin.json"),
    JSON.stringify(
      {
        name: "browser-use",
        version: "0.1.0-alpha1",
        description: "Browser Use visual fixture from the local Codex plugin cache.",
        skills: "./skills/",
        interface: {
          displayName: "Browser Use",
          shortDescription: "Checks Ambient Browser adapter labels.",
          category: "Engineering",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    join(pluginRoot, "skills", "browser-use", "SKILL.md"),
    ["---", "name: browser-use", "description: Visual browser import fixture.", "---", "", "Fixture skill.", ""].join("\n"),
    "utf8",
  );
}

async function seedChromeProfile(root) {
  await mkdir(join(root, "Default", "Cache"), { recursive: true });
  await writeFile(join(root, "Default", "Cookies"), "ambient visual cookie fixture", "utf8");
  await writeFile(join(root, "Default", "Cache", "ignored-cache"), "cache fixture", "utf8");
  await writeFile(join(root, "SingletonLock"), "lock fixture", "utf8");
}

async function seedRemoteCodexMarketplace(path) {
  await writeFile(
    path,
    JSON.stringify(
      {
        name: "remote-codex-visual-fixture",
        interface: { displayName: "Remote Codex Visual Fixture" },
        plugins: [
          {
            name: "remote-helper",
            version: "0.1.0",
            description: "Remote Codex visual fixture.",
            source: {
              source: "git-subdir",
              url: "https://github.com/example/codex-plugins.git",
              path: "./plugins/remote-helper",
              ref: "main",
            },
            category: "Productivity",
            interface: {
              displayName: "Remote Helper",
              shortDescription: "Remote Codex candidate for visual regression.",
              category: "Productivity",
            },
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function launchApp() {
  const child = spawn("pnpm", ["exec", "electron-vite", "dev", "--remoteDebuggingPort", String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AMBIENT_DESKTOP_WORKSPACE: workspace,
      AMBIENT_E2E: "1",
      AMBIENT_E2E_USER_DATA: userData,
      AMBIENT_DESKTOP_BOOTSTRAP_WATCHDOG_MS: process.env.AMBIENT_DESKTOP_BOOTSTRAP_WATCHDOG_MS ?? "180000",
      AMBIENT_E2E_SKIP_PROJECT_BOARD_SOURCE_REFRESH: "1",
      AMBIENT_CODEX_PLUGIN_CACHE: codexPluginCache,
      AMBIENT_CODEX_CURATED_MARKETPLACE_URL: "0",
      AMBIENT_CODEX_REMOTE_MARKETPLACE_PATH: remoteCodexMarketplacePath,
      AMBIENT_PI_PACKAGE_GALLERY_PATH: piPackageGalleryPath,
      AMBIENT_PI_USER_SETTINGS_PATH: join(userData, "missing-pi-settings.json"),
      AMBIENT_BROWSER_CHROME_PROFILE: chromeProfile,
      ...(ambientApiKey
        ? {
            AMBIENT_API_KEY: ambientApiKey,
            AMBIENT_AGENT_AMBIENT_API_KEY: ambientApiKey,
          }
        : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  appChildren.add(child);
  child.once("exit", () => appChildren.delete(child));
  child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));
  const target = await waitForPageEndpoint(port);
  const cdp = await connectPageCdpWithRetry(target.webSocketDebuggerUrl, "Electron page CDP");
  return { child, cdp };
}

async function injectProgressToolArtifactState(cdp) {
  const state = await evaluate(cdp, "window.ambientDesktop.bootstrap()");
  const threadId = state.activeThreadId;
  const now = new Date().toISOString();
  await emitE2eEvent(cdp, { type: "run-status", threadId, status: "streaming" });
  await emitE2eEvent(cdp, {
    type: "message-created",
    message: {
      id: "visual-user",
      threadId,
      role: "user",
      content: "Create a short notes artifact and inspect the workspace.",
      createdAt: now,
    },
  });
  await emitE2eEvent(cdp, {
    type: "message-created",
    message: {
      id: "visual-thinking",
      threadId,
      role: "assistant",
      content: "",
      createdAt: now,
      metadata: { status: "thinking", kind: "thinking" },
    },
  });
  await emitE2eEvent(cdp, { type: "message-delta", messageId: "visual-thinking", delta: "Inspecting files before writing the artifact." });
  await emitE2eEvent(cdp, { type: "tool-event", threadId, label: "write", status: "running" });
  await emitE2eEvent(cdp, {
    type: "message-created",
    message: {
      id: "visual-write-tool",
      threadId,
      role: "tool",
      content: [
        "write completed",
        "",
        "Input",
        JSON.stringify(
          {
            path: join(workspace, "notes.md"),
            content: "# Visual Smoke Notes\n\nThis file verifies artifact preview flow.\n",
          },
          null,
          2,
        ),
        "",
        "Result",
        `Successfully wrote 62 bytes to ${join(workspace, "notes.md")}`,
      ].join("\n"),
      createdAt: now,
      metadata: { toolName: "write", status: "done" },
    },
  });
  await emitE2eEvent(cdp, {
    type: "message-created",
    message: {
      id: "visual-assistant",
      threadId,
      role: "assistant",
      content: "Created `notes.md` and left the workspace ready for review.",
      createdAt: now,
      metadata: { status: "streaming" },
    },
  });
}

async function injectRemoteSurfaceActivationCardsState(cdp) {
  const state = await evaluate(cdp, "window.ambientDesktop.bootstrap()");
  const threadId = state.activeThreadId;
  const now = new Date().toISOString();
  const safety = {
    startsBridge: false,
    listsProviderChats: false,
    readsProviderMessages: false,
    readsProviderHistory: false,
    mutatesBindings: false,
    startsPolling: false,
    sendsProviderMessages: false,
  };
  const previewSendSafety = {
    commandPreviewTool: "ambient_messaging_remote_surface_command_preview",
    replyPreviewTool: "ambient_messaging_remote_surface_reply_preview",
    providerSendApplyTool: "ambient_messaging_remote_surface_reply_apply",
    previewRequiredBeforeProviderSend: true,
    providerSendRequiresSeparateApproval: true,
    providerSendReady: false,
  };
  const cards = [
    {
      id: "visual-remote-activation-route-ready",
      toolName: "ambient_messaging_remote_surface_activation_plan",
      contentStatus: "route_ready",
      card: {
        kind: "messaging-remote-surface-activation",
        intent: "remote_ambient_surface",
        providerId: "telegram-tdlib",
        providerLabel: "Telegram",
        status: "route_ready",
        title: "Remote Ambient Surface activation",
        summary: "Reviewed provider route selected.",
        detail: "Next Telegram phase: Select metadata-only owner conversation.",
        ambientSurface: "projects",
        currentPhase: {
          id: "product-provider-route",
          title: "Choose reviewed provider route",
          status: "complete",
          approvalRequired: false,
          nextTool: "ambient_messaging_telegram_owner_loop_activation_plan",
          blockerCount: 0,
        },
        phaseChips: [
          {
            id: "product-provider-route",
            title: "Choose reviewed provider route",
            status: "complete",
            approvalRequired: false,
            nextTool: "ambient_messaging_telegram_owner_loop_activation_plan",
            blockerCount: 0,
          },
          {
            id: "metadata-directory",
            title: "Select metadata-only owner conversation",
            status: "ready",
            approvalRequired: true,
            nextTool: "ambient_messaging_telegram_conversation_directory_preview",
            blockerCount: 0,
          },
        ],
        recommendedNextTool: "ambient_messaging_telegram_owner_loop_activation_plan",
        delegatedRecommendedNextTool: "ambient_messaging_telegram_conversation_directory_preview",
        activationPlanFirstTool: "ambient_messaging_telegram_owner_loop_activation_plan",
        repairPrompt: "Run the Telegram owner-loop activation plan next; do not skip into low-level setup tools.",
        repairPrompts: [
          "Run the Telegram owner-loop activation plan next; do not skip into low-level setup tools.",
          "Keep provider sends behind preview/apply approval.",
        ],
        blockedUntilActivationPlan: [
          "ambient_messaging_gateway_lifecycle_preview",
          "ambient_messaging_telegram_conversation_directory_preview",
          "ambient_messaging_telegram_owner_handoff_preview",
        ],
        previewSendSafety,
        safety,
      },
    },
    {
      id: "visual-remote-activation-blocked",
      toolName: "ambient_messaging_telegram_owner_loop_activation_plan",
      contentStatus: "blocked",
      card: {
        kind: "messaging-remote-surface-activation",
        intent: "remote_ambient_surface",
        providerId: "telegram-tdlib",
        providerLabel: "Telegram",
        status: "blocked",
        title: "Remote Ambient Surface activation",
        summary: "Activation route is blocked.",
        detail: "Check provider readiness: blocked.",
        ambientSurface: "projects",
        currentPhase: {
          id: "provider-readiness",
          title: "Check provider readiness",
          status: "blocked",
          approvalRequired: false,
          blockerCount: 2,
        },
        phaseChips: [
          {
            id: "product-provider-route",
            title: "Choose reviewed provider route",
            status: "complete",
            approvalRequired: false,
            blockerCount: 0,
          },
          {
            id: "provider-readiness",
            title: "Check provider readiness",
            status: "blocked",
            approvalRequired: false,
            blockerCount: 2,
          },
          {
            id: "metadata-directory",
            title: "Select metadata-only owner conversation",
            status: "waiting",
            approvalRequired: true,
            blockerCount: 1,
          },
        ],
        repairPrompt: "Provider readiness: Telegram bridge credentials are missing. Use Settings/secret setup before lifecycle apply.",
        repairPrompts: [
          "Provider readiness: Telegram bridge credentials are missing. Use Settings/secret setup before lifecycle apply.",
          "Do not inspect Telegram Desktop or shell out to provider CLIs.",
        ],
        blockedUntilActivationPlan: [
          "ambient_messaging_gateway_lifecycle_preview",
          "ambient_messaging_telegram_conversation_directory_preview",
        ],
        previewSendSafety,
        safety,
      },
    },
    {
      id: "visual-remote-activation-unsupported",
      toolName: "ambient_messaging_remote_surface_activation_plan",
      contentStatus: "unsupported_provider",
      card: {
        kind: "messaging-remote-surface-activation",
        intent: "remote_ambient_surface",
        requestedProvider: "Signal",
        status: "unsupported_provider",
        title: "Remote Ambient Surface activation",
        summary: "No reviewed activation route exists for this provider.",
        detail: "Choose reviewed provider route: blocked.",
        ambientSurface: "projects",
        currentPhase: {
          id: "product-provider-route",
          title: "Choose reviewed provider route",
          status: "blocked",
          approvalRequired: false,
          blockerCount: 3,
        },
        phaseChips: [
          {
            id: "product-provider-route",
            title: "Choose reviewed provider route",
            status: "blocked",
            approvalRequired: false,
            blockerCount: 3,
          },
        ],
        repairPrompt: "No reviewed Remote Ambient Surface activation shortcut exists for Signal.",
        repairPrompts: [
          "No reviewed Remote Ambient Surface activation shortcut exists for Signal.",
          "Ask the owner to use Telegram for the current product activation path, or treat this as future provider onboarding rather than falling back to external Messaging Connector tools.",
          "Do not call Signal low-level tools, provider UI, shell, browser, provider CLI, or generic Messaging Connector setup.",
        ],
        blockedUntilActivationPlan: [
          "ambient_messaging_gateway_lifecycle_preview",
          "ambient_messaging_signal_conversation_directory_preview",
        ],
        previewSendSafety,
        safety,
      },
    },
  ];
  await emitE2eEvent(cdp, {
    type: "message-created",
    message: {
      id: "visual-remote-activation-user",
      threadId,
      role: "user",
      content: "Set up Signal remote control and compare it with the reviewed Telegram route.",
      createdAt: now,
    },
  });
  for (const entry of cards) {
    await emitE2eEvent(cdp, {
      type: "message-created",
      message: {
        id: entry.id,
        threadId,
        role: "tool",
        content: [
          `${entry.toolName} completed`,
          "",
          "Result",
          `Status: ${entry.contentStatus}`,
          entry.card.summary,
        ].join("\n"),
        createdAt: now,
        metadata: {
          toolName: entry.toolName,
          status: "done",
          toolResultDetails: {
            messagingRemoteSurfaceActivation: entry.card,
          },
        },
      },
    });
  }
  await evaluate(
    cdp,
    `(() => {
      document.querySelectorAll(".tool-card").forEach((card) => {
        if (card.textContent?.includes("Remote Ambient Surface activation")) card.open = true;
      });
      document.querySelector(".tool-remote-activation.danger")?.scrollIntoView({ block: "center" });
    })()`,
  );
  await delay(300);
}

async function runSettingsUxRefreshVisualSmoke(cdp) {
  await setViewport(cdp, 1440, 900);
  await clickUtilityToolbarButton(cdp, "Settings");
  await waitFor(
    cdp,
    () =>
      Boolean(document.querySelector('.settings-search input[type="search"]')) &&
      document.querySelector(".settings-nav")?.textContent?.includes("Security & Access") === true,
    "settings refresh shell",
  );
  await waitFor(
    cdp,
    () => document.querySelector('.settings-nav button[aria-current="location"]')?.textContent?.includes("Overview") === true,
    "settings active overview nav",
  );

  await assertSettingsSearchResult(cdp, "provider", ["Voice Output", "Speech Input", "Provider"]);
  await assertSettingsSearchResult(cdp, "core setup", ["Overview", "Core setup", "Start setup"]);
  await assertSettingsSearchResult(cdp, "remote control", ["Overview", "Remote control", "Set up Telegram", "Check Signal", "Signal is not a reviewed Remote Ambient Surface activation route yet"]);
  await installSettingsRemoteSurfaceSendCapture(cdp);
  try {
    await emitE2eEvent(cdp, { type: "run-status", threadId: (await evaluate(cdp, "window.ambientDesktop.bootstrap()")).activeThreadId, status: "idle" });
    await waitFor(
      cdp,
      () => [...document.querySelectorAll("button")].some((item) => item.textContent?.trim() === "Set up Telegram" && !item.disabled),
      "settings remote surface Telegram action enabled",
    );
    await clickButton(cdp, "Set up Telegram");
    await waitFor(
      cdp,
      () => {
        const visibleText = document.body.innerText || "";
        return (
          window.__ambientVisualRemoteSurfacePrompts?.some((item) =>
            item.content?.includes("Launch source: Settings Remote control.") &&
            item.content.includes("set up Telegram remote control for Ambient Desktop projects") &&
            item.content.includes("ambient_messaging_remote_surface_activation_plan") &&
            item.content.includes("ambient_messaging_telegram_owner_loop_activation_plan"),
          ) ||
          (visibleText.includes("Launch source: Settings Remote control.") &&
            visibleText.includes("set up Telegram remote control for Ambient Desktop projects") &&
            visibleText.includes("ambient_messaging_remote_surface_activation_plan") &&
            visibleText.includes("ambient_messaging_telegram_owner_loop_activation_plan"))
        );
      },
      "settings remote surface Telegram entrypoint prompt",
    );
    await emitE2eEvent(cdp, { type: "run-status", threadId: (await evaluate(cdp, "window.ambientDesktop.bootstrap()")).activeThreadId, status: "idle" });
    await clickButton(cdp, "Check Signal");
    await waitFor(
      cdp,
      () => {
        const visibleText = document.body.innerText || "";
        return (
          window.__ambientVisualRemoteSurfacePrompts?.some((item) =>
            item.content?.includes("Launch source: Settings Remote control.") &&
            item.content.includes("set up Signal remote control for Ambient Desktop projects") &&
            item.content.includes("ambient_messaging_remote_surface_activation_plan"),
          ) ||
          (visibleText.includes("Launch source: Settings Remote control.") &&
            visibleText.includes("set up Signal remote control for Ambient Desktop projects") &&
            visibleText.includes("ambient_messaging_remote_surface_activation_plan"))
        );
      },
      "settings remote surface Signal entrypoint prompt",
    );
    await emitE2eEvent(cdp, { type: "run-status", threadId: (await evaluate(cdp, "window.ambientDesktop.bootstrap()")).activeThreadId, status: "idle" });
    await captureVisual(cdp, "06c-settings-remote-entrypoint");
  } finally {
    await restoreSettingsRemoteSurfaceSendCapture(cdp);
  }
  await assertSettingsSearchResult(
    cdp,
    "api key",
    usesGmiCloudProvider ? ["Security & Access", "GMI Cloud API key", "Set GMI Cloud API key"] : ["Security & Access", "API key", "Set Ambient API key"],
    ["Permission grants", "Permission log"],
  );
  await waitFor(
    cdp,
    () => document.querySelector('.settings-nav button[aria-current="location"]')?.textContent?.includes("Security & Access") === true,
    "settings active search nav",
  );
  await captureVisual(cdp, "06a-settings-search");

  await assertSettingsSearchResult(cdp, "permission", ["Security & Access", "Permission grants", "Permission log"]);
  await evaluate(cdp, `document.querySelector(".right-panel")?.style.setProperty("width", "420px")`);
  await waitFor(
    cdp,
    () => {
      const panel = document.querySelector(".right-panel");
      const shell = document.querySelector(".settings-shell");
      const nav = document.querySelector(".settings-nav");
      return (
        Boolean(panel && getComputedStyle(panel).display !== "none") &&
        Boolean(shell && getComputedStyle(shell).gridTemplateColumns.split(" ").length === 1) &&
        Boolean(nav && getComputedStyle(nav).display === "flex")
      );
    },
    "settings narrow layout",
  );
  await captureVisual(cdp, "06b-settings-narrow");

  await evaluate(cdp, `document.querySelector(".right-panel")?.style.setProperty("width", "520px")`);
  await waitFor(
    cdp,
    () => {
      const panel = document.querySelector(".right-panel");
      const shell = document.querySelector(".settings-shell");
      return Boolean(panel && getComputedStyle(panel).display !== "none" && shell && getComputedStyle(shell).gridTemplateColumns.split(" ").length > 1);
    },
    "settings wide layout restored",
  );
  await fillInput(cdp, '.settings-search input[type="search"]', "");
}

async function assertSettingsSearchResult(cdp, query, expectedTexts, absentTexts = []) {
  await fillInput(cdp, '.settings-search input[type="search"]', query);
  await waitFor(
    cdp,
    new Function(`
      const host = document.querySelector(".settings-panel-host");
      const text = host?.innerText || "";
      const resultCount = document.querySelector(".settings-search small")?.textContent || "";
      const expectedTexts = ${JSON.stringify(expectedTexts)};
      const absentTexts = ${JSON.stringify(absentTexts)};
      return expectedTexts.every((item) => text.includes(item)) &&
        absentTexts.every((item) => !text.includes(item)) &&
        /matching row/.test(resultCount) &&
        !text.includes("No settings found");
    `),
    `settings search ${query}`,
  );
}

async function installSettingsRemoteSurfaceSendCapture(cdp) {
  await evaluate(
    cdp,
    `(() => {
      window.__ambientVisualRemoteSurfacePrompts = [];
      if (!window.__ambientVisualOriginalSendMessage) {
        window.__ambientVisualOriginalSendMessage = window.ambientDesktop.sendMessage;
      }
      window.ambientDesktop.sendMessage = async (input) => {
        window.__ambientVisualRemoteSurfacePrompts.push(input);
      };
    })()`,
  );
}

async function restoreSettingsRemoteSurfaceSendCapture(cdp) {
  await evaluate(
    cdp,
    `(() => {
      if (window.__ambientVisualOriginalSendMessage) {
        window.ambientDesktop.sendMessage = window.__ambientVisualOriginalSendMessage;
        delete window.__ambientVisualOriginalSendMessage;
      }
    })()`,
  );
}

async function startBrowserFixtureServer() {
  if (browserFixtureServer) return `http://127.0.0.1:${browserFixturePort}/sample.html`;
  browserFixtureServer = createHttpServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", `http://127.0.0.1:${browserFixturePort}`).pathname;
    if (pathname !== "/sample.html") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    try {
      const html = await readFile(join(workspace, "sample.html"), "utf8");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise((resolve) => browserFixtureServer.listen(browserFixturePort, "127.0.0.1", resolve));
  return `http://127.0.0.1:${browserFixturePort}/sample.html`;
}

async function clickUtilityToolbarButton(cdp, label) {
  const clicked = await evaluate(
    cdp,
    `
    (() => {
      const label = ${JSON.stringify(label)};
      const button = [...document.querySelectorAll("button.icon-text")]
        .find((item) => item.textContent?.trim() === label);
      if (!button) return false;
      button.click();
      return true;
    })()
  `,
  );
  if (!clicked) throw new Error(`Utility toolbar button not found: ${label}`);
}

async function captureVisual(cdp, name) {
  const scenario = `${scenarioPrefix}${name}`;
  await assertNoHorizontalOverflow(cdp, scenario);
  const result = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  if (!result.data || result.data.length < 10_000) throw new Error(`${scenario} screenshot was unexpectedly small.`);
  await writeFile(join(resultsDir, `${scenario}.png`), Buffer.from(result.data, "base64"));
}

async function assertWorkflowWorkspaceCompactLayout(
  cdp,
  { workspaceSelector, railSelector, shellSelector, rowSelector, label },
) {
  const result = await evaluate(
    cdp,
    `
    (async () => {
      const workspace = document.querySelector(${JSON.stringify(workspaceSelector)});
      const rail = document.querySelector(${JSON.stringify(railSelector)});
      const shell = document.querySelector(${JSON.stringify(shellSelector)});
      const row = ${rowSelector ? `document.querySelector(${JSON.stringify(rowSelector)})` : "null"};
      if (!workspace || !rail || !shell) {
        return { ok: false, reason: "missing compact layout target", workspace: Boolean(workspace), rail: Boolean(rail), shell: Boolean(shell) };
      }
      const previous = {
        width: workspace.style.width,
        minWidth: workspace.style.minWidth,
        maxWidth: workspace.style.maxWidth,
      };
      workspace.style.width = "640px";
      workspace.style.minWidth = "0";
      workspace.style.maxWidth = "640px";
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const railStyle = getComputedStyle(rail);
      const shellStyle = getComputedStyle(shell);
      const rowStyle = row ? getComputedStyle(row) : null;
      const shellColumns = shellStyle.gridTemplateColumns.split(" ").filter(Boolean).length;
      const rowColumns = rowStyle ? rowStyle.gridTemplateColumns.split(" ").filter(Boolean).length : null;
      const result = {
        ok: railStyle.display === "flex" && shellColumns === 1 && (!rowStyle || rowColumns === 1),
        railDisplay: railStyle.display,
        shellColumns,
        rowColumns,
        width: Math.round(workspace.getBoundingClientRect().width),
      };
      workspace.style.width = previous.width;
      workspace.style.minWidth = previous.minWidth;
      workspace.style.maxWidth = previous.maxWidth;
      return result;
    })()
  `,
  );
  if (!result?.ok) {
    throw new Error(`Expected compact Workflow Agent layout for ${label}: ${JSON.stringify(result)}`);
  }
}

async function installVisualStabilizers(cdp) {
  await evaluate(
    cdp,
    `
    (() => {
      const style = document.createElement("style");
      style.textContent = [
        "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }",
        ".spin { animation: none !important; }",
        ".send-button.stop-button, .send-button.stop-button:disabled { opacity: 1 !important; background: #111827 !important; color: #ffffff !important; border-color: #111827 !important; }",
      ].join("\\n");
      document.head.appendChild(style);
      const normalize = () => {
        for (const item of document.querySelectorAll(".run-activity-metrics span")) {
          const text = item.textContent || "";
          if (/^Worked\\s+/.test(text) && text !== "Worked stable") item.textContent = "Worked stable";
        }
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const textNodes = [];
        while (walker.nextNode()) textNodes.push(walker.currentNode);
        for (const node of textNodes) {
          const text = node.nodeValue || "";
          const nextText = text
            .replace(/workflow-sample-[0-9a-f-]{36}/gi, "workflow-sample-visual")
            .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "00000000-0000-4000-a000-000000000000")
            .replace(/2026-[0-9]{2}-[0-9]{2}T[0-9:.]+Z/g, "2026-05-05T00:00:00.000Z")
            .replace(/May\\s+5,\\s+\\d{1,2}:\\d{2}\\s+PM/g, "May 5, 3:00 PM");
          if (nextText !== text) node.nodeValue = nextText;
        }
      };
      normalize();
      new MutationObserver(normalize).observe(document.body, { childList: true, subtree: true, characterData: true });
      window.__ambientVisualStabilized = true;
    })()
  `,
  );
}

async function writeVisualManifest() {
  const screenshots = [];
  for (const scenario of scenarioNames) {
    screenshots.push(await screenshotMetadata(join(resultsDir, `${scenario}.png`), scenario));
  }
  await writeFile(
    join(resultsDir, "manifest.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        workspace: basename(workspace),
        themePreference: visualThemePreference,
        compareBaselines,
        updateBaselines,
        screenshots,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function updateVisualBaselines() {
  await mkdir(baselineDir, { recursive: true });
  const screenshots = [];
  for (const scenario of scenarioNames) {
    const source = join(resultsDir, `${scenario}.png`);
    const destination = join(baselineDir, `${scenario}.png`);
    await copyFile(source, destination);
    screenshots.push(await screenshotMetadata(destination, scenario));
  }
  await writeFile(
    join(baselineDir, "manifest.json"),
    `${JSON.stringify({ version: 1, screenshots }, null, 2)}\n`,
    "utf8",
  );
}

async function compareVisualBaselines() {
  await mkdir(diffDir, { recursive: true });
  const reports = [];
  for (const scenario of scenarioNames) {
    reports.push(
      await comparePngScreenshots({
        scenario,
        actualPath: join(resultsDir, `${scenario}.png`),
        baselinePath: join(baselineDir, `${scenario}.png`),
        diffPath: join(diffDir, `${scenario}.diff.png`),
      }),
    );
  }
  const failed = reports.filter((report) => !report.ok);
  await writeFile(
    join(resultsDir, "regression-report.json"),
    `${JSON.stringify({ version: 1, failed: failed.length, reports }, null, 2)}\n`,
    "utf8",
  );
  if (failed.length > 0) {
    throw new Error(`Visual baseline comparison failed for ${failed.map((report) => report.scenario).join(", ")}.`);
  }
}

async function screenshotMetadata(filePath, scenario) {
  const [buffer, fileStat] = await Promise.all([readFile(filePath), stat(filePath)]);
  const { width, height } = pngSize(buffer);
  return {
    scenario,
    file: `${scenario}.png`,
    bytes: fileStat.size,
    width,
    height,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

async function comparePngScreenshots({ scenario, actualPath, baselinePath, diffPath }) {
  let actual;
  let baseline;
  try {
    actual = decodePng(await readFile(actualPath));
    baseline = decodePng(await readFile(baselinePath));
  } catch (error) {
    return {
      scenario,
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      changedPixels: Number.POSITIVE_INFINITY,
      changedRatio: 1,
      maxChannelDelta: 255,
    };
  }

  if (actual.width !== baseline.width || actual.height !== baseline.height) {
    return {
      scenario,
      ok: false,
      reason: `Dimension mismatch: actual ${actual.width}x${actual.height}, baseline ${baseline.width}x${baseline.height}.`,
      changedPixels: Number.POSITIVE_INFINITY,
      changedRatio: 1,
      maxChannelDelta: 255,
    };
  }

  const channelThreshold = Number(process.env.AMBIENT_VISUAL_CHANNEL_THRESHOLD ?? 24);
  const maxChangedPixels = maxChangedPixelsForScenario(scenario);
  const diff = new Uint8Array(actual.width * actual.height * 4);
  let changedPixels = 0;
  let maxChannelDelta = 0;

  for (let pixel = 0; pixel < actual.width * actual.height; pixel += 1) {
    const offset = pixel * 4;
    let pixelChanged = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(actual.data[offset + channel] - baseline.data[offset + channel]);
      if (delta > maxChannelDelta) maxChannelDelta = delta;
      if (delta > channelThreshold) pixelChanged = true;
    }
    if (pixelChanged) {
      changedPixels += 1;
      diff[offset] = 224;
      diff[offset + 1] = 49;
      diff[offset + 2] = 49;
      diff[offset + 3] = 255;
    } else {
      const gray = Math.round((actual.data[offset] + actual.data[offset + 1] + actual.data[offset + 2]) / 3);
      diff[offset] = gray;
      diff[offset + 1] = gray;
      diff[offset + 2] = gray;
      diff[offset + 3] = 255;
    }
  }

  const ok = changedPixels <= maxChangedPixels;
  if (!ok) await writeFile(diffPath, encodePngRgba(actual.width, actual.height, diff));
  return {
    scenario,
    ok,
    changedPixels,
    changedRatio: changedPixels / (actual.width * actual.height),
    maxChannelDelta,
    ...(ok ? {} : { diff: diffPath }),
  };
}

function maxChangedPixelsForScenario(scenario) {
  if (process.env.AMBIENT_VISUAL_MAX_CHANGED_PIXELS) return Number(process.env.AMBIENT_VISUAL_MAX_CHANGED_PIXELS);
  const tolerances = new Map([
    // These captures intentionally include active composer/browser chrome where disabled
    // state antialiasing can vary by a few hundred pixels between Electron runs.
    ["04c-git-review", 1_200],
    ["05-plugin-import-candidate", 1_200],
    ["06-compact-layout", 1_200],
    ["08-browser-picker-active", 1_200],
    // React Flow panes can shift fit-view transforms by a few pixels after layout,
    // while still preserving the graph content and overall pane composition.
    ["05a-workflow-discovery", 15_000],
    ["05c-workflow-compile-progress", 15_000],
    ["05d-workflow-compile-failure", 15_000],
    ["05b-workflow-agent-diagram", 8_000],
    ["05e-workflow-recovery-cards", 15_000],
    ["05f-workflow-revision-diff", 15_000],
    ["05k-workflow-plan-edit-chat", 15_000],
    ["05g-workflow-schedule-targeting", 15_000],
    ["05j-workflow-schedule-focus", 15_000],
    ["05i-workflow-schedule-grant-action", 15_000],
    ["05h-workflow-permission-grant-prompt", 15_000],
  ]);
  return tolerances.get(scenario) ?? 50;
}

function pngSize(buffer) {
  const decoded = decodePng(buffer, { metadataOnly: true });
  return { width: decoded.width, height: decoded.height };
}

function decodePng(buffer, options = {}) {
  const signature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== signature) throw new Error("Not a PNG file.");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (options.metadataOnly) return { width, height, data: new Uint8Array() };
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth}.`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (channels === 0) throw new Error(`Unsupported PNG color type ${colorType}.`);

  const inflated = inflateSync(Buffer.concat(idatChunks));
  const rowBytes = width * channels;
  const raw = new Uint8Array(height * rowBytes);
  let readOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[readOffset];
    readOffset += 1;
    const rowStart = y * rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const rawByte = inflated[readOffset + x];
      const left = x >= channels ? raw[rowStart + x - channels] : 0;
      const up = y > 0 ? raw[rowStart + x - rowBytes] : 0;
      const upLeft = y > 0 && x >= channels ? raw[rowStart + x - rowBytes - channels] : 0;
      raw[rowStart + x] = (rawByte + pngFilterDelta(filter, left, up, upLeft)) & 0xff;
    }
    readOffset += rowBytes;
  }

  if (channels === 4) return { width, height, data: raw };

  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    rgba[pixel * 4] = raw[pixel * 3];
    rgba[pixel * 4 + 1] = raw[pixel * 3 + 1];
    rgba[pixel * 4 + 2] = raw[pixel * 3 + 2];
    rgba[pixel * 4 + 3] = 255;
  }
  return { width, height, data: rgba };
}

function pngFilterDelta(filter, left, up, upLeft) {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return Math.floor((left + up) / 2);
  if (filter === 4) return paeth(left, up, upLeft);
  throw new Error(`Unsupported PNG filter ${filter}.`);
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  if (upDistance <= upLeftDistance) return up;
  return upLeft;
}

function encodePngRgba(width, height, rgba) {
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (rowBytes + 1);
    raw[rowStart] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * rowBytes, rowBytes).copy(raw, rowStart + 1);
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk(
      "IHDR",
      Buffer.from([
        (width >>> 24) & 0xff,
        (width >>> 16) & 0xff,
        (width >>> 8) & 0xff,
        width & 0xff,
        (height >>> 24) & 0xff,
        (height >>> 16) & 0xff,
        (height >>> 8) & 0xff,
        height & 0xff,
        8,
        6,
        0,
        0,
        0,
      ]),
    ),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function readAmbientApiKey() {
  const existing = process.env.AMBIENT_API_KEY || process.env.AMBIENT_AGENT_AMBIENT_API_KEY;
  if (existing?.trim()) return existing.trim();
  const candidates = [
    process.env.AMBIENT_API_KEY_FILE,
    join(process.cwd(), "ignored-provider-key-file.txt"),
    join(dirname(process.cwd()), "ignored-provider-key-file.txt"),
    join(dirname(dirname(process.cwd())), "ignored-provider-key-file.txt"),
    join(homedir(), "ignored-provider-key-file.txt"),
    "/Users/example/Documents/ambientCoder/ignored-provider-key-file.txt",
    "/Users/example/Documents/New project 3/ignored-provider-key-file.txt",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const value = (await readFile(candidate, "utf8")).trim();
      if (value) return value;
    } catch {
      // Try the next conventional location.
    }
  }
  return undefined;
}

async function createProjectBoardLinkedTask(cdp, title, description) {
  const board = await evaluate(
    cdp,
    `window.ambientDesktop.createOrchestrationTask(${JSON.stringify({
      title,
      description,
      state: "in_progress",
      priority: 1,
      labels: ["project-board", "visual", "active"],
    })})`,
  );
  const task = board.tasks.find((candidate) => candidate.title === title);
  if (!task) throw new Error(`Expected linked task to be created for ${title}.`);
  return task;
}

async function waitForPageEndpoint(cdpPort) {
  const targetTimeoutMs = Number(process.env.AMBIENT_VISUAL_CDP_TARGET_TIMEOUT_MS || 0) || 120_000;
  const deadline = Date.now() + targetTimeoutMs;
  let lastTargets = [];
  while (Date.now() < deadline) {
    try {
      const response = await fetchWithTimeout(`http://127.0.0.1:${cdpPort}/json/list`, 2_000);
      const targets = await response.json();
      if (Array.isArray(targets)) {
        lastTargets = targets;
        const pageTarget =
          targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl && !String(item.url ?? "").startsWith("devtools://")) ??
          targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
        if (pageTarget?.webSocketDebuggerUrl) return pageTarget;
      }
    } catch {
      // App not listening yet.
    }
    await delay(250);
  }
  throw new Error(
    `Timed out waiting for Electron page CDP endpoint after ${targetTimeoutMs.toLocaleString()}ms. Last targets: ${JSON.stringify(
      summarizeCdpTargets(lastTargets),
    )}`,
  );
}

async function waitForTarget(cdpPort) {
  const targetTimeoutMs = Number(process.env.AMBIENT_VISUAL_CDP_TARGET_TIMEOUT_MS || 0) || 120_000;
  const deadline = Date.now() + targetTimeoutMs;
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
  throw new Error(`Timed out waiting for Electron browser CDP endpoint after ${targetTimeoutMs.toLocaleString()}ms.`);
}

async function waitForPageTarget(cdp) {
  const targetTimeoutMs = Number(process.env.AMBIENT_VISUAL_CDP_TARGET_TIMEOUT_MS || 0) || 120_000;
  const deadline = Date.now() + targetTimeoutMs;
  let lastTargets = [];
  while (Date.now() < deadline) {
    const targets = await cdp.send("Target.getTargets").catch(() => ({ targetInfos: [] }));
    lastTargets = targets.targetInfos ?? [];
    const pageTarget =
      targets.targetInfos?.find((item) => item.type === "page" && !item.url.startsWith("devtools://")) ??
      targets.targetInfos?.find((item) => item.type === "page");
    if (pageTarget?.targetId) return pageTarget;
    await delay(250);
  }
  throw new Error(
    `Timed out waiting for Electron page CDP target after ${targetTimeoutMs.toLocaleString()}ms. Last targets: ${JSON.stringify(
      summarizeCdpTargets(lastTargets),
    )}`,
  );
}

function summarizeCdpTargets(targets) {
  return (targets ?? []).slice(0, 12).map((item) => ({
    id: item.id ?? item.targetId,
    type: item.type,
    title: item.title,
    url: item.url,
  }));
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
  const targetTimeoutMs = Number(process.env.AMBIENT_VISUAL_CDP_TARGET_TIMEOUT_MS || 0) || 120_000;
  const deadline = Date.now() + targetTimeoutMs;
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
  throw new Error(
    `Timed out connecting to ${label} after ${targetTimeoutMs.toLocaleString()}ms${
      lastError ? `: ${lastError.message}` : ""
    }.`,
  );
}

async function connectPageCdpWithRetry(url, label) {
  const targetTimeoutMs = Number(process.env.AMBIENT_VISUAL_CDP_TARGET_TIMEOUT_MS || 0) || 120_000;
  const deadline = Date.now() + targetTimeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    let cdp;
    try {
      cdp = await connectCdp(url);
      await cdp.send("Runtime.enable");
      await cdp.send("Page.enable");
      return cdp;
    } catch (error) {
      lastError = error;
      cdp?.close();
      await delay(500);
    }
  }
  throw new Error(
    `Timed out connecting to ${label} after ${targetTimeoutMs.toLocaleString()}ms${
      lastError ? `: ${lastError.message}` : ""
    }.`,
  );
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

async function evaluate(cdp, expression) {
  let result;
  try {
    result = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
  } catch (error) {
    if (!String(error?.message || error).includes("Object reference chain is too long")) throw error;
    const jsonResult = await cdp.send("Runtime.evaluate", {
      expression: `(async () => JSON.stringify(await (${expression})))()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (jsonResult.exceptionDetails) throw new Error(jsonResult.exceptionDetails.text ?? "Runtime.evaluate JSON fallback failed.");
    const jsonValue = jsonResult.result?.value;
    return typeof jsonValue === "string" ? JSON.parse(jsonValue) : undefined;
  }
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Runtime.evaluate failed.");
  return result.result?.value;
}

async function waitFor(cdp, predicate, label, timeoutMs = 10_000) {
  const expression = `(${predicate.toString()})()`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression)) return;
    await delay(150);
  }
  const bodyText = await evaluate(cdp, "document.body.innerText.slice(0, 4000)");
  console.error(`Timed out waiting for ${label}. Body text snapshot:\\n${bodyText}`);
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

async function clickButton(cdp, label) {
  const clicked = await evaluate(
    cdp,
    `
    (() => {
      const needle = ${JSON.stringify(label)};
      const button = [...document.querySelectorAll("button")]
        .find((item) => item.textContent?.includes(needle) || item.title?.includes(needle) || item.getAttribute("aria-label")?.includes(needle));
      if (!button) return false;
      button.click();
      return true;
    })()
  `,
  );
  if (!clicked) throw new Error(`Button not found: ${label}`);
}

async function clickProjectionReviewResolution(cdp, rowText, label) {
  const clicked = await evaluate(
    cdp,
    `
    (() => {
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
    })()
  `,
  );
  if (!clicked) throw new Error(`Projection review resolution not found: ${rowText} / ${label}`);
}

async function clickProjectBoardDialogButton(cdp, label) {
  const clicked = await evaluate(
    cdp,
    `
    (() => {
      const needle = ${JSON.stringify(label)};
      const dialog = document.querySelector(".project-action-dialog");
      const button = dialog
        ? [...dialog.querySelectorAll("button")].find((item) => item.textContent?.includes(needle) || item.title?.includes(needle) || item.getAttribute("aria-label")?.includes(needle))
        : undefined;
      if (!button) return false;
      button.click();
      return true;
    })()
  `,
  );
  if (!clicked) throw new Error(`Project board dialog button not found: ${label}`);
}

async function clickProjectBoardKickoffButton(cdp, label) {
  const clicked = await evaluate(
    cdp,
    `
    (() => {
      const needle = ${JSON.stringify(label)};
      const kickoff = document.querySelector(".project-board-kickoff");
      const button = kickoff
        ? [...kickoff.querySelectorAll("button")].find((item) => item.textContent?.includes(needle) || item.title?.includes(needle) || item.getAttribute("aria-label")?.includes(needle))
        : undefined;
      if (!button) return false;
      button.click();
      return true;
    })()
  `,
  );
  if (!clicked) throw new Error(`Project board kickoff button not found: ${label}`);
}

async function clickScheduledRunScheduleAction(cdp) {
  const clicked = await evaluate(
    cdp,
    `
    (() => {
      const card = [...document.querySelectorAll(".run-card, .workflow-thread-run-row")]
        .find((item) => item.textContent?.includes("Scheduled") && item.textContent?.includes("Schedule"));
      const button = card
        ? [...card.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Schedule")
        : undefined;
      if (!button) return false;
      button.click();
      return true;
    })()
  `,
  );
  if (!clicked) throw new Error("Scheduled run Schedule action not found.");
}

async function clickWorkflowReviewScheduleAction(cdp) {
  const clicked = await evaluate(
    cdp,
    `
    (() => {
      const workspace = document.querySelector(".workflow-review-workspace");
      const button = workspace
        ? [...workspace.querySelectorAll("button")]
            .find((item) => item.textContent?.trim() === "Schedule" && !item.disabled)
        : undefined;
      if (!button) return false;
      button.click();
      return true;
    })()
  `,
  );
  if (!clicked) throw new Error("Workflow review Schedule action not found.");
}

async function clickProjectBoardTab(cdp, label) {
  const clicked = await evaluate(
    cdp,
    `
    (() => {
      const needle = ${JSON.stringify(label)};
      const button = [...document.querySelectorAll(".project-board-tabs button")]
        .find((item) => item.textContent?.trim().startsWith(needle));
      if (!button) return false;
      button.click();
      return true;
    })()
  `,
  );
  if (!clicked) throw new Error(`Project board tab not found: ${label}`);
}

async function assertProjectBoardButtonsHaveTooltips(cdp, label) {
  const missing = await evaluate(
    cdp,
    `
    (() => {
      return [...document.querySelectorAll(".project-board-workspace button")]
        .filter((button) => {
          if (button.closest("[aria-hidden='true']")) return false;
          return !(button.getAttribute("title")?.trim() || button.getAttribute("aria-label")?.trim());
        })
        .map((button) => (button.textContent || button.className || button.outerHTML).trim().replace(/\\s+/g, " ").slice(0, 80));
    })()
  `,
  );
  if (missing.length > 0) throw new Error(`${label} missing tooltip titles: ${missing.join(", ")}`);
}

async function assertProjectBoardProofScopeWarningsStable(cdp, label) {
  const result = await evaluate(
    cdp,
    `
    (() => {
      const rows = [...document.querySelectorAll(".project-board-proof-scope-summary")].map((node) => {
        node.scrollIntoView({ block: "nearest", inline: "nearest" });
        const rect = node.getBoundingClientRect();
        const parent = node.closest(".project-board-card, .project-board-candidate-detail, .project-board-proof-scope-warning-list, .project-board-proposal-panel");
        const parentRect = parent?.getBoundingClientRect();
        const pointX = Math.min(rect.right - 2, rect.left + 12);
        const pointY = Math.min(rect.bottom - 2, rect.top + 12);
        const topElement = document.elementFromPoint(pointX, pointY);
        return {
          text: node.textContent || "",
          width: rect.width,
          height: rect.height,
          visible: rect.width > 60 && rect.height > 20,
          insideParent: parentRect
            ? rect.left >= parentRect.left - 2 &&
              rect.right <= parentRect.right + 2 &&
              rect.top >= parentRect.top - 2 &&
              rect.bottom <= parentRect.bottom + 2
            : true,
          ownsPoint: Boolean(topElement && (node === topElement || node.contains(topElement))),
        };
      });
      const fallbackText = document.querySelector(".project-board-proof-scope-warning-list, .project-board-proposal-panel, .project-board-draft-board, .project-board-candidate-detail")?.textContent || "";
      return { count: rows.length, rows, fallbackText };
    })()
  `,
  );
  if (result.count < 1 && !/proof-scope warning|Proof ownership warning/i.test(result.fallbackText || "")) {
    throw new Error(`${label} did not render proof-scope warnings.`);
  }
  const invalid = result.rows.filter((row) => !row.text.includes("Proof ownership warning") || !row.visible || !row.insideParent || !row.ownsPoint);
  if (invalid.length > 0) {
    throw new Error(`${label} rendered unstable proof-scope warnings: ${JSON.stringify(invalid)}`);
  }
}

async function clickWorkflowAgentThread(cdp, title) {
  const titleLiteral = JSON.stringify(title);
  await waitFor(
    cdp,
    new Function(`
      const title = ${titleLiteral};
      return [...document.querySelectorAll(".thread-row")]
        .some((item) => item.textContent?.includes(title));
    `),
    `workflow thread ${title}`,
  );
  const clicked = await evaluate(
    cdp,
    `
    (() => {
      const title = ${JSON.stringify(title)};
      const thread = [...document.querySelectorAll(".thread-row")]
        .find((item) => item.textContent?.includes(title));
      if (!thread) return false;
      thread.click();
      return true;
    })()
  `,
  );
  if (!clicked) throw new Error(`Workflow thread not found: ${title}`);
}

async function clickEnabledButtonInRow(cdp, selector, rowText, label) {
  const clicked = await evaluate(
    cdp,
    `
    (() => {
      const rowNeedle = ${JSON.stringify(rowText)};
      const buttonNeedle = ${JSON.stringify(label)};
      const row = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((item) => item.textContent?.includes(rowNeedle));
      const button = row
        ? [...row.querySelectorAll("button")].find((item) => !item.disabled && (item.textContent?.includes(buttonNeedle) || item.title?.includes(buttonNeedle) || item.getAttribute("aria-label")?.includes(buttonNeedle)))
        : undefined;
      if (!button) return false;
      button.click();
      return true;
    })()
  `,
  );
  if (!clicked) throw new Error(`Enabled button not found in ${rowText}: ${label}`);
}

async function clickProjectBoardCard(cdp, title) {
  const clicked = await evaluate(
    cdp,
    `
    (() => {
      const title = ${JSON.stringify(title)};
      const card = [...document.querySelectorAll('.project-board-card[role="button"]')]
        .find((item) => item.querySelector("h3")?.textContent?.trim() === title);
      if (!card) return false;
      card.click();
      return true;
    })()
  `,
  );
  if (!clicked) throw new Error(`Project board card not found: ${title}`);
}

async function clickProjectBoardActiveCardDetailTab(cdp, label) {
  const clicked = await evaluate(
    cdp,
    `
    (() => {
      const label = ${JSON.stringify(label)};
      const tab = [...document.querySelectorAll(".project-board-active-card-tabs button")]
        .find((item) => item.textContent?.trim() === label);
      if (!tab) return false;
      tab.click();
      return true;
    })()
  `,
  );
  if (!clicked) throw new Error(`Project board active card detail tab not found: ${label}`);
}

async function answerProjectBoardKickoff(cdp) {
  const answers = [
    "Build a stable board flow for converting project plans into executable work.",
    "Treat project notes as authoritative and use threads to fill gaps.",
    "Ask for clarification when scope changes; otherwise make conservative implementation choices.",
    "Require unit, integration, and visual proof for user-facing board behavior.",
    "Sequence cards by dependency order and keep retrying until proof is satisfied or a blocker is explicit.",
  ];
  for (const [index, answer] of answers.entries()) {
    await fillInput(cdp, ".project-board-question textarea", answer);
    await clickButton(cdp, index === answers.length - 1 ? "Finish Questions" : "Next");
    if (index === answers.length - 1) {
      await waitFor(
        cdp,
        selectorTextIncludesPredicate(".project-board-kickoff", "The charter answers are captured"),
        `visual project board answer ${index + 1}`,
      );
    } else {
      const progressLabel = `${index + 2} of ${answers.length}`;
      await waitFor(
        cdp,
        selectorTextIncludesPredicate(".project-board-kickoff", progressLabel),
        `visual project board answer ${index + 1}`,
      );
    }
  }
}

async function fillInput(cdp, selector, value) {
  const filled = await evaluate(
    cdp,
    `
    (() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      if (!input) return false;
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
      setter?.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()
  `,
  );
  if (!filled) throw new Error(`Input not found: ${selector}`);
}

async function assertNoHorizontalOverflow(cdp, label) {
  const result = await evaluate(
    cdp,
    `
    (() => ({
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
    }))()
  `,
  );
  const maxScrollWidth = Math.max(result.scrollWidth, result.bodyScrollWidth);
  if (maxScrollWidth > result.innerWidth + 1) {
    throw new Error(`${label} has horizontal overflow: ${maxScrollWidth}px > ${result.innerWidth}px.`);
  }
}

function selectorTextIncludesPredicate(selector, text) {
  return new Function(`return document.querySelector(${JSON.stringify(selector)})?.textContent?.includes(${JSON.stringify(text)}) === true;`);
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed with ${exitCode}: ${stderr}`));
    });
  });
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
  await Promise.race([exited, delay(1_500)]);
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    if (process.platform === "win32") proc.kill("SIGKILL");
    else process.kill(-proc.pid, "SIGKILL");
  } catch {
    proc.kill("SIGKILL");
  }
  await Promise.race([exited, delay(500)]);
}

async function terminateDebugPortProcesses() {
  if (process.platform === "win32") return;
  const cwdPattern = process.cwd().replace(/[.[\]{}()*+?^$|\\]/g, "\\$&");
  const userDataPattern = userData.replace(/[.[\]{}()*+?^$|\\]/g, "\\$&");
  await runIgnoringFailure("pkill", ["-f", `remoteDebuggingPort ${port}`]);
  await runIgnoringFailure("pkill", ["-f", `remote-debugging-port=${port}`]);
  await runIgnoringFailure("pkill", ["-f", `${cwdPattern}.*remote-debugging-port=${port}`]);
  await runIgnoringFailure("pkill", ["-f", `${cwdPattern}.*remoteDebuggingPort ${port}`]);
  await runIgnoringFailure("pkill", ["-f", `${userDataPattern}`]);
}

function runIgnoringFailure(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", resolve);
    child.on("close", resolve);
  });
}

function outputTail() {
  return `Electron output tail:\n${output.join("").split(/\r?\n/).slice(-80).join("\n")}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function availablePort(preferredPort) {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => {
      resolve(availablePort(0));
    });
    server.listen(preferredPort, "127.0.0.1", () => {
      const address = server.address();
      const selectedPort = typeof address === "object" && address ? address.port : preferredPort;
      server.close(() => resolve(selectedPort));
    });
  });
}
