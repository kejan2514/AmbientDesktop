import type { DesktopEvent } from "../../shared/desktopTypes";
import type {
  AmbientCompactionSettings,
  ContextUsageSnapshot,
  RunStatus,
  ThreadSummary,
} from "../../shared/threadTypes";
import {
  runtimeCompactionFinishedActivity,
  runtimeCompactionStartingActivity,
} from "./agentRuntimeCompactionActivity";
import {
  isProviderContextPreflightBlockError,
  runProviderCallContextPreflightBeforePrompt,
  type ProviderCallContextPreflightSession,
  type RunProviderCallContextPreflightBeforePromptInput,
} from "./agentRuntimeProviderContextPreflight";
import {
  runPromptPreflightBeforePrompt,
  type PromptPreflightSession,
  type RunPromptPreflightBeforePromptInput,
} from "./agentRuntimePromptPreflight";

export type AgentRuntimePromptPreflightSession = PromptPreflightSession & ProviderCallContextPreflightSession;
export type AgentRuntimePromptPreflightRunStatus = Exclude<RunStatus, "idle" | "error">;

export const PROVIDER_CONTEXT_PREFLIGHT_COMPACTION_INSTRUCTIONS =
  "Compact the session because the provider context safety preflight blocked the next request. Preserve the current task, user intent, pending decisions, relevant files, constraints, and blockers while removing transcript bulk that can be rediscovered with tools.";
export const PROVIDER_CONTEXT_PREFLIGHT_COMPACTED_MESSAGE =
  "Compacted after provider context preflight block; retrying request.";

export interface RunAgentRuntimePromptPreflightBeforePromptInput<TSession extends AgentRuntimePromptPreflightSession> {
  thread: ThreadSummary;
  session: TSession;
  promptContent: string;
  compactionSettings: Pick<AmbientCompactionSettings, "reserveTokens" | "hardPreflightPercent">;
  unavailableContextWindow: number;
  setActiveRunStatus: (status: AgentRuntimePromptPreflightRunStatus) => void;
  isRunStoreActive?: () => boolean;
  emitRunEvent: (event: DesktopEvent) => void;
  recordContextUsageSnapshot: (threadId: string, session: TSession, message?: string) => ContextUsageSnapshot;
}

export interface AgentRuntimePromptPreflightBeforePromptDependencies<
  TSession extends AgentRuntimePromptPreflightSession,
> {
  runPromptPreflightBeforePrompt?: (input: RunPromptPreflightBeforePromptInput<TSession>) => Promise<void>;
  runProviderCallContextPreflightBeforePrompt?: (
    input: RunProviderCallContextPreflightBeforePromptInput & { session: TSession },
  ) => Promise<void>;
}

export async function runAgentRuntimePromptPreflightBeforePrompt<TSession extends AgentRuntimePromptPreflightSession>(
  input: RunAgentRuntimePromptPreflightBeforePromptInput<TSession>,
  dependencies: AgentRuntimePromptPreflightBeforePromptDependencies<TSession> = {},
): Promise<void> {
  const isRunStoreActive = input.isRunStoreActive ?? (() => true);
  const runPromptPreflight = dependencies.runPromptPreflightBeforePrompt ?? runPromptPreflightBeforePrompt;
  const runProviderPreflight =
    dependencies.runProviderCallContextPreflightBeforePrompt ?? runProviderCallContextPreflightBeforePrompt;

  await runPromptPreflight({
    threadId: input.thread.id,
    session: input.session,
    promptContent: input.promptContent,
    compactionSettings: input.compactionSettings,
    unavailableContextWindow: input.unavailableContextWindow,
    setActiveRunStatus: input.setActiveRunStatus,
    isRunStoreActive,
    emitRunEvent: input.emitRunEvent,
    recordContextUsageSnapshot: input.recordContextUsageSnapshot,
  });
  if (!isRunStoreActive()) return;

  const providerPreflightInput = {
    threadId: input.thread.id,
    workspacePath: input.thread.workspacePath,
    session: input.session,
    promptContent: input.promptContent,
    contextWindow: input.session.model?.contextWindow ?? input.unavailableContextWindow,
    requestedOutputTokens: input.session.model?.maxTokens,
    reserveTokens: input.compactionSettings.reserveTokens,
    hardPreflightPercent: input.compactionSettings.hardPreflightPercent,
  };

  try {
    await runProviderPreflight(providerPreflightInput);
  } catch (error) {
    if (!isProviderContextPreflightBlockError(error)) throw error;
    if (!isRunStoreActive()) return;

    input.setActiveRunStatus("compacting");
    input.emitRunEvent({
      type: "runtime-activity",
      activity: runtimeCompactionStartingActivity({
        threadId: input.thread.id,
        reason: "overflow",
      }),
    });
    input.recordContextUsageSnapshot(input.thread.id, input.session, error instanceof Error ? error.message : String(error));
    try {
      await input.session.compact(PROVIDER_CONTEXT_PREFLIGHT_COMPACTION_INSTRUCTIONS);
      if (!isRunStoreActive()) return;
      input.recordContextUsageSnapshot(input.thread.id, input.session, PROVIDER_CONTEXT_PREFLIGHT_COMPACTED_MESSAGE);
      await runProviderPreflight(providerPreflightInput);
      if (!isRunStoreActive()) return;
      input.emitRunEvent({
        type: "runtime-activity",
        activity: runtimeCompactionFinishedActivity({
          threadId: input.thread.id,
          reason: "overflow",
          aborted: false,
          willRetry: true,
          message: PROVIDER_CONTEXT_PREFLIGHT_COMPACTED_MESSAGE,
        }),
      });
      input.setActiveRunStatus("streaming");
    } catch (compactionOrRetryError) {
      if (!isRunStoreActive()) return;
      const message = compactionOrRetryError instanceof Error ? compactionOrRetryError.message : String(compactionOrRetryError);
      input.emitRunEvent({
        type: "runtime-activity",
        activity: runtimeCompactionFinishedActivity({
          threadId: input.thread.id,
          reason: "overflow",
          aborted: false,
          willRetry: false,
          message,
        }),
      });
      throw compactionOrRetryError;
    }
  }
}
