import type { FastifyInstance } from "fastify";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { GetRoadContextUseCase } from "../../application/use-cases/get-road-context.use-case.js";
import { RoadContextController } from "../controllers/road-context.controller.js";
import { normalizedErrorSchema } from "../schemas/error.schema.js";
import { roadContextRequestSchema, roadContextResponseSchema } from "../schemas/road-context.schema.js";

export async function registerRoadContextRoutes(
  app: FastifyInstance,
  useCase: GetRoadContextUseCase,
): Promise<void> {
  const controller = new RoadContextController(useCase);
  app.post(
    "/api/v1/road-context",
    {
      schema: {
        body: zodToJsonSchema(roadContextRequestSchema),
        response: {
          200: zodToJsonSchema(roadContextResponseSchema),
          400: zodToJsonSchema(normalizedErrorSchema),
          409: zodToJsonSchema(normalizedErrorSchema),
          429: zodToJsonSchema(normalizedErrorSchema),
          500: zodToJsonSchema(normalizedErrorSchema),
        },
      },
    },
    controller.handle,
  );
}
