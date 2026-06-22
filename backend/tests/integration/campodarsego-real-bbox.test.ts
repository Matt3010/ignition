import { readFile } from "node:fs/promises";
import { parseOsmAlerts } from "../../src/infrastructure/osm/osm-alert-parser.js";

describe("Campodarsego real OSM bbox regression", () => {
  it("preserves every real speed-camera node, including fixme and coincident records", async () => {
    const xml = await readFile(new URL("../fixtures/campodarsego-real-bbox.osm", import.meta.url), "utf8");
    const result = parseOsmAlerts(xml, "osm-real-campodarsego");
    const cameras = result.alerts.filter((alert) => alert.type === "fixedSpeedCamera");

    expect(cameras).toHaveLength(65);
    expect(new Set(cameras.map((alert) => alert.osmId)).size).toBe(65);
    expect(cameras.some((alert) => alert.fixme?.includes("no trace"))).toBe(true);
    expect(cameras.some((alert) => alert.fixme?.includes("approx position"))).toBe(true);
    expect(cameras.filter((alert) => alert.operationalStatus === "notOperational")).toHaveLength(1);
  });
});
