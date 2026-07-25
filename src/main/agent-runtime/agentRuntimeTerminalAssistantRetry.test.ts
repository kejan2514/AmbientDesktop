import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "./agentRuntime";
import { ProjectStore } from "./agentRuntimeProjectStoreFacade";

function fakePiSession(sessionFile: string) {
  return {
    sessionFile,
    sessionManager: {
      getEntries: () => [],
    },
    model: {
      contextWindow: 128_000,
    },
    getContextUsage: () => ({
      tokens: 512,
      contextWindow: 128_000,
      percent: 0.4,
    }),
    sendCustomMessage: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
}

describe("AgentRuntime terminal assistant retry", () => {
  it("retries an empty post-tool assistant answer without dropping the restorable session file", async () => {
    vi.useFakeTimers();
    const workspacePath = await mkdtemp(join(tmpdir(), "ambient-runtime-empty-post-tool-retry-"));
    const store = new ProjectStore();
    try {
      const workspace = store.openWorkspace(workspacePath);
      const created = store.createThread("empty post-tool retry");
      const threadSessionDir = join(workspace.sessionPath, created.id);
      await mkdir(threadSessionDir, { recursive: true });
      const firstSessionFile = join(threadSessionDir, "first.jsonl");
      const retrySessionFile = join(threadSessionDir, "retry.jsonl");
      await writeFile(firstSessionFile, "", "utf8");
      const thread = store.updateThreadSettings(created.id, { piSessionFile: firstSessionFile });
      const initialText = "I'll check the provider catalog and current search setup.";
      const retryText = "Brave Search is available, but setup needs a BRAVE_API_KEY captured through Ambient-managed secrets.";

      const firstSubscribers: Array<(event: any) => void> = [];
      let rejectPrompt: ((error: Error) => void) | undefined;
      const emitFirst = (event: any) => {
        for (const subscriber of [...firstSubscribers]) subscriber(event);
      };
      const firstSession = {
        ...fakePiSession(firstSessionFile),
        isStreaming: true,
        subscribe: vi.fn((subscriber: (event: any) => void) => {
          firstSubscribers.push(subscriber);
          return () => {
            const index = firstSubscribers.indexOf(subscriber);
            if (index >= 0) firstSubscribers.splice(index, 1);
          };
        }),
        prompt: vi.fn(() => new Promise<never>((_resolve, reject) => {
          rejectPrompt = reject;
          setTimeout(() => {
            emitFirst({ type: "message_start", message: { role: "assistant" } });
            emitFirst({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: initialText } });
            emitFirst({
              type: "message_end",
              message: {
                role: "assistant",
                stopReason: "toolUse",
                content: [
                  { type: "text", text: initialText },
                  { type: "toolCall", id: "call-provider-catalog", name: "ambient_provider_catalog", arguments: {} },
                ],
              },
            });
            emitFirst({
              type: "tool_execution_start",
              toolCallId: "call-provider-catalog",
              toolName: "ambient_provider_catalog",
              args: {},
            });
            emitFirst({
              type: "tool_execution_end",
              toolCallId: "call-provider-catalog",
              toolName: "ambient_provider_catalog",
              result: [{ type: "text", text: "Brave Search API (search.brave)" }],
            });
            emitFirst({ type: "message_start", message: { role: "assistant" } });
            emitFirst({
              type: "message_end",
              message: {
                role: "assistant",
                stopReason: "stop",
                content: [],
              },
            });
          }, 0);
        })),
        steer: vi.fn(async () => undefined),
        compact: vi.fn(async () => undefined),
        agent: {
          abort: vi.fn(() => {
            emitFirst({
              type: "message_end",
              message: {
                role: "assistant",
                stopReason: "aborted",
                errorMessage: "Request was aborted.",
                content: [],
              },
            });
            rejectPrompt?.(new Error("Request was aborted."));
          }),
          waitForIdle: vi.fn(async () => undefined),
        },
      };

      const retrySubscribers: Array<(event: any) => void> = [];
      const emitRetry = (event: any) => {
        for (const subscriber of [...retrySubscribers]) subscriber(event);
      };
      const retrySession = {
        ...fakePiSession(retrySessionFile),
        isStreaming: true,
        subscribe: vi.fn((subscriber: (event: any) => void) => {
          retrySubscribers.push(subscriber);
          return () => {
            const index = retrySubscribers.indexOf(subscriber);
            if (index >= 0) retrySubscribers.splice(index, 1);
          };
        }),
        prompt: vi.fn(() => new Promise<void>((resolve) => {
          setTimeout(() => {
            emitRetry({ type: "message_start", message: { role: "assistant" } });
            emitRetry({
              type: "message_end",
              message: {
                role: "assistant",
                stopReason: "stop",
                content: [{ type: "text", text: retryText }],
              },
            });
            resolve();
          }, 0);
        })),
        steer: vi.fn(async () => undefined),
        compact: vi.fn(async () => undefined),
        agent: {
          abort: vi.fn(),
          waitForIdle: vi.fn(async () => undefined),
        },
      };

      const runtime = new AgentRuntime(store, {} as any, {} as any, () => undefined, {
        request: vi.fn(),
        denyThread: () => undefined,
      });
      const getSession = vi.spyOn(runtime as any, "getSession")
        .mockResolvedValueOnce(firstSession)
        .mockResolvedValueOnce(retrySession);

      const sendPromise = runtime.send({
        threadId: thread.id,
        content: "Can we add Brave Search as a provider?",
        permissionMode: "full-access",
        collaborationMode: "agent",
        model: "ambient-preview",
        thinkingLevel: "medium",
        delivery: "prompt",
        context: [],
      });

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(15_000);
      await sendPromise;
      await vi.advanceTimersByTimeAsync(2_000);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await vi.advanceTimersByTimeAsync(1);
        if (store.listMessages(thread.id).some((message) => message.content.includes(retryText))) break;
      }

      const assistantMessages = store.listMessages(thread.id).filter((message) => message.role === "assistant");
      const retryNotice = assistantMessages.find((message) =>
        message.content.includes("Retrying assistant finalization attempt 1/10 after resetting the live session."),
      );
      expect(retryNotice).toMatchObject({
        metadata: expect.objectContaining({
          status: "done",
          retryingEmptyAssistantResponse: true,
          piTerminalCleanup: expect.objectContaining({
            reason: "assistant-terminal-before-prompt-resolved",
            cleanupAction: "abort-and-dispose-session",
            receivedAnyText: true,
            currentAssistantReceivedText: false,
            currentAssistantFinalTextChars: 0,
          }),
          piEmptyAssistantResponse: expect.objectContaining({
            retryScheduled: true,
            retryUsesFreshSession: false,
            retryAttempt: 1,
            maxRetries: 10,
            retryReason: "empty_assistant_response",
            retryDelayMs: 1_000,
            receivedAnyText: true,
            currentAssistantFinalTextChars: 0,
            sessionFile: firstSessionFile,
            lastAssistantTerminalEvent: expect.objectContaining({
              eventType: "message_end",
              stopReason: "stop",
              contentBlockCount: 0,
              finalTextChars: 0,
            }),
          }),
        }),
      });
      expect(assistantMessages.at(-1)).toMatchObject({
        content: retryText,
        metadata: expect.objectContaining({ status: "done" }),
      });
      expect(getSession).toHaveBeenCalledTimes(2);
      const retryThreadArg = getSession.mock.calls[1]?.[0] as { piSessionFile?: string | null };
      expect(retryThreadArg.piSessionFile).toBe(firstSessionFile);
      expect(firstSession.dispose).toHaveBeenCalled();
      expect(firstSession.agent.abort).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      store.close();
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("retries empty assistant responses across the aggressive finalization budget with fresh Pi sessions", async () => {
    vi.useFakeTimers();
    const workspacePath = await mkdtemp(join(tmpdir(), "ambient-runtime-empty-retry-"));
    const store = new ProjectStore();
    try {
      const workspace = store.openWorkspace(workspacePath);
      const created = store.createThread("empty retry");
      const thread = store.updateThreadTitle(created.id, "Empty retry");
      const threadSessionDir = join(workspace.sessionPath, thread.id);
      await mkdir(threadSessionDir, { recursive: true });

      const makeSession = (name: string, finalText: string) => {
        const sessionFile = join(threadSessionDir, `${name}.jsonl`);
        const subscribers: Array<(event: any) => void> = [];
        const emit = (event: any) => {
          for (const subscriber of [...subscribers]) subscriber(event);
        };
        const session = {
          ...fakePiSession(sessionFile),
          isStreaming: true,
          subscribe: vi.fn((subscriber: (event: any) => void) => {
            subscribers.push(subscriber);
            return () => {
              const index = subscribers.indexOf(subscriber);
              if (index >= 0) subscribers.splice(index, 1);
            };
          }),
          prompt: vi.fn(() => new Promise<void>((resolve) => {
            setTimeout(() => {
              emit({
                type: "message_end",
                message: {
                  role: "assistant",
                  stopReason: "stop",
                  content: finalText ? [{ type: "text", text: finalText }] : [],
                },
              });
              resolve();
            }, 0);
          })),
          steer: vi.fn(async () => undefined),
          compact: vi.fn(async () => undefined),
          agent: {
            abort: vi.fn(),
            waitForIdle: vi.fn(async () => undefined),
          },
        };
        return session;
      };
      const firstSession = makeSession("empty", "");
      const secondEmptySession = makeSession("empty-2", "");
      const retrySession = makeSession("retry", "Get a Brave Search API key at https://brave.com/search/api/.");
      const runtime = new AgentRuntime(store, {} as any, {} as any, () => undefined, {
        request: vi.fn(),
        denyThread: () => undefined,
      });
      const getSession = vi.spyOn(runtime as any, "getSession")
        .mockResolvedValueOnce(firstSession)
        .mockResolvedValueOnce(secondEmptySession)
        .mockResolvedValueOnce(retrySession);

      const sendPromise = runtime.send({
        threadId: thread.id,
        content: "Where can I get a Brave Search API key?",
        permissionMode: "full-access",
        collaborationMode: "agent",
        model: "ambient-preview",
        thinkingLevel: "medium",
        delivery: "prompt",
        context: [],
      });

      await vi.advanceTimersByTimeAsync(0);
      await sendPromise;
      await vi.advanceTimersByTimeAsync(10_000);
      for (let attempt = 0; attempt < 16; attempt += 1) {
        await vi.advanceTimersByTimeAsync(1);
        if (store.listMessages(thread.id).some((message) => message.content.includes("Get a Brave Search API key"))) break;
      }

      const assistantMessages = store.listMessages(thread.id).filter((message) => message.role === "assistant");
      expect(assistantMessages[0]).toMatchObject({
        content: "Ambient/Pi returned no assistant text. Retrying assistant finalization attempt 1/10 with a fresh session.",
        metadata: expect.objectContaining({
          status: "done",
          retryingEmptyAssistantResponse: true,
          piEmptyAssistantResponse: expect.objectContaining({
            retryScheduled: true,
            retryUsesFreshSession: true,
            retryAttempt: 1,
            maxRetries: 10,
            retryReason: "empty_assistant_response",
            retryDelayMs: 1_000,
            receivedAnyText: false,
            currentAssistantFinalTextChars: 0,
            sessionFile: join(threadSessionDir, "empty.jsonl"),
            lastAssistantTerminalEvent: expect.objectContaining({
              eventType: "message_end",
              stopReason: "stop",
              contentBlockCount: 0,
              finalTextChars: 0,
            }),
          }),
        }),
      });
      expect(assistantMessages[1]).toMatchObject({
        content: "Ambient/Pi returned no assistant text. Retrying assistant finalization attempt 2/10 with a fresh session.",
        metadata: expect.objectContaining({
          status: "done",
          retryingEmptyAssistantResponse: true,
          piEmptyAssistantResponse: expect.objectContaining({
            retryScheduled: true,
            retryUsesFreshSession: true,
            retryAttempt: 2,
            maxRetries: 10,
            retryReason: "empty_assistant_response",
            retryDelayMs: 1_000,
            receivedAnyText: false,
            currentAssistantFinalTextChars: 0,
            sessionFile: join(threadSessionDir, "empty-2.jsonl"),
          }),
        }),
      });
      expect(assistantMessages.at(-1)).toMatchObject({
        content: "Get a Brave Search API key at https://brave.com/search/api/.",
        metadata: expect.objectContaining({ status: "done" }),
      });
      expect(getSession).toHaveBeenCalledTimes(3);
      expect(firstSession.dispose).toHaveBeenCalled();
      expect(secondEmptySession.dispose).toHaveBeenCalled();
      expect(retrySession.prompt).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      store.close();
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("can await internal empty-assistant retries before resolving send", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "ambient-runtime-internal-empty-retry-"));
    const store = new ProjectStore();
    try {
      const workspace = store.openWorkspace(workspacePath);
      const created = store.createThread("internal empty retry");
      const threadSessionDir = join(workspace.sessionPath, created.id);
      await mkdir(threadSessionDir, { recursive: true });

      const makeSession = (name: string, finalText: string) => {
        const sessionFile = join(threadSessionDir, `${name}.jsonl`);
        const subscribers: Array<(event: any) => void> = [];
        const emit = (event: any) => {
          for (const subscriber of [...subscribers]) subscriber(event);
        };
        return {
          ...fakePiSession(sessionFile),
          isStreaming: true,
          subscribe: vi.fn((subscriber: (event: any) => void) => {
            subscribers.push(subscriber);
            return () => {
              const index = subscribers.indexOf(subscriber);
              if (index >= 0) subscribers.splice(index, 1);
            };
          }),
          prompt: vi.fn(() => new Promise<void>((resolve) => {
            setTimeout(() => {
              emit({
                type: "message_end",
                message: {
                  role: "assistant",
                  stopReason: "stop",
                  content: finalText ? [{ type: "text", text: finalText }] : [],
                },
              });
              resolve();
            }, 0);
          })),
          steer: vi.fn(async () => undefined),
          compact: vi.fn(async () => undefined),
          agent: {
            abort: vi.fn(),
            waitForIdle: vi.fn(async () => undefined),
          },
        };
      };
      const firstSession = makeSession("empty", "");
      const retrySession = makeSession("retry", "Recovered child result.");
      const runtime = new AgentRuntime(store, {} as any, {} as any, () => undefined, {
        request: vi.fn(),
        denyThread: () => undefined,
      });
      const getSession = vi.spyOn(runtime as any, "getSession")
        .mockResolvedValueOnce(firstSession)
        .mockResolvedValueOnce(retrySession);

      const sendPromise = runtime.send({
        threadId: created.id,
        content: "Return the child result.",
        permissionMode: "workspace",
        collaborationMode: "agent",
        model: "ambient-preview",
        thinkingLevel: "minimal",
        delivery: "prompt",
        context: [],
      }, { awaitInternalRetryCompletion: true });

      await sendPromise;

      const assistantMessages = store.listMessages(created.id).filter((message) => message.role === "assistant");
      expect(assistantMessages.map((message) => message.content)).toEqual([
        "Ambient/Pi returned no assistant text. Retrying assistant finalization attempt 1/10 with a fresh session.",
        "Recovered child result.",
      ]);
      expect(getSession).toHaveBeenCalledTimes(2);
      expect(firstSession.dispose).toHaveBeenCalled();
    } finally {
      store.close();
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("retries a pre-output assistant-start stream stall with a fresh Pi session", async () => {
    vi.useFakeTimers();
    const workspacePath = await mkdtemp(join(tmpdir(), "ambient-runtime-empty-start-stall-retry-"));
    const store = new ProjectStore();
    try {
      const workspace = store.openWorkspace(workspacePath);
      const created = store.createThread("empty assistant start retry");
      const threadSessionDir = join(workspace.sessionPath, created.id);
      await mkdir(threadSessionDir, { recursive: true });
      const firstSessionFile = join(threadSessionDir, "stalled.jsonl");
      const retrySessionFile = join(threadSessionDir, "retry.jsonl");
      await writeFile(firstSessionFile, "", "utf8");
      await writeFile(retrySessionFile, "", "utf8");
      const thread = store.updateThreadSettings(created.id, { piSessionFile: firstSessionFile });
      const retryText = "Brave Search is available; enter BRAVE_API_KEY through Ambient-managed secrets to continue.";

      const firstSubscribers: Array<(event: any) => void> = [];
      let rejectPrompt: ((error: Error) => void) | undefined;
      const emitFirst = (event: any) => {
        for (const subscriber of [...firstSubscribers]) subscriber(event);
      };
      const firstSession = {
        ...fakePiSession(firstSessionFile),
        isStreaming: true,
        subscribe: vi.fn((subscriber: (event: any) => void) => {
          firstSubscribers.push(subscriber);
          return () => {
            const index = firstSubscribers.indexOf(subscriber);
            if (index >= 0) firstSubscribers.splice(index, 1);
          };
        }),
        prompt: vi.fn(() => new Promise<never>((_resolve, reject) => {
          rejectPrompt = reject;
          setTimeout(() => {
            emitFirst({ type: "message_start", message: { role: "assistant" } });
          }, 0);
        })),
        steer: vi.fn(async () => undefined),
        compact: vi.fn(async () => undefined),
        agent: {
          abort: vi.fn(() => {
            emitFirst({
              type: "message_end",
              message: {
                role: "assistant",
                stopReason: "aborted",
                errorMessage: "Request was aborted.",
                content: [{ type: "text", text: "" }],
              },
            });
            rejectPrompt?.(new Error("Request was aborted."));
          }),
          waitForIdle: vi.fn(async () => undefined),
        },
      };

      const retrySubscribers: Array<(event: any) => void> = [];
      const emitRetry = (event: any) => {
        for (const subscriber of [...retrySubscribers]) subscriber(event);
      };
      const retrySession = {
        ...fakePiSession(retrySessionFile),
        isStreaming: true,
        subscribe: vi.fn((subscriber: (event: any) => void) => {
          retrySubscribers.push(subscriber);
          return () => {
            const index = retrySubscribers.indexOf(subscriber);
            if (index >= 0) retrySubscribers.splice(index, 1);
          };
        }),
        prompt: vi.fn(() => new Promise<void>((resolve) => {
          setTimeout(() => {
            emitRetry({ type: "message_start", message: { role: "assistant" } });
            emitRetry({
              type: "message_end",
              message: {
                role: "assistant",
                stopReason: "stop",
                content: [{ type: "text", text: retryText }],
              },
            });
            resolve();
          }, 0);
        })),
        steer: vi.fn(async () => undefined),
        compact: vi.fn(async () => undefined),
        agent: {
          abort: vi.fn(),
          waitForIdle: vi.fn(async () => undefined),
        },
      };

      const runtime = new AgentRuntime(store, {} as any, {} as any, () => undefined, {
        request: vi.fn(),
        denyThread: () => undefined,
      });
      const getSession = vi.spyOn(runtime as any, "getSession")
        .mockResolvedValueOnce(firstSession)
        .mockResolvedValueOnce(retrySession);

      const sendPromise = runtime.send({
        threadId: thread.id,
        content: "Can we add Brave Search as a provider?",
        permissionMode: "full-access",
        collaborationMode: "agent",
        model: "ambient-preview",
        thinkingLevel: "medium",
        delivery: "prompt",
        context: [],
      });

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_000);
      await sendPromise;
      await vi.advanceTimersByTimeAsync(2_000);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await vi.advanceTimersByTimeAsync(1);
        if (store.listMessages(thread.id).some((message) => message.content.includes(retryText))) break;
      }

      const assistantMessages = store.listMessages(thread.id).filter((message) => message.role === "assistant");
      expect(assistantMessages[0]).toMatchObject({
        content: "Ambient/Pi stream stalled before assistant output. Retrying assistant finalization attempt 1/10 with a fresh session.",
        metadata: expect.objectContaining({
          status: "done",
          retryingStreamStall: true,
          piStreamTimeout: expect.objectContaining({
            retryScheduled: true,
            retryUsesFreshSession: true,
            retryAttempt: 1,
            maxRetries: 10,
            retryReason: "pre_output_stream_stall",
            retryDelayMs: 1_000,
            message: "Ambient/Pi stream stalled after 30000ms without stream activity.",
            receivedAnyText: false,
            toolMessageCount: 0,
            currentAssistantFinalTextChars: 0,
            sessionFile: firstSessionFile,
          }),
        }),
      });
      expect(assistantMessages.at(-1)).toMatchObject({
        content: retryText,
        metadata: expect.objectContaining({ status: "done" }),
      });
      expect(getSession).toHaveBeenCalledTimes(2);
      expect(firstSession.agent.abort).toHaveBeenCalledTimes(1);
      expect(firstSession.dispose).toHaveBeenCalled();
      expect(store.getThread(thread.id).piSessionFile).toBe(retrySessionFile);
    } finally {
      vi.useRealTimers();
      store.close();
      await rm(workspacePath, { recursive: true, force: true });
    }
  });
});
