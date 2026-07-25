import type { DesktopEvent, SendMessageInput } from "../../shared/desktopTypes";
import type { Model } from "@mariozechner/pi-ai";
import type { PlannerPlanArtifact } from "../../shared/plannerTypes";
import type { ChatMessage, ThreadSummary } from "../../shared/threadTypes";
import type {
  AssistantTerminalCleanupDiagnostic,
  AssistantTerminalEventDiagnostic,
} from "./agentRuntimeAssistantTerminalDiagnostics";
import type { AssistantFinalizationRetryReason } from "./agentRuntimeAssistantRetryInput";
import type { RuntimeSendMessageInput } from "./agentRuntimeSendPreparationController";
import type { PiSessionFileCommitReason } from "./agentRuntimeSessionFacade";
import {
  carrySymphonyParentModePolicy,
  carrySymphonyParentModeVerifiedLaunch,
  type SymphonyParentModeVerifiedLaunch,
} from "./agentRuntimeSymphonyParentMode";
import type { SubagentParentControlAbortIntent } from "./tools/agentRuntimeToolMessageMetadata";
import type { RuntimeAssistantMessageController } from "./runtimeAssistantMessageController";
import type { RuntimeQueuedMessageController } from "./runtimeQueuedMessageController";
import {
  handleRuntimePromptFailure,
  type RuntimePromptFailureHandlerInput,
} from "./runtimePromptFailureHandler";
import {
  handleRuntimePromptSuccess,
  type RuntimePromptSuccessHandlerInput,
} from "./runtimePromptSuccessHandler";
import {
  finalizeRuntimeSendAfterRun,
} from "./runtimeSendAfterRun";
import type { RuntimeToolArgumentWatchdog } from "./runtimeToolArgumentWatchdog";
import type { RuntimeToolExecutionWatchdog } from "./runtimeToolExecutionWatchdog";
import type { RuntimeToolMessageController } from "./runtimeToolMessageController";
import {
  ambientModel,
  type AmbientProviderContextOverflow,
} from "./agentRuntimeAmbientFacade";
import { getAmbientProviderStatus, normalizeAmbientBaseUrl } from "./agentRuntimeProviderFacade";

export const PROVIDER_CONTEXT_OVERFLOW_RECOVERY_COMPACTION_INSTRUCTIONS =
  "Compact this session after the provider reported a stricter combined input/output context limit. Preserve the current task, user intent, completed work, relevant files, constraints, decisions, and blockers while removing transcript bulk that can be rediscovered with tools.";

export interface AgentRuntimePromptOutcomeSession {
  sessionFile?: string | undefined;
  model?: Model<"openai-completions">;
  setModel?(model: Model<"openai-completions">): Promise<unknown>;
  compact?(instructions?: string): Promise<unknown>;
}

export interface AgentRuntimePromptOutcomeCommitInput {
  threadId: string;
  sessionFile?: string;
  currentPiSessionFile?: string | null;
  reason: PiSessionFileCommitReason;
  emit: (event: DesktopEvent) => void;
}

