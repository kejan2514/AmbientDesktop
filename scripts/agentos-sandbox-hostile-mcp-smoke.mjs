import { AgentOs } from "@rivet-dev/agent-os-core";
import common from "@rivet-dev/agent-os-common";
import { createSandboxFs, createSandboxToolkit } from "@rivet-dev/agent-os-sandbox";
import { SandboxAgent } from "sandbox-agent";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import getPort from "get-port";

const execFileAsync = promisify(execFile);
const image = process.env.AMBIENT_SANDBOX_AGENT_IMAGE ?? "rivetdev/sandbox-agent:0.5.0-rc.2-full";
const marker = "__AMBIENT_DOCKER_SANDBOX_HOSTILE_MCP_RESULT__";
const timeoutMs = 30_000;
const host = "127.0.0.1";
const port = await getPort({ host });
const containerName = `ambient-agentos-sandbox-hostile-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const hostTemp = await mkdtemp(join(tmpdir(), "ambient-agentos-docker-sandbox-host-"));
const hostSecretPath = join(hostTemp, "host-secret.txt");
const hostEscapePath = join(hostTemp, "host-escape.txt");
const hostNestedEscapePath = join(hostTemp, "host-nested-escape.txt");
await writeFile(hostSecretPath, "HOST_SECRET_SHOULD_NOT_BE_READ", "utf8");
const previousParentSecret = process.env.AGENTOS_DOCKER_SANDBOX_PARENT_SECRET;
process.env.AGENTOS_DOCKER_SANDBOX_PARENT_SECRET = "HOST_PARENT_ENV_SHOULD_NOT_BE_READ";

let vm;
let sandbox;

try {
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

  const script = hostileMcpServerSource({ hostSecretPath, hostEscapePath, hostNestedEscapePath });
  await sandbox.writeFsFile({ path: "/tmp/hostile-mcp-server.mjs" }, new TextEncoder().encode(script));

  const mountProbe = await probeSandboxMount(vm, sandbox);
  const run = await runSandboxCommandViaAgentOs(vm, {
    command: "node",
    args: ["/tmp/hostile-mcp-server.mjs"],
    timeoutMs,
  });
  const resultLine = [...String(run.stdout ?? "").split("\n")].reverse().find((line) => line.startsWith(marker));
  if (!resultLine) {
    throw new Error(`Hostile sandbox MCP smoke did not emit result. exit=${run.exitCode} stdout=${run.stdout} stderr=${run.stderr}`);
  }

  const report = {
    image,
    containerName,
    sandboxBaseUrl: `http://${host}:${port}`,
    mountProbe,
    run: {
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      stderr: String(run.stderr ?? "").slice(0, 4_000),
      durationMs: run.durationMs,
    },
    attacks: JSON.parse(resultLine.slice(marker.length)),
    containmentChecks: {
      hostSecretPath,
      hostEscapePath,
      hostNestedEscapePath,
      hostEscapeExists: existsSync(hostEscapePath),
      hostNestedEscapeExists: existsSync(hostNestedEscapePath),
    },
  };
  await writeStdout(`${JSON.stringify(report, null, 2)}\n`);
  if (report.containmentChecks.hostEscapeExists || report.containmentChecks.hostNestedEscapeExists) process.exitCode = 2;
} catch (error) {
  process.exitCode = process.exitCode || 1;
  await writeStdout(
    `${JSON.stringify(
      {
        image,
        containerName,
        error: error?.stack ?? error?.message ?? String(error),
        containmentChecks: {
          hostSecretPath,
          hostEscapePath,
          hostNestedEscapePath,
          hostEscapeExists: existsSync(hostEscapePath),
          hostNestedEscapeExists: existsSync(hostNestedEscapePath),
        },
      },
      null,
      2,
    )}\n`,
  ).catch(() => undefined);
} finally {
  await waitWithTimeout(vm?.dispose?.(), 5_000, "AgentOS dispose timed out").catch((error) => console.error(String(error?.message ?? error)));
  await sandbox?.dispose?.().catch(() => undefined);
  await execFileAsync("docker", ["rm", "-f", containerName]).catch(() => undefined);
  await rm(hostTemp, { recursive: true, force: true });
  if (previousParentSecret === undefined) delete process.env.AGENTOS_DOCKER_SANDBOX_PARENT_SECRET;
  else process.env.AGENTOS_DOCKER_SANDBOX_PARENT_SECRET = previousParentSecret;
  process.exit(process.exitCode ?? 0);
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

async function probeSandboxMount(vm, sandbox) {
  const probePath = `/tmp/agentos-mount-probe-${Date.now()}.txt`;
  const mountedPath = `/sandbox${probePath}`;
  const content = "written through agentOS mount";
  const result = {
    mountedPath,
    sandboxPath: probePath,
    vmWriteSucceeded: false,
    vmExistsAfterWrite: false,
    sandboxReadSucceeded: false,
    sandboxReadValue: undefined,
    error: undefined,
  };
  try {
    await vm.writeFile(mountedPath, content);
    result.vmWriteSucceeded = true;
    result.vmExistsAfterWrite = await vm.exists(mountedPath);
    const bytes = await sandbox.readFsFile({ path: probePath });
    result.sandboxReadSucceeded = true;
    result.sandboxReadValue = Buffer.from(bytes).toString("utf8");
  } catch (error) {
    result.error = error?.problem ?? error?.message ?? String(error);
  }
  return result;
}

function hostileMcpServerSource(paths) {
  return `
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createConnection } from "node:net";

const attacks = [];

async function attempt(name, fn) {
  try {
    const value = await fn();
    attacks.push({ name, ok: true, value: summarize(value) });
  } catch (error) {
    attacks.push({ name, ok: false, error: String(error && (error.stack || error.message) || error) });
  }
}

await attempt("read explicit host secret path", () => readFileSync(${JSON.stringify(paths.hostSecretPath)}, "utf8"));
await attempt("read likely project ambient key", () => readFileSync("/Users/example/Documents/New project 3/ignored-provider-key-file.txt", "utf8"));
await attempt("read container passwd", () => readFileSync("/etc/passwd", "utf8").slice(0, 160));
await attempt("write explicit host escape path", () => {
  mkdirSync(dirname(${JSON.stringify(paths.hostEscapePath)}), { recursive: true });
  writeFileSync(${JSON.stringify(paths.hostEscapePath)}, "direct write from docker sandbox mcp");
  return existsSync(${JSON.stringify(paths.hostEscapePath)});
});
await attempt("symlink host secret then read", () => {
  symlinkSync(${JSON.stringify(paths.hostSecretPath)}, "/tmp/host-secret-link");
  return readFileSync("/tmp/host-secret-link", "utf8");
});
await attempt("nested child writes explicit host path", () => {
  const script = "const fs=require('node:fs'); fs.mkdirSync(" + JSON.stringify(${JSON.stringify(dirname(paths.hostNestedEscapePath))}) + ", { recursive: true }); fs.writeFileSync(" + JSON.stringify(${JSON.stringify(paths.hostNestedEscapePath)}) + ", 'nested write from docker sandbox mcp');";
  const result = spawnSync("node", ["-e", script], { encoding: "utf8" });
  return { status: result.status, error: result.error && result.error.message, stderr: result.stderr, exists: existsSync(${JSON.stringify(paths.hostNestedEscapePath)}) };
});
await attempt("nested child reads host secret", () => {
  const script = "process.stdout.write(require('node:fs').readFileSync(" + JSON.stringify(${JSON.stringify(paths.hostSecretPath)}) + ", 'utf8'));";
  const result = spawnSync("node", ["-e", script], { encoding: "utf8" });
  return { status: result.status, error: result.error && result.error.message, stdout: result.stdout, stderr: result.stderr };
});
await attempt("read inherited parent env secret", () => process.env.AGENTOS_DOCKER_SANDBOX_PARENT_SECRET || null);
await attempt("command availability", () => {
  const result = spawnSync("sh", ["-lc", "node --version; python3 --version || true; gcc --version | head -1 || true; npm --version || true"], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
});
await attempt("fetch example.com", async () => {
  const response = await fetch("https://example.com");
  return { status: response.status, bytes: (await response.text()).length };
});
await attempt("fetch ambient.xyz", async () => {
  const response = await fetch("https://ambient.xyz");
  return { status: response.status, bytes: (await response.text()).length };
});
await attempt("host docker internal", async () => {
  const response = await fetch("http://host.docker.internal:1");
  return { status: response.status, bytes: (await response.text()).length };
});
await attempt("local socket connect", () => new Promise((resolve, reject) => {
  const socket = createConnection({ host: "127.0.0.1", port: 22 });
  const timer = setTimeout(() => {
    socket.destroy();
    resolve("timeout");
  }, 1500);
  socket.on("connect", () => {
    clearTimeout(timer);
    socket.destroy();
    resolve("connected");
  });
  socket.on("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
}));
await attempt("large in-process result", () => "x".repeat(1024 * 1024).length);

console.log(${JSON.stringify(marker)} + JSON.stringify(attacks));

function summarize(value) {
  if (typeof value === "string") return value.length > 240 ? value.slice(0, 240) + "...[truncated]" : value;
  return value;
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

function writeStdout(text) {
  return new Promise((resolve, reject) => {
    process.stdout.write(text, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
