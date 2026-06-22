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
  it("keeps alerts on other roads and directions when they are not behind", () => {
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
    expect(alerts.map((alert) => alert.id)).toEqual(["a", "opposite-road", "opposite-dir"]);
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

  it("keeps expired and inactive alerts in lossless mode", () => {
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
    expect(alerts.map((alert) => alert.id)).toEqual(["a", "expired", "inactive"]);
  });

  it("does not mutate confidence when direction bearing is unknown", () => {
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
    expect(alert.confidence).toBe(0.95);
  });

  it("keeps all nearby alerts regardless of road assignment", () => {
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
    expect(alerts.map((alert) => alert.id)).toEqual(["close-unassigned", "far-unassigned", "same-road"]);
  });

  it("keeps all nearby alerts while the road is unmatched", () => {
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
    expect(alerts.map((alert) => alert.id)).toEqual(["close", "far", "same-road-but-unmatched"]);
  });
});

it("removes alerts that are behind the vehicle", () => {
  const alerts = filterRelevantAlerts({
    alerts: [
      { ...base, id: "ahead", latitude: 45.001, longitude: 11, roadId: null },
      { ...base, id: "behind", latitude: 44.999, longitude: 11, roadId: null },
    ],
    roadId: "way-1",
    userCourse: 0,
    userLatitude: 45,
    userLongitude: 11,
    aheadToleranceDegrees: 80,
    minConfidence: 0.6,
    direction: "forward",
    directionToleranceDegrees: 45,
    unassignedMaxDistanceMeters: 500,
    unmatchedMaxDistanceMeters: 300,
    now: new Date("2026-01-01T00:00:00Z"),
    limit: 10,
  });
  expect(alerts.map((alert) => alert.id)).toEqual(["ahead"]);
});

it("keeps non-operational OSM cameras visible even below the confidence threshold", () => {
    const alerts = filterRelevantAlerts({
      alerts: [{ ...base, confidence: 0.2, operationalStatus: "notOperational", statusReason: "no trace" }],
      roadId: null,
      userCourse: null,
      direction: "unknown",
      directionToleranceDegrees: 45,
      unassignedMaxDistanceMeters: 500,
      unmatchedMaxDistanceMeters: 300,
      minConfidence: 0.6,
      now: new Date(),
      limit: 10,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].operationalStatus).toBe("notOperational");
});
