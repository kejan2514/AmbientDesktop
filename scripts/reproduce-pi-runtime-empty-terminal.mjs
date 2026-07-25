#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
  defineTool,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const defaultSessionLog =
  "/Users/example/.ambient-hardening/bases/example-core-no-secrets/workspace/.ambient-codex/sessions/fb1c7ffc-732d-421c-a429-c66c4628bf60/2026-05-14T23-55-00-533Z_019e28ea-3e35-71f1-a6f9-5233bcce0cac.jsonl";
const continuationPrefix = "Ambient completed the most recent tool call, but no assistant-visible response followed.";

function parseArgs(argv) {
  const args = {
    mode: "replay-continuation",
    sessionLog: defaultSessionLog,
    timeoutMs: 240_000,
    steerDelayMs: 1_000,
    abortOnTerminal: false,
    abortDelayMs: 1_000,
    toolResultDelayMs: 0,
    promptLine: undefined,
    trace: undefined,
    repeat: 1,
    outputRoot: join(repoRoot, ".ambient", "repros", "pi-runtime-empty-terminal"),
    model: "zai-org/GLM-5.1-FP8",
    baseUrl: process.env.AMBIENT_BASE_URL || process.env.AMBIENT_AGENT_AMBIENT_BASE_URL || "https://api.ambient.xyz/v1",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };
    if (arg === "--mode") args.mode = next();
    else if (arg === "--session-log") args.sessionLog = next();
    else if (arg === "--timeout-ms") args.timeoutMs = Number(next());
    else if (arg === "--steer-delay-ms") args.steerDelayMs = Number(next());
    else if (arg === "--abort-on-terminal") args.abortOnTerminal = true;
    else if (arg === "--abort-delay-ms") args.abortDelayMs = Number(next());
    else if (arg === "--tool-result-delay-ms") args.toolResultDelayMs = Number(next());
    else if (arg === "--prompt-line") args.promptLine = Number(next());
    else if (arg === "--trace") args.trace = next();
    else if (arg === "--repeat") args.repeat = Number(next());
    else if (arg === "--output-root") args.outputRoot = next();
    else if (arg === "--model") args.model = next();
    else if (arg === "--base-url") args.baseUrl = next();
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) throw new Error("--timeout-ms must be a positive number");
  if (!Number.isFinite(args.steerDelayMs) || args.steerDelayMs < 0) throw new Error("--steer-delay-ms must be a non-negative number");
  if (!Number.isFinite(args.abortDelayMs) || args.abortDelayMs < 0) throw new Error("--abort-delay-ms must be a non-negative number");
  if (!Number.isFinite(args.toolResultDelayMs) || args.toolResultDelayMs < 0) {
    throw new Error("--tool-result-delay-ms must be a non-negative number");
  }
  if (args.promptLine !== undefined && (!Number.isInteger(args.promptLine) || args.promptLine <= 0)) {
    throw new Error("--prompt-line must be a positive 1-based JSONL line number");
  }
  if (args.mode === "replay-trace" && !args.trace) throw new Error("--trace is required for replay-trace.");
  if (args.mode === "replay-line" && (!args.sessionLog || !args.promptLine)) {
    throw new Error("--session-log and --prompt-line are required for replay-line.");
  }
  if (!Number.isInteger(args.repeat) || args.repeat <= 0) throw new Error("--repeat must be a positive integer");
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/reproduce-pi-runtime-empty-terminal.mjs --mode replay-continuation [--session-log PATH]
  node scripts/reproduce-pi-runtime-empty-terminal.mjs --mode replay-line --session-log PATH --prompt-line LINE [--repeat N]
  node scripts/reproduce-pi-runtime-empty-terminal.mjs --mode replay-trace --trace PATH [--repeat N]
  node scripts/reproduce-pi-runtime-empty-terminal.mjs --mode steer-after-tool [--abort-on-terminal]

