import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

const { getCatalogMock, runOnceMock } = vi.hoisted(() => ({
  getCatalogMock: vi.fn(),
  runOnceMock: vi.fn(),
}));

vi.mock("../src/lib/opencode/models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/opencode/models.js")>();
  return { ...actual, getCatalog: getCatalogMock };
});

vi.mock("../src/lib/opencode/runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/opencode/runner.js")>();
  return { ...actual, runOnce: runOnceMock };
});

const catalog = [
  { canonical: "opencode/mimo-v2.6-flash-free", provider: "opencode", id: "mimo-v2.6-flash-free", limits: null },
  { canonical: "openai/gpt-6-luna", provider: "openai", id: "gpt-6-luna", limits: null },
];
const authorization = { authorization: "Bearer test-inbound-key" };
const chatPayload = { model: "mimo-v2.6-flash-free", messages: [{ role: "user", content: "hi" }] };

describe("Global route authentication", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.stubEnv("API_KEY", "test-inbound-key");
    getCatalogMock.mockReset();
    getCatalogMock.mockResolvedValue(catalog);
    runOnceMock.mockReset();
    runOnceMock.mockResolvedValue({
      content: "hello", chunks: ["hello"], finish_reason: "stop", usage: null,
      sessionId: null, error: null, toolCalls: 0,
    });
    app = buildServer("test-inbound-key");
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it("fails closed when API_KEY is missing or empty", () => {
    expect(() => buildServer("")).toThrow("API_KEY must be configured");
    vi.stubEnv("API_KEY", "");
    expect(() => buildServer(undefined)).toThrow("API_KEY must be configured");
  });

  it.each([" leading", "trailing ", "internal whitespace", "comma,key"])(
    "fails closed when API_KEY contains invalid Bearer-token characters",
    (apiKey) => {
      expect(() => buildServer(apiKey)).toThrow("API_KEY must be a valid Bearer token");
    },
  );

  it("accepts a normal API_KEY as a Bearer token", async () => {
    const response = await app.inject({ method: "GET", url: "/health", headers: authorization });

    expect(response.statusCode).toBe(200);
  });

  it.each([
    ["missing", undefined],
    ["empty", "Bearer "],
    ["malformed", "Bearer one two"],
    ["repeated", "Bearer test-inbound-key, Bearer test-inbound-key"],
    ["unsupported scheme", "Basic test-inbound-key"],
    ["incorrect", "Bearer wrong-key"],
  ])("rejects %s credentials before route work", async (_condition, header) => {
    const headers = header === undefined
      ? { "x-opencode-key": "upstream-key" }
      : { authorization: header, "x-opencode-key": "upstream-key" };
    const response = await app.inject({ method: "GET", url: "/v1/models", headers });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { type: "server_error", code: "opencode_error" } });
    expect(getCatalogMock).not.toHaveBeenCalled();
  });

  it.each([
    ["models", "GET", "/v1/models"],
    ["chat completions", "POST", "/v1/chat/completions"],
    ["metadata", "GET", "/models.dev.json"],
    ["health", "GET", "/health"],
  ] as const)("requires Bearer authentication for %s", async (_route, method, url) => {
    const response = await app.inject({
      method,
      url,
      ...(method === "POST" ? { payload: chatPayload } : {}),
    });

    expect(response.statusCode).toBe(401);
  });

  it("does not let x-opencode-key authenticate and forwards it separately to the child", async () => {
    const unauthorized = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-opencode-key": "upstream-key" },
      payload: chatPayload,
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(getCatalogMock).not.toHaveBeenCalled();

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...authorization, "x-opencode-key": "upstream-key" },
      payload: chatPayload,
    });

    expect(response.statusCode).toBe(200);
    expect(runOnceMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "opencode/mimo-v2.6-flash-free" }),
      expect.objectContaining({ OPENCODE_API_KEY: "upstream-key" }),
    );
    expect(runOnceMock.mock.calls[0]?.[1]).not.toHaveProperty("OPENCODE_API_KEY", "test-inbound-key");
  });

  it.each(["gpt-6-luna", "openai/gpt-6-luna"])("uses existing provider credentials for %s without x-opencode-key", async (model) => {
    vi.stubEnv("OPENCODE_API_KEY", "");
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authorization,
      payload: { ...chatPayload, model },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.content).toBe("hello");
    expect(runOnceMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "openai/gpt-6-luna" }),
      expect.objectContaining({ OPENCODE_API_KEY: "" }),
    );
  });

  it("preserves a server-configured OpenCode key when x-opencode-key is absent", async () => {
    vi.stubEnv("OPENCODE_API_KEY", "server-upstream-key");
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authorization,
      payload: chatPayload,
    });

    expect(response.statusCode).toBe(200);
    expect(runOnceMock.mock.calls[0]?.[1]).toHaveProperty("OPENCODE_API_KEY", "server-upstream-key");
  });
});