export interface AgentRuntimePromptOutcomeControllerOptions {
  getThread: (threadId: string) => ThreadSummary;
  updateThreadSettings: (threadId: string, settings: { piSessionFile?: string | null }) => ThreadSummary;
  replaceMessage: (messageId: string, content: string, metadata: Record<string, unknown>) => ChatMessage;
  commitThreadPiSessionFile: (input: AgentRuntimePromptOutcomeCommitInput) => Promise<ThreadSummary | undefined>;
  recordContextUsageSnapshot: (threadId: string, session: AgentRuntimePromptOutcomeSession) => unknown;
  createPlannerPlanArtifactFromMessage: RuntimePromptSuccessHandlerInput["createPlannerPlanArtifactFromMessage"];
  resolveSubagentFinalizationBlock: (threadId: string, runId: string) => ReturnType<
    RuntimePromptSuccessHandlerInput["resolveSubagentFinalizationBlock"]
  >;
  resolveCallableWorkflowFinalizationBlock: (
    threadId: string,
    runId: string,
    symphonyParentModeVerifiedLaunch?: SymphonyParentModeVerifiedLaunch | undefined,
  ) => ReturnType<RuntimePromptSuccessHandlerInput["resolveCallableWorkflowFinalizationBlock"]>;
  recordSubagentFinalizationBlockedParentMailbox: (
    threadId: string,
    runId: string,
    block: Parameters<RuntimePromptSuccessHandlerInput["recordSubagentFinalizationBlockedParentMailbox"]>[0],
  ) => ReturnType<RuntimePromptSuccessHandlerInput["recordSubagentFinalizationBlockedParentMailbox"]>;
  recordCallableWorkflowFinalizationBlockedParentMailbox: (
    threadId: string,
    runId: string,
    block: Parameters<RuntimePromptSuccessHandlerInput["recordCallableWorkflowFinalizationBlockedParentMailbox"]>[0],
  ) => ReturnType<RuntimePromptSuccessHandlerInput["recordCallableWorkflowFinalizationBlockedParentMailbox"]>;
  suppressCallableWorkflowParentAssistantMessages: RuntimePromptSuccessHandlerInput["suppressCallableWorkflowParentAssistantMessages"];
  recordVoiceDispatch: RuntimePromptSuccessHandlerInput["recordVoiceDispatch"];
  clearActiveRun: (threadId: string) => void;
  clearActiveRunId: (threadId: string) => void;
  clearPermissionWaitControl: (threadId: string) => void;
  clearWorkflowPlanEditIntent: (threadId: string) => void;
  takePendingProjectSwitch: (threadId: string) => unknown;
  updateRuntimeEvent: Parameters<typeof finalizeRuntimeSendAfterRun>[0]["updateRuntimeEvent"];
  scheduleProjectSwitchCompletion: (projectSwitch: unknown, input: { threadId: string; workspacePath: string }) => void;
  getRunRecord: (runId: string) => Parameters<typeof finalizeRuntimeSendAfterRun>[0]["getRunRecord"] extends () => infer RunRecord
    ? RunRecord
    : never;
  accountFinishedGoalRun: Parameters<typeof finalizeRuntimeSendAfterRun>[0]["accountFinishedGoalRun"];
  scheduleGoalContinuation: Parameters<typeof finalizeRuntimeSendAfterRun>[0]["scheduleGoalContinuation"];
  schedulePlannerDurableRepairFollowUp: Parameters<typeof finalizeRuntimeSendAfterRun>[0]["schedulePlannerDurableRepairFollowUp"];
  send: Parameters<typeof finalizeRuntimeSendAfterRun>[0]["send"];
  emitError: (message: string, threadId: string, workspacePath: string) => void;
  learnProviderContextLimit?: (input: {
    modelId: string;
    overflow: AmbientProviderContextOverflow;
  }) => import("../../shared/ambientModels").AmbientModelRuntimeProfile;
}

export interface HandleAgentRuntimePromptSuccessInput {
  sendInput: SendMessageInput;
  runId: string;
  runWorkspacePath: string;
  startedInPlannerMode: boolean;
  session: AgentRuntimePromptOutcomeSession;
  runtimeMessages: RuntimeAssistantMessageController;
  toolMessages: RuntimeToolMessageController;
  plannerFinalizationSources: PlannerPlanArtifact[];
  runtimeError?: string | undefined;
  abortRequested: boolean;
  finalizedAfterToolIdle: boolean;
  currentThinkingFinalText: string;
  currentAssistantFinalText: string;
  receivedAnyText: boolean;
  pendingEmptyResponseRetryDelayMs: number;
  activeRetryReason?: AssistantFinalizationRetryReason | undefined;
  retrySourceUserMessageId?: string | undefined;
  lastAssistantTerminalEvent?: AssistantTerminalEventDiagnostic | undefined;
  assistantTerminalCleanupDiagnostic?: AssistantTerminalCleanupDiagnostic | undefined;
  subagentParentControlAbortIntent?: SubagentParentControlAbortIntent | undefined;
  providerRetryBeforeVisibleOutput: boolean;
  providerRetryRecovered: boolean;
  providerRetryAttemptCount: number;
  providerRetryLastError?: string | undefined;
  usesDedicatedReviewSession: boolean;
  symphonyParentModeVerifiedLaunch?: SymphonyParentModeVerifiedLaunch | undefined;
  assistantFinalizationRetryMaxRetries: number;
  canScheduleAssistantFinalizationRetryFor: (reason: AssistantFinalizationRetryReason) => boolean;
  assistantFinalizationRetryAttemptsUsedFor: (reason: AssistantFinalizationRetryReason) => number;
  assistantFinalizationRetryNextAttemptFor: (reason: AssistantFinalizationRetryReason) => number;
  createAssistantFinalizationRetryInput: (reason: AssistantFinalizationRetryReason) => RuntimeSendMessageInput;
  consumeSubagentParentControlAbort: () => Promise<void>;
  cleanupCurrentSession: () => void;
  finishPlannerFinalizationSources: RuntimePromptSuccessHandlerInput["finishPlannerFinalizationSources"];
  finishParentRun: RuntimePromptSuccessHandlerInput["finishParentRun"];
  emitRunEvent: (event: DesktopEvent) => void;
}

