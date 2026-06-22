import { buildApp } from "../../src/app.js";
import { testConfig, validPayload } from "../fixtures/config.js";

describe("HTTP hardening", () => {
  it("rejects payloads larger than the configured limit with a normalized error", async () => {
    const app = await buildApp(testConfig({ PAYLOAD_LIMIT_BYTES: 180 }));
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/road-context",
      headers: { "content-type": "application/json" },
      payload: {
        ...validPayload,
        padding: "x".repeat(500),
      },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({
      error: {
        code: "INVALID_REQUEST",
        message: "Payload troppo grande",
        details: [],
      },
    });
    await app.close();
  });

  it("rejects oversized app log payloads with the documented normalized 413 response", async () => {
    const app = await buildApp(testConfig({ PAYLOAD_LIMIT_BYTES: 220 }));
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/app-logs",
      headers: { "content-type": "application/json" },
      payload: {
        sessionId: validPayload.sessionId,
        createdAt: "2026-06-17T20:30:01Z",
        kind: "client_error",
        platform: "ios",
        appName: "RoadRecorder",
        backendBaseURL: "https://example.test",
        message: "x".repeat(500),
      },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({
      error: {
        code: "INVALID_REQUEST",
        message: "Payload troppo grande",
        details: [],
      },
    });
    await app.close();
  });

  it("blocks debug scenarios in production", async () => {
    const app = await buildApp(
      testConfig({
        NODE_ENV: "production",
        ROAD_CONTEXT_PROVIDER: "mock",
      }),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/road-context",
      headers: { "x-road-context-scenario": "limit70" },
      payload: validPayload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
    await app.close();
  });

  it("rate limits excessive requests by IP and session", async () => {
    const app = await buildApp(
      testConfig({
        RATE_LIMIT_MAX: 1,
        RATE_LIMIT_WINDOW: "1 minute",
      }),
    );
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/road-context",
      payload: validPayload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/road-context",
      payload: {
        ...validPayload,
        timestamp: "2026-06-17T20:30:01Z",
      },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    await app.close();
  });

  it("normalizes mock provider HTTP failures", async () => {
    const app = await buildApp(testConfig());
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/road-context",
      headers: { "x-road-context-scenario": "httpError" },
      payload: validPayload,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("INTERNAL_ERROR");
    await app.close();
  });
});
