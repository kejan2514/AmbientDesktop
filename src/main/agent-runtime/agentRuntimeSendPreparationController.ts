import {
  DEFAULT_MODEL_RUNTIME_PROVIDER_PRE_STREAM_TIMEOUT_MS,
  DEFAULT_MODEL_RUNTIME_PROVIDER_STREAM_IDLE_TIMEOUT_MS,
} from "../../shared/modelRuntimeSettings";
import type { DesktopEvent, SendMessageInput } from "../../shared/desktopTypes";
import type { AmbientFeatureFlagSnapshot } from "../../shared/featureFlags";
import { isAmbientSubagentsEnabled } from "../../shared/featureFlags";
import type { PlannerPlanArtifact } from "../../shared/plannerTypes";
import type { ChatMessage, ModelRuntimeSettings, RuntimeContinuationSource, ThreadSummary } from "../../shared/threadTypes";
import type { SearchRoutingSettings } from "../../shared/webResearchTypes";
import { classifyWorkflowPlanEditIntent, type WorkflowPlanEditIntentKind } from "../../shared/workflowThreadPlanEdit";
import type {
  AssistantFinalizationRetryState,
  RuntimeSessionRecoveryContext,
} from "./agentRuntimeAssistantRetryInput";
import type { InterruptedToolCallRecoveryState } from "./agentRuntimeInterruptedToolRecoveryInput";
import { assistantFinalizationRetryMaxRetriesFromSettings } from "./agentRuntimeRetrySettings";
import { appendMcpInstallRouteGuidance } from "./agentRuntimeInstallRouteGuard";
import { agentRuntimeUserMessageMetadata } from "./agentRuntimeUserMessageMetadata";
import { goalRuntimeActivity } from "./agentRuntimeGoalRuntime";
import { hasRuntimeThreadSettingsUpdate, runtimeThreadSettingsUpdateFromSendInput } from "./agentRuntimeThreadSettingsUpdate";
import type { ProjectStore } from "./agentRuntimeProjectStoreFacade";
import { modelContentForAgentRuntimeSendInput } from "./agentRuntimeSendContent";
import { appendSearchRoutingGuidance } from "./agentRuntimeWebResearchFacade";
import type {
  SymphonyParentModePolicy,
  SymphonyParentModeVerifiedLaunch,
} from "./agentRuntimeSymphonyParentMode";

export type RuntimeSendMessageInput = SendMessageInput & {
  internal?: true;
  assistantFinalizationRetry?: AssistantFinalizationRetryState;
  interruptedToolCallRecovery?: InterruptedToolCallRecoveryState;
  sessionRecovery?: RuntimeSessionRecoveryContext;
  dedicatedSessionKind?: "workflow-recording-review";
  modelContentOverride?: string;
  visibleUserContent?: string;
  hiddenUserMessage?: true;
  continuationSource?: RuntimeContinuationSource;
  goalContinuation?: { goalId: string };
  symphonyParentModePolicy?: SymphonyParentModePolicy | undefined;
  symphonyParentModeVerifiedLaunch?: SymphonyParentModeVerifiedLaunch | undefined;
};

export interface RuntimeSendLoopContext {
  runtimeInput: RuntimeSendMessageInput;
  usesDedicatedReviewSession: boolean;
  visibleUserContent: string;
  hasWorkflowPlanEditIntent: boolean;
  thread: ThreadSummary;
  plannerFinalizationSources: PlannerPlanArtifact[];
  runWorkspacePath: string;
  modelRuntimeSettingsForRun: ModelRuntimeSettings;
  piPreStreamTimeoutMs: number;
  piStreamIdleTimeoutMs: number;
  defaultToolExecutionIdleTimeoutMs: number;
  emptyAssistantStallTimeoutMs: number;
  promptContent: string;
  shouldInjectBootstrap: boolean;
  retrySourceUserMessageId?: string;
  activeAssistantFinalizationRetry?: AssistantFinalizationRetryState;
  assistantFinalizationRetryMaxRetries: number;
  interruptedToolCallRecoveryMaxRetries: number;
  interruptedToolCallRecoveryAttemptsUsed: number;
  canScheduleInterruptedToolCallRecovery: boolean;
}

