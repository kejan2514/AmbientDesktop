import type { DesktopEvent, SendMessageInput } from "../../shared/desktopTypes";
import type {
  ChatMessage,
  InterruptedToolCallRecoverySnapshot,
  ProviderContinuationState,
  ThreadSummary,
  ToolArgumentProgressSnapshot,
} from "../../shared/threadTypes";
import type {
  AssistantFinalizationRetryReason,
  AssistantFinalizationRetryState,
  RuntimeSessionRecoveryContext,
} from "./agentRuntimeAssistantRetryInput";
import type { AmbientStreamFailureKind } from "./agentRuntimeAmbientFacade";
import type { AmbientProviderContextOverflow } from "./agentRuntimeAmbientFacade";
import type { RuntimeProviderErrorDiagnostic } from "./provider-continuation/agentRuntimeProviderDiagnostics";
import type { ProviderInterruptionToolSnapshot } from "./provider-continuation/agentRuntimeProviderContinuationHelpers";
import type { ChatStreamInterruptionDiagnostic } from "./agentRuntimeSendStreamDiagnostics";
import type { SubagentParentControlAbortIntent } from "./tools/agentRuntimeToolMessageMetadata";
import type { RuntimeOpenToolFailureReason } from "./openToolFailureUpdates";
import type { CallableWorkflowParentBlockingBlock } from "./agentRuntimeCallableWorkflowFacade";
import type { RuntimeAssistantMessageController } from "./runtimeAssistantMessageController";
import type { RuntimeToolMessageController } from "./runtimeToolMessageController";
import type { PiSessionFileCommitReason } from "./agentRuntimeSessionFacade";
import type { SymphonyParentModePolicy } from "./agentRuntimeSymphonyParentMode";
import type { SubagentFinalizationBarrierBlock } from "./agentRuntimeFinalizationBlocking";

export interface RuntimePromptFailureToolArgumentProgress {
  current(toolCallId: string): ToolArgumentProgressSnapshot | undefined;
}

export interface RuntimePromptFailureInterruptedToolRecovery {
  recoverable(): InterruptedToolCallRecoverySnapshot[];
}

export type RuntimePromptFailureRetryInputFactory = (
  reason: AssistantFinalizationRetryReason,
  sessionRecovery?: RuntimeSessionRecoveryContext,
) => SendMessageInput;

export interface RuntimePromptFailureProviderContinuationStateInput {
  message: string;
  kind: AmbientStreamFailureKind;
  retryScheduled: boolean;
  replaySafe: boolean;
  continuationSafe?: boolean;
  retryUsesFreshSession?: boolean;
  retryAttempt?: number;
  maxRetries?: number;
  retryReason?: string;
  retryDelayMs?: number;
  openToolCalls?: ProviderInterruptionToolSnapshot[];
  completedToolMessageCount: number;
  receivedAnyText?: boolean;
  stateId?: string;
}

