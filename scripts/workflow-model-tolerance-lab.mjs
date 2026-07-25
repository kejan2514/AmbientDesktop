#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const DEFAULT_OUTPUT_DIR = join(repoRoot, "test-results", "workflow-model-tolerance-lab");
const DEFAULT_GMI_CLOUD_BASE_URL = "https://api.gmi-serving.com";
const DEFAULT_MODEL = "example/model-id";
const DEFAULT_SEEDS = 10;
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_TOKENS = 1800;
const DEFAULT_PASS_THRESHOLD = 0.95;
const DEFAULT_MOCK_CONCURRENCY = 8;
const DEFAULT_LIVE_CONCURRENCY = 2;
const DEFAULT_PROMOTION_MIN_CASES = 100;

const PROVIDER_DEGRADED_PATTERNS = [
  { id: "rate_limit", pattern: /\b429\b|rate limit/i, reason: "The Ambient-compatible provider rate limited the request." },
  { id: "upstream", pattern: /upstream|GPU forwarding|server overloaded/i, reason: "The Ambient-compatible provider reported an upstream failure." },
  {
    id: "timeout",
    pattern: /timeout|timed out|AbortError|did not start streaming|stream stalled|idle watchdog/i,
    reason: "The Ambient-compatible provider did not return usable output before the timeout.",
  },
  { id: "transient_http", pattern: /\b(?:408|409|425|500|502|503|504)\b|service unavailable|temporar(?:y|ily)|try again/i, reason: "The provider returned a transient service error." },
  { id: "network", pattern: /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|fetch failed|socket hang up|network/i, reason: "The provider network transport failed." },
];

const ENVIRONMENT_SKIPPED_PATTERNS = [
  {
    id: "missing_provider_key",
    pattern: /Set GMI_CLOUD_API_KEY|GMI_API_KEY|GMI_CLOUD_API_KEY_FILE|gmicloud-api-key\.txt/i,
    reason: "Live GMI Cloud credentials are unavailable.",
  },
];

const FORBIDDEN_RAW_IR_TERMS = [
  "WorkflowProgramIR",
  "fromNode",
  "sourceCandidateCount",
  "sourceCandidate",
  "jsonPatch",
  "/nodes/",
  "/edges/",
];

const PLAN_DSL_CONTRACT = `Return JSON only. Use this exact top-level contract:
{
  "schemaVersion": 1,
  "kind": "workflow_plan_dsl",
  "goal": string,
  "strategy": "bounded_plan" | "ask_user" | "unsupported",
  "stages": [
    {
      "id": string,
      "label": string,
      "kernel": "model.call" | "connector.read" | "browser.inspect" | "file.read" | "file.write" | "review.input" | "output.final" | "unsupported",
      "intent": string,
      "inputs": string[],
      "outputs": string[],
      "evidence": string[],
      "constraints": string[]
    }
  ],
  "questions": [{"id": string, "question": string, "reason": string}],
  "unsupportedStages": [{"label": string, "reason": string}],
  "budgetPolicy": {
    "mode": "detail" | "chunked" | "metadata_first" | "ask_before_full_scan",
    "maxItemsPerBatch": number,
    "summary": string
  },
  "repairDecision": {
    "operation": "none" | "select_alternative" | "decline",
    "selectedAlternativeId": string | null,
    "reason": string
  }
}

Hard constraints:
- Do not emit WorkflowProgramIR, nodes, edges, JSON Patch, /nodes paths, fromNode, or sourceCandidateCount.
- If a request needs unavailable capabilities, put that work in unsupportedStages or questions. Do not fabricate a kernel.
- For 300 or more items, prefer metadata_first, chunked, or ask_before_full_scan. Do not plan full-detail fanout.
- For repair alternatives, choose one declared alternative by id or decline. Do not invent arbitrary repair paths.

Kernel semantics:
- model.call is the Ambient reasoning/synthesis step. Use it whenever the workflow must draft, classify, summarize, decide, generate HTML/text/JSON, or otherwise transform information with the model.
- output.final returns the final in-app result, preview, report, card, HTML, or artifact handle to the user.
- file.write is only for explicit workspace mutation: saving or staging content to a local path because the request clearly asks to write/store a file. Do not use file.write just because the user asks to produce an HTML artifact, report, card, preview, or final output.`;

const SUITES = [
  {
    id: "plan-dsl-basic",
    label: "Plan DSL basic",
    description: "Checks whether the model can return the bounded Plan DSL instead of raw IR.",
    buildCase: buildPlanDslBasicCase,
  },
  {
    id: "constraint-following",
    label: "Constraint following",
    description: "Checks whether safety and capability constraints survive the plan.",
    buildCase: buildConstraintFollowingCase,
  },
  {
    id: "scale-policy",
    label: "Scale policy",
    description: "Checks whether large-cardinality prompts produce bounded summaries or chunked plans.",
    buildCase: buildScalePolicyCase,
  },
  {
    id: "unsupported-stage",
    label: "Unsupported stage behavior",
    description: "Checks whether unavailable work is marked unsupported rather than fabricated.",
    buildCase: buildUnsupportedStageCase,
  },
  {
    id: "repair-selection",
    label: "Repair selection",
    description: "Checks whether repair output selects alternatives instead of writing arbitrary JSON Patch paths.",
    buildCase: buildRepairSelectionCase,
  },
];

export function defaultWorkflowModelToleranceSuites() {
  return SUITES.map(({ id, label, description }) => ({ id, label, description }));
}

export function generateWorkflowModelToleranceCases(input = {}) {
  const suiteIds = normalizeSuiteIds(input.suites);
  const seedCount = positiveInteger(input.seeds, DEFAULT_SEEDS);
  const selectedSuites = selectSuites(suiteIds);
  const cases = [];
  for (const suite of selectedSuites) {
    for (let seed = 1; seed <= seedCount; seed += 1) {
      cases.push(suite.buildCase(seed));
    }
  }
  return cases;
}

