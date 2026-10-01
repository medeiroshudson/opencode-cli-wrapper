import type { CatalogEntry } from "../lib/opencode/models.js";

const LOOPBACK_NO_PROXY = "localhost,127.0.0.1,::1";
const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"] as const;
const AMBIENT_PROXY_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;
const ZEN_PROVIDER = "opencode";
const GO_PROVIDER = "opencode-go";

export function resolveProxyEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const configured = env.OPENCODE_PROXY_URL;
  if (typeof configured !== "string" || configured.trim().length === 0) return {};

  const url = configured.trim();
  return { HTTP_PROXY: url, HTTPS_PROXY: url, NO_PROXY: LOOPBACK_NO_PROXY };
}

export function buildChildEnv(
  configEnv: NodeJS.ProcessEnv = process.env,
  baseEnv: NodeJS.ProcessEnv = configEnv,
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of AMBIENT_PROXY_KEYS) delete child[key];
  return { ...child, ...resolveProxyEnv(configEnv) };
}

export function describeProxyEnv(env: NodeJS.ProcessEnv = process.env): string {
  const resolved = resolveProxyEnv(env);
  const mask = (url: string): string => url.replace(/\/\/[^@/]+@/, "//***@");
  return PROXY_KEYS.map((key) => (resolved[key] ? `${key}=${mask(resolved[key])}` : null))
    .filter((value): value is string => value !== null)
    .join(" ");
}

export class ModelNotFoundError extends Error {
  override name = "ModelNotFoundError";

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, ModelNotFoundError.prototype);
  }
}

export function resolveOpencodeBin(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.OPENCODE_BIN;
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return "opencode";
}

export function getTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.OPENCODE_TIMEOUT_MS;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return 120_000;
}

function providerRank(provider: string): number {
  if (provider === ZEN_PROVIDER) return 0;
  if (provider === GO_PROVIDER) return 1;
  return 2;
}

function preferZen(current: CatalogEntry, candidate: CatalogEntry): CatalogEntry {
  return providerRank(candidate.provider) < providerRank(current.provider) ? candidate : current;
}

function dedupeById(entries: CatalogEntry[]): CatalogEntry[] {
  const byId = new Map<string, CatalogEntry>();
  for (const entry of entries) {
    const current = byId.get(entry.id);
    byId.set(entry.id, current ? preferZen(current, entry) : entry);
  }
  return [...byId.values()];
}

function finiteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function listModels(
  entries: CatalogEntry[],
): {
  object: "list";
  data: Array<{
    id: string;
    object: "model";
    owned_by: string;
    context_length?: number;
    max_model_len?: number;
    max_output_tokens?: number;
    max_input_tokens?: number;
  }>;
} {
  return {
    object: "list",
    data: dedupeById(entries).map((entry) => {
      const data = {
        id: entry.id,
        object: "model" as const,
        owned_by: entry.provider,
      };
      return {
        ...data,
        ...(finiteNumber(entry.limits?.context)
          ? { context_length: entry.limits.context, max_model_len: entry.limits.context }
          : {}),
        ...(finiteNumber(entry.limits?.output)
          ? { max_output_tokens: entry.limits.output }
          : {}),
        ...(finiteNumber(entry.limits?.input)
          ? { max_input_tokens: entry.limits.input }
          : {}),
      };
    }),
  };
}

export interface ModelsDevLimit {
  readonly context?: number;
  readonly input?: number;
  readonly output?: number;
}

export interface ModelsDevMetadataEntry {
  readonly id: string;
  readonly limit?: ModelsDevLimit;
}

export function modelsDevMetadata(entries: CatalogEntry[]): Record<string, ModelsDevMetadataEntry> {
  // A flat bare-id key makes the plugin's exact lookup deterministic; provider nesting can make
  // its model-portion fallback ambiguous when the same short id exists under multiple providers.
  return Object.fromEntries(
    dedupeById(entries).map((entry) => {
      const context = entry.limits?.context;
      const input = entry.limits?.input;
      const output = entry.limits?.output;
      const limit: ModelsDevLimit = {
        ...(finiteNumber(context) ? { context } : {}),
        ...(finiteNumber(input) ? { input } : {}),
        ...(finiteNumber(output) ? { output } : {}),
      };
      return [entry.id, { id: entry.id, ...(Object.keys(limit).length > 0 ? { limit } : {}) }];
    }),
  );
}

export function resolveModel(id: string, entries: CatalogEntry[]): string {
  const exact = entries.find((entry) => entry.canonical === id);
  if (exact) return exact.canonical;

  const matches = entries.filter((entry) => entry.id === id);
  if (matches.length > 0) return matches.reduce(preferZen).canonical;

  throw new ModelNotFoundError(`Model '${id}' not found in the model catalog.`);
}
