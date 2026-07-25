import { existsSync } from "node:fs";

import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

import type { BrowserCapabilityState } from "../../shared/browserTypes";
import type { ContextUsageSnapshot, ThreadSummary } from "../../shared/threadTypes";
import type { WorkspaceState } from "../../shared/workspaceTypes";
import type {
  AmbientModelReasoningCapability,
  AmbientModelRuntimeCatalog,
  AmbientModelRuntimeProfile,
} from "../../shared/ambientModels";
import {
  ambientModel,
  createAmbientProviderExtension,
  createAmbientToolRouterResultStatusExtension,
} from "./agentRuntimeAmbientFacade";
import { createAmbientCompactionSummaryExtension as createAmbientCompactionSummaryToolsExtension } from "./agentRuntimeCompactionSummaryExtension";
import {
  createContextAccountingExtension as createContextAccountingToolsExtension,
  type ContextAccountingSession,
  type ContextAccountingTokenCount,
} from "./agentRuntimeContextAccountingExtension";
import {
  contextUsageCompactionStatsFromEntries,
} from "./agentRuntimeContextUsageSnapshot";
import { createModelReasoningPayloadExtension as createModelReasoningPayloadToolsExtension } from "./agentRuntimeModelReasoningExtension";
import { createModelStatusToolExtension as createModelStatusToolsExtension } from "./agentRuntimeModelStatusTools";
import { createAmbientProductContextExtension } from "./agentRuntimeProductContextTools";
import {
  createProviderCallContextPreflightExtension as createProviderCallContextPreflightToolsExtension,
} from "./agentRuntimeProviderContextPreflight";
import { getAmbientProviderStatus, normalizeAmbientBaseUrl } from "./agentRuntimeProviderFacade";
import type { ProjectStore } from "./agentRuntimeProjectStoreFacade";
import type { AmbientProviderTransportChannel } from "../ambient/ambientProviderTransportActivity";

type ModelContextSession = ContextAccountingSession & {
  model?: { contextWindow?: number; maxTokens?: number };
};

export interface AgentRuntimeModelContextControllerOptions {
  store: ProjectStore;
  getActiveSession: (threadId: string) => ModelContextSession | undefined;
  getBrowserState: () => BrowserCapabilityState | Promise<BrowserCapabilityState | undefined> | undefined;
  countSerializedPayload: (payload: unknown, fallbackTokens?: number) => Promise<ContextAccountingTokenCount>;
  recordContextUsageSnapshot: (snapshot: Omit<ContextUsageSnapshot, "updatedAt">) => ContextUsageSnapshot;
  emitContextUsageUpdated: (snapshot: ContextUsageSnapshot) => void;
  modelRuntimeCatalog?: (generatedAt?: string) => AmbientModelRuntimeCatalog;
  resolveModelRuntimeProfile?: (modelId?: string) => AmbientModelRuntimeProfile | undefined;
  modelReasoningEvidencePath?: () => string | undefined;
  fileExists?: (path: string) => boolean;
}

export interface AgentRuntimeModelContextExtensionFactoriesInput {
  thread: ThreadSummary;
  workspace: WorkspaceState;
  model: Model<"openai-completions">;
  modelProfile?: AmbientModelRuntimeProfile;
  apiKey?: string;
  getRunningModel?: () => Model<"openai-completions"> | undefined;
  providerTransportChannel?: AmbientProviderTransportChannel;
}

export class AgentRuntimeModelContextController {
  constructor(private readonly options: AgentRuntimeModelContextControllerOptions) {}

  createModelContextExtensionFactories(input: AgentRuntimeModelContextExtensionFactoriesInput): ExtensionFactory[] {
    return [
      createAmbientProviderExtension(input.model),
      createAmbientToolRouterResultStatusExtension(),
      createAmbientProductContextExtension(),
      this.createModelStatusToolExtension(input),
      this.createAmbientCompactionSummaryExtension(input.thread.id, input.workspace, input.model, input.apiKey),
      this.createProviderCallContextPreflightExtension(input.thread.id, input.workspace.path, input.model),
      this.createModelReasoningPayloadExtension(input.thread.id, input.model, input.modelProfile),
      this.createContextAccountingExtension(
        input.thread.id,
        input.model,
        input.providerTransportChannel,
        input.getRunningModel,
      ),
    ];
  }

  createProviderCallContextPreflightExtension(
    threadId: string,
    workspacePath: string,
    model: Model<"openai-completions">,
  ): ExtensionFactory {
    const compactionSettings = this.options.store.getCompactionSettings();
    return createProviderCallContextPreflightToolsExtension({
      workspacePath,
      contextWindow: model.contextWindow,
      getContextWindow: () => this.currentProviderContextWindow(threadId, model.contextWindow),
      requestedOutputTokens: model.maxTokens,
      reserveTokens: compactionSettings.reserveTokens,
      hardPreflightPercent: compactionSettings.hardPreflightPercent,
    });
  }

