import { buildApp } from "../../src/app.js";
import { testConfig, validPayload } from "../fixtures/config.js";

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
    expect(body.alerts.some((alert: { type: string }) => alert.type === "fixedSpeedCamera")).toBe(true);
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
    const prefetch = await app.inject({ method: "GET", url: "/api/v1/tile-prefetch/status" });
    expect(openapi.statusCode).toBe(200);
    expect(config.json().supportedAlertTypes).toContain("roadWorks");
    expect(prefetch.json().enabled).toBe(false);
    await app.close();
  });
});
