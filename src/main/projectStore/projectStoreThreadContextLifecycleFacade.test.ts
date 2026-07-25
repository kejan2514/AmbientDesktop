import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectStore } from "./projectStore";

const describeNative = process.env.AMBIENT_TEST_NATIVE === "1" ? describe : describe.skip;

describeNative("ProjectStore thread context and lifecycle facade (requires Node ABI better-sqlite3 build)", () => {
  let workspacePath = "";
  let store: ProjectStore;

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), "ambient-store-"));
    store = new ProjectStore();
    store.openWorkspace(workspacePath);
  });

  afterEach(async () => {
    store.close();
    await rm(workspacePath, { recursive: true, force: true });
  });

  it("records context usage snapshots for diagnostics", () => {
    const thread = store.createThread("Context accounting");
    const snapshot = store.recordContextUsageSnapshot({
      threadId: thread.id,
      modelId: "example/model-id",
      source: "provider-plus-estimate",
      tokens: 42_000,
      contextWindow: 200_000,
      percent: 21,
      latestCompactionAt: "2026-05-01T00:00:00.000Z",
      compactionCount: 1,
      updatedAt: "2026-05-01T00:00:01.000Z",
      diagnostics: {
        piSessionFile: "/tmp/session.jsonl",
        piSessionFileExists: true,
        activeSession: true,
      },
    });

    expect(snapshot).toMatchObject({
      threadId: thread.id,
      modelId: "example/model-id",
      source: "provider-plus-estimate",
      tokens: 42_000,
      contextWindow: 200_000,
      percent: 21,
      compactionCount: 1,
      diagnostics: {
        activeSession: true,
      },
    });
    expect(store.getLatestContextUsageSnapshot(thread.id)).toMatchObject({ threadId: thread.id, tokens: 42_000 });
    expect(store.listContextUsageSnapshots()).toEqual([expect.objectContaining({ threadId: thread.id })]);
  });

  it("keeps only one reusable empty starter thread", () => {
    const first = store.findReusableEmptyThread();
    const second = store.createThread();

    expect(first).toBeTruthy();
    expect(store.listThreads().map((thread) => thread.id)).toEqual(expect.arrayContaining([second.id, first!.id]));

    expect(store.pruneRedundantEmptyThreads()).toBe(1);
    expect(store.listThreads()).toHaveLength(1);
    expect(store.findReusableEmptyThread()).toBeTruthy();
  });

  it("does not reuse empty-looking chats that already have Pi context state", () => {
    const sessionBacked = store.findReusableEmptyThread();
    expect(sessionBacked).toBeTruthy();

    store.updateThreadSettings(sessionBacked!.id, { piSessionFile: "/tmp/session.jsonl" });
    expect(store.findReusableEmptyThread()).toBeUndefined();

    const snapshotBacked = store.createThread();
    store.recordContextUsageSnapshot({
      threadId: snapshotBacked.id,
      source: "estimate",
      tokens: 1,
      contextWindow: 200_000,
      percent: 0.0005,
      compactionCount: 0,
    });

    expect(store.findReusableEmptyThread()).toBeUndefined();
  });

  it("pins, marks unread, and archives individual chat threads", () => {
    const first = store.createThread("First chat");
    const second = store.createThread("Second chat");

    expect(store.setThreadPinned(first.id, true).pinned).toBe(true);
    expect(store.listThreads()[0].id).toBe(first.id);
    expect(store.listThreads().map((thread) => thread.id)).toContain(second.id);

    const unread = store.markThreadUnread(first.id);
    expect(unread.lastReadAt).toBeTruthy();
    expect(unread.lastReadAt! < unread.updatedAt).toBe(true);

    expect(store.archiveThread(first.id)).toBe(1);
    expect(store.listThreads().map((thread) => thread.id)).not.toContain(first.id);
    expect(store.listThreads().map((thread) => thread.id)).toContain(second.id);
  });

  it("forks chat transcript content into a new thread", () => {
    const source = store.createThread("Forkable chat");
    store.addMessage({ threadId: source.id, role: "user", content: "Build the prototype." });
    store.addMessage({ threadId: source.id, role: "assistant", content: "Prototype built." });

    const fork = store.forkThread(source.id);

    expect(fork.id).not.toBe(source.id);
    expect(fork.title).toBe(source.title);
    expect(fork.workspacePath).toBe(source.workspacePath);
    expect(store.listMessages(fork.id).map((message) => [message.role, message.content])).toEqual([
      ["user", "Build the prototype."],
      ["assistant", "Prototype built."],
    ]);
  });

  it("removes empty starter threads once real work exists", () => {
    const starter = store.findReusableEmptyThread();
    const workThread = store.createThread("Real work");
    store.addMessage({ threadId: workThread.id, role: "user", content: "Build the app." });

    expect(starter).toBeTruthy();
    expect(store.pruneRedundantEmptyThreads()).toBe(1);
    expect(store.listThreads().map((thread) => thread.id)).not.toContain(starter!.id);
    expect(store.findReusableEmptyThread()).toBeUndefined();
  });
});
