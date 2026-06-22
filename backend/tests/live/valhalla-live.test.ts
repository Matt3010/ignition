import { ValhallaClient } from "../../src/infrastructure/valhalla/valhalla-client.js";
import { ValhallaRoadContextProvider } from "../../src/infrastructure/valhalla/valhalla-road-context-provider.js";
import type { GpsSample } from "../../src/domain/models/road-context.js";
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

    // Multiple consecutive points on Avenue d'Ostende. A single GPS point is
    // insufficient for a deterministic map_snap result and may legitimately
    // be returned by Valhalla as `unmatched`.
    const startedAtSeconds = Math.floor(Date.now() / 1000) - 8;
    const coordinates = [
      [43.737020, 7.422120],
      [43.737105, 7.422650],
      [43.737190, 7.423180],
      [43.737300, 7.423750],
      [43.737454, 7.424920],
    ] as const;

    const trace: GpsSample[] = coordinates.map(([latitude, longitude], index) => ({
      latitude,
      longitude,
      speedKmh: 25,
      course: null,
      horizontalAccuracyMeters: 12,
      timestamp: new Date((startedAtSeconds + index * 2) * 1000).toISOString(),
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
    }));
    const sample = trace.at(-1)!;

    const result = await provider.match({
      sample,
      trace,
      previousState: null,
    });

    expect(
      result.matched,
      `Expected a Monaco road match, received ${JSON.stringify(result)}`,
    ).toBe(true);
    if (!result.matched) return;

    expect(result.roadName ?? result.roadId ?? result.roadType).not.toBeNull();
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.valhallaQuality).toBeGreaterThan(0);
  });
});
