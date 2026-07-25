#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repoRoot = process.cwd();
const resultsDir = join(repoRoot, "test-results", "prompt-cache-status");
const latestReportPath = join(resultsDir, "latest.json");
const defaultProvider = "ambient";
const kimiModel = "example/model-id";
const appWaitTimeoutMs = 90_000;
const chatTurnTimeoutMs = Number(process.env.AMBIENT_PROMPT_CACHE_DOGFOOD_CHAT_TIMEOUT_MS ?? 300_000);
const cdpCommandTimeoutMs = 20_000;
const schemaVersion = "ambient-prompt-cache-status-dogfood-v1";
const runNonce = process.env.AMBIENT_PROMPT_CACHE_DOGFOOD_NONCE || `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;

const startedAt = new Date().toISOString();
let app;
let cdp;
let scratch;
let report;
let cachedAgentBrowserAvailable;

try {
  await rm(latestReportPath, { force: true });
  await mkdir(resultsDir, { recursive: true });
  await run("pnpm", ["run", "prepare:electron-native"], buildDogfoodEnv());

  scratch = await createScratch();
  app = launchDesktop(scratch);
  cdp = await connectToElectron(dogfoodCdpPort(), app);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await setViewport(cdp, 1500, 950);
  await waitForText(cdp, "Ambient", appWaitTimeoutMs);
  await installLiveCollector(cdp);

  const settingsEvidence = await enablePromptCacheDiagnostics(cdp);
  const initialElectronEvidence = await captureElectronEvidence(cdp, "settings-enabled");

  const repeatThreadId = await createDogfoodThread(cdp, {
    title: "Prompt cache repeated payload",
    model: dogfoodModelId(),
    thinkingLevel: "xhigh",
  });
  const repeatedPrompt = promptCacheDogfoodPrompt({
    marker: "PROMPT_CACHE_REPEAT_A_OK",
    seed: `repeat-a-${runNonce}`,
  });
  const firstTurn = await runPromptTurn(cdp, {
    threadId: repeatThreadId,
    content: repeatedPrompt,
    expectedMarker: "PROMPT_CACHE_REPEAT_A_OK",
    acceptedStatuses: ["hit", "miss"],
    label: "initial repeated prompt",
  });
  const missScreenshot = await writeScreenshot(cdp, "prompt-cache-miss-a.png");

  const secondTurn = await runPromptTurn(cdp, {
    threadId: repeatThreadId,
    content: repeatedPrompt,
    expectedMarker: "PROMPT_CACHE_REPEAT_A_OK",
    acceptedStatuses: ["hit", "miss"],
    minimumCacheReadExclusive: maxCacheRead(firstTurn),
    label: "same prompt repeated",
  });
  const hitScreenshot = await writeScreenshot(cdp, "prompt-cache-hit-a.png");

  const changedThreadId = await createDogfoodThread(cdp, {
    title: "Prompt cache changed payload",
    model: dogfoodModelId(),
    thinkingLevel: "xhigh",
  });
  const changedPrompt = promptCacheDogfoodPrompt({
    marker: "PROMPT_CACHE_CHANGED_B_OK",
    seed: `changed-b-${runNonce}`,
  });
  const changedTurn = await runPromptTurn(cdp, {
    threadId: changedThreadId,
    content: changedPrompt,
    expectedMarker: "PROMPT_CACHE_CHANGED_B_OK",
    acceptedStatuses: ["hit", "miss"],
    label: "different prompt in fresh thread",
  });
  const changedMissScreenshot = await writeScreenshot(cdp, "prompt-cache-miss-b.png");
  const finalElectronEvidence = await captureElectronEvidence(cdp, "final-cache-status");

  const proof = assertPromptCacheDogfood({
    firstTurn,
    secondTurn,
    changedTurn,
    settingsEvidence,
  });
  report = {
    schemaVersion,
    scenario: "prompt-cache-status",
    startedAt,
    status: "passed",
    classification: "passed",
    provider: {
      providerId: dogfoodProviderId(),
      model: dogfoodModelId(),
      ambientKeyConfigured: ambientKeyConfigured(),
    },
    runNonce,
    settings: settingsEvidence,
    proof,
    turns: {
      first: summarizeTurn(firstTurn),
      repeated: summarizeTurn(secondTurn),
      changed: summarizeTurn(changedTurn),
    },
    electronSkillEvidence: {
      initial: initialElectronEvidence,
      final: finalElectronEvidence,
    },
    artifacts: {
      missScreenshot: outputPathRelative(missScreenshot),
      hitScreenshot: outputPathRelative(hitScreenshot),
      changedMissScreenshot: outputPathRelative(changedMissScreenshot),
      latestReport: outputPathRelative(latestReportPath),
      initialSnapshot: initialElectronEvidence.snapshotPath,
      initialScreenshot: initialElectronEvidence.screenshotPath,
      finalSnapshot: finalElectronEvidence.snapshotPath,
      finalScreenshot: finalElectronEvidence.screenshotPath,
    },
  };
  await writeReport(report);
  console.log(`Prompt cache status dogfood passed. Results: ${outputPathRelative(latestReportPath)}`);
} catch (error) {
  const failure = error instanceof Error ? error : new Error(String(error));
  if (cdp) {
    try {
      await writeScreenshot(cdp, "prompt-cache-status-failure.png");
    } catch {
      // Preserve the original failure.
    }
  }
  report = {
    schemaVersion,
    scenario: "prompt-cache-status",
    startedAt,
    status: "failed",
    classification: "failed",
    provider: {
      providerId: dogfoodProviderId(),
      model: dogfoodModelId(),
      ambientKeyConfigured: ambientKeyConfigured(),
    },
    error: failure.message,
    stack: failure.stack,
  };
  await writeReport(report).catch(() => undefined);
  console.error(failure.stack ?? failure.message);
  process.exitCode = 1;
} finally {
  cdp?.close?.();
  await terminateProcessTree(app);
  try {
    await run("pnpm", ["run", "prepare:node-native"], buildDogfoodEnv());
  } catch (error) {
    process.exitCode = 1;
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
  if (scratch && process.env.AMBIENT_PROMPT_CACHE_DOGFOOD_KEEP_SCRATCH !== "1") {
    await rm(scratch.root, { recursive: true, force: true }).catch(() => undefined);
  } else if (scratch) {
    console.error(`Keeping prompt cache dogfood scratch: ${scratch.root}`);
  }
}

function promptCacheDogfoodPrompt({ marker, seed }) {
  const payload = largeDeterministicPayload(seed);
  return [
    `RUN NONCE: ${seed}`,
    "This is a live Ambient prompt cache status dogfood.",
    "Use the model only; do not call tools.",
    "Read the deterministic payload below. Think internally about whether the sentinel alphabetically sorts before the seed.",
    `Your final assistant response must contain this marker on its own line: ${marker}.`,
    "Do not leave the marker only in thinking content. Keep the final assistant response under 20 words.",
    "",
    "DETERMINISTIC PAYLOAD START",
    payload,
    "DETERMINISTIC PAYLOAD END",
  ].join("\n");
}

function largeDeterministicPayload(seed) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  const lines = [];
  for (let index = 0; index < 420; index += 1) {
    const rotated = `${alphabet.slice(index % alphabet.length)}${alphabet.slice(0, index % alphabet.length)}`;
    lines.push(
      [
        `line=${String(index).padStart(4, "0")}`,
        `seed=${seed}`,
        `sentinel=${rotated.toUpperCase()}`,
        "cache-detection-repeatable-input",
        "Ambient Desktop should surface provider-reported prompt cache status without claiming the response itself was cached.",
      ].join(" | "),
    );
  }
  return lines.join("\n");
}

async function enablePromptCacheDiagnostics(cdpClient) {
  const settings = await evaluate(cdpClient, async () => {
    const initial = await window.ambientDesktop.bootstrap();
    const thinkingDisplay = await window.ambientDesktop.updateThinkingDisplaySettings({
      ...initial.settings.thinkingDisplay,
      mode: "full",
    });
    const modelRuntime = await window.ambientDesktop.updateModelRuntimeSettings({
      ...initial.settings.modelRuntime,
      showPromptCacheStatus: true,
    });
    const after = await window.ambientDesktop.bootstrap();
    return {
      thinkingDisplay,
      modelRuntime,
      afterThinkingDisplay: after.settings.thinkingDisplay,
      afterModelRuntime: after.settings.modelRuntime,
    };
  });
  if (settings?.afterThinkingDisplay?.mode !== "full") {
    throw new Error(`Thinking display was not set to Full: ${JSON.stringify(settings)}`);
  }
  if (settings?.afterModelRuntime?.showPromptCacheStatus !== true) {
    throw new Error(`Show prompt cache status was not enabled: ${JSON.stringify(settings)}`);
  }
  return settings;
}

async function createDogfoodThread(cdpClient, input) {
  const threadId = await evaluate(
    cdpClient,
    async (threadInput) => {
      const next = await window.ambientDesktop.createThread({
        permissionMode: "workspace",
        collaborationMode: "agent",
        model: threadInput.model,
        thinkingLevel: threadInput.thinkingLevel,
      });
      const id = next.activeThreadId;
      if (window.ambientDesktop.updateThread) {
        await window.ambientDesktop.updateThread({ threadId: id, title: threadInput.title });
      }
      await window.ambientDesktop.selectThread(id);
      if (window.ambientDesktop.updateThreadSettings) {
        await window.ambientDesktop.updateThreadSettings({
          threadId: id,
          collaborationMode: "agent",
          model: threadInput.model,
          thinkingLevel: threadInput.thinkingLevel,
          memoryEnabled: false,
        });
      }
      await window.ambientDesktop.selectThread(id);
      return id;
    },
    input,
  );
  if (!threadId) throw new Error(`createThread did not return an active thread id for ${input.title}.`);
  await reloadRendererForThread(cdpClient, threadId);
  return threadId;
}

async function reloadRendererForThread(cdpClient, threadId) {
  await cdpClient.send("Page.reload", { ignoreCache: true }, { timeoutMs: 30_000 });
  await waitForText(cdpClient, "Ambient", appWaitTimeoutMs);
  await evaluate(
    cdpClient,
    async (id) => {
      await window.ambientDesktop.selectThread(id);
      return window.ambientDesktop.bootstrap();
    },
    threadId,
  );
  await installLiveCollector(cdpClient);
}

async function runPromptTurn(cdpClient, input) {
  await resetLiveCollector(cdpClient);
  const beforeMessageIds = await threadMessageIds(cdpClient, input.threadId);
  await evaluate(
    cdpClient,
    async (turn) => {
      const live = window.__ambientPromptCacheDogfood;
      await window.ambientDesktop.selectThread(turn.threadId);
      window.ambientDesktop
        .sendMessage({
          threadId: turn.threadId,
          content: turn.content,
          permissionMode: "workspace",
          collaborationMode: "agent",
          model: turn.model,
          thinkingLevel: "xhigh",
        })
        .then(() => {
          live.sendResolved = true;
        })
        .catch((error) => {
          live.error = error instanceof Error ? error.message : String(error);
        });
      return true;
    },
    { ...input, model: dogfoodModelId() },
  );
  return waitForPromptCacheEvidence(cdpClient, {
    ...input,
    beforeMessageIds,
  });
}

async function waitForPromptCacheEvidence(cdpClient, input) {
  const deadline = Date.now() + chatTurnTimeoutMs;
  let latestEvidence;
  while (Date.now() < deadline) {
    const live = await getLiveState(cdpClient);
    if (live?.error) throw new Error(live.error);
    latestEvidence = await collectPromptCacheEvidence(cdpClient, input);
    if (
      latestEvidence.assistantMarkerPresent &&
      acceptedPromptCacheStatuses(input).includes(latestEvidence.finalPromptCache?.status) &&
      latestEvidence.thinkingPromptCacheStatuses.length > 0 &&
      latestEvidence.promptCacheMessageBadges.length > 0 &&
      latestEvidence.promptCacheMessageBadges.every((row) => promptCacheBadgeRowMatchesTelemetry(row, input)) &&
      (input.minimumCacheReadExclusive === undefined || latestEvidence.maxCacheRead > input.minimumCacheReadExclusive)
    ) {
      return {
        ...latestEvidence,
        live,
        expectedStatus: input.expectedStatus ?? latestEvidence.finalPromptCache?.status,
        acceptedStatuses: acceptedPromptCacheStatuses(input),
        label: input.label,
      };
    }
    await delay(1_000);
  }
  throw new Error(
    `Timed out waiting for ${input.label} prompt cache ${input.expectedStatus} evidence. Latest evidence: ${JSON.stringify(latestEvidence, null, 2)}`,
  );
}

async function collectPromptCacheEvidence(cdpClient, input) {
  return evaluate(
    cdpClient,
    async (turn) => {
      await window.ambientDesktop.selectThread(turn.threadId);
      const state = await window.ambientDesktop.bootstrap();
      const before = new Set(turn.beforeMessageIds);
      const messages = (state.messages ?? []).filter((message) => message.threadId === turn.threadId);
      const newMessages = messages.filter((message) => !before.has(message.id));
      const finalAssistantMessages = newMessages.filter((message) => message.role === "assistant" && message.metadata?.kind !== "thinking");
      const finalAssistant =
        [...finalAssistantMessages].reverse().find((message) => String(message.content ?? "").includes(turn.expectedMarker)) ??
        finalAssistantMessages.at(-1);
      const thinkingMessages = newMessages.filter((message) => message.role === "assistant" && message.metadata?.kind === "thinking");
      const badgeLabelsForMessage = (messageId) => {
        if (!messageId) return [];
        const escaped = window.CSS?.escape ? window.CSS.escape(messageId) : String(messageId).replace(/"/g, '\\"');
        return [...document.querySelectorAll(`[data-message-id="${escaped}"] .message-prompt-cache-badge`)]
          .map((element) => element.textContent?.trim() ?? "")
          .filter(Boolean);
      };
      const finalBadgeLabels = badgeLabelsForMessage(finalAssistant?.id);
      const finalPromptCache = finalAssistant?.metadata?.promptCache;
      const thinkingBadgeLabels = thinkingMessages.map((message) => ({
        messageId: message.id,
        status: message.metadata?.promptCache?.status,
        cacheRead: message.metadata?.promptCache?.usage?.cacheRead,
        labels: badgeLabelsForMessage(message.id),
      }));
      const promptCacheMessageBadges = [
        {
          messageId: finalAssistant?.id,
          kind: "assistant",
          status: finalPromptCache?.status,
          cacheRead: finalPromptCache?.usage?.cacheRead,
          labels: finalBadgeLabels,
        },
        ...thinkingBadgeLabels.map((row) => ({ ...row, kind: "thinking" })),
      ].filter((row) => row.messageId && typeof row.status === "string");
      const cacheReadValues = promptCacheMessageBadges
        .map((row) => Number(row.cacheRead))
        .filter((value) => Number.isFinite(value));
      const visibleBadgeLabels = [...document.querySelectorAll(".message-prompt-cache-badge")]
        .map((element) => element.textContent?.trim() ?? "")
        .filter(Boolean);
      return {
        threadId: turn.threadId,
        expectedMarker: turn.expectedMarker,
        newMessageCount: newMessages.length,
        finalAssistantId: finalAssistant?.id,
      finalAssistantContentTail: String(finalAssistant?.content ?? "").slice(-1000),
      assistantMarkerPresent: String(finalAssistant?.content ?? "").includes(turn.expectedMarker),
      finalPromptCache,
      finalBadgeLabels,
      thinkingMessageIds: thinkingMessages.map((message) => message.id),
      thinkingPromptCacheStatuses: thinkingMessages
        .map((message) => message.metadata?.promptCache?.status)
        .filter((status) => typeof status === "string"),
      thinkingPromptCacheTelemetry: thinkingMessages.map((message) => message.metadata?.promptCache),
      thinkingBadgeLabels,
      promptCacheMessageBadges,
      maxCacheRead: cacheReadValues.length > 0 ? Math.max(...cacheReadValues) : 0,
      visibleBadgeLabels,
        bodyTail: document.body?.innerText?.slice(-4000) ?? "",
      };
    },
    input,
  );
}

async function threadMessageIds(cdpClient, threadId) {
  return evaluate(
    cdpClient,
    async (id) => {
      await window.ambientDesktop.selectThread(id);
      const state = await window.ambientDesktop.bootstrap();
      return (state.messages ?? []).filter((message) => message.threadId === id).map((message) => message.id);
    },
    threadId,
  );
}

function assertPromptCacheDogfood({ firstTurn, secondTurn, changedTurn, settingsEvidence }) {
  const failures = [];
  if (settingsEvidence?.afterThinkingDisplay?.mode !== "full") failures.push("thinking display was not Full");
  if (settingsEvidence?.afterModelRuntime?.showPromptCacheStatus !== true)
    failures.push("Show prompt cache status setting was not enabled");
  assertTurnMatchesTelemetry(firstTurn, ["hit", "miss"], failures);
  assertTurnMatchesTelemetry(secondTurn, ["hit", "miss"], failures);
  assertTurnHasIncreasedCacheRead(secondTurn, firstTurn, failures);
  assertTurnMatchesTelemetry(changedTurn, ["hit", "miss"], failures);
  const secondCacheRead = maxCacheRead(secondTurn);
  if (failures.length > 0) throw new Error(`Prompt cache status dogfood failed:\n- ${failures.join("\n- ")}`);
  return {
    settingEnabled: true,
    thinkingDisplayFull: true,
    firstStatus: firstTurn.finalPromptCache?.status,
    repeatedStatus: secondTurn.finalPromptCache?.status,
    changedStatus: changedTurn.finalPromptCache?.status,
    firstMaxCacheRead: maxCacheRead(firstTurn),
    repeatedCacheRead: secondCacheRead,
    repeatedHitMessageKinds: secondTurn.promptCacheMessageBadges
      .filter((row) => row.status === "hit")
      .map((row) => row.kind),
    thinkingBadgeStatuses: {
      first: firstTurn.thinkingPromptCacheStatuses,
      repeated: secondTurn.thinkingPromptCacheStatuses,
      changed: changedTurn.thinkingPromptCacheStatuses,
    },
  };
}

function acceptedPromptCacheStatuses(input) {
  if (Array.isArray(input.acceptedStatuses)) return input.acceptedStatuses;
  return [input.expectedStatus];
}

function promptCacheBadgeRowMatchesTelemetry(row, input) {
  if (!acceptedPromptCacheStatuses(input).includes(row.status)) return false;
  return row.labels.some((label) => label.includes(expectedBadgeText(row.status)));
}

function assertTurn(turn, expectedStatus, failures) {
  if (!turn.assistantMarkerPresent) failures.push(`${turn.label} assistant marker was missing`);
  if (turn.finalPromptCache?.status !== expectedStatus) {
    failures.push(
      `${turn.label} final assistant prompt cache status was ${JSON.stringify(turn.finalPromptCache?.status)}, expected ${expectedStatus}`,
    );
  }
  if (!turn.thinkingPromptCacheStatuses.length) failures.push(`${turn.label} had no visible thinking prompt cache status`);
  const mismatchedThinking = turn.thinkingPromptCacheStatuses.filter((status) => status !== expectedStatus);
  if (mismatchedThinking.length > 0) {
    failures.push(
      `${turn.label} thinking prompt cache statuses included ${JSON.stringify(mismatchedThinking)}, expected ${expectedStatus}`,
    );
  }
  assertPromptCacheRowsMatchTelemetry(turn, [expectedStatus], failures);
}

function assertTurnMatchesTelemetry(turn, acceptedStatuses, failures) {
  const status = turn.finalPromptCache?.status;
  if (!acceptedStatuses.includes(status)) {
    failures.push(
      `${turn.label} final assistant prompt cache status was ${JSON.stringify(status)}, expected one of ${acceptedStatuses.join(", ")}`,
    );
    return;
  }
  if (!turn.assistantMarkerPresent) failures.push(`${turn.label} assistant marker was missing`);
  if (!turn.thinkingPromptCacheStatuses.length) failures.push(`${turn.label} had no visible thinking prompt cache status`);
  assertPromptCacheRowsMatchTelemetry(turn, acceptedStatuses, failures);
}

function assertPromptCacheRowsMatchTelemetry(turn, acceptedStatuses, failures) {
  const mismatchedRows = turn.promptCacheMessageBadges.filter(
    (row) => !acceptedStatuses.includes(row.status) || !row.labels.some((label) => label.includes(expectedBadgeText(row.status))),
  );
  if (mismatchedRows.length > 0) {
    failures.push(`${turn.label} prompt cache badges did not match telemetry: ${JSON.stringify(mismatchedRows)}`);
  }
}

function assertTurnHasIncreasedCacheRead(turn, baselineTurn, failures) {
  const baseline = maxCacheRead(baselineTurn);
  const current = maxCacheRead(turn);
  if (!(current > baseline)) {
    failures.push(`${turn.label} did not increase cached-token evidence above baseline ${baseline}; got ${current}`);
  }
  if (!turn.promptCacheMessageBadges.some((row) => row.status === "hit" && Number(row.cacheRead) > baseline)) {
    failures.push(`${turn.label} did not include a message-scoped hit badge above baseline ${baseline}`);
  }
}

function maxCacheRead(turn) {
  const values = (turn.promptCacheMessageBadges ?? [])
    .map((row) => Number(row.cacheRead))
    .filter((value) => Number.isFinite(value));
  return values.length > 0 ? Math.max(...values) : 0;
}

function expectedBadgeText(status) {
  if (status === "hit") return "Prompt cache hit";
  if (status === "miss") return "Prompt cache miss";
  if (status === "unknown") return "Prompt cache unknown";
  return "Prompt cache pending";
}

function summarizeTurn(turn) {
  return {
    label: turn.label,
    threadId: turn.threadId,
    expectedStatus: turn.expectedStatus,
    finalAssistantId: turn.finalAssistantId,
    finalPromptCache: turn.finalPromptCache,
    finalBadgeLabels: turn.finalBadgeLabels,
    thinkingMessageIds: turn.thinkingMessageIds,
    thinkingPromptCacheStatuses: turn.thinkingPromptCacheStatuses,
    thinkingBadgeLabels: turn.thinkingBadgeLabels,
    promptCacheMessageBadges: turn.promptCacheMessageBadges,
    maxCacheRead: turn.maxCacheRead,
    visibleBadgeLabels: turn.visibleBadgeLabels,
    newMessageCount: turn.newMessageCount,
    statuses: turn.live?.statuses?.slice(-8) ?? [],
  };
}

async function captureElectronEvidence(cdpClient, label) {
  const session = `prompt-cache-status-${process.pid}`;
  const snapshotPath = join(resultsDir, `${label}-agent-browser-snapshot.txt`);
  const screenshotPath = join(resultsDir, `${label}-agent-browser-screenshot.png`);
  await mkdir(resultsDir, { recursive: true });
  if (!agentBrowserAvailable()) {
    return captureCdpElectronEvidence(cdpClient, { label, session, snapshotPath, screenshotPath });
  }
  await runCaptured("agent-browser", ["--session", session, "connect", String(dogfoodCdpPort())], 30_000);
  const snapshot = await runCaptured("agent-browser", ["--session", session, "snapshot", "-i"], 30_000);
  await writeFile(snapshotPath, snapshot.stdout || snapshot.stderr, "utf8");
  await runCaptured("agent-browser", ["--session", session, "screenshot", screenshotPath], 30_000);
  const screenshotStat = await stat(screenshotPath);
  if (screenshotStat.size < 1_000) throw new Error(`agent-browser screenshot was unexpectedly small: ${screenshotStat.size} bytes.`);
  return {
    source: "agent-browser electron skill",
    label,
    session,
    cdpPort: dogfoodCdpPort(),
    snapshotPath: outputPathRelative(snapshotPath),
    snapshotPreview: (snapshot.stdout || snapshot.stderr).slice(0, 1200),
    screenshotPath: outputPathRelative(screenshotPath),
    screenshotBytes: screenshotStat.size,
  };
}

async function captureCdpElectronEvidence(cdpClient, input) {
  const snapshotText = await bodyText(cdpClient).catch(
    (error) => `CDP body text unavailable: ${error instanceof Error ? error.message : String(error)}`,
  );
  await writeFile(input.snapshotPath, snapshotText || "(empty body text)", "utf8");
  const screenshot = await cdpClient.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, { timeoutMs: 30_000 });
  await writeFile(input.screenshotPath, Buffer.from(screenshot.data, "base64"));
  const screenshotStat = await stat(input.screenshotPath);
  if (screenshotStat.size < 1_000) throw new Error(`CDP fallback screenshot was unexpectedly small: ${screenshotStat.size} bytes.`);
  return {
    source: "cdp fallback; agent-browser unavailable",
    label: input.label,
    session: input.session,
    cdpPort: dogfoodCdpPort(),
    snapshotPath: outputPathRelative(input.snapshotPath),
    snapshotPreview: snapshotText.slice(0, 1200),
    screenshotPath: outputPathRelative(input.screenshotPath),
    screenshotBytes: screenshotStat.size,
  };
}

function agentBrowserAvailable() {
  if (cachedAgentBrowserAvailable !== undefined) return cachedAgentBrowserAvailable;
  const result = spawnSync("agent-browser", ["--help"], {
    cwd: repoRoot,
    stdio: "ignore",
    env: cleanChildEnv(process.env),
  });
  cachedAgentBrowserAvailable = result.status === 0;
  return cachedAgentBrowserAvailable;
}

async function installLiveCollector(cdpClient) {
  await evaluate(cdpClient, () => {
    window.__ambientPromptCacheDogfood?.unsubscribe?.();
    window.__ambientPromptCacheDogfood = {
      statuses: [],
      runtimeActivities: [],
      assistantTail: "",
      sawRunStart: false,
      sawRunIdle: false,
      sendResolved: true,
      error: undefined,
    };
    window.__ambientPromptCacheDogfood.unsubscribe = window.ambientDesktop.onEvent((event) => {
      const live = window.__ambientPromptCacheDogfood;
      if (event.type === "run-status") {
        live.statuses.push(event.status);
        if (event.status !== "idle") live.sawRunStart = true;
        if (live.sawRunStart && event.status === "idle") live.sawRunIdle = true;
      }
      if (event.type === "runtime-activity") {
        live.runtimeActivities.push({
          kind: event.activity?.kind,
          status: event.activity?.status,
          message: event.activity?.message,
          toolName: event.activity?.toolName,
          thinkingChars: event.activity?.thinkingChars,
        });
        live.runtimeActivities = live.runtimeActivities.slice(-80);
      }
      if (event.type === "message-delta") {
        live.assistantTail = (live.assistantTail + String(event.delta ?? "")).slice(-8000);
      }
      if (event.type === "error") live.error = event.message;
    });
    return true;
  });
}

async function resetLiveCollector(cdpClient) {
  await evaluate(cdpClient, () => {
    const live = window.__ambientPromptCacheDogfood;
    if (!live) return false;
    live.statuses = [];
    live.runtimeActivities = [];
    live.assistantTail = "";
    live.sawRunStart = false;
    live.sawRunIdle = false;
    live.sendResolved = false;
    live.error = undefined;
    return true;
  });
}

async function getLiveState(cdpClient) {
  return evaluate(cdpClient, () => {
    const live = window.__ambientPromptCacheDogfood;
    return live
      ? {
          statuses: live.statuses,
          runtimeActivities: live.runtimeActivities,
          assistantTail: live.assistantTail,
          sawRunStart: live.sawRunStart,
          sawRunIdle: live.sawRunIdle,
          sendResolved: live.sendResolved,
          error: live.error,
        }
      : undefined;
  });
}

function launchDesktop(input) {
  return spawn("pnpm", ["exec", "electron-vite", "dev", "--", `--remote-debugging-port=${dogfoodCdpPort()}`], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: buildDogfoodEnv({
      extra: {
        AMBIENT_E2E: "1",
        AMBIENT_DESKTOP_WORKSPACE: input.workspacePath,
        AMBIENT_E2E_USER_DATA: input.userDataPath,
        AMBIENT_AUTHORITY_STATE_ROOT: input.authorityStateRoot,
      },
    }),
  });
}

async function connectToElectron(port, child) {
  const started = Date.now();
  let lastOutput = "";
  child.stdout?.on("data", (chunk) => {
    lastOutput = `${lastOutput}${chunk.toString()}`.slice(-8000);
  });
  child.stderr?.on("data", (chunk) => {
    lastOutput = `${lastOutput}${chunk.toString()}`.slice(-8000);
  });
  while (Date.now() - started < 60_000) {
    if (child.exitCode !== null) throw new Error(`Electron exited before CDP was available.\n${lastOutput}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
        if (page?.webSocketDebuggerUrl) return createCdpClient(page.webSocketDebuggerUrl);
      }
    } catch {
      // Keep polling until Electron exposes the debugger endpoint.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for Electron CDP on port ${port}.\n${lastOutput}`);
}

