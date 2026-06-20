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

  it("treats empty optional extract URL as unset", () => {
    expect(loadConfig({ OSM_EXTRACT_URL: "" }).OSM_EXTRACT_URL).toBeUndefined();
  });
});
