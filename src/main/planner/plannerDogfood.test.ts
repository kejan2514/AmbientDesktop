import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { safeStorage } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AMBIENT_DEFAULT_MODEL } from "../../shared/ambientModels";
import type { SendMessageInput } from "../../shared/desktopTypes";
import type { PlannerDiagramKind, PlannerPlanArtifact } from "../../shared/plannerTypes";
import { plannerDecisionFinalizationPrompt } from "../../renderer/src/plannerModeUiModel";
import { AgentRuntime } from "./plannerAgentRuntimeDogfoodFacade";
import { BrowserCredentialStore, BrowserService } from "../browser/browserAgentRuntimeContract";
import type { PlannerDurableHtmlBrowserValidator } from "./plannerDurableHtml";
import { ProjectStore } from "./plannerProjectStoreFacade";

const electronMock = vi.hoisted(() => ({
  userDataPath: `${process.env.TMPDIR || "/tmp"}/ambient-planner-dogfood-electron`,
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataPath,
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  },
}));

const describeNative = process.env.AMBIENT_TEST_NATIVE === "1" ? describe : describe.skip;
const itLive = process.env.AMBIENT_PLANNER_DOGFOOD_LIVE === "1" ? it : it.skip;
const itRepairLive = process.env.AMBIENT_PLANNER_DOGFOOD_REPAIR_LIVE === "1" ? it : it.skip;
const itMediumLive = process.env.AMBIENT_PLANNER_DOGFOOD_MEDIUM_LIVE === "1" ? it : it.skip;
const LIVE_PLANNER_DOGFOOD_TIMEOUT_MS = envDurationMs("AMBIENT_PLANNER_DOGFOOD_TEST_TIMEOUT_MS", 900_000, 120_000);
const LIVE_PLANNER_DOGFOOD_TURN_TIMEOUT_MS = envDurationMs("AMBIENT_PLANNER_DOGFOOD_TURN_TIMEOUT_MS", 300_000, 30_000);
const REQUIRED_DURABLE_DIAGRAM_KINDS: PlannerDiagramKind[] = ["architecture", "dependencies", "program_flow", "functional_nonfunctional"];

