import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import { loadConfig, type AppConfig } from "./config/env.js";
import type { AlertRepository } from "./application/ports/alert-repository.js";
import { GetRoadContextUseCase } from "./application/use-cases/get-road-context.use-case.js";
import { SessionTraceStore } from "./domain/services/session-trace.js";
import { InMemoryAlertRepository } from "./infrastructure/alerts/in-memory-alert-repository.js";
import { createPool } from "./infrastructure/database/postgres.js";
import { PostgisAlertRepository } from "./infrastructure/repositories/postgis-alert-repository.js";
import { LocalScriptTilePrefetcher, NoopTilePrefetcher } from "./infrastructure/osm/tile-prefetcher.js";
import { ValhallaClient } from "./infrastructure/valhalla/valhalla-client.js";
import { ValhallaRoadContextProvider } from "./infrastructure/valhalla/valhalla-road-context-provider.js";
import { createMockAlerts } from "./mock/mock-data.js";
import { MockRoadContextProvider } from "./mock/mock-road-context-provider.js";
import { registerErrorHandler } from "./http/plugins/error-handler.js";
import { registerSessionRateLimit } from "./http/plugins/session-rate-limit.js";
import { registerAppLogRoutes } from "./http/routes/app-log.routes.js";
import { registerRoadContextRoutes } from "./http/routes/road-context.routes.js";
import { registerSystemRoutes } from "./http/routes/system.routes.js";

declare module "fastify" {
  interface FastifyInstance {
    config: AppConfig;
    pgPool?: pg.Pool;
  }
}

export async function buildApp(config = loadConfig()): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ["req.headers.authorization", "req.body.latitude", "req.body.longitude"],
    },
    genReqId: () => randomUUID(),
    bodyLimit: config.PAYLOAD_LIMIT_BYTES,
    requestTimeout: config.REQUEST_TIMEOUT_MS,
  });
  app.decorate("config", config);

  await app.register(helmet);
  await app.register(cors, {
    origin: config.CORS_ORIGIN === "*" ? true : config.CORS_ORIGIN.split(","),
  });
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
    keyGenerator: (request) => {
      const body = request.body as { sessionId?: string } | undefined;
      return body?.sessionId ? `${request.ip}:${body.sessionId}` : request.ip;
    },
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Motorcycle Road Context API",
        version: config.API_VERSION,
      },
    },
  });
  await app.register(swaggerUi, {
    routePrefix: "/documentation",
  });
  await registerErrorHandler(app);
  await registerSessionRateLimit(app);

  const dependencies = createDependencies(config);
  if (dependencies.pool) app.decorate("pgPool", dependencies.pool);

  const useCase = new GetRoadContextUseCase(
    dependencies.provider,
    dependencies.alertRepository,
    new SessionTraceStore(config.SESSION_TRACE_TTL_SECONDS * 1000),
    config,
    dependencies.tilePrefetcher,
  );
  await registerAppLogRoutes(app);
  await registerRoadContextRoutes(app, useCase);
  await registerSystemRoutes(app, {
    provider: dependencies.provider,
    alertRepository: dependencies.alertRepository,
    databaseEnabled: dependencies.databaseEnabled,
    tilePrefetcher: dependencies.tilePrefetcher,
  });

  app.addHook("onClose", async () => {
    await dependencies.pool?.end();
  });

  return app;
}

function createDependencies(config: AppConfig): {
  provider: MockRoadContextProvider | ValhallaRoadContextProvider;
  alertRepository: AlertRepository;
  databaseEnabled: boolean;
  tilePrefetcher: NoopTilePrefetcher | LocalScriptTilePrefetcher;
  pool?: pg.Pool;
} {
  if (config.ROAD_CONTEXT_PROVIDER === "mock") {
    return {
      provider: new MockRoadContextProvider(config.NODE_ENV === "production"),
      alertRepository: new InMemoryAlertRepository(createMockAlerts()),
      databaseEnabled: false,
      tilePrefetcher: new NoopTilePrefetcher(),
    };
  }

  const pool = createPool(config);
  const tilePrefetcher = new LocalScriptTilePrefetcher(config);
  return {
    provider: new ValhallaRoadContextProvider(new ValhallaClient(config)),
    alertRepository: new PostgisAlertRepository(pool),
    databaseEnabled: true,
    tilePrefetcher,
    pool,
  };
}
