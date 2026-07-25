import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAmbientModelRuntimeSnapshot } from "../../shared/ambientModels";
import { AMBIENT_SUBAGENTS_FEATURE_FLAG, resolveAmbientFeatureFlags } from "../../shared/featureFlags";
import { effectiveSubagentRoleSnapshot } from "../../shared/subagentPatternGraph";
import { getDefaultSubagentRoleProfile } from "../../shared/subagentRoles";
import {
  buildCallableWorkflowExecutionPlan,
  buildCallableWorkflowRegistry,
  buildCallableWorkflowRunPlan,
  parentPiVisibleCallableWorkflowTools,
} from "../callable-workflow/callableWorkflowTestContract";
import { createChatExportBundle } from "./chatExport";
import { ProjectStore } from "./chatExportProjectStoreFacade";

describe("chat export", () => {
  let workspacePath = "";
  let extraPaths: string[] = [];

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), "ambient-chat-export-"));
    extraPaths = [];
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
    for (const path of extraPaths) await rm(path, { recursive: true, force: true });
  });

  it("exports the full redacted Pi session with the visible transcript", async () => {
    const store = new ProjectStore();
    try {
      const workspace = store.openWorkspace(workspacePath);
      const created = store.createThread("Debug chat");
      const threadSessionDir = join(workspace.sessionPath, created.id);
      await mkdir(threadSessionDir, { recursive: true });
      const sessionFile = join(threadSessionDir, "session.jsonl");
      const largeTail = `tail-${"x".repeat(300_000)}-end`;
      await writeFile(
        sessionFile,
        `{"type":"session","version":3}\n{"type":"message","message":{"role":"assistant","content":"api_key=ambient-abcdefghijklmnopqrstuvwxyz0123456789 ${largeTail}"}}\n`,
        "utf8",
      );
      const thread = store.updateThreadSettings(created.id, { piSessionFile: sessionFile });
      store.addMessage({
        threadId: thread.id,
        role: "user",
        content: "Bearer abcdefghijklmnopqrstuv",
      });
      store.recordContextUsageSnapshot({
        threadId: thread.id,
        source: "estimate",
        tokens: 12,
        contextWindow: 100,
        percent: 12,
        compactionCount: 0,
        diagnostics: { piSessionFile: sessionFile, activeSession: true },
      });

      const payload = await createChatExportBundle(store, thread.id, {
        appName: "Ambient",
        appVersion: "0.1.0",
        now: new Date("2026-05-19T00:00:00.000Z"),
      });
      const zip = await JSZip.loadAsync(payload.archive);

      expect(payload.source).toBe("pi-session");
      expect(payload.fileName).toBe("ambient-chat-export-debug-chat-2026-05-19T00-00-00-000Z.zip");
      const session = await zipText(zip, "pi-session.jsonl");
      expect(session).toContain("tail-");
      expect(session).toContain("-end");
      expect(session).not.toContain("ambient-abcdefghijklmnopqrstuvwxyz0123456789");
      expect(session).toContain("[REDACTED]");

      const transcript = await zipText(zip, "visible-transcript.json");
      expect(transcript).not.toContain("Bearer abcdefghijklmnopqrstuv");
      expect(transcript).toContain("Bearer [REDACTED]");

      const contextUsage = JSON.parse(await zipText(zip, "context-usage.json")) as Record<string, unknown>;
      expect(contextUsage).toMatchObject({ threadId: thread.id, tokens: 12 });

      const manifest = JSON.parse(await zipText(zip, "manifest.json")) as Record<string, any>;
      expect(manifest.export).toMatchObject({
        source: "pi-session",
        originalPiSessionFileExists: true,
      });
      expect(manifest.export.includedFiles).toContain("pi-session.jsonl");
      expect(manifest.redaction.replacementCount).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it("falls back to the visible transcript when the recorded Pi session file is missing", async () => {
    const store = new ProjectStore();
    try {
      const workspace = store.openWorkspace(workspacePath);
      const created = store.createThread("Missing session");
      const missingSessionFile = join(workspace.sessionPath, created.id, "missing.jsonl");
      const thread = store.updateThreadSettings(created.id, { piSessionFile: missingSessionFile });
      store.addMessage({ threadId: thread.id, role: "assistant", content: "Visible answer" });

      const payload = await createChatExportBundle(store, thread.id, {
        appName: "Ambient",
        appVersion: "0.1.0",
        now: new Date("2026-05-19T00:00:00.000Z"),
      });
      const zip = await JSZip.loadAsync(payload.archive);

      expect(payload.source).toBe("visible-chat-fallback");
      expect(payload.fallbackReason).toContain("missing");
      expect(zip.file("pi-session.jsonl")).toBeNull();
      expect(await zipText(zip, "visible-transcript.md")).toContain("Visible answer");
      expect(store.getThread(thread.id).piSessionFile).toBe(missingSessionFile);

      const manifest = JSON.parse(await zipText(zip, "manifest.json")) as Record<string, any>;
      expect(manifest.export).toMatchObject({
        source: "visible-chat-fallback",
        originalPiSessionFileExists: false,
      });
      expect(manifest.export.fallbackReason).toContain("missing");
    } finally {
      store.close();
    }
  });

  it("aliases credential-bearing paths in exports while preserving ordinary paths", async () => {
    const store = new ProjectStore();
    try {
      const workspace = store.openWorkspace(workspacePath);
      const thread = store.createThread("Path redaction");
      const sensitivePath = join(workspace.path, "ignored-provider-key-file.txt");
      const ordinaryPath = join(workspace.path, "src", "index.ts");
      store.addMessage({
        threadId: thread.id,
        role: "assistant",
        content: `Debug ${sensitivePath} and then inspect ${ordinaryPath}.`,
      });

      const payload = await createChatExportBundle(store, thread.id, {
        appName: "Ambient",
        appVersion: "0.1.0",
        now: new Date("2026-05-19T00:00:00.000Z"),
      });
      const zip = await JSZip.loadAsync(payload.archive);
      const transcript = await zipText(zip, "visible-transcript.md");

      expect(transcript).toContain("sensitive-path-ref:v1:");
      expect(transcript).toContain(ordinaryPath);
      expect(transcript).not.toContain("ignored-provider-key-file.txt");
      expect(transcript).not.toContain("[REDACTED_CREDENTIAL_PATH]");
      expect(transcript).not.toContain("[REDACTED] and then inspect");
      const manifest = JSON.parse(await zipText(zip, "manifest.json")) as Record<string, any>;
      expect(manifest.redaction.replacementCount).toBeGreaterThanOrEqual(1);
    } finally {
      store.close();
    }
  });

  it("exports a clean visible transcript with typed tool artifacts", async () => {
    const store = new ProjectStore();
    try {
      store.openWorkspace(workspacePath);
      const thread = store.createThread("Mixed transcript");
      store.addMessage({ threadId: thread.id, role: "user", content: "Ask the local model." });
      store.addMessage({ threadId: thread.id, role: "assistant", content: "", metadata: { status: "done" } });
      store.addMessage({ threadId: thread.id, role: "assistant", content: "Inspecting route.", metadata: { kind: "thinking", status: "done" } });
      store.addMessage({
        threadId: thread.id,
        role: "user",
        content: "Continue working toward the active Ambient Desktop thread goal.",
        metadata: {
          runtime: "ambient-internal",
          kind: "hidden-user-message",
          hiddenFromTranscript: true,
          hiddenUserMessage: true,
        },
      });
      store.addMessage({ threadId: thread.id, role: "assistant", content: "I will delegate this." });
      store.addMessage({
        threadId: thread.id,
        role: "tool",
        content: "ambient_cli completed\n\nResult:\nDelegated model response stored.",
        metadata: {
          status: "done",
          toolName: "ambient_cli",
          toolCallId: "call-model",
          toolResultDetails: {
            largeOutputPreview: {
              kind: "large-output",
              summary: "stdout · 42 chars · full output: .ambient/tool-outputs/model.txt",
              items: [{
                label: "stdout",
                chars: 42,
                previewChars: 42,
                truncated: false,
                artifactKind: "stdout",
                artifactPath: ".ambient/tool-outputs/model.txt",
                artifactBytes: 42,
              }],
            },
            externalModelResponse: {
              kind: "external-model-response",
              label: "delegated local model",
              verbatim: true,
              chars: 42,
              previewChars: 42,
              truncated: false,
              artifactPath: ".ambient/tool-outputs/model.txt",
              artifactBytes: 42,
              model: "local-test-model",
              usage: { outputTokens: 9 },
            },
          },
        },
      });

      const payload = await createChatExportBundle(store, thread.id, {
        appName: "Ambient",
        appVersion: "0.1.0",
        now: new Date("2026-05-19T00:00:00.000Z"),
      });
      const zip = await JSZip.loadAsync(payload.archive);
      const visible = JSON.parse(await zipText(zip, "visible-transcript.json")) as Record<string, any>;
      const artifacts = JSON.parse(await zipText(zip, "artifacts.json")) as Record<string, any>;
      const markdown = await zipText(zip, "visible-transcript.md");

      expect(visible.messages.map((message: any) => message.content)).toEqual([
        "Ask the local model.",
        "I will delegate this.",
        "ambient_cli completed\n\nResult:\nDelegated model response stored.",
      ]);
      expect(visible.exportStats).toMatchObject({
        hiddenThinkingMessageCount: 1,
        hiddenEmptyAssistantMessageCount: 1,
        artifactCount: 2,
      });
      expect(visible.messages.some((message: any) => message.metadata?.kind === "thinking")).toBe(false);
      expect(visible.messages.some((message: any) => message.metadata?.hiddenFromTranscript === true)).toBe(false);
      expect(visible.messages.some((message: any) => message.role === "assistant" && !message.content.trim())).toBe(false);
      expect(artifacts.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "stdout",
          artifactPath: ".ambient/tool-outputs/model.txt",
          toolName: "ambient_cli",
        }),
        expect.objectContaining({
          kind: "external-model-response",
          artifactPath: ".ambient/tool-outputs/model.txt",
          verbatim: true,
          model: "local-test-model",
          usage: { outputTokens: 9 },
        }),
      ]));
      expect(markdown).not.toContain("Inspecting route.");
      expect(markdown).not.toContain("Continue working toward the active Ambient Desktop thread goal.");
      expect(markdown).toContain("external-model-response: delegated local model");
    } finally {
      store.close();
    }
  });

  it("includes direct sub-agent child transcripts and runtime evidence", async () => {
    const store = new ProjectStore();
    try {
      const workspace = store.openWorkspace(workspacePath);
      const parent = store.createThread("Parent with child threads");
      const parentMessage = store.addMessage({
        threadId: parent.id,
        role: "assistant",
        content: "Launching a reader child.",
      });
      const parentRun = store.startRun({ threadId: parent.id, assistantMessageId: parentMessage.id });
      const featureFlagSnapshot = enabledSubagentFeatureFlags();
      const task = store.enqueueCallableWorkflowTask({
        executionPlan: executionPlanForParent(parent.id, parentRun.id, parentMessage.id, featureFlagSnapshot),
        featureFlagSnapshot,
      });
      const run = store.createSubagentRun({
        parentThreadId: parent.id,
        parentRunId: parentRun.id,
        parentMessageId: parentMessage.id,
        title: "Reader child",
        roleId: "explorer",
        roleProfileSnapshot: getDefaultSubagentRoleProfile("explorer"),
        canonicalTaskPath: "root/0:explorer",
        featureFlagSnapshot,
        modelRuntimeSnapshot: createAmbientModelRuntimeSnapshot(parent.model, "2026-05-19T00:00:00.000Z"),
        dependencyMode: "required",
        effectiveRoleSnapshot: effectiveSubagentRoleSnapshot({
          baseRole: "explorer",
          patternRole: "mapper",
          overlayLabels: ["Read-only source slice"],
          outputContract: "Return extracted evidence for the reducer.",
        }),
      });
      const boundTask = store.bindCallableWorkflowTaskPatternGraphChild({
        workflowTaskId: task.id,
        roleNodeId: "mapper",
        childRunId: run.id,
        label: "Reader child",
        updatedAt: "2026-05-19T00:00:02.500Z",
      });
      store.addMessage({
        threadId: run.childThreadId,
        role: "user",
        content: "Read the markdown and summarize it.",
      });
      store.addMessage({
        threadId: run.childThreadId,
        role: "assistant",
        content: "CHILD_THINKING_ROUTE api_key=ambient-abcdefghijklmnopqrstuvwxyz0123456789",
        metadata: { kind: "thinking", status: "done" },
      });
      store.addMessage({
        threadId: run.childThreadId,
        role: "assistant",
        content: "",
        metadata: { status: "streaming", runtimeEvent: "assistant_delta" },
      });
      store.addMessage({
        threadId: run.childThreadId,
        role: "assistant",
        content: "Child found the requested text.",
      });
      store.appendSubagentRunEvent(run.id, {
        type: "test.child_progress",
        preview: { summary: "Child transcript is exportable." },
        createdAt: "2026-05-19T00:00:03.000Z",
      });
      store.appendSubagentMailboxEvent(run.id, {
        direction: "child_to_parent",
        type: "subagent.progress",
        payload: { summary: "Reading is underway." },
        deliveryState: "delivered",
        createdAt: "2026-05-19T00:00:04.000Z",
      });
      store.appendSubagentRunEvent(run.id, {
        type: "subagent.wait_agent.progress",
        preview: {
          waitOutcome: { kind: "progress_return", reason: "parent_wait_window_elapsed" },
          waitBarrierId: "pending-barrier-id",
          childRunIds: [run.id],
        },
        createdAt: "2026-05-19T00:00:04.050Z",
      });
      store.recordSubagentToolScopeSnapshot(run.id, {
        scope: {
          schemaVersion: "ambient-subagent-tool-scope-v1",
          loadedCategories: ["workspace.read", "artifact.read", "long-context.read"],
          piVisibleCategories: ["workspace.read", "artifact.read", "long-context.read"],
          deniedCategories: [{
            id: "workspace.write",
            reason: "Denied by child task intent file_read; read-only child does not need Downloads writes.",
          }],
          loadedTools: [
            { source: "built_in", id: "workspace.read", categoryId: "workspace.read", piVisible: true, mutatesState: false, requiresApproval: false },
            { source: "built_in", id: "long_context_process", categoryId: "long-context.read", piVisible: true, mutatesState: false, requiresApproval: false },
          ],
          piVisibleTools: [
            { source: "built_in", id: "workspace.read", categoryId: "workspace.read", piVisible: true, mutatesState: false, requiresApproval: false },
            { source: "built_in", id: "long_context_process", categoryId: "long-context.read", piVisible: true, mutatesState: false, requiresApproval: false },
          ],
          deniedTools: [{
            source: "built_in",
            id: "workspace.write",
            categoryId: "workspace.write",
            reason: "Read-only child task; parent narrowed mutation rights before launch.",
          }],
          approvalMode: "interactive",
          worktreeIsolated: false,
          fanoutAvailable: false,
        },
        resolverInputs: {
          childAuthority: {
            taskIntent: "file_read",
            readRoots: ["/Users/travis/Downloads"],
            writeRoots: [],
            rationale: "Read and summarize the requested files only.",
          },
        },
        createdAt: "2026-05-19T00:00:04.250Z",
      });
      store.appendSubagentMailboxEvent(run.id, {
        direction: "child_to_parent",
        type: "subagent.approval_requested",
        payload: {
          schemaVersion: "ambient-subagent-approval-bridge-v1",
          approvalId: "approval-reader-downloads",
          childRunId: run.id,
          childThreadId: run.childThreadId,
          canonicalTaskPath: run.canonicalTaskPath,
          requestedScope: "child_thread",
          action: "workspace.read",
        },
        deliveryState: "queued",
        createdAt: "2026-05-19T00:00:04.300Z",
      });
      store.appendSubagentRunEvent(run.id, {
        type: "subagent.approval_requested",
        preview: {
          schemaVersion: "ambient-subagent-approval-bridge-v1",
          approvalId: "approval-reader-downloads",
          childRunId: run.id,
          childThreadId: run.childThreadId,
          canonicalTaskPath: run.canonicalTaskPath,
        },
        createdAt: "2026-05-19T00:00:04.350Z",
      });
      store.appendSubagentParentMailboxEvent({
        parentThreadId: parent.id,
        parentRunId: parentRun.id,
        parentMessageId: parentMessage.id,
        type: "subagent.child_approval_requested",
        payload: {
          schemaVersion: "ambient-subagent-approval-bridge-v1",
          approvalId: "approval-reader-downloads",
          childRunId: run.id,
          childThreadId: run.childThreadId,
          canonicalTaskPath: run.canonicalTaskPath,
          requestedScope: "child_thread",
          parentBlocking: {
            action: "forward_child_approval_then_wait",
            childRunId: run.id,
          },
        },
        deliveryState: "queued",
        idempotencyKey: "approval-reader-downloads-request",
        createdAt: "2026-05-19T00:00:04.400Z",
      });
      store.upsertSubagentGroupedCompletionNotification({
        parentThreadId: parent.id,
        parentRunId: parentRun.id,
        parentMessageId: parentMessage.id,
        child: {
          runId: run.id,
          childThreadId: run.childThreadId,
          canonicalTaskPath: run.canonicalTaskPath,
          roleId: run.roleId,
          status: "completed",
          summary: "Child found the requested text.",
          completedAt: "2026-05-19T00:00:05.000Z",
        },
        createdAt: "2026-05-19T00:00:05.000Z",
      });
      store.markSubagentRunStatus(run.id, "completed", {
        now: "2026-05-19T00:00:05.500Z",
        resultArtifact: {
          schemaVersion: "ambient-subagent-result-artifact-v1",
          runId: run.id,
          childThreadId: run.childThreadId,
          status: "completed",
          summary: "Child found the requested text.",
          partial: false,
        },
      });
      const barrier = store.createSubagentWaitBarrier({
        parentThreadId: parent.id,
        parentRunId: parentRun.id,
        childRunIds: [run.id],
        dependencyMode: "required_all",
        failurePolicy: "ask_user",
        timeoutMs: 60_000,
        createdAt: "2026-05-19T00:00:06.000Z",
      });
      const hiddenWaitToolMessage = store.addMessage({
        threadId: parent.id,
        role: "assistant",
        content: "",
        metadata: {
          status: "done",
          toolName: "ambient_subagent",
          toolCallId: "hidden-wait-reader-child",
          inputContent: JSON.stringify({
            action: "wait_agent",
            childRunId: run.id,
            waitBarrierId: barrier.id,
            timeoutMs: 60000,
            idempotencyKey: "hidden-wait-reader-child-once",
          }),
        },
      });
      store.addMessage({
        threadId: parent.id,
        role: "tool",
        content: [
          "ambient_subagent completed",
          "",
          "Input",
          JSON.stringify({ action: "wait_agent", childRunId: run.id, waitBarrierId: barrier.id, timeoutMs: 60000 }),
          "",
          "Result",
          JSON.stringify({
            waitOutcome: { kind: "progress_return", reason: "parent_wait_window_elapsed" },
            waitBarrier: { id: barrier.id, status: "waiting_on_children" },
            waitBarrierBlockers: [{
              childRunId: run.id,
              childThreadId: run.childThreadId,
              lastActivityAt: "2026-05-19T00:00:05.500Z",
              lastActivitySource: "run_event:subagent.status_changed",
            }],
          }),
        ].join("\n"),
        metadata: {
          status: "done",
          toolName: "ambient_subagent",
          toolCallId: "wait-reader-child",
          waitOutcome: { kind: "progress_return", reason: "parent_wait_window_elapsed" },
          waitBarrierId: barrier.id,
          childRunIds: [run.id],
          inputContent: JSON.stringify({
            action: "wait_agent",
            childRunId: run.id,
            waitBarrierId: barrier.id,
            timeoutMs: 60000,
            idempotencyKey: "wait-reader-child-once",
          }),
        },
      });
      store.appendSubagentMailboxEvent(run.id, {
        direction: "child_to_parent",
        type: "subagent.wait_completed",
        payload: {
          schemaVersion: "ambient-subagent-wait-completion-v1",
          runId: run.id,
          parentRunId: parentRun.id,
          childThreadId: run.childThreadId,
          canonicalTaskPath: run.canonicalTaskPath,
          status: "completed",
          waitTimedOut: false,
          synthesisAllowed: true,
          resultValidation: { valid: true, synthesisAllowed: true, partial: false, status: "completed" },
          waitBarrier: { id: barrier.id, status: "satisfied" },
        },
        deliveryState: "delivered",
        createdAt: "2026-05-19T00:00:06.250Z",
        deliveredAt: "2026-05-19T00:00:06.250Z",
      });
      store.appendSubagentParentMailboxEvent({
        parentThreadId: parent.id,
        parentRunId: parentRun.id,
        parentMessageId: parentMessage.id,
        type: "subagent.wait_barrier_attention",
        payload: {
          schemaVersion: "ambient-subagent-wait-barrier-attention-v1",
          parentThreadId: parent.id,
          parentRunId: parentRun.id,
          childRunId: run.id,
          childThreadId: run.childThreadId,
          canonicalTaskPath: run.canonicalTaskPath,
          waitBarrierId: barrier.id,
          barrierStatus: "waiting_on_children",
          childRunIds: [run.id],
          parentFinalizationBlocked: true,
          parentResolution: { status: "blocked", action: "wait_for_child", canSynthesize: false },
          reason: "Parent finalization attempted before the wait barrier was satisfied.",
        },
        deliveryState: "queued",
        idempotencyKey: `subagent:finalization_blocked:${parentRun.id}:${barrier.id}`,
        createdAt: "2026-05-19T00:00:06.500Z",
      });
      store.updateSubagentWaitBarrierStatus(barrier.id, "satisfied", {
        now: "2026-05-19T00:00:07.000Z",
        resolutionArtifact: {
          schemaVersion: "ambient-subagent-wait-barrier-resolution-v1",
          childRunIds: [run.id],
          childStatuses: [{ childRunId: run.id, status: "completed" }],
          timedOut: false,
          transitionEvidence: {
            schemaVersion: "ambient-subagent-wait-barrier-transition-evidence-v1",
            kind: "child_terminal",
            source: "wait_agent",
            childRunId: run.id,
            reason: "child_completed_after_progress_return",
          },
          synthesisAllowed: true,
          resultArtifact: {
            schemaVersion: "ambient-subagent-result-artifact-v1",
            runId: run.id,
            status: "completed",
            summary: "Child found the requested text.",
          },
        },
      });
      store.appendSubagentParentMailboxEvent({
        parentThreadId: parent.id,
        parentRunId: parentRun.id,
        parentMessageId: parentMessage.id,
        type: "subagent.wait_barrier_decision",
        payload: {
          schemaVersion: "ambient-subagent-wait-barrier-decision-v1",
          toolCallId: "decision-reader-child",
          parentThreadId: parent.id,
          parentRunId: parentRun.id,
          waitBarrierId: barrier.id,
          barrierStatus: "satisfied",
          childRunIds: [run.id],
          childStatuses: [{ childRunId: run.id, status: "completed" }],
          decision: "wait_again",
          parentResolution: { status: "resolved", action: "wait_for_child", canSynthesize: true },
          waitBarrier: { id: barrier.id, status: "satisfied" },
        },
        deliveryState: "delivered",
        idempotencyKey: "decision-reader-child-once",
        createdAt: "2026-05-19T00:00:07.250Z",
        deliveredAt: "2026-05-19T00:00:07.250Z",
      });
      const childSessionDir = join(workspace.sessionPath, run.childThreadId);
      await mkdir(childSessionDir, { recursive: true });
      const childSessionFile = join(childSessionDir, "session.jsonl");
      await writeFile(
        childSessionFile,
        '{"type":"message","message":{"role":"assistant","content":"child session transcript"}}\n',
        "utf8",
      );
      store.updateThreadSettings(run.childThreadId, { piSessionFile: childSessionFile });

      const payload = await createChatExportBundle(store, parent.id, {
        appName: "Ambient",
        appVersion: "0.1.0",
        now: new Date("2026-05-19T00:00:00.000Z"),
      });
      const zip = await JSZip.loadAsync(payload.archive);
      const manifest = JSON.parse(await zipText(zip, "manifest.json")) as Record<string, any>;
      const index = JSON.parse(await zipText(zip, "child-threads/index.json")) as Record<string, any>;
      const childDir = index.children[0].dir as string;

      expect(manifest.export).toMatchObject({
        childThreadCount: 1,
        childVisibleMessageCount: 2,
        childHiddenMessageCount: 2,
        childPiSessionCount: 1,
        callableWorkflowTaskCount: 1,
        patternGraphCount: 1,
        patternGraphLinkedChildCount: 1,
      });
      expect(manifest.export.includedFiles).toEqual(expect.arrayContaining([
        "child-threads/index.json",
        "child-threads/evidence-summary.json",
        "child-threads/parent-mailbox-events.json",
        "child-threads/callable-workflow-tasks.json",
        "child-threads/pattern-graphs.json",
        `${childDir}/full-transcript.json`,
        `${childDir}/full-transcript.md`,
        `${childDir}/visible-transcript.md`,
        `${childDir}/pi-session.jsonl`,
        `${childDir}/run-events.json`,
        `${childDir}/mailbox-events.json`,
        `${childDir}/wait-barriers.json`,
      ]));
      expect(await zipText(zip, "visible-transcript.json")).not.toContain("hidden-wait-reader-child");
      expect(index.children[0]).toMatchObject({
        run: { id: run.id, childThreadId: run.childThreadId },
        thread: { id: run.childThreadId, parentThreadId: parent.id },
        piSession: { included: true, originalPiSessionFileExists: true },
      });
      expect(index).toMatchObject({
        callableWorkflowTaskCount: 1,
        patternGraphCount: 1,
        patternGraphLinkedChildCount: 1,
        callableWorkflowTasks: [
          expect.objectContaining({
            id: task.id,
            hasPatternGraph: true,
            toolName: "ambient_workflow_symphony_map_reduce",
          }),
        ],
        patternGraphs: [
          expect.objectContaining({
            workflowTaskId: task.id,
            patternId: "map_reduce",
            childTranscriptLinks: [
              expect.objectContaining({
                nodeId: `mapper:${run.id}`,
                childRunId: run.id,
                childThreadId: run.childThreadId,
                transcriptPath: `${childDir}/visible-transcript.md`,
                exportState: "included",
              }),
            ],
          }),
        ],
      });
      const visibleTranscript = await zipText(zip, `${childDir}/visible-transcript.md`);
      const fullTranscript = await zipText(zip, `${childDir}/full-transcript.md`);
      const fullTranscriptJson = JSON.parse(await zipText(zip, `${childDir}/full-transcript.json`)) as Record<string, any>;
      expect(visibleTranscript).toContain("Child found the requested text.");
      expect(visibleTranscript).not.toContain("CHILD_THINKING_ROUTE");
      expect(fullTranscript).toContain("CHILD_THINKING_ROUTE");
      expect(fullTranscript).toContain("[REDACTED]");
      expect(fullTranscript).not.toContain("ambient-abcdefghijklmnopqrstuvwxyz0123456789");
      expect(fullTranscript).toContain("assistant (thinking)");
      expect(fullTranscript).toContain("Exported source messages: 4");
      expect(fullTranscriptJson.messages).toHaveLength(4);
      expect(fullTranscriptJson.messages.some((message: any) => message.metadata?.kind === "thinking")).toBe(true);
      expect(JSON.stringify(fullTranscriptJson)).not.toContain("ambient-abcdefghijklmnopqrstuvwxyz0123456789");
      expect(await zipText(zip, `${childDir}/pi-session.jsonl`)).toContain("child session transcript");
      expect(await zipText(zip, `${childDir}/run-events.json`)).toContain("test.child_progress");
      expect(await zipText(zip, `${childDir}/mailbox-events.json`)).toContain("Reading is underway.");
      expect(await zipText(zip, `${childDir}/tool-scope-snapshots.json`)).toContain("long_context_process");
      expect(await zipText(zip, `${childDir}/wait-barriers.json`)).toContain("required_all");
      expect(await zipText(zip, "child-threads/parent-mailbox-events.json")).toContain("Child found the requested text.");
      const evidenceSummary = JSON.parse(await zipText(zip, "child-threads/evidence-summary.json")) as Record<string, any>;
      expect(evidenceSummary).toMatchObject({
        childThreadCount: 1,
        approvalBridgeEventCount: 1,
        waitEvidence: {
          waitBarrierCount: 1,
          waitSessionCount: 2,
          progressReturnCount: expect.any(Number),
          barrierTransitionCount: 1,
          finalizationBlockCount: 1,
          rawToolArgumentMessageCount: 2,
          childrenWithProgressReturns: [run.id],
          childrenWithFinalizationBlocks: [run.id],
        },
        children: [
          expect.objectContaining({
            runId: run.id,
            childThreadId: run.childThreadId,
            canonicalTaskPath: run.canonicalTaskPath,
            status: "completed",
            files: expect.objectContaining({
              fullTranscriptJson: `${childDir}/full-transcript.json`,
              fullTranscriptMarkdown: `${childDir}/full-transcript.md`,
              visibleTranscriptMarkdown: `${childDir}/visible-transcript.md`,
              toolScopeSnapshots: `${childDir}/tool-scope-snapshots.json`,
              piSession: `${childDir}/pi-session.jsonl`,
            }),
            transcript: expect.objectContaining({
              sourceMessageCount: 4,
              visibleMessageCount: 2,
              hiddenMessageCount: 2,
              hiddenThinkingMessageCount: 1,
              hiddenEmptyAssistantMessageCount: 1,
              piSessionIncluded: true,
            }),
            role: expect.objectContaining({
              roleId: "explorer",
              effectiveRole: expect.objectContaining({
                patternRole: "mapper",
                roleOverlayIds: ["mapper.read-only-source-slice"],
              }),
            }),
            authority: expect.objectContaining({
              toolScopeSnapshotCount: 1,
              latestToolScopeSnapshot: expect.objectContaining({
                approvalMode: "interactive",
                piVisibleCategories: ["workspace.read", "artifact.read", "long-context.read"],
                displayMetadata: expect.objectContaining({
                  deniedCategoryIds: ["workspace.write"],
                  deniedToolIds: ["built_in:workspace.write"],
                }),
              }),
            }),
            approvals: expect.objectContaining({
              childMailboxApprovalEventCount: 1,
              runApprovalEventCount: 1,
              parentApprovalBridgeEventCount: 1,
            }),
            resultArtifact: expect.objectContaining({
              present: true,
              status: "completed",
              summary: "Child found the requested text.",
              partial: false,
            }),
            waitEvidence: expect.objectContaining({
              rawToolArguments: expect.arrayContaining([
                expect.objectContaining({
                  messageId: hiddenWaitToolMessage.id,
                  toolName: "ambient_subagent",
                  toolCallId: "hidden-wait-reader-child",
                  action: "wait_agent",
                  waitBarrierId: barrier.id,
                  childRunIds: [run.id],
                  inputSource: "inputContent",
                  messageVisibleInTranscript: false,
                  path: "child-threads/evidence-summary.json",
                  rawInput: expect.objectContaining({
                    action: "wait_agent",
                    childRunId: run.id,
                    waitBarrierId: barrier.id,
                  }),
                }),
                expect.objectContaining({
                  messageId: expect.any(String),
                  toolName: "ambient_subagent",
                  toolCallId: "wait-reader-child",
                  action: "wait_agent",
                  waitBarrierId: barrier.id,
                  childRunIds: [run.id],
                  inputSource: "inputContent",
                  rawInput: expect.objectContaining({
                    action: "wait_agent",
                    childRunId: run.id,
                    waitBarrierId: barrier.id,
                  }),
                }),
              ]),
              waitSessions: expect.arrayContaining([
                expect.objectContaining({
                  sourceMessageId: hiddenWaitToolMessage.id,
                  action: "wait_agent",
                  waitBarrierId: barrier.id,
                  childRunIds: [run.id],
                  timeoutMs: 60000,
                  idempotencyKey: "hidden-wait-reader-child-once",
                  path: "child-threads/evidence-summary.json",
                }),
                expect.objectContaining({
                  action: "wait_agent",
                  waitBarrierId: barrier.id,
                  childRunIds: [run.id],
                  timeoutMs: 60000,
                  idempotencyKey: "wait-reader-child-once",
                }),
              ]),
              progressReturns: expect.arrayContaining([
                expect.objectContaining({
                  source: "parent_transcript",
                  waitBarrierId: barrier.id,
                  waitOutcome: expect.objectContaining({ kind: "progress_return" }),
                }),
              ]),
              barrierTransitions: [
                expect.objectContaining({
                  waitBarrierId: barrier.id,
                  status: "satisfied",
                  transitionEvidence: expect.objectContaining({
                    kind: "child_terminal",
                    source: "wait_agent",
                  }),
                  synthesisAllowed: true,
                }),
              ],
              livenessSnapshots: [
                expect.objectContaining({
                  source: expect.any(String),
                  path: expect.stringContaining(childDir),
                }),
              ],
              waitCompletionEvents: expect.arrayContaining([
                expect.objectContaining({
                  source: "child_mailbox",
                  waitBarrierId: barrier.id,
                }),
              ]),
              attentionEvents: expect.arrayContaining([
                expect.objectContaining({
                  source: "parent_mailbox",
                  waitBarrierId: barrier.id,
                }),
              ]),
              decisionEvents: expect.arrayContaining([
                expect.objectContaining({
                  source: "parent_mailbox",
                  waitBarrierId: barrier.id,
                }),
              ]),
              finalizationBlocks: expect.arrayContaining([
                expect.objectContaining({
                  source: "parent_mailbox",
                  waitBarrierId: barrier.id,
                }),
              ]),
            }),
            evidenceGaps: [],
          }),
        ],
      });
      expect(evidenceSummary.children[0].waitEvidence.progressReturns.length).toBeGreaterThanOrEqual(1);
      const callableTasks = JSON.parse(await zipText(zip, "child-threads/callable-workflow-tasks.json")) as Record<string, any>;
      expect(callableTasks.tasks[0]).toMatchObject({
        id: boundTask.id,
        patternGraphSnapshot: {
          nodes: expect.arrayContaining([
            expect.objectContaining({
              id: `mapper:${run.id}`,
              childRunId: run.id,
              childThreadId: run.childThreadId,
            }),
          ]),
        },
      });
      const patternGraphs = JSON.parse(await zipText(zip, "child-threads/pattern-graphs.json")) as Record<string, any>;
      expect(patternGraphs).toMatchObject({
        patternGraphCount: 1,
        linkedChildCount: 1,
        graphs: [
          expect.objectContaining({
            workflowTaskId: task.id,
            snapshot: expect.objectContaining({ workflowTaskId: task.id, patternId: "map_reduce" }),
            childTranscriptLinks: [
              expect.objectContaining({
                nodeId: `mapper:${run.id}`,
                manifestPath: `${childDir}/manifest.json`,
                transcriptJsonPath: `${childDir}/visible-transcript.json`,
              }),
            ],
          }),
        ],
      });
    } finally {
      store.close();
    }
  });

  it("exports typed child-runtime timeout barrier evidence", async () => {
    const store = new ProjectStore();
    try {
      store.openWorkspace(workspacePath);
      const parent = store.createThread("Parent with timeout child");
      const parentMessage = store.addMessage({
        threadId: parent.id,
        role: "assistant",
        content: "Launching a slow research child.",
      });
      const parentRun = store.startRun({ threadId: parent.id, assistantMessageId: parentMessage.id });
      const featureFlagSnapshot = enabledSubagentFeatureFlags();
      const child = store.createSubagentRun({
        parentThreadId: parent.id,
        parentRunId: parentRun.id,
        parentMessageId: parentMessage.id,
        title: "Slow child",
        roleId: "explorer",
        roleProfileSnapshot: getDefaultSubagentRoleProfile("explorer"),
        canonicalTaskPath: "root/0:explorer",
        featureFlagSnapshot,
        modelRuntimeSnapshot: createAmbientModelRuntimeSnapshot(parent.model, "2026-06-16T00:00:00.000Z"),
        dependencyMode: "required",
      });
      store.addMessage({
        threadId: child.childThreadId,
        role: "user",
        content: "Check the slow source and report back.",
      });
      store.addMessage({
        threadId: child.childThreadId,
        role: "assistant",
        content: "I am still working through the source.",
      });
      store.markSubagentRunStatus(child.id, "running", { now: "2026-06-16T00:00:01.000Z" });
      store.markSubagentRunStatus(child.id, "timed_out", {
        now: "2026-06-16T00:10:01.000Z",
        resultArtifact: {
          schemaVersion: "ambient-subagent-result-artifact-v1",
          runId: child.id,
          childThreadId: child.childThreadId,
          status: "timed_out",
          partial: false,
          summary: "Child hit the hard runtime cap before returning synthesis-safe output.",
        },
      });
      const barrier = store.createSubagentWaitBarrier({
        parentThreadId: parent.id,
        parentRunId: parentRun.id,
        childRunIds: [child.id],
        dependencyMode: "required_all",
        failurePolicy: "ask_user",
        timeoutMs: 600_000,
        createdAt: "2026-06-16T00:00:01.000Z",
      });
      const waitToolMessage = store.addMessage({
        threadId: parent.id,
        role: "assistant",
        content: "",
        metadata: {
          status: "done",
          toolName: "ambient_subagent",
          toolCallId: "wait-timeout-child",
          inputContent: JSON.stringify({
            action: "wait_agent",
            childRunId: child.id,
            waitBarrierId: barrier.id,
            timeoutMs: 600000,
            idempotencyKey: "wait-timeout-child-once",
          }),
        },
      });
      const timeoutDetails = {
        childHardElapsedMs: 600_000,
        childHardTimeoutMs: 600_000,
        childIdleElapsedMs: 1_000,
        lastChildActivityAt: "2026-06-16T00:10:00.000Z",
        lastChildActivitySource: "message:assistant",
      };
      store.updateSubagentWaitBarrierStatus(barrier.id, "timed_out", {
        now: "2026-06-16T00:10:01.000Z",
        resolutionArtifact: {
          schemaVersion: "ambient-subagent-wait-barrier-resolution-v1",
          childRunIds: [child.id],
          childStatuses: [{ childRunId: child.id, status: "timed_out" }],
          timedOut: true,
          transitionEvidence: {
            schemaVersion: "ambient-subagent-wait-barrier-transition-evidence-v1",
            kind: "child_runtime_timeout",
            source: "child_runtime",
            childRunId: child.id,
            reason: "runtime_hard_cap_exceeded",
            timeoutKind: "hard_cap",
            details: timeoutDetails,
          },
          waitBarrierEvaluation: {
            timedOut: true,
            runtimeTimeoutKind: "hard_cap",
            terminalEvidence: {
              kind: "child_runtime_timeout",
              childRunId: child.id,
              reason: "runtime_hard_cap_exceeded",
              timeoutKind: "hard_cap",
              details: timeoutDetails,
            },
            activeChildRunIds: [],
            reason: "required_all barrier timed out with 0/1 synthesis-safe child results.",
          },
          synthesisAllowed: false,
          resultArtifact: null,
        },
      });
      store.appendSubagentParentMailboxEvent({
        parentThreadId: parent.id,
        parentRunId: parentRun.id,
        parentMessageId: parentMessage.id,
        type: "subagent.wait_barrier_attention",
        payload: {
          schemaVersion: "ambient-subagent-wait-barrier-attention-v1",
          childRunId: child.id,
          childThreadId: child.childThreadId,
          waitBarrierId: barrier.id,
          childRunIds: [child.id],
          parentFinalizationBlocked: true,
          reason: "Parent finalization blocked by timed-out required child.",
        },
        deliveryState: "queued",
        idempotencyKey: `subagent:finalization_blocked:${parentRun.id}:${barrier.id}`,
        createdAt: "2026-06-16T00:10:02.000Z",
      });

      const payload = await createChatExportBundle(store, parent.id, {
        appName: "Ambient",
        appVersion: "0.1.0",
        now: new Date("2026-06-16T00:11:00.000Z"),
      });
      const zip = await JSZip.loadAsync(payload.archive);
      const evidenceSummary = JSON.parse(await zipText(zip, "child-threads/evidence-summary.json")) as Record<string, any>;
      const childSummary = evidenceSummary.children[0] as Record<string, any>;

      expect(evidenceSummary.waitEvidence).toMatchObject({
        waitBarrierCount: 1,
        waitSessionCount: 1,
        barrierTransitionCount: 1,
        runtimeTimeoutTransitionCount: 1,
        runtimeTimeoutKindCounts: { hard_cap: 1 },
        finalizationBlockCount: 1,
        childrenWithRuntimeTimeouts: [child.id],
        childrenWithFinalizationBlocks: [child.id],
      });
      expect(childSummary).toMatchObject({
        runId: child.id,
        status: "timed_out",
        barriers: [
          expect.objectContaining({
            id: barrier.id,
            status: "timed_out",
            transitionKind: "child_runtime_timeout",
            timeoutKind: "hard_cap",
            runtimeTimeoutKind: "hard_cap",
          }),
        ],
        waitEvidence: expect.objectContaining({
          rawToolArguments: [
            expect.objectContaining({
              messageId: waitToolMessage.id,
              action: "wait_agent",
              waitBarrierId: barrier.id,
              childRunIds: [child.id],
            }),
          ],
          waitSessions: [
            expect.objectContaining({
              action: "wait_agent",
              waitBarrierId: barrier.id,
              childRunIds: [child.id],
              timeoutMs: 600000,
              idempotencyKey: "wait-timeout-child-once",
            }),
          ],
          barrierTransitions: [
            expect.objectContaining({
              waitBarrierId: barrier.id,
              status: "timed_out",
              transitionKind: "child_runtime_timeout",
              transitionReason: "runtime_hard_cap_exceeded",
              timeoutKind: "hard_cap",
              runtimeTimeoutKind: "hard_cap",
              details: timeoutDetails,
              transitionEvidence: expect.objectContaining({
                kind: "child_runtime_timeout",
                timeoutKind: "hard_cap",
                details: timeoutDetails,
              }),
              waitBarrierEvaluation: expect.objectContaining({
                timedOut: true,
                runtimeTimeoutKind: "hard_cap",
                terminalEvidence: expect.objectContaining({
                  kind: "child_runtime_timeout",
                  timeoutKind: "hard_cap",
                  details: timeoutDetails,
                }),
              }),
              synthesisAllowed: false,
            }),
          ],
          finalizationBlocks: [
            expect.objectContaining({
              source: "parent_mailbox",
              waitBarrierId: barrier.id,
              childRunIds: [child.id],
            }),
          ],
        }),
      });
      expect(childSummary.waitEvidence.livenessSnapshots[0]).toMatchObject({
        source: expect.any(String),
        path: expect.stringContaining(childSummary.files.runEvents),
      });
      expect(await zipText(zip, childSummary.files.waitBarriers)).toContain("runtime_hard_cap_exceeded");
    } finally {
      store.close();
    }
  });

  it("rejects a recorded Pi session path outside the thread session directory", async () => {
    const store = new ProjectStore();
    try {
      store.openWorkspace(workspacePath);
      const outsideDir = await mkdtemp(join(tmpdir(), "ambient-chat-export-outside-"));
      extraPaths.push(outsideDir);
      const outsideSessionFile = join(outsideDir, "session.jsonl");
      await writeFile(outsideSessionFile, '{"type":"session","version":3}\n', "utf8");
      const created = store.createThread("Outside session");
      const thread = store.updateThreadSettings(created.id, { piSessionFile: outsideSessionFile });
      store.addMessage({ threadId: thread.id, role: "user", content: "Visible prompt" });

      const payload = await createChatExportBundle(store, thread.id, {
        appName: "Ambient",
        appVersion: "0.1.0",
        now: new Date("2026-05-19T00:00:00.000Z"),
      });
      const zip = await JSZip.loadAsync(payload.archive);

      expect(payload.source).toBe("visible-chat-fallback");
      expect(payload.fallbackReason).toContain("outside");
      expect(zip.file("pi-session.jsonl")).toBeNull();
      expect(await zipText(zip, "visible-transcript.md")).toContain("Visible prompt");
    } finally {
      store.close();
    }
  });
});