describeNative("Planner Mode live dogfood", () => {
  let workspacePath = "";
  let store: ProjectStore;
  let runtime: AgentRuntime | undefined;
  let browser: BrowserService | undefined;
  let desktopEvents: unknown[] = [];

  beforeEach(async () => {
    desktopEvents = [];
    workspacePath = await mkdtemp(join(tmpdir(), "ambient-planner-dogfood-"));
    await writeFile(
      join(workspacePath, "README.md"),
      [
        "# Planner dogfood workspace",
        "",
        "This temporary workspace exists only to validate live Ambient Planner Mode behavior.",
      ].join("\n"),
      "utf8",
    );
    store = new ProjectStore();
    store.openWorkspace(workspacePath);
  });

  afterEach(async () => {
    runtime?.resetSessions();
    await runtime?.shutdownPluginMcpServers().catch(() => undefined);
    await browser?.shutdown().catch(() => undefined);
    store.close();
    await rm(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    runtime = undefined;
    browser = undefined;
  });

  itLive("dogfoods question capture, answer finalization, durable HTML generation, and board source promotion", async () => {
    await ensureAmbientApiKey();
    store.createProjectBoard({ title: "Planner dogfood board", summary: "Validate durable planning artifacts." });
    const thread = store.createThread("Planner durable dogfood", workspacePath);
    runtime = createPlannerDogfoodRuntime(store, (created) => {
      browser = created;
    }, (event) => desktopEvents.push(event), {
      durableBrowserValidator: plannerDogfoodPassValidator(),
    });

    await sendPlannerDogfoodTurn(
      runtime,
      store,
      desktopEvents,
      "initial planner question turn",
      {
        threadId: thread.id,
        permissionMode: "workspace",
        collaborationMode: "planner",
        model: process.env.AMBIENT_PLANNER_DOGFOOD_MODEL ?? AMBIENT_DEFAULT_MODEL,
        thinkingLevel: "minimal",
        content: [
          "This is an Ambient Desktop Planner Mode live dogfood test.",
          "Create a planning-only proposal for a tiny UI code change: add a dismiss affordance to planner status banners.",
          "Hard output contract: your first response must include exactly one parseable canonical ambient-planner-questions fenced JSON block with one required question, two options, and a recommended option. Do not decide this question yourself.",
          "Do not edit files, run tests, install dependencies, or begin implementation.",
        ].join("\n"),
      },
    );

    const initialArtifact = latestPlannerArtifact(store, thread.id);
    expect(initialArtifact.decisionQuestions.length, plannerDogfoodDiagnostic(store, thread.id, initialArtifact)).toBeGreaterThanOrEqual(1);
    expect(
      initialArtifact.decisionQuestions.some((question) => question.required),
      plannerDogfoodDiagnostic(store, thread.id, initialArtifact),
    ).toBe(true);
    expect(initialArtifact.durableArtifactPath).toBeUndefined();

    const finalArtifact = await drivePlannerArtifactToDurable(runtime, store, thread.id, initialArtifact, desktopEvents, {
      waitForBackgroundRepair: true,
    });
    expect(["durable_ready", "durable_ready_with_fallbacks"]).toContain(finalArtifact.workflowState);
    expect(finalArtifact.durableArtifactPath).toMatch(/^\.ambient\/board\/plans\/.+-DurablePlan\.html$/);
    expect(finalArtifact.durableArtifactValidation).toMatchObject({
      ok: true,
      warnings: expect.arrayContaining([
        expect.objectContaining({
          code: "dogfood-browser-validator",
        }),
      ]),
    });

    const durablePath = join(workspacePath, finalArtifact.durableArtifactPath!);
    await expect(access(durablePath)).resolves.toBeUndefined();
    const durableHtml = await readFile(durablePath, "utf8");
    expect(durableHtml).toContain('id="diagram-gallery"');
    expect(durableHtml).toContain("<svg");
    expect(durableHtml).toContain("Planner durable dogfood");

    const board = store.getProjectBoardForPath(workspacePath);
    expect(board?.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "plan_artifact",
          artifactId: finalArtifact.id,
          path: finalArtifact.durableArtifactPath,
          authorityRole: "primary",
        }),
      ]),
    );
  }, LIVE_PLANNER_DOGFOOD_TIMEOUT_MS);

  itRepairLive("dogfoods durable repair after injected malformed diagram validation", async () => {
    await ensureAmbientApiKey();
    store.createProjectBoard({ title: "Planner repair dogfood board", summary: "Validate durable repair handling." });
    const thread = store.createThread("Planner durable repair dogfood", workspacePath);
    runtime = createPlannerDogfoodRuntime(store, (created) => {
      browser = created;
    }, (event) => desktopEvents.push(event), {
      durableBrowserValidator: plannerDogfoodFailOnceValidator(),
    });

    await sendPlannerDogfoodTurn(
      runtime,
      store,
      desktopEvents,
      "initial repair planner question turn",
      {
        threadId: thread.id,
        permissionMode: "workspace",
        collaborationMode: "planner",
        model: process.env.AMBIENT_PLANNER_DOGFOOD_MODEL ?? AMBIENT_DEFAULT_MODEL,
        thinkingLevel: "minimal",
        content: [
          "This is an Ambient Desktop Planner Mode durable repair dogfood test.",
          "Create a planning-only proposal for a medium UI feature: make planner durable artifact cards show validation status, repair attempts, and fallback warnings.",
          "Hard output contract: your first response must include exactly one parseable canonical ambient-planner-questions fenced JSON block with one required question, two options, and a recommended option. Do not decide this question yourself.",
          "Do not edit files, run tests, install dependencies, or begin implementation.",
        ].join("\n"),
      },
    );

    const initialArtifact = latestPlannerArtifact(store, thread.id);
    expect(initialArtifact.decisionQuestions.length, plannerDogfoodDiagnostic(store, thread.id, initialArtifact)).toBeGreaterThanOrEqual(1);

    const finalArtifact = await drivePlannerArtifactToDurable(runtime, store, thread.id, initialArtifact, desktopEvents, {
      waitForBackgroundRepair: true,
    });
    expect(finalArtifact.durableArtifactPath).toMatch(/^\.ambient\/board\/plans\/.+-DurablePlan\.html$/);
    expect(finalArtifact.durableArtifactValidation).toMatchObject({
      ok: true,
      warnings: expect.arrayContaining([
        expect.objectContaining({
          code: "dogfood-repair-validator-pass",
        }),
      ]),
    });

    const artifacts = store.listPlannerPlanArtifacts(thread.id);
    expect(artifacts.some((artifact) => artifact.durableArtifactValidation?.errors.some((issue) => issue.code === "dogfood-injected-malformed-diagram"))).toBe(true);
    expect(
      desktopEvents.some((event) => ["planner-plan-artifact-created", "planner-plan-artifact-updated"].includes(plannerDogfoodEventType(event) ?? "")),
    ).toBe(true);

    const board = store.getProjectBoardForPath(workspacePath);
    expect(board?.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "plan_artifact",
          artifactId: finalArtifact.id,
          path: finalArtifact.durableArtifactPath,
          authorityRole: "primary",
        }),
      ]),
    );
  }, LIVE_PLANNER_DOGFOOD_TIMEOUT_MS);

  itMediumLive("dogfoods multiple decisions and diagram-rich durable planning", async () => {
    await ensureAmbientApiKey();
    store.createProjectBoard({ title: "Planner medium dogfood board", summary: "Validate multi-decision durable planning." });
    const thread = store.createThread("Planner medium diagram dogfood", workspacePath);
    runtime = createPlannerDogfoodRuntime(store, (created) => {
      browser = created;
    }, (event) => desktopEvents.push(event), {
      durableBrowserValidator: plannerDogfoodPassValidator(),
    });

    await sendPlannerDogfoodTurn(
      runtime,
      store,
      desktopEvents,
      "initial medium planner question turn",
      {
        threadId: thread.id,
        permissionMode: "workspace",
        collaborationMode: "planner",
        model: process.env.AMBIENT_PLANNER_DOGFOOD_MODEL ?? AMBIENT_DEFAULT_MODEL,
        thinkingLevel: "minimal",
        content: [
          "This is an Ambient Desktop Planner Mode medium dogfood test.",
          "Create a planning-only proposal for a medium feature: let users tell Ambient to prefer a named provider for a task class, such as using Brave Search for search/research while still preserving browser fallback for human-in-the-loop pages.",
          "This feature should naturally benefit from architecture, dependencies, program flow, and functional/non-functional concern diagrams.",
          "Dogfood harness constraint: do not call tools, inspect files, browse, search, or query provider catalogs. Use only this prompt and the user's eventual decisions.",
          "Hard output contract: your first response must include exactly one parseable canonical ambient-planner-questions fenced JSON block with exactly two required questions. Each question must have at least two options and a recommended option. Do not decide either question yourself.",
          "Do not edit files, run tests, install dependencies, or begin implementation.",
        ].join("\n"),
      },
    );

    const initialArtifact = latestPlannerArtifact(store, thread.id);
    const requiredQuestions = initialArtifact.decisionQuestions.filter((question) => question.required);
    expect(requiredQuestions.length, plannerDogfoodDiagnostic(store, thread.id, initialArtifact)).toBeGreaterThanOrEqual(2);
    expect(initialArtifact.durableArtifactPath).toBeUndefined();

    const finalArtifact = await drivePlannerArtifactToDurable(runtime, store, thread.id, initialArtifact, desktopEvents, {
      waitForBackgroundRepair: true,
      refinementInstruction:
        "Dogfood harness constraint: do not call tools, inspect files, browse, search, or query provider catalogs. Produce the durable plan from the existing plan and answered decisions only.",
    });
    expect(["durable_ready", "durable_ready_with_fallbacks"]).toContain(finalArtifact.workflowState);
    expect(finalArtifact.decisionQuestions.filter((question) => question.answer).length).toBeGreaterThanOrEqual(2);
    expect(finalArtifact.durableArtifactPath).toMatch(/^\.ambient\/board\/plans\/.+-DurablePlan\.html$/);
    expect(finalArtifact.durableArtifactValidation).toMatchObject({
      ok: true,
      warnings: expect.arrayContaining([
        expect.objectContaining({
          code: "dogfood-browser-validator",
        }),
      ]),
    });
    const missingDiagramKinds = plannerDogfoodMissingDiagramKinds(finalArtifact);
    expect(missingDiagramKinds).not.toContain("architecture");
    expect(missingDiagramKinds).not.toContain("dependencies");
    expect(missingDiagramKinds).not.toContain("program_flow");
    expect(missingDiagramKinds.length).toBeLessThanOrEqual(1);

    const durablePath = join(workspacePath, finalArtifact.durableArtifactPath!);
    const durableHtml = await readFile(durablePath, "utf8");
    expect(durableHtml).toContain('id="architecture"');
    expect(durableHtml).toContain('id="dependencies"');
    expect(durableHtml).toContain('id="program-flow"');
    expect(durableHtml).toContain('id="functional-concerns"');
    expect(durableHtml).toContain("Brave Search");
    expect(durableHtml).toContain("Provider");

    const board = store.getProjectBoardForPath(workspacePath);
    expect(board?.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "plan_artifact",
          artifactId: finalArtifact.id,
          path: finalArtifact.durableArtifactPath,
          authorityRole: "primary",
        }),
      ]),
    );
  }, LIVE_PLANNER_DOGFOOD_TIMEOUT_MS);
});