export interface AgentRuntimeSendPreparationControllerOptions {
  store: Pick<
    ProjectStore,
    | "addMessage"
    | "countMessages"
    | "getMessage"
    | "getModelRuntimeSettings"
    | "getThread"
    | "getWorkflowAgentThreadSummary"
    | "getWorkspace"
    | "markThreadRead"
    | "updateThreadSettings"
  >;
  getFeatureFlagSnapshot: () => AmbientFeatureFlagSnapshot;
  readSearchSettings?: () => SearchRoutingSettings | undefined;
  plannerFinalizationSourceArtifactsForPrompt: (threadId: string, prompt: string) => PlannerPlanArtifact[];
  deletePendingProjectSwitch: (threadId: string) => void;
  setWorkflowPlanEditIntent: (threadId: string, intent: WorkflowPlanEditIntentKind, workflowThreadId: string) => void;
  generateTitleIfNeeded: (thread: ThreadSummary, prompt: string) => void;
  emit: (event: DesktopEvent) => void;
  workflowRecordingReviewStreamIdleTimeoutMs: number;
  chatPiEmptyAssistantStallTimeoutMs: number;
  defaultInterruptedToolCallRecoveryMaxRetries: number;
  localToolIdleTimeoutMs: () => number;
}

export class AgentRuntimeSendPreparationController {
  constructor(private readonly options: AgentRuntimeSendPreparationControllerOptions) {}

  modelContentForSendInput(input: SendMessageInput): string {
    return modelContentForAgentRuntimeSendInput(input, {
      isSubagentsEnabled: () => isAmbientSubagentsEnabled(this.options.getFeatureFlagSnapshot()),
      getFeatureFlagSnapshot: () => this.options.getFeatureFlagSnapshot(),
      getWorkflowAgentThreadSummary: (workflowThreadId) =>
        this.options.store.getWorkflowAgentThreadSummary(workflowThreadId),
    });
  }