export interface HandleAgentRuntimePromptFailureInput
  extends Omit<
    RuntimePromptFailureHandlerInput,
    | "threadId"
    | "workspacePath"
    | "createInterruptedToolCallRecoveryInput"
    | "createProviderInterruptionContinuationInput"
    | "replaceToolMessage"
  > {
  sendInput: SendMessageInput;
  session?: AgentRuntimePromptOutcomeSession | undefined;
  runId: string;
  runWorkspacePath: string;
  symphonyParentModeVerifiedLaunch?: SymphonyParentModeVerifiedLaunch | undefined;
  createInterruptedToolCallRecoveryInput: RuntimePromptFailureHandlerInput["createInterruptedToolCallRecoveryInput"];
  createProviderInterruptionContinuationInput: RuntimePromptFailureHandlerInput["createProviderInterruptionContinuationInput"];
}

export interface FinalizeAgentRuntimeSendAfterRunInput {
  sendInput: SendMessageInput;
  hooks: { awaitInternalRetryCompletion?: boolean };
  runId: string;
  runWorkspacePath: string;
  runGoalId?: string | undefined;
  runGoalStartedAtMs: number;
  promptContent: string;
  currentAssistantFinalText: string;
  assistantOutputChars: number;
  currentThinkingFinalText: string;
  thinkingOutputChars: number;
  abortRequested: boolean;
  pendingPlannerRepairFollowUp?: SendMessageInput | undefined;
  pendingEmptyResponseRetry?: SendMessageInput | undefined;
  pendingInterruptedToolCallRecoveryFollowUp?: SendMessageInput | undefined;
  pendingProviderInterruptionContinuation?: SendMessageInput | undefined;
  pendingEmptyResponseRetryDelayMs: number;
  usesDedicatedReviewSession: boolean;
  session?: AgentRuntimePromptOutcomeSession | undefined;
  hasWorkflowPlanEditIntent: boolean;
  isRunStoreActive: () => boolean;
  cleanupCurrentSession: () => void;
  emitRunEvent: (event: DesktopEvent) => void;
  toolArgumentWatchdog?: RuntimeToolArgumentWatchdog | undefined;
  toolExecutionWatchdog?: RuntimeToolExecutionWatchdog | undefined;
  queuedMessages: RuntimeQueuedMessageController;
  toolMessages: RuntimeToolMessageController;
  resolveActiveRunSettled?: (() => void) | undefined;
}

export class AgentRuntimePromptOutcomeController {
  constructor(private readonly options: AgentRuntimePromptOutcomeControllerOptions) {}

