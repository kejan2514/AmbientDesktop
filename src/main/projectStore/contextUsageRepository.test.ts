import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONTEXT_USAGE_EXACT_SNAPSHOT_RETENTION,
  CONTEXT_USAGE_TOTAL_SNAPSHOT_RETENTION,
  ProjectStoreContextUsageRepository,
} from "./contextUsageRepository";

describe("ProjectStoreContextUsageRepository", () => {
  let db: Database.Database;
  let repository: ProjectStoreContextUsageRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE context_usage_snapshots (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        model_id TEXT,
        source TEXT NOT NULL,
        tokens INTEGER,
        context_window INTEGER,
        percent REAL,
        latest_compaction_at TEXT,
        compaction_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        diagnostics_json TEXT
      );
    `);
    repository = new ProjectStoreContextUsageRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it("records and lists context usage snapshots with latest-first ordering", () => {
    repository.recordContextUsageSnapshot({
      threadId: "thread-1",
      source: "estimate",
      compactionCount: 0,
      updatedAt: "2026-06-16T00:00:00.000Z",
    });
    const latest = repository.recordContextUsageSnapshot({
      threadId: "thread-1",
      modelId: "example/model-id",
      source: "provider-plus-estimate",
      tokens: 42_000,
      contextWindow: 200_000,
      percent: 21,
      latestCompactionAt: "2026-06-16T00:00:01.000Z",
      compactionCount: 1,
      updatedAt: "2026-06-16T00:00:02.000Z",
      diagnostics: { activeSession: true },
    });

    expect(latest).toMatchObject({
      threadId: "thread-1",
      modelId: "example/model-id",
      source: "provider-plus-estimate",
      tokens: 42_000,
      contextWindow: 200_000,
      percent: 21,
      latestCompactionAt: "2026-06-16T00:00:01.000Z",
      compactionCount: 1,
      diagnostics: { activeSession: true },
    });
    expect(repository.getLatestContextUsageSnapshot("thread-1")).toMatchObject({ tokens: 42_000 });
    expect(repository.listContextUsageSnapshots().map((snapshot) => snapshot.updatedAt)).toEqual([
      "2026-06-16T00:00:02.000Z",
      "2026-06-16T00:00:00.000Z",
    ]);
  });

  it("bounds context snapshot listing limits", () => {
    repository.recordContextUsageSnapshot({
      threadId: "thread-1",
      source: "estimate",
      compactionCount: 0,
      updatedAt: "2026-06-16T00:00:00.000Z",
    });

    expect(repository.listContextUsageSnapshots(0)).toHaveLength(1);
    expect(repository.listContextUsageSnapshots(1_000)).toHaveLength(1);
  });

  it("retains exact latest snapshots and sampled older snapshots per thread", () => {
    for (let index = 0; index < 260; index += 1) {
      repository.recordContextUsageSnapshot({
        threadId: "thread-1",
        source: "estimate",
        tokens: index,
        compactionCount: 0,
        updatedAt: new Date(Date.UTC(2026, 5, 16, 0, 0, index)).toISOString(),
      });
    }
    for (let index = 0; index < 3; index += 1) {
      repository.recordContextUsageSnapshot({
        threadId: "thread-2",
        source: "estimate",
        tokens: index,
        compactionCount: 0,
        updatedAt: new Date(Date.UTC(2026, 5, 17, 0, 0, index)).toISOString(),
      });
    }

    const rows = db
      .prepare(`
        SELECT tokens
        FROM context_usage_snapshots
        WHERE thread_id = 'thread-1'
        ORDER BY updated_at DESC, rowid DESC
      `)
      .all() as Array<{ tokens: number }>;
    const retainedTokens = rows.map((row) => row.tokens);

    expect(rows.length).toBeLessThanOrEqual(CONTEXT_USAGE_TOTAL_SNAPSHOT_RETENTION);
    expect(retainedTokens.slice(0, CONTEXT_USAGE_EXACT_SNAPSHOT_RETENTION)).toEqual(
      Array.from({ length: CONTEXT_USAGE_EXACT_SNAPSHOT_RETENTION }, (_, index) => 259 - index),
    );
    expect(retainedTokens).toContain(235);
    expect(retainedTokens.filter((token) => token < 236)).toHaveLength(
      rows.length - CONTEXT_USAGE_EXACT_SNAPSHOT_RETENTION,
    );
    expect(retainedTokens.filter((token) => token < 236).length).toBeLessThan(236);
    expect(repository.getLatestContextUsageSnapshot("thread-1")).toMatchObject({ tokens: 259 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM context_usage_snapshots WHERE thread_id = 'thread-2'").get()).toMatchObject({
      count: 3,
    });
  });
});
