import type { DesktopEvent, SendMessageInput } from "../../shared/desktopTypes";
import type { AmbientFeatureFlagSnapshot } from "../../shared/featureFlags";
import type { ThreadSummary } from "../../shared/threadTypes";
import type { AgentRuntimeActiveRunHandoffController } from "./agentRuntimeActiveRunHandoffController";
import type { AgentRuntimePromptExecutionController } from "./agentRuntimePromptExecutionController";
import type { AgentRuntimePromptOutcomeController } from "./agentRuntimePromptOutcomeController";
import type { ProjectStore } from "./agentRuntimeProjectStoreFacade";
import type {
  RuntimeSessionRecoveryContext,
} from "./agentRuntimeAssistantRetryInput";
import {
  createAgentRuntimeSendRunStateForRuntime,
} from "./agentRuntimeSendRunState";
import { runAgentRuntimeSendPromptRun, type AgentRuntimeSendPromptRunSession } from "./agentRuntimeSendPromptRun";
import type { AgentRuntimeSendPreparationController } from "./agentRuntimeSendPreparationController";
import type { AgentRuntimeSendPreflightController } from "./agentRuntimeSendPreflightController";
import { prepareAgentRuntimeSendStartContext } from "./agentRuntimeSendStartContext";
import type { PiSessionFileCommitReason } from "./agentRuntimeSessionFacade";
import type { AgentRuntimeSessionRegistry } from "./agentRuntimeSessionRegistry";
import type { AgentRuntimeSubagentStopCascadeController } from "./agentRuntimeSubagentStopCascadeController";
import type {
  SymphonyParentModePolicy,
  SymphonyParentModeVerifiedLaunch,
} from "./agentRuntimeSymphonyParentMode";
import {
  resolveChatPiEmptyAssistantStallTimeoutMs,
  resolvePostToolContinuationIdleMs,
  resolvePostToolFinalizationTickMs,
  resolveWorkflowRecordingReviewStreamIdleTimeoutMs,
} from "./agentRuntimeTimeouts";
import {
  localToolIdleTimeoutMs,
} from "./agentRuntimeUtilityHelpers";
import type { RuntimeAbortContextActiveRun } from "./runtimeAbortContext";
import type { RuntimePermissionWaitControl } from "./runtimePermissionWaitController";

const POST_TOOL_CONTINUATION_IDLE_MS = resolvePostToolContinuationIdleMs();
const POST_TOOL_FINALIZATION_IDLE_MS = 120_000;
const POST_TOOL_FINALIZATION_TICK_MS = resolvePostToolFinalizationTickMs();
export const POST_TOOL_ABORT_GRACE_MS = 5_000;
const ASSISTANT_FINALIZATION_RETRY_DELAY_MS = 1_000;
const DEFAULT_INTERRUPTED_TOOL_CALL_RECOVERY_MAX_RETRIES = 3;
const CHAT_PI_EMPTY_ASSISTANT_STALL_TIMEOUT_MS = resolveChatPiEmptyAssistantStallTimeoutMs();
const WORKFLOW_RECORDING_REVIEW_STREAM_IDLE_TIMEOUT_MS = resolveWorkflowRecordingReviewStreamIdleTimeoutMs();
const CHAT_PI_STREAM_PROGRESS_THROTTLE_MS = 2_000;
const CHAT_PI_STREAM_PROGRESS_CHAR_DELTA = 250;
const CHAT_PI_STREAM_TRACE_RECENT_EVENT_LIMIT = 250;
const ASSISTANT_TERMINAL_TEXT_IDLE_GRACE_MS = 15_000;

export interface AgentRuntimeSendHooks {
  onActivity?: () => void;
  awaitQueuedDeliveryCompletion?: boolean;
  awaitInternalRetryCompletion?: boolean;
}

