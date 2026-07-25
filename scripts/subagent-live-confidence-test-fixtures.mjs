import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import {
  REQUIRED_DESKTOP_DOGFOOD_SCENARIOS,
  REQUIRED_DESKTOP_MATURITY_ASSERTION_IDS,
  REQUIRED_DESKTOP_VISUAL_ASSERTIONS,
} from "./subagent-desktop-dogfood-evidence-contract.mjs";

function liveSmokeArtifact() {
  return {
    createdAt: "2026-06-10T23:00:00.000Z",
    provider: "GMI Cloud",
    assistantText: "SUBAGENT_LIVE_DONE",
    childAssistantText: "SUBAGENT_CHILD_DONE",
    run: {
      id: "child-run",
      status: "completed",
      childThreadId: "child-thread",
      resultArtifact: { status: "completed" },
      runtimeEvents: [{ type: "started" }, { type: "assistant_delta" }, { type: "completed" }],
    },
  };
}

function longContextAuthorityArtifact() {
  return {
    createdAt: "2026-06-10T23:00:00.000Z",
    provider: "GMI Cloud",
    run: {
      id: "long-context-run",
      status: "completed",
      childThreadId: "long-context-child",
      resultArtifact: { status: "completed" },
      toolScopeSnapshots: [
        {
          resolverInputs: {
            childAuthorityProfile: {
              resourceScopes: {
                filesystem: {
                  readRoots: ["/workspace/allowed/notes.txt", "/workspace/allowed/brief.pdf", "/workspace/allowed/brief.docx"],
                  writeRoots: [],
                  readDecision: "allow",
                  writeDecision: "deny",
                },
              },
            },
          },
        },
      ],
    },
    childToolNames: ["read", "long_context_process"],
    childTranscript: [
      "TEXT_AUTHORITY_OK",
      "PDF_AUTHORITY_OK",
      "OFFICE_AUTHORITY_OK",
      "long_context_process path is outside the current workspace authority",
    ].join("\n"),
    deniedContentLeaked: false,
  };
}

function approvalAuthorityArtifact() {
  const run = {
    id: "approval-run",
    status: "needs_attention",
    childThreadId: "approval-child",
    resultArtifact: undefined,
  };
  return {
    createdAt: "2026-06-10T23:00:00.000Z",
    provider: "GMI Cloud",
    run,
    waitDetails: {
      status: "needs_attention",
      waitSatisfied: false,
      synthesisAllowed: false,
      waitNotice:
        "Child requested approval; parent approval was forwarded to the parent mailbox and the parent remains blocked on this child.",
    },
    pendingPermissions: [
      {
        id: "approval-1",
        threadId: run.childThreadId,
        toolName: "read",
        grantActionKind: "file_content_read",
        grantTargetKind: "path",
        grantTargetLabel: "/workspace/approval-needed.txt",
      },
    ],
    parentMailboxEvents: [
      {
        id: "mailbox-approval-1",
        type: "subagent.child_approval_requested",
        deliveryState: "queued",
        payload: {
          childRunId: run.id,
          childThreadId: run.childThreadId,
          approvalId: "approval-1",
          requestedToolId: "read",
          requestedAction: "file_content_read",
          parentBlockingState: {
            action: "forward_child_approval_then_wait",
            childRunId: run.id,
            childThreadId: run.childThreadId,
            resumeParentBlocking: true,
          },
        },
      },
    ],
    childTranscript: "Child runtime is waiting for parent approval.",
    deniedContentLeaked: false,
    evidence: {
      dogfoodRunEvidence: {
        details: {
          schemaVersion: "ambient-subagent-live-approval-authority-evidence-v1",
          childPausedForApproval: true,
          parentRemainedBlocked: true,
          approvalForwardedToParent: true,
        },
      },
    },
  };
}

function browserApprovalArtifact() {
  const run = {
    id: "browser-run",
    status: "running",
    childThreadId: "browser-child",
    resultArtifact: undefined,
    runEvents: [
      { type: "subagent.approval_requested" },
      { type: "subagent.child_approval_forwarded" },
      { type: "subagent.approval_response.consumed" },
    ],
  };
  return {
    createdAt: "2026-06-10T23:00:00.000Z",
    provider: "GMI Cloud",
    parentPermissionMode: "full-access",
    run,
    waitDetails: {
      status: "needs_attention",
      waitSatisfied: false,
      synthesisAllowed: false,
      run: {
        status: "needs_attention",
      },
      waitNotice:
        "Child requested approval; parent approval was forwarded to the parent mailbox and the parent remains blocked on this child.",
    },
    resumeDetails: {
      status: "running",
      synthesisAllowed: false,
      parentResolution: { status: "blocked", canSynthesize: false },
    },
    pendingBeforeApproval: [
      {
        id: "browser-approval-1",
        threadId: run.childThreadId,
        toolName: "browser_content",
        grantActionKind: "browser_network",
        grantTargetKind: "browser_origin",
        grantTargetLabel: "example.com",
        grantConditions: {
          childRunId: run.id,
          childThreadId: run.childThreadId,
          domain: "example.com",
          source: "subagent-child-browser-authority",
        },
      },
    ],
    permissionResponses: [{ id: "browser-approval-1", response: "always_thread" }],
    parentMailboxEvents: [
      {
        id: "mailbox-browser-approval-1",
        type: "subagent.child_approval_requested",
        deliveryState: "consumed",
        payload: {
          childRunId: run.id,
          childThreadId: run.childThreadId,
          approvalId: "browser-approval-1",
          requestedToolId: "browser_content",
          requestedAction: "browser_network",
          parentBlockingState: {
            action: "forward_child_approval_then_wait",
            childRunId: run.id,
            childThreadId: run.childThreadId,
            resumeParentBlocking: true,
          },
        },
      },
    ],
    childTranscriptBeforeApproval: "Child runtime is waiting for parent approval.",
    childTranscriptAfterResume: "Approval response delivered back to child runtime.",
  };
}

function liveWorkflowArtifact() {
  return {
    run: { id: "workflow-run", status: "succeeded" },
    artifact: { id: "workflow-artifact", workflowThreadId: "workflow-thread" },
    events: 7,
    fileReads: 2,
    modelCalls: [{ task: "dogfood.local_file_report", status: "succeeded", latencyMs: 1234 }],
    checkpoint: {
      files: ["local-report/events.md", "local-report/notes.txt"],
      report: { report: "Story time, picnic, museum, registration, and travel notes." },
    },
  };
}