function createCdpClient(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (typeof message.id !== "number") return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message || "CDP command failed"));
    else waiter.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const waiter of pending.values()) waiter.reject(new Error("CDP socket closed"));
    pending.clear();
  });
  return {
    send(method, params = {}, options = {}) {
      const id = nextId++;
      const timeoutMs = options.timeoutMs ?? cdpCommandTimeoutMs;
      const ready =
        socket.readyState === WebSocket.OPEN
          ? Promise.resolve()
          : new Promise((resolveReady, rejectReady) => {
              const timeout = setTimeout(() => {
                rejectReady(new Error(`Timed out waiting for CDP socket open after ${timeoutMs}ms.`));
              }, timeoutMs);
              socket.addEventListener(
                "open",
                () => {
                  clearTimeout(timeout);
                  resolveReady();
                },
                { once: true },
              );
              socket.addEventListener(
                "error",
                () => {
                  clearTimeout(timeout);
                  rejectReady(new Error("CDP socket failed to open."));
                },
                { once: true },
              );
            });
      return ready.then(
        () =>
          new Promise((resolveSend, rejectSend) => {
            const timeout = setTimeout(() => {
              pending.delete(id);
              rejectSend(new Error(`Timed out waiting for CDP ${method} after ${timeoutMs}ms.`));
            }, timeoutMs);
            pending.set(id, {
              resolve: (value) => {
                clearTimeout(timeout);
                resolveSend(value);
              },
              reject: (error) => {
                clearTimeout(timeout);
                rejectSend(error);
              },
            });
            socket.send(JSON.stringify({ id, method, params }));
          }),
      );
    },
    close() {
      socket.close();
    },
  };
}