export interface AgentRuntimeSendOrchestratorInput<Session extends AgentRuntimeSendPromptRunSession> {
  sendInput: SendMessageInput;
  hooks?: AgentRuntimeSendHooks | undefined;
  store: ProjectStore;
  activeRuns: Map<string, RuntimeAbortContextActiveRun>;
  activeRunIds: Map<string, string>;
  sessions: AgentRuntimeSessionRegistry<Session>;
  permissionWaitControls: Map<string, RuntimePermissionWaitControl>;
  permissions: {
    denyThread: (threadId: string) => void;
  };
  activeRunHandoff: Pick<AgentRuntimeActiveRunHandoffController, "handleSendActiveRunHandoff">;
  sendPreparation: Pick<AgentRuntimeSendPreparationController, "prepareRuntimeSendLoopContext">;
  sendPreflight: Pick<
    AgentRuntimeSendPreflightController,
    "resolveMainModelRuntimeProfile" | "runBeforePrompt" | "sendInputWithSymphonyParentModeToolCapableModel"
  >;
  promptExecutions: Pick<AgentRuntimePromptExecutionController<Session>, "runPrompt">;
  promptOutcomes: Pick<AgentRuntimePromptOutcomeController, "finalizeSendAfterRun" | "handlePromptFailure" | "handlePromptSuccess">;
  subagentStopCascade: Pick<AgentRuntimeSubagentStopCascadeController, "cascadeSubagentsForStoppedParentRun">;
  getFeatureFlagSnapshot: () => AmbientFeatureFlagSnapshot;
  createWorkflowRecordingReviewSession: (thread: ThreadSummary) => Promise<Session>;
  getSession: (
    thread: ThreadSummary,
    recovery?: RuntimeSessionRecoveryContext | undefined,
    symphonyParentModePolicy?: SymphonyParentModePolicy | undefined,
    symphonyParentModeVerifiedLaunch?: SymphonyParentModeVerifiedLaunch | undefined,
  ) => Promise<Session>;
  commitThreadPiSessionFile: (input: {
    threadId: string;
    sessionFile?: string;
    currentPiSessionFile?: string | null;
    reason: PiSessionFileCommitReason;
    emit: (event: DesktopEvent) => void;
  }) => Promise<ThreadSummary | undefined>;
  abortSessionRun: (session: Session, threadId: string) => Promise<void>;
  emit: (event: DesktopEvent) => void;
}

