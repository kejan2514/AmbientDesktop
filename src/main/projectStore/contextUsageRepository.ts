import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { ContextUsageSnapshot } from "../../shared/threadTypes";
import type { ContextUsageSnapshotInput } from "./projectStoreFacadeHelpers";
import { mapContextUsageSnapshotRow, type ContextUsageSnapshotRow } from "./contextUsageMappers";

export const CONTEXT_USAGE_EXACT_SNAPSHOT_RETENTION = 24;
export const CONTEXT_USAGE_SAMPLED_SNAPSHOT_RETENTION = 96;
export const CONTEXT_USAGE_SNAPSHOT_SAMPLE_STRIDE = 10;
export const CONTEXT_USAGE_TOTAL_SNAPSHOT_RETENTION =
  CONTEXT_USAGE_EXACT_SNAPSHOT_RETENTION + CONTEXT_USAGE_SAMPLED_SNAPSHOT_RETENTION;

export class ProjectStoreContextUsageRepository {
  constructor(private readonly db: Database.Database) {}

  recordContextUsageSnapshot(input: ContextUsageSnapshotInput): ContextUsageSnapshot {
    const now = input.updatedAt ?? new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO context_usage_snapshots
        (id, thread_id, model_id, source, tokens, context_window, percent, latest_compaction_at, compaction_count, updated_at, diagnostics_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.threadId,
        input.modelId ?? null,
        input.source,
        input.tokens ?? null,
        input.contextWindow ?? null,
        input.percent ?? null,
        input.latestCompactionAt ?? null,
        input.compactionCount,
        now,
        input.diagnostics ? JSON.stringify(input.diagnostics) : null,
      );
    this.pruneThreadSnapshots(input.threadId);
    return this.getContextUsageSnapshot(id);
  }

  getLatestContextUsageSnapshot(threadId: string): ContextUsageSnapshot | undefined {
    const row = this.db
      .prepare("SELECT * FROM context_usage_snapshots WHERE thread_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1")
      .get(threadId) as ContextUsageSnapshotRow | undefined;
    return row ? mapContextUsageSnapshotRow(row) : undefined;
  }

  listContextUsageSnapshots(limit = 100): ContextUsageSnapshot[] {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    const rows = this.db
      .prepare("SELECT * FROM context_usage_snapshots ORDER BY updated_at DESC, rowid DESC LIMIT ?")
      .all(boundedLimit) as ContextUsageSnapshotRow[];
    return rows.map(mapContextUsageSnapshotRow);
  }

  private getContextUsageSnapshot(id: string): ContextUsageSnapshot {
    const row = this.db.prepare("SELECT * FROM context_usage_snapshots WHERE id = ?").get(id) as
      | ContextUsageSnapshotRow
      | undefined;
    if (!row) throw new Error(`Context usage snapshot not found: ${id}`);
    return mapContextUsageSnapshotRow(row);
  }

  private pruneThreadSnapshots(threadId: string): void {
    const rows = this.db
      .prepare(`
        SELECT id
        FROM context_usage_snapshots
        WHERE thread_id = ?
        ORDER BY updated_at DESC, rowid DESC
      `)
      .all(threadId) as Array<{ id: string }>;
    if (rows.length <= CONTEXT_USAGE_TOTAL_SNAPSHOT_RETENTION) return;

    const retainedIds = new Set<string>();
    let sampledCount = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const id = rows[index]?.id;
      if (!id) continue;
      if (index < CONTEXT_USAGE_EXACT_SNAPSHOT_RETENTION) {
        retainedIds.add(id);
        continue;
      }
      const sampledIndex = index - CONTEXT_USAGE_EXACT_SNAPSHOT_RETENTION;
      if (
        sampledIndex % CONTEXT_USAGE_SNAPSHOT_SAMPLE_STRIDE === 0 &&
        sampledCount < CONTEXT_USAGE_SAMPLED_SNAPSHOT_RETENTION
      ) {
        retainedIds.add(id);
        sampledCount += 1;
      }
    }

    const deleteIds = rows.map((row) => row.id).filter((id) => !retainedIds.has(id));
    const deleteBatch = this.db.prepare("DELETE FROM context_usage_snapshots WHERE id = ?");
    const transaction = this.db.transaction((ids: string[]) => {
      for (const id of ids) deleteBatch.run(id);
    });
    for (let index = 0; index < deleteIds.length; index += 500) {
      transaction(deleteIds.slice(index, index + 500));
    }
  }
}
