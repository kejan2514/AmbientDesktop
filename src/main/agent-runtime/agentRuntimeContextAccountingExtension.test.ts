import { describe, expect, it, vi } from "vitest";

import type { ContextUsageSnapshot } from "../../shared/threadTypes";
import { summarizeProviderPayload } from "../../shared/contextAccounting";
import { createContextAccountingExtension } from "./agentRuntimeContextAccountingExtension";

type ProviderRequestHandler = (event: any) => Promise<undefined>;

describe("createContextAccountingExtension", () => {
  it("records tokenizer-backed provider payload context usage with session diagnostics", async () => {
    const payload = {
      model: "ambient-test",
      messages: [
        { role: "system", content: "Use concise answers." },
        { role: "user", content: "Summarize the workspace." },
      ],
      tools: [{ function: { name: "read" } }],
    };
    const accounting = summarizeProviderPayload(payload);
    const pi = fakePi();
    const recordedSnapshots: any[] = [];
    const emitted: ContextUsageSnapshot[] = [];
    const countSerializedPayload = vi.fn(async () => ({
      source: "local-tokenizer" as const,
      tokens: 321,
      latencyMs: 9,
    }));
    const onProviderRequestPrepared = vi.fn();

    createContextAccountingExtension({
      threadId: "thread-1",
      modelId: "ambient-test",
      contextWindow: 1_000,
      getActiveSession: () => ({
        sessionFile: "/tmp/session.json",
        sessionManager: {
          getEntries: () => [{ type: "compaction" }],
        },
      }),
      compactionStatsFromEntries: vi.fn(() => ({
        compactionCount: 2,
        latestCompactionAt: "2026-06-12T06:00:00.000Z",
      })),
      countSerializedPayload,
      recordContextUsageSnapshot: (snapshot) => {
        recordedSnapshots.push(snapshot);
        return { ...snapshot, updatedAt: "2026-06-12T06:01:00.000Z" };
      },
      emitContextUsageUpdated: (snapshot) => {
        emitted.push(snapshot);
      },
      onProviderRequestPrepared,
      fileExists: () => true,
    })(pi.instance as any);

    await pi.beforeProviderRequest()({ payload });

    expect(countSerializedPayload).toHaveBeenCalledWith(payload, accounting.estimatedTokens);
    expect(onProviderRequestPrepared).toHaveBeenCalledWith({ inputTokens: 321 });
    expect(recordedSnapshots).toEqual([
      {
        threadId: "thread-1",
        modelId: "ambient-test",
        source: "estimate",
        tokens: 321,
        contextWindow: 1_000,
        percent: 32.1,
        latestCompactionAt: "2026-06-12T06:00:00.000Z",
        compactionCount: 2,
        diagnostics: {
          piSessionFile: "/tmp/session.json",
          piSessionFileExists: true,
          activeSession: true,
          message: "Local GLM tokenizer counted payload in 9ms.",
          providerPayload: {
            ...accounting,
            estimatedTokens: accounting.estimatedTokens,
          },
        },
      },
    ]);
    expect(emitted).toEqual([
      {
        ...recordedSnapshots[0],
        updatedAt: "2026-06-12T06:01:00.000Z",
      },
    ]);
  });

  it("records estimated payload usage without an active session", async () => {
    const pi = fakePi();
    const snapshots: any[] = [];

    createContextAccountingExtension({
      threadId: "thread-1",
      modelId: "old-model",
      contextWindow: 1_000,
      getRunningModel: () => ({ id: "ambient-test", contextWindow: 2_000 }),
      getActiveSession: () => undefined,
      compactionStatsFromEntries: vi.fn(() => ({ compactionCount: 99 })),
      countSerializedPayload: vi.fn(async () => ({
        source: "estimate" as const,
        tokens: 80,
        latencyMs: 1,
        error: "GLM tokenizer is disabled.",
      })),
      recordContextUsageSnapshot: (snapshot) => {
        snapshots.push(snapshot);
        return { ...snapshot, updatedAt: "2026-06-12T06:02:00.000Z" };
      },
      emitContextUsageUpdated: vi.fn(),
      fileExists: vi.fn(() => true),
    })(pi.instance as any);

    await pi.beforeProviderRequest()({ payload: { messages: [{ role: "user", content: "Hello" }] } });

    expect(snapshots).toEqual([
      expect.objectContaining({
        threadId: "thread-1",
        modelId: "ambient-test",
        source: "estimate",
        tokens: 80,
        contextWindow: 2_000,
        percent: 4,
        compactionCount: 0,
        diagnostics: expect.objectContaining({
          piSessionFileExists: false,
          activeSession: false,
          message: "GLM tokenizer is disabled.",
          providerPayload: expect.objectContaining({
            estimatedTokens: 80,
          }),
        }),
      }),
    ]);
  });
});

function fakePi() {
  let beforeProviderRequest: ProviderRequestHandler | undefined;
  return {
    instance: {
      on: (eventName: string, handler: ProviderRequestHandler) => {
        if (eventName === "before_provider_request") beforeProviderRequest = handler;
      },
    },
    beforeProviderRequest: () => {
      expect(beforeProviderRequest).toBeDefined();
      return beforeProviderRequest!;
    },
  };
}
