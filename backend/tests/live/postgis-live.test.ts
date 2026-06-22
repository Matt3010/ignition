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

  beforeAll(async () => {
    await pool.query("delete from road_alerts where source = 'ci-live-test'");
  });

  afterAll(async () => {
    await pool.query("delete from road_alerts where source = 'ci-live-test'");
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
