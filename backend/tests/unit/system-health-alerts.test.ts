import Fastify from "fastify";
import { registerSystemRoutes } from "../../src/http/routes/system.routes.js";
import type { AlertDatasetStatus, AlertRepository } from "../../src/application/ports/alert-repository.js";
import type { RoadContextProvider } from "../../src/application/ports/road-context-provider.js";
import { testConfig } from "../fixtures/config.js";

function dependencies(alertsStatus: AlertDatasetStatus) {
  const alertRepository = {
    health: async () => "up" as const,
    getDatasetStatus: async () => alertsStatus,
  } as AlertRepository;
  const provider = { health: async () => "up" as const } as RoadContextProvider;
  return { alertRepository, provider, databaseEnabled: true as const };
}

describe("system health alert availability", () => {
  it("marks readiness degraded when the alert dataset is unavailable", async () => {
    const app = Fastify();
    app.decorate("config", testConfig());
    await registerSystemRoutes(app, dependencies("unavailable"));
    const health = await app.inject({ method: "GET", url: "/health" });
    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(health.json()).toMatchObject({ status: "degraded", alerts: "unavailable" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ ready: false, alerts: "unavailable" });
    await app.close();
  });

  it("treats a successful empty import as ready", async () => {
    const app = Fastify();
    app.decorate("config", testConfig());
    await registerSystemRoutes(app, dependencies("empty"));
    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ ready: true, alerts: "empty" });
    await app.close();
  });

  it("reports ready when alerts, database and Valhalla are available", async () => {
    const app = Fastify();
    app.decorate("config", testConfig());
    await registerSystemRoutes(app, dependencies("available"));
    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ ready: true, alerts: "available" });
    await app.close();
  });
});
