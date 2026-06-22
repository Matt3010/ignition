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
    });
    expect(calls[0].sql).toContain("ST_DWithin");
    expect(calls[0].sql).toContain("ST_DistanceSphere");
    expect(calls[0].values).toEqual([11, 45, 1000]);
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

it("binds every upsert placeholder and commits atomically", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      return { rows: [], rowCount: 1 };
    },
    release: () => undefined,
  };
  const repository = new PostgisAlertRepository({
    connect: async () => client,
  } as any);

  await repository.upsertMany([{
    id: "11111111-1111-4111-a111-111111111111",
    type: "fixedSpeedCamera",
    latitude: 45,
    longitude: 11,
    speedLimitKmh: 70,
    speedLimitSource: "explicit",
    direction: "forward",
    bearing: 10,
    roadId: null,
    confidence: 0.9,
    active: true,
    validFrom: null,
    validUntil: null,
    source: "osm",
    directionBearings: [10],
    osmPresenceStatus: "present",
  }]);

  const insert = calls.find((call) => call.sql.includes("insert into road_alerts"));
  expect(insert).toBeDefined();
  const placeholders = [...insert!.sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
  expect(Math.max(...placeholders)).toBe(insert!.values.length);
  expect(calls.map((call) => call.sql.trim())).toEqual([
    "begin",
    expect.stringContaining("insert into road_alerts"),
    "commit",
  ]);
});
