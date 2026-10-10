// PHASE S4 — supervision of the locally spawned `opencode serve` daemon.

import { spawn } from "node:child_process";
import {
  buildChildEnv,
  getServeBaseUrl,
  getServePort,
  getServeReadinessTimeoutMs,
  resolveOpencodeBin,
} from "../../config/index.js";
import type { ServeClient } from "./client.js";

export interface SpawnedChild { kill(): void }

export interface ServeProcessDeps {
  baseUrl: string;
  port: number;
  bin: string;
  readinessTimeoutMs: number;
  isHealthy: () => Promise<boolean>;
  spawnServe: (bin: string, port: number) => SpawnedChild;
}

export class ServeStartupError extends Error {
  override name = "ServeStartupError";
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, ServeStartupError.prototype);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class ServeSupervisor {
  private child: SpawnedChild | null = null;
  private readiness: Promise<void> | null = null;

  constructor(private readonly deps: ServeProcessDeps) {}

  baseUrl(): string {
    return this.deps.baseUrl;
  }

  ensureReady(): Promise<void> {
    // Memoize the in-flight attempt so concurrent cold-start callers share a
    // single health check and spawn; clear it once the attempt settles.
    if (!this.readiness) {
      this.readiness = this.start().finally(() => {
        this.readiness = null;
      });
    }
    return this.readiness;
  }

  private async start(): Promise<void> {
    if (await this.deps.isHealthy()) return;
    this.child = this.deps.spawnServe(this.deps.bin, this.deps.port);
    const deadline = Date.now() + this.deps.readinessTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.deps.isHealthy()) return;
      await sleep(250);
    }
    // The daemon never came up: don't leak it holding the port.
    this.killChild();
    throw new ServeStartupError(`opencode serve did not become healthy in ${this.deps.readinessTimeoutMs}ms`);
  }

  private killChild(): void {
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // already gone
      }
      this.child = null;
    }
  }

  async shutdown(): Promise<void> {
    this.killChild();
  }
}

export function defaultServeDeps(
  client: ServeClient,
  spawnImpl: typeof spawn = spawn,
  env: NodeJS.ProcessEnv = process.env,
): ServeProcessDeps {
  return {
    baseUrl: getServeBaseUrl(),
    port: getServePort(),
    bin: resolveOpencodeBin(),
    readinessTimeoutMs: getServeReadinessTimeoutMs(),
    isHealthy: () => client.health(),
    spawnServe: (bin, port) =>
      spawnImpl(bin, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
        stdio: ["ignore", "inherit", "inherit"],
        // The daemon makes the outbound model requests, so it gets the wrapper's
        // proxy configuration: OPENCODE_PROXY_URL mapped onto HTTP(S)_PROXY, with
        // ambient proxy variables scrubbed (see buildChildEnv).
        env: buildChildEnv(env),
      }),
  };
}