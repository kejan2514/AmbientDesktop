import { AgentOs } from "@rivet-dev/agent-os-core";
import common from "@rivet-dev/agent-os-common";
import { createSandboxFs, createSandboxToolkit } from "@rivet-dev/agent-os-sandbox";
import { SandboxAgent } from "sandbox-agent";
import { streamSimpleOpenAICompletions } from "@mariozechner/pi-ai/openai-completions";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import getPort from "get-port";

const execFileAsync = promisify(execFile);
const image = process.env.AMBIENT_SANDBOX_AGENT_IMAGE ?? "rivetdev/sandbox-agent:0.5.0-rc.2-full";
const adapterVersion = process.env.AMBIENT_PI_MCP_ADAPTER_VERSION ?? "2.5.4";
const marker = "__AMBIENT_AGENTOS_SANDBOX_MCP_BRIDGE_RESULT__";
const timeoutMs = Number(process.env.AMBIENT_AGENTOS_SANDBOX_MCP_BRIDGE_TIMEOUT_MS ?? 240_000);
const livePiTranscriptBounds = {
  toolDescriptorBytes: Number(process.env.AMBIENT_AGENTOS_MCP_BRIDGE_LIVE_MAX_TOOL_DESCRIPTOR_BYTES ?? 1_500),
  totalBridgeResultBytes: Number(process.env.AMBIENT_AGENTOS_MCP_BRIDGE_LIVE_MAX_BRIDGE_RESULT_BYTES ?? 24_000),
  totalMessageBytes: Number(process.env.AMBIENT_AGENTOS_MCP_BRIDGE_LIVE_MAX_MESSAGE_BYTES ?? 40_000),
  finalInputTokens: Number(process.env.AMBIENT_AGENTOS_MCP_BRIDGE_LIVE_MAX_FINAL_INPUT_TOKENS ?? 8_000),
};
const host = "127.0.0.1";
const args = parseArgs(process.argv.slice(2));
const fixture = args.fixture ?? "excel";
const requests = args.smoke ? smokeRequests(fixture) : [requestFromArgs(args)];
const networkPolicy = args.networkPolicy ?? "open";
const postBootstrapNetworkProbe = args.postBootstrapNetworkProbe !== "false";
const hostTemp = await mkdtemp(join(tmpdir(), "ambient-agentos-sandbox-mcp-bridge-host-"));
const hostEscapePath = join(hostTemp, "host-escape.xlsx");
const port = await getPort({ host });
const containerName = `ambient-agentos-sandbox-mcp-bridge-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const previousParentSecret = process.env.AGENTOS_SANDBOX_MCP_BRIDGE_PARENT_SECRET;
process.env.AGENTOS_SANDBOX_MCP_BRIDGE_PARENT_SECRET = "HOST_PARENT_ENV_SHOULD_NOT_LEAK";

let vm;
let sandbox;
let committedImage;
let cleanupContainers = [containerName];

try {
  if (args.serviceSmoke && networkPolicy !== "disabled") {
    throw new Error("--serviceSmoke currently requires --networkPolicy disabled");
  }
  if (args.livePiServiceSmoke && networkPolicy !== "disabled") {
    throw new Error("--livePiServiceSmoke currently requires --networkPolicy disabled");
  }
  if (networkPolicy === "disabled") {
    const report = args.livePiServiceSmoke
      ? await runDockerNetworkDisabledBridgeLivePiSmoke()
      : args.serviceSmoke
        ? await runDockerNetworkDisabledBridgeServiceSmoke()
        : await runDockerNetworkDisabledBridge();
    console.log(`${marker}${JSON.stringify(report)}`);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    if (report.diagnostics.hostEscapeExists) process.exitCode = 2;
    if (report.diagnostics.inner && report.diagnostics.inner.env?.parentSecret !== null) process.exitCode = 3;
    if (report.diagnostics.inner?.processes?.assertion?.ok === false) process.exitCode = 4;
    if (report.diagnostics.inner?.network?.assertion?.ok === false) process.exitCode = 5;
  } else {
    if (networkPolicy !== "open") throw new Error(`Unsupported network policy: ${networkPolicy}`);

    await execFileAsync("docker", [
      "run",
      "--rm",
      "-d",
      "--name",
      containerName,
      "-p",
      `${host}:${port}:3000`,
      image,
      "server",
      "--no-token",
      "--host",
      "0.0.0.0",
      "--port",
      "3000",
    ]);

    sandbox = await SandboxAgent.connect({ baseUrl: `http://${host}:${port}` });
    await waitForSandboxHealth(sandbox);
    vm = await AgentOs.create({
      software: [common],
      mounts: [{ path: "/sandbox", driver: createSandboxFs({ client: sandbox }) }],
      toolKits: [createSandboxToolkit({ client: sandbox })],
    });

    await sandbox.writeFsFile(
      { path: "/tmp/sandbox-mcp-bridge.mjs" },
      new TextEncoder().encode(
        bridgeSource({
          adapterVersion,
          marker,
          requests,
          fixture,
          networkPolicy,
          postBootstrapNetworkProbe,
          hostEscapePath,
        }),
      ),
    );

    const run = await runSandboxCommandViaAgentOs(vm, {
      command: "node",
      args: ["/tmp/sandbox-mcp-bridge.mjs"],
      timeoutMs,
    });
    const resultLine = [...String(run.stdout ?? "").split("\n")].reverse().find((line) => line.startsWith(marker));
    if (!resultLine) {
      throw new Error(`Sandbox MCP bridge did not emit result. exit=${run.exitCode} stdout=${run.stdout} stderr=${run.stderr}`);
    }
    const inner = JSON.parse(resultLine.slice(marker.length));
    const report = {
      ok: inner.ok === true,
      image,
      adapterVersion,
      containerName,
      sandboxBaseUrl: `http://${host}:${port}`,
      elapsedMs: run.durationMs,
      results: inner.results,
      diagnostics: {
        sandboxId: inner.sandboxId,
        run: {
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          stderr: String(run.stderr ?? "").slice(0, 4_000),
          durationMs: run.durationMs,
        },
        inner: inner.diagnostics,
        hostEscapePath,
        hostEscapeExists: existsSync(hostEscapePath),
      },
    };
    console.log(`${marker}${JSON.stringify(report)}`);
    console.log(JSON.stringify(report, null, 2));

    if (!report.ok) process.exitCode = 1;
    if (report.diagnostics.hostEscapeExists) process.exitCode = 2;
    if (inner.diagnostics?.env?.parentSecret !== null) process.exitCode = 3;
    if (inner.diagnostics?.processes?.assertion?.ok === false) process.exitCode = 4;
    if (inner.diagnostics?.network?.assertion?.ok === false) process.exitCode = 5;
  }
} catch (error) {
  process.exitCode = process.exitCode || 1;
  const report = {
    ok: false,
    image,
    adapterVersion,
    containerName,
    results: requests.map((request) => errorResult(request, error, "host")),
    diagnostics: {
      hostEscapePath,
      hostEscapeExists: existsSync(hostEscapePath),
      error: error?.stack ?? error?.message ?? String(error),
    },
  };
  console.log(`${marker}${JSON.stringify(report)}`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await waitWithTimeout(vm?.dispose?.(), 5_000, "AgentOS dispose timed out").catch((error) => console.error(String(error?.message ?? error)));
  await sandbox?.dispose?.().catch(() => undefined);
  await execFileAsync("docker", ["rm", "-f", containerName]).catch(() => undefined);
  for (const name of cleanupContainers.filter((entry) => entry !== containerName)) {
    await execFileAsync("docker", ["rm", "-f", name]).catch(() => undefined);
  }
  if (committedImage) await execFileAsync("docker", ["image", "rm", "-f", committedImage]).catch(() => undefined);
  await rm(hostTemp, { recursive: true, force: true });
  if (previousParentSecret === undefined) delete process.env.AGENTOS_SANDBOX_MCP_BRIDGE_PARENT_SECRET;
  else process.env.AGENTOS_SANDBOX_MCP_BRIDGE_PARENT_SECRET = previousParentSecret;
  process.exit(process.exitCode ?? 0);
}

async function runDockerNetworkDisabledBridge() {
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const bootstrapName = `ambient-mcp-bridge-bootstrap-${nonce}`;
  const execName = `ambient-mcp-bridge-exec-${nonce}`;
  cleanupContainers.push(bootstrapName, execName);
  committedImage = `ambient-mcp-bridge-bootstrap:${nonce}`;
  const started = Date.now();

  await execFileAsync("docker", ["run", "--rm", "-d", "--name", bootstrapName, "--entrypoint", "sleep", image, "infinity"]);
  await writeContainerFile(bootstrapName, "/tmp/sandbox-mcp-bridge-bootstrap.mjs", bridgeBootstrapSource({ adapterVersion }));
  const bootstrapRun = await execDocker(bootstrapName, ["node", "/tmp/sandbox-mcp-bridge-bootstrap.mjs"], 180_000);
  if (bootstrapRun.exitCode !== 0) {
    throw new Error(`Network-disabled bootstrap failed: ${bootstrapRun.stderr || bootstrapRun.stdout}`);
  }
  await execFileAsync("docker", ["commit", bootstrapName, committedImage], { timeout: 120_000 });
  await execFileAsync("docker", ["rm", "-f", bootstrapName]).catch(() => undefined);

  await execFileAsync("docker", ["run", "--rm", "-d", "--network", "none", "--name", execName, "--entrypoint", "sleep", committedImage, "infinity"]);
  await writeContainerFile(
    execName,
    "/tmp/sandbox-mcp-bridge.mjs",
    bridgeSource({
      adapterVersion,
      marker,
      requests,
      fixture,
      networkPolicy,
      postBootstrapNetworkProbe,
      hostEscapePath,
      dependencyMode: "preinstalled",
      adapterRoot: "/tmp/ambient-mcp-bridge-preinstalled/adapter",
    }),
  );
  const run = await execDocker(execName, ["node", "/tmp/sandbox-mcp-bridge.mjs"], timeoutMs);
  const resultLine = [...String(run.stdout ?? "").split("\n")].reverse().find((line) => line.startsWith(marker));
  if (!resultLine) {
    throw new Error(`Network-disabled Docker MCP bridge did not emit result. exit=${run.exitCode} stdout=${run.stdout} stderr=${run.stderr}`);
  }
  const inner = JSON.parse(resultLine.slice(marker.length));
  return {
    ok: inner.ok === true,
    image,
    executionImage: committedImage,
    adapterVersion,
    containerName: execName,
    networkPolicy,
    elapsedMs: Date.now() - started,
    results: inner.results,
    diagnostics: {
      sandboxId: inner.sandboxId,
      run: {
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        stderr: String(run.stderr ?? "").slice(0, 4_000),
        durationMs: run.durationMs,
      },
      inner: inner.diagnostics,
      hostEscapePath,
      hostEscapeExists: existsSync(hostEscapePath),
    },
  };
}

async function runDockerNetworkDisabledBridgeServiceSmoke() {
  const serviceSession = await startDockerNetworkDisabledBridgeService();
  const { service, pending, transcript, stderr, started, execName, ready } = serviceSession;
  const serviceRequests = serviceSmokeRequests();
  const results = [];
  try {
    for (const request of serviceRequests) {
      results.push(await sendServiceRequest(service, pending, request));
    }
    const shutdown = await sendServiceControl(service, pending, "shutdown");
    const exited = await waitForChildExit(service, 10_000);
    const fixtureAssertion = assertServiceSmokeBehavior(networkPolicy, results, shutdown);
    return {
      ok: results.every((result) => result.ok) && shutdown?.report?.ok === true && fixtureAssertion.ok,
      image,
      executionImage: committedImage,
      adapterVersion,
      containerName: execName,
      networkPolicy,
      serviceMode: true,
      elapsedMs: Date.now() - started,
      results,
      diagnostics: {
        fixtureAssertion,
        ready,
        shutdown,
        service: {
          protocol: "json-lines",
          requestCount: serviceRequests.length,
          transcriptEvents: transcript.length,
          exit: exited,
          stderr: stderr.text.slice(0, 4_000),
        },
        hostEscapePath,
        hostEscapeExists: existsSync(hostEscapePath),
      },
    };
  } catch (error) {
    service.kill("SIGKILL");
    throw error;
  }
}

async function startDockerNetworkDisabledBridgeService() {
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const bootstrapName = `ambient-mcp-bridge-service-bootstrap-${nonce}`;
  const execName = `ambient-mcp-bridge-service-exec-${nonce}`;
  cleanupContainers.push(bootstrapName, execName);
  committedImage = `ambient-mcp-bridge-service-bootstrap:${nonce}`;
  const started = Date.now();

  await execFileAsync("docker", ["run", "--rm", "-d", "--name", bootstrapName, "--entrypoint", "sleep", image, "infinity"]);
  await writeContainerFile(bootstrapName, "/tmp/sandbox-mcp-bridge-bootstrap.mjs", bridgeBootstrapSource({ adapterVersion }));
  const bootstrapRun = await execDocker(bootstrapName, ["node", "/tmp/sandbox-mcp-bridge-bootstrap.mjs"], 180_000);
  if (bootstrapRun.exitCode !== 0) {
    throw new Error(`Network-disabled service bootstrap failed: ${bootstrapRun.stderr || bootstrapRun.stdout}`);
  }
  await execFileAsync("docker", ["commit", bootstrapName, committedImage], { timeout: 120_000 });
  await execFileAsync("docker", ["rm", "-f", bootstrapName]).catch(() => undefined);

  await execFileAsync("docker", ["run", "--rm", "-d", "--network", "none", "--name", execName, "--entrypoint", "sleep", committedImage, "infinity"]);
  await writeContainerFile(
    execName,
    "/tmp/sandbox-mcp-bridge.mjs",
    bridgeSource({
      adapterVersion,
      marker,
      requests: [],
      fixture: "excel",
      networkPolicy,
      postBootstrapNetworkProbe,
      hostEscapePath,
      dependencyMode: "preinstalled",
      adapterRoot: "/tmp/ambient-mcp-bridge-preinstalled/adapter",
      serviceMode: true,
    }),
  );

  const service = spawn("docker", ["exec", "-i", execName, "node", "/tmp/sandbox-mcp-bridge.mjs"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const transcript = [];
  let stdoutBuffer = "";
  const stderr = { text: "" };
  const pending = new Map();
  service.stdout.setEncoding("utf8");
  service.stderr.setEncoding("utf8");
  service.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    for (;;) {
      const index = stdoutBuffer.indexOf("\n");
      if (index === -1) break;
      const line = stdoutBuffer.slice(0, index);
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (!line.startsWith(marker)) continue;
      const message = JSON.parse(line.slice(marker.length));
      transcript.push(message);
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });
  service.stderr.on("data", (chunk) => {
    stderr.text += chunk;
  });

  const ready = await waitForServiceMessage(pending, transcript, "ready", 60_000);
  if (ready.event !== "ready") throw new Error("MCP bridge service did not become ready");
  return { service, pending, transcript, stderr, started, execName, ready };
}

function serviceSmokeRequests() {
  const workbookPath = "/tmp/ambient-sandbox-mcp-bridge-service/service-workbook.xlsx";
  return [
    { action: "status", server: "excel" },
    { action: "search", server: "excel", query: "workbook worksheet", includeSchemas: false },
    { action: "describe", server: "excel", tool: "excel_create_workbook" },
    { action: "call", server: "excel", tool: "excel_create_workbook", args: { filepath: workbookPath } },
    {
      action: "call",
      server: "excel",
      tool: "excel_write_data_to_excel",
      args: {
        filepath: workbookPath,
        sheet_name: "Sheet1",
        data: [
          ["metric", "value"],
          ["service", 1],
        ],
        start_cell: "A1",
      },
    },
    {
      action: "call",
      server: "excel",
      tool: "excel_read_data_from_excel",
      args: {
        filepath: workbookPath,
        sheet_name: "Sheet1",
        start_cell: "A1",
        end_cell: "B2",
        preview_only: false,
      },
    },
  ];
}

function assertServiceSmokeBehavior(selectedNetworkPolicy, results, shutdown) {
  const status = results.find((result) => result.action === "status");
  const read = results.find((result) => result.tool === "excel_read_data_from_excel");
  return {
    ok: selectedNetworkPolicy === "disabled"
      && status?.ok === true
      && read?.ok === true
      && String(read?.text ?? "").includes("service")
      && shutdown?.report?.diagnostics?.network?.assertion?.ok === true
      && shutdown?.report?.diagnostics?.processes?.assertion?.ok === true,
    statusOk: status?.ok === true,
    readbackContainsService: String(read?.text ?? "").includes("service"),
    networkAssertion: shutdown?.report?.diagnostics?.network?.assertion,
    processAssertion: shutdown?.report?.diagnostics?.processes?.assertion,
  };
}

async function runDockerNetworkDisabledBridgeLivePiSmoke() {
  const apiKey = await readAmbientApiKey();
  if (!apiKey) {
    throw new Error("Set AMBIENT_API_KEY, AMBIENT_AGENT_AMBIENT_API_KEY, AMBIENT_API_KEY_FILE, or place ignored-provider-key-file.txt near the repo.");
  }
  const serviceSession = await startDockerNetworkDisabledBridgeService();
  const { service, pending, transcript, stderr, started, execName, ready } = serviceSession;
  try {
    const live = await runLivePiBridgePlanner({ service, pending, apiKey });
    const liveSummary = summarizeLivePiBridgeRun(live);
    const shutdown = await sendServiceControl(service, pending, "shutdown");
    const exited = await waitForChildExit(service, 10_000);
    const fixtureAssertion = assertLivePiServiceSmokeBehavior(live, shutdown);
    return {
      ok: live.ok && shutdown?.report?.ok === true && fixtureAssertion.ok,
      image,
      executionImage: committedImage,
      adapterVersion,
      containerName: execName,
      networkPolicy,
      serviceMode: true,
      livePi: true,
      elapsedMs: Date.now() - started,
      results: live.results,
      diagnostics: {
        fixtureAssertion,
        ready,
        liveSummary,
        live,
        shutdown,
        service: {
          protocol: "json-lines",
          requestCount: live.results.length,
          transcriptEvents: transcript.length,
          exit: exited,
          stderr: stderr.text.slice(0, 4_000),
        },
        hostEscapePath,
        hostEscapeExists: existsSync(hostEscapePath),
      },
    };
  } catch (error) {
    service.kill("SIGKILL");
    throw error;
  }
}

async function runLivePiBridgePlanner({ service, pending, apiKey }) {
  const modelId = process.env.AMBIENT_AGENTOS_MCP_BRIDGE_LIVE_MODEL || "example/model-id";
  const sessionId = `ambient-sandbox-mcp-bridge-live-${Date.now()}`;
  const workbookPath = "/tmp/ambient-sandbox-mcp-bridge-live-pi/live-pi-workbook.xlsx";
  const tool = sandboxMcpBridgeTool();
  const context = {
    systemPrompt: livePiSystemPrompt(),
    messages: [
      {
        role: "user",
        content: [
          "Use the sandbox_mcp_bridge tool to complete this Excel workflow through the sandboxed MCP bridge.",
          "Required sequence: inspect server status, search for relevant workbook/worksheet tools, describe the tools you choose, create a workbook, write a tiny table, read it back, then answer with the exact token LIVE_PI_MCP_BRIDGE_OK.",
          `Use this sandbox-local workbook path: ${workbookPath}`,
          "Do not use any other tool. Do not ask for confirmation.",
        ].join("\n"),
        timestamp: Date.now(),
      },
    ],
    tools: [tool],
  };
  const results = [];
  const turns = [];
  for (let turn = 0; turn < 8; turn += 1) {
    let assistant;
    try {
      assistant = await callLivePiPlanner({
        apiKey,
        modelId,
        sessionId,
        context,
        toolChoice: "auto",
      });
    } catch (error) {
      turns.push({
        index: turn,
        stopReason: "error",
        textBytes: 0,
        toolCallCount: 0,
        error: error?.message ?? String(error),
      });
      if (turn < 7) {
        context.messages.push({
          role: "user",
          content: [
            "The previous model turn failed or timed out before completing the sandbox MCP bridge workflow.",
            "Continue with the next required bridge tool call. Do not repeat completed work unless needed.",
            "When readback confirms the table, answer with exactly LIVE_PI_MCP_BRIDGE_OK.",
          ].join("\n"),
          timestamp: Date.now(),
        });
        continue;
      }
      break;
    }
    context.messages.push(assistant);
    const assistantOutput = assistantText(assistant);
    const structuredToolCalls = assistant.content.filter((part) => part.type === "toolCall" && part.name === "sandbox_mcp_bridge");
    const pseudoToolCalls = structuredToolCalls.length === 0 ? extractPseudoBridgeToolCalls(assistantOutput, turn) : [];
    const toolCalls = structuredToolCalls.length > 0 ? structuredToolCalls : pseudoToolCalls;
    turns.push({
      index: turn,
      stopReason: assistant.stopReason,
      textBytes: Buffer.byteLength(assistantOutput, "utf8"),
      toolCallCount: toolCalls.length,
      pseudoToolCallCount: pseudoToolCalls.length,
      inputTokens: assistant.usage?.input,
      outputTokens: assistant.usage?.output,
      totalTokens: assistant.usage?.totalTokens,
    });
    if (toolCalls.length === 0) {
      const finalText = assistantText(assistant);
      if (!(finalText.includes("LIVE_PI_MCP_BRIDGE_OK") && sawLivePiWorkflow(results)) && turn < 7) {
        context.messages.push({
          role: "user",
          content: [
            "The sandbox MCP bridge workflow is not complete yet.",
            "Continue from the existing tool results. If you have only searched so far, describe the selected tools next, then create, write, and read back the workbook.",
            "When readback confirms the table, answer with exactly LIVE_PI_MCP_BRIDGE_OK.",
          ].join("\n"),
          timestamp: Date.now(),
        });
        turns[turn].continuedAfterIncompleteStop = true;
        continue;
      }
      return {
        ok: finalText.includes("LIVE_PI_MCP_BRIDGE_OK") && sawLivePiWorkflow(results),
        model: modelId,
        finalText,
        turns,
        results,
        transcriptMetrics: livePiTranscriptMetrics(tool, context, results),
      };
    }
    for (const toolCall of toolCalls) {
      const request = normalizeLivePiBridgeRequest(toolCall.arguments, workbookPath);
      const result = await sendServiceRequest(service, pending, request);
      results.push(result);
      if (toolCall.pseudo) {
        context.messages.push({
          role: "user",
          content: `Result for recovered textual sandbox_mcp_bridge call:\n${compactToolResultForPi(result)}`,
          timestamp: Date.now(),
        });
      } else {
        context.messages.push({
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text", text: compactToolResultForPi(result) }],
          details: {
            action: result.action,
            server: result.server,
            tool: result.tool,
            ok: result.ok,
            elapsedMs: result.elapsedMs,
          },
          isError: !result.ok,
          timestamp: Date.now(),
        });
      }
    }
  }
  return {
    ok: false,
    model: modelId,
    finalText: "",
    turns,
    results,
    transcriptMetrics: livePiTranscriptMetrics(tool, context, results),
    error: "Live Pi planner exceeded turn limit.",
  };
}

async function callLivePiPlanner({ apiKey, modelId, sessionId, context, toolChoice }) {
  const timeout = Number(process.env.AMBIENT_AGENTOS_MCP_BRIDGE_LIVE_TURN_TIMEOUT_MS ?? 75_000);
  const abortController = new AbortController();
  const timer = setTimeout(() => {
    abortController.abort(new Error(`Ambient/Pi bridge planner turn timed out after ${timeout}ms.`));
  }, timeout);
  const stream = streamSimpleOpenAICompletions(livePiModel(modelId), context, {
    apiKey,
    cacheRetention: "short",
    maxRetries: 0,
    maxTokens: 2_000,
    reasoning: "minimal",
    signal: abortController.signal,
    sessionId,
    toolChoice,
    timeoutMs: timeout,
  });
  try {
    let finalMessage;
    for await (const event of stream) {
      if (event.type === "done") finalMessage = event.message;
      if (event.type === "error") throw new Error(event.error?.errorMessage || "Ambient/Pi bridge planner returned an error.");
    }
    if (!finalMessage) throw new Error("Ambient/Pi bridge planner did not return a final message.");
    return finalMessage;
  } finally {
    clearTimeout(timer);
  }
}

function extractPseudoBridgeToolCalls(text, turn) {
  const calls = [];
  const pattern = /<tool_call>\s*sandbox_mcp_bridge\((\{[\s\S]*?\})\)/g;
  for (const match of text.matchAll(pattern)) {
    try {
      calls.push({
        type: "toolCall",
        id: `pseudo-${turn}-${calls.length}`,
        name: "sandbox_mcp_bridge",
        arguments: JSON.parse(match[1]),
        pseudo: true,
      });
    } catch {
      // Ignore malformed pseudo-calls; the incomplete-turn retry path will handle them.
    }
  }
  return calls;
}

function livePiSystemPrompt() {
  return [
    "You are Pi running a focused live smoke test for a sandboxed MCP bridge.",
    "You have one tool, sandbox_mcp_bridge, which forwards compact bridge requests to a sandboxed MCP adapter service.",
    "Always call sandbox_mcp_bridge as a real tool. Never write textual <tool_call> markup.",
    "Plan with search and describe before mutation calls. Keep arguments minimal and valid JSON.",
    "The bridge actions are: status, search, describe, call.",
    "When the workflow is complete and the readback confirms the table, answer with exactly LIVE_PI_MCP_BRIDGE_OK.",
  ].join("\n");
}

function sandboxMcpBridgeTool() {
  return {
    name: "sandbox_mcp_bridge",
    description: "Forward one compact status/search/describe/call request to the sandboxed MCP bridge service.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action", "server"],
      properties: {
        action: { type: "string", enum: ["status", "search", "describe", "call"] },
        server: { type: "string", enum: ["excel"] },
        query: { type: "string" },
        includeSchemas: { type: "boolean" },
        tool: { type: "string" },
        args: { type: "object", additionalProperties: true },
      },
    },
  };
}