function workflowUiDogfoodMatrixArtifact() {
  return {
    ok: true,
    startedAt: "2026-06-10T23:00:00.000Z",
    finishedAt: "2026-06-10T23:04:00.000Z",
    suite: "phase0-live",
    scenarios: ["vocabulary-quiz", "local-file-classifier"],
    results: [
      {
        scenario: "vocabulary-quiz",
        ok: true,
        exitCode: 0,
        elapsedMs: 62_000,
        reportPath: "/tmp/ambient/test-results/workflow-agent-thread-ui-dogfood/vocabulary-quiz/latest.json",
        runStatus: "succeeded",
        artifact: "Vocabulary Quiz",
        finalOutput: { charCount: 420, signalCount: 1, formats: ["html"], sources: ["event:output"] },
        runEvidence: {
          events: 18,
          modelCalls: 1,
          checkpoints: 2,
          approvals: 0,
          outputSignals: 2,
          runtimeInputRequests: 0,
          runtimeInputResponses: 0,
          approvalRequests: 0,
          approvalResponses: 0,
          desktopToolEnds: [],
          connectorEnds: [],
          recoveryEvents: 0,
        },
        scenarioAssertions: { passed: true, finalOutput: { charCount: 420, signalCount: 1 } },
        uiAssertions: { passed: true },
        screenshots: [{ name: "build", file: "build.png", bytes: 12_345 }],
      },
      {
        scenario: "local-file-classifier",
        ok: true,
        exitCode: 0,
        elapsedMs: 81_000,
        reportPath: "/tmp/ambient/test-results/workflow-agent-thread-ui-dogfood/local-file-classifier/latest.json",
        runStatus: "succeeded",
        artifact: "Local File Classifier",
        finalOutput: { charCount: 640, signalCount: 2, formats: ["html"], sources: ["event:output", "checkpoint:final_output"] },
        runEvidence: {
          events: 26,
          modelCalls: 2,
          checkpoints: 3,
          approvals: 0,
          outputSignals: 3,
          runtimeInputRequests: 1,
          runtimeInputResponses: 1,
          approvalRequests: 0,
          approvalResponses: 0,
          desktopToolEnds: ["file_read"],
          connectorEnds: [],
          recoveryEvents: 0,
        },
        scenarioAssertions: { passed: true, finalOutput: { charCount: 640, signalCount: 2 } },
        uiAssertions: { passed: true },
        screenshots: [{ name: "runs", file: "runs.png", bytes: 23_456 }],
      },
    ],
  };
}

function workflowUiBroaderDogfoodMatrixArtifact() {
  const base = workflowUiDogfoodMatrixArtifact();
  const scenarios = [
    "gmail-20-metadata-readonly-validation",
    "downloads-document-categorization",
    "public-source-browser",
    "current-web-recipe-report",
  ];
  return {
    ...base,
    suite: "phase1-live",
    scenarios,
    results: scenarios.map((scenario, index) => {
      const seed = base.results[index % base.results.length];
      return {
        ...seed,
        scenario,
        elapsedMs: seed.elapsedMs + index * 1_000,
        reportPath: `/tmp/ambient/test-results/workflow-agent-thread-ui-dogfood/${scenario}/latest.json`,
        artifact: `Phase 1 ${scenario}`,
        finalOutput: {
          ...seed.finalOutput,
          charCount: seed.finalOutput.charCount + index * 40,
          signalCount: seed.finalOutput.signalCount + 1,
        },
        runEvidence: {
          ...seed.runEvidence,
          events: seed.runEvidence.events + index,
          modelCalls: seed.runEvidence.modelCalls + 1,
          checkpoints: seed.runEvidence.checkpoints + 1,
          outputSignals: seed.runEvidence.outputSignals + 1,
        },
        scenarioAssertions: {
          ...seed.scenarioAssertions,
          finalOutput: {
            ...seed.scenarioAssertions.finalOutput,
            charCount: seed.scenarioAssertions.finalOutput.charCount + index * 40,
            signalCount: seed.scenarioAssertions.finalOutput.signalCount + 1,
          },
        },
        screenshots: [{ name: "phase1", file: `${scenario}.png`, bytes: 30_000 + index }],
        harness: {
          name: `workflow-agent-thread-ui-dogfood/${scenario}`,
          runId: `${scenario}-run`,
          snapshotMode: "shared-snapshot-temp-copy",
          snapshotRootLabel: "example-shared-secrets",
          snapshotRootPathDigest: "abc123def456",
          pathsAreMachineLocal: true,
        },
        launch: {
          providerId: "gmi-cloud",
          providerLabel: "GMI Cloud",
          workspaceMode: "shared-snapshot-temp-copy",
          credentialConfigured: true,
          credentialSources: ["file:ignored-provider-key-file.txt"],
          googleWorkspace: {
            status: "configured",
            binarySource: "gws-hardening-snapshot",
            configSource: "user-data-config",
            binaryConfigured: true,
            configConfigured: true,
          },
        },
      };
    }),
  };
}

