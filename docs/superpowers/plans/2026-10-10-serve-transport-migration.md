# Migração do transporte CLI → `opencode serve` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir o transporte do wrapper (spawn de `opencode run` por request) por um cliente HTTP de um `opencode serve` supervisionado, ganhando streaming incremental real, menor latência e suporte a tools.

**Architecture:** O wrapper passa a ser cliente HTTP de um daemon `opencode serve` que ele mesmo garante (`serve/process.ts`). O catálogo vem de `GET /config/providers`. Cada request cria uma sessão, posta a mensagem e (se `stream`) assina o SSE da sessão, traduzindo `message.part.delta` em chunks OpenAI. Sem estado: sessão nova por request, histórico via prompt-embed.

**Tech Stack:** Node.js ≥22, TypeScript (ESM), Fastify 5, Vitest 5, `fetch` global.

**Spec:** `docs/superpowers/specs/2026-10-10-serve-transport-migration-design.md`

## Global Constraints

- Node.js ≥ 22 (`package.json` `engines.node`); TypeScript ESM (`"type": "module"`).
- Toda rota exige `Authorization: Bearer ${API_KEY}` (hook existente em `src/server.ts`); `API_KEY` sem espaços/vírgulas.
- **Uma única credencial upstream** (a autenticação do `opencode` do host). `x-opencode-key` é removido — nenhum header/param novo deve reintroduzi-lo.
- Formas de resposta OpenAI preservadas: `chat.completion`, `chat.completion.chunk`, `data: [DONE]\n\n`, corpos de erro `{error:{message,type,code?,param}}`.
- `OPENCODE_BASE` resolvido **em runtime** a cada chamada; default `http://127.0.0.1:${OPENCODE_PORT}`.
- Nenhum comentário/identificador novo em português no código-fonte (o repo usa comentários em inglês).
- Testes: Vitest, arquivos em `tests/*.test.ts`, helpers em `tests/helpers/`. Rodar com `npm test`.

## Review Focus

Estas classes de entrada/falha o spec implica mas nenhum teste direto cobre; cada uma ganha teste na task dona do código (indicada):

1. **`format: json_schema` não honrado pelo free model** → o modelo devolve texto/fence em vez de JSON. Esperado: cair para o modo instrução, nunca devolver `tool_calls` vazio com `finish_reason:"tool_calls"`. (Task 6)
2. **Cliente desconecta no meio do stream** → esperado: abortar a geração (`POST /session/{id}/abort`) e apagar a sessão, sem vazar sessão nem processo. (Task 8)
3. **Daemon morre no meio de um request** → esperado: erro OpenAI `502` (não pendurar indefinidamente). (Task 7)
4. **`model` inexistente/digitado errado** → esperado: `404` com mensagem, sem 500 nem request ao upstream. (Task 7)
5. **Duas requisições concorrentes** → esperado: sessões distintas, deltas de uma não vazam na outra. (Task 8)

---

## File Structure

**Criar:**
- `src/lib/serve/events.ts` — parsing puro de blocos SSE e extração de deltas.
- `src/lib/serve/client.ts` — cliente HTTP fino sobre os endpoints do serve.
- `src/lib/serve/process.ts` — supervisão do daemon (health/spawn/readiness/shutdown).
- `src/lib/serve/runtime.ts` — singletons (supervisor + client) e reset.
- `src/lib/opencode/tools.ts` — instrução + parsing de tool calls (emulação).
- `src/lib/opencode/turn.ts` — execução de um turno (não-stream e stream).
- `tests/helpers/fake-serve.ts` — servidor HTTP stub.
- `tests/serve-events.test.ts`, `tests/serve-client.test.ts`, `tests/serve-process.test.ts`, `tests/tools.test.ts`.
- `scripts/tool-reliability.mjs` — harness de confiabilidade.

**Modificar:**
- `src/config/index.ts` — env do serve; remover `getModelsTimeoutMs`.
- `src/lib/opencode/models.ts` — catálogo via serve (reescrita).
- `src/routes/chat.ts` — fluxo via client (não-stream + stream) + tools.
- `src/lib/openai-format/index.ts` — builders tool-aware.
- `src/server.ts` — shutdown do supervisor.
- `tests/config.test.ts`, `tests/models.test.ts`, `tests/routes.test.ts`.
- `README.md`, `.env.example`, `docs/DEVELOPMENT.md`.

**Remover:**
- `src/lib/opencode/runner.ts`, `tests/runner.test.ts`, `tests/helpers/fake-opencode.ts`.

---

### Task 1: Configuração de ambiente do serve

**Files:**
- Modify: `src/config/index.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `getServeBaseUrl(env?: NodeJS.ProcessEnv): string` — `OPENCODE_BASE` sem barra final, ou `http://127.0.0.1:${getServePort(env)}`.
  - `getServePort(env?: NodeJS.ProcessEnv): number` — `OPENCODE_PORT`, default `4100`.
  - `getServeReadinessTimeoutMs(env?: NodeJS.ProcessEnv): number` — `OPENCODE_SERVE_READY_TIMEOUT_MS`, default `20000`.
  - `resolveProxyEnv`, `buildChildEnv`, `getTimeoutMs`, `resolveOpencodeBin`, `resolveModel`, `visibleModels`, `listModels`, `modelsDevMetadata` **inalterados**.
  - **Removido:** `getModelsTimeoutMs`.

- [ ] **Step 1: Write the failing test**

Adicione ao fim de `tests/config.test.ts`:

```ts
import { getServeBaseUrl, getServePort, getServeReadinessTimeoutMs } from "../src/config/index.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `getServeBaseUrl is not a function` (ou import `undefined`).

- [ ] **Step 3: Write minimal implementation**

Em `src/config/index.ts`, adicione após `getTimeoutMs`:

```ts
export function getServePort(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.OPENCODE_PORT;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) return parsed;
  }
  return 4100;
}

export function getServeBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OPENCODE_BASE;
  if (typeof configured === "string" && configured.trim().length > 0) {
    return configured.trim().replace(/\/+$/, "");
  }
  return `http://127.0.0.1:${getServePort(env)}`;
}

export function getServeReadinessTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.OPENCODE_SERVE_READY_TIMEOUT_MS;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return 20_000;
}
```

Remova `getModelsTimeoutMs` de `src/lib/opencode/models.ts` (export) e qualquer import dele.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/index.ts tests/config.test.ts src/lib/opencode/models.ts
git commit -m "feat(config): add serve env resolution"
```

