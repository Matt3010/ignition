import { loadConfig } from "../../src/config/env.js";

describe("config", () => {
  it("accepts a comma-separated list of OSM regions", () => {
    expect(loadConfig({ OSM_REGIONS: "italy,france,switzerland" }).OSM_REGIONS).toBe(
      "italy,france,switzerland",
    );
  });

  it("uses a 10 km default radius for generic map alerts", () => {
    const config = loadConfig({});
    expect(config.ALERT_SEARCH_RADIUS_METERS).toBe(1500);
    expect(config.GENERIC_ALERT_SEARCH_RADIUS_METERS).toBe(10000);
  });
});
