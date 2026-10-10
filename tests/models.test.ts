import { beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogError, getCatalog, resetCatalogCache } from "../src/lib/opencode/models.js";
import type { ServeCatalog, ServeClient } from "../src/lib/serve/client.js";

const CATALOG: ServeCatalog = {
  providers: [
    {
      id: "opencode",
      models: {
        "mimo-v2.6-flash-free": { id: "mimo-v2.6-flash-free", providerID: "opencode", limit: { context: 200000, output: 32000 } },
        "space-bunny-free": { id: "space-bunny-free", providerID: "opencode" },
      },
    },
    { id: "opencode-go", models: { "qwen3.8-flash": { id: "qwen3.8-flash", providerID: "opencode-go" } } },
  ],
};

const clientOf = (catalog: () => Promise<ServeCatalog>): ServeClient =>
  ({ catalog } as never as ServeClient);

describe("getCatalog", () => {
  beforeEach(() => resetCatalogCache());

  it("maps providers to canonical entries with limits", async () => {
    const entries = await getCatalog(clientOf(() => Promise.resolve(CATALOG)), {});
    expect(entries).toEqual([
      { canonical: "opencode-go/qwen3.8-flash", provider: "opencode-go", id: "qwen3.8-flash", limits: null },
      { canonical: "opencode/mimo-v2.6-flash-free", provider: "opencode", id: "mimo-v2.6-flash-free", limits: { context: 200000, input: null, output: 32000 } },
      { canonical: "opencode/space-bunny-free", provider: "opencode", id: "space-bunny-free", limits: null },
    ]);
  });

  it("caches within the TTL and shares one refresh between callers", async () => {
    const catalog = vi.fn(() => Promise.resolve(CATALOG));
    await Promise.all([getCatalog(clientOf(catalog), {}), getCatalog(clientOf(catalog), {})]);
    await getCatalog(clientOf(catalog), {});
    expect(catalog).toHaveBeenCalledTimes(1);
  });

  it("returns the prior catalog when a refresh fails", async () => {
    vi.useFakeTimers();
    const first = await getCatalog(clientOf(() => Promise.resolve(CATALOG)), { OPENCODE_MODELS_TTL_MS: "1" });
    vi.advanceTimersByTime(1);
    const failing = clientOf(() => Promise.reject(new Error("down")));
    await expect(getCatalog(failing, { OPENCODE_MODELS_TTL_MS: "1" })).resolves.toEqual(first);
    vi.useRealTimers();
  });

  it("throws CatalogError on a cold failing load", async () => {
    const failing = clientOf(() => Promise.reject(new Error("down")));
    await expect(getCatalog(failing, {})).rejects.toBeInstanceOf(CatalogError);
  });
});