function callableWorkflowDogfoodArtifact() {
  return {
    schemaVersion: "ambient-callable-workflow-dogfood-evidence-v1",
    createdAt: "2026-06-05T00:45:00.000Z",
    task: {
      id: "workflow-task-1",
      launchId: "launch-1",
      toolName: "ambient_workflow_symphony_map_reduce",
      sourceKind: "symphony_recipe",
      status: "succeeded",
      blocking: true,
      workflowArtifactId: "workflow-artifact-1",
      workflowRunId: "workflow-run-1",
    },
    launchCard: {
      present: true,
      riskLevel: "medium",
      estimatedAgents: 4,
      maxFanout: 3,
      maxDepth: 2,
      estimatedTokenBudget: 12000,
      estimatedLocalMemoryBytes: 268435456,
      defaultCollapsed: true,
      blocking: true,
      pauseResumeCancel: true,
      checkpointResume: "Checkpoint after every stage and resume from the last completed step.",
      approvalFailureHandling: "Forward child approval requests to the parent and resume blocking afterward.",
      requirementIds: ["launch_confirmed", "nested_fanout_limited"],
      metricTemplateIds: ["map_reduce-metric"],
      policyWarnings: ["child mutating workflow requires approval"],
    },
    childCaller: {
      kind: "subagent_child_thread",
      threadId: "child-thread-1",
      runId: "child-run-1",
      subagentRunId: "subagent-run-1",
      canonicalTaskPath: "parent/1",
      parentThreadId: "parent-thread",
      parentRunId: "parent-run",
    },
    mutation: {
      artifactId: "workflow-artifact-1",
      mutationPolicy: "staged_until_approved",
      approvalRequired: true,
      approvalSource: "child_bridge_policy",
      approvalScope: "this_child_thread",
      worktreeRequired: true,
      worktreeIsolated: true,
      worktreeStatus: "active",
      worktreePathPresent: true,
      nestedFanoutRequired: true,
      nestedFanoutSource: "child_bridge_policy",
    },
    mutationOutput: {
      kind: "staged_file",
      stagedRelativePath: "src/feature.txt",
      stagedFileSha256: "a".repeat(64),
      fullArtifactPath: "/tmp/child-worktree/.ambient-codex/workflows/dogfood/mutation-report.md",
      fullArtifactBytes: 256,
      fullArtifactSha256: "b".repeat(64),
      boundedPreview: "Child staged mutation preview.",
      previewBytes: 30,
      previewTruncated: true,
      parentWorkspaceUnchanged: true,
    },
    workflow: {
      workflowThreadId: "workflow-thread-1",
      artifactId: "workflow-artifact-1",
      artifactStatus: "ready_for_preview",
      runId: "workflow-run-1",
      runStatus: "succeeded",
      taskArtifactLinkMatches: true,
      taskRunLinkMatches: true,
    },
    taskEvents: {
      started: true,
      finished: true,
      control: false,
      eventTypes: ["callable_workflow.task_started", "callable_workflow.task_finished"],
    },
    parentBlocking: {
      schemaVersion: "ambient-callable-workflow-parent-blocking-v1",
      reason: "blocking_callable_workflow_not_synthesis_safe",
      blockedBeforeCompletion: true,
      unblockedAfterCompletion: true,
      blockedTaskIds: ["workflow-task-1"],
      waitingTaskIds: ["workflow-task-1"],
      attentionTaskIds: [],
      allowedUserChoiceIds: ["wait_again", "cancel_parent"],
      idempotencyKey: "callable-workflow:parent-finalization-blocked:parent-run:workflow-task-1",
      message: "Parent final answer blocked because blocking callable workflow work is not safe for synthesis.",
    },
    deniedScope: {
      schemaVersion: "ambient-subagent-tool-scope-launch-policy-v1",
      denied: true,
      denialKinds: ["phase4_isolation_required"],
      explicitToolRequestObserved: true,
      deniedCategoryIds: ["workflow.call"],
      deniedToolIds: ["callable_workflow:ambient_workflow_symphony_map_reduce"],
      reasonSamples: ["Requested sub-agent tool scope was denied before launch."],
      bridgeReasons: [
        "Callable workflow child bridge is disabled by child role policy.",
        "Callable workflow child bridge requires an active isolated child worktree.",
        "Callable workflow child bridge is unavailable because the nested fanout limit is exhausted.",
      ],
    },
    restart: {
      schemaVersion: "ambient-callable-workflow-task-restart-v1",
      issueKinds: ["workflow_run_terminal_task_unfinished"],
      repairedTaskIds: ["workflow-task-1"],
      diagnosticTaskIds: ["workflow-task-1"],
      terminalRepairObserved: true,
    },
    maturityAssertions: {
      workflow_launch_card_bounds: {
        id: "workflow_launch_card_bounds",
        status: "passed",
        capabilities: ["workflow_launch", "launch_card_bounds", "pause_resume_cancel"],
        evidence: [
          "passed: risk=medium agents=4 fanout=3 depth=2",
          "passed: tokenBudget=12000 localMemory=268435456 checkpoint=Checkpoint after every stage and resume from the last completed step.",
          "passed: defaultCollapsed=true blocking=true pauseResumeCancel=true",
        ],
      },
      workflow_mutating_child_worker: {
        id: "workflow_mutating_child_worker",
        status: "passed",
        capabilities: ["mutating_child_workflow", "child_scoped_approval", "isolated_child_worktree"],
        evidence: [
          "passed: approval=child_bridge_policy scope=this_child_thread",
          "passed: worktree=active isolated=true path=true",
          "passed: staged=src/feature.txt parentUnchanged=true",
        ],
      },
      workflow_parent_blocking_completion: {
        id: "workflow_parent_blocking_completion",
        status: "passed",
        capabilities: ["parent_blocking_workflow", "workflow_launch"],
        evidence: [
          "passed: blockedBeforeCompletion=true",
          "passed: unblockedAfterCompletion=true",
          "passed: choices=wait_again,cancel_parent",
        ],
      },
      workflow_denied_child_scope: {
        id: "workflow_denied_child_scope",
        status: "passed",
        capabilities: ["denied_workflow_scope", "child_workflow_scope"],
        evidence: ["passed: denials=1", "passed: categories=workflow.call", "passed: bridgeReasons=3"],
      },
      workflow_restart_repair: {
        id: "workflow_restart_repair",
        status: "passed",
        capabilities: ["workflow_task_rehydration", "restart_repair"],
        evidence: [
          "passed: issueKinds=workflow_run_terminal_task_unfinished",
          "passed: repairedTaskIds=workflow-task-1",
          "passed: diagnosticTaskIds=workflow-task-1",
        ],
      },
    },
  };
}

function callableWorkflowRehydrationArtifact() {
  return {
    schemaVersion: "ambient-callable-workflow-rehydration-evidence-v1",
    createdAt: "2026-06-05T00:45:00.000Z",
    task: {
      id: "workflow-task-1",
      launchId: "launch-1",
      toolName: "ambient_workflow_symphony_map_reduce",
      sourceKind: "symphony_recipe",
      status: "running",
      blocking: true,
      workflowThreadId: "workflow-thread-1",
      workflowArtifactId: "workflow-artifact-1",
      workflowRunId: "workflow-run-1",
    },
    rehydration: {
      sameTaskId: true,
      sameArtifactId: true,
      sameRunId: true,
      workflowThreadHydrated: true,
      artifactSourcePathHydrated: true,
      artifactStatePathHydrated: true,
      artifactMutationPolicyHydrated: true,
      artifactSpecHydrated: true,
      launchCardHydrated: true,
      executionPlanHydrated: true,
      progressHydrated: true,
      usageHydrated: true,
    },
    childCaller: {
      kind: "subagent_child_thread",
      threadId: "child-thread-1",
      runId: "child-run-1",
      subagentRunId: "subagent-run-1",
      canonicalTaskPath: "parent/1",
      parentThreadId: "parent-thread",
      parentRunId: "parent-run",
    },
    artifact: {
      id: "workflow-artifact-1",
      title: "Rehydration Workflow",
      workflowThreadId: "workflow-thread-1",
      status: "ready_for_preview",
      sourcePath: "/tmp/worktree/.ambient-codex/workflows/rehydration/main.ts",
      statePath: "/tmp/worktree/.ambient-codex/workflows/rehydration/state.json",
      mutationPolicy: "staged_until_approved",
      specGoal: "Keep callable workflow task links visible after restart.",
    },
    workflowRun: {
      id: "workflow-run-1",
      artifactId: "workflow-artifact-1",
      status: "running",
    },
    progressSnapshot: {
      workflowRunStatus: "running",
      eventCount: 4,
      modelCallCount: 1,
      completedStepCount: 1,
      activeStepCount: 1,
      lastEventType: "step.start",
      lastEventMessage: "Reduce rehydrated evidence",
      lastEventAt: "2026-06-05T00:44:00.000Z",
    },
    usageSnapshot: {
      modelCallCount: 1,
      tokenCount: 21,
      tokenCountEstimated: false,
      costMicros: 34,
      costEstimated: false,
    },
    taskEvents: {
      started: true,
      eventTypes: ["callable_workflow.task_started", "step.start", "step.end"],
    },
    maturityAssertions: {
      workflow_rehydrated_task_links: {
        id: "workflow_rehydrated_task_links",
        status: "passed",
        capabilities: ["workflow_task_rehydration", "artifact_link"],
        evidence: ["passed: sameTaskId=true", "passed: sameArtifactId=true", "passed: sameRunId=true"],
      },
      workflow_rehydrated_artifact_payload: {
        id: "workflow_rehydrated_artifact_payload",
        status: "passed",
        capabilities: ["artifact_link", "checkpoint_output"],
        evidence: [
          "passed: sourcePath=true",
          "passed: statePath=true",
          "passed: mutationPolicy=staged_until_approved",
          "passed: specGoal=true",
        ],
      },
      workflow_rehydrated_progress_usage: {
        id: "workflow_rehydrated_progress_usage",
        status: "passed",
        capabilities: ["workflow_task_rehydration", "checkpoint_output"],
        evidence: ["passed: progressEvents=4", "passed: modelCalls=1", "passed: tokens=21"],
      },
      workflow_rehydrated_child_provenance: {
        id: "workflow_rehydrated_child_provenance",
        status: "passed",
        capabilities: ["child_workflow_provenance", "workflow_task_rehydration"],
        evidence: ["passed: childThread=child-thread-1", "passed: subagentRun=subagent-run-1", "passed: canonicalTaskPath=parent/1"],
      },
    },
  };
}

