import { describe, expect, it, vi } from "vitest";

import type { DesktopEvent, SendMessageInput } from "../../shared/desktopTypes";
import type { SubagentWaitBarrierSummary } from "../../shared/subagentTypes";
import type { ChatMessage, RunDiagnostics } from "../../shared/threadTypes";
import {
  createAgentRuntimeSendExecutionState,
  type AgentRuntimeSendExecutionStateInput,
  type AgentRuntimeSendExecutionStateSession,
} from "./agentRuntimeSendExecutionState";
import { createAgentRuntimeSendPromptState } from "./agentRuntimeSendPromptState";
import type { RuntimePermissionWaitController } from "./runtimePermissionWaitController";
import type { RuntimeStreamWatchdogController } from "./runtimeStreamWatchdogController";
import type { RuntimeToolArgumentWatchdog } from "./runtimeToolArgumentWatchdog";
import type { RuntimeToolExecutionWatchdog } from "./runtimeToolExecutionWatchdog";

interface TestSession extends AgentRuntimeSendExecutionStateSession {
  id: string;
  sessionFile: string;
}

describe("createAgentRuntimeSendExecutionState", () => {
  it("registers permission wait controls and keeps watchdog references live", () => {
    const { input, promptState, setPermissionWaitControl } = baseInput();
    const streamWatchdog = streamWatchdogController();
    const toolArgumentWatchdog = toolArgumentWatchdogController();
    const toolExecutionWatchdog = toolExecutionWatchdogController();
    promptState.setStreamWatchdog(streamWatchdog);

    const state = createAgentRuntimeSendExecutionState(input);
    state.setToolArgumentWatchdog(toolArgumentWatchdog);
    state.setToolExecutionWatchdog(toolExecutionWatchdog);

    expect(setPermissionWaitControl).toHaveBeenCalledWith(state.permissionWaits);
    expect(state.toolArgumentWatchdog()).toBe(toolArgumentWatchdog);
    expect(state.toolExecutionWatchdog()).toBe(toolExecutionWatchdog);
    expect(state.activeRun.dedicatedSessionKind).toBe("workflow-recording-review");

    const finishPermissionWait = state.permissionWaits.begin({ toolName: "write", title: "Allow write" });
    finishPermissionWait({ allowed: true, mode: "allow_once" });

    expect(streamWatchdog.pause).toHaveBeenCalledTimes(1);
    expect(streamWatchdog.resume).toHaveBeenCalledTimes(1);
    expect(toolArgumentWatchdog.clear).toHaveBeenCalledTimes(1);
    expect(toolArgumentWatchdog.schedule).toHaveBeenCalledTimes(1);
    expect(toolExecutionWatchdog.clear).toHaveBeenCalledTimes(1);
  });

  it("exposes active-run abort delegates without changing abort behavior", async () => {
    const { input, session } = baseInput();
    const state = createAgentRuntimeSendExecutionState(input);

    await state.activeRun.abort();

    expect(input.denyThread).toHaveBeenCalledWith("thread-1");
    expect(input.finishRun).toHaveBeenCalledWith("run-1", "aborted", undefined);
    expect(input.abortSessionRun).toHaveBeenCalledWith(session, "thread-1");
    expect(state.isAbortRequested()).toBe(true);
  });

  it("keeps session cleanup and open-tool failure handlers mutable", () => {
    const { input, session } = baseInput();
    const state = createAgentRuntimeSendExecutionState(input);
    const markOpenToolMessagesFailed = vi.fn();

    state.markOpenToolMessagesFailed("before handler");
    state.setMarkOpenToolMessagesFailed(markOpenToolMessagesFailed);
    state.markOpenToolMessagesFailed("after handler");
    const cleanup = state.cleanupCurrentSession({ clearPersistedSessionFileIfCurrent: true });

    expect(markOpenToolMessagesFailed).toHaveBeenCalledWith("after handler");
    expect(input.removeActiveSessionIfCurrent).toHaveBeenCalledWith(session);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(input.clearThreadPiSessionFile).toHaveBeenCalledWith(session.sessionFile);
    expect(cleanup).toMatchObject({
      removedActiveSession: true,
      disposedSession: true,
      clearedPersistedSessionFile: true,
    });
  });
});

