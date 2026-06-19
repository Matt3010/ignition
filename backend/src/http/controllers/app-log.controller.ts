import type { FastifyReply, FastifyRequest } from "fastify";
import type { FileAppLogStore } from "../../infrastructure/app-logs/file-app-log-store.js";
import { appLogRequestSchema } from "../schemas/app-log.schema.js";

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
        sessionHash: hashSession(payload.sessionId),
        kind: payload.kind,
        file,
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

function hashSession(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 33) ^ value.charCodeAt(index);
  return `s_${(hash >>> 0).toString(16)}`;
}
