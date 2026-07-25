import { describe, expect, it } from "vitest";
import {
  INCOMPLETE_TOOL_ARGUMENT_CONTINUATION_MAX_RETRIES,
  providerInterruptionContinuationRetryDelayMs,
  providerInterruptionContinuationRetryBudget,
} from "./providerInterruptionContinuation";

describe("providerInterruptionContinuationRetryBudget", () => {
  it("uses the configured retry budget when arguments completed or execution started", () => {
    expect(providerInterruptionContinuationRetryBudget({
      configuredMaxRetries: 10,
      tools: [{ executionStarted: false, argumentComplete: true }],
    })).toEqual({
      maxRetries: 10,
      boundedByIncompleteToolArguments: false,
    });

    expect(providerInterruptionContinuationRetryBudget({
      configuredMaxRetries: 10,
      tools: [{ executionStarted: true, argumentComplete: false }],
    })).toEqual({
      maxRetries: 10,
      boundedByIncompleteToolArguments: false,
    });
  });

  it("bounds retries when the provider repeatedly stalls before tool arguments complete", () => {
    expect(providerInterruptionContinuationRetryBudget({
      configuredMaxRetries: 10,
      tools: [{ executionStarted: false, argumentComplete: false, inputChars: 4096 }],
    })).toEqual({
      maxRetries: INCOMPLETE_TOOL_ARGUMENT_CONTINUATION_MAX_RETRIES,
      boundedByIncompleteToolArguments: true,
      reason: "incomplete_tool_argument_stream",
    });
  });

  it("keeps the configured retry budget for short incomplete arguments that never executed", () => {
    expect(providerInterruptionContinuationRetryBudget({
      configuredMaxRetries: 10,
      tools: [{ executionStarted: false, argumentComplete: false, inputChars: 77 }],
    })).toEqual({
      maxRetries: 10,
      boundedByIncompleteToolArguments: false,
    });
  });

  it("does not raise a lower configured retry budget", () => {
    expect(providerInterruptionContinuationRetryBudget({
      configuredMaxRetries: 1,
      tools: [{ executionStarted: false, argumentComplete: false, inputChars: 4096 }],
    })).toEqual({
      maxRetries: 1,
      boundedByIncompleteToolArguments: true,
      reason: "incomplete_tool_argument_stream",
    });
  });
});

describe("providerInterruptionContinuationRetryDelayMs", () => {
  it("uses deterministic bounded jitter over an increasing backoff", () => {
    const delays = [1, 2, 3, 4, 5, 6].map((attempt) =>
      providerInterruptionContinuationRetryDelayMs(attempt, "state-1"),
    );
    expect(delays[0]).toBeGreaterThanOrEqual(850);
    expect(delays[0]).toBeLessThanOrEqual(1_150);
    expect(delays[1]).toBeGreaterThan(delays[0]);
    expect(delays.every((delay) => delay >= 250 && delay <= 5_000)).toBe(true);
    expect(providerInterruptionContinuationRetryDelayMs(3, "state-1")).toBe(delays[2]);
  });
});