function localRuntimeControlProofArtifact() {
  return {
    schemaVersion: "ambient-local-runtime-control-proof-v1",
    updatedAt: "2026-06-05T00:01:00.000Z",
    scenarios: {
      "minicpm-nondestructive-stop": {
        status: "passed",
        stopped: true,
        uninstalled: false,
        packageStatePreserved: true,
        evidence: "MiniCPM-V stop preserved installed provider state.",
      },
      "active-subagent-stop-blocker": {
        status: "passed",
        runtimeEntryId: "local-text:local-text-runtime:4301",
        capability: "local-text",
        trackingStatus: "managed",
        running: true,
        ordinaryStopAllowed: false,
        activeLeaseCount: 1,
        blockerLeaseIds: ["lease-review"],
        affectedSubagents: [
          {
            leaseId: "lease-review",
            parentThreadId: "parent-thread",
            subagentThreadId: "child-thread",
            subagentRunId: "run-review",
            displayName: "sub-agent Review worker",
            status: "running",
            modelRuntimeId: "local-text-runtime",
            modelProfileId: "local-text-4b-q4",
            providerId: "local",
            capabilityKind: "local-text",
          },
        ],
        forceTerminationAllowed: true,
        forceRequiresSubagentCancellation: true,
        evidence: "Managed local-text runtime ordinary Stop is disabled while active sub-agent lease lease-review owns the runtime.",
      },
      "untracked-runtime-safety": {
        status: "passed",
        proofKind: "deterministic-untracked-runtime-safety",
        runtimeEntryId: "untracked-llama:4401",
        capability: "local-text",
        trackingStatus: "untracked",
        running: true,
        pid: 4401,
        modelId: "unknown-local-model",
        ordinaryStopAllowed: false,
        ordinaryRestartAllowed: false,
        forceTerminationAllowed: false,
        untracked: true,
        untrackedRuntimeIds: ["untracked-llama:4401"],
        stopBlockedRuntimeIds: ["untracked-llama:4401"],
        repeatedObservationCount: 3,
        repeatedObservations: repeatedUntrackedObservations(),
        nextSafeActions: [
          {
            action: "ask-user-to-stop-untracked",
            safety: "external",
            runtimeEntryId: "untracked-llama:4401",
            runtimeId: "untracked-llama:4401",
            capability: "local-text",
            untracked: true,
          },
        ],
        evidence: "Untracked runtime stayed visible and external-only.",
      },
      "stale-lease-recovery": {
        status: "passed",
        proofKind: "deterministic-stale-lease-recovery",
        runtimeEntryId: "local-text:local-text-runtime:4301",
        capability: "local-text",
        trackingStatus: "managed",
        running: true,
        ordinaryStopAllowed: true,
        ordinaryRestartAllowed: true,
        forceRequiresSubagentCancellation: false,
        activeLeaseCount: 0,
        activeOwnerCount: 0,
        staleLeaseIds: ["lease-stale"],
        blockerLeaseIds: [],
        affectedSubagents: [],
        nextSafeActions: [
          {
            action: "stop-runtime",
            safety: "requires-approval",
            runtimeEntryId: "local-text:local-text-runtime:4301",
            toolName: "ambient_local_model_runtime_stop",
          },
          {
            action: "restart-runtime",
            safety: "requires-approval",
            runtimeEntryId: "local-text:local-text-runtime:4301",
            toolName: "ambient_local_model_runtime_restart",
          },
        ],
        evidence: "Stale lease stayed visible but no longer blocked ordinary Stop/Restart.",
      },
      "stopped-provider-display": {
        status: "passed",
        minicpmDisplayedStopped: true,
        voiceDisplayedStopped: true,
        evidence: "Stopped runtimes display as stopped provider state.",
      },
      "provider-declared-lifecycle": {
        status: "passed",
        actions: ["start", "stop", "restart"],
        usedGenericLifecycle: false,
        evidence: "Provider-declared lifecycle commands ran safely.",
      },
    },
  };
}

function repeatedUntrackedObservations() {
  return ["initial_inventory", "policy_handoff_recheck", "lifecycle_action_preview"].map((observationKind) => ({
    observationKind,
    runtimeEntryId: "untracked-llama:4401",
    trackingStatus: "untracked",
    ordinaryStopAllowed: false,
    ordinaryRestartAllowed: false,
    forceTerminationAllowed: false,
    untracked: true,
    nextSafeAction: "ask-user-to-stop-untracked",
    nextSafeActionSafety: "external",
  }));
}

