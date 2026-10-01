import type { FastifyInstance } from "fastify";
import { listModels, modelsDevMetadata } from "../config/index.js";
import { CatalogError, getCatalog } from "../lib/opencode/models.js";
import { toOpenAIErrorBody } from "../lib/openai-format/index.js";

export async function modelsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/models", async (_request, reply) => {
    try {
      const entries = await getCatalog();
      reply.status(200).send(listModels(entries));
    } catch (error) {
      if (!(error instanceof CatalogError)) throw error;
      const mapped = toOpenAIErrorBody(error, 500);
      reply.status(mapped.status).send(mapped.body);
    }
  });

  app.get("/models.dev.json", async (_request, reply) => {
    try {
      const entries = await getCatalog();
      reply.status(200).send(modelsDevMetadata(entries));
    } catch (error) {
      if (!(error instanceof CatalogError)) throw error;
      const mapped = toOpenAIErrorBody(error, 500);
      reply.status(mapped.status).send(mapped.body);
    }
  });
}
