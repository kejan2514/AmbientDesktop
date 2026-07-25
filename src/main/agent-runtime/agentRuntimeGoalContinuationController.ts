import type { DesktopEvent, SendMessageInput } from "../../shared/desktopTypes";
import type { RuntimeContinuationSource, ThreadGoal } from "../../shared/threadTypes";
import {
  goalCompletionChatMessage,
  goalContinuationPrompt,
  goalRuntimeActivity,
  GOAL_COMPLETION_MESSAGE_KIND,
  GOAL_NO_PROGRESS_TURN_LIMIT,
  GOAL_PROVIDER_INFRA_FAILURE_LIMIT,
} from "./agentRuntimeGoalRuntime";
import type { ProjectStore } from "./agentRuntimeProjectStoreFacade";
import type { AccountFinishedGoalRunInput } from "./runtimeGoalContinuationAfterRun";

export type GoalContinuationSendInput = SendMessageInput & {
  internal?: true;
  modelContentOverride?: string;
  visibleUserContent?: string;
  hiddenUserMessage?: true;
  continuationSource?: RuntimeContinuationSource;
  goalContinuation?: { goalId: string };
};

export interface AgentRuntimeGoalContinuationControllerOptions {
  store: Pick<
    ProjectStore,
    | "accountThreadGoalUsage"
    | "addMessage"
    | "clearThreadGoal"
    | "getThread"
    | "getThreadGoal"
    | "markThreadGoalStatus"
  >;
  hasActiveRun: (threadId: string) => boolean;
  send: (input: GoalContinuationSendInput) => Promise<void>;
  emit: (event: DesktopEvent) => void;
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  now?: () => number;
}

export class AgentRuntimeGoalContinuationController {
  private readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  private readonly now: () => number;

  constructor(private readonly options: AgentRuntimeGoalContinuationControllerOptions) {
    this.setTimeout = options.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.now = options.now ?? (() => Date.now());
  }

  accountFinishedGoalRun(input: AccountFinishedGoalRunInput): ThreadGoal | undefined {
    const seconds = Math.max(0, Math.ceil((this.now() - input.startedAtMs) / 1000));
    const tokenEstimate = Math.max(1, Math.ceil((input.promptChars + input.assistantChars + input.thinkingChars) / 4));
    const providerInfrastructureFailure =
      input.providerInterruptionContinuationScheduled === true || isProviderInfrastructureFailure(input);
    const failedTerminalRun = input.runStatus === "error" || input.runStatus === "interrupted" || input.runStatus === "aborted";
    const providerInfrastructureTerminalFailure = failedTerminalRun && providerInfrastructureFailure;
    const observedAgentProgress =
      input.toolMessageCount > 0 || input.assistantChars >= 40 || input.thinkingChars >= 40;
    const noProgress = !providerInfrastructureFailure && !input.internalFollowUpScheduled && !observedAgentProgress;
    const accounted = this.options.store.accountThreadGoalUsage({
      threadId: input.threadId,
      goalId: input.goalId,
      tokensUsedDelta: tokenEstimate,
      timeUsedSecondsDelta: seconds,
      noProgressTurnDelta: noProgress ? 1 : 0,
      providerInfraFailureDelta: providerInfrastructureFailure ? 1 : 0,
      ...(providerInfrastructureTerminalFailure
        ? { statusReason: providerInfrastructureGoalStatusReason(input.runErrorMessage) }
        : {}),
    });
    if (!accounted) return undefined;
    let goal = accounted;
    if (input.abortRequested && goal.status === "active") {
      goal = this.options.store.markThreadGoalStatus(input.threadId, "paused", {
        expectedGoalId: input.goalId,
        statusReason: "Paused because the user stopped the active run.",
      });
      this.options.emit({
        type: "runtime-activity",
        activity: goalRuntimeActivity({
          threadId: input.threadId,
          status: "paused",
          message: "Goal paused because the active run was stopped.",
          goalId: goal.goalId,
        }),
      });
    }
    if (!input.abortRequested && providerInfrastructureTerminalFailure && goal.status === "active" && providerInfrastructureLimitReached(goal)) {
      const statusReason = providerInfrastructureLimitStatusReason(goal);
      goal = this.options.store.markThreadGoalStatus(input.threadId, "provider_unavailable", {
        expectedGoalId: input.goalId,
        statusReason,
      });
      this.options.emit({
        type: "runtime-activity",
        activity: goalRuntimeActivity({
          threadId: input.threadId,
          status: "skipped",
          message: statusReason,
          goalId: goal.goalId,
        }),
      });
      this.options.emit({ type: "thread-goal-updated", goal });
      return goal;
    }
    if (!input.abortRequested && failedTerminalRun && providerInfrastructureFailure && goal.status === "active") {
      const statusReason = providerInfrastructureGoalStatusReason(input.runErrorMessage);
      this.options.emit({
        type: "runtime-activity",
        activity: goalRuntimeActivity({
          threadId: input.threadId,
          status: "skipped",
          message: statusReason,
          goalId: goal.goalId,
        }),
      });
      this.options.emit({ type: "thread-goal-updated", goal });
      return goal;
    }
    if (!input.abortRequested && failedTerminalRun && goal.status === "active") {
      const detail = input.runErrorMessage?.trim().slice(0, 240);
      const statusReason =
        input.runStatus === "interrupted"
          ? "Paused because the active run was interrupted."
          : detail
            ? `Paused because the goal run failed: ${detail}`
            : "Paused because the goal run failed.";
      goal = this.options.store.markThreadGoalStatus(input.threadId, "paused", {
        expectedGoalId: input.goalId,
        statusReason,
      });
      this.options.emit({
        type: "runtime-activity",
        activity: goalRuntimeActivity({
          threadId: input.threadId,
          status: "paused",
          message: statusReason,
          goalId: goal.goalId,
        }),
      });
    }
    this.options.emit({ type: "thread-goal-updated", goal });
    if (goal.status === "complete") return this.finalizeCompletedThreadGoal(goal);
    return goal;
  }

