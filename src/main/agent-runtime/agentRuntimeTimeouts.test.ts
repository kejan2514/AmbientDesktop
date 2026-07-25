import { afterEach, describe, expect, it, vi } from "vitest";
import {
  piStreamStallTimeoutMessage,
  piStreamStartTimeoutMessage,
  resolveAdaptivePiPreStreamTimeoutMs,
  resolveChatPiEmptyAssistantStallTimeoutMs,
  resolvePostToolContinuationIdleMs,
  resolvePostToolFinalizationTickMs,
  resolveWorkflowRecordingReviewStreamIdleTimeoutMs,
  withTimeout,
} from "./agentRuntimeTimeouts";

describe("agentRuntimeTimeouts", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps workflow recording review stream timeout defaults and minimums", () => {
    expect(resolveWorkflowRecordingReviewStreamIdleTimeoutMs({})).toBe(120_000);
    expect(resolveWorkflowRecordingReviewStreamIdleTimeoutMs({
      AMBIENT_WORKFLOW_RECORDING_REVIEW_STREAM_IDLE_TIMEOUT_MS: "4000",
    })).toBe(5_000);
    expect(resolveWorkflowRecordingReviewStreamIdleTimeoutMs({
      AMBIENT_WORKFLOW_RECORDING_REVIEW_STREAM_IDLE_TIMEOUT_MS: "6000.8",
    })).toBe(6_000);
    expect(resolveWorkflowRecordingReviewStreamIdleTimeoutMs({
      AMBIENT_WORKFLOW_RECORDING_REVIEW_STREAM_IDLE_TIMEOUT_MS: "not-a-number",
    })).toBe(120_000);
  });

  it("uses chat empty-assistant overrides only in E2E mode", () => {
    expect(resolveChatPiEmptyAssistantStallTimeoutMs({
      AMBIENT_CHAT_PI_EMPTY_ASSISTANT_STALL_TIMEOUT_MS: "2500",
    })).toBe(120_000);
    expect(resolveChatPiEmptyAssistantStallTimeoutMs({
      AMBIENT_E2E: "1",
      AMBIENT_CHAT_PI_EMPTY_ASSISTANT_STALL_TIMEOUT_MS: "500",
    })).toBe(1_000);
    expect(resolveChatPiEmptyAssistantStallTimeoutMs({
      AMBIENT_E2E: "1",
      AMBIENT_CHAT_PI_EMPTY_ASSISTANT_STALL_TIMEOUT_MS: "2500.8",
    })).toBe(2_500);
  });

  it("uses post-tool continuation and finalization tick overrides only in E2E mode", () => {
    expect(resolvePostToolContinuationIdleMs({
      AMBIENT_POST_TOOL_CONTINUATION_IDLE_MS: "50",
    })).toBe(15_000);
    expect(resolvePostToolContinuationIdleMs({
      AMBIENT_E2E: "1",
      AMBIENT_POST_TOOL_CONTINUATION_IDLE_MS: "25",
    })).toBe(50);
    expect(resolvePostToolFinalizationTickMs({
      AMBIENT_POST_TOOL_FINALIZATION_TICK_MS: "25",
    })).toBe(1_000);
    expect(resolvePostToolFinalizationTickMs({
      AMBIENT_E2E: "1",
      AMBIENT_POST_TOOL_FINALIZATION_TICK_MS: "10",
    })).toBe(25);
  });

  it("formats Pi stream timeout messages", () => {
    expect(piStreamStartTimeoutMessage(1500)).toBe("Ambient/Pi did not start streaming within 1500ms.");
    expect(piStreamStallTimeoutMessage(30000)).toBe("Ambient/Pi stream stalled after 30000ms without stream activity.");
  });

  it("adapts pre-stream timeouts to exact input size and reasoning level", () => {
    expect(resolveAdaptivePiPreStreamTimeoutMs({
      configuredTimeoutMs: 45_000,
      inputTokens: 10_000,
    })).toBe(45_000);
    expect(resolveAdaptivePiPreStreamTimeoutMs({
      configuredTimeoutMs: 45_000,
      inputTokens: 69_377,
    })).toBe(80_000);
    expect(resolveAdaptivePiPreStreamTimeoutMs({
      configuredTimeoutMs: 45_000,
      inputTokens: 69_377,
      thinkingLevel: "xhigh",
    })).toBe(100_000);
    expect(resolveAdaptivePiPreStreamTimeoutMs({
      configuredTimeoutMs: 240_000,
      inputTokens: 500_000,
      thinkingLevel: "xhigh",
    })).toBe(240_000);
  });

  it("resolves with undefined when a promise exceeds the timeout", async () => {
    vi.useFakeTimers();
    const result = withTimeout(new Promise<string>(() => undefined), 10);

    await vi.advanceTimersByTimeAsync(10);

    await expect(result).resolves.toBeUndefined();
  });
});
