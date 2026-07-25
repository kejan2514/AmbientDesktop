import type { Dispatch, SetStateAction } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppAppearance, DesktopState } from "../../shared/desktopTypes";
import type { ThreadSummary } from "../../shared/threadTypes";
import {
  createAppShellCommandActions,
  createAppShellCommandActionsForApp,
} from "./AppShellCommandActions";
import { createAppWorkflowComposerNavigation } from "./AppWorkflowComposerNavigation";
import type { AutomationPane } from "./AutomationsWorkspace";
import type { AutomationPopover, ProjectPopover } from "./AppSidebar";
import type { SidebarArea } from "./AppShellSidebar";
import type { UtilityPanel } from "./RightPanel";

describe("AppShellCommandActions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    if (typeof document === "undefined") return;
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-theme-preference");
    document.documentElement.style.colorScheme = "";
  });

  it("opens a new workflow-agent composer with the existing sidebar state resets", () => {
    const sidebarArea = statefulSetter<SidebarArea>("projects");
    const projectPopover = statefulSetter<ProjectPopover | undefined>("add");
    const automationPopover = statefulSetter<AutomationPopover | undefined>("organize");
    const selectedAutomationPane = statefulSetter<AutomationPane>("home");
    const selectedWorkflowAgentFolderId = statefulSetter("home");
    const selectedWorkflowAgentThreadId = statefulSetter<string | undefined>("thread-1");
    const selectedWorkflowRecordingId = statefulSetter<string | undefined>("recording-1");
    const selectedAutomationThreadId = statefulSetter<string | undefined>("automation-thread-1");
    const rightPanel = statefulSetter<UtilityPanel | undefined>("files");
    const loadWorkflowAgentFolders = vi.fn();

    const { openNewWorkflowComposer } = createAppWorkflowComposerNavigation({
      loadWorkflowAgentFolders,
      setAutomationPopover: automationPopover.set,
      setProjectPopover: projectPopover.set,
      setRightPanel: rightPanel.set,
      setSelectedAutomationPane: selectedAutomationPane.set,
      setSelectedAutomationThreadId: selectedAutomationThreadId.set,
      setSelectedWorkflowAgentFolderId: selectedWorkflowAgentFolderId.set,
      setSelectedWorkflowAgentThreadId: selectedWorkflowAgentThreadId.set,
      setSelectedWorkflowRecordingId: selectedWorkflowRecordingId.set,
      setSidebarArea: sidebarArea.set,
    });

    openNewWorkflowComposer("folder-2");

    expect(sidebarArea.value).toBe("automations");
    expect(projectPopover.value).toBeUndefined();
    expect(automationPopover.value).toBeUndefined();
    expect(selectedAutomationPane.value).toBe("workflow_agent");
    expect(selectedWorkflowAgentFolderId.value).toBe("folder-2");
    expect(selectedWorkflowAgentThreadId.value).toBeUndefined();
    expect(selectedWorkflowRecordingId.value).toBeUndefined();
    expect(selectedAutomationThreadId.value).toBeUndefined();
    expect(rightPanel.value).toBeUndefined();
    expect(loadWorkflowAgentFolders).toHaveBeenCalledOnce();
  });

  it("preserves search/settings while opening a workflow-agent composer", () => {
    const rightPanel = statefulSetter<UtilityPanel | undefined>("search");
    const { openNewWorkflowComposer } = createAppWorkflowComposerNavigation({
      loadWorkflowAgentFolders: vi.fn(),
      setAutomationPopover: vi.fn(),
      setProjectPopover: vi.fn(),
      setRightPanel: rightPanel.set,
      setSelectedAutomationPane: vi.fn(),
      setSelectedAutomationThreadId: vi.fn(),
      setSelectedWorkflowAgentFolderId: vi.fn(),
      setSelectedWorkflowAgentThreadId: vi.fn(),
      setSelectedWorkflowRecordingId: vi.fn(),
      setSidebarArea: vi.fn(),
    });

    openNewWorkflowComposer();

    expect(rightPanel.value).toBe("search");
  });

  it("routes desktop menu commands through the same shell actions", async () => {
    const controller = createController();
    controller.exportDiagnostics.mockRejectedValueOnce(new Error("zip failed"));

    await controller.actions.handleMenuCommand("new-chat");
    await controller.actions.handleMenuCommand("open-folder");
    await controller.actions.handleMenuCommand("toggle-sidebar");
    await controller.actions.handleMenuCommand("toggle-terminal");
    await controller.actions.handleMenuCommand("performance-trace");
    await controller.actions.handleMenuCommand("export-diagnostics");

    expect(controller.createThread).toHaveBeenCalledOnce();
    expect(controller.openWorkspace).toHaveBeenCalledOnce();
    expect(controller.sidebarOpen.value).toBe(false);
    expect(controller.togglePanel).toHaveBeenCalledWith("terminal");
    expect(controller.openPanel).toHaveBeenCalledWith("performance");
    expect(controller.error.value).toBe("zip failed");
  });

  it("maps App owner state into shell command actions", async () => {
    const controller = createForAppController();
    controller.threadMaintenanceActions.exportDiagnostics.mockRejectedValueOnce(new Error("zip failed"));

    await controller.actions.handleMenuCommand("new-chat");
    await controller.actions.handleMenuCommand("open-folder");
    await controller.actions.handleMenuCommand("toggle-sidebar");
    await controller.actions.handleMenuCommand("toggle-terminal");
    await controller.actions.handleMenuCommand("performance-trace");
    await controller.actions.handleMenuCommand("export-diagnostics");

    expect(controller.navigationActions.createThread).toHaveBeenCalledOnce();
    expect(controller.navigationActions.openWorkspace).toHaveBeenCalledOnce();
    expect(controller.sidebarOpen.value).toBe(false);
    expect(controller.rightPanelState.togglePanel).toHaveBeenCalledWith("terminal");
    expect(controller.rightPanelState.openPanel).toHaveBeenCalledWith("performance");
    expect(controller.shellUiState.error.value).toBe("zip failed");

    await controller.actions.commandItems().find((item) => item.id === "api-key")?.run();
    await controller.actions.commandItems().find((item) => item.id === "mcp-runtime-settings")?.run();
    await controller.actions.commandItems().find((item) => item.id === "automations")?.run();
    await controller.actions.commandItems().find((item) => item.id === "compact")?.run();

    expect(controller.credentialDialogActions.openApiKeyDialog).toHaveBeenCalledOnce();
    expect(controller.rightPanelState.openMcpRuntimeSettings).toHaveBeenCalledOnce();
    expect(controller.navigationActions.openWorkflowRecordingsArea).toHaveBeenCalledOnce();
    expect(controller.threadMaintenanceActions.compactActiveThread).toHaveBeenCalledOnce();

    controller.actions.openMediaPreviewModal("/tmp/screenshot.png", "image");
    expect(controller.shellUiState.mediaPreviewModal.value).toEqual({
      path: "/tmp/screenshot.png",
      mediaKind: "image",
    });
  });

  it("closes the palette and runs the selected command", async () => {
    const controller = createController();
    controller.commandPaletteOpen.set(true);
    controller.commandPaletteQuery.set("diag");
    const run = vi.fn();

    await controller.actions.runPaletteCommand({
      id: "diagnostics",
      label: "Diagnostics",
      detail: "Help",
      run,
    });

    expect(controller.commandPaletteOpen.value).toBe(false);
    expect(controller.commandPaletteQuery.value).toBe("");
    expect(run).toHaveBeenCalledOnce();
  });

  it("updates thread settings and mirrors active-thread settings into desktop state", async () => {
    const updatedThread = {
      ...threadSummary("thread-1"),
      collaborationMode: "planner",
      memoryEnabled: false,
      model: "kimi",
      thinkingLevel: "high",
    } as ThreadSummary;
    const updateThreadSettings = vi.fn(async () => updatedThread);
    vi.stubGlobal("window", { ambientDesktop: { updateThreadSettings } });
    const controller = createController({ state: desktopState() });

    await controller.actions.updateThreadSettings({ memoryEnabled: false });

    expect(updateThreadSettings).toHaveBeenCalledWith({
      threadId: "thread-1",
      memoryEnabled: false,
    });
    expect(controller.state.value?.threads[0]).toBe(updatedThread);
    expect(controller.state.value?.settings.collaborationMode).toBe("planner");
    expect(controller.state.value?.settings.model).toBe("kimi");
    expect(controller.state.value?.settings.thinkingLevel).toBe("high");
  });

  it("replaces context usage from the previous model when the active model changes", async () => {
    const initialState = desktopState();
    initialState.contextUsage = {
      threadId: "thread-1",
      modelId: "old-model",
      source: "estimate",
      tokens: 100_000,
      contextWindow: 80_000,
      percent: 125,
      compactionCount: 0,
      updatedAt: "2026-07-22T00:00:00.000Z",
    };
    const updatedThread = { ...threadSummary("thread-1"), model: "new-model" } as ThreadSummary;
    const refreshedContextUsage: DesktopState["contextUsage"] = {
      threadId: "thread-1",
      modelId: "new-model",
      source: "unavailable",
      contextWindow: 200_000,
      compactionCount: 0,
      updatedAt: "2026-07-22T00:00:01.000Z",
      diagnostics: { activeSession: false, message: "Waiting for the new model." },
    };
    const getContextUsage = vi.fn(async () => refreshedContextUsage);
    vi.stubGlobal("window", {
      ambientDesktop: {
        updateThreadSettings: vi.fn(async () => updatedThread),
        getContextUsage,
      },
    });
    const controller = createController({ state: initialState });

    await controller.actions.updateThreadSettings({ model: "new-model" });

    expect(controller.state.value?.settings.model).toBe("new-model");
    expect(getContextUsage).toHaveBeenCalledWith("thread-1");
    expect(controller.state.value?.contextUsage).toBe(refreshedContextUsage);
  });

  it("updates theme preference through the desktop bridge and document appearance", async () => {
    const appearance: AppAppearance = { themePreference: "dark", resolvedTheme: "dark" };
    const setThemePreference = vi.fn(async () => appearance);
    const setItem = vi.fn();
    const documentElement = fakeDocumentElement();
    vi.stubGlobal("window", {
      ambientDesktop: { setThemePreference },
      localStorage: { setItem },
    });
    vi.stubGlobal("document", { documentElement });
    const controller = createController({ state: desktopState() });

    await controller.actions.updateThemePreference("dark");

    expect(setThemePreference).toHaveBeenCalledWith({ themePreference: "dark" });
    expect(controller.state.value?.appearance).toEqual(appearance);
    expect(documentElement.dataset.theme).toBe("dark");
    expect(documentElement.dataset.themePreference).toBe("dark");
    expect(setItem).toHaveBeenCalledWith("ambient-desktop-resolved-theme", "dark");
  });
});