function baseInput(): {
  input: AgentRuntimeSendExecutionStateInput<TestSession>;
  promptState: AgentRuntimeSendExecutionStateInput<TestSession>["sendPromptState"];
  session: TestSession;
  setPermissionWaitControl: ReturnType<typeof vi.fn>;
} {
  const events: DesktopEvent[] = [];
  const diagnostics: RunDiagnostics[] = [];
  const messages: ChatMessage[] = [assistantMessage()];
  const session: TestSession = {
    id: "session-1",
    sessionFile: "sessions/thread-1.jsonl",
    dispose: vi.fn(),
    steer: async () => undefined,
    followUp: async () => undefined,
  };
  const setPermissionWaitControl = vi.fn();
  const promptState = createAgentRuntimeSendPromptState<TestSession>({
    threadId: "thread-1",
    runId: "run-1",
    workspacePath: "/workspace",
    assistantMessage: messages[0],
    baseInput: sendInput(),
    usesDedicatedReviewSession: false,
    assistantFinalizationRetryMaxRetries: 3,
    retrySourceUserMessageId: "user-1",
    interruptedToolCallRecoveryAttemptsUsed: 0,
    interruptedToolCallRecoveryMaxRetries: 3,
    piPreStreamTimeoutMs: 10_000,
    piStreamIdleTimeoutMs: 30_000,
    runStartedAt: "2026-06-22T00:00:00.000Z",
    runtimeModel: "example/model-id",
    getPermissionMode: () => "workspace",
    getCurrentSessionFile: () => session.sessionFile,
    getCurrentThreadPiSessionFile: () => session.sessionFile,
    getCurrentThreadModel: () => "example/model-id",
    commitThreadPiSessionFile: vi.fn(async () => undefined),
    getSession: () => session,
    getPromptContentLength: () => "Please write the report.".length,
    getWorkspaceStatePath: () => "/workspace/.ambient",
    isRunStoreActive: () => true,
    markRunActivity: () => true,
    updateRunStatus: vi.fn(),
    listMessages: () => messages,
    getMessage: (messageId) => messages.find((message) => message.id === messageId),
    addAssistantMessage: (messageInput) => {
      const message = assistantMessage({
        id: `assistant-${messages.length + 1}`,
        threadId: messageInput.threadId,
        content: messageInput.content,
        metadata: messageInput.metadata,
      });
      messages.push(message);
      return message;
    },
    appendToMessage: (messageId, delta) => {
      const message = findMessage(messages, messageId);
      message.content += delta;
      return message;
    },
    replaceMessage: (messageId, content, metadata) => {
      const message = findMessage(messages, messageId);
      message.content = content;
      message.metadata = metadata;
      return message;
    },
    updateRunDiagnostics: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
    emitRunEvent: (event) => {
      events.push(event);
    },
    toolMessageCount: () => 0,
    progressThrottleMs: 0,
    progressCharDelta: 0,
    recentEventLimit: 10,
    emptyResponseRetryDelayMs: 0,
  });
  const input: AgentRuntimeSendExecutionStateInput<TestSession> = {
    threadId: "thread-1",
    runId: "run-1",
    threadWorkspacePath: "/workspace",
    permissionMode: "workspace",
    visibleUserContent: "Please write the report.",
    retrySourceUserMessageId: "user-1",
    baseInput: sendInput(),
    runtimeInput: {
      dedicatedSessionKind: "workflow-recording-review",
    },
    usesDedicatedReviewSession: false,
    runtimeModel: "example/model-id",
    piPreStreamTimeoutMs: 10_000,
    piStreamIdleTimeoutMs: 30_000,
    assistantFinalizationRetryMaxRetries: 3,
    sendPromptState: promptState,
    runEventScope: {
      addActivityListener: vi.fn(() => vi.fn()),
      detachFromWorkspace: vi.fn(),
    },
    isRunStoreActive: vi.fn(() => true),
    markRunActivity: vi.fn(() => true),
    listMessages: () => messages,
    getMessage: (messageId) => messages.find((message) => message.id === messageId),
    addToolMessage: (messageInput) => {
      const message = toolMessage({
        id: `tool-${messages.length + 1}`,
        threadId: messageInput.threadId,
        content: messageInput.content,
        metadata: messageInput.metadata,
      });
      messages.push(message);
      return message;
    },
    replaceMessage: (messageId, content, metadata = {}) => {
      const message = findMessage(messages, messageId);
      message.content = content;
      message.metadata = metadata;
      return message;
    },
    updateRunDiagnostics: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
    finishRun: vi.fn(),
    denyThread: vi.fn(),
    getSession: () => session,
    abortSessionRun: vi.fn(async () => undefined),
    markSubagentParentControlBarrierReconciled: vi.fn(
      () =>
        ({
          id: "barrier-1",
          status: "satisfied",
        }) as SubagentWaitBarrierSummary,
    ),
    cascadeSubagentsForStoppedParentRun: vi.fn(async () => undefined),
    setPermissionWaitControl: setPermissionWaitControl as (control: RuntimePermissionWaitController) => void,
    getPermissionMode: () => "workspace",
    getModel: () => "example/model-id",
    currentThreadPiSessionFile: () => session.sessionFile,
    clearThreadPiSessionFile: vi.fn(),
    removeActiveSessionIfCurrent: vi.fn(() => true),
    listCallableWorkflowTasksForParentRun: () => [],
    emitRunEvent: (event) => {
      events.push(event);
    },
  };
  return { input, promptState, session, setPermissionWaitControl };
}

