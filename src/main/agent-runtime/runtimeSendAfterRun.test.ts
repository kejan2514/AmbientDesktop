import { describe, expect, it, vi } from "vitest";

import type { SendMessageInput } from "../../shared/desktopTypes";
import type { ThreadGoal } from "../../shared/threadTypes";
import { finalizeRuntimeSendAfterRun, type RuntimeSendAfterRunInput } from "./runtimeSendAfterRun";

const activeGoal: ThreadGoal = {
  goalId: "goal-1",
  threadId: "thread-1",
  objective: "Simplify the runtime",
  status: "active",
  tokensUsed: 0,
  timeUsedSeconds: 0,
  continuationTurns: 0,
  noProgressTurns: 0,
  createdAt: "2026-06-15T00:00:00.000Z",
  updatedAt: "2026-06-15T00:00:00.000Z",
};

const followUp = (content: string): SendMessageInput => ({
  threadId: "thread-1",
  content,
  permissionMode: "full-access",
  collaborationMode: "agent",
  model: "ambient-preview",
  thinkingLevel: "medium",
  delivery: "prompt",
  context: [],
});

function baseInput(overrides: Partial<RuntimeSendAfterRunInput> = {}): RuntimeSendAfterRunInput {
  return {
    threadId: "thread-1",
    workspacePath: "/tmp/workspace",
    runGoalId: "goal-1",
    runGoalStartedAtMs: 1000,
    promptChars: 120,
    assistantChars: 240,
    thinkingChars: 80,
    toolMessageCount: 2,
    abortRequested: false,
    pendingEmptyResponseRetryDelayMs: 0,
    awaitInternalRetryCompletion: false,
    hasWorkflowPlanEditIntent: false,
    hasDedicatedReviewSession: false,
    isRunStoreActive: vi.fn(() => true),
    clearActiveRun: vi.fn(),
    clearActiveRunId: vi.fn(),
    clearPermissionWaitControl: vi.fn(),
    clearToolArgumentWatchdog: vi.fn(),
    clearToolExecutionWatchdog: vi.fn(),
    cleanupDedicatedReviewSession: vi.fn(),
    clearWorkflowPlanEditIntent: vi.fn(),
    takePendingProjectSwitch: vi.fn(() => undefined),
    updateRuntimeEvent: vi.fn(),
    scheduleProjectSwitchCompletion: vi.fn(),
    getRunRecord: vi.fn(() => ({ status: "done" as const })),
    hasQueuedUserInput: vi.fn(() => false),
    accountFinishedGoalRun: vi.fn(() => activeGoal),
    scheduleGoalContinuation: vi.fn(),
    schedulePlannerDurableRepairFollowUp: vi.fn(),
    send: vi.fn(async () => undefined),
    emitError: vi.fn(),
    emitRunEvent: vi.fn(),
    resolveActiveRunSettled: vi.fn(),
    setTimeout: vi.fn(),
    sleep: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("finalizeRuntimeSendAfterRun", () => {
  it("clears run ownership, emits queue clear, schedules follow-ups, and blocks goal continuation", async () => {
    const timers: Array<{ callback: () => void; delayMs: number }> = [];
    const input = baseInput({
      hasWorkflowPlanEditIntent: true,
      hasDedicatedReviewSession: true,
      pendingPlannerRepairFollowUp: followUp("planner repair"),
      pendingInterruptedToolCallRecoveryFollowUp: followUp("recovery"),
      pendingProviderInterruptionContinuation: followUp("provider continuation"),
      pendingEmptyResponseRetry: followUp("empty retry"),
      pendingEmptyResponseRetryDelayMs: 25,
      setTimeout: vi.fn((callback, delayMs) => {
        timers.push({ callback, delayMs });
        return timers.length;
      }),
    });

    const result = await finalizeRuntimeSendAfterRun(input);

    expect(input.clearActiveRun).toHaveBeenCalledTimes(1);
    expect(input.clearActiveRunId).toHaveBeenCalledTimes(1);
    expect(input.clearPermissionWaitControl).toHaveBeenCalledTimes(1);
    expect(input.clearToolArgumentWatchdog).toHaveBeenCalledTimes(1);
    expect(input.clearToolExecutionWatchdog).toHaveBeenCalledTimes(1);
    expect(input.cleanupDedicatedReviewSession).toHaveBeenCalledTimes(1);
    expect(input.clearWorkflowPlanEditIntent).toHaveBeenCalledTimes(1);
    expect(input.emitRunEvent).toHaveBeenCalledWith({
      type: "queue-updated",
      queue: { threadId: "thread-1", steering: [], followUp: [] },
    });
    expect(input.schedulePlannerDurableRepairFollowUp).toHaveBeenCalledWith(
      input.pendingPlannerRepairFollowUp,
      "/tmp/workspace",
    );
    expect(timers.map((timer) => timer.delayMs)).toEqual([0, 1_000, 25]);
    expect(input.accountFinishedGoalRun).toHaveBeenCalledTimes(1);
    expect(input.scheduleGoalContinuation).not.toHaveBeenCalled();
    expect(input.resolveActiveRunSettled).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      shouldEmitQueueClear: true,
      scheduledFollowUpCount: 4,
      hasPendingInternalFollowUp: true,
      projectSwitchPending: false,
      scheduledGoalContinuation: false,
    });
  });

  it("cancels pending project switches and suppresses follow-ups when queue clearing is suppressed", async () => {
    const pendingProjectSwitch = {
      runtimeEventId: "event-1",
      workspacePath: "/tmp/next",
      reason: "user requested switch",
    };
    const input = baseInput({
      isRunStoreActive: vi.fn(() => false),
      pendingPlannerRepairFollowUp: followUp("planner repair"),
      takePendingProjectSwitch: vi.fn(() => pendingProjectSwitch),
    });

    const result = await finalizeRuntimeSendAfterRun(input);

    expect(input.emitRunEvent).not.toHaveBeenCalled();
    expect(input.schedulePlannerDurableRepairFollowUp).not.toHaveBeenCalled();
    expect(input.updateRuntimeEvent).toHaveBeenCalledWith("event-1", expect.objectContaining({
      status: "canceled",
    }));
    expect(input.scheduleProjectSwitchCompletion).not.toHaveBeenCalled();
    expect(input.accountFinishedGoalRun).not.toHaveBeenCalled();
    expect(input.resolveActiveRunSettled).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      shouldEmitQueueClear: false,
      scheduledFollowUpCount: 0,
      hasPendingInternalFollowUp: true,
      projectSwitchPending: true,
      scheduledGoalContinuation: false,
    });
  });

  it("schedules goal continuation after a clean run with no internal follow-up or queued user input", async () => {
    const input = baseInput();

    const result = await finalizeRuntimeSendAfterRun(input);

    expect(input.accountFinishedGoalRun).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread-1",
      goalId: "goal-1",
      promptChars: 120,
      assistantChars: 240,
      thinkingChars: 80,
      toolMessageCount: 2,
      runStatus: "done",
    }));
    expect(input.scheduleGoalContinuation).toHaveBeenCalledWith("thread-1", "goal-1", 0);
    expect(result).toMatchObject({
      hasPendingInternalFollowUp: false,
      hasQueuedUserInput: false,
      scheduledGoalContinuation: true,
    });
  });

  it("marks goal accounting with scheduled provider interruption continuations", async () => {
    const input = baseInput({
      assistantChars: 0,
      thinkingChars: 0,
      toolMessageCount: 0,
      pendingProviderInterruptionContinuation: followUp("provider continuation"),
    });

    await finalizeRuntimeSendAfterRun(input);

    expect(input.accountFinishedGoalRun).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread-1",
      goalId: "goal-1",
      runStatus: "done",
      runErrorMessage: undefined,
      providerInterruptionContinuationScheduled: true,
      internalFollowUpScheduled: true,
    }));
    expect(input.scheduleGoalContinuation).not.toHaveBeenCalled();
  });

  it("restarts the active goal through the retry scheduled after context-overflow compaction", async () => {
    const timers: Array<() => void> = [];
    const overflowRetry = {
      ...followUp("Retry the compacted prompt"),
      internal: true as const,
      retryOfMessageId: "user-1",
      preserveActiveThread: true as const,
      assistantFinalizationRetry: {
        sourceUserMessageId: "user-1",
        attempt: 1,
        maxRetries: 1,
        reason: "provider_context_overflow" as const,
      },
    };
    const input = baseInput({
      assistantChars: 0,
      thinkingChars: 0,
      toolMessageCount: 0,
      pendingEmptyResponseRetry: overflowRetry,
      setTimeout: vi.fn((callback) => {
        timers.push(callback);
        return timers.length;
      }),
    });

    const result = await finalizeRuntimeSendAfterRun(input);

    expect(input.accountFinishedGoalRun).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread-1",
      goalId: "goal-1",
      runStatus: "done",
      internalFollowUpScheduled: true,
    }));
    expect(input.scheduleGoalContinuation).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      scheduledFollowUpCount: 1,
      hasPendingInternalFollowUp: true,
      scheduledGoalContinuation: false,
    });

    expect(timers).toHaveLength(1);
    timers[0]!();
    await Promise.resolve();
    expect(input.send).toHaveBeenCalledWith(overflowRetry);
  });
});
