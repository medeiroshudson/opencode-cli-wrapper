import { describe, expect, it, vi } from "vitest";
import { ServeStartupError, ServeSupervisor } from "../src/lib/serve/process.js";

function deps(overrides: Record<string, unknown> = {}) {
  return {
    baseUrl: "http://127.0.0.1:4100",
    port: 4100,
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
});