function localRuntimeControlProofGateArtifact() {
  return {
    schemaVersion: "ambient-local-runtime-control-proof-gate-v1",
    startedAt: "2026-06-11T02:17:11.376Z",
    completedAt: "2026-06-11T02:17:11.377Z",
    status: "passed_with_advisories",
    checks: [
      { id: "scenario:ldr-status-before-setup", status: "advisory", issue: "Missing Local Deep Research live summary artifact." },
      { id: "scenario:minicpm-nondestructive-stop", status: "passed", evidence: "MiniCPM-V stop preserved installed provider state." },
      { id: "scenario:active-subagent-stop-blocker", status: "passed", evidence: "Active lease blocks ordinary Stop." },
      { id: "scenario:untracked-runtime-safety", status: "passed", evidence: "Untracked runtime stayed external-only." },
      { id: "scenario:stale-lease-recovery", status: "passed", evidence: "Stale lease stopped blocking ordinary lifecycle." },
      { id: "scenario:stopped-provider-display", status: "passed", evidence: "Stopped providers display as stopped." },
      { id: "scenario:provider-declared-lifecycle", status: "passed", evidence: "Provider lifecycle actions ran safely." },
      { id: "scenario:ldr-reasoning-synthesis", status: "advisory", issue: "Missing Local Deep Research live summary artifact." },
    ],
    releaseDecision: {
      blockingIssues: [],
      advisoryIssues: ["Missing Local Deep Research live summary artifact."],
    },
  };
}

function restartRepairDiagnosticsArtifact() {
  return {
    schemaVersion: "ambient-subagent-replay-diagnostics-v1",
    startedAt: "2026-06-11T02:24:00.258Z",
    completedAt: "2026-06-11T02:24:00.910Z",
    status: "passed",
    plan: {
      fixture: "restart-repair-broken-child-tree",
      liveTokens: false,
    },
    commandResult: {
      exitCode: 0,
      fixtureEvidencePath: "test-results/subagent-replay-diagnostics/latest-fixture-evidence.json",
    },
    vitest: {
      status: "passed",
      missingReplayTests: [],
    },
    replayEvidence: restartRepairReplayEvidence(),
  };
}

function restartRepairReplayEvidence() {
  return {
    schemaVersion: "ambient-subagent-replay-evidence-v1",
    fixtureName: "restart-repair-broken-child-tree",
    createdAt: "2026-06-05T00:00:00.000Z",
    liveTokens: false,
    counts: {
      threads: 4,
      childThreads: 4,
      runs: 3,
      persistedRunEvents: 4,
      runtimeEvents: 3,
      parentMailboxEvents: 1,
      transcriptMessages: 3,
      restartRepairIssues: 7,
    },
    childThreads: [{ threadId: "child-active", runId: "run-active" }],
    runtimeEventTimeline: [{ sequence: 1, runId: "run-active", parentRunId: "parent-run", childThreadId: "child-active", type: "started" }],
    persistedRunEventTimeline: [
      { sequence: 1, runId: "run-active", parentRunId: "parent-run", childThreadId: "child-active", type: "subagent.lifecycle_started" },
    ],
    parentMailboxTimeline: [
      {
        sequence: 1,
        id: "parent-mailbox-grouped-completion",
        parentRunId: "parent-run",
        parentThreadId: "parent-thread",
        parentMessageId: "parent-message-2",
        type: "subagent.grouped_completion",
        deliveryState: "queued",
        childRunIds: ["run-artifact", "run-terminal"],
      },
    ],
    rehydration: restartRehydrationProof(),
    restartRepair: {
      expectedIssueKinds: [
        "active_run_interrupted",
        "missing_lifecycle_stop",
        "missing_spawn_edge",
        "missing_result_artifact",
        "dangling_spawn_edge",
        "orphan_child_thread",
        "dangling_wait_barrier_child",
      ],
      observedIssueKinds: [
        "active_run_interrupted",
        "missing_lifecycle_stop",
        "missing_spawn_edge",
        "missing_result_artifact",
        "dangling_spawn_edge",
        "orphan_child_thread",
        "dangling_wait_barrier_child",
      ],
      repairedRunIds: ["run-active"],
      repairedBarrierIds: ["barrier-required"],
      repairedParentControlBarrierIds: [],
      repairableSpawnEdgeRunIds: ["run-terminal"],
      danglingSpawnEdgeRunIds: ["missing-run"],
      diagnosticRunIds: ["run-terminal"],
    },
  };
}

function restartRehydrationProof() {
  return {
    schemaVersion: "ambient-subagent-restart-rehydration-proof-v1",
    childRunIds: ["run-active", "run-artifact", "run-terminal"],
    childThreadIds: ["child-active", "child-artifact", "child-terminal", "orphan-child"],
    parentMailboxEventIds: ["parent-mailbox-grouped-completion"],
    parentMailboxStates: [
      {
        id: "parent-mailbox-grouped-completion",
        parentThreadId: "parent-thread",
        parentRunId: "parent-run",
        parentMessageId: "parent-message-2",
        deliveryState: "queued",
        childRunIds: ["run-artifact", "run-terminal"],
      },
    ],
    transcriptChildRunIds: ["run-active"],
    transcriptThreadIds: ["child-active", "parent-thread"],
    resultArtifactPointers: [
      {
        runId: "run-artifact",
        childThreadId: "child-artifact",
        status: "completed",
        artifactPath: ".ambient-codex/subagents/run-artifact/result.json",
        fullOutputPath: ".ambient-codex/subagents/run-artifact/full-output.txt",
        structuredOutputPath: ".ambient-codex/subagents/run-artifact/structured.json",
      },
    ],
    missingResultArtifactRunIds: ["run-terminal"],
    artifactPointerIntegrity: {
      allResultPointersHaveRunAndThread: true,
      missingResultArtifactsDiagnosed: true,
      parentMailboxChildRefsResolved: true,
      transcriptChildRefsResolved: true,
    },
  };
}