function createPlannerDogfoodRuntime(
  store: ProjectStore,
  onBrowser: (browser: BrowserService) => void,
  onDesktopEvent: (event: unknown) => void,
  options: { durableBrowserValidator: PlannerDurableHtmlBrowserValidator },
): AgentRuntime {
  const plannerBrowser = new BrowserService(() => store.getWorkspace());
  onBrowser(plannerBrowser);
  return new AgentRuntime(
    store,
    plannerBrowser,
    new BrowserCredentialStore(() => store.getWorkspace(), safeStorage),
    () =>
      ({
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          isCrashed: () => false,
          send: (_channel: string, event: unknown) => onDesktopEvent(event),
        },
      }) as any,
    {
      request: async (request) => {
        throw new Error(`Unexpected permission prompt during planner dogfood: ${request.title}`);
      },
      denyThread: () => undefined,
    },
    {
      planner: {
        durableBrowserValidator: options.durableBrowserValidator,
      },
    },
  );
}

async function drivePlannerArtifactToDurable(
  activeRuntime: AgentRuntime,
  activeStore: ProjectStore,
  threadId: string,
  startingArtifact: PlannerPlanArtifact,
  events: unknown[],
  options: { waitForBackgroundRepair?: boolean; refinementInstruction?: string } = {},
): Promise<PlannerPlanArtifact> {
  let artifact = startingArtifact;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (artifact.durableArtifactPath) return artifact;
    let answered = artifact;
    for (const question of artifact.decisionQuestions.filter((item) => !item.answer)) {
      const optionId = question.options.some((option) => option.id === question.recommendedOptionId)
        ? question.recommendedOptionId
        : question.options[0]?.id;
      if (!optionId) continue;
      answered = activeStore.answerPlannerDecisionQuestion(answered.id, question.id, { kind: "option", optionId });
    }
    answered = activeStore.updatePlannerPlanArtifact(answered.id, { workflowState: "finalizing" });
    console.log(
      `[planner-dogfood] artifact before refinement ${attempt + 1}: state=${answered.workflowState}; decisions=${answered.decisionQuestions.length}; answered=${answered.decisionQuestions.filter((question) => question.answer).length}`,
    );

    await sendPlannerDogfoodTurn(
      activeRuntime,
      activeStore,
      events,
      `planner decision finalization turn ${attempt + 1}`,
      {
        threadId,
        permissionMode: "workspace",
        collaborationMode: "planner",
        model: process.env.AMBIENT_PLANNER_DOGFOOD_MODEL ?? AMBIENT_DEFAULT_MODEL,
        thinkingLevel: "minimal",
        content: [plannerDecisionFinalizationPrompt(answered), options.refinementInstruction].filter(Boolean).join("\n\n"),
      },
    );
    artifact = latestPlannerArtifact(activeStore, threadId);
    console.log(
      `[planner-dogfood] artifact after refinement ${attempt + 1}: state=${artifact.workflowState}; durable=${artifact.durableArtifactPath ?? "none"}; decisions=${artifact.decisionQuestions.length}; answered=${artifact.decisionQuestions.filter((question) => question.answer).length}; diagrams=${artifact.diagrams?.length ?? 0}; validation=${artifact.durableArtifactValidation?.ok ?? "none"}`,
    );
    if (!artifact.durableArtifactPath && artifact.workflowState === "repairing" && options.waitForBackgroundRepair) {
      artifact = await waitForPlannerDogfoodDurableArtifact(activeRuntime, activeStore, threadId, events, `planner repair follow-up ${attempt + 1}`);
      console.log(
        `[planner-dogfood] artifact after repair ${attempt + 1}: state=${artifact.workflowState}; durable=${artifact.durableArtifactPath ?? "none"}; decisions=${artifact.decisionQuestions.length}; answered=${artifact.decisionQuestions.filter((question) => question.answer).length}; diagrams=${artifact.diagrams?.length ?? 0}; validation=${artifact.durableArtifactValidation?.ok ?? "none"}`,
      );
    }
  }
  return artifact;
}

