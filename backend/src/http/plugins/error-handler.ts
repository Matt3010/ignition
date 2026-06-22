import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { ApplicationError } from "../../domain/errors/application-error.js";
import { hashSessionId } from "../../domain/services/session-id.js";

interface ErrorResponseOptions {
  statusCode: number;
  code: string;
  publicMessage: string;
  logMessage: string;
  details?: unknown[];
}

export async function registerErrorHandler(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((error, request, reply) => {
    const fastifyError = error as { code?: string; statusCode?: number; message?: string };

    if (typeof error === "object" && error !== null && "validation" in error) {
      const validation = (error as { validation?: unknown }).validation;
      return sendClientError(request, reply, {
        statusCode: 400,
        code: "INVALID_REQUEST",
        publicMessage: "Request non valida",
        logMessage: "Request validation failed",
        details: Array.isArray(validation) ? validation : [],
      });
    }

    if (error instanceof ZodError) {
      return sendClientError(request, reply, {
        statusCode: 400,
        code: "INVALID_REQUEST",
        publicMessage: "Request non valida",
        logMessage: "Zod validation failed",
        details: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    if (fastifyError.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return sendClientError(request, reply, {
        statusCode: 413,
        code: "INVALID_REQUEST",
        publicMessage: "Payload troppo grande",
        logMessage: "Payload too large",
      });
    }

    if (fastifyError.statusCode === 429) {
      return sendClientError(request, reply, {
        statusCode: 429,
        code: "RATE_LIMITED",
        publicMessage: "Troppe richieste",
        logMessage: "Rate limited",
      });
    }

    if (error instanceof ApplicationError) {
      return sendClientError(request, reply, {
        statusCode: error.statusCode,
        code: error.code,
        publicMessage: error.message,
        logMessage: error.message,
        details: error.details,
      });
    }

    if (fastifyError.statusCode && fastifyError.statusCode >= 400 && fastifyError.statusCode < 500) {
      const message = fastifyError.message ?? "Client request error";
      return sendClientError(request, reply, {
        statusCode: fastifyError.statusCode,
        code: "INVALID_REQUEST",
        publicMessage: fastifyError.message ?? "Request non valida",
        logMessage: message,
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

function sendClientError(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ErrorResponseOptions,
): FastifyReply {
  const details = options.details ?? [];
  const body = request.body as { sessionId?: string } | undefined;
  request.log.warn(
    {
      statusCode: options.statusCode,
      code: options.code,
      details,
      sessionHash: body?.sessionId ? hashSessionId(body.sessionId) : null,
    },
    options.logMessage,
  );

  return reply.status(options.statusCode).send({
    error: {
      code: options.code,
      message: options.publicMessage,
      details,
    },
  });
}
