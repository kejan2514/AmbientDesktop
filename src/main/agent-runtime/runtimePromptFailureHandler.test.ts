import { describe, expect, it, vi } from "vitest";
import type { DesktopEvent, SendMessageInput } from "../../shared/desktopTypes";
import type { ChatMessage, ProviderContinuationState } from "../../shared/threadTypes";
import type { ChatStreamInterruptionDiagnostic } from "../agent-runtime/agentRuntimeSendStreamDiagnostics";
import { handleRuntimePromptFailure, type RuntimePromptFailureHandlerInput } from "./runtimePromptFailureHandler";
import { SYMPHONY_PARENT_MODE_MISSING_WORKFLOW_TASK_ERROR } from "./agentRuntimeSymphonyParentMode";
import { AmbientStreamFailureError } from "./agentRuntimeAmbientFacade";
import type { RuntimeAssistantMessageController } from "./runtimeAssistantMessageController";
import type { RuntimeToolMessageController } from "./runtimeToolMessageController";
import {
  CALLABLE_WORKFLOW_PARENT_BLOCKING_REASON,
  CALLABLE_WORKFLOW_PARENT_BLOCKING_SCHEMA_VERSION,
  type CallableWorkflowParentBlockingBlock,
} from "./agentRuntimeCallableWorkflowFacade";
import type { SubagentFinalizationBarrierBlock } from "./agentRuntimeFinalizationBlocking";

function message(input: Partial<ChatMessage> & { id: string; content?: string }): ChatMessage {
  return {
    ...input,
    id: input.id,
    threadId: input.threadId ?? "thread-1",
    role: input.role ?? "assistant",
    content: input.content ?? "",
    createdAt: input.createdAt ?? "2026-06-15T00:00:00.000Z",
    metadata: input.metadata,
  };
}

function streamDiagnostic(
  text: string,
  input: Partial<ChatStreamInterruptionDiagnostic> = {},
): ChatStreamInterruptionDiagnostic {
  return {
    kind: input.kind ?? "pre_stream_timeout",
    message: text,
    retryScheduled: input.retryScheduled ?? false,
    replaySafe: input.replaySafe ?? false,
    runStartedAt: "2026-06-15T00:00:00.000Z",
    semanticOutputSeen: false,
    toolCallSeen: false,
    assistantOutputChars: 0,
    thinkingOutputChars: 0,
    toolMessageCount: 0,
    currentAssistantFinalTextChars: 0,
    streamEventCount: 0,
    ...input,
  };
}

function callableWorkflowBlock(): CallableWorkflowParentBlockingBlock {
  return {
    schemaVersion: CALLABLE_WORKFLOW_PARENT_BLOCKING_SCHEMA_VERSION,
    reason: CALLABLE_WORKFLOW_PARENT_BLOCKING_REASON,
    message: "Workflow task is still running.",
    instruction: "Wait for workflow completion.",
    synthesisAllowed: false,
    parentFinalizationBlocked: true,
    taskIds: ["task-1"],
    launchIds: ["launch-1"],
    workflowArtifactIds: [],
    workflowRunIds: [],
    waitingTaskIds: ["task-1"],
    attentionTaskIds: [],
    tasks: [{
      id: "task-1",
      launchId: "launch-1",
      parentThreadId: "thread-1",
      parentRunId: "run-1",
      toolCallId: "tool-1",
      toolId: "tool-1",
      toolName: "ambient_workflow_symphony_imitate_and_verify",
      sourceKind: "symphony_recipe",
      title: "Imitate and Verify",
      status: "running",
      statusLabel: "Running",
      statusGroup: "waiting_on_workflow",
      blocking: true,
      runnerTarget: "workflow",
      runnerDeferredReason: "running",
      createdAt: "2026-06-15T00:00:00.000Z",
      updatedAt: "2026-06-15T00:00:00.000Z",
    }],
  };
}

