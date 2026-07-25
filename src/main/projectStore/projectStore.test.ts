import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultOrchestrationProjectPath, defaultProjectArtifactWorkspacePath, ProjectStore } from "./projectStore";
import { AMBIENT_DEFAULT_MODEL } from "../../shared/ambientModels";
import type { ModelRuntimeInstalledProvider } from "../../shared/threadTypes";

const describeNative = process.env.AMBIENT_TEST_NATIVE === "1" ? describe : describe.skip;

function setRawStoreSetting(store: ProjectStore, key: string, value: unknown): void {
  (store as unknown as { repos: { settings: () => { setSetting: (key: string, value: unknown) => void } } }).repos.settings().setSetting(key, value);
}

describeNative("ProjectStore orchestration tasks (requires Node ABI better-sqlite3 build)", () => {
  let workspacePath = "";
  let store: ProjectStore;

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), "ambient-store-"));
    store = new ProjectStore();
    store.openWorkspace(workspacePath);
  });

  afterEach(async () => {
    store.close();
    await rm(workspacePath, { recursive: true, force: true });
  });

  it("creates local tasks with stable identifiers and normalized fields", () => {
    const task = store.createOrchestrationTask({
      title: " Build the board ",
      description: "  Durable local tasks  ",
      state: "Ready",
      priority: 2,
      labels: ["UI", "ui", " Phase6 "],
      projectPath: "/tmp/ambient-project",
    });

    expect(task).toMatchObject({
      identifier: "LOCAL-1",
      title: "Build the board",
      description: "Durable local tasks",
      state: "ready",
      priority: 2,
      labels: ["ui", "phase6"],
      projectPath: "/tmp/ambient-project",
      sourceKind: "local",
    });
  });

  it("defaults local task project paths to the owning project instead of prepared workspaces", () => {
    const preparedWorkspacePath = join(workspacePath, ".ambient-codex", "orchestration", "workspaces", "LOCAL-1");
    expect(defaultOrchestrationProjectPath(preparedWorkspacePath)).toBe(workspacePath);
  });

  it("defaults long artifact destinations to the owning project instead of internal execution worktrees", () => {
    const executionWorkspacePath = join(workspacePath, ".ambient-codex", "worktrees", "thread-1");
    const preparedWorkspacePath = join(workspacePath, ".ambient-codex", "orchestration", "workspaces", "LOCAL-1");
    expect(defaultProjectArtifactWorkspacePath(executionWorkspacePath)).toBe(workspacePath);
    expect(defaultProjectArtifactWorkspacePath(preparedWorkspacePath)).toBe(workspacePath);
    expect(defaultProjectArtifactWorkspacePath(workspacePath)).toBe(workspacePath);
  });

  it("keeps persisted active work untouched on ordinary workspace open", () => {
    const thread = store.createThread("Background run");
    const assistant = store.addMessage({
      threadId: thread.id,
      role: "assistant",
      content: "",
      metadata: { status: "streaming", runtime: "pi" },
    });
    const run = store.startRun({ threadId: thread.id, assistantMessageId: assistant.id });
    const task = store.createOrchestrationTask({ title: "Background task" });
    const orchestrationRun = store.recordPreparedOrchestrationRun({ taskId: task.id, workspacePath });
    store.updateOrchestrationRun({ id: orchestrationRun.id, status: "running", threadId: thread.id });

    store.close();
    store = new ProjectStore();
    store.openWorkspace(workspacePath);

    expect(store.listActiveRuns()).toEqual([expect.objectContaining({ id: run.id, status: "starting" })]);
    expect(store.listMessages(thread.id).find((message) => message.id === assistant.id)?.metadata).toMatchObject({ status: "streaming" });
    expect(store.getOrchestrationRun(orchestrationRun.id)).toMatchObject({ status: "running", threadId: thread.id });
  });

  it("persists active run diagnostics", () => {
    const thread = store.createThread("Diagnostic run");
    const assistant = store.addMessage({
      threadId: thread.id,
      role: "assistant",
      content: "",
    });
    const run = store.startRun({ threadId: thread.id, assistantMessageId: assistant.id });

    store.updateRunDiagnostics(run.id, {
      toolArgumentStreams: {
        version: 1,
        lastUpdatedAt: "2026-05-21T10:00:00.000Z",
        active: [],
        completed: [],
      },
    });

    store.close();
    store = new ProjectStore();
    store.openWorkspace(workspacePath);

    expect(store.listActiveRuns()).toEqual([
      expect.objectContaining({
        id: run.id,
        diagnostics: expect.objectContaining({
          toolArgumentStreams: expect.objectContaining({ version: 1 }),
        }),
      }),
    ]);
  });

  it("does not treat completed runs as active even if a late status update arrives", () => {
    const thread = store.createThread("Terminal run");
    const assistant = store.addMessage({
      threadId: thread.id,
      role: "assistant",
      content: "",
      metadata: { status: "streaming", runtime: "pi" },
    });
    const run = store.startRun({ threadId: thread.id, assistantMessageId: assistant.id });

    store.finishRun(run.id, "done");
    const lateUpdate = store.updateRunStatus(run.id, "tool");

    expect(lateUpdate.status).toBe("done");
    expect(lateUpdate.completedAt).toBeTruthy();
    expect(store.listActiveRuns()).toEqual([]);
  });

  it("recovers persisted active work when workspace open recovery is explicit", () => {
    const thread = store.createThread("Restart recovery");
    const assistant = store.addMessage({
      threadId: thread.id,
      role: "assistant",
      content: "",
      metadata: { status: "streaming", runtime: "pi" },
    });
    const run = store.startRun({ threadId: thread.id, assistantMessageId: assistant.id });
    const task = store.createOrchestrationTask({ title: "Restarted task" });
    const orchestrationRun = store.recordPreparedOrchestrationRun({ taskId: task.id, workspacePath });
    store.updateOrchestrationRun({ id: orchestrationRun.id, status: "running", threadId: thread.id });

    store.close();
    store = new ProjectStore();
    store.openWorkspace(workspacePath, { recoverActiveRuns: true, recoverOrchestrationRuns: true });

    expect(store.listActiveRuns().some((activeRun) => activeRun.id === run.id)).toBe(false);
    expect(store.listMessages(thread.id).find((message) => message.id === assistant.id)?.metadata).toMatchObject({ status: "interrupted" });
    expect(store.getOrchestrationRun(orchestrationRun.id)).toMatchObject({
      status: "stalled",
      error: "Ambient Desktop restarted before this Local Task run finished.",
    });
    expect(store.getOrchestrationTask(task.id).state).toBe("needs_info");
  });

  it("defaults new workspace settings and new threads to workspace permission mode", () => {
    expect(store.getDefaultSettings().permissionMode).toBe("workspace");
    expect(store.findReusableEmptyThread()?.permissionMode).toBe("workspace");
    expect(store.createThread("Fresh task").permissionMode).toBe("workspace");
  });

  it("can create a thread with explicit initial runtime settings", () => {
    const thread = store.createThread("Builder flow", store.getWorkspace().path, {
      permissionMode: "full-access",
      collaborationMode: "agent",
      model: AMBIENT_DEFAULT_MODEL,
      thinkingLevel: "high",
    });

    expect(thread).toMatchObject({
      permissionMode: "full-access",
      collaborationMode: "agent",
      model: AMBIENT_DEFAULT_MODEL,
      thinkingLevel: "high",
    });
    expect(store.getDefaultSettings().permissionMode).toBe("workspace");
  });

  it("exposes pending thread wake continuations as scheduled thread check-ins", () => {
    const thread = store.createThread("Wake me");
    const later = store.scheduleThreadWakeContinuation({
      threadId: thread.id,
      dueAt: "2026-06-04T13:00:00.000Z",
      reason: "Check the long-running job.",
    });
    const earlier = store.scheduleThreadWakeContinuation({
      threadId: thread.id,
      dueAt: "2026-06-04T12:30:00.000Z",
      reason: "Check progress first.",
    });

    expect(store.getThread(thread.id).scheduledCheckIn).toMatchObject({
      sourceKind: "thread_wake",
      wakeId: earlier.id,
      nextRunAt: "2026-06-04T12:30:00.000Z",
      targetKind: "thread_wake",
      targetLabel: "this thread",
    });
    expect(store.listThreads().find((candidate) => candidate.id === thread.id)?.scheduledCheckIn).toMatchObject({
      wakeId: earlier.id,
    });

    store.markThreadWakeContinuationDelivered(earlier.id);
    expect(store.getThread(thread.id).scheduledCheckIn).toMatchObject({
      wakeId: later.id,
      nextRunAt: "2026-06-04T13:00:00.000Z",
    });

    store.markThreadWakeContinuationDelivered(later.id);
    expect(store.getThread(thread.id).scheduledCheckIn).toBeUndefined();
  });

  it("persists aggressive retry runtime settings with safe defaults", () => {
    expect(store.getDefaultSettings().modelRuntime).toEqual({
      aggressiveRetries: true,
      showPromptCacheStatus: false,
      providerPreStreamTimeoutMs: 45_000,
      providerStreamIdleTimeoutMs: 120_000,
      installedProviders: [],
    });
    expect(store.getModelRuntimeSettings()).toEqual({
      aggressiveRetries: true,
      showPromptCacheStatus: false,
      providerPreStreamTimeoutMs: 45_000,
      providerStreamIdleTimeoutMs: 120_000,
      installedProviders: [],
    });

    expect(store.setModelRuntimeSettings({ aggressiveRetries: false, providerPreStreamTimeoutMs: 60_000, providerStreamIdleTimeoutMs: 120_000 })).toEqual({
      aggressiveRetries: false,
      showPromptCacheStatus: false,
      providerPreStreamTimeoutMs: 60_000,
      providerStreamIdleTimeoutMs: 120_000,
      installedProviders: [],
    });
    store.close();
    store.openWorkspace(workspacePath);

    expect(store.getModelRuntimeSettings()).toEqual({
      aggressiveRetries: false,
      showPromptCacheStatus: false,
      providerPreStreamTimeoutMs: 60_000,
      providerStreamIdleTimeoutMs: 120_000,
      installedProviders: [],
    });

    setRawStoreSetting(store, "modelRuntimeTimeoutDefaultsVersion", 1);
    setRawStoreSetting(store, "modelRuntime", {
      aggressiveRetries: true,
      showPromptCacheStatus: false,
      providerPreStreamTimeoutMs: 45_000,
      providerStreamIdleTimeoutMs: 30_000,
      installedProviders: [],
    });
    expect(store.getModelRuntimeSettings().providerStreamIdleTimeoutMs).toBe(120_000);
    expect(store.setModelRuntimeSettings({ providerStreamIdleTimeoutMs: 30_000 }).providerStreamIdleTimeoutMs).toBe(30_000);

    setRawStoreSetting(store, "modelRuntime", {
      aggressiveRetries: "yes",
      providerPreStreamTimeoutMs: 1,
      providerStreamIdleTimeoutMs: 999_999,
    });

    expect(store.getModelRuntimeSettings()).toEqual({
      aggressiveRetries: true,
      showPromptCacheStatus: false,
      providerPreStreamTimeoutMs: 5_000,
      providerStreamIdleTimeoutMs: 600_000,
      installedProviders: [],
    });
  });

  it("persists Settings-installed model providers and feeds the runtime catalog without secrets", () => {
    const installed = installedProvider({
      providerId: "customer-router",
      modelId: "CUSTOM/Router Model v2",
    });

    store.setModelRuntimeSettings({ installedProviders: [installed] });
    store.close();
    store.openWorkspace(workspacePath);

    const settings = store.getModelRuntimeSettings();
    const catalog = store.getModelRuntimeCatalog("2026-06-06T01:00:00.000Z");
    const serializedSettings = JSON.stringify(settings);

    expect(settings.installedProviders).toEqual([
      expect.objectContaining({
        provider: expect.objectContaining({ id: "customer-router" }),
        profile: expect.objectContaining({
          providerId: "customer-router",
          modelId: "CUSTOM/Router Model v2",
        }),
      }),
    ]);
    expect(serializedSettings).not.toContain("sk-test-secret");
    expect(catalog.providers).toContainEqual(expect.objectContaining({
      id: "customer-router",
      label: "Customer Router",
    }));
    expect(catalog.profiles).toContainEqual(expect.objectContaining({
      profileId: "customer-router:CUSTOM/Router Model v2",
      modelId: "CUSTOM/Router Model v2",
      selectableAsMain: true,
      selectableAsSubagent: true,
    }));
    expect(catalog.selectableMainModelOptions.map((option) => option.id)).toEqual(expect.arrayContaining([
      AMBIENT_DEFAULT_MODEL,
      "CUSTOM/Router Model v2",
    ]));
    expect(catalog.selectableSubagentProfiles.map((profile) => profile.modelId)).toEqual(expect.arrayContaining([
      AMBIENT_DEFAULT_MODEL,
      "CUSTOM/Router Model v2",
    ]));
  });

  it("migrates legacy full-access defaults without changing active work threads", () => {
    const starter = store.findReusableEmptyThread();
    const workThread = store.createThread("Needs broad tools");
    store.updateThreadSettings(starter!.id, { permissionMode: "full-access" });
    store.updateThreadSettings(workThread.id, { permissionMode: "full-access" });
    setRawStoreSetting(store, "permissionMode", "full-access");

    store.close();
    store.openWorkspace(workspacePath);

    expect(store.getDefaultSettings().permissionMode).toBe("workspace");
    expect(store.listThreads().map((thread) => thread.id)).not.toContain(starter!.id);
    expect(store.getThread(workThread.id).permissionMode).toBe("full-access");
    expect(store.createThread("Post-migration task").permissionMode).toBe("workspace");
  });

  it("migrates a legacy empty starter thread to workspace permission mode", () => {
    const starter = store.findReusableEmptyThread();
    store.updateThreadSettings(starter!.id, { permissionMode: "full-access" });
    setRawStoreSetting(store, "permissionMode", "full-access");

    store.close();
    store.openWorkspace(workspacePath);

    expect(store.findReusableEmptyThread()?.id).toBe(starter!.id);
    expect(store.findReusableEmptyThread()?.permissionMode).toBe("workspace");
    expect(store.createThread("Post-migration task").permissionMode).toBe("workspace");
  });

  it("deletes messages after a retry target and restores the thread preview", () => {
    const thread = store.createThread();
    const user = store.addMessage({ threadId: thread.id, role: "user", content: "Try this request." });
    store.addMessage({ threadId: thread.id, role: "assistant", content: "The Pi/Ambient runtime returned an error.", metadata: { status: "error" } });

    const remaining = store.deleteMessagesAfter(thread.id, user.id);

    expect(remaining.map((message) => message.id)).toEqual([user.id]);
    expect(store.listMessages(thread.id).map((message) => message.id)).toEqual([user.id]);
    expect(store.getThread(thread.id).lastMessagePreview).toBe("Try this request.");
  });

  it("persists voice state in a message-keyed side table", () => {
    const thread = store.createThread();
    const message = store.addMessage({ threadId: thread.id, role: "assistant", content: "Ready to speak." });

    const queued = store.setMessageVoiceState({
      messageId: message.id,
      threadId: thread.id,
      status: "queued",
      source: "assistant-text",
      sourceMessageId: message.id,
      providerCapabilityId: "voice:fixture",
      providerId: "fixture",
      spokenText: "Ready to speak.",
      spokenTextChars: 15,
      sourceTextChars: 15,
    });

    expect(queued).toMatchObject({
      messageId: message.id,
      status: "queued",
      source: "assistant-text",
      providerCapabilityId: "voice:fixture",
      spokenTextChars: 15,
    });

    const ready = store.setMessageVoiceState({
      ...queued,
      status: "ready",
      audioPath: ".ambient/voice/thread/message.wav",
      mediaUrl: "ambient-media://workspace/token/message.wav",
      mimeType: "audio/wav",
      durationMs: 1200,
    });

    expect(ready.createdAt).toBe(queued.createdAt);
    expect(ready.updatedAt >= queued.updatedAt).toBe(true);
    expect(store.getMessageVoiceState(message.id)).toMatchObject({
      status: "ready",
      audioPath: ".ambient/voice/thread/message.wav",
      mimeType: "audio/wav",
    });
    expect(store.listMessageVoiceStates(thread.id)).toHaveLength(1);

    store.close();
    store.openWorkspace(workspacePath);

    expect(store.listMessageVoiceStates(thread.id)[0]).toMatchObject({
      messageId: message.id,
      status: "ready",
      providerId: "fixture",
      durationMs: 1200,
    });
  });

  it("clears voice artifact metadata without deleting the message voice row", () => {
    const thread = store.createThread();
    const message = store.addMessage({ threadId: thread.id, role: "assistant", content: "Ready to clear." });
    const ready = store.setMessageVoiceState({
      messageId: message.id,
      threadId: thread.id,
      status: "ready",
      source: "summary",
      sourceMessageId: message.id,
      providerCapabilityId: "voice:fixture",
      providerId: "fixture",
      voiceId: "default",
      spokenText: "Ready to clear.",
      spokenTextChars: 15,
      sourceTextChars: 120,
      audioPath: ".ambient/voice/thread/message.wav",
      mediaUrl: "ambient-media://workspace/token/message.wav",
      mimeType: "audio/wav",
      durationMs: 1200,
    });

    const cleared = store.clearMessageVoiceArtifact(ready.messageId);

    expect(cleared).toMatchObject({
      messageId: message.id,
      status: "canceled",
      source: "summary",
      providerCapabilityId: "voice:fixture",
      spokenText: "Ready to clear.",
      spokenTextChars: 15,
      sourceTextChars: 120,
      lastAudioPath: ".ambient/voice/thread/message.wav",
      error: "Voice artifact cleared.",
    });
    expect(cleared.audioPath).toBeUndefined();
    expect(cleared.lastAudioPath).toBe(".ambient/voice/thread/message.wav");
    expect(cleared.mediaUrl).toBeUndefined();
    expect(cleared.mimeType).toBeUndefined();
    expect(cleared.durationMs).toBeUndefined();
    expect(store.listMessages(thread.id)[0]).toMatchObject({ id: message.id, content: "Ready to clear." });
  });

  it("lists tasks in dispatch-friendly priority order", () => {
    const later = store.createOrchestrationTask({ title: "Later" });
    const urgent = store.createOrchestrationTask({ title: "Urgent", priority: 1 });

    expect(store.listOrchestrationTasks().map((task) => task.id)).toEqual([urgent.id, later.id]);
  });

  it("updates task state and exposes board data", () => {
    const task = store.createOrchestrationTask({ title: "Review me" });

    store.updateOrchestrationTask({ id: task.id, state: "In Progress", priority: null });
    const board = store.listOrchestrationBoard();

    expect(board.runs).toEqual([]);
    expect(board.tasks[0]).toMatchObject({ id: task.id, state: "in_progress" });
  });

  it("organizes automation threads into a home folder and custom folders", () => {
    const task = store.createOrchestrationTask({ title: "Ship automation", priority: 1 });
    let folders = store.listAutomationFolders();
    const home = folders.find((folder) => folder.kind === "home");
    const taskThread = home?.threads.find((thread) => thread.sourceId === task.id);

    expect(home?.name).toBe("Home");
    expect(taskThread).toMatchObject({
      kind: "orchestration_task",
      title: "Ship automation",
      status: "todo",
      badges: expect.arrayContaining(["LOCAL-1", "Priority 1"]),
    });

    folders = store.createAutomationFolder({ name: "Nightly" });
    const customFolder = folders.find((folder) => folder.name === "Nightly");
    expect(customFolder).toBeTruthy();

    folders = store.moveAutomationThread({ threadId: taskThread!.id, folderId: customFolder!.id });
    expect(folders.find((folder) => folder.kind === "home")?.threads.map((thread) => thread.id)).not.toContain(taskThread!.id);
    expect(folders.find((folder) => folder.id === customFolder!.id)?.threads.map((thread) => thread.id)).toContain(taskThread!.id);

    const run = store.recordPreparedOrchestrationRun({
      taskId: task.id,
      workspacePath: join(workspacePath, ".ambient-codex", "worktrees", task.identifier),
    });
    const runThread = store.createThread(`${task.identifier}: ${task.title}`, run.workspacePath);
    store.updateOrchestrationRun({ id: run.id, status: "running", threadId: runThread.id });

    expect(store.listAutomationThreadChatIds()).toContain(runThread.id);
    expect(store.listAutomationFolders().find((folder) => folder.id === customFolder!.id)?.threads[0].latestRun).toMatchObject({
      id: run.id,
      status: "running",
      threadId: runThread.id,
    });
  });

  it("searches persisted threads and messages", () => {
    const thread = store.createThread("Searchable thread");
    const otherThread = store.createThread("Other thread");
    store.addMessage({ threadId: thread.id, role: "user", content: "Find the durable banana result." });
    store.addMessage({ threadId: otherThread.id, role: "user", content: "Find the durable banana result in another chat." });

    const results = store.searchWorkspace("banana");

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "message",
          threadId: thread.id,
          title: "Searchable thread",
          excerpt: "Find the durable banana result.",
        }),
      ]),
    );
    expect(store.searchWorkspace("banana", { scope: "chat", threadId: thread.id }).map((result) => result.threadId)).toEqual(
      expect.arrayContaining([thread.id]),
    );
    expect(store.searchWorkspace("banana", { scope: "chat", threadId: thread.id }).map((result) => result.threadId)).not.toContain(otherThread.id);
  });

  it("persists the last active thread id across workspace reopen", () => {
    const thread = store.createThread("Last used");

    store.setLastActiveThreadId("missing-thread");
    expect(store.getLastActiveThreadId()).toBeUndefined();

    store.setLastActiveThreadId(thread.id);

    store.close();
    store.openWorkspace(workspacePath);

    expect(store.getLastActiveThreadId()).toBe(thread.id);
  });

  it("persists compaction policy settings with safe defaults", () => {
    expect(store.getDefaultSettings().compaction).toMatchObject({
      autoCompactionEnabled: true,
      reserveTokens: 16384,
      keepRecentTokens: 20000,
      softWarningPercent: 80,
      hardPreflightPercent: 92,
    });

    store.setCompactionSettings({
      autoCompactionEnabled: false,
      reserveTokens: 8_000,
      keepRecentTokens: 12_000,
      softWarningPercent: 75,
      hardPreflightPercent: 90,
    });

    store.close();
    store.openWorkspace(workspacePath);

    expect(store.getCompactionSettings()).toMatchObject({
      autoCompactionEnabled: false,
      reserveTokens: 8_000,
      keepRecentTokens: 12_000,
      softWarningPercent: 75,
      hardPreflightPercent: 90,
    });
  });

});