  finalizeCompletedThreadGoal(goal: ThreadGoal): ThreadGoal {
    const current = this.options.store.getThreadGoal(goal.threadId);
    if (!current || current.goalId !== goal.goalId) return goal;
    if (current.status !== "complete") return current;
    const message = this.options.store.addMessage({
      threadId: current.threadId,
      role: "assistant",
      content: goalCompletionChatMessage(current),
      metadata: {
        runtime: "ambient-goal-mode",
        kind: GOAL_COMPLETION_MESSAGE_KIND,
        status: "done",
        goalId: current.goalId,
        objective: current.objective,
        tokensUsed: current.tokensUsed,
        timeUsedSeconds: current.timeUsedSeconds,
        completedAt: current.completedAt,
      },
    });
    this.options.emit({ type: "message-created", message });
    const cleared = this.options.store.clearThreadGoal(current.threadId, current.goalId);
    this.options.emit({ type: "thread-goal-cleared", threadId: current.threadId, goalId: cleared?.goalId ?? current.goalId });
    return current;
  }

  scheduleGoalContinuation(threadId: string, expectedGoalId: string, delayMs = 0): void {
    this.setTimeout(() => {
      void this.maybeContinueGoalIfIdle(threadId, expectedGoalId).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.options.emit({ type: "error", message: `Goal continuation failed: ${message}`, threadId });
      });
    }, delayMs);
  }

  continueGoalIfIdle(threadId: string, expectedGoalId: string, delayMs = 0): void {
    this.scheduleGoalContinuation(threadId, expectedGoalId, delayMs);
  }

  async maybeContinueGoalIfIdle(threadId: string, expectedGoalId: string): Promise<void> {
    if (this.options.hasActiveRun(threadId)) return;
    const thread = this.options.store.getThread(threadId);
    if (thread.collaborationMode === "planner") return;
    const goal = this.options.store.getThreadGoal(threadId);
    if (!goal || goal.goalId !== expectedGoalId || goal.status !== "active") return;
    if (goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) {
      const stopped = this.options.store.markThreadGoalStatus(threadId, "budget_limited", {
        expectedGoalId,
        statusReason: "Goal token budget reached.",
      });
      this.options.emit({ type: "thread-goal-updated", goal: stopped });
      return;
    }
    if (providerInfrastructureLimitReached(goal)) {
      const statusReason = providerInfrastructureLimitStatusReason(goal);
      const stopped = this.options.store.markThreadGoalStatus(threadId, "provider_unavailable", {
        expectedGoalId,
        statusReason,
      });
      this.options.emit({ type: "thread-goal-updated", goal: stopped });
      this.options.emit({
        type: "runtime-activity",
        activity: goalRuntimeActivity({
          threadId,
          status: "skipped",
          message: statusReason,
          goalId: stopped.goalId,
        }),
      });
      return;
    }
    if (goal.noProgressTurns >= GOAL_NO_PROGRESS_TURN_LIMIT) {
      const paused = this.options.store.markThreadGoalStatus(threadId, "paused", {
        expectedGoalId,
        statusReason: `Paused after ${GOAL_NO_PROGRESS_TURN_LIMIT} no-progress turns.`,
      });
      this.options.emit({ type: "thread-goal-updated", goal: paused });
      return;
    }
    const updated = this.options.store.accountThreadGoalUsage({
      threadId,
      goalId: expectedGoalId,
      continuationTurnDelta: 1,
      statusReason: null,
    });
    if (!updated || updated.status !== "active") return;
    this.options.emit({ type: "thread-goal-updated", goal: updated });
    const prompt = goalContinuationPrompt(thread, updated);
    this.options.emit({
      type: "runtime-activity",
      activity: goalRuntimeActivity({
        threadId,
        status: "continuing",
        message: "Continuing goal...",
        goalId: updated.goalId,
      }),
    });
    await this.options.send({
      threadId,
      content: prompt,
      visibleUserContent: "Continuing goal...",
      modelContentOverride: prompt,
      hiddenUserMessage: true,
      continuationSource: "goal-continuation",
      goalContinuation: { goalId: updated.goalId },
      permissionMode: thread.permissionMode,
      collaborationMode: "agent",
      model: thread.model,
      thinkingLevel: thread.thinkingLevel,
      delivery: "follow-up",
      preserveActiveThread: true,
      internal: true,
    });
  }
}

