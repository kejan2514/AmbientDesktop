#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  seedChromeProfile,
  seedCodexPluginCache,
  seedLegacyGitProject,
  seedPrivilegedPiFixture,
  seedProjectRegistry,
  seedRegisteredProject,
  seedRemoteCodexMarketplace,
  seedWorkspace,
} from "./e2e-electron-smoke-fixtures.mjs";
import { runOrchestrationSmoke } from "./e2e-electron-smoke-orchestration.mjs";
import { runProjectBoardSmoke } from "./e2e-electron-smoke-project-board.mjs";
import * as cdpHelpers from "./e2e-electron-smoke-cdp-helpers.mjs";
import * as domActions from "./e2e-electron-smoke-dom-actions.mjs";

const fixedCdpPort = process.env.AMBIENT_E2E_CDP_PORT ? Number(process.env.AMBIENT_E2E_CDP_PORT) : undefined;
let port = fixedCdpPort ?? 9475;
const workspace = await mkdtemp(join(tmpdir(), "ambient-e2e-workspace-"));
const registeredWorkspace = await mkdtemp(join(tmpdir(), "ambient-e2e-registered-"));
const legacyGitWorkspace = await mkdtemp(join(tmpdir(), "ambient-e2e-legacy-git-"));
const codexPluginCache = await mkdtemp(join(tmpdir(), "ambient-e2e-codex-cache-"));
const privilegedPiFixture = await mkdtemp(join(tmpdir(), "ambient-e2e-privileged-pi-"));
const userData = await mkdtemp(join(tmpdir(), "ambient-e2e-user-data-"));
const chromeProfile = await mkdtemp(join(tmpdir(), "ambient-e2e-chrome-profile-"));
const diagnosticsPath = join(workspace, "diagnostics.json");
const openTargetLogPath = join(workspace, "open-targets.jsonl");
const piPackageGalleryPath = join(workspace, "pi-package-gallery.html");
const remoteCodexMarketplacePath = join(workspace, "remote-codex-marketplace.json");
const output = [];
const e2eOnly = process.env.AMBIENT_E2E_ONLY;
const children = new Set();
const syntheticToolNames = ["read", "bash", "edit", "write", "grep", "find", "ls", "browser_pick", "ambient_fixture_workspace_summary"];
const syntheticToolStatuses = ["running", "done", "error"];
const browserScreenshotFixturePath = ".ambient-codex/browser/screenshots/browser-e2e.png";
const ambientApiKey = await readAmbientApiKey();
const { connectCdp, delay, evaluate, findOpenPort, waitFor, waitForProcessExit, waitForTarget } = cdpHelpers;
const {
  assertFilePaneResize,
  assertNoHorizontalOverflow,
  assertRightPanelResize,
  assertSidebarResize,
  captureScreenshot,
  clickButton,
  clickButtonByTitle,
  clickEnabledButton,
  clickEnabledButtonIn,
  clickEnabledButtonInRow,
  clickFileRow,
  clickGitConfirmButton,
  clickPluginCandidateAction,
  clickSelector,
  clickWorkflowAgentSidebarThread,
  clickWorkflowAgentView,
  dragKanbanCardToColumn,
  expectText,
  fillInput,
  pasteComposerText,
  pressComposerKey,
  pressTerminalKey,
  selectAutomationField,
  selectBranch,
  setViewport,
  typeTerminal,
  clickNthButton,
} = domActions;
const waitForMiniWindowTarget = (title) => cdpHelpers.waitForMiniWindowTarget(port, title);
const waitForCdpPortClosed = () => cdpHelpers.waitForCdpPortClosed(port);

let appInstance;

try {
  await seedWorkspace(workspace, { piPackageGalleryPath, browserScreenshotFixturePath });
  await seedRegisteredProject(registeredWorkspace);
  await seedLegacyGitProject(legacyGitWorkspace);
  await seedCodexPluginCache(codexPluginCache);
  await seedPrivilegedPiFixture(privilegedPiFixture);
  await seedChromeProfile(chromeProfile);
  await seedRemoteCodexMarketplace(remoteCodexMarketplacePath);
  await seedProjectRegistry(userData, [registeredWorkspace, legacyGitWorkspace, workspace]);

  appInstance = await launchApp();
  try {
    if (e2eOnly === "voice-settings") {
      await runVoiceOnlySmoke(appInstance.cdp);
    } else if (e2eOnly === "voice-tool-cards") {
      await runVoiceToolCardOnlySmoke(appInstance.cdp);
    } else if (e2eOnly === "media-artifacts") {
      await runMediaArtifactOnlySmoke(appInstance.cdp);
    } else if (e2eOnly === "office-preview") {
      await runOfficePreviewOnlySmoke(appInstance.cdp);
    } else {
      await runMainSmoke(appInstance.cdp);
    }
  } finally {
    await shutdownAppInstance(appInstance);
    appInstance = undefined;
  }

  if (e2eOnly === "voice-settings") {
    console.log("Electron E2E voice settings smoke passed.");
  } else if (e2eOnly === "voice-tool-cards") {
    console.log("Electron E2E voice tool card smoke passed.");
  } else if (e2eOnly === "media-artifacts") {
    console.log("Electron E2E media artifact smoke passed.");
  } else if (e2eOnly === "office-preview") {
    console.log("Electron E2E office preview smoke passed.");
  } else {
    await assertDiagnosticsExport();
    await assertOpenTargetLaunch();

    appInstance = await launchApp();
    try {
      await runRestartSmoke(appInstance.cdp);
    } finally {
      await shutdownAppInstance(appInstance);
      appInstance = undefined;
    }
  }
} catch (error) {
  console.error(outputTail());
  throw error;
} finally {
  if (appInstance) await shutdownAppInstance(appInstance);
  for (const child of children) await terminateProcessTree(child);
  await terminateDebugPortProcesses();
  await rm(workspace, { recursive: true, force: true });
  await rm(registeredWorkspace, { recursive: true, force: true });
  await rm(legacyGitWorkspace, { recursive: true, force: true });
  await rm(codexPluginCache, { recursive: true, force: true });
  await rm(privilegedPiFixture, { recursive: true, force: true });
  await rm(userData, { recursive: true, force: true });
  await rm(chromeProfile, { recursive: true, force: true });
}

if (!e2eOnly) console.log("Electron E2E smoke passed.");

async function readAmbientApiKey() {
  const existing = process.env.AMBIENT_API_KEY || process.env.AMBIENT_AGENT_AMBIENT_API_KEY;
  if (existing?.trim()) return existing.trim();
  const candidates = [
    process.env.AMBIENT_API_KEY_FILE,
    join(process.cwd(), "ignored-provider-key-file.txt"),
    join(dirname(process.cwd()), "ignored-provider-key-file.txt"),
    join(dirname(dirname(process.cwd())), "ignored-provider-key-file.txt"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const value = (await readFile(candidate, "utf8")).trim();
      if (value) return value;
    } catch {
      // Try the next conventional key location.
    }
  }
  return undefined;
}

async function launchApp() {
  if (!fixedCdpPort) port = await findOpenPort(9475);
  const child = spawn(
    "pnpm",
    ["exec", "electron-vite", "dev", "--", `--remote-debugging-port=${port}`],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AMBIENT_DESKTOP_WORKSPACE: workspace,
        AMBIENT_E2E: "1",
        AMBIENT_E2E_USER_DATA: userData,
        ...(process.env.AMBIENT_E2E_ONLY === "voice-settings" || process.env.AMBIENT_E2E_CAPTURE_MESSAGES === "1"
          ? { AMBIENT_E2E_CAPTURE_MESSAGES: "1" }
          : {}),
        AMBIENT_E2E_DIAGNOSTICS_PATH: diagnosticsPath,
        AMBIENT_E2E_OPEN_TARGET_LOG: openTargetLogPath,
        AMBIENT_E2E_OPEN_TARGETS: "1",
        AMBIENT_CODEX_PLUGIN_CACHE: codexPluginCache,
        AMBIENT_CODEX_CURATED_MARKETPLACE_URL: "0",
        AMBIENT_CODEX_REMOTE_MARKETPLACE_PATH: remoteCodexMarketplacePath,
        AMBIENT_PI_PACKAGE_GALLERY_PATH: piPackageGalleryPath,
        AMBIENT_PI_USER_SETTINGS_PATH: join(userData, "missing-pi-settings.json"),
        AMBIENT_BROWSER_CHROME_PROFILE: chromeProfile,
        ...(ambientApiKey ? { AMBIENT_API_KEY: ambientApiKey, AMBIENT_AGENT_AMBIENT_API_KEY: ambientApiKey } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  children.add(child);
  child.once("exit", () => children.delete(child));

  child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));

  const target = await waitForTarget(port);
  await delay(750);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await waitFor(cdp, () => document.body?.innerText.includes("Ambient"), "main shell");
  return { child, cdp };
}

async function runMainSmoke(cdp) {
  await expectText(cdp, "Ambient");
  await assertDesktopLayout(cdp);
  await assertSidebarResize(cdp);
  await assertCollapsedSidebarTopbarInset(cdp);
  await openApiKeyDialogSmoke(cdp);
  await runThreadListSmoke(cdp);
  await runProjectBoardSmoke(cdp);
  await evaluate(cdp, `window.ambientDesktop.setOrchestrationAutoDispatchEnabled({ enabled: false }).then(() => true)`);

  await clickButton(cdp, "Settings");
  await waitFor(cdp, () => document.body.innerText.includes("Diagnostics"), "settings panel");
  await runVoiceSettingsSmoke(cdp);
  await clickButton(cdp, "Settings");
  await waitFor(cdp, () => Boolean(document.querySelector(".diagnostic-export")), "settings diagnostics panel");
  await clickDiagnosticsExport(cdp);
  await waitFor(cdp, () => document.body.innerText.includes("Saved diagnostics.json"), "diagnostics export status");

  await clickButton(cdp, "Add context");
  await waitFor(cdp, () => document.body.innerText.includes("Choose files"), "context panel");
  await expectText(cdp, "Choose folders");

  await clickButtonByTitle(cdp, "File tree");
  await waitFor(cdp, () => [...document.querySelectorAll("button")].some((button) => button.textContent?.includes("notes.md")), "file tree");
  await clickFileRow(cdp, "notes.md");
  await waitFor(cdp, () => document.body.innerText.includes("E2E Notes"), "markdown preview");
  await clickNthButton(cdp, "Add context", 1);
  await waitFor(cdp, () => document.body.innerText.includes("notes.md") && document.body.innerText.includes("Clear"), "context chip");

  await clickFileRow(cdp, "pixel.png");
  await waitFor(cdp, () => {
    const image = document.querySelector('img[alt="pixel.png"]');
    return Boolean(image && image.naturalWidth > 0);
  }, "image preview");

  await clickFileRow(cdp, "sound.wav");
  await waitFor(cdp, () => Boolean(document.querySelector('.file-media-preview audio[src^="ambient-media://"]')), "audio preview");

  await clickFileRow(cdp, "clip.webm");
  await waitFor(cdp, () => Boolean(document.querySelector('.file-media-preview video[src^="ambient-media://"]')), "video preview");

  await clickFileRow(cdp, "sample.pdf");
  await waitFor(cdp, () => Boolean(document.querySelector('iframe.file-pdf-preview[title="sample.pdf"]')), "PDF preview");

  await clickFileRow(cdp, "sample.docx");
  await assertOfficePreviewSmoke(cdp, "Office preview");

  await clickFileRow(cdp, "app.ts");
  await waitFor(cdp, () => document.body.innerText.includes("export const e2e = true"), "code preview");
  await waitFor(cdp, () => [...document.querySelectorAll("button")].some((button) => button.textContent?.includes("VS Code")), "VS Code open target");
  await assertFilePaneResize(cdp);
  await clickButton(cdp, "VS Code");
  await delay(350);

  await clickButtonByTitle(cdp, "Terminal");
  await waitFor(cdp, () => document.body.innerText.includes("Ambient terminal"), "terminal panel");
  await waitFor(
    cdp,
    () => {
      const label = document.querySelector(".terminal-banner code")?.textContent?.trim();
      return label === "none" || label === "macos-sandbox-exec" || label === "policy-only";
    },
    "terminal sandbox label",
  );
  await typeTerminal(cdp, "printf 'E2E_TERMINAL_DIRECT\\n'");
  await pressTerminalKey(cdp, "Enter");
  await waitFor(cdp, () => document.querySelector(".terminal-output")?.textContent?.includes("E2E_TERMINAL_DIRECT"), "direct terminal typing");

  await runSearchSmoke(cdp);
  await runUpdateNoticeSmoke(cdp);
  await runBrowserSmoke(cdp);
  await runDiffSmoke(cdp);
  await runNoRepoGitSmoke(cdp);
  await runSharedWorkspaceMigrationSmoke(cdp);
  await runPluginSmoke(cdp);
  await runOrchestrationSmoke(cdp, {
    clickButton,
    waitFor,
    clickWorkflowAgentView,
    evaluate,
    fillInput,
    clickButtonByTitle,
    clickEnabledButton,
    clickWorkflowAgentSidebarThread,
    clickEnabledButtonIn,
    clickEnabledButtonInRow,
    selectAutomationField,
    dragKanbanCardToColumn,
  });
  await runProjectControlsSmoke(cdp);
  await runResponsiveSmoke(cdp);
  await runPromptHistorySmoke(cdp);
  await runSyntheticStreamSmoke(cdp);
}

