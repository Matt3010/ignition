import { loadConfig } from "../../src/config/env.js";

describe("config", () => {
  it("accepts a comma-separated list of OSM regions", () => {
    expect(loadConfig({ OSM_REGIONS: "italy,france,switzerland" }).OSM_REGIONS).toBe(
      "italy,france,switzerland",
    );
  });
});
