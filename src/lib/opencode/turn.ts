// PHASE S7 — one chat turn against the serve API (stateless: fresh session per turn).
//
// Both entry points share `prepare` (request payload) and `assemble` (OpenAI-shaped
// result). The only difference is that the streaming variant forwards text deltas as
// they arrive; the authoritative answer, finish reason and tokens always come from
// the buffered `postMessage` response, so nothing is reconstructed from deltas.

import type { ServeClient, ServeMessageResponse, ServeTokens } from "../serve/client.js";
import type { TurnResult } from "../openai-format/index.js";
import { newStreamState, projectEvent } from "../serve/events.js";
import { buildToolJsonSchema, createFenceGuard, parseToolCalls, toolChoiceMode } from "./tools.js";
import type { ParsedCall, ToolDef } from "./tools.js";

export interface TurnParams {
  model: { providerID: string; modelID: string };
  system?: string;
  variant?: string;
  prompt: string;
  tools: ToolDef[];
  toolChoice: unknown;
}

export interface StreamingParams extends TurnParams {
  onDelta: (chunk: string) => void;
  // Optional caller signal (e.g. the HTTP request closing). When it aborts, the
  // turn stops and runs the same abort+delete cleanup as a consumer failure.
  signal?: AbortSignal;
}

const EMPTY_RESPONSE: ServeMessageResponse = { info: {}, parts: [] };

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

// The serve answers a failed generation with HTTP 200 and the failure inside
// info.error ({name, data:{message, statusCode}}). Surfacing it as an exception
// keeps an upstream rejection (schema refused, rate limit) from becoming an
// empty 200 completion that looks like the model chose not to answer.
export class TurnFailedError extends Error {
  override name = "TurnFailedError";
  constructor(readonly statusCode: number | null, message: string) {
    super(message);
    Object.setPrototypeOf(this, TurnFailedError.prototype);
  }
}

function upstreamError(res: ServeMessageResponse): TurnFailedError | null {
  const raw = res.info?.error;
  if (typeof raw !== "object" || raw === null) return null;
  const err = raw as { name?: unknown; message?: unknown; data?: unknown };
  const data = typeof err.data === "object" && err.data !== null ? (err.data as { message?: unknown; statusCode?: unknown }) : {};
  const message =
    typeof data.message === "string" && data.message.length > 0
      ? data.message
      : typeof err.message === "string" && err.message.length > 0
        ? err.message
        : typeof err.name === "string"
          ? err.name
          : "upstream generation failed";
  const statusCode = typeof data.statusCode === "number" ? data.statusCode : null;
  return new TurnFailedError(statusCode, message);
}

// A `format: json_schema` turn does not answer with text: serve puts the constrained
// object on `info.structured` ({name, arguments}) and the text parts stay empty, so
// reading only the parts makes a required/named turn look like an empty message.
function structuredCall(res: ServeMessageResponse, known: ReadonlySet<string>): ParsedCall | null {
  const structured = res.info?.structured;
  if (typeof structured !== "object" || structured === null || Array.isArray(structured)) return null;
  const record = structured as Record<string, unknown>;
  if (typeof record.name !== "string" || !known.has(record.name)) return null;
  const args = record.arguments;
  return {
    name: record.name,
    arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
  };
}

interface PreparedTurn {
  payload: Record<string, unknown>;
  wantsJson: boolean;
  known: Set<string>;
}

// Spec §7.2: a required/named tool_choice asks for a call, not prose, so the turn is
// constrained to the tool JSON schema.
function prepare(params: TurnParams): PreparedTurn {
  const mode = toolChoiceMode(params.toolChoice);
  const wantsJson = params.tools.length > 0 && (mode === "required" || typeof mode === "object");
  const payload: Record<string, unknown> = {
    model: params.model,
    parts: [{ type: "text", text: params.prompt }],
  };
  if (params.system) payload.system = params.system;
  if (params.variant) payload.variant = params.variant;
  if (wantsJson) {
    payload.format = { type: "json_schema", schema: buildToolJsonSchema(params.tools), retryCount: 2 };
  }
  return { payload, wantsJson, known: new Set(params.tools.map((t) => t.name)) };
}

