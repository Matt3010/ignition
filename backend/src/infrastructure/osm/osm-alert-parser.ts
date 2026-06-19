import { createHash } from "node:crypto";
import type { Direction, RoadAlert } from "../../domain/models/alert.js";
import { initialBearing, normalizeCourse } from "../../domain/services/geo.js";
import { parseMaxspeedToKmh } from "../../domain/services/maxspeed.js";

interface OsmNode {
  id: string;
  latitude: number;
  longitude: number;
  tags: Record<string, string>;
}

interface OsmWay {
  id: string;
  nodeRefs: string[];
  tags: Record<string, string>;
}

interface OsmRelationMember {
  type: string;
  ref: string;
  role: string;
}

interface OsmRelation {
  id: string;
  members: OsmRelationMember[];
  tags: Record<string, string>;
}

export interface OsmAlertParseResult {
  alerts: RoadAlert[];
  elementsScanned: number;
  bounds: OsmBounds | null;
}

export interface OsmBounds {
  minLatitude: number;
  minLongitude: number;
  maxLatitude: number;
  maxLongitude: number;
}

export function parseOsmAlerts(xml: string, source = "osm"): OsmAlertParseResult {
  const nodes = parseNodes(xml);
  const ways = parseWays(xml);
  const waysById = new Map(ways.map((way) => [way.id, way]));
  const relations = parseRelations(xml);
  const speedCameraNodesCoveredByRelations = enforcementDeviceNodeIds(relations);
  const alerts: RoadAlert[] = [];

  for (const node of nodes.values()) {
    if (speedCameraNodesCoveredByRelations.has(node.id) && isSpeedCamera(node.tags)) continue;
    const alert = alertFromElement("node", node.id, node.latitude, node.longitude, node.tags, source, null);
    if (alert) alerts.push(alert);
  }

  for (const way of ways) {
    const center = wayCenter(way, nodes);
    if (!center) continue;
    const alert = alertFromElement("way", way.id, center.latitude, center.longitude, way.tags, source, `way-${way.id}`);
    if (alert) alerts.push(alert);
  }

  for (const relation of relations) {
    const alert = alertFromRelation(relation, nodes, waysById, source);
    if (alert) alerts.push(alert);
  }

  return {
    alerts: dedupe(alerts),
    elementsScanned: nodes.size + ways.length + relations.length,
    bounds: parseBounds(xml) ?? boundsFromNodes(nodes),
  };
}

function enforcementDeviceNodeIds(relations: OsmRelation[]): Set<string> {
  const ids = new Set<string>();
  for (const relation of relations) {
    if (relation.tags.enforcement !== "maxspeed") continue;
    for (const member of relation.members) {
      if (member.type === "node" && (member.role === "device" || member.role === "via")) ids.add(member.ref);
    }
  }
  return ids;
}

function alertFromRelation(
  relation: OsmRelation,
  nodes: Map<string, OsmNode>,
  ways: Map<string, OsmWay>,
  source: string,
): RoadAlert | null {
  if (relation.tags.enforcement !== "maxspeed") return null;
  const deviceNode = relationNode(relation, nodes, "device") ?? relationNode(relation, nodes, "via");
  const fromNode = relationNode(relation, nodes, "from") ?? relationWayEndpoint(relation, nodes, ways, "from", deviceNode);
  const toNode = relationNode(relation, nodes, "to") ?? relationWayEndpoint(relation, nodes, ways, "to", deviceNode);
  const node = deviceNode ?? fromNode ?? toNode;
  if (!node) return null;
  const bearing = relationBearing(fromNode, deviceNode, toNode);
  return buildAlert({
    osmType: "relation",
    osmId: relation.id,
    type: "fixedSpeedCamera",
    latitude: node.latitude,
    longitude: node.longitude,
    tags: relation.tags,
    source,
    roadId: relationRoadId(relation),
    direction: bearing === null ? "unknown" : "forward",
    bearing,
    confidence: bearing === null ? 0.9 : 0.95,
  });
}

function alertFromElement(
  osmType: "node" | "way",
  osmId: string,
  latitude: number,
  longitude: number,
  tags: Record<string, string>,
  source: string,
  roadId: string | null,
): RoadAlert | null {
  if (isSpeedCamera(tags)) {
    return buildAlert({
      osmType,
      osmId,
      type: "fixedSpeedCamera",
      latitude,
      longitude,
      tags,
      source,
      roadId,
      confidence: 0.88,
    });
  }
  if (isRoadWorks(tags)) {
    return buildAlert({
      osmType,
      osmId,
      type: "roadWorks",
      latitude,
      longitude,
      tags,
      source,
      roadId,
      confidence: 0.75,
    });
  }
  if (isRoadHazard(tags)) {
    return buildAlert({
      osmType,
      osmId,
      type: "roadHazard",
      latitude,
      longitude,
      tags,
      source,
      roadId,
      confidence: 0.72,
    });
  }
  return null;
}

