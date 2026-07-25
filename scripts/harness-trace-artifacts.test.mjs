import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { snapshotHarnessWorkspace, writeHarnessTraceArtifacts } from "./harness-trace-artifacts.mjs";

describe("meta harness trace artifacts", () => {
  it("captures redacted messages, tool transcripts, and workspace changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-trace-artifacts-"));
    const workspace = join(root, "workspace");
    const traceDir = join(root, "trace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "README.md"), "before\n", "utf8");
    await writeFile(join(workspace, "ignored-provider-key-file.txt"), "do-not-read", "utf8");
    const beforeWorkspace = await snapshotHarnessWorkspace(workspace);
    await writeFile(join(workspace, "README.md"), "after\n", "utf8");
    await writeFile(join(workspace, "src.txt"), "created\n", "utf8");

    const result = await writeHarnessTraceArtifacts({
      traceDir,
      workspace,
      beforeWorkspace,
      summary: { status: "passed" },
      messages: [
        { id: "m1", role: "assistant", content: "done" },
        { id: "m2", role: "tool", content: "AMBIENT_API_KEY_FILE=<ignored-key-file>", metadata: { toolName: "bash" } },
      ],
    });

    expect(result.artifacts).toEqual(expect.arrayContaining(["messages.jsonl", "tool-transcript.txt", "changed-files.json", "trace-preview.json"]));
    expect(await readFile(join(traceDir, "tool-transcript.txt"), "utf8")).toContain("AMBIENT_API_KEY_FILE=<ignored-key-file>");
    const changed = JSON.parse(await readFile(join(traceDir, "changed-files.json"), "utf8"));
    expect(changed.changes.map((change) => [change.path, change.status])).toEqual([
      ["README.md", "modified"],
      ["src.txt", "added"],
    ]);
    expect(changed.beforeOmitted.secretLike).toBe(1);
  });
});