  async handlePromptFailure(input: HandleAgentRuntimePromptFailureInput): Promise<void> {
    await handleRuntimePromptFailure({
      ...input,
      threadId: input.sendInput.threadId,
      workspacePath: input.runWorkspacePath,
      createInterruptedToolCallRecoveryInput: (snapshots) =>
        carrySymphonyParentModeVerifiedLaunch(
          carrySymphonyParentModePolicy(
            input.createInterruptedToolCallRecoveryInput(snapshots),
            input.symphonyParentModePolicy,
          ),
          input.symphonyParentModeVerifiedLaunch,
        ),
      createProviderInterruptionContinuationInput: (continuationInput) =>
        carrySymphonyParentModeVerifiedLaunch(
          carrySymphonyParentModePolicy(
            input.createProviderInterruptionContinuationInput(continuationInput),
            input.symphonyParentModePolicy,
          ),
          input.symphonyParentModeVerifiedLaunch,
        ),
      replaceToolMessage: (messageId, content, metadata) =>
        this.options.replaceMessage(messageId, content, metadata),
      resolveSubagentFinalizationBlock: () =>
        this.options.resolveSubagentFinalizationBlock(input.sendInput.threadId, input.runId),
      recordSubagentFinalizationBlockedParentMailbox: (block) =>
        this.options.recordSubagentFinalizationBlockedParentMailbox(
          input.sendInput.threadId,
          input.runId,
          block,
        ),
      resolveCallableWorkflowFinalizationBlock: () =>
        this.options.resolveCallableWorkflowFinalizationBlock(
          input.sendInput.threadId,
          input.runId,
          input.symphonyParentModeVerifiedLaunch,
        ),
      recordCallableWorkflowFinalizationBlockedParentMailbox: (block) =>
        this.options.recordCallableWorkflowFinalizationBlockedParentMailbox(
          input.sendInput.threadId,
          input.runId,
          block,
        ),
      suppressCallableWorkflowParentAssistantMessages: this.options.suppressCallableWorkflowParentAssistantMessages,
      getThread: () => this.options.getThread(input.sendInput.threadId),
      recoverProviderContextOverflow:
        this.options.learnProviderContextLimit && input.session?.setModel && input.session.compact
        ? async (overflow) => {
            const thread = this.options.getThread(input.sendInput.threadId);
            const profile = this.options.learnProviderContextLimit!({ modelId: thread.model, overflow });
            const provider = getAmbientProviderStatus(thread.model);
            const model = ambientModel(
              thread.model,
              normalizeAmbientBaseUrl(provider.baseUrl),
              profile,
              { requestModelId: provider.model },
            );
            await input.session!.setModel!(model);
            await input.session!.compact!(PROVIDER_CONTEXT_OVERFLOW_RECOVERY_COMPACTION_INSTRUCTIONS);
            this.options.recordContextUsageSnapshot(input.sendInput.threadId, input.session!);
            return {
              effectiveContextWindowTokens: model.contextWindow,
              requestedOutputTokens: model.maxTokens,
            };
          }
        : undefined,
    });
  }

