import { describe, it, expect } from "vitest";
import type { CatalogEntry } from "../src/lib/opencode/models.js";
import {
  getTimeoutMs,
  listModels,
  modelsDevMetadata,
  ModelNotFoundError,
  describeProxyEnv,
  resolveModel,
  resolveOpencodeBin,
  resolveProxyEnv,
} from "../src/config/index.js";

const entries: CatalogEntry[] = [
  { canonical: "opencode/mimo-v2.6-flash-free", provider: "opencode", id: "mimo-v2.6-flash-free", limits: { context: 200000, input: 160000, output: 32000 } },
  { canonical: "opencode/space-bunny-free", provider: "opencode", id: "space-bunny-free", limits: null },
  { canonical: "opencode/claude-opus-5", provider: "opencode", id: "claude-opus-5", limits: { context: 100, input: null, output: 20 } },
];

describe("config module", () => {
  it("lists model ids and providers in catalog order", () => {
    expect(listModels(entries)).toEqual({
      object: "list",
      data: [
        { id: "mimo-v2.6-flash-free", object: "model", owned_by: "opencode", context_length: 200000, max_model_len: 200000, max_output_tokens: 32000, max_input_tokens: 160000 },
        { id: "space-bunny-free", object: "model", owned_by: "opencode" },
        { id: "claude-opus-5", object: "model", owned_by: "opencode", context_length: 100, max_model_len: 100, max_output_tokens: 20 },
      ],
    });
  });

  it("builds models.dev metadata with available limits", () => {
    expect(modelsDevMetadata([entries[0]])).toEqual({
      "mimo-v2.6-flash-free": {
        id: "mimo-v2.6-flash-free",
        limit: { context: 200000, input: 160000, output: 32000 },
      },
    });
  });

  it("omits limits when a model has no limits", () => {
    expect(modelsDevMetadata([entries[1]])).toEqual({ "space-bunny-free": { id: "space-bunny-free" } });
  });

  it("resolves a non-free short id to its canonical id", () => {
    expect(resolveModel("claude-opus-5", entries)).toBe("opencode/claude-opus-5");
  });

  it("resolves a non-free canonical id", () => {
    expect(resolveModel("opencode/claude-opus-5", entries)).toBe("opencode/claude-opus-5");
  });

  it("rejects a model outside the catalog", () => {
    expect(() => resolveModel("gpt-4", entries)).toThrow(ModelNotFoundError);
  });

  it("rejects every id when the catalog is empty", () => {
    expect(() => resolveModel("mimo-v2.6-flash-free", [])).toThrow(ModelNotFoundError);
  });

  it("keeps getTimeoutMs default and fallback behavior", () => {
    expect(getTimeoutMs({})).toBe(120000);
    expect(getTimeoutMs({ OPENCODE_TIMEOUT_MS: "0" })).toBe(120000);
    expect(getTimeoutMs({ OPENCODE_TIMEOUT_MS: "abc" })).toBe(120000);
    expect(getTimeoutMs({ OPENCODE_TIMEOUT_MS: "9999" })).toBe(9999);
  });

  it("keeps resolveOpencodeBin default and override behavior", () => {
    expect(resolveOpencodeBin({})).toBe("opencode");
    expect(resolveOpencodeBin({ OPENCODE_BIN: "mybin" })).toBe("mybin");
  });
});

describe("resolveProxyEnv", () => {
  it("maps OPENCODE_PROXY_URL to HTTP_PROXY and HTTPS_PROXY with a loopback bypass", () => {
    expect(resolveProxyEnv({ OPENCODE_PROXY_URL: "http://proxy:8080" })).toEqual({
      HTTP_PROXY: "http://proxy:8080",
      HTTPS_PROXY: "http://proxy:8080",
      NO_PROXY: "localhost,127.0.0.1,::1",
    });
  });

  it("trims the configured proxy URL", () => {
    expect(resolveProxyEnv({ OPENCODE_PROXY_URL: "  http://proxy:8080  " }).HTTP_PROXY).toBe("http://proxy:8080");
  });

  it("ignores ambient proxy variables and only uses OPENCODE_PROXY_URL", () => {
    const env = { HTTP_PROXY: "http://http:8080", HTTPS_PROXY: "http://https:8080", NO_PROXY: "example.com" };
    expect(resolveProxyEnv(env)).toEqual({});
  });

  it("returns no proxy variables when OPENCODE_PROXY_URL is empty", () => {
    expect(resolveProxyEnv({})).toEqual({});
    expect(resolveProxyEnv({ OPENCODE_PROXY_URL: "" })).toEqual({});
    expect(resolveProxyEnv({ OPENCODE_PROXY_URL: "   " })).toEqual({});
  });

  it("masks credentials in describeProxyEnv", () => {
    expect(describeProxyEnv({ OPENCODE_PROXY_URL: "http://user:pass@proxy:8080" })).toBe(
      "HTTP_PROXY=http://***@proxy:8080 HTTPS_PROXY=http://***@proxy:8080 NO_PROXY=localhost,127.0.0.1,::1",
    );
  });

  it("describes nothing when no proxy is configured", () => {
    expect(describeProxyEnv({ HTTP_PROXY: "http://http:8080" })).toBe("");
  });
});

describe("ZEN model preference", () => {
  const dual: CatalogEntry[] = [
    { canonical: "opencode-go/space-bunny-free", provider: "opencode-go", id: "space-bunny-free", limits: null },
    { canonical: "opencode/space-bunny-free", provider: "opencode", id: "space-bunny-free", limits: null },
    { canonical: "opencode/mimo-v2.6-flash-free", provider: "opencode", id: "mimo-v2.6-flash-free", limits: null },
  ];

  it("resolves a short id shared by ZEN and GO to the ZEN provider", () => {
    expect(resolveModel("space-bunny-free", dual)).toBe("opencode/space-bunny-free");
  });

  it("still honors an explicit GO canonical id", () => {
    expect(resolveModel("opencode-go/space-bunny-free", dual)).toBe("opencode-go/space-bunny-free");
  });

  it("lists a single entry per id, preferring ZEN", () => {
    expect(listModels(dual)).toEqual({
      object: "list",
      data: [
        { id: "space-bunny-free", object: "model", owned_by: "opencode" },
        { id: "mimo-v2.6-flash-free", object: "model", owned_by: "opencode" },
      ],
    });
  });

  it("uses the ZEN entry for duplicate models.dev ids", () => {
    const dualWithLimits: CatalogEntry[] = [
      { ...dual[0], limits: { context: 10, input: 8, output: 2 } },
      { ...dual[1], limits: { context: 20, input: 16, output: 4 } },
    ];
    expect(modelsDevMetadata(dualWithLimits)).toEqual({
      "space-bunny-free": {
        id: "space-bunny-free",
        limit: { context: 20, input: 16, output: 4 },
      },
    });
  });
});
