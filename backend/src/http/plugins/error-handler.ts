import type { FastifyInstance, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { ApplicationError } from "../../domain/errors/application-error.js";

export async function registerErrorHandler(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((error, request, reply) => {
    const fastifyError = error as { code?: string; statusCode?: number; message?: string };
    if (typeof error === "object" && error !== null && "validation" in error) {
      const validation = (error as { validation?: unknown }).validation;
      const details = Array.isArray(validation) ? validation : [];
      logClientError(request, {
        statusCode: 400,
        code: "INVALID_REQUEST",
        message: "Request validation failed",
        details,
      });
      return reply.status(400).send({
        error: {
          code: "INVALID_REQUEST",
          message: "Request non valida",
          details,
        },
      });
    }

    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
      logClientError(request, {
        statusCode: 400,
        code: "INVALID_REQUEST",
        message: "Zod validation failed",
        details,
      });
      return reply.status(400).send({
        error: {
          code: "INVALID_REQUEST",
          message: "Request non valida",
          details,
        },
      });
    }

    if (fastifyError.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      logClientError(request, {
        statusCode: 413,
        code: "INVALID_REQUEST",
        message: "Payload too large",
        details: [],
      });
      return reply.status(413).send({
        error: {
          code: "INVALID_REQUEST",
          message: "Payload troppo grande",
          details: [],
        },
      });
    }

    if (fastifyError.statusCode === 429) {
      logClientError(request, {
        statusCode: 429,
        code: "RATE_LIMITED",
        message: "Rate limited",
        details: [],
      });
      return reply.status(429).send({
        error: {
          code: "RATE_LIMITED",
          message: "Troppe richieste",
          details: [],
        },
      });
    }

    if (error instanceof ApplicationError) {
      logClientError(request, {
        statusCode: error.statusCode,
        code: error.code,
        message: error.message,
        details: error.details,
      });
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      });
    }

    if (fastifyError.statusCode && fastifyError.statusCode >= 400 && fastifyError.statusCode < 500) {
      logClientError(request, {
        statusCode: fastifyError.statusCode,
        code: "INVALID_REQUEST",
        message: fastifyError.message ?? "Client request error",
        details: [],
      });
      return reply.status(fastifyError.statusCode).send({
        error: {
          code: "INVALID_REQUEST",
          message: fastifyError.message ?? "Request non valida",
          details: [],
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

function logClientError(
  request: FastifyRequest,
  event: { statusCode: number; code: string; message: string; details: unknown[] },
): void {
  const body = request.body as { sessionId?: string } | undefined;
  request.log.warn(
    {
      statusCode: event.statusCode,
      code: event.code,
      details: event.details,
      sessionHash: body?.sessionId ? hashSession(body.sessionId) : null,
    },
    event.message,
  );
}

function hashSession(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index++) hash = (hash * 33) ^ value.charCodeAt(index);
  return `s_${(hash >>> 0).toString(16)}`;
}
