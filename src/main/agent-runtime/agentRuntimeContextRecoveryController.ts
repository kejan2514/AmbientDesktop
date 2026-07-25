import { join } from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";

import type { CompactThreadInput, DesktopEvent, RecoverThreadContextInput } from "../../shared/desktopTypes";
import { normalizeAmbientModelId, type AmbientModelRuntimeProfile } from "../../shared/ambientModels";
import type { ContextUsageSnapshot, ThreadSummary } from "../../shared/threadTypes";
import { ambientModel } from "./agentRuntimeAmbientFacade";
import {
  buildActiveContextUsageSnapshot,
  buildUnavailableContextUsageSnapshot,
  type ActiveContextUsageSnapshotSession,
  type ContextUsageAmbientCliSkillMountDiagnostic,
  type ContextUsageSessionManagerOpen,
} from "./agentRuntimeContextUsageSnapshot";
import { createManualCompactionEventHandler } from "./agentRuntimeManualCompactionEvents";
import { getAmbientProviderStatus, normalizeAmbientBaseUrl } from "./agentRuntimeProviderFacade";
import type { ProjectStore } from "./agentRuntimeProjectStoreFacade";
import { getRestorablePiSessionFile } from "./agentRuntimeSessionFacade";
import type { PiSessionFileCommitReason } from "./agentRuntimeSessionFacade";
import {
  hasVisibleTranscriptRecoveryMessage,
  isVisibleTranscriptRecoveryNormalCompactionRequiredError,
  visibleTranscriptRecoveryManualMessages,
  visibleTranscriptRecoveryReason,
  visibleTranscriptRecoveryRestorableSessionPlan,
  visibleTranscriptMessagesForModelContext,
} from "./recovery/compactionSummary";

export interface AgentRuntimeContextRecoverySession extends ActiveContextUsageSnapshotSession {
  sessionFile?: string;
  isCompacting?: boolean;
  subscribe(handler: (event: unknown) => void): () => void;
  compact(customInstructions?: string): Promise<unknown>;
  sendCustomMessage(message: unknown, options: { triggerTurn: false; deliverAs: "nextTurn" }): Promise<void>;
  dispose(): void;
}

export interface AgentRuntimeContextRecoveryCommitInput {
  threadId: string;
  sessionFile?: string;
  currentPiSessionFile?: string | null;
  reason: PiSessionFileCommitReason;
  emit: (event: DesktopEvent) => void;
}

export interface AgentRuntimeContextRecoveryControllerOptions {
  store: Pick<
    ProjectStore,
    | "addMessage"
    | "getLatestContextUsageSnapshot"
    | "getThread"
    | "getWorkspace"
    | "listMessages"
    | "recordContextUsageSnapshot"
    | "updateThreadSettings"
  >;
  hasActiveRun: (threadId: string) => boolean;
  getActiveSession: (threadId: string) => AgentRuntimeContextRecoverySession | undefined;
  deleteActiveSession: (threadId: string) => boolean;
  getSession: (thread: ThreadSummary) => Promise<AgentRuntimeContextRecoverySession>;
  commitThreadPiSessionFile: (input: AgentRuntimeContextRecoveryCommitInput) => Promise<ThreadSummary | undefined>;
  ambientCliSkillMountForThread: (threadId: string) => ContextUsageAmbientCliSkillMountDiagnostic | undefined;
  resolveModelRuntimeProfile?: (modelId?: string) => AmbientModelRuntimeProfile | undefined;
  emit: (event: DesktopEvent) => void;
  openSessionManager?: ContextUsageSessionManagerOpen;
  now?: () => Date;
}

const CONTEXT_USAGE_UNAVAILABLE_WINDOW = 200_000;

export class AgentRuntimeContextRecoveryController {
  private readonly openSessionManager: ContextUsageSessionManagerOpen;
  private readonly now: () => Date;

  constructor(private readonly options: AgentRuntimeContextRecoveryControllerOptions) {
    this.openSessionManager = options.openSessionManager ?? ((sessionFile, sessionDir, workspacePath) =>
      SessionManager.open(sessionFile, sessionDir, workspacePath));
    this.now = options.now ?? (() => new Date());
  }