async function runUpdateNoticeSmoke(cdp) {
  const state = await desktopState(cdp);
  await emitE2eEvent(cdp, {
    type: "state",
    state: {
      ...state,
      app: {
        ...state.app,
        update: {
          enabled: true,
          status: "available",
          currentVersion: state.app.version,
          channel: "stable",
          feedUrl: "https://updates.ambient.xyz/desktop/stable",
          availableVersion: "99.0.0-e2e",
          releaseName: "Synthetic E2E update",
          releaseNotes: "Synthetic update used to verify the notification surface.",
          canCheck: true,
          canDownload: true,
          canInstall: false,
        },
      },
    },
  });
  await waitFor(cdp, () => document.querySelector(".desktop-update-pill")?.textContent?.includes("Update"), "update notice pill");
  await openUpdateNoticePopover(cdp);
  await waitFor(cdp, () => document.querySelector(".desktop-update-popover")?.textContent?.includes("99.0.0-e2e"), "update popover");
  await waitFor(cdp, () => document.querySelector(".desktop-update-popover")?.textContent?.includes("Download"), "update download action");
  await clickSelector(cdp, '.desktop-update-popover button[title="Dismiss update notice"]');
  await waitFor(cdp, () => !document.querySelector(".desktop-update-pill"), "update notice dismissed");
}

async function runVoiceOnlySmoke(cdp) {
  await expectText(cdp, "Ambient");
  await runVoiceArtifactManagementSmoke(cdp);
  await clickButton(cdp, "Settings");
  await waitFor(cdp, () => document.body.innerText.includes("Diagnostics"), "settings panel");
  await runVoiceSettingsSmoke(cdp);
  await clickButton(cdp, "Settings");
  await waitFor(cdp, () => document.body.innerText.includes("Diagnostics"), "settings panel reopened for voice onboarding prompt");
  await runVoiceOnboardingPromptSmoke(cdp);
}

async function runMediaArtifactOnlySmoke(cdp) {
  await expectText(cdp, "Ambient");
  const state = await desktopState(cdp);
  if (!state.activeThreadId) throw new Error("Expected an active thread for media artifact smoke.");
  await runMediaArtifactSmoke(cdp, state.activeThreadId);
}

async function runOfficePreviewOnlySmoke(cdp) {
  await expectText(cdp, "Ambient");
  await clickButtonByTitle(cdp, "File tree");
  await waitFor(cdp, () => [...document.querySelectorAll("button")].some((button) => button.textContent?.includes("sample.docx")), "office sample in file tree");
  await clickFileRow(cdp, "sample.docx");
  await assertOfficePreviewSmoke(cdp, "Office preview smoke");
}

async function assertOfficePreviewSmoke(cdp, label) {
  await waitFor(
    cdp,
    () =>
      (document.body.innerText.includes("Extracted text") && document.body.innerText.includes("Extracted document text is visible.")) ||
      Boolean(document.querySelector('iframe.file-pdf-preview[title="sample.docx preview"]')),
    label,
  );
  await waitFor(
    cdp,
    () => {
      const text = document.body.innerText;
      if (document.querySelector('iframe.file-pdf-preview[title="sample.docx preview"]')) return true;
      return text.includes("Retry preview") && text.includes("LibreOffice not found");
    },
    `${label} retry affordance`,
  );
}

async function runVoiceToolCardOnlySmoke(cdp) {
  await expectText(cdp, "Ambient");
  const state = await desktopState(cdp);
  if (!state.activeThreadId) throw new Error("Expected an active thread for voice tool card smoke.");
  await runVoiceToolCardSmoke(cdp, state.activeThreadId);
  await runSttToolCardSmoke(cdp, state.activeThreadId);
}

async function openUpdateNoticePopover(cdp) {
  const opened = await evaluate(
    cdp,
    `
    (() => {
      if (document.querySelector(".desktop-update-popover")) return true;
      const pill = document.querySelector(".desktop-update-pill");
      if (!pill) return false;
      if (pill.getAttribute("aria-expanded") !== "true") pill.click();
      return true;
    })()
  `,
  );
  if (!opened) throw new Error("Unable to open update notice popover.");
}

