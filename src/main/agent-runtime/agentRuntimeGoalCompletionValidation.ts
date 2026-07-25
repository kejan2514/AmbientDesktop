import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

import type {
  BrowserEvaluateInput,
  BrowserNavigateInput,
  BrowserPageContent,
  BrowserScreenshotResult,
  BrowserStartInput,
  BrowserUserActionState,
} from "../../shared/browserTypes";
import type { ChatMessage, ThreadGoal, ThreadSummary } from "../../shared/threadTypes";
import { isBrowserUserActionState } from "./agentRuntimeAgentFacade";
import { cleanToolPath, normalizeWorkspaceArtifactPath, parseToolJsonInput, stringField } from "./agentRuntimeMediaArtifacts";

const HTML_ARTIFACT_PATTERN = /\.(?:html?|xhtml)(?:[?#].*)?$/i;
const SCRIPT_SOURCE_PATTERN = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i;
const MOTION_HINT_PATTERN = /\b(?:animat(?:e|ed|ion)|moving|motion|screensaver|screen\s+saver|sandstorm|particle|particles|canvas|webgl|three\.js|requestanimationframe|setinterval|keyframes)\b/i;
const MOTION_IMPLEMENTATION_PATTERN = /\brequestAnimationFrame\s*\(|\bsetInterval\s*\(|@keyframes\b|\.animate\s*\(|\banimation\s*:/i;
const GOAL_VALIDATION_BROWSER_DELAY_MS = 1800;
const GOAL_VALIDATION_PREVIEW_TTL_MS = 60_000;
const HTML_DISCOVERY_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "htmlcov",
  "node_modules",
  "site-packages",
  "venv",
]);

export interface GoalCompletionValidationResult {
  ok: boolean;
  message?: string;
  issues: string[];
  artifactPaths: string[];
  repairInstructions: string[];
}

export interface GoalCompletionValidationInput {
  goal: ThreadGoal;
  thread: Pick<ThreadSummary, "id" | "workspacePath">;
  messages: ChatMessage[];
  browser?: GoalCompletionBrowser;
  openLocalPreview?: (input: { workspacePath: string; path: string; ttlMs?: number }) => Promise<{ url: string }>;
}

export interface GoalCompletionBrowser {
  navigate: (input: BrowserNavigateInput) => Promise<BrowserPageContent | BrowserUserActionState>;
  evaluate: (input: BrowserEvaluateInput) => Promise<unknown | BrowserUserActionState>;
  screenshot: (input?: BrowserStartInput) => Promise<BrowserScreenshotResult | BrowserUserActionState>;
}

interface HtmlArtifactCandidate {
  absolutePath: string;
  relativePath: string;
}

export async function validateGoalCompletionArtifacts(input: GoalCompletionValidationInput): Promise<GoalCompletionValidationResult> {
  const workspacePath = input.thread.workspacePath;
  const candidates = htmlArtifactCandidates(input.goal, input.messages, workspacePath);
  const shouldInspectHtml = candidates.length > 0 || goalRequiresVisualHtmlValidation(input.goal, input.messages);
  if (!shouldInspectHtml) return okResult([]);

  const issues: string[] = [];
  const repairInstructions = new Set<string>();
  if (!candidates.length) {
    issues.push("No completed HTML artifact was found for this browser-visible goal.");
    repairInstructions.add("Write the browser artifact first, then rerun completion after validation can inspect it.");
    return failureResult(issues, [], repairInstructions);
  }

  const artifactPaths = candidates.map((candidate) => candidate.relativePath);
  const motionRequired = goalRequiresMotionValidation(input.goal, input.messages, candidates);
  let browserChecked = false;
  for (const candidate of candidates) {
    const html = safeReadText(candidate.absolutePath);
    if (html === undefined) {
      issues.push(`${candidate.relativePath}: artifact could not be read.`);
      repairInstructions.add("Rewrite the artifact so Ambient can inspect the completed file.");
      continue;
    }
    const staticIssues = validateHtmlStaticArtifact(candidate, html);
    for (const issue of staticIssues) issues.push(issue);
    if (staticIssues.length) {
      repairInstructions.add("Repair the HTML so all opened tags are closed and JavaScript parses before marking the goal complete.");
    }

    if (!motionRequired) continue;
    if (!MOTION_IMPLEMENTATION_PATTERN.test(html)) {
      issues.push(`${candidate.relativePath}: motion was requested, but no animation loop or CSS animation was detected.`);
      repairInstructions.add("Add and start an animation loop such as requestAnimationFrame, or a CSS keyframes animation if that is the intended implementation.");
      continue;
    }

    const browserIssues = await validateBrowserMotion(input, candidate);
    if (browserIssues === undefined) continue;
    browserChecked = true;
    for (const issue of browserIssues) issues.push(issue);
    if (browserIssues.length) {
      repairInstructions.add("Open the artifact through local preview, fix runtime errors, and prove at least two frames differ for moving visuals.");
    }
  }

  if (motionRequired && !browserChecked) {
    issues.push("Motion was requested, but Ambient could not run browser frame validation for the artifact.");
    repairInstructions.add("Use browser local preview and screenshot proof, or repair browser validation access before marking complete.");
  }

  return issues.length ? failureResult(issues, artifactPaths, repairInstructions) : okResult(artifactPaths);
}

function validateHtmlStaticArtifact(candidate: HtmlArtifactCandidate, html: string): string[] {
  const issues: string[] = [];
  const scriptOpenCount = countMatches(html, /<script\b/gi);
  const scriptCloseCount = countMatches(html, /<\/script\s*>/gi);
  if (scriptOpenCount > scriptCloseCount) {
    issues.push(`${candidate.relativePath}: opened ${scriptOpenCount} <script> tag(s) but closed ${scriptCloseCount}.`);
  }
  if (!/<\/body\s*>/i.test(html)) issues.push(`${candidate.relativePath}: missing closing </body> tag.`);
  if (!/<\/html\s*>/i.test(html)) issues.push(`${candidate.relativePath}: missing closing </html> tag.`);

  const scripts = scriptBlocks(html);
  scripts.forEach((script, index) => {
    if (!script.sourcePath && !script.code.trim()) return;
    try {
      new Script(script.code, { filename: script.sourcePath ?? `${candidate.relativePath}#inline-script-${index + 1}` });
    } catch (error) {
      issues.push(`${script.sourcePath ?? `${candidate.relativePath} inline script ${index + 1}`}: JavaScript does not parse (${errorMessage(error)}).`);
    }
  });

  for (const sourcePath of localScriptSources(candidate.absolutePath, html)) {
    const scriptText = safeReadText(sourcePath.absolutePath);
    if (scriptText === undefined) {
      issues.push(`${candidate.relativePath}: referenced script ${sourcePath.displayPath} could not be read.`);
      continue;
    }
    try {
      new Script(scriptText, { filename: sourcePath.displayPath });
    } catch (error) {
      issues.push(`${sourcePath.displayPath}: JavaScript does not parse (${errorMessage(error)}).`);
    }
  }

  if (/\bfunction\s+animate\s*\(/i.test(html) && !/\banimate\s*\(\s*\)\s*;?|\brequestAnimationFrame\s*\(\s*animate\b/i.test(html)) {
    issues.push(`${candidate.relativePath}: defines animate() but does not appear to start it.`);
  }
  return issues;
}

async function validateBrowserMotion(input: GoalCompletionValidationInput, candidate: HtmlArtifactCandidate): Promise<string[] | undefined> {
  if (!input.browser || !input.openLocalPreview) return undefined;
  const issues: string[] = [];
  let previewUrl: string;
  try {
    previewUrl = (await input.openLocalPreview({
      workspacePath: input.thread.workspacePath,
      path: candidate.relativePath,
      ttlMs: GOAL_VALIDATION_PREVIEW_TTL_MS,
    })).url;
  } catch (error) {
    return [`${candidate.relativePath}: local browser preview could not open (${errorMessage(error)}).`];
  }

  try {
    const content = await input.browser.navigate({
      url: previewUrl,
      runtime: "internal",
      waitForUserAction: false,
      sourceThreadId: input.thread.id,
    });
    if (isBrowserUserActionState(content)) return [`${candidate.relativePath}: browser validation needs user action (${content.message}).`];

    await input.browser.evaluate({
      runtime: "internal",
      code: `
const bucket = window.__ambientGoalCompletionValidation ?? { errors: [], installed: false };
if (!bucket.installed) {
  bucket.installed = true;
  const originalError = console.error.bind(console);
  console.error = (...args) => {
    bucket.errors.push(args.map((arg) => String(arg)).join(" "));
    originalError(...args);
  };
  window.addEventListener("error", (event) => bucket.errors.push(event.message || String(event.error || "window error")));
  window.addEventListener("unhandledrejection", (event) => bucket.errors.push(String(event.reason || "unhandled rejection")));
}
window.__ambientGoalCompletionValidation = bucket;
return true;`,
    });

    const first = await input.browser.screenshot({ runtime: "internal", artifactWorkspacePath: input.thread.workspacePath });
    if (isBrowserUserActionState(first)) return [`${candidate.relativePath}: first browser screenshot needs user action (${first.message}).`];
    await input.browser.evaluate({
      runtime: "internal",
      code: `await new Promise((resolve) => setTimeout(resolve, ${GOAL_VALIDATION_BROWSER_DELAY_MS})); return true;`,
    });
    const second = await input.browser.screenshot({ runtime: "internal", artifactWorkspacePath: input.thread.workspacePath });
    if (isBrowserUserActionState(second)) return [`${candidate.relativePath}: second browser screenshot needs user action (${second.message}).`];

    if (!screenshotsDiffer(first, second)) {
      issues.push(`${candidate.relativePath}: browser screenshots taken ${GOAL_VALIDATION_BROWSER_DELAY_MS}ms apart were identical, so requested motion was not proven.`);
    }

    const browserState = await input.browser.evaluate({
      runtime: "internal",
      code: `
return {
  title: document.title || "",
  elementCount: document.body ? document.body.querySelectorAll("*").length : 0,
  bodyText: document.body && document.body.innerText ? document.body.innerText.trim().slice(0, 500) : "",
  canvasCount: document.querySelectorAll("canvas").length,
  errors: (window.__ambientGoalCompletionValidation && window.__ambientGoalCompletionValidation.errors) || [],
};`,
    });
    const state = objectRecord(browserState);
    const errors = Array.isArray(state.errors) ? state.errors.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 5) : [];
    for (const error of errors) issues.push(`${candidate.relativePath}: browser console/runtime error: ${error}`);
    if (state.elementCount === 0 && state.canvasCount === 0 && !state.bodyText) {
      issues.push(`${candidate.relativePath}: browser page appears empty after loading.`);
    }
  } catch (error) {
    issues.push(`${candidate.relativePath}: browser validation failed (${errorMessage(error)}).`);
  }
  return issues;
}

function htmlArtifactCandidates(goal: ThreadGoal, messages: ChatMessage[], workspacePath: string): HtmlArtifactCandidate[] {
  const evidencePaths = new Set<string>();
  for (const message of messagesForGoal(goal, messages)) {
    for (const path of htmlPathsFromMessage(message)) evidencePaths.add(path);
  }
  const evidenceCandidates = resolveHtmlArtifactCandidates(evidencePaths, workspacePath);
  if (evidenceCandidates.length) return evidenceCandidates.slice(0, 12);

  const goalCreatedAtMs = Date.parse(goal.createdAt);
  const fallbackPaths = newestWorkspaceHtmlArtifacts(
    workspacePath,
    Number.isFinite(goalCreatedAtMs) ? goalCreatedAtMs : undefined,
  );
  return resolveHtmlArtifactCandidates(fallbackPaths, workspacePath).slice(0, 12);
}

function resolveHtmlArtifactCandidates(paths: Iterable<string>, workspacePath: string): HtmlArtifactCandidate[] {
  const candidates: HtmlArtifactCandidate[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const candidate = htmlArtifactCandidate(path, workspacePath);
    if (!candidate || seen.has(candidate.absolutePath)) continue;
    seen.add(candidate.absolutePath);
    candidates.push(candidate);
  }
  return candidates;
}

function messagesForGoal(goal: ThreadGoal, messages: ChatMessage[]): ChatMessage[] {
  const goalCreatedAtMs = Date.parse(goal.createdAt);
  if (!Number.isFinite(goalCreatedAtMs)) return messages;
  let initiatingUserMessageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role !== "user") continue;
    const messageCreatedAtMs = Date.parse(message.createdAt);
    if (!Number.isFinite(messageCreatedAtMs) || messageCreatedAtMs > goalCreatedAtMs) continue;
    initiatingUserMessageIndex = index;
    break;
  }
  const goalMessages = initiatingUserMessageIndex >= 0 ? messages.slice(initiatingUserMessageIndex) : messages;
  return goalMessages.filter((message, index) => {
    if (initiatingUserMessageIndex >= 0 && index === 0) return true;
    const messageCreatedAtMs = Date.parse(message.createdAt);
    return !Number.isFinite(messageCreatedAtMs) || messageCreatedAtMs >= goalCreatedAtMs;
  });
}

function htmlPathsFromMessage(message: ChatMessage): string[] {
  const paths: string[] = [];
  const metadata = message.metadata ?? {};
  if (metadata.status === "error") return paths;
  const artifactPath = typeof metadata.artifactPath === "string" ? metadata.artifactPath : undefined;
  if (artifactPath && HTML_ARTIFACT_PATTERN.test(artifactPath)) paths.push(artifactPath);

  const toolName = typeof metadata.toolName === "string" ? metadata.toolName.toLowerCase() : "";
  if (toolName && !["write", "file_write", "edit", "apply_patch", "shell", "bash"].includes(toolName)) return paths;

  const parsed = parseToolJsonInput(message.content);
  const inputPath = stringField(parsed, ["path", "filePath", "file", "targetPath", "outputPath", "artifactPath"]);
  if (inputPath && HTML_ARTIFACT_PATTERN.test(inputPath)) paths.push(inputPath);
  for (const path of htmlPathsInText(message.content)) paths.push(path);
  return paths;
}

function htmlPathsInText(text: string): string[] {
  const matches = text.matchAll(/(?:^|[\s"'`(])((?:file:\/\/|\.{0,2}\/|\/)?[^"'`\s)<>|]+\.(?:html?|xhtml))(?:[\s"'`),.]|$)/gi);
  return [...matches].map((match) => match[1]).filter(Boolean);
}

function htmlArtifactCandidate(path: string, workspacePath: string): HtmlArtifactCandidate | undefined {
  const cleaned = cleanToolPath(path);
  if (!cleaned || !HTML_ARTIFACT_PATTERN.test(cleaned)) return undefined;
  const normalized = normalizeWorkspaceArtifactPath(fileUrlToPath(cleaned) ?? cleaned, workspacePath);
  if (!normalized) return undefined;
  const absolutePath = isAbsolute(normalized) ? normalized : resolve(workspacePath, normalized);
  if (!existsSync(absolutePath)) return undefined;
  let file;
  try {
    file = statSync(absolutePath);
  } catch {
    return undefined;
  }
  if (!file.isFile()) return undefined;
  const workspaceRelative = relative(workspacePath, absolutePath);
  const relativePath = workspaceRelative && !workspaceRelative.startsWith("..") && !isAbsolute(workspaceRelative)
    ? workspaceRelative
    : absolutePath;
  return { absolutePath, relativePath };
}

function newestWorkspaceHtmlArtifacts(workspacePath: string, createdAfterMs?: number): string[] {
  const entries: { path: string; mtimeMs: number }[] = [];
  scanWorkspaceHtmlArtifacts(workspacePath, workspacePath, entries, 0, createdAfterMs);
  return entries
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 8)
    .map((entry) => entry.path);
}

function scanWorkspaceHtmlArtifacts(
  workspacePath: string,
  directory: string,
  entries: { path: string; mtimeMs: number }[],
  depth: number,
  createdAfterMs?: number,
): void {
  if (depth > 8 || entries.length > 64) return;
  let dirents: Dirent[];
  try {
    dirents = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of dirents) {
    if (HTML_DISCOVERY_EXCLUDED_DIRECTORIES.has(dirent.name)) continue;
    const absolutePath = join(directory, dirent.name);
    if (dirent.isDirectory()) {
      scanWorkspaceHtmlArtifacts(workspacePath, absolutePath, entries, depth + 1, createdAfterMs);
      continue;
    }
    if (!dirent.isFile() || !HTML_ARTIFACT_PATTERN.test(dirent.name)) continue;
    try {
      const file = statSync(absolutePath);
      if (file.isFile() && (createdAfterMs === undefined || file.mtimeMs >= createdAfterMs)) {
        entries.push({ path: relative(workspacePath, absolutePath), mtimeMs: file.mtimeMs });
      }
    } catch {
      continue;
    }
  }
}

function goalRequiresVisualHtmlValidation(goal: ThreadGoal, messages: ChatMessage[]): boolean {
  const text = goalAndRecentText(goal, messages);
  return /\b(?:app|page|html|browser|visual|canvas|webgl|screensaver|preview|render)\b/i.test(text);
}

function goalRequiresMotionValidation(goal: ThreadGoal, messages: ChatMessage[], candidates: HtmlArtifactCandidate[]): boolean {
  if (MOTION_HINT_PATTERN.test(goalAndRecentText(goal, messages))) return true;
  return candidates.some((candidate) => {
    const html = safeReadText(candidate.absolutePath);
    return Boolean(html && MOTION_IMPLEMENTATION_PATTERN.test(html));
  });
}

function goalAndRecentText(goal: ThreadGoal, messages: ChatMessage[]): string {
  return [goal.objective, ...messages.slice(-12).map((message) => message.content)].join("\n");
}

function scriptBlocks(html: string): { code: string; sourcePath?: string }[] {
  const scripts: { code: string; sourcePath?: string }[] = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    if (SCRIPT_SOURCE_PATTERN.test(match[1] ?? "")) continue;
    scripts.push({ code: match[2] ?? "" });
  }
  return scripts;
}

function localScriptSources(htmlPath: string, html: string): { absolutePath: string; displayPath: string }[] {
  const sources: { absolutePath: string; displayPath: string }[] = [];
  const pattern = /<script\b([^>]*)>[\s\S]*?<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    const raw = SCRIPT_SOURCE_PATTERN.exec(match[1] ?? "")?.slice(1).find((value) => value);
    if (!raw || /^(?:https?:|data:|blob:|\/\/)/i.test(raw)) continue;
    const cleaned = cleanToolPath(raw.split(/[?#]/)[0]);
    if (!cleaned) continue;
    const absolutePath = resolve(join(htmlPath, ".."), cleaned);
    sources.push({ absolutePath, displayPath: cleaned });
  }
  return sources;
}

function screenshotsDiffer(first: BrowserScreenshotResult, second: BrowserScreenshotResult): boolean {
  if (!first.path || !second.path) return first.bytes !== second.bytes;
  try {
    const firstBytes = readFileSync(first.path);
    const secondBytes = readFileSync(second.path);
    return firstBytes.length !== secondBytes.length || !firstBytes.equals(secondBytes);
  } catch {
    return first.bytes !== second.bytes;
  }
}

function safeReadText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

function fileUrlToPath(path: string): string | undefined {
  if (!path.startsWith("file://")) return undefined;
  try {
    return fileURLToPath(path);
  } catch {
    return undefined;
  }
}

function okResult(artifactPaths: string[]): GoalCompletionValidationResult {
  return { ok: true, issues: [], artifactPaths, repairInstructions: [] };
}

function failureResult(issues: string[], artifactPaths: string[], repairInstructions: Set<string>): GoalCompletionValidationResult {
  const instructions = [...repairInstructions];
  return {
    ok: false,
    issues,
    artifactPaths,
    repairInstructions: instructions,
    message: [
      "Goal completion validation failed for browser artifact(s).",
      ...issues.map((issue) => `- ${issue}`),
      ...instructions.map((instruction) => `Repair: ${instruction}`),
    ].join("\n"),
  };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
