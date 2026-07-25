import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { DesktopEvent } from "../../shared/desktopTypes";
import { AgentRuntimeContextRecoveryController, type AgentRuntimeContextRecoverySession } from "./agentRuntimeContextRecoveryController";
import { ProjectStore } from "./agentRuntimeProjectStoreFacade";

async function withController<T>(
  callback: (input: {
    store: ProjectStore;
    workspacePath: string;
    activeSessions: Map<string, AgentRuntimeContextRecoverySession>;
    controller: AgentRuntimeContextRecoveryController;
    emitted: DesktopEvent[];
    getSession: ReturnType<typeof vi.fn<(thread: ReturnType<ProjectStore["getThread"]>) => Promise<AgentRuntimeContextRecoverySession>>>;
  }) => Promise<T> | T,
): Promise<T> {
  const workspacePath = await mkdtemp(join(tmpdir(), "ambient-context-recovery-controller-"));
  const store = new ProjectStore();
  const activeSessions = new Map<string, AgentRuntimeContextRecoverySession>();
  const emitted: DesktopEvent[] = [];
  const getSession = vi.fn<(thread: ReturnType<ProjectStore["getThread"]>) => Promise<AgentRuntimeContextRecoverySession>>();
  try {
    store.openWorkspace(workspacePath);
    const controller = new AgentRuntimeContextRecoveryController({
      store,
      hasActiveRun: () => false,
      getActiveSession: (threadId) => activeSessions.get(threadId),
      deleteActiveSession: (threadId) => activeSessions.delete(threadId),
      getSession,
      commitThreadPiSessionFile: async (input) => store.updateThreadSettings(input.threadId, { piSessionFile: input.sessionFile }),
      ambientCliSkillMountForThread: () => undefined,
      emit: (event) => emitted.push(event),
      openSessionManager: () => ({ getEntries: () => [] }),
      now: () => new Date("2026-05-01T00:00:00.000Z"),
    });
    return await callback({ store, workspacePath, activeSessions, controller, emitted, getSession });
  } finally {
    store.close();
    await rm(workspacePath, { recursive: true, force: true });
  }
}

