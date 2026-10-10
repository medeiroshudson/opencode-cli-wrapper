// PHASE P5 — OpenAI-compatible format layer.
// Translates a TurnResult into OpenAI-shaped responses, SSE chunks, and error bodies.

import { randomUUID } from "node:crypto";

export interface TurnResult {
  content: string;
  finish_reason: string;
  usage: Usage | null;
  sessionId: string | null;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
}

export type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type CompletionToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type CompletionChoice = {
  index: number;
  message: { role: string; content: string | null; tool_calls?: CompletionToolCall[] };
  finish_reason: string | null;
};

export type ChatCompletion = {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: CompletionChoice[];
  usage?: Usage;
};

export type DeltaToolCall = {
  index: number;
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type DeltaContent = { content?: string; tool_calls?: DeltaToolCall[] };

export type ChatCompletionChunk = {
  id: string;
  model: string;
  created: number;
  object: string;
  choices: Array<{ index: number; delta: DeltaContent; finish_reason: string | null }>;
};

export type OpenAIErrorBody = {
  message: string;
  type: string;
  code?: string;
  param: string | null;
};

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | null {
  return typeof value === "object" && value !== null ? (value as Rec) : null;
}

function detectStatus(err: unknown): number | null {
  const rec = asRecord(err);
  if (!rec) return null;
  if (typeof rec.status === "number") return rec.status;
  if (typeof rec.statusCode === "number") return rec.statusCode;
  return null;
}

export function buildCompletionWithId(
  result: TurnResult,
  model: string,
  id: string,
  created: number,
): ChatCompletion {
  const completion: ChatCompletion = {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: result.toolCalls.length > 0 ? result.content || null : result.content,
          ...(result.toolCalls.length > 0
            ? {
                tool_calls: result.toolCalls.map((c) => ({
                  id: c.id,
                  type: "function" as const,
                  function: { name: c.name, arguments: c.arguments },
                })),
              }
            : {}),
        },
        finish_reason: result.finish_reason,
      },
    ],
  };
  if (result.usage !== null) completion.usage = result.usage;
  return completion;
}

export function buildCompletion(result: TurnResult, model: string): ChatCompletion {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  return buildCompletionWithId(result, model, id, created);
}

export function buildChunk(
  id: string,
  model: string,
  created: number,
  delta: DeltaContent,
  finishReason: string | null,
): ChatCompletionChunk {
  return {
    id,
    model,
    created,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export const SSE_DONE = "data: [DONE]\n\n";

export function toOpenAIErrorBody(
  err: unknown,
  status = 500,
): { status: number; body: { error: OpenAIErrorBody } } {
  const message = err instanceof Error ? err.message : String(err);
  const detected = detectStatus(err);
  // An upstream 4xx belongs to the caller (rate limit, rejected request) and must
  // survive: the fallback describes the wrapper's own failure (502 = transport or
  // startup), so letting it win flattened a 429 into a 502. An upstream 5xx keeps the
  // fallback, which is how the wrapper reports an unhealthy daemon.
  const finalStatus = detected !== null && detected >= 400 && detected < 500 ? detected : status;

  const error: OpenAIErrorBody =
    finalStatus === 400 || finalStatus === 422
      ? { message, type: "invalid_request_error", param: null }
      : finalStatus === 429
        ? { message, type: "rate_limit_error", code: "rate_limit_exceeded", param: null }
        : { message, type: "server_error", code: "opencode_error", param: null };

  return { status: finalStatus, body: { error } };
}
