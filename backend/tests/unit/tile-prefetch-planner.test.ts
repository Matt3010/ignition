import { planTilePrefetch } from "../../src/domain/services/tile-prefetch-planner.js";
import { validPayload } from "../fixtures/config.js";

const options = {
  prefix: "prefetch",
  halfLat: 0.01,
  halfLon: 0.01,
  gridDegrees: 0.01,
  lookaheadChunks: 1,
  lookaheadMeters: 1200,
};

describe("tile prefetch planner", () => {
  it("builds a stable bbox around the snapped current position", () => {
    const [plan] = planTilePrefetch({ ...validPayload, course: null }, options);
    expect(plan).toEqual({
      region: "prefetch-45p000000-11p000000",
      bbox: "10.990000,44.990000,11.010000,45.010000",
      centerLat: 45,
      centerLon: 11,
    });
  });

  it("adds lookahead chunks in the current course direction", () => {
    const plans = planTilePrefetch({ ...validPayload, course: 0 }, options);
    expect(plans).toHaveLength(2);
    expect(plans[0]?.region).toBe("prefetch-45p000000-11p000000");
    expect(plans[1]?.centerLat).toBeGreaterThan(plans[0]?.centerLat ?? 0);
    expect(plans[1]?.centerLon).toBe(11);
  });

  it("deduplicates points that snap to the same chunk", () => {
    const plans = planTilePrefetch(
      {
        ...validPayload,
        course: 90,
      },
      {
        ...options,
        lookaheadMeters: 50,
      },
    );
    expect(plans).toHaveLength(1);
  });
});
