import { describe, expect, it, vi } from "vitest";
import { defaultServeDeps, ServeStartupError, ServeSupervisor } from "../src/lib/serve/process.js";
import { buildChildEnv } from "../src/config/index.js";

function deps(overrides: Record<string, unknown> = {}) {
  return {
    baseUrl: "http://127.0.0.1:4100",
    spawnPort: 4100,
    bin: "opencode",
    readinessTimeoutMs: 1000,
    isHealthy: vi.fn(async () => true),
    spawnServe: vi.fn(() => ({ kill: vi.fn() })),
    ...overrides,
  } as never as Parameters<typeof ServeSupervisor.prototype.ensureReady> extends never ? never : ConstructorParameters<typeof ServeSupervisor>[0];
}

describe("ServeSupervisor", () => {
  it("uses an already-healthy serve without spawning", async () => {
    const d = deps();
    const sup = new ServeSupervisor(d);
    await sup.ensureReady();
    expect(d.spawnServe).not.toHaveBeenCalled();
    expect(sup.baseUrl()).toBe("http://127.0.0.1:4100");
  });

  it("spawns and waits until healthy", async () => {
    let healthy = false;
    const d = deps({
      isHealthy: vi.fn(async () => {
        const was = healthy;
        healthy = true;
        return was;
      }),
    });
    const sup = new ServeSupervisor(d);
    await sup.ensureReady();
    expect(d.spawnServe).toHaveBeenCalledWith("opencode", 4100);
  });

  it("refuses to spawn when the endpoint is not local", async () => {
    const d = deps({ baseUrl: "http://serve.internal:9999", spawnPort: null, isHealthy: vi.fn(async () => false) });
    const sup = new ServeSupervisor(d);

    await expect(sup.ensureReady()).rejects.toThrow(/OPENCODE_BASE points off-host/);
    expect(d.spawnServe).not.toHaveBeenCalled();
  });

  it("uses an unhealthy remote endpoint's daemon without spawning", async () => {
    // Healthy remote endpoint: nothing to do, and still no local child.
    const d = deps({ baseUrl: "http://serve.internal:9999", spawnPort: null });
    const sup = new ServeSupervisor(d);

    await sup.ensureReady();
    expect(d.spawnServe).not.toHaveBeenCalled();
  });

  it("throws ServeStartupError when the daemon never becomes healthy", async () => {
    const d = deps({ isHealthy: vi.fn(async () => false), readinessTimeoutMs: 150 });
    const sup = new ServeSupervisor(d);
    await expect(sup.ensureReady()).rejects.toBeInstanceOf(ServeStartupError);
  });

  it("kills the spawned child on shutdown", async () => {
    const kill = vi.fn();
    let healthy = false;
    const d = deps({ isHealthy: vi.fn(async () => healthy), spawnServe: vi.fn(() => ({ kill })) });
    const sup = new ServeSupervisor(d);
    const pending = sup.ensureReady();
    healthy = true;
    await pending;
    await sup.shutdown();
    expect(kill).toHaveBeenCalled();
  });

  it("kills the spawned child when readiness times out", async () => {
    const kill = vi.fn();
    const d = deps({
      isHealthy: vi.fn(async () => false),
      spawnServe: vi.fn(() => ({ kill })),
      readinessTimeoutMs: 150,
    });
    const sup = new ServeSupervisor(d);
    await expect(sup.ensureReady()).rejects.toBeInstanceOf(ServeStartupError);
    expect(d.spawnServe).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalled();
  });

  it("does not double-spawn on concurrent ensureReady calls", async () => {
    let healthy = false;
    const spawnServe = vi.fn(() => ({ kill: vi.fn() }));
    const d = deps({
      isHealthy: vi.fn(async () => healthy),
      spawnServe,
      readinessTimeoutMs: 2000,
    });
    const sup = new ServeSupervisor(d);
    const first = sup.ensureReady();
    const second = sup.ensureReady();
    healthy = true;
    await Promise.all([first, second]);
    expect(spawnServe).toHaveBeenCalledTimes(1);
  });
});

describe("defaultServeDeps", () => {
  it("spawns opencode serve with the proxied child environment", () => {
    const spawnImpl = vi.fn((_bin: string, _args: readonly string[], _opts: { env?: NodeJS.ProcessEnv }) => ({
      kill: vi.fn(),
    }));
    const client = { health: vi.fn(async () => true) };
    // OPENCODE_PROXY_URL is mapped onto HTTP(S)_PROXY; the ambient HTTP_PROXY is scrubbed.
    const env = {
      PATH: "/bin",
      OPENCODE_PROXY_URL: "http://proxy.corp:8080",
      HTTP_PROXY: "http://ambient:8080",
    };

    const d = defaultServeDeps(client as never, spawnImpl as never, env);
    d.spawnServe("opencode", 4100);

    expect(spawnImpl).toHaveBeenCalledWith(
      "opencode",
      ["serve", "--port", "4100", "--hostname", "127.0.0.1"],
      expect.objectContaining({ env: buildChildEnv(env) }),
    );
    const spawnedEnv = spawnImpl.mock.calls[0]?.[2]?.env;
    expect(spawnedEnv?.HTTP_PROXY).toBe("http://proxy.corp:8080");
    expect(spawnedEnv?.HTTPS_PROXY).toBe("http://proxy.corp:8080");
    expect(spawnedEnv?.NO_PROXY).toBe("localhost,127.0.0.1,::1");
    expect(spawnedEnv?.PATH).toBe("/bin");
  });

  it("spawns on the port named by a loopback OPENCODE_BASE", () => {
    const client = { health: vi.fn(async () => true) };

    const d = defaultServeDeps(client as never, vi.fn() as never, { OPENCODE_BASE: "http://127.0.0.1:9999" });

    // Without this, the daemon starts on OPENCODE_PORT's default 4100 while readiness
    // and every request poll :9999.
    expect(d.baseUrl).toBe("http://127.0.0.1:9999");
    expect(d.spawnPort).toBe(9999);
  });

  it("keeps the default port when OPENCODE_BASE is unset", () => {
    const client = { health: vi.fn(async () => true) };

    const d = defaultServeDeps(client as never, vi.fn() as never, { OPENCODE_PORT: "4200" });

    expect(d.baseUrl).toBe("http://127.0.0.1:4200");
    expect(d.spawnPort).toBe(4200);
  });

  it("never spawns for a non-loopback OPENCODE_BASE", () => {
    const client = { health: vi.fn(async () => true) };

    const d = defaultServeDeps(client as never, vi.fn() as never, {
      OPENCODE_BASE: "http://serve.internal:9999",
      OPENCODE_PORT: "4200",
    });

    expect(d.baseUrl).toBe("http://serve.internal:9999");
    expect(d.spawnPort).toBeNull();
  });
});