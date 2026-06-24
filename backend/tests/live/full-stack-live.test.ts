import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { buildApp } from "../../src/app.js";
import { PostgisAlertRepository } from "../../src/infrastructure/repositories/postgis-alert-repository.js";
import type { RoadAlert } from "../../src/domain/models/alert.js";
import { testConfig } from "../fixtures/config.js";

const describeLive = process.env.RUN_FULL_STACK_INTEGRATION === "1" ? describe : describe.skip;

describeLive("production dependency graph end to end", () => {
  const databaseUrl = process.env.DATABASE_URL;
  const valhallaBaseUrl = process.env.VALHALLA_BASE_URL ?? "http://127.0.0.1:8002";
  const source = "ci-full-stack";
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const repository = new PostgisAlertRepository(pool);

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("DATABASE_URL is required when RUN_FULL_STACK_INTEGRATION=1");
    await pool.query("delete from road_alerts where source = $1", [source]);
  });

  afterAll(async () => {
    await pool.query("delete from road_alerts where source = $1", [source]);
    await pool.end();
  });

  it("uses real Valhalla and PostGIS through the production application wiring", async () => {
    const alertId = randomUUID();
    const alert: RoadAlert = {
      id: alertId,
      type: "fixedSpeedCamera",
      subtype: "camera",
      capabilities: ["speed"],
      primaryCapability: "speed",
      latitude: 43.737454,
      longitude: 7.42492,
      speedLimitKmh: 50,
      speedLimitSource: "explicit",
      direction: "unknown",
      bearing: null,
      roadId: null,
      confidence: 0.95,
      active: true,
      validFrom: null,
      validUntil: null,
      source,
      operationalStatus: "operational",
      statusReason: null,
      directionBearings: [],
      osmPresenceStatus: "present",
      originalOsmIds: [],
    };
    await repository.upsertMany([alert]);

    const app = await buildApp(
      testConfig({
        DATABASE_URL: databaseUrl!,
        VALHALLA_BASE_URL: valhallaBaseUrl,
        VALHALLA_TIMEOUT_MS: 10_000,
        MIN_CLIENT_INTERVAL_MS: 1,
        MAX_SAMPLE_AGE_SECONDS: 60,
        MAX_SAMPLE_FUTURE_SECONDS: 5,
        LOG_LEVEL: "silent",
      }),
    );

    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      const ready = await app.inject({ method: "GET", url: "/ready" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({ status: "ok", database: "up", valhalla: "up" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toMatchObject({ ready: true, database: "up", valhalla: "up" });

      const invalid = await app.inject({
        method: "POST",
        url: "/api/v1/road-context",
        payload: {
          latitude: 99,
          longitude: 7.42492,
          speedKmh: 25,
          course: 80,
          horizontalAccuracyMeters: 8,
          timestamp: new Date().toISOString(),
          sessionId: randomUUID(),
        },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe("INVALID_REQUEST");

      const sessionId = randomUUID();
      const coordinates = [
        [43.73702, 7.42212],
        [43.737105, 7.42265],
        [43.73719, 7.42318],
        [43.7373, 7.42375],
        [43.737454, 7.42492],
      ] as const;
      const startedAtSeconds = Math.floor(Date.now() / 1000) - 8;
      let finalBody: Record<string, unknown> | null = null;

      for (const [index, [latitude, longitude]] of coordinates.entries()) {
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/road-context",
          payload: {
            latitude,
            longitude,
            speedKmh: 25,
            course: null,
            horizontalAccuracyMeters: 12,
            timestamp: new Date((startedAtSeconds + index * 2) * 1000).toISOString(),
            sessionId,
          },
        });
        expect(response.statusCode, response.body).toBe(200);
        finalBody = response.json();
      }

      expect(finalBody).not.toBeNull();
      expect(finalBody?.matched).toBe(true);
      expect(finalBody?.matchStatus).toBe("matched");
      expect(Number(finalBody?.confidence)).toBeGreaterThan(0);
      expect(Array.isArray(finalBody?.alerts)).toBe(true);
      expect((finalBody?.alerts as Array<{ id: string }>).some((item) => item.id === alertId)).toBe(
        true,
      );
    } finally {
      await app.close();
    }
  }, 30_000);

  it("returns a real no-match outside the loaded Valhalla tiles", async () => {
    const app = await buildApp(
      testConfig({
        DATABASE_URL: databaseUrl!,
        VALHALLA_BASE_URL: valhallaBaseUrl,
        VALHALLA_TIMEOUT_MS: 10_000,
        MIN_CLIENT_INTERVAL_MS: 1,
        MAX_SAMPLE_AGE_SECONDS: 60,
        LOG_LEVEL: "silent",
      }),
    );

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/road-context",
        payload: {
          latitude: 0,
          longitude: 0,
          speedKmh: 20,
          course: 0,
          horizontalAccuracyMeters: 8,
          timestamp: new Date().toISOString(),
          sessionId: randomUUID(),
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ matched: false, matchStatus: "noMatch" });
    } finally {
      await app.close();
    }
  }, 20_000);
  it("enforces the real per-session minimum interval without affecting another session", async () => {
    const app = await buildApp(
      testConfig({
        DATABASE_URL: databaseUrl!,
        VALHALLA_BASE_URL: valhallaBaseUrl,
        VALHALLA_TIMEOUT_MS: 10_000,
        MIN_CLIENT_INTERVAL_MS: 5_000,
        MAX_SAMPLE_AGE_SECONDS: 60,
        LOG_LEVEL: "silent",
      }),
    );

    const payload = (sessionId: string) => ({
      latitude: 43.737454,
      longitude: 7.42492,
      speedKmh: 25,
      course: 80,
      horizontalAccuracyMeters: 8,
      timestamp: new Date().toISOString(),
      sessionId,
    });

    try {
      const sessionId = randomUUID();
      const first = await app.inject({
        method: "POST",
        url: "/api/v1/road-context",
        payload: payload(sessionId),
      });
      expect(first.statusCode, first.body).toBe(200);

      const limited = await app.inject({
        method: "POST",
        url: "/api/v1/road-context",
        payload: payload(sessionId),
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBeDefined();
      expect(limited.headers["x-min-client-interval-ms"]).toBe("5000");
      expect(limited.json().error.code).toBe("TOO_MANY_REQUESTS");

      const otherSession = await app.inject({
        method: "POST",
        url: "/api/v1/road-context",
        payload: payload(randomUUID()),
      });
      expect(otherSession.statusCode, otherSession.body).toBe(200);
    } finally {
      await app.close();
    }
  }, 30_000);

  it("stores and rotates app logs through the real HTTP route and filesystem", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ignition-app-logs-"));
    const sessionId = randomUUID();
    const app = await buildApp(
      testConfig({
        DATABASE_URL: databaseUrl!,
        VALHALLA_BASE_URL: valhallaBaseUrl,
        APP_DEBUG_LOG_DIR: directory,
        APP_DEBUG_LOG_MAX_FILE_BYTES: 450,
        APP_DEBUG_LOG_MAX_FILES: 10,
        LOG_LEVEL: "silent",
      }),
    );

    const payload = {
      sessionId,
      createdAt: new Date().toISOString(),
      kind: "client_error",
      platform: "ios",
      appName: "Ignition",
      appVersion: "0.1.0",
      backendBaseURL: "http://127.0.0.1:3000",
      message: "x".repeat(240),
    };

    try {
      for (let index = 0; index < 3; index += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/app-logs",
          payload: { ...payload, createdAt: new Date(Date.now() + index).toISOString() },
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({ stored: true, file: `${sessionId}.jsonl` });
      }

      const files = (await readdir(directory)).filter((file) => file.endsWith(".jsonl"));
      expect(files.length).toBeGreaterThan(1);
      const records = (
        await Promise.all(files.map((file) => readFile(path.join(directory, file), "utf8")))
      )
        .flatMap((content) => content.trim().split("\n").filter(Boolean))
        .map((line) => JSON.parse(line) as { sessionId: string; requestId: string });
      expect(records).toHaveLength(3);
      expect(records.every((record) => record.sessionId === sessionId)).toBe(true);
      expect(records.every((record) => record.requestId.length > 0)).toBe(true);

      const invalid = await app.inject({
        method: "POST",
        url: "/api/v1/app-logs",
        payload: { ...payload, sessionId: "not-a-uuid" },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe("INVALID_REQUEST");
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("returns an internal error when the real log filesystem is not writable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ignition-readonly-logs-"));
    const directory = path.join(root, "logs");
    await mkdir(directory);
    await chmod(directory, 0o500);

    const app = await buildApp(
      testConfig({
        DATABASE_URL: databaseUrl!,
        VALHALLA_BASE_URL: valhallaBaseUrl,
        APP_DEBUG_LOG_DIR: directory,
        LOG_LEVEL: "silent",
      }),
    );

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/app-logs",
        payload: {
          sessionId: randomUUID(),
          createdAt: new Date().toISOString(),
          kind: "client_error",
          platform: "ios",
          appName: "Ignition",
          appVersion: "0.1.0",
          backendBaseURL: "http://127.0.0.1:3000",
          message: "permission failure",
        },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json().error.code).toBe("INTERNAL_ERROR");
    } finally {
      await app.close();
      await chmod(directory, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
