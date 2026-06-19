import { parseOsmAlerts } from "../../src/infrastructure/osm/osm-alert-parser.js";

describe("OSM alert parser", () => {
  it("imports static alerts from real OSM tags", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <bounds minlat="44.9900" minlon="10.9900" maxlat="45.0100" maxlon="11.0100"/>
  <node id="1" lat="45.0001" lon="11.0001">
    <tag k="highway" v="speed_camera"/>
    <tag k="maxspeed" v="50"/>
    <tag k="direction" v="forward"/>
    <tag k="bearing" v="90"/>
  </node>
  <node id="2" lat="45.0002" lon="11.0002">
    <tag k="hazard" v="rockfall"/>
  </node>
  <node id="3" lat="45.0010" lon="11.0010"/>
  <node id="4" lat="45.0030" lon="11.0030"/>
  <node id="5" lat="44.9990" lon="11.0002"/>
  <node id="6" lat="45.0010" lon="11.0002"/>
  <way id="10">
    <nd ref="3"/>
    <nd ref="4"/>
    <tag k="highway" v="construction"/>
    <tag k="maxspeed" v="30 mph"/>
  </way>
  <relation id="20">
    <member type="node" ref="2" role="device"/>
    <member type="node" ref="5" role="from"/>
    <member type="node" ref="6" role="to"/>
    <tag k="type" v="enforcement"/>
    <tag k="enforcement" v="maxspeed"/>
    <tag k="maxspeed" v="70"/>
  </relation>
</osm>`;

    const result = parseOsmAlerts(xml);

    expect(result.bounds).toEqual({
      minLatitude: 44.99,
      minLongitude: 10.99,
      maxLatitude: 45.01,
      maxLongitude: 11.01,
    });
    expect(result.elementsScanned).toBe(8);
    expect(result.alerts).toHaveLength(4);
    expect(result.alerts.map((alert) => alert.type)).toEqual([
      "fixedSpeedCamera",
      "roadHazard",
      "roadWorks",
      "fixedSpeedCamera",
    ]);
    expect(result.alerts[0]).toMatchObject({
      latitude: 45.0001,
      longitude: 11.0001,
      speedLimitKmh: 50,
      direction: "forward",
      bearing: 90,
      source: "osm",
    });
    expect(result.alerts[2].latitude).toBeCloseTo(45.002);
    expect(result.alerts[2].longitude).toBeCloseTo(11.002);
    expect(result.alerts[2]).toMatchObject({
      roadId: "way-10",
      speedLimitKmh: 48,
    });
    expect(result.alerts[3]).toMatchObject({
      type: "fixedSpeedCamera",
      latitude: 45.0002,
      longitude: 11.0002,
      speedLimitKmh: 70,
      direction: "forward",
    });
    expect(result.alerts[3].bearing).toBeCloseTo(0);
  });

  it("keeps directional OSM enforcement relations and suppresses the generic device duplicate", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <node id="1" lat="45.0000" lon="11.0000"/>
  <node id="2" lat="45.0010" lon="11.0000">
    <tag k="highway" v="speed_camera"/>
    <tag k="maxspeed" v="50"/>
  </node>
  <node id="3" lat="45.0020" lon="11.0000"/>
  <node id="4" lat="45.0010" lon="10.9990"/>
  <node id="5" lat="45.0010" lon="11.0010"/>
  <relation id="100">
    <member type="node" ref="1" role="from"/>
    <member type="node" ref="2" role="device"/>
    <member type="node" ref="3" role="to"/>
    <tag k="type" v="enforcement"/>
    <tag k="enforcement" v="maxspeed"/>
    <tag k="maxspeed" v="50"/>
  </relation>
  <relation id="101">
    <member type="node" ref="4" role="from"/>
    <member type="node" ref="2" role="device"/>
    <member type="node" ref="5" role="to"/>
    <tag k="type" v="enforcement"/>
    <tag k="enforcement" v="maxspeed"/>
    <tag k="maxspeed" v="50"/>
  </relation>
</osm>`;

    const result = parseOsmAlerts(xml);

    expect(result.alerts).toHaveLength(2);
    expect(result.alerts.filter((alert) => alert.type === "fixedSpeedCamera")).toHaveLength(2);
    expect(result.alerts[0].bearing).toBeCloseTo(0);
    expect(result.alerts[1].bearing).toBeCloseTo(90);
  });
});