function lifecycleEdgeArtifact() {
  return {
    schemaVersion: "ambient-subagent-lifecycle-edge-evidence-v1",
    createdAt: "2026-06-11T04:00:00.000Z",
    source: "deterministic_fixture",
    liveTokens: false,
    featureFlagSnapshot: {
      ambientSubagentsEnabled: true,
      source: "test_override",
    },
    parent: {
      threadId: "parent-thread",
      runId: "parent-run",
      messageId: "parent-message",
    },
    summary: {
      requiredEdgeKinds: ["restart", "stop", "detach", "cancel", "retry", "timeout", "partial_result"],
      coveredEdgeKinds: ["restart", "stop", "detach", "cancel", "retry", "timeout", "partial_result"],
      missingEdgeKinds: [],
      unsafeEdgeIds: [],
      liveTokens: false,
    },
    edges: [
      lifecycleEdge({
        id: "edge-restart",
        kind: "restart",
        label: "Restart after active child",
        parentBlockingStateBefore: "waiting_on_child",
        parentBlockingStateAfter: "interrupted_repair_visible",
        childRunIds: ["run-active"],
        childThreadIds: ["child-active"],
        observedEventIds: ["runtime-event-started", "repair-diagnostic-active-run"],
        restart: {
          interruptedRunIds: ["run-active"],
          diagnosticRunIds: ["run-active"],
          restartRepairObserved: true,
          nonResumableMarkedInterrupted: true,
        },
      }),
      lifecycleEdge({
        id: "edge-child-stop",
        kind: "stop",
        label: "Stopped child while sibling keeps running",
        parentBlockingStateBefore: "waiting_on_two_children",
        parentBlockingStateAfter: "needs_decision_after_stopped_child",
        childRunIds: ["run-stopped", "run-sibling"],
        childThreadIds: ["child-stopped", "child-sibling"],
        observedEventIds: ["cancel-event-stopped", "capacity-release-stopped"],
        stop: {
          stoppedRunIds: ["run-stopped"],
          siblingRunIdsUnaffected: ["run-sibling"],
          structuredCancellationResult: true,
          capacityReleased: true,
        },
      }),
      lifecycleEdge({
        id: "edge-detach",
        kind: "detach",
        label: "Detached child from parent wait",
        parentBlockingStateBefore: "waiting_on_detachable_child",
        parentBlockingStateAfter: "unblocked_detached_child_visible",
        childRunIds: ["run-detached"],
        childThreadIds: ["child-detached"],
        observedEventIds: ["mailbox-detach-decision", "mailbox-detach-cleanup"],
        detach: {
          detachedRunIds: ["run-detached"],
          detachedChildrenExcludedFromSynthesis: true,
          parentUnblockedAfterDecision: true,
          mailboxCleanupRecorded: true,
        },
      }),
      lifecycleEdge({
        id: "edge-parent-cancel",
        kind: "cancel",
        label: "Parent cancellation cascades to children",
        parentBlockingStateBefore: "waiting_on_children",
        parentBlockingStateAfter: "parent_cancelled_children_marked",
        childRunIds: ["run-cancel-a", "run-cancel-b"],
        childThreadIds: ["child-cancel-a", "child-cancel-b"],
        observedEventIds: ["parent-cancel-requested", "cancel-cascade-event"],
        cancel: {
          parentCancellationRequested: true,
          cancelledRunIds: ["run-cancel-a", "run-cancel-b"],
          cancellationCascadeRecorded: true,
          parentReturnedCancelledState: true,
        },
      }),
      lifecycleEdge({
        id: "edge-retry-child",
        kind: "retry",
        label: "Retry failed required child while parent stays blocked",
        parentBlockingStateBefore: "failed_required_child_waiting_for_decision",
        parentBlockingStateAfter: "retry_requested_parent_still_blocked",
        childRunIds: ["run-retry"],
        childThreadIds: ["child-retry"],
        observedEventIds: ["mailbox-retry-decision", "runtime-retry-started", "retry-mailbox-consumed"],
        retry: {
          retryRequestedRunIds: ["run-retry"],
          retryAcceptedRunIds: ["run-retry"],
          retryMailboxEventIds: ["mailbox-retry"],
          parentRemainedBlocked: true,
          childSessionRestarted: true,
        },
      }),
      lifecycleEdge({
        id: "edge-timeout",
        kind: "timeout",
        label: "Timed-out required child blocks unsafe synthesis",
        parentBlockingStateBefore: "waiting_on_required_child",
        parentBlockingStateAfter: "timed_out_needs_user_choice",
        childRunIds: ["run-timeout"],
        childThreadIds: ["child-timeout"],
        observedEventIds: ["barrier-timeout-event", "mailbox-timeout-attention"],
        timeout: {
          barrierStatus: "timed_out",
          failurePolicy: "ask_user",
          allowedUserChoiceIds: ["wait_again", "cancel_parent", "continue_with_partial"],
          noTimedOutChildSynthesis: true,
        },
      }),
      lifecycleEdge({
        id: "edge-partial-result",
        kind: "partial_result",
        label: "User explicitly continues with partial result",
        parentBlockingStateBefore: "waiting_on_failed_child",
        parentBlockingStateAfter: "partial_result_synthesis_allowed",
        childRunIds: ["run-complete", "run-failed"],
        childThreadIds: ["child-complete", "child-failed"],
        observedEventIds: ["barrier-partial-decision", "partial-summary-artifact"],
        partialResult: {
          decision: "continue_with_partial",
          partialSummaryIncluded: true,
          omittedChildRunIds: ["run-failed"],
          failedChildNotSynthesized: true,
          parentMarkedPartial: true,
        },
      }),
    ],
  };
}

function lifecycleEdge(edge) {
  return {
    ...edge,
    synthesisSafety: {
      parentDidNotSynthesizeUnsafeChild: true,
      resultArtifactStateExplicit: true,
      affectedChildrenNamed: true,
      decisionOrEventAttributed: true,
      visibleCollapsedThreadState: true,
    },
  };
}

