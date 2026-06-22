import { ValhallaClient } from "../../src/infrastructure/valhalla/valhalla-client.js";
import { ValhallaRoadContextProvider } from "../../src/infrastructure/valhalla/valhalla-road-context-provider.js";
import { testConfig } from "../fixtures/config.js";

const describeLive = process.env.RUN_VALHALLA_INTEGRATION === "1" ? describe : describe.skip;

describeLive("live Valhalla integration", () => {
  const baseUrl = process.env.VALHALLA_BASE_URL ?? "http://127.0.0.1:8002";
  const client = new ValhallaClient(testConfig({
    VALHALLA_BASE_URL: baseUrl,
    VALHALLA_TIMEOUT_MS: 10_000,
  }));
  const provider = new ValhallaRoadContextProvider(client);

  it("reports healthy and map-matches a real Monaco road trace", async () => {
    expect(await provider.health()).toBe("up");

    const timestamp = new Date().toISOString();
    const sample = {
      latitude: 43.73842,
      longitude: 7.42462,
      speedKmh: 30,
      course: 45,
      horizontalAccuracyMeters: 8,
      timestamp,
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
    };

    const result = await provider.match({
      sample,
      trace: [sample],
      previousState: null,
    });

    expect(result.matched).toBe(true);
    if (!result.matched) return;
    expect(result.roadName ?? result.roadId ?? result.roadType).not.toBeNull();
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.valhallaQuality).toBeGreaterThan(0);
  });
});