describe("AgentRuntimeContextRecoveryController", () => {
  it("records context usage from an active session", async () => {
    await withController(async ({ store, activeSessions, controller, emitted }) => {
      const workspace = store.getWorkspace();
      const thread = store.createThread("context usage");
      const threadSessionDir = join(workspace.sessionPath, thread.id);
      await mkdir(threadSessionDir, { recursive: true });
      const sessionFile = join(threadSessionDir, "session.jsonl");
      await writeFile(sessionFile, "", "utf8");
      activeSessions.set(thread.id, fakePiSession(sessionFile));
      store.recordContextUsageSnapshot({
        threadId: thread.id,
        source: "estimate",
        tokens: 480,
        contextWindow: 128_000,
        percent: 0.375,
        compactionCount: 0,
        diagnostics: {
          activeSession: true,
          providerPayload: {
            requestType: "normal",
            model: "example/model-id",
            messageCount: 2,
            toolCount: 2,
            toolNames: ["read", "ambient_tool_search"],
            toolSchemaBytes: 987,
            totalBytes: 4321,
            estimatedTokens: 1080,
          },
        },
      });

      const snapshot = await controller.getContextUsage(thread.id);

      expect(snapshot).toMatchObject({
        threadId: thread.id,
        source: "provider-plus-estimate",
        tokens: 512,
        contextWindow: 128_000,
        percent: 0.4,
        diagnostics: expect.objectContaining({
          piSessionFile: sessionFile,
          piSessionFileExists: true,
          activeSession: true,
          providerPayload: expect.objectContaining({
            model: "example/model-id",
            toolCount: 2,
            toolNames: ["read", "ambient_tool_search"],
            toolSchemaBytes: 987,
          }),
        }),
      });
      expect(store.getLatestContextUsageSnapshot(thread.id)).toMatchObject({
        threadId: thread.id,
        tokens: 512,
      });
      expect(emitted).toContainEqual({
        type: "context-usage-updated",
        snapshot: expect.objectContaining({ threadId: thread.id, tokens: 512 }),
      });
    });
  });

  it("does not reuse a persisted context snapshot from a different model", async () => {
    await withController(async ({ store, controller }) => {
      const thread = store.createThread("model-scoped context");
      store.recordContextUsageSnapshot({
        threadId: thread.id,
        modelId: "old-model",
        source: "estimate",
        tokens: 100_000,
        contextWindow: 80_000,
        percent: 125,
        compactionCount: 0,
      });

      const snapshot = await controller.getContextUsage(thread.id);

      expect(snapshot).toMatchObject({
        threadId: thread.id,
        modelId: thread.model,
        source: "unavailable",
        percent: undefined,
        diagnostics: expect.objectContaining({
          message: "The selected model has not reported context usage yet.",
        }),
      });
    });
  });

  it("runs manual compaction, commits the session file, and returns to idle", async () => {
    await withController(async ({ store, controller, emitted, getSession }) => {
      const workspace = store.getWorkspace();
      const thread = store.createThread("manual compaction");
      const threadSessionDir = join(workspace.sessionPath, thread.id);
      await mkdir(threadSessionDir, { recursive: true });
      const sessionFile = join(threadSessionDir, "compacted.jsonl");
      await writeFile(sessionFile, "", "utf8");
      const session = fakePiSession(sessionFile);
      const unsubscribe = vi.fn();
      let subscribed: ((event: unknown) => void) | undefined;
      session.subscribe = vi.fn((handler) => {
        subscribed = handler;
        return unsubscribe;
      });
      session.compact = vi.fn(async () => {
        subscribed?.({ type: "compaction_start", reason: "manual" });
        subscribed?.({ type: "compaction_end", reason: "manual", aborted: false, willRetry: false });
      });
      getSession.mockResolvedValue(session);

      const snapshot = await controller.compactThread({
        threadId: thread.id,
        customInstructions: "Keep deployment notes.",
      });

      expect(session.subscribe).toHaveBeenCalledOnce();
      expect(session.compact).toHaveBeenCalledWith("Keep deployment notes.");
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(store.getThread(thread.id).piSessionFile).toBe(sessionFile);
      expect(snapshot).toMatchObject({
        threadId: thread.id,
        diagnostics: expect.objectContaining({
          piSessionFile: sessionFile,
          activeSession: true,
        }),
      });
      expect(emitted).toEqual(expect.arrayContaining([
        { type: "run-status", threadId: thread.id, status: "compacting" },
        {
          type: "runtime-activity",
          activity: expect.objectContaining({
            threadId: thread.id,
            kind: "compaction",
            status: "starting",
            reason: "manual",
          }),
        },
        {
          type: "runtime-activity",
          activity: expect.objectContaining({
            threadId: thread.id,
            kind: "compaction",
            status: "finished",
            reason: "manual",
          }),
        },
        { type: "run-status", threadId: thread.id, status: "idle" },
      ]));
    });
  });

  it("recovers visible transcript when no Pi session file was recorded", async () => {
    await withController(async ({ store, controller, getSession }) => {
      const workspace = store.getWorkspace();
      const thread = store.createThread("context recovery");
      store.addMessage({ threadId: thread.id, role: "user", content: "Build a notes app." });
      store.addMessage({ threadId: thread.id, role: "assistant", content: "I created the notes app shell." });
      const threadSessionDir = join(workspace.sessionPath, thread.id);
      await mkdir(threadSessionDir, { recursive: true });
      const sessionFile = join(threadSessionDir, "recovered.jsonl");
      await writeFile(sessionFile, "", "utf8");
      const session = fakePiSession(sessionFile);
      getSession.mockResolvedValue(session);

      const snapshot = await controller.recoverThreadContext({ threadId: thread.id });

      expect(session.sendCustomMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: "ambient-visible-transcript-recovery",
          content: expect.stringContaining("No Pi session file was recorded for this chat"),
        }),
        { triggerTurn: false, deliverAs: "nextTurn" },
      );
      expect(store.getThread(thread.id).piSessionFile).toBe(sessionFile);
      expect(recoveryMessages(store, thread.id)).toHaveLength(1);
      expect(snapshot).toMatchObject({
        threadId: thread.id,
        diagnostics: expect.objectContaining({
          piSessionFile: sessionFile,
          piSessionFileExists: true,
          activeSession: true,
        }),
      });
    });
  });

  it("recovers visible transcript when the recorded Pi session file is missing", async () => {
    await withController(async ({ store, controller, getSession }) => {
      const workspace = store.getWorkspace();
      const created = store.createThread("missing session recovery");
      const threadSessionDir = join(workspace.sessionPath, created.id);
      const missingSessionFile = join(threadSessionDir, "missing.jsonl");
      const thread = store.updateThreadSettings(created.id, { piSessionFile: missingSessionFile });
      store.addMessage({ threadId: thread.id, role: "user", content: "Remember this project state." });
      store.addMessage({ threadId: thread.id, role: "assistant", content: "The project state is recorded." });
      await mkdir(threadSessionDir, { recursive: true });
      const recoveredSessionFile = join(threadSessionDir, "recovered.jsonl");
      await writeFile(recoveredSessionFile, "", "utf8");
      const session = fakePiSession(recoveredSessionFile);
      getSession.mockResolvedValue(session);

      await controller.recoverThreadContext({ threadId: thread.id });

      expect(session.sendCustomMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: "ambient-visible-transcript-recovery",
          content: expect.stringContaining("missing or outside the thread session directory"),
        }),
        { triggerTurn: false, deliverAs: "nextTurn" },
      );
      expect(store.getThread(thread.id).piSessionFile).toBe(recoveredSessionFile);
      expect(recoveryMessages(store, thread.id)).toHaveLength(1);
    });
  });

  it("rejects recovery when there is no visible transcript to rebuild from", async () => {
    await withController(async ({ store, controller, getSession }) => {
      const thread = store.createThread("empty recovery");

      await expect(controller.recoverThreadContext({ threadId: thread.id })).rejects.toThrow(
        "There is no visible transcript to rebuild model context from.",
      );

      expect(getSession).not.toHaveBeenCalled();
    });
  });

  it("rejects lossy recovery when the existing Pi session file is restorable", async () => {
    await withController(async ({ store, controller, getSession }) => {
      const workspace = store.getWorkspace();
      const created = store.createThread("healthy session");
      const threadSessionDir = join(workspace.sessionPath, created.id);
      await mkdir(threadSessionDir, { recursive: true });
      const sessionFile = join(threadSessionDir, "session.jsonl");
      await writeFile(sessionFile, "", "utf8");
      const thread = store.updateThreadSettings(created.id, { piSessionFile: sessionFile });
      store.addMessage({ threadId: thread.id, role: "user", content: "Continue normally." });

      await expect(controller.recoverThreadContext({ threadId: thread.id })).rejects.toThrow(
        "This chat's Pi session file is available. Use normal compaction instead of lossy recovery.",
      );

      expect(getSession).not.toHaveBeenCalled();
      expect(recoveryMessages(store, thread.id)).toHaveLength(0);
    });
  });

  it("does not duplicate recovery messages when recovery has already produced a restorable session", async () => {
    await withController(async ({ store, controller, getSession }) => {
      const workspace = store.getWorkspace();
      const created = store.createThread("already recovered session");
      const threadSessionDir = join(workspace.sessionPath, created.id);
      await mkdir(threadSessionDir, { recursive: true });
      const sessionFile = join(threadSessionDir, "session.jsonl");
      await writeFile(sessionFile, "", "utf8");
      const thread = store.updateThreadSettings(created.id, { piSessionFile: sessionFile });
      store.addMessage({ threadId: thread.id, role: "user", content: "Continue from recovery." });
      store.addMessage({
        threadId: thread.id,
        role: "system",
        content: "Model context was rebuilt from the visible transcript.",
        metadata: { status: "done", runtime: "ambient-recovery", lossy: true },
      });
      const session = fakePiSession(sessionFile);
      getSession.mockResolvedValue(session);

      const snapshot = await controller.recoverThreadContext({ threadId: thread.id });

      expect(session.sendCustomMessage).not.toHaveBeenCalled();
      expect(recoveryMessages(store, thread.id)).toHaveLength(1);
      expect(snapshot.diagnostics?.message).toBe("Model context was already rebuilt from the visible transcript.");
      expect(store.getThread(thread.id).piSessionFile).toBe(sessionFile);
    });
  });
});

function fakePiSession(sessionFile: string): AgentRuntimeContextRecoverySession {
  return {
    sessionFile,
    sessionManager: {
      getEntries: () => [],
    },
    model: {
      id: "example/model-id",
      contextWindow: 128_000,
    },
    getContextUsage: () => ({
      tokens: 512,
      contextWindow: 128_000,
      percent: 0.4,
    }),
    sendCustomMessage: vi.fn(async () => undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
    compact: vi.fn(async () => undefined),
  };
}

function recoveryMessages(store: ProjectStore, threadId: string) {
  return store.listMessages(threadId).filter((message) => message.metadata?.runtime === "ambient-recovery");
}