function normalizeLivePiBridgeRequest(args, workbookPath) {
  const request = {
    action: args?.action,
    server: args?.server ?? "excel",
  };
  if (args?.query) request.query = String(args.query);
  if (args?.includeSchemas !== undefined) request.includeSchemas = Boolean(args.includeSchemas);
  if (args?.tool) request.tool = String(args.tool);
  if (args?.args && typeof args.args === "object") request.args = sanitizeLivePiToolArgs(args.args, workbookPath);
  return request;
}

function sanitizeLivePiToolArgs(args, workbookPath) {
  const sanitized = { ...args };
  if (typeof sanitized.filepath === "string") sanitized.filepath = workbookPath;
  return sanitized;
}

function compactToolResultForPi(result) {
  return JSON.stringify({
    ok: result.ok,
    action: result.action,
    server: result.server,
    tool: result.tool,
    text: result.text,
    structured: result.structured,
    error: result.error,
  });
}

function sawLivePiWorkflow(results) {
  const text = results.map((result) => `${result.tool ?? result.action}\n${result.text ?? ""}\n${JSON.stringify(result.structured ?? {})}`).join("\n");
  return text.includes("excel_create_workbook")
    && text.includes("excel_write_data_to_excel")
    && text.includes("excel_read_data_from_excel")
    && /service|metric|value|LIVE|live/i.test(text);
}

