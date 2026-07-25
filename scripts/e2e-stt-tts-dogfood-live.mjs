#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const configuredPort = process.env.AMBIENT_STT_TTS_DOGFOOD_CDP_PORT ? Number(process.env.AMBIENT_STT_TTS_DOGFOOD_CDP_PORT) : undefined;
const port = Number.isFinite(configuredPort) && configuredPort > 0 ? configuredPort : await findFreeTcpPort();
const timeoutMs = Number(process.env.AMBIENT_STT_TTS_DOGFOOD_TIMEOUT_MS ?? 540_000);
const workspace = await mkdtemp(join(tmpdir(), "ambient-stt-tts-dogfood-"));
const diagnosticsPath = join(workspace, "stt-tts-dogfood-summary.json");
const defaultFixturePath = join(process.cwd(), ".ambient", "stt-spike", "fixtures", "en-short-clean.wav");
const fixturePath = process.env.AMBIENT_STT_TTS_DOGFOOD_AUDIO_PATH || defaultFixturePath;
const realQwen = process.env.AMBIENT_STT_TTS_DOGFOOD_REAL_QWEN === "1";
const micMode = (process.env.AMBIENT_STT_TTS_DOGFOOD_MIC ?? "off").toLowerCase();
const attemptMicCapture = ["1", "true", "probe", "capture", "primary", "required"].includes(micMode);
const requireMicCapture = micMode === "required" || process.env.AMBIENT_STT_TTS_DOGFOOD_MIC_REQUIRED === "1";
const preferMicCapture = micMode === "primary" || micMode === "required";
const micCaptureMs = Number(process.env.AMBIENT_STT_TTS_DOGFOOD_MIC_MS ?? 3_500);
const micPermissionTimeoutMs = Number(process.env.AMBIENT_STT_TTS_DOGFOOD_MIC_PERMISSION_TIMEOUT_MS ?? 8_000);
const micSpeechThresholdDbfs = Number(process.env.AMBIENT_STT_TTS_DOGFOOD_MIC_SPEECH_THRESHOLD_DBFS ?? -55);
const doneToken = "STT_TTS_DOGFOOD_DONE";
const bargeToken = "STT_TTS_BARGE_DONE";
const spokenRequest = [
  "Create a practical implementation plan for a local first offline grocery planner app.",
  "Include the data model, three UI states, two privacy risks, and a staged validation checklist.",
  "Keep the answer under two hundred and twenty words.",
].join(" ");
const fakeTranscript = spokenRequest;
const output = [];
const children = new Set();
const ambientApiKey = await readAmbientApiKey();
let appInstance;

try {
  if (!existsSync(fixturePath)) throw new Error(`STT/TTS dogfood audio fixture was not found: ${fixturePath}`);
  await writeFile(
    join(workspace, "README.md"),
    [
      "# Ambient STT/TTS live dogfood workspace",
      "",
      "This temporary workspace validates a push-to-talk transcript through Ambient chat and local voice playback.",
      "",
    ].join("\n"),
    "utf8",
  );
  await seedVoiceProviderFixture(workspace);

  await terminateDebugPortProcesses();
  appInstance = await launchApp();
  const summary = await runSttTtsDogfood(appInstance.cdp);
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
  if (process.env.AMBIENT_STT_TTS_DOGFOOD_KEEP_WORKSPACE !== "1") {
    await rm(workspace, { recursive: true, force: true });
  } else {
    console.error(`Keeping STT/TTS dogfood workspace: ${workspace}`);
  }
}

console.log("Live Ambient STT/TTS dogfood smoke passed.");

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