function sendInput(overrides: Partial<SendMessageInput> = {}): SendMessageInput {
  return {
    threadId: "thread-1",
    content: "Please write the report.",
    permissionMode: "workspace",
    collaborationMode: "agent",
    model: "example/model-id",
    thinkingLevel: "medium",
    delivery: "prompt",
    ...overrides,
  };
}

function assistantMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "assistant-1",
    threadId: "thread-1",
    role: "assistant",
    content: "",
    createdAt: "2026-06-22T00:00:00.000Z",
    metadata: { status: "streaming" },
    ...overrides,
  };
}

function toolMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "tool-1",
    threadId: "thread-1",
    role: "tool",
    content: "",
    createdAt: "2026-06-22T00:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

function findMessage(messages: ChatMessage[], messageId: string): ChatMessage {
  const message = messages.find((item) => item.id === messageId);
  if (!message) throw new Error(`Missing message ${messageId}`);
  return message;
}

function streamWatchdogController(): RuntimeStreamWatchdogController {
  return {
    pause: vi.fn(),
    resume: vi.fn(),
    reset: vi.fn(),
    markTransportActivity: vi.fn(),
    setPreStreamTimeoutMs: vi.fn(),
    stop: vi.fn(),
    pauseIfNeeded: vi.fn(),
  };
}

function toolArgumentWatchdogController(): RuntimeToolArgumentWatchdog {
  return {
    clear: vi.fn(),
    schedule: vi.fn(),
    refreshOnTransportActivity: vi.fn(),
  };
}

function toolExecutionWatchdogController(): RuntimeToolExecutionWatchdog {
  return {
    active: vi.fn(),
    count: vi.fn(() => 0),
    isActive: vi.fn(() => false),
    isTimedOut: vi.fn(() => false),
    timeoutMessage: vi.fn(),
    clear: vi.fn(),
    schedule: vi.fn(),
    begin: vi.fn(),
    mark: vi.fn(),
    finish: vi.fn(),
  };
}