async function sendPlannerDogfoodTurn(
  activeRuntime: AgentRuntime,
  activeStore: ProjectStore,
  events: unknown[],
  label: string,
  input: SendMessageInput,
): Promise<void> {
  console.log(`[planner-dogfood] starting ${label}`);
  try {
    await withPlannerDogfoodTimeout(
      activeRuntime.send(input, {
        onActivity: () => {
          // The desktop event log below captures details; this hook keeps the turn timeout honest.
        },
      }),
      () => plannerTurnTimeoutMessage(activeStore, input.threadId, events, label, LIVE_PLANNER_DOGFOOD_TURN_TIMEOUT_MS),
      LIVE_PLANNER_DOGFOOD_TURN_TIMEOUT_MS,
    );
  } catch (error) {
    await activeRuntime.abort(input.threadId).catch(() => undefined);
    throw error;
  }
  console.log(`[planner-dogfood] completed ${label}`);
}

async function withPlannerDogfoodTimeout<T>(promise: Promise<T>, timeoutMessage: () => string, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage())), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function plannerTurnTimeoutMessage(activeStore: ProjectStore, threadId: string, events: unknown[], label: string, timeoutMs: number): string {
  return [
    `Timed out waiting for ${label} after ${timeoutMs}ms.`,
    plannerRuntimeDiagnostic(activeStore, threadId, events),
  ].join("\n\n");
}