function installedProvider(input: {
  providerId: string;
  modelId: string;
}): ModelRuntimeInstalledProvider {
  return {
    schemaVersion: "ambient-model-runtime-installed-provider-v1",
    source: "settings-provider-onboarding",
    templateId: "generic-openai-compatible",
    enabled: true,
    installedAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
    provider: {
      id: input.providerId,
      label: "Customer Router",
      locality: "cloud",
      secretRequirement: "user-secret",
      supportsStreaming: true,
      supportsTools: true,
      notes: ["Configured with authorization=sk-test-secret-12345678."],
    },
    profile: {
      schemaVersion: "ambient-model-runtime-profile-v1",
      profileId: `${input.providerId}:${input.modelId}`,
      providerId: input.providerId,
      modelId: input.modelId,
      label: input.modelId,
      selectableAsMain: true,
      selectableAsSubagent: true,
      available: true,
      contextWindowTokens: 128_000,
      supportsStreaming: true,
      toolUse: "ambient-tools",
      structuredOutput: "schema",
      supportsVision: false,
      supportsAudio: false,
      locality: "cloud",
      costClass: "metered",
      trustClass: "user-configured",
      privacyLabel: "User configured cloud provider",
      memoryClass: "remote",
      providerQuirks: ["Configured through Settings provider onboarding."],
    },
    secretRef: {
      schemaVersion: "ambient-model-runtime-installed-provider-secret-ref-v1",
      flow: "ambient_cli_secret_request",
      configured: true,
      label: "Desktop secret request",
    },
    // The runtime catalog is proof-first: profiles without passing capability probe
    // evidence are not selectable, so an installed provider fixture must carry a
    // passing probe report and eligibility for the template's required probes.
    probeReport: {
      schemaVersion: "ambient-model-provider-capability-probe-v1",
      templateId: "generic-openai-compatible",
      providerId: input.providerId,
      modelId: input.modelId,
      generatedAt: "2026-06-06T00:00:00.000Z",
      observations: [
        "streaming",
        "context_window",
        "structured_json",
        "schema_output",
        "tool_use",
        "latency",
        "error_shape",
        "reliability",
      ].map((probeId) => ({
        probeId,
        status: "passed",
        measuredAt: "2026-06-06T00:00:00.000Z",
      })),
    },
    eligibility: {
      schemaVersion: "ambient-model-provider-capability-eligibility-v1",
      providerId: input.providerId,
      modelId: input.modelId,
      templateId: "generic-openai-compatible",
      eligibleAsMain: true,
      eligibleAsSubagent: true,
      mainBlockers: [],
      subagentBlockers: [],
      warnings: [],
      diagnostics: [],
    },
  } as ModelRuntimeInstalledProvider;
}
