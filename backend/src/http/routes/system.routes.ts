import type { FastifyInstance } from "fastify";
import { alertTypes } from "../../domain/models/alert.js";
import type { AlertRepository } from "../../application/ports/alert-repository.js";
import type { RoadContextProvider } from "../../application/ports/road-context-provider.js";
import { APP_VERSION } from "../../config/app-version.js";

interface DependencyHealth {
  database: "up" | "down";
  valhalla: "up" | "down";
  healthy: boolean;
  timestamp: string;
}

export async function registerSystemRoutes(
  app: FastifyInstance,
  dependencies: {
    provider: RoadContextProvider;
    alertRepository: AlertRepository;
    databaseEnabled: boolean;
  },
): Promise<void> {
  const readDependencyHealth = async (): Promise<DependencyHealth> => {
    const [database, valhalla] = await Promise.all([
      dependencies.databaseEnabled ? dependencies.alertRepository.health() : Promise.resolve<"up">("up"),
      dependencies.provider.health(),
    ]);

    return {
      database,
      valhalla,
      healthy: database === "up" && valhalla === "up",
      timestamp: new Date().toISOString(),
    };
  };

  app.get("/health", async () => {
    const health = await readDependencyHealth();
    return {
      status: health.healthy ? "ok" : "degraded",
      database: health.database,
      valhalla: health.valhalla,
      timestamp: health.timestamp,
    };
  });

  app.get("/ready", async (_request, reply) => {
    const health = await readDependencyHealth();
    return reply.status(health.healthy ? 200 : 503).send({
      ready: health.healthy,
      database: health.database,
      valhalla: health.valhalla,
      timestamp: health.timestamp,
    });
  });

  app.get("/api/v1/config", async () => ({
    apiVersion: APP_VERSION,
    minSuggestedIntervalMs: app.config.MIN_CLIENT_INTERVAL_MS,
    maxRecommendedAccuracyMeters: app.config.MAX_GPS_ACCURACY_METERS,
    supportedAlertTypes: alertTypes,
  }));
}
