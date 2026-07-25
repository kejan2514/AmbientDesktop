import { describe, expect, it, vi } from "vitest";
import type { Model } from "@mariozechner/pi-ai";

import {
  attachAmbientProviderTransportChannelForSession,
  bindAmbientProviderTransportChannel,
  createAmbientProviderTransportChannel,
  createAmbientProviderTransportFetch,
} from "./ambientProviderTransportActivity";

describe("ambientProviderTransportActivity", () => {
  it("strips the private routing header and reports response headers plus every raw body chunk", async () => {
    const activities: unknown[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).has("x-ambient-desktop-transport-channel")).toBe(false);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
            controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    const observedFetch = createAmbientProviderTransportFetch(fetchImpl as typeof fetch, (id) =>
      id === "channel-1"
        ? { publish: (activity) => activities.push(activity), subscribe: () => () => undefined }
        : undefined,
    );

    const response = await observedFetch("https://ambient.example/v1/chat/completions", {
      headers: { "x-ambient-desktop-transport-channel": "channel-1", authorization: "Bearer test" },
    });
    await response.text();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(activities).toEqual([
      { kind: "response_headers" },
      { kind: "body", bytes: 13 },
      { kind: "body", bytes: 10 },
    ]);
  });

  it("leaves unrelated fetches untouched", async () => {
    const response = new Response("ok");
    const fetchImpl = vi.fn(async () => response);
    const observedFetch = createAmbientProviderTransportFetch(fetchImpl as typeof fetch, () => undefined);
    const init = { headers: { authorization: "Bearer test" } };

    await expect(observedFetch("https://example.com", init)).resolves.toBe(response);
    expect(fetchImpl).toHaveBeenCalledWith("https://example.com", init);
  });

  it("carries the same private channel onto models switched within a session", () => {
    const firstModel = { headers: { "x-existing": "yes" } } as unknown as Model<"openai-completions">;
    const nextModel = {} as Model<"openai-completions">;
    const session = {};
    const channel = createAmbientProviderTransportChannel(firstModel);
    bindAmbientProviderTransportChannel(session, channel);
    channel.subscribe(() => {
      throw new Error("observer failure");
    });

    attachAmbientProviderTransportChannelForSession(nextModel, session);
    expect(() => channel.publish({ kind: "body", bytes: 1 })).not.toThrow();

    const firstChannelId = firstModel.headers?.["x-ambient-desktop-transport-channel"];
    expect(firstChannelId).toEqual(expect.any(String));
    expect(nextModel.headers?.["x-ambient-desktop-transport-channel"]).toBe(firstChannelId);
    expect(firstModel.headers?.["x-existing"]).toBe("yes");
  });
});