  prepareRuntimeSendLoopContext(input: SendMessageInput): RuntimeSendLoopContext {
    const runtimeInput = input as RuntimeSendMessageInput;
    const usesDedicatedReviewSession = runtimeInput.dedicatedSessionKind === "workflow-recording-review";
    const visibleUserContent = runtimeInput.visibleUserContent ?? input.content;

    this.options.deletePendingProjectSwitch(input.threadId);
    const workflowPlanEditIntent = input.workflowThreadId ? classifyWorkflowPlanEditIntent(input.content) : undefined;
    if (workflowPlanEditIntent) {
      this.options.setWorkflowPlanEditIntent(input.threadId, workflowPlanEditIntent.kind, input.workflowThreadId!);
    }

    const threadSettingsUpdate = runtimeThreadSettingsUpdateFromSendInput(input);
    const thread = hasRuntimeThreadSettingsUpdate(threadSettingsUpdate)
      ? this.options.store.updateThreadSettings(input.threadId, threadSettingsUpdate)
      : this.options.store.getThread(input.threadId);
    const plannerFinalizationSources = this.options.plannerFinalizationSourceArtifactsForPrompt(thread.id, input.content);
    const runWorkspacePath = this.options.store.getWorkspace().path;
    const modelRuntimeSettingsForRun = usesDedicatedReviewSession
      ? { ...this.options.store.getModelRuntimeSettings(), aggressiveRetries: true }
      : this.options.store.getModelRuntimeSettings();
    const piPreStreamTimeoutMs = usesDedicatedReviewSession
      ? this.options.workflowRecordingReviewStreamIdleTimeoutMs
      : modelRuntimeSettingsForRun.providerPreStreamTimeoutMs ?? DEFAULT_MODEL_RUNTIME_PROVIDER_PRE_STREAM_TIMEOUT_MS;
    const piStreamIdleTimeoutMs = usesDedicatedReviewSession
      ? this.options.workflowRecordingReviewStreamIdleTimeoutMs
      : modelRuntimeSettingsForRun.providerStreamIdleTimeoutMs ?? DEFAULT_MODEL_RUNTIME_PROVIDER_STREAM_IDLE_TIMEOUT_MS;
    const defaultToolExecutionIdleTimeoutMs = this.options.localToolIdleTimeoutMs();
    const emptyAssistantStallTimeoutMs = Math.max(
      this.options.chatPiEmptyAssistantStallTimeoutMs,
      piStreamIdleTimeoutMs,
    );
    const configuredAssistantFinalizationRetryMaxRetries = assistantFinalizationRetryMaxRetriesFromSettings(
      modelRuntimeSettingsForRun,
    );
    const retryUserMessage = input.retryOfMessageId
      ? this.retryTargetMessage(input.threadId, input.retryOfMessageId)
      : undefined;
    if (input.retryOfMessageId && (!retryUserMessage || retryUserMessage.role !== "user")) {
      throw new Error("Retry target user message was not found.");
    }

    let promptContent = runtimeInput.modelContentOverride ?? this.modelContentForSendInput(input);
    if (!usesDedicatedReviewSession) promptContent = appendSearchRoutingGuidance(promptContent, this.options.readSearchSettings?.());
    if (!usesDedicatedReviewSession) promptContent = appendMcpInstallRouteGuidance(promptContent, visibleUserContent);
    const shouldInjectBootstrap =
      !input.retryOfMessageId && this.options.store.countMessages(input.threadId) === 0 && input.delivery !== "follow-up";
    let retrySourceUserMessageId = retryUserMessage?.id;

    if (retryUserMessage) {
      this.options.emit({ type: "thread-updated", thread: this.options.store.markThreadRead(input.threadId) });
    } else if (runtimeInput.hiddenUserMessage) {
      const userMessage = this.options.store.addMessage({
        threadId: input.threadId,
        role: "user",
        content: promptContent,
        metadata: {
          ...(agentRuntimeUserMessageMetadata(input, { dedicatedSessionKind: runtimeInput.dedicatedSessionKind }) ?? {}),
          runtime: "ambient-internal",
          kind: "hidden-user-message",
          hiddenFromTranscript: true,
          hiddenUserMessage: true,
          visibleUserContent,
          continuationSource: hiddenContinuationSource(runtimeInput),
          ...(runtimeInput.goalContinuation?.goalId ? { goalId: runtimeInput.goalContinuation.goalId } : {}),
        },
      });
      retrySourceUserMessageId = userMessage.id;
      this.options.emit({ type: "message-created", message: userMessage });
      this.options.emit({
        type: "runtime-activity",
        activity: goalRuntimeActivity({
          threadId: input.threadId,
          status: "continuing",
          message: visibleUserContent,
          goalId: runtimeInput.goalContinuation?.goalId,
          continuationSource: hiddenContinuationSource(runtimeInput),
        }),
      });
    } else {
      const userMessage = this.options.store.addMessage({
        threadId: input.threadId,
        role: "user",
        content: visibleUserContent,
        metadata: agentRuntimeUserMessageMetadata(input, { dedicatedSessionKind: runtimeInput.dedicatedSessionKind }),
      });
      retrySourceUserMessageId = userMessage.id;
      this.options.emit({ type: "message-created", message: userMessage });
      this.options.emit({ type: "thread-updated", thread: this.options.store.markThreadRead(input.threadId) });
      this.options.generateTitleIfNeeded(thread, visibleUserContent);
    }

    const activeAssistantFinalizationRetry =
      runtimeInput.assistantFinalizationRetry?.sourceUserMessageId === retrySourceUserMessageId
        ? runtimeInput.assistantFinalizationRetry
        : undefined;
    const assistantFinalizationRetryMaxRetries = Math.max(
      configuredAssistantFinalizationRetryMaxRetries,
      activeAssistantFinalizationRetry?.maxRetries ?? 0,
    );
    const interruptedToolCallRecoveryMaxRetries =
      runtimeInput.interruptedToolCallRecovery?.maxRetries ?? this.options.defaultInterruptedToolCallRecoveryMaxRetries;
    const interruptedToolCallRecoveryAttemptsUsed = Math.min(
      runtimeInput.interruptedToolCallRecovery?.attempt ?? 0,
      interruptedToolCallRecoveryMaxRetries,
    );
    const canScheduleInterruptedToolCallRecovery =
      !usesDedicatedReviewSession && interruptedToolCallRecoveryAttemptsUsed < interruptedToolCallRecoveryMaxRetries;

    return {
      runtimeInput,
      usesDedicatedReviewSession,
      visibleUserContent,
      hasWorkflowPlanEditIntent: Boolean(workflowPlanEditIntent),
      thread,
      plannerFinalizationSources,
      runWorkspacePath,
      modelRuntimeSettingsForRun,
      piPreStreamTimeoutMs,
      piStreamIdleTimeoutMs,
      defaultToolExecutionIdleTimeoutMs,
      emptyAssistantStallTimeoutMs,
      promptContent,
      shouldInjectBootstrap,
      retrySourceUserMessageId,
      activeAssistantFinalizationRetry,
      assistantFinalizationRetryMaxRetries,
      interruptedToolCallRecoveryMaxRetries,
      interruptedToolCallRecoveryAttemptsUsed,
      canScheduleInterruptedToolCallRecovery,
    };
  }

  private retryTargetMessage(threadId: string, messageId: string): ChatMessage | undefined {
    try {
      const message = this.options.store.getMessage(messageId);
      return message.threadId === threadId ? message : undefined;
    } catch {
      return undefined;
    }
  }
}

function hiddenContinuationSource(input: RuntimeSendMessageInput): RuntimeContinuationSource {
  if (input.continuationSource) return input.continuationSource;
  if (input.goalContinuation?.goalId) return "goal-continuation";
  return "post-tool-continuation";
}
