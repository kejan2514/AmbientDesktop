import type { DesktopEvent } from "../../shared/desktopTypes";
import type { AmbientFeatureFlagSnapshot } from "../../shared/featureFlags";
import type { AgentMemoryRuntimeSnapshot } from "../../shared/agentMemoryDiagnostics";
import { normalizeAmbientModelId } from "../../shared/ambientModels";
import type { ContextUsageSnapshot, ModelRuntimeSettings, ThreadSummary } from "../../shared/threadTypes";
import { runtimeSettingsActivity } from "./agentRuntimeRetrySettings";
import type { AgentRuntimePiSession } from "./agentRuntimeSessionFactoryController";
import { AgentRuntimeSessionRegistry } from "./agentRuntimeSessionRegistry";

export interface AgentRuntimeSettingsSessionControllerOptions {
  sessions: AgentRuntimeSessionRegistry<AgentRuntimePiSession>;
  activeRuns: { has(threadId: string): boolean };
  ambientCliSkillMountDiagnostics: { delete(threadId: string): unknown };
  tencentMemoryRuntimeSnapshots: Map<string, AgentMemoryRuntimeSnapshot>;
  getThread: (threadId: string) => ThreadSummary;
  switchSessionToThreadModel: (thread: ThreadSummary, session: AgentRuntimePiSession) => Promise<void>;
  recordUnavailableContextUsageSnapshot: (thread: ThreadSummary, message: string) => ContextUsageSnapshot;
  emit: (event: DesktopEvent) => void;
}

export class AgentRuntimeSettingsSessionController {
  constructor(private readonly options: AgentRuntimeSettingsSessionControllerOptions) {}

  applyRuntimeSettings(settings: ModelRuntimeSettings): {
    disposedSessions: number;
    deferredSessions: number;
    disposedThreadIds: string[];
    deferredThreadIds: string[];
  } {
    return this.options.sessions.resetForRuntimeSettings(this.options.activeRuns, {
      onDeferred: (threadId) => {
        this.options.emit({
          type: "runtime-activity",
          activity: runtimeSettingsActivity(threadId, settings.aggressiveRetries, "deferred"),
        });
      },
      onDisposed: (threadId) => {
        this.clearThreadRuntimeCaches(threadId);
        this.options.emit({
          type: "runtime-activity",
          activity: runtimeSettingsActivity(threadId, settings.aggressiveRetries, "applied"),
        });
      },
    });
  }

  applyFeatureFlags(_snapshot: AmbientFeatureFlagSnapshot): {
    disposedSessions: number;
    deferredSessions: number;
    disposedThreadIds: string[];
    deferredThreadIds: string[];
  } {
    void _snapshot;
    return this.resetSessionsAndClearCaches();
  }

  applyMemorySettings(): {
    disposedSessions: number;
    deferredSessions: number;
    disposedThreadIds: string[];
    deferredThreadIds: string[];
  } {
    return this.resetSessionsAndClearCaches();
  }

  applyModelRuntimeProfiles(): {
    disposedSessions: number;
    deferredSessions: number;
    disposedThreadIds: string[];
    deferredThreadIds: string[];
  } {
    return this.resetSessionsAndClearCaches();
  }

  async applyThreadModelSettings(threadId: string): Promise<{
    switchedSessions: number;
    deferredSessions: number;
    switchedThreadIds: string[];
    deferredThreadIds: string[];
  }> {
    const thread = this.options.getThread(threadId);
    const session = this.options.sessions.get(threadId);
    const result = {
      switchedSessions: 0,
      deferredSessions: 0,
      switchedThreadIds: [] as string[],
      deferredThreadIds: [] as string[],
    };
    if (!session) {
      this.options.sessions.clearRuntimeSettingsStale(threadId);
      this.recordPendingModelContext(thread, "The selected model will report context usage after its first response.");
      return result;
    }

    if (normalizeAmbientModelId(session.model?.id) === normalizeAmbientModelId(thread.model)) {
      session.setThinkingLevel(thread.thinkingLevel);
      this.options.sessions.clearRuntimeSettingsStale(threadId);
      return result;
    }

    if (this.options.activeRuns.has(threadId)) {
      this.options.sessions.markRuntimeSettingsStale(threadId);
      this.recordPendingModelContext(
        thread,
        "The selected model will report context usage after the current run finishes and the model change is applied.",
      );
      result.deferredSessions = 1;
      result.deferredThreadIds.push(threadId);
      return result;
    }

    await this.options.switchSessionToThreadModel(thread, session);
    result.switchedSessions = 1;
    result.switchedThreadIds.push(threadId);
    return result;
  }

  private recordPendingModelContext(thread: ThreadSummary, message: string): void {
    const snapshot = this.options.recordUnavailableContextUsageSnapshot(thread, message);
    this.options.emit({ type: "context-usage-updated", snapshot });
  }

  applyThreadMemorySettings(threadId: string): {
    disposedSessions: number;
    deferredSessions: number;
    disposedThreadIds: string[];
    deferredThreadIds: string[];
  } {
    return this.options.sessions.resetForRuntimeSettings(this.options.activeRuns, {
      onDisposed: () => {
        this.clearThreadRuntimeCaches(threadId);
      },
    }, [threadId]);
  }

  listAgentMemoryRuntimeSnapshots(): AgentMemoryRuntimeSnapshot[] {
    return [...this.options.tencentMemoryRuntimeSnapshots.values()];
  }

  private resetSessionsAndClearCaches(): {
    disposedSessions: number;
    deferredSessions: number;
    disposedThreadIds: string[];
    deferredThreadIds: string[];
  } {
    return this.options.sessions.resetForRuntimeSettings(this.options.activeRuns, {
      onDisposed: (threadId) => {
        this.clearThreadRuntimeCaches(threadId);
      },
    });
  }

  private clearThreadRuntimeCaches(threadId: string): void {
    this.options.ambientCliSkillMountDiagnostics.delete(threadId);
    this.options.tencentMemoryRuntimeSnapshots.delete(threadId);
  }
}
