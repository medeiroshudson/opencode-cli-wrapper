import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { ModelNotFoundError, resolveModel } from "../config/index.js";
import type { ChatMessage } from "../lib/opencode/compose.js";
import { applyAnchors, composePrompt } from "../lib/opencode/compose.js";
import { CatalogError, getCatalog } from "../lib/opencode/models.js";
import type { CatalogEntry } from "../lib/opencode/models.js";
import { extractToolDefs, toolChoiceMode, toolInstruction } from "../lib/opencode/tools.js";
import { runStreamingTurn, runTurn } from "../lib/opencode/turn.js";
import { getServeClient, getServeSupervisor } from "../lib/serve/runtime.js";
import type { DeltaContent } from "../lib/openai-format/index.js";
import { buildChunk, buildCompletion, sseEvent, SSE_DONE, toOpenAIErrorBody } from "../lib/openai-format/index.js";

interface ChatRequestBody {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  variant?: string;
  tools?: unknown[];
  tool_choice?: unknown;
}

const chatBodySchema = {
  body: {
    type: "object",
    required: ["model", "messages"],
    properties: {
      model: { type: "string" },
      messages: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["role", "content"],
          properties: {
            role: { type: "string" },
            // A tool-only assistant turn sends `content: null`; a caller may also send
            // Anthropic-style blocks (`[{type:"text",text:"…"}]`). compose.normalizeContent
            // flattens that array form.
            content: { type: ["string", "null", "array"], items: { type: ["object", "string"] } },
          },
        },
      },
      stream: { type: "boolean" },
      temperature: { type: "number" },
      max_tokens: { type: "integer" },
      variant: { type: "string" },
      tools: { type: "array" },
      tool_choice: {},
    },
  },
} as const;

// The catalog canonical is always "provider/id"; split on the first slash.
function splitCanonical(canonical: string): { providerID: string; modelID: string } {
  const slash = canonical.indexOf("/");
  if (slash < 0) return { providerID: canonical, modelID: canonical };
  return { providerID: canonical.slice(0, slash), modelID: canonical.slice(slash + 1) };
}

// Aborts `controller` on a real client disconnect — the RESPONSE closing before it
// finished. A normal completion ends the response (writableFinished true) before the
// socket closes, so it must NOT abort.
//
// Listening on the request instead is wrong: `request.raw` "close" fires as soon as
// the request body is fully read (≈1 ms into the handler), which would abort every
// normal streaming POST.
export function wireClientDisconnect(
  res: { on(event: "close", cb: () => void): void; writableFinished: boolean },
  controller: AbortController,
): void {
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: ChatRequestBody }>(
    "/v1/chat/completions",
    { schema: chatBodySchema },
    async (request, reply) => {
      const body = request.body;

      // The daemon must be up before the catalog fetch: getServeClient() only
      // constructs a client, so a cold start would otherwise hit a dead port.
      try {
        await getServeSupervisor().ensureReady();
      } catch (error) {
        const mapped = toOpenAIErrorBody(error, 502);
        reply.status(mapped.status).send(mapped.body);
        return;
      }

      let entries: CatalogEntry[];
      try {
        entries = await getCatalog();
      } catch (error) {
        if (!(error instanceof CatalogError)) throw error;
        const mapped = toOpenAIErrorBody(error, 500);
        reply.status(mapped.status).send(mapped.body);
        return;
      }

      let canonicalModel: string;
      try {
        canonicalModel = resolveModel(body.model, entries);
      } catch (err) {
        if (err instanceof ModelNotFoundError) {
          const mapped = toOpenAIErrorBody(err, 404);
          reply.status(mapped.status).send(mapped.body);
          return;
        }
        throw err;
      }

      const tools = extractToolDefs(body);
      // A required/named turn is constrained by `format: json_schema` alone
      // (turn.ts prepare()). Adding the fence instruction on top makes the model
      // follow the instruction instead of the schema — it answers with a
      // ```tool_call block, which cannot satisfy the schema, and the serve fails
      // the turn with StructuredOutputError. Measured 4/4 fail with it, 4/4 pass
      // without.
      const mode = toolChoiceMode(body.tool_choice);
      const instruction = mode === "required" || typeof mode === "object" ? null : toolInstruction(tools, body.tool_choice);
      let prompt = applyAnchors(composePrompt(body.messages), {
        temperature: body.temperature,
        maxTokens: body.max_tokens,
      });
      if (instruction) prompt = `${prompt}\n\n${instruction}`;

      const turnParams = {
        model: splitCanonical(canonicalModel),
        prompt,
        variant: body.variant,
        tools,
        toolChoice: body.tool_choice,
      };
      const client = getServeClient();

      try {
        if (!body.stream) {
          const result = await runTurn(client, turnParams);
          if (result.sessionId) reply.header("x-opencode-session-id", result.sessionId);
          reply.status(200).send(buildCompletion(result, body.model));
          return;
        }

        // Real SSE: stream incremental text deltas, then tool calls / finish, then [DONE].
        const id = `chatcmpl-${randomUUID()}`;
        const created = Math.floor(Date.now() / 1000);
        let started = false;
        let roleSent = false;
        let contentStreamed = false;
        // A consumer that goes away mid-turn aborts this controller; runStreamingTurn
        // then stops the generation and deletes the session instead of leaking it.
        const disconnect = new AbortController();
        wireClientDisconnect(reply.raw, disconnect);

        const writeChunk = (delta: DeltaContent, finish: string | null): void => {
          if (!started) {
            started = true;
            reply.hijack();
            reply.raw.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-store",
            });
          }
          // The first chunk carries the role, so OpenAI clients see delta.role first.
          const payload = roleSent ? delta : { role: "assistant", ...delta };
          roleSent = true;
          reply.raw.write(sseEvent(buildChunk(id, body.model, created, payload, finish)));
        };

        try {
          const result = await runStreamingTurn(client, {
            ...turnParams,
            signal: disconnect.signal,
            onDelta: (chunk) => {
              if (disconnect.signal.aborted || reply.raw.destroyed || reply.raw.writableEnded) {
                throw new Error("client disconnected");
              }
              contentStreamed = true;
              writeChunk({ content: chunk }, null);
            },
          });

          if (result.toolCalls.length > 0) {
            for (const [i, c] of result.toolCalls.entries()) {
              writeChunk(
                {
                  tool_calls: [
                    { index: i, id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } },
                  ],
                },
                null,
              );
            }
            writeChunk({}, "tool_calls");
          } else {
            // A required/named turn buffers its content instead of streaming it, so a
            // model that ignored the schema still delivers its prose.
            if (!contentStreamed && result.content) writeChunk({ content: result.content }, null);
            writeChunk({}, result.finish_reason);
          }
          reply.raw.write(SSE_DONE);
        } catch (error) {
          const mapped = toOpenAIErrorBody(error, 502);
          // Headers are already on the wire; surface the failure inside the stream.
          if (started) {
            reply.raw.write(sseEvent({ error: mapped.body.error }));
            // Terminate explicitly: a client keyed on [DONE] would otherwise treat the
            // error frame as a truncated stream and wait for more.
            reply.raw.write(SSE_DONE);
          } else {
            reply.status(mapped.status).send(mapped.body);
            return;
          }
        } finally {
          if (started) reply.raw.end();
        }
      } catch (error) {
        const mapped = toOpenAIErrorBody(error, 502);
        reply.status(mapped.status).send(mapped.body);
      }
    },
  );
}