Modes:
  replay-continuation  Open a copied Pi JSONL prefix, then prompt the exact post-tool continuation.
  replay-line          Copy a Pi JSONL prefix through the line before --prompt-line, then send that user message.
  replay-trace         Read an Ambient Pi stream trace artifact and replay its recorded prompt line.
  steer-after-tool     Start a fresh Pi session, force one no-op tool call, then steer the continuation while prompt() is still open.
`);
}

async function readApiKey() {
  for (const name of ["AMBIENT_API_KEY", "AMBIENT_AGENT_AMBIENT_API_KEY"]) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  const candidates = [
    process.env.AMBIENT_API_KEY_FILE,
    join(repoRoot, "ignored-provider-key-file.txt"),
    join(dirname(repoRoot), "ignored-provider-key-file.txt"),
    "/Users/example/Documents/ambientCoder/ignored-provider-key-file.txt",
    "/Users/example/Documents/New project 3/ignored-provider-key-file.txt",
    join(homedir(), "ignored-provider-key-file.txt"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const path = resolve(String(candidate));
    if (!existsSync(path)) continue;
    const value = (await readFile(path, "utf8")).trim();
    if (value) return value;
  }
  throw new Error("Ambient API key missing. Set AMBIENT_API_KEY or provide ignored-provider-key-file.txt.");
}

function normalizeBaseUrl(value) {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function ambientModel(modelId, baseUrl) {
  return {
    id: modelId,
    name: modelId.includes("GLM-5.1") ? "GLM-5.1 FP8" : modelId,
    api: "openai-completions",
    provider: "ambient",
    baseUrl: normalizeBaseUrl(baseUrl),
    compat: {
      supportsDeveloperRole: false,
      thinkingFormat: "zai",
      zaiToolStream: true,
    },
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 200000,
    maxTokens: 131072,
  };
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block && typeof block === "object" && block.type === "text") return String(block.text ?? "");
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function assistantStats(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  let textChars = 0;
  let toolCalls = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") textChars += String(block.text ?? "").length;
    if (block.type === "toolCall") toolCalls += 1;
  }
  return {
    textChars,
    toolCalls,
    stopReason: message?.stopReason,
    errorMessage: message?.errorMessage,
  };
}

async function loadJsonl(path) {
  const raw = await readFile(path, "utf8");
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Could not parse ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

function findContinuation(entries) {
  let fallback = undefined;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const message = entry?.message;
    if (entry?.type !== "message" || message?.role !== "user") continue;
    const text = textFromContent(message.content);
    if (!text.startsWith(continuationPrefix)) continue;
    const next = entries[index + 1]?.message;
    if (next?.role === "assistant" && next.stopReason === "aborted") {
      return { index, abortedIndex: index + 1, text };
    }
    fallback = { index, abortedIndex: undefined, text };
  }
  if (fallback) return fallback;
  throw new Error("No post-tool continuation prompt found in session log.");
}

function findPromptLine(entries, promptLine) {
  const index = promptLine - 1;
  const entry = entries[index];
  const message = entry?.message;
  if (entry?.type !== "message" || message?.role !== "user") {
    throw new Error(`Line ${promptLine} is not a user message in the Pi session log.`);
  }
  const text = textFromContent(message.content);
  if (!text.trim()) throw new Error(`Line ${promptLine} has no text content to replay.`);
  return { index, text };
}

async function replayTargetFromTrace(tracePath) {
  const trace = JSON.parse(await readFile(tracePath, "utf8"));
  const sessionLog = trace?.sessionFile;
  const promptLine = trace?.prompt?.userLine;
  if (!sessionLog || typeof sessionLog !== "string") throw new Error(`Trace ${tracePath} does not include sessionFile.`);
  if (!Number.isInteger(promptLine) || promptLine <= 0) throw new Error(`Trace ${tracePath} does not include prompt.userLine.`);
  return { sessionLog, promptLine };
}

function collectToolNames(entries) {
  const names = new Set(["bash", "edit", "write", "read", "grep", "find", "ls"]);
  for (const entry of entries) {
    const message = entry?.message;
    if (!message) continue;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === "toolCall" && block.name) names.add(String(block.name));
      }
    }
    if (message.role === "toolResult" && message.toolName) names.add(String(message.toolName));
  }
  return [...names].sort();
}

function makeNoopTool(name, options = {}) {
  return defineTool({
    name,
    label: name,
    description: `Repro harness no-op replacement for ${name}. Records that Pi attempted to execute this tool without mutating the workspace.`,
    parameters: Type.Object({}, { additionalProperties: Type.Any() }),
    async execute(_toolCallId, params) {
      if (options.delayMs) await sleep(options.delayMs);
      const content =
        options.content ??
        `Repro harness executed ${name} without side effects. Arguments: ${JSON.stringify(params ?? {}).slice(0, 1200)}`;
      return {
        content: [{ type: "text", text: content }],
        details: { repro: true, toolName: name },
      };
    },
  });
}

async function copySessionPrefix(entries, continuationIndex, outputDir) {
  const header = entries[0];
  if (header?.type !== "session") throw new Error("Session log does not start with a session header.");
  const sessionDir = join(outputDir, "session");
  await mkdir(sessionDir, { recursive: true });
  const sessionFile = join(sessionDir, "replay-prefix.jsonl");
  const copied = entries.slice(0, continuationIndex);
  await writeFile(sessionFile, `${copied.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  return { sessionFile, sessionDir, cwd: header.cwd || process.cwd(), copiedEntries: copied.length };
}

