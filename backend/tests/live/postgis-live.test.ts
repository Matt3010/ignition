import pg from "pg";
import { randomUUID } from "node:crypto";
import { PostgisAlertRepository } from "../../src/infrastructure/repositories/postgis-alert-repository.js";
import type { RoadAlert } from "../../src/domain/models/alert.js";

const liveEnabled = process.env.RUN_DB_INTEGRATION === "1";
const describeLive = liveEnabled ? describe : describe.skip;

describeLive("live PostgreSQL/PostGIS integration", () => {
  const connectionString = process.env.DATABASE_URL ?? "postgres://road:road@127.0.0.1:5432/road_context";

  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required when RUN_DB_INTEGRATION=1");
    }
  });

  const pool = new pg.Pool({ connectionString, max: 2 });
  const repository = new PostgisAlertRepository(pool);

  beforeEach(async () => {
    await pool.query("delete from road_alerts where source like 'ci-live-test%'");
  });

  afterAll(async () => {
    await pool.query("delete from road_alerts where source like 'ci-live-test%'");
    await pool.end();
  });

  it("persists, spatially queries, updates and deactivates real alert rows", async () => {
    const nearbyId = randomUUID();
    const expiredId = randomUUID();
    const inactiveId = randomUUID();
    const farId = randomUUID();

    const alerts: RoadAlert[] = [
      makeAlert(nearbyId, 43.73842, 7.42462),
      makeAlert(expiredId, 43.73843, 7.42463, { validUntil: new Date(Date.now() - 60_000) }),
      makeAlert(inactiveId, 43.73844, 7.42464, { active: false, osmPresenceStatus: "missingFromLatestImport" }),
      makeAlert(farId, 43.76, 7.46),
    ];

    expect(await repository.upsertMany(alerts)).toBe(4);
    expect(await repository.health()).toBe("up");

    const nearby = await repository.findNearby({
      latitude: 43.73842,
      longitude: 7.42462,
      radiusMeters: 250,
    });

    expect(nearby.map((alert) => alert.id)).toEqual([nearbyId]);
    expect(nearby[0]?.distanceMeters).toBeLessThan(5);
    expect(nearby[0]?.capabilities).toEqual(["speed"]);

    const updated = makeAlert(nearbyId, 43.73842, 7.42462, {
      speedLimitKmh: 50,
      confidence: 0.95,
    });
    expect(await repository.upsertMany([updated])).toBe(1);

    const afterUpdate = await repository.findNearby({
      latitude: 43.73842,
      longitude: 7.42462,
      radiusMeters: 250,
    });
    expect(afterUpdate[0]?.speedLimitKmh).toBe(50);
    expect(afterUpdate[0]?.confidence).toBeCloseTo(0.95);

    const deactivated = await repository.deactivateMissingInBounds({
      source: "ci-live-test",
      activeIds: [],
      bounds: {
        minLatitude: 43.73,
        minLongitude: 7.41,
        maxLatitude: 43.75,
        maxLongitude: 7.44,
      },
    });
    expect(deactivated).toBe(2);

    const afterDeactivate = await repository.findNearby({
      latitude: 43.73842,
      longitude: 7.42462,
      radiusMeters: 250,
    });
    expect(afterDeactivate).toEqual([]);
  });

  it("persists multi-row upsert batches against real PostGIS", async () => {
    const alerts = Array.from({ length: 501 }, (_, index) =>
      makeAlert(randomUUID(), 43.7 + index / 100_000, 7.4 + index / 100_000, {
        source: "ci-live-test",
        osmId: `batch-${index}`,
        originalOsmIds: [`node/batch-${index}`],
      }),
    );

    expect(await repository.upsertMany(alerts)).toBe(501);

    const result = await pool.query(
      "select count(*)::int as count from road_alerts where source = 'ci-live-test' and osm_id like 'batch-%'",
    );
    expect(Number(result.rows[0]?.count ?? 0)).toBe(501);
  });

  it("syncs OSM alerts through staging and deactivates missing rows", async () => {
    const keepId = randomUUID();
    const replaceId = randomUUID();
    const staleId = randomUUID();
    await repository.upsertMany([
      makeAlert(keepId, 43.7101, 7.4101, { source: "ci-live-test-staging", osmId: "staging-keep" }),
      makeAlert(staleId, 43.7102, 7.4102, { source: "ci-live-test-staging", osmId: "staging-stale" }),
    ]);

    const result = await repository.syncManyViaStaging({
      alerts: [
        makeAlert(keepId, 43.7101, 7.4101, { source: "ci-live-test-staging", speedLimitKmh: 80, osmId: "staging-keep" }),
        makeAlert(replaceId, 43.7103, 7.4103, { source: "ci-live-test-staging", osmId: "staging-new" }),
      ],
      source: "ci-live-test-staging",
      bounds: {
        minLatitude: 43.70,
        minLongitude: 7.40,
        maxLatitude: 43.72,
        maxLongitude: 7.42,
      },
      deactivateMissing: true,
      minRetainRatio: 0.1,
      minExistingForRatioCheck: 1,
    });

    expect(result).toEqual({ upserted: 2, deactivated: 1 });
    const rows = await pool.query(
      `
      select id::text, speed_limit_kmh, active, osm_presence_status
      from road_alerts
      where id = any($1::uuid[])
      order by id
      `,
      [[keepId, replaceId, staleId]],
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row]));
    expect(byId.get(keepId)).toMatchObject({ speed_limit_kmh: 80, active: true, osm_presence_status: "present" });
    expect(byId.get(replaceId)).toMatchObject({ active: true, osm_presence_status: "present" });
    expect(byId.get(staleId)).toMatchObject({ active: false, osm_presence_status: "missingFromLatestImport" });
  });
});

function makeAlert(
  id: string,
  latitude: number,
  longitude: number,
  overrides: Partial<RoadAlert> = {},
): RoadAlert {
  return {
    id,
    type: "fixedSpeedCamera",
    subtype: "camera",
    capabilities: ["speed"],
    primaryCapability: "speed",
    latitude,
    longitude,
    speedLimitKmh: 70,
    speedLimitSource: "explicit",
    direction: "forward",
    bearing: 90,
    roadId: "ci-road",
    confidence: 0.9,
    active: true,
    validFrom: null,
    validUntil: null,
    source: "ci-live-test",
    operationalStatus: "operational",
    statusReason: null,
    directionBearings: [90],
    osmPresenceStatus: "present",
    originalOsmIds: [],
    ...overrides,
  };
}
