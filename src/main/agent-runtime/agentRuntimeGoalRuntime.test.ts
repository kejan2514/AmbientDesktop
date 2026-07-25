import { describe, expect, it } from "vitest";
import {
  goalContinuationPrompt,
  goalCompletionChatMessage,
  goalRuntimeActivity,
  GOAL_COMPLETION_MESSAGE_KIND,
  GOAL_MODE_TOOL_NAMES,
  GOAL_NO_PROGRESS_TURN_LIMIT,
  GOAL_PROVIDER_INFRA_FAILURE_LIMIT,
} from "./agentRuntimeGoalRuntime";

describe("agentRuntimeGoalRuntime", () => {
  it("exports the goal mode runtime constants used by AgentRuntime", () => {
    expect(GOAL_MODE_TOOL_NAMES).toEqual(["get_goal", "create_goal", "update_goal"]);
    expect(GOAL_COMPLETION_MESSAGE_KIND).toBe("goal-completion");
    expect(GOAL_NO_PROGRESS_TURN_LIMIT).toBe(3);
    expect(GOAL_PROVIDER_INFRA_FAILURE_LIMIT).toBe(2);
  });

  it("formats the goal completion chat message with pluralized usage", () => {
    expect(goalCompletionChatMessage({ tokensUsed: 2, timeUsedSeconds: 1 })).toBe([
      "Goal completed and cleared.",
      "",
      "Final usage estimate: 2 tokens, 1 second.",
    ].join("\n"));
  });

  it("builds goal runtime activity payloads", () => {
    expect(goalRuntimeActivity({
      threadId: "thread-1",
      status: "continuing",
      message: "Continuing goal...",
      goalId: "goal-1",
    })).toEqual({
      threadId: "thread-1",
      kind: "goal",
      status: "continuing",
      message: "Continuing goal...",
      goalId: "goal-1",
      continuationSource: "goal-continuation",
    });
    expect(goalRuntimeActivity({
      threadId: "thread-2",
      status: "paused",
      message: "Goal paused because the active run was stopped.",
    })).toEqual({
      threadId: "thread-2",
      kind: "goal",
      status: "paused",
      message: "Goal paused because the active run was stopped.",
      goalId: undefined,
    });
  });

  it("formats the internal goal continuation prompt with current usage", () => {
    expect(goalContinuationPrompt({ id: "thread-1" }, {
      goalId: "goal-1",
      objective: "Finish the simplification plan phase by phase.",
      tokenBudget: 2000,
      tokensUsed: 1400,
      continuationTurns: 3,
      noProgressTurns: 1,
    })).toBe([
      "Continue working toward the active Ambient Desktop thread goal.",
      "",
      "This is an internal continuation turn. Do not wait for another user prompt if meaningful progress can be made with available state and tools.",
      "Before deciding the goal is complete, verify the current state against every explicit requirement in the objective. Use update_goal({ status: \"complete\" }) only when the objective is actually satisfied.",
      "Use update_goal({ status: \"blocked\" }) only when the same blocking condition has repeated and no meaningful progress is possible without user input or an external state change.",
      "If the goal is paused, budget-limited, or Planner mode becomes active, stop work.",
      "",
      "Thread: thread-1",
      "Goal id: goal-1",
      "Objective: Finish the simplification plan phase by phase.",
      "Estimated tokens used: 1400 / 2000",
      "Continuation turn: 3",
      "No-progress turns: 1",
      "Provider infrastructure failures: 0",
    ].join("\n"));
  });

  it("omits the token budget when none is set", () => {
    expect(goalContinuationPrompt({ id: "thread-1" }, {
      goalId: "goal-1",
      objective: "Keep working.",
      tokensUsed: 12,
      continuationTurns: 1,
      noProgressTurns: 0,
    })).toContain("Estimated tokens used: 12\n");
  });
});