async function createHarnessSession({ cwd, outputDir, apiKey, model, toolNames, customTools }) {
  const agentDir = join(outputDir, "agent-home");
  await mkdir(agentDir, { recursive: true });

  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey("ambient", apiKey);
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  modelRegistry.registerProvider("ambient", {
    baseUrl: model.baseUrl,
    apiKey: "AMBIENT_API_KEY",
    api: "openai-completions",
    models: [model],
  });

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: {
      enabled: true,
      maxRetries: 1,
      baseDelayMs: 1_000,
      provider: { timeoutMs: 300_000, maxRetries: 0, maxRetryDelayMs: 1_000 },
    },
    steeringMode: "all",
    followUpMode: "all",
    defaultThinkingLevel: "xhigh",
    images: { blockImages: true },
    terminal: { showTerminalProgress: true },
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        let requestIndex = 0;
        pi.on("before_provider_request", async (event) => {
          requestIndex += 1;
          await writeFile(
            join(outputDir, `provider-request-${String(requestIndex).padStart(2, "0")}.json`),
            JSON.stringify(event.payload, null, 2),
            "utf8",
          );
          return undefined;
        });
        pi.on("after_provider_response", async (event) => {
          const headers =
            event.headers && typeof event.headers.entries === "function"
              ? Object.fromEntries(event.headers.entries())
              : event.headers && typeof event.headers === "object"
                ? event.headers
                : undefined;
          await writeFile(
            join(outputDir, `provider-response-${String(requestIndex).padStart(2, "0")}.json`),
            JSON.stringify({ status: event.status, headers }, null, 2),
            "utf8",
          );
        });
      },
    ],
    systemPrompt: [
      "You are Ambient Desktop's Pi runtime repro harness.",
      "Continue from the session context faithfully.",
      "Use tools only when necessary. The registered tools are safe no-op repro tools.",
    ].join("\n"),
  });
  await resourceLoader.reload();

  return {
    settingsManager,
    resourceLoader,
    sessionOptions: {
      cwd,
      agentDir,
      authStorage,
      modelRegistry,
      model,
      resourceLoader,
      settingsManager,
      thinkingLevel: "xhigh",
      tools: toolNames,
      customTools,
    },
  };
}