function subagentBlock(): SubagentFinalizationBarrierBlock {
  return {
    message: "A required child is still running.",
    barrierIds: ["barrier-1"],
    childRunIds: ["child-run-1"],
    childBlockers: [{
      childRunId: "child-run-1",
      childThreadId: "child-thread-1",
      canonicalTaskPath: "root/1:reviewer",
      roleId: "reviewer",
      status: "running",
      dependencyMode: "required_all",
      barrierIds: ["barrier-1"],
      lastActivityAt: "2026-06-15T00:00:00.000Z",
      lastActivitySource: "run_event:assistant_delta",
    }],
    barriers: [{
      id: "barrier-1",
      dependencyMode: "required_all",
      status: "waiting_on_children",
      failurePolicy: "fail_parent",
      childRunIds: ["child-run-1"],
      childBlockers: [{
        childRunId: "child-run-1",
        childThreadId: "child-thread-1",
        canonicalTaskPath: "root/1:reviewer",
        roleId: "reviewer",
        status: "running",
        dependencyMode: "required_all",
        barrierIds: ["barrier-1"],
        lastActivityAt: "2026-06-15T00:00:00.000Z",
        lastActivitySource: "run_event:assistant_delta",
      }],
    }],
  };
}

function setup(overrides: Partial<RuntimePromptFailureHandlerInput> = {}) {
  const events: DesktopEvent[] = [];
  const retryFollowUp = {
    threadId: "thread-1",
    content: "retry",
    permissionMode: "workspace",
    collaborationMode: "agent",
  } as SendMessageInput;
  const continuationState = { stateId: "state-1" } as ProviderContinuationState;
  let pendingEmptyResponseRetry: SendMessageInput | undefined;
  let pendingInterruptedToolCallRecoveryFollowUp: SendMessageInput | undefined;
  let pendingProviderInterruptionContinuation: SendMessageInput | undefined;
  let providerRetryAttemptCount = 0;
  let providerRetryLastError: string | undefined;
  const replacedAssistantMessages: ChatMessage[] = [];
  const finishedRuns: Array<{ status: string; errorMessage?: string }> = [];
  const runtimeMessages = {
    currentAssistantMessageId: vi.fn(() => "assistant-1"),
    assistantStartCount: vi.fn(() => 0),
    currentMessageContent: vi.fn((_, fallback) => fallback),
    currentAssistantContent: vi.fn((fallback) => fallback),
    startAssistantMessage: vi.fn(),
    ensureAssistantMessage: vi.fn(() => "assistant-1"),
    appendAssistantDelta: vi.fn(),
    replaceCurrentAssistant: vi.fn((content: string, metadata?: Record<string, unknown>) => {
      const updated = message({ id: "assistant-1", content, metadata });
      replacedAssistantMessages.push(updated);
      return updated;
    }),
    finishCurrentAssistantMessage: vi.fn(),
    suppressAssistantMessagesExceptCurrent: vi.fn(),
    currentPromptCacheTelemetry: vi.fn(() => ({ status: "unknown" as const })),
    applyPromptCacheTelemetry: vi.fn(() => []),
    completePromptCacheTelemetryIfPending: vi.fn(() => []),
    ensureThinkingMessage: vi.fn(() => "thinking-1"),
    appendThinkingDelta: vi.fn(),
    replaceCurrentThinking: vi.fn(),
    finishCurrentThinkingMessage: vi.fn(),
    suppressCurrentThinkingMessage: vi.fn(),
  } satisfies RuntimeAssistantMessageController;
  const toolMessages = {
    size: vi.fn(() => 0),
    toolCallIds: vi.fn(() => [][Symbol.iterator]()),
    inputs: vi.fn(() => new Map()),
    recoveryInputs: vi.fn(() => new Map()),
    labels: vi.fn(() => new Map()),
    messageId: vi.fn(),
    inputContent: vi.fn(),
    recoveryInput: vi.fn(),
    recoveryInputSource: vi.fn(),
    longformInputPreview: vi.fn(),
    editInputPreview: vi.fn(),
    metadataFor: vi.fn(() => ({})),
    rememberRecoveryInput: vi.fn(),
    rememberLongformInputPreview: vi.fn(),
    rememberEditInputPreview: vi.fn(),
    upsertInputMessage: vi.fn(),
    emitRunningToolEvent: vi.fn(),
    applyResultUpdate: vi.fn(),
    markOpenToolMessagesFailed: vi.fn(() => 0),
    cleanupToolCall: vi.fn(),
  } as unknown as RuntimeToolMessageController;
  const input: RuntimePromptFailureHandlerInput = {
    error: new Error("provider exploded"),
    threadId: "thread-1",
    workspacePath: "/workspace",
    usesDedicatedReviewSession: false,
    assistantFinalizationRetryMaxRetries: 3,
    interruptedToolCallRecoveryAttemptsUsed: 0,
    interruptedToolCallRecoveryMaxRetries: 2,
    canScheduleInterruptedToolCallRecovery: false,
    pendingEmptyResponseRetryDelayMs: 0,
    retrySourceUserMessageId: undefined,
    runtimeMessages,
    toolMessages,
    toolArgumentProgress: {
      current: vi.fn(),
    },
    interruptedToolCallRecovery: {
      recoverable: vi.fn(() => []),
    },
    startedToolCallIds: new Set(),
    abortRequested: vi.fn(() => false),
    streamWatchdogTimedOut: vi.fn(() => false),
    currentPiStreamFailureKind: vi.fn(() => "pre_stream_timeout" as const),
    currentAssistantFinalText: vi.fn(() => ""),
    currentThinkingFinalText: vi.fn(() => "thinking"),
    receivedAnyText: vi.fn(() => false),
    subagentParentControlAbortIntent: vi.fn(() => undefined),
    isRunStoreActive: vi.fn(() => true),
    consumeSubagentParentControlAbort: vi.fn(async () => undefined),
    persistPiStreamTrace: vi.fn(),
    canScheduleAssistantFinalizationRetryFor: vi.fn(() => false),
    assistantFinalizationRetryAttemptsUsedFor: vi.fn(() => 0),
    assistantFinalizationRetryNextAttemptFor: vi.fn(() => 1),
    sessionRecoveryForCurrentSession: vi.fn((kind, reason, providerContinuationStateId) => ({
      kind,
      reason,
      ...(providerContinuationStateId ? { providerContinuationStateId } : {}),
    })),
    createAssistantFinalizationRetryInput: vi.fn(() => retryFollowUp),
    createInterruptedToolCallRecoveryInput: vi.fn(() => retryFollowUp),
    collectOpenProviderInterruptionToolSnapshots: vi.fn(() => []),
    createProviderContinuationState: vi.fn(() => continuationState),
    persistProviderContinuationState: vi.fn((state) => state),
    persistCurrentSessionPointerForRetry: vi.fn(async () => undefined),
    createProviderInterruptionContinuationInput: vi.fn(() => retryFollowUp),
    setPendingEmptyResponseRetry: vi.fn((value) => {
      pendingEmptyResponseRetry = value;
    }),
    setPendingInterruptedToolCallRecoveryFollowUp: vi.fn((value) => {
      pendingInterruptedToolCallRecoveryFollowUp = value;
    }),
    setPendingProviderInterruptionContinuation: vi.fn((value) => {
      pendingProviderInterruptionContinuation = value;
    }),
    providerRetryAttemptCount: vi.fn(() => providerRetryAttemptCount),
    setProviderRetryAttemptCount: vi.fn((value) => {
      providerRetryAttemptCount = value;
    }),
    setProviderRetryLastError: vi.fn((value) => {
      providerRetryLastError = value;
    }),
    cleanupCurrentSession: vi.fn(),
    markOpenToolMessagesFailed: vi.fn(),
    persistToolArgumentDiagnostics: vi.fn(),
    replaceToolMessage: vi.fn((messageId, content, metadata) => message({ id: messageId, role: "tool", content, metadata })),
    suppressCallableWorkflowParentAssistantMessages: vi.fn(),
    finishPlannerFinalizationSources: vi.fn(),
    finishParentRun: vi.fn((status, errorMessage) => {
      finishedRuns.push({ status, errorMessage });
    }),
    getThread: vi.fn(() => ({ id: "thread-1" } as any)),
    chatStreamInterruptionDiagnostic: vi.fn(streamDiagnostic),
    chatStreamInterruptionNotice: vi.fn((text) => `interrupted: ${text}`),
    emitRunEvent: vi.fn((event) => {
      events.push(event);
    }),
    ...overrides,
  };
  return {
    input,
    runtimeMessages,
    events,
    retryFollowUp,
    replacedAssistantMessages,
    finishedRuns,
    pending: () => ({
      pendingEmptyResponseRetry,
      pendingInterruptedToolCallRecoveryFollowUp,
      pendingProviderInterruptionContinuation,
      providerRetryAttemptCount,
      providerRetryLastError,
    }),
  };
}

