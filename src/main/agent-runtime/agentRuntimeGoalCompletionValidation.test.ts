import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { BrowserPageContent, BrowserScreenshotResult } from "../../shared/browserTypes";
import type { ChatMessage, ThreadGoal, ThreadSummary } from "../../shared/threadTypes";
import { validateGoalCompletionArtifacts, type GoalCompletionBrowser } from "./agentRuntimeGoalCompletionValidation";

describe("validateGoalCompletionArtifacts", () => {
  it("blocks a truncated moving HTML artifact before goal completion", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "ambient-goal-validation-"));
    mkdirSync(join(workspacePath, "sandstorm-screensaver"));
    writeFileSync(
      join(workspacePath, "sandstorm-screensaver", "index.html"),
      `<html><body><canvas id="storm"></canvas><script>
const canvas = document.getElementById("storm");
function animate() {
  // Atmospheric haze overlay`,
    );

    const result = await validateGoalCompletionArtifacts({
      goal: goal({ objective: "make a moving screensaver that looks like a sandstorm." }),
      thread: thread(workspacePath),
      messages: [
        toolMessage(workspacePath, "sandstorm-screensaver/index.html"),
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.artifactPaths).toEqual(["sandstorm-screensaver/index.html"]);
    expect(result.issues.join("\n")).toContain("<script>");
    expect(result.issues.join("\n")).toContain("</body>");
    expect(result.issues.join("\n")).toContain("</html>");
    expect(result.issues.join("\n")).toContain("motion was requested");
  });

  it("allows a complete moving HTML artifact when browser frames differ", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "ambient-goal-validation-"));
    mkdirSync(join(workspacePath, "sandstorm-screensaver"));
    writeFileSync(
      join(workspacePath, "sandstorm-screensaver", "index.html"),
      `<!doctype html>
<html>
<body>
<canvas id="storm"></canvas>
<script>
const canvas = document.getElementById("storm");
function animate() {
  requestAnimationFrame(animate);
}
animate();
</script>
</body>
</html>`,
    );
    const firstShot = join(workspacePath, "first.png");
    const secondShot = join(workspacePath, "second.png");
    writeFileSync(firstShot, "frame-1");
    writeFileSync(secondShot, "frame-2");
    const screenshots: BrowserScreenshotResult[] = [
      { path: firstShot, bytes: 7 },
      { path: secondShot, bytes: 7 },
    ];
    const browser: GoalCompletionBrowser = {
      navigate: async () => pageContent(),
      evaluate: async () => ({ elementCount: 1, canvasCount: 1, bodyText: "", errors: [] }),
      screenshot: async () => screenshots.shift()!,
    };

    const result = await validateGoalCompletionArtifacts({
      goal: goal({ objective: "make a moving screensaver that looks like a sandstorm." }),
      thread: thread(workspacePath),
      messages: [
        toolMessage(workspacePath, "sandstorm-screensaver/index.html"),
      ],
      browser,
      openLocalPreview: async () => ({ url: "http://127.0.0.1:12345/sandstorm-screensaver/index.html" }),
    });

    expect(result).toMatchObject({
      ok: true,
      issues: [],
      artifactPaths: ["sandstorm-screensaver/index.html"],
    });
  });

  it("does not require motion evidence for ordinary non-browser goals", async () => {
    const result = await validateGoalCompletionArtifacts({
      goal: goal({ objective: "summarize the README" }),
      thread: thread(mkdtempSync(join(tmpdir(), "ambient-goal-validation-"))),
      messages: [],
    });

    expect(result.ok).toBe(true);
    expect(result.artifactPaths).toEqual([]);
  });

  it("does not let virtual-environment HTML templates block an explicit goal artifact", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "ambient-goal-validation-"));
    const artifactPath = "implementationGaps.html";
    writeFileSync(
      join(workspacePath, artifactPath),
      "<!doctype html><html><body><p>Priorities 1–7 are closed.</p></body></html>",
    );
    const coverageTemplates = join(
      workspacePath,
      ".venv",
      "lib",
      "python3.12",
      "site-packages",
      "coverage",
      "htmlfiles",
    );
    mkdirSync(coverageTemplates, { recursive: true });
    writeFileSync(
      join(coverageTemplates, "index.html"),
      "<!doctype html><html><body><script src=\"./code.js\"></script></body></html>",
    );

    const result = await validateGoalCompletionArtifacts({
      goal: goal({ objective: "Update the implementationGaps.html report page." }),
      thread: thread(workspacePath),
      messages: [toolMessage(workspacePath, artifactPath)],
    });

    expect(result).toMatchObject({
      ok: true,
      issues: [],
      artifactPaths: [artifactPath],
    });
  });

  it("does not carry artifact candidates forward from work before the current goal", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "ambient-goal-validation-"));
    writeFileSync(
      join(workspacePath, "old-report.html"),
      "<!doctype html><html><body><script src=\"./missing.js\"></script></body></html>",
    );
    writeFileSync(
      join(workspacePath, "current-report.html"),
      "<!doctype html><html><body><p>Current report.</p></body></html>",
    );
    const oldArtifactMessage = {
      ...toolMessage(workspacePath, "old-report.html"),
      id: "old-artifact",
      createdAt: "2026-06-13T00:00:00.000Z",
    };

    const result = await validateGoalCompletionArtifacts({
      goal: goal({ objective: "Finish the current report page." }),
      thread: thread(workspacePath),
      messages: [oldArtifactMessage, toolMessage(workspacePath, "current-report.html")],
    });

    expect(result).toMatchObject({
      ok: true,
      issues: [],
      artifactPaths: ["current-report.html"],
    });
  });

  it("ignores virtual-environment templates during workspace fallback discovery", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "ambient-goal-validation-"));
    writeFileSync(
      join(workspacePath, "report.html"),
      "<!doctype html><html><body><p>Complete report.</p></body></html>",
    );
    const coverageTemplates = join(workspacePath, ".venv", "lib", "site-packages", "coverage", "htmlfiles");
    mkdirSync(coverageTemplates, { recursive: true });
    writeFileSync(
      join(coverageTemplates, "index.html"),
      "<!doctype html><html><body><script src=\"./code.js\"></script></body></html>",
    );

    const result = await validateGoalCompletionArtifacts({
      goal: goal({ objective: "Finish the browser-visible report page." }),
      thread: thread(workspacePath),
      messages: [],
    });

    expect(result).toMatchObject({
      ok: true,
      issues: [],
      artifactPaths: ["report.html"],
    });
  });
});

function goal(input: Partial<ThreadGoal> = {}): ThreadGoal {
  return {
    threadId: "thread-1",
    goalId: "goal-1",
    objective: "make a moving screensaver that looks like a sandstorm.",
    status: "active",
    tokenBudget: undefined,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    continuationTurns: 0,
    noProgressTurns: 0,
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z",
    ...input,
  };
}

function thread(workspacePath: string): Pick<ThreadSummary, "id" | "workspacePath"> {
  return { id: "thread-1", workspacePath };
}

function toolMessage(workspacePath: string, artifactPath: string): ChatMessage {
  return {
    id: "message-1",
    threadId: "thread-1",
    role: "tool",
    content: JSON.stringify({ path: artifactPath }),
    createdAt: "2026-06-14T00:00:00.000Z",
    metadata: {
      status: "done",
      toolName: "write",
      artifactPath: join(workspacePath, artifactPath),
    },
  };
}

function pageContent(): BrowserPageContent {
  return { title: "Sandstorm", url: "http://127.0.0.1:12345/sandstorm-screensaver/index.html", text: "", links: [] };
}
