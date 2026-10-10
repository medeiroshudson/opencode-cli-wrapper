import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { wireClientDisconnect } from "../src/routes/chat.js";

const catalogFixture = [
  { canonical: "opencode/mimo-v2.6-flash-free", provider: "opencode", id: "mimo-v2.6-flash-free", limits: { context: 200000, input: 160000, output: 32000 } },
  { canonical: "opencode/space-bunny-free", provider: "opencode", id: "space-bunny-free", limits: null },
  { canonical: "opencode/claude-opus-5", provider: "opencode", id: "claude-opus-5", limits: { context: 100, input: null, output: 20 } },
];
const inboundHeaders = { authorization: "Bearer test-inbound-key" };

const { getCatalogMock, useRealCatalog, ensureReadyMock, callLog } = vi.hoisted(() => ({
  getCatalogMock: vi.fn(),
  useRealCatalog: { value: false },
  ensureReadyMock: vi.fn(),
  callLog: [] as string[],
}));

vi.mock("../src/lib/opencode/models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/opencode/models.js")>();
  return {
    ...actual,
    getCatalog: (client?: unknown, env?: NodeJS.ProcessEnv) =>
      useRealCatalog.value ? actual.getCatalog(undefined, env) : getCatalogMock(env),
  };
});

// The runtime module must hand back STABLE singletons: the route and the tests
// both resolve getServeClient() to the same object, so vi.spyOn in a test can
// intercept the very instance the route calls. ensureReady records into callLog
// so a test can pin that the daemon is made ready before the catalog is fetched.
vi.mock("../src/lib/serve/runtime.js", () => {
  const client = {
    health: async () => true,
    createSession: async () => "ses_test",
    postMessage: async () => ({ info: { finish: "stop" }, parts: [{ type: "text", text: "pong" }] }),
    deleteSession: async () => undefined,
    abortSession: async () => undefined,
  };
  const supervisor = {
    ensureReady: ensureReadyMock,
    baseUrl: () => "http://x",
    shutdown: async () => undefined,
  };
  return {
    getServeClient: () => client,
    getServeSupervisor: () => supervisor,
    resetRuntime: () => undefined,
  };
});

// Minimal response-like emitter for wireClientDisconnect: lets a test fire a
// "close" event without a real socket.
class FakeResponse {
  writableFinished = false;
  private readonly closeHandlers: Array<() => void> = [];
  on(event: "close", cb: () => void): void {
    if (event === "close") this.closeHandlers.push(cb);
  }
  emitClose(): void {
    for (const cb of this.closeHandlers) cb();
  }
}

