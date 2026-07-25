import { randomUUID } from "node:crypto";

import type { Model } from "@mariozechner/pi-ai";

const AMBIENT_TRANSPORT_CHANNEL_HEADER = "x-ambient-desktop-transport-channel";

export type AmbientProviderTransportActivity =
  | { kind: "request_prepared"; inputTokens: number }
  | { kind: "response_headers" }
  | { kind: "body"; bytes: number };

export interface AmbientProviderTransportChannel {
  publish: (activity: AmbientProviderTransportActivity) => void;
  subscribe: (listener: (activity: AmbientProviderTransportActivity) => void) => () => void;
}

type AmbientProviderTransportChannelInternal = AmbientProviderTransportChannel & {
  id: string;
};

const channelsById = new Map<string, WeakRef<AmbientProviderTransportChannelInternal>>();
const channelsBySession = new WeakMap<object, AmbientProviderTransportChannel>();
const idsByChannel = new WeakMap<AmbientProviderTransportChannel, string>();
let transportFetchInstalled = false;

function byteLength(chunk: unknown): number {
  if (typeof chunk === "string") return Buffer.byteLength(chunk);
  if (chunk instanceof ArrayBuffer) return chunk.byteLength;
  if (ArrayBuffer.isView(chunk)) return chunk.byteLength;
  return 0;
}

function channelIdFromHeaders(input: RequestInfo | URL, init?: RequestInit): string | undefined {
  const sourceHeaders = init?.headers ?? (input instanceof Request ? input.headers : undefined);
  if (!sourceHeaders) return undefined;
  return new Headers(sourceHeaders).get(AMBIENT_TRANSPORT_CHANNEL_HEADER) ?? undefined;
}

function requestWithoutTransportHeader(
  input: RequestInfo | URL,
  init?: RequestInit,
): [RequestInfo | URL, RequestInit?] {
  const sourceHeaders = init?.headers ?? (input instanceof Request ? input.headers : undefined);
  const headers = new Headers(sourceHeaders);
  headers.delete(AMBIENT_TRANSPORT_CHANNEL_HEADER);
  if (input instanceof Request) {
    return [new Request(input, { ...init, headers })];
  }
  return [input, { ...init, headers }];
}

function responseWithObservedBody(response: Response, onBody: (bytes: number) => void): Response {
  if (!response.body) return response;
  const observedBody = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const bytes = byteLength(chunk);
        if (bytes > 0) onBody(bytes);
        controller.enqueue(chunk);
      },
    }),
  );
  const observedResponse = new Response(observedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperties(observedResponse, {
    url: { value: response.url },
    redirected: { value: response.redirected },
    type: { value: response.type },
  });
  return observedResponse;
}

export function createAmbientProviderTransportFetch(
  fetchImpl: typeof fetch,
  resolveChannel: (id: string) => AmbientProviderTransportChannel | undefined,
): typeof fetch {
  return async (input, init) => {
    const channelId = channelIdFromHeaders(input, init);
    if (!channelId) return fetchImpl(input, init);
    const channel = resolveChannel(channelId);
    const [nextInput, nextInit] = requestWithoutTransportHeader(input, init);
    const response = await fetchImpl(nextInput, nextInit);
    channel?.publish({ kind: "response_headers" });
    return responseWithObservedBody(response, (bytes) => channel?.publish({ kind: "body", bytes }));
  };
}

function installAmbientProviderTransportFetch(): void {
  if (transportFetchInstalled) return;
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = createAmbientProviderTransportFetch(originalFetch, (id) => {
    const reference = channelsById.get(id);
    const channel = reference?.deref();
    if (!channel && reference) channelsById.delete(id);
    return channel;
  });
  transportFetchInstalled = true;
}

export function createAmbientProviderTransportChannel(
  model: Model<"openai-completions">,
): AmbientProviderTransportChannel {
  installAmbientProviderTransportFetch();
  const listeners = new Set<(activity: AmbientProviderTransportActivity) => void>();
  const channel: AmbientProviderTransportChannelInternal = {
    id: randomUUID(),
    publish(activity) {
      for (const listener of listeners) {
        try {
          listener(activity);
        } catch {
          // Transport observation must never disrupt the provider stream.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  channelsById.set(channel.id, new WeakRef(channel));
  idsByChannel.set(channel, channel.id);
  attachAmbientProviderTransportChannel(model, channel);
  return channel;
}

function attachAmbientProviderTransportChannel(
  model: Model<"openai-completions">,
  channel: AmbientProviderTransportChannel,
): void {
  const channelId = idsByChannel.get(channel);
  if (!channelId) return;
  model.headers = {
    ...model.headers,
    [AMBIENT_TRANSPORT_CHANNEL_HEADER]: channelId,
  };
}

export function bindAmbientProviderTransportChannel(session: object, channel: AmbientProviderTransportChannel): void {
  channelsBySession.set(session, channel);
}

export function attachAmbientProviderTransportChannelForSession(
  model: Model<"openai-completions">,
  session: object,
): void {
  const channel = channelsBySession.get(session);
  if (channel) attachAmbientProviderTransportChannel(model, channel);
}

export function subscribeAmbientProviderTransportActivity(
  session: object,
  listener: (activity: AmbientProviderTransportActivity) => void,
): () => void {
  return channelsBySession.get(session)?.subscribe(listener) ?? (() => undefined);
}
