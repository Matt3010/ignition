import { InMemoryAlertRepository } from "../../src/infrastructure/alerts/in-memory-alert-repository.js";
import type { RoadAlert } from "../../src/domain/models/alert.js";

function alert(overrides: Partial<RoadAlert>): RoadAlert {
  return {
    id: crypto.randomUUID(),
    type: "fixedSpeedCamera",
    latitude: 45,
    longitude: 11,
    speedLimitKmh: 70,
    speedLimitSource: "explicit",
    direction: "unknown",
    bearing: null,
    roadId: null,
    confidence: 1,
    active: true,
    validFrom: null,
    validUntil: null,
    source: "osm",
    osmPresenceStatus: "present",
    ...overrides,
  };
}

describe("in-memory alert repository", () => {
  it("returns only active, present and currently valid alerts", async () => {
    const now = Date.now();
    const valid = alert({ id: "11111111-1111-4111-a111-111111111111" });
    const repository = new InMemoryAlertRepository([
      valid,
      alert({ active: false }),
      alert({ osmPresenceStatus: "missingFromLatestImport" }),
      alert({ validFrom: new Date(now + 60_000) }),
      alert({ validUntil: new Date(now - 60_000) }),
    ]);

    const result = await repository.findNearby({ latitude: 45, longitude: 11, radiusMeters: 100 });

    expect(result.map((item) => item.id)).toEqual([valid.id]);
  });
});
