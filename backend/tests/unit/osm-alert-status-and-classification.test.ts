import { parseOsmAlerts } from "../../src/infrastructure/osm/osm-alert-parser.js";

describe("OSM alert status and classification", () => {
  it("keeps working=no and disabled=true cameras and marks them non operational", () => {
    const xml = `<osm version="0.6">
      <node id="1" lat="45" lon="11"><tag k="highway" v="speed_camera"/><tag k="working" v="no"/></node>
      <node id="2" lat="45.001" lon="11.001"><tag k="highway" v="speed_camera"/><tag k="disabled" v="true"/></node>
    </osm>`;
    const alerts = parseOsmAlerts(xml).alerts;
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatchObject({ operationalStatus: "notOperational", statusReason: "working=no" });
    expect(alerts[1]).toMatchObject({ operationalStatus: "notOperational", statusReason: "disabled=true" });
  });

  it("classifies traffic-signal enforcement as red-light cameras without dropping them", () => {
    const xml = `<osm version="0.6">
      <node id="1" lat="45" lon="11"><tag k="highway" v="speed_camera"/><tag k="enforcement" v="traffic_signals"/></node>
      <relation id="10"><member type="node" ref="1" role="device"/><tag k="type" v="enforcement"/><tag k="enforcement" v="traffic_signals"/></relation>
    </osm>`;
    const alerts = parseOsmAlerts(xml).alerts;
    expect(alerts).toHaveLength(2);
    expect(alerts.every((alert) => alert.type === "redLightCamera")).toBe(true);
  });

  it("parses multiple and negative numeric directions losslessly", () => {
    const xml = `<osm version="0.6">
      <node id="1" lat="45" lon="11"><tag k="highway" v="speed_camera"/><tag k="direction" v="90;260"/></node>
      <node id="2" lat="45.001" lon="11.001"><tag k="highway" v="speed_camera"/><tag k="direction" v="-90;95"/></node>
      <node id="3" lat="45.002" lon="11.002"><tag k="highway" v="speed_camera"/><tag k="direction" v="forward;backward"/></node>
    </osm>`;
    const alerts = parseOsmAlerts(xml).alerts;
    expect(alerts[0].directionBearings).toEqual([90, 260]);
    expect(alerts[1].directionBearings).toEqual([270, 95]);
    expect(alerts[2].directionBearings).toEqual([]);
    expect(alerts[2].direction).toBe("unknown");
  });
});