async function openReplaySession({ args, outputDir, apiKey, model }) {
  const entries = await loadJsonl(args.sessionLog);
  const continuation = findContinuation(entries);
  const { sessionFile, sessionDir, cwd, copiedEntries } = await copySessionPrefix(entries, continuation.index, outputDir);
  const toolNames = collectToolNames(entries.slice(0, continuation.index));
  const customTools = toolNames.map((name) => makeNoopTool(name, { delayMs: args.toolResultDelayMs }));
  const harness = await createHarnessSession({ cwd, outputDir, apiKey, model, toolNames, customTools });
  const sessionManager = SessionManager.open(sessionFile, sessionDir, cwd);
  const { session } = await createAgentSession({
    ...harness.sessionOptions,
    sessionManager,
  });
  await session.bindExtensions({});
  session.agent.toolExecution = "sequential";
  return {
    session,
    promptText: continuation.text,
    metadata: {
      mode: args.mode,
      sourceSessionLog: args.sessionLog,
      sourceContinuationLine: continuation.index + 1,
      sourceAbortedLine: continuation.abortedIndex === undefined ? undefined : continuation.abortedIndex + 1,
      copiedEntries,
      cwd,
      sessionFile,
      toolNames,
    },
  };
}

async function openReplayLineSession({ args, outputDir, apiKey, model }) {
  let sessionLog = args.sessionLog;
  let promptLine = args.promptLine;
  if (args.mode === "replay-trace") {
    const target = await replayTargetFromTrace(args.trace);
    sessionLog = target.sessionLog;
    promptLine = target.promptLine;
  }
  if (!sessionLog) throw new Error("--session-log is required for replay-line.");
  if (!promptLine) throw new Error("--prompt-line is required for replay-line.");
  const entries = await loadJsonl(sessionLog);
  const prompt = findPromptLine(entries, promptLine);
  const { sessionFile, sessionDir, cwd, copiedEntries } = await copySessionPrefix(entries, prompt.index, outputDir);
  const toolNames = collectToolNames(entries.slice(0, prompt.index));
  const customTools = toolNames.map((name) => makeNoopTool(name, { delayMs: args.toolResultDelayMs }));
  const harness = await createHarnessSession({ cwd, outputDir, apiKey, model, toolNames, customTools });
  const sessionManager = SessionManager.open(sessionFile, sessionDir, cwd);
  const { session } = await createAgentSession({
    ...harness.sessionOptions,
    sessionManager,
  });
  await session.bindExtensions({});
  session.agent.toolExecution = "sequential";
  return {
    session,
    promptText: prompt.text,
    metadata: {
      mode: args.mode,
      sourceTrace: args.trace,
      sourceSessionLog: sessionLog,
      sourcePromptLine: promptLine,
      copiedEntries,
      cwd,
      sessionFile,
      toolNames,
    },
  };
}