async function runVoiceArtifactManagementSmoke(cdp) {
  await waitFor(cdp, () => document.body.innerText.includes("Voice artifact ready for cleanup."), "seeded voice assistant message");
  await waitFor(
    cdp,
    () => {
      const status = document.querySelector(".thread-voice-status");
      const text = status?.textContent ?? "";
      const button = status?.querySelector("button");
      return text.includes("Voice not set up") && text.includes("1 ready") && button?.textContent?.includes("Voice settings");
    },
    "thread voice lifecycle status",
  );
  await clickSelector(cdp, ".thread-voice-status button");
  await waitFor(
    cdp,
    () => {
      const section = document.querySelector("#settings-section-voice");
      const text = section?.textContent ?? "";
      return (
        Boolean(section) &&
        text.includes("Provider cache:") &&
        text.includes("Voice setup health") &&
        text.includes("None selected") &&
        text.includes("2 managed") &&
        text.includes("Provider refresh activity") &&
        text.includes("Voice artifacts")
      );
    },
    "thread voice status routes to focused voice settings",
  );
  await clickSelector(cdp, ".panel-close-button");
  await waitFor(
    cdp,
    () => {
      const strip = document.querySelector(".message-voice-state.voice-ready");
      if (!strip) return false;
      const titles = [...strip.querySelectorAll("button")].map((button) => button.getAttribute("title"));
      return (
        strip.textContent?.includes("Voice ready") &&
        strip.textContent?.includes("provider E2E Voice Provider") &&
        titles.includes("Play voice") &&
        titles.includes("Stop voice") &&
        titles.includes("Inspect voice details") &&
        titles.includes("Regenerate voice") &&
        titles.includes("Reveal voice file") &&
        titles.includes("Clear voice file")
      );
    },
    "ready voice artifact controls",
  );
  const activeWorkspacePath = await evaluate(cdp, "window.ambientDesktop.bootstrap().then((state) => state.activeWorkspace.path)");
  const artifactPath = join(activeWorkspacePath, ".ambient", "voice", "e2e-thread", "e2e-assistant.wav");
  const orphanPath = join(activeWorkspacePath, ".ambient", "voice", "e2e-thread", "orphan.wav");
  const initialRetention = await evaluate(
    cdp,
    "window.ambientDesktop.inspectVoiceArtifacts({ threadId: 'e2e-thread', providerCapabilityId: 'ambient-cli:ambient-e2e-voice-provider:tool:e2e_voice_provider' })",
  );
  if (initialRetention.managedFileCount !== 2 || initialRetention.referencedFileCount !== 1 || initialRetention.orphanedFileCount !== 1) {
    throw new Error(`Expected initial voice artifact retention inventory: ${JSON.stringify(initialRetention)}`);
  }
  await readFile(artifactPath);
  await clickVoiceStripButton(cdp, "Inspect voice details");
  await waitFor(
    cdp,
    () => {
      const details = document.querySelector(".message-voice-details");
      const text = details?.textContent ?? "";
      return text.includes("Artifact path") && text.includes(".ambient/voice/e2e-thread/e2e-assistant.wav") && text.includes("Voice artifact ready for cleanup.");
    },
    "ready voice artifact inspection details",
  );
  await clickVoiceStripButton(cdp, "Inspect voice details");
  const clicked = await evaluate(
    cdp,
    `
    (() => {
      const strip = document.querySelector(".message-voice-state.voice-ready");
      const button = [...(strip?.querySelectorAll("button") ?? [])].find((item) => item.getAttribute("title") === "Clear voice file");
      button?.click();
      return Boolean(button);
    })()
  `,
  );
  if (!clicked) throw new Error("Unable to click clear voice file.");
  await waitFor(
    cdp,
    () => {
      const strip = document.querySelector(".message-voice-state.voice-canceled");
      const text = strip?.textContent ?? "";
      const titles = [...(strip?.querySelectorAll("button") ?? [])].map((button) => button.getAttribute("title"));
      return (
        text.includes("Voice canceled") &&
        text.includes("Audio artifact cleared") &&
        titles.includes("Inspect voice details") &&
        titles.includes("Retry voice synthesis") &&
        !titles.includes("Play voice") &&
        !titles.includes("Stop voice") &&
        !titles.includes("Reveal voice file") &&
        !titles.includes("Clear voice file")
      );
    },
    "cleared voice artifact controls",
  );
  const state = await evaluate(cdp, "window.ambientDesktop.bootstrap()");
  const voiceState = state.messageVoiceStates["e2e-assistant"];
  if (voiceState?.status !== "canceled" || voiceState.audioPath || voiceState.mediaUrl || voiceState.mimeType || voiceState.durationMs) {
    throw new Error(`Expected cleared voice artifact metadata: ${JSON.stringify(voiceState)}`);
  }
  if (voiceState.lastAudioPath !== ".ambient/voice/e2e-thread/e2e-assistant.wav") {
    throw new Error(`Expected cleared voice artifact to preserve last path: ${JSON.stringify(voiceState)}`);
  }
  await clickVoiceStripButton(cdp, "Inspect voice details");
  await waitFor(
    cdp,
    () => {
      const details = document.querySelector(".message-voice-details");
      const text = details?.textContent ?? "";
      return text.includes("Last artifact path") && text.includes(".ambient/voice/e2e-thread/e2e-assistant.wav") && text.includes("Voice artifact ready for cleanup.");
    },
    "cleared voice artifact inspection details",
  );
  try {
    await readFile(artifactPath);
    throw new Error(`Expected voice artifact to be deleted: ${artifactPath}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const pruneResult = await evaluate(cdp, "window.ambientDesktop.pruneVoiceArtifacts({ threadId: 'e2e-thread' })");
  if (pruneResult.deletedFileCount !== 1 || pruneResult.orphanedFileCount !== 1) {
    throw new Error(`Expected voice artifact prune to delete one orphan: ${JSON.stringify(pruneResult)}`);
  }
  try {
    await readFile(orphanPath);
    throw new Error(`Expected orphan voice artifact to be deleted: ${orphanPath}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function clickVoiceStripButton(cdp, title) {
  const clicked = await evaluate(
    cdp,
    `
    (() => {
      const title = ${JSON.stringify(title)};
      const strip = document.querySelector(".message-voice-state");
      const button = [...(strip?.querySelectorAll("button") ?? [])].find((item) => item.getAttribute("title") === title);
      button?.click();
      return Boolean(button);
    })()
  `,
  );
  if (!clicked) throw new Error(`Unable to click voice strip button: ${title}`);
}

async function runThreadListSmoke(cdp) {
  const before = await desktopState(cdp);
  const created = await evaluate(cdp, "window.ambientDesktop.createThread()");
  const beforeHadEmptyStarter = before.threads.some((thread) => thread.title === "New chat" && !thread.lastMessagePreview);
  const expectedCreatedCount = beforeHadEmptyStarter ? before.threads.length : before.threads.length + 1;
  if (created.threads.length !== expectedCreatedCount) {
    throw new Error(`Creating a starter chat produced an unexpected thread count. Before=${before.threads.length}, after=${created.threads.length}`);
  }
  const starter = created.threads.find((thread) => thread.id === created.activeThreadId);
  if (starter?.title !== "New chat" || starter.lastMessagePreview) {
    throw new Error(`Expected createThread to activate an empty starter chat, got ${JSON.stringify(starter)}.`);
  }
  const reused = await evaluate(cdp, "window.ambientDesktop.createThread()");
  if (reused.threads.length !== created.threads.length) {
    throw new Error(`Creating a thread from an empty starter chat should reuse it. Before=${created.threads.length}, after=${reused.threads.length}`);
  }
  if (reused.activeThreadId !== created.activeThreadId) {
    throw new Error(`Expected empty starter chat to remain active, got ${reused.activeThreadId}.`);
  }
  await waitFor(cdp, () => document.querySelectorAll(".thread-row.active").length === 1, "single active starter thread row");
  await assertProjectThreadTitleTooltips(cdp);
  await evaluate(
    cdp,
    `window.ambientDesktop.openThreadMiniWindow({ threadId: ${JSON.stringify(reused.activeThreadId)}, workspacePath: ${JSON.stringify(reused.workspace.path)} }).then(() => true)`,
  );
  await waitForMiniWindowTarget(reused.threads.find((thread) => thread.id === reused.activeThreadId)?.title ?? "New chat");
}

async function runVoiceSettingsSmoke(cdp) {
  await waitFor(
    cdp,
    () => {
      const providerSelect = document.querySelector('#settings-section-voice select[aria-label="Voice provider"]');
      return [...(providerSelect?.options ?? [])].some((item) => item.textContent?.includes("E2E Voice Provider"));
    },
    "voice provider option",
  );
  await expectText(cdp, "Add provider");
  const selected = await evaluate(
    cdp,
    `
    (() => {
      const section = document.querySelector("#settings-section-voice");
      if (!section) return { ok: false, reason: "voice section not found" };
      const providerSelect = section.querySelector('select[aria-label="Voice provider"]');
      const option = [...(providerSelect?.options ?? [])].find((item) => item.textContent?.includes("E2E Voice Provider"));
      if (!providerSelect || !option) return { ok: false, reason: "provider select/option not found" };
      providerSelect.value = option.value;
      providerSelect.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, value: providerSelect.value };
    })()
  `,
  );
  if (!selected?.ok) throw new Error(`Unable to select voice provider: ${selected?.reason ?? "unknown"}`);
  await waitFor(
    cdp,
    () => {
      const section = document.querySelector("#settings-section-voice");
      const text = section?.textContent ?? "";
      const toggles = [...(section?.querySelectorAll('label.setting-toggle input[type="checkbox"]') ?? [])];
      return (
        text.includes("E2E Voice Provider") &&
        text.includes("Provider cache:") &&
        text.includes("Voice setup health") &&
        text.includes("Provider unavailable") &&
        text.includes("Voice artifacts") &&
        text.includes("Provider refresh activity") &&
        text.includes("cached provider label") &&
        text.includes("Health check failed") &&
        text.includes("model file missing") &&
        text.includes("Verify model files are downloaded") &&
        toggles.length >= 2 &&
        toggles.every((input) => !input.checked && input.disabled)
      );
    },
    "voice provider failed diagnostics and blocked toggles",
  );
  const activeWorkspacePath = await evaluate(cdp, "window.ambientDesktop.bootstrap().then((state) => state.activeWorkspace.path)");
  await writeFile(join(activeWorkspacePath, ".ambient", "cli-packages", "imported", "ambient-e2e-voice-provider", "voice-ready.marker"), "ready\n", "utf8");
  await clickButton(cdp, "Retry health");
  await waitFor(
    cdp,
    () => {
      const section = document.querySelector("#settings-section-voice");
      const text = section?.textContent ?? "";
      const toggles = [...(section?.querySelectorAll('label.setting-toggle input[type="checkbox"]') ?? [])];
      return (
        text.includes("Provider cache:") &&
        text.includes("Voice setup health") &&
        text.includes("E2E Voice Provider") &&
        text.includes("Provider refresh activity") &&
        text.includes("Health check passed") &&
        toggles.length >= 2 &&
        toggles.every((input) => !input.disabled)
      );
    },
    "voice provider repaired diagnostics",
  );
  await openSettingsDisclosure(cdp, "#settings-section-voice", "Provider details");
  await clickButton(cdp, "Refresh voices");
  await waitFor(
    cdp,
    () => {
      const section = document.querySelector("#settings-section-voice");
      const text = section?.textContent ?? "";
      return (
        text.includes("Voice catalog: E2E Voice Provider") &&
        text.includes("10 voices") &&
        text.includes("Voice catalog cache: fresh") &&
        text.includes("10 cached / 10 shown") &&
        text.includes("Dynamic catalog: local-runtime") &&
        text.includes("Voice cloning: local provider") &&
        text.includes("audio wav") &&
        text.includes("consent required") &&
        text.includes("creates local-model-asset, dynamic-cache-voice") &&
        [...(section?.querySelectorAll("select") ?? [])].some((select) => [...select.options].some((option) => option.value === "warm-narrator"))
      );
    },
    "dynamic voice catalog refresh from Settings",
  );
  const dynamicSelected = await evaluate(
    cdp,
    `
    (() => {
      const section = document.querySelector("#settings-section-voice");
      if (!section) return { ok: false, reason: "voice section not found" };
      const search = section.querySelector('input[aria-label="Search voices"]');
      if (!search) return { ok: false, reason: "voice search input not found" };
      search.value = "warm";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      const selects = [...section.querySelectorAll("select")];
      const voiceSelect = selects.find((select) => [...select.options].some((option) => option.value === "warm-narrator"));
      if (!voiceSelect) return { ok: false, reason: "dynamic voice select not found" };
      voiceSelect.value = "warm-narrator";
      voiceSelect.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, value: voiceSelect.value };
    })()
  `,
  );
  if (!dynamicSelected?.ok) throw new Error(`Unable to select dynamic voice: ${dynamicSelected?.reason ?? "unknown"}`);
  await waitFor(
    cdp,
    () => {
      const section = document.querySelector("#settings-section-voice");
      const voiceSelect = [...(section?.querySelectorAll("select") ?? [])].find((select) => [...select.options].some((option) => option.value === "warm-narrator"));
      const text = section?.textContent ?? "";
      return (
        voiceSelect?.value === "warm-narrator" &&
        text.includes("Selected voice source: cached dynamic catalog") &&
        text.includes("Provider default voice: Warm E2E narrator") &&
        text.includes("current") &&
        text.includes("warm, narration")
      );
    },
    "dynamic voice selected in Settings",
  );
  const settingsAfterDynamicVoice = await evaluate(cdp, "window.ambientDesktop.bootstrap().then((state) => state.settings.voice)");
  if (settingsAfterDynamicVoice.voiceId !== "warm-narrator") {
    throw new Error(`Expected dynamic voice to persist in settings: ${JSON.stringify(settingsAfterDynamicVoice)}`);
  }
  if (settingsAfterDynamicVoice.preferredVoicesByProvider?.[settingsAfterDynamicVoice.providerCapabilityId] !== "warm-narrator") {
    throw new Error(`Expected dynamic voice to persist as provider default: ${JSON.stringify(settingsAfterDynamicVoice)}`);
  }
  await clickVoiceToggle(cdp, 0);
  await waitFor(
    cdp,
    () => {
      const section = document.querySelector("#settings-section-voice");
      const input = [...(section?.querySelectorAll('label.setting-toggle input[type="checkbox"]') ?? [])][0];
      return Boolean(input?.checked && !input.disabled);
    },
    "repaired voice enable toggle checked",
  );
  await clickVoiceToggle(cdp, 1);
  await waitFor(
    cdp,
    () => {
      const section = document.querySelector("#settings-section-voice");
      const text = section?.textContent ?? "";
      const toggles = [...(section?.querySelectorAll('label.setting-toggle input[type="checkbox"]') ?? [])];
      return text.includes("E2E Voice Provider") && text.includes("Health check passed") && toggles.length >= 2 && toggles.every((input) => input.checked && !input.disabled);
    },
    "voice provider repaired and manually enabled",
  );
  const regenerated = await evaluate(cdp, "window.ambientDesktop.regenerateMessageVoice({ messageId: 'e2e-assistant' })");
  if (regenerated?.status !== "ready" || regenerated.voiceId !== "warm-narrator" || regenerated.mimeType !== "audio/wav") {
    throw new Error(`Expected regenerated dynamic voice artifact: ${JSON.stringify(regenerated)}`);
  }
  await rm(join(activeWorkspacePath, ".ambient", "cli-packages", "imported", "ambient-e2e-voice-provider", "voice-ready.marker"), { force: true });
  await emitE2eEvent(cdp, {
    type: "tool-event",
    threadId: "e2e-thread",
    label: "ambient_cli provider repair",
    status: "done",
    details: { source: "first-party", runtime: "chat", toolName: "ambient_cli" },
  });
  await waitFor(
    cdp,
    () => {
      const section = document.querySelector("#settings-section-voice");
      const text = section?.textContent ?? "";
      return (
        text.includes("Voice setup health") &&
        text.includes("Provider unavailable") &&
        text.includes("Provider refresh activity") &&
        text.includes("tool done") &&
        text.includes("Health check failed") &&
        text.includes("model file missing")
      );
    },
    "voice provider regressed diagnostics",
  );
  await clickSelector(cdp, ".panel-close-button");
  await waitFor(
    cdp,
    () => {
      const status = document.querySelector(".thread-voice-status");
      const text = status?.textContent ?? "";
      return text.includes("Voice provider unavailable") && text.includes("E2E Voice Provider") && text.includes("model file missing");
    },
    "thread voice provider unavailable status",
  );
}

async function runVoiceOnboardingPromptSmoke(cdp) {
  await evaluate(
    cdp,
    `
    window.ambientDesktop.bootstrap().then((state) => {
      if (state.activeThreadId) window.ambientDesktop.emitE2eEvent?.({ type: "run-status", threadId: state.activeThreadId, status: "idle" });
      return true;
    })
  `,
  );
  await evaluate(
    cdp,
    `
    (() => {
      window.__ambientCapturedVoiceOnboardingMessages = [];
      window.__ambientVoiceOnboardingCaptureDispose?.();
      window.__ambientVoiceOnboardingCaptureDispose = window.ambientDesktop.onEvent((event) => {
        if (event.type === "e2e-message-captured") window.__ambientCapturedVoiceOnboardingMessages.push(event.input);
      });
      return true;
    })()
  `,
  );
  const clicked = await evaluate(
    cdp,
    `
    (() => {
      const section = document.querySelector("#settings-section-voice");
      const button = [...(section?.querySelectorAll("button") ?? [])].find((item) => item.textContent?.includes("Add provider"));
      if (!button) return { ok: false, reason: "Add provider button not found" };
      if (button.disabled) return { ok: false, reason: button.title || "Add provider button disabled" };
      button.click();
      return { ok: true };
    })()
  `,
  );
  if (!clicked?.ok) throw new Error(`Unable to click voice Add provider: ${clicked?.reason ?? "unknown"}`);
  await waitFor(
    cdp,
    () => Boolean(window.__ambientCapturedVoiceOnboardingMessages?.[0]),
    "voice onboarding captured prompt",
    30_000,
  );
  const captured = await evaluate(cdp, "window.__ambientCapturedVoiceOnboardingMessages?.[0]");
  const content = captured?.content ?? "";
  const expectedFragments = [
    "Installer shape: tts-provider",
    "Machine facts:",
    "OS/arch:",
    "Runtimes/package managers:",
    "Node.js (node): available",
    "Provider recommendation summary:",
    "First-turn behavior: briefly explain these recommendations",
    "Piper: recommended now",
    "ElevenLabs: good option",
    "Cartesia: good option",
    "Piper fast path requirements:",
    "en_US-lessac-medium.onnx",
    "Health check must fail clearly when model assets are missing",
    "Cloud provider fast path requirements:",
    "For ElevenLabs, plan envNames ELEVENLABS_API_KEY",
    "For Cartesia, plan envNames CARTESIA_API_KEY",
    "Do not search bundled app markdown",
    "Piper (local, recommended)",
    "ElevenLabs (cloud, recommended)",
    "Cartesia (cloud, recommended)",
    "ambient_cli_secret_request",
    "ambient_cli_env_bind",
    "never expose secret values",
    "Command contract: accept --text <text>, --output <path>, --format <wav|mp3|ogg>",
  ];
  const missing = expectedFragments.filter((fragment) => !content.includes(fragment));
  if (captured?.delivery !== "prompt" || missing.length) {
    throw new Error(`Unexpected voice onboarding prompt. Missing=${JSON.stringify(missing)} Preview=${JSON.stringify(content.slice(0, 1200))}`);
  }
  await evaluate(
    cdp,
    `
    (() => {
      const latest = window.__ambientCapturedVoiceOnboardingMessages?.[0];
      if (latest?.threadId) window.ambientDesktop.emitE2eEvent?.({ type: "run-status", threadId: latest.threadId, status: "idle" });
      window.__ambientVoiceOnboardingCaptureDispose?.();
      delete window.__ambientVoiceOnboardingCaptureDispose;
      return true;
    })()
  `,
  );
}

async function clickDiagnosticsExport(cdp) {
  const clicked = await evaluate(
    cdp,
    `
    (() => {
      const section = [...document.querySelectorAll(".diagnostic-export")].find((item) =>
        item.querySelector(".panel-section-heading strong")?.textContent?.trim() === "Diagnostics"
      );
      const button = [...(section?.querySelectorAll("button") ?? [])].find((item) => item.textContent?.includes("Export"));
      button?.click();
      return Boolean(button);
    })()
  `,
  );
  if (!clicked) throw new Error("Unable to click diagnostics export button.");
}

async function clickVoiceToggle(cdp, index) {
  const clicked = await evaluate(
    cdp,
    `
    (() => {
      const section = document.querySelector("#settings-section-voice");
      const input = [...(section?.querySelectorAll('label.setting-toggle input[type="checkbox"]') ?? [])][${index}];
      if (!input || input.disabled) return false;
      if (!input.checked) input.click();
      return true;
    })()
  `,
  );
  if (!clicked) throw new Error(`Unable to click voice toggle ${index}.`);
}

async function openSettingsDisclosure(cdp, sectionSelector, title) {
  const opened = await evaluate(
    cdp,
    `
    (() => {
      const section = document.querySelector(${JSON.stringify(sectionSelector)});
      const details = [...(section?.querySelectorAll(".settings-disclosure") ?? [])].find((item) => item.querySelector("summary")?.textContent?.includes(${JSON.stringify(title)}));
      if (!details) return false;
      if (!details.open) details.querySelector("summary")?.click();
      return true;
    })()
  `,
  );
  if (!opened) throw new Error(`Unable to open settings disclosure: ${title}`);
}

async function openApiKeyDialogSmoke(cdp) {
  await clickSelector(cdp, ".provider-pill");
  await waitFor(cdp, () => document.body.innerText.includes("Connect Ambient API"), "API key dialog");
  await expectText(cdp, "app.ambient.xyz/keys");
  await expectText(cdp, "Ambient API key");
  await expectText(cdp, "Get key");
  await expectText(cdp, "Paste");
  await expectText(cdp, "Test key");
  await clickButton(cdp, "Close");
  await waitFor(cdp, () => !document.body.innerText.includes("Connect Ambient API"), "API key dialog close");
}

async function runSearchSmoke(cdp) {
  await clickButton(cdp, "Search");
  await waitFor(cdp, () => Boolean(document.querySelector('input[placeholder="Search this project"]')), "search panel");
  await fillInput(cdp, 'input[placeholder="Search this project"]', "New chat");
  await waitFor(cdp, () => document.querySelectorAll(".search-result-row").length > 0, "search results");
  await clickButton(cdp, "This chat");
  await waitFor(cdp, () => Boolean(document.querySelector('input[placeholder="Search this chat"]')), "chat search scope");
  await fillInput(cdp, 'input[placeholder="Search this chat"]', "New chat");
  await waitFor(cdp, () => document.querySelector(".search-result-row")?.textContent?.includes("New chat"), "chat search result");
  await clickButton(cdp, "All projects");
  await waitFor(cdp, () => Boolean(document.querySelector('input[placeholder="Search all projects"]')), "all projects search scope");
  await fillInput(cdp, 'input[placeholder="Search all projects"]', "mango");
  await waitFor(
    cdp,
    () => document.querySelector(".search-result-row")?.textContent?.includes("Registered project chat"),
    "all projects registered result",
  );
}

async function runBrowserSmoke(cdp) {
  await clickButton(cdp, "Browser");
  await waitFor(cdp, () => document.body.innerText.includes("Agent browser"), "browser panel");
  const initialState = await evaluate(cdp, "window.ambientDesktop.getBrowserState()");
  if (!initialState.internalAvailable) throw new Error("Internal browser runtime should be available in Electron.");
  if (initialState.sourceProfilePath !== chromeProfile) {
    throw new Error(`Expected fixture Chrome profile source. State: ${JSON.stringify(initialState)}`);
  }
  await clickButton(cdp, "Copy profile");
  await waitFor(cdp, () => document.body.innerText.includes("Copy Chrome profile?"), "browser profile copy dialog");
  await expectText(cdp, "Cookies and login");
  await expectText(cdp, chromeProfile);
  await clickButton(cdp, "Copy Chrome profile");
  await waitFor(cdp, () => document.body.innerText.includes("Copied Chrome profile is ready."), "copied profile ready status");
  const copiedState = await evaluate(cdp, "window.ambientDesktop.getBrowserState()");
  if (!copiedState.copiedProfileAvailable || copiedState.copiedProfileSourcePath !== chromeProfile || !copiedState.copiedProfileCopiedAt) {
    throw new Error(`Expected copied profile metadata. State: ${JSON.stringify(copiedState)}`);
  }
  await expectText(cdp, "Clear it to revoke logged-in browser access");
  await clickButton(cdp, "Clear copied profile");
  await waitFor(cdp, () => document.body.innerText.includes("Copied Chrome profile cleared."), "copied profile clear status");
  const clearedState = await evaluate(cdp, "window.ambientDesktop.getBrowserState()");
  if (clearedState.copiedProfileAvailable || clearedState.copiedProfileCopiedAt) {
    throw new Error(`Expected copied profile cleanup. State: ${JSON.stringify(clearedState)}`);
  }
  const audit = await evaluate(cdp, "window.ambientDesktop.listPermissionAudit()");
  const profileAudit = audit.filter((entry) => entry.toolName === "browser_profile" && entry.risk === "browser-profile");
  if (profileAudit.length < 2 || !profileAudit.some((entry) => entry.reason.includes("copied")) || !profileAudit.some((entry) => entry.reason.includes("cleared"))) {
    throw new Error(`Expected browser profile copy/clear audit entries: ${JSON.stringify(audit)}`);
  }
  await evaluate(
    cdp,
    "window.ambientDesktop.setBrowserViewBounds({ x: 520, y: 90, width: 520, height: 320, visible: true })",
  );
  const started = await evaluate(cdp, "window.ambientDesktop.startBrowser({ profileMode: 'isolated' })");
  if (started.runtime !== "internal" || started.profileMode !== "isolated" || !started.running) {
    throw new Error(`Expected isolated browser to start internally. State: ${JSON.stringify(started)}`);
  }
  const content = await evaluate(
    cdp,
    `window.ambientDesktop.navigateBrowser({ url: ${JSON.stringify(`file://${join(workspace, "sample.html")}`)} })`,
  );
  if (!content.text.includes("E2E HTML Preview")) throw new Error(`Internal browser content was not extracted: ${content.text}`);
  const screenshot = await evaluate(cdp, "window.ambientDesktop.screenshotBrowser({ profileMode: 'isolated' })");
  if (!screenshot.path || screenshot.bytes < 100) throw new Error(`Internal browser screenshot was empty: ${JSON.stringify(screenshot)}`);
  await evaluate(cdp, "window.ambientDesktop.writeClipboardText('ambient-e2e-browser-reference')");
  const clipboardText = await evaluate(cdp, "window.ambientDesktop.readClipboardText()");
  if (clipboardText !== "ambient-e2e-browser-reference") throw new Error(`Clipboard bridge did not round-trip browser reference text: ${clipboardText}`);
  await clickButton(cdp, "Focus browser");
  await waitFor(cdp, () => Boolean(document.querySelector(".browser-focused-shell")) && document.body.innerText.includes("Restore"), "focused browser mode");
  await clickButton(cdp, "Restore");
  await waitFor(cdp, () => !document.querySelector(".browser-focused-shell"), "browser focus restore");
  await evaluate(
    cdp,
    `(() => {
      window.__ambientE2ePickResult = undefined;
      window.__ambientE2ePickError = undefined;
      window.ambientDesktop.pickBrowser({ prompt: "Select the E2E preview title", profileMode: "isolated" })
        .then((result) => { window.__ambientE2ePickResult = result; })
        .catch((error) => { window.__ambientE2ePickError = String(error?.message || error); });
      return true;
    })()`,
  );
  await waitFor(
    cdp,
    () =>
      document.body.innerText.includes("Ambient is waiting for your browser selection") &&
      document.body.innerText.includes("Select the E2E preview title"),
    "browser picker active state",
  );
  const activePickState = await evaluate(cdp, "window.ambientDesktop.getBrowserState()");
  if (!activePickState.pickerActive || activePickState.pickerPrompt !== "Select the E2E preview title") {
    throw new Error(`Expected active browser picker state. State: ${JSON.stringify(activePickState)}`);
  }
  await clickButton(cdp, "Cancel picker");
  await waitFor(cdp, () => window.__ambientE2ePickResult?.canceled === true || Boolean(window.__ambientE2ePickError), "browser picker cancellation");
  const pickResult = await evaluate(cdp, "window.__ambientE2ePickResult");
  if (!pickResult?.canceled || pickResult.prompt !== "Select the E2E preview title") {
    throw new Error(`Expected canceled picker result: ${JSON.stringify(pickResult)}`);
  }
  const pickerAudit = await evaluate(cdp, "window.ambientDesktop.listPermissionAudit()");
  if (!pickerAudit.some((entry) => entry.toolName === "browser_pick" && entry.risk === "browser-control")) {
    throw new Error(`Expected browser picker audit entry: ${JSON.stringify(pickerAudit)}`);
  }
  const stopped = await evaluate(cdp, "window.ambientDesktop.stopBrowser()");
  if (stopped.running) throw new Error(`Browser should stop cleanly. State: ${JSON.stringify(stopped)}`);
}

async function runDiffSmoke(cdp) {
  await clickButtonByTitle(cdp, "Diff");
  await assertRightPanelResize(cdp);
  await waitFor(
    cdp,
    () => {
      const badge = document.querySelector(".git-edit-badge");
      const text = badge?.textContent ?? "";
      return /\+\d+/.test(text) && /-\d+/.test(text);
    },
    "top git edit summary badge",
  );
  await waitFor(
    cdp,
    () => {
      const text = document.querySelector(".git-codex-summary-card")?.textContent ?? "";
      return text.includes("files changed") && text.includes("tracked.txt");
    },
    "Codex-style git summary card",
  );
  await waitFor(cdp, () => document.querySelector(".git-summary-file[open] .diff-output")?.textContent?.includes("tracked changed"), "expanded summary diff");
  await waitFor(
    cdp,
    () => {
      const restore = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Restore"));
      return Boolean(restore?.disabled);
    },
    "Restore disabled without checkpoint",
  );
  await clickButton(cdp, "Review");
  await waitFor(cdp, () => document.body.innerText.includes("Modified") && document.body.innerText.includes("tracked.txt"), "modified diff");
  await waitFor(cdp, () => document.body.innerText.includes("Untracked") && document.body.innerText.includes("untracked.txt"), "untracked diff");
  await selectBranch(cdp, "e2e-alt");
  await waitFor(cdp, () => document.body.innerText.includes("Switch branches with local changes?"), "dirty branch switch confirmation");
  await clickButton(cdp, "Cancel");
  await waitFor(cdp, () => !document.body.innerText.includes("Switch branches with local changes?"), "dirty branch switch confirmation close");
  await clickButton(cdp, "Review");
  await clickButton(cdp, "Discard");
  await waitFor(
    cdp,
    () => document.body.innerText.includes("Discard file changes?") || document.body.innerText.includes("Delete untracked file?"),
    "git discard confirmation",
  );
  await clickButton(cdp, "Cancel");
  await waitFor(cdp, () => !document.body.innerText.includes("Discard file changes?") && !document.body.innerText.includes("Delete untracked file?"), "git discard confirmation close");
  await waitFor(cdp, () => document.body.innerText.includes("tracked.txt"), "discard cancel preserves file");
  await clickButton(cdp, "Discard");
  await waitFor(cdp, () => document.body.innerText.includes("Discard file changes?"), "git discard confirmation for checkpoint");
  await clickButton(cdp, "Discard changes");
  await waitFor(cdp, () => !document.querySelector(".git-review-file")?.textContent?.includes("tracked.txt"), "tracked file discarded");
  await clickButton(cdp, "Summary");
  await waitFor(
    cdp,
    () => {
      const restore = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Restore"));
      return Boolean(restore && !restore.disabled);
    },
    "Restore enabled after checkpointed discard",
  );
  await clickEnabledButton(cdp, "Restore");
  await waitFor(cdp, () => document.body.innerText.includes("Restore latest checkpoint?"), "Restore confirmation");
  await clickGitConfirmButton(cdp, "Restore checkpoint");
  await waitFor(cdp, () => document.body.innerText.includes("tracked changed"), "Restore checkpoint restores tracked diff");
}

async function runNoRepoGitSmoke(cdp) {
  await clickButton(cdp, basename(registeredWorkspace));
  const registeredPath = JSON.stringify(registeredWorkspace);
  await waitFor(
    cdp,
    new Function(`return window.ambientDesktop.bootstrap().then((state) => state.workspace.path === ${registeredPath});`),
    "registered project selection",
  );
  await waitFor(
    cdp,
    new Function(
      `return window.ambientDesktop.getGitReview().then((review) => review.workspacePath === ${registeredPath} && review.projectRoot === ${registeredPath} && !review.isGitRepository);`,
    ),
    "registered no-repo git review",
  );
  await clickButton(cdp, "Summary");
  await clickButton(cdp, "Refresh");
  await waitFor(cdp, () => document.body.innerText.includes("Unversioned workspace"), "no-repo git summary");
  await clickButton(cdp, "Initialize repository");
  await waitFor(cdp, () => document.body.innerText.includes("Initialize Git repository?"), "initialize repository confirmation");
  await clickButton(cdp, "Cancel");
  await waitFor(cdp, () => !document.body.innerText.includes("Initialize Git repository?"), "initialize repository confirmation close");
  await clickButton(cdp, "Continue without Git");
  await waitFor(cdp, () => document.body.innerText.includes("Continuing without Git"), "continue without git state");
  await clickButton(cdp, basename(workspace));
  await expectText(cdp, basename(workspace));
}

async function runSharedWorkspaceMigrationSmoke(cdp) {
  await clickButton(cdp, basename(legacyGitWorkspace));
  const legacyPath = JSON.stringify(legacyGitWorkspace);
  await waitFor(
    cdp,
    new Function(`return window.ambientDesktop.bootstrap().then((state) => state.workspace.path === ${legacyPath});`),
    "legacy project selection",
  );
  await waitFor(
    cdp,
    new Function(
      `return window.ambientDesktop.getGitReview().then((review) => review.workspacePath === ${legacyPath} && review.projectRoot === ${legacyPath} && review.isGitRepository);`,
    ),
    "legacy git review",
  );
  await clickButton(cdp, "Summary");
  await clickButton(cdp, "Refresh");
  await waitFor(cdp, () => document.body.innerText.includes("Shared project workspace"), "shared workspace warning");
  await expectText(cdp, "Create thread worktree");
  await expectText(cdp, "Attach existing");
  await waitFor(cdp, () => document.body.innerText.includes("legacy.txt"), "legacy shared diff");
  await clickButton(cdp, "Keep shared");
  await waitFor(cdp, () => document.body.innerText.includes("This chat will keep using the shared project root for now."), "keep shared workspace state");
  await clickButton(cdp, "Create thread worktree");
  await waitFor(cdp, () => document.body.innerText.includes("Create thread worktree?"), "create thread worktree confirmation");
  await clickButton(cdp, "Create worktree");
  await waitFor(cdp, () => document.body.innerText.includes("Thread worktree:"), "thread worktree active");
  await clickButton(cdp, basename(workspace));
  await expectText(cdp, basename(workspace));
}

async function runPluginSmoke(cdp) {
  await clickButton(cdp, "Plugins");
  await waitFor(cdp, () => document.body.innerText.includes("Ambient Plugin Host"), "plugin host panel");
  await clickButton(cdp, "Installed");
  await waitFor(cdp, () => document.body.innerText.includes("Ambient Fixture"), "plugin catalog");
  await waitFor(cdp, () => document.body.innerText.includes("Trust required for code"), "plugin trust badge");
  await waitFor(cdp, () => document.body.innerText.includes("Codex workspace"), "plugin source badge");
  await clickButton(cdp, "Trust");
  await waitFor(cdp, () => document.body.innerText.includes("Trusted"), "plugin trust toggle");
  const openedFixtureDetails = await evaluate(
    cdp,
    `
    (() => {
      const row = [...document.querySelectorAll(".plugin-row")].find((item) => item.innerText.includes("Ambient Fixture"));
      const button = [...(row?.querySelectorAll("button") ?? [])].find((item) => item.textContent?.includes("Details"));
      button?.click();
      return Boolean(button);
    })()
  `,
  );
  if (!openedFixtureDetails) throw new Error("Unable to open Ambient Fixture plugin details.");
  await waitFor(cdp, () => document.body.innerText.includes("workspace-inspector"), "plugin skill discovery");
  await clickButton(cdp, "Marketplace");
  await waitFor(cdp, () => document.body.innerText.includes("Cache Fixture"), "Codex cache import candidate");
  await waitFor(cdp, () => document.body.innerText.includes("Supported"), "plugin compatibility tier");
  await waitFor(cdp, () => document.body.innerText.includes("Browser Use"), "Browser Use import candidate");
  await waitFor(cdp, () => document.body.innerText.includes("Maps browser workflows"), "Browser Use adapter label");
  await waitFor(cdp, () => document.body.innerText.includes("Computer Use"), "Computer Use import candidate");
  await waitFor(cdp, () => document.body.innerText.includes("Exercises native MCP compatibility labels"), "Computer Use support label");
  await waitFor(cdp, () => document.body.innerText.includes("Remote Helper"), "remote Codex marketplace candidate");
  await waitFor(cdp, () => document.body.innerText.includes("Remote marketplace"), "remote Codex marketplace label");
  await clickPluginCandidateAction(cdp, "Remote Helper", "Register");
  await waitFor(
    cdp,
    () =>
      window.ambientDesktop.discoverCodexPlugins().then(
        (catalog) =>
          catalog.plugins.some((plugin) => plugin.name === "remote-helper" && plugin.sourceKind === "remote-marketplace") &&
          catalog.importCandidates.some((plugin) => plugin.name === "remote-helper" && plugin.imported),
      ),
    "registered remote plugin catalog state",
  );
  await waitFor(cdp, () => document.body.innerText.includes("Registered"), "remote plugin marked registered");
  await clickButton(cdp, "Sources");
  await waitFor(cdp, () => document.body.innerText.includes("Configured remote marketplace"), "plugin sources before Pi package inspection");
  await clickButton(cdp, "Inspect Pi packages");
  await waitFor(cdp, () => document.body.innerText.includes("Pi Packages"), "Pi package section");
  await waitFor(cdp, () => document.body.innerText.includes("ambient-e2e-pi-package"), "workspace Pi package metadata");
  await waitFor(cdp, () => document.body.innerText.includes("Extensions are executable"), "Pi extension safety label");
  await waitFor(cdp, () => document.body.innerText.includes("pi-mcp-adapter"), "Pi gallery package metadata");
  await waitFor(cdp, () => document.body.innerText.includes("Pi packages are execution-disabled"), "Pi package install disabled label");
  await fillInput(cdp, ".pi-package-install-row input", privilegedPiFixture);
  await clickButton(cdp, "Scan privileged");
  await waitFor(cdp, () => document.body.innerText.includes("Privileged Scan: ambient-e2e-privileged-pi"), "privileged fixture scan result");
  await waitFor(cdp, () => document.body.innerText.includes("Privileged review required"), "privileged fixture risk label");
  await waitFor(cdp, () => document.body.innerText.includes("Install disabled keeps this package inactive"), "privileged fixture inactive caveat");
  await waitFor(
    cdp,
    () => document.body.innerText.includes("MCP config detected") && document.body.innerText.includes("command surface"),
    "privileged fixture resource labels",
  );
  await waitFor(
    cdp,
    () => [...document.querySelectorAll(".pi-package-install-row button")].some((button) => button.textContent?.includes("Install disabled") && !button.disabled),
    "privileged fixture install disabled button",
  );
  await clickButton(cdp, "Install disabled");
  await waitFor(
    cdp,
    () =>
      document.body.innerText.includes('Install privileged Pi package "ambient-e2e-privileged-pi" as disabled?') ||
      window.ambientDesktop.inspectPiPrivilegedPackages().then((catalog) =>
        catalog.packages.some((pkg) => pkg.packageName === "ambient-e2e-privileged-pi" && pkg.status === "disabled"),
      ),
    "privileged fixture install permission or installed state",
    30_000,
  );
  const privilegedInstallNeedsApproval = await evaluate(
    cdp,
    `document.body.innerText.includes('Install privileged Pi package "ambient-e2e-privileged-pi" as disabled?')`,
  );
  if (privilegedInstallNeedsApproval) await clickButton(cdp, "Trust and allow once");
  await waitFor(cdp, () => document.body.innerText.includes("Privileged Pi Installs"), "privileged fixture installs section", 30_000);
  await waitFor(
    cdp,
    () => document.body.innerText.includes("ambient-e2e-privileged-pi") && document.body.innerText.includes("Disabled"),
    "privileged fixture disabled install",
    30_000,
  );
  await waitFor(cdp, () => document.body.innerText.includes("Alpha install is inactive"), "privileged fixture disabled caveat");
  await waitFor(
    cdp,
    () =>
      window.ambientDesktop.inspectPiPrivilegedPackages().then((catalog) =>
        catalog.packages.some(
          (pkg) =>
            pkg.packageName === "ambient-e2e-privileged-pi" &&
            pkg.status === "disabled" &&
            pkg.scan.riskSummary.mcpServers &&
            pkg.scan.riskSummary.lifecycleHooks &&
            pkg.scan.riskSummary.processExecution,
        ),
      ),
    "privileged fixture catalog installed state",
    30_000,
  );
  const clickedPrivilegedUninstall = await evaluate(
    cdp,
    `
    (() => {
      const rows = [...document.querySelectorAll(".plugin-row")].filter((row) => row.innerText.includes("ambient-e2e-privileged-pi"));
      const row = rows[rows.length - 1];
      const button = [...(row?.querySelectorAll("button") ?? [])].find((item) => item.textContent?.includes("Uninstall"));
      button?.click();
      return Boolean(button);
    })()
  `,
  );
  if (!clickedPrivilegedUninstall) throw new Error("Unable to click ambient-e2e-privileged-pi privileged uninstall button.");
  await waitFor(cdp, () => document.body.innerText.includes("No privileged Pi installs are registered."), "privileged fixture uninstall empty state", 30_000);
  await waitFor(
    cdp,
    () => window.ambientDesktop.inspectPiPrivilegedPackages().then((catalog) => catalog.packages.length === 0),
    "privileged fixture catalog empty state",
    30_000,
  );
  await clickButton(cdp, "Marketplace");
  await waitFor(cdp, () => document.body.innerText.includes("Cache Fixture"), "Codex cache import candidate before import");
  await clickPluginCandidateAction(cdp, "Cache Fixture", "Import");
  await waitFor(
    cdp,
    () =>
      window.ambientDesktop.discoverCodexPlugins().then(
        (catalog) =>
          catalog.plugins.some((plugin) => plugin.name === "cache-fixture" && plugin.sourceKind === "workspace") &&
          catalog.importCandidates.some((plugin) => plugin.name === "cache-fixture" && plugin.imported),
      ),
    "imported plugin catalog state",
  );
  await waitFor(cdp, () => document.body.innerText.includes("Imported"), "import candidate marked imported");
  await clickButton(cdp, "Inspect MCP");
  await clickButton(cdp, "Diagnostics");
  await waitFor(cdp, () => Boolean(document.querySelector(".plugin-mcp-result")), "plugin MCP inspection result");
  const resultText = await evaluate(cdp, `document.querySelector(".plugin-mcp-result")?.innerText ?? ""`);
  if (!resultText.includes("ambient-fixture") || !resultText.includes("1 tool")) {
    throw new Error(`Plugin MCP inspection did not list the fixture server tool count. Result: ${resultText}`);
  }
}

async function runResponsiveSmoke(cdp) {
  await setViewport(cdp, 880, 720);
  await delay(300);
  await assertNoHorizontalOverflow(cdp, "compact viewport");
  await waitFor(cdp, () => {
    const panel = document.querySelector(".right-panel");
    if (!panel) return true;
    return getComputedStyle(panel).display === "none";
  }, "compact panel hide");
  await setViewport(cdp, 1320, 900);
  await delay(300);
  await assertDesktopLayout(cdp);
}

async function runProjectControlsSmoke(cdp) {
  await clickButton(cdp, "Projects");
  await expectText(cdp, "Projects");
  await expectText(cdp, basename(registeredWorkspace));
  await expectText(cdp, "Registered project chat");
  await clickButton(cdp, "Add new project");
  await waitFor(cdp, () => document.body.innerText.includes("Start from scratch"), "add project popover");
  await expectText(cdp, "Use an existing folder");

  await clickButton(cdp, "Filter, sort, and organize chats");
  await waitFor(cdp, () => document.body.innerText.includes("Organize") && document.body.innerText.includes("By project"), "organize popover");
  await expectText(cdp, "Chronological list");
  await expectText(cdp, "Chats first");
  await expectText(cdp, "Sort by");
  await expectText(cdp, "Created");
  await expectText(cdp, "Updated");
  await expectText(cdp, "All chats");
  await expectText(cdp, "Relevant");

  await clickButton(cdp, "Chronological list");
  await waitFor(cdp, () => Boolean(document.querySelector(".thread-list.flat")), "flat chronological thread list");
  await assertProjectThreadTitleTooltips(cdp);
  await clickButton(cdp, "Workflow Agents");
  await waitFor(cdp, () => document.body.innerText.includes("Workflow Agents"), "workflow agents shell from project list");
  await clickWorkflowAgentView(cdp, "Home");
  await waitFor(cdp, () => document.body.innerText.includes("Workflow Agents"), "workflow agents home from project list");
  await clickButton(cdp, "Projects");
  await waitFor(
    cdp,
    () => Boolean(document.querySelector(".project-list .project-group .workspace-button") && document.querySelector(".thread-list.nested")),
    "projects nav restores grouped project folders",
  );
  await assertProjectThreadTitleTooltips(cdp);
  await clickButton(cdp, "Filter, sort, and organize chats");
  await clickButton(cdp, "Chronological list");
  await waitFor(cdp, () => Boolean(document.querySelector(".thread-list.flat")), "flat chronological thread list after return");
  await assertProjectThreadTitleTooltips(cdp);
  await clickButton(cdp, "Collapse all projects");
  await waitFor(cdp, () => !document.querySelector(".thread-list"), "collapsed projects");
  await clickButton(cdp, "Expand all projects");
  await waitFor(cdp, () => Boolean(document.querySelector(".thread-list.flat")), "expanded projects");
  await clickButton(cdp, "By project");
  await waitFor(cdp, () => Boolean(document.querySelector(".workspace-button") && document.querySelector(".thread-list.nested")), "project grouped thread list");
  await assertProjectThreadTitleTooltips(cdp);
}

async function assertDesktopLayout(cdp) {
  await assertNoHorizontalOverflow(cdp, "desktop viewport");
  const ok = await evaluate(
    cdp,
    `
    (() => {
      const mark = document.querySelector(".brand-button .ambient-mark");
      const composer = document.querySelector(".composer");
      const controls = document.querySelector(".composer-controls");
      const workspace = document.querySelector(".workspace-button");
      const thread = document.querySelector(".thread-row");
      if (!mark || !composer || !controls || !workspace || !thread) return false;
      const markRect = mark.getBoundingClientRect();
      const composerRect = composer.getBoundingClientRect();
      const controlsRect = controls.getBoundingClientRect();
      const workspaceRect = workspace.getBoundingClientRect();
      const threadRect = thread.getBoundingClientRect();
      return markRect.left >= 78
        && composerRect.left >= 0
        && composerRect.right <= window.innerWidth
        && controlsRect.width <= composerRect.width + 1
        && threadRect.left >= workspaceRect.left + 18;
    })()
  `,
  );
  if (!ok) throw new Error("Desktop layout check failed.");
  await captureScreenshot(cdp);
}

async function assertCollapsedSidebarTopbarInset(cdp) {
  const result = await evaluate(
    cdp,
    `
    (async () => {
      const shell = document.querySelector(".app-shell");
      const sidebarToggle = document.querySelector(".sidebar button[title='Toggle sidebar']");
      if (!sidebarToggle) return { ok: false, reason: "missing sidebar toggle" };
      sidebarToggle.click();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const topbar = document.querySelector(".topbar.sidebar-hidden");
      const topbarToggle = topbar?.querySelector("button[title='Toggle sidebar']");
      const heading = topbar?.querySelector(".thread-heading");
      const isMac = shell?.classList.contains("platform-macos") ?? false;
      const minLeft = isMac ? 74 : 0;
      const topbarToggleLeft = topbarToggle?.getBoundingClientRect().left ?? -1;
      const headingLeft = heading?.getBoundingClientRect().left ?? -1;
      const ok = Boolean(topbar && topbarToggle && heading) && (!isMac || (topbarToggleLeft >= minLeft && headingLeft >= minLeft));
      topbarToggle?.click();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return { ok, isMac, minLeft, topbarToggleLeft, headingLeft, sidebarRestored: Boolean(document.querySelector(".sidebar")) };
    })()
  `,
  );
  if (!result.ok || !result.sidebarRestored) throw new Error(`Collapsed sidebar topbar inset failed: ${JSON.stringify(result)}`);
}

async function assertProjectThreadTitleTooltips(cdp) {
  const result = await evaluate(
    cdp,
    `
    (() => {
      const rows = [...document.querySelectorAll(".thread-row:not(.automation-thread-row)")];
      if (rows.length === 0) return { ok: false, reason: "missing project thread rows" };
      for (const row of rows) {
        const title = row.querySelector(".thread-title")?.textContent?.trim();
        if (!title) return { ok: false, reason: "missing title text", row: row.textContent };
        if (row.getAttribute("title") !== title) {
          return { ok: false, reason: "row title mismatch", expected: title, actual: row.getAttribute("title") };
        }
        if (row.querySelector(".thread-title")?.getAttribute("title") !== title) {
          return {
            ok: false,
            reason: "thread title tooltip mismatch",
            expected: title,
            actual: row.querySelector(".thread-title")?.getAttribute("title"),
          };
        }
      }
      return { ok: true, count: rows.length };
    })()
  `,
  );
  if (!result.ok) throw new Error(`Project thread title tooltip check failed: ${JSON.stringify(result)}`);
}

async function runSyntheticStreamSmoke(cdp) {
  const state = await desktopState(cdp);
  const thread = state.threads.find((candidate) => candidate.id === state.activeThreadId);
  if (!thread) throw new Error("Active thread not found in E2E state.");

  const assistantMessage = {
    id: "e2e-assistant-stream",
    threadId: state.activeThreadId,
    role: "assistant",
    content: "",
    createdAt: new Date().toISOString(),
    metadata: { status: "streaming", runtime: "e2e" },
  };
  await emitE2eEvent(cdp, { type: "message-created", message: assistantMessage });
  await emitE2eEvent(cdp, { type: "run-status", threadId: state.activeThreadId, status: "streaming" });
  await waitFor(cdp, () => document.querySelectorAll(".cursor").length === 1, "streaming cursor");
  await waitFor(cdp, () => Boolean(document.querySelector(".thread-indicator.running")), "running thread indicator");
  await waitFor(cdp, () => document.querySelector(".run-activity-card")?.textContent?.includes("Waiting for model output."), "run activity feed");
  await waitFor(cdp, () => document.querySelector(".run-activity-metrics")?.textContent?.includes("Observed"), "run activity metrics");

  await emitE2eEvent(cdp, { type: "message-delta", messageId: assistantMessage.id, delta: "Streaming E2E response." });
  await waitFor(cdp, () => document.body.innerText.includes("Streaming E2E response."), "streaming text");
  await waitFor(cdp, () => document.querySelectorAll(".cursor").length === 0, "cursor hidden after first token");
  await emitE2eEvent(cdp, {
    type: "message-updated",
    message: {
      ...assistantMessage,
      content: "Streaming E2E response.\n\n| Section | Status |\n| --- | --- |\n| Browser | Ready |\n| Picker | Visible |",
      metadata: { ...assistantMessage.metadata, status: "done" },
    },
  });
  await waitFor(
    cdp,
    () => document.querySelector(".rich-table")?.textContent?.includes("Picker") && document.querySelector(".rich-table")?.textContent?.includes("Visible"),
    "assistant markdown table rendering",
  );
  await evaluate(
    cdp,
    `window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true }))`,
  );
  await waitFor(cdp, () => Boolean(document.querySelector('input[placeholder="Find in this chat"]')), "chat find bar");
  await fillInput(cdp, 'input[placeholder="Find in this chat"]', "Streaming");
  await waitFor(cdp, () => Boolean(document.querySelector(".chat-find-highlight.active")), "active chat find highlight");

  const thinkingMessage = {
    id: "e2e-thinking-stream",
    threadId: state.activeThreadId,
    role: "assistant",
    content: "",
    createdAt: new Date().toISOString(),
    metadata: { status: "thinking", runtime: "e2e", kind: "thinking" },
  };
  await emitE2eEvent(cdp, { type: "message-created", message: thinkingMessage });
  await waitFor(cdp, () => document.body.innerText.includes("Thinking"), "thinking role label");
  await waitFor(cdp, () => document.querySelectorAll(".message.thinking .cursor").length === 1, "thinking streaming cursor");
  await emitE2eEvent(cdp, { type: "message-delta", messageId: thinkingMessage.id, delta: "Inspecting the workspace." });
  await waitFor(cdp, () => document.body.innerText.includes("Inspecting the workspace."), "thinking stream text");
  await waitFor(cdp, () => document.querySelector(".run-activity-card")?.textContent?.includes("Inspecting the workspace."), "thinking activity line");
  await emitE2eEvent(cdp, {
    type: "message-updated",
    message: {
      ...thinkingMessage,
      content: "Inspecting the workspace.",
      metadata: { ...thinkingMessage.metadata, status: "done" },
    },
  });
  await waitFor(cdp, () => document.querySelectorAll(".message.thinking .cursor").length === 0, "thinking cursor hidden when done");

  await runSyntheticToolCardMatrix(cdp, state.activeThreadId);
  await runMediaArtifactSmoke(cdp, state.activeThreadId);
  await runVoiceToolCardSmoke(cdp, state.activeThreadId);
  await runSttToolCardSmoke(cdp, state.activeThreadId);

  await emitE2eEvent(cdp, { type: "run-status", threadId: state.activeThreadId, status: "idle" });
  const activeUpdatedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const activeLastReadAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  await emitE2eEvent(cdp, {
    type: "thread-updated",
    thread: { ...thread, lastMessagePreview: "Awaiting user input", updatedAt: activeUpdatedAt, lastReadAt: activeLastReadAt },
  });
  await waitFor(cdp, () => !document.querySelector(".thread-row.active .thread-indicator.awaiting"), "active thread unread indicator hidden");
  await waitFor(
    cdp,
    () => /^\d+h$/.test(document.querySelector(".thread-row.active .thread-age")?.textContent ?? ""),
    "active thread age label",
  );

  const registeredThread = state.projects
    .flatMap((project) => project.threads)
    .find((candidate) => candidate.id === "registered-thread-1");
  if (!registeredThread) throw new Error("Registered E2E thread not found.");
  const inactiveUpdatedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const inactiveLastReadAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  await emitE2eEvent(cdp, {
    type: "thread-updated",
    thread: {
      ...registeredThread,
      title: "Unread E2E work",
      lastMessagePreview: "New work arrived",
      updatedAt: inactiveUpdatedAt,
      lastReadAt: inactiveLastReadAt,
    },
  });
  await waitFor(
    cdp,
    () =>
      [...document.querySelectorAll(".thread-row")].some(
        (row) =>
          row.textContent?.includes("Unread E2E work") &&
          row.querySelector(".thread-indicator.awaiting") &&
          /^\d+d$/.test(row.querySelector(".thread-age")?.textContent ?? ""),
      ),
    "inactive unread thread indicator and age",
  );
  await clickButton(cdp, "Unread E2E work");
  await waitFor(cdp, () => !document.querySelector(".thread-row.active .thread-indicator.awaiting"), "reviewed thread indicator clears");
}

async function runPromptHistorySmoke(cdp) {
  const state = await desktopState(cdp);
  const olderPrompt = "Create a compact calculator.";
  const newerPrompt = "Add keyboard shortcuts to the calculator.";
  await emitE2eEvent(cdp, {
    type: "message-created",
    message: {
      id: "e2e-user-history-older",
      threadId: state.activeThreadId,
      role: "user",
      content: olderPrompt,
      createdAt: new Date(Date.now() - 2_000).toISOString(),
    },
  });
  await emitE2eEvent(cdp, {
    type: "message-created",
    message: {
      id: "e2e-user-history-newer",
      threadId: state.activeThreadId,
      role: "user",
      content: newerPrompt,
      createdAt: new Date(Date.now() - 1_000).toISOString(),
    },
  });

  await fillInput(cdp, ".composer textarea", "");
  await pressComposerKey(cdp, "ArrowUp");
  await waitFor(cdp, () => document.querySelector(".composer textarea")?.value === "Add keyboard shortcuts to the calculator.", "latest prompt history entry");
  await pressComposerKey(cdp, "ArrowUp");
  await waitFor(cdp, () => document.querySelector(".composer textarea")?.value === "Create a compact calculator.", "older prompt history entry");
  await pressComposerKey(cdp, "ArrowDown");
  await waitFor(cdp, () => document.querySelector(".composer textarea")?.value === "Add keyboard shortcuts to the calculator.", "newer prompt history entry");
  await pressComposerKey(cdp, "ArrowDown");
  await waitFor(cdp, () => document.querySelector(".composer textarea")?.value === "", "prompt history draft restore");

  await fillInput(cdp, ".composer textarea", "manual draft");
  await pressComposerKey(cdp, "ArrowUp");
  await waitFor(cdp, () => document.querySelector(".composer textarea")?.value === "manual draft", "manual draft preserved on arrow up");
  await fillInput(cdp, ".composer textarea", "");
  await pasteComposerText(cdp, "pasted prompt text");
  await waitFor(cdp, () => document.querySelector(".composer textarea")?.value === "pasted prompt text", "composer paste");
  await fillInput(cdp, ".composer textarea", "");
}

async function runSyntheticToolCardMatrix(cdp, threadId) {
  const entries = [];
  for (const toolName of syntheticToolNames) {
    for (const status of syntheticToolStatuses) {
      const entry = syntheticToolCardEntry(threadId, toolName, status);
      entries.push(entry);
      await emitSyntheticToolCard(cdp, entry);
    }
  }

  await waitFor(cdp, () => document.querySelectorAll(".message.tool").length >= 24, "synthetic tool card matrix");
  await waitFor(cdp, () => Boolean(document.querySelector(".tool-status.running .spin")), "running tool matrix spinner");

  let cards = await toolCardSnapshots(cdp);
  for (const entry of entries) assertSyntheticToolCard(cards, entry);

  for (const entry of entries.filter((item) => item.status === "done")) {
    await expandSyntheticToolCard(cdp, entry.marker);
  }

  cards = await toolCardSnapshots(cdp);
  for (const entry of entries.filter((item) => item.status === "done")) {
    const card = findSyntheticToolCard(cards, entry);
    if (!card.open) throw new Error(`Expected completed ${entry.toolName} tool card to open after click.`);
    if (!card.text.includes("Result") || !card.text.includes(entry.marker)) {
      throw new Error(`Expanded ${entry.toolName} card did not show its result. Card: ${JSON.stringify(card)}`);
    }
  }

  await clickArtifactPreview(cdp, "notes.md");
  await waitFor(cdp, () => document.body.innerText.includes("E2E Notes"), "artifact preview content");
  await waitFor(
    cdp,
    () => getComputedStyle(document.querySelector(".tool-output")).userSelect !== "none",
    "selectable tool output",
  );

  const emptyCompletedCard = cards.find((card) => card.statusClass.includes("done") && card.text.includes("No output."));
  if (emptyCompletedCard) throw new Error(`Completed tool card rendered as empty: ${JSON.stringify(emptyCompletedCard)}`);
}

async function runMediaArtifactSmoke(cdp, threadId) {
  await emitMediaArtifactToolMessage(cdp, threadId, "pixel.png");
  await emitMediaArtifactToolMessage(cdp, threadId, "sound.wav");
  await emitMediaArtifactToolMessage(cdp, threadId, "clip.webm");
  await emitBrowserScreenshotToolMessage(cdp, threadId);

  await waitFor(cdp, () => document.querySelectorAll(".media-artifact-strip").length >= 4, "media artifact strips");
  await waitFor(cdp, () => {
    const image = document.querySelector('.inline-media-preview.image img[alt="pixel.png"]');
    return Boolean(image && image.naturalWidth > 0);
  }, "inline image artifact preview");
  await waitFor(cdp, () => {
    const image = document.querySelector('.inline-media-preview.image img[alt="browser-e2e.png"]');
    return Boolean(image && image.naturalWidth > 0);
  }, "inline browser screenshot artifact preview");
  await waitFor(cdp, () => Boolean(document.querySelector('.inline-media-preview.audio audio[src^="ambient-media://"]')), "inline audio artifact preview");
  await waitFor(cdp, () => Boolean(document.querySelector('.inline-media-preview.video video[src^="ambient-media://"]')), "inline video artifact preview");

  await clickInlineMediaPreview(cdp, "image", "pixel.png");
  await waitFor(cdp, () => {
    const image = document.querySelector('.media-modal img[alt="pixel.png"]');
    return Boolean(image && image.naturalWidth > 0);
  }, "image artifact modal preview");
  await closeMediaModal(cdp);

  await clickInlineMediaPreview(cdp, "image", "browser-e2e.png");
  await waitFor(cdp, () => {
    const image = document.querySelector('.media-modal img[alt="browser-e2e.png"]');
    return Boolean(image && image.naturalWidth > 0);
  }, "browser screenshot artifact modal preview");
  await closeMediaModal(cdp);

  await clickInlineMediaPreview(cdp, "video", "clip.webm");
  await waitFor(cdp, () => Boolean(document.querySelector('.media-modal video[src^="ambient-media://"]')), "video artifact modal preview");
  await closeMediaModal(cdp);
}

async function runVoiceToolCardSmoke(cdp, threadId) {
  await emitVoiceTestToolMessage(cdp, threadId);
  await emitVoiceCloneStatusToolMessage(cdp, threadId);

  await waitFor(
    cdp,
    () => [...document.querySelectorAll(".tool-voice-preview")].some((card) => card.textContent?.includes("Voice test")),
    "normal voice test tool card",
  );
  await waitFor(
    cdp,
    () => [...document.querySelectorAll(".tool-voice-preview.warning")].some((card) => card.textContent?.includes("Voice clone status")),
    "voice clone warning tool card",
  );

  const snapshot = await voiceToolCardSnapshots(cdp);
  const testCard = snapshot.find((card) => card.text.includes("Voice test"));
  if (!testCard) throw new Error(`Expected normal voice test card. Cards: ${JSON.stringify(snapshot)}`);
  if (testCard.warning || testCard.reconcile) {
    throw new Error(`Normal voice test card should not render reconcile warnings: ${JSON.stringify(testCard)}`);
  }
  for (const expected of ["Selected provider", "Selected voice", "Test status", "Audio", "voice-test.wav"]) {
    if (!testCard.details.includes(expected)) {
      throw new Error(`Normal voice test card missing ${expected}: ${JSON.stringify(testCard)}`);
    }
  }

  const cloneCard = snapshot.find((card) => card.text.includes("Voice clone status"));
  if (!cloneCard) throw new Error(`Expected voice clone status card. Cards: ${JSON.stringify(snapshot)}`);
  if (!cloneCard.warning || !cloneCard.reconcile) {
    throw new Error(`Voice clone status card should render reconcile warnings: ${JSON.stringify(cloneCard)}`);
  }
  for (const expected of [
    "Dynamic cache",
    "Missing cloned voice entry",
    "Missing local artifacts",
    ".ambient/voice-models/clone-1/config.json",
    "Selection blocked",
    "Do not select this voice until the warning is resolved",
  ]) {
    if (!cloneCard.reconcile.includes(expected)) {
      throw new Error(`Voice clone reconcile block missing ${expected}: ${JSON.stringify(cloneCard)}`);
    }
  }
  for (const expected of [
    "Provider id",
    "ambient-cli:local:tool:local_tts",
    "Voice id",
    "clone-1",
    "Readiness",
    "ready",
    "Ready for selection",
    "false",
    "Provider dashboard",
    "https://example.test/voices/clone-1",
    "Provider verification",
    "https://example.test/verify/clone-1",
    "Local artifacts",
    ".ambient/voice-models/clone-1/model.onnx",
  ]) {
    if (!cloneCard.details.includes(expected)) {
      throw new Error(`Voice clone details block missing ${expected}: ${JSON.stringify(cloneCard)}`);
    }
  }
  if (!cloneCard.actions.includes("Open verification") || !cloneCard.actions.includes("Open dashboard")) {
    throw new Error(`Voice clone provider action buttons missing: ${JSON.stringify(cloneCard)}`);
  }
}

async function emitVoiceTestToolMessage(cdp, threadId) {
  const audioPath = ".ambient/voice/e2e-thread/voice-test.wav";
  await emitE2eEvent(cdp, {
    type: "message-created",
    message: {
      id: "e2e-voice-test-card",
      threadId,
      role: "tool",
      content: [
        "Ambient voice test",
        "Provider: E2E Voice Provider (ambient-cli:ambient-e2e-voice-provider:tool:e2e_voice_provider)",
        "Voice: Default E2E voice (default)",
        "Test status: ready",
        `Audio: ${audioPath}`,
        "MIME type: audio/wav",
      ].join("\n"),
      createdAt: new Date().toISOString(),
      metadata: {
        toolName: "ambient_voice_test",
        status: "done",
        toolResultDetails: {
          status: "ready",
          providerCapabilityId: "ambient-cli:ambient-e2e-voice-provider:tool:e2e_voice_provider",
          voiceId: "default",
          audioPath,
          mimeType: "audio/wav",
          durationMs: 100,
          testStatus: "ready",
        },
      },
    },
  });
}

async function emitVoiceCloneStatusToolMessage(cdp, threadId) {
  await emitE2eEvent(cdp, {
    type: "message-created",
    message: {
      id: "e2e-voice-clone-status-card",
      threadId,
      role: "tool",
      content: [
        "Ambient voice clone status",
        "Provider: Local Voice Provider (ambient-cli:local:tool:local_tts)",
        "Voice: Demo clone (clone-1)",
        "Provider status: ready",
        "Readiness: ready",
        "Ready for chat selection: false",
        "Retry status later: false",
        "Dynamic cache: missing",
        "Provider dashboard: https://example.test/voices/clone-1?token=not-a-secret",
        "Provider verification: https://example.test/verify/clone-1?token=not-a-secret",
        "Local artifacts: .ambient/voice-models/clone-1/model.onnx, .ambient/voice-models/clone-1/config.json",
        "Missing local artifacts: .ambient/voice-models/clone-1/config.json",
        "Cloned: true",
      ].join("\n"),
      createdAt: new Date().toISOString(),
      metadata: {
        toolName: "ambient_voice_clone_status",
        status: "done",
        toolResultDetails: {
          status: "ready",
          providerCapabilityId: "ambient-cli:local:tool:local_tts",
          voiceId: "clone-1",
          readiness: "ready",
          readyForSelection: false,
          shouldRetryStatus: false,
          cacheStatus: "missing",
          dashboardUrl: "https://example.test/voices/clone-1",
          verificationUrl: "https://example.test/verify/clone-1",
          localArtifactPaths: [
            ".ambient/voice-models/clone-1/model.onnx",
            ".ambient/voice-models/clone-1/config.json",
          ],
          missingLocalArtifactPaths: [".ambient/voice-models/clone-1/config.json"],
        },
      },
    },
  });
}

async function voiceToolCardSnapshots(cdp) {
  return evaluate(
    cdp,
    `
    [...document.querySelectorAll(".tool-voice-preview")].map((card) => ({
      text: card.textContent ?? "",
      warning: card.classList.contains("warning"),
      reconcile: card.querySelector(".tool-voice-reconcile")?.textContent ?? "",
      details: card.querySelector(".tool-voice-details")?.textContent ?? "",
      actions: card.querySelector(".tool-voice-actions")?.textContent ?? "",
    }))
  `,
  );
}

async function runSttToolCardSmoke(cdp, threadId) {
  await emitSttTestToolMessage(cdp, threadId);

  await waitFor(
    cdp,
    () => [...document.querySelectorAll(".tool-stt-preview")].some((card) => card.textContent?.includes("Speech input test")),
    "STT test tool card",
  );

  const snapshot = await sttToolCardSnapshots(cdp);
  const testCard = snapshot.find((card) => card.text.includes("Speech input test"));
  if (!testCard) throw new Error(`Expected STT test card. Cards: ${JSON.stringify(snapshot)}`);
  for (const expected of [
    "Transcript",
    "Ambient speech recognition spike.",
    "Selected provider",
    "Qwen3-ASR Local",
    "Language",
    "English",
    "Test status",
    "ready",
    "Provider elapsed",
    "1655 ms",
    "RMS",
    "-31.3 dBFS",
  ]) {
    if (!testCard.text.includes(expected)) {
      throw new Error(`STT test card missing ${expected}: ${JSON.stringify(testCard)}`);
    }
  }
  for (const expected of [
    "Raw audio",
    ".ambient/stt/e2e-thread/stt-test.raw.wav",
    "Normalized audio",
    ".ambient/stt/e2e-thread/stt-test.wav",
    "Transcript",
    ".ambient/stt/e2e-thread/stt-test.txt",
    "JSON",
    ".ambient/stt/e2e-thread/stt-test.json",
  ]) {
    if (!testCard.artifacts.includes(expected)) {
      throw new Error(`STT test artifacts missing ${expected}: ${JSON.stringify(testCard)}`);
    }
  }
}

async function emitSttTestToolMessage(cdp, threadId) {
  const audioPath = ".ambient/stt/e2e-thread/stt-test.raw.wav";
  const normalizedAudioPath = ".ambient/stt/e2e-thread/stt-test.wav";
  const transcriptPath = ".ambient/stt/e2e-thread/stt-test.txt";
  const jsonPath = ".ambient/stt/e2e-thread/stt-test.json";
  await emitE2eEvent(cdp, {
    type: "message-created",
    message: {
      id: "e2e-stt-test-card",
      threadId,
      role: "tool",
      content: [
        "Ambient STT test succeeded",
        "Provider: Qwen3-ASR Local",
        "Status: ready",
        "Language: English",
        "Transcript: Ambient speech recognition spike.",
        "Provider elapsed: 1655 ms",
        "RMS: -31.3 dBFS",
        "No-speech threshold: -55 dBFS",
        `Normalized audio artifact: ${normalizedAudioPath}`,
        `Transcript artifact: ${transcriptPath}`,
        `JSON artifact: ${jsonPath}`,
        "Raw audio bytes were not returned to the agent.",
      ].join("\n"),
      createdAt: new Date().toISOString(),
      metadata: {
        toolName: "ambient_stt_test",
        status: "done",
        toolResultDetails: {
          status: "complete",
          testStatus: "ready",
          providerCapabilityId: "ambient-cli:ambient-qwen3-asr:tool:qwen3_asr_transcribe",
          language: "English",
          transcript: "Ambient speech recognition spike.",
          audioPath,
          normalizedAudioPath,
          transcriptPath,
          jsonPath,
          durationMs: 1655,
          noSpeechGate: { rmsDbfs: -31.25, thresholdDbfs: -55 },
        },
      },
    },
  });
}

async function sttToolCardSnapshots(cdp) {
  return evaluate(
    cdp,
    `
    [...document.querySelectorAll(".tool-stt-preview")].map((card) => ({
      text: card.textContent ?? "",
      details: card.querySelector(".tool-voice-details")?.textContent ?? "",
      artifacts: card.querySelector(".tool-stt-artifacts")?.textContent ?? "",
    }))
  `,
  );
}

async function emitMediaArtifactToolMessage(cdp, threadId, fileName) {
  await emitE2eEvent(cdp, {
    type: "message-created",
    message: {
      id: `e2e-media-artifact-${fileName.replace(/[^a-z0-9]+/gi, "-")}`,
      threadId,
      role: "tool",
      content: [
        "write completed",
        "",
        "Input",
        JSON.stringify({ path: fileName, content: "", fixture: `media-artifact-${fileName}` }, null, 2),
        "",
        "Result",
        `Successfully wrote fixture media to ${fileName}`,
      ].join("\n"),
      createdAt: new Date().toISOString(),
      metadata: { toolName: "write", status: "done" },
    },
  });
}

async function emitBrowserScreenshotToolMessage(cdp, threadId) {
  await emitE2eEvent(cdp, {
    type: "message-created",
    message: {
      id: "e2e-browser-screenshot-artifact",
      threadId,
      role: "tool",
      content: [
        "browser_screenshot completed",
        "",
        "Input",
        JSON.stringify({ profileMode: "isolated" }, null, 2),
        "",
        "Result",
        [
          "Browser screenshot captured.",
          "Title: E2E Browser Screenshot Fixture",
          "URL: file:///e2e/browser-screenshot",
          `Artifact: ${browserScreenshotFixturePath}`,
          `Path: ${join(workspace, browserScreenshotFixturePath)}`,
          "Dimensions: 1x1",
          `Bytes: ${pngFixtureBuffer().length}`,
        ].join("\n"),
      ].join("\n"),
      createdAt: new Date().toISOString(),
      metadata: {
        toolName: "browser_screenshot",
        status: "done",
        artifactPath: browserScreenshotFixturePath,
        inlinePreviewEligible: true,
        mediaArtifact: {
          artifactPath: browserScreenshotFixturePath,
          mediaKind: "image",
          mimeType: "image/png",
          bytes: pngFixtureBuffer().length,
          width: 1,
          height: 1,
          sourceUrl: "file:///e2e/browser-screenshot",
          inlinePreviewEligible: true,
          displayInstruction: "Ambient Desktop will attempt to render this browser screenshot inline in the visible chat.",
        },
      },
    },
  });
}

async function clickInlineMediaPreview(cdp, kind, fileName) {
  const clicked = await evaluate(
    cdp,
    `
    (() => {
      const selector = ${JSON.stringify(`.inline-media-preview.${kind}`)};
      const fileName = ${JSON.stringify(fileName)};
      const preview = [...document.querySelectorAll(selector)].find((candidate) => candidate.textContent?.includes(fileName) || candidate.querySelector?.(\`[alt="\${fileName}"]\`) || candidate.getAttribute("title")?.includes(fileName));
      if (!preview || typeof preview.click !== "function") return false;
      preview.click();
      return true;
    })()
  `,
  );
  if (!clicked) throw new Error(`Unable to click inline ${kind} preview for ${fileName}.`);
}

async function closeMediaModal(cdp) {
  await clickSelector(cdp, 'button[aria-label="Close media preview"]');
  await waitFor(cdp, () => !document.querySelector(".media-modal"), "media modal closed");
}

function syntheticToolCardEntry(threadId, toolName, status) {
  const marker = `${toolName.replaceAll("_", "-")}-${status}-output`;
  const statusLabel = status === "done" ? "completed" : status === "error" ? "failed" : "running";
  const inputTitle = toolName === "bash" ? "Command" : "Input";
  const input =
    toolName === "bash"
      ? `printf ${marker}`
      : toolName === "write"
        ? JSON.stringify(
            {
              path: join(workspace, "notes.md"),
              content: "# E2E Notes\n\nThis file verifies the preview pane.\n",
              fixture: marker,
            },
            null,
            2,
          )
        : JSON.stringify({ fixture: marker }, null, 2);
  const result = toolName === "write" ? `${marker}\nSuccessfully wrote 51 bytes to ${join(workspace, "notes.md")}` : marker;
  return {
    id: `e2e-tool-${toolName}-${status}`,
    threadId,
    toolName,
    status,
    statusLabel,
    marker,
    preview: toolName === "bash" ? `printf ${marker}` : "",
    content: `${toolName} ${statusLabel}\n\n${inputTitle}\n${input}\n\nResult\n${result}`,
  };
}

async function emitSyntheticToolCard(cdp, entry) {
  await emitE2eEvent(cdp, {
    type: "message-created",
    message: {
      id: entry.id,
      threadId: entry.threadId,
      role: "tool",
      content: entry.content,
      createdAt: new Date().toISOString(),
      metadata: { toolName: entry.toolName, status: entry.status },
    },
  });
}

async function toolCardSnapshots(cdp) {
  return evaluate(
    cdp,
    `
    [...document.querySelectorAll(".message.tool")].map((article) => {
      const details = article.querySelector(".tool-card");
      const status = article.querySelector(".tool-status");
      return {
        toolName: article.querySelector("summary strong")?.textContent?.trim() ?? "",
        summary: article.querySelector("summary small")?.textContent?.trim() ?? "",
        preview: article.querySelector(".tool-command-preview code")?.textContent?.trim() ?? "",
        resultPreview: article.querySelector(".tool-result-preview code")?.textContent?.trim() ?? "",
        artifactLink: article.querySelector(".artifact-link")?.textContent?.trim() ?? "",
        text: article.textContent ?? "",
        open: Boolean(details?.open),
        statusClass: status?.className ?? "",
        hasSpinner: Boolean(article.querySelector(".tool-status.running .spin")),
      };
    })
  `,
  );
}

function assertSyntheticToolCard(cards, entry) {
  const card = findSyntheticToolCard(cards, entry);
  if (!card) throw new Error(`Missing ${entry.status} ${entry.toolName} tool card.`);
  if (card.summary !== `${entry.toolName} ${entry.statusLabel}`) {
    throw new Error(`Unexpected ${entry.toolName} summary: ${JSON.stringify(card)}`);
  }
  if (!card.statusClass.includes(entry.status)) {
    throw new Error(`Unexpected ${entry.toolName} status class: ${JSON.stringify(card)}`);
  }
  if (entry.status === "running" && (!card.open || !card.hasSpinner)) {
    throw new Error(`Running ${entry.toolName} card did not render open with a spinner: ${JSON.stringify(card)}`);
  }
  if (entry.status === "error" && !card.open) {
    throw new Error(`Error ${entry.toolName} card did not render open: ${JSON.stringify(card)}`);
  }
  if (entry.status === "done" && card.open) {
    throw new Error(`Completed ${entry.toolName} card should start collapsed: ${JSON.stringify(card)}`);
  }
  if (entry.toolName === "bash" && (entry.status === "running" || entry.status === "done") && card.preview !== entry.preview) {
    throw new Error(`Bash ${entry.status} command preview was not rendered: ${JSON.stringify(card)}`);
  }
  if (entry.status !== "running" && !card.resultPreview.includes(entry.marker)) {
    throw new Error(`Collapsed ${entry.toolName} card did not render a result preview: ${JSON.stringify(card)}`);
  }
  if (entry.toolName === "write" && entry.status === "done" && !card.artifactLink.includes("Preview notes.md")) {
    throw new Error(`Completed write card did not render an artifact preview link: ${JSON.stringify(card)}`);
  }
  if (!card.text.includes("Result") || !card.text.includes(entry.marker)) {
    throw new Error(`Tool card did not preserve result output: ${JSON.stringify(card)}`);
  }
}

function findSyntheticToolCard(cards, entry) {
  return cards.find((card) => card.toolName === entry.toolName && card.text.includes(entry.marker));
}

async function expandSyntheticToolCard(cdp, marker) {
  const opened = await evaluate(
    cdp,
    `
    (() => {
      const marker = ${JSON.stringify(marker)};
      const article = [...document.querySelectorAll(".message.tool")].find((card) => card.textContent?.includes(marker));
      const details = article?.querySelector(".tool-card");
      if (!details) return false;
      if (!details.open) details.querySelector("summary")?.click();
      return details.open;
    })()
  `,
  );
  if (!opened) throw new Error(`Unable to expand tool card containing ${marker}.`);
}

async function clickArtifactPreview(cdp, fileName) {
  const clicked = await evaluate(
    cdp,
    `
    (() => {
      const fileName = ${JSON.stringify(fileName)};
      const button = [...document.querySelectorAll(".artifact-link")].find((candidate) => candidate.textContent?.includes(fileName));
      if (!button) return false;
      button.click();
      return true;
    })()
  `,
  );
  if (!clicked) throw new Error(`Unable to click artifact preview for ${fileName}.`);
}

async function runRestartSmoke(cdp) {
  await expectText(cdp, "Ambient");
  await waitFor(cdp, () => document.body.innerText.includes("Workspace scope"), "workspace mode persisted across restart");
  const state = await desktopState(cdp);
  if (state.settings.permissionMode !== "workspace") {
    throw new Error(`Expected workspace mode after restart, got ${state.settings.permissionMode}.`);
  }
  const automationShellOpen = await evaluate(cdp, `Boolean(document.querySelector(".workflow-agent-tabs"))`);
  if (!automationShellOpen) {
    await clickButton(cdp, "Workflow Agents");
    await waitFor(cdp, () => Boolean(document.querySelector(".workflow-agent-tabs")), "workflow agent tabs after app restart");
  }
  await clickWorkflowAgentSidebarThread(cdp, "Workflow Agent tool bridge preview");
  await waitFor(cdp, () => document.body.innerText.includes("Workflow Agent tool bridge preview"), "workflow sample artifact after app restart");
  await clickEnabledButtonIn(cdp, ".workflow-artifact-row", "Audit");
  await waitFor(cdp, () => document.querySelector(".workflow-program-inspector")?.innerText.includes("export default async function"), "workflow source preview after app restart");
  await waitFor(cdp, () => document.body.innerText.includes("Resume source edit"), "workflow source draft resume action after app restart");
  await clickEnabledButtonIn(cdp, ".workflow-program-inspector", "Resume source edit");
  await waitFor(cdp, () => document.querySelector('textarea[placeholder="Workflow source"]')?.value.includes("// e2e restart source draft"), "workflow source draft restored after app restart");
  await clickEnabledButtonIn(cdp, ".workflow-program-inspector", "Cancel source edit");
  await waitFor(
    cdp,
    () => {
      const rawDrafts = window.localStorage.getItem("ambient.workflowSourceDrafts.v1");
      if (!rawDrafts) return true;
      try {
        return !Object.values(JSON.parse(rawDrafts)).some((value) => String(value).includes("// e2e restart source draft"));
      } catch {
        return false;
      }
    },
    "workflow source draft restart cleanup",
  );
}

async function assertDiagnosticsExport() {
  const payload = JSON.parse(await readFile(diagnosticsPath, "utf8"));
  if (!payload.app || !payload.workspace || !payload.sqlite?.threads) {
    throw new Error("Diagnostic bundle did not include app, workspace, and thread sections.");
  }
}

async function assertOpenTargetLaunch() {
  const entries = (await readFile(openTargetLogPath, "utf8"))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (!entries.some((entry) => entry.targetId === "vscode" && entry.path.endsWith("app.ts"))) {
    throw new Error("Open-with launch was not recorded for VS Code and app.ts.");
  }
}

async function desktopState(cdp) {
  return evaluate(cdp, "window.ambientDesktop.bootstrap()");
}

async function emitE2eEvent(cdp, event) {
  await evaluate(cdp, `window.ambientDesktop.emitE2eEvent(${JSON.stringify(event)})`);
}

async function shutdownAppInstance(instance) {
  try {
    await instance.cdp.send("Browser.close");
  } catch {
    // Fall back to process cleanup below.
  }
  try {
    instance.cdp.close();
  } catch {
    // WebSocket may already be closed after Browser.close.
  }
  await waitForProcessExit(instance.child, 5_000);
  await terminateProcessTree(instance.child);
  await terminateDebugPortProcesses();
  await waitForCdpPortClosed().catch(() => undefined);
}

async function terminateProcessTree(proc) {
  children.delete(proc);
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
  await runIgnoringFailure("pkill", ["-f", `remote-debugging-port=${port}`]);
  await runIgnoringFailure("pkill", ["-f", `${cwdPattern}.*remote-debugging-port=${port}`]);
  await runIgnoringFailure("pkill", ["-f", `electron-vite dev -- --remote-debugging-port=${port}`]);
}

function runIgnoringFailure(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", resolve);
    child.on("close", resolve);
  });
}

function outputTail() {
  return `Electron output tail:\n${output.join("").split("\n").slice(-80).join("\n")}\n`;
}