async function runSttTtsDogfood(cdp) {
  const initialState = await desktopState(cdp);
  if (!initialState.provider.hasApiKey) {
    throw new Error("Ambient API key is missing. Set AMBIENT_API_KEY, AMBIENT_AGENT_AMBIENT_API_KEY, AMBIENT_API_KEY_FILE, or place ignored-provider-key-file.txt near the repo.");
  }
  const keyCheck = await evaluate(cdp, "window.ambientDesktop.testAmbientApiKey()");
  if (!keyCheck?.ok) throw new Error(`Ambient API key check failed: ${keyCheck?.message ?? "unknown error"}`);

  const managedAudio = await seedManagedAudio(cdp, initialState.activeThreadId, fixturePath);
  const microphone = attemptMicCapture ? await captureMicrophoneAudio(cdp, initialState.activeThreadId) : { attempted: false };
  if (requireMicCapture && !microphone.ok) {
    throw new Error(`Microphone capture was required but did not succeed: ${JSON.stringify(microphone)}`);
  }
  if (requireMicCapture && microphone.ok && !microphone.speechLikely) {
    throw new Error(`Microphone capture was required but did not cross the speech threshold: ${JSON.stringify(microphone)}`);
  }
  const useMicrophoneAudio = Boolean(microphone.ok && microphone.audio && (preferMicCapture || microphone.speechLikely));
  const audio = useMicrophoneAudio ? microphone.audio : managedAudio;
  const audioSource = useMicrophoneAudio ? "microphone-capture" : "managed-fixture";

  const setupStarted = Date.now();
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
  const setupDurationMs = Date.now() - setupStarted;
  if (setup?.status !== "ready" || !setup?.selectedProvider?.available) {
    throw new Error(`Qwen3-ASR setup did not become ready: ${JSON.stringify(summarizeSetup(setup, setupDurationMs), null, 2)}`);
  }

  const voiceProvider = await waitForE2EVoiceProvider(cdp);

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
  const voiceSettings = await evaluate(
    cdp,
    `window.ambientDesktop.updateVoiceSettings(${JSON.stringify({
      enabled: true,
      mode: "assistant-final",
      autoplay: true,
      providerCapabilityId: voiceProvider.capabilityId,
      voiceId: "default",
      preferredVoicesByProvider: { [voiceProvider.capabilityId]: "default" },
      maxChars: 3500,
      longReply: "skip",
      format: "wav",
    })})`,
  );
  if (!voiceSettings?.enabled || !voiceSettings?.autoplay) {
    throw new Error(`Voice settings did not enable the E2E provider: ${JSON.stringify(voiceSettings)}`);
  }

  await installLiveEventCollector(cdp);

  const initialTranscription = await transcribeManagedAudio(cdp, {
    threadId: preparedState.activeThreadId,
    audioPath: audio.audioPath,
    utteranceId: `stt-tts-initial-${Date.now().toString(36)}`,
  });
  assertReadyTranscription(initialTranscription, "initial");
  if (!realQwen && initialTranscription.state.text !== fakeTranscript) {
    throw new Error("Fake Qwen transcript did not round-trip for the initial utterance.");
  }

  await sendPrompt(cdp, "initialSendResolved", {
    threadId: preparedState.activeThreadId,
    content: [
      "The following text was produced by Ambient's configured push-to-talk STT provider.",
      "Treat it as the user's spoken request and answer it directly.",
      "",
      "Spoken request:",
      initialTranscription.state.text,
      "",
      `Dogfood verification instruction: do not use tools and end your reply with exactly ${doneToken}.`,
    ].join("\n"),
    permissionMode: "workspace",
    collaborationMode: "agent",
    model: process.env.AMBIENT_STT_TTS_DOGFOOD_MODEL || preparedState.settings.model,
    thinkingLevel: "low",
    context: [],
    stt: sttMetadataFromTranscription(initialTranscription.state),
  });
  await waitFor(cdp, () => window.__ambientSttTtsDogfood?.statuses?.some((status) => status !== "idle"), "Ambient run start", 45_000);
  const initialAssistant = await waitForAssistantToken(cdp, doneToken, timeoutMs);

  const voiceState = await waitForVoiceReady(cdp, initialAssistant.id, 90_000);
  const playback = await startVoicePlayback(cdp);
  const followUpTranscription = await transcribeManagedAudio(cdp, {
    threadId: preparedState.activeThreadId,
    audioPath: audio.audioPath,
    utteranceId: `stt-tts-barge-${Date.now().toString(36)}`,
  });
  assertReadyTranscription(followUpTranscription, "barge-in");
  await waitFor(cdp, () => (window.__ambientSttTtsDogfood?.stopTtsRequests ?? 0) > 0, "TTS stop request after barge-in", 30_000);

  await sendPrompt(cdp, "followUpSendResolved", {
    threadId: preparedState.activeThreadId,
    content: [
      "A second push-to-talk utterance arrived while voice playback was active.",
      "Use the transcript below as the user follow-up, then respond with one concise refinement.",
      "",
      "Follow-up transcript:",
      followUpTranscription.state.text,
      "",
      `Dogfood verification instruction: end your reply with exactly ${bargeToken}.`,
    ].join("\n"),
    permissionMode: "workspace",
    collaborationMode: "agent",
    model: process.env.AMBIENT_STT_TTS_DOGFOOD_MODEL || preparedState.settings.model,
    thinkingLevel: "low",
    delivery: "follow-up",
    context: [],
    stt: sttMetadataFromTranscription(followUpTranscription.state),
  });
  const followUpAssistant = await waitForAssistantToken(cdp, bargeToken, timeoutMs);
  await waitForCompletion(cdp, timeoutMs);

  const finalState = await desktopState(cdp);
  const live = await getLiveState(cdp);
  const visibleSttMessages = finalState.messages
    .filter((message) => message.role === "user" && message.metadata?.stt)
    .map((message) => ({
      id: message.id,
      status: message.metadata.status ?? "sent",
      delivery: message.metadata.delivery ?? "initial",
      utteranceId: message.metadata.stt.utteranceId,
      sttStatus: message.metadata.stt.status,
      contentChars: [...message.content].length,
      hasAudioArtifact: Boolean(message.metadata.stt.artifacts?.audioPath),
      hasTranscriptArtifact: Boolean(message.metadata.stt.artifacts?.transcriptPath),
    }));

  if (!visibleSttMessages.some((message) => message.utteranceId === initialTranscription.state.utteranceId)) {
    throw new Error("Visible chat did not include the initial STT user message metadata.");
  }
  if (!visibleSttMessages.some((message) => message.utteranceId === followUpTranscription.state.utteranceId)) {
    throw new Error("Visible chat did not include the barge-in STT user message metadata.");
  }
  const sttDiagnostics = finalState.sttDiagnostics ?? [];
  if (!sttDiagnostics.some((diagnostic) => diagnostic.kind === "setup" && diagnostic.status === "ready")) {
    throw new Error(`Final Desktop state did not include a ready STT setup diagnostic: ${JSON.stringify(sttDiagnostics, null, 2)}`);
  }
  for (const transcription of [initialTranscription, followUpTranscription]) {
    if (!sttDiagnostics.some((diagnostic) => diagnostic.kind === "transcription" && diagnostic.utteranceId === transcription.state.utteranceId)) {
      throw new Error(`Final Desktop state did not include a transcription diagnostic for ${transcription.state.utteranceId}.`);
    }
  }
  if (JSON.stringify(sttDiagnostics).includes(fakeTranscript)) {
    throw new Error("STT diagnostics leaked raw transcript text.");
  }

  const assistantText = finalState.messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.content)
    .join("\n");
  if (!assistantText.includes(doneToken)) throw new Error(`Initial dogfood token was not present in assistant output.`);
  if (!assistantText.includes(bargeToken)) throw new Error(`Barge-in dogfood token was not present in assistant output.`);

  return {
    workspace,
    diagnosticsPath,
    model: process.env.AMBIENT_STT_TTS_DOGFOOD_MODEL || preparedState.settings.model,
    qwenMode: realQwen ? "real" : "fake-transcript",
    microphone,
    audioSource,
    setup: summarizeSetup(setup, setupDurationMs),
    audio: {
      durationMs: audio.durationMs,
      bytes: audio.bytes,
      sampleRate: audio.sampleRate,
      channels: audio.channels,
    },
    stt: {
      initial: summarizeTranscription(initialTranscription),
      bargeIn: summarizeTranscription(followUpTranscription),
    },
    diagnostics: summarizeSttDiagnostics(sttDiagnostics),
    tts: {
      providerCapabilityId: voiceProvider.capabilityId,
      providerLabel: voiceProvider.label,
      settingsMode: voiceSettings.mode,
      autoplay: voiceSettings.autoplay,
      playback,
      voiceState: summarizeVoiceState(voiceState),
      stopTtsRequests: live.stopTtsRequests,
    },
    visibleSttMessages,
    events: {
      runStatusEventCount: live.statuses.length,
      runStatusCounts: countBy(live.statuses),
      lastRunStatus: live.statuses.at(-1),
      queueEventCount: live.queueEvents.length,
      sttQueueEventCount: live.sttQueueEvents.length,
      speakingQueueEvents: live.sttQueueEvents.filter((event) => event.phase === "speaking").length,
      stopTtsRequests: live.stopTtsRequests,
    },
    completion: {
      initialAssistantMessageId: initialAssistant.id,
      followUpAssistantMessageId: followUpAssistant.id,
      initialTokenMatched: assistantText.includes(doneToken),
      bargeTokenMatched: assistantText.includes(bargeToken),
      initialSendResolved: live.initialSendResolved,
      followUpSendResolved: live.followUpSendResolved,
    },
  };
}