export async function runAgentRuntimeSendOrchestrator<Session extends AgentRuntimeSendPromptRunSession>(
  input: AgentRuntimeSendOrchestratorInput<Session>,
): Promise<void> {
  const hooks = input.hooks ?? {};
  const sendStart = await prepareAgentRuntimeSendStartContext({
    input: input.sendInput,
    hooks,
    activeRuns: input.activeRuns,
    activeRunHandoff: input.activeRunHandoff,
    sendPreparation: input.sendPreparation,
    sendPreflight: input.sendPreflight,
    store: input.store,
    getFeatureFlagSnapshot: input.getFeatureFlagSnapshot,
    emit: input.emit,
  });
  if (sendStart.kind === "handled") return;
  const {
    runtimeInput,
    usesDedicatedReviewSession,
    visibleUserContent,
    hasWorkflowPlanEditIntent,
    thread,
    plannerFinalizationSources,
    runWorkspacePath,
    piPreStreamTimeoutMs,
    piStreamIdleTimeoutMs,
    defaultToolExecutionIdleTimeoutMs,
    emptyAssistantStallTimeoutMs,
    retrySourceUserMessageId,
    activeAssistantFinalizationRetry,
    assistantFinalizationRetryMaxRetries,
    interruptedToolCallRecoveryMaxRetries,
    interruptedToolCallRecoveryAttemptsUsed,
    canScheduleInterruptedToolCallRecovery,
    symphonyParentModePolicy,
    sendInputWithSymphonyParentModePolicy,
    promptImageInputs,
    runEventScope,
    runtimeModel,
    promptContent,
  } = sendStart.context;
  const startedInPlannerMode = thread.collaborationMode === "planner";

  const sessionRef: { current: Session | undefined } = { current: undefined };
  const {
    runId,
    runGoalId,
    runGoalStartedAtMs,
    sendPromptState,
    sendExecutionState,
  } = createAgentRuntimeSendRunStateForRuntime<Session>({
    sendInput: input.sendInput,
    thread,
    runWorkspacePath,
    visibleUserContent,
    retrySourceUserMessageId,
    sendInputWithSymphonyParentModePolicy,
    runtimeInput,
    usesDedicatedReviewSession,
    runtimeModel,
    activeAssistantFinalizationRetry,
    assistantFinalizationRetryMaxRetries,
    interruptedToolCallRecoveryAttemptsUsed,
    interruptedToolCallRecoveryMaxRetries,
    piPreStreamTimeoutMs,
    piStreamIdleTimeoutMs,
    progressThrottleMs: CHAT_PI_STREAM_PROGRESS_THROTTLE_MS,
    progressCharDelta: CHAT_PI_STREAM_PROGRESS_CHAR_DELTA,
    recentEventLimit: CHAT_PI_STREAM_TRACE_RECENT_EVENT_LIMIT,
    emptyResponseRetryDelayMs: ASSISTANT_FINALIZATION_RETRY_DELAY_MS,
    symphonyParentModePolicy,
    runEventScope,
    sessionRef,
    promptContent,
    store: input.store,
    activeRunIds: input.activeRunIds,
    activeRuns: input.activeRuns,
    sessions: input.sessions,
    permissions: input.permissions,
    permissionWaitControls: input.permissionWaitControls,
    commitThreadPiSessionFile: input.commitThreadPiSessionFile,
    abortSessionRun: input.abortSessionRun,
    cascadeSubagentsForStoppedParentRun: (threadId, runId, reason) =>
      input.subagentStopCascade.cascadeSubagentsForStoppedParentRun(threadId, runId, reason),
    emit: input.emit,
  });

  await runAgentRuntimeSendPromptRun({
    sendInput: input.sendInput,
    hooks,
    thread,
    runId,
    runWorkspacePath,
    promptContent,
    images: promptImageInputs.images,
    piPreStreamTimeoutMs,
    piStreamIdleTimeoutMs,
    defaultToolExecutionIdleTimeoutMs,
    emptyAssistantStallTimeoutMs,
    assistantTerminalGraceMs: ASSISTANT_TERMINAL_TEXT_IDLE_GRACE_MS,
    postToolContinuationIdleMs: POST_TOOL_CONTINUATION_IDLE_MS,
    postToolFinalizationIdleMs: POST_TOOL_FINALIZATION_IDLE_MS,
    postToolFinalizationTickMs: POST_TOOL_FINALIZATION_TICK_MS,
    abortGraceMs: POST_TOOL_ABORT_GRACE_MS,
    assistantFinalizationRetryMaxRetries,
    activeAssistantFinalizationRetry,
    retrySourceUserMessageId,
    interruptedToolCallRecoveryAttemptsUsed,
    interruptedToolCallRecoveryMaxRetries,
    canScheduleInterruptedToolCallRecovery,
    plannerFinalizationSources,
    startedInPlannerMode,
    usesDedicatedReviewSession,
    hasWorkflowPlanEditIntent,
    runGoalId,
    runGoalStartedAtMs,
    symphonyParentModePolicy,
    sendPromptState,
    sendExecutionState,
    runEventScope,
    promptExecutions: input.promptExecutions,
    promptOutcomes: input.promptOutcomes,
    createSession: () =>
      usesDedicatedReviewSession
        ? input.createWorkflowRecordingReviewSession(thread)
        : input.getSession(
            thread,
            runtimeInput.sessionRecovery,
            symphonyParentModePolicy,
            runtimeInput.symphonyParentModeVerifiedLaunch,
          ),
    setSession: (createdSession) => {
      sessionRef.current = createdSession;
    },
    abortSessionRun: input.abortSessionRun,
    getMessages: () => input.store.listMessages(input.sendInput.threadId),
    getThread: () => input.store.getThread(input.sendInput.threadId),
  });
}
