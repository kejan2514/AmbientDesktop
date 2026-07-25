import type { ContextUsage } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import type { ContextUsageSnapshot, ThreadSummary } from "../../shared/threadTypes";
import {
  PROVIDER_CONTEXT_PREFLIGHT_COMPACTED_MESSAGE,
  PROVIDER_CONTEXT_PREFLIGHT_COMPACTION_INSTRUCTIONS,
  runAgentRuntimePromptPreflightBeforePrompt,
  type AgentRuntimePromptPreflightSession,
} from "./agentRuntimePromptPreflightBeforePrompt";
import { ProviderContextPreflightBlockError } from "./agentRuntimeProviderContextPreflight";

const compactionSettings = {
  reserveTokens: 16_384,
  hardPreflightPercent: 92,
};

function createThread(input: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: "thread-1",
    workspacePath: "/tmp/workspace",
    ...input,
  } as ThreadSummary;
}

function createSession(contextWindow?: number): AgentRuntimePromptPreflightSession {
  return {
    sessionFile: "/tmp/pi-session.jsonl",
    model: contextWindow === undefined ? undefined : { contextWindow },
    getContextUsage: () => ({
      tokens: 42,
      contextWindow: contextWindow ?? 120_000,
      percent: 1,
    } as ContextUsage),
    compact: async () => undefined,
    sessionManager: {
      getEntries: () => [],
    },
  };
}

function providerContextPreflightBlockError(message = "Ambient/Pi provider call blocked before streaming because the protected context is estimated at 191,440 tokens, above the 186,368 token safety budget."): ProviderContextPreflightBlockError {
  return new ProviderContextPreflightBlockError(message, {
    threadId: "thread-1",
    workspacePath: "/tmp/workspace",
    sessionFile: "/tmp/pi-session.jsonl",
    budgetTokens: 186_368,
    estimate: {
      beforeBytes: 1,
      afterBytes: 765_760,
      beforeTokens: 1,
      afterTokens: 191_440,
      largeTextCount: 0,
      largestTextChars: 0,
    },
    largeTextHint: " No single oversized text part was available for deterministic offload.",
  });
}

