#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "ambient-local-restart-dogfood-"));
const project = join(root, "project");
const userData = join(root, "user-data");
const cdpPort = Number(process.env.AMBIENT_LOCAL_RESTART_DOGFOOD_CDP_PORT || (await findOpenPort(9680)));
const children = new Set();
const transcript = [];
const report = {
  root,
  project,
  startedAt: new Date().toISOString(),
  checks: [],
};

let appInstance;
try {
  const ambientApiKey = await readAmbientApiKey();
  if (!ambientApiKey) throw new Error("Set AMBIENT_API_KEY or provide ignored-provider-key-file.txt before running local restart dogfood.");

  await seedProject(project);
  await mkdir(userData, { recursive: true });
  await writeFile(join(userData, "projects.json"), JSON.stringify({ version: 1, paths: [project] }, null, 2), "utf8");

  appInstance = await launchApp({ ambientApiKey });
  await expectText(appInstance.cdp, "Ambient");
  await evaluate(appInstance.cdp, "window.ambientDesktop.setOrchestrationAutoDispatchEnabled({ enabled: false }).then(() => true)");

  const task = await createRestartDogfoodTask(appInstance.cdp);
  const prepared = await evaluate(appInstance.cdp, "window.ambientDesktop.prepareNextOrchestrationTasks()");
  assert(prepared.prepared.length === 1, `Expected one prepared restart dogfood task, got ${prepared.prepared.length}.`);
  const run = await runForTask(appInstance.cdp, task.id, "prepared");

  await evaluate(appInstance.cdp, "window.ambientDesktop.setOrchestrationAutoDispatchEnabled({ enabled: true }).then(() => true)");
  await startRun(appInstance.cdp, run.id);
  const running = await waitForRun(appInstance.cdp, run.id, (candidate) => candidate.status === "running", "run to become active", 30_000);
  assert(running.threadId, "Running dogfood run did not have a thread id.");
  assert(existsSync(running.workspacePath), `Prepared workspace is missing: ${running.workspacePath}`);
  report.checks.push({
    name: "started run before forced restart",
    runId: running.id,
    taskId: running.taskId,
    threadId: running.threadId,
    workspacePath: running.workspacePath,
  });

  await forceKillApp(appInstance);
  appInstance = undefined;
  report.checks.push({ name: "forced app stop while local task was running" });

  appInstance = await launchApp({ ambientApiKey });
  await expectText(appInstance.cdp, "Ambient");
  const resumed = await waitForRun(
    appInstance.cdp,
    run.id,
    (candidate) => {
      const recovery = candidate.proofOfWork?.recovery;
      return (
        candidate.threadId === running.threadId &&
        candidate.workspacePath === running.workspacePath &&
        recovery?.type === "desktop-restart" &&
        recovery?.resumeAvailable === true &&
        recovery?.autoContinueAttempts === 1 &&
        candidate.status !== "stalled"
      );
    },
    "auto-dispatch to continue the interrupted run",
    90_000,
  );
  const autoStatus = await evaluate(appInstance.cdp, "window.ambientDesktop.getOrchestrationAutoDispatchStatus()");
  report.checks.push({
    name: "auto-dispatch continued interrupted run",
    runId: resumed.id,
    status: resumed.status,
    threadId: resumed.threadId,
    workspacePath: resumed.workspacePath,
    recovery: resumed.proofOfWork?.recovery,
    lastStartedRuns: autoStatus.lastStartedRuns,
  });

  if (resumed.status === "running") {
    await evaluate(appInstance.cdp, `window.ambientDesktop.cancelOrchestrationRun({ runId: ${JSON.stringify(resumed.id)} }).then(() => true)`).catch(
      () => undefined,
    );
  }

  report.finishedAt = new Date().toISOString();
  report.status = "passed";
  await writeFile(join(root, "local-task-restart-dogfood-report.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(`Local Task restart dogfood passed. Report: ${join(root, "local-task-restart-dogfood-report.json")}`);
} catch (error) {
  report.finishedAt = new Date().toISOString();
  report.status = "failed";
  report.error = error instanceof Error ? error.stack || error.message : String(error);
  report.transcriptTail = transcript.slice(-100);
  await writeFile(join(root, "local-task-restart-dogfood-report.json"), JSON.stringify(report, null, 2), "utf8").catch(() => undefined);
  console.error(`Local Task restart dogfood failed. Report: ${join(root, "local-task-restart-dogfood-report.json")}`);
  console.error(outputTail());
  throw error;
} finally {
  if (appInstance) await shutdownApp(appInstance);
  for (const child of [...children]) await terminateProcessTree(child);
}

async function createRestartDogfoodTask(cdp) {
  const board = await evaluate(
    cdp,
    `window.ambientDesktop.createOrchestrationTask(${JSON.stringify({
      title: "Dogfood interrupted local task resume",
      description: [
        "This is an Ambient Local Task restart dogfood.",
        "First write dogfood-started.txt containing RESTART_DOGFOOD_STARTED.",
        "Then pause for at least 90 seconds before writing dogfood-resumed.md with DOGFOOD_DONE.",
        "If this task is resumed after interruption, inspect the workspace first and continue from the existing files.",
      ].join(" "),
      state: "ready",
      priority: 0,
      labels: ["dogfood", "restart", "trigger:auto-dispatch"],
      projectPath: project,
    })})`,
  );
  const task = board.tasks.find((candidate) => candidate.title === "Dogfood interrupted local task resume");
  assert(task, "Restart dogfood task was not created.");
  return task;
}

async function seedProject(target) {
  await mkdir(target, { recursive: true });
  await writeFile(
    join(target, "WORKFLOW.md"),
    [
      "---",
      "tracker:",
      "  active_states: [ready]",
      "  terminal_states: [done, canceled, duplicate]",
      "  review_states: [needs_review, review]",
      "orchestration:",
      "  poll_interval_ms: 30000",
      "  max_concurrent_agents: 1",
      "  max_turns: 1",
      "  stall_timeout_ms: 240000",
      "  auto_dispatch: true",
      "workspace:",
      "  strategy: directory",
      "  root: .ambient-codex/restart-dogfood-workspaces",
      "  reuse_existing: true",
      "agent:",
      "  permission_mode: workspace",
      "  thinking_level: low",
      "proof_of_work:",
      "  require_diff_summary: true",
      "  require_tests: false",
      "  require_screenshots: false",
      "---",
      "You are dogfooding Ambient Local Task restart recovery in the prepared workspace.",
      "Complete {{ task.identifier }}: {{ task.title }}.",
      "",
      "Task description:",
      "{{ task.description }}",
      "",
      "Rules:",
      "- Work only in the prepared workspace.",
      "- Do not inspect absolute project-root paths.",
      "- Keep scope small and use shell/file tools when useful.",
      "- Include the literal marker DOGFOOD_DONE in dogfood-resumed.md when the task is actually complete.",
    ].join("\n"),
    "utf8",
  );
}

async function launchApp({ ambientApiKey }) {
  const child = spawn("pnpm", ["exec", "electron-vite", "dev", "--", `--remote-debugging-port=${cdpPort}`], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AMBIENT_DESKTOP_WORKSPACE: project,
      AMBIENT_E2E: "1",
      AMBIENT_E2E_USER_DATA: userData,
      AMBIENT_CHAT_PI_STREAM_IDLE_TIMEOUT_MS: "240000",
      AMBIENT_API_KEY: ambientApiKey,
      AMBIENT_AGENT_AMBIENT_API_KEY: ambientApiKey,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  child.stdout.on("data", (chunk) => transcript.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => transcript.push(chunk.toString("utf8")));
  const target = await waitForTarget(cdpPort);
  await delay(750);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await waitFor(cdp, () => document.body?.innerText.includes("Ambient"), "Ambient shell", 60_000);
  return { child, cdp };
}

async function startRun(cdp, runId) {
  await evaluate(cdp, `window.ambientDesktop.startOrchestrationRun({ runId: ${JSON.stringify(runId)} }).then(() => true)`);
}

async function runForTask(cdp, taskId, status) {
  const board = await evaluate(cdp, "window.ambientDesktop.listOrchestrationBoard()");
  const run = board.runs.find((candidate) => candidate.taskId === taskId && (!status || candidate.status === status));
  assert(run, `Run with status ${status} not found for task: ${taskId}`);
  return run;
}

async function waitForRun(cdp, runId, predicate, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    const board = await evaluate(cdp, "window.ambientDesktop.listOrchestrationBoard()");
    latest = board.runs.find((candidate) => candidate.id === runId);
    if (latest && predicate(latest)) return latest;
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${label}. Latest run: ${JSON.stringify(latest, null, 2)}`);
}

async function readAmbientApiKey() {
  const existing = process.env.AMBIENT_API_KEY || process.env.AMBIENT_AGENT_AMBIENT_API_KEY;
  if (existing?.trim()) return existing.trim();
  const candidates = [
    process.env.AMBIENT_API_KEY_FILE,
    join(process.cwd(), "ignored-provider-key-file.txt"),
    join(dirname(process.cwd()), "ignored-provider-key-file.txt"),
    "/Users/example/Documents/ambientCoder/ignored-provider-key-file.txt",
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

async function waitForTarget(port) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const target = targets.find((item) => item.webSocketDebuggerUrl && item.type === "page") ?? targets[0];
      if (target?.webSocketDebuggerUrl) return target;
    } catch {
      // App is still starting.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for Electron CDP target on ${port}.`);
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let nextId = 1;
    const pending = new Map();
    const api = {
      debugContext: "",
      send(method, params = {}) {
        const id = nextId++;
        socket.send(JSON.stringify({ id, method, params }));
        return new Promise((innerResolve, innerReject) => {
          pending.set(id, { resolve: innerResolve, reject: innerReject });
          setTimeout(() => {
            if (!pending.has(id)) return;
            pending.delete(id);
            innerReject(new Error(`Timed out waiting for CDP ${method}: ${api.debugContext}`));
          }, 20_000);
        });
      },
      close() {
        socket.close();
      },
    };
    socket.addEventListener("open", () => resolve(api));
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
  const previousContext = cdp.debugContext;
  cdp.debugContext = expression.replace(/\s+/g, " ").slice(0, 220);
  const result = await cdp
    .send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    .finally(() => {
      cdp.debugContext = previousContext;
    });
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
  const bodyTail = await evaluate(cdp, "document.body.innerText.slice(-2000)").catch(() => "");
  throw new Error(`Timed out waiting for ${label}.\n\nBody tail:\n${bodyTail}`);
}

async function expectText(cdp, text) {
  const found = await evaluate(cdp, `document.body.innerText.includes(${JSON.stringify(text)})`);
  assert(found, `Expected page text to contain: ${text}`);
}

async function findOpenPort(startPort) {
  for (let candidate = startPort; candidate < startPort + 100; candidate += 1) {
    if (await canListenOnPort(candidate)) return candidate;
  }
  throw new Error(`Unable to find open port from ${startPort}.`);
}

function canListenOnPort(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port }, () => server.close(() => resolve(true)));
  });
}

