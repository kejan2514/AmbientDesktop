import { existsSync } from "node:fs";
import {
  SessionManager,
  type ContextUsage,
  type SessionEntry,
} from "@mariozechner/pi-coding-agent";

import type { ContextUsageSnapshot } from "../../shared/threadTypes";
import { getRestorablePiSessionFile } from "./agentRuntimeSessionFacade";

export interface ContextUsageReader {
  getContextUsage(): ContextUsage | undefined;
}

export interface ContextUsageCompactionStats {
  compactionCount: number;
  latestCompactionAt?: string;
}

type ContextUsageDiagnostics = NonNullable<ContextUsageSnapshot["diagnostics"]>;

export type ContextUsageAmbientCliSkillMountDiagnostic = NonNullable<ContextUsageDiagnostics["ambientCliSkillMount"]>;

export interface ActiveContextUsageSnapshotSession extends ContextUsageReader {
  sessionFile?: string;
  model?: {
    id?: string;
    contextWindow?: number;
  };
  sessionManager: {
    getEntries(): unknown[];
  };
}

export interface ContextUsageModelWindowReader extends ContextUsageReader {
  model?: {
    contextWindow?: number;
    maxTokens?: number;
  };
}

export interface ContextUsagePreflightInput {
  currentTokens?: number;
  contextWindow: number;
}

export interface BuildActiveContextUsageSnapshotInput {
  threadId: string;
  session: ActiveContextUsageSnapshotSession;
  unavailableContextWindow: number;
  ambientCliSkillMount?: ContextUsageAmbientCliSkillMountDiagnostic;
  providerPayload?: ContextUsageDiagnostics["providerPayload"];
  message?: string;
  now?: () => Date;
  fileExists?: (path: string) => boolean;
}

export type ContextUsageRestorableSessionFileResolver = (
  sessionFile: string | undefined,
  sessionDir: string,
) => string | undefined;

export interface BuildUnavailableContextUsageSnapshotInput {
  threadId: string;
  modelId: string;
  sessionFile?: string;
  sessionDir: string;
  workspacePath: string;
  contextWindow: number;
  message: string;
  now?: () => Date;
  fileExists?: (path: string) => boolean;
  getRestorableSessionFile?: ContextUsageRestorableSessionFileResolver;
  openSessionManager?: ContextUsageSessionManagerOpen;
}

export interface SessionEntriesReader {
  getEntries(): SessionEntry[];
}

export type ContextUsageSessionManagerOpen = (
  sessionFile: string,
  sessionDir: string,
  workspacePath: string,
) => SessionEntriesReader;

const defaultOpenSessionManager: ContextUsageSessionManagerOpen = (sessionFile, sessionDir, workspacePath) =>
  SessionManager.open(sessionFile, sessionDir, workspacePath);

export function safeContextUsage(session: ContextUsageReader): ContextUsage | undefined {
  try {
    return session.getContextUsage();
  } catch {
    return undefined;
  }
}

export function contextUsageSource(usage: ContextUsage | undefined): ContextUsageSnapshot["source"] {
  if (!usage) return "unavailable";
  if (usage.tokens === null || usage.percent === null) return "unknown-after-compaction";
  return "provider-plus-estimate";
}

export function contextUsageCompactionStatsFromEntries(entries: unknown[]): ContextUsageCompactionStats {
  const compactions = entries.filter(isCompactionEntry);
  const latest = compactions.at(-1);
  return {
    compactionCount: compactions.length,
    latestCompactionAt: typeof latest?.timestamp === "string" ? latest.timestamp : undefined,
  };
}

export function contextUsagePreflightInput(
  session: ContextUsageModelWindowReader,
  unavailableContextWindow: number,
): ContextUsagePreflightInput {
  const usage = safeContextUsage(session);
  return {
    currentTokens: usage?.tokens ?? undefined,
    contextWindow: usage?.contextWindow ?? session.model?.contextWindow ?? unavailableContextWindow,
  };
}

export function buildActiveContextUsageSnapshot(input: BuildActiveContextUsageSnapshotInput): ContextUsageSnapshot {
  const usage = safeContextUsage(input.session);
  const sessionFile = input.session.sessionFile;
  const compaction = contextUsageCompactionStatsFromEntries(input.session.sessionManager.getEntries());
  const fileExists = input.fileExists ?? existsSync;
  const now = input.now ?? (() => new Date());
  return {
    threadId: input.threadId,
    modelId: input.session.model?.id,
    source: contextUsageSource(usage),
    tokens: usage?.tokens ?? undefined,
    contextWindow: usage?.contextWindow ?? input.session.model?.contextWindow ?? input.unavailableContextWindow,
    percent: usage?.percent ?? undefined,
    latestCompactionAt: compaction.latestCompactionAt,
    compactionCount: compaction.compactionCount,
    updatedAt: now().toISOString(),
    diagnostics: {
      piSessionFile: sessionFile,
      piSessionFileExists: sessionFile ? fileExists(sessionFile) : false,
      activeSession: true,
      ...(input.ambientCliSkillMount ? { ambientCliSkillMount: input.ambientCliSkillMount } : {}),
      ...(input.providerPayload ? { providerPayload: input.providerPayload } : {}),
      ...(input.message ? { message: input.message } : {}),
    },
  };
}

export function buildUnavailableContextUsageSnapshot(input: BuildUnavailableContextUsageSnapshotInput): ContextUsageSnapshot {
  const fileExists = input.fileExists ?? existsSync;
  const now = input.now ?? (() => new Date());
  const getRestorableSessionFile = input.getRestorableSessionFile ?? getRestorablePiSessionFile;
  const restorableSessionFile = getRestorableSessionFile(input.sessionFile, input.sessionDir);
  const compaction = readSessionCompactionStats(
    restorableSessionFile,
    input.sessionDir,
    input.workspacePath,
    input.openSessionManager,
  );
  return {
    threadId: input.threadId,
    modelId: input.modelId,
    source: "unavailable",
    contextWindow: input.contextWindow,
    compactionCount: compaction.compactionCount,
    latestCompactionAt: compaction.latestCompactionAt,
    updatedAt: now().toISOString(),
    diagnostics: {
      piSessionFile: input.sessionFile,
      piSessionFileExists: input.sessionFile ? fileExists(input.sessionFile) : false,
      activeSession: false,
      message: input.message,
    },
  };
}

export function readSessionCompactionStats(
  sessionFile: string | undefined,
  sessionDir: string,
  workspacePath: string,
  openSessionManager: ContextUsageSessionManagerOpen = defaultOpenSessionManager,
): ContextUsageCompactionStats {
  if (!sessionFile) return { compactionCount: 0 };
  try {
    return contextUsageCompactionStatsFromEntries(openSessionManager(sessionFile, sessionDir, workspacePath).getEntries());
  } catch {
    return { compactionCount: 0 };
  }
}

function isCompactionEntry(entry: unknown): entry is { type: "compaction"; timestamp?: unknown } {
  return typeof entry === "object" && entry !== null && "type" in entry && entry.type === "compaction";
}
