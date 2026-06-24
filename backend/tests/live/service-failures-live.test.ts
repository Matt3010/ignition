import { randomUUID } from "node:crypto";
import pg from "pg";
import { buildApp } from "../../src/app.js";
import { testConfig } from "../fixtures/config.js";

const describeLive = process.env.RUN_FAILURE_INTEGRATION === "1" ? describe : describe.skip;

describeLive("real infrastructure failure handling", () => {
  const databaseUrl = process.env.DATABASE_URL;
  const valhallaBaseUrl = process.env.VALHALLA_BASE_URL ?? "http://127.0.0.1:8002";

  beforeAll(() => {
    if (!databaseUrl) throw new Error("DATABASE_URL is required when RUN_FAILURE_INTEGRATION=1");
  });

  it("reports Valhalla down while the real database remains available", async () => {
    const app = await buildApp(
      testConfig({
        DATABASE_URL: databaseUrl!,
        VALHALLA_BASE_URL: "http://127.0.0.1:1",
        VALHALLA_TIMEOUT_MS: 250,
        LOG_LEVEL: "silent",
      }),
    );

    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      const ready = await app.inject({ method: "GET", url: "/ready" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({ status: "degraded", database: "up", valhalla: "down" });
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toMatchObject({ ready: false, database: "up", valhalla: "down" });

      const sessionId = randomUUID();
      const startedAt = Date.now() - 2_000;
      const trace = [
        { latitude: 43.73702, longitude: 7.42212 },
        { latitude: 43.737105, longitude: 7.42265 },
      ];

      let response = null as Awaited<ReturnType<typeof app.inject>> | null;
      for (const [index, point] of trace.entries()) {
        response = await app.inject({
          method: "POST",
          url: "/api/v1/road-context",
          payload: {
            ...point,
            speedKmh: 25,
            course: null,
            horizontalAccuracyMeters: 12,
            timestamp: new Date(startedAt + index * 2_000).toISOString(),
            sessionId,
          },
        });
        expect(response.statusCode).toBe(200);
      }

      expect(response).not.toBeNull();
      expect(response!.json()).toMatchObject({
        matched: false,
        matchStatus: "providerUnavailable",
      });
    } finally {
      await app.close();
    }
  }, 15_000);

  it("reports PostGIS down while the real Valhalla service remains available", async () => {
    const app = await buildApp(
      testConfig({
        DATABASE_URL: "postgres://road:road@127.0.0.1:1/road_context",
        VALHALLA_BASE_URL: valhallaBaseUrl,
        VALHALLA_TIMEOUT_MS: 5_000,
        LOG_LEVEL: "silent",
      }),
    );

    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      const ready = await app.inject({ method: "GET", url: "/ready" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({ status: "degraded", database: "down", valhalla: "up" });
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toMatchObject({ ready: false, database: "down", valhalla: "up" });
    } finally {
      await app.close();
    }
  }, 15_000);
  it("surfaces a real PostgreSQL permission error without leaking database details", async () => {
    const admin = new pg.Pool({ connectionString: databaseUrl!, max: 1 });
    const role = `ci_restricted_${Date.now()}`;
    const password = randomUUID();
    const quotedRole = `"${role.replaceAll('"', '""')}"`;
    const quotedPassword = `'${password.replaceAll("'", "''")}'`;

    await admin.query(`CREATE ROLE ${quotedRole} LOGIN PASSWORD ${quotedPassword}`);
    await admin.query(`GRANT CONNECT ON DATABASE road_context TO ${quotedRole}`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${quotedRole}`);

    const restrictedUrl = new URL(databaseUrl!);
    restrictedUrl.username = role;
    restrictedUrl.password = password;
    const app = await buildApp(
      testConfig({
        DATABASE_URL: restrictedUrl.toString(),
        VALHALLA_BASE_URL: valhallaBaseUrl,
        VALHALLA_TIMEOUT_MS: 5_000,
        MIN_CLIENT_INTERVAL_MS: 1,
        NODE_ENV: "production",
        LOG_LEVEL: "silent",
      }),
    );

    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({
        status: "degraded",
        database: "down",
        valhalla: "up",
      });

      const sessionId = randomUUID();
      const startedAt = Date.now() - 2_000;
      const trace = [
        { latitude: 43.73702, longitude: 7.42212 },
        { latitude: 43.737105, longitude: 7.42265 },
      ];

      let response = null as Awaited<ReturnType<typeof app.inject>> | null;
      for (const [index, point] of trace.entries()) {
        response = await app.inject({
          method: "POST",
          url: "/api/v1/road-context",
          payload: {
            ...point,
            speedKmh: 25,
            course: null,
            horizontalAccuracyMeters: 12,
            timestamp: new Date(startedAt + index * 2_000).toISOString(),
            sessionId,
          },
        });
      }

      expect(response).not.toBeNull();
      expect(response!.statusCode).toBe(500);
      expect(response!.json()).toEqual({
        error: { code: "INTERNAL_ERROR", message: "Errore interno", details: [] },
      });
      expect(response!.body).not.toContain("permission denied");
      expect(response!.body).not.toContain("road_alerts");
    } finally {
      await app.close();
      await admin.query(`REVOKE USAGE ON SCHEMA public FROM ${quotedRole}`).catch(() => undefined);
      await admin.query(`REVOKE CONNECT ON DATABASE road_context FROM ${quotedRole}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${quotedRole}`);
      await admin.end();
    }
  }, 20_000);
});
