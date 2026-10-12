import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { wireClientDisconnect } from "../src/routes/chat.js";
import { getServeClient } from "../src/lib/serve/runtime.js";

const catalogFixture = [
  { canonical: "opencode/mimo-v2.6-flash-free", provider: "opencode", id: "mimo-v2.6-flash-free", limits: { context: 200000, input: 160000, output: 32000 } },
  { canonical: "opencode/space-bunny-free", provider: "opencode", id: "space-bunny-free", limits: null },
  { canonical: "opencode/claude-opus-5", provider: "opencode", id: "claude-opus-5", limits: { context: 100, input: null, output: 20 } },
];
const inboundHeaders = { authorization: "Bearer test-inbound-key" };

const WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a location.",
    parameters: { type: "object", properties: { location: { type: "string" } }, required: ["location"] },
  },
};

interface SseChunk {
  choices: Array<{ delta: { content?: string; tool_calls?: Array<{ function: { name: string } }> }; finish_reason: string | null }>;
}

function sseChunks(body: string): SseChunk[] {
  return body
    .split("\n\n")
    .filter((block) => block.startsWith("data: ") && !block.includes("[DONE]"))
    .map((block) => JSON.parse(block.slice("data: ".length)) as SseChunk);
}

function contentDeltas(body: string): string[] {
  return sseChunks(body)
    .map((chunk) => chunk.choices[0]?.delta.content)
    .filter((value): value is string => typeof value === "string");
}