function assertLivePiServiceSmokeBehavior(live, shutdown) {
  const read = live.results.find((result) => result.tool === "excel_read_data_from_excel");
  const transcriptBounds = assertLivePiTranscriptBounds(live);
  return {
    ok: live.ok
      && read?.ok === true
      && transcriptBounds.ok
      && shutdown?.report?.diagnostics?.network?.assertion?.ok === true
      && shutdown?.report?.diagnostics?.processes?.assertion?.ok === true,
    liveOk: live.ok,
    readOk: read?.ok === true,
    transcriptBounds,
    finalText: live.finalText,
    networkAssertion: shutdown?.report?.diagnostics?.network?.assertion,
    processAssertion: shutdown?.report?.diagnostics?.processes?.assertion,
  };
}

function assertLivePiTranscriptBounds(live) {
  const summary = summarizeLivePiBridgeRun(live);
  const checks = [
    {
      name: "toolDescriptorBytes",
      actual: summary.toolDescriptorBytes,
      max: livePiTranscriptBounds.toolDescriptorBytes,
    },
    {
      name: "totalBridgeResultBytes",
      actual: summary.totalBridgeResultBytes,
      max: livePiTranscriptBounds.totalBridgeResultBytes,
    },
    {
      name: "totalMessageBytes",
      actual: summary.totalMessageBytes,
      max: livePiTranscriptBounds.totalMessageBytes,
    },
    {
      name: "finalInputTokens",
      actual: summary.finalInputTokens,
      max: livePiTranscriptBounds.finalInputTokens,
    },
  ];
  const failed = checks.filter((check) => typeof check.actual !== "number" || check.actual > check.max);
  return {
    ok: failed.length === 0,
    bounds: livePiTranscriptBounds,
    observed: Object.fromEntries(checks.map((check) => [check.name, check.actual])),
    failed,
  };
}

