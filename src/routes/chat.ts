import type { FastifyInstance } from "fastify";
import { ModelNotFoundError, resolveModel } from "../config/index.js";
import type { ChatMessage } from "../lib/opencode/compose.js";
import { applyAnchors, composePrompt } from "../lib/opencode/compose.js";
import { extractAuth } from "../lib/opencode/auth.js";
import { CatalogError, getCatalog } from "../lib/opencode/models.js";
import type { CatalogEntry } from "../lib/opencode/models.js";
import { extractToolDefs, toolInstruction } from "../lib/opencode/tools.js";
import { runTurn } from "../lib/opencode/turn.js";
import { getServeClient, getServeSupervisor } from "../lib/serve/runtime.js";
import { buildCompletion, buildSseBody, toOpenAIErrorBody } from "../lib/openai-format/index.js";

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
            content: { type: "string" },
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

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: ChatRequestBody }>(
    "/v1/chat/completions",
    { schema: chatBodySchema },
    async (request, reply) => {
      const body = request.body;
      const auth = extractAuth(request.headers["x-opencode-key"]);

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
        canonicalModel = resolveModel(body.model, auth, entries);
      } catch (err) {
        if (err instanceof ModelNotFoundError) {
          const mapped = toOpenAIErrorBody(err, 404);
          reply.status(mapped.status).send(mapped.body);
          return;
        }
        throw err;
      }

      const tools = extractToolDefs(body);
      const instruction = toolInstruction(tools, body.tool_choice);
      let prompt = applyAnchors(composePrompt(body.messages), {
        temperature: body.temperature,
        maxTokens: body.max_tokens,
      });
      if (instruction) prompt = `${prompt}\n\n${instruction}`;

      try {
        await getServeSupervisor().ensureReady();
        const result = await runTurn(getServeClient(), {
          model: splitCanonical(canonicalModel),
          prompt,
          variant: body.variant,
          tools,
          toolChoice: body.tool_choice,
        });

        if (!body.stream) {
          if (result.sessionId) reply.header("x-opencode-session-id", result.sessionId);
          reply.status(200).send(buildCompletion(result, body.model));
          return;
        }

        // Buffered SSE: one text/tool chunk set plus a terminal frame, then [DONE].
        reply.header("Content-Type", "text/event-stream");
        reply.header("Cache-Control", "no-store");
        reply.send(buildSseBody(result, body.model));
      } catch (error) {
        const mapped = toOpenAIErrorBody(error, 502);
        reply.status(mapped.status).send(mapped.body);
      }
    },
  );
}
