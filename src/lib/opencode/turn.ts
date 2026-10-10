// PHASE S7 — one chat turn against the serve API (stateless: fresh session per turn).

import type { ServeClient, ServeMessageResponse, ServeTokens } from "../serve/client.js";
import type { TurnResult } from "../openai-format/index.js";
import { isFinish, partText, textDelta } from "../serve/events.js";
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

export interface StreamingParams extends TurnParams {
  onDelta: (chunk: string) => void;
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

// Streaming variant: opens the session event stream BEFORE posting the message,
// forwards each text delta to onDelta as it arrives, then assembles the final
// TurnResult (including tool calls parsed out of the assembled text).
//
// If onDelta throws — the consumer went away mid-turn — the turn is aborted and
// the session deleted so neither the generation nor the session leaks.
export async function runStreamingTurn(client: ServeClient, params: StreamingParams): Promise<TurnResult> {
  const sessionId = await client.createSession();
  const controller = new AbortController();
  const emptyResponse: ServeMessageResponse = { info: {}, parts: [] };
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
    // Swallow a late rejection when we skip awaiting `posted` after an abort.
    posted.catch(() => undefined);

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

    // On abort, do NOT await the in-flight message: it resolves only when the
    // (still running) generation completes, which would defeat the abort.
    const res = aborted ? emptyResponse : await posted.catch(() => emptyResponse);
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