async function seedManagedAudio(cdp, threadId, audioPath) {
  const audioBase64 = (await readFile(audioPath)).toString("base64");
  const audio = await evaluate(
    cdp,
    `window.ambientDesktop.saveSttTestAudio(${JSON.stringify({
      source: "composer-push-to-talk",
      threadId,
      audioBase64,
    })})`,
  );
  if (!audio?.audioPath) throw new Error(`Failed to seed managed STT audio: ${JSON.stringify(audio)}`);
  return audio;
}

async function captureMicrophoneAudio(cdp, threadId) {
  return evaluate(
    cdp,
    `
    (async () => {
      const captureMs = ${JSON.stringify(micCaptureMs)};
      const permissionTimeoutMs = ${JSON.stringify(micPermissionTimeoutMs)};
      const speechThresholdDbfs = ${JSON.stringify(micSpeechThresholdDbfs)};
      if (!navigator.mediaDevices?.getUserMedia) return { attempted: true, ok: false, reason: "getUserMedia-unavailable" };
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCtor) return { attempted: true, ok: false, reason: "audio-context-unavailable" };

      let stream;
      try {
        stream = await Promise.race([
          navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("microphone-permission-timeout")), permissionTimeoutMs)),
        ]);
      } catch (error) {
        return { attempted: true, ok: false, reason: error instanceof Error ? error.message || error.name : String(error) };
      }

      const audioContext = new AudioContextCtor();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, Math.max(1, source.channelCount || 1), 1);
      const chunks = [];
      let recordedFrames = 0;
      let stopped = false;
      let sumSquares = 0;
      let peak = 0;

      processor.onaudioprocess = (event) => {
        if (stopped) return;
        const input = event.inputBuffer;
        const frames = input.length;
        const channels = Math.max(1, input.numberOfChannels);
        const mono = new Float32Array(frames);
        for (let channel = 0; channel < channels; channel += 1) {
          const data = input.getChannelData(channel);
          for (let index = 0; index < frames; index += 1) {
            mono[index] += (data[index] || 0) / channels;
          }
        }
        for (const sample of mono) {
          const bounded = Math.max(-1, Math.min(1, sample));
          sumSquares += bounded * bounded;
          peak = Math.max(peak, Math.abs(bounded));
        }
        chunks.push(mono);
        recordedFrames += frames;
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
      await new Promise((resolve) => setTimeout(resolve, captureMs));
      stopped = true;
      processor.disconnect();
      source.disconnect();
      stream.getTracks().forEach((track) => track.stop());

      const sampleRate = audioContext.sampleRate;
      await audioContext.close().catch(() => undefined);
      const samples = mergeFloat32Chunks(chunks, recordedFrames);
      const wav = encodePcm16WavMono(samples, sampleRate);
      const rms = recordedFrames > 0 ? Math.sqrt(sumSquares / recordedFrames) : 0;
      const rmsDbfs = amplitudeToDbfs(rms);
      const peakDbfs = amplitudeToDbfs(peak);
      const durationMs = Math.round((samples.length / sampleRate) * 1000);
      const audio = await window.ambientDesktop.saveSttTestAudio({
        source: "composer-push-to-talk",
        threadId: ${JSON.stringify(threadId)},
        audioBase64: arrayBufferToBase64(wav),
        durationMs,
        sampleRate,
        channels: 1,
      });
      return {
        attempted: true,
        ok: true,
        audio,
        durationMs,
        sampleRate,
        bytes: wav.byteLength,
        rmsDbfs,
        peakDbfs,
        speechThresholdDbfs,
        speechLikely: rmsDbfs > speechThresholdDbfs,
      };

      function mergeFloat32Chunks(parts, totalLength) {
        const output = new Float32Array(totalLength);
        let offset = 0;
        for (const part of parts) {
          output.set(part, offset);
          offset += part.length;
        }
        return output;
      }

      function encodePcm16WavMono(samples, sampleRate) {
        const dataBytes = samples.length * 2;
        const buffer = new ArrayBuffer(44 + dataBytes);
        const view = new DataView(buffer);
        writeAscii(view, 0, "RIFF");
        view.setUint32(4, 36 + dataBytes, true);
        writeAscii(view, 8, "WAVE");
        writeAscii(view, 12, "fmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        writeAscii(view, 36, "data");
        view.setUint32(40, dataBytes, true);
        for (let index = 0; index < samples.length; index += 1) {
          const sample = Math.max(-1, Math.min(1, samples[index] || 0));
          view.setInt16(44 + index * 2, Math.round(sample * 32767), true);
        }
        return buffer;
      }

      function writeAscii(view, offset, value) {
        for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
      }

      function arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
        }
        return btoa(binary);
      }

      function amplitudeToDbfs(value) {
        if (!Number.isFinite(value) || value <= 0) return -120;
        return Math.max(-120, Math.round(20 * Math.log10(value) * 1000) / 1000);
      }
    })()
  `,
  );
}