function summarizeLivePiBridgeRun(live) {
  const finalTurn = live.turns.at(-1);
  const metrics = live.transcriptMetrics;
  return {
    ok: live.ok,
    model: live.model,
    turnCount: live.turns.length,
    bridgeRequestCount: live.results.length,
    finalInputTokens: finalTurn?.inputTokens,
    finalTotalTokens: finalTurn?.totalTokens,
    toolDescriptorBytes: metrics?.toolDescriptorBytes,
    totalMessageBytes: metrics?.totalMessageBytes,
    totalBridgeResultBytes: metrics?.bridgeResultBytes?.reduce((sum, entry) => sum + entry.totalBytes, 0),
    finalTextBytes: Buffer.byteLength(live.finalText ?? "", "utf8"),
  };
}

function livePiTranscriptMetrics(tool, context, results) {
  const toolDescriptorBytes = byteLengthJson(tool);
  const messageBytes = context.messages.map((message) => byteLengthJson(message));
  return {
    toolDescriptorBytes,
    totalMessageBytes: messageBytes.reduce((sum, bytes) => sum + bytes, 0),
    messageBytes,
    bridgeResultBytes: results.map((result) => ({
      action: result.action,
      tool: result.tool,
      textBytes: Buffer.byteLength(result.text ?? "", "utf8"),
      totalBytes: byteLengthJson(result),
    })),
  };
}

function livePiModel(modelId) {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: "ambient",
    baseUrl: normalizeAmbientBaseUrl(process.env.AMBIENT_BASE_URL || process.env.AMBIENT_AGENT_AMBIENT_BASE_URL),
    compat: {
      supportsDeveloperRole: false,
      supportsStore: false,
      thinkingFormat: "zai",
      zaiToolStream: true,
      sendSessionAffinityHeaders: true,
    },
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 131072,
  };
}

function normalizeAmbientBaseUrl(baseUrl) {
  const root = (baseUrl || "https://api.ambient.xyz").replace(/\/+$/, "");
  return root.endsWith("/v1") ? root : `${root}/v1`;
}

function assistantText(message) {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function byteLengthJson(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

async function readAmbientApiKey() {
  const envKey = process.env.AMBIENT_API_KEY || process.env.AMBIENT_AGENT_AMBIENT_API_KEY;
  if (envKey?.trim()) return envKey.trim();
  const candidates = [
    process.env.AMBIENT_API_KEY_FILE,
    join(process.cwd(), "ignored-provider-key-file.txt"),
    join(process.cwd(), "..", "ignored-provider-key-file.txt"),
    join(process.cwd(), "..", "..", "ignored-provider-key-file.txt"),
    join(homedir(), "ignored-provider-key-file.txt"),
    "/Users/example/Documents/ambientCoder/ignored-provider-key-file.txt",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const value = (await readFile(candidate, "utf8")).trim();
      if (value) return value;
    } catch {
      // Try the next configured key location.
    }
  }
  return undefined;
}

async function waitForServiceMessage(_pending, transcript, event, waitMs) {
  return new Promise((resolve, reject) => {
    const existing = transcript.find((message) => message.event === event);
    if (existing) {
      resolve(existing);
      return;
    }
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`Timed out waiting for service event ${event}`));
    }, waitMs);
    const interval = setInterval(() => {
      const message = transcript.find((entry) => entry.event === event);
      if (!message) return;
      clearTimeout(timeout);
      clearInterval(interval);
      resolve(message);
    }, 100);
  });
}

async function sendServiceRequest(service, pending, request) {
  return sendServiceMessage(service, pending, { request });
}

async function sendServiceControl(service, pending, control) {
  return sendServiceMessage(service, pending, { control });
}

async function sendServiceMessage(service, pending, payload) {
  const id = `host-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const message = { id, ...payload };
  const response = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for service response ${id}`));
    }, timeoutMs);
    pending.set(id, (result) => {
      clearTimeout(timeout);
      resolve(result);
    });
  });
  service.stdin.write(`${JSON.stringify(message)}\n`);
  return response;
}

async function waitForChildExit(child, waitMs) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: child.exitCode, signal: "SIGKILL", timedOut: true });
    }, waitMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, timedOut: false });
    });
  });
}

function parseArgs(argv) {
  const parsed = { smoke: false, serviceSmoke: false, livePiServiceSmoke: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--smoke") {
      parsed.smoke = true;
      continue;
    }
    if (arg === "--serviceSmoke") {
      parsed.serviceSmoke = true;
      parsed.smoke = true;
      continue;
    }
    if (arg === "--livePiServiceSmoke") {
      parsed.livePiServiceSmoke = true;
      parsed.smoke = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`Missing value for ${arg}`);
    parsed[key] = value;
    i += 1;
  }
  return parsed;
}

function requestFromArgs(parsed) {
  const action = parsed.action ?? "status";
  if (!["status", "search", "describe", "call"].includes(action)) throw new Error(`Unsupported action: ${action}`);
  const request = {
    action,
    server: parsed.server ?? "excel",
  };
  if (parsed.query) request.query = parsed.query;
  if (parsed.tool) request.tool = parsed.tool;
  if (parsed.args) request.args = JSON.parse(parsed.args);
  if (parsed.includeSchemas !== undefined) request.includeSchemas = parsed.includeSchemas !== "false";
  return request;
}