  async getContextUsage(threadId: string): Promise<ContextUsageSnapshot> {
    const thread = this.options.store.getThread(threadId);
    const session = this.options.getActiveSession(threadId);
    if (
      session &&
      normalizeAmbientModelId(session.model?.id) === normalizeAmbientModelId(thread.model)
    ) {
      return this.recordContextUsageSnapshot(threadId, session);
    }

    if (session) {
      const snapshot = this.unavailableContextUsageSnapshot(
        thread,
        "The selected model will report context usage after the pending model change is applied.",
      );
      return this.options.store.recordContextUsageSnapshot(snapshot);
    }

    const latest = this.options.store.getLatestContextUsageSnapshot(threadId);
    if (
      latest &&
      latest.modelId !== undefined &&
      normalizeAmbientModelId(latest.modelId) === normalizeAmbientModelId(thread.model)
    ) {
      return latest;
    }

    const snapshot = this.unavailableContextUsageSnapshot(
      thread,
      latest
        ? "The selected model has not reported context usage yet."
        : "No active Pi session has reported context usage yet.",
    );
    return this.options.store.recordContextUsageSnapshot(snapshot);
  }

  async compactThread(input: CompactThreadInput): Promise<ContextUsageSnapshot> {
    const thread = this.options.store.getThread(input.threadId);
    if (this.options.hasActiveRun(input.threadId)) {
      throw new Error("Context compaction is available after the current run finishes.");
    }

    const session = await this.options.getSession(thread);
    if (session.isCompacting) {
      throw new Error("Context compaction is already running for this thread.");
    }

    this.options.emit({ type: "run-status", threadId: input.threadId, status: "compacting" });
    const compactionEvents = createManualCompactionEventHandler({
      threadId: input.threadId,
      session,
      recordContextUsageSnapshot: (threadId, compactionSession, message) =>
        this.recordContextUsageSnapshot(threadId, compactionSession, message),
      emit: (event) => this.options.emit(event),
    });
    const unsubscribe = session.subscribe((event: unknown) => compactionEvents.handle(event));

    try {
      await session.compact(input.customInstructions);
      if (compactionEvents.runtimeError) throw new Error(compactionEvents.runtimeError);
      const current = this.options.store.getThread(input.threadId);
      if (session.sessionFile && session.sessionFile !== current.piSessionFile) {
        await this.options.commitThreadPiSessionFile({
          threadId: input.threadId,
          sessionFile: session.sessionFile,
          currentPiSessionFile: current.piSessionFile,
          reason: "compaction-finished",
          emit: (event) => this.options.emit(event),
        });
      }
      return this.recordContextUsageSnapshot(input.threadId, session);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.emit({ type: "error", message, threadId: input.threadId, workspacePath: this.options.store.getWorkspace().path });
      throw error;
    } finally {
      unsubscribe();
      this.options.emit({ type: "run-status", threadId: input.threadId, status: "idle" });
    }
  }

  async recoverThreadContext(input: RecoverThreadContextInput): Promise<ContextUsageSnapshot> {
    const thread = this.options.store.getThread(input.threadId);
    if (this.options.hasActiveRun(input.threadId)) {
      throw new Error("Context recovery is available after the current run finishes.");
    }

    const appWorkspace = this.options.store.getWorkspace();
    const piSessionDir = join(appWorkspace.sessionPath, thread.id);
    const restorableSessionFile = getRestorablePiSessionFile(thread.piSessionFile, piSessionDir);
    if (restorableSessionFile) {
      try {
        this.openSessionManager(restorableSessionFile, piSessionDir, thread.workspacePath).getEntries();
        const restorableSessionPlan = visibleTranscriptRecoveryRestorableSessionPlan({
          hasRecoveryMessage: this.hasVisibleTranscriptRecoveryMessage(thread.id),
        });
        if (restorableSessionPlan.kind === "already-recovered") {
          const session = await this.options.getSession(thread);
          return this.recordContextUsageSnapshot(thread.id, session, restorableSessionPlan.snapshotMessage);
        }
        throw new Error(restorableSessionPlan.errorMessage);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isVisibleTranscriptRecoveryNormalCompactionRequiredError(message)) throw error;
      }
    }