async function transcribeManagedAudio(cdp, input) {
  const started = Date.now();
  const result = await evaluate(
    cdp,
    `window.ambientDesktop.transcribeSttAudio(${JSON.stringify(input)})`,
  );
  return {
    ...result,
    elapsedMs: Date.now() - started,
  };
}

function assertReadyTranscription(transcription, label) {
  if (transcription?.state?.status !== "ready") {
    throw new Error(`Expected ready ${label} STT transcription: ${JSON.stringify(summarizeTranscription(transcription), null, 2)}`);
  }
  if (!transcription.state.text?.trim()) throw new Error(`Expected non-empty ${label} STT transcript.`);
}

async function startVoicePlayback(cdp) {
  const clicked = await evaluate(
    cdp,
    `
    (() => {
      const buttons = Array.from(document.querySelectorAll('.message-voice-state.voice-ready button[aria-label="Play voice"]'));
      const button = buttons.at(-1);
      if (!button) return { clicked: false, buttonCount: buttons.length };
      button.click();
      return { clicked: true, buttonCount: buttons.length };
    })()
  `,
  );
  let startedBy = clicked.clicked ? "ui-click" : "ipc-fallback";
  try {
    await waitFor(cdp, () => window.__ambientSttTtsDogfood?.sttQueueEvents?.some((event) => event.phase === "speaking"), "voice playback speaking state", 2_500);
  } catch {
    await evaluate(cdp, "window.ambientDesktop.setSttTtsSpeaking({ speaking: true })");
    startedBy = `${startedBy}+ipc-speaking-fallback`;
    await waitFor(cdp, () => window.__ambientSttTtsDogfood?.sttQueueEvents?.some((event) => event.phase === "speaking"), "fallback voice speaking state", 5_000);
  }
  return {
    ...clicked,
    startedBy,
  };
}

