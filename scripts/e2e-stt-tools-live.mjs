#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";

const port = Number(process.env.AMBIENT_STT_TOOLS_LIVE_CDP_PORT ?? 9478);
const timeoutMs = Number(process.env.AMBIENT_STT_TOOLS_LIVE_TIMEOUT_MS ?? 420_000);
const workspace = await mkdtemp(join(tmpdir(), "ambient-stt-tools-live-"));
const diagnosticsPath = join(workspace, "stt-tools-live-summary.json");
const fixturePath = process.env.AMBIENT_STT_TOOLS_LIVE_AUDIO_PATH || join(process.cwd(), ".ambient", "stt-spike", "fixtures", "en-short-clean.wav");
const finalToken = "STT_TOOLS_LIVE_DONE";
const fakeTranscript = "Ambient speech recognition spike live dogfood.";
const realQwen = process.env.AMBIENT_STT_TOOLS_LIVE_REAL_QWEN === "1";
const providerMode = (process.env.AMBIENT_STT_TOOLS_LIVE_PROVIDER || "qwen").trim().toLowerCase();
const output = [];
const children = new Set();
const ambientApiKey = await readAmbientApiKey();
let appInstance;

try {
  if (!existsSync(fixturePath)) throw new Error(`STT live audio fixture was not found: ${fixturePath}`);
  await writeFile(
    join(workspace, "README.md"),
    [
      "# Ambient STT tools live workspace",
      "",
      "This temporary workspace validates Pi-visible Ambient STT tools against a managed WAV artifact.",
      "",
    ].join("\n"),
    "utf8",
  );
  if (providerMode === "faster-whisper") {
    await installBundledFasterWhisperPackage(workspace);
  } else if (providerMode !== "qwen") {
    throw new Error(`Unsupported AMBIENT_STT_TOOLS_LIVE_PROVIDER: ${providerMode}`);
  }

  appInstance = await launchApp();
  const summary = await runSttToolsLiveSmoke(appInstance.cdp);
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
  if (process.env.AMBIENT_STT_TOOLS_LIVE_KEEP_WORKSPACE !== "1") {
    await rm(workspace, { recursive: true, force: true });
  } else {
    console.error(`Keeping STT live workspace: ${workspace}`);
  }
}

console.log("Live Ambient STT tools smoke passed.");

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

