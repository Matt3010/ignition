import type { FastifyInstance } from "fastify";
import { alertTypes } from "../../domain/models/alert.js";
import type { AlertRepository } from "../../application/ports/alert-repository.js";
import type { RoadContextProvider } from "../../application/ports/road-context-provider.js";
import type { TilePrefetcher } from "../../application/ports/tile-prefetcher.js";

export async function registerSystemRoutes(
  app: FastifyInstance,
  dependencies: {
    provider: RoadContextProvider;
    alertRepository: AlertRepository;
    databaseEnabled: boolean;
    tilePrefetcher: TilePrefetcher;
  },
): Promise<void> {
  app.get("/health", async () => {
    const [database, valhalla] = await Promise.all([
      dependencies.databaseEnabled ? dependencies.alertRepository.health() : Promise.resolve<"up">("up"),
      dependencies.provider.health(),
    ]);
    return {
      status: database === "up" && valhalla === "up" ? "ok" : "degraded",
      database,
      valhalla,
      timestamp: new Date().toISOString(),
    };
  });

  app.get("/ready", async (_request, reply) => {
    const [database, valhalla] = await Promise.all([
      dependencies.databaseEnabled ? dependencies.alertRepository.health() : Promise.resolve<"up">("up"),
      dependencies.provider.health(),
    ]);
    const ready = database === "up" && valhalla === "up";
    return reply.status(ready ? 200 : 503).send({
      ready,
      database,
      valhalla,
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/api/v1/config", async () => ({
    apiVersion: app.config.API_VERSION,
    minSuggestedIntervalMs: app.config.MIN_CLIENT_INTERVAL_MS,
    maxRecommendedAccuracyMeters: app.config.MAX_GPS_ACCURACY_METERS,
    supportedAlertTypes: alertTypes,
    tilePrefetchEnabled: dependencies.tilePrefetcher.status().enabled,
  }));

  app.get("/api/v1/tile-prefetch/status", async () => dependencies.tilePrefetcher.status());
}