async function waitForText(cdpClient, text, timeoutMs) {
  await waitFor(cdpClient, (expected) => document.body.innerText.includes(expected), timeoutMs, text);
}

async function waitFor(cdpClient, predicate, timeoutMs, ...args) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      if (await evaluate(cdpClient, predicate, ...args)) return;
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  const body = await bodyText(cdpClient).catch(() => "");
  throw new Error(
    `Timed out waiting for Electron UI condition.${lastError ? ` Last error: ${lastError.message}` : ""}\n\nBody tail:\n${body.slice(-2000)}`,
  );
}

async function evaluate(cdpClient, fnOrExpression, ...args) {
  const expression =
    typeof fnOrExpression === "function" ? `(${fnOrExpression.toString()})(...${JSON.stringify(args)})` : String(fnOrExpression);
  const result = await cdpClient.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(`Runtime.evaluate failed: ${JSON.stringify(result.exceptionDetails)}`);
  return result.result?.value;
}

async function bodyText(cdpClient) {
  return evaluate(cdpClient, () => document.body.innerText);
}

async function setViewport(cdpClient, width, height) {
  await cdpClient.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function writeScreenshot(cdpClient, name) {
  await mkdir(resultsDir, { recursive: true });
  const result = await cdpClient.send("Page.captureScreenshot", { format: "png", fromSurface: true }, { timeoutMs: 30_000 });
  const outputPath = join(resultsDir, name);
  await writeFile(outputPath, Buffer.from(result.data, "base64"));
  const screenshotStat = await stat(outputPath);
  if (screenshotStat.size < 1_000) throw new Error(`Screenshot ${name} was unexpectedly small: ${screenshotStat.size} bytes.`);
  return outputPath;
}

async function createScratch() {
  const root = await mkdtemp(join(tmpdir(), "ambient-prompt-cache-status-"));
  const workspacePath = resolve(join(root, "workspace"));
  const userDataPath = resolve(join(root, "userData"));
  const authorityStateRoot = resolve(join(userDataPath, "authority-state"));
  await mkdir(workspacePath, { recursive: true });
  await mkdir(userDataPath, { recursive: true });
  const sourceUserData = sourceUserDataPath();
  if (sourceUserData) {
    await cp(sourceUserData, userDataPath, { recursive: true, force: true });
  }
  await writeFile(
    join(workspacePath, "README.md"),
    "# Prompt Cache Status Dogfood\n\nThis workspace is disposable and validates live prompt-cache UI telemetry.\n",
    "utf8",
  );
  return { root, workspacePath, userDataPath, authorityStateRoot };
}

function sourceUserDataPath() {
  const value = process.env.AMBIENT_PROMPT_CACHE_DOGFOOD_SOURCE_USER_DATA || process.env.AMBIENT_E2E_USER_DATA;
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!existsSync(trimmed)) throw new Error("Configured prompt cache dogfood source userData path does not exist.");
  return trimmed;
}

async function writeReport(value) {
  await mkdir(resultsDir, { recursive: true });
  const next = {
    ...value,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - Date.parse(value.startedAt),
  };
  await writeFile(latestReportPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  const runReportPath = join(resultsDir, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(runReportPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

async function run(command, commandArgs, env) {
  const child = spawn(command, commandArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    env,
  });
  const [code, signal] = await once(child, "exit");
  if (code !== 0) throw new Error(`${command} ${commandArgs.join(" ")} failed with ${signal ?? code}.`);
}

async function runCaptured(command, commandArgs, timeoutMs) {
  const child = spawn(command, commandArgs, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: cleanChildEnv(process.env),
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const timeout = delay(timeoutMs).then(() => "timeout");
  const exit = once(child, "exit").then(([code, signal]) => ({ code, signal }));
  const result = await Promise.race([timeout, exit]);
  if (result === "timeout") {
    child.kill("SIGTERM");
    throw new Error(`${command} ${commandArgs.join(" ")} timed out after ${timeoutMs}ms.\n${stderr}`);
  }
  if (result.code !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(" ")} failed with ${result.signal ?? result.code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  return { stdout, stderr };
}

async function terminateProcessTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    // Best effort cleanup.
  }
  if (await waitForAppExit(child, 5_000)) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    // Best effort cleanup.
  }
}

async function waitForAppExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const timeout = delay(timeoutMs).then(() => false);
  const exited = new Promise((resolveExit) => child.once("exit", () => resolveExit(true)));
  return Promise.race([timeout, exited]);
}

function buildDogfoodEnv(input = {}) {
  const providerId = dogfoodProviderId();
  const modelId = input.modelId ?? dogfoodModelId(providerId);
  const apiKeyFile = ambientApiKeyFilePath();
  const keyFileEnv = apiKeyFile
    ? {
        AMBIENT_API_KEY_FILE: apiKeyFile,
        AMBIENT_AGENT_AMBIENT_API_KEY_FILE: process.env.AMBIENT_AGENT_AMBIENT_API_KEY_FILE || apiKeyFile,
      }
    : {};
  return cleanChildEnv({
    ...process.env,
    ...(input.extra ?? {}),
    ...keyFileEnv,
    AMBIENT_PROVIDER: providerId,
    ...(providerId === "gmi-cloud" ? { GMI_CLOUD_MODEL: modelId } : { AMBIENT_LIVE_MODEL: modelId }),
  });
}

function ambientApiKeyFilePath() {
  if (process.env.AMBIENT_API_KEY_FILE) return process.env.AMBIENT_API_KEY_FILE;
  if (process.env.AMBIENT_AGENT_AMBIENT_API_KEY_FILE) return process.env.AMBIENT_AGENT_AMBIENT_API_KEY_FILE;
  let current = repoRoot;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(current, "ignored-provider-key-file.txt");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const siblingCheckoutCandidate = join(dirname(repoRoot), "ambientCoder", "ignored-provider-key-file.txt");
  if (existsSync(siblingCheckoutCandidate)) return siblingCheckoutCandidate;
  return undefined;
}

function ambientKeyConfigured() {
  return Boolean(process.env.AMBIENT_API_KEY || process.env.AMBIENT_AGENT_AMBIENT_API_KEY || ambientApiKeyFilePath());
}

function dogfoodProviderId() {
  return process.env.AMBIENT_PROVIDER || defaultProvider;
}

function dogfoodModelId(providerId = dogfoodProviderId()) {
  return providerId === "gmi-cloud"
    ? process.env.GMI_CLOUD_MODEL || process.env.AMBIENT_MODEL || kimiModel
    : process.env.AMBIENT_LIVE_MODEL || process.env.AMBIENT_MODEL || kimiModel;
}

function dogfoodCdpPort() {
  const parsed = Number(process.env.AMBIENT_HARNESS_CDP_PORT || process.env.AMBIENT_SUBAGENT_DESKTOP_DOGFOOD_CDP_PORT);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 19791;
}

function cleanChildEnv(env) {
  const next = { ...env };
  delete next.NODE_OPTIONS;
  delete next.VITEST;
  return next;
}

function outputPathRelative(path) {
  const rel = relative(repoRoot, path);
  return rel && !rel.startsWith("..") ? rel : path;
}
