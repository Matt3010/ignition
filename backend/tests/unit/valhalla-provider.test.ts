import { ValhallaRoadContextProvider } from "../../src/infrastructure/valhalla/valhalla-road-context-provider.js";
import { validPayload } from "../fixtures/config.js";

describe("Valhalla provider", () => {
  it("returns unmatched when Valhalla is unavailable", async () => {
    const provider = new ValhallaRoadContextProvider({
      traceAttributes: async () => {
        throw new Error("down");
      },
      health: async () => "down",
    });
    const result = await provider.match({ sample: validPayload, trace: [validPayload], previousState: null });
    expect(result.matched).toBe(false);
  });

  it("parses matched edge response", async () => {
    const provider = new ValhallaRoadContextProvider({
      traceAttributes: async () => ({
        edges: [{ names: ["SR308"], way_id: 123, road_class: "primary", speed_limit: "70", forward: true, end_heading: 0 }],
        matched_points: [{ edge_index: 0, distance_from_trace_point: 3, type: "matched" }],
      }),
      health: async () => "up",
    });
    const result = await provider.match({ sample: validPayload, trace: [validPayload], previousState: null });
    expect(result.matched).toBe(true);
    expect(result.roadId).toBe("way-123");
    expect(result.speedLimitKmh).toBe(70);
  });

  it("returns a readable fallback name for unnamed OSM ways", async () => {
    const provider = new ValhallaRoadContextProvider({
      traceAttributes: async () => ({
        edges: [{ names: [], way_id: 76210046, road_class: "residential", speed_limit: "35", forward: true }],
        matched_points: [{ edge_index: 0, distance_from_trace_point: 3, type: "matched" }],
      }),
      health: async () => "up",
    });
    const result = await provider.match({ sample: validPayload, trace: [validPayload], previousState: null });
    expect(result.matched).toBe(true);
    expect(result.roadId).toBe("way-76210046");
    expect(result.roadName).toBe("Strada residenziale senza nome");
  });
});
