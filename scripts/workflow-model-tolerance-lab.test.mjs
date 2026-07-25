import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyWorkflowModelToleranceAttempt,
  defaultWorkflowModelToleranceSuites,
  generateWorkflowModelToleranceCases,
  renderWorkflowModelToleranceMarkdown,
  runWorkflowModelToleranceLab,
  validateWorkflowPlanDslPayload,
  workflowModelToleranceExitCode,
  writeWorkflowModelToleranceReport,
} from "./workflow-model-tolerance-lab.mjs";

describe("workflow model tolerance lab", () => {
  it("generates deterministic seeded cases across the Phase 0A suites", () => {
    expect(defaultWorkflowModelToleranceSuites().map((suite) => suite.id)).toEqual([
      "plan-dsl-basic",
      "constraint-following",
      "scale-policy",
      "unsupported-stage",
      "repair-selection",
    ]);

    const first = generateWorkflowModelToleranceCases({ suites: "plan-dsl-basic,scale-policy", seeds: 3 });
    const second = generateWorkflowModelToleranceCases({ suites: "plan-dsl-basic,scale-policy", seeds: 3 });
    expect(first.map((testCase) => testCase.id)).toEqual([
      "plan-dsl-basic-001",
      "plan-dsl-basic-002",
      "plan-dsl-basic-003",
      "scale-policy-001",
      "scale-policy-002",
      "scale-policy-003",
    ]);
    expect(first).toEqual(second);
    expect(first[0].prompt).toContain("Do not emit WorkflowProgramIR");
    expect(first[0].prompt).toContain("model.call is the Ambient reasoning/synthesis step");
    expect(first[0].prompt).toContain("Do not use file.write because no local save path or workspace mutation was requested.");
    const [repairCase] = generateWorkflowModelToleranceCases({ suites: "repair-selection", seeds: 1 });
    expect(repairCase.prompt).toContain("Rejected low-level locator for diagnosis only:");
    expect(repairCase.prompt).toContain("Do not copy the rejected locator");
    expect(repairCase.prompt).toContain('goal must be exactly "Select a declared repair alternative for a rejected compiler locator."');
    const [unsupportedCase] = generateWorkflowModelToleranceCases({ suites: "unsupported-stage", seeds: 1 });
    expect(unsupportedCase.prompt).toContain("Represent the unavailable work with the allowed unsupported kernel");
    expect(unsupportedCase.prompt).toContain('strategy must be "unsupported"');
  });

  it("validates Plan DSL shape and rejects raw IR leakage", () => {
    const [testCase] = generateWorkflowModelToleranceCases({ suites: "plan-dsl-basic", seeds: 1 });
    const validPayload = {
      schemaVersion: 1,
      kind: "workflow_plan_dsl",
      goal: "tiny app",
      strategy: "bounded_plan",
      stages: [
        {
          id: "discover",
          label: "Discover",
          kernel: "model.call",
          intent: "Collect requirements.",
          inputs: ["request"],
          outputs: ["requirements"],
          evidence: ["summary"],
          constraints: [],
        },
        {
          id: "review",
          label: "Review",
          kernel: "review.input",
          intent: "Ask one bounded question.",
          inputs: ["requirements"],
          outputs: ["decision"],
          evidence: ["answer"],
          constraints: [],
        },
        {
          id: "final",
          label: "Final",
          kernel: "output.final",
          intent: "Return artifact.",
          inputs: ["decision"],
          outputs: ["artifact"],
          evidence: ["proof"],
          constraints: [],
        },
      ],
      questions: [],
      unsupportedStages: [],
      budgetPolicy: { mode: "detail", maxItemsPerBatch: 20, summary: "small request" },
      repairDecision: { operation: "none", selectedAlternativeId: null, reason: "no repair" },
    };
    expect(validateWorkflowPlanDslPayload(validPayload, testCase)).toMatchObject({ passed: true });

    const fileWriteOnly = JSON.stringify({
      ...validPayload,
      stages: [
        {
          id: "discover",
          label: "Discover",
          kernel: "review.input",
          intent: "Ask for requirements.",
          inputs: ["request"],
          outputs: ["requirements"],
          evidence: ["answer"],
          constraints: [],
        },
        {
          id: "write-html",
          label: "Write HTML artifact",
          kernel: "file.write",
          intent: "Generate and save the HTML artifact.",
          inputs: ["requirements"],
          outputs: ["html"],
          evidence: ["file path"],
          constraints: [],
        },
        {
          id: "final",
          label: "Final",
          kernel: "output.final",
          intent: "Return artifact.",
          inputs: ["html"],
          outputs: ["artifact"],
          evidence: ["proof"],
          constraints: [],
        },
      ],
    });
    const fileWriteResult = validateWorkflowPlanDslPayload(fileWriteOnly, testCase);
    expect(fileWriteResult.passed).toBe(false);
    expect(fileWriteResult.violations).toEqual(expect.arrayContaining(["expected at least one model.call stage", "forbidden kernel selected: file.write"]));

    const invalid = JSON.stringify({
      ...validPayload,
      fromNode: "n1",
      stages: [{ ...validPayload.stages[0], intent: "Use /nodes/7/1/sourceCandidateCount/fromNode" }],
    });
    const result = validateWorkflowPlanDslPayload(invalid, testCase);
    expect(result.passed).toBe(false);
    expect(result.violations.join("\n")).toMatch(/forbidden raw IR/);
  });

  it("checks behavior-specific constraints for scale, unsupported capability, and repair", () => {
    const [largeScale] = generateWorkflowModelToleranceCases({ suites: "scale-policy", seeds: 2 }).filter((testCase) => testCase.expected.large);
    expect(largeScale).toBeTruthy();
    const badScalePayload = basePayload({
      budgetPolicy: { mode: "detail", maxItemsPerBatch: 500, summary: "scan everything" },
    });
    const scaleResult = validateWorkflowPlanDslPayload(badScalePayload, largeScale);
    expect(scaleResult.passed).toBe(false);
    expect(scaleResult.violations.join("\n")).toMatch(/large item count/);

    const [unsupportedCase] = generateWorkflowModelToleranceCases({ suites: "unsupported-stage", seeds: 1 });
    const badUnsupported = basePayload({ strategy: "bounded_plan", unsupportedStages: [], questions: [] });
    expect(validateWorkflowPlanDslPayload(badUnsupported, unsupportedCase).violations.join("\n")).toMatch(/unsupported capability/);

    const [repairCase] = generateWorkflowModelToleranceCases({ suites: "repair-selection", seeds: 1 });
    const badRepair = basePayload({ repairDecision: { operation: "select_alternative", selectedAlternativeId: "made-up-alt", reason: "guess" } });
    expect(validateWorkflowPlanDslPayload(badRepair, repairCase).violations.join("\n")).toMatch(/undeclared alternative/);
  });

  it("runs the mocked lab and renders an operator-facing report", async () => {
    const summary = await runWorkflowModelToleranceLab({
      generatedAt: "2026-05-18T00:00:00.000Z",
      suites: "plan-dsl-basic,constraint-following,scale-policy,unsupported-stage,repair-selection",
      seeds: 2,
    });

    expect(summary).toMatchObject({
      mode: "mock",
      caseCount: 10,
      passedCount: 10,
      productOrTestFailureCount: 0,
      thresholdPassed: true,
      promotionReady: true,
    });
    expect(summary.suiteStats).toHaveLength(5);
    expect(workflowModelToleranceExitCode(summary)).toBe(0);

    const markdown = renderWorkflowModelToleranceMarkdown(summary);
    expect(markdown).toContain("Workflow Model Tolerance Lab");
    expect(markdown).toContain("Threshold passed: yes");
    expect(markdown).toContain("Promotion ready: yes");
    expect(markdown).toContain("plan-dsl-basic-001");
  });

  it("runs cases concurrently and applies the promotion gate", async () => {
    const cases = generateWorkflowModelToleranceCases({ suites: "plan-dsl-basic", seeds: 4 });
    let active = 0;
    let maxActive = 0;
    const summary = await runWorkflowModelToleranceLab({
      generatedAt: "2026-05-18T02:00:00.000Z",
      cases,
      concurrency: 2,
      promotionGate: true,
      minPromotionCases: 4,
      modelCall: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return JSON.stringify(passingBasicPayload());
      },
    });

    expect(maxActive).toBe(2);
    expect(summary).toMatchObject({
      concurrency: 2,
      caseCount: 4,
      passedCount: 4,
      promotionGate: true,
      minPromotionCases: 4,
      promotionReady: true,
    });
    expect(summary.cases.map((testCase) => testCase.id)).toEqual(cases.map((testCase) => testCase.id));
    expect(summary.suiteStats[0]).toMatchObject({ suiteId: "plan-dsl-basic", caseCount: 4, passedCount: 4 });
    expect(workflowModelToleranceExitCode(summary, { promotionGate: true })).toBe(0);
  });

  it("stops assigning work after the configured failure limit", async () => {
    const summary = await runWorkflowModelToleranceLab({
      generatedAt: "2026-05-18T03:00:00.000Z",
      suites: "plan-dsl-basic",
      seeds: 3,
      concurrency: 1,
      stopAfterFailures: 1,
      modelCall: async () => JSON.stringify({}),
    });

    expect(summary.productOrTestFailureCount).toBe(1);
    expect(summary.notRunCount).toBe(2);
    expect(summary.cases.map((testCase) => testCase.status)).toEqual(["product_or_test_failure", "not_run", "not_run"]);
    expect(workflowModelToleranceExitCode(summary)).toBe(1);
  });

  it("does not promote a small smoke sample when a promotion minimum is required", async () => {
    const summary = await runWorkflowModelToleranceLab({
      generatedAt: "2026-05-18T04:00:00.000Z",
      suites: "plan-dsl-basic",
      seeds: 1,
      promotionGate: true,
      minPromotionCases: 2,
      modelCall: async () => JSON.stringify(passingBasicPayload()),
    });

    expect(summary).toMatchObject({
      passedCount: 1,
      thresholdPassed: true,
      promotionReady: false,
      minPromotionCases: 2,
    });
    expect(workflowModelToleranceExitCode(summary)).toBe(0);
    expect(workflowModelToleranceExitCode(summary, { promotionGate: true })).toBe(1);
  });

  it("classifies provider, environment, and product failures", () => {
    expect(classifyWorkflowModelToleranceAttempt({ validation: { passed: true } })).toMatchObject({
      status: "passed",
      providerHealth: "healthy",
    });
    expect(classifyWorkflowModelToleranceAttempt({ errorMessage: "HTTP 429 upstream rate limit" })).toMatchObject({
      status: "provider_degraded",
      matchedPattern: "rate_limit",
      retryable: true,
    });
    expect(classifyWorkflowModelToleranceAttempt({ errorMessage: "Set GMI_CLOUD_API_KEY, GMI_API_KEY, GMI_CLOUD_API_KEY_FILE, or provide ignored-provider-key-file.txt" })).toMatchObject({
      status: "skipped",
      matchedPattern: "missing_provider_key",
    });
    expect(classifyWorkflowModelToleranceAttempt({ validation: { passed: false, violations: ["expected at least 3 stages"] } })).toMatchObject({
      status: "product_or_test_failure",
      retryable: false,
    });
  });

  it("writes latest and immutable run artifacts without requiring live credentials", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "workflow-model-tolerance-"));
    const summary = await runWorkflowModelToleranceLab({
      generatedAt: "2026-05-18T01:02:03.004Z",
      suites: "plan-dsl-basic",
      seeds: 1,
    });
    const paths = await writeWorkflowModelToleranceReport(summary, outputDir);
    const latest = JSON.parse(await readFile(paths.latestJsonPath, "utf8"));
    const markdown = await readFile(paths.latestMarkdownPath, "utf8");

    expect(latest.runId).toBe("workflow-model-tolerance-2026-05-18T01-02-03-004Z");
    expect(markdown).toContain("Minimized repro");
    expect(paths.runJsonPath).toContain(latest.runId);
  });

  it("uses live requirements to decide exit code for inconclusive provider rows", () => {
    const summary = {
      mode: "live",
      caseCount: 1,
      passedCount: 0,
      providerDegradedCount: 1,
      skippedCount: 0,
      productOrTestFailureCount: 0,
      thresholdPassed: false,
      cases: [],
    };
    expect(workflowModelToleranceExitCode(summary)).toBe(0);
    expect(workflowModelToleranceExitCode(summary, { requireLive: true })).toBe(1);
    expect(workflowModelToleranceExitCode({ ...summary, providerDegradedCount: 0, productOrTestFailureCount: 1 })).toBe(1);
  });
});

