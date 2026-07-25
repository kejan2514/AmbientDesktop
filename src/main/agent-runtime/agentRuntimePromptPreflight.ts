import type { DesktopEvent } from "../../shared/desktopTypes";
import type { AmbientCompactionSettings, RunStatus } from "../../shared/threadTypes";
import {
  contextUsagePreflightInput,
  type ContextUsageModelWindowReader,
} from "./agentRuntimeContextUsageSnapshot";
import {
  runtimeCompactionFinishedActivity,
  runtimeCompactionStartingActivity,
} from "./agentRuntimeCompactionActivity";
import { preflightPrompt } from "../../shared/contextAccounting";
import {
  AMBIENT_CONTEXT_SAFETY_MARGIN_TOKENS,
  ambientRequestedOutputTokens,
} from "./agentRuntimeAmbientFacade";

export const PROMPT_PREFLIGHT_COMPACTION_INSTRUCTIONS =
  "Prepare the session to accept the next user prompt. Preserve current task status, files, constraints, and blockers.";
export const PROMPT_PREFLIGHT_COMPACTED_MESSAGE = "Compacted before sending large prompt.";

export interface PromptPreflightSession extends ContextUsageModelWindowReader {
  compact(instructions?: string): Promise<unknown>;
}

export type PromptPreflightRunStatus = Exclude<RunStatus, "idle" | "error">;

export interface RunPromptPreflightBeforePromptInput<TSession extends PromptPreflightSession> {
  threadId: string;
  session: TSession;
  promptContent: string;
  compactionSettings: Pick<AmbientCompactionSettings, "reserveTokens" | "hardPreflightPercent">;
  unavailableContextWindow: number;
  setActiveRunStatus: (status: PromptPreflightRunStatus) => void;
  isRunStoreActive?: () => boolean;
  emitRunEvent: (event: DesktopEvent) => void;
  recordContextUsageSnapshot: (threadId: string, session: TSession, message?: string) => unknown;
}

export async function runPromptPreflightBeforePrompt<TSession extends PromptPreflightSession>(
  input: RunPromptPreflightBeforePromptInput<TSession>,
): Promise<void> {
  const isRunStoreActive = input.isRunStoreActive ?? (() => true);
  const usage = contextUsagePreflightInput(input.session, input.unavailableContextWindow);
  const requestOutputReserve = ambientRequestedOutputTokens(input.session.model?.maxTokens) + AMBIENT_CONTEXT_SAFETY_MARGIN_TOKENS;
  const result = preflightPrompt({
    prompt: input.promptContent,
    currentTokens: usage.currentTokens,
    contextWindow: usage.contextWindow,
    reserveTokens: Math.max(input.compactionSettings.reserveTokens, requestOutputReserve),
    hardPreflightPercent: input.compactionSettings.hardPreflightPercent,
  });
  if (result.promptTooLarge) {
    throw new Error(
      `${result.reason ?? "The prompt is too large for the current model context."} Remove attachments, split the request, or start with a smaller prompt.`,
    );
  }
  if (!result.shouldCompact) return;
  if (!isRunStoreActive()) return;

  input.setActiveRunStatus("compacting");
  input.emitRunEvent({
    type: "runtime-activity",
    activity: runtimeCompactionStartingActivity({
      threadId: input.threadId,
      reason: "threshold",
    }),
  });
  input.recordContextUsageSnapshot(input.threadId, input.session, result.reason);
  try {
    await input.session.compact(PROMPT_PREFLIGHT_COMPACTION_INSTRUCTIONS);
    if (!isRunStoreActive()) return;
    input.recordContextUsageSnapshot(input.threadId, input.session, PROMPT_PREFLIGHT_COMPACTED_MESSAGE);
    input.emitRunEvent({
      type: "runtime-activity",
      activity: runtimeCompactionFinishedActivity({
        threadId: input.threadId,
        reason: "threshold",
        aborted: false,
        willRetry: false,
        message: PROMPT_PREFLIGHT_COMPACTED_MESSAGE,
      }),
    });
    input.setActiveRunStatus("streaming");
  } catch (error) {
    if (!isRunStoreActive()) return;
    const message = error instanceof Error ? error.message : String(error);
    input.emitRunEvent({
      type: "runtime-activity",
      activity: runtimeCompactionFinishedActivity({
        threadId: input.threadId,
        reason: "threshold",
        aborted: false,
        willRetry: false,
        message,
      }),
    });
    throw error;
  }
}