function buildAlert(input: {
  osmType: string;
  osmId: string;
  type: RoadAlert["type"];
  latitude: number;
  longitude: number;
  tags: Record<string, string>;
  source: string;
  roadId: string | null;
  direction?: Direction;
  bearing?: number | null;
  confidence: number;
}): RoadAlert {
  const now = new Date();
  return {
    id: deterministicUuid(`${input.source}:${input.osmType}:${input.osmId}:${input.type}`),
    type: input.type,
    latitude: input.latitude,
    longitude: input.longitude,
    speedLimitKmh: parseMaxspeedToKmh(input.tags.maxspeed ?? input.tags["maxspeed:forward"] ?? input.tags["maxspeed:backward"]),
    direction: input.direction ?? parseDirection(input.tags.direction),
    bearing: input.bearing ?? parseBearing(input.tags),
    roadId: input.roadId,
    confidence: input.confidence,
    active: true,
    validFrom: null,
    validUntil: null,
    source: input.source,
    createdAt: now,
    updatedAt: now,
  };
}

function parseNodes(xml: string): Map<string, OsmNode> {
  const nodes = new Map<string, OsmNode>();
  for (const match of xml.matchAll(/<node\b([^>]*?)(?:\/>|>([\s\S]*?)<\/node>)/g)) {
    const attrs = parseAttributes(match[1]);
    const id = attrs.id;
    const latitude = Number(attrs.lat);
    const longitude = Number(attrs.lon);
    if (!id || !Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    nodes.set(id, {
      id,
      latitude,
      longitude,
      tags: parseTags(match[2] ?? ""),
    });
  }
  return nodes;
}

function parseBounds(xml: string): OsmBounds | null {
  const match = xml.match(/<bounds\b([^>]*)\/>/);
  if (!match) return null;
  const attrs = parseAttributes(match[1]);
  const minLatitude = Number(attrs.minlat);
  const minLongitude = Number(attrs.minlon);
  const maxLatitude = Number(attrs.maxlat);
  const maxLongitude = Number(attrs.maxlon);
  if (![minLatitude, minLongitude, maxLatitude, maxLongitude].every(Number.isFinite)) return null;
  return { minLatitude, minLongitude, maxLatitude, maxLongitude };
}

function boundsFromNodes(nodes: Map<string, OsmNode>): OsmBounds | null {
  if (!nodes.size) return null;
  let minLatitude = 90;
  let minLongitude = 180;
  let maxLatitude = -90;
  let maxLongitude = -180;
  for (const node of nodes.values()) {
    minLatitude = Math.min(minLatitude, node.latitude);
    minLongitude = Math.min(minLongitude, node.longitude);
    maxLatitude = Math.max(maxLatitude, node.latitude);
    maxLongitude = Math.max(maxLongitude, node.longitude);
  }
  return { minLatitude, minLongitude, maxLatitude, maxLongitude };
}

function parseWays(xml: string): OsmWay[] {
  const ways: OsmWay[] = [];
  for (const match of xml.matchAll(/<way\b([^>]*)>([\s\S]*?)<\/way>/g)) {
    const attrs = parseAttributes(match[1]);
    if (!attrs.id) continue;
    ways.push({
      id: attrs.id,
      nodeRefs: [...match[2].matchAll(/<nd\b([^>]*)\/>/g)]
        .map((item) => parseAttributes(item[1]).ref)
        .filter((ref): ref is string => Boolean(ref)),
      tags: parseTags(match[2]),
    });
  }
  return ways;
}

function parseRelations(xml: string): OsmRelation[] {
  const relations: OsmRelation[] = [];
  for (const match of xml.matchAll(/<relation\b([^>]*)>([\s\S]*?)<\/relation>/g)) {
    const attrs = parseAttributes(match[1]);
    if (!attrs.id) continue;
    relations.push({
      id: attrs.id,
      members: [...match[2].matchAll(/<member\b([^>]*)\/>/g)].map((item) => {
        const member = parseAttributes(item[1]);
        return { type: member.type ?? "", ref: member.ref ?? "", role: member.role ?? "" };
      }),
      tags: parseTags(match[2]),
    });
  }
  return relations;
}

function relationNode(
  relation: OsmRelation,
  nodes: Map<string, OsmNode>,
  role: "device" | "from" | "to" | "via",
): OsmNode | null {
  const member = relation.members.find((item) => item.type === "node" && item.role === role);
  return member ? (nodes.get(member.ref) ?? null) : null;
}

function relationWayEndpoint(
  relation: OsmRelation,
  nodes: Map<string, OsmNode>,
  ways: Map<string, OsmWay>,
  role: "from" | "to",
  deviceNode: OsmNode | null,
): OsmNode | null {
  const member = relation.members.find((item) => item.type === "way" && item.role === role);
  const way = member ? ways.get(member.ref) : null;
  if (!way) return null;
  const wayNodes = way.nodeRefs.map((ref) => nodes.get(ref)).filter((node): node is OsmNode => Boolean(node));
  if (!wayNodes.length) return null;
  if (!deviceNode) return role === "from" ? wayNodes.at(-1)! : wayNodes[0];
  return nearestNode(wayNodes, deviceNode);
}

function relationRoadId(relation: OsmRelation): string | null {
  const wayMember = relation.members.find(
    (item) => item.type === "way" && (item.role === "from" || item.role === "to"),
  );
  return wayMember ? `way-${wayMember.ref}` : null;
}

function relationBearing(
  fromNode: OsmNode | null,
  deviceNode: OsmNode | null,
  toNode: OsmNode | null,
): number | null {
  if (fromNode && toNode) {
    return initialBearing(fromNode.latitude, fromNode.longitude, toNode.latitude, toNode.longitude);
  }
  if (fromNode && deviceNode) {
    return initialBearing(fromNode.latitude, fromNode.longitude, deviceNode.latitude, deviceNode.longitude);
  }
  if (deviceNode && toNode) {
    return initialBearing(deviceNode.latitude, deviceNode.longitude, toNode.latitude, toNode.longitude);
  }
  return null;
}

function nearestNode(nodes: OsmNode[], target: OsmNode): OsmNode {
  return nodes.reduce((best, node) => {
    const bestScore = squaredDistance(best, target);
    const nodeScore = squaredDistance(node, target);
    return nodeScore < bestScore ? node : best;
  });
}

function squaredDistance(left: OsmNode, right: OsmNode): number {
  return (left.latitude - right.latitude) ** 2 + (left.longitude - right.longitude) ** 2;
}

function parseTags(block: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const match of block.matchAll(/<tag\b([^>]*)\/>/g)) {
    const attrs = parseAttributes(match[1]);
    if (attrs.k && attrs.v !== undefined) tags[attrs.k] = attrs.v;
  }
  return tags;
}

