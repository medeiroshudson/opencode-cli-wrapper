import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

const { getCatalogMock, createSessionMock, postMessageMock } = vi.hoisted(() => ({
  getCatalogMock: vi.fn(),
  createSessionMock: vi.fn(),
  postMessageMock: vi.fn(),
}));

vi.mock("../src/lib/opencode/models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/opencode/models.js")>();
  return { ...actual, getCatalog: getCatalogMock };
});

// Stable singletons: the route and these tests must share one client instance.
vi.mock("../src/lib/serve/runtime.js", () => {
  const client = {
    health: async () => true,
    createSession: createSessionMock,
    postMessage: postMessageMock,
    deleteSession: async () => undefined,
    abortSession: async () => undefined,
  };
  const supervisor = {
    ensureReady: async () => undefined,
    baseUrl: () => "http://x",
    shutdown: async () => undefined,
  };
  return {
    getServeClient: () => client,
    getServeSupervisor: () => supervisor,
    resetRuntime: () => undefined,
  };
});

const catalog = [
  { canonical: "opencode/mimo-v2.6-flash-free", provider: "opencode", id: "mimo-v2.6-flash-free", limits: null },
];
const authorization = { authorization: "Bearer test-inbound-key" };
const chatPayload = { model: "mimo-v2.6-flash-free", messages: [{ role: "user", content: "hi" }] };

describe("Global route authentication", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.stubEnv("API_KEY", "test-inbound-key");
    getCatalogMock.mockReset();
    getCatalogMock.mockResolvedValue(catalog);
    createSessionMock.mockReset();
    createSessionMock.mockResolvedValue("ses_test");
    postMessageMock.mockReset();
    postMessageMock.mockResolvedValue({ info: { finish: "stop" }, parts: [{ type: "text", text: "hello" }] });
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
    const headers = header === undefined ? {} : { authorization: header };
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

  it("routes the chat turn through the serve client with the resolved model and no upstream credential", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authorization,
      payload: chatPayload,
    });

    expect(response.statusCode).toBe(200);
    // runTurn assembles the payload from the conversation alone: the resolved model and
    // the prompt. There is no per-request upstream credential field.
    expect(postMessageMock).toHaveBeenCalledWith("ses_test", {
      model: { providerID: "opencode", modelID: "mimo-v2.6-flash-free" },
      parts: [{ type: "text", text: expect.any(String) }],
    });
  });
});
