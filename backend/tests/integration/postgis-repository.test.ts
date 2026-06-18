import { PostgisAlertRepository } from "../../src/infrastructure/repositories/postgis-alert-repository.js";

describe("PostGIS alert repository", () => {
  it("uses spatial query and parameterized values", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const repository = new PostgisAlertRepository({
      query: async (sql: string, values: unknown[]) => {
        calls.push({ sql, values });
        return { rows: [] };
      },
    } as any);
    await repository.findNearby({
      latitude: 45,
      longitude: 11,
      radiusMeters: 1000,
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(calls[0].sql).toContain("ST_DWithin");
    expect(calls[0].sql).toContain("ST_DistanceSphere");
    expect(calls[0].values).toEqual([11, 45, 1000, new Date("2026-01-01T00:00:00Z")]);
  });

  it("deactivates stale source alerts inside a bbox", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const repository = new PostgisAlertRepository({
      query: async (sql: string, values: unknown[]) => {
        calls.push({ sql, values });
        return { rowCount: 2 };
      },
    } as any);

    const count = await repository.deactivateMissingInBounds({
      source: "osm",
      activeIds: ["11111111-1111-4111-a111-111111111111"],
      bounds: {
        minLatitude: 44.96,
        minLongitude: 10.99,
        maxLatitude: 44.98,
        maxLongitude: 11.01,
      },
    });

    expect(count).toBe(2);
    expect(calls[0].sql).toContain("active = false");
    expect(calls[0].sql).toContain("ST_Covers");
    expect(calls[0].sql).toContain("ST_MakeEnvelope");
    expect(calls[0].values).toEqual([
      "osm",
      ["11111111-1111-4111-a111-111111111111"],
      10.99,
      44.96,
      11.01,
      44.98,
    ]);
  });
});