  createModelReasoningPayloadExtension(
    threadId: string,
    model: Model<"openai-completions">,
    modelProfile?: AmbientModelRuntimeProfile,
  ): ExtensionFactory {
    return createModelReasoningPayloadToolsExtension({
      modelId: model.id,
      getThinkingLevel: () => this.options.store.getThread(threadId).thinkingLevel,
      resolveReasoningCapability: (modelId) => this.resolveReasoningCapability(modelId, modelProfile),
      evidencePath: this.options.modelReasoningEvidencePath?.() ?? process.env.AMBIENT_MODEL_REASONING_EVIDENCE_PATH,
    });
  }

  createContextAccountingExtension(
    threadId: string,
    model: Model<"openai-completions">,
    providerTransportChannel?: AmbientProviderTransportChannel,
    getRunningModel?: () => Model<"openai-completions"> | undefined,
  ): ExtensionFactory {
    return createContextAccountingToolsExtension({
      threadId,
      modelId: model.id,
      contextWindow: model.contextWindow,
      getRunningModel,
      getActiveSession: (id) => this.options.getActiveSession(id),
      compactionStatsFromEntries: (entries) => contextUsageCompactionStatsFromEntries(entries),
      countSerializedPayload: (payload, fallbackTokens) => this.options.countSerializedPayload(payload, fallbackTokens),
      recordContextUsageSnapshot: (snapshot) => this.options.recordContextUsageSnapshot(snapshot),
      emitContextUsageUpdated: (snapshot) => this.options.emitContextUsageUpdated(snapshot),
      onProviderRequestPrepared: ({ inputTokens }) => {
        providerTransportChannel?.publish({ kind: "request_prepared", inputTokens });
      },
      fileExists: this.options.fileExists ?? existsSync,
    });
  }

  private createModelStatusToolExtension(input: AgentRuntimeModelContextExtensionFactoriesInput): ExtensionFactory {
    return createModelStatusToolsExtension({
      requestedModelId: () => this.options.store.getThread(input.thread.id)?.model ?? input.thread.model,
      thinkingLevel: () => this.options.store.getThread(input.thread.id)?.thinkingLevel ?? input.thread.thinkingLevel,
      runningModel: () => input.getRunningModel?.() ?? input.model,
      providerStatus: () => {
        const runningModel = input.getRunningModel?.();
        const requestedModelId = this.options.store.getThread(input.thread.id)?.model ?? input.thread.model;
        return getAmbientProviderStatus(runningModel?.id ?? requestedModelId);
      },
      modelRuntimeCatalog: () => this.options.modelRuntimeCatalog?.() ?? this.options.store.getModelRuntimeCatalog(),
    });
  }

  private createAmbientCompactionSummaryExtension(
    threadId: string,
    workspace: WorkspaceState,
    model: Model<"openai-completions">,
    apiKey: string | undefined,
  ): ExtensionFactory {
    const compactionSettings = this.options.store.getCompactionSettings();
    return createAmbientCompactionSummaryToolsExtension({
      threadId,
      workspace,
      model,
      apiKey,
      getThread: (id) => this.options.store.getThread(id),
      listMessages: (id) => this.options.store.listMessages(id),
      getBrowserState: () => this.options.getBrowserState(),
      providerContextPreflight: {
        reserveTokens: compactionSettings.reserveTokens,
        hardPreflightPercent: compactionSettings.hardPreflightPercent,
      },
    });
  }

  private currentProviderContextWindow(threadId: string, fallback: number): number {
    const sessionContextWindow = this.options.getActiveSession(threadId)?.model?.contextWindow;
    if (typeof sessionContextWindow === "number" && Number.isFinite(sessionContextWindow) && sessionContextWindow > 0) {
      return sessionContextWindow;
    }
    try {
      const thread = this.options.store.getThread(threadId);
      const provider = getAmbientProviderStatus(thread.model);
      return ambientModel(
        thread.model,
        normalizeAmbientBaseUrl(provider.baseUrl),
        this.options.resolveModelRuntimeProfile?.(thread.model),
      ).contextWindow;
    } catch {
      return fallback;
    }
  }

  private resolveReasoningCapability(
    modelId?: string,
    fallbackProfile?: AmbientModelRuntimeProfile,
  ): AmbientModelReasoningCapability | undefined {
    const resolved = this.options.resolveModelRuntimeProfile?.(modelId)?.reasoningCapability;
    if (resolved) return resolved;
    if (!fallbackProfile || fallbackProfile.modelId !== modelId) return undefined;
    return fallbackProfile.reasoningCapability;
  }
}
