import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWorkflowHook, sanitizeOutput } from "./orchestrationHooks";

describe("sanitizeOutput", () => {
  it("redacts common secret shapes", () => {
    expect(sanitizeOutput("AMBIENT_API_KEY_FILE=<ignored-key-file> Bearer abcdefghijklmnop")).toBe(
      "AMBIENT_API_KEY_FILE=<ignored-key-file> Bearer [redacted]",
    );
  });
});

describe("runWorkflowHook", () => {
  let cwd = "";

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "ambient-hook-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("runs hook commands in the requested cwd", async () => {
    const result = await runWorkflowHook("beforeRun", "pwd", cwd, { timeoutMs: 1_000 });
    const realCwd = await realpath(cwd);

    expect(result).toMatchObject({ hook: "beforeRun", ok: true, cwd: realCwd });
    expect(result?.stdout.trim()).toBe(realCwd);
  });

  it("captures failures without throwing", async () => {
    const result = await runWorkflowHook("afterCreate", "echo nope >&2; exit 7", cwd, { timeoutMs: 1_000 });

    expect(result).toMatchObject({ ok: false, exitCode: 7, timedOut: false });
    expect(result?.stderr).toContain("nope");
  });

  it("times out long running hooks", async () => {
    const result = await runWorkflowHook("beforeRun", "sleep 2", cwd, { timeoutMs: 50 });

    expect(result).toMatchObject({ ok: false, timedOut: true });
  });

  it("redacts and truncates output", async () => {
    const result = await runWorkflowHook("beforeRun", "printf 'TOKEN=supersecretvalue1234567890\\nabcdef'", cwd, {
      timeoutMs: 1_000,
      maxOutputChars: 18,
    });

    expect(result?.stdout).not.toContain("supersecretvalue");
    expect(result?.stdout).toContain("[truncated]");
    expect(result?.truncated).toBe(true);
  });
});