function desktopDogfoodArtifact() {
  return {
    schemaVersion: "ambient-subagent-desktop-dogfood-v1",
    status: "passed",
    classification: "passed",
    provider: "gmi-cloud",
    featureFlag: "ambient.subagents",
    gitCommit: "desktop-dogfood-commit",
    scenarios: [...REQUIRED_DESKTOP_DOGFOOD_SCENARIOS],
    parentThreadId: "desktop-dogfood-parent-thread",
    parentMessageId: "desktop-dogfood-parent-message",
    childRunIds: ["desktop-dogfood-review-run", "desktop-dogfood-summary-run"],
    childThreadIds: ["desktop-dogfood-review-thread", "desktop-dogfood-summary-thread"],
    approvalId: "desktop-dogfood-approval-write",
    localRuntimeLeaseId: "desktop-dogfood-local-runtime-lease",
    localRuntimeId: "local-text-runtime",
    untrackedRuntimeId: "untracked-llama:4404",
    workflowTaskId: "callable-workflow:desktop-dogfood-map-reduce",
    workflowRunId: "desktop-dogfood-workflow-run",
    lifecycleEdgeParentMessageId: "desktop-dogfood-lifecycle-parent-message",
    lifecycleEdgeChildRunIds: [
      "desktop-dogfood-lifecycle-timeout-run",
      "desktop-dogfood-lifecycle-partial-run",
      "desktop-dogfood-lifecycle-retry-run",
      "desktop-dogfood-lifecycle-detached-run",
    ],
    parentStopCascadeParentMessageId: "desktop-dogfood-parent-stop-parent-message",
    parentStopCascadeChildRunIds: [
      "desktop-dogfood-parent-stop-required-run",
      "desktop-dogfood-parent-stop-background-run",
      "desktop-dogfood-parent-stop-completed-run",
    ],
    artifacts: {
      collapsedDesktopScreenshot: "test-results/subagent-desktop-dogfood/collapsed-desktop.png",
      expandedDesktopScreenshot: "test-results/subagent-desktop-dogfood/expanded-desktop.png",
      approvalDialogScreenshot: "test-results/subagent-desktop-dogfood/approval-forwarding-dialog.png",
      approvalForwardingDesktopScreenshot: "test-results/subagent-desktop-dogfood/approval-forwarded-desktop.png",
      workflowHighLoadDesktopScreenshot: "test-results/subagent-desktop-dogfood/workflow-high-load-desktop.png",
      lifecycleEdgeVisibilityDesktopScreenshot: "test-results/subagent-desktop-dogfood/lifecycle-edge-visibility-desktop.png",
      parentStopCascadeDesktopScreenshot: "test-results/subagent-desktop-dogfood/parent-stop-cascade-desktop.png",
      localRuntimeOwnershipDesktopScreenshot: "test-results/subagent-desktop-dogfood/local-runtime-ownership-desktop.png",
      expandedNarrowScreenshot: "test-results/subagent-desktop-dogfood/expanded-narrow.png",
      operatorBehaviorDesktopScreenshot: "test-results/subagent-desktop-dogfood/operator-behavior-desktop.png",
      childTranscriptExpandedDesktopScreenshot: "test-results/subagent-desktop-dogfood/child-transcript-expanded-desktop.png",
      completedChildTranscriptDesktopScreenshot: "test-results/subagent-desktop-dogfood/completed-child-transcript-desktop.png",
      deniedScopeExplanationDesktopScreenshot: "test-results/subagent-desktop-dogfood/denied-scope-explanation-desktop.png",
      effectiveRoleSnapshotDesktopScreenshot: "test-results/subagent-desktop-dogfood/effective-role-snapshot-desktop.png",
      multiClusterStressDesktopScreenshot: "test-results/subagent-desktop-dogfood/multi-cluster-stress-desktop.png",
      mutatingWorkerDogfoodDesktopScreenshot: "test-results/subagent-desktop-dogfood/mutating-worker-dogfood-desktop.png",
      patternGraphClickThroughDesktopScreenshot: "test-results/subagent-desktop-dogfood/pattern-graph-click-through-desktop.png",
      patternGraphCompletedClickThroughDesktopScreenshot:
        "test-results/subagent-desktop-dogfood/pattern-graph-completed-click-through-desktop.png",
      restartRehydrationDesktopScreenshot: "test-results/subagent-desktop-dogfood/restart-rehydration-desktop.png",
      workflowArtifactRehydrationDesktopScreenshot: "test-results/subagent-desktop-dogfood/workflow-artifact-rehydration-desktop.png",
      workflowExecutionDesktopScreenshot: "test-results/subagent-desktop-dogfood/workflow-execution-desktop.png",
      workflowRehydratedNavigationDesktopScreenshot: "test-results/subagent-desktop-dogfood/workflow-rehydrated-navigation-desktop.png",
      chatExportZip: "test-results/subagent-desktop-dogfood/desktop-chat-export.zip",
      accessibilitySnapshot: "test-results/subagent-desktop-dogfood/expanded-accessibility.json",
    },
    checks: {
      collapsed: {
        defaultCollapsed: true,
        horizontalOverflowFree: true,
      },
      expanded: {
        defaultCollapsed: false,
        horizontalOverflowFree: true,
        approvalFlow: {
          approvalRequested: true,
          approvalBlockedChild: true,
          parentStillBlocked: true,
          childIdentifierVisible: true,
          toolScopeVisible: true,
          approvalScopeVisible: true,
          approvalPromptVisible: true,
          approveButtonVisible: true,
          denyButtonVisible: true,
          approvalButtonsNameChild: true,
        },
      },
      narrow: {
        horizontalOverflowFree: true,
        criticalOverlapCount: 0,
      },
      childTranscript: desktopRunningChildTranscript(),
      completedChildTranscript: desktopCompletedChildTranscript(),
      workflowExecution: {
        workflowSectionVisible: true,
        parentBlockerVisible: true,
        taskIdVisible: true,
        artifactIdVisible: true,
        horizontalOverflowFree: true,
      },
      approvalForwarding: {
        forwardedVisible: true,
        approvedDecisionVisible: true,
        childThreadScopeVisible: true,
        forwardedNamesChild: true,
        forwardedNamesApproval: true,
        forwardedMatchesApprovalChild: true,
        approvalRequestMatchesApprovalChild: true,
        forwardedAndRequestSameChild: true,
        approvalRequestStillVisible: true,
        approvalRequestActionsRemoved: true,
        parentStillBlockedAfterForward: true,
        childRowDataMatchesApprovalChild: true,
        childRowStillBlocksApprovalChild: true,
        childReturnedToNeedsSteering: true,
        waitBarrierStillVisible: true,
        horizontalOverflowFree: true,
      },
      approvalDialog: {
        dialogOpened: true,
        dialogNamesApproval: true,
        dialogNamesChildRun: true,
        dialogNamesChildThread: true,
        dialogNamesBlockingChild: true,
        dialogShowsParentWaitState: true,
        dialogShowsPrompt: true,
        dialogShowsStandardScopes: true,
        initialScopeThisAction: true,
      },
      localRuntimeOwnership: {
        runtimeInventoryVisible: true,
        activeLeaseVisible: true,
        ownerLabelVisible: true,
        stopDisabledVisible: true,
        affectedSubagentVisible: true,
        untrackedRuntimeVisible: true,
        untrackedStopDisabledVisible: true,
        untrackedRestartDisabledVisible: true,
        untrackedExternalStopGuidanceVisible: true,
        horizontalOverflowFree: true,
      },
      lifecycleEdgeVisibility: {
        clusterVisible: true,
        clusterDefaultCollapsedBeforeOpen: true,
        timeoutChildVisible: true,
        partialChildVisible: true,
        retryChildVisible: true,
        retryDecisionVisible: true,
        detachedChildVisible: true,
        timeoutChoicesVisible: true,
        partialDecisionVisible: true,
        partialSummaryVisible: true,
        detachDecisionVisible: true,
        horizontalOverflowFree: true,
      },
      parentStopCascadeVisibility: {
        parentMessageVisible: true,
        clusterVisible: true,
        clusterDefaultCollapsedBeforeOpen: true,
        summaryVisible: true,
        requiredChildCancelledVisible: true,
        optionalChildDetachedVisible: true,
        completedChildUnchangedVisible: true,
        parentStoppedMailboxVisible: true,
        parentCancellationRequestedVisible: true,
        cancelledWaitBarrierVisible: true,
        cancelledMailboxEventsVisible: true,
        cascadeReasonVisible: true,
        cascadeIdentityCaptured: true,
        horizontalOverflowFree: true,
        criticalOverlapCount: 0,
      },
      operatorBehavior: {
        completedChildClosed: true,
        completedChildStillVisible: true,
        completedChildControlsReleased: true,
        attentionChildCancelled: true,
        attentionChildStillVisible: true,
        attentionCancelControlRemoved: true,
        siblingStatePreserved: true,
        lifecycleInterruptionVisible: true,
        typedBarrierConsequenceVisible: true,
        rowsStillInspectable: true,
        horizontalOverflowFree: true,
      },
      workflowHighLoad: {
        workflowRowCount: 6,
      },
      chatExport: {
        approvalAuthorityContract: {
          requestExported: true,
          forwardedExported: true,
          eventIdMatches: true,
          schemaMatches: true,
          childIdentityMatches: true,
          requestedToolMatches: true,
          requestedScopeThisAction: true,
          requestEffectiveScopeNarrow: true,
          forwardedEffectiveScopeChildThread: true,
          parentBlockingResumeMatches: true,
          forwardedParentBlockingResumeMatches: true,
          waitBarrierMatches: true,
          instructionPreservesBlocking: true,
        },
      },
    },
    visualAssertions: passedAssertions(REQUIRED_DESKTOP_VISUAL_ASSERTIONS),
    maturityAssertions: passedAssertions(REQUIRED_DESKTOP_MATURITY_ASSERTION_IDS, {
      desktop_chat_export_child_bundle: {
        capabilities: [
          "chat_export_child_bundle",
          "child_transcript_export",
          "child_full_transcript_export",
          "policy_provenance_export",
          "pattern_graph_export_links",
          "parent_mailbox_approval_export",
          "child_pi_session_status_export",
          "wait_barrier_export",
          "result_artifact_export",
          "lifecycle_edge_child_export",
          "parent_stop_child_export",
        ],
      },
    }),
  };
}

