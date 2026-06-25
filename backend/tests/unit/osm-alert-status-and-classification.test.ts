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

  it("imports lifecycle-prefixed alerts and preserves their original tags", () => {
    const xml = `<osm version="0.6">
      <node id="6" lat="45.005" lon="11.005"><tag k="removed:highway" v="speed_camera"/><tag k="removed:maxspeed" v="70"/></node>
      <node id="7" lat="45.006" lon="11.006"><tag k="disused:enforcement" v="traffic_signals"/></node>
      <node id="8" lat="45.007" lon="11.007"><tag k="demolished:highway" v="roadworks"/></node>
    </osm>`;
    const alerts = parseOsmAlerts(xml).alerts;
    expect(alerts).toHaveLength(3);
    expect(alerts[0]).toMatchObject({ type: "fixedSpeedCamera", operationalStatus: "notOperational", statusReason: "removed:highway=speed_camera", speedLimitKmh: 70 });
    expect(alerts[0].sourceTags).toEqual({ "removed:highway": "speed_camera", "removed:maxspeed": "70" });
    expect(alerts[1]).toMatchObject({ type: "redLightCamera", operationalStatus: "notOperational", statusReason: "disused:enforcement=traffic_signals" });
    expect(alerts[2]).toMatchObject({ type: "roadWorks", operationalStatus: "notOperational", statusReason: "demolished:highway=roadworks" });
  });

  it("classifies standalone traffic_signals=red_light_camera tags", () => {
    const xml = `<osm version="0.6">
      <node id="20" lat="45.01" lon="11.01"><tag k="highway" v="traffic_signals"/><tag k="traffic_signals" v="red_light_camera"/></node>
      <node id="21" lat="45.02" lon="11.02"><tag k="disused:traffic_signals" v="red_light_camera"/></node>
    </osm>`;
    const alerts = parseOsmAlerts(xml).alerts;
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatchObject({ type: "redLightCamera", operationalStatus: "unknown" });
    expect(alerts[1]).toMatchObject({ type: "redLightCamera", operationalStatus: "notOperational", statusReason: "disused:traffic_signals=red_light_camera" });
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
  it("keeps access enforcement and drops low-value enforcement types", () => {
    const xml = `<osm version="0.6">
      <node id="1" lat="45" lon="11"><tag k="enforcement" v="access"/></node>
      <node id="2" lat="45.001" lon="11.001"><tag k="enforcement" v="maxweight"/></node>
      <node id="3" lat="45.002" lon="11.002"><tag k="enforcement" v="check"/></node>
    </osm>`;
    expect(parseOsmAlerts(xml).alerts.map((alert) => alert.type)).toEqual(["accessControl"]);
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

describe("OSM enforcement capabilities", () => {
  it("preserves multiple enforcement capabilities and selects a stable primary capability", () => {
    const xml = `<osm version="0.6">
      <node id="30" lat="45.03" lon="11.03">
        <tag k="enforcement" v="maxspeed;traffic_signals"/>
        <tag k="maxspeed" v="70"/>
      </node>
    </osm>`;
    const [alert] = parseOsmAlerts(xml).alerts;
    expect(alert).toMatchObject({
      type: "fixedSpeedCamera",
      subtype: "fixed",
      capabilities: ["maxspeed", "traffic_signals"],
      primaryCapability: "maxspeed",
      speedLimitKmh: 70,
    });
  });

  it("keeps average-speed enforcement distinct from fixed cameras", () => {
    const xml = `<osm version="0.6">
      <relation id="31">
        <member type="node" ref="32" role="device"/>
        <tag k="type" v="enforcement"/>
        <tag k="enforcement" v="average_speed"/>
      </relation>
      <node id="32" lat="45.04" lon="11.04"/>
    </osm>`;
    const [alert] = parseOsmAlerts(xml).alerts;
    expect(alert).toMatchObject({
      type: "averageSpeedCamera",
      subtype: "average",
      capabilities: ["average_speed"],
      primaryCapability: "average_speed",
    });
  });

  it("drops unknown enforcement values", () => {
    const xml = `<osm version="0.6">
      <node id="33" lat="45.05" lon="11.05"><tag k="enforcement" v="maxheight;check"/></node>
    </osm>`;
    expect(parseOsmAlerts(xml).alerts).toEqual([]);
  });
});
