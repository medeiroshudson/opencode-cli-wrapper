import { afterEach, describe, expect, it, vi } from "vitest";
import { ServeClient } from "../src/lib/serve/client.js";
import { runStreamingTurn } from "../src/lib/opencode/turn.js";
import { startFakeServe } from "./helpers/fake-serve.js";

let closeFns: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closeFns.map((fn) => fn()));
  closeFns = [];
});

describe("runStreamingTurn wall-clock timeout (C1)", () => {
  it("gives up when the stream never ends and the message POST already failed", async () => {
    // The upstream rejects the message fast (the shape of a 5xx/429/bad model), while
    // the SSE subscription stays open and never delivers a terminal event.
    const fake = await startFakeServe({ hangEventStream: true, failMessage: 500 });
    closeFns.push(fake.close);
    const client = new ServeClient({ baseUrl: fake.url, timeoutMs: 120 });
    const abortSpy = vi.spyOn(client, "abortSession").mockResolvedValue(undefined);
    const deleteSpy = vi.spyOn(client, "deleteSession").mockResolvedValue(undefined);

    const started = Date.now();
    const turn = runStreamingTurn(client, {
      model: { providerID: "opencode", modelID: "mimo-v2.6-flash-free" },
      prompt: "hi",
      tools: [],
      toolChoice: "auto",
      onDelta: () => undefined,
    });

    await expect(turn).rejects.toThrow();
    // Bounded by the client timeout, not by the (endless) upstream stream.
    expect(Date.now() - started).toBeLessThan(5000);
    expect(abortSpy).toHaveBeenCalledWith("ses_fake");
    expect(deleteSpy).toHaveBeenCalledWith("ses_fake");
  });
});