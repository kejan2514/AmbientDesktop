import { describe, expect, it } from "vitest";
import { mapContextUsageSnapshotRow, type ContextUsageSnapshotRow } from "./projectStoreContextMappers";

describe("project store context mappers", () => {
  it("maps context usage snapshot rows without store state", () => {
    const row: ContextUsageSnapshotRow = {
      id: "snapshot-1",
      thread_id: "thread-1",
      model_id: "example/model-id",
      source: "provider",
      tokens: 1200,
      context_window: 200000,
      percent: 0.6,
      latest_compaction_at: "2026-06-06T19:01:00.000Z",
      compaction_count: 2,
      updated_at: "2026-06-06T19:02:00.000Z",
      diagnostics_json: JSON.stringify({
        activeSession: true,
        piSessionFile: "/tmp/session.jsonl",
        providerPayload: {
          requestType: "normal",
          model: "ambient-test",
          messageCount: 4,
        },
      }),
    };

    expect(mapContextUsageSnapshotRow(row)).toEqual({
      threadId: "thread-1",
      modelId: "example/model-id",
      source: "provider",
      tokens: 1200,
      contextWindow: 200000,
      percent: 0.6,
      latestCompactionAt: "2026-06-06T19:01:00.000Z",
      compactionCount: 2,
      updatedAt: "2026-06-06T19:02:00.000Z",
      diagnostics: {
        activeSession: true,
        piSessionFile: "/tmp/session.jsonl",
        providerPayload: {
          requestType: "normal",
          model: "ambient-test",
          messageCount: 4,
        },
      },
    });
  });

  it("keeps nullable context usage snapshot fields undefined", () => {
    expect(mapContextUsageSnapshotRow(baseContextUsageSnapshotRow())).toEqual({
      threadId: "thread-1",
      modelId: undefined,
      source: "estimate",
      tokens: undefined,
      contextWindow: undefined,
      percent: undefined,
      latestCompactionAt: undefined,
      compactionCount: 0,
      updatedAt: "2026-06-06T19:02:00.000Z",
      diagnostics: undefined,
    });
  });

  it("keeps invalid context usage diagnostics undefined", () => {
    expect(mapContextUsageSnapshotRow({ ...baseContextUsageSnapshotRow(), diagnostics_json: "not json" }).diagnostics).toBeUndefined();
    expect(mapContextUsageSnapshotRow({ ...baseContextUsageSnapshotRow(), diagnostics_json: "[]" }).diagnostics).toBeUndefined();
    expect(mapContextUsageSnapshotRow({ ...baseContextUsageSnapshotRow(), diagnostics_json: null }).diagnostics).toBeUndefined();
  });
});

function baseContextUsageSnapshotRow(): ContextUsageSnapshotRow {
  return {
    id: "snapshot-1",
    thread_id: "thread-1",
    model_id: null,
    source: "estimate",
    tokens: null,
    context_window: null,
    percent: null,
    latest_compaction_at: null,
    compaction_count: 0,
    updated_at: "2026-06-06T19:02:00.000Z",
    diagnostics_json: null,
  };
}
