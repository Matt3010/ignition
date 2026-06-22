import type { FastifyReply, FastifyRequest } from "fastify";
import type { FileAppLogStore } from "../../infrastructure/app-logs/file-app-log-store.js";
import { appLogRequestSchema } from "../schemas/app-log.schema.js";
import { hashSessionId } from "../../domain/services/session-id.js";

export class AppLogController {
  constructor(private readonly store: FileAppLogStore) {}

  handle = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const payload = appLogRequestSchema.parse(request.body);
    const storedAt = new Date().toISOString();
    const file = await this.store.append(payload, {
      requestId: request.id,
      receivedAt: storedAt,
    });
    request.log.info(
      {
        sessionHash: hashSessionId(payload.sessionId),
        kind: payload.kind,
        rotated: file != `${payload.sessionId}.jsonl`,
      },
      "app debug log stored",
    );
    reply.send({
      stored: true,
      storedAt,
      file,
    });
  };
}