function smokeRequests(selectedFixture) {
  if (selectedFixture === "network-attack") {
    return [
      { action: "status", server: "network_probe" },
      { action: "search", server: "network_probe", query: "network fetch", includeSchemas: false },
      { action: "describe", server: "network_probe", tool: "network_probe_network_attempt_fetch" },
      {
        action: "call",
        server: "network_probe",
        tool: "network_probe_network_attempt_fetch",
        args: { url: "https://example.com" },
      },
    ];
  }
  if (selectedFixture === "excel-workflow") {
    const workbookPath = "/tmp/ambient-sandbox-mcp-bridge-workflow/q1-summary.xlsx";
    return [
      { action: "status", server: "excel" },
      { action: "search", server: "excel", query: "workbook worksheet chart", includeSchemas: false },
      { action: "describe", server: "excel", tool: "excel_create_workbook" },
      { action: "describe", server: "excel", tool: "excel_write_data_to_excel" },
      { action: "describe", server: "excel", tool: "excel_create_chart" },
      { action: "call", server: "excel", tool: "excel_create_workbook", args: { filepath: workbookPath } },
      { action: "call", server: "excel", tool: "excel_create_worksheet", args: { filepath: workbookPath, sheet_name: "Q1 Summary" } },
      {
        action: "call",
        server: "excel",
        tool: "excel_write_data_to_excel",
        args: {
          filepath: workbookPath,
          sheet_name: "Q1 Summary",
          data: [
            ["month", "revenue", "cost", "profit"],
            ["January", 120, 45, "=B2-C2"],
            ["February", 132, 51, "=B3-C3"],
            ["March", 141, 58, "=B4-C4"],
            ["Total", "=SUM(B2:B4)", "=SUM(C2:C4)", "=SUM(D2:D4)"],
          ],
          start_cell: "A1",
        },
      },
      {
        action: "call",
        server: "excel",
        tool: "excel_create_chart",
        args: {
          filepath: workbookPath,
          sheet_name: "Q1 Summary",
          data_range: "A1:B4",
          chart_type: "bar",
          target_cell: "F2",
          title: "Q1 Revenue",
          x_axis: "Month",
          y_axis: "Revenue",
        },
      },
      {
        action: "call",
        server: "excel",
        tool: "excel_read_data_from_excel",
        args: {
          filepath: workbookPath,
          sheet_name: "Q1 Summary",
          start_cell: "A1",
          end_cell: "D5",
          preview_only: false,
        },
      },
      { action: "call", server: "excel", tool: "excel_get_workbook_metadata", args: { filepath: workbookPath } },
    ];
  }
  if (selectedFixture === "excel-planner") return [];
  if (selectedFixture !== "excel") throw new Error(`Unsupported smoke fixture: ${selectedFixture}`);
  const workbookPath = "/tmp/ambient-sandbox-mcp-bridge-smoke/workbook.xlsx";
  return [
    { action: "status", server: "excel" },
    { action: "search", server: "excel", query: "workbook worksheet", includeSchemas: false },
    { action: "describe", server: "excel", tool: "excel_create_workbook" },
    { action: "call", server: "excel", tool: "excel_create_workbook", args: { filepath: workbookPath } },
    {
      action: "call",
      server: "excel",
      tool: "excel_write_data_to_excel",
      args: {
        filepath: workbookPath,
        sheet_name: "Sheet1",
        data: [
          ["metric", "value"],
          ["revenue", 120],
          ["cost", 45],
          ["profit", 75],
        ],
        start_cell: "A1",
      },
    },
    {
      action: "call",
      server: "excel",
      tool: "excel_read_data_from_excel",
      args: {
        filepath: workbookPath,
        sheet_name: "Sheet1",
        start_cell: "A1",
        end_cell: "B4",
        preview_only: false,
      },
    },
  ];
}

async function waitForSandboxHealth(client) {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const health = await client.getHealth();
      if (health?.status === "ok") return;
      lastError = new Error(`health status ${JSON.stringify(health)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw lastError ?? new Error("sandbox-agent health check timed out");
}

async function runSandboxCommandViaAgentOs(vm, request) {
  const command = `node /usr/local/bin/agentos-sandbox run-command --json '${JSON.stringify(request).replace(/'/g, "'\\''")}'`;
  const result = await vm.exec(command, { timeout: (request.timeoutMs ?? timeoutMs) + 10_000 });
  if (result.exitCode !== 0) throw new Error(`agentOS sandbox toolkit failed: ${result.stderr || result.stdout}`);
  const payload = JSON.parse(result.stdout);
  if (!payload.ok) throw new Error(`agentOS sandbox toolkit returned error: ${result.stdout}`);
  return payload.result;
}

function errorResult(request, error, sandboxId) {
  return {
    ok: false,
    action: request.action,
    server: request.server,
    tool: request.tool,
    elapsedMs: 0,
    sandboxId,
    diagnosticsRef: `${sandboxId}:diagnostics`,
    error: {
      code: "bridge_error",
      message: error?.message ?? String(error),
      retryable: false,
    },
  };
}

async function writeContainerFile(container, path, content) {
  const tmpFile = join(hostTemp, `${container}-${path.split("/").pop()}`);
  await writeFile(tmpFile, content, "utf8");
  await execFileAsync("docker", ["cp", tmpFile, `${container}:${path}`], { timeout: 30_000 });
}

async function execDocker(container, args, commandTimeoutMs) {
  const started = Date.now();
  try {
    const result = await execFileAsync("docker", ["exec", container, ...args], {
      timeout: commandTimeoutMs,
      maxBuffer: 20 * 1024 * 1024,
    });
    return {
      exitCode: 0,
      timedOut: false,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      exitCode: error?.code ?? 1,
      timedOut: error?.killed === true,
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? error?.message ?? String(error),
      durationMs: Date.now() - started,
    };
  }
}

function bridgeBootstrapSource(input) {
  return `
import { execFile, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const adapterRoot = "/tmp/ambient-mcp-bridge-preinstalled/adapter";
const adapterVersion = ${JSON.stringify(input.adapterVersion)};

await installUv();
await mkdir(adapterRoot, { recursive: true });
await writeFile(join(adapterRoot, "package.json"), JSON.stringify({ private: true, type: "module" }, null, 2), "utf8");
await execFileAsync("npm", [
  "install",
  "--ignore-scripts",
  "--no-audit",
  "--fund=false",
  "@mariozechner/pi-coding-agent@0.70.6",
  "pi-mcp-adapter@" + adapterVersion,
], { cwd: adapterRoot, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
process.env.PATH = [
  dirname(process.execPath),
  join(process.env.HOME || "/home/sandbox", ".local", "bin"),
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  process.env.PATH ?? "",
].join(":");
await execFileAsync("uvx", ["excel-mcp-server", "--help"], { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }).catch((error) => {
  const stderr = String(error?.stderr ?? "");
  const stdout = String(error?.stdout ?? "");
  if (!stderr.includes("Usage") && !stdout.includes("Usage")) throw error;
});
console.log(JSON.stringify({ ok: true, adapterRoot }));

async function installUv() {
  const existing = spawnSync("sh", ["-lc", "command -v uvx"], { encoding: "utf8" });
  if (existing.status === 0) return;
  const install = spawnSync("sh", ["-lc", "curl -LsSf https://astral.sh/uv/install.sh | sh"], {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (install.status !== 0) throw new Error("uv install failed: " + install.stderr + install.stdout);
}
`;
}

