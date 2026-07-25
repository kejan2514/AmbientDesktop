#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "ambient-local-dogfood-"));
const project = join(root, "main-project");
const alternateProject = join(root, "alternate-project");
const userData = join(root, "user-data");
const cdpPort = Number(process.env.AMBIENT_DOGFOOD_CDP_PORT || (await findOpenPort(9580)));
const children = new Set();
const transcript = [];
const report = {
  root,
  project,
  alternateProject,
  startedAt: new Date().toISOString(),
  tasks: [],
  checks: [],
};

let appInstance;
try {
  await seedProject(project, "main");
  await seedProject(alternateProject, "alternate");
  await mkdir(userData, { recursive: true });
  await writeFile(join(userData, "projects.json"), JSON.stringify({ version: 1, paths: [project, alternateProject] }, null, 2), "utf8");

  appInstance = await launchApp();
  const cdp = appInstance.cdp;
  await expectText(cdp, "Ambient");
  await evaluate(cdp, "window.ambientDesktop.setOrchestrationAutoDispatchEnabled({ enabled: false }).then(() => true)");

  await coverPriorityAndManualRun(cdp);
  await coverProjectScopedManualRun(cdp);
  await coverAutoDispatchRun(cdp);
  await coverScheduleCreation(cdp);
  await coverRefreshButton(cdp);

  report.finishedAt = new Date().toISOString();
  report.status = "passed";
  await writeFile(join(root, "local-capability-dogfood-report.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(`Local capability dogfood passed. Report: ${join(root, "local-capability-dogfood-report.json")}`);
} catch (error) {
  report.finishedAt = new Date().toISOString();
  report.status = "failed";
  report.error = error instanceof Error ? error.stack || error.message : String(error);
  report.transcriptTail = transcript.slice(-80);
  await writeFile(join(root, "local-capability-dogfood-report.json"), JSON.stringify(report, null, 2), "utf8").catch(() => undefined);
  console.error(`Local capability dogfood failed. Report: ${join(root, "local-capability-dogfood-report.json")}`);
  console.error(outputTail());
  throw error;
} finally {
  if (appInstance) await shutdownApp(appInstance);
  for (const child of [...children]) await terminateProcessTree(child);
}

async function coverPriorityAndManualRun(cdp) {
  await createTask(cdp, {
    title: "Dogfood vector Pong arcade",
    description:
      "Create vector-pong.html with a self-contained black-background vector-graphics Pong-style arcade game. Use canvas line art, paddles, ball, score display, and simple keyboard controls. Also write dogfood-summary.md with DOGFOOD_DONE and a short proof summary.",
    state: "ready",
    priority: 1,
    labels: ["dogfood", "arcade", "manual"],
    projectPath: project,
  });
  await createTask(cdp, {
    title: "Dogfood lower-priority backlog note",
    description: "This low priority task should not be prepared before the priority 1 arcade task.",
    state: "ready",
    priority: 9,
    labels: ["dogfood", "priority"],
    projectPath: project,
  });
  const prepared = await prepareNext(cdp);
  assert(prepared.prepared.length === 1, `Expected one prepared priority task, got ${prepared.prepared.length}.`);
  assert(prepared.prepared[0].title === "Dogfood vector Pong arcade", `Priority scheduling selected ${prepared.prepared[0].title}.`);
  const run = await runForTaskTitle(cdp, "Dogfood vector Pong arcade", "prepared");
  await startRun(cdp, run.id);
  const finished = await waitForRunTerminal(cdp, run.id, "manual vector arcade run", 540_000);
  assertTerminalRun(finished, "manual vector arcade run");
  await assertWorkspaceFile(finished.workspacePath, "vector-pong.html", ["canvas", "Pong"]);
  await assertWorkspaceFile(finished.workspacePath, "dogfood-summary.md", ["DOGFOOD_DONE"]);
  report.tasks.push({ title: "Dogfood vector Pong arcade", runId: run.id, status: finished.status, workspacePath: finished.workspacePath });
}

async function coverProjectScopedManualRun(cdp) {
  await createTask(cdp, {
    title: "Dogfood LLM knowledge document",
    description:
      "In dogfood-knowledge-brief.md, write a concise LLM-knowledge brief explaining why 1970s vector arcade games had distinctive visual constraints. Include DOGFOOD_DONE.",
    state: "ready",
    priority: 0,
    labels: ["dogfood", "document", "knowledge"],
    projectPath: alternateProject,
  });
  const prepared = await prepareNext(cdp);
  assert(prepared.prepared.length === 1, `Expected one alternate project prepared task, got ${prepared.prepared.length}.`);
  assert(prepared.prepared[0].workspacePath.startsWith(join(alternateProject, ".ambient-codex")), `Prepared workspace did not use alternate project: ${prepared.prepared[0].workspacePath}`);
  const run = await runForTaskTitle(cdp, "Dogfood LLM knowledge document", "prepared");
  await startRun(cdp, run.id);
  const finished = await waitForRunTerminal(cdp, run.id, "alternate project document run", 540_000);
  assertTerminalRun(finished, "alternate project document run");
  await assertWorkspaceFile(finished.workspacePath, "dogfood-knowledge-brief.md", ["DOGFOOD_DONE", "vector"]);
  report.tasks.push({ title: "Dogfood LLM knowledge document", runId: run.id, status: finished.status, workspacePath: finished.workspacePath });
}

async function coverAutoDispatchRun(cdp) {
  await createTask(cdp, {
    title: "Dogfood calendar appointment check",
    description:
      "Read appointments.ics from the prepared workspace. Write dogfood-calendar-summary.md listing the next appointments, their local times, and one preparation note. Include DOGFOOD_DONE.",
    state: "ready",
    priority: 0,
    labels: ["dogfood", "calendar", "trigger:auto-dispatch"],
    projectPath: project,
  });
  await evaluate(cdp, "window.ambientDesktop.setOrchestrationAutoDispatchEnabled({ enabled: true }).then(() => true)");
  const started = await waitForAutoDispatchStart(cdp, "Dogfood calendar appointment check", 90_000);
  assert(started.title === "Dogfood calendar appointment check", `Auto-dispatch started unexpected task: ${started.title}.`);
  await evaluate(cdp, "window.ambientDesktop.setOrchestrationAutoDispatchEnabled({ enabled: false }).then(() => true)");
  const finished = await waitForRunTerminal(cdp, started.runId, "auto-dispatch calendar run", 540_000);
  assertTerminalRun(finished, "auto-dispatch calendar run");
  await assertWorkspaceFile(finished.workspacePath, "dogfood-calendar-summary.md", ["DOGFOOD_DONE"]);
  await assertWorkspaceFileCaseInsensitive(finished.workspacePath, "dogfood-calendar-summary.md", ["design review"]);
  report.tasks.push({ title: "Dogfood calendar appointment check", runId: started.runId, status: finished.status, workspacePath: finished.workspacePath });
}

async function coverScheduleCreation(cdp) {
  const board = await createTask(cdp, {
    title: "Dogfood scheduled local task shell",
    description: "Scheduled task fixture used to verify Local Task schedule creation.",
    state: "todo",
    priority: 5,
    labels: ["dogfood", "scheduled"],
    projectPath: project,
  });
  const task = board.tasks.find((candidate) => candidate.title === "Dogfood scheduled local task shell");
  assert(task, "Scheduled fixture task was not created.");
  const schedules = await evaluate(
    cdp,
    `window.ambientDesktop.createAutomationSchedule(${JSON.stringify({
      targetKind: "local_task",
      targetId: task.id,
      preset: "daily",
      timezone: "America/Phoenix",
      enabled: true,
      skipIfActive: true,
    })})`,
  );
  const schedule = schedules.find((item) => item.targetId === task.id);
  assert(schedule?.targetKind === "local_task" && schedule.enabled, "Local Task schedule was not created as enabled.");
  report.checks.push({ name: "schedule creation", scheduleId: schedule.id, targetId: task.id });
}

async function coverRefreshButton(cdp) {
  await clickWorkflowAgentsLocalTasks(cdp);
  await clickButton(cdp, "Refresh");
  await waitFor(cdp, () => document.body.innerText.includes("Auto-dispatch"), "refresh kept local task status visible", 10_000);
  report.checks.push({ name: "refresh local task surface", status: "passed" });
}

async function seedProject(target, label) {
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
      "  poll_interval_ms: 2000",
      "  max_concurrent_agents: 1",
      "  max_turns: 1",
      "  stall_timeout_ms: 240000",
      "  auto_dispatch: true",
      "workspace:",
      "  strategy: git-worktree",
      "  root: .ambient-codex/local-dogfood-workspaces",
      "  branch_prefix: dogfood/",
      "  reuse_existing: false",
      "agent:",
      "  permission_mode: workspace",
      "  thinking_level: low",
      "proof_of_work:",
      "  require_diff_summary: true",
      "  require_tests: false",
      "  require_screenshots: false",
      "---",
      "You are dogfooding Ambient Local Tasks in the prepared workspace.",
      "Complete {{ task.identifier }}: {{ task.title }}.",
      "",
      "Task description:",
      "{{ task.description }}",
      "",
      "Rules:",
      "- Work only in the prepared workspace.",
      "- Needed project files are already present in the prepared workspace; do not inspect absolute project-root paths.",
      "- Create the exact artifact files requested by the task description.",
      "- Keep scope small and finish in one pass.",
      "- Include the literal marker DOGFOOD_DONE in the requested summary/document file.",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(target, "appointments.ics"),
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      `PRODID:-//Ambient Dogfood ${label}//EN`,
      "BEGIN:VEVENT",
      "UID:design-review@example.test",
      "DTSTART:20260509T160000Z",
      "DTEND:20260509T163000Z",
      "SUMMARY:Design review",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:retro@example.test",
      "DTSTART:20260510T170000Z",
      "DTEND:20260510T174500Z",
      "SUMMARY:Planning retro",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n"),
    "utf8",
  );
  await runCommand("git", ["init"], target);
  await runCommand("git", ["config", "user.email", "dogfood@example.test"], target);
  await runCommand("git", ["config", "user.name", "Ambient Dogfood"], target);
  await runCommand("git", ["add", "WORKFLOW.md", "appointments.ics"], target);
  await runCommand("git", ["commit", "-m", `Seed ${label} dogfood project`], target);
}

async function launchApp() {
  const ambientApiKey = await readAmbientApiKey();
  const child = spawn("pnpm", ["exec", "electron-vite", "dev", "--", `--remote-debugging-port=${cdpPort}`], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AMBIENT_DESKTOP_WORKSPACE: project,
      AMBIENT_E2E: "1",
      AMBIENT_E2E_USER_DATA: userData,
      AMBIENT_CHAT_PI_STREAM_IDLE_TIMEOUT_MS: "240000",
      ...(ambientApiKey ? { AMBIENT_API_KEY: ambientApiKey, AMBIENT_AGENT_AMBIENT_API_KEY: ambientApiKey } : {}),
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

async function createTask(cdp, input) {
  return evaluate(cdp, `window.ambientDesktop.createOrchestrationTask(${JSON.stringify(input)})`);
}

async function prepareNext(cdp) {
  return evaluate(cdp, "window.ambientDesktop.prepareNextOrchestrationTasks()");
}

async function startRun(cdp, runId) {
  await evaluate(cdp, `window.ambientDesktop.startOrchestrationRun({ runId: ${JSON.stringify(runId)} }).then(() => true)`);
}

async function runForTaskTitle(cdp, title, status) {
  const board = await evaluate(cdp, "window.ambientDesktop.listOrchestrationBoard()");
  const task = board.tasks.find((candidate) => candidate.title === title);
  assert(task, `Task not found: ${title}`);
  const run = board.runs.find((candidate) => candidate.taskId === task.id && (!status || candidate.status === status));
  assert(run, `Run with status ${status} not found for task: ${title}`);
  return run;
}

async function waitForRunTerminal(cdp, runId, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const active = new Set(["claimed", "prepared", "preparing", "running", "retry_queued"]);
  while (Date.now() < deadline) {
    const board = await evaluate(cdp, "window.ambientDesktop.listOrchestrationBoard()");
    const run = board.runs.find((candidate) => candidate.id === runId);
    if (run && !active.has(run.status)) return run;
    await delay(2_000);
  }
  throw new Error(`Timed out waiting for ${label} to finish.`);
}

async function waitForAutoDispatchStart(cdp, title, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await evaluate(cdp, "window.ambientDesktop.getOrchestrationAutoDispatchStatus()");
    const started = status.lastStartedRuns.find((item) => item.title === title);
    if (started) return started;
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for auto-dispatch to start ${title}.`);
}

function assertTerminalRun(run, label) {
  if (run.status !== "completed") {
    throw new Error(`${label} ended with ${run.status}: ${run.error || "no error"}`);
  }
}

async function assertWorkspaceFile(workspacePath, relativePath, needles) {
  const target = join(workspacePath, relativePath);
  assert(existsSync(target), `Expected artifact file: ${target}`);
  const content = await readFile(target, "utf8");
  for (const needle of needles) assert(content.includes(needle), `${relativePath} did not include ${needle}.`);
  report.checks.push({ name: "artifact", path: target, bytes: content.length });
}

async function assertWorkspaceFileCaseInsensitive(workspacePath, relativePath, needles) {
  const target = join(workspacePath, relativePath);
  assert(existsSync(target), `Expected artifact file: ${target}`);
  const content = (await readFile(target, "utf8")).toLowerCase();
  for (const needle of needles) assert(content.includes(needle.toLowerCase()), `${relativePath} did not include ${needle}.`);
}

async function clickWorkflowAgentsLocalTasks(cdp) {
  await clickButton(cdp, "Workflow Agents");
  await waitFor(cdp, () => document.body.innerText.includes("Workflow Agents"), "workflow agents pane");
  await clickButton(cdp, "Local Tasks");
  await waitFor(cdp, () => document.body.innerText.includes("Local Tasks"), "local tasks pane");
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

async function clickButton(cdp, label) {
  const clicked = await evaluate(
    cdp,
    `
    (() => {
      const needle = ${JSON.stringify(label)};
      const buttons = [...document.querySelectorAll("button")].filter((button) => {
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      });
      const button =
        buttons.find((item) => item.textContent?.trim() === needle) ??
        buttons.find((item) => item.textContent?.includes(needle)) ??
        buttons.find((item) => item.title?.includes(needle) || item.getAttribute("aria-label")?.includes(needle));
      if (!button) return false;
      button.click();
      return true;
    })()
  `,
  );
  assert(clicked, `Button not found: ${label}`);
}

async function findOpenPort(startPort) {
  for (let candidate = startPort; candidate < startPort + 100; candidate += 1) {
    if (await canListenOnPort(candidate)) return candidate;
  }
  throw new Error(`Unable to find open port from ${startPort}.`);
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

function waitForProcessExit(proc, timeoutMs) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return Promise.race([new Promise((resolve) => proc.once("exit", resolve)), delay(timeoutMs)]);
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
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function outputTail() {
  return transcript.slice(-80).join("").slice(-8000);
}
