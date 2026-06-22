import { readFile } from "node:fs/promises";
import { parseOsmAlerts } from "../../src/infrastructure/osm/osm-alert-parser.js";

describe("Campodarsego real OSM bbox regression", () => {
  it("preserves every real speed-camera node, including fixme and coincident records", async () => {
    const xml = await readFile(new URL("../fixtures/campodarsego-real-bbox.osm", import.meta.url), "utf8");
    const result = parseOsmAlerts(xml, "osm-real-campodarsego");
    const enforcementAlerts = result.alerts.filter((alert) =>
      alert.type === "fixedSpeedCamera" || alert.type === "redLightCamera",
    );
    const cameras = enforcementAlerts.filter((alert) => alert.type === "fixedSpeedCamera");
    const redLights = enforcementAlerts.filter((alert) => alert.type === "redLightCamera");

    expect(enforcementAlerts).toHaveLength(65);
    expect(new Set(enforcementAlerts.map((alert) => alert.osmId)).size).toBe(65);
    expect(cameras).toHaveLength(59);
    expect(redLights).toHaveLength(6);
    expect(enforcementAlerts.some((alert) => alert.fixme?.includes("no trace"))).toBe(true);
    expect(enforcementAlerts.some((alert) => alert.fixme?.includes("approx position"))).toBe(true);
    expect(enforcementAlerts.filter((alert) => alert.operationalStatus === "notOperational")).toHaveLength(1);
  });
});
