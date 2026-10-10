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