function fakeDocumentElement(): {
  dataset: Record<string, string>;
  removeAttribute: (name: string) => void;
  style: { colorScheme: string };
} {
  const dataset: Record<string, string> = {};
  return {
    dataset,
    removeAttribute(name) {
      if (name === "data-theme") delete dataset.theme;
      if (name === "data-theme-preference") delete dataset.themePreference;
    },
    style: { colorScheme: "" },
  };
}

function createController({ state: initialState = undefined }: { state?: DesktopState } = {}) {
  const state = statefulSetter<DesktopState | undefined>(initialState);
  const commandPaletteOpen = statefulSetter(false);
  const commandPaletteQuery = statefulSetter("");
  const error = statefulSetter<string | undefined>(undefined);
  const mediaPreviewModal = statefulSetter<{ path: string; mediaKind: "image" | "video" } | undefined>(undefined);
  const rightPanelWidth = statefulSetter(520);
  const sidebarOpen = statefulSetter(true);
  const sidebarWidth = statefulSetter(280);
  const workflowRecorderReviewPanelWidth = statefulSetter(420);
  const createThread = vi.fn();
  const exportActiveChat = vi.fn();
  const exportDiagnostics = vi.fn();
  const openPanel = vi.fn();
  const openWorkspace = vi.fn();
  const togglePanel = vi.fn();

  return {
    actions: createAppShellCommandActions({
      compactActiveThread: vi.fn(),
      contextUsage: initialState?.contextUsage,
      createThread,
      exportActiveChat,
      exportDiagnostics,
      openApiKeyDialog: vi.fn(),
      openMcpRuntimeSettings: vi.fn(),
      openPanel,
      openWorkflowLabArea: vi.fn(),
      openWorkflowRecordingsArea: vi.fn(),
      openWorkspace,
      recoverActiveThreadContext: vi.fn(),
      rightPanel: undefined,
      setCommandPaletteOpen: commandPaletteOpen.set,
      setCommandPaletteQuery: commandPaletteQuery.set,
      setError: error.set,
      setMediaPreviewModal: mediaPreviewModal.set,
      setRightPanelWidth: rightPanelWidth.set,
      setSidebarOpen: sidebarOpen.set,
      setSidebarWidth: sidebarWidth.set,
      setState: state.set,
      setWorkflowRecorderReviewPanelWidth: workflowRecorderReviewPanelWidth.set,
      sidebarOpen: sidebarOpen.value,
      state: state.value,
      togglePanel,
      workflowRecorderNavLabel: "Automations",
    }),
    commandPaletteOpen,
    commandPaletteQuery,
    createThread,
    error,
    exportActiveChat,
    exportDiagnostics,
    mediaPreviewModal,
    openPanel,
    openWorkspace,
    rightPanelWidth,
    sidebarOpen,
    sidebarWidth,
    state,
    togglePanel,
    workflowRecorderReviewPanelWidth,
  };
}

