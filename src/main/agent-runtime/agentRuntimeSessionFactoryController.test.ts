import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AMBIENT_DEFAULT_MODEL,
  AMBIENT_GLM_5_2_FP8_MODEL,
  resolveAmbientModelRuntimeProfile,
  type AmbientModelRuntimeProfile,
} from "../../shared/ambientModels";
import type { ThreadSummary } from "../../shared/threadTypes";
import { AgentRuntimeSessionRegistry } from "./agentRuntimeSessionRegistry";
import {
  AgentRuntimeSessionFactoryController,
  type AgentRuntimePiSession,
  type AgentRuntimeSessionFactoryControllerOptions,
} from "./agentRuntimeSessionFactoryController";
import { GMI_CLOUD_GLM_5_2_FP8_MODEL } from "../ambient/gmiCloudModelRouting";

afterEach(() => {
  vi.unstubAllEnvs();
});

function thread(input: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: input.id ?? "thread-1",
    title: "Session factory",
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
    workspacePath: "/workspace",
    kind: "chat",
    permissionMode: "workspace",
    model: input.model ?? AMBIENT_DEFAULT_MODEL,
    thinkingLevel: input.thinkingLevel ?? "medium",
    piSessionFile: input.piSessionFile,
  } as ThreadSummary;
}

function session(input: {
  modelId?: string;
  model?: AgentRuntimePiSession["model"];
  sessionFile?: string;
} = {}): AgentRuntimePiSession {
  return {
    model: input.model ?? (input.modelId ? { id: input.modelId } : undefined),
    sessionFile: input.sessionFile,
    setModel: vi.fn(async () => undefined),
    setThinkingLevel: vi.fn(),
    dispose: vi.fn(),
  } as unknown as AgentRuntimePiSession;
}

function controller(input: {
  sessions?: AgentRuntimeSessionRegistry<AgentRuntimePiSession>;
  currentThread?: ThreadSummary;
  features?: AgentRuntimeSessionFactoryControllerOptions["features"];
  commitThreadPiSessionFile?: AgentRuntimeSessionFactoryControllerOptions["commitThreadPiSessionFile"];
  recordContextUsageSnapshot?: AgentRuntimeSessionFactoryControllerOptions["recordContextUsageSnapshot"];
} = {}): AgentRuntimeSessionFactoryController {
  const sessions = input.sessions ?? new AgentRuntimeSessionRegistry<AgentRuntimePiSession>();
  const currentThread = input.currentThread ?? thread();
  return new AgentRuntimeSessionFactoryController({
    store: {
      getThread: vi.fn(() => currentThread),
    } as unknown as AgentRuntimeSessionFactoryControllerOptions["store"],
    sessions,
    pluginHost: {} as AgentRuntimeSessionFactoryControllerOptions["pluginHost"],
    extensionAssembly: {} as AgentRuntimeSessionFactoryControllerOptions["extensionAssembly"],
    mcpToolOrchestration: {} as AgentRuntimeSessionFactoryControllerOptions["mcpToolOrchestration"],
    providerRuntime: {} as AgentRuntimeSessionFactoryControllerOptions["providerRuntime"],
    features: input.features ?? {},
    ambientCliSkillMountDiagnostics: new Map(),
    tencentMemoryRuntimeSnapshots: new Map(),
    getFeatureFlagSnapshot: vi.fn(() => ({ flags: {} }) as never),
    commitThreadPiSessionFile: input.commitThreadPiSessionFile ?? vi.fn(async () => undefined),
    recordContextUsageSnapshot: input.recordContextUsageSnapshot ?? vi.fn(() => ({}) as never),
    recordUnavailableContextUsageSnapshot: vi.fn(() => ({}) as never),
    resolveToolCallPermission: vi.fn(async () => undefined),
    emit: vi.fn(),
  });
}