async function waitForAssistantToken(cdp, token, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const state = await desktopState(cdp);
    const assistant = [...state.messages]
      .reverse()
      .find((message) => message.role === "assistant" && message.content.includes(token));
    if (assistant) return assistant;
    const live = await getLiveState(cdp);
    if (live.error) throw new Error(live.error);
    await delay(500);
  }
  throw new Error(`Timed out waiting for assistant token ${token}.`);
}

async function waitForVoiceReady(cdp, messageId, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const state = await desktopState(cdp);
    const voiceState = state.messageVoiceStates?.[messageId];
    if (voiceState?.status === "ready" && voiceState.mediaUrl) return voiceState;
    if (voiceState?.status === "failed") throw new Error(`Voice synthesis failed: ${voiceState.error ?? "unknown error"}`);
    await delay(500);
  }
  const state = await desktopState(cdp);
  throw new Error(`Timed out waiting for voice artifact for ${messageId}: ${JSON.stringify(state.messageVoiceStates?.[messageId])}`);
}

async function installLiveEventCollector(cdp) {
  await evaluate(
    cdp,
    `
    (() => {
      window.__ambientSttTtsDogfood?.unsubscribe?.();
      window.__ambientSttTtsDogfood = {
        statuses: [],
        queueEvents: [],
        sttQueueEvents: [],
        sttUserMessages: [],
        stopTtsRequests: 0,
        initialSendResolved: false,
        followUpSendResolved: false,
        error: undefined,
      };
      window.__ambientSttTtsDogfood.unsubscribe = window.ambientDesktop.onEvent((event) => {
        const live = window.__ambientSttTtsDogfood;
        if (event.type === "run-status") live.statuses.push(event.status);
        if (event.type === "queue-updated") live.queueEvents.push(event.queue);
        if (event.type === "stt-queue-updated") live.sttQueueEvents.push(event.queue);
        if (event.type === "stt-stop-tts-requested") live.stopTtsRequests += 1;
        if ((event.type === "message-created" || event.type === "message-updated") && event.message?.role === "user" && event.message.metadata?.stt) {
          live.sttUserMessages.push({
            id: event.message.id,
            status: event.message.metadata.status,
            delivery: event.message.metadata.delivery,
            sttUtteranceId: event.message.metadata.stt.utteranceId,
            sttStatus: event.message.metadata.stt.status,
            contentChars: event.message.content.length,
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

async function sendPrompt(cdp, resolvedFlag, input) {
  await evaluate(
    cdp,
    `
    (() => {
      const input = ${JSON.stringify(input)};
      window.ambientDesktop.sendMessage(input)
        .then(() => {
          window.__ambientSttTtsDogfood[${JSON.stringify(resolvedFlag)}] = true;
        })
        .catch((error) => {
          window.__ambientSttTtsDogfood.error = error instanceof Error ? error.message : String(error);
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
    if (live.initialSendResolved && live.followUpSendResolved && live.statuses.at(-1) === "idle") return;
    await delay(500);
  }
  throw new Error(`Timed out after ${maxMs}ms waiting for the live Ambient STT/TTS dogfood run to complete.`);
}

async function getLiveState(cdp) {
  return evaluate(
    cdp,
    `
    (() => {
      const live = window.__ambientSttTtsDogfood;
      return live ? {
        statuses: live.statuses,
        queueEvents: live.queueEvents,
        sttQueueEvents: live.sttQueueEvents,
        sttUserMessages: live.sttUserMessages,
        stopTtsRequests: live.stopTtsRequests,
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

function summarizeSetup(setup, setupDurationMs) {
  return {
    status: setup?.status,
    action: setup?.action,
    packageName: setup?.packageName,
    setupDurationMs,
    providerCapabilityId: setup?.selectedProvider?.capabilityId,
    providerAvailable: setup?.selectedProvider?.available,
    runtimeInstall: setup?.runtimeInstall
      ? {
          attempted: setup.runtimeInstall.attempted,
          status: setup.runtimeInstall.status,
          manager: setup.runtimeInstall.manager,
          packageName: setup.runtimeInstall.packageName,
          durationMs: setup.runtimeInstall.durationMs,
          hasBinaryPath: Boolean(setup.runtimeInstall.binaryPath),
          missingHintCount: setup.runtimeInstall.missingHints?.length ?? 0,
          hasError: Boolean(setup.runtimeInstall.error),
        }
      : undefined,
    validation: setup?.validation
      ? {
          status: setup.validation.status,
          platform: setup.validation.platform,
          arch: setup.validation.arch,
          lane: setup.validation.lane,
          hasBinaryPath: Boolean(setup.validation.binaryPath),
          runtimeVersion: setup.validation.runtimeVersion,
          model: setup.validation.model,
          modelSource: setup.validation.modelSource,
          assetManifestVersion: setup.validation.assetManifest?.version,
          durationMs: setup.validation.durationMs,
          hasError: Boolean(setup.validation.error),
          missingHintCount: setup.validation.missingHints?.length ?? 0,
        }
      : undefined,
    runtimeCandidateCount: setup?.runtimeCandidates?.length ?? 0,
    installStatuses: setup?.installStatuses?.map((entry) => ({
      packageName: entry.packageName,
      source: entry.source,
      status: entry.status,
      hasError: Boolean(entry.error),
    })),
  };
}

function summarizeTranscription(transcription) {
  const state = transcription?.state;
  return {
    utteranceId: state?.utteranceId,
    status: state?.status,
    providerCapabilityId: state?.providerCapabilityId,
    providerId: state?.providerId,
    language: state?.language,
    textChars: state?.text ? [...state.text].length : 0,
    durationMs: state?.durationMs,
    elapsedMs: transcription?.elapsedMs,
    noSpeechGate: state?.noSpeechGate
      ? {
          enabled: state.noSpeechGate.enabled,
          skipped: state.noSpeechGate.skipped,
          rmsDbfs: state.noSpeechGate.rmsDbfs,
          peakDbfs: state.noSpeechGate.peakDbfs,
          thresholdDbfs: state.noSpeechGate.thresholdDbfs,
          durationMs: state.noSpeechGate.durationMs,
        }
      : undefined,
    artifacts: {
      hasAudio: Boolean(state?.audioPath),
      hasNormalizedAudio: Boolean(state?.normalizedAudioPath),
      hasTranscript: Boolean(state?.transcriptPath),
      hasJson: Boolean(state?.jsonPath),
      hasStdout: Boolean(state?.stdoutPath),
      hasStderr: Boolean(state?.stderrPath),
    },
    queuePhase: transcription?.queue?.phase,
    queuedUtteranceCount: transcription?.queue?.queuedUtteranceIds?.length ?? 0,
    hasError: Boolean(state?.error),
  };
}

function summarizeVoiceState(voiceState) {
  return {
    messageId: voiceState.messageId,
    status: voiceState.status,
    source: voiceState.source,
    providerCapabilityId: voiceState.providerCapabilityId,
    voiceId: voiceState.voiceId,
    spokenTextChars: voiceState.spokenTextChars,
    sourceTextChars: voiceState.sourceTextChars,
    audioPath: voiceState.audioPath,
    mimeType: voiceState.mimeType,
    durationMs: voiceState.durationMs,
    hasMediaUrl: Boolean(voiceState.mediaUrl),
  };
}

function summarizeSttDiagnostics(diagnostics) {
  return {
    count: diagnostics.length,
    setupCount: diagnostics.filter((diagnostic) => diagnostic.kind === "setup").length,
    transcriptionCount: diagnostics.filter((diagnostic) => diagnostic.kind === "transcription").length,
    latest: diagnostics.slice(0, 5).map((diagnostic) => ({
      kind: diagnostic.kind,
      status: diagnostic.status,
      durationMs: diagnostic.durationMs,
      transcriptionElapsedMs: diagnostic.transcriptionElapsedMs,
      audioDurationMs: diagnostic.audioDurationMs,
      lane: diagnostic.lane,
      errorCategory: diagnostic.errorCategory,
      transcriptChars: diagnostic.transcriptChars,
      noSpeechSkipped: diagnostic.noSpeechGate?.skipped,
    })),
  };
}

function countBy(values) {
  return values.reduce((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

async function desktopState(cdp) {
  return evaluate(cdp, "window.ambientDesktop.bootstrap()");
}

async function waitForE2EVoiceProvider(cdp, maxMs = 30_000) {
  const deadline = Date.now() + maxMs;
  let voiceProviders = [];
  while (Date.now() < deadline) {
    voiceProviders = await evaluate(cdp, "window.ambientDesktop.listVoiceProviders()");
    const voiceProvider = voiceProviders.find((provider) => provider.capabilityId?.includes("ambient-e2e-voice-provider") && provider.available);
    if (voiceProvider) return voiceProvider;
    await delay(500);
  }
  throw new Error(`E2E voice provider was not available: ${JSON.stringify(voiceProviders, null, 2)}`);
}

async function seedVoiceProviderFixture(root) {
  const packageRoot = join(root, ".ambient", "cli-packages", "imported", "ambient-e2e-voice-provider");
  await mkdir(packageRoot, { recursive: true });
  await mkdir(join(root, ".ambient", "cli-packages"), { recursive: true });
  await writeFile(
    join(root, ".ambient", "cli-packages", "packages.json"),
    JSON.stringify({ packages: [{ source: "./.ambient/cli-packages/imported/ambient-e2e-voice-provider" }] }, null, 2),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "ambient-cli.json"),
    JSON.stringify(
      {
        name: "ambient-e2e-voice-provider",
        version: "0.1.0",
        description: "E2E local TTS provider metadata fixture.",
        skills: "./SKILL.md",
        commands: {
          e2e_voice_provider: {
            description: "Synthesize spoken assistant text to a WAV file for E2E STT/TTS dogfood.",
            command: "node",
            args: ["./run.mjs"],
            cwd: "package",
            healthCheck: ["node", "./health.mjs"],
            voiceProvider: {
              label: "E2E Voice Provider",
              defaultFormat: "wav",
              formats: ["wav"],
              voices: [{ id: "default", label: "Default E2E voice", locale: "en-US", language: "English", style: ["default"] }],
              local: true,
            },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(join(packageRoot, "SKILL.md"), "---\nname: ambient-e2e-voice-provider\n---\n", "utf8");
  await writeFile(join(packageRoot, "voice-ready.marker"), "ready\n", "utf8");
  await writeFile(
    join(packageRoot, "health.mjs"),
    [
      "#!/usr/bin/env node",
      "import { existsSync } from 'node:fs';",
      "if (!existsSync('./voice-ready.marker')) throw new Error('model file missing');",
      "console.log('voice provider health ok');",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(packageRoot, "run.mjs"),
    [
      "#!/usr/bin/env node",
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import { dirname } from 'node:path';",
      "if (process.argv.includes('--list-voices')) {",
      "  console.log(JSON.stringify({ voices: [{ id: 'default', label: 'Default E2E voice', locale: 'en-US', language: 'English', style: ['default'] }] }));",
      "  process.exit(0);",
      "}",
      "const output = process.argv[process.argv.indexOf('--output') + 1];",
      "const text = process.argv[process.argv.indexOf('--text') + 1] || '';",
      "if (!output) process.exit(2);",
      "mkdirSync(dirname(output), { recursive: true });",
      "const durationMs = Math.max(1800, Math.min(5000, text.length * 18));",
      "writeFileSync(output, silentWav(durationMs));",
      "console.log(JSON.stringify({ audioPath: output, mimeType: 'audio/wav', durationMs }));",
      "function silentWav(durationMs) {",
      "  const sampleRate = 16000;",
      "  const channels = 1;",
      "  const bitsPerSample = 16;",
      "  const samples = Math.max(1, Math.ceil((durationMs / 1000) * sampleRate));",
      "  const dataBytes = samples * channels * (bitsPerSample / 8);",
      "  const buffer = Buffer.alloc(44 + dataBytes);",
      "  buffer.write('RIFF', 0);",
      "  buffer.writeUInt32LE(36 + dataBytes, 4);",
      "  buffer.write('WAVE', 8);",
      "  buffer.write('fmt ', 12);",
      "  buffer.writeUInt32LE(16, 16);",
      "  buffer.writeUInt16LE(1, 20);",
      "  buffer.writeUInt16LE(channels, 22);",
      "  buffer.writeUInt32LE(sampleRate, 24);",
      "  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);",
      "  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);",
      "  buffer.writeUInt16LE(bitsPerSample, 34);",
      "  buffer.write('data', 36);",
      "  buffer.writeUInt32LE(dataBytes, 40);",
      "  return buffer;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
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

function findFreeTcpPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const selectedPort = typeof address === "object" && address ? address.port : undefined;
      server.close(() => {
        if (selectedPort) resolve(selectedPort);
        else reject(new Error("Could not allocate a free local CDP port."));
      });
    });
  });
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