async function openSteerSession({ args, outputDir, apiKey, model }) {
  const cwd = await mkdtemp(join(tmpdir(), "ambient-pi-runtime-repro-workspace-"));
  const toolNames = ["repro_edit"];
  const customTools = [
    makeNoopTool("repro_edit", {
      delayMs: args.toolResultDelayMs,
      content: "Successfully replaced 1 block(s) in .ambient/capability-builder/packages/repro/scripts/run.mjs.",
    }),
  ];
  const harness = await createHarnessSession({ cwd, outputDir, apiKey, model, toolNames, customTools });
  const sessionManager = SessionManager.create(cwd, join(outputDir, "session"));
  const { session } = await createAgentSession({
    ...harness.sessionOptions,
    sessionManager,
  });
  await session.bindExtensions({});
  session.agent.toolExecution = "sequential";
  return {
    session,
    promptText: [
      "Call the repro_edit tool exactly once with any small JSON argument.",
      "Do not answer before the tool call.",
      "After the tool call result, continue with the user's requested next step.",
    ].join("\n"),
    steerText: [
      continuationPrefix,
      "Continue from the completed tool result now.",
      "Do not wait for a new user instruction unless the tool result is explicitly blocked on user input, approval, credentials, or an external action.",
      "If blocked, explain the exact next user action. Otherwise, summarize what happened and take the next required step.",
      "Most recent tool: repro_edit (done).",
    ].join("\n"),
    metadata: {
      mode: args.mode,
      cwd,
      sessionFile: session.sessionFile,
      toolNames,
      steerDelayMs: args.steerDelayMs,
      abortOnTerminal: args.abortOnTerminal,
      abortDelayMs: args.abortDelayMs,
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function summarizeEvent(event) {
  const base = { at: new Date().toISOString(), type: event?.type };
  if (event?.type === "message_start" || event?.type === "message_end") {
    const message = event.message;
    const summary = {
      ...base,
      role: message?.role,
      ...(message?.role === "assistant" ? assistantStats(message) : {}),
      ...(message?.role === "user" ? { textPreview: textFromContent(message.content).slice(0, 240) } : {}),
      ...(message?.role === "toolResult"
        ? {
            toolName: message.toolName,
            toolCallId: message.toolCallId,
            isError: Boolean(message.isError),
            textPreview: textFromContent(message.content).slice(0, 240),
          }
        : {}),
    };
    return summary;
  }
  if (event?.type === "message_update") {
    const update = event.assistantMessageEvent;
    return {
      ...base,
      updateType: update?.type,
      deltaChars: typeof update?.delta === "string" ? update.delta.length : undefined,
      textPreview: typeof update?.delta === "string" ? update.delta.slice(0, 120) : undefined,
      partialRole: update?.partial?.role,
    };
  }
  if (event?.type === "tool_execution_start" || event?.type === "tool_execution_update" || event?.type === "tool_execution_end") {
    return {
      ...base,
      toolName: event.toolName || event.name,
      toolCallId: event.toolCallId,
      isError: Boolean(event.isError),
    };
  }
  if (event?.type === "agent_end") {
    const assistantMessages = Array.isArray(event.messages) ? event.messages.filter((message) => message?.role === "assistant") : [];
    return {
      ...base,
      messageCount: Array.isArray(event.messages) ? event.messages.length : undefined,
      assistantCount: assistantMessages.length,
      assistantStats: assistantMessages.map(assistantStats),
    };
  }
  if (event?.type === "queue_update") {
    return {
      ...base,
      steering: Array.isArray(event.steering) ? event.steering.length : undefined,
      followUp: Array.isArray(event.followUp) ? event.followUp.length : undefined,
    };
  }
  if (event?.type === "auto_retry_start" || event?.type === "auto_retry_end") {
    return {
      ...base,
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
      delayMs: event.delayMs,
      success: event.success,
      errorMessage: event.errorMessage || event.finalError,
    };
  }
  return base;
}

async function runObservedPrompt({ session, promptText, steerText, args, eventPath }) {
  const events = [];
  const result = {
    promptResolved: false,
    promptError: undefined,
    steerIssued: false,
    abortIssued: false,
    emptyAssistantStartBeforePromptResolved: false,
    emptyTerminalAssistant: false,
    emptyAbortedAssistant: false,
    assistantTerminalBeforePromptResolved: false,
    agentEnded: false,
  };

  let promptSettled = false;
  let steerTimerSet = false;
  let abortTimerSet = false;

  const appendEvent = async (summary) => {
    events.push(summary);
    await writeFile(eventPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
  };

  const unsubscribe = session.subscribe((event) => {
    const summary = summarizeEvent(event);
    void appendEvent(summary);

    if (event?.type === "tool_execution_end" && steerText && !steerTimerSet) {
      steerTimerSet = true;
      setTimeout(() => {
        result.steerIssued = true;
        session.steer(steerText).catch((error) => {
          result.promptError = `steer failed: ${error instanceof Error ? error.message : String(error)}`;
        });
      }, args.steerDelayMs);
    }

    if (event?.type === "message_end" && event.message?.role === "assistant") {
      const stats = assistantStats(event.message);
      const empty = stats.textChars === 0 && stats.toolCalls === 0;
      if (empty) result.emptyTerminalAssistant = true;
      if (empty && (stats.stopReason === "aborted" || stats.stopReason === "error")) result.emptyAbortedAssistant = true;
      if (empty && !promptSettled) result.assistantTerminalBeforePromptResolved = true;
      if (args.abortOnTerminal && empty && !promptSettled && !abortTimerSet) {
        abortTimerSet = true;
        setTimeout(() => {
          result.abortIssued = true;
          session.abort().catch((error) => {
            result.promptError = `abort failed: ${error instanceof Error ? error.message : String(error)}`;
          });
        }, args.abortDelayMs);
      }
    }

    if (event?.type === "message_start" && event.message?.role === "assistant") {
      const stats = assistantStats(event.message);
      if (stats.textChars === 0 && stats.toolCalls === 0 && !promptSettled) {
        result.emptyAssistantStartBeforePromptResolved = true;
      }
    }

    if (event?.type === "agent_end") {
      result.agentEnded = true;
    }
  });

  try {
    await withTimeout(
      session.prompt(promptText, { expandPromptTemplates: false, source: "interactive" }),
      args.timeoutMs,
    );
    result.promptResolved = true;
  } catch (error) {
    result.promptError = error instanceof Error ? error.message : String(error);
    if (/timed out/i.test(result.promptError)) {
      result.abortIssued = true;
      await session.abort().catch((abortError) => {
        result.promptError += `; abort after timeout failed: ${abortError instanceof Error ? abortError.message : String(abortError)}`;
      });
    }
  } finally {
    promptSettled = true;
    unsubscribe();
  }

  return { result, events };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = await readApiKey();
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const runId = `${timestamp}-${args.mode}-${randomUUID().slice(0, 8)}`;
  const outputDir = join(args.outputRoot, runId);
  await mkdir(outputDir, { recursive: true });

  const model = ambientModel(args.model, args.baseUrl);
  const attempts = [];
  for (let attempt = 1; attempt <= args.repeat; attempt += 1) {
    const attemptDir = args.repeat === 1 ? outputDir : join(outputDir, `attempt-${String(attempt).padStart(2, "0")}`);
    await mkdir(attemptDir, { recursive: true });
    const opened =
      args.mode === "replay-continuation"
        ? await openReplaySession({ args, outputDir: attemptDir, apiKey, model })
        : args.mode === "replay-line" || args.mode === "replay-trace"
          ? await openReplayLineSession({ args, outputDir: attemptDir, apiKey, model })
          : args.mode === "steer-after-tool"
            ? await openSteerSession({ args, outputDir: attemptDir, apiKey, model })
            : undefined;
    if (!opened) throw new Error(`Unsupported mode: ${args.mode}`);

    const eventPath = join(attemptDir, "events.ndjson");
    const { result, events } = await runObservedPrompt({
      session: opened.session,
      promptText: opened.promptText,
      steerText: opened.steerText,
      args,
      eventPath,
    });
    opened.session.dispose();
    attempts.push({
      attempt,
      metadata: opened.metadata,
      result,
      eventCounts: events.reduce((counts, event) => {
        counts[event.type || "unknown"] = (counts[event.type || "unknown"] || 0) + 1;
        return counts;
      }, {}),
      artifacts: {
        outputDir: attemptDir,
        events: eventPath,
        sessionFile: opened.session.sessionFile,
      },
    });
  }

  const summary = {
    schemaVersion: "ambient-pi-runtime-empty-terminal-repro-v1",
    runId,
    createdAt: new Date().toISOString(),
    args: {
      mode: args.mode,
      sessionLog: args.mode === "replay-continuation" || args.mode === "replay-line" ? args.sessionLog : undefined,
      trace: args.mode === "replay-trace" ? args.trace : undefined,
      promptLine: args.promptLine,
      repeat: args.repeat,
      timeoutMs: args.timeoutMs,
      steerDelayMs: args.mode === "steer-after-tool" ? args.steerDelayMs : undefined,
      abortOnTerminal: args.abortOnTerminal,
      abortDelayMs: args.abortOnTerminal ? args.abortDelayMs : undefined,
      model: args.model,
      baseUrl: normalizeBaseUrl(args.baseUrl),
    },
    attempts,
    artifacts: {
      outputDir,
    },
  };
  const summaryPath = join(outputDir, "summary.json");
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
