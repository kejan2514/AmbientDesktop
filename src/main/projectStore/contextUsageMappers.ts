import type { ContextUsageSnapshot } from "../../shared/threadTypes";

export interface ContextUsageSnapshotRow {
  id: string;
  thread_id: string;
  model_id: string | null;
  source: ContextUsageSnapshot["source"];
  tokens: number | null;
  context_window: number | null;
  percent: number | null;
  latest_compaction_at: string | null;
  compaction_count: number;
  updated_at: string;
  diagnostics_json: string | null;
}

export function mapContextUsageSnapshotRow(row: ContextUsageSnapshotRow): ContextUsageSnapshot {
  return {
    threadId: row.thread_id,
    modelId: row.model_id ?? undefined,
    source: row.source,
    tokens: row.tokens ?? undefined,
    contextWindow: row.context_window ?? undefined,
    percent: row.percent ?? undefined,
    latestCompactionAt: row.latest_compaction_at ?? undefined,
    compactionCount: row.compaction_count,
    updatedAt: row.updated_at,
    diagnostics: row.diagnostics_json
      ? parseJsonObject<ContextUsageSnapshot["diagnostics"]>(row.diagnostics_json, undefined)
      : undefined,
  };
}

function parseJsonObject<T>(json: string, fallback: T): T {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}