async function runSttToolsLiveSmoke(cdp) {
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
  if (!audio?.audioPath) throw new Error(`Failed to seed managed STT validation audio: ${JSON.stringify(audio)}`);

  const setup = providerMode === "faster-whisper"
    ? await prepareFasterWhisperProvider(cdp)
    : await prepareQwenProvider(cdp, audio.audioPath);
  if (setup?.status !== "ready" || !setup?.selectedProvider?.available) {
    throw new Error(`${providerMode} setup did not become ready: ${JSON.stringify(setup, null, 2)}`);
  }

  const preparedState = await desktopState(cdp);
  if (providerMode === "qwen") {
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
  }

  await installLiveEventCollector(cdp);
  const prompt = providerMode === "faster-whisper"
    ? [
        "This is a live Ambient/Pi dogfood for the provider-neutral speech input tools.",
        "Use only the Ambient STT tools for this check. Do not use bash, shell, file tools, browser tools, ambient_cli, or Settings instructions.",
        "First call ambient_stt_status.",
        `Then call ambient_stt_select with providerCapabilityId exactly ${JSON.stringify(setup.selectedProvider.capabilityId)}, spokenLanguage English, and enabled true.`,
        `Then call ambient_stt_test with audioPath exactly ${JSON.stringify(audio.audioPath)} and spokenLanguage English.`,
        "After all three tools complete, reply with exactly:",
        finalToken,
      ].join("\n")
    : [
        "This is a live Ambient/Pi dogfood for the first-party speech input tools.",
        "Use only the Ambient STT tools for this check. Do not use bash, shell, file tools, browser tools, or Settings instructions.",
        "First call ambient_stt_status.",
        "Then call ambient_stt_policy_update to set silenceFinalizeSeconds to 0.9. Keep queueWhileAgentRuns true and autoSendAfterTranscription true.",
        `Then call ambient_stt_test with audioPath exactly ${JSON.stringify(audio.audioPath)} and spokenLanguage English.`,
        "After all three tools complete, reply with exactly:",
        finalToken,
      ].join("\n");

  await sendLivePrompt(cdp, {
    threadId: preparedState.activeThreadId,
    content: prompt,
    permissionMode: "workspace",
    collaborationMode: "agent",
    model: process.env.AMBIENT_STT_TOOLS_LIVE_MODEL || preparedState.settings.model,
    thinkingLevel: "low",
  });

  const completion = await waitForSttLiveCompletion(cdp, timeoutMs);
  const live = await getLiveState(cdp);
  const finalState = await desktopState(cdp);
  const toolMessages = finalState.messages.filter((message) => message.role === "tool");
  const toolNames = toolMessages.flatMap((message) => typeof message.metadata?.toolName === "string" ? [message.metadata.toolName] : []);
  const assistantText = finalState.messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.content)
    .join("\n");
  const transcriptText = toolMessages
    .map((message) => message.content)
    .join("\n");

  const requiredTools = providerMode === "faster-whisper"
    ? ["ambient_stt_status", "ambient_stt_select", "ambient_stt_test"]
    : ["ambient_stt_status", "ambient_stt_policy_update", "ambient_stt_test"];
  for (const requiredTool of requiredTools) {
    if (!toolNames.includes(requiredTool)) {
      throw new Error(`Live STT dogfood did not call ${requiredTool}. Tools: ${toolNames.join(", ") || "(none)"}`);
    }
  }
  if (!assistantText.includes(finalToken)) {
    throw new Error(`Live STT dogfood did not finish with ${finalToken}. Assistant text: ${assistantText.slice(-1000)}`);
  }
  if (!transcriptText.includes("Ambient STT status")) throw new Error("Live STT dogfood did not render STT status output.");
  if (providerMode === "faster-whisper" && !transcriptText.includes("Ambient STT settings updated")) {
    throw new Error("Live faster-whisper STT dogfood did not render STT selection output.");
  }
  if (providerMode === "qwen" && !transcriptText.includes("Ambient STT policy updated")) throw new Error("Live STT dogfood did not render STT policy update output.");
  if (!transcriptText.includes("Ambient STT test succeeded")) throw new Error("Live STT dogfood did not render STT test success output.");
  const fasterWhisperExpectedSnippet = process.env.AMBIENT_STT_TOOLS_LIVE_EXPECT_TRANSCRIPT || "He hoped there would be stew";
  if (providerMode === "faster-whisper" && !transcriptText.includes(fasterWhisperExpectedSnippet)) {
    throw new Error(`Live faster-whisper STT dogfood did not surface the expected transcript snippet. Tool output: ${transcriptText.slice(-1500)}`);
  }
  if (providerMode === "qwen" && !realQwen && !transcriptText.includes(fakeTranscript)) {
    throw new Error(`Live STT dogfood did not surface the fake Qwen transcript. Tool output: ${transcriptText.slice(-1500)}`);
  }
  if (providerMode === "qwen" && Math.abs(finalState.settings.stt.silenceFinalizeSeconds - 0.9) > 0.001) {
    throw new Error(`Live STT dogfood did not update silenceFinalizeSeconds to 0.9. Settings: ${JSON.stringify(finalState.settings.stt)}`);
  }
  if (providerMode === "faster-whisper" && finalState.settings.stt.providerCapabilityId !== setup.selectedProvider.capabilityId) {
    throw new Error(`Live faster-whisper STT dogfood did not select the expected provider. Settings: ${JSON.stringify(finalState.settings.stt)}`);
  }

  return {
    workspace,
    audioPath: audio.audioPath,
    model: process.env.AMBIENT_STT_TOOLS_LIVE_MODEL || preparedState.settings.model,
    providerMode,
    qwenMode: realQwen ? "real" : "fake-transcript",
    providerCapabilityId: setup.selectedProvider.capabilityId,
    setupStatus: setup.status,
    approvalCount: completion.approvals.length,
    approvalTitles: completion.approvals,
    toolNames,
    messageDeltaCount: live.messageDeltaCount,
    toolEventCount: live.toolEventCount,
    toolMessageCount: live.toolMessageCount,
    finalSilenceFinalizeSeconds: finalState.settings.stt.silenceFinalizeSeconds,
    transcriptMatched: providerMode === "faster-whisper"
      ? transcriptText.includes(fasterWhisperExpectedSnippet)
      : realQwen
        ? transcriptText.includes("Transcript:")
        : transcriptText.includes(fakeTranscript),
    statuses: live.statuses,
  };
}

async function prepareQwenProvider(cdp, audioPath) {
  return evaluate(
    cdp,
    `window.ambientDesktop.setupSttProvider(${JSON.stringify({
      provider: "qwen3-asr",
      action: "repair",
      installRuntime: realQwen,
      validationAudioPath: audioPath,
      spokenLanguage: "English",
      selectProvider: true,
      enable: true,
    })})`,
  );
}

async function prepareFasterWhisperProvider(cdp) {
  const providers = await evaluate(cdp, "window.ambientDesktop.listSttProviders()");
  const selectedProvider = providers.find((provider) => provider.packageName === "ambient-faster-whisper-stt" && provider.command === "faster_whisper_transcribe");
  if (!selectedProvider) throw new Error(`Bundled faster-whisper STT provider was not discovered: ${JSON.stringify(providers)}`);
  if (!selectedProvider.available) throw new Error(`Bundled faster-whisper STT provider is unavailable: ${JSON.stringify(selectedProvider)}`);
  const state = await desktopState(cdp);
  await evaluate(
    cdp,
    `window.ambientDesktop.updateSttSettings(${JSON.stringify({
      ...state.settings.stt,
      enabled: false,
      providerCapabilityId: undefined,
      spokenLanguage: "English",
      mode: "push-to-talk",
      autoSendAfterTranscription: true,
      silenceFinalizeSeconds: 0.8,
      noSpeechGate: { enabled: false, rmsThresholdDbfs: -55 },
      bargeIn: { stopTtsOnSpeech: true, queueWhileAgentRuns: true },
    })})`,
  );
  return {
    status: "ready",
    selectedProvider,
  };
}