function createForAppController({ state: initialState = desktopState() }: { state?: DesktopState } = {}) {
  const state = statefulSetter<DesktopState | undefined>(initialState);
  const commandPaletteOpen = statefulSetter(false);
  const commandPaletteQuery = statefulSetter("");
  const error = statefulSetter<string | undefined>(undefined);
  const mediaPreviewModal = statefulSetter<{ path: string; mediaKind: "image" | "video" } | undefined>(undefined);
  const rightPanelWidth = statefulSetter(520);
  const sidebarOpen = statefulSetter(true);
  const sidebarWidth = statefulSetter(280);
  const workflowRecorderReviewPanelWidth = statefulSetter(420);
  const credentialDialogActions = {
    openApiKeyDialog: vi.fn(),
  };
  const navigationActions = {
    createThread: vi.fn(),
    openWorkflowLabArea: vi.fn(),
    openWorkflowRecordingsArea: vi.fn(),
    openWorkspace: vi.fn(),
  };
  const rightPanelState = {
    openMcpRuntimeSettings: vi.fn(),
    openPanel: vi.fn(),
    rightPanel: "browser" as UtilityPanel | undefined,
    setRightPanelWidth: rightPanelWidth.set,
    togglePanel: vi.fn(),
  };
  const shellUiState = {
    commandPaletteOpen,
    commandPaletteQuery,
    error,
    mediaPreviewModal,
    setCommandPaletteOpen: commandPaletteOpen.set,
    setCommandPaletteQuery: commandPaletteQuery.set,
    setError: error.set,
    setMediaPreviewModal: mediaPreviewModal.set,
    setSidebarOpen: sidebarOpen.set,
    setSidebarWidth: sidebarWidth.set,
    setWorkflowRecorderReviewPanelWidth: workflowRecorderReviewPanelWidth.set,
    sidebarOpen: sidebarOpen.value,
    sidebarWidth,
    workflowRecorderReviewPanelWidth,
  };
  const threadMaintenanceActions = {
    compactActiveThread: vi.fn(),
    exportActiveChat: vi.fn(),
    exportDiagnostics: vi.fn(),
    recoverActiveThreadContext: vi.fn(),
  };

  return {
    actions: createAppShellCommandActionsForApp({
      credentialDialogActions,
      navigationActions,
      rightPanelState,
      setState: state.set,
      shellUiState,
      state: state.value,
      threadMaintenanceActions,
      workflowRecorderNavLabel: "Automations",
    }),
    credentialDialogActions,
    navigationActions,
    rightPanelState,
    sidebarOpen,
    shellUiState,
    state,
    threadMaintenanceActions,
  };
}

function desktopState(): DesktopState {
  return {
    activeThreadId: "thread-1",
    appearance: { themePreference: "system", resolvedTheme: "light" },
    settings: {
      collaborationMode: "default",
      model: "default",
      permissionMode: "full-access",
      thinkingLevel: "medium",
    },
    threads: [threadSummary("thread-1"), threadSummary("thread-2")],
  } as unknown as DesktopState;
}

function threadSummary(id: string): ThreadSummary {
  return {
    id,
    collaborationMode: "default",
    memoryEnabled: true,
    model: "default",
    permissionMode: "full-access",
    thinkingLevel: "medium",
  } as unknown as ThreadSummary;
}

function statefulSetter<T>(initial: T): {
  set: Dispatch<SetStateAction<T>>;
  value: T;
} {
  const state = { value: initial };
  return {
    get value() {
      return state.value;
    },
    set(next) {
      state.value = typeof next === "function" ? (next as (current: T) => T)(state.value) : next;
    },
  };
}
