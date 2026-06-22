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


  it("marks disabled=no as operational and disused/removed records as non operational", () => {
    const xml = `<osm version="0.6">
      <node id="3" lat="45.002" lon="11.002"><tag k="highway" v="speed_camera"/><tag k="disabled" v="no"/></node>
      <node id="4" lat="45.003" lon="11.003"><tag k="highway" v="speed_camera"/><tag k="disused" v="yes"/></node>
      <node id="5" lat="45.004" lon="11.004"><tag k="highway" v="speed_camera"/><tag k="removed" v="yes"/></node>
    </osm>`;
    const alerts = parseOsmAlerts(xml).alerts;
    expect(alerts[0]).toMatchObject({ operationalStatus: "operational", statusReason: "disabled=no" });
    expect(alerts[1]).toMatchObject({ operationalStatus: "notOperational", statusReason: "disused=yes" });
    expect(alerts[2]).toMatchObject({ operationalStatus: "notOperational", statusReason: "removed=yes" });
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

describe("additional OSM enforcement coverage", () => {
  it("keeps access, weight and generic enforcement types", () => {
    const xml = `<osm version="0.6">
      <node id="1" lat="45" lon="11"><tag k="enforcement" v="access"/></node>
      <node id="2" lat="45.001" lon="11.001"><tag k="enforcement" v="maxweight"/></node>
      <node id="3" lat="45.002" lon="11.002"><tag k="enforcement" v="check"/></node>
    </osm>`;
    expect(parseOsmAlerts(xml).alerts.map((alert) => alert.type)).toEqual([
      "accessControl", "weightControl", "genericEnforcement",
    ]);
  });

  it("preserves OSM metadata and rejects unrelated building construction", () => {
    const xml = `<osm version="0.6">
      <node id="1" lat="45" lon="11" version="7" timestamp="2026-06-20T10:00:00Z" changeset="123" user="mapper" uid="456">
        <tag k="highway" v="speed_camera"/><tag k="description" v="verificare la giusta posizione"/>
      </node>
      <node id="2" lat="45.1" lon="11.1"><tag k="building" v="construction"/><tag k="construction" v="house"/></node>
    </osm>`;
    const alerts = parseOsmAlerts(xml).alerts;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ osmVersion: 7, osmChangeset: "123", osmUser: "mapper", osmUid: "456", positionApproximate: true });
  });
});