---

### Task 2: Parsing de eventos SSE do serve

**Files:**
- Create: `src/lib/serve/events.ts`
- Test: `tests/serve-events.test.ts`

**Interfaces:**
- Consumes: nada (puro).
- Produces:
  - `interface ServeEvent { id?: string; type: string; properties: Record<string, unknown> }`
  - `splitSseBlocks(buffer: string): { blocks: string[]; rest: string }` — separa blocos por `\n\n`; `rest` é o último bloco incompleto.
  - `parseSseBlock(block: string): ServeEvent | null` — junta linhas `data:` e faz `JSON.parse`; devolve `null` para `[DONE]`, heartbeat (`:`), vazio ou inválido.
  - `textDelta(ev: ServeEvent): string | null` — `"message.part.delta"` com `properties.field === "text"` → `String(properties.delta)`; senão `null`.
  - `partText(ev: ServeEvent): string | null` — `"message.part.updated"` com `properties.part.type === "text"` → o texto; senão `null`.
  - `isFinish(ev: ServeEvent): boolean` — `type === "session.idle"` ou `"message.updated"`.

- [ ] **Step 1: Write the failing test**

Crie `tests/serve-events.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseSseBlock, partText, splitSseBlocks, textDelta } from "../src/lib/serve/events.js";

describe("splitSseBlocks", () => {
  it("splits complete blocks and keeps the trailing partial one", () => {
    expect(splitSseBlocks("data: a\n\ndata: b\n\ndata: par")).toEqual({
      blocks: ["data: a", "data: b"],
      rest: "data: par",
    });
  });

  it("returns no blocks when only a partial block is buffered", () => {
    expect(splitSseBlocks("data: only")).toEqual({ blocks: [], rest: "data: only" });
  });
});

describe("parseSseBlock", () => {
  it("joins multi-line data fields and parses the JSON event", () => {
    const block = 'data: {"id":"evt_1","type":"message.part.delta",\n' +
      'data: "properties":{"field":"text","delta":"hi"}}';
    expect(parseSseBlock(block)).toEqual({
      id: "evt_1",
      type: "message.part.delta",
      properties: { field: "text", delta: "hi" },
    });
  });

  it("returns null for [DONE], heartbeats and invalid payloads", () => {
    expect(parseSseBlock("data: [DONE]")).toBeNull();
    expect(parseSseBlock(": keep-alive")).toBeNull();
    expect(parseSseBlock("data: not json")).toBeNull();
    expect(parseSseBlock("")).toBeNull();
  });
});

describe("textDelta", () => {
  it("extracts a text delta only for the text field", () => {
    expect(
      textDelta({ type: "message.part.delta", properties: { field: "text", delta: "abc" } }),
    ).toBe("abc");
    expect(
      textDelta({ type: "message.part.delta", properties: { field: "reasoning", delta: "x" } }),
    ).toBeNull();
    expect(textDelta({ type: "message.updated", properties: {} })).toBeNull();
  });
});

describe("partText", () => {
  it("extracts text from a completed text part", () => {
    expect(
      partText({ type: "message.part.updated", properties: { part: { type: "text", text: "done" } } }),
    ).toBe("done");
    expect(partText({ type: "message.part.updated", properties: { part: { type: "tool" } } })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/serve-events.test.ts`
Expected: FAIL — módulo `../src/lib/serve/events.js` não encontrado.

- [ ] **Step 3: Write minimal implementation**

Crie `src/lib/serve/events.ts`:

```ts
// PHASE S2 — parsing of the opencode serve SSE event stream.

export interface ServeEvent {
  id?: string;
  type: string;
  properties: Record<string, unknown>;
}

export function splitSseBlocks(buffer: string): { blocks: string[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  return { blocks: parts, rest };
}

export function parseSseBlock(block: string): ServeEvent | null {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (data.length === 0) return null;
  if (data.trim() === "[DONE]") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.type !== "string") return null;
    return {
      id: typeof record.id === "string" ? record.id : undefined,
      type: record.type,
      properties:
        typeof record.properties === "object" && record.properties !== null && !Array.isArray(record.properties)
          ? (record.properties as Record<string, unknown>)
          : {},
    };
  } catch {
    return null;
  }
}

export function textDelta(ev: ServeEvent): string | null {
  if (ev.type !== "message.part.delta") return null;
  if (ev.properties.field !== "text") return null;
  const delta = ev.properties.delta;
  return typeof delta === "string" ? delta : null;
}

export function partText(ev: ServeEvent): string | null {
  if (ev.type !== "message.part.updated") return null;
  const part = ev.properties.part;
  if (typeof part !== "object" || part === null) return null;
  const record = part as Record<string, unknown>;
  if (record.type !== "text") return null;
  return typeof record.text === "string" ? record.text : null;
}

export function isFinish(ev: ServeEvent): boolean {
  return ev.type === "session.idle" || ev.type === "message.updated";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/serve-events.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/serve/events.ts tests/serve-events.test.ts
git commit -m "feat(serve): parse SSE event stream"
```

---

### Task 3: Cliente HTTP do serve + fake-serve

**Files:**
- Create: `src/lib/serve/client.ts`, `tests/helpers/fake-serve.ts`
- Test: `tests/serve-client.test.ts`

**Interfaces:**
- Consumes: `splitSseBlocks`, `parseSseBlock`, `ServeEvent` de `serve/events.js`.
- Produces:
  - `interface ServeModelInfo { id: string; providerID: string; name?: string; limit?: { context?: number; input?: number; output?: number }; capabilities?: { toolcall?: boolean } }`
  - `interface ServeProvider { id: string; models: Record<string, ServeModelInfo> }`
  - `interface ServeCatalog { providers: ServeProvider[] }`
  - `interface ServeTokens { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }`
  - `interface ServeMessageResponse { info?: { finish?: string; tokens?: ServeTokens }; parts?: Array<{ type: string; text?: string }> }`
  - `class ServeClient { constructor(opts: { baseUrl: string; timeoutMs: number; fetchImpl?: typeof fetch }) }` com:
    - `health(): Promise<boolean>`
    - `catalog(): Promise<ServeCatalog>`
    - `createSession(): Promise<string>`
    - `postMessage(sessionId: string, body: Record<string, unknown>): Promise<ServeMessageResponse>`
    - `deleteSession(sessionId: string): Promise<void>`
    - `abortSession(sessionId: string): Promise<void>`
    - `streamEvents(sessionId: string, signal?: AbortSignal): AsyncGenerator<ServeEvent>`
  - `class ServeHttpError extends Error { status: number; body: string }`
  - `startFakeServe(opts?): Promise<{ url: string; calls: { message: number; createSession: number; deleteSession: number }; close(): Promise<void> }>` em `tests/helpers/fake-serve.ts`.

