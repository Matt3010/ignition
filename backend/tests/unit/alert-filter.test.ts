import type { AlertCandidate } from "../../src/domain/models/alert.js";
import { filterRelevantAlerts } from "../../src/domain/services/alert-filter.js";

const base: AlertCandidate = {
  id: "a",
  type: "fixedSpeedCamera",
  latitude: 45,
  longitude: 11,
  speedLimitKmh: 70,
  direction: "forward",
  bearing: 0,
  roadId: "way-1",
  confidence: 0.9,
  active: true,
  validFrom: null,
  validUntil: null,
  source: "test",
  distanceMeters: 100,
};

describe("alert filtering", () => {
  it("removes opposite-road and opposite-direction alerts", () => {
    const alerts = filterRelevantAlerts({
      alerts: [
        base,
        { ...base, id: "opposite-road", roadId: "way-2" },
        { ...base, id: "opposite-dir", direction: "backward" },
      ],
      roadId: "way-1",
      userCourse: 0,
      direction: "forward",
      directionToleranceDegrees: 45,
      now: new Date("2026-01-01T00:00:00Z"),
      limit: 10,
    });
    expect(alerts.map((alert) => alert.id)).toEqual(["a"]);
  });

  it("removes expired and inactive alerts", () => {
    const alerts = filterRelevantAlerts({
      alerts: [
        base,
        { ...base, id: "expired", validUntil: new Date("2020-01-01T00:00:00Z") },
        { ...base, id: "inactive", active: false },
      ],
      roadId: "way-1",
      userCourse: 0,
      direction: "forward",
      directionToleranceDegrees: 45,
      now: new Date("2026-01-01T00:00:00Z"),
      limit: 10,
    });
    expect(alerts.map((alert) => alert.id)).toEqual(["a"]);
  });

  it("reduces confidence when direction bearing is unknown", () => {
    const [alert] = filterRelevantAlerts({
      alerts: [{ ...base, bearing: null, direction: "unknown", confidence: 0.95 }],
      roadId: "way-1",
      userCourse: 0,
      direction: "forward",
      directionToleranceDegrees: 45,
      now: new Date("2026-01-01T00:00:00Z"),
      limit: 10,
    });
    expect(alert.confidence).toBe(0.75);
  });
});