function plannerRuntimeDiagnostic(activeStore: ProjectStore, threadId: string, events: unknown[]): string {
  const messages = activeStore.listMessages(threadId);
  const messageTail = messages.slice(-6).map((message) => {
    const metadata = message.metadata ?? {};
    const status = typeof metadata.status === "string" ? metadata.status : "unknown";
    const kind = typeof metadata.kind === "string" ? metadata.kind : undefined;
    return `${message.role}${kind ? `/${kind}` : ""}:${status}:${message.content.slice(0, 220).replace(/\s+/g, " ")}`;
  });
  const activeRuns = activeStore.listActiveRuns().map((run) => `${run.status}:${run.threadId}:${run.errorMessage ?? ""}`);
  const eventTail = events.slice(-12).map((event) => {
    if (!event || typeof event !== "object") return String(event);
    const record = event as Record<string, any>;
    if (record.type === "runtime-activity") {
      const activity = record.activity as Record<string, any> | undefined;
      return `runtime-activity:${activity?.kind ?? "unknown"}:${activity?.status ?? "unknown"}:${activity?.message ?? ""}:out=${activity?.outputChars ?? ""}:think=${activity?.thinkingChars ?? ""}`;
    }
    if (record.type === "run-status") return `run-status:${record.status ?? "unknown"}`;
    if (record.type === "message-created" || record.type === "message-updated") {
      const message = record.message as Record<string, any> | undefined;
      const metadata = message?.metadata as Record<string, any> | undefined;
      return `${record.type}:${message?.role ?? "unknown"}:${metadata?.status ?? "unknown"}:${String(message?.content ?? "").slice(0, 120).replace(/\s+/g, " ")}`;
    }
    if (record.type === "error") return `error:${record.message ?? ""}`;
    return String(record.type ?? JSON.stringify(record).slice(0, 180));
  });
  return [
    "Planner dogfood runtime diagnostic:",
    `Active runs: ${activeRuns.join(" | ") || "none"}`,
    `Messages:\n${messageTail.join("\n") || "none"}`,
    `Events:\n${eventTail.join("\n") || "none"}`,
  ].join("\n");
}

function latestPlannerArtifact(activeStore: ProjectStore, threadId: string): PlannerPlanArtifact {
  const artifact = activeStore.listPlannerPlanArtifacts(threadId)[0];
  if (!artifact) throw new Error("Expected Planner Mode to create a planner plan artifact.");
  return artifact;
}

