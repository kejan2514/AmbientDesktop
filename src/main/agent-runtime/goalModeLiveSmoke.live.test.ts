import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AMBIENT_DEFAULT_MODEL } from "../../shared/ambientModels";
import { AgentRuntime } from "./agentRuntime";
import {
  applyLiveAmbientProviderApiKeyEnv,
  liveAmbientProviderLabel,
  liveAmbientProviderModel,
  readLiveAmbientProviderApiKey,
} from "./agentRuntimeAmbientFacade";
import { ProjectStore } from "./agentRuntimeProjectStoreFacade";

const describeNative = process.env.AMBIENT_TEST_NATIVE === "1" ? describe : describe.skip;
const itLive = process.env.AMBIENT_GOAL_MODE_LIVE === "1" ? it : it.skip;

describeNative("AgentRuntime goal mode live smoke", () => {
  let workspacePath = "";
  let store: ProjectStore;
  let runtime: AgentRuntime | undefined;

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), "ambient-goal-mode-live-"));
    store = new ProjectStore();
    store.openWorkspace(workspacePath);
  });

  afterEach(async () => {
    if (runtime) {
      await runtime.shutdownPluginMcpServers();
      runtime = undefined;
    }
    store.close();
    await rm(workspacePath, { recursive: true, force: true });
  });

  itLive("lets live Pi inspect and complete an active thread goal", async () => {
    applyLiveAmbientProviderApiKeyEnv(readLiveAmbientProviderApiKey({ purpose: "goal mode live smoke" }));
    const thread = store.createThread("Goal mode live smoke");
    const goal = store.createThreadGoalIfAbsent({
      threadId: thread.id,
      objective: "Read the active goal, verify its id, and mark it complete.",
      tokenBudget: 4000,
    });
    runtime = new AgentRuntime(store, {} as any, {} as any, () => undefined, {
      request: async (request) => {
        throw new Error(`Unexpected permission request during goal mode live smoke: ${request.toolName}`);
      },
      denyThread: () => undefined,
    });

    const prompt = [
      "This is a live Ambient Desktop goal mode smoke test.",
      "Do exactly this:",
      "1. Call get_goal once.",
      `2. Confirm the active goal id is ${goal.goalId}.`,
      "3. Call update_goal with status complete.",
      "4. Reply exactly: GOAL_MODE_LIVE_DONE",
      "Do not use any tools other than get_goal and update_goal.",
    ].join("\n");

    await sendWithTimeout({
      runtime,
      store,
      threadId: thread.id,
      timeoutMs: Number(process.env.AMBIENT_GOAL_MODE_LIVE_TIMEOUT_MS ?? 180_000),
      send: runtime.send({
        threadId: thread.id,
        permissionMode: "workspace",
        collaborationMode: "agent",
        model: liveAmbientProviderModel({ fallbackModel: AMBIENT_DEFAULT_MODEL }),
        thinkingLevel: "minimal",
        content: prompt,
      }),
    });

    const toolNames = threadToolNames(store, thread.id);
    const finalGoal = store.getThreadGoal(thread.id);
    const completionMessage = store.listMessages(thread.id).find(
      (message) => message.metadata?.kind === "goal-completion" && message.metadata?.goalId === goal.goalId,
    );
    const transcript = threadTranscript(store, thread.id);
    const assistantText = store
      .listMessages(thread.id)
      .filter((message) => message.role === "assistant")
      .map((message) => message.content)
      .join("\n");
    const report = {
      createdAt: new Date().toISOString(),
      provider: liveAmbientProviderLabel(),
      workspacePath,
      threadId: thread.id,
      goalId: goal.goalId,
      toolNames,
      finalGoal,
      completionMessage,
      assistantText,
      transcript,
    };
    const reportRoot = join(process.cwd(), "test-results", "goal-mode-live-smoke");
    await mkdir(reportRoot, { recursive: true });
    await writeFile(join(reportRoot, "latest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(join(reportRoot, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");

    expect(toolNames).toContain("get_goal");
    expect(toolNames).toContain("update_goal");
    expect(finalGoal).toBeUndefined();
    expect(completionMessage).toMatchObject({
      role: "assistant",
      metadata: expect.objectContaining({
        kind: "goal-completion",
        goalId: goal.goalId,
      }),
    });
    expect(assistantText).toContain("GOAL_MODE_LIVE_DONE");
  }, Number(process.env.AMBIENT_GOAL_MODE_LIVE_TEST_TIMEOUT_MS ?? 240_000));
});

async function sendWithTimeout(input: {
  runtime: AgentRuntime;
  store: ProjectStore;
  threadId: string;
  send: Promise<void>;
  timeoutMs: number;
}): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      void input.runtime.abort(input.threadId).catch(() => undefined);
      reject(new Error(`Goal mode live smoke timed out after ${input.timeoutMs}ms.\n${summarizeThread(input.store, input.threadId)}`));
    }, input.timeoutMs);
  });
  try {
    await Promise.race([input.send, timedOut]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function threadTranscript(store: ProjectStore, threadId: string): string {
  return store
    .listMessages(threadId)
    .map((message) => message.content)
    .join("\n\n--- MESSAGE ---\n\n");
}

function threadToolNames(store: ProjectStore, threadId: string): string[] {
  return store
    .listMessages(threadId)
    .map((message) => (typeof message.metadata?.toolName === "string" ? message.metadata.toolName : undefined))
    .filter((toolName): toolName is string => Boolean(toolName));
}

function summarizeThread(store: ProjectStore, threadId: string): string {
  const messages = store.listMessages(threadId);
  return messages
    .slice(-8)
    .map((message) => {
      const tool = message.metadata?.toolName ? ` tool=${message.metadata.toolName}` : "";
      return `${message.role}${tool}: ${message.content.replace(/\s+/g, " ").slice(0, 600)}`;
    })
    .join("\n");
}
