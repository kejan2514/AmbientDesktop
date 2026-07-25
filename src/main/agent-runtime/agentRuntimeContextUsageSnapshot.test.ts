import type { ContextUsage, SessionEntry } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  buildActiveContextUsageSnapshot,
  buildUnavailableContextUsageSnapshot,
  contextUsageCompactionStatsFromEntries,
  contextUsagePreflightInput,
  contextUsageSource,
  readSessionCompactionStats,
  safeContextUsage,
  type ActiveContextUsageSnapshotSession,
  type ContextUsageModelWindowReader,
  type ContextUsageReader,
} from "./agentRuntimeContextUsageSnapshot";

function usage(input: Partial<ContextUsage>): ContextUsage {
  return {
    tokens: 42_000,
    contextWindow: 200_000,
    percent: 21,
    ...input,
  } as ContextUsage;
}

function sessionEntry(type: string, timestamp?: string): SessionEntry {
  return {
    type,
    timestamp,
  } as SessionEntry;
}

function activeSession(input: Partial<ActiveContextUsageSnapshotSession> = {}): ActiveContextUsageSnapshotSession {
  return {
    getContextUsage: () => usage({}),
    sessionFile: "/sessions/thread-1/session.jsonl",
    model: { id: "example/model-id", contextWindow: 180_000 },
    sessionManager: {
      getEntries: () => [],
    },
    ...input,
  };
}

function preflightSession(input: Partial<ContextUsageModelWindowReader> = {}): ContextUsageModelWindowReader {
  return {
    getContextUsage: () => usage({ tokens: 42_000, contextWindow: 200_000 }),
    model: { contextWindow: 180_000 },
    ...input,
  };
}

