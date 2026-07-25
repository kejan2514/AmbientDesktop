#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const port = Number(process.env.AMBIENT_MEDIA_LIVE_CDP_PORT ?? 9482);
const timeoutMs = Number(process.env.AMBIENT_MEDIA_LIVE_TIMEOUT_MS ?? 300_000);
const workspace = await mkdtemp(join(tmpdir(), "ambient-media-live-workspace-"));
const output = [];
const children = new Set();
const ambientApiKey = await readAmbientApiKey();
let appInstance;

const mediaSpecs = [
  {
    kind: "image",
    fileName: "ambient-live-pixel.png",
    finalToken: "MEDIA_IMAGE_LIVE_OK",
    command: [
      "node <<'NODE'",
      "const { writeFileSync } = require('node:fs');",
      'writeFileSync("ambient-live-pixel.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ax8pWQAAAAASUVORK5CYII=", "base64"));',
      'console.log("Generated media artifact: ambient-live-pixel.png");',
      "NODE",
    ].join("\n"),
    validate: async (path) => {
      const bytes = await readFile(path);
      if (bytes[0] !== 0x89 || bytes.toString("ascii", 1, 4) !== "PNG") throw new Error(`${path} is not a PNG fixture.`);
    },
  },
  {
    kind: "audio",
    fileName: "ambient-live-tone.wav",
    finalToken: "MEDIA_AUDIO_LIVE_OK",
    command: [
      "node <<'NODE'",
      "const { writeFileSync } = require('node:fs');",
      "const sampleRate = 8000;",
      "const dataSize = sampleRate / 10;",
      "const buffer = Buffer.alloc(44 + dataSize);",
      'buffer.write("RIFF", 0);',
      "buffer.writeUInt32LE(36 + dataSize, 4);",
      'buffer.write("WAVEfmt ", 8);',
      "buffer.writeUInt32LE(16, 16);",
      "buffer.writeUInt16LE(1, 20);",
      "buffer.writeUInt16LE(1, 22);",
      "buffer.writeUInt32LE(sampleRate, 24);",
      "buffer.writeUInt32LE(sampleRate, 28);",
      "buffer.writeUInt16LE(1, 32);",
      "buffer.writeUInt16LE(8, 34);",
      'buffer.write("data", 36);',
      "buffer.writeUInt32LE(dataSize, 40);",
      "buffer.fill(128, 44);",
      'writeFileSync("ambient-live-tone.wav", buffer);',
      'console.log("Generated media artifact: ambient-live-tone.wav");',
      "NODE",
    ].join("\n"),
    validate: async (path) => {
      const bytes = await readFile(path);
      if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
        throw new Error(`${path} is not a WAV fixture.`);
      }
    },
  },
  {
    kind: "video",
    fileName: "ambient-live-clip.webm",
    finalToken: "MEDIA_VIDEO_LIVE_OK",
    command: [
      "node <<'NODE'",
      "const { writeFileSync } = require('node:fs');",
      'writeFileSync("ambient-live-clip.webm", Buffer.from("GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAIUEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEjTbuMU6uEHFO7a1OsggH+7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjIuMy4xMDBXQYxMYXZmNjIuMy4xMDBEiYhAXgAAAAAAABZUrmvIrgEAAAAAAAA/14EBc8WIk0hgEAEFKDKcgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QCYloA4JCwgRC6gRCagQJVsIRVuYEBElTDZ/tzc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYyLjMuMTAwc3PWY8CLY8WIk0hgEAEFKDJnyKFFo4dFTkNPREVSRIeUTGF2YzYyLjExLjEwMCBsaWJ2cHhnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAwLjEyMDAwMDAwMAAfQ7Z11ueBAKOjgQAAgBACAJ0BKhAAEAAARwiFhYiFhIgCAgAMDWAA/v+rUICjlYEAKACxAQAHEOwAGAAYWC/0AAgAAKOVgQBQALEBAAcQ7AAYABhYL/QACAAAHFO7a5G7j7OBALeK94EB8YIBo/CBAw==", "base64"));',
      'console.log("Generated media artifact: ambient-live-clip.webm");',
      "NODE",
    ].join("\n"),
    validate: async (path) => {
      const bytes = await readFile(path);
      if (bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3) {
        throw new Error(`${path} is not a WebM/Matroska fixture.`);
      }
    },
  },
];

