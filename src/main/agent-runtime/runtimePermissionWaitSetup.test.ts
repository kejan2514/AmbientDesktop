import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, ToolEditInputPreview, ToolLongformInputPreview } from "../../shared/threadTypes";
import { ToolArgumentProgressTracker } from "./agentRuntimeToolRuntimeFacade";
import type {
  RuntimePermissionWaitController,
  RuntimePermissionWaitControllerInput,
} from "./runtimePermissionWaitController";
import {
  createRuntimePermissionWaitSetup,
  type RuntimePermissionWaitSetupInput,
} from "./runtimePermissionWaitSetup";
import type { RuntimeStreamWatchdogController } from "./runtimeStreamWatchdogController";
import type { RuntimeToolArgumentWatchdog } from "./runtimeToolArgumentWatchdog";
import type { RuntimeToolExecutionWatchdog } from "./runtimeToolExecutionWatchdog";
import type { RuntimeToolMessageController } from "./runtimeToolMessageController";

function chatMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "message-1",
    threadId: "thread-1",
    role: "tool",
    content: "tool content",
    createdAt: "2026-06-15T00:00:00.000Z",
    ...overrides,
  };
}

function createController(): RuntimePermissionWaitController {
  return {
    begin: vi.fn(),
    isWaiting: vi.fn(() => false),
  };
}

function createInput(
  overrides: Partial<RuntimePermissionWaitSetupInput> = {},
): RuntimePermissionWaitSetupInput {
  const controller = createController();
  const longformInputPreview: ToolLongformInputPreview = {
    kind: "longform-input",
    summary: "large input",
    items: [],
  };
  const editInputPreview: ToolEditInputPreview = {
    kind: "edit-input",
    path: "patch.diff",
    summary: "patch",
    edits: [],
  };
  const toolMessages = {
    messageId: vi.fn(() => "message-1"),
    inputContent: vi.fn(() => "{\"path\":\"demo.txt\"}"),
    longformInputPreview: vi.fn(() => longformInputPreview),
    editInputPreview: vi.fn(() => editInputPreview),
  } as unknown as RuntimeToolMessageController;
  return {
    threadId: "thread-1",
    toolMessages,
    toolArgumentProgress: new ToolArgumentProgressTracker(),
    getToolExecutionWatchdog: vi.fn(() => undefined),
    getToolArgumentWatchdog: vi.fn(() => undefined),
    getStreamWatchdog: vi.fn(() => undefined),
    markRunActivity: vi.fn(() => true),
    replaceMessage: vi.fn((messageId, content, metadata) => chatMessage({ id: messageId, content, metadata })),
    emitRunEvent: vi.fn(),
    createPermissionWaitController: vi.fn(() => controller),
    ...overrides,
  };
}

describe("createRuntimePermissionWaitSetup", () => {
  it("creates a permission-wait controller with explicit runtime owners", () => {
    const input = createInput();

    const controller = createRuntimePermissionWaitSetup(input);

    expect(controller).toBe(vi.mocked(input.createPermissionWaitController!).mock.results[0].value);
    expect(input.createPermissionWaitController).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        markRunActivity: input.markRunActivity,
        replaceMessage: input.replaceMessage,
        emitRunEvent: input.emitRunEvent,
      }),
    );
  });

  it("maps tool message and argument-progress lookups to the current runtime owners", () => {
    const input = createInput();
    input.toolArgumentProgress.recordArgumentEvent({
      toolCallId: "tool-call-1",
      toolName: "ambient_write_file",
      eventType: "toolcall_delta",
      inputContent: "{\"path\":\"demo.txt\"}",
      nowMs: Date.parse("2026-06-15T00:00:01.000Z"),
    });

    createRuntimePermissionWaitSetup(input);

    const controllerInput = vi.mocked(input.createPermissionWaitController!).mock
      .calls[0][0] as RuntimePermissionWaitControllerInput;
    expect(controllerInput.getToolMessageId("tool-call-1")).toBe("message-1");
    expect(controllerInput.getToolInputContent("tool-call-1")).toBe("{\"path\":\"demo.txt\"}");
    expect(controllerInput.getToolLongformInputPreview("tool-call-1")).toMatchObject({ summary: "large input" });
    expect(controllerInput.getToolEditInputPreview("tool-call-1")).toMatchObject({ path: "patch.diff" });
    expect(controllerInput.getToolArgumentProgress("tool-call-1")).toMatchObject({
      toolCallId: "tool-call-1",
      observedArgumentChars: 19,
    });
  });

  it("uses late-bound watchdog getters for pause, resume, mark, clear, and schedule operations", () => {
    const toolExecutionWatchdog = {
      active: vi.fn(() => ({ toolCallId: "tool-call-1", toolName: "ambient_write_file" })),
      count: vi.fn(() => 1),
      mark: vi.fn(),
      clear: vi.fn(),
      schedule: vi.fn(),
    } as unknown as RuntimeToolExecutionWatchdog;
    const toolArgumentWatchdog = {
      clear: vi.fn(),
      refreshOnTransportActivity: vi.fn(),
      schedule: vi.fn(),
    } as RuntimeToolArgumentWatchdog;
    const streamWatchdog = {
      pause: vi.fn(),
      resume: vi.fn(),
    } as unknown as RuntimeStreamWatchdogController;
    const input = createInput({
      getToolExecutionWatchdog: vi.fn(() => toolExecutionWatchdog),
      getToolArgumentWatchdog: vi.fn(() => toolArgumentWatchdog),
      getStreamWatchdog: vi.fn(() => streamWatchdog),
    });

    createRuntimePermissionWaitSetup(input);

    const controllerInput = vi.mocked(input.createPermissionWaitController!).mock
      .calls[0][0] as RuntimePermissionWaitControllerInput;
    expect(controllerInput.getActiveToolExecution()).toEqual({
      toolCallId: "tool-call-1",
      toolName: "ambient_write_file",
    });
    expect(controllerInput.getActiveToolExecutionCount()).toBe(1);

    controllerInput.markToolExecutionActivity("tool-call-1", "ambient_write_file");
    controllerInput.pauseStreamWatchdog();
    controllerInput.resumeStreamWatchdog();
    controllerInput.clearToolArgumentWatchdog();
    controllerInput.scheduleToolArgumentWatchdog();
    controllerInput.clearToolExecutionWatchdog();
    controllerInput.scheduleToolExecutionWatchdog();

    expect(toolExecutionWatchdog.mark).toHaveBeenCalledWith("tool-call-1", "ambient_write_file");
    expect(streamWatchdog.pause).toHaveBeenCalledTimes(1);
    expect(streamWatchdog.resume).toHaveBeenCalledTimes(1);
    expect(toolArgumentWatchdog.clear).toHaveBeenCalledTimes(1);
    expect(toolArgumentWatchdog.schedule).toHaveBeenCalledTimes(1);
    expect(toolExecutionWatchdog.clear).toHaveBeenCalledTimes(1);
    expect(toolExecutionWatchdog.schedule).toHaveBeenCalledTimes(1);
  });
});
