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
  // `structured` carries the `format: json_schema` result ({name, arguments}); it is
  // NOT returned as a text part, so a schema-constrained turn must read it here.
  info?: { finish?: string; tokens?: ServeTokens; structured?: unknown };
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
    // The wall-clock deadline is ALWAYS in force: a caller-supplied signal narrows
    // it, it never replaces it. Passing the caller signal through unchanged left the
    // SSE subscription with no deadline at all, so a turn whose message POST failed
    // fast (upstream 4xx/5xx) waited forever for a `session.idle` that never came.
    const deadline = AbortSignal.timeout(this.opts.timeoutMs);
    return this.fetchImpl(`${this.opts.baseUrl}${path}`, {
      ...init,
      signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
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