try {
  await writeFile(
    join(workspace, "README.md"),
    [
      "# Ambient live media artifact workspace",
      "",
      "This temporary workspace validates real Ambient/Pi generated media artifact preview behavior.",
      "",
    ].join("\n"),
    "utf8",
  );

  appInstance = await launchApp();
  const summary = await runLiveMediaSmoke(appInstance.cdp);
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
  if (process.env.AMBIENT_MEDIA_LIVE_KEEP_WORKSPACE !== "1") {
    await rm(workspace, { recursive: true, force: true });
  }
}

console.log("Live Ambient media artifact smoke passed.");

async function runLiveMediaSmoke(cdp) {
  const state = await desktopState(cdp);
  if (!state.provider.hasApiKey) {
    throw new Error(
      [
        "Ambient API key is missing.",
        "Save a key in the app, or launch this script with AMBIENT_API_KEY/AMBIENT_AGENT_AMBIENT_API_KEY.",
        "Keys can be created at https://app.ambient.xyz/keys.",
      ].join(" "),
    );
  }

  const keyCheck = await evaluate(cdp, "window.ambientDesktop.testAmbientApiKey()");
  if (!keyCheck?.ok) throw new Error(`Ambient API key check failed: ${keyCheck?.message ?? "unknown error"}`);

  const summaries = [];
  for (const spec of mediaSpecs) {
    summaries.push(await runMediaPrompt(cdp, state, spec));
  }

  await verifyModal(cdp, "image", "ambient-live-pixel.png");
  await verifyModal(cdp, "video", "ambient-live-clip.webm");

  return {
    workspace,
    model: process.env.AMBIENT_MEDIA_LIVE_MODEL || state.settings.model,
    artifacts: summaries,
  };
}

async function runMediaPrompt(cdp, state, spec) {
  await installLiveEventCollector(cdp);
  const prompt = [
    "This is a live product smoke test for Ambient Desktop generated media artifact previews.",
    "Use the bash tool exactly once to run this command in the current workspace:",
    "```bash",
    spec.command,
    "```",
    `The command must create ${spec.fileName} and print the exact generated artifact line included in the command.`,
    `After the tool succeeds, reply with exactly: ${spec.finalToken}`,
    "Do not embed base64 media in your assistant response. Do not use the network. Do not ask for confirmation.",
  ].join("\n");

  await sendLivePrompt(cdp, {
    threadId: state.activeThreadId,
    content: prompt,
    permissionMode: "full-access",
    collaborationMode: "agent",
    model: process.env.AMBIENT_MEDIA_LIVE_MODEL || state.settings.model,
    thinkingLevel: "low",
  });

  await waitFor(cdp, () => Boolean(window.__ambientMediaLive?.sawRunStart), `${spec.fileName} run start`, 45_000);
  const artifactPath = join(workspace, spec.fileName);
  await waitForFile(artifactPath, spec.validate, timeoutMs);
  await waitForLiveCompletion(cdp, timeoutMs);
  await waitForArtifactPreview(cdp, spec);

  const live = await getLiveState(cdp);
  const nextState = await desktopState(cdp);
  const assistantText = nextState.messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.content)
    .join("\n");
  if (live.error) throw new Error(`Live Ambient media run failed: ${live.error}`);
  if (!assistantText.includes(spec.finalToken)) {
    throw new Error(`Live Ambient media run did not finish with ${spec.finalToken}. Assistant text: ${assistantText.slice(-1000)}`);
  }

  const fileStat = await stat(artifactPath);
  return {
    kind: spec.kind,
    fileName: spec.fileName,
    bytes: fileStat.size,
    toolEventCount: live.toolEventCount,
    toolMessageCount: live.toolMessageCount,
    toolNames: live.toolNames,
  };
}

async function waitForArtifactPreview(cdp, spec) {
  await waitFor(
    cdp,
    (fileName, kind) => {
      const strip = [...document.querySelectorAll(".media-artifact-strip")].find((candidate) => candidate.textContent?.includes(fileName));
      if (!strip) return false;
      if (kind === "image") {
        const image = strip.querySelector(`.inline-media-preview.image img[alt="${CSS.escape(fileName)}"]`);
        return Boolean(image && image.naturalWidth > 0);
      }
      if (kind === "audio") return Boolean(strip.querySelector('.inline-media-preview.audio audio[src^="ambient-media://"]'));
      return Boolean(strip.querySelector('.inline-media-preview.video video[src^="ambient-media://"]'));
    },
    `${spec.fileName} inline media artifact preview`,
    45_000,
    [spec.fileName, spec.kind],
  );
}