describe("AgentRuntimeSessionFactoryController", () => {
  it("reuses an unstale session and reapplies thinking level", async () => {
    const sessions = new AgentRuntimeSessionRegistry<AgentRuntimePiSession>();
    const existing = session({ modelId: AMBIENT_DEFAULT_MODEL, sessionFile: "/sessions/thread-1.jsonl" });
    sessions.set({ threadId: "thread-1", session: existing });
    const runtimeSessionFactory = controller({ sessions });

    const resolved = await runtimeSessionFactory.getSession(thread());

    expect(resolved).toBe(existing);
    expect(existing.setModel).not.toHaveBeenCalled();
    expect(existing.setThinkingLevel).toHaveBeenCalledWith("medium");
    expect(existing.dispose).not.toHaveBeenCalled();
  });

  it("switches a reusable session to the thread model and commits the session file", async () => {
    const sessions = new AgentRuntimeSessionRegistry<AgentRuntimePiSession>();
    const existing = session({ modelId: "old-model", sessionFile: "/sessions/thread-1.jsonl" });
    sessions.set({ threadId: "thread-1", session: existing });
    const commitThreadPiSessionFile = vi.fn(async () => undefined);
    const recordContextUsageSnapshot = vi.fn(() => ({}) as never);
    const currentThread = thread({ piSessionFile: "/sessions/old.jsonl" });
    const runtimeSessionFactory = controller({
      sessions,
      currentThread,
      commitThreadPiSessionFile,
      recordContextUsageSnapshot,
    });

    await runtimeSessionFactory.switchSessionToThreadModel(currentThread, existing);

    expect(existing.setModel).toHaveBeenCalledTimes(1);
    expect(existing.setThinkingLevel).toHaveBeenCalledWith("medium");
    expect(recordContextUsageSnapshot).toHaveBeenCalledWith(
      "thread-1",
      existing,
      "Context usage refreshed after the model changed.",
    );
    expect(commitThreadPiSessionFile).toHaveBeenCalledWith({
      threadId: "thread-1",
      sessionFile: "/sessions/thread-1.jsonl",
      currentPiSessionFile: "/sessions/old.jsonl",
      reason: "model-changed",
      emit: expect.any(Function),
    });
  });

  it("refreshes a reusable session when discovery changes the same model descriptor", async () => {
    const existing = session({
      model: {
        id: "moonshotai/kimi-k2.6",
        name: "moonshotai/kimi-k2.6 (unavailable)",
        contextWindow: 200000,
        maxTokens: 131072,
        input: ["text"],
        compat: {
          supportsDeveloperRole: false,
          zaiToolStream: true,
        },
      } as AgentRuntimePiSession["model"],
      sessionFile: "/sessions/thread-1.jsonl",
    });
    const runtimeSessionFactory = controller({
      features: {
        modelRuntime: {
          resolveModelRuntimeProfile: () => discoveredKimiProfile(),
        },
      },
    });

    await runtimeSessionFactory.switchSessionToThreadModel(
      thread({ model: "moonshotai/kimi-k2.6" }),
      existing,
    );

    expect(existing.setModel).toHaveBeenCalledWith(expect.objectContaining({
      id: "moonshotai/kimi-k2.6",
      name: "Kimi K2.6",
      contextWindow: 262144,
      maxTokens: 32000,
      input: ["text", "image"],
    }));
  });

  it("uses GMI Cloud's GLM request id while preserving the canonical model profile", async () => {
    vi.stubEnv("AMBIENT_PROVIDER", "gmi-cloud");
    vi.stubEnv("GMI_CLOUD_MODEL", "");
    const existing = session({ modelId: "old-model" });
    const currentThread = thread({ model: AMBIENT_GLM_5_2_FP8_MODEL });
    const runtimeSessionFactory = controller({ currentThread });

    await runtimeSessionFactory.switchSessionToThreadModel(currentThread, existing);

    expect(existing.setModel).toHaveBeenCalledWith(expect.objectContaining({
      id: GMI_CLOUD_GLM_5_2_FP8_MODEL,
      name: "GLM 5.2",
      contextWindow: 202752,
      maxTokens: 32000,
    }));
    expect(currentThread.model).toBe(AMBIENT_GLM_5_2_FP8_MODEL);
  });
});

function discoveredKimiProfile(): AmbientModelRuntimeProfile {
  return {
    ...resolveAmbientModelRuntimeProfile(AMBIENT_DEFAULT_MODEL),
    profileId: "ambient:moonshotai/kimi-k2.6",
    modelId: "moonshotai/kimi-k2.6",
    label: "Kimi K2.6",
    supportsVision: true,
  };
}
