import { buildApp } from "../../src/app.js";
import { testConfig, validPayload } from "../fixtures/config.js";

interface RoadContextBody {
  matched: boolean;
  roadId: string | null;
  roadName: string | null;
  speedLimitKmh: number | null;
  confidence: number;
  dataTimestamp: string;
  alerts: Array<{
    id: string;
    type: string;
    distanceMeters: number;
    roadId?: string;
  }>;
}

describe("mock test drive", () => {
  it("keeps a stable road context across a short ride and moves alerts closer", async () => {
    const app = await buildApp(testConfig());
    const sessionId = "550e8400-e29b-41d4-a716-446655440010";
    const samples = [
      { latitude: 45.0, speedKmh: 45, timestamp: "2026-06-17T20:30:00Z", scenario: "limit50" },
      { latitude: 45.0018, speedKmh: 52, timestamp: "2026-06-17T20:30:01Z", scenario: "limit50" },
      { latitude: 45.0036, speedKmh: 72, timestamp: "2026-06-17T20:30:02Z", scenario: "limit70" },
    ];

    const responses: RoadContextBody[] = [];
    for (const sample of samples) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/road-context",
        headers: { "x-road-context-scenario": sample.scenario },
        payload: {
          ...validPayload,
          sessionId,
          latitude: sample.latitude,
          speedKmh: sample.speedKmh,
          timestamp: sample.timestamp,
        },
      });
      expect(response.statusCode).toBe(200);
      responses.push(response.json());
    }

    expect(responses.map((response) => response.matched)).toEqual([true, true, true]);
    expect(responses.map((response) => response.roadId)).toEqual([
      "way-mock-primary",
      "way-mock-primary",
      "way-mock-primary",
    ]);
    expect(responses[0].speedLimitKmh).toBe(50);
    expect(responses[2].speedLimitKmh).toBe(70);
    expect(responses[2].confidence).toBeGreaterThanOrEqual(responses[0].confidence);

    const firstCamera500 = responses[0].alerts.find((alert) => alert.id === "camera-500");
    const lastCamera500 = responses[2].alerts.find((alert) => alert.id === "camera-500");
    expect(firstCamera500?.distanceMeters).toBeGreaterThan(lastCamera500?.distanceMeters ?? Infinity);
    expect(responses.flatMap((response) => response.alerts.map((alert) => alert.id))).not.toContain(
      "camera-opposite",
    );
    expect(responses.flatMap((response) => response.alerts.map((alert) => alert.id))).not.toContain(
      "parallel-250",
    );
    await app.close();
  });

  it("switches to the parallel road only when the provider has strong scenario evidence", async () => {
    const app = await buildApp(testConfig());
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/road-context",
      headers: { "x-road-context-scenario": "parallelRoad" },
      payload: {
        ...validPayload,
        sessionId: "550e8400-e29b-41d4-a716-446655440011",
        latitude: 45.00225,
        longitude: 11.00025,
        speedKmh: 35,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as RoadContextBody;
    expect(body.roadId).toBe("way-parallel");
    expect(body.roadName).toBe("Complanare mock");
    expect(body.alerts.map((alert) => alert.id)).toEqual(["parallel-250"]);
    expect(body.confidence).toBeLessThan(0.85);
    await app.close();
  });

  it("covers null limit, low confidence, stale data and matched false scenarios", async () => {
    const app = await buildApp(testConfig());
    const scenarios = ["nullLimit", "lowConfidence", "staleData", "matchedFalse"] as const;
    const results: Record<string, RoadContextBody> = {};

    for (const scenario of scenarios) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/road-context",
        headers: { "x-road-context-scenario": scenario },
        payload: {
          ...validPayload,
          sessionId: `550e8400-e29b-41d4-a716-4466554400${scenarios.indexOf(scenario) + 20}`,
        },
      });
      expect(response.statusCode).toBe(200);
      results[scenario] = response.json();
    }

    expect(results.nullLimit.speedLimitKmh).toBeNull();
    expect(results.lowConfidence.confidence).toBeLessThan(0.5);
    expect(Date.parse(results.staleData.dataTimestamp)).toBeLessThan(Date.parse(validPayload.timestamp));
    expect(results.matchedFalse.matched).toBe(false);
    expect(results.matchedFalse.alerts.length).toBeGreaterThan(0);
    await app.close();
  });
});