describe("Routes (P6/P7)", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.stubEnv("API_KEY", "test-inbound-key");
    callLog.length = 0;
    ensureReadyMock.mockReset();
    ensureReadyMock.mockImplementation(async () => {
      callLog.push("ready");
    });
    getCatalogMock.mockReset();
    getCatalogMock.mockImplementation(async () => {
      callLog.push("catalog");
      return catalogFixture;
    });
    app = buildServer("test-inbound-key");
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllEnvs();
    useRealCatalog.value = false;
  });

  it("GET /v1/models returns only free ids without an upstream key", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/models", headers: inboundHeaders });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      object: "list",
      data: [
        { id: "mimo-v2.6-flash-free", object: "model", owned_by: "opencode", context_length: 200000, max_model_len: 200000, max_output_tokens: 32000, max_input_tokens: 160000 },
        { id: "space-bunny-free", object: "model", owned_by: "opencode" },
      ],
    });
  });

  it("GET /models.dev.json returns the full flat catalog", async () => {
    const res = await app.inject({ method: "GET", url: "/models.dev.json", headers: inboundHeaders });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      "mimo-v2.6-flash-free": {
        id: "mimo-v2.6-flash-free",
        limit: { context: 200000, input: 160000, output: 32000 },
      },
      "space-bunny-free": { id: "space-bunny-free" },
      "claude-opus-5": { id: "claude-opus-5", limit: { context: 100, output: 20 } },
    });
  });

  it("GET /models.dev.json maps catalog failure to an OpenAI 500 error", async () => {
    const { CatalogError } = await import("../src/lib/opencode/models.js");
    getCatalogMock.mockRejectedValueOnce(new CatalogError("catalog unavailable"));

    const res = await app.inject({ method: "GET", url: "/models.dev.json", headers: inboundHeaders });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { type: "server_error", code: "opencode_error" } });
  });

  it("GET /v1/models returns all catalog ids with x-opencode-key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { ...inboundHeaders, "x-opencode-key": "upstream-key" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((model: { id: string }) => model.id)).toEqual(
      catalogFixture.map((model) => model.id),
    );
  });

  it("GET /v1/models maps catalog failure to an OpenAI 500 error", async () => {
    const { CatalogError } = await import("../src/lib/opencode/models.js");
    getCatalogMock.mockRejectedValueOnce(new CatalogError("catalog unavailable"));

    const res = await app.inject({ method: "GET", url: "/v1/models", headers: inboundHeaders });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { type: "server_error", code: "opencode_error" } });
  });

  it("GET /health returns ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health", headers: inboundHeaders });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("rejects a body without messages with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: inboundHeaders,
      payload: { model: "mimo-v2.6-flash-free" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe("invalid_request_error");
  });

  it("rejects a model outside the visible catalog with 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: inboundHeaders,
      payload: { model: "opencode/claude-opus-5", messages: [{ role: "user", content: "hi" }] },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { type: "server_error", code: "opencode_error" } });
  });

  it("returns a non-stream completion via the serve client", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: inboundHeaders,
      payload: { model: "mimo-v2.6-flash-free", messages: [{ role: "user", content: "hi" }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
    });
  });

  it("maps an upstream serve failure to 502", async () => {
    const { getServeClient } = await import("../src/lib/serve/runtime.js");
    vi.spyOn(getServeClient(), "postMessage").mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: inboundHeaders,
      payload: { model: "mimo-v2.6-flash-free", messages: [{ role: "user", content: "hi" }] },
    });

    expect(res.statusCode).toBe(502);
  });

  it("makes the serve daemon ready before fetching the catalog on chat", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: inboundHeaders,
      payload: { model: "mimo-v2.6-flash-free", messages: [{ role: "user", content: "hi" }] },
    });

    expect(res.statusCode).toBe(200);
    expect(callLog).toEqual(["ready", "catalog"]);
  });

  it("makes the serve daemon ready before fetching the catalog on GET /v1/models", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/models", headers: inboundHeaders });

    expect(res.statusCode).toBe(200);
    expect(callLog).toEqual(["ready", "catalog"]);
  });

  it("streams incremental deltas ending with [DONE]", async () => {
    const { getServeClient } = await import("../src/lib/serve/runtime.js");
    const client = getServeClient() as unknown as { streamEvents: () => AsyncGenerator<unknown> };
    client.streamEvents = async function* () {
      yield { type: "message.part.delta", properties: { field: "text", delta: "he" } };
      yield { type: "message.part.delta", properties: { field: "text", delta: "llo" } };
      yield { type: "session.idle", properties: {} };
    } as never;

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: inboundHeaders,
      payload: { model: "mimo-v2.6-flash-free", messages: [{ role: "user", content: "hi" }], stream: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain('"content":"he"');
    expect(res.body).toContain('"content":"llo"');
    expect(res.body.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("aborts and deletes the session when the client disconnects", async () => {
    const { getServeClient } = await import("../src/lib/serve/runtime.js");
    const client = getServeClient();
    const deleteSpy = vi.spyOn(client, "deleteSession").mockResolvedValue(undefined);
    const abortSpy = vi.spyOn(client, "abortSession").mockResolvedValue(undefined);
    (client as unknown as { streamEvents: () => AsyncGenerator<unknown> }).streamEvents = async function* () {
      yield { type: "message.part.delta", properties: { field: "text", delta: "x" } };
      yield { type: "session.idle", properties: {} };
    } as never;

    const { runStreamingTurn } = await import("../src/lib/opencode/turn.js");
    await runStreamingTurn(client, {
      model: { providerID: "opencode", modelID: "mimo-v2.6-flash-free" },
      prompt: "hi",
      tools: [],
      toolChoice: "auto",
      onDelta: () => {
        throw Object.assign(new Error("client gone"), { code: "ABORT_ERR" });
      },
    }).catch(() => undefined);

    expect(abortSpy).toHaveBeenCalled();
    expect(deleteSpy).toHaveBeenCalled();
  });

  it("aborts and deletes the session when the event stream drops mid-turn", async () => {
    const { getServeClient } = await import("../src/lib/serve/runtime.js");
    const client = getServeClient();
    const abortSpy = vi.spyOn(client, "abortSession").mockResolvedValue(undefined);
    const deleteSpy = vi.spyOn(client, "deleteSession").mockResolvedValue(undefined);
    abortSpy.mockClear();
    deleteSpy.mockClear();
    (client as unknown as { streamEvents: () => AsyncGenerator<unknown> }).streamEvents = async function* () {
      yield { type: "message.part.delta", properties: { field: "text", delta: "x" } };
      throw new Error("event stream dropped");
    } as never;

    const { runStreamingTurn } = await import("../src/lib/opencode/turn.js");
    await runStreamingTurn(client, {
      model: { providerID: "opencode", modelID: "mimo-v2.6-flash-free" },
      prompt: "hi",
      tools: [],
      toolChoice: "auto",
      onDelta: () => {},
    }).catch(() => undefined);

    expect(abortSpy).toHaveBeenCalled();
    expect(deleteSpy).toHaveBeenCalled();
  });

  it("aborts and deletes the session when the caller signal is aborted", async () => {
    const { getServeClient } = await import("../src/lib/serve/runtime.js");
    const client = getServeClient();
    const abortSpy = vi.spyOn(client, "abortSession").mockResolvedValue(undefined);
    const deleteSpy = vi.spyOn(client, "deleteSession").mockResolvedValue(undefined);
    abortSpy.mockClear();
    deleteSpy.mockClear();
    (client as unknown as { streamEvents: () => AsyncGenerator<unknown> }).streamEvents = async function* () {
      yield { type: "message.part.delta", properties: { field: "text", delta: "x" } };
      yield { type: "session.idle", properties: {} };
    } as never;

    const { runStreamingTurn } = await import("../src/lib/opencode/turn.js");
    await runStreamingTurn(client, {
      model: { providerID: "opencode", modelID: "mimo-v2.6-flash-free" },
      prompt: "hi",
      tools: [],
      toolChoice: "auto",
      signal: AbortSignal.abort(),
      onDelta: () => {},
    }).catch(() => undefined);

    expect(abortSpy).toHaveBeenCalled();
    expect(deleteSpy).toHaveBeenCalled();
  });

  it("wireClientDisconnect aborts when the response closes unfinished (real disconnect)", () => {
    const res = new FakeResponse();
    res.writableFinished = false;
    const controller = new AbortController();

    wireClientDisconnect(res, controller);
    res.emitClose();

    expect(controller.signal.aborted).toBe(true);
  });

  it("wireClientDisconnect does not abort when the response finished normally", () => {
    const res = new FakeResponse();
    res.writableFinished = true;
    const controller = new AbortController();

    wireClientDisconnect(res, controller);
    res.emitClose();

    expect(controller.signal.aborted).toBe(false);
  });

  const itIntegration = process.env.INTEGRATION === "1" ? it : it.skip;

  itIntegration(
    "returns only free models without x-opencode-key and more models with x-opencode-key",
    async () => {
      useRealCatalog.value = true;
      const freeResponse = await app.inject({ method: "GET", url: "/v1/models", headers: inboundHeaders });

      expect(freeResponse.statusCode).toBe(200);
      const freeModels = freeResponse.json().data as Array<{ id: string }>;
      expect(freeModels.length).toBeGreaterThan(0);
      expect(freeModels.every((model) => model.id.endsWith("-free"))).toBe(true);

      const authenticatedResponse = await app.inject({
        method: "GET",
        url: "/v1/models",
        headers: { ...inboundHeaders, "x-opencode-key": "upstream-key" },
      });

      expect(authenticatedResponse.statusCode).toBe(200);
      const authenticatedModels = authenticatedResponse.json().data as Array<{ id: string }>;
      expect(authenticatedModels.length).toBeGreaterThan(freeModels.length);
    },
    120_000,
  );

  itIntegration(
    "rejects a non-free model without x-opencode-key",
    async () => {
      useRealCatalog.value = true;
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: inboundHeaders,
        payload: {
          model: "opencode/claude-opus-5",
          messages: [{ role: "user", content: "hi" }],
        },
      });

      expect(res.statusCode).toBe(404);
    },
    120_000,
  );

  itIntegration(
    "returns non-empty completion content for a free model (non-stream)",
    async () => {
      useRealCatalog.value = true;
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: inboundHeaders,
        payload: {
          model: "opencode/mimo-v2.6-flash-free",
          messages: [{ role: "user", content: "Responda apenas: ok" }],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.choices[0].message.content.length).toBeGreaterThan(0);
    },
    120_000,
  );

  itIntegration(
    "streams SSE ending with [DONE]",
    async () => {
      useRealCatalog.value = true;
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: inboundHeaders,
        payload: {
          model: "opencode/mimo-v2.6-flash-free",
          messages: [{ role: "user", content: "Responda apenas: ok" }],
          stream: true,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/event-stream");
      expect(res.body.endsWith("data: [DONE]\n\n")).toBe(true);
    },
    120_000,
  );

});
