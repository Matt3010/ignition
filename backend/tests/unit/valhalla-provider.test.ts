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
    if (!result.matched) expect(result.unmatchedReason).toBe("providerError");
  });

  it("distinguishes a valid no-match response from a provider failure", async () => {
    const provider = new ValhallaRoadContextProvider({
      traceAttributes: async () => ({ edges: [], matched_points: [] }),
      health: async () => "up",
    });
    const result = await provider.match({ sample: validPayload, trace: [validPayload], previousState: null });
    expect(result.matched).toBe(false);
    if (!result.matched) expect(result.unmatchedReason).toBe("noMatch");
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

  it("does not treat Valhalla routing speed as a legal speed limit", async () => {
    const provider = new ValhallaRoadContextProvider({
      traceAttributes: async () => ({
        edges: [{ names: ["Via senza maxspeed"], way_id: 42, road_class: "service_other", speed: 25, forward: true }],
        matched_points: [{ edge_index: 0, distance_from_trace_point: 3, type: "matched" }],
      }),
      health: async () => "up",
    });
    const result = await provider.match({ sample: validPayload, trace: [validPayload], previousState: null });
    expect(result.matched).toBe(true);
    expect(result.speedLimitKmh).toBeNull();
  });
});

it("classifies structurally incomplete Valhalla payloads as provider errors", async () => {
  const provider = new ValhallaRoadContextProvider({
    traceAttributes: async () => ({ matched_points: [{}], edges: [{}] }),
    health: async () => "up",
  });
  const result = await provider.match({ sample: validPayload, trace: [validPayload], previousState: null });
  expect(result.matched).toBe(false);
  if (!result.matched) expect(result.unmatchedReason).toBe("providerError");
});

it("classifies out-of-range edge indexes as provider errors", async () => {
  const provider = new ValhallaRoadContextProvider({
    traceAttributes: async () => ({
      matched_points: [{ edge_index: 2, type: "matched" }],
      edges: [{ way_id: 1 }],
    }),
    health: async () => "up",
  });
  const result = await provider.match({ sample: validPayload, trace: [validPayload], previousState: null });
  expect(result.matched).toBe(false);
  if (!result.matched) expect(result.unmatchedReason).toBe("providerError");
});

it("logs only a hashed session identifier on provider failures", async () => {
  const warnings: Record<string, unknown>[] = [];
  const provider = new ValhallaRoadContextProvider(
    {
      traceAttributes: async () => {
        throw new Error("down");
      },
      health: async () => "down",
    },
    {
      warn: (data) => warnings.push(data),
    },
  );

  await provider.match({ sample: validPayload, trace: [validPayload], previousState: null });
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).not.toHaveProperty("sessionId");
  expect(warnings[0]?.sessionHash).toMatch(/^s_[0-9a-f]+$/);
  expect(warnings[0]?.sessionHash).not.toBe(validPayload.sessionId);
});
