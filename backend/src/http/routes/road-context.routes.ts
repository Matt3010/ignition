import type { FastifyInstance } from "fastify";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { GetRoadContextUseCase } from "../../application/use-cases/get-road-context.use-case.js";
import { RoadContextController } from "../controllers/road-context.controller.js";
import { roadContextRequestSchema, roadContextResponseSchema } from "../schemas/road-context.schema.js";
import { errorResponses } from "../schemas/route-schema.js";

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
          ...errorResponses(400, 413, 409, 429, 500),
        },
      },
    },
    controller.handle,
  );
}
