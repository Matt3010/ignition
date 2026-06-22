import { buildApp } from "../../src/app.js";
import { testConfig, validPayload } from "../fixtures/config.js";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

describe("HTTP API", () => {
  it("serves health and ready in mock mode", async () => {
    const app = await buildApp(testConfig());
    const health = await app.inject({ method: "GET", url: "/health" });
    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(health.statusCode).toBe(200);
    expect(ready.statusCode).toBe(200);
    await app.close();
  });

  it("returns road context for valid payload", async () => {
    const app = await buildApp(testConfig());
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/road-context",
      headers: { "x-road-context-scenario": "limit70" },
      payload: validPayload,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.matched).toBe(true);
    expect(body.speedLimitKmh).toBe(70);
    expect(body.speedLimitSource).toBe("explicit");
    expect(
      body.alerts.some(
        (alert: { type: string; speedLimitSource: string }) =>
          alert.type === "fixedSpeedCamera" && alert.speedLimitSource === "explicit",
      ),
    ).toBe(true);
    await app.close();
  });

  it("returns normalized error for invalid payload", async () => {
    const app = await buildApp(testConfig());
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/road-context",
      payload: { ...validPayload, latitude: 99 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
    await app.close();
  });

  it("preserves structured ApplicationError details", async () => {
    const app = await buildApp(testConfig({ MAX_GPS_ACCURACY_METERS: 10 }));
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/road-context",
      payload: { ...validPayload, horizontalAccuracyMeters: 20 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "INVALID_REQUEST",
        message: "Accuratezza GPS troppo bassa",
        details: [{ path: "horizontalAccuracyMeters", max: 10 }],
      },
    });
    await app.close();
  });

  it("supports matched false scenario", async () => {
    const app = await buildApp(testConfig());
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/road-context",
      headers: { "x-road-context-scenario": "matchedFalse" },
      payload: validPayload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().matched).toBe(false);
    await app.close();
  });

  it("serves OpenAPI and client config", async () => {
    const app = await buildApp(testConfig());
    const openapi = await app.inject({ method: "GET", url: "/documentation/json" });
    const config = await app.inject({ method: "GET", url: "/api/v1/config" });
    expect(openapi.statusCode).toBe(200);
    expect(config.json().supportedAlertTypes).toContain("roadWorks");
    await app.close();
  });

  it("stores app debug logs as session jsonl", async () => {
    const logDir = await mkdtemp(path.join(tmpdir(), "app-debug-logs-"));
    const app = await buildApp(testConfig({ APP_DEBUG_LOG_DIR: logDir }));
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/app-logs",
      payload: {
        sessionId: validPayload.sessionId,
        createdAt: "2026-06-17T20:30:01Z",
        kind: "road_context_event",
        platform: "ios",
        appName: "RoadRecorder",
        appVersion: "1.0",
        backendBaseURL: "https://roads.scanferlamatteo.work",
        message: "72 km/h, Via Test, limite 70 km/h, velocita ok, nessun alert vicino",
        counters: {
          sentCount: 1,
          errorCount: 0,
          localEventCount: 1,
        },
        event: {
          debugLine: "72 km/h, Via Test, limite 70 km/h, velocita ok, nessun alert vicino",
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().stored).toBe(true);
    const stored = await readFile(path.join(logDir, `${validPayload.sessionId}.jsonl`), "utf8");
    expect(stored).toContain("road_context_event");
    expect(stored).toContain("72 km/h");
    await app.close();
  });
  it("enforces the minimum interval for the same session", async () => {
    const app = await buildApp(testConfig({ MIN_CLIENT_INTERVAL_MS: 1000 }));
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/road-context",
      payload: validPayload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/road-context",
      payload: { ...validPayload, timestamp: "2026-06-17T20:30:01Z" },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe("TOO_MANY_REQUESTS");
    expect(second.headers["retry-after"]).toBeDefined();
    await app.close();
  });

});
