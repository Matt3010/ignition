import { randomUUID } from "node:crypto";
import { buildApp } from "../../src/app.js";
import { testConfig } from "../fixtures/config.js";

const describeLive = process.env.RUN_NETWORK_FAULT_INTEGRATION === "1" ? describe : describe.skip;

describeLive("real Valhalla network fault injection", () => {
  const databaseUrl = process.env.DATABASE_URL;
  const proxyBaseUrl = process.env.VALHALLA_PROXY_BASE_URL ?? "http://127.0.0.1:8004";
  const adminBaseUrl = process.env.TOXIPROXY_ADMIN_URL ?? "http://127.0.0.1:8474";

  beforeAll(() => {
    if (!databaseUrl) throw new Error("DATABASE_URL is required");
  });

  afterEach(async () => {
    await fetch(`${adminBaseUrl}/proxies/valhalla/toxics/slow-downstream`, {
      method: "DELETE",
    }).catch(() => undefined);
  });

  it("times out through a real proxy and recovers after removing the network fault", async () => {
    const toxicResponse = await fetch(`${adminBaseUrl}/proxies/valhalla/toxics`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "slow-downstream",
        type: "latency",
        stream: "downstream",
        toxicity: 1,
        attributes: { latency: 1500, jitter: 0 },
      }),
    });
    expect(toxicResponse.status).toBe(200);

    const app = await buildApp(
      testConfig({
        DATABASE_URL: databaseUrl!,
        VALHALLA_BASE_URL: proxyBaseUrl,
        VALHALLA_TIMEOUT_MS: 100,
        MIN_CLIENT_INTERVAL_MS: 1,
        LOG_LEVEL: "silent",
      }),
    );

    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({ status: "degraded", database: "up", valhalla: "down" });

      const failedSessionId = randomUUID();
      const failedTraceStartedAt = Date.now() - 2_000;
      const failedTrace = [
        { latitude: 43.73702, longitude: 7.42212 },
        { latitude: 43.737105, longitude: 7.42265 },
      ] as const;

      let failedResponse: Awaited<ReturnType<typeof app.inject>> | null = null;
      for (const [index, point] of failedTrace.entries()) {
        failedResponse = await app.inject({
          method: "POST",
          url: "/api/v1/road-context",
          payload: {
            ...point,
            speedKmh: 25,
            course: null,
            horizontalAccuracyMeters: 12,
            timestamp: new Date(failedTraceStartedAt + index * 2_000).toISOString(),
            sessionId: failedSessionId,
          },
        });
        expect(failedResponse.statusCode, failedResponse.body).toBe(200);
        if (index === 0) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(failedResponse).not.toBeNull();
      expect(failedResponse!.json()).toMatchObject({
        matched: false,
        matchStatus: "providerUnavailable",
      });

      const remove = await fetch(`${adminBaseUrl}/proxies/valhalla/toxics/slow-downstream`, {
        method: "DELETE",
      });
      expect(remove.status).toBe(204);

      const recovered = await buildApp(
        testConfig({
          DATABASE_URL: databaseUrl!,
          VALHALLA_BASE_URL: proxyBaseUrl,
          VALHALLA_TIMEOUT_MS: 5_000,
          MIN_CLIENT_INTERVAL_MS: 1,
          LOG_LEVEL: "silent",
        }),
      );
      try {
        const recoveredHealth = await recovered.inject({ method: "GET", url: "/health" });
        expect(recoveredHealth.statusCode).toBe(200);
        expect(recoveredHealth.json()).toMatchObject({
          database: "up",
          valhalla: "up",
        });

        const recoveredSessionId = randomUUID();
        const recoveredStartedAtSeconds = Math.floor(Date.now() / 1000) - 8;
        const recoveredTrace = [
          [43.73702, 7.42212],
          [43.737105, 7.42265],
          [43.73719, 7.42318],
          [43.7373, 7.42375],
          [43.737454, 7.42492],
        ] as const;
        let recoveredResponse: Awaited<ReturnType<typeof recovered.inject>> | null = null;
        for (const [index, [latitude, longitude]] of recoveredTrace.entries()) {
          recoveredResponse = await recovered.inject({
            method: "POST",
            url: "/api/v1/road-context",
            payload: {
              latitude,
              longitude,
              speedKmh: 25,
              course: null,
              horizontalAccuracyMeters: 12,
              timestamp: new Date((recoveredStartedAtSeconds + index * 2) * 1000).toISOString(),
              sessionId: recoveredSessionId,
            },
          });
          expect(recoveredResponse.statusCode, recoveredResponse.body).toBe(200);
          if (index < recoveredTrace.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
        expect(recoveredResponse).not.toBeNull();
        expect(recoveredResponse!.json()).toMatchObject({
          matched: true,
          matchStatus: "matched",
        });
      } finally {
        await recovered.close();
      }
    } finally {
      await app.close();
    }
  }, 20_000);
});
