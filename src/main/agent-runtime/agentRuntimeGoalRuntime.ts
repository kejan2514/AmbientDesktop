import type { RuntimeActivity, RuntimeContinuationSource, ThreadGoal, ThreadSummary } from "../../shared/threadTypes";

export const GOAL_MODE_TOOL_NAMES = ["get_goal", "create_goal", "update_goal"] as const;
export const GOAL_COMPLETION_MESSAGE_KIND = "goal-completion";
export const GOAL_NO_PROGRESS_TURN_LIMIT = 3;
export const GOAL_PROVIDER_INFRA_FAILURE_LIMIT = 2;
type RuntimeGoalActivity = Extract<RuntimeActivity, { kind: "goal" }>;

export interface GoalRuntimeActivityInput {
  threadId: string;
  status: RuntimeGoalActivity["status"];
  message: string;
  goalId?: string;
  continuationSource?: RuntimeContinuationSource;
}

function goalUsageCountLabel(value: number, singular: string): string {
  return `${value} ${value === 1 ? singular : `${singular}s`}`;
}

export function goalCompletionChatMessage(goal: Pick<ThreadGoal, "tokensUsed" | "timeUsedSeconds">): string {
  return [
    "Goal completed and cleared.",
    "",
    `Final usage estimate: ${goalUsageCountLabel(goal.tokensUsed, "token")}, ${goalUsageCountLabel(goal.timeUsedSeconds, "second")}.`,
  ].join("\n");
}

export function goalRuntimeActivity(input: GoalRuntimeActivityInput): RuntimeGoalActivity {
  const continuationSource = input.continuationSource ?? (
    input.status === "continuing" ? "goal-continuation" : undefined
  );
  return {
    threadId: input.threadId,
    kind: "goal",
    status: input.status,
    message: input.message,
    goalId: input.goalId,
    ...(continuationSource ? { continuationSource } : {}),
  };
}

export function goalContinuationPrompt(
  thread: Pick<ThreadSummary, "id">,
  goal: Pick<
    ThreadGoal,
    | "goalId"
    | "objective"
    | "tokensUsed"
    | "tokenBudget"
    | "continuationTurns"
    | "noProgressTurns"
    | "providerInfraFailures"
  >,
): string {
  return [
    "Continue working toward the active Ambient Desktop thread goal.",
    "",
    "This is an internal continuation turn. Do not wait for another user prompt if meaningful progress can be made with available state and tools.",
    "Before deciding the goal is complete, verify the current state against every explicit requirement in the objective. Use update_goal({ status: \"complete\" }) only when the objective is actually satisfied.",
    "Use update_goal({ status: \"blocked\" }) only when the same blocking condition has repeated and no meaningful progress is possible without user input or an external state change.",
    "If the goal is paused, budget-limited, or Planner mode becomes active, stop work.",
    "",
    `Thread: ${thread.id}`,
    `Goal id: ${goal.goalId}`,
    `Objective: ${goal.objective}`,
    `Estimated tokens used: ${goal.tokensUsed}${goal.tokenBudget !== undefined ? ` / ${goal.tokenBudget}` : ""}`,
    `Continuation turn: ${goal.continuationTurns}`,
    `No-progress turns: ${goal.noProgressTurns}`,
    `Provider infrastructure failures: ${goal.providerInfraFailures ?? 0}`,
  ].join("\n");
}
