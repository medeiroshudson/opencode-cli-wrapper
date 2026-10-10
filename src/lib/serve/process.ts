// PHASE S4 — supervision of the locally spawned `opencode serve` daemon.

import { spawn } from "node:child_process";
import { getServeBaseUrl, getServePort, getServeReadinessTimeoutMs, resolveOpencodeBin } from "../../config/index.js";
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

  constructor(private readonly deps: ServeProcessDeps) {}

  baseUrl(): string {
    return this.deps.baseUrl;
  }

  async ensureReady(): Promise<void> {
    if (await this.deps.isHealthy()) return;
    this.child = this.deps.spawnServe(this.deps.bin, this.deps.port);
    const deadline = Date.now() + this.deps.readinessTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.deps.isHealthy()) return;
      await sleep(250);
    }
    throw new ServeStartupError(`opencode serve did not become healthy in ${this.deps.readinessTimeoutMs}ms`);
  }

  async shutdown(): Promise<void> {
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // already gone
      }
      this.child = null;
    }
  }
}

export function defaultServeDeps(client: ServeClient): ServeProcessDeps {
  return {
    baseUrl: getServeBaseUrl(),
    port: getServePort(),
    bin: resolveOpencodeBin(),
    readinessTimeoutMs: getServeReadinessTimeoutMs(),
    isHealthy: () => client.health(),
    spawnServe: (bin, port) =>
      spawn(bin, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], { stdio: "inherit" }),
  };
}