  async handlePromptSuccess(
    input: HandleAgentRuntimePromptSuccessInput,
  ): Promise<{
    pendingEmptyResponseRetry?: RuntimeSendMessageInput | undefined;
    pendingPlannerRepairFollowUp?: SendMessageInput | undefined;
  }> {
    const emptyAssistantRetryReason: AssistantFinalizationRetryReason = "empty_assistant_response";
    const currentThread = this.options.getThread(input.sendInput.threadId);
    const result = await handleRuntimePromptSuccess({
      threadId: input.sendInput.threadId,
      runId: input.runId,
      workspacePath: input.runWorkspacePath,
      startedInPlannerMode: input.startedInPlannerMode,
      currentAssistantMessageId: input.runtimeMessages.currentAssistantMessageId(),
      runtimeError: input.runtimeError,
      abortRequested: input.abortRequested,
      finalizedAfterToolIdle: input.finalizedAfterToolIdle,
      currentThinkingFinalText: input.currentThinkingFinalText,
      currentAssistantFinalText: input.currentAssistantFinalText,
      currentAssistantVisibleContent: input.runtimeMessages.currentMessageContent(
        input.runtimeMessages.currentAssistantMessageId(),
        input.currentAssistantFinalText,
      ),
      receivedAnyText: input.receivedAnyText,
      activeToolMessageCount: input.toolMessages.size(),
      pendingEmptyResponseRetryDelayMs: input.pendingEmptyResponseRetryDelayMs,
      activeRetryReason: input.activeRetryReason,
      retrySourceUserMessageId: input.retrySourceUserMessageId,
      sessionFile: input.session.sessionFile,
      lastAssistantTerminalEvent: input.lastAssistantTerminalEvent,
      assistantTerminalCleanupDiagnostic: input.assistantTerminalCleanupDiagnostic,
      subagentParentControlAbortIntent: input.subagentParentControlAbortIntent,
      providerRetryBeforeVisibleOutput: input.providerRetryBeforeVisibleOutput,
      providerRetryRecovered: input.providerRetryRecovered,
      providerRetryAttemptCount: input.providerRetryAttemptCount,
      providerRetryLastError: input.providerRetryLastError,
      usesDedicatedReviewSession: input.usesDedicatedReviewSession,
      currentThreadPiSessionFile: currentThread.piSessionFile,
      hasPlannerFinalizationSources: input.plannerFinalizationSources.length > 0,
      assistantFinalizationRetryMaxRetries: input.assistantFinalizationRetryMaxRetries,
      canScheduleEmptyAssistantRetry: input.canScheduleAssistantFinalizationRetryFor(emptyAssistantRetryReason),
      emptyAssistantRetryAttemptsUsed: input.assistantFinalizationRetryAttemptsUsedFor(emptyAssistantRetryReason),
      emptyAssistantRetryNextAttempt: input.assistantFinalizationRetryNextAttemptFor(emptyAssistantRetryReason),
      consumeSubagentParentControlAbort: input.consumeSubagentParentControlAbort,
      currentPromptCacheTelemetry: input.runtimeMessages.currentPromptCacheTelemetry,
      completePromptCacheTelemetryIfPending: input.runtimeMessages.completePromptCacheTelemetryIfPending,
      finishCurrentThinkingMessage: input.runtimeMessages.finishCurrentThinkingMessage,
      suppressAssistantMessagesExceptCurrent: input.runtimeMessages.suppressAssistantMessagesExceptCurrent,
      suppressCurrentThinkingMessage: input.runtimeMessages.suppressCurrentThinkingMessage,
      recordContextUsageSnapshot: () => this.options.recordContextUsageSnapshot(input.sendInput.threadId, input.session),
      cleanupCurrentSession: input.cleanupCurrentSession,
      createEmptyAssistantRetry: () => input.createAssistantFinalizationRetryInput(emptyAssistantRetryReason),
      clearThreadPiSessionFile: () => {
        input.emitRunEvent({
          type: "thread-updated",
          thread: this.options.updateThreadSettings(input.sendInput.threadId, { piSessionFile: null }),
        });
      },
      commitThreadPiSessionFile: async (commitInput) => {
        await this.options.commitThreadPiSessionFile({
          threadId: input.sendInput.threadId,
          sessionFile: commitInput.sessionFile,
          currentPiSessionFile: commitInput.currentPiSessionFile,
          reason: commitInput.reason,
          emit: input.emitRunEvent,
        });
      },
      createPlannerRepairFollowUp: (prompt) => {
        const repairThread = this.options.getThread(input.sendInput.threadId);
        return {
          threadId: input.sendInput.threadId,
          content: prompt,
          permissionMode: repairThread.permissionMode,
          collaborationMode: "planner",
          model: repairThread.model,
          thinkingLevel: repairThread.thinkingLevel,
          delivery: "follow-up",
          preserveActiveThread: true,
        };
      },
      resolveSubagentFinalizationBlock: () =>
        this.options.resolveSubagentFinalizationBlock(input.sendInput.threadId, input.runId),
      resolveCallableWorkflowFinalizationBlock: () =>
        this.options.resolveCallableWorkflowFinalizationBlock(
          input.sendInput.threadId,
          input.runId,
          input.symphonyParentModeVerifiedLaunch,
        ),
      recordSubagentFinalizationBlockedParentMailbox: (block) =>
        this.options.recordSubagentFinalizationBlockedParentMailbox(input.sendInput.threadId, input.runId, block),
      recordCallableWorkflowFinalizationBlockedParentMailbox: (block) =>
        this.options.recordCallableWorkflowFinalizationBlockedParentMailbox(input.sendInput.threadId, input.runId, block),
      suppressCallableWorkflowParentAssistantMessages: this.options.suppressCallableWorkflowParentAssistantMessages,
      replaceAssistantMessage: (messageId, content, metadata) => this.options.replaceMessage(messageId, content, metadata),
      createPlannerPlanArtifactFromMessage: (message, options) => this.options.createPlannerPlanArtifactFromMessage(message, options),
      finishPlannerFinalizationSources: input.finishPlannerFinalizationSources,
      finishParentRun: input.finishParentRun,
      recordVoiceDispatch: this.options.recordVoiceDispatch,
      getThread: () => this.options.getThread(input.sendInput.threadId),
      emitRunEvent: input.emitRunEvent,
    });
    return {
      pendingEmptyResponseRetry: result.pendingEmptyResponseRetry as RuntimeSendMessageInput | undefined,
      pendingPlannerRepairFollowUp: result.pendingPlannerRepairFollowUp,
    };
  }