function parseAttributes(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of input.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
    attrs[match[1]] = decodeXml(match[2]);
  }
  return attrs;
}

function decodeXml(input: string): string {
  return input
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function wayCenter(way: OsmWay, nodes: Map<string, OsmNode>): { latitude: number; longitude: number } | null {
  const wayNodes = way.nodeRefs.map((ref) => nodes.get(ref)).filter((node): node is OsmNode => Boolean(node));
  if (!wayNodes.length) return null;
  return {
    latitude: wayNodes.reduce((sum, node) => sum + node.latitude, 0) / wayNodes.length,
    longitude: wayNodes.reduce((sum, node) => sum + node.longitude, 0) / wayNodes.length,
  };
}

function isSpeedCamera(tags: Record<string, string>): boolean {
  return (
    tags.highway === "speed_camera" ||
    tags.enforcement === "maxspeed" ||
    tags["speed_camera"] === "yes" ||
    tags["camera:type"] === "speed"
  );
}

function isRoadWorks(tags: Record<string, string>): boolean {
  return (
    tags.highway === "construction" ||
    tags.highway === "roadworks" ||
    Boolean(tags.construction) ||
    tags.roadworks === "yes"
  );
}

function isRoadHazard(tags: Record<string, string>): boolean {
  return Boolean(tags.hazard) || Boolean(tags["hazard:conditional"]) || tags.highway === "hazard";
}

function parseDirection(value: string | undefined): Direction {
  if (value === "forward" || value === "backward") return value;
  return "unknown";
}

function parseBearing(tags: Record<string, string>): number | null {
  return normalizeCourse(Number(tags.bearing ?? tags["camera:direction"] ?? tags.direction));
}

function deterministicUuid(value: string): string {
  const hash = createHash("sha1").update(value).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function dedupe(alerts: RoadAlert[]): RoadAlert[] {
  const seen = new Map<string, RoadAlert>();
  for (const alert of alerts) {
    const existing = seen.get(alert.id);
    if (!existing || alert.confidence >= existing.confidence) seen.set(alert.id, alert);
  }
  return [...seen.values()];
}