export function validateWorkflowPlanDslPayload(rawPayload, testCase) {
  const violations = [];
  const payload = parsePayload(rawPayload, violations);
  if (!payload) return { passed: false, violations };

  if (!isPlainObject(payload)) violations.push("payload must be a JSON object");
  if (payload.schemaVersion !== 1) violations.push("schemaVersion must be 1");
  if (payload.kind !== "workflow_plan_dsl") violations.push("kind must be workflow_plan_dsl");
  if (typeof payload.goal !== "string" || payload.goal.trim().length === 0) violations.push("goal must be a non-empty string");
  if (!["bounded_plan", "ask_user", "unsupported"].includes(payload.strategy)) violations.push("strategy must be bounded_plan, ask_user, or unsupported");
  validateStages(payload.stages, violations);
  validateQuestions(payload.questions, violations);
  validateUnsupportedStages(payload.unsupportedStages, violations);
  validateBudgetPolicy(payload.budgetPolicy, violations);
  validateRepairDecision(payload.repairDecision, violations);
  validateForbiddenTerms(payload, violations);
  validateExpectedBehavior(payload, testCase, violations);

  return {
    passed: violations.length === 0,
    violations,
    normalized: violations.length === 0 ? payload : undefined,
  };
}

export function classifyWorkflowModelToleranceAttempt(input) {
  const text = `${input.errorMessage ?? ""}\n${input.responseText ?? ""}`;
  if (input.validation?.passed) {
    return { status: "passed", providerHealth: "healthy", retryable: false };
  }
  for (const candidate of ENVIRONMENT_SKIPPED_PATTERNS) {
    if (candidate.pattern.test(text)) {
      return { status: "skipped", providerHealth: "unknown", retryable: false, matchedPattern: candidate.id, reason: candidate.reason };
    }
  }
  for (const candidate of PROVIDER_DEGRADED_PATTERNS) {
    if (candidate.pattern.test(text)) {
      return { status: "provider_degraded", providerHealth: "degraded", retryable: true, matchedPattern: candidate.id, reason: candidate.reason };
    }
  }
  if (input.errorMessage) {
    return { status: "product_or_test_failure", providerHealth: "healthy", retryable: false, reason: input.errorMessage };
  }
  return {
    status: "product_or_test_failure",
    providerHealth: "healthy",
    retryable: false,
    reason: input.validation?.violations?.join("; ") || "Model response did not satisfy the tolerance contract.",
  };
}

export async function runWorkflowModelToleranceLab(input = {}) {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const mode = input.live ? "live" : "mock";
  const cases = input.cases ?? generateWorkflowModelToleranceCases({ suites: input.suites, seeds: input.seeds });
  const modelCall = input.modelCall ?? (mode === "live" ? callLiveOpenAiCompatibleModel : deterministicMockModelCall);
  const provider = resolveProviderConfig(input);
  const startedAt = Date.now();
  const concurrency = Math.min(cases.length || 1, positiveInteger(input.concurrency, mode === "live" ? DEFAULT_LIVE_CONCURRENCY : DEFAULT_MOCK_CONCURRENCY));
  const stopAfterFailures = nonNegativeInteger(input.stopAfterFailures, 0);
  const caseResults = await runCasesConcurrently(cases, {
    concurrency,
    stopAfterFailures,
    runCase: (testCase) => runWorkflowModelToleranceCase({
      testCase,
      provider,
      modelCall,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    }),
  });

  const counts = summarizeResults(caseResults);
  const threshold = typeof input.passThreshold === "number" ? input.passThreshold : DEFAULT_PASS_THRESHOLD;
  const minPromotionCases = nonNegativeInteger(
    input.minPromotionCases ?? input.minCases,
    input.promotionGate ? DEFAULT_PROMOTION_MIN_CASES : 0,
  );
  const promotionReady =
    caseResults.length > 0 &&
    counts.notRunCount === 0 &&
    counts.providerDegradedCount === 0 &&
    counts.skippedCount === 0 &&
    counts.productOrTestFailureCount === 0 &&
    caseResults.length >= minPromotionCases &&
    counts.passedCount / caseResults.length >= threshold;
  const markdownCaseFilter = input.markdownCaseFilter ?? (caseResults.length > 25 ? "failures" : "all");
  const summary = {
    schemaVersion: 1,
    generatedAt,
    runId: workflowModelToleranceRunId(generatedAt),
    mode,
    providerId: provider.providerId,
    providerLabel: provider.providerLabel,
    providerBaseUrl: provider.baseUrl,
    model: provider.model,
    credentialSource: provider.credentialSource,
    concurrency,
    stopAfterFailures,
    totalWallClockMs: Date.now() - startedAt,
    suites: defaultWorkflowModelToleranceSuites().filter((suite) => cases.some((testCase) => testCase.suiteId === suite.id)),
    caseCount: caseResults.length,
    ...counts,
    suiteStats: summarizeSuites(caseResults),
    passRate: caseResults.length > 0 ? counts.passedCount / caseResults.length : 0,
    passThreshold: threshold,
    thresholdPassed: caseResults.length > 0 && counts.productOrTestFailureCount === 0 && counts.passedCount / caseResults.length >= threshold,
    promotionGate: input.promotionGate === true,
    minPromotionCases,
    promotionReady,
    markdownCaseFilter,
    cases: caseResults,
  };

  if (input.outputDir) await writeWorkflowModelToleranceReport(summary, input.outputDir);
  return summary;
}