function assemble(res: ServeMessageResponse, prepared: PreparedTurn, sessionId: string): TurnResult {
  const failed = upstreamError(res);
  if (failed) throw failed;
  const text = textFromParts(res);
  const parsed = parseToolCalls(text, prepared.known);
  const structured = prepared.wantsJson ? structuredCall(res, prepared.known) : null;
  const calls: ParsedCall[] = structured ? [structured] : parsed.calls;
  const toolCalls = calls.map((c, i) => ({ id: `call_${sessionId}_${i}`, name: c.name, arguments: c.arguments }));
  const finish = toolCalls.length > 0 ? "tool_calls" : res.info?.finish === "length" ? "length" : "stop";
  return {
    content: toolCalls.length > 0 ? parsed.content : parsed.content || text,
    finish_reason: finish,
    usage: mapUsage(res.info?.tokens),
    sessionId,
    toolCalls,
  };
}

export async function runTurn(client: ServeClient, params: TurnParams): Promise<TurnResult> {
  const sessionId = await client.createSession();
  try {
    const prepared = prepare(params);
    const res = await client.postMessage(sessionId, prepared.payload);
    return assemble(res, prepared, sessionId);
  } finally {
    await client.deleteSession(sessionId).catch(() => undefined);
  }
}

export async function runStreamingTurn(client: ServeClient, params: StreamingParams): Promise<TurnResult> {
  const sessionId = await client.createSession();
  const controller = new AbortController();
  let aborted = false;

  // A caller-supplied signal (route disconnect) aborts the turn too, even when no
  // further delta ever arrives to trigger onDelta.
  const external = params.signal;
  const onExternalAbort = (): void => {
    aborted = true;
    controller.abort();
  };
  if (external) {
    if (external.aborted) onExternalAbort();
    else external.addEventListener("abort", onExternalAbort);
  }

  try {
    const prepared = prepare(params);
    // A schema-constrained turn has no prose to stream — it answers with a tool call,
    // which the route emits from the assembled result. Buffering it is the whole job.
    if (prepared.wantsJson) {
      const res = await client.postMessage(sessionId, prepared.payload);
      return assemble(res, prepared, sessionId);
    }

    const state = newStreamState(sessionId);
    const fenceGuard = createFenceGuard();

    const emit = (chunk: string): void => {
      if (chunk.length === 0) return;
      try {
        params.onDelta(chunk);
      } catch {
        aborted = true;
        controller.abort();
      }
    };

    const stream = client.streamEvents(controller.signal);
    const posted = client.postMessage(sessionId, prepared.payload);
    // Swallow a late rejection when we skip awaiting `posted` after an abort.
    posted.catch(() => undefined);

    let failed: string | null = null;
    try {
      for await (const ev of stream) {
        if (aborted) break;
        const projected = projectEvent(state, ev);
        if (projected.delta !== null) {
          // The guard withholds anything that could become a ```tool_call fence, so a
          // fence is never emitted as content and then re-emitted as tool_calls.
          emit(fenceGuard.push(projected.delta));
        }
        if (projected.failed !== null) {
          failed = projected.failed;
          aborted = true;
          controller.abort();
          break;
        }
        if (projected.done) break;
      }
    } catch (error) {
      // The event stream dropped mid-turn: stop the generation before cleanup, then
      // rethrow unless we already initiated the abort ourselves (signal/onDelta).
      const selfInflicted = aborted;
      aborted = true;
      controller.abort();
      if (!selfInflicted) throw error;
    }

    // Release the text the guard held back (trailing prose after a fence, or a
    // fragment that never became one).
    if (!aborted) emit(fenceGuard.flush());
    if (failed !== null) throw new Error(failed);

    // On abort, do NOT await the in-flight message: it resolves only when the
    // (still running) generation completes, which would defeat the abort.
    const res = aborted ? EMPTY_RESPONSE : await posted.catch(() => EMPTY_RESPONSE);
    return assemble(res, prepared, sessionId);
  } finally {
    if (external) external.removeEventListener("abort", onExternalAbort);
    if (aborted) await client.abortSession(sessionId).catch(() => undefined);
    await client.deleteSession(sessionId).catch(() => undefined);
  }
}