describe("runAgentRuntimePromptPreflightBeforePrompt", () => {
  it("runs prompt preflight before provider context preflight with runtime settings", async () => {
    const calls: string[] = [];
    const runPromptPreflightBeforePrompt = vi.fn(async () => {
      calls.push("prompt");
    });
    const runProviderCallContextPreflightBeforePrompt = vi.fn(async () => {
      calls.push("provider");
    });
    const session = createSession(200_000);

    await runAgentRuntimePromptPreflightBeforePrompt({
      thread: createThread(),
      session,
      promptContent: "hello",
      compactionSettings,
      unavailableContextWindow: 120_000,
      setActiveRunStatus: vi.fn(),
      emitRunEvent: vi.fn(),
      recordContextUsageSnapshot: vi.fn(() => ({}) as ContextUsageSnapshot),
    }, {
      runPromptPreflightBeforePrompt,
      runProviderCallContextPreflightBeforePrompt,
    });

    expect(calls).toEqual(["prompt", "provider"]);
    expect(runPromptPreflightBeforePrompt).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread-1",
      session,
      promptContent: "hello",
      compactionSettings,
      unavailableContextWindow: 120_000,
    }));
    expect(runProviderCallContextPreflightBeforePrompt).toHaveBeenCalledWith({
      threadId: "thread-1",
      workspacePath: "/tmp/workspace",
      session,
      promptContent: "hello",
      contextWindow: 200_000,
      requestedOutputTokens: undefined,
      reserveTokens: 16_384,
      hardPreflightPercent: 92,
    });
  });

  it("skips provider context preflight when the run becomes inactive after prompt preflight", async () => {
    const isRunStoreActive = vi.fn(() => false);
    const runProviderCallContextPreflightBeforePrompt = vi.fn(async () => undefined);

    await runAgentRuntimePromptPreflightBeforePrompt({
      thread: createThread(),
      session: createSession(200_000),
      promptContent: "hello",
      compactionSettings,
      unavailableContextWindow: 120_000,
      setActiveRunStatus: vi.fn(),
      isRunStoreActive,
      emitRunEvent: vi.fn(),
      recordContextUsageSnapshot: vi.fn(() => ({}) as ContextUsageSnapshot),
    }, {
      runPromptPreflightBeforePrompt: vi.fn(async () => undefined),
      runProviderCallContextPreflightBeforePrompt,
    });

    expect(isRunStoreActive).toHaveBeenCalledTimes(1);
    expect(runProviderCallContextPreflightBeforePrompt).not.toHaveBeenCalled();
  });

  it("uses the unavailable context window when the session has no model window", async () => {
    const runProviderCallContextPreflightBeforePrompt = vi.fn(async () => undefined);

    await runAgentRuntimePromptPreflightBeforePrompt({
      thread: createThread(),
      session: createSession(),
      promptContent: "hello",
      compactionSettings,
      unavailableContextWindow: 120_000,
      setActiveRunStatus: vi.fn(),
      emitRunEvent: vi.fn(),
      recordContextUsageSnapshot: vi.fn(() => ({}) as ContextUsageSnapshot),
    }, {
      runPromptPreflightBeforePrompt: vi.fn(async () => undefined),
      runProviderCallContextPreflightBeforePrompt,
    });

    expect(runProviderCallContextPreflightBeforePrompt).toHaveBeenCalledWith(expect.objectContaining({
      contextWindow: 120_000,
    }));
  });

  it("does not run provider context preflight when prompt preflight rejects", async () => {
    const runProviderCallContextPreflightBeforePrompt = vi.fn(async () => undefined);

    await expect(runAgentRuntimePromptPreflightBeforePrompt({
      thread: createThread(),
      session: createSession(200_000),
      promptContent: "hello",
      compactionSettings,
      unavailableContextWindow: 120_000,
      setActiveRunStatus: vi.fn(),
      emitRunEvent: vi.fn(),
      recordContextUsageSnapshot: vi.fn(() => ({}) as ContextUsageSnapshot),
    }, {
      runPromptPreflightBeforePrompt: vi.fn(async () => {
        throw new Error("prompt preflight failed");
      }),
      runProviderCallContextPreflightBeforePrompt,
    })).rejects.toThrow("prompt preflight failed");

    expect(runProviderCallContextPreflightBeforePrompt).not.toHaveBeenCalled();
  });

  it("compacts once and retries provider context preflight after a provider context safety block", async () => {
    const session = createSession(200_000);
    session.compact = vi.fn(async () => undefined);
    const setActiveRunStatus = vi.fn();
    const emitRunEvent = vi.fn();
    const recordContextUsageSnapshot = vi.fn(() => ({}) as ContextUsageSnapshot);
    const firstBlock = providerContextPreflightBlockError();
    const runProviderCallContextPreflightBeforePrompt = vi.fn()
      .mockRejectedValueOnce(firstBlock)
      .mockResolvedValueOnce(undefined);

    await runAgentRuntimePromptPreflightBeforePrompt({
      thread: createThread(),
      session,
      promptContent: "hello",
      compactionSettings,
      unavailableContextWindow: 120_000,
      setActiveRunStatus,
      emitRunEvent,
      recordContextUsageSnapshot,
    }, {
      runPromptPreflightBeforePrompt: vi.fn(async () => undefined),
      runProviderCallContextPreflightBeforePrompt,
    });

    expect(runProviderCallContextPreflightBeforePrompt).toHaveBeenCalledTimes(2);
    expect(session.compact).toHaveBeenCalledWith(PROVIDER_CONTEXT_PREFLIGHT_COMPACTION_INSTRUCTIONS);
    expect(recordContextUsageSnapshot).toHaveBeenCalledWith("thread-1", session, firstBlock.message);
    expect(recordContextUsageSnapshot).toHaveBeenCalledWith("thread-1", session, PROVIDER_CONTEXT_PREFLIGHT_COMPACTED_MESSAGE);
    expect(emitRunEvent).toHaveBeenCalledWith({
      type: "runtime-activity",
      activity: {
        threadId: "thread-1",
        kind: "compaction",
        status: "starting",
        reason: "overflow",
      },
    });
    expect(emitRunEvent).toHaveBeenCalledWith({
      type: "runtime-activity",
      activity: {
        threadId: "thread-1",
        kind: "compaction",
        status: "finished",
        reason: "overflow",
        aborted: false,
        willRetry: true,
        message: PROVIDER_CONTEXT_PREFLIGHT_COMPACTED_MESSAGE,
      },
    });
    expect(setActiveRunStatus).toHaveBeenCalledWith("compacting");
    expect(setActiveRunStatus).toHaveBeenLastCalledWith("streaming");
  });

  it("surfaces compaction failure after a provider context safety block", async () => {
    const session = createSession(200_000);
    session.compact = vi.fn(async () => {
      throw new Error("compact failed");
    });
    const emitRunEvent = vi.fn();
    const runProviderCallContextPreflightBeforePrompt = vi.fn()
      .mockRejectedValueOnce(providerContextPreflightBlockError());

    await expect(runAgentRuntimePromptPreflightBeforePrompt({
      thread: createThread(),
      session,
      promptContent: "hello",
      compactionSettings,
      unavailableContextWindow: 120_000,
      setActiveRunStatus: vi.fn(),
      emitRunEvent,
      recordContextUsageSnapshot: vi.fn(() => ({}) as ContextUsageSnapshot),
    }, {
      runPromptPreflightBeforePrompt: vi.fn(async () => undefined),
      runProviderCallContextPreflightBeforePrompt,
    })).rejects.toThrow("compact failed");

    expect(runProviderCallContextPreflightBeforePrompt).toHaveBeenCalledTimes(1);
    expect(emitRunEvent).toHaveBeenCalledWith({
      type: "runtime-activity",
      activity: {
        threadId: "thread-1",
        kind: "compaction",
        status: "finished",
        reason: "overflow",
        aborted: false,
        willRetry: false,
        message: "compact failed",
      },
    });
  });
});