async function shutdownApp(instance) {
  try {
    await instance.cdp.send("Browser.close");
  } catch {
    // Fall through to process cleanup.
  }
  try {
    instance.cdp.close();
  } catch {
    // Already closed.
  }
  await waitForProcessExit(instance.child, 5_000);
  await terminateProcessTree(instance.child);
}

async function forceKillApp(instance) {
  try {
    instance.cdp.close();
  } catch {
    // The process is about to be killed.
  }
  await killProcessTree(instance.child, "SIGKILL", 5_000);
}

function waitForProcessExit(proc, timeoutMs) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return Promise.race([new Promise((resolve) => proc.once("exit", resolve)), delay(timeoutMs)]);
}

async function terminateProcessTree(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await killProcessTree(proc, "SIGTERM", 1_500);
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await killProcessTree(proc, "SIGKILL", 3_000);
}

async function killProcessTree(proc, signal, timeoutMs) {
  children.delete(proc);
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise((resolve) => proc.once("exit", resolve));
  try {
    if (process.platform === "win32") proc.kill(signal);
    else process.kill(-proc.pid, signal);
  } catch {
    proc.kill(signal);
  }
  await Promise.race([exited, delay(timeoutMs)]);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function outputTail() {
  return transcript.slice(-100).join("").slice(-10000);
}