async function installBundledFasterWhisperPackage(root) {
  const packageName = "ambient-faster-whisper-stt";
  const packageRoot = join(process.cwd(), "resources", "ambient-cli-packages", packageName);
  const importedRoot = join(root, ".ambient", "cli-packages", "imported", packageName);
  if (!existsSync(packageRoot)) throw new Error(`Bundled faster-whisper package is missing: ${packageRoot}`);
  await mkdir(dirname(importedRoot), { recursive: true });
  await cp(packageRoot, importedRoot, { recursive: true, force: true });
  await mkdir(join(root, ".ambient", "cli-packages"), { recursive: true });
  await writeFile(
    join(root, ".ambient", "cli-packages", "packages.json"),
    `${JSON.stringify({ packages: [{ source: "./.ambient/cli-packages/imported/ambient-faster-whisper-stt" }] }, null, 2)}\n`,
    "utf8",
  );
}

async function installLiveEventCollector(cdp) {
  await evaluate(
    cdp,
    `
    (() => {
      window.__ambientSttToolsLive?.unsubscribe?.();
      window.__ambientSttToolsLive = {
        statuses: [],
        messageDeltaCount: 0,
        toolEventCount: 0,
        toolMessageCount: 0,
        sawRunStart: false,
        sawRunIdle: false,
        sendResolved: false,
        error: undefined,
        toolNames: [],
      };
      window.__ambientSttToolsLive.unsubscribe = window.ambientDesktop.onEvent((event) => {
        if (event.type === "run-status") {
          window.__ambientSttToolsLive.statuses.push(event.status);
          if (event.status !== "idle") window.__ambientSttToolsLive.sawRunStart = true;
          if (window.__ambientSttToolsLive.sawRunStart && event.status === "idle") window.__ambientSttToolsLive.sawRunIdle = true;
        }
        if (event.type === "message-delta") window.__ambientSttToolsLive.messageDeltaCount += 1;
        if (event.type === "tool-event") window.__ambientSttToolsLive.toolEventCount += 1;
        if ((event.type === "message-created" || event.type === "message-updated") && event.message?.role === "tool") {
          if (event.type === "message-created") window.__ambientSttToolsLive.toolMessageCount += 1;
          const toolName = String(event.message.metadata?.toolName ?? "");
          if (toolName) window.__ambientSttToolsLive.toolNames.push(toolName);
        }
        if (event.type === "error") window.__ambientSttToolsLive.error = event.message;
      });
      return true;
    })()
  `,
  );
}

async function sendLivePrompt(cdp, input) {
  await evaluate(
    cdp,
    `
    (() => {
      const input = ${JSON.stringify(input)};
      window.ambientDesktop.sendMessage(input)
        .then(() => {
          window.__ambientSttToolsLive.sendResolved = true;
        })
        .catch((error) => {
          window.__ambientSttToolsLive.error = error instanceof Error ? error.message : String(error);
        });
      return true;
    })()
  `,
  );
}

async function waitForSttLiveCompletion(cdp, maxMs) {
  const deadline = Date.now() + maxMs;
  const approvals = [];
  while (Date.now() < deadline) {
    approvals.push(...await approveVisiblePermissionDialogs(cdp));
    const live = await getLiveState(cdp);
    if (live.error) throw new Error(live.error);
    if (live.sawRunIdle && live.sendResolved) return { approvals };
    await delay(500);
  }
  throw new Error(`Timed out after ${maxMs}ms waiting for the live Ambient STT tools run to complete. Approvals: ${approvals.join(" | ")}`);
}

async function approveVisiblePermissionDialogs(cdp) {
  return evaluate(
    cdp,
    `
    (() => {
      const approvals = [];
      for (const dialog of document.querySelectorAll(".permission-dialog")) {
        const title = dialog.querySelector("h2")?.textContent?.trim() || "permission";
        const button = [...dialog.querySelectorAll("button")].find((item) => item.classList.contains("primary-button") && /allow once/i.test(item.textContent ?? ""));
        if (!button) continue;
        button.click();
        approvals.push(title);
      }
      return approvals;
    })()
  `,
  );
}

async function getLiveState(cdp) {
  return evaluate(
    cdp,
    `
    (() => {
      const live = window.__ambientSttToolsLive;
      return live ? {
        statuses: live.statuses,
        messageDeltaCount: live.messageDeltaCount,
        toolEventCount: live.toolEventCount,
        toolMessageCount: live.toolMessageCount,
        toolNames: live.toolNames,
        sawRunStart: live.sawRunStart,
        sawRunIdle: live.sawRunIdle,
        sendResolved: live.sendResolved,
        error: live.error,
      } : undefined;
    })()
  `,
  );
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
  return `Electron output tail:\n${output.join("").split("\n").slice(-160).join("\n")}\n`;
}
