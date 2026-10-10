import { config as loadEnv } from "dotenv";
import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { describeProxyEnv, ModelNotFoundError, resolveProxyEnv } from "./config/index.js";
import { toOpenAIErrorBody } from "./lib/openai-format/index.js";
import { getServeSupervisor } from "./lib/serve/runtime.js";
import { chatRoutes } from "./routes/chat.js";
import { modelsRoutes } from "./routes/models.js";

function readStatusCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === "number" ? value : null;
}

function hasValidationErrors(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = (error as { validation?: unknown }).validation;
  return Array.isArray(value) && value.length > 0;
}

export function buildServer(apiKey = process.env.API_KEY): FastifyInstance {
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new Error("API_KEY must be configured");
  }
  if (!/^[^\s,]+$/.test(apiKey)) {
    throw new Error("API_KEY must be a valid Bearer token without whitespace or commas");
  }

  const app = Fastify({ logger: true });

  app.addHook("onRequest", async (request, reply) => {
    const authorization = request.headers.authorization;
    const match = typeof authorization === "string"
      ? /^Bearer ([^\s,]+)$/i.exec(authorization)
      : null;
    const providedKey = match?.[1];
    const provided = Buffer.from(providedKey ?? "");
    const expected = Buffer.from(apiKey);
    const valid = provided.length === expected.length && timingSafeEqual(provided, expected);

    if (!valid) {
      reply.status(401).send({
        error: {
          message: "Invalid authentication credentials",
          type: "server_error",
          code: "opencode_error",
          param: null,
        },
      });
    }
  });

  const proxyEnv = resolveProxyEnv();
  const proxyConfigured = Boolean(proxyEnv.HTTP_PROXY);
  if (proxyConfigured) {
    app.log.info(`outbound proxy configured: ${describeProxyEnv()}`);
  } else {
    app.log.debug("outbound proxy: none");
  }

  app.register(modelsRoutes);
  app.register(chatRoutes);

  // Stop the supervised `opencode serve` daemon when the server closes, so it
  // never outlives the wrapper holding the port.
  app.addHook("onClose", () => getServeSupervisor().shutdown());

  app.get("/health", async () => ({ status: "ok" }));

  app.setErrorHandler((error: unknown, _request, reply) => {
    if (hasValidationErrors(error) || readStatusCode(error) === 400) {
      const mapped = toOpenAIErrorBody(error, 400);
      reply.status(mapped.status).send(mapped.body);
      return;
    }

    if (error instanceof ModelNotFoundError) {
      const mapped = toOpenAIErrorBody(error, 404);
      reply.status(mapped.status).send(mapped.body);
      return;
    }

    const mapped = toOpenAIErrorBody(error, 500);
    reply.status(mapped.status).send(mapped.body);
  });

  return app;
}

const entry = process.argv[1];
const isMain = typeof entry === "string" && (entry.endsWith("server.js") || entry.endsWith("server.ts"));

if (isMain) {
  loadEnv();
  const app = buildServer();
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  const host = process.env.HOST ?? "0.0.0.0";

  app.listen({ port, host }).catch((err: unknown) => {
    app.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
