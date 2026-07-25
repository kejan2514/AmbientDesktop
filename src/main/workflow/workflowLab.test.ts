import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectStore } from "./workflowProjectStoreFacade";
import {
  AmbientWorkflowLabJudgeProvider,
  evaluateWorkflowLabVariant,
  runWorkflowLab,
  workflowLabApplyRunStatus,
  workflowLabApplyVariantAdoption,
  workflowLabAppendVariant,
  workflowLabCandidatePatches,
  workflowLabCreateRun,
  workflowLabListRuns,
  workflowLabReadRun,
  workflowLabRecordEvaluation,
  workflowLabRequireAcceptedVariant,
  workflowLabRequireBaseVersion,
  workflowLabRunArtifactPath,
  workflowLabRunsRootPath,
  workflowLabWriteRun,
} from "./workflowLab";
import type { WorkflowLabCandidatePatch, WorkflowLabEvaluationResult, WorkflowLabRun, WorkflowLabVariant } from "../../shared/workflowTypes";

const describeNative = process.env.AMBIENT_TEST_NATIVE === "1" ? describe : describe.skip;

describeNative("Workflow Lab", () => {
  let workspacePath = "";
  let store: ProjectStore;

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), "ambient-workflow-lab-"));
    store = new ProjectStore();
    store.openWorkspace(workspacePath);
  });

  afterEach(async () => {
    store.close();
    await rm(workspacePath, { recursive: true, force: true });
  });

  it("reads and lists normalized Workflow Lab run artifacts", async () => {
    expect(workflowLabListRuns(workspacePath)).toEqual([]);
    const rootPath = workflowLabRunsRootPath(workspacePath);
    await mkdir(rootPath, { recursive: true });
    const olderPath = workflowLabRunArtifactPath(workspacePath, "run-old");
    const newerPath = workflowLabRunArtifactPath(workspacePath, "run-new");
    const baseRun = {
      workflowId: "workflow-1",
      workflowTitle: "Date night workflow",
      baseVersion: 1,
      goal: "Improve recovery.",
      createdAt: "2026-05-20T17:00:00.000Z",
      evaluationCases: [],
      variants: [],
    };
    await writeFile(
      olderPath,
      `${JSON.stringify(
        {
          run: {
            ...baseRun,
            id: "run-old",
            metricEmphasis: "speed",
            attemptBudget: 99,
            plateauThreshold: -1,
            heldOutEnabled: false,
            status: "completed",
            updatedAt: "2026-05-20T18:00:00.000Z",
            artifactPath: "",
            audit: ["kept", 12],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      newerPath,
      `${JSON.stringify(
        {
          run: {
            ...baseRun,
            id: "run-new",
            workflowId: "workflow-2",
            metricEmphasis: "unknown",
            status: "unknown",
            updatedAt: "2026-05-20T19:00:00.000Z",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(join(rootPath, "ignored.txt"), "{}", "utf8");
    await writeFile(join(rootPath, "invalid.json"), "{ nope", "utf8");

    expect(workflowLabReadRun(olderPath)).toMatchObject({
      id: "run-old",
      metricEmphasis: "speed",
      attemptBudget: 10,
      plateauThreshold: 0,
      heldOutEnabled: false,
      status: "completed",
      artifactPath: olderPath,
      audit: ["kept"],
    });
    expect(workflowLabReadRun(newerPath)).toMatchObject({
      id: "run-new",
      metricEmphasis: "balanced",
      status: "draft",
    });
    expect(workflowLabListRuns(workspacePath).map((run) => run.id)).toEqual(["run-new", "run-old"]);
    expect(workflowLabListRuns(workspacePath, { workflowId: "workflow-1" }).map((run) => run.id)).toEqual(["run-old"]);
    expect(workflowLabListRuns(workspacePath, { limit: 1 }).map((run) => run.id)).toEqual(["run-new"]);
  });

  it("writes normalized Workflow Lab run artifacts", () => {
    const saved = workflowLabWriteRun(workspacePath, {
      id: "run-saved",
      workflowId: "workflow-1",
      workflowTitle: "Date night workflow",
      baseVersion: 1,
      goal: "Improve recovery.",
      metricEmphasis: "unsupported" as never,
      attemptBudget: 0,
      plateauThreshold: 2,
      heldOutEnabled: true,
      status: "unknown" as never,
      createdAt: "2026-05-20T17:00:00.000Z",
      updatedAt: "2026-05-20T18:00:00.000Z",
      artifactPath: "/tmp/wrong.json",
      evaluationCases: [],
      variants: [
        {
          id: "variant-1",
          runId: "run-saved",
          attempt: 1,
          hypothesis: "Normalize variant status.",
          patch: {
            summary: "No-op patch.",
            changedFields: [],
            draft: {
              intent: "Find date-night options.",
              inputs: [],
              successfulExamples: [],
              doNot: [],
              validation: [],
              outputShape: [],
            },
          },
          status: "unknown" as never,
          createdAt: "2026-05-20T17:10:00.000Z",
          updatedAt: "2026-05-20T17:10:00.000Z",
          evaluations: [],
        },
      ],
      audit: [],
    });

    expect(saved).toMatchObject({
      id: "run-saved",
      metricEmphasis: "balanced",
      attemptBudget: 1,
      plateauThreshold: 1,
      status: "draft",
      artifactPath: workflowLabRunArtifactPath(workspacePath, "run-saved"),
      variants: [expect.objectContaining({ status: "proposed" })],
    });
    expect(workflowLabReadRun(saved.artifactPath)).toMatchObject(saved);
  });

  it("creates normalized Workflow Lab run drafts from workflow descriptions", () => {
    const workflow = seedWorkflowDescription(store, workspacePath);
    const createdAt = "2026-05-20T20:00:00.000Z";
    const run = workflowLabCreateRun({
      workspacePath,
      workflow,
      request: {
        workflowId: workflow.id,
        goal: "  Improve recovery.  ",
        metricEmphasis: "speed",
        attemptBudget: 99,
        plateauThreshold: -1,
        heldOutEnabled: false,
      },
      runId: "run-create",
      createdAt,
    });

    expect(run).toMatchObject({
      id: "run-create",
      workflowId: workflow.id,
      workflowTitle: workflow.title,
      baseVersion: workflow.version,
      goal: "Improve recovery.",
      metricEmphasis: "speed",
      attemptBudget: 10,
      plateauThreshold: 0,
      heldOutEnabled: false,
      status: "draft",
      createdAt,
      updatedAt: createdAt,
      artifactPath: workflowLabRunArtifactPath(workspacePath, "run-create"),
      variants: [],
      audit: [
        `Created Workflow Lab run for ${workflow.id} at version ${workflow.version}.`,
        "Canonical workflow playbook will not change unless a candidate is adopted.",
      ],
    });
    expect(run.evaluationCases.map((evaluationCase) => evaluationCase.id)).toEqual(["original-replay"]);

    expect(() =>
      workflowLabCreateRun({
        workspacePath,
        workflow: { ...workflow, playbook: undefined },
        request: {
          workflowId: workflow.id,
          goal: "Improve recovery.",
        },
        runId: "run-without-playbook",
        createdAt,
      }),
    ).toThrow(`Workflow recording has no editable playbook: ${workflow.id}`);
  });

  it("applies Workflow Lab run status transitions without persistence", () => {
    const createdAt = "2026-05-20T20:00:00.000Z";
    const run = workflowLabRunFixture({
      createdAt,
      updatedAt: createdAt,
      audit: ["Created."],
    });

    const runningAt = "2026-05-20T20:01:00.000Z";
    const running = workflowLabApplyRunStatus(run, "running", { updatedAt: runningAt });

    expect(running).toMatchObject({
      status: "running",
      updatedAt: runningAt,
      audit: ["Created.", "Run status changed to running."],
    });
    expect(running.completedAt).toBeUndefined();
    expect(running.error).toBeUndefined();
    expect(run).toMatchObject({
      status: "draft",
      updatedAt: createdAt,
      audit: ["Created."],
    });

    const failedAt = "2026-05-20T20:02:00.000Z";
    const failed = workflowLabApplyRunStatus(running, "failed", {
      updatedAt: failedAt,
      error: "No candidate variants could be generated for this workflow.",
    });

    expect(failed).toMatchObject({
      status: "failed",
      updatedAt: failedAt,
      completedAt: failedAt,
      error: "No candidate variants could be generated for this workflow.",
      audit: [
        "Created.",
        "Run status changed to running.",
        "Run failed: No candidate variants could be generated for this workflow.",
      ],
    });
  });

  it("appends Workflow Lab variants without persistence", () => {
    const createdAt = "2026-05-20T20:00:00.000Z";
    const initialVariant = workflowLabVariantFixture({
      id: "variant-1",
      attempt: 1,
      hypothesis: "Initial recovery guidance.",
      patch: workflowLabCandidatePatchFixture("Initial patch."),
      createdAt,
      updatedAt: createdAt,
    });
    const run = workflowLabRunFixture({
      createdAt,
      updatedAt: createdAt,
      variants: [initialVariant],
      audit: ["Created."],
    });
    const appendedAt = "2026-05-20T20:03:00.000Z";
    const patch = workflowLabCandidatePatchFixture("Add explicit retry guidance.");

    const appended = workflowLabAppendVariant({
      run,
      variantId: "variant-2",
      createdAt: appendedAt,
      parentVariantId: initialVariant.id,
      hypothesis: "Add recovery branch.",
      patch,
      status: "evaluating",
    });

    expect(appended.variant).toMatchObject({
      id: "variant-2",
      runId: run.id,
      parentVariantId: initialVariant.id,
      attempt: 2,
      hypothesis: "Add recovery branch.",
      patch,
      status: "evaluating",
      createdAt: appendedAt,
      updatedAt: appendedAt,
      evaluations: [],
    });
    expect(appended.run).toMatchObject({
      updatedAt: appendedAt,
      variants: [initialVariant, appended.variant],
      audit: ["Created.", "Proposed variant 2: Add recovery branch."],
    });
    expect(run).toMatchObject({
      updatedAt: createdAt,
      variants: [initialVariant],
      audit: ["Created."],
    });
  });

  it("records Workflow Lab evaluations without persistence", () => {
    const createdAt = "2026-05-20T20:00:00.000Z";
    const evaluatedAt = "2026-05-20T20:04:00.000Z";
    const acceptedVariant = workflowLabVariantFixture({
      id: "variant-1",
      attempt: 1,
      status: "accepted",
      score: 85,
    });
    const candidateVariant = workflowLabVariantFixture({
      id: "variant-2",
      attempt: 2,
      hypothesis: "Add retry validation.",
      evaluations: [workflowLabEvaluationFixture({ caseId: "original-replay", score: 100 })],
    });
    const run = workflowLabRunFixture({
      createdAt,
      updatedAt: createdAt,
      bestVariantId: acceptedVariant.id,
      variants: [acceptedVariant, candidateVariant],
      audit: ["Created."],
    });

    const replacement = workflowLabEvaluationFixture({
      caseId: "original-replay",
      score: 92,
      rationale: "Replacement evaluation should win over the older case result.",
    });
    const evaluated = workflowLabRecordEvaluation({
      run,
      variantId: candidateVariant.id,
      evaluation: replacement,
      status: "accepted",
      evaluatedAt,
    });

    expect(evaluated).toMatchObject({
      updatedAt: evaluatedAt,
      bestVariantId: candidateVariant.id,
      audit: ["Created.", "Evaluated variant 2: 92/100 (accepted)."],
    });
    expect(evaluated.variants[1]).toMatchObject({
      id: candidateVariant.id,
      status: "accepted",
      score: 92,
      rationale: replacement.judge.rationale,
      updatedAt: evaluatedAt,
      evaluatedAt,
      evaluations: [replacement],
    });
    expect(run).toMatchObject({
      bestVariantId: acceptedVariant.id,
      updatedAt: createdAt,
      variants: [acceptedVariant, candidateVariant],
      audit: ["Created."],
    });

    const failed = workflowLabRecordEvaluation({
      run: evaluated,
      variantId: candidateVariant.id,
      evaluation: workflowLabEvaluationFixture({
        caseId: "held-out-variation",
        score: 100,
        gateStatus: "failed",
        rationale: "A failed deterministic gate should force the score to zero.",
      }),
      status: "rejected",
      evaluatedAt: "2026-05-20T20:05:00.000Z",
    });

    expect(failed.variants[1]).toMatchObject({
      status: "rejected",
      score: 0,
      evaluations: [
        replacement,
        expect.objectContaining({
          caseId: "held-out-variation",
          gates: [expect.objectContaining({ status: "failed" })],
        }),
      ],
    });
    expect(failed.bestVariantId).toBe(acceptedVariant.id);
    expect(() =>
      workflowLabRecordEvaluation({
        run,
        variantId: "missing-variant",
        evaluation: replacement,
        status: "accepted",
        evaluatedAt,
      }),
    ).toThrow("Workflow Lab variant not found: missing-variant");
  });

  it("applies Workflow Lab variant adoption without persistence", () => {
    const createdAt = "2026-05-20T20:00:00.000Z";
    const adoptedAt = "2026-05-20T20:06:00.000Z";
    const acceptedVariant = workflowLabVariantFixture({
      id: "variant-1",
      attempt: 1,
      status: "accepted",
      score: 92,
      updatedAt: "2026-05-20T20:04:00.000Z",
    });
    const rejectedVariant = workflowLabVariantFixture({
      id: "variant-2",
      attempt: 2,
      status: "rejected",
      updatedAt: "2026-05-20T20:05:00.000Z",
    });
    const run = workflowLabRunFixture({
      createdAt,
      updatedAt: createdAt,
      variants: [acceptedVariant, rejectedVariant],
      audit: ["Created."],
    });

    expect(workflowLabRequireAcceptedVariant(run, acceptedVariant.id)).toBe(acceptedVariant);
    expect(() => workflowLabRequireAcceptedVariant(run, rejectedVariant.id)).toThrow(
      `Workflow Lab variant is not accepted: ${rejectedVariant.id}`,
    );
    expect(() => workflowLabRequireAcceptedVariant(run, "missing-variant")).toThrow(
      "Workflow Lab variant not found: missing-variant",
    );
    expect(() => workflowLabRequireBaseVersion(run, run.baseVersion)).not.toThrow();
    expect(() => workflowLabRequireBaseVersion(run, run.baseVersion + 1)).toThrow(
      "Workflow recording version changed: expected v1, current v2. Start a new Workflow Lab run.",
    );

    const adopted = workflowLabApplyVariantAdoption({
      run,
      variant: acceptedVariant,
      adoptedVersion: 3,
      adoptedAt,
    });

    expect(adopted).toMatchObject({
      status: "completed",
      bestVariantId: acceptedVariant.id,
      completedAt: adoptedAt,
      updatedAt: adoptedAt,
      audit: ["Created.", "Adopted variant 1 as workflow version 3."],
    });
    expect(adopted.variants).toEqual([
      { ...acceptedVariant, status: "accepted", updatedAt: adoptedAt },
      rejectedVariant,
    ]);
    expect(run).toMatchObject({
      status: "draft",
      updatedAt: createdAt,
      variants: [acceptedVariant, rejectedVariant],
      audit: ["Created."],
    });
  });

  it("runs bounded candidates, records gates and judge scores, then adopts the accepted best variant", async () => {
    const playbook = seedWorkflowPlaybook(store, workspacePath);
    const run = store.createWorkflowLabRun({
      workflowId: playbook.id,
      goal: "Improve recovery when venue pages or search results differ from the original recording.",
      attemptBudget: 3,
      plateauThreshold: 0.03,
      heldOutEnabled: true,
    });

    const completed = await runWorkflowLab(store, run.id, {
      judge: ({ variant, gates }) => ({
        provider: "deterministic",
        score: gates.some((gate) => gate.status === "failed") ? 0 : 70 + variant.attempt,
        clarity: 80,
        robustness: 78,
        generalization: 76,
        intentPreservation: 82,
        rationale: `Variant ${variant.attempt} preserves intent and improves recovery guidance.`,
      }),
    });

    expect(completed).toMatchObject({
      status: "completed",
      workflowId: playbook.id,
      baseVersion: 1,
    });
    expect(completed.variants.length).toBeGreaterThanOrEqual(2);
    expect(completed.bestVariantId).toBeTruthy();
    expect(completed.evaluationCases.map((evaluationCase) => evaluationCase.id)).toEqual(["original-replay", "held-out-variation"]);
    expect(completed.variants.every((variant) => variant.evaluations.length === 2)).toBe(true);
    expect(completed.variants.flatMap((variant) => variant.evaluations).every((evaluation) => evaluation.gates.every((gate) => gate.status === "passed"))).toBe(true);

    const adopted = store.adoptWorkflowLabVariant(completed.id, completed.bestVariantId!);
    expect(adopted).toMatchObject({
      id: playbook.id,
      version: 2,
    });
    expect(adopted.playbook?.intent).toContain("Improve recovery");
  });

  it("rejects unsafe candidate content before a judge score can win", async () => {
    const workflow = seedWorkflowDescription(store, workspacePath);
    const run = store.createWorkflowLabRun({
      workflowId: workflow.id,
      goal: "Improve validation without leaking local files.",
      attemptBudget: 1,
    });
    const [candidate] = workflowLabCandidatePatches(workflow, run);
    const variant = store.appendWorkflowLabVariant(run.id, {
      hypothesis: "Unsafe local-path leakage should fail the deterministic safety gate.",
      patch: {
        ...candidate.patch,
        draft: {
          ...candidate.patch.draft,
          validation: [...candidate.patch.draft.validation, "Read /Users/example/Documents/ambientCoder/ignored-provider-key-file.txt before judging success."],
        },
      },
    });

    const evaluation = await evaluateWorkflowLabVariant({
      run,
      workflow,
      variant,
      casePrompt: run.evaluationCases[0].prompt,
      judge: ({ gates }) => ({
        provider: "deterministic",
        score: gates.some((gate) => gate.status === "failed") ? 0 : 100,
        clarity: 100,
        robustness: 100,
        generalization: 100,
        intentPreservation: 100,
        rationale: "Unsafe candidates must not pass deterministic gates.",
      }),
    });

    expect(evaluation.gates).toContainEqual(expect.objectContaining({
      id: "secret-and-path-safety",
      status: "failed",
    }));
    const evaluatedRun = store.recordWorkflowLabEvaluation(run.id, variant.id, evaluation, "rejected");
    expect(evaluatedRun.bestVariantId).toBeUndefined();
    expect(evaluatedRun.variants[0]).toMatchObject({
      status: "rejected",
      score: 0,
    });
  });

  it("normalizes fenced JSON from provider-backed Workflow Lab judge responses", async () => {
    const workflow = seedWorkflowDescription(store, workspacePath);
    const run = store.createWorkflowLabRun({
      workflowId: workflow.id,
      goal: "Improve clarity while preserving the original intent.",
      attemptBudget: 1,
    });
    const [candidate] = workflowLabCandidatePatches(workflow, run);
    const variant = store.appendWorkflowLabVariant(run.id, {
      hypothesis: candidate.hypothesis,
      patch: candidate.patch,
    });
    const provider = new AmbientWorkflowLabJudgeProvider({
      apiKey: "test",
      textCall: async () => [
        "```json",
        JSON.stringify({
          score: 87,
          clarity: 90,
          robustness: 84,
          generalization: 86,
          intentPreservation: 88,
          rationale: "The candidate is clear, reusable, and preserves the workflow intent.",
        }),
        "```",
      ].join("\n"),
    });

    const evaluation = await evaluateWorkflowLabVariant({
      run,
      workflow,
      variant,
      casePrompt: run.evaluationCases[0].prompt,
      judge: (input) => provider.judge(input),
    });

    expect(evaluation.judge).toMatchObject({
      provider: "ambient",
      score: 87,
      clarity: 90,
    });
  });

  it("blocks adoption when the canonical workflow version changed after the lab run started", async () => {
    const playbook = seedWorkflowPlaybook(store, workspacePath);
    const run = store.createWorkflowLabRun({
      workflowId: playbook.id,
      goal: "Improve clarity.",
      attemptBudget: 1,
    });
    const completed = await runWorkflowLab(store, run.id);
    expect(completed.bestVariantId).toBeTruthy();

    store.updateWorkflowRecordingPlaybook(playbook.id, {
      baseVersion: playbook.version,
      draft: {
        intent: "Find current Scottsdale theatre date-night options with source-backed caveats.",
        inputs: ["Location", "Date window"],
        successfulExamples: [
          {
            toolName: "browser_search",
            inputPreview: "Scottsdale theatre date night",
            resultPreview: "Current venue pages and ticket links.",
          },
        ],
        doNot: [{ toolName: "browser_open", status: "failed", reason: "Avoid blocked or stale venue pages." }],
        validation: ["Final answer links to current source pages."],
        outputShape: ["Shortlist with source notes."],
      },
    });

    expect(() => store.adoptWorkflowLabVariant(completed.id, completed.bestVariantId!)).toThrow(/version changed/);
  });
});

function seedWorkflowPlaybook(store: ProjectStore, workspacePath: string) {
  const thread = store.createWorkflowRecordingThread({
    goal: "Find Scottsdale theatre options for a date night.",
    workspacePath,
  });
  store.addMessage({ threadId: thread.id, role: "user", content: "Find Scottsdale theatre events for date night." });
  store.addMessage({
    threadId: thread.id,
    role: "tool",
    content: "browser_search completed\nFound venue pages and ticket links.",
    metadata: { toolName: "browser_search", toolCallId: "search-1", status: "done" },
  });
  store.addMessage({
    threadId: thread.id,
    role: "assistant",
    content: "Rank current theatre options by date, source link, and date-night fit.",
    metadata: { status: "done" },
  });
  store.stopWorkflowRecording(thread.id);
  store.updateWorkflowRecordingReviewDraft(thread.id, {
    intent: "Find Scottsdale theatre options for a date night.",
    inputs: ["Location", "Date window", "Date-night fit criteria"],
    successfulExamples: [
      {
        toolName: "browser_search",
        inputPreview: "Scottsdale theatre date night",
        resultPreview: "Venue pages and ticket links.",
      },
    ],
    doNot: [{ toolName: "browser_open", status: "failed", reason: "Avoid stale or blocked venue pages." }],
    validation: ["Final answer ranks current source-backed theatre options."],
    outputShape: ["Ranked theatre shortlist with dates, booking links, and fit rationale."],
  });
  return store.confirmWorkflowRecordingReview(thread.id).review!.savedPlaybook!;
}

function seedWorkflowDescription(store: ProjectStore, workspacePath: string) {
  const playbook = seedWorkflowPlaybook(store, workspacePath);
  return store.describeWorkflowRecording(playbook.id);
}

function workflowLabRunFixture(overrides: Partial<WorkflowLabRun> = {}): WorkflowLabRun {
  const createdAt = "2026-05-20T20:00:00.000Z";
  return {
    id: "run-status",
    workflowId: "workflow-1",
    workflowTitle: "Date night workflow",
    baseVersion: 1,
    goal: "Improve recovery.",
    metricEmphasis: "balanced",
    attemptBudget: 3,
    plateauThreshold: 0.03,
    heldOutEnabled: true,
    status: "draft",
    createdAt,
    updatedAt: createdAt,
    artifactPath: "/tmp/run-status.json",
    evaluationCases: [],
    variants: [],
    audit: [],
    ...overrides,
  };
}

function workflowLabVariantFixture(overrides: Partial<WorkflowLabVariant> = {}): WorkflowLabVariant {
  const createdAt = "2026-05-20T20:00:00.000Z";
  return {
    id: "variant-1",
    runId: "run-status",
    attempt: 1,
    hypothesis: "Improve recovery guidance.",
    patch: workflowLabCandidatePatchFixture("Add recovery guidance."),
    status: "proposed",
    createdAt,
    updatedAt: createdAt,
    evaluations: [],
    ...overrides,
  };
}

function workflowLabEvaluationFixture(
  overrides: {
    caseId?: string;
    score?: number;
    gateStatus?: "passed" | "failed";
    rationale?: string;
  } = {},
): WorkflowLabEvaluationResult {
  const score = overrides.score ?? 80;
  return {
    caseId: overrides.caseId ?? "original-replay",
    metrics: {
      completed: true,
      toolCallCount: 2,
      retryCount: 0,
      elapsedMs: 1200,
      validationIssueCount: 0,
      explicitValidationCount: 1,
      recoveryCueCount: 1,
    },
    gates: [
      {
        id: "intent-preservation",
        label: "Intent preservation",
        status: overrides.gateStatus ?? "passed",
        detail: "Candidate preserves the workflow intent.",
      },
    ],
    judge: {
      provider: "deterministic",
      score,
      clarity: score,
      robustness: score,
      generalization: score,
      intentPreservation: score,
      rationale: overrides.rationale ?? "Candidate preserves intent and improves recovery.",
    },
    traceArtifactRefs: [],
    createdAt: "2026-05-20T20:00:30.000Z",
  };
}

function workflowLabCandidatePatchFixture(summary: string): WorkflowLabCandidatePatch {
  return {
    summary,
    changedFields: ["validation"],
    draft: {
      intent: "Find date-night options.",
      inputs: ["Location", "Date window"],
      successfulExamples: [],
      doNot: [],
      validation: ["Final answer links to source pages."],
      outputShape: ["Shortlist with source notes."],
    },
  };
}