  async finalizeSendAfterRun(input: FinalizeAgentRuntimeSendAfterRunInput): Promise<void> {
    await finalizeRuntimeSendAfterRun({
      threadId: input.sendInput.threadId,
      workspacePath: input.runWorkspacePath,
      runGoalId: input.runGoalId,
      runGoalStartedAtMs: input.runGoalStartedAtMs,
      promptChars: input.promptContent.length,
      assistantChars: input.currentAssistantFinalText.length + input.assistantOutputChars,
      thinkingChars: input.currentThinkingFinalText.length + input.thinkingOutputChars,
      toolMessageCount: input.toolMessages.size(),
      abortRequested: input.abortRequested,
      pendingPlannerRepairFollowUp: input.pendingPlannerRepairFollowUp,
      pendingInterruptedToolCallRecoveryFollowUp: input.pendingInterruptedToolCallRecoveryFollowUp,
      pendingProviderInterruptionContinuation: input.pendingProviderInterruptionContinuation,
      pendingEmptyResponseRetry: input.pendingEmptyResponseRetry,
      pendingEmptyResponseRetryDelayMs: input.pendingEmptyResponseRetryDelayMs,
      awaitInternalRetryCompletion: Boolean(input.hooks.awaitInternalRetryCompletion),
      hasWorkflowPlanEditIntent: input.hasWorkflowPlanEditIntent,
      hasDedicatedReviewSession: input.usesDedicatedReviewSession && Boolean(input.session),
      isRunStoreActive: input.isRunStoreActive,
      clearActiveRun: () => this.options.clearActiveRun(input.sendInput.threadId),
      clearActiveRunId: () => this.options.clearActiveRunId(input.sendInput.threadId),
      clearPermissionWaitControl: () => this.options.clearPermissionWaitControl(input.sendInput.threadId),
      clearToolArgumentWatchdog: () => {
        input.toolArgumentWatchdog?.clear();
      },
      clearToolExecutionWatchdog: () => {
        input.toolExecutionWatchdog?.clear();
      },
      cleanupDedicatedReviewSession: input.cleanupCurrentSession,
      clearWorkflowPlanEditIntent: () => this.options.clearWorkflowPlanEditIntent(input.sendInput.threadId),
      takePendingProjectSwitch: () => this.options.takePendingProjectSwitch(input.sendInput.threadId) as ReturnType<
        Parameters<typeof finalizeRuntimeSendAfterRun>[0]["takePendingProjectSwitch"]
      >,
      updateRuntimeEvent: this.options.updateRuntimeEvent,
      scheduleProjectSwitchCompletion: (projectSwitch) => {
        this.options.scheduleProjectSwitchCompletion(projectSwitch, {
          threadId: input.sendInput.threadId,
          workspacePath: input.runWorkspacePath,
        });
      },
      getRunRecord: () => this.options.getRunRecord(input.runId),
      hasQueuedUserInput: () => input.queuedMessages.hasQueuedOrSentInput(),
      accountFinishedGoalRun: this.options.accountFinishedGoalRun,
      scheduleGoalContinuation: this.options.scheduleGoalContinuation,
      schedulePlannerDurableRepairFollowUp: this.options.schedulePlannerDurableRepairFollowUp,
      send: this.options.send,
      emitError: this.options.emitError,
      emitRunEvent: input.emitRunEvent,
      resolveActiveRunSettled: () => {
        input.resolveActiveRunSettled?.();
      },
    });
  }
}