async function verifyModal(cdp, kind, fileName) {
  const clicked = await evaluate(
    cdp,
    `
    (() => {
      const fileName = ${JSON.stringify(fileName)};
      const kind = ${JSON.stringify(kind)};
      const strip = [...document.querySelectorAll(".media-artifact-strip")].find((candidate) => candidate.textContent?.includes(fileName));
      const preview = strip?.querySelector(\`.inline-media-preview.\${kind}\`);
      if (!preview || typeof preview.click !== "function") return false;
      preview.click();
      return true;
    })()
  `,
  );
  if (!clicked) throw new Error(`Unable to click ${kind} artifact preview for ${fileName}.`);
  await waitFor(
    cdp,
    (modalKind, modalFileName) => {
      if (modalKind === "image") {
        const image = document.querySelector(`.media-modal img[alt="${CSS.escape(modalFileName)}"]`);
        return Boolean(image && image.naturalWidth > 0);
      }
      return Boolean(document.querySelector('.media-modal video[src^="ambient-media://"]'));
    },
    `${fileName} media modal`,
    20_000,
    [kind, fileName],
  );
  await evaluate(cdp, `document.querySelector('button[aria-label="Close media preview"]')?.click()`);
  await waitFor(cdp, () => !document.querySelector(".media-modal"), `${fileName} media modal close`);
}

async function launchApp() {
  const child = spawn(
    "pnpm",
    ["exec", "electron-vite", "dev", "--", `--remote-debugging-port=${port}`],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AMBIENT_DESKTOP_WORKSPACE: workspace,
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
  await waitFor(cdp, () => document.body?.innerText.includes("Ambient"), "main shell", 30_000);
  return { child, cdp };
}

async function installLiveEventCollector(cdp) {
  await evaluate(
    cdp,
    `
    (() => {
      window.__ambientMediaLive?.unsubscribe?.();
      window.__ambientMediaLive = {
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
      window.__ambientMediaLive.unsubscribe = window.ambientDesktop.onEvent((event) => {
        if (event.type === "run-status") {
          window.__ambientMediaLive.statuses.push(event.status);
          if (event.status !== "idle") window.__ambientMediaLive.sawRunStart = true;
          if (window.__ambientMediaLive.sawRunStart && event.status === "idle") window.__ambientMediaLive.sawRunIdle = true;
        }
        if (event.type === "message-delta") window.__ambientMediaLive.messageDeltaCount += 1;
        if (event.type === "tool-event") window.__ambientMediaLive.toolEventCount += 1;
        if ((event.type === "message-created" || event.type === "message-updated") && event.message?.role === "tool") {
          if (event.type === "message-created") window.__ambientMediaLive.toolMessageCount += 1;
          const toolName = String(event.message.metadata?.toolName ?? "");
          if (toolName) window.__ambientMediaLive.toolNames.push(toolName);
        }
        if (event.type === "error") window.__ambientMediaLive.error = event.message;
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
          window.__ambientMediaLive.sendResolved = true;
        })
        .catch((error) => {
          window.__ambientMediaLive.error = error instanceof Error ? error.message : String(error);
        });
      return true;
    })()
  `,
  );
}

async function waitForLiveCompletion(cdp, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const live = await getLiveState(cdp);
    if (live.error) throw new Error(live.error);
    if (live.sawRunIdle && live.sendResolved) return;
    await delay(1_000);
  }
  throw new Error(`Timed out after ${maxMs}ms waiting for the live Ambient media run to complete.`);
}

async function getLiveState(cdp) {
  return evaluate(
    cdp,
    `
    (() => {
      const live = window.__ambientMediaLive;
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

async function waitForFile(path, validate, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      await validate(path);
      return;
    }
    await delay(1_000);
  }
  throw new Error(`Timed out after ${maxMs}ms waiting for ${path}.`);
}

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
            }, 15_000);
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
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Runtime.evaluate failed.");
  return result.result?.value;
}

async function waitFor(cdp, predicate, label, maxMs = 10_000, args = []) {
  const expression = `(${predicate.toString()})(...${JSON.stringify(args)})`;
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
  return `Electron output tail:\n${output.join("").split("\n").slice(-120).join("\n")}\n`;
}
