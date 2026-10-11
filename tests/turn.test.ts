import { afterEach, describe, expect, it, vi } from "vitest";
import { ServeClient } from "../src/lib/serve/client.js";
import { runTurn, runStreamingTurn, TurnFailedError } from "../src/lib/opencode/turn.js";
import { startFakeServe } from "./helpers/fake-serve.js";
import { toOpenAIErrorBody } from "../src/lib/openai-format/index.js";

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

// The serve reports a failed generation inside a 200 (info.error), the shape of a
// schema rejection or a rate limit from the upstream provider. assemble() must
// throw, not return an empty completion that looks like a model refusal.
describe("runTurn surfaces upstream info.error", () => {
  const turnParams = {
    model: { providerID: "opencode", modelID: "mimo-v2.6-flash-free" },
    prompt: "hi",
    tools: [],
    toolChoice: "auto",
  };

  function failingClient(info: Record<string, unknown>): ServeClient {
    return {
      createSession: async () => "ses_err",
      postMessage: async () => ({ info, parts: [] }),
      deleteSession: async () => undefined,
    } as unknown as ServeClient;
  }

  it("rejects with TurnFailedError carrying the upstream message and status", async () => {
    const client = failingClient({
      finish: "error",
      error: { name: "APIError", data: { message: "Thinking mode does not support this tool_choice", statusCode: 400 } },
    });
    const deleteSpy = vi.spyOn(client, "deleteSession").mockResolvedValue(undefined);

    await expect(runTurn(client, turnParams)).rejects.toMatchObject({
      name: "TurnFailedError",
      statusCode: 400,
      message: "Thinking mode does not support this tool_choice",
    });
    // The session is still cleaned up when the turn fails.
    expect(deleteSpy).toHaveBeenCalledWith("ses_err");
  });

  it("falls back to the error name when data.message is absent", async () => {
    const client = failingClient({ error: { name: "ProviderModelNotFoundError", data: {} } });
    await expect(runTurn(client, turnParams)).rejects.toMatchObject({
      name: "TurnFailedError",
      statusCode: null,
      message: "ProviderModelNotFoundError",
    });
  });

  it("does not fire for a normal response (no regression on the happy path)", async () => {
    const client = failingClient({ finish: "stop", tokens: { input: 1, output: 1 } });
    const result = await runTurn(client, turnParams);
    expect(result.content).toBe("");
    expect(result.finish_reason).toBe("stop");
    expect(result).not.toBeInstanceOf(TurnFailedError);
  });

  it("the mapped status survives toOpenAIErrorBody as a 4xx", async () => {
    const client = failingClient({ error: { name: "APIError", data: { message: "bad schema", statusCode: 400 } } });
    const error = await runTurn(client, turnParams).catch((e: unknown) => e);
    const mapped = toOpenAIErrorBody(error, 502);
    expect(mapped.status).toBe(400);
    expect(mapped.body.error.type).toBe("invalid_request_error");
  });
});