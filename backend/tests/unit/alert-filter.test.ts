import type { AlertCandidate } from "../../src/domain/models/alert.js";
import { filterRelevantAlerts } from "../../src/domain/services/alert-filter.js";

const base: AlertCandidate = {
  id: "a", type: "fixedSpeedCamera", latitude: 45.001, longitude: 11,
  speedLimitKmh: 70, speedLimitSource: "explicit", direction: "forward", bearing: 0,
  roadId: "way-1", confidence: 0.9, active: true, validFrom: null, validUntil: null,
  source: "test", distanceMeters: 100,
};

function filter(alerts: AlertCandidate[], overrides: Partial<Parameters<typeof filterRelevantAlerts>[0]> = {}) {
  return filterRelevantAlerts({
    alerts, userCourse: 0, matchedRoadBearing: null, userLatitude: 45, userLongitude: 11,
    userSpeedKmh: 50, horizontalAccuracyMeters: 5, previousPosition: null,
    behindMinAngleDegrees: 135, behindImmediateAngleDegrees: 170, behindMinSpeedKmh: 5,
    behindMaxGpsAccuracyMeters: 25, behindMinDistanceIncreaseMeters: 5, ...overrides,
  });
}

describe("alert filtering", () => {
  it("keeps all nearby alerts regardless of status, confidence, road, or validity", () => {
    expect(filter([base, { ...base, id: "inactive", active: false }, { ...base, id: "low", confidence: 0.1 }])).toHaveLength(3);
  });
  it("keeps a geometrically rear alert until movement proves it was passed", () => {
    expect(filter([{ ...base, id: "ahead", latitude: 45.001, roadId: null }, { ...base, id: "behind", latitude: 44.999, roadId: null }]).map(a => a.id)).toEqual(["ahead", "behind"]);
  });
  it("keeps a same-road rear alert until movement away proves it was passed", () => {
    expect(filter([{ ...base, latitude: 44.999, roadId: "way-1" }])).toHaveLength(1);
  });
  it("suppresses an almost exactly rear alert when moving away", () => {
    expect(filter([{ ...base, latitude: 44.999 }], { previousPosition: { latitude: 44.9995, longitude: 11 } })).toHaveLength(0);
  });
  it("keeps a side/rear alert on a possible curve even while euclidean distance grows", () => {
    expect(filter([{ ...base, latitude: 44.9993, longitude: 11.0007 }], { previousPosition: { latitude: 44.9996, longitude: 11.0004 } })).toHaveLength(1);
  });
  it("keeps rear alerts with low speed or poor GPS", () => {
    const alert = { ...base, latitude: 44.999, roadId: null };
    expect(filter([alert], { userSpeedKmh: 2 })).toHaveLength(1);
    expect(filter([alert], { horizontalAccuracyMeters: 40 })).toHaveLength(1);
  });
  it("does not truncate large result sets", () => {
    const alerts = Array.from({ length: 300 }, (_, index) => ({ ...base, id: `a-${index}`, distanceMeters: index }));
    expect(filter(alerts, { userCourse: null })).toHaveLength(300);
  });
});