function basePayload(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "workflow_plan_dsl",
    goal: "fixture",
    strategy: "bounded_plan",
    stages: [
      {
        id: "discover",
        label: "Discover",
        kernel: "model.call",
        intent: "Collect requirements.",
        inputs: ["request"],
        outputs: ["requirements"],
        evidence: ["summary"],
        constraints: [],
      },
      {
        id: "final",
        label: "Final",
        kernel: "output.final",
        intent: "Return output.",
        inputs: ["requirements"],
        outputs: ["final"],
        evidence: ["proof"],
        constraints: [],
      },
    ],
    questions: [],
    unsupportedStages: [],
    budgetPolicy: { mode: "metadata_first", maxItemsPerBatch: 50, summary: "bounded" },
    repairDecision: { operation: "none", selectedAlternativeId: null, reason: "no repair" },
    ...overrides,
  };
}

function passingBasicPayload() {
  return basePayload({
    stages: [
      {
        id: "discover",
        label: "Discover",
        kernel: "model.call",
        intent: "Collect requirements.",
        inputs: ["request"],
        outputs: ["requirements"],
        evidence: ["summary"],
        constraints: [],
      },
      {
        id: "review",
        label: "Review",
        kernel: "review.input",
        intent: "Ask one bounded question.",
        inputs: ["requirements"],
        outputs: ["decision"],
        evidence: ["answer"],
        constraints: [],
      },
      {
        id: "final",
        label: "Final",
        kernel: "output.final",
        intent: "Return output.",
        inputs: ["decision"],
        outputs: ["final"],
        evidence: ["proof"],
        constraints: [],
      },
    ],
  });
}