// The serve event shapes the mocked stream must speak: a text part is announced
// before its deltas, and the turn ends on session.idle (NOT message.updated, which
// fires for the user's own message).
const textPart = () => ({ type: "message.part.updated", properties: { sessionID: "ses_test", part: { id: "prt_1", type: "text", text: "" } } });
const delta = (d: string) => ({ type: "message.part.delta", properties: { sessionID: "ses_test", partID: "prt_1", field: "text", delta: d } });
const idleEvent = () => ({ type: "session.idle", properties: { sessionID: "ses_test" } });

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
    // The runtime mock hands back ONE shared client for the whole file, so a spy
    // installed by one test would otherwise leak into the next. Restore the
    // defaults here; each test that needs a different shape spies on top.
    const client = getServeClient() as unknown as Record<string, unknown>;
    client.createSession = async () => "ses_test";
    client.postMessage = async () => ({ info: { finish: "stop" }, parts: [{ type: "text", text: "pong" }] });
    client.deleteSession = async () => undefined;
    client.abortSession = async () => undefined;
    delete client.streamEvents;
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

  it("GET /v1/models returns the full catalog", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/models", headers: inboundHeaders });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      object: "list",
      data: [
        { id: "mimo-v2.6-flash-free", object: "model", owned_by: "opencode", context_length: 200000, max_model_len: 200000, max_output_tokens: 32000, max_input_tokens: 160000 },
        { id: "space-bunny-free", object: "model", owned_by: "opencode" },
        { id: "claude-opus-5", object: "model", owned_by: "opencode", context_length: 100, max_model_len: 100, max_output_tokens: 20 },
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

  it("accepts Anthropic-style block arrays as message content", async () => {
    const postSpy = vi.spyOn(getServeClient(), "postMessage");
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: inboundHeaders,
      payload: {
        model: "mimo-v2.6-flash-free",
        messages: [
          { role: "system", content: [{ type: "text", text: "" }, { type: "text", text: "be terse" }] },
          { role: "user", content: "hi" },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const prompt = (postSpy.mock.calls[0]?.[1] as { parts: Array<{ text: string }> }).parts[0]?.text ?? "";
    expect(prompt).toContain("System: be terse");
    expect(prompt).not.toContain("[object Object]");
  });

  it("answers the last user turn when a trailing system turn is present", async () => {
    const postSpy = vi.spyOn(getServeClient(), "postMessage");
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: inboundHeaders,
      payload: {
        model: "mimo-v2.6-flash-free",
        messages: [
          { role: "user", content: "Temos uma api nativa da Apple para TTS?" },
          { role: "system", content: "SessionStart hook: superpowers enabled" },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const prompt = (postSpy.mock.calls[0]?.[1] as { parts: Array<{ text: string }> }).parts[0]?.text ?? "";
    expect(prompt.endsWith("Question: Temos uma api nativa da Apple para TTS?")).toBe(true);
    expect(prompt).not.toContain("Question: SessionStart hook");
  });

  it("rejects a model absent from the catalog with 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: inboundHeaders,
      payload: { model: "opencode/unknown-model", messages: [{ role: "user", content: "hi" }] },
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
      yield textPart();
      yield delta("he");
      yield delta("llo");
      yield idleEvent();
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
      yield textPart();
      yield delta("x");
      yield idleEvent();
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
      yield textPart();
      yield delta("x");
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
      yield textPart();
      yield delta("x");
      yield idleEvent();
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

  it("emits tool_calls (and no fence content) when streaming a required tool_choice", async () => {
    const { getServeClient } = await import("../src/lib/serve/runtime.js");
    const client = getServeClient();
    // A required turn is schema-constrained: it answers with a tool call, not prose,
    // so nothing is streamed and the call comes from the buffered response.
    const postSpy = vi.spyOn(client, "postMessage").mockResolvedValueOnce({
      info: { finish: "tool-calls", structured: { name: "get_weather", arguments: '{"location":"Paris"}' } },
      parts: [{ type: "step-start" }],
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: inboundHeaders,
      payload: {
        model: "mimo-v2.6-flash-free",
        messages: [{ role: "user", content: "weather in Paris?" }],
        stream: true,
        tools: [WEATHER_TOOL],
        tool_choice: "required",
      },
    });

    expect(res.statusCode).toBe(200);
    // A required turn is constrained by the serve JSON schema, not by the fence prompt.
    expect(postSpy.mock.calls[0]?.[1]).toMatchObject({ format: { type: "json_schema", retryCount: 2 } });
    const chunks = sseChunks(res.body);
    expect(chunks.some((chunk) => chunk.choices[0]?.delta.tool_calls?.[0]?.function.name === "get_weather")).toBe(true);
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("tool_calls");
    // The fence must never be forwarded as content as well.
    expect(contentDeltas(res.body).join("")).not.toContain("tool_call");
    expect(contentDeltas(res.body)).toEqual([]);
    expect(res.body.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("streams plain content and no tool_calls for tool_choice auto", async () => {
    const { getServeClient } = await import("../src/lib/serve/runtime.js");
    const client = getServeClient();
    (client as unknown as { streamEvents: () => AsyncGenerator<unknown> }).streamEvents = async function* () {
      yield textPart();
      yield delta("he");
      yield delta("llo");
      yield idleEvent();
    } as never;

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: inboundHeaders,
      payload: {
        model: "mimo-v2.6-flash-free",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        tools: [WEATHER_TOOL],
        tool_choice: "auto",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(contentDeltas(res.body)).toEqual(["he", "llo"]);
    expect(res.body).not.toContain("tool_calls");
  });

  it("holds a fenced tool_call back from streamed content in auto mode", async () => {
    const { getServeClient } = await import("../src/lib/serve/runtime.js");
    const client = getServeClient();
    (client as unknown as { streamEvents: () => AsyncGenerator<unknown> }).streamEvents = async function* () {
      yield textPart();
      yield delta("Let me check.\n``");
      yield delta("`tool_call\n");
      yield delta('{"name":"get_weather","arguments":{"location":"Paris"}}');
      yield delta("\n``");
      yield delta("`");
      yield idleEvent();
    } as never;
    // The buffered response carries the same text the stream did (the real serve
    // returns the finished message), which is where the tool call is parsed from.
    vi.spyOn(client, "postMessage").mockResolvedValueOnce({
      info: { finish: "stop" },
      parts: [{ type: "text", text: 'Let me check.\n```tool_call\n{"name":"get_weather","arguments":{"location":"Paris"}}\n```' }],
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: inboundHeaders,
      payload: {
        model: "mimo-v2.6-flash-free",
        messages: [{ role: "user", content: "weather in Paris?" }],
        stream: true,
        tools: [WEATHER_TOOL],
        tool_choice: "auto",
      },
    });

    expect(res.statusCode).toBe(200);
    const streamed = contentDeltas(res.body).join("");
    expect(streamed).toBe("Let me check.\n");
    expect(streamed).not.toContain("tool_call");
    const chunks = sseChunks(res.body);
    expect(chunks.some((chunk) => chunk.choices[0]?.delta.tool_calls?.[0]?.function.name === "get_weather")).toBe(true);
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("tool_calls");
  });

  it("returns tool_calls with finish_reason tool_calls for a required non-stream turn", async () => {
    const { getServeClient } = await import("../src/lib/serve/runtime.js");
    const client = getServeClient();
    vi.spyOn(client, "postMessage").mockResolvedValueOnce({
      info: { finish: "stop" },
      parts: [{ type: "text", text: '{"name":"get_weather","arguments":{"location":"Paris"}}' }],
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: inboundHeaders,
      payload: {
        model: "mimo-v2.6-flash-free",
        messages: [{ role: "user", content: "weather in Paris?" }],
        tools: [WEATHER_TOOL],
        tool_choice: "required",
      },
    });

    expect(res.statusCode).toBe(200);
    const choice = res.json().choices[0];
    expect(choice.message.tool_calls).toEqual([
      { id: expect.stringContaining("call_"), type: "function", function: { name: "get_weather", arguments: '{"location":"Paris"}' } },
    ]);
    expect(choice.finish_reason).toBe("tool_calls");
    expect(choice.message.content).toBeNull();
  });

  it("reads the json_schema call from info.structured, which carries no text part", async () => {
    const { getServeClient } = await import("../src/lib/serve/runtime.js");
    const client = getServeClient();
    // The real serve shape for a schema-constrained turn: finish/structured on info,
    // empty parts — reading only parts makes this look like an empty message.
    vi.spyOn(client, "postMessage").mockResolvedValueOnce({
      info: { finish: "tool-calls", structured: { name: "get_weather", arguments: '{"location": "Paris"}' } },
      parts: [{ type: "step-start" }],
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: inboundHeaders,
      payload: {
        model: "mimo-v2.6-flash-free",
        messages: [{ role: "user", content: "weather in Paris?" }],
        tools: [WEATHER_TOOL],
        tool_choice: "required",
      },
    });

    expect(res.statusCode).toBe(200);
    const choice = res.json().choices[0];
    expect(choice.message.tool_calls).toEqual([
      { id: expect.stringContaining("call_"), type: "function", function: { name: "get_weather", arguments: '{"location": "Paris"}' } },
    ]);
    expect(choice.finish_reason).toBe("tool_calls");
  });

  it("reads the structured call for a streaming required turn that streams no text", async () => {
    const { getServeClient } = await import("../src/lib/serve/runtime.js");
    const client = getServeClient();
    vi.spyOn(client, "postMessage").mockResolvedValueOnce({
      info: { finish: "tool-calls", structured: { name: "get_weather", arguments: { location: "Paris" } } },
      parts: [],
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: inboundHeaders,
      payload: {
        model: "mimo-v2.6-flash-free",
        messages: [{ role: "user", content: "weather in Paris?" }],
        stream: true,
        tools: [WEATHER_TOOL],
        tool_choice: "required",
      },
    });

    expect(res.statusCode).toBe(200);
    const chunks = sseChunks(res.body);
    expect(chunks.some((chunk) => chunk.choices[0]?.delta.tool_calls?.[0]?.function.name === "get_weather")).toBe(true);
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("tool_calls");
    expect(contentDeltas(res.body)).toEqual([]);
  });

  it("keeps finish_reason stop and no tool_calls for an auto turn answered with plain text", async () => {
    const { getServeClient } = await import("../src/lib/serve/runtime.js");
    const client = getServeClient();
    vi.spyOn(client, "postMessage").mockResolvedValueOnce({
      info: { finish: "stop" },
      parts: [{ type: "text", text: "It is sunny in Paris." }],
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: inboundHeaders,
      payload: {
        model: "mimo-v2.6-flash-free",
        messages: [{ role: "user", content: "weather in Paris?" }],
        tools: [WEATHER_TOOL],
        tool_choice: "auto",
      },
    });

    expect(res.statusCode).toBe(200);
    const choice = res.json().choices[0];
    expect(choice.message.tool_calls).toBeUndefined();
    expect(choice.finish_reason).toBe("stop");
    expect(choice.message.content).toBe("It is sunny in Paris.");
  });

  it("never reports tool_calls when a required turn ignores the schema", async () => {
    const { getServeClient } = await import("../src/lib/serve/runtime.js");
    const client = getServeClient();
    vi.spyOn(client, "postMessage").mockResolvedValueOnce({
      info: { finish: "stop" },
      parts: [{ type: "text", text: "I cannot call tools, but it is sunny in Paris." }],
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: inboundHeaders,
      payload: {
        model: "mimo-v2.6-flash-free",
        messages: [{ role: "user", content: "weather in Paris?" }],
        tools: [WEATHER_TOOL],
        tool_choice: "required",
      },
    });

    expect(res.statusCode).toBe(200);
    const choice = res.json().choices[0];
    // An empty tool_calls with a tool_calls finish would make clients wait for a call.
    expect(choice.message.tool_calls).toBeUndefined();
    expect(choice.finish_reason).not.toBe("tool_calls");
    expect(choice.finish_reason).toBe("stop");
  });

  it("keeps concurrent requests in distinct sessions without cross-contamination", async () => {
    const { getServeClient } = await import("../src/lib/serve/runtime.js");
    const client = getServeClient();
    const sessions: string[] = [];
    const createSpy = vi.spyOn(client, "createSession").mockImplementation(async () => {
      const id = `ses_${sessions.length + 1}`;
      sessions.push(id);
      return id;
    });
    vi.spyOn(client, "postMessage").mockImplementation(async (sessionId: string) => {
      // The first request finishes last, so a shared turn state would swap the replies.
      await new Promise((resolve) => setTimeout(resolve, sessionId === "ses_1" ? 20 : 1));
      return { info: { finish: "stop" }, parts: [{ type: "text", text: `reply-${sessionId}` }] };
    });

    const payloadFor = (content: string) => ({
      method: "POST" as const,
      url: "/v1/chat/completions",
      headers: inboundHeaders,
      payload: { model: "mimo-v2.6-flash-free", messages: [{ role: "user", content }] },
    });
    const [first, second] = await Promise.all([app.inject(payloadFor("one")), app.inject(payloadFor("two"))]);

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(new Set(sessions).size).toBe(2);
    expect(first.headers["x-opencode-session-id"]).toBe("ses_1");
    expect(second.headers["x-opencode-session-id"]).toBe("ses_2");
    expect(first.json().choices[0].message.content).toBe("reply-ses_1");
    expect(second.json().choices[0].message.content).toBe("reply-ses_2");
  });

  it("accepts an assistant turn with null content and tool_calls in the history", async () => {
    const { getServeClient } = await import("../src/lib/serve/runtime.js");
    const client = getServeClient();
    const postSpy = vi.spyOn(client, "postMessage");

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: inboundHeaders,
      payload: {
        model: "mimo-v2.6-flash-free",
        messages: [
          { role: "user", content: "weather in Paris?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"location":"Paris"}' } },
            ],
          },
          { role: "tool", content: '{"temperature":18}' },
          { role: "user", content: "thanks" },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const prompt = (postSpy.mock.calls[0]?.[1] as { parts: Array<{ text: string }> }).parts[0]?.text ?? "";
    expect(prompt).toContain('Assistant: {"tool_calls":');
    expect(prompt).toContain("get_weather");
    expect(prompt).toContain('Tool: {"temperature":18}');
  });

  it("maps an upstream 429 to a 429 rate-limit error", async () => {
    const { ServeHttpError } = await import("../src/lib/serve/client.js");
    const { getServeClient } = await import("../src/lib/serve/runtime.js");
    vi.spyOn(getServeClient(), "postMessage").mockRejectedValueOnce(new ServeHttpError(429, "rate limited"));

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: inboundHeaders,
      payload: { model: "mimo-v2.6-flash-free", messages: [{ role: "user", content: "hi" }] },
    });

    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({
      error: { message: "serve responded 429", type: "rate_limit_error", code: "rate_limit_exceeded", param: null },
    });
  });

  it("maps an upstream 500 to a 502", async () => {
    const { ServeHttpError } = await import("../src/lib/serve/client.js");
    const { getServeClient } = await import("../src/lib/serve/runtime.js");
    vi.spyOn(getServeClient(), "postMessage").mockRejectedValueOnce(new ServeHttpError(500, "boom"));

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: inboundHeaders,
      payload: { model: "mimo-v2.6-flash-free", messages: [{ role: "user", content: "hi" }] },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: { type: "server_error", code: "opencode_error" } });
  });

  it("ends a failed stream with [DONE] instead of truncating it", async () => {
    const { getServeClient } = await import("../src/lib/serve/runtime.js");
    const client = getServeClient();
    (client as unknown as { streamEvents: () => AsyncGenerator<unknown> }).streamEvents = async function* () {
      yield textPart();
      yield delta("par");
      throw new Error("event stream dropped");
    } as never;

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: inboundHeaders,
      payload: { model: "mimo-v2.6-flash-free", messages: [{ role: "user", content: "hi" }], stream: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"error"');
    expect(res.body.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  const itIntegration = process.env.INTEGRATION === "1" ? it : it.skip;

  itIntegration(
    "returns the discovered catalog",
    async () => {
      useRealCatalog.value = true;
      const res = await app.inject({ method: "GET", url: "/v1/models", headers: inboundHeaders });

      expect(res.statusCode).toBe(200);
      const models = res.json().data as Array<{ id: string }>;
      expect(models.length).toBeGreaterThan(0);
    },
    120_000,
  );

  itIntegration(
    "rejects a model absent from the catalog with 404",
    async () => {
      useRealCatalog.value = true;
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: inboundHeaders,
        payload: {
          model: "opencode/definitely-not-a-real-model",
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