function desktopRunningChildTranscript() {
  return {
    childExpanded: true,
    transcriptPanelVisible: true,
    liveTranscriptShellVisible: true,
    liveTranscriptStreamVisible: true,
    liveTranscriptStatusVisible: true,
    miniThreadHeaderVisible: true,
    miniThreadHeaderNamesChild: true,
    openFullThreadActionVisible: true,
    openFullThreadActionNamesChild: true,
    liveTranscriptMessageCountVisible: true,
    liveTranscriptRuntimeEventCountVisible: true,
    liveTranscriptMessageCountMatchesBubbles: true,
    liveTranscriptRuntimeEventCountPositive: true,
    liveTranscriptModeLabelVisible: true,
    childStreaming: false,
    runtimeEventRailVisible: true,
    runtimeEventRailHasRecentEvents: true,
    runtimeTimelineVisible: true,
    runtimeTimelineCountVisible: true,
    runtimeTimelineRenderedCountMatchesRows: true,
    runtimeTimelineOmittedCountConsistent: true,
    runtimeEventRows: 3,
    userMessageVisible: true,
    assistantMessageVisible: true,
    siblingSummaryNotLeakedIntoTranscript: true,
    childRunIdVisible: true,
    childThreadIdVisible: true,
    messageBubbleCount: 2,
    childTranscriptTerminal: false,
    childTranscriptSynthesisSafe: false,
    liveContinuationMarkerVisible: true,
    liveContinuationMarkerAfterMessages: true,
    completionEndCapVisible: false,
    completionEndCapAfterMessages: false,
    completionSummaryDeferredWhileLive: true,
    transcriptEndStateCorrect: true,
    summaryNotObscuringTranscript: true,
    horizontalOverflowFree: true,
    criticalOverlapCount: 0,
  };
}

function desktopCompletedChildTranscript() {
  return {
    childExpanded: true,
    transcriptPanelVisible: true,
    liveTranscriptShellVisible: true,
    liveTranscriptStreamVisible: true,
    liveTranscriptStatusVisible: true,
    miniThreadHeaderVisible: true,
    miniThreadHeaderNamesChild: true,
    openFullThreadActionVisible: true,
    openFullThreadActionNamesChild: true,
    liveTranscriptMessageCountVisible: true,
    liveTranscriptRuntimeEventCountVisible: true,
    liveTranscriptMessageCountMatchesBubbles: true,
    liveTranscriptRuntimeEventCountPositive: true,
    liveTranscriptModeLabelVisible: true,
    childStreaming: false,
    runtimeEventRailVisible: true,
    runtimeEventRailHasRecentEvents: true,
    runtimeTimelineVisible: true,
    runtimeTimelineCountVisible: true,
    runtimeTimelineRenderedCountMatchesRows: true,
    runtimeTimelineOmittedCountConsistent: true,
    runtimeEventRows: 2,
    userMessageVisible: false,
    assistantMessageVisible: true,
    siblingSummaryNotLeakedIntoTranscript: true,
    childRunIdVisible: true,
    childThreadIdVisible: true,
    messageBubbleCount: 1,
    childTranscriptTerminal: true,
    childTranscriptSynthesisSafe: true,
    liveContinuationMarkerVisible: false,
    liveContinuationMarkerAfterMessages: false,
    completionEndCapVisible: true,
    completionEndCapText: "Completion summary\nCompleted\nContext summarizer completed",
    completionEndCapLabelVisible: true,
    completionEndCapAfterMessages: true,
    completionSummaryDeferredWhileLive: true,
    transcriptEndStateCorrect: true,
    summaryNotObscuringTranscript: true,
    horizontalOverflowFree: true,
    criticalOverlapCount: 0,
  };
}

function passedAssertions(ids, overrides = {}) {
  return Object.fromEntries(
    ids.map((id) => [
      id,
      {
        id,
        status: "passed",
        evidence: [`passed: ${id}`],
        ...(overrides[id] ?? {}),
      },
    ]),
  );
}

async function waitForPidFile(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(path, "utf8");
      const pids = text
        .split(/\s+/)
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0);
      if (pids.length >= 2) return pids;
    } catch (error) {
      lastError = error;
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for pid file ${path}: ${lastError?.message ?? "not ready"}`);
}

async function waitForProcessExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await sleep(25);
  }
  throw new Error(`Process ${pid} was still running after abort cleanup.`);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export {
  liveSmokeArtifact,
  longContextAuthorityArtifact,
  approvalAuthorityArtifact,
  browserApprovalArtifact,
  liveWorkflowArtifact,
  workflowUiDogfoodMatrixArtifact,
  workflowUiBroaderDogfoodMatrixArtifact,
  callableWorkflowDogfoodArtifact,
  callableWorkflowRehydrationArtifact,
  localRuntimeControlProofArtifact,
  repeatedUntrackedObservations,
  localRuntimeControlProofGateArtifact,
  restartRepairDiagnosticsArtifact,
  restartRepairReplayEvidence,
  restartRehydrationProof,
  lifecycleEdgeArtifact,
  lifecycleEdge,
  desktopDogfoodArtifact,
  desktopRunningChildTranscript,
  desktopCompletedChildTranscript,
  passedAssertions,
  waitForPidFile,
  waitForProcessExit,
  processExists,
};