export interface RuntimePromptFailureHandlerInput {
  error: unknown;
  threadId: string;
  workspacePath: string;
  usesDedicatedReviewSession: boolean;
  activeAssistantFinalizationRetry?: AssistantFinalizationRetryState | undefined;
  assistantFinalizationRetryMaxRetries: number;
  interruptedToolCallRecoveryAttemptsUsed: number;
  interruptedToolCallRecoveryMaxRetries: number;
  canScheduleInterruptedToolCallRecovery: boolean;
  pendingEmptyResponseRetryDelayMs: number;
  retrySourceUserMessageId?: string | undefined;
  runtimeMessages: RuntimeAssistantMessageController;
  toolMessages: RuntimeToolMessageController;
  toolArgumentProgress: RuntimePromptFailureToolArgumentProgress;
  interruptedToolCallRecovery: RuntimePromptFailureInterruptedToolRecovery;
  startedToolCallIds: ReadonlySet<string>;
  abortRequested: () => boolean;
  streamWatchdogTimedOut: () => boolean;
  currentPiStreamFailureKind: () => AmbientStreamFailureKind;
  currentAssistantFinalText: () => string;
  currentThinkingFinalText: () => string;
  receivedAnyText: () => boolean;
  subagentParentControlAbortIntent: () => SubagentParentControlAbortIntent | undefined;
  isRunStoreActive: () => boolean;
  consumeSubagentParentControlAbort: () => Promise<void>;
  persistPiStreamTrace: (reason: string) => void;
  canScheduleAssistantFinalizationRetryFor: (reason: AssistantFinalizationRetryReason) => boolean;
  assistantFinalizationRetryAttemptsUsedFor: (
    reason: AssistantFinalizationRetryReason,
    recoveryStateId?: string,
  ) => number;
  assistantFinalizationRetryNextAttemptFor: (
    reason: AssistantFinalizationRetryReason,
    recoveryStateId?: string,
  ) => number;
  sessionRecoveryForCurrentSession: (
    kind: RuntimeSessionRecoveryContext["kind"],
    reason: string,
    providerContinuationStateId?: string,
  ) => RuntimeSessionRecoveryContext;
  createAssistantFinalizationRetryInput: RuntimePromptFailureRetryInputFactory;
  recoverProviderContextOverflow?: (overflow: AmbientProviderContextOverflow) => Promise<{
    effectiveContextWindowTokens: number;
    requestedOutputTokens: number;
  }>;
  createInterruptedToolCallRecoveryInput: (snapshots: InterruptedToolCallRecoverySnapshot[]) => SendMessageInput;
  collectOpenProviderInterruptionToolSnapshots: () => ProviderInterruptionToolSnapshot[];
  createProviderContinuationState: (
    input: RuntimePromptFailureProviderContinuationStateInput,
  ) => ProviderContinuationState;
  persistProviderContinuationState: (state: ProviderContinuationState) => ProviderContinuationState;
  persistCurrentSessionPointerForRetry: (reason: PiSessionFileCommitReason) => Promise<void>;
  createProviderInterruptionContinuationInput: (input: {
    message: string;
    diagnostic: RuntimeProviderErrorDiagnostic;
    tools: ProviderInterruptionToolSnapshot[];
    completedToolMessageCount: number;
    continuationState: ProviderContinuationState;
  }) => SendMessageInput;
  setPendingEmptyResponseRetry: (input: SendMessageInput) => void;
  setPendingInterruptedToolCallRecoveryFollowUp: (input: SendMessageInput) => void;
  setPendingProviderInterruptionContinuation: (input: SendMessageInput | undefined) => void;
  providerRetryAttemptCount: () => number;
  setProviderRetryAttemptCount: (count: number) => void;
  setProviderRetryLastError: (message: string) => void;
  cleanupCurrentSession: (options?: { clearPersistedSessionFileIfCurrent?: boolean }) => void;
  markOpenToolMessagesFailed: (reason: RuntimeOpenToolFailureReason) => void;
  persistToolArgumentDiagnostics: (force?: boolean) => void;
  replaceToolMessage: (messageId: string, content: string, metadata: Record<string, unknown>) => ChatMessage;
  resolveSubagentFinalizationBlock?: (() => SubagentFinalizationBarrierBlock | undefined) | undefined;
  resolveCallableWorkflowFinalizationBlock?: (() => CallableWorkflowParentBlockingBlock | undefined) | undefined;
  recordSubagentFinalizationBlockedParentMailbox?: ((
    block: SubagentFinalizationBarrierBlock,
  ) => Array<{ id: string }>) | undefined;
  recordCallableWorkflowFinalizationBlockedParentMailbox?: ((
    block: CallableWorkflowParentBlockingBlock,
  ) => { id: string } | undefined) | undefined;
  suppressCallableWorkflowParentAssistantMessages?: ((
    block: CallableWorkflowParentBlockingBlock,
    options: { preserveMessageId?: string | undefined },
  ) => void) | undefined;
  finishPlannerFinalizationSources: (
    status: "failed",
    options: { error: string; workflowState: "failed" },
  ) => void;
  finishParentRun: (status: "done" | "error" | "aborted" | "interrupted", errorMessage?: string) => void;
  getThread: () => ThreadSummary;
  symphonyParentModePolicy?: SymphonyParentModePolicy | undefined;
  chatStreamInterruptionDiagnostic: (
    message: string,
    input?: Partial<
      Pick<
        ChatStreamInterruptionDiagnostic,
        | "kind"
        | "retryScheduled"
        | "replaySafe"
        | "continuationSafe"
        | "retryUsesFreshSession"
        | "retryAttempt"
        | "maxRetries"
        | "retryReason"
        | "retryDelayMs"
        | "providerErrorDiagnostic"
        | "interruptedToolCalls"
        | "completedToolMessageCount"
        | "receivedAnyText"
      >
    >,
  ) => ChatStreamInterruptionDiagnostic;
  chatStreamInterruptionNotice: (message: string) => string;
  emitRunEvent: (event: DesktopEvent) => void;
}
