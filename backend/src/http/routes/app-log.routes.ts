import type { FastifyInstance } from "fastify";
import { zodToJsonSchema } from "zod-to-json-schema";
import { FileAppLogStore } from "../../infrastructure/app-logs/file-app-log-store.js";
import { AppLogController } from "../controllers/app-log.controller.js";
import { normalizedErrorSchema } from "../schemas/error.schema.js";
import { appLogRequestSchema, appLogResponseSchema } from "../schemas/app-log.schema.js";

export async function registerAppLogRoutes(app: FastifyInstance): Promise<void> {
  const controller = new AppLogController(new FileAppLogStore(app.config.APP_DEBUG_LOG_DIR));
  app.post(
    "/api/v1/app-logs",
    {
      schema: {
        body: zodToJsonSchema(appLogRequestSchema),
        response: {
          200: zodToJsonSchema(appLogResponseSchema),
          400: zodToJsonSchema(normalizedErrorSchema),
          500: zodToJsonSchema(normalizedErrorSchema),
        },
      },
    },
    controller.handle,
  );
}