async function waitForPlannerDogfoodDurableArtifact(
  activeRuntime: AgentRuntime,
  activeStore: ProjectStore,
  threadId: string,
  events: unknown[],
  label: string,
): Promise<PlannerPlanArtifact> {
  const deadline = Date.now() + LIVE_PLANNER_DOGFOOD_TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const artifact = latestPlannerArtifact(activeStore, threadId);
    if (artifact.durableArtifactPath) return artifact;
    if (artifact.workflowState === "failed") {
      throw new Error([`Planner durable repair failed during ${label}.`, plannerRuntimeDiagnostic(activeStore, threadId, events)].join("\n\n"));
    }
    await delay(1_000);
  }
  await activeRuntime.abort(threadId).catch(() => undefined);
  throw new Error(plannerTurnTimeoutMessage(activeStore, threadId, events, label, LIVE_PLANNER_DOGFOOD_TURN_TIMEOUT_MS));
}

function plannerDogfoodPassValidator(): PlannerDurableHtmlBrowserValidator {
  return async ({ staticValidation }) => ({
    ...staticValidation,
    warnings: [...staticValidation.warnings, plannerDogfoodValidationWarning("dogfood-browser-validator", "Planner dogfood validator observed the durable artifact candidate.")],
  });
}

function plannerDogfoodFailOnceValidator(): PlannerDurableHtmlBrowserValidator {
  let callCount = 0;
  return async ({ staticValidation }) => {
    callCount += 1;
    if (callCount === 1) {
      return {
        ok: false,
        checkedAt: new Date().toISOString(),
        errors: [
          {
            code: "dogfood-injected-malformed-diagram",
            section: "diagram-gallery",
            message: "Injected browser-validation failure for live planner durable repair dogfood.",
          },
        ],
        warnings: staticValidation.warnings,
      };
    }
    return {
      ...staticValidation,
      warnings: [
        ...staticValidation.warnings,
        plannerDogfoodValidationWarning("dogfood-repair-validator-pass", "Planner dogfood validator accepted the repaired durable artifact candidate."),
      ],
    };
  };
}

function plannerDogfoodValidationWarning(code: string, message: string) {
  return {
    code,
    section: "diagram-gallery",
    message,
  };
}

function plannerDogfoodEventType(event: unknown): string | undefined {
  return event && typeof event === "object" && "type" in event ? String((event as { type?: unknown }).type) : undefined;
}

function plannerDogfoodMissingDiagramKinds(artifact: PlannerPlanArtifact): PlannerDiagramKind[] {
  const providedKinds = new Set((artifact.diagrams ?? []).map((diagram) => diagram.kind));
  return REQUIRED_DURABLE_DIAGRAM_KINDS.filter((kind) => !providedKinds.has(kind));
}

function plannerDogfoodDiagnostic(activeStore: ProjectStore, threadId: string, artifact: PlannerPlanArtifact): string {
  const finalAssistant = [...activeStore.listMessages(threadId)].reverse().find((message) => message.role === "assistant")?.content ?? "";
  return [
    "Expected live Planner Mode to create native decision questions.",
    `Artifact title: ${artifact.title}`,
    `Warnings: ${(artifact.warnings ?? []).join("; ") || "none"}`,
    `Content preview: ${artifact.content.slice(0, 1200)}`,
    `Final assistant preview: ${finalAssistant.slice(0, 1200)}`,
  ].join("\n");
}

async function ensureAmbientApiKey(): Promise<string> {
  const existing = process.env.AMBIENT_API_KEY || process.env.AMBIENT_AGENT_AMBIENT_API_KEY;
  if (existing?.trim()) return existing.trim();
  const candidates = [
    process.env.AMBIENT_API_KEY_FILE,
    join(process.cwd(), "ignored-provider-key-file.txt"),
    join(dirname(process.cwd()), "ambientCoder", "ignored-provider-key-file.txt"),
    join(dirname(process.cwd()), "ignored-provider-key-file.txt"),
    join(dirname(dirname(process.cwd())), "ignored-provider-key-file.txt"),
    join(homedir(), "ignored-provider-key-file.txt"),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      const key = (await readFile(candidate, "utf8")).trim();
      if (key) {
        process.env.AMBIENT_API_KEY = key;
        process.env.AMBIENT_AGENT_AMBIENT_API_KEY = key;
        return key;
      }
    } catch {
      // Try the next conventional local key location.
    }
  }
  throw new Error("Set AMBIENT_API_KEY, AMBIENT_AGENT_AMBIENT_API_KEY, AMBIENT_API_KEY_FILE, or place ignored-provider-key-file.txt near the repo.");
}

function envDurationMs(name: string, fallbackMs: number, minMs: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallbackMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  return Math.max(minMs, Math.floor(parsed));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