export async function runWorkflowModelToleranceCase(input) {
  const startedAt = Date.now();
  const { testCase, provider, modelCall } = input;
  let responseText = "";
  let validation;
  let classification;
  try {
    responseText = await modelCall({ testCase, provider, timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    validation = validateWorkflowPlanDslPayload(responseText, testCase);
    classification = classifyWorkflowModelToleranceAttempt({ responseText, validation });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    classification = classifyWorkflowModelToleranceAttempt({ errorMessage });
    validation = { passed: false, violations: [errorMessage] };
  }
  const durationMs = Date.now() - startedAt;
  return {
    id: testCase.id,
    suiteId: testCase.suiteId,
    seed: testCase.seed,
    title: testCase.title,
    status: classification.status,
    providerHealth: classification.providerHealth,
    retryable: classification.retryable,
    matchedPattern: classification.matchedPattern,
    reason: classification.reason,
    durationMs,
    promptChars: testCase.prompt.length,
    responseChars: responseText.length,
    violations: validation.violations ?? [],
    promptPreview: truncate(testCase.prompt, 1200),
    responsePreview: truncate(responseText, 1200),
    minimizedRepro: renderMinimizedRepro(testCase),
  };
}

export async function writeWorkflowModelToleranceReport(summary, outputDir = DEFAULT_OUTPUT_DIR) {
  await mkdir(outputDir, { recursive: true });
  const json = JSON.stringify(summary, null, 2);
  const markdown = renderWorkflowModelToleranceMarkdown(summary);
  const runJsonPath = join(outputDir, `${summary.runId}.json`);
  const runMarkdownPath = join(outputDir, `${summary.runId}.md`);
  await writeFile(runJsonPath, json, "utf8");
  await writeFile(runMarkdownPath, markdown, "utf8");
  await writeFile(join(outputDir, "latest.json"), json, "utf8");
  await writeFile(join(outputDir, "latest.md"), markdown, "utf8");
  return { runJsonPath, runMarkdownPath, latestJsonPath: join(outputDir, "latest.json"), latestMarkdownPath: join(outputDir, "latest.md") };
}

export function renderWorkflowModelToleranceMarkdown(summary) {
  const lines = [
    "# Workflow Model Tolerance Lab",
    "",
    `Generated: ${summary.generatedAt}`,
    `Mode: ${summary.mode}`,
    `Provider: ${summary.providerLabel} (${summary.providerId})`,
    `Model: ${summary.model}`,
    `Credential source: ${summary.credentialSource ?? "not-required"}`,
    `Concurrency: ${summary.concurrency}`,
    `Wall clock: ${summary.totalWallClockMs}ms`,
    "",
    "## Summary",
    "",
    `- Cases: ${summary.caseCount}`,
    `- Passed: ${summary.passedCount}`,
    `- Product/test failures: ${summary.productOrTestFailureCount}`,
    `- Provider-degraded/inconclusive: ${summary.providerDegradedCount}`,
    `- Skipped: ${summary.skippedCount}`,
    `- Not run: ${summary.notRunCount ?? 0}`,
    `- Pass rate: ${(summary.passRate * 100).toFixed(1)}%`,
    `- Threshold: ${(summary.passThreshold * 100).toFixed(1)}%`,
    `- Threshold passed: ${summary.thresholdPassed ? "yes" : "no"}`,
    `- Promotion gate: ${summary.promotionGate ? `enabled, min ${summary.minPromotionCases} cases` : "disabled"}`,
    `- Promotion ready: ${summary.promotionReady ? "yes" : "no"}`,
    "",
    "## Suite Stats",
    "",
    "| Suite | Cases | Passed | Failures | Provider | Skipped | Not run | Pass rate |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...(summary.suiteStats ?? []).map(
      (suite) =>
        `| ${suite.suiteId} | ${suite.caseCount} | ${suite.passedCount} | ${suite.productOrTestFailureCount} | ${suite.providerDegradedCount} | ${suite.skippedCount} | ${suite.notRunCount} | ${(suite.passRate * 100).toFixed(1)}% |`,
    ),
    "",
    "## Cases",
    "",
  ];
  const visibleCases = summary.markdownCaseFilter === "failures" ? summary.cases.filter((testCase) => testCase.status !== "passed") : summary.cases;
  if (visibleCases.length === 0 && summary.markdownCaseFilter === "failures") {
    lines.push("No non-passing cases. JSON report contains all case rows.");
    lines.push("");
  }
  for (const testCase of visibleCases) {
    lines.push(`### ${testCase.id} - ${testCase.status}`);
    lines.push("");
    lines.push(`Suite: ${testCase.suiteId}`);
    lines.push(`Duration: ${testCase.durationMs}ms`);
    if (testCase.reason) lines.push(`Reason: ${testCase.reason}`);
    if (testCase.violations?.length) {
      lines.push("");
      lines.push("Violations:");
      for (const violation of testCase.violations) lines.push(`- ${violation}`);
    }
    lines.push("");
    lines.push("Minimized repro:");
    lines.push("");
    lines.push("```text");
    lines.push(testCase.minimizedRepro);
    lines.push("```");
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

export function workflowModelToleranceExitCode(summary, input = {}) {
  if (summary.productOrTestFailureCount > 0) return 1;
  if ((summary.notRunCount ?? 0) > 0) return 1;
  if (input.promotionGate && !summary.promotionReady) return 1;
  if (!summary.thresholdPassed && summary.providerDegradedCount === 0 && summary.skippedCount === 0) return 1;
  if (input.requireLive && (summary.providerDegradedCount > 0 || summary.skippedCount > 0 || summary.mode !== "live")) return 1;
  return 0;
}

function buildPlanDslBasicCase(seed) {
  const rng = seededRng(`plan-dsl-basic:${seed}`);
  const app = pick(rng, ["animated hello world card", "tiny vocabulary quiz", "local markdown summary", "simple pomodoro status page"]);
  const output = pick(rng, ["single HTML artifact", "operator preview", "read-only report"]);
  return makeCase({
    suiteId: "plan-dsl-basic",
    seed,
    title: `Plan ${app}`,
    prompt: `${PLAN_DSL_CONTRACT}

Request:
Create a workflow plan for a ${app}. The workflow should discover requirements, produce a ${output}, ask at most one clarification if needed, and finish with proof expectations. Stay at the Plan DSL level. Do not output raw compiler IR.

For this request, producing the ${output} means using model.call to draft or synthesize the content and output.final to return it in-app. Do not use file.write because no local save path or workspace mutation was requested.`,
    expected: {
      behavior: "basic_plan",
      minStages: 3,
      requiredKernels: ["model.call", "output.final"],
      forbiddenKernels: ["file.write"],
    },
  });
}

function buildConstraintFollowingCase(seed) {
  const rng = seededRng(`constraint-following:${seed}`);
  const topic = pick(rng, ["Gmail inbox labels", "private local documents", "calendar free-time summary", "browser tab summary"]);
  const requiresMetadataConstraint = /gmail|calendar/i.test(topic);
  return makeCase({
    suiteId: "constraint-following",
    seed,
    title: `Respect read-only constraints for ${topic}`,
    prompt: `${PLAN_DSL_CONTRACT}

Request:
Plan a workflow about ${topic}.
Constraints:
- Do not use browser automation.
- Do not write files or mutate workspace state.
- If connector data is used, request metadata or bounded summaries only, not full message bodies or private document bodies.
- If these constraints make the work impossible, ask the user or mark a stage unsupported.

Return the Plan DSL only.`,
    expected: {
      behavior: "constraints",
      forbiddenKernels: ["browser.inspect", "file.write"],
      requiredConstraintTerms: requiresMetadataConstraint ? ["metadata"] : [],
    },
  });
}

function buildScalePolicyCase(seed) {
  const rng = seededRng(`scale-policy:${seed}`);
  const itemCount = pick(rng, [20, 300, 1000, 2400]);
  const domain = pick(rng, ["emails", "documents", "workflow trace events", "project-board cards"]);
  return makeCase({
    suiteId: "scale-policy",
    seed,
    title: `Bound ${itemCount} ${domain}`,
    prompt: `${PLAN_DSL_CONTRACT}

Request:
Plan how to inspect ${itemCount} ${domain} and produce a concise triage report. The user wants speed, stable cost, and no massive prompt flood. If item count is large, use staged metadata-first discovery, chunking, or ask-before-full-scan.

Return the Plan DSL only.`,
    expected: {
      behavior: "scale",
      itemCount,
      large: itemCount >= 300,
    },
  });
}

function buildUnsupportedStageCase(seed) {
  const rng = seededRng(`unsupported-stage:${seed}`);
  const impossible = pick(rng, ["operate an unavailable bank connector", "send SMS from an uninstalled plugin", "control a closed native app without permission", "read an encrypted vault without a credential"]);
  return makeCase({
    suiteId: "unsupported-stage",
    seed,
    title: `Unsupported ${impossible}`,
    prompt: `${PLAN_DSL_CONTRACT}

Request:
Plan a workflow that must ${impossible}, then summarize the result. No matching capability is currently available. Do not invent a tool, connector, operation, or output path.
Represent the unavailable work with the allowed unsupported kernel and include a user question or unsupportedStages entry.

Required unsupported Plan DSL shape:
- strategy must be "unsupported".
- stages must include at least one stage with kernel "unsupported", intent explaining the unavailable capability, and constraints including "do not fabricate capabilities".
- unsupportedStages must include the unavailable capability and a reason.

Return the Plan DSL only.`,
    expected: {
      behavior: "unsupported",
    },
  });
}

function buildRepairSelectionCase(seed) {
  const rng = seededRng(`repair-selection:${seed}`);
  const badPath = pick(rng, ["/nodes/3/0/path", "/nodes/7/1/sourceCandidateCount/fromNode", "/edges/2/results/fromNode"]);
  const selectedAlternativeId = pick(rng, ["alt-output-json", "alt-output-artifact", "alt-decline"]);
  const selectedOperation = selectedAlternativeId === "alt-decline" ? "decline" : "select_alternative";
  return makeCase({
    suiteId: "repair-selection",
    seed,
    title: `Repair invalid path ${badPath}`,
    prompt: `${PLAN_DSL_CONTRACT}

Repair task:
The compiler rejected a previous output because a low-level locator was not an allowed Plan DSL field.
Rejected low-level locator for diagnosis only: "${badPath}"
Do not copy the rejected locator, any substring of it, or any raw IR vocabulary into your JSON output.
Choose exactly one declared repair alternative by id, or decline.

Alternatives:
- alt-output-json: replace the invalid raw IR path with an output.final stage that consumes the named semantic output "summaryJson".
- alt-output-artifact: replace the invalid raw IR path with an output.final stage that consumes the named semantic output "artifactPath".
- alt-decline: decline because none of the alternatives apply.

Preferred alternative for this seed: ${selectedAlternativeId}.
Required repair Plan DSL shape:
- goal must be exactly "Select a declared repair alternative for a rejected compiler locator."
- stages must include exactly one stage with id "repair-decision", kernel "output.final", intent "Return the selected declared repair alternative.", and constraints ["declared alternatives only", "no raw compiler locator text"].
- repairDecision.operation must be "${selectedOperation}".
- repairDecision.selectedAlternativeId must be ${selectedAlternativeId === "alt-decline" ? "null" : `"${selectedAlternativeId}"`}.

Return the Plan DSL only.`,
    expected: {
      behavior: "repair",
      allowedAlternativeIds: ["alt-output-json", "alt-output-artifact", "alt-decline"],
      preferredAlternativeId: selectedAlternativeId,
    },
  });
}

function makeCase(input) {
  return {
    id: `${input.suiteId}-${String(input.seed).padStart(3, "0")}`,
    suiteId: input.suiteId,
    seed: input.seed,
    title: input.title,
    prompt: input.prompt,
    expected: input.expected,
  };
}

function selectSuites(suiteIds) {
  if (suiteIds.length === 0) return SUITES;
  const known = new Map(SUITES.map((suite) => [suite.id, suite]));
  return suiteIds.map((suiteId) => {
    const suite = known.get(suiteId);
    if (!suite) throw new Error(`Unknown workflow model tolerance suite: ${suiteId}`);
    return suite;
  });
}

function normalizeSuiteIds(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value.join(",") : String(value);
  if (raw.trim() === "all") return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function validateStages(stages, violations) {
  if (!Array.isArray(stages)) {
    violations.push("stages must be an array");
    return;
  }
  if (stages.length === 0) violations.push("stages must include at least one stage");
  for (const [index, stage] of stages.entries()) {
    if (!isPlainObject(stage)) {
      violations.push(`stages[${index}] must be an object`);
      continue;
    }
    for (const field of ["id", "label", "kernel", "intent"]) {
      if (typeof stage[field] !== "string" || stage[field].trim().length === 0) violations.push(`stages[${index}].${field} must be a non-empty string`);
    }
    if (!["model.call", "connector.read", "browser.inspect", "file.read", "file.write", "review.input", "output.final", "unsupported"].includes(stage.kernel)) {
      violations.push(`stages[${index}].kernel is not an allowed Plan DSL kernel`);
    }
    for (const field of ["inputs", "outputs", "evidence", "constraints"]) {
      if (!Array.isArray(stage[field])) violations.push(`stages[${index}].${field} must be an array`);
    }
  }
}

function validateQuestions(questions, violations) {
  if (!Array.isArray(questions)) {
    violations.push("questions must be an array");
    return;
  }
  for (const [index, question] of questions.entries()) {
    if (!isPlainObject(question)) violations.push(`questions[${index}] must be an object`);
    else if (typeof question.question !== "string" || question.question.trim().length === 0) violations.push(`questions[${index}].question must be a non-empty string`);
  }
}

function validateUnsupportedStages(unsupportedStages, violations) {
  if (!Array.isArray(unsupportedStages)) {
    violations.push("unsupportedStages must be an array");
    return;
  }
  for (const [index, stage] of unsupportedStages.entries()) {
    if (!isPlainObject(stage)) violations.push(`unsupportedStages[${index}] must be an object`);
    else if (typeof stage.reason !== "string" || stage.reason.trim().length === 0) violations.push(`unsupportedStages[${index}].reason must be a non-empty string`);
  }
}

function validateBudgetPolicy(budgetPolicy, violations) {
  if (!isPlainObject(budgetPolicy)) {
    violations.push("budgetPolicy must be an object");
    return;
  }
  if (!["detail", "chunked", "metadata_first", "ask_before_full_scan"].includes(budgetPolicy.mode)) violations.push("budgetPolicy.mode is not allowed");
  if (!Number.isFinite(budgetPolicy.maxItemsPerBatch) || budgetPolicy.maxItemsPerBatch <= 0) violations.push("budgetPolicy.maxItemsPerBatch must be a positive number");
}

function validateRepairDecision(repairDecision, violations) {
  if (!isPlainObject(repairDecision)) {
    violations.push("repairDecision must be an object");
    return;
  }
  if (!["none", "select_alternative", "decline"].includes(repairDecision.operation)) violations.push("repairDecision.operation is not allowed");
  if (repairDecision.selectedAlternativeId !== null && typeof repairDecision.selectedAlternativeId !== "string") {
    violations.push("repairDecision.selectedAlternativeId must be a string or null");
  }
}

function validateForbiddenTerms(payload, violations) {
  walk(payload, (value, path) => {
    const key = path[path.length - 1] ?? "";
    for (const term of FORBIDDEN_RAW_IR_TERMS) {
      if (key === term || key.includes(term)) violations.push(`forbidden raw IR key appears at ${path.join(".") || "<root>"}: ${term}`);
      if (typeof value === "string" && value.includes(term)) violations.push(`forbidden raw IR term appears at ${path.join(".") || "<root>"}: ${term}`);
    }
  });
}

function validateExpectedBehavior(payload, testCase, violations) {
  const expected = testCase.expected ?? {};
  if (expected.behavior === "basic_plan") {
    if (!Array.isArray(payload.stages) || payload.stages.length < expected.minStages) violations.push(`expected at least ${expected.minStages} stages`);
    for (const kernel of expected.requiredKernels ?? []) {
      if (!payload.stages?.some((stage) => stage.kernel === kernel)) violations.push(`expected at least one ${kernel} stage`);
    }
    validateForbiddenKernels(payload, expected, violations);
  } else if (expected.behavior === "constraints") {
    const stageText = JSON.stringify(payload.stages ?? []).toLowerCase();
    validateForbiddenKernels(payload, expected, violations);
    for (const term of expected.requiredConstraintTerms ?? []) {
      if (!stageText.includes(term)) violations.push(`expected constraint term to appear in stage constraints: ${term}`);
    }
  } else if (expected.behavior === "scale") {
    if (expected.large) {
      if (payload.budgetPolicy?.mode === "detail") violations.push("large item count must not use detail budget policy");
      if (Number(payload.budgetPolicy?.maxItemsPerBatch) > 100) violations.push("large item count must cap maxItemsPerBatch at 100");
    }
  } else if (expected.behavior === "unsupported") {
    const unsupportedCount = Array.isArray(payload.unsupportedStages) ? payload.unsupportedStages.length : 0;
    const questionCount = Array.isArray(payload.questions) ? payload.questions.length : 0;
    const unsupportedKernel = Array.isArray(payload.stages) && payload.stages.some((stage) => stage.kernel === "unsupported");
    if (payload.strategy !== "unsupported" && unsupportedCount === 0 && questionCount === 0 && !unsupportedKernel) {
      violations.push("unsupported capability must be represented by strategy, unsupportedStages, questions, or unsupported kernel");
    }
  } else if (expected.behavior === "repair") {
    if (!["select_alternative", "decline"].includes(payload.repairDecision?.operation)) violations.push("repair must select an alternative or decline");
    const selected = payload.repairDecision?.selectedAlternativeId;
    if (payload.repairDecision?.operation === "select_alternative" && !expected.allowedAlternativeIds?.includes(selected)) {
      violations.push(`repair selected undeclared alternative: ${selected ?? "<none>"}`);
    }
  }
}

function validateForbiddenKernels(payload, expected, violations) {
  for (const kernel of expected.forbiddenKernels ?? []) {
    if (payload.stages?.some((stage) => stage.kernel === kernel)) violations.push(`forbidden kernel selected: ${kernel}`);
  }
}

function parsePayload(rawPayload, violations) {
  if (isPlainObject(rawPayload)) return rawPayload;
  if (typeof rawPayload !== "string") {
    violations.push("payload must be an object or JSON string");
    return undefined;
  }
  const text = extractJsonText(rawPayload);
  try {
    return JSON.parse(text);
  } catch (error) {
    violations.push(`payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function extractJsonText(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

async function deterministicMockModelCall({ testCase }) {
  const payload = deterministicMockPayload(testCase);
  return JSON.stringify(payload);
}

function deterministicMockPayload(testCase) {
  const expected = testCase.expected ?? {};
  const stages = [
    {
      id: "discover",
      label: "Discover request shape",
      kernel: "model.call",
      intent: "Summarize the user request into bounded workflow requirements.",
      inputs: ["request"],
      outputs: ["requirements"],
      evidence: ["requirements summary"],
      constraints: [],
    },
    {
      id: "review",
      label: "Review constraints",
      kernel: expected.behavior === "unsupported" ? "unsupported" : "review.input",
      intent: expected.behavior === "unsupported" ? "Wait for a supported capability or user decision." : "Confirm ambiguous choices before expensive work.",
      inputs: ["requirements"],
      outputs: ["decision"],
      evidence: ["decision log"],
      constraints: [],
    },
    {
      id: "final",
      label: "Final output",
      kernel: "output.final",
      intent: "Return the final workflow result and proof expectations.",
      inputs: ["requirements", "decision"],
      outputs: ["final"],
      evidence: ["final summary"],
      constraints: [],
    },
  ];
  if (expected.behavior === "constraints") {
    for (const stage of stages) stage.constraints = ["no browser automation", "no file writes", "metadata only summaries"];
  }
  const payload = {
    schemaVersion: 1,
    kind: "workflow_plan_dsl",
    goal: "Produce a bounded workflow plan for the requested task.",
    strategy: expected.behavior === "unsupported" ? "unsupported" : "bounded_plan",
    stages,
    questions: [],
    unsupportedStages: [],
    budgetPolicy: {
      mode: expected.behavior === "scale" && expected.large ? "metadata_first" : "detail",
      maxItemsPerBatch: expected.behavior === "scale" && expected.large ? 50 : 20,
      summary: expected.behavior === "scale" && expected.large ? "Use metadata-first scan before requesting details." : "Small plan can use direct detail.",
    },
    repairDecision: { operation: "none", selectedAlternativeId: null, reason: "No repair required." },
  };
  if (expected.behavior === "unsupported") {
    payload.unsupportedStages = [{ label: "Unavailable capability", reason: "The requested capability is not available in the current tool inventory." }];
    payload.questions = [{ id: "q1", question: "Which supported capability should replace the unavailable step?", reason: "The plan cannot fabricate tools." }];
  }
  if (expected.behavior === "repair") {
    payload.repairDecision = {
      operation: expected.preferredAlternativeId === "alt-decline" ? "decline" : "select_alternative",
      selectedAlternativeId: expected.preferredAlternativeId === "alt-decline" ? null : expected.preferredAlternativeId,
      reason: "Selected from declared repair alternatives only.",
    };
  }
  return payload;
}

async function callLiveOpenAiCompatibleModel({ testCase, provider, timeoutMs }) {
  if (!provider.apiKey) {
    throw new Error("Set GMI_CLOUD_API_KEY, GMI_API_KEY, GMI_CLOUD_API_KEY_FILE, or provide ignored-provider-key-file.txt for live workflow model tolerance lab.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`workflow model tolerance request timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    const response = await fetch(`${normalizeBaseUrl(provider.baseUrl)}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          {
            role: "system",
            content: "You are testing a workflow compiler instruction contract. Return valid compact JSON only. Obey the supplied schema and do not include hidden analysis.",
          },
          { role: "user", content: testCase.prompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.15,
        max_tokens: DEFAULT_MAX_TOKENS,
        stream: false,
        thinking: { type: "disabled" },
        reasoning: { effort: "none", enabled: false, exclude: true },
        enable_thinking: false,
      }),
    });
    const responseBody = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${truncate(responseBody, 600)}`);
    const parsed = JSON.parse(responseBody);
    const content = parsed?.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
        .join("")
        .trim();
    }
    throw new Error("Provider response did not include message.content.");
  } finally {
    clearTimeout(timeout);
  }
}

function resolveProviderConfig(input = {}) {
  const env = input.env ?? process.env;
  const providerId = normalizeProviderId(input.providerId ?? env.AMBIENT_PROVIDER ?? env.AMBIENT_LLM_PROVIDER ?? "gmi-cloud");
  const gmiCloud = providerId === "gmi-cloud";
  const baseUrl = input.baseUrl ?? (gmiCloud ? env.GMI_CLOUD_BASE_URL || DEFAULT_GMI_CLOUD_BASE_URL : env.AMBIENT_BASE_URL || "https://api.ambient.xyz");
  const model = input.model ?? (gmiCloud ? env.GMI_CLOUD_MODEL || env.AMBIENT_WORKFLOW_MODEL || DEFAULT_MODEL : env.AMBIENT_WORKFLOW_MODEL || env.AMBIENT_LIVE_MODEL || DEFAULT_MODEL);
  const credential = input.live ? readProviderCredential(providerId, env, input.cwd ?? process.cwd()) : { apiKey: undefined, credentialSource: "not-required" };
  return {
    providerId,
    providerLabel: gmiCloud ? "GMI Cloud" : "Ambient",
    baseUrl: normalizeBaseUrl(baseUrl).replace(/\/v1$/, ""),
    model,
    ...credential,
  };
}

function readProviderCredential(providerId, env, cwd) {
  if (providerId !== "gmi-cloud") {
    if (env.AMBIENT_API_KEY?.trim()) return { apiKey: env.AMBIENT_API_KEY.trim(), credentialSource: "env:AMBIENT_API_KEY" };
    if (env.AMBIENT_AGENT_AMBIENT_API_KEY?.trim()) return { apiKey: env.AMBIENT_AGENT_AMBIENT_API_KEY.trim(), credentialSource: "env:AMBIENT_AGENT_AMBIENT_API_KEY" };
    if (env.AMBIENT_API_KEY_FILE?.trim()) return readKeyFileCredential(env.AMBIENT_API_KEY_FILE, "env:AMBIENT_API_KEY_FILE");
    return readFirstKeyFileCredential(
      [
        join(cwd, "ignored-provider-key-file.txt"),
        join(dirname(cwd), "ignored-provider-key-file.txt"),
        join(dirname(cwd), "ambientCoder", "ignored-provider-key-file.txt"),
        join(homedir(), "Documents", "ambientCoder", "ignored-provider-key-file.txt"),
      ],
      "ignored-provider-key-file.txt",
    );
  }
  if (env.GMI_CLOUD_API_KEY?.trim()) return { apiKey: env.GMI_CLOUD_API_KEY.trim(), credentialSource: "env:GMI_CLOUD_API_KEY" };
  if (env.GMI_API_KEY?.trim()) return { apiKey: env.GMI_API_KEY.trim(), credentialSource: "env:GMI_API_KEY" };
  if (env.GMI_CLOUD_API_KEY_FILE?.trim()) return readKeyFileCredential(env.GMI_CLOUD_API_KEY_FILE, "env:GMI_CLOUD_API_KEY_FILE");
  return readFirstKeyFileCredential(
    [
      join(cwd, "ignored-provider-key-file.txt"),
      join(dirname(cwd), "ignored-provider-key-file.txt"),
      join(dirname(cwd), "ambientCoder", "ignored-provider-key-file.txt"),
      join(homedir(), "Documents", "ambientCoder", "ignored-provider-key-file.txt"),
      join(homedir(), "Documents", "New project 3", "ignored-provider-key-file.txt"),
    ],
    "ignored-provider-key-file.txt",
  );
}

function readFirstKeyFileCredential(candidates, label) {
  for (const candidate of candidates) {
    const credential = readKeyFileCredential(candidate, `file:${label}`);
    if (credential.apiKey) return credential;
  }
  return { apiKey: undefined, credentialSource: undefined };
}

function readKeyFileCredential(filePath, source) {
  const candidate = String(filePath ?? "").trim();
  if (!candidate || !existsSync(candidate)) return { apiKey: undefined, credentialSource: undefined };
  try {
    const value = readFileSync(candidate, "utf8").trim();
    return value ? { apiKey: value, credentialSource: source || `file:${basename(candidate)}` } : { apiKey: undefined, credentialSource: undefined };
  } catch {
    return { apiKey: undefined, credentialSource: undefined };
  }
}

async function runCasesConcurrently(cases, input) {
  const results = new Array(cases.length);
  const concurrency = Math.max(1, Math.min(cases.length || 1, input.concurrency));
  const stopAfterFailures = Math.max(0, input.stopAfterFailures ?? 0);
  let nextIndex = 0;
  let productFailures = 0;

  async function worker() {
    while (true) {
      if (stopAfterFailures > 0 && productFailures >= stopAfterFailures) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= cases.length) return;
      const result = await input.runCase(cases[index]);
      results[index] = result;
      if (result.status === "product_or_test_failure") productFailures += 1;
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return cases.map((testCase, index) => {
    if (results[index]) return results[index];
    return {
      id: testCase.id,
      suiteId: testCase.suiteId,
      seed: testCase.seed,
      title: testCase.title,
      status: "not_run",
      providerHealth: "unknown",
      retryable: false,
      reason: `Stopped after ${stopAfterFailures} product/test failure${stopAfterFailures === 1 ? "" : "s"}.`,
      durationMs: 0,
      promptChars: testCase.prompt.length,
      responseChars: 0,
      violations: ["case was not run because the stop-after-failures threshold was reached"],
      promptPreview: truncate(testCase.prompt, 1200),
      responsePreview: "",
      minimizedRepro: renderMinimizedRepro(testCase),
    };
  });
}

function summarizeResults(results) {
  return {
    passedCount: results.filter((result) => result.status === "passed").length,
    productOrTestFailureCount: results.filter((result) => result.status === "product_or_test_failure").length,
    providerDegradedCount: results.filter((result) => result.status === "provider_degraded").length,
    skippedCount: results.filter((result) => result.status === "skipped").length,
    notRunCount: results.filter((result) => result.status === "not_run").length,
  };
}

function summarizeSuites(results) {
  const bySuite = new Map();
  for (const result of results) {
    if (!bySuite.has(result.suiteId)) bySuite.set(result.suiteId, []);
    bySuite.get(result.suiteId).push(result);
  }
  return Array.from(bySuite.entries()).map(([suiteId, suiteResults]) => {
    const counts = summarizeResults(suiteResults);
    return {
      suiteId,
      caseCount: suiteResults.length,
      ...counts,
      passRate: suiteResults.length > 0 ? counts.passedCount / suiteResults.length : 0,
    };
  });
}

function renderMinimizedRepro(testCase) {
  return [`Suite: ${testCase.suiteId}`, `Seed: ${testCase.seed}`, "", testCase.prompt].join("\n");
}

function workflowModelToleranceRunId(generatedAt) {
  return `workflow-model-tolerance-${generatedAt.replace(/[:.]/g, "-")}`;
}

function normalizeProviderId(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (["gmi", "gmi-cloud", "gmicloud", "gmi_cloud", "pi-session", "pi_session", "pi"].includes(raw)) return "gmi-cloud";
  return "ambient";
}

function normalizeBaseUrl(baseUrl) {
  const root = String(baseUrl || DEFAULT_GMI_CLOUD_BASE_URL).replace(/\/+$/, "");
  return root.endsWith("/v1") ? root : `${root}/v1`;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function parseMarkdownCaseFilter(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "all" || normalized === "failures") return normalized;
  throw new Error(`Unknown markdown case filter: ${value}`);
}

function seededRng(seedText) {
  let seed = 2166136261;
  for (let index = 0; index < seedText.length; index += 1) {
    seed ^= seedText.charCodeAt(index);
    seed = Math.imul(seed, 16777619);
  }
  return () => {
    seed += 0x6d2b79f5;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, values) {
  return values[Math.floor(rng() * values.length) % values.length];
}

function walk(value, visit, path = []) {
  visit(value, path);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, visit, [...path, String(index)]));
  } else if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) walk(entry, visit, [...path, key]);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function truncate(value, maxChars) {
  const text = String(value ?? "");
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

function parseCliArgs(argv) {
  const options = {
    suites: [],
    seeds: DEFAULT_SEEDS,
    outputDir: DEFAULT_OUTPUT_DIR,
    live: false,
    requireLive: false,
    passThreshold: DEFAULT_PASS_THRESHOLD,
    promotionGate: false,
  };
  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--live") options.live = true;
    else if (arg === "--mock" || arg === "--dry-run") options.live = false;
    else if (arg === "--require-live") options.requireLive = true;
    else if (arg === "--promotion-gate") options.promotionGate = true;
    else if (arg.startsWith("--suite=")) options.suites = arg.slice("--suite=".length);
    else if (arg.startsWith("--seeds=")) options.seeds = positiveInteger(arg.slice("--seeds=".length), DEFAULT_SEEDS);
    else if (arg.startsWith("--output-dir=")) options.outputDir = resolve(arg.slice("--output-dir=".length));
    else if (arg.startsWith("--provider=")) options.providerId = arg.slice("--provider=".length);
    else if (arg.startsWith("--model=")) options.model = arg.slice("--model=".length);
    else if (arg.startsWith("--base-url=")) options.baseUrl = arg.slice("--base-url=".length);
    else if (arg.startsWith("--timeout-ms=")) options.timeoutMs = positiveInteger(arg.slice("--timeout-ms=".length), DEFAULT_TIMEOUT_MS);
    else if (arg.startsWith("--concurrency=")) options.concurrency = positiveInteger(arg.slice("--concurrency=".length), options.live ? DEFAULT_LIVE_CONCURRENCY : DEFAULT_MOCK_CONCURRENCY);
    else if (arg.startsWith("--stop-after-failures=")) options.stopAfterFailures = nonNegativeInteger(arg.slice("--stop-after-failures=".length), 0);
    else if (arg.startsWith("--min-cases=")) options.minPromotionCases = nonNegativeInteger(arg.slice("--min-cases=".length), DEFAULT_PROMOTION_MIN_CASES);
    else if (arg.startsWith("--markdown-case-filter=")) options.markdownCaseFilter = parseMarkdownCaseFilter(arg.slice("--markdown-case-filter=".length));
    else if (arg.startsWith("--pass-threshold=")) options.passThreshold = Number(arg.slice("--pass-threshold=".length));
    else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function usage() {
  return `Usage:
  node scripts/workflow-model-tolerance-lab.mjs [--mock|--live] [--suite=all|plan-dsl-basic,...] [--seeds=100]

Options:
  --mock                 Run deterministic local responses. This is the default.
  --live                 Call the Ambient-compatible provider directly without Desktop.
  --require-live         Exit non-zero if live provider is skipped or degraded.
  --promotion-gate       Exit non-zero unless threshold, provider, skip, not-run, and min-case gates are green.
  --suite=<ids>          Comma-separated suite ids, or all. Defaults to all.
  --seeds=<n>            Prompt variants per suite. Defaults to ${DEFAULT_SEEDS}.
  --concurrency=<n>      Parallel cases. Defaults to ${DEFAULT_MOCK_CONCURRENCY} mock, ${DEFAULT_LIVE_CONCURRENCY} live.
  --stop-after-failures=<n>
                         Stop assigning new cases after n product/test failures. 0 disables.
  --min-cases=<n>        Promotion-gate minimum case count. Defaults to ${DEFAULT_PROMOTION_MIN_CASES}.
  --markdown-case-filter=<all|failures>
                         Render all cases or only non-passing cases in Markdown.
  --output-dir=<path>    Report directory. Defaults to test-results/workflow-model-tolerance-lab.
  --provider=<id>        gmi-cloud, pi-session, or ambient. Defaults to AMBIENT_PROVIDER or gmi-cloud.
  --model=<id>           Model id. Defaults to GMI_CLOUD_MODEL, AMBIENT_WORKFLOW_MODEL, or ${DEFAULT_MODEL}.
  --base-url=<url>       Provider root URL.
  --pass-threshold=<n>   Required pass rate for product failures. Defaults to ${DEFAULT_PASS_THRESHOLD}.`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      process.exit(0);
    }
    const summary = await runWorkflowModelToleranceLab(options);
    await writeWorkflowModelToleranceReport(summary, options.outputDir);
    console.log(renderWorkflowModelToleranceMarkdown(summary));
    process.exit(workflowModelToleranceExitCode(summary, { requireLive: options.requireLive, promotionGate: options.promotionGate }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
