import type { AlertCandidate } from "../../src/domain/models/alert.js";
import { filterRelevantAlerts } from "../../src/domain/services/alert-filter.js";

const base: AlertCandidate = {
  id: "a",
  type: "fixedSpeedCamera",
  latitude: 45,
  longitude: 11,
  speedLimitKmh: 70,
  speedLimitSource: "explicit",
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
        { ...base, bearing: null },
        { ...base, id: "opposite-road", roadId: "way-2" },
        { ...base, id: "opposite-dir", direction: "backward", bearing: null },
      ],
      roadId: "way-1",
      userCourse: 0,
      direction: "forward",
      directionToleranceDegrees: 45,
      unassignedMaxDistanceMeters: 500,
      unmatchedMaxDistanceMeters: 300,
      now: new Date("2026-01-01T00:00:00Z"),
      limit: 10,
    });
    expect(alerts.map((alert) => alert.id)).toEqual(["a"]);
  });

  it("keeps bearing-compatible camera alerts even when way direction differs", () => {
    const alerts = filterRelevantAlerts({
      alerts: [{ ...base, direction: "forward", bearing: 0 }],
      roadId: "way-1",
      userCourse: 0,
      direction: "backward",
      directionToleranceDegrees: 45,
      unassignedMaxDistanceMeters: 500,
      unmatchedMaxDistanceMeters: 300,
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
      unassignedMaxDistanceMeters: 500,
      unmatchedMaxDistanceMeters: 300,
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
      unassignedMaxDistanceMeters: 500,
      unmatchedMaxDistanceMeters: 300,
      now: new Date("2026-01-01T00:00:00Z"),
      limit: 10,
    });
    expect(alert.confidence).toBe(0.75);
  });

  it("keeps unassigned alerts only when they are close to the matched road position", () => {
    const alerts = filterRelevantAlerts({
      alerts: [
        { ...base, id: "close-unassigned", roadId: null, distanceMeters: 250 },
        { ...base, id: "far-unassigned", roadId: null, distanceMeters: 900 },
        { ...base, id: "same-road", roadId: "way-1", distanceMeters: 1200 },
      ],
      roadId: "way-1",
      userCourse: 0,
      direction: "forward",
      directionToleranceDegrees: 45,
      unassignedMaxDistanceMeters: 500,
      unmatchedMaxDistanceMeters: 300,
      now: new Date("2026-01-01T00:00:00Z"),
      limit: 10,
    });
    expect(alerts.map((alert) => alert.id)).toEqual(["same-road", "close-unassigned"]);
  });

  it("keeps only very close alerts while the road is unmatched", () => {
    const alerts = filterRelevantAlerts({
      alerts: [
        { ...base, id: "close", roadId: null, distanceMeters: 220 },
        { ...base, id: "far", roadId: null, distanceMeters: 450 },
        { ...base, id: "same-road-but-unmatched", roadId: "way-1", distanceMeters: 600 },
      ],
      roadId: null,
      userCourse: 0,
      direction: "unknown",
      directionToleranceDegrees: 45,
      unassignedMaxDistanceMeters: 500,
      unmatchedMaxDistanceMeters: 300,
      now: new Date("2026-01-01T00:00:00Z"),
      limit: 10,
    });
    expect(alerts.map((alert) => alert.id)).toEqual(["close"]);
  });
});
