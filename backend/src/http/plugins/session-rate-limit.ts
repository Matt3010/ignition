import type { FastifyInstance } from "fastify";
import { TtlCache } from "../../domain/services/cache.js";

export async function registerSessionRateLimit(app: FastifyInstance): Promise<void> {
  const recent = new TtlCache<string, number>(app.config.MIN_CLIENT_INTERVAL_MS);
  app.addHook("preHandler", async (request, reply) => {
    if (request.method !== "POST" || request.url !== "/api/v1/road-context") return;
    const body = request.body as { sessionId?: string; timestamp?: string } | undefined;
    if (!body?.sessionId) return;
    const key = `${body.sessionId}:${body.timestamp ?? ""}`;
    const seen = recent.get(key);
    if (seen) {
      reply.header("x-duplicate-request", "true");
      return;
    }
    recent.set(key, Date.now());
  });
}
