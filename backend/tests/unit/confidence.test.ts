import { calculateRoadConfidence } from "../../src/domain/services/confidence.js";
import { validPayload } from "../fixtures/config.js";

describe("confidence", () => {
  it("scores a coherent match highly", () => {
    const score = calculateRoadConfidence({
      sample: validPayload,
      match: {
        matched: true,
        roadId: "way-1",
        roadName: "A",
        speedLimitKmh: 70,
        speedLimitSource: "explicit",
        roadType: "primary",
        direction: "forward",
        dataTimestamp: validPayload.timestamp,
        distanceFromTraceMeters: 2,
        bearing: 0,
        valhallaQuality: 0.95,
      },
      previousState: { roadId: "way-1", roadType: "primary", direction: "forward", confidence: 0.9, updatedAt: Date.now() },
    });
    expect(score).toBeGreaterThan(0.85);
  });

  it("penalizes parallel road oscillation", () => {
    const score = calculateRoadConfidence({
      sample: { ...validPayload, course: 90 },
      match: {
        matched: true,
        roadId: "way-2",
        roadName: "B",
        speedLimitKmh: null,
        speedLimitSource: "unknown",
        roadType: "secondary_link",
        direction: "forward",
        dataTimestamp: validPayload.timestamp,
        distanceFromTraceMeters: 5,
        bearing: 0,
        valhallaQuality: 0.75,
      },
      previousState: { roadId: "way-1", roadType: "primary", direction: "forward", confidence: 0.9, updatedAt: Date.now() },
      candidateAlternatives: [{ roadId: "way-1", distanceMeters: 7, bearing: 0 }],
    });
    expect(score).toBeLessThan(0.65);
  });
});