function isProviderInfrastructureFailure(input: AccountFinishedGoalRunInput): boolean {
  if (input.abortRequested) return false;
  const text = input.runErrorMessage ?? "";
  return /\b(?:Ambient\/Pi\s+(?:stream|provider)|provider\s+(?:stream|interrupted|failed)|stream_idle_timeout|pre_stream_timeout|stream stalled|did not start streaming|stream interrupted|Request was aborted)\b/i.test(text);
}

function providerInfrastructureGoalStatusReason(message: string | undefined): string {
  const detail = message?.trim().slice(0, 240);
  return detail
    ? `Provider recovery stopped without pausing the goal: ${detail}`
    : "Provider recovery stopped without pausing the goal.";
}

function providerInfrastructureLimitReached(goal: Pick<ThreadGoal, "providerInfraFailures">): boolean {
  return (goal.providerInfraFailures ?? 0) >= GOAL_PROVIDER_INFRA_FAILURE_LIMIT;
}

function providerInfrastructureLimitStatusReason(goal: Pick<ThreadGoal, "providerInfraFailures" | "statusReason">): string {
  const failureCount = Math.max(0, Math.floor(goal.providerInfraFailures ?? 0));
  const countLabel = `${failureCount} provider infrastructure ${failureCount === 1 ? "failure" : "failures"}`;
  const lastStatus = goal.statusReason?.trim();
  return lastStatus
    ? `Provider availability retry limit reached after ${countLabel}. Last recovery status: ${lastStatus}`
    : `Provider availability retry limit reached after ${countLabel}.`;
}