    const visibleMessages = visibleTranscriptMessagesForModelContext(this.options.store.listMessages(thread.id));
    if (visibleMessages.length === 0) {
      this.options.store.updateThreadSettings(thread.id, { piSessionFile: null });
      throw new Error("There is no visible transcript to rebuild model context from.");
    }

    const existing = this.options.getActiveSession(thread.id);
    existing?.dispose();
    this.options.deleteActiveSession(thread.id);
    this.options.store.updateThreadSettings(thread.id, { piSessionFile: null });

    const reason = visibleTranscriptRecoveryReason({
      requestedReason: input.reason,
      threadSessionFile: thread.piSessionFile,
      restorableSessionFile,
    });
    const session = await this.options.getSession(this.options.store.getThread(thread.id));
    const recoveryMessages = visibleTranscriptRecoveryManualMessages({
      thread,
      visibleMessages,
      reason,
      recoveredAt: this.now().toISOString(),
      includeSystemMessage: !this.hasVisibleTranscriptRecoveryMessage(thread.id),
    });
    await session.sendCustomMessage(recoveryMessages.customMessage, { triggerTurn: false, deliverAs: "nextTurn" });

    if (recoveryMessages.systemMessage) {
      const recoveryMessage = this.options.store.addMessage(recoveryMessages.systemMessage);
      this.options.emit({ type: "message-created", message: recoveryMessage });
    }
    if (session.sessionFile) {
      await this.options.commitThreadPiSessionFile({
        threadId: thread.id,
        sessionFile: session.sessionFile,
        currentPiSessionFile: this.options.store.getThread(thread.id).piSessionFile,
        reason: "visible-transcript-recovery",
        emit: (event) => this.options.emit(event),
      });
    }
    return this.recordContextUsageSnapshot(thread.id, session, "Model context rebuilt from visible transcript. Recovery is lossy.");
  }

  recordContextUsageSnapshot(
    threadId: string,
    session: AgentRuntimeContextRecoverySession,
    message?: string,
  ): ContextUsageSnapshot {
    const snapshot = this.contextUsageSnapshot(threadId, session, message);
    const recorded = this.options.store.recordContextUsageSnapshot(snapshot);
    this.options.emit({ type: "context-usage-updated", snapshot: recorded });
    return recorded;
  }

  contextUsageSnapshot(
    threadId: string,
    session: AgentRuntimeContextRecoverySession,
    message?: string,
  ): ContextUsageSnapshot {
    const latestProviderPayload = this.options.store.getLatestContextUsageSnapshot(threadId)?.diagnostics?.providerPayload;
    return buildActiveContextUsageSnapshot({
      threadId,
      session,
      unavailableContextWindow: CONTEXT_USAGE_UNAVAILABLE_WINDOW,
      ambientCliSkillMount: this.options.ambientCliSkillMountForThread(threadId),
      providerPayload: latestProviderPayload,
      message,
    });
  }

  unavailableContextUsageSnapshot(thread: ThreadSummary, message: string): ContextUsageSnapshot {
    const appWorkspace = this.options.store.getWorkspace();
    return buildUnavailableContextUsageSnapshot({
      threadId: thread.id,
      modelId: thread.model,
      sessionFile: thread.piSessionFile,
      sessionDir: join(appWorkspace.sessionPath, thread.id),
      workspacePath: thread.workspacePath,
      contextWindow: ambientModel(
        thread.model,
        normalizeAmbientBaseUrl(getAmbientProviderStatus(thread.model).baseUrl),
        this.options.resolveModelRuntimeProfile?.(thread.model),
      ).contextWindow,
      message,
    });
  }

  private hasVisibleTranscriptRecoveryMessage(threadId: string): boolean {
    return hasVisibleTranscriptRecoveryMessage(this.options.store.listMessages(threadId));
  }
}
