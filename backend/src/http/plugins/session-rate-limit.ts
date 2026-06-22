import type { FastifyInstance } from "fastify";
import { TtlCache } from "../../domain/services/cache.js";

export async function registerSessionRateLimit(app: FastifyInstance): Promise<void> {
  const recent = new TtlCache<string, number>(app.config.MIN_CLIENT_INTERVAL_MS);
  const reservations = new WeakMap<object, { sessionId: string; reservedAt: number }>();

  app.addHook("preHandler", async (request, reply) => {
    if (request.method !== "POST" || request.routeOptions.url !== "/api/v1/road-context") return;

    const body = request.body as { sessionId?: string; timestamp?: string } | undefined;
    if (!body?.sessionId) return;

    const now = Date.now();
    const previousRequestAt = recent.get(body.sessionId);
    if (previousRequestAt !== null) {
      const retryAfterMs = Math.max(1, app.config.MIN_CLIENT_INTERVAL_MS - (now - previousRequestAt));
      reply
        .header("retry-after", Math.max(1, Math.ceil(retryAfterMs / 1000)).toString())
        .header("x-min-client-interval-ms", app.config.MIN_CLIENT_INTERVAL_MS.toString())
        .code(429)
        .send({
          error: {
            code: "TOO_MANY_REQUESTS",
            message: "Richieste troppo ravvicinate per la stessa sessione",
            details: [{ retryAfterMs }],
          },
        });
      return reply;
    }

    recent.set(body.sessionId, now);
    reservations.set(request, { sessionId: body.sessionId, reservedAt: now });
  });

  app.addHook("onError", async (request) => {
    const reservation = reservations.get(request);
    if (!reservation) return;
    if (recent.get(reservation.sessionId) === reservation.reservedAt) {
      recent.delete(reservation.sessionId);
    }
    reservations.delete(request);
  });

  app.addHook("onResponse", async (request) => {
    reservations.delete(request);
  });
}
