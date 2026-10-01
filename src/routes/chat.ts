import type { FastifyInstance } from "fastify";
import { ModelNotFoundError, resolveModel } from "../config/index.js";
import type { ChatMessage } from "../lib/opencode/compose.js";
import { applyAnchors, composePrompt } from "../lib/opencode/compose.js";
import { extractAuth } from "../lib/opencode/auth.js";
import { CatalogError, getCatalog } from "../lib/opencode/models.js";
import type { CatalogEntry } from "../lib/opencode/models.js";
import { runOnce } from "../lib/opencode/runner.js";
import { buildCompletion, buildSseBody, SSE_DONE, toOpenAIErrorBody } from "../lib/openai-format/index.js";

interface ChatRequestBody {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  variant?: string;
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
    },
  },
} as const;

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
        canonicalModel = resolveModel(body.model, entries);
      } catch (err) {
        if (err instanceof ModelNotFoundError) {
          const mapped = toOpenAIErrorBody(err, 404);
          reply.status(mapped.status).send(mapped.body);
          return;
        }
        throw err;
      }

      const prompt = applyAnchors(composePrompt(body.messages), {
        temperature: body.temperature,
        maxTokens: body.max_tokens,
      });
      const env = { ...process.env, ...(auth.token ? { OPENCODE_API_KEY: auth.token } : {}) };
      const result = await runOnce({ model: canonicalModel, prompt, variant: body.variant }, env);

      if (!body.stream) {
        if (result.error) {
          const mapped = toOpenAIErrorBody(new Error(result.error), 500);
          reply.status(mapped.status).send(mapped.body);
          return;
        }
        if (result.sessionId) reply.header("x-opencode-session-id", result.sessionId);
        reply.status(200).send(buildCompletion(result, body.model));
        return;
      }

      // Buffered single-step SSE: `opencode run --format json` emits one text event per step.
      reply.header("Content-Type", "text/event-stream");
      reply.header("Cache-Control", "no-store");
      if (result.error) {
        const errorFrame = `data: ${JSON.stringify({ error: result.error })}\n\n`;
        reply.send(errorFrame + SSE_DONE);
        return;
      }
      reply.send(buildSseBody(result.content, body.model, result.finish_reason));
    },
  );
}