describe("agentRuntimeContextUsageSnapshot", () => {
  it("reads context usage from a live session", () => {
    const currentUsage = usage({ tokens: 7_500, percent: 3.75 });

    expect(safeContextUsage({
      getContextUsage: () => currentUsage,
    })).toBe(currentUsage);
  });

  it("treats context usage read failures as unavailable", () => {
    const session: ContextUsageReader = {
      getContextUsage: () => {
        throw new Error("session has not initialized usage accounting");
      },
    };

    expect(safeContextUsage(session)).toBeUndefined();
  });

  it("classifies missing usage as unavailable", () => {
    expect(contextUsageSource(undefined)).toBe("unavailable");
  });

  it("classifies incomplete usage as unknown after compaction", () => {
    expect(contextUsageSource(usage({ tokens: null }))).toBe("unknown-after-compaction");
    expect(contextUsageSource(usage({ percent: null }))).toBe("unknown-after-compaction");
  });

  it("classifies complete usage as provider plus estimate", () => {
    expect(contextUsageSource(usage({ tokens: 120_000, percent: 60 }))).toBe("provider-plus-estimate");
  });

  it("counts compaction entries and reports the latest compaction timestamp", () => {
    expect(contextUsageCompactionStatsFromEntries([
      sessionEntry("message", "2026-06-12T13:00:00.000Z"),
      sessionEntry("compaction", "2026-06-12T13:01:00.000Z"),
      sessionEntry("tool", "2026-06-12T13:02:00.000Z"),
      sessionEntry("compaction", "2026-06-12T13:03:00.000Z"),
    ])).toEqual({
      compactionCount: 2,
      latestCompactionAt: "2026-06-12T13:03:00.000Z",
    });
  });

  it("reports zero compactions when no compaction entries exist", () => {
    expect(contextUsageCompactionStatsFromEntries([
      sessionEntry("message", "2026-06-12T13:00:00.000Z"),
      sessionEntry("tool", "2026-06-12T13:01:00.000Z"),
    ])).toEqual({ compactionCount: 0 });
  });

  it("uses provider usage tokens and context window for prompt preflight", () => {
    expect(contextUsagePreflightInput(
      preflightSession({
        getContextUsage: () => usage({ tokens: 80_000, contextWindow: 200_000 }),
      }),
      120_000,
    )).toEqual({
      currentTokens: 80_000,
      contextWindow: 200_000,
    });
  });

  it("falls back to the session model context window when preflight usage is unavailable", () => {
    expect(contextUsagePreflightInput(
      preflightSession({
        getContextUsage: () => undefined,
        model: { contextWindow: 96_000 },
      }),
      120_000,
    )).toEqual({
      currentTokens: undefined,
      contextWindow: 96_000,
    });
  });

  it("falls back to the unavailable context window when preflight usage and model window are unavailable", () => {
    expect(contextUsagePreflightInput(
      preflightSession({
        getContextUsage: () => {
          throw new Error("context usage unavailable");
        },
        model: undefined,
      }),
      120_000,
    )).toEqual({
      currentTokens: undefined,
      contextWindow: 120_000,
    });
  });

  it("does not open a session manager when no session file is restorable", () => {
    let opened = false;

    expect(readSessionCompactionStats(undefined, "/sessions/thread-1", "/workspace", () => {
      opened = true;
      return { getEntries: () => [] };
    })).toEqual({ compactionCount: 0 });
    expect(opened).toBe(false);
  });

  it("reads compaction stats from a restorable session file", () => {
    const stats = readSessionCompactionStats(
      "/sessions/thread-1/session.jsonl",
      "/sessions/thread-1",
      "/workspace",
      (sessionFile, sessionDir, workspacePath) => {
        expect({ sessionFile, sessionDir, workspacePath }).toEqual({
          sessionFile: "/sessions/thread-1/session.jsonl",
          sessionDir: "/sessions/thread-1",
          workspacePath: "/workspace",
        });
        return {
          getEntries: () => [
            sessionEntry("compaction", "2026-06-12T13:04:00.000Z"),
          ],
        };
      },
    );

    expect(stats).toEqual({
      compactionCount: 1,
      latestCompactionAt: "2026-06-12T13:04:00.000Z",
    });
  });

  it("treats session manager read failures as zero compactions", () => {
    expect(readSessionCompactionStats(
      "/sessions/thread-1/session.jsonl",
      "/sessions/thread-1",
      "/workspace",
      () => {
        throw new Error("session file is corrupt");
      },
    )).toEqual({ compactionCount: 0 });
  });

  it("builds active context usage snapshots from live session state", () => {
    const snapshot = buildActiveContextUsageSnapshot({
      threadId: "thread-1",
      session: activeSession({
        getContextUsage: () => usage({
          tokens: 80_000,
          contextWindow: 200_000,
          percent: 40,
        }),
        sessionManager: {
          getEntries: () => [
            sessionEntry("message", "2026-06-12T13:10:00.000Z"),
            sessionEntry("compaction", "2026-06-12T13:11:00.000Z"),
          ],
        },
      }),
      unavailableContextWindow: 120_000,
      ambientCliSkillMount: {
        lazyModeEnabled: true,
        installedCliPackageCount: 3,
        eagerCliSkillCount: 1,
        mountedCliSkillCount: 2,
      },
      providerPayload: {
        requestType: "normal",
        model: "example/model-id",
        messageCount: 2,
        toolCount: 3,
        toolNames: ["read", "ambient_tool_search", "ambient_tool_call"],
        toolSchemaBytes: 1234,
        totalBytes: 4321,
        estimatedTokens: 1080,
      },
      message: "Compaction started.",
      now: () => new Date("2026-06-12T13:12:00.000Z"),
      fileExists: (path) => path === "/sessions/thread-1/session.jsonl",
    });

    expect(snapshot).toEqual({
      threadId: "thread-1",
      modelId: "example/model-id",
      source: "provider-plus-estimate",
      tokens: 80_000,
      contextWindow: 200_000,
      percent: 40,
      latestCompactionAt: "2026-06-12T13:11:00.000Z",
      compactionCount: 1,
      updatedAt: "2026-06-12T13:12:00.000Z",
      diagnostics: {
        piSessionFile: "/sessions/thread-1/session.jsonl",
        piSessionFileExists: true,
        activeSession: true,
        ambientCliSkillMount: {
          lazyModeEnabled: true,
          installedCliPackageCount: 3,
          eagerCliSkillCount: 1,
          mountedCliSkillCount: 2,
        },
        providerPayload: {
          requestType: "normal",
          model: "example/model-id",
          messageCount: 2,
          toolCount: 3,
          toolNames: ["read", "ambient_tool_search", "ambient_tool_call"],
          toolSchemaBytes: 1234,
          totalBytes: 4321,
          estimatedTokens: 1080,
        },
        message: "Compaction started.",
      },
    });
  });

  it("falls back to the session model context window when usage is unavailable", () => {
    const snapshot = buildActiveContextUsageSnapshot({
      threadId: "thread-1",
      session: activeSession({
        getContextUsage: () => undefined,
        model: { contextWindow: 96_000 },
      }),
      unavailableContextWindow: 120_000,
      now: () => new Date("2026-06-12T13:12:00.000Z"),
      fileExists: () => false,
    });

    expect(snapshot).toMatchObject({
      source: "unavailable",
      tokens: undefined,
      contextWindow: 96_000,
      percent: undefined,
      diagnostics: {
        piSessionFileExists: false,
        activeSession: true,
      },
    });
  });

  it("uses the unavailable context window fallback when the session has no usage or model window", () => {
    let checkedPath: string | undefined;
    const snapshot = buildActiveContextUsageSnapshot({
      threadId: "thread-1",
      session: activeSession({
        getContextUsage: () => undefined,
        sessionFile: undefined,
        model: undefined,
      }),
      unavailableContextWindow: 120_000,
      now: () => new Date("2026-06-12T13:12:00.000Z"),
      fileExists: (path) => {
        checkedPath = path;
        return true;
      },
    });

    expect(snapshot.contextWindow).toBe(120_000);
    expect(snapshot.diagnostics?.piSessionFileExists).toBe(false);
    expect(checkedPath).toBeUndefined();
  });

  it("builds unavailable snapshots without opening session files when no thread session file is present", () => {
    let opened = false;
    let fileChecked: string | undefined;

    const snapshot = buildUnavailableContextUsageSnapshot({
      threadId: "thread-1",
      modelId: "example/model-id",
      sessionDir: "/sessions/thread-1",
      workspacePath: "/workspace",
      contextWindow: 200_000,
      message: "No active Pi session has reported context usage yet.",
      now: () => new Date("2026-06-12T13:13:00.000Z"),
      fileExists: (path) => {
        fileChecked = path;
        return true;
      },
      getRestorableSessionFile: () => undefined,
      openSessionManager: () => {
        opened = true;
        return { getEntries: () => [] };
      },
    });

    expect(snapshot).toEqual({
      threadId: "thread-1",
      modelId: "example/model-id",
      source: "unavailable",
      contextWindow: 200_000,
      compactionCount: 0,
      latestCompactionAt: undefined,
      updatedAt: "2026-06-12T13:13:00.000Z",
      diagnostics: {
        piSessionFile: undefined,
        piSessionFileExists: false,
        activeSession: false,
        message: "No active Pi session has reported context usage yet.",
      },
    });
    expect(fileChecked).toBeUndefined();
    expect(opened).toBe(false);
  });

  it("reports thread session file existence even when the file is not restorable", () => {
    let opened = false;

    const snapshot = buildUnavailableContextUsageSnapshot({
      threadId: "thread-1",
      modelId: "example/model-id",
      sessionFile: "/outside/session.jsonl",
      sessionDir: "/sessions/thread-1",
      workspacePath: "/workspace",
      contextWindow: 200_000,
      message: "No active session.",
      now: () => new Date("2026-06-12T13:13:00.000Z"),
      fileExists: (path) => path === "/outside/session.jsonl",
      getRestorableSessionFile: (sessionFile, sessionDir) => {
        expect({ sessionFile, sessionDir }).toEqual({
          sessionFile: "/outside/session.jsonl",
          sessionDir: "/sessions/thread-1",
        });
        return undefined;
      },
      openSessionManager: () => {
        opened = true;
        return { getEntries: () => [] };
      },
    });

    expect(snapshot.compactionCount).toBe(0);
    expect(snapshot.diagnostics).toMatchObject({
      piSessionFile: "/outside/session.jsonl",
      piSessionFileExists: true,
      activeSession: false,
      message: "No active session.",
    });
    expect(opened).toBe(false);
  });

  it("builds unavailable snapshots with compaction stats from restorable session files", () => {
    const snapshot = buildUnavailableContextUsageSnapshot({
      threadId: "thread-1",
      modelId: "example/model-id",
      sessionFile: "/sessions/thread-1/session.jsonl",
      sessionDir: "/sessions/thread-1",
      workspacePath: "/workspace",
      contextWindow: 200_000,
      message: "Model context is unavailable.",
      now: () => new Date("2026-06-12T13:13:00.000Z"),
      fileExists: (path) => path === "/sessions/thread-1/session.jsonl",
      getRestorableSessionFile: () => "/sessions/thread-1/session.jsonl",
      openSessionManager: (sessionFile, sessionDir, workspacePath) => {
        expect({ sessionFile, sessionDir, workspacePath }).toEqual({
          sessionFile: "/sessions/thread-1/session.jsonl",
          sessionDir: "/sessions/thread-1",
          workspacePath: "/workspace",
        });
        return {
          getEntries: () => [
            sessionEntry("compaction", "2026-06-12T13:14:00.000Z"),
            sessionEntry("compaction", "2026-06-12T13:15:00.000Z"),
          ],
        };
      },
    });

    expect(snapshot).toMatchObject({
      threadId: "thread-1",
      source: "unavailable",
      contextWindow: 200_000,
      compactionCount: 2,
      latestCompactionAt: "2026-06-12T13:15:00.000Z",
      updatedAt: "2026-06-12T13:13:00.000Z",
      diagnostics: {
        piSessionFile: "/sessions/thread-1/session.jsonl",
        piSessionFileExists: true,
        activeSession: false,
        message: "Model context is unavailable.",
      },
    });
  });
});