async function zipText(zip: JSZip, path: string): Promise<string> {
  const file = zip.file(path);
  expect(file).toBeTruthy();
  return file!.async("string");
}

function enabledSubagentFeatureFlags(generatedAt = "2026-05-19T00:00:00.000Z") {
  return resolveAmbientFeatureFlags({
    startup: { enabled: [AMBIENT_SUBAGENTS_FEATURE_FLAG], disabled: [] },
    generatedAt,
  });
}

function executionPlanForParent(
  parentThreadId: string,
  parentRunId: string,
  assistantMessageId: string,
  featureFlagSnapshot = enabledSubagentFeatureFlags(),
) {
  const registry = buildCallableWorkflowRegistry({ featureFlagSnapshot });
  const tool = parentPiVisibleCallableWorkflowTools(registry)
    .find((candidate) => candidate.id === "symphony:map_reduce");
  if (!tool) throw new Error("Map-Reduce callable workflow tool was not registered.");
  const runPlan = buildCallableWorkflowRunPlan(tool, {
    goal: "Read the requested source files and reduce their findings.",
    blocking: true,
    metricCriteria: [{ templateId: "map_reduce-metric", value: "Each child source slice has evidence." }],
  });
  return buildCallableWorkflowExecutionPlan({
    descriptor: tool,
    runPlan,
    parent: {
      threadId: parentThreadId,
      runId: parentRunId,
      assistantMessageId,
    },
    toolCallId: "tool-call-map-reduce-export",
    createdAt: "2026-05-19T00:00:01.000Z",
  });
}
