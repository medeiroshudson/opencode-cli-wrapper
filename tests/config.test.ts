import { describe, it, expect } from "vitest";
import type { AuthContext } from "../src/lib/opencode/auth.js";
import type { CatalogEntry } from "../src/lib/opencode/models.js";
import {
  getServeBaseUrl,
  getServePort,
  getServeReadinessTimeoutMs,
  getTimeoutMs,
  listModels,
  modelsDevMetadata,
  ModelNotFoundError,
  describeProxyEnv,
  resolveModel,
  resolveOpencodeBin,
  resolveProxyEnv,
  visibleModels,
} from "../src/config/index.js";

const entries: CatalogEntry[] = [
  { canonical: "opencode/mimo-v2.6-flash-free", provider: "opencode", id: "mimo-v2.6-flash-free", limits: { context: 200000, input: 160000, output: 32000 } },
  { canonical: "opencode/space-bunny-free", provider: "opencode", id: "space-bunny-free", limits: null },
  { canonical: "opencode/claude-opus-5", provider: "opencode", id: "claude-opus-5", limits: { context: 100, input: null, output: 20 } },
];

const noAuth: AuthContext = { enabled: false, token: null };
const withAuth: AuthContext = { enabled: true, token: "key" };

describe("config module", () => {
  it("shows only free ids without auth", () => {
    expect(visibleModels(entries, noAuth)).toEqual(entries.slice(0, 2));
  });

  it("shows every catalog entry with auth", () => {
    expect(visibleModels(entries, withAuth)).toEqual(entries);
  });

  it("lists model ids and providers in catalog order", () => {
    expect(listModels(withAuth, entries)).toEqual({
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

  it("resolves a visible short id to its canonical id", () => {
    expect(resolveModel("mimo-v2.6-flash-free", noAuth, entries)).toBe("opencode/mimo-v2.6-flash-free");
  });

  it("resolves a visible canonical id", () => {
    expect(resolveModel("opencode/mimo-v2.6-flash-free", noAuth, entries)).toBe("opencode/mimo-v2.6-flash-free");
  });

  it("rejects a model outside the visible catalog", () => {
    expect(() => resolveModel("gpt-4", withAuth, entries)).toThrow(ModelNotFoundError);
  });

  it("rejects every id when the catalog is empty", () => {
    expect(() => resolveModel("mimo-v2.6-flash-free", withAuth, [])).toThrow(ModelNotFoundError);
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
    expect(resolveModel("space-bunny-free", noAuth, dual)).toBe("opencode/space-bunny-free");
  });

  it("still honors an explicit GO canonical id", () => {
    expect(resolveModel("opencode-go/space-bunny-free", noAuth, dual)).toBe("opencode-go/space-bunny-free");
  });

  it("lists a single entry per id, preferring ZEN", () => {
    expect(listModels(noAuth, dual)).toEqual({
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

describe("serve env", () => {
  it("defaults base url to loopback on the default port", () => {
    expect(getServePort({})).toBe(4100);
    expect(getServeBaseUrl({})).toBe("http://127.0.0.1:4100");
  });

  it("reads OPENCODE_BASE at runtime and strips trailing slashes", () => {
    expect(getServeBaseUrl({ OPENCODE_BASE: "http://serve.internal:9999/" })).toBe(
      "http://serve.internal:9999",
    );
  });

  it("derives the base url from OPENCODE_PORT when OPENCODE_BASE is unset", () => {
    expect(getServeBaseUrl({ OPENCODE_PORT: "4200" })).toBe("http://127.0.0.1:4200");
  });

  it("defaults the readiness timeout to 20000ms and reads the override", () => {
    expect(getServeReadinessTimeoutMs({})).toBe(20_000);
    expect(getServeReadinessTimeoutMs({ OPENCODE_SERVE_READY_TIMEOUT_MS: "5000" })).toBe(5_000);
  });
});