describe("handleRuntimePromptFailure", () => {
  it("learns a stricter provider limit, compacts, and retries an overflow once without discarding the session", async () => {
    const recoverProviderContextOverflow = vi.fn(async () => ({
      effectiveContextWindowTokens: 101_376,
      requestedOutputTokens: 32_000,
    }));
    const { input, pending, runtimeMessages, finishedRuns } = setup({
      error: new Error(
        '400 {"error":{"message":"This model\'s maximum context length is 101376 tokens. However, you requested 32000 output tokens and your prompt contains at least 69377 input tokens, for a total of at least 101377 tokens. (parameter=input_tokens, value=69377)","code":400}}',
      ),
      retrySourceUserMessageId: "user-1",
      recoverProviderContextOverflow,
    });

    await handleRuntimePromptFailure(input);

    expect(recoverProviderContextOverflow).toHaveBeenCalledWith(expect.objectContaining({
      contextWindowTokens: 101_376,
      requestedOutputTokens: 32_000,
      inputTokens: 69_377,
    }));
    expect(pending().pendingEmptyResponseRetry).toBeDefined();
    expect(input.cleanupCurrentSession).not.toHaveBeenCalled();
    expect(runtimeMessages.replaceCurrentAssistant).toHaveBeenCalledWith(
      expect.stringContaining("learned the provider's effective 101,376-token context limit"),
      expect.objectContaining({ retryingProviderContextOverflow: true, maxRetries: 1 }),
    );
    expect(finishedRuns).toEqual([{ status: "done", errorMessage: undefined }]);
  });

  it("does not repeat provider context overflow recovery after its single retry", async () => {
    const recoverProviderContextOverflow = vi.fn(async () => ({
      effectiveContextWindowTokens: 101_376,
      requestedOutputTokens: 32_000,
    }));
    const { input, pending } = setup({
      error: new Error(
        "This model's maximum context length is 101376 tokens. However, you requested 32000 output tokens and your prompt contains at least 69377 input tokens, for a total of at least 101377 tokens.",
      ),
      retrySourceUserMessageId: "user-1",
      recoverProviderContextOverflow,
      assistantFinalizationRetryAttemptsUsedFor: vi.fn((reason) => reason === "provider_context_overflow" ? 1 : 0),
    });

    await handleRuntimePromptFailure(input);

    expect(recoverProviderContextOverflow).not.toHaveBeenCalled();
    expect(pending().pendingEmptyResponseRetry).toBeUndefined();
  });

  it("schedules a fresh-session retry for pre-output stream stalls", async () => {
    const { input, retryFollowUp, runtimeMessages, events, finishedRuns, pending } = setup({
      error: new Error("Ambient/Pi did not start streaming within 60000 ms"),
      retrySourceUserMessageId: "user-1",
      streamWatchdogTimedOut: vi.fn(() => true),
      canScheduleAssistantFinalizationRetryFor: vi.fn((reason) => reason === "pre_output_stream_stall"),
    });

    await handleRuntimePromptFailure(input);

    expect(pending().pendingEmptyResponseRetry).toBe(retryFollowUp);
    expect(input.cleanupCurrentSession).toHaveBeenCalledWith({ clearPersistedSessionFileIfCurrent: true });
    expect(input.persistPiStreamTrace).toHaveBeenCalledWith("Ambient/Pi did not start streaming within 60000 ms");
    expect(runtimeMessages.finishCurrentThinkingMessage).toHaveBeenCalledWith("done", "thinking");
    expect(runtimeMessages.replaceCurrentAssistant).toHaveBeenCalledWith(
      expect.stringContaining("Retrying assistant finalization attempt 1/3"),
      expect.objectContaining({ status: "done", retryingStreamStall: true }),
    );
    expect(finishedRuns).toEqual([{ status: "done", errorMessage: undefined }]);
    expect(events).toContainEqual({ type: "run-status", threadId: "thread-1", status: "idle" });
  });

  it("does not continue pre-output stream stalls after the fresh-session retry budget is exhausted", async () => {
    const message = "Ambient/Pi did not start streaming within 45000 ms";
    const { input, runtimeMessages, events, finishedRuns, pending } = setup({
      error: new Error(message),
      retrySourceUserMessageId: "user-1",
      streamWatchdogTimedOut: vi.fn(() => true),
      currentPiStreamFailureKind: vi.fn(() => "pre_stream_timeout" as const),
      canScheduleAssistantFinalizationRetryFor: vi.fn(() => false),
    });

    await handleRuntimePromptFailure(input);

    expect(pending().pendingEmptyResponseRetry).toBeUndefined();
    expect(pending().pendingProviderInterruptionContinuation).toBeUndefined();
    expect(input.createProviderContinuationState).not.toHaveBeenCalled();
    expect(input.persistCurrentSessionPointerForRetry).not.toHaveBeenCalled();
    expect(input.finishPlannerFinalizationSources).toHaveBeenCalledWith("failed", {
      error: message,
      workflowState: "failed",
    });
    expect(finishedRuns).toEqual([{ status: "error", errorMessage: message }]);
    expect(runtimeMessages.replaceCurrentAssistant).toHaveBeenCalledWith(
      expect.stringContaining(message),
      expect.objectContaining({
        status: "error",
        piStreamInterruption: expect.objectContaining({
          kind: "pre_stream_timeout",
          retryScheduled: false,
        }),
      }),
    );
    expect(events).toContainEqual({ type: "run-status", threadId: "thread-1", status: "error" });
    expect(events).toContainEqual({ type: "error", message, threadId: "thread-1", workspacePath: "/workspace" });
  });

  it("continues from durable transcript state after completed tool output and no open tool calls", async () => {
    const { input, retryFollowUp, runtimeMessages, events, finishedRuns, pending } = setup({
      error: new AmbientStreamFailureError(
        "stream_idle_timeout",
        "Ambient/Pi stream stalled after 30000ms without stream activity.",
        { semanticOutputSeen: true, toolCallSeen: true },
      ),
      retrySourceUserMessageId: "user-1",
      streamWatchdogTimedOut: vi.fn(() => true),
      currentPiStreamFailureKind: vi.fn(() => "stream_idle_timeout" as const),
      receivedAnyText: vi.fn(() => true),
      currentAssistantFinalText: vi.fn(() => "The tool finished; I need to inspect its result."),
      toolMessages: {
        ...setup().input.toolMessages,
        size: vi.fn(() => 1),
      } as RuntimePromptFailureHandlerInput["toolMessages"],
      collectOpenProviderInterruptionToolSnapshots: vi.fn(() => []),
      canScheduleAssistantFinalizationRetryFor: vi.fn(() => true),
    });

    await handleRuntimePromptFailure(input);

    expect(pending().pendingProviderInterruptionContinuation).toBe(retryFollowUp);
    expect(input.createProviderContinuationState).toHaveBeenCalledWith(expect.objectContaining({
      kind: "stream_idle_timeout",
      retryScheduled: true,
      replaySafe: false,
      continuationSafe: true,
      retryReason: "provider_interruption_continuation",
      openToolCalls: [],
      completedToolMessageCount: 1,
      receivedAnyText: true,
    }));
    expect(input.chatStreamInterruptionDiagnostic).toHaveBeenCalledWith(
      "Ambient/Pi stream stalled after 30000ms without stream activity.",
      expect.objectContaining({
        kind: "stream_idle_timeout",
        retryScheduled: true,
        replaySafe: false,
        continuationSafe: true,
        retryReason: "provider_interruption_continuation",
        completedToolMessageCount: 1,
      }),
    );
    expect(runtimeMessages.replaceCurrentAssistant).toHaveBeenCalledWith(
      expect.stringContaining("Ambient is starting a continuation turn from the durable recovery state"),
      expect.objectContaining({
        status: "done",
        providerInterruptionContinuation: true,
      }),
    );
    expect(finishedRuns).toEqual([{ status: "done", errorMessage: undefined }]);
    expect(events).toContainEqual({ type: "run-status", threadId: "thread-1", status: "idle" });
  });

  it("suppresses parent output when failure happens after a blocking callable workflow launch", async () => {
    const block = callableWorkflowBlock();
    const { input, runtimeMessages, events, finishedRuns, replacedAssistantMessages, pending } = setup({
      error: new Error("provider failed after launch"),
      currentAssistantFinalText: vi.fn(() => "Premature parent answer."),
      currentThinkingFinalText: vi.fn(() => "Premature parent thinking."),
      receivedAnyText: vi.fn(() => true),
      streamWatchdogTimedOut: vi.fn(() => true),
      resolveCallableWorkflowFinalizationBlock: vi.fn(() => block),
      recordCallableWorkflowFinalizationBlockedParentMailbox: vi.fn(() => ({ id: "mailbox-1" })),
      retrySourceUserMessageId: "user-1",
      canScheduleAssistantFinalizationRetryFor: vi.fn(() => true),
    });

    await handleRuntimePromptFailure(input);

    expect(runtimeMessages.finishCurrentThinkingMessage).toHaveBeenCalledWith("error", "Premature parent thinking.");
    expect(runtimeMessages.suppressAssistantMessagesExceptCurrent).toHaveBeenCalledWith("error");
    expect(runtimeMessages.suppressCurrentThinkingMessage).toHaveBeenCalledWith("error");
    expect(input.suppressCallableWorkflowParentAssistantMessages).toHaveBeenCalledWith(block, {
      preserveMessageId: "assistant-1",
    });
    expect(input.persistPiStreamTrace).toHaveBeenCalledWith("provider failed after launch");
    expect(input.chatStreamInterruptionDiagnostic).toHaveBeenCalledWith("provider failed after launch", expect.objectContaining({
      kind: "pre_stream_timeout",
      retryScheduled: false,
      replaySafe: false,
      completedToolMessageCount: 0,
      receivedAnyText: true,
      providerErrorDiagnostic: expect.objectContaining({
        message: "provider failed after launch",
      }),
    }));
    expect(runtimeMessages.replaceCurrentAssistant).toHaveBeenCalledWith(
      "",
      expect.objectContaining({
        status: "error",
        providerErrorDiagnostic: expect.objectContaining({
          message: "provider failed after launch",
        }),
        piStreamInterruption: expect.objectContaining({
          kind: "pre_stream_timeout",
          message: "provider failed after launch",
          providerErrorDiagnostic: expect.objectContaining({
            message: "provider failed after launch",
          }),
        }),
        callableWorkflowFinalizationBlocked: expect.objectContaining({
          taskIds: ["task-1"],
          waitingTaskIds: ["task-1"],
          parentMailboxEventId: "mailbox-1",
        }),
      }),
    );
    expect(replacedAssistantMessages.at(-1)).toMatchObject({ content: "" });
    expect(input.recordCallableWorkflowFinalizationBlockedParentMailbox).toHaveBeenCalledWith(block);
    expect(input.markOpenToolMessagesFailed).toHaveBeenCalledWith(expect.stringContaining("waiting for the workflow task"));
    expect(pending().pendingEmptyResponseRetry).toBeUndefined();
    expect(finishedRuns).toEqual([{ status: "error", errorMessage: "Workflow task is still running." }]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "runtime-activity",
        activity: expect.objectContaining({
          diagnostic: expect.objectContaining({
            reason: CALLABLE_WORKFLOW_PARENT_BLOCKING_REASON,
            taskIds: ["task-1"],
          }),
        }),
      }),
      { type: "run-status", threadId: "thread-1", status: "error" },
      { type: "thread-updated", thread: { id: "thread-1" } },
    ]));
  });

  it("preserves mixed subagent and workflow blocker state on post-launch failures", async () => {
    const workflowBlock = callableWorkflowBlock();
    const childBlock = subagentBlock();
    const { input, runtimeMessages, events, finishedRuns } = setup({
      error: new Error("provider failed after mixed launch"),
      currentAssistantFinalText: vi.fn(() => "Premature mixed parent answer."),
      currentThinkingFinalText: vi.fn(() => "Premature mixed parent thinking."),
      receivedAnyText: vi.fn(() => true),
      resolveSubagentFinalizationBlock: vi.fn(() => childBlock),
      recordSubagentFinalizationBlockedParentMailbox: vi.fn(() => [{ id: "child-mailbox-1" }]),
      resolveCallableWorkflowFinalizationBlock: vi.fn(() => workflowBlock),
      recordCallableWorkflowFinalizationBlockedParentMailbox: vi.fn(() => ({ id: "workflow-mailbox-1" })),
    });

    await handleRuntimePromptFailure(input);

    expect(runtimeMessages.suppressAssistantMessagesExceptCurrent).toHaveBeenCalledWith("error");
    expect(runtimeMessages.suppressCurrentThinkingMessage).toHaveBeenCalledWith("error");
    expect(input.suppressCallableWorkflowParentAssistantMessages).toHaveBeenCalledWith(workflowBlock, {
      preserveMessageId: "assistant-1",
    });
    expect(input.persistPiStreamTrace).toHaveBeenCalledWith("provider failed after mixed launch");
    expect(input.chatStreamInterruptionDiagnostic).toHaveBeenCalledWith("provider failed after mixed launch", expect.objectContaining({
      kind: "provider_error_event",
      retryScheduled: false,
      replaySafe: false,
      providerErrorDiagnostic: expect.objectContaining({
        message: "provider failed after mixed launch",
      }),
    }));
    expect(runtimeMessages.replaceCurrentAssistant).toHaveBeenCalledWith(
      "",
      expect.objectContaining({
        providerErrorDiagnostic: expect.objectContaining({
          message: "provider failed after mixed launch",
        }),
        piStreamInterruption: expect.objectContaining({
          kind: "provider_error_event",
          message: "provider failed after mixed launch",
        }),
        subagentFinalizationBlocked: expect.objectContaining({
          parentMailboxEventIds: ["child-mailbox-1"],
        }),
        callableWorkflowFinalizationBlocked: expect.objectContaining({
          parentMailboxEventId: "workflow-mailbox-1",
        }),
      }),
    );
    expect(input.recordSubagentFinalizationBlockedParentMailbox).toHaveBeenCalledWith(childBlock);
    expect(input.recordCallableWorkflowFinalizationBlockedParentMailbox).toHaveBeenCalledWith(workflowBlock);
    expect(finishedRuns).toEqual([{
      status: "error",
      errorMessage: "A required child is still running.\n\nWorkflow task is still running.",
    }]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "runtime-activity",
        activity: expect.objectContaining({
          diagnostic: expect.objectContaining({
            reason: "required_wait_barrier_not_satisfied",
            barrierIds: ["barrier-1"],
          }),
        }),
      }),
      expect.objectContaining({
        type: "runtime-activity",
        activity: expect.objectContaining({
          diagnostic: expect.objectContaining({
            reason: CALLABLE_WORKFLOW_PARENT_BLOCKING_REASON,
            taskIds: ["task-1"],
          }),
        }),
      }),
    ]));
  });

  it("finalizes terminal provider failures when no retry path applies", async () => {
    const { input, runtimeMessages, events, finishedRuns, replacedAssistantMessages, pending } = setup({
      error: new Error("provider exploded"),
    });

    await handleRuntimePromptFailure(input);

    expect(pending().pendingEmptyResponseRetry).toBeUndefined();
    expect(input.markOpenToolMessagesFailed).toHaveBeenCalledWith("Ambient/Pi provider failed before this tool completed.");
    expect(input.finishPlannerFinalizationSources).toHaveBeenCalledWith("failed", {
      error: "provider exploded",
      workflowState: "failed",
    });
    expect(finishedRuns).toEqual([{ status: "error", errorMessage: "provider exploded" }]);
    expect(runtimeMessages.replaceCurrentAssistant).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "error", runtime: "pi", provider: "ambient" }),
    );
    expect(replacedAssistantMessages.at(-1)?.metadata).toEqual(expect.objectContaining({
      status: "error",
      providerErrorDiagnostic: expect.objectContaining({ message: "provider exploded" }),
    }));
    expect(events).toContainEqual({ type: "run-status", threadId: "thread-1", status: "error" });
    expect(events).toContainEqual({ type: "error", message: "provider exploded", threadId: "thread-1", workspacePath: "/workspace" });
  });

  it("surfaces Symphony parent-mode launch misses as recovery cards instead of provider failures", async () => {
    const { input, runtimeMessages, events, finishedRuns, replacedAssistantMessages } = setup({
      error: new Error(SYMPHONY_PARENT_MODE_MISSING_WORKFLOW_TASK_ERROR),
      symphonyParentModePolicy: {
        enabled: true,
        reason: "symphony-composer-run-once",
        launchRequirement: "required_this_turn",
        directExecutionPolicy: "deny_substantive_tools",
        expectedWorkflowToolName: "ambient_workflow_symphony_map_reduce",
        expectedWorkflowSourceKind: "symphony_recipe",
        expectedPatternId: "map_reduce",
      },
    });

    await handleRuntimePromptFailure(input);

    expect(input.cleanupCurrentSession).toHaveBeenCalledWith({ clearPersistedSessionFileIfCurrent: true });
    expect(runtimeMessages.finishCurrentThinkingMessage).toHaveBeenCalledWith("error", "thinking");
    expect(input.markOpenToolMessagesFailed).toHaveBeenCalledWith(
      "Symphony parent mode stopped before a callable workflow launch was verified.",
    );
    expect(runtimeMessages.replaceCurrentAssistant).toHaveBeenCalledWith(
      expect.stringContaining("Symphony launch needs a recovery choice."),
      expect.objectContaining({
        status: "error",
        runtime: "pi",
        provider: "ambient",
        symphonyParentModeRecovery: expect.objectContaining({
          expectedWorkflowToolName: "ambient_workflow_symphony_map_reduce",
          expectedPatternId: "map_reduce",
          actionRequired: true,
        }),
      }),
    );
    expect(input.finishPlannerFinalizationSources).toHaveBeenCalledWith("failed", {
      error: SYMPHONY_PARENT_MODE_MISSING_WORKFLOW_TASK_ERROR,
      workflowState: "failed",
    });
    expect(finishedRuns).toEqual([{ status: "error", errorMessage: SYMPHONY_PARENT_MODE_MISSING_WORKFLOW_TASK_ERROR }]);
    expect(replacedAssistantMessages.at(-1)?.content).not.toContain("provider exploded");
    expect(events).toContainEqual({
      type: "run-status",
      threadId: "thread-1",
      status: "error",
    });
  });
});
