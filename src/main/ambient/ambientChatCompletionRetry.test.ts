import { describe, expect, it } from "vitest";
import { aggressiveAmbientRetryPolicy } from "./aggressiveRetries";
import {
  ambientChatCompletionTransportTimeoutsFromEnv,
  callAmbientChatCompletionTextWithRetries,
  type AmbientChatCompletionRetryEvent,
} from "./ambientChatCompletionRetry";

describe("callAmbientChatCompletionTextWithRetries", () => {
  it("uses bounded direct-helper transport timeouts for the GMI Cloud override", () => {
    expect(ambientChatCompletionTransportTimeoutsFromEnv({ AMBIENT_PROVIDER: "gmi-cloud" } as NodeJS.ProcessEnv)).toEqual({
      preStreamResponseTimeoutMs: 60_000,
      streamIdleTimeoutMs: 120_000,
      streamContentIdleTimeoutMs: 120_000,
    });
  });

  it("allows direct-helper transport timeout overrides", () => {
    expect(
      ambientChatCompletionTransportTimeoutsFromEnv({
        AMBIENT_PROVIDER: "gmi-cloud",
        AMBIENT_DIRECT_HELPER_PRE_STREAM_TIMEOUT_MS: "3456",
        AMBIENT_DIRECT_HELPER_STREAM_IDLE_TIMEOUT_MS: "4567",
        AMBIENT_DIRECT_HELPER_STREAM_CONTENT_IDLE_TIMEOUT_MS: "5678",
      } as NodeJS.ProcessEnv),
    ).toEqual({
      preStreamResponseTimeoutMs: 3456,
      streamIdleTimeoutMs: 4567,
      streamContentIdleTimeoutMs: 5678,
    });
  });

  it("does not retry interrupted partial streams unless the caller opts in", async () => {
    let calls = 0;
    const retryDelays: number[] = [];

    await expect(
      callAmbientChatCompletionTextWithRetries({
        apiKey: "ambient-test-key",
        baseUrl: "https://ambient.example/v1",
        label: "Ambient direct helper",
        requestBody: { model: "zai-org/GLM-5.1-FP8", messages: [], stream: true },
        retryPolicy: aggressiveAmbientRetryPolicy(),
        waitForRetry: async (delayMs) => {
          retryDelays.push(delayMs);
        },
        fetchImpl: async () => {
          calls += 1;
          return streamingTextResponse(["{\"partial\":"], false);
        },
      }),
    ).rejects.toThrow("Ambient stream ended before completion.");

    expect(calls).toBe(1);
    expect(retryDelays).toEqual([]);
  });

  it("retries interrupted partial streams for side-effect-free direct helpers that opt in", async () => {
    let calls = 0;
    const retryDelays: number[] = [];
    const retryEvents: AmbientChatCompletionRetryEvent[] = [];
    const progressEvents: number[] = [];
    const recovered = "{\"ok\":true}";

    const text = await callAmbientChatCompletionTextWithRetries({
      apiKey: "ambient-test-key",
      baseUrl: "https://ambient.example/v1",
      label: "Ambient direct helper",
      requestBody: { model: "zai-org/GLM-5.1-FP8", messages: [], stream: true },
      retryPolicy: aggressiveAmbientRetryPolicy(),
      retryPartialStreamFailures: true,
      waitForRetry: async (delayMs) => {
        retryDelays.push(delayMs);
      },
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return streamingTextResponse(["{\"partial\":"], false);
        return streamingTextResponse([recovered], true);
      },
      onRetry: (event) => retryEvents.push(event),
      onResponseChars: (responseCharCount) => progressEvents.push(responseCharCount),
    });

    expect(text).toBe(recovered);
    expect(calls).toBe(2);
    expect(retryDelays).toEqual([1_000]);
    expect(retryEvents).toEqual([
      expect.objectContaining({
        retryAttempt: 1,
        maxRetries: 10,
        delayMs: 1_000,
        responseCharCount: "{\"partial\":".length,
        error: "Ambient stream ended before completion.",
      }),
    ]);
    expect(progressEvents).toEqual(["{\"partial\":".length, recovered.length]);
  });

  it("retries keepalive-only streams when the content-idle watchdog fires before the body-idle watchdog", async () => {
    let calls = 0;
    const retryDelays: number[] = [];
    const retryEvents: AmbientChatCompletionRetryEvent[] = [];
    const recovered = "{\"ok\":true}";

    const text = await callAmbientChatCompletionTextWithRetries({
      apiKey: "ambient-test-key",
      baseUrl: "https://ambient.example/v1",
      label: "Ambient direct helper",
      requestBody: { model: "zai-org/GLM-5.1-FP8", messages: [], stream: true },
      retryPolicy: aggressiveAmbientRetryPolicy({ maxRetries: 1, backoffMs: [0] }),
      waitForRetry: async (delayMs) => {
        retryDelays.push(delayMs);
      },
      streamIdleTimeoutMs: 100,
      streamContentIdleTimeoutMs: 10,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return keepaliveOnlyStreamingResponse();
        return streamingTextResponse([recovered], true);
      },
      onRetry: (event) => retryEvents.push(event),
    });

    expect(text).toBe(recovered);
    expect(calls).toBe(2);
    expect(retryDelays).toEqual([0]);
    expect(retryEvents).toEqual([
      expect.objectContaining({
        retryAttempt: 1,
        maxRetries: 1,
        delayMs: 0,
        responseCharCount: 0,
        error: "Ambient direct helper stream stalled after 10ms without model content (0 response characters received).",
      }),
    ]);
  });

  it("does not count valid non-text stream payloads as direct-helper answer content", async () => {
    const requestStreams: unknown[] = [];
    const retryEvents: AmbientChatCompletionRetryEvent[] = [];
    const recovered = "{\"ok\":true}";

    const text = await callAmbientChatCompletionTextWithRetries({
      apiKey: "ambient-test-key",
      baseUrl: "https://ambient.example/v1",
      label: "Ambient direct helper",
      requestBody: { model: "zai-org/GLM-5.1-FP8", messages: [], stream: true },
      retryPolicy: aggressiveAmbientRetryPolicy({ maxRetries: 1, backoffMs: [0] }),
      nonStreamFallback: { enabled: true, afterStreamFailureCount: 1 },
      waitForRetry: async () => undefined,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requestStreams.push(body.stream);
        if (requestStreams.length === 1) return metadataOnlyStreamingResponse();
        return jsonTextResponse(recovered);
      },
      streamIdleTimeoutMs: 100,
      streamContentIdleTimeoutMs: 20,
      onRetry: (event) => retryEvents.push(event),
    });

    expect(text).toBe(recovered);
    expect(requestStreams).toEqual([true, false]);
    expect(retryEvents).toEqual([
      expect.objectContaining({
        retryAttempt: 1,
        fallbackToNonStream: true,
        error: "Ambient direct helper stream stalled after 20ms without model content (0 response characters received).",
      }),
    ]);
  });

  it("switches side-effect-free direct helpers to non-stream fallback after repeated stream failures", async () => {
    let calls = 0;
    const requestStreams: unknown[] = [];
    const retryDelays: number[] = [];
    const retryEvents: AmbientChatCompletionRetryEvent[] = [];
    const recovered = "{\"ok\":true}";

    const text = await callAmbientChatCompletionTextWithRetries({
      apiKey: "ambient-test-key",
      baseUrl: "https://ambient.example/v1",
      label: "Ambient direct helper",
      requestBody: { model: "zai-org/GLM-5.1-FP8", messages: [], stream: true },
      retryPolicy: aggressiveAmbientRetryPolicy(),
      retryPartialStreamFailures: true,
      nonStreamFallback: { enabled: true, afterStreamFailureCount: 2 },
      waitForRetry: async (delayMs) => {
        retryDelays.push(delayMs);
      },
      fetchImpl: async (_url, init) => {
        calls += 1;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requestStreams.push(body.stream);
        if (calls <= 2) return keepaliveOnlyStreamingResponse();
        return jsonTextResponse(recovered);
      },
      streamIdleTimeoutMs: 100,
      streamContentIdleTimeoutMs: 10,
      onRetry: (event) => retryEvents.push(event),
    });

    expect(text).toBe(recovered);
    expect(requestStreams).toEqual([true, true, false]);
    expect(retryDelays).toEqual([1_000, 2_000]);
    expect(retryEvents).toEqual([
      expect.objectContaining({
        retryAttempt: 1,
        fallbackToNonStream: false,
      }),
      expect.objectContaining({
        retryAttempt: 2,
        fallbackToNonStream: true,
      }),
    ]);
  });

  it("switches side-effect-free direct helpers to non-stream fallback after repeated streamed validation failures", async () => {
    let calls = 0;
    const requestStreams: unknown[] = [];
    const retryDelays: number[] = [];
    const retryEvents: AmbientChatCompletionRetryEvent[] = [];
    const recovered = "{\"ok\":true}";

    const text = await callAmbientChatCompletionTextWithRetries({
      apiKey: "ambient-test-key",
      baseUrl: "https://ambient.example/v1",
      label: "Ambient direct helper",
      requestBody: { model: "zai-org/GLM-5.1-FP8", messages: [], stream: true },
      retryPolicy: aggressiveAmbientRetryPolicy(),
      retryPartialStreamFailures: true,
      nonStreamFallback: { enabled: true, afterStreamFailureCount: 2 },
      waitForRetry: async (delayMs) => {
        retryDelays.push(delayMs);
      },
      fetchImpl: async (_url, init) => {
        calls += 1;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requestStreams.push(body.stream);
        if (calls <= 2) return streamingTextResponse(["not json"], true);
        return jsonTextResponse(recovered);
      },
      validateResponseText: (responseText) => {
        JSON.parse(responseText);
      },
      onRetry: (event) => retryEvents.push(event),
    });

    expect(text).toBe(recovered);
    expect(requestStreams).toEqual([true, true, false]);
    expect(retryDelays).toEqual([1_000, 2_000]);
    expect(retryEvents).toEqual([
      expect.objectContaining({
        retryAttempt: 1,
        fallbackToNonStream: false,
        error: expect.stringContaining("response validation failed"),
      }),
      expect.objectContaining({
        retryAttempt: 2,
        fallbackToNonStream: true,
        error: expect.stringContaining("response validation failed"),
      }),
    ]);
  });

  it("retries opt-in response validation failures inside the retry envelope", async () => {
    let calls = 0;
    const retryDelays: number[] = [];
    const retryEvents: AmbientChatCompletionRetryEvent[] = [];
    const invalid = "not json";
    const recovered = "{\"ok\":true}";

    const text = await callAmbientChatCompletionTextWithRetries({
      apiKey: "ambient-test-key",
      baseUrl: "https://ambient.example/v1",
      label: "Ambient direct helper",
      requestBody: { model: "zai-org/GLM-5.1-FP8", messages: [], stream: false },
      retryPolicy: aggressiveAmbientRetryPolicy(),
      waitForRetry: async (delayMs) => {
        retryDelays.push(delayMs);
      },
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return jsonTextResponse(invalid);
        return jsonTextResponse(recovered);
      },
      validateResponseText: (responseText) => {
        JSON.parse(responseText);
      },
      onRetry: (event) => retryEvents.push(event),
    });

    expect(text).toBe(recovered);
    expect(calls).toBe(2);
    expect(retryDelays).toEqual([1_000]);
    expect(retryEvents).toEqual([
      expect.objectContaining({
        retryAttempt: 1,
        maxRetries: 10,
        delayMs: 1_000,
        responseCharCount: invalid.length,
        error: expect.stringContaining("response validation failed"),
      }),
    ]);
  });

  it("retries terminated non-stream response bodies", async () => {
    let calls = 0;
    const retryDelays: number[] = [];
    const recovered = "{\"ok\":true}";

    const text = await callAmbientChatCompletionTextWithRetries({
      apiKey: "ambient-test-key",
      baseUrl: "https://ambient.example/v1",
      label: "Ambient direct helper",
      requestBody: { model: "zai-org/GLM-5.1-FP8", messages: [], stream: false },
      retryPolicy: aggressiveAmbientRetryPolicy(),
      waitForRetry: async (delayMs) => {
        retryDelays.push(delayMs);
      },
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return terminatedJsonResponse();
        return jsonTextResponse(recovered);
      },
    });

    expect(text).toBe(recovered);
    expect(calls).toBe(2);
    expect(retryDelays).toEqual([1_000]);
  });
});

function streamingTextResponse(chunks: string[], done: boolean): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`));
        }
        if (done) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

function keepaliveOnlyStreamingResponse(): Response {
  let interval: ReturnType<typeof setInterval> | undefined;
  return new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        interval = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            if (interval) clearInterval(interval);
          }
        }, 2);
      },
      cancel() {
        if (interval) clearInterval(interval);
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

function metadataOnlyStreamingResponse(): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        void (async () => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`));
          await new Promise((resolve) => setTimeout(resolve, 15));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {} }] })}\n\n`));
        })().catch((error) => controller.error(error));
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

function jsonTextResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content,
          },
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function terminatedJsonResponse(): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new TypeError("terminated"));
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
