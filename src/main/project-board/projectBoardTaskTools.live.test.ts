import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeAmbientModelId } from "../../shared/ambientModels";
import { normalizeAmbientBaseUrl } from "./projectBoardProviderFacade";
import { projectBoardTaskToolActionIntegrityIssues, projectBoardTaskToolActionsFromText, projectBoardTaskToolPromptSection } from "./projectBoardTaskTools";

const runLive = process.env.AMBIENT_PROJECT_BOARD_TASK_ACTIONS_LIVE === "1";
const liveIt = runLive ? it : it.skip;
const liveAmbientStreamIdleTimeoutMs = Number(process.env.AMBIENT_PROJECT_BOARD_TASK_ACTION_STREAM_IDLE_MS || 0) || 90_000;

describe("project board task actions live", () => {
  liveIt(
    "Ambient/Pi follows the prompt-level task action protocol",
    async () => {
      const prompt = [
        "This is a live protocol smoke for a project-board worker card.",
        "Do not claim to edit files in this test; simulate the structured progress packet a worker would emit after completing a tiny deterministic card.",
        'Return one JSON object only with a "task_actions" array. Include at least task_heartbeat, task_report_proof, and task_complete. Keep JSON valid.',
        projectBoardTaskToolPromptSection({
          id: "live-task-action-smoke",
          title: "Add deterministic starship input reducer",
          acceptanceCriteria: ["Reducer accepts left/right/thrust/fire input and returns stable player intent state."],
          testPlan: {
            unit: ["Reducer tests cover keyboard intent transitions."],
            integration: ["Game shell imports the reducer without runtime errors."],
            visual: [],
            manual: ["A developer can inspect the reducer API and use it from the game loop."],
          },
        }),
      ].join("\n\n");

      const responseText = await callAmbient(prompt);
      const actions = projectBoardTaskToolActionsFromText(responseText);
      const actionNames = actions.map((action) => action.action);

      expect(responseText.length).toBeGreaterThan(100);
      expect(actions.length, responseText).toBeGreaterThanOrEqual(3);
      expect(actionNames).toContain("task_heartbeat");
      expect(actionNames).toContain("task_report_proof");
      expect(actionNames).toContain("task_complete");
      expect(actions.find((action) => action.action === "task_report_proof")?.changedFiles.length).toBeGreaterThan(0);
      expect(actions.find((action) => action.action === "task_report_proof")?.commands.length).toBeGreaterThan(0);
      expect(projectBoardTaskToolActionIntegrityIssues(actions)).toEqual([]);
    },
    300_000,
  );
});

async function callAmbient(prompt: string): Promise<string> {
  const apiKey = readLiveAmbientApiKey();
  const response = await fetch(`${normalizeAmbientBaseUrl(process.env.AMBIENT_BASE_URL || process.env.AMBIENT_AGENT_AMBIENT_BASE_URL)}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model: normalizeAmbientModelId(process.env.AMBIENT_PROJECT_BOARD_MODEL || process.env.AMBIENT_LIVE_MODEL || "zai-org/GLM-5.1-FP8"),
      messages: [
        {
          role: "system",
          content: "You are Ambient/Pi working inside an autonomous project-board Local Task. Follow the task action protocol exactly.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 2_000,
      response_format: { type: "json_object" },
      stream: true,
    }),
  });
  if (!response.ok) throw new Error(`Ambient task-action smoke failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  return readAmbientResponseText(response, { streamIdleTimeoutMs: liveAmbientStreamIdleTimeoutMs });
}

async function readAmbientResponseText(response: Response, options: { streamIdleTimeoutMs: number }): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string }; text?: string }> };
    return payload.choices?.[0]?.message?.content ?? payload.choices?.[0]?.text ?? "";
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let responseText = "";
  const consumeEvent = (eventText: string) => {
    for (const line of eventText.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice("data:".length).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string }; message?: { content?: string }; text?: string }> };
        for (const choice of chunk.choices ?? []) responseText += choice.delta?.content ?? choice.message?.content ?? choice.text ?? "";
      } catch {
        // Ignore stream keepalives; validation happens after parsing the final text.
      }
    }
  };
  while (true) {
    const { done, value } = await readAmbientStreamChunk(reader, options.streamIdleTimeoutMs, responseText.length);
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      events.forEach(consumeEvent);
    }
    if (done) break;
  }
  if (buffer.trim()) consumeEvent(buffer);
  return responseText;
}

async function readAmbientStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  streamIdleTimeoutMs: number,
  responseCharCount: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(
              `Ambient task-action stream stalled after ${streamIdleTimeoutMs.toLocaleString()}ms without streaming events ` +
                `(${responseCharCount.toLocaleString()} response characters received).`,
            ),
          );
        }, streamIdleTimeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function readLiveAmbientApiKey(): string {
  const explicit = process.env.AMBIENT_API_KEY || process.env.AMBIENT_AGENT_AMBIENT_API_KEY;
  if (explicit?.trim()) return explicit.trim();
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const candidates = [
    process.env.AMBIENT_API_KEY_FILE,
    join(repoRoot, "ignored-provider-key-file.txt"),
    join(dirname(repoRoot), "ignored-provider-key-file.txt"),
    join(dirname(dirname(repoRoot)), "ignored-provider-key-file.txt"),
    "/Users/example/Documents/ambientCoder/ignored-provider-key-file.txt",
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const key = readFileSync(candidate, "utf8").trim();
    if (key) return key;
  }
  throw new Error("Set AMBIENT_API_KEY, AMBIENT_API_KEY_FILE, or place ignored-provider-key-file.txt near the repo.");
}
