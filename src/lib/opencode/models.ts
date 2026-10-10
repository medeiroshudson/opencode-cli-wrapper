// PHASE S5 — model catalog sourced from the opencode serve API.

import type { ServeCatalog, ServeClient } from "../serve/client.js";
import { getServeClient } from "../serve/runtime.js";

export interface ModelLimits {
  readonly context: number | null;
  readonly input: number | null;
  readonly output: number | null;
}

export interface CatalogEntry {
  readonly canonical: string;
  readonly provider: string;
  readonly id: string;
  readonly limits: ModelLimits | null;
}

interface CatalogCache {
  readonly entries: CatalogEntry[];
  readonly fetchedAt: number;
}

const DEFAULT_TTL_MS = 300_000;

let catalogCache: CatalogCache | null = null;
let refreshPromise: Promise<CatalogEntry[]> | null = null;
let catalogGeneration = 0;

export class CatalogError extends Error {
  override name = "CatalogError";
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, CatalogError.prototype);
  }
}

export function getModelsTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.OPENCODE_MODELS_TTL_MS;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_TTL_MS;
}

function readLimit(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function catalogFromServe(catalog: ServeCatalog): CatalogEntry[] {
  const entries = new Map<string, CatalogEntry>();
  for (const provider of catalog.providers ?? []) {
    for (const model of Object.values(provider.models ?? {})) {
      const canonical = `${provider.id}/${model.id}`;
      const limit = model.limit ?? {};
      const hasLimit =
        limit.context !== undefined || limit.input !== undefined || limit.output !== undefined;
      entries.set(canonical, {
        canonical,
        provider: provider.id,
        id: model.id,
        limits: hasLimit
          ? { context: readLimit(limit.context), input: readLimit(limit.input), output: readLimit(limit.output) }
          : null,
      });
    }
  }
  return [...entries.values()].sort((left, right) => left.canonical.localeCompare(right.canonical));
}

export async function getCatalog(
  client: ServeClient = getServeClient(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<CatalogEntry[]> {
  if (catalogCache && Date.now() - catalogCache.fetchedAt < getModelsTtlMs(env)) return catalogCache.entries;
  if (!refreshPromise) {
    const generation = catalogGeneration;
    refreshPromise = client
      .catalog()
      .then((catalog) => {
        const entries = catalogFromServe(catalog);
        if (generation === catalogGeneration) catalogCache = { entries, fetchedAt: Date.now() };
        return entries;
      })
      .catch((cause: unknown) => {
        if (catalogCache) return catalogCache.entries;
        throw cause instanceof CatalogError ? cause : new CatalogError("Unable to read model catalog");
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

export function resetCatalogCache(): void {
  catalogGeneration += 1;
  catalogCache = null;
  refreshPromise = null;
}