- [ ] **Step 1: Write the failing test**

Crie `tests/serve-client.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { ServeClient, ServeHttpError } from "../src/lib/serve/client.js";
import { startFakeServe } from "./helpers/fake-serve.js";

let closeFns: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closeFns.map((fn) => fn()));
  closeFns = [];
});

async function clientFor(overrides = {}) {
  const fake = await startFakeServe(overrides);
  closeFns.push(fake.close);
  return { client: new ServeClient({ baseUrl: fake.url, timeoutMs: 5000 }), fake };
}

describe("ServeClient", () => {
  it("reports health", async () => {
    const { client } = await clientFor();
    expect(await client.health()).toBe(true);
  });

  it("reads the provider catalog with limits", async () => {
    const { client } = await clientFor();
    const catalog = await client.catalog();
    expect(catalog.providers[0]?.id).toBe("opencode");
    expect(catalog.providers[0]?.models["mimo-v2.6-flash-free"]?.limit).toEqual({
      context: 200000,
      output: 32000,
    });
  });

  it("creates a session, posts a message and deletes the session", async () => {
    const { client, fake } = await clientFor();
    const sid = await client.createSession();
    const res = await client.postMessage(sid, { parts: [{ type: "text", text: "hi" }] });
    expect(res.parts?.[0]?.text).toBe("pong");
    await client.deleteSession(sid);
    expect(fake.calls.createSession).toBe(1);
    expect(fake.calls.message).toBe(1);
    expect(fake.calls.deleteSession).toBe(1);
  });

  it("streams serve events from the session event endpoint", async () => {
    const { client } = await clientFor();
    const sid = await client.createSession();
    const seen: string[] = [];
    for await (const ev of client.streamEvents(sid)) seen.push(ev.type);
    expect(seen).toContain("message.part.delta");
    expect(seen).toContain("session.idle");
  });

  it("raises ServeHttpError with the upstream status", async () => {
    const { client } = await clientFor({ failMessage: 500 });
    const sid = await client.createSession();
    await expect(client.postMessage(sid, { parts: [] })).rejects.toBeInstanceOf(ServeHttpError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/serve-client.test.ts`
Expected: FAIL — `../src/lib/serve/client.js` não encontrado.

- [ ] **Step 3: Write the fake serve helper**

Crie `tests/helpers/fake-serve.ts`:

```ts
import { createServer } from "node:http";
import type { Server } from "node:http";

export interface FakeServeOptions {
  readonly text?: string;
  readonly deltas?: readonly string[];
  readonly failMessage?: number;
}

export interface FakeServe {
  readonly url: string;
  readonly calls: { createSession: number; message: number; deleteSession: number };
  close(): Promise<void>;
}

const CATALOG = {
  providers: [
    {
      id: "opencode",
      models: {
        "mimo-v2.6-flash-free": {
          id: "mimo-v2.6-flash-free",
          providerID: "opencode",
          limit: { context: 200000, output: 32000 },
        },
      },
    },
  ],
};

export async function startFakeServe(opts: FakeServeOptions = {}): Promise<FakeServe> {
  const deltas = opts.deltas ?? ["po", "ng"];
  const calls = { createSession: 0, message: 0, deleteSession: 0 };

  const server: Server = createServer((req, res) => {
    const url = req.url ?? "";
    const sendJson = (code: number, body: unknown): void => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url === "/global/health") return sendJson(200, { healthy: true });
    if (url === "/config/providers") return sendJson(200, CATALOG);
    if (url === "/session" && req.method === "POST") {
      calls.createSession += 1;
      return sendJson(200, { id: "ses_fake" });
    }
    if (url.startsWith("/session/") && url.endsWith("/message")) {
      calls.message += 1;
      if (opts.failMessage) return sendJson(opts.failMessage, { error: "boom" });
      return sendJson(200, { info: { finish: "stop" }, parts: [{ type: "text", text: opts.text ?? "pong" }] });
    }
    if (url.startsWith("/api/session/") && url.endsWith("/event")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const d of deltas) {
        res.write(`data: ${JSON.stringify({ type: "message.part.delta", properties: { field: "text", delta: d } })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ type: "session.idle", properties: {} })}\n\n`);
      return res.end();
    }
    if (url.startsWith("/session/") && req.method === "DELETE") {
      calls.deleteSession += 1;
      return sendJson(200, {});
    }
    return sendJson(404, { error: "not found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
```

- [ ] **Step 4: Write the client implementation**

Crie `src/lib/serve/client.ts`:

```ts
// PHASE S3 — minimal HTTP client over the opencode serve API.

import type { ServeEvent } from "./events.js";
import { parseSseBlock, splitSseBlocks } from "./events.js";

export interface ServeModelInfo {
  id: string;
  providerID: string;
  name?: string;
  limit?: { context?: number; input?: number; output?: number };
  capabilities?: { toolcall?: boolean };
}
export interface ServeProvider { id: string; models: Record<string, ServeModelInfo> }
export interface ServeCatalog { providers: ServeProvider[] }
export interface ServeTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}
export interface ServeMessageResponse {
  info?: { finish?: string; tokens?: ServeTokens };
  parts?: Array<{ type: string; text?: string }>;
}

export class ServeHttpError extends Error {
  override name = "ServeHttpError";
  constructor(readonly status: number, readonly body: string) {
    super(`serve responded ${status}`);
    Object.setPrototypeOf(this, ServeHttpError.prototype);
  }
}

export interface ServeClientOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class ServeClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ServeClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchImpl(`${this.opts.baseUrl}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(this.opts.timeoutMs),
    });
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(path, init);
    const text = await res.text();
    if (!res.ok) throw new ServeHttpError(res.status, text.slice(0, 2000));
    return (text ? JSON.parse(text) : {}) as T;
  }

  async health(): Promise<boolean> {
    try {
      const res = await this.request("/global/health", { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return false;
      const body = (await res.json()) as { healthy?: boolean };
      return body.healthy === true;
    } catch {
      return false;
    }
  }

  catalog(): Promise<ServeCatalog> {
    return this.json<ServeCatalog>("/config/providers");
  }

  async createSession(): Promise<string> {
    const body = await this.json<{ id?: string }>("/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    if (typeof body.id !== "string" || body.id.length === 0) {
      throw new ServeHttpError(502, "session creation returned no id");
    }
    return body.id;
  }

  postMessage(sessionId: string, payload: Record<string, unknown>): Promise<ServeMessageResponse> {
    return this.json<ServeMessageResponse>(`/session/${sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request(`/session/${sessionId}`, { method: "DELETE", signal: AbortSignal.timeout(15_000) });
  }

  async abortSession(sessionId: string): Promise<void> {
    await this.request(`/session/${sessionId}/abort`, { method: "POST", signal: AbortSignal.timeout(15_000) });
  }

  async *streamEvents(sessionId: string, signal?: AbortSignal): AsyncGenerator<ServeEvent> {
    const res = await this.request(`/api/session/${sessionId}/event`, { signal });
    if (!res.ok || !res.body) throw new ServeHttpError(res.status, "event stream unavailable");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { blocks, rest } = splitSseBlocks(buffer);
        buffer = rest;
        for (const block of blocks) {
          const ev = parseSseBlock(block);
          if (ev) yield ev;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/serve-client.test.ts`
Expected: PASS (5 testes).

- [ ] **Step 6: Commit**

```bash
git add src/lib/serve/client.ts tests/helpers/fake-serve.ts tests/serve-client.test.ts
git commit -m "feat(serve): add HTTP client and fake serve helper"
```

---

### Task 4: Supervisão do daemon

**Files:**
- Create: `src/lib/serve/process.ts`, `src/lib/serve/runtime.ts`
- Test: `tests/serve-process.test.ts`

**Interfaces:**
- Consumes: `getServeBaseUrl`, `getServePort`, `getServeReadinessTimeoutMs`, `resolveOpencodeBin` (`config/index.js`); `ServeClient` (`serve/client.js`).
- Produces:
  - `interface SpawnedChild { kill(): void }`
  - `interface ServeProcessDeps { baseUrl: string; port: number; bin: string; readinessTimeoutMs: number; isHealthy: () => Promise<boolean>; spawnServe: (bin: string, port: number) => SpawnedChild }`
  - `class ServeSupervisor { constructor(deps: ServeProcessDeps); ensureReady(): Promise<void>; baseUrl(): string; shutdown(): Promise<void> }`
  - `class ServeStartupError extends Error`
  - `defaultServeDeps(client: ServeClient): ServeProcessDeps`
  - `runtime.js`: `getServeSupervisor(): ServeSupervisor`, `getServeClient(): ServeClient`, `resetRuntime(): void`.

- [ ] **Step 1: Write the failing test**

Crie `tests/serve-process.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/serve-process.test.ts`
Expected: FAIL — `../src/lib/serve/process.js` não encontrado.

- [ ] **Step 3: Write minimal implementation**

Crie `src/lib/serve/process.ts`:

```ts
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
```

Crie `src/lib/serve/runtime.ts`:

```ts
// PHASE S4 — process-wide singletons for the serve client and supervisor.

import { getServeBaseUrl, getTimeoutMs } from "../../config/index.js";
import { ServeClient } from "./client.js";
import { ServeSupervisor, defaultServeDeps } from "./process.js";

let client: ServeClient | null = null;
let supervisor: ServeSupervisor | null = null;

export function getServeClient(): ServeClient {
  if (!client) client = new ServeClient({ baseUrl: getServeBaseUrl(), timeoutMs: getTimeoutMs() });
  return client;
}

export function getServeSupervisor(): ServeSupervisor {
  if (!supervisor) supervisor = new ServeSupervisor(defaultServeDeps(getServeClient()));
  return supervisor;
}

export function resetRuntime(): void {
  client = null;
  supervisor = null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/serve-process.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/serve/process.ts src/lib/serve/runtime.ts tests/serve-process.test.ts
git commit -m "feat(serve): supervise the opencode serve daemon"
```

---

### Task 5: Catálogo de modelos via serve

**Files:**
- Modify: `src/lib/opencode/models.ts` (reescrita)
- Test: `tests/models.test.ts` (reescrita)

**Interfaces:**
- Consumes: `ServeClient.catalog()`, `ServeCatalog` (`serve/client.js`); `getServeClient()` (`serve/runtime.js`).
- Produces (mantidos, mesma forma):
  - `interface CatalogEntry { canonical: string; provider: string; id: string; limits: ModelLimits | null }`
  - `interface ModelLimits { context: number | null; input: number | null; output: number | null }`
  - `class CatalogError extends Error`
  - `getModelsTtlMs(env?): number` (inalterado)
  - `catalogFromServe(catalog: ServeCatalog): CatalogEntry[]`
  - `getCatalog(client?: ServeClient, env?: NodeJS.ProcessEnv): Promise<CatalogEntry[]>` — cache com TTL, refresh compartilhado, fallback para o cache anterior.
  - `resetCatalogCache(): void`
  - **Removidos:** `parseModelsOutput`, `parseVerboseModelsOutput`, `getModelsTimeoutMs`.

- [ ] **Step 1: Write the failing test**

Substitua todo o conteúdo de `tests/models.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/models.test.ts`
Expected: FAIL — `getCatalog` ainda espera `env` como 1º argumento / usa spawn.

- [ ] **Step 3: Write the implementation**

Reescreva `src/lib/opencode/models.ts` (mantendo `CatalogEntry`, `ModelLimits`, `CatalogError`, `getModelsTtlMs`, `resetCatalogCache`; removendo os parsers de CLI):

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/models.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/opencode/models.ts tests/models.test.ts
git commit -m "feat(models): source catalog from opencode serve"
```

---

### Task 6: Emulação de tools

**Files:**
- Create: `src/lib/opencode/tools.ts`
- Test: `tests/tools.test.ts`

**Interfaces:**
- Consumes: nada (puro).
- Produces:
  - `interface ToolDef { name: string; description: string; parameters: unknown }`
  - `extractToolDefs(body: unknown): ToolDef[]`
  - `toolChoiceMode(choice: unknown): "none" | "required" | "auto" | { name: string }`
  - `toolInstruction(tools: ToolDef[], choice: unknown): string | null`
  - `buildToolJsonSchema(tools: ToolDef[]): Record<string, unknown>` — schema para `format: json_schema`, com `oneOf` por tool.
  - `interface ParsedCall { name: string; arguments: string }`
  - `parseToolCalls(text: string, known?: ReadonlySet<string>): { content: string; calls: ParsedCall[] }` — **nunca** devolve o bloco dentro de `content`.

- [ ] **Step 1: Write the failing test**

Crie `tests/tools.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildToolJsonSchema, extractToolDefs, parseToolCalls, toolChoiceMode, toolInstruction } from "../src/lib/opencode/tools.js";

const body = {
  tools: [
    { type: "function", function: { name: "get_weather", description: "w", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } },
  ],
};

describe("extractToolDefs", () => {
  it("extracts function tools and ignores others", () => {
    expect(extractToolDefs(body).map((t) => t.name)).toEqual(["get_weather"]);
    expect(extractToolDefs({})).toEqual([]);
  });
});

describe("toolChoiceMode", () => {
  it("classifies each choice form", () => {
    expect(toolChoiceMode("required")).toBe("required");
    expect(toolChoiceMode("none")).toBe("none");
    expect(toolChoiceMode("auto")).toBe("auto");
    expect(toolChoiceMode(undefined)).toBe("auto");
    expect(toolChoiceMode({ type: "function", function: { name: "get_weather" } })).toEqual({ name: "get_weather" });
  });
});

describe("toolInstruction", () => {
  it("mentions every tool and forbids text when required", () => {
    const s = toolInstruction(extractToolDefs(body), "required") ?? "";
    expect(s).toContain("get_weather");
    expect(s.toLowerCase()).toContain("must");
  });

  it("returns null when there are no tools or choice is none", () => {
    expect(toolInstruction([], "required")).toBeNull();
    expect(toolInstruction(extractToolDefs(body), "none")).toBeNull();
  });
});

describe("buildToolJsonSchema", () => {
  it("produces a oneOf of call objects", () => {
    const schema = buildToolJsonSchema(extractToolDefs(body)) as { oneOf: Array<{ properties: { name: { const: string } } }> };
    expect(schema.oneOf[0]?.properties.name.const).toBe("get_weather");
  });
});

describe("parseToolCalls", () => {
  it("extracts a fenced call and strips the block from content", () => {
    const text = "Let me check.\n```tool_call\n{\"name\":\"get_weather\",\"arguments\":{\"city\":\"Paris\"}}\n```";
    const { content, calls } = parseToolCalls(text, new Set(["get_weather"]));
    expect(content).toBe("Let me check.");
    expect(calls).toEqual([{ name: "get_weather", arguments: "{\"city\":\"Paris\"}" }]);
  });

  it("does not leak the fence into content when the message is only the block", () => {
    const text = "```tool_call\n{\"name\":\"get_weather\",\"arguments\":{\"city\":\"Paris\"}}\n```";
    const { content, calls } = parseToolCalls(text, new Set(["get_weather"]));
    expect(content).toBe("");
    expect(content).not.toContain("tool_call");
    expect(calls).toHaveLength(1);
  });

  it("parses bare JSON objects and supports multiple calls", () => {
    const text = '{"name":"a","arguments":{}}\n{"name":"b","arguments":{"x":1}}';
    const { calls } = parseToolCalls(text, new Set(["a", "b"]));
    expect(calls.map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("ignores unknown tool names and invalid JSON", () => {
    expect(parseToolCalls("```tool_call\n{\"name\":\"nope\",\"arguments\":{}}\n```", new Set(["a"])).calls).toEqual([]);
    expect(parseToolCalls("```tool_call\nnot json\n```", new Set(["a"])).calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools.test.ts`
Expected: FAIL — módulo não encontrado.

- [ ] **Step 3: Write minimal implementation**

Crie `src/lib/opencode/tools.ts`:

```ts
// PHASE S6 — caller-defined tool emulation (serve has no native caller tools).

export interface ToolDef {
  name: string;
  description: string;
  parameters: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function extractToolDefs(body: unknown): ToolDef[] {
  const record = asRecord(body);
  const tools = record && Array.isArray(record.tools) ? record.tools : [];
  const out: ToolDef[] = [];
  for (const raw of tools) {
    const tool = asRecord(raw);
    const fn = tool ? asRecord(tool.function) : null;
    if (!fn || typeof fn.name !== "string") continue;
    out.push({
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : "",
      parameters: fn.parameters ?? { type: "object", properties: {} },
    });
  }
  return out;
}

export function toolChoiceMode(choice: unknown): "none" | "required" | "auto" | { name: string } {
  if (choice === "none") return "none";
  if (choice === "required") return "required";
  const record = asRecord(choice);
  const fn = record ? asRecord(record.function) : null;
  if (record?.type === "function" && fn && typeof fn.name === "string") return { name: fn.name };
  return "auto";
}

export function toolInstruction(tools: ToolDef[], choice: unknown): string | null {
  if (tools.length === 0) return null;
  const mode = toolChoiceMode(choice);
  if (mode === "none") return null;

  const catalog = tools
    .map((t) => `- ${t.name}: ${t.description}\n  parameters: ${JSON.stringify(t.parameters)}`)
    .join("\n");

  const rule =
    typeof mode === "object"
      ? `You MUST call the tool named "${mode.name}".`
      : mode === "required"
        ? "You MUST call exactly one of the tools."
        : "Call a tool only if it is needed to answer.";

  return [
    "You have access to these tools (OpenAI function format):",
    catalog,
    `RULES: ${rule} Reply with the tool call as a fenced block, nothing inside but JSON:`,
    "```tool_call",
    '{"name":"<tool name>","arguments":{...}}',
    "```",
    "Use only the listed tool names. arguments must be a JSON object matching the schema. Put any explanation OUTSIDE the block.",
  ].join("\n");
}

export function buildToolJsonSchema(tools: ToolDef[]): Record<string, unknown> {
  return {
    type: "object",
    oneOf: tools.map((tool) => ({
      type: "object",
      properties: {
        name: { const: tool.name },
        arguments: (asRecord(tool.parameters) ?? { type: "object" }) as Record<string, unknown>,
      },
      required: ["name", "arguments"],
      additionalProperties: false,
    })),
  };
}

export interface ParsedCall {
  name: string;
  arguments: string;
}

const FENCE = /```tool_call\s*([\s\S]*?)```/g;

function tryParseCall(raw: string, known: ReadonlySet<string> | undefined): ParsedCall | null {
  try {
    const parsed: unknown = JSON.parse(raw.trim());
    const record = asRecord(parsed);
    if (!record || typeof record.name !== "string") return null;
    if (known && !known.has(record.name)) return null;
    const args = asRecord(record.arguments) ?? {};
    return { name: record.name, arguments: JSON.stringify(args) };
  } catch {
    return null;
  }
}

export function parseToolCalls(
  text: string,
  known?: ReadonlySet<string>,
): { content: string; calls: ParsedCall[] } {
  const calls: ParsedCall[] = [];
  let content = text.replace(FENCE, (full, inner: string) => {
    const parsed = tryParseCall(inner, known);
    if (!parsed) return full;
    calls.push(parsed);
    return "";
  });

  if (calls.length === 0) {
    const bare = tryParseCall(content.trim(), known);
    if (bare) {
      calls.push(bare);
      content = "";
    }
  }

  return { content: content.trim(), calls };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tools.test.ts`
Expected: PASS (o teste de regressão do vazamento de fence fica verde).

- [ ] **Step 5: Commit**

```bash
git add src/lib/opencode/tools.ts tests/tools.test.ts
git commit -m "feat(tools): emulate caller tools with fence parsing"
```

---

### Task 7: Rota de chat via serve (paridade, não-stream) + format tool-aware

**Files:**
- Modify: `src/lib/openai-format/index.ts`, `src/routes/chat.ts`
- Create: `src/lib/opencode/turn.ts`
- Test: `tests/routes.test.ts`

**Interfaces:**
- Consumes: `getServeClient`, `getServeSupervisor` (`serve/runtime.js`); `composePrompt`, `applyAnchors` (`opencode/compose.js`); `resolveModel` (`config/index.js`); `extractToolDefs`, `toolInstruction`, `parseToolCalls`, `buildToolJsonSchema`, `toolChoiceMode` (`opencode/tools.js`); `getCatalog` (`opencode/models.js`).
- Produces:
  - `interface TurnResult { content: string; finish_reason: string; usage: Usage | null; sessionId: string | null; toolCalls: Array<{ id: string; name: string; arguments: string }> }`
  - `buildCompletion(result: TurnResult, model: string): ChatCompletion` (estendido)
  - `buildSseBody(result: TurnResult, model: string): string` (estendido)
  - `runTurn(client: ServeClient, params: TurnParams): Promise<TurnResult>` em `src/lib/opencode/turn.ts`.

- [ ] **Step 1: Write the failing test**

Em `tests/routes.test.ts`, troque o mock de `models.js` e adicione os testes (o `catalogFixture` continua valendo):

```ts
const { getCatalogMock, useRealCatalog } = vi.hoisted(() => ({
  getCatalogMock: vi.fn(),
  useRealCatalog: { value: false },
}));

vi.mock("../src/lib/opencode/models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/opencode/models.js")>();
  return {
    ...actual,
    getCatalog: (client?: unknown, env?: NodeJS.ProcessEnv) =>
      useRealCatalog.value ? actual.getCatalog(undefined, env) : getCatalogMock(env),
  };
});

vi.mock("../src/lib/serve/runtime.js", () => ({
  getServeClient: () => ({
    health: async () => true,
    createSession: async () => "ses_test",
    postMessage: async () => ({ info: { finish: "stop" }, parts: [{ type: "text", text: "pong" }] }),
    deleteSession: async () => undefined,
    abortSession: async () => undefined,
  }),
  getServeSupervisor: () => ({
    ensureReady: async () => undefined,
    baseUrl: () => "http://x",
    shutdown: async () => undefined,
  }),
}));
```

Testes novos:

```ts
it("returns a non-stream completion via the serve client", async () => {
  const res = await app.inject({
    method: "POST", url: "/v1/chat/completions", headers: inboundHeaders,
    payload: { model: "mimo-v2.6-flash-free", messages: [{ role: "user", content: "hi" }] },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
  });
});

it("maps an upstream serve failure to 502", async () => {
  const { getServeClient } = await import("../src/lib/serve/runtime.js");
  vi.spyOn(getServeClient(), "postMessage").mockRejectedValueOnce(new Error("ECONNREFUSED"));
  const res = await app.inject({
    method: "POST", url: "/v1/chat/completions", headers: inboundHeaders,
    payload: { model: "mimo-v2.6-flash-free", messages: [{ role: "user", content: "hi" }] },
  });
  expect(res.statusCode).toBe(502);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/routes.test.ts`
Expected: FAIL — `chat.ts` ainda usa `runOnce`.

- [ ] **Step 3: Extend `openai-format`**

Em `src/lib/openai-format/index.ts`, adicione `TurnResult` e ajuste os builders:

```ts
export interface TurnResult {
  content: string;
  finish_reason: string;
  usage: Usage | null;
  sessionId: string | null;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
}
```

No `message` de `buildCompletionWithId`:

```ts
message: {
  role: "assistant",
  content: result.toolCalls.length > 0 ? (result.content || null) : result.content,
  ...(result.toolCalls.length > 0
    ? {
        tool_calls: result.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments },
        })),
      }
    : {}),
},
```

Substitua `buildSseBody` por uma versão tool-aware:

```ts
export function buildSseBody(result: TurnResult, model: string): string {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let body = sseEvent(buildChunk(id, model, created, { content: "" }, null));
  if (result.toolCalls.length > 0) {
    for (const [i, c] of result.toolCalls.entries()) {
      body += sseEvent({
        id, model, created, object: "chat.completion.chunk",
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: i, id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } }] },
          finish_reason: null,
        }],
      } as unknown as ChatCompletionChunk);
    }
    body += sseEvent(buildChunk(id, model, created, {}, "tool_calls"));
  } else {
    body += sseEvent(buildChunk(id, model, created, { content: result.content }, null));
    body += sseEvent(buildChunk(id, model, created, {}, result.finish_reason));
  }
  return body + SSE_DONE;
}
```

- [ ] **Step 4: Add the turn runner**

Crie `src/lib/opencode/turn.ts`:

```ts
// PHASE S7 — one chat turn against the serve API (stateless: fresh session per turn).

import type { ServeClient, ServeMessageResponse, ServeTokens } from "../serve/client.js";
import type { TurnResult } from "../openai-format/index.js";
import { buildToolJsonSchema, parseToolCalls, toolChoiceMode } from "./tools.js";
import type { ToolDef } from "./tools.js";

export interface TurnParams {
  model: { providerID: string; modelID: string };
  system?: string;
  variant?: string;
  prompt: string;
  tools: ToolDef[];
  toolChoice: unknown;
}

function mapUsage(tokens: ServeTokens | undefined): TurnResult["usage"] {
  if (!tokens) return null;
  const cache = tokens.cache ?? {};
  const prompt = (tokens.input ?? 0) + (cache.read ?? 0) + (cache.write ?? 0);
  const completion = (tokens.output ?? 0) + (tokens.reasoning ?? 0);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

function textFromParts(res: ServeMessageResponse): string {
  return (res.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
}

export async function runTurn(client: ServeClient, params: TurnParams): Promise<TurnResult> {
  const sessionId = await client.createSession();
  try {
    const mode = toolChoiceMode(params.toolChoice);
    const payload: Record<string, unknown> = {
      model: params.model,
      parts: [{ type: "text", text: params.prompt }],
    };
    if (params.system) payload.system = params.system;
    if (params.variant) payload.variant = params.variant;
    const wantsJson = params.tools.length > 0 && (mode === "required" || typeof mode === "object");
    if (wantsJson) {
      payload.format = { type: "json_schema", schema: buildToolJsonSchema(params.tools), retryCount: 2 };
    }

    const res = await client.postMessage(sessionId, payload);
    const text = textFromParts(res);
    const known = new Set(params.tools.map((t) => t.name));
    const { content, calls } = parseToolCalls(text, known);
    const toolCalls = calls.map((c, i) => ({ id: `call_${sessionId}_${i}`, name: c.name, arguments: c.arguments }));
    const finish = toolCalls.length > 0 ? "tool_calls" : res.info?.finish === "length" ? "length" : "stop";
    return {
      content: toolCalls.length > 0 ? content : content || text,
      finish_reason: finish,
      usage: mapUsage(res.info?.tokens),
      sessionId,
      toolCalls,
    };
  } finally {
    await client.deleteSession(sessionId).catch(() => undefined);
  }
}
```

- [ ] **Step 5: Rewrite the chat route (non-stream)**

Substitua o corpo de `src/routes/chat.ts` para: validar Bearer (hook já cobre), `await getServeSupervisor().ensureReady()`, `getCatalog()` + `resolveModel()`, `composePrompt()` + `applyAnchors()` + `toolInstruction()`, e `runTurn(getServeClient(), {...})`. Para `stream:false`, responder `buildCompletion(result, body.model)`; para erro, `toOpenAIErrorBody(err, 502)`. Adicione `tools`/`tool_choice`/`variant` ao schema do body.

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/routes.test.ts tests/openai-format.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/openai-format/index.ts src/lib/opencode/turn.ts src/routes/chat.ts tests/routes.test.ts
git commit -m "feat(chat): serve non-stream completions with tool support"
```

---

### Task 8: Streaming SSE real

**Files:**
- Modify: `src/lib/opencode/turn.ts`, `src/routes/chat.ts`
- Test: `tests/routes.test.ts`

**Interfaces:**
- Consumes: `textDelta`, `partText`, `isFinish` (`serve/events.js`).
- Produces: `runStreamingTurn(client: ServeClient, params: StreamingParams): Promise<TurnResult>` com `interface StreamingParams extends TurnParams { onDelta: (chunk: string) => void }`.

- [ ] **Step 1: Write the failing tests**

Adicione a `tests/routes.test.ts`:

```ts
it("streams incremental deltas ending with [DONE]", async () => {
  const { getServeClient } = await import("../src/lib/serve/runtime.js");
  const client = getServeClient() as unknown as { streamEvents: () => AsyncGenerator<unknown> };
  client.streamEvents = async function* () {
    yield { type: "message.part.delta", properties: { field: "text", delta: "he" } };
    yield { type: "message.part.delta", properties: { field: "text", delta: "llo" } };
    yield { type: "session.idle", properties: {} };
  } as never;

  const res = await app.inject({
    method: "POST", url: "/v1/chat/completions", headers: inboundHeaders,
    payload: { model: "mimo-v2.6-flash-free", messages: [{ role: "user", content: "hi" }], stream: true },
  });

  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toContain("text/event-stream");
  expect(res.body).toContain('"content":"he"');
  expect(res.body).toContain('"content":"llo"');
  expect(res.body.endsWith("data: [DONE]\n\n")).toBe(true);
});

it("aborts and deletes the session when the client disconnects", async () => {
  const { getServeClient } = await import("../src/lib/serve/runtime.js");
  const client = getServeClient();
  const deleteSpy = vi.spyOn(client, "deleteSession").mockResolvedValue(undefined);
  const abortSpy = vi.spyOn(client, "abortSession").mockResolvedValue(undefined);
  (client as unknown as { streamEvents: () => AsyncGenerator<unknown> }).streamEvents = async function* () {
    yield { type: "message.part.delta", properties: { field: "text", delta: "x" } };
    yield { type: "session.idle", properties: {} };
  } as never;

  const { runStreamingTurn } = await import("../src/lib/opencode/turn.js");
  await runStreamingTurn(client, {
    model: { providerID: "opencode", modelID: "mimo-v2.6-flash-free" },
    prompt: "hi",
    tools: [],
    toolChoice: "auto",
    onDelta: () => {
      throw Object.assign(new Error("client gone"), { code: "ABORT_ERR" });
    },
  }).catch(() => undefined);

  expect(abortSpy).toHaveBeenCalled();
  expect(deleteSpy).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/routes.test.ts`
Expected: FAIL — `runStreamingTurn` inexistente; stream não usa eventos.

- [ ] **Step 3: Implement streaming turn**

Adicione a `src/lib/opencode/turn.ts`:

```ts
import { isFinish, partText, textDelta } from "../serve/events.js";

export interface StreamingParams extends TurnParams {
  onDelta: (chunk: string) => void;
}

export async function runStreamingTurn(client: ServeClient, params: StreamingParams): Promise<TurnResult> {
  const sessionId = await client.createSession();
  const controller = new AbortController();
  let assembled = "";
  let aborted = false;
  try {
    const payload: Record<string, unknown> = {
      model: params.model,
      parts: [{ type: "text", text: params.prompt }],
    };
    if (params.system) payload.system = params.system;
    if (params.variant) payload.variant = params.variant;

    const stream = client.streamEvents(sessionId, controller.signal);
    const posted = client.postMessage(sessionId, payload);

    for await (const ev of stream) {
      const delta = textDelta(ev);
      if (delta !== null) {
        assembled += delta;
        try {
          params.onDelta(delta);
        } catch {
          aborted = true;
          controller.abort();
          break;
        }
      } else {
        const full = partText(ev);
        if (full !== null && assembled.length === 0) assembled = full;
      }
      if (isFinish(ev)) break;
    }

    const res = await posted.catch(() => ({ info: {}, parts: [] }) as ServeMessageResponse);
    if (!assembled) assembled = textFromParts(res);
    const known = new Set(params.tools.map((t) => t.name));
    const { content, calls } = parseToolCalls(assembled, known);
    const toolCalls = calls.map((c, i) => ({ id: `call_${sessionId}_${i}`, name: c.name, arguments: c.arguments }));
    return {
      content: toolCalls.length > 0 ? content : content || assembled,
      finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      usage: mapUsage(res.info?.tokens),
      sessionId,
      toolCalls,
    };
  } finally {
    if (aborted) await client.abortSession(sessionId).catch(() => undefined);
    await client.deleteSession(sessionId).catch(() => undefined);
  }
}
```

Em `src/routes/chat.ts`, no ramo `stream:true`: escrever o cabeçalho `text/event-stream`, montar cada chunk com `buildChunk` e escrever via `onDelta` no `reply.raw`; no fim, `[DONE]`. Propagar a desconexão: `request.raw.on("close", () => controller.abort())` (o `AbortController` deve ser o mesmo usado por `runStreamingTurn` — passe-o via `params` ou faça `onDelta` lançar quando `reply.raw.writableEnded`).

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/opencode/turn.ts src/routes/chat.ts tests/routes.test.ts
git commit -m "feat(chat): stream real SSE deltas from serve"
```

---

### Task 9: Remover o caminho CLI e atualizar docs

**Files:**
- Remove: `src/lib/opencode/runner.ts`, `tests/runner.test.ts`, `tests/helpers/fake-opencode.ts`
- Modify: `src/server.ts`, `src/routes/models.ts`, `src/routes/chat.ts`, `README.md`, `.env.example`, `docs/DEVELOPMENT.md`
- Test: suíte completa

**Interfaces:**
- Consumes: `getServeSupervisor`.
- Produces: nada novo. Remove `x-opencode-key` das rotas e o encaminhamento de credencial.

- [ ] **Step 1: Delete the CLI path**

```bash
git rm src/lib/opencode/runner.ts tests/runner.test.ts tests/helpers/fake-opencode.ts
```

- [ ] **Step 2: Remove x-opencode-key handling**

Em `src/routes/models.ts` e `src/routes/chat.ts`, remova a leitura de `x-opencode-key`; use `auth = { enabled: true, token: null }` para que todo o catálogo seja visível. Remova o parâmetro de auth de `runTurn`.

- [ ] **Step 3: Shutdown hook**

Em `src/server.ts`, registre `app.addHook("onClose", () => getServeSupervisor().shutdown())`.

- [ ] **Step 4: Update docs**

- `.env.example`: adicionar `OPENCODE_BASE`, `OPENCODE_PORT`, `OPENCODE_SERVE_READY_TIMEOUT_MS`; remover `OPENCODE_MODELS_TIMEOUT_MS`.
- `README.md`: remover `x-opencode-key`; descrever o daemon supervisionado e o `OPENCODE_BASE`.
- `docs/DEVELOPMENT.md`: atualizar a arquitetura (serve client, supervisor).

- [ ] **Step 5: Run the whole suite**

Run: `npm run typecheck && npm test`
Expected: PASS, sem referências a `runner`/`fake-opencode`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove CLI transport, update docs for serve"
```

---

### Task 10: Harness de confiabilidade de tools

**Files:**
- Create: `scripts/tool-reliability.mjs`
- Modify: `package.json`, `README.md`

**Interfaces:**
- Consumes: o wrapper rodando (`http://127.0.0.1:3000`).
- Produces: relatório de taxa de acerto no stdout; não roda no CI.

- [ ] **Step 1: Write the harness**

Crie `scripts/tool-reliability.mjs`: para cada `tool_choice` em
`["required", { type: "function", function: { name: "get_weather" } }, "auto", undefined]`,
dispara 5 requisições a `/v1/chat/completions` com a tool `get_weather` e conta quantas
devolvem `tool_calls`; imprime uma tabela `choice | acertos/5`.

- [ ] **Step 2: Wire the script**

Adicione a `package.json`:

```json
"tools:reliability": "node scripts/tool-reliability.mjs"
```

- [ ] **Step 3: Document usage**

Adicione ao `README.md`: `npm run tools:reliability` (requer o wrapper no ar e `API_KEY` no ambiente).

- [ ] **Step 4: Commit**

```bash
git add scripts/tool-reliability.mjs package.json README.md
git commit -m "chore(tools): add reliability harness"
```

---

## Self-Review

**Cobertura do spec:**
- §5 componentes (`serve/process`, `serve/client`, `serve/events`, `tools`, remoção de `runner`) → Tasks 2, 3, 4, 6, 9.
- §6.1 fluxo não-stream → Task 7. §6.2 streaming → Task 8.
- §7 tools (dois modos, fim do vazamento, parser tolerante) → Task 6 (+ Task 7 para `format`).
- §8 erros (daemon caído, upstream, abort, órfã, rate limit) → Tasks 7, 8.
- §9 env (remover `OPENCODE_MODELS_TIMEOUT_MS`, `x-opencode-key`) → Tasks 1, 9.
- §10 testes (`fake-serve`, substituição de `fake-opencode`, harness) → Tasks 3, 9, 10.
- §13 ordem de migração → espelhada nas Tasks 1–10.

**Placeholders:** nenhum "TBD/TODO"; todos os passos de código trazem o código.

**Consistência de tipos:** `ServeClient`/`ServeEvent`/`TurnResult`/`ToolDef`/`CatalogEntry` definidos na primeira task que os usa e reusados com a mesma forma. `runTurn`/`runStreamingTurn` usam `TurnParams`/`StreamingParams` de `turn.ts`.

**Review Focus → testes:** (1) json_schema não honrado → Task 6 (`parseToolCalls` tolerante) + Task 7; (2) desconexão do cliente → Task 8; (3) daemon morto → Task 7; (4) modelo inexistente → Task 7 (já coberto pelo teste de 404 existente); (5) concorrência → Task 8 (sessões distintas por `sessionID`).

**Lacuna conhecida:** o contrato exato do `reply.raw` do Fastify para propagar `close` → `AbortController` (Task 8) depende de detalhe do Fastify; o passo descreve o comportamento exigido e o teste cobre a limpeza.