#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const port = Number(process.env.AMBIENT_STT_QUEUE_BARGE_LIVE_CDP_PORT ?? 9482);
const timeoutMs = Number(process.env.AMBIENT_STT_QUEUE_BARGE_LIVE_TIMEOUT_MS ?? 420_000);
const workspace = await mkdtemp(join(tmpdir(), "ambient-stt-queue-barge-live-"));
const diagnosticsPath = join(workspace, "stt-queue-barge-live-summary.json");
const fixturePath = process.env.AMBIENT_STT_QUEUE_BARGE_LIVE_AUDIO_PATH || join(process.cwd(), ".ambient", "stt-spike", "fixtures", "en-short-clean.wav");
const realQwen = process.env.AMBIENT_STT_QUEUE_BARGE_LIVE_REAL_QWEN === "1";
const fakeTranscript = "This queued speech follow-up came from Qwen STT. Reply with exactly QUEUED_STT_FOLLOWUP_DONE.";
const initialDoneToken = "INITIAL_STT_QUEUE_BARGE_DONE";
const followUpDoneToken = "QUEUED_STT_FOLLOWUP_DONE";
const output = [];
const children = new Set();
const ambientApiKey = await readAmbientApiKey();
let appInstance;

try {
  if (!existsSync(fixturePath)) throw new Error(`STT queue/barge live audio fixture was not found: ${fixturePath}`);
  await writeFile(
    join(workspace, "README.md"),
    [
      "# Ambient STT queue/barge-in live workspace",
      "",
      "This temporary workspace validates queued speech follow-ups and TTS barge-in through Desktop IPC.",
      "",
    ].join("\n"),
    "utf8",
  );

  appInstance = await launchApp();
  const summary = await runSttQueueBargeLiveSmoke(appInstance.cdp);
  await writeFile(diagnosticsPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(outputTail());
  throw error;
} finally {
  if (appInstance) {
    appInstance.cdp.close();
    await terminateProcessTree(appInstance.child);
  }
  for (const child of children) await terminateProcessTree(child);
  await terminateDebugPortProcesses();
  if (process.env.AMBIENT_STT_QUEUE_BARGE_LIVE_KEEP_WORKSPACE !== "1") {
    await rm(workspace, { recursive: true, force: true });
  } else {
    console.error(`Keeping STT queue/barge workspace: ${workspace}`);
  }
}

console.log("Live Ambient STT queue/barge-in smoke passed.");

async function launchApp() {
  const child = spawn(
    "pnpm",
    ["exec", "electron-vite", "dev", "--", `--remote-debugging-port=${port}`],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AMBIENT_DESKTOP_WORKSPACE: workspace,
        AMBIENT_E2E: "1",
        AMBIENT_E2E_DIAGNOSTICS_PATH: diagnosticsPath,
        ...(ambientApiKey ? { AMBIENT_API_KEY: ambientApiKey, AMBIENT_AGENT_AMBIENT_API_KEY: ambientApiKey } : {}),
        ...(realQwen
          ? {}
          : {
              AMBIENT_QWEN3_ASR_BINARY: process.execPath,
              AMBIENT_QWEN3_ASR_FAKE_TRANSCRIPT: fakeTranscript,
            }),
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
  await waitFor(cdp, () => document.body?.innerText.includes("Ambient"), "main shell", 30_000);
  return { child, cdp };
}

async function runSttQueueBargeLiveSmoke(cdp) {
  const state = await desktopState(cdp);
  if (!state.provider.hasApiKey) {
    throw new Error("Ambient API key is missing. Set AMBIENT_API_KEY, AMBIENT_AGENT_AMBIENT_API_KEY, AMBIENT_API_KEY_FILE, or place ignored-provider-key-file.txt near the repo.");
  }
  const keyCheck = await evaluate(cdp, "window.ambientDesktop.testAmbientApiKey()");
  if (!keyCheck?.ok) throw new Error(`Ambient API key check failed: ${keyCheck?.message ?? "unknown error"}`);

  const audioBase64 = (await readFile(fixturePath)).toString("base64");
  const audio = await evaluate(
    cdp,
    `window.ambientDesktop.saveSttTestAudio(${JSON.stringify({
      source: "settings-microphone",
      audioBase64,
    })})`,
  );
  if (!audio?.audioPath) throw new Error(`Failed to seed managed STT audio: ${JSON.stringify(audio)}`);

  const setup = await evaluate(
    cdp,
    `window.ambientDesktop.setupSttProvider(${JSON.stringify({
      provider: "qwen3-asr",
      action: "repair",
      installRuntime: realQwen,
      validationAudioPath: audio.audioPath,
      spokenLanguage: "English",
      selectProvider: true,
      enable: true,
    })})`,
  );
  if (setup?.status !== "ready" || !setup?.selectedProvider?.available) {
    throw new Error(`Qwen3-ASR setup did not become ready: ${JSON.stringify(setup, null, 2)}`);
  }

  const preparedState = await desktopState(cdp);
  await evaluate(
    cdp,
    `window.ambientDesktop.updateSttSettings(${JSON.stringify({
      ...preparedState.settings.stt,
      enabled: true,
      providerCapabilityId: setup.selectedProvider.capabilityId,
      spokenLanguage: "English",
      mode: "push-to-talk",
      autoSendAfterTranscription: true,
      silenceFinalizeSeconds: 0.8,
      noSpeechGate: { enabled: true, rmsThresholdDbfs: -55 },
      bargeIn: { stopTtsOnSpeech: true, queueWhileAgentRuns: true },
    })})`,
  );

  await installLiveEventCollector(cdp);
  await sendInitialPrompt(cdp, {
    threadId: preparedState.activeThreadId,
    content: [
      "This is a live Ambient STT queue and barge-in dogfood.",
      "Do not use tools.",
      "Reply with one short sentence, then write exactly:",
      initialDoneToken,
    ].join("\n"),
    permissionMode: "workspace",
    collaborationMode: "agent",
    model: process.env.AMBIENT_STT_QUEUE_BARGE_LIVE_MODEL || preparedState.settings.model,
    thinkingLevel: "low",
    context: [],
  });
  await waitFor(cdp, () => window.__ambientSttQueueBarge?.statuses?.some((status) => status !== "idle"), "Ambient run start", 45_000);

  await evaluate(cdp, "window.ambientDesktop.setSttTtsSpeaking({ speaking: true })");
  const utteranceId = `stt-queue-barge-${Date.now().toString(36)}`;
  const transcription = await evaluate(
    cdp,
    `window.ambientDesktop.transcribeSttAudio(${JSON.stringify({
      threadId: preparedState.activeThreadId,
      utteranceId,
      audioPath: audio.audioPath,
    })})`,
  );
  if (transcription?.state?.status !== "ready") {
    throw new Error(`Expected ready STT transcription while run was active: ${JSON.stringify(transcription, null, 2)}`);
  }
  if (!realQwen && transcription.state.text !== fakeTranscript) {
    throw new Error(`Fake Qwen transcript did not round-trip. Transcript: ${JSON.stringify(transcription.state.text)}`);
  }

  await waitFor(cdp, () => (window.__ambientSttQueueBarge?.stopTtsRequests ?? 0) > 0, "STT stop-TTS request", 30_000);

  const stt = sttMetadataFromTranscription(transcription.state);
  await sendSpeechFollowUp(cdp, {
    threadId: preparedState.activeThreadId,
    content: transcription.state.text,
    permissionMode: "workspace",
    collaborationMode: "agent",
    model: process.env.AMBIENT_STT_QUEUE_BARGE_LIVE_MODEL || preparedState.settings.model,
    thinkingLevel: "low",
    delivery: "follow-up",
    context: [],
    stt,
  });
  await waitFor(
    cdp,
    () => window.__ambientSttQueueBarge?.sttUserMessages?.some((message) => (
      message.status === "queued" &&
      message.delivery === "follow-up" &&
      message.sttUtteranceId?.startsWith("stt-queue-barge-")
    )),
    "visible queued STT follow-up",
    45_000,
  );

  const completion = await waitForCompletion(cdp, timeoutMs);
  const live = await getLiveState(cdp);
  const finalState = await desktopState(cdp);
  const sttUserMessages = finalState.messages.filter((message) => message.role === "user" && message.metadata?.stt?.utteranceId === utteranceId);
  const assistantText = finalState.messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.content)
    .join("\n");
  const queuedTranscriptNeedle = transcription.state.text.slice(0, 48);

  if (!sttUserMessages.length) throw new Error(`Final Desktop state does not include the queued STT user message for ${utteranceId}.`);
  if (!live.queueEvents.some((queue) => queue.followUp?.some((item) => item.includes(queuedTranscriptNeedle)))) {
    throw new Error(`Desktop queue events did not expose the STT follow-up. Events: ${JSON.stringify(live.queueEvents)}`);
  }
  if (!live.sttQueueEvents.some((queue) => queue.queuedUtteranceIds?.includes(utteranceId))) {
    throw new Error(`STT queue events did not include ${utteranceId}. Events: ${JSON.stringify(live.sttQueueEvents)}`);
  }
  if (!assistantText.includes(initialDoneToken)) {
    throw new Error(`Initial Ambient run did not finish with ${initialDoneToken}. Assistant text: ${assistantText.slice(-1500)}`);
  }

  return {
    workspace,
    audioPath: audio.audioPath,
    model: process.env.AMBIENT_STT_QUEUE_BARGE_LIVE_MODEL || preparedState.settings.model,
    qwenMode: realQwen ? "real" : "fake-transcript",
    providerCapabilityId: setup.selectedProvider.capabilityId,
    setupStatus: setup.status,
    utteranceId,
    transcriptionStatus: transcription.state.status,
    transcriptionText: transcription.state.text,
    returnedSttQueue: transcription.queue,
    stopTtsRequests: live.stopTtsRequests,
    queuedSttMessageCount: live.sttUserMessages.filter((message) => message.status === "queued" && message.sttUtteranceId === utteranceId).length,
    finalSttMessageStatuses: sttUserMessages.map((message) => message.metadata?.status ?? "sent"),
    queueEventCount: live.queueEvents.length,
    sttQueueEventCount: live.sttQueueEvents.length,
    statuses: live.statuses,
    initialTokenMatched: assistantText.includes(initialDoneToken),
    followUpTokenMatched: assistantText.includes(followUpDoneToken),
    completion,
  };
}

async function installLiveEventCollector(cdp) {
  await evaluate(
    cdp,
    `
    (() => {
      window.__ambientSttQueueBarge?.unsubscribe?.();
      window.__ambientSttQueueBarge = {
        statuses: [],
        queueEvents: [],
        sttQueueEvents: [],
        sttUserMessages: [],
        stopTtsRequests: 0,
        sawRunStart: false,
        sawRunIdle: false,
        initialSendResolved: false,
        followUpSendResolved: false,
        error: undefined,
      };
      window.__ambientSttQueueBarge.unsubscribe = window.ambientDesktop.onEvent((event) => {
        const live = window.__ambientSttQueueBarge;
        if (event.type === "run-status") {
          live.statuses.push(event.status);
          if (event.status !== "idle") live.sawRunStart = true;
          if (live.sawRunStart && event.status === "idle") live.sawRunIdle = true;
        }
        if (event.type === "queue-updated") live.queueEvents.push(event.queue);
        if (event.type === "stt-queue-updated") live.sttQueueEvents.push(event.queue);
        if (event.type === "stt-stop-tts-requested") live.stopTtsRequests += 1;
        if ((event.type === "message-created" || event.type === "message-updated") && event.message?.role === "user" && event.message.metadata?.stt) {
          live.sttUserMessages.push({
            id: event.message.id,
            content: event.message.content,
            status: event.message.metadata.status,
            delivery: event.message.metadata.delivery,
            sttUtteranceId: event.message.metadata.stt.utteranceId,
            sttStatus: event.message.metadata.stt.status,
            hasTranscriptArtifact: Boolean(event.message.metadata.stt.artifacts?.transcriptPath),
            eventType: event.type,
          });
        }
        if (event.type === "error") live.error = event.message;
      });
      return true;
    })()
  `,
  );
}

async function sendInitialPrompt(cdp, input) {
  await evaluate(
    cdp,
    `
    (() => {
      const input = ${JSON.stringify(input)};
      window.ambientDesktop.sendMessage(input)
        .then(() => {
          window.__ambientSttQueueBarge.initialSendResolved = true;
        })
        .catch((error) => {
          window.__ambientSttQueueBarge.error = error instanceof Error ? error.message : String(error);
        });
      return true;
    })()
  `,
  );
}

async function sendSpeechFollowUp(cdp, input) {
  await evaluate(
    cdp,
    `
    (() => {
      const input = ${JSON.stringify(input)};
      window.ambientDesktop.sendMessage(input)
        .then(() => {
          window.__ambientSttQueueBarge.followUpSendResolved = true;
        })
        .catch((error) => {
          window.__ambientSttQueueBarge.error = error instanceof Error ? error.message : String(error);
        });
      return true;
    })()
  `,
  );
}

async function waitForCompletion(cdp, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const live = await getLiveState(cdp);
    if (live.error) throw new Error(live.error);
    if (live.sawRunIdle && live.initialSendResolved && live.followUpSendResolved) {
      return {
        initialSendResolved: live.initialSendResolved,
        followUpSendResolved: live.followUpSendResolved,
      };
    }
    await delay(500);
  }
  throw new Error(`Timed out after ${maxMs}ms waiting for the live Ambient STT queue/barge run to complete.`);
}