function bridgeSource(input) {
  return `
import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const adapterVersion = ${JSON.stringify(input.adapterVersion)};
const marker = ${JSON.stringify(input.marker)};
const requests = ${JSON.stringify(input.requests)};
const fixture = ${JSON.stringify(input.fixture ?? "excel")};
const networkPolicy = ${JSON.stringify(input.networkPolicy)};
const postBootstrapNetworkProbe = ${JSON.stringify(input.postBootstrapNetworkProbe)};
const dependencyMode = ${JSON.stringify(input.dependencyMode ?? "install")};
const preinstalledAdapterRoot = ${JSON.stringify(input.adapterRoot ?? null)};
const hostEscapePath = ${JSON.stringify(input.hostEscapePath)};
const serviceMode = ${JSON.stringify(input.serviceMode ?? false)};
const sandboxId = "agentos-sandbox-" + Date.now().toString(36);
const root = await mkdtemp(join(tmpdir(), "ambient-agentos-sandbox-mcp-bridge-"));
const adapterRoot = preinstalledAdapterRoot ?? join(root, "adapter");
const workspaceRoot = join(root, "workspace");
const piAgentDir = join(root, "pi-agent");
const excelDir = join(workspaceRoot, "excel-files");
const previousCwd = process.cwd();
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousDirectTools = process.env.MCP_DIRECT_TOOLS;
const previousPath = process.env.PATH;
let exitCode = 0;

try {
  if (!["open", "disabled"].includes(networkPolicy)) {
    throw new Error("Unsupported network policy " + JSON.stringify(networkPolicy) + ".");
  }
  if (dependencyMode === "install") await installUv();
  if (dependencyMode === "install") await mkdir(adapterRoot, { recursive: true });
  await mkdir(excelDir, { recursive: true });
  if (dependencyMode === "install") {
    await writeFile(join(adapterRoot, "package.json"), JSON.stringify({ private: true, type: "module" }, null, 2), "utf8");
    await execFileAsync("npm", [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--fund=false",
      "@mariozechner/pi-coding-agent@0.70.6",
      "pi-mcp-adapter@" + adapterVersion,
    ], { cwd: adapterRoot, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
  }
  const networkProbe = postBootstrapNetworkProbe ? await probeNetwork("post-bootstrap") : { skipped: true };
  if (fixture === "network-attack") {
    await writeFile(join(workspaceRoot, "network-probe-mcp.mjs"), networkProbeMcpServerSource(), "utf8");
  }
  await writeFile(join(workspaceRoot, ".mcp.json"), JSON.stringify(defaultMcpConfig(fixture), null, 2), "utf8");

  process.env.PI_CODING_AGENT_DIR = piAgentDir;
  process.env.MCP_DIRECT_TOOLS = "__none__";
  process.env.PATH = [
    dirname(process.execPath),
    join(process.env.HOME || "/home/sandbox", ".local", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    previousPath ?? "",
  ].join(":");
  process.chdir(workspaceRoot);

  const piCodingAgentPath = join(adapterRoot, "node_modules", "@mariozechner", "pi-coding-agent", "dist", "index.js");
  const { createEventBus } = await import(pathToFileURL(piCodingAgentPath).href);
  const { loadExtensions } = await importPiExtensionLoader(piCodingAgentPath);
  const adapterEntry = join(adapterRoot, "node_modules", "pi-mcp-adapter", "index.ts");
  if (!existsSync(adapterEntry)) throw new Error("pi-mcp-adapter entrypoint not found at " + adapterEntry);

  const loaded = await loadExtensions([adapterEntry], workspaceRoot, createEventBus());
  if (loaded.errors.length) throw new Error("Failed to load pi-mcp-adapter: " + JSON.stringify(loaded.errors));
  const extension = loaded.extensions[0];
  loaded.runtime.getAllTools = () => [...extension.tools.values()].map((tool) => tool.definition);
  loaded.runtime.getActiveTools = loaded.runtime.getAllTools;

  const ctx = createHeadlessExtensionContext();
  for (const handler of extension.handlers.get("session_start") ?? []) {
    await handler({ type: "session_start", cwd: workspaceRoot }, ctx);
  }
  const mcp = extension.tools.get("mcp")?.definition;
  if (!mcp) throw new Error("pi-mcp-adapter did not register the mcp proxy tool.");

  if (serviceMode) {
    await runBridgeService({ mcp, ctx, extension, networkProbe });
  } else {
  const planner = fixture === "excel-planner" ? await runExcelPlanner(mcp, ctx) : undefined;
  const results = planner?.results ?? [];
  if (!planner) {
    for (const request of requests) {
      results.push(await executeBridgeRequest(mcp, request, ctx));
    }
  }

  const hostEscapeAttempt = await executeBridgeRequest(mcp, {
    action: "call",
    server: "excel",
    tool: "excel_create_workbook",
    args: { filepath: hostEscapePath },
  }, ctx);
  const processesBeforeShutdown = await collectProcessSnapshot();
  await shutdownExtension(extension, ctx);
  await delay(500);
  const processesAfterShutdown = await collectProcessSnapshot();
  const lingeringMcpProcesses = findLingeringMcpProcesses(processesAfterShutdown);
  const fixtureAssertion = assertFixtureBehavior(fixture, networkPolicy, results);
  const plannerDiagnostics = planner ? summarizePlanner(planner) : undefined;

  const report = {
    ok: results.every((result) => result.ok) && !existsSync(hostEscapePath) && lingeringMcpProcesses.length === 0 && fixtureAssertion.ok,
    sandboxId,
    results,
    diagnostics: {
      fixture,
      fixtureAssertion,
      planner: plannerDiagnostics,
      root,
      workspaceRoot,
      piAgentDir,
      excelDir,
      proxyTool: summarizeTool(mcp),
      cache: existsSync(join(piAgentDir, "mcp-cache.json"))
        ? safeJsonPreview(await readFile(join(piAgentDir, "mcp-cache.json"), "utf8"))
        : undefined,
      hostEscapeAttempt,
      hostEscapeExistsInContainer: existsSync(hostEscapePath),
      network: {
        requestedPolicy: networkPolicy,
        bootstrapNetworkRequired: true,
        dependencyMode,
        postBootstrapProbe: networkProbe,
        assertion: {
          ok: networkPolicy === "open" ? networkProbe.ok === true : networkProbe.ok === false,
          note: networkPolicy === "open"
            ? "sandbox-agent bridge path is running with explicit open egress"
            : "Docker split bridge ran MCP execution with --network none after dependency bootstrap",
        },
      },
      processes: {
        beforeShutdown: summarizeProcesses(processesBeforeShutdown),
        afterShutdown: summarizeProcesses(processesAfterShutdown),
        lingeringMcpProcesses,
        assertion: {
          ok: lingeringMcpProcesses.length === 0,
          note: lingeringMcpProcesses.length === 0
            ? "no uvx/python/excel MCP child processes remained after adapter shutdown"
            : "MCP child processes remained after adapter shutdown",
        },
      },
      env: {
        parentSecret: process.env.AGENTOS_SANDBOX_MCP_BRIDGE_PARENT_SECRET ?? null,
      },
    },
  };
  console.log(marker + JSON.stringify(report));
  console.log(JSON.stringify(report, null, 2));
  }
} catch (error) {
  exitCode = 1;
  const report = {
    ok: false,
    sandboxId,
    results: requests.map((request) => ({
      ok: false,
      action: request.action,
      server: request.server,
      tool: request.tool,
      elapsedMs: 0,
      sandboxId,
      error: { code: "bridge_error", message: error?.message ?? String(error), retryable: false },
    })),
    diagnostics: {
      root,
      error: error?.stack ?? error?.message ?? String(error),
    },
  };
  console.log(marker + JSON.stringify(report));
  console.log(JSON.stringify(report, null, 2));
} finally {
  process.chdir(previousCwd);
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousDirectTools === undefined) delete process.env.MCP_DIRECT_TOOLS;
  else process.env.MCP_DIRECT_TOOLS = previousDirectTools;
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  if (process.env.AMBIENT_KEEP_SANDBOX_MCP_BRIDGE !== "1") {
    await rm(root, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

async function runBridgeService({ mcp, ctx, extension, networkProbe }) {
  const results = [];
  const started = Date.now();
  console.log(marker + JSON.stringify({
    event: "ready",
    sandboxId,
    service: {
      protocol: "json-lines",
      actions: ["status", "search", "describe", "call"],
    },
    diagnosticsRef: sandboxId + ":diagnostics",
  }));
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
      if (message.control === "shutdown") {
        const report = await serviceShutdownReport({ extension, ctx, networkProbe, results, started });
        console.log(marker + JSON.stringify({ id: message.id, ok: report.ok, report }));
        return;
      }
      const result = await executeBridgeRequest(mcp, message.request, ctx);
      results.push(result);
      console.log(marker + JSON.stringify({ id: message.id, ...result }));
    } catch (error) {
      console.log(marker + JSON.stringify({
        id: message?.id,
        ok: false,
        error: {
          code: "service_error",
          message: error?.message ?? String(error),
          retryable: false,
        },
      }));
    }
  }
}

async function serviceShutdownReport({ extension, ctx, networkProbe, results, started }) {
  const hostEscapeAttempt = await executeBridgeRequest(mcpHostEscapeProxy(extension), {
    action: "call",
    server: "excel",
    tool: "excel_create_workbook",
    args: { filepath: hostEscapePath },
  }, ctx);
  const processesBeforeShutdown = await collectProcessSnapshot();
  await shutdownExtension(extension, ctx);
  await delay(500);
  const processesAfterShutdown = await collectProcessSnapshot();
  const lingeringMcpProcesses = findLingeringMcpProcesses(processesAfterShutdown);
  return {
    ok: results.every((result) => result.ok) && !existsSync(hostEscapePath) && lingeringMcpProcesses.length === 0,
    sandboxId,
    elapsedMs: Date.now() - started,
    results,
    diagnostics: {
      fixture,
      root,
      workspaceRoot,
      piAgentDir,
      excelDir,
      hostEscapeAttempt,
      hostEscapeExistsInContainer: existsSync(hostEscapePath),
      network: {
        requestedPolicy: networkPolicy,
        bootstrapNetworkRequired: true,
        dependencyMode,
        postBootstrapProbe: networkProbe,
        assertion: {
          ok: networkPolicy === "open" ? networkProbe.ok === true : networkProbe.ok === false,
          note: networkPolicy === "open"
            ? "sandbox-agent bridge path is running with explicit open egress"
            : "Docker split bridge ran MCP execution with --network none after dependency bootstrap",
        },
      },
      processes: {
        beforeShutdown: summarizeProcesses(processesBeforeShutdown),
        afterShutdown: summarizeProcesses(processesAfterShutdown),
        lingeringMcpProcesses,
        assertion: {
          ok: lingeringMcpProcesses.length === 0,
          note: lingeringMcpProcesses.length === 0
            ? "no uvx/python/excel MCP child processes remained after adapter shutdown"
            : "MCP child processes remained after adapter shutdown",
        },
      },
      env: {
        parentSecret: process.env.AGENTOS_SANDBOX_MCP_BRIDGE_PARENT_SECRET ?? null,
      },
    },
  };
}

function mcpHostEscapeProxy(extension) {
  const mcp = extension.tools.get("mcp")?.definition;
  if (!mcp) throw new Error("pi-mcp-adapter did not register the mcp proxy tool.");
  return mcp;
}

function defaultMcpConfig(selectedFixture) {
  if (selectedFixture === "network-attack") {
    return {
      settings: { toolPrefix: "server", directTools: false, idleTimeout: 1 },
      mcpServers: {
        network_probe: {
          command: "node",
          args: [join(workspaceRoot, "network-probe-mcp.mjs")],
          lifecycle: "lazy",
          idleTimeout: 1,
        },
      },
    };
  }
  if (!["excel", "excel-workflow", "excel-planner"].includes(selectedFixture)) throw new Error("Unsupported MCP bridge fixture: " + selectedFixture);
  return {
    settings: { toolPrefix: "server", directTools: false, idleTimeout: 1 },
    mcpServers: {
      excel: {
        command: "uvx",
        args: ["excel-mcp-server", "stdio"],
        lifecycle: "lazy",
        idleTimeout: 1,
      },
    },
  };
}

function assertFixtureBehavior(selectedFixture, selectedNetworkPolicy, results) {
  if (selectedFixture === "excel-planner") return assertExcelWorkflowBehavior(selectedNetworkPolicy, results);
  if (selectedFixture === "excel-workflow") return assertExcelWorkflowBehavior(selectedNetworkPolicy, results);
  if (selectedFixture !== "network-attack") return { ok: true, skipped: true };
  const callResult = results.find((result) => result.action === "call" && result.tool === "network_probe_network_attempt_fetch");
  const text = String(callResult?.text ?? "");
  const structuredText = JSON.stringify(callResult?.structured ?? {});
  const combined = text + "\\n" + structuredText;
  const sawDeniedFetch = /"ok"\\s*:\\s*false|ok=false|fetch failed|getaddrinfo|network|ENOTFOUND|EAI_AGAIN/i.test(combined);
  if (selectedNetworkPolicy === "disabled") {
    return {
      ok: callResult?.ok === true && sawDeniedFetch,
      expected: "MCP tool call succeeds but its outbound fetch fails under disabled network",
      observedText: text.slice(0, 500),
    };
  }
  const sawSuccessfulFetch = /"ok"\\s*:\\s*true|ok=true|status/i.test(combined) && !sawDeniedFetch;
  return {
    ok: callResult?.ok === true && sawSuccessfulFetch,
    expected: "MCP tool outbound fetch succeeds under open network",
    observedText: text.slice(0, 500),
  };
}

function assertExcelWorkflowBehavior(selectedNetworkPolicy, results) {
  const failed = results.filter((result) => !result.ok).map((result) => ({
    action: result.action,
    tool: result.tool,
    error: result.error?.message ?? result.text,
  }));
  const readResult = results.find((result) => result.action === "call" && result.tool === "excel_read_data_from_excel");
  const chartResult = results.find((result) => result.action === "call" && result.tool === "excel_create_chart");
  const metadataResult = results.find((result) => result.action === "call" && result.tool === "excel_get_workbook_metadata");
  const combinedRead = String(readResult?.text ?? "") + "\\n" + JSON.stringify(readResult?.structured ?? {});
  const combinedMetadata = String(metadataResult?.text ?? "") + "\\n" + JSON.stringify(metadataResult?.structured ?? {});
  const resultTextBytes = results.reduce((sum, result) => sum + Buffer.byteLength(result.text ?? "", "utf8"), 0);
  const sawExpectedTable = combinedRead.includes("January")
    && combinedRead.includes("March")
    && combinedRead.includes("profit")
    && combinedRead.includes("=B2-C2")
    && combinedRead.includes("=SUM(D2:D4)");
  const sawWorksheet = combinedMetadata.includes("Q1 Summary");
  return {
    ok: failed.length === 0
      && chartResult?.ok === true
      && sawExpectedTable
      && sawWorksheet
      && selectedNetworkPolicy === "disabled"
      && resultTextBytes < 8_000,
    expected: "disabled-network Excel workflow creates workbook, writes formulas, creates chart, reads data, fetches metadata, and keeps transcript compact",
    failed,
    sawExpectedTable,
    sawWorksheet,
    resultTextBytes,
  };
}

async function runExcelPlanner(mcp, ctx) {
  const workbookPath = "/tmp/ambient-sandbox-mcp-bridge-planner/q1-planned.xlsx";
  const trace = [];
  const results = [];
  const status = await planStep(results, trace, mcp, ctx, { action: "status", server: "excel" }, "discover server status");
  const search = await planStep(
    results,
    trace,
    mcp,
    ctx,
    { action: "search", server: "excel", query: "workbook worksheet chart metadata", includeSchemas: false },
    "find workbook, worksheet, chart, metadata tools",
  );
  const matches = Array.isArray(search.structured?.matches) ? search.structured.matches.map((entry) => entry.tool) : [];
  const toolPlan = {
    createWorkbook: chooseTool(matches, ["excel_create_workbook"]),
    createWorksheet: chooseTool(matches, ["excel_create_worksheet"]),
    writeData: chooseTool(matches, ["excel_write_data_to_excel"]),
    createChart: chooseTool(matches, ["excel_create_chart"]),
    readData: chooseTool(matches, ["excel_read_data_from_excel"]),
    metadata: chooseTool(matches, ["excel_get_workbook_metadata"]),
  };
  trace.push({ step: "selected tools from search", toolPlan });
  for (const tool of [toolPlan.createWorkbook, toolPlan.writeData, toolPlan.createChart]) {
    await planStep(results, trace, mcp, ctx, { action: "describe", server: "excel", tool }, "describe selected tool schema");
  }
  await planStep(results, trace, mcp, ctx, {
    action: "call",
    server: "excel",
    tool: toolPlan.createWorkbook,
    args: { filepath: workbookPath },
  }, "create workbook");
  await planStep(results, trace, mcp, ctx, {
    action: "call",
    server: "excel",
    tool: toolPlan.createWorksheet,
    args: { filepath: workbookPath, sheet_name: "Q1 Summary" },
  }, "create worksheet");
  await planStep(results, trace, mcp, ctx, {
    action: "call",
    server: "excel",
    tool: toolPlan.writeData,
    args: {
      filepath: workbookPath,
      sheet_name: "Q1 Summary",
      data: [
        ["month", "revenue", "cost", "profit"],
        ["January", 120, 45, "=B2-C2"],
        ["February", 132, 51, "=B3-C3"],
        ["March", 141, 58, "=B4-C4"],
        ["Total", "=SUM(B2:B4)", "=SUM(C2:C4)", "=SUM(D2:D4)"],
      ],
      start_cell: "A1",
    },
  }, "write table and formulas");
  await planStep(results, trace, mcp, ctx, {
    action: "call",
    server: "excel",
    tool: toolPlan.createChart,
    args: {
      filepath: workbookPath,
      sheet_name: "Q1 Summary",
      data_range: "A1:B4",
      chart_type: "bar",
      target_cell: "F2",
      title: "Q1 Revenue",
      x_axis: "Month",
      y_axis: "Revenue",
    },
  }, "create chart");
  await planStep(results, trace, mcp, ctx, {
    action: "call",
    server: "excel",
    tool: toolPlan.readData,
    args: {
      filepath: workbookPath,
      sheet_name: "Q1 Summary",
      start_cell: "A1",
      end_cell: "D5",
      preview_only: false,
    },
  }, "read back worksheet");
  await planStep(results, trace, mcp, ctx, {
    action: "call",
    server: "excel",
    tool: toolPlan.metadata,
    args: { filepath: workbookPath },
  }, "fetch workbook metadata");
  const resultTextBytes = results.reduce((sum, result) => sum + Buffer.byteLength(result.text ?? "", "utf8"), 0);
  return {
    mode: "deterministic-planner-harness",
    workbookPath,
    toolPlan,
    resultTextBytes,
    trace,
    results,
  };
}

function summarizePlanner(planner) {
  return {
    mode: planner.mode,
    workbookPath: planner.workbookPath,
    toolPlan: planner.toolPlan,
    resultTextBytes: planner.resultTextBytes,
    trace: planner.trace,
  };
}

async function planStep(results, trace, mcp, ctx, request, reason) {
  const result = await executeBridgeRequest(mcp, request, ctx);
  results.push(result);
  trace.push({
    reason,
    action: request.action,
    server: request.server,
    tool: request.tool,
    ok: result.ok,
    textBytes: Buffer.byteLength(result.text ?? "", "utf8"),
  });
  if (!result.ok) throw new Error("Planner step failed: " + reason + ": " + (result.error?.message ?? result.text ?? "unknown error"));
  return result;
}

function chooseTool(matches, candidates) {
  for (const candidate of candidates) {
    if (matches.includes(candidate)) return candidate;
  }
  throw new Error("Could not find required tool. Candidates=" + candidates.join(", ") + " matches=" + matches.join(", "));
}

function networkProbeMcpServerSource() {
  return String.raw\`
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}

function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\\n");
}

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "initialize") {
    send(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "ambient-network-probe", version: "0.0.1" },
    });
    return;
  }
  if (message.method === "tools/list") {
    send(message.id, {
      tools: [{
        name: "network_attempt_fetch",
        description: "Attempt outbound fetch from inside the MCP server process.",
        inputSchema: {
          type: "object",
          properties: { url: { type: "string", default: "https://example.com" } },
        },
      }],
    });
    return;
  }
  if (message.method === "tools/call") {
    const url = message.params?.arguments?.url ?? "https://example.com";
    const started = Date.now();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const body = await response.text();
      send(message.id, {
        content: [{ type: "text", text: JSON.stringify({ ok: true, url, status: response.status, bytes: body.length, elapsedMs: Date.now() - started }) }],
        structuredContent: { ok: true, url, status: response.status, bytes: body.length, elapsedMs: Date.now() - started },
      });
    } catch (error) {
      send(message.id, {
        content: [{ type: "text", text: JSON.stringify({ ok: false, url, error: error?.message ?? String(error), elapsedMs: Date.now() - started }) }],
        structuredContent: { ok: false, url, error: error?.message ?? String(error), elapsedMs: Date.now() - started },
      });
    }
    return;
  }
  if (message.id !== undefined) sendError(message.id, -32601, "Method not found");
});
\`;
}

async function executeBridgeRequest(mcp, request, ctx) {
  const started = Date.now();
  try {
    const params = paramsForRequest(request);
    const raw = await mcp.execute("bridge-" + request.action + "-" + started, params, undefined, undefined, ctx);
    const text = textFromResult(raw);
    const errorCode = raw.details?.error;
    return {
      ok: !errorCode,
      action: request.action,
      server: request.server,
      tool: request.tool,
      text: text.length > 2_000 ? text.slice(0, 2_000) + "...[truncated]" : text,
      structured: structuredFromResult(raw),
      elapsedMs: Date.now() - started,
      sandboxId,
      diagnosticsRef: sandboxId + ":diagnostics",
      ...(errorCode
        ? { error: { code: String(errorCode), message: text || "MCP bridge call failed", retryable: retryableError(errorCode) } }
        : {}),
    };
  } catch (error) {
    return {
      ok: false,
      action: request.action,
      server: request.server,
      tool: request.tool,
      elapsedMs: Date.now() - started,
      sandboxId,
      diagnosticsRef: sandboxId + ":diagnostics",
      error: { code: "bridge_exception", message: error?.message ?? String(error), retryable: false },
    };
  }
}

function paramsForRequest(request) {
  if (request.action === "status") return {};
  if (request.action === "search") {
    return {
      search: request.query ?? "",
      server: request.server,
      includeSchemas: request.includeSchemas ?? false,
    };
  }
  if (request.action === "describe") return { describe: request.tool, server: request.server };
  if (request.action === "call") {
    return {
      tool: request.tool,
      server: request.server,
      args: JSON.stringify(request.args ?? {}),
    };
  }
  throw new Error("Unsupported bridge action: " + request.action);
}

function textFromResult(result) {
  return (result.content ?? [])
    .filter((item) => item?.type === "text")
    .map((item) => item.text)
    .join("\\n");
}

function structuredFromResult(result) {
  const mcpResult = result.details?.mcpResult;
  if (mcpResult?.structuredContent !== undefined) return mcpResult.structuredContent;
  if (result.details !== undefined) return result.details;
  return undefined;
}

function retryableError(code) {
  return code === "connect_failed" || code === "server_backoff" || code === "server_not_connected";
}

async function installUv() {
  const existing = spawnSync("sh", ["-lc", "command -v uvx"], { encoding: "utf8" });
  if (existing.status === 0) return;
  const install = spawnSync("sh", ["-lc", "curl -LsSf https://astral.sh/uv/install.sh | sh"], {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (install.status !== 0) throw new Error("uv install failed: " + install.stderr + install.stdout);
}

async function shutdownExtension(extension, ctx) {
  for (const handler of extension.handlers.get("session_shutdown") ?? []) {
    await handler({ type: "session_shutdown" }, ctx).catch(() => undefined);
  }
}

async function probeNetwork(phase) {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const response = await fetch("https://example.com", { signal: controller.signal });
    clearTimeout(timeout);
    await response.arrayBuffer();
    return {
      phase,
      ok: true,
      url: "https://example.com",
      status: response.status,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    return {
      phase,
      ok: false,
      url: "https://example.com",
      elapsedMs: Date.now() - started,
      error: error?.message ?? String(error),
    };
  }
}

async function collectProcessSnapshot() {
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,comm=,args="], {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return String(stdout)
      .trim()
      .split("\\n")
      .filter(Boolean)
      .map((line) => {
        const match = line.trim().match(/^(\\d+)\\s+(\\d+)\\s+(\\S+)\\s+(.*)$/);
        if (!match) return { raw: line.trim() };
        return {
          pid: Number(match[1]),
          ppid: Number(match[2]),
          command: match[3],
          args: match[4],
        };
      });
  } catch (error) {
    return [{ error: error?.message ?? String(error) }];
  }
}

function summarizeProcesses(processes) {
  return processes
    .filter((entry) => processLooksRelevant(entry))
    .map((entry) => ({
      pid: entry.pid,
      ppid: entry.ppid,
      command: entry.command,
      args: truncate(entry.args ?? entry.raw ?? entry.error ?? "", 300),
    }))
    .slice(0, 30);
}

function findLingeringMcpProcesses(processes) {
  return processes
    .filter((entry) => entry.pid !== process.pid && processLooksLikeMcpChild(entry))
    .map((entry) => ({
      pid: entry.pid,
      ppid: entry.ppid,
      command: entry.command,
      args: truncate(entry.args ?? entry.raw ?? "", 300),
    }));
}

function processLooksRelevant(entry) {
  const text = String(entry.args ?? entry.raw ?? entry.command ?? "");
  return text.includes("excel-mcp-server")
    || text.includes("uvx")
    || text.includes("pi-mcp-adapter")
    || text.includes("sandbox-mcp-bridge")
    || text.includes(root);
}

function processLooksLikeMcpChild(entry) {
  const text = String(entry.args ?? entry.raw ?? entry.command ?? "");
  return text.includes("excel-mcp-server")
    || text.includes("uvx")
    || text.includes(join(root, "adapter"))
    || text.includes(join(root, "pi-agent"));
}

function truncate(text, maxLength) {
  return text.length > maxLength ? text.slice(0, maxLength) + "...[truncated]" : text;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createHeadlessExtensionContext() {
  const abortController = new AbortController();
  return {
    hasUI: false,
    signal: abortController.signal,
    model: undefined,
    modelRegistry: undefined,
    ui: { notify() {}, setStatus() {} },
    reload: async () => {},
  };
}

function summarizeTool(tool) {
  return {
    name: tool.name,
    label: tool.label,
    descriptionBytes: Buffer.byteLength(tool.description ?? "", "utf8"),
    promptSnippet: tool.promptSnippet,
    parameterKeys: Object.keys(tool.parameters?.properties ?? {}),
  };
}

function safeJsonPreview(text) {
  try {
    const parsed = JSON.parse(text);
    const servers = parsed?.servers && typeof parsed.servers === "object" ? Object.keys(parsed.servers) : [];
    return { version: parsed?.version, servers, bytes: Buffer.byteLength(text, "utf8") };
  } catch {
    return { bytes: Buffer.byteLength(text, "utf8") };
  }
}

async function importPiExtensionLoader(piIndexPath) {
  const loaderPath = join(dirname(piIndexPath), "core", "extensions", "loader.js");
  return import(pathToFileURL(loaderPath).href);
}
`;
}

function waitWithTimeout(promise, ms, message) {
  if (!promise) return Promise.resolve();
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}
