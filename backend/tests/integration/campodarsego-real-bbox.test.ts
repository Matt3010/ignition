import { readFile } from "node:fs/promises";
import { parseOsmAlerts } from "../../src/infrastructure/osm/osm-alert-parser.js";

describe("Campodarsego real OSM bbox regression", () => {
  it("preserves every real camera node and every relation whose referenced geometry is present", async () => {
    const xml = await readFile(new URL("../fixtures/campodarsego-real-bbox.osm", import.meta.url), "utf8");
    const result = parseOsmAlerts(xml, "osm-real-campodarsego");
    const nodeAlerts = result.alerts.filter((alert) => alert.osmType === "node");
    const relationAlerts = result.alerts.filter((alert) => alert.osmType === "relation");
    const fixed = result.alerts.filter((alert) => alert.type === "fixedSpeedCamera");
    const redLights = result.alerts.filter((alert) => alert.type === "redLightCamera");

    expect(result.elementsScanned).toBe(108);
    expect(nodeAlerts).toHaveLength(66);
    expect(new Set(nodeAlerts.map((alert) => alert.osmId)).size).toBe(66);
    expect(relationAlerts).toHaveLength(11);
    expect(result.alerts).toHaveLength(77);
    expect(fixed).toHaveLength(67);
    expect(redLights).toHaveLength(10);
    expect(result.alerts.some((alert) => alert.fixme?.includes("no trace"))).toBe(true);
    expect(result.alerts.some((alert) => alert.fixme?.includes("approx position"))).toBe(true);
    expect(result.alerts.filter((alert) => alert.operationalStatus === "notOperational")).toHaveLength(1);
  });
});