async function getLiveState(cdp) {
  return evaluate(
    cdp,
    `
    (() => {
      const live = window.__ambientSttQueueBarge;
      return live ? {
        statuses: live.statuses,
        queueEvents: live.queueEvents,
        sttQueueEvents: live.sttQueueEvents,
        sttUserMessages: live.sttUserMessages,
        stopTtsRequests: live.stopTtsRequests,
        sawRunStart: live.sawRunStart,
        sawRunIdle: live.sawRunIdle,
        initialSendResolved: live.initialSendResolved,
        followUpSendResolved: live.followUpSendResolved,
        error: live.error,
      } : undefined;
    })()
  `,
  );
}

function sttMetadataFromTranscription(state) {
  return {
    source: "stt",
    utteranceId: state.utteranceId,
    threadId: state.threadId,
    status: state.status,
    ...(state.providerCapabilityId ? { providerCapabilityId: state.providerCapabilityId } : {}),
    ...(state.providerId ? { providerId: state.providerId } : {}),
    ...(state.language ? { language: state.language } : {}),
    ...(typeof state.durationMs === "number" ? { durationMs: state.durationMs } : {}),
    ...(state.noSpeechGate ? { noSpeechGate: state.noSpeechGate } : {}),
    artifacts: {
      ...(state.audioPath ? { audioPath: state.audioPath } : {}),
      ...(state.normalizedAudioPath ? { normalizedAudioPath: state.normalizedAudioPath } : {}),
      ...(state.transcriptPath ? { transcriptPath: state.transcriptPath } : {}),
      ...(state.jsonPath ? { jsonPath: state.jsonPath } : {}),
      ...(state.stdoutPath ? { stdoutPath: state.stdoutPath } : {}),
      ...(state.stderrPath ? { stderrPath: state.stderrPath } : {}),
    },
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

async function desktopState(cdp) {
  return evaluate(cdp, "window.ambientDesktop.bootstrap()");
}

async function waitForTarget(cdpPort) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      const targets = await response.json();
      const target = targets.find((item) => item.webSocketDebuggerUrl && item.type === "page") ?? targets[0];
      if (target?.webSocketDebuggerUrl) return target;
    } catch {
      // App not listening yet.
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for Electron CDP target.");
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let nextId = 1;
    const pending = new Map();
    socket.addEventListener("open", () => {
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((innerResolve, innerReject) => {
            pending.set(id, { resolve: innerResolve, reject: innerReject });
            setTimeout(() => {
              if (!pending.has(id)) return;
              pending.delete(id);
              innerReject(new Error(`Timed out waiting for CDP ${method}.`));
            }, 20_000);
          });
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
    socket.addEventListener("error", () => reject(new Error("CDP websocket failed.")));
  });
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? "Runtime.evaluate failed.");
  }
  return result.result?.value;
}

async function waitFor(cdp, predicate, label, maxMs = 10_000) {
  const expression = `(${predicate.toString()})()`;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression)) return;
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      // Try the next conventional key location.
    }
  }
  return undefined;
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
  return `Electron output tail:\n${output.join("").split("\n").slice(-180).join("\n")}\n`;
}
