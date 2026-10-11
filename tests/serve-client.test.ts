import { afterEach, describe, expect, it } from "vitest";
import { ServeClient, ServeHttpError } from "../src/lib/serve/client.js";
import { startFakeServe } from "./helpers/fake-serve.js";

let closeFns: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closeFns.map((fn) => fn()));
  closeFns = [];
});

async function clientFor(overrides = {}) {
  const fake = await startFakeServe(overrides);
  closeFns.push(fake.close);
  return { client: new ServeClient({ baseUrl: fake.url, timeoutMs: 5000 }), fake };
}

describe("ServeClient", () => {
  it("reports health", async () => {
    const { client } = await clientFor();
    expect(await client.health()).toBe(true);
  });

  it("reads the provider catalog with limits", async () => {
    const { client } = await clientFor();
    const catalog = await client.catalog();
    expect(catalog.providers[0]?.id).toBe("opencode");
    expect(catalog.providers[0]?.models["mimo-v2.6-flash-free"]?.limit).toEqual({
      context: 200000,
      output: 32000,
    });
  });

  it("creates a session, posts a message and deletes the session", async () => {
    const { client, fake } = await clientFor();
    const sid = await client.createSession();
    const res = await client.postMessage(sid, { parts: [{ type: "text", text: "hi" }] });
    expect(res.parts?.[0]?.text).toBe("pong");
    await client.deleteSession(sid);
    expect(fake.calls.createSession).toBe(1);
    expect(fake.calls.message).toBe(1);
    expect(fake.calls.deleteSession).toBe(1);
  });

  it("streams serve events from the global event endpoint", async () => {
    const { client } = await clientFor();
    const seen: string[] = [];
    for await (const ev of client.streamEvents()) seen.push(ev.type);
    expect(seen).toContain("message.part.delta");
    expect(seen).toContain("session.idle");
  });

  it("bounds the event stream by idleness, not by total duration", async () => {
    const encoder = new TextEncoder();
    const event = `data: ${JSON.stringify({ type: "server.heartbeat", properties: {} })}\n\n`;

    // Events every 30ms for 150ms total: longer than the 100ms window, but never
    // idle for 100ms, so a whole-stream deadline would cut it and this must not.
    const steady = new ServeClient({
      baseUrl: "http://x",
      timeoutMs: 100,
      fetchImpl: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              for (let i = 0; i < 5; i++) {
                await new Promise((resolve) => setTimeout(resolve, 30));
                controller.enqueue(encoder.encode(event));
              }
              controller.close();
            },
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    const seen: string[] = [];
    for await (const ev of steady.streamEvents()) seen.push(ev.type);
    expect(seen).toHaveLength(5);

    // One event, then silence forever: the idle window must abort it.
    const silent = new ServeClient({
      baseUrl: "http://x",
      timeoutMs: 100,
      fetchImpl: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(event));
            },
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    const drain = async (): Promise<void> => {
      for await (const _ev of silent.streamEvents()) void _ev;
    };
    await expect(drain()).rejects.toThrow();
  });

  it("raises ServeHttpError with the upstream status", async () => {
    const { client } = await clientFor({ failMessage: 500 });
    const sid = await client.createSession();
    await expect(client.postMessage(sid, { parts: [] })).rejects.toBeInstanceOf(ServeHttpError);
  });
});