import { describe, expect, it, vi } from "vitest";

import type { SendMessageInput } from "../../shared/desktopTypes";
import { scheduleRuntimeSendFollowUps } from "./runtimeSendFollowUps";

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

describe("scheduleRuntimeSendFollowUps", () => {
  it("reports pending follow-ups without scheduling when queue clearing is suppressed", async () => {
    const result = await scheduleRuntimeSendFollowUps({
      shouldEmitQueueClear: false,
      threadId: "thread-1",
      workspacePath: "/tmp/workspace",
      plannerRepairFollowUp: followUp("planner repair"),
      emptyResponseRetryDelayMs: 0,
      awaitInternalRetryCompletion: false,
      schedulePlannerDurableRepairFollowUp: vi.fn(),
      send: vi.fn(),
      emitError: vi.fn(),
      setTimeout: vi.fn(),
      sleep: vi.fn(),
    });

    expect(result).toEqual({
      hasPendingInternalFollowUp: true,
      scheduledFollowUpCount: 0,
      awaitedEmptyResponseRetry: false,
    });
  });

  it("schedules planner repair, recovery, provider continuation, and delayed retry follow-ups", async () => {
    const timers: Array<{ callback: () => void; delayMs: number }> = [];
    const plannerRepairFollowUp = followUp("planner repair");
    const interruptedToolCallRecoveryFollowUp = followUp("interrupted recovery");
    const providerInterruptionContinuation = followUp("provider continuation");
    const emptyResponseRetry = followUp("empty retry");
    const schedulePlannerDurableRepairFollowUp = vi.fn();
    const send = vi.fn(async (input: SendMessageInput) => {
      if (input.content === "provider continuation") throw new Error("provider retry exploded");
    });
    const emitError = vi.fn();

    const result = await scheduleRuntimeSendFollowUps({
      shouldEmitQueueClear: true,
      threadId: "thread-1",
      workspacePath: "/tmp/workspace",
      plannerRepairFollowUp,
      interruptedToolCallRecoveryFollowUp,
      providerInterruptionContinuation,
      emptyResponseRetry,
      emptyResponseRetryDelayMs: 25,
      awaitInternalRetryCompletion: false,
      schedulePlannerDurableRepairFollowUp,
      send,
      emitError,
      setTimeout: (callback, delayMs) => {
        timers.push({ callback, delayMs });
        return timers.length;
      },
      sleep: vi.fn(),
    });

    expect(result).toEqual({
      hasPendingInternalFollowUp: true,
      scheduledFollowUpCount: 4,
      awaitedEmptyResponseRetry: false,
    });
    expect(schedulePlannerDurableRepairFollowUp).toHaveBeenCalledWith(plannerRepairFollowUp, "/tmp/workspace");
    expect(timers.map((timer) => timer.delayMs)).toEqual([0, 1_000, 25]);

    timers.forEach((timer) => timer.callback());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(send).toHaveBeenCalledWith(interruptedToolCallRecoveryFollowUp);
    expect(send).toHaveBeenCalledWith(providerInterruptionContinuation);
    expect(send).toHaveBeenCalledWith(emptyResponseRetry);
    expect(emitError).toHaveBeenCalledWith(
      "Provider interruption continuation failed: provider retry exploded",
      "thread-1",
      "/tmp/workspace",
    );
  });

  it("awaits empty-response retry completion when requested", async () => {
    const retry = followUp("empty retry");
    const send = vi.fn(async () => undefined);
    const sleep = vi.fn(async () => undefined);
    const setTimeout = vi.fn();

    const result = await scheduleRuntimeSendFollowUps({
      shouldEmitQueueClear: true,
      threadId: "thread-1",
      workspacePath: "/tmp/workspace",
      emptyResponseRetry: retry,
      emptyResponseRetryDelayMs: 50,
      awaitInternalRetryCompletion: true,
      schedulePlannerDurableRepairFollowUp: vi.fn(),
      send,
      emitError: vi.fn(),
      setTimeout,
      sleep,
    });

    expect(result).toEqual({
      hasPendingInternalFollowUp: true,
      scheduledFollowUpCount: 1,
      awaitedEmptyResponseRetry: true,
    });
    expect(sleep).toHaveBeenCalledWith(50);
    expect(send).toHaveBeenCalledWith(retry, { awaitInternalRetryCompletion: true });
    expect(setTimeout).not.toHaveBeenCalled();
  });
});
