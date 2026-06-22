import { loadConfig } from "../../src/config/env.js";

describe("config", () => {
  it("rejects mock provider in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        ROAD_CONTEXT_PROVIDER: "mock",
      }),
    ).toThrow("ROAD_CONTEXT_PROVIDER=mock is not allowed in production");
  });

  it("accepts a comma-separated list of OSM regions", () => {
    expect(loadConfig({ OSM_REGIONS: "italy,france,switzerland" }).OSM_REGIONS).toBe(
      "italy,france,switzerland",
    );
  });
});
