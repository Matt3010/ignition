import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { ApplicationError } from "../../domain/errors/application-error.js";

export async function registerErrorHandler(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((error, request, reply) => {
    const fastifyError = error as { code?: string; statusCode?: number; message?: string };
    if (typeof error === "object" && error !== null && "validation" in error) {
      const validation = (error as { validation?: unknown }).validation;
      return reply.status(400).send({
        error: {
          code: "INVALID_REQUEST",
          message: "Request non valida",
          details: Array.isArray(validation) ? validation : [],
        },
      });
    }

    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: "INVALID_REQUEST",
          message: "Request non valida",
          details: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      });
    }

    if (fastifyError.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.status(413).send({
        error: {
          code: "INVALID_REQUEST",
          message: "Payload troppo grande",
          details: [],
        },
      });
    }

    if (fastifyError.statusCode === 429) {
      return reply.status(429).send({
        error: {
          code: "RATE_LIMITED",
          message: "Troppe richieste",
          details: [],
        },
      });
    }

    if (fastifyError.statusCode && fastifyError.statusCode >= 400 && fastifyError.statusCode < 500) {
      return reply.status(fastifyError.statusCode).send({
        error: {
          code: "INVALID_REQUEST",
          message: fastifyError.message ?? "Request non valida",
          details: [],
        },
      });
    }

    if (error instanceof ApplicationError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      });
    }

    request.log.error({ err: error }, "Unhandled request error");
    return reply.status(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message:
          app.config.NODE_ENV === "production"
            ? "Errore interno"
            : error instanceof Error
              ? error.message
              : "Errore interno",
        details: [],
      },
    });
  });
}
