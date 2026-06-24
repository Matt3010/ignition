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

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/road-context",
        payload: {
          latitude: 43.737454,
          longitude: 7.42492,
          speedKmh: 25,
          course: 80,
          horizontalAccuracyMeters: 8,
          timestamp: new Date().toISOString(),
          sessionId: randomUUID(),
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ matched: false, matchStatus: "providerUnavailable" });

      const remove = await fetch(`${adminBaseUrl}/proxies/valhalla/toxics/slow-downstream`, {
        method: "DELETE",
      });
      expect(remove.status).toBe(204);

      const recovered = await buildApp(
        testConfig({
          DATABASE_URL: databaseUrl!,
          VALHALLA_BASE_URL: proxyBaseUrl,
          VALHALLA_TIMEOUT_MS: 5_000,
          LOG_LEVEL: "silent",
        }),
      );
      try {
        const recoveredHealth = await recovered.inject({ method: "GET", url: "/health" });
        expect(recoveredHealth.statusCode).toBe(200);
        expect(recoveredHealth.json()).toMatchObject({
          status: "ok",
          database: "up",
          valhalla: "up",
        });
      } finally {
        await recovered.close();
      }
    } finally {
      await app.close();
    }
  }, 20_000);
});
