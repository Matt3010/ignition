import { createHash } from "node:crypto";
import type { Direction, RoadAlert } from "../../domain/models/alert.js";
import {
  initialBearing,
  normalizeCourse,
} from "../../domain/services/geo.js";
import { parseMaxspeed } from "../../domain/services/maxspeed.js";

interface OsmNode {
  id: string;
  latitude: number;
  longitude: number;
  tags: Record<string, string>;
  attributes: Record<string, string>;
}

interface OsmWay {
  id: string;
  nodeRefs: string[];
  tags: Record<string, string>;
  attributes: Record<string, string>;
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
  attributes: Record<string, string>;
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
  const alerts: RoadAlert[] = [];

  for (const node of nodes.values()) {
    const alert = alertFromElement(
      "node",
      node.id,
      node.latitude,
      node.longitude,
      node.tags,
      source,
      null,
      node.attributes,
    );
    if (alert) alerts.push(alert);
  }

  for (const way of ways) {
    const center = wayCenter(way, nodes);
    if (!center) continue;
    const alert = alertFromElement(
      "way",
      way.id,
      center.latitude,
      center.longitude,
      way.tags,
      source,
      `way-${way.id}`,
      way.attributes,
    );
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

function alertFromRelation(
  relation: OsmRelation,
  nodes: Map<string, OsmNode>,
  ways: Map<string, OsmWay>,
  source: string,
): RoadAlert | null {
  const deviceNode =
    relationNode(relation, nodes, "device") ?? relationNode(relation, nodes, "via");
  const fromNode =
    relationNode(relation, nodes, "from") ??
    relationWayEndpoint(relation, nodes, ways, "from", deviceNode);
  const toNode =
    relationNode(relation, nodes, "to") ??
    relationWayEndpoint(relation, nodes, ways, "to", deviceNode);
  const position = deviceNode ?? fromNode ?? toNode ?? relationWayCenter(relation, nodes, ways);
  if (!position) return null;
  const tags = { ...(deviceNode?.tags ?? {}), ...relation.tags };
  const effectiveTags = normalizeLifecycleTags(tags);
  const bearing = relationBearing(fromNode, deviceNode, toNode);
  const type = alertTypeFromTags(effectiveTags);
  if (!type) return null;
  return buildAlert({
    osmType: "relation",
    osmId: relation.id,
    type,
    latitude: position.latitude,
    longitude: position.longitude,
    tags,
    effectiveTags,
    source,
    roadId: relationRoadId(relation),
    direction: bearing === null ? "unknown" : "forward",
    bearing,
    directionBearings: bearing === null ? parseBearings(tags) : [bearing],
    confidence: calculateOsmConfidence(tags, {
      hasRoad: relationRoadId(relation) !== null,
      hasBearing: bearing !== null || parseBearing(tags) !== null,
      relation: true,
      attributes: relation.attributes,
    }),
    osmRelationId: relation.id,
    originalOsmIds: [`relation/${relation.id}`, ...(deviceNode ? [`node/${deviceNode.id}`] : [])],
    attributes: relation.attributes,
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
  attributes: Record<string, string>,
): RoadAlert | null {
  const effectiveTags = normalizeLifecycleTags(tags);
  const enforcementType = alertTypeFromTags(effectiveTags);
  if (enforcementType || isSpeedCamera(effectiveTags)) {
    return buildAlert({
      osmType,
      osmId,
      type: enforcementType ?? "fixedSpeedCamera",
      latitude,
      longitude,
      tags,
      effectiveTags,
      source,
      roadId,
      confidence: calculateOsmConfidence(tags, {
        hasRoad: roadId !== null,
        hasBearing: parseBearing(tags) !== null,
        relation: false,
        attributes,
      }),
      attributes,
    });
  }
  if (isRoadWorks(effectiveTags)) {
    return buildAlert({
      osmType,
      osmId,
      type: "roadWorks",
      latitude,
      longitude,
      tags,
      effectiveTags,
      source,
      roadId,
      confidence: calculateOsmConfidence(tags, {
        hasRoad: roadId !== null,
        hasBearing: parseBearing(tags) !== null,
        relation: false,
        attributes,
        base: 0.75,
      }),
      attributes,
    });
  }
  if (isRoadHazard(effectiveTags)) {
    return buildAlert({
      osmType,
      osmId,
      type: "roadHazard",
      latitude,
      longitude,
      tags,
      effectiveTags,
      source,
      roadId,
      confidence: calculateOsmConfidence(tags, {
        hasRoad: roadId !== null,
        hasBearing: parseBearing(tags) !== null,
        relation: false,
        attributes,
        base: 0.72,
      }),
      attributes,
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
  effectiveTags?: Record<string, string>;
  source: string;
  roadId: string | null;
  direction?: Direction;
  bearing?: number | null;
  directionBearings?: number[];
  confidence: number;
  osmRelationId?: string | null;
  originalOsmIds?: string[];
  attributes?: Record<string, string>;
}): RoadAlert {
  const effectiveTags = input.effectiveTags ?? normalizeLifecycleTags(input.tags);
  const maxspeed = parseMaxspeed(
    effectiveTags.maxspeed ?? effectiveTags["maxspeed:forward"] ?? effectiveTags["maxspeed:backward"],
  );
  return {
    id: deterministicUuid(`${input.source}:${input.osmType}:${input.osmId}:${input.type}`),
    type: input.type,
    latitude: input.latitude,
    longitude: input.longitude,
    speedLimitKmh: maxspeed.value,
    speedLimitSource: maxspeed.source,
    direction: input.direction ?? parseDirection(effectiveTags.direction),
    bearing: input.bearing ?? parseBearing(effectiveTags),
    directionBearings: input.directionBearings ?? parseBearings(effectiveTags),
    roadId: input.roadId,
    confidence: input.confidence,
    active: true,
    validFrom: null,
    validUntil: null,
    source: input.source,
    osmType: input.osmType,
    osmId: input.osmId,
    osmRelationId: input.osmRelationId ?? null,
    osmVersion: parseInteger(input.attributes?.version),
    osmTimestamp: parseOsmDate(input.attributes?.timestamp),
    osmChangeset: input.attributes?.changeset ?? null,
    osmUser: input.attributes?.user ?? null,
    osmUid: input.attributes?.uid ?? null,
    sourceTags: input.tags,
    fixme: input.tags.fixme ?? null,
    positionApproximate: isApproximatePosition(input.tags),
    operationalStatus: operationalStatusFromTags(input.tags),
    statusReason: operationalStatusReason(input.tags),
    osmPresenceStatus: "present",
    originalOsmIds: input.originalOsmIds ?? [`${input.osmType}/${input.osmId}`],
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
      attributes: attrs,
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
      attributes: attrs,
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
      attributes: attrs,
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
  const wayNodes = way.nodeRefs
    .map((ref) => nodes.get(ref))
    .filter((node): node is OsmNode => Boolean(node));
  if (!wayNodes.length) return null;
  if (!deviceNode) return role === "from" ? wayNodes.at(-1)! : wayNodes[0];
  return nearestNode(wayNodes, deviceNode);
}

function relationWayCenter(
  relation: OsmRelation,
  nodes: Map<string, OsmNode>,
  ways: Map<string, OsmWay>,
): { latitude: number; longitude: number } | null {
  for (const member of relation.members) {
    if (member.type !== "way") continue;
    const way = ways.get(member.ref);
    if (!way) continue;
    const center = wayCenter(way, nodes);
    if (center) return center;
  }
  return null;
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
    return initialBearing(
      fromNode.latitude,
      fromNode.longitude,
      deviceNode.latitude,
      deviceNode.longitude,
    );
  }
  if (deviceNode && toNode) {
    return initialBearing(
      deviceNode.latitude,
      deviceNode.longitude,
      toNode.latitude,
      toNode.longitude,
    );
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

function wayCenter(
  way: OsmWay,
  nodes: Map<string, OsmNode>,
): { latitude: number; longitude: number } | null {
  const wayNodes = way.nodeRefs
    .map((ref) => nodes.get(ref))
    .filter((node): node is OsmNode => Boolean(node));
  if (!wayNodes.length) return null;
  return {
    latitude: wayNodes.reduce((sum, node) => sum + node.latitude, 0) / wayNodes.length,
    longitude: wayNodes.reduce((sum, node) => sum + node.longitude, 0) / wayNodes.length,
  };
}


const lifecyclePrefixes = ["disused", "abandoned", "removed", "demolished", "razed"] as const;

function normalizeLifecycleTags(tags: Record<string, string>): Record<string, string> {
  const normalized = { ...tags };
  for (const prefix of lifecyclePrefixes) {
    for (const [key, value] of Object.entries(tags)) {
      const marker = `${prefix}:`;
      if (key.startsWith(marker)) {
        const baseKey = key.slice(marker.length);
        if (baseKey && normalized[baseKey] === undefined) normalized[baseKey] = value;
      }
    }
  }
  return normalized;
}

function lifecycleReason(tags: Record<string, string>): string | null {
  for (const prefix of lifecyclePrefixes) {
    const match = Object.entries(tags).find(([key]) => key.startsWith(`${prefix}:`));
    if (match) return `${match[0]}=${match[1]}`;
  }
  return null;
}

function isSpeedCamera(tags: Record<string, string>): boolean {
  return (
    tags.highway === "speed_camera" ||
    tags["speed_camera"] === "yes" ||
    tags["camera:type"] === "speed"
  );
}

function isRedLightCamera(tags: Record<string, string>): boolean {
  return tags.traffic_signals?.trim().toLowerCase() === "red_light_camera";
}

function alertTypeFromTags(tags: Record<string, string>): RoadAlert["type"] | null {
  if (isRedLightCamera(tags)) return "redLightCamera";
  return enforcementAlertType(tags.enforcement);
}

function enforcementAlertType(value: string | undefined): RoadAlert["type"] | null {
  if (!value) return null;
  switch (value.trim().toLowerCase()) {
    case "maxspeed":
    case "average_speed":
      return "fixedSpeedCamera";
    case "traffic_signals":
      return "redLightCamera";
    case "access":
      return "accessControl";
    case "maxweight":
    case "weigh_station":
      return "weightControl";
    default:
      return "genericEnforcement";
  }
}

function isRoadWorks(tags: Record<string, string>): boolean {
  if (tags.highway === "construction" || tags.highway === "roadworks") return true;
  if (["yes", "true", "1"].includes(tags.roadworks?.toLowerCase() ?? "")) return true;
  return Boolean(tags.highway && tags.construction && isRoadHighway(tags.highway));
}

function isRoadHighway(value: string): boolean {
  return ![
    "construction", "roadworks", "speed_camera", "street_lamp", "bus_stop",
    "crossing", "traffic_signals", "give_way", "stop", "elevator",
  ].includes(value);
}

function isRoadHazard(tags: Record<string, string>): boolean {
  return Boolean(tags.hazard) || Boolean(tags["hazard:conditional"]) || tags.highway === "hazard";
}

function parseDirection(value: string | undefined): Direction {
  if (!value) return "unknown";
  const values = value.toLowerCase().split(";").map((item) => item.trim());
  if (values.length === 1 && (values[0] === "forward" || values[0] === "backward")) {
    return values[0];
  }
  return "unknown";
}

function parseBearing(tags: Record<string, string>): number | null {
  return parseBearings(tags)[0] ?? null;
}

function parseBearings(tags: Record<string, string>): number[] {
  const raw = tags.bearing ?? tags["camera:direction"] ?? tags.direction;
  if (!raw) return [];
  const bearings = raw
    .split(";")
    .map((item) => normalizeCourse(Number(item.trim())))
    .filter((item): item is number => item !== null);
  return [...new Set(bearings)];
}

function deterministicUuid(value: string): string {
  const hash = createHash("sha1").update(value).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function dedupe(alerts: RoadAlert[]): RoadAlert[] {
  // Lossless policy: only collapse records with the exact same deterministic ID.
  // Geographically close OSM objects are intentionally preserved because they may
  // represent separate devices, opposite directions, or incomplete mapper data.
  const byIdentity = new Map<string, RoadAlert>();
  for (const alert of alerts) {
    const existing = byIdentity.get(alert.id);
    if (!existing || alert.confidence >= existing.confidence) byIdentity.set(alert.id, alert);
  }
  return [...byIdentity.values()];
}

function calculateOsmConfidence(
  tags: Record<string, string>,
  input: {
    hasRoad: boolean;
    hasBearing: boolean;
    relation: boolean;
    attributes: Record<string, string>;
    base?: number;
  },
): number {
  let confidence = input.base ?? 0.72;
  if (input.relation) confidence += 0.12;
  if (input.hasRoad) confidence += 0.08;
  if (input.hasBearing) confidence += 0.08;
  if (
    parseMaxspeed(tags.maxspeed ?? tags["maxspeed:forward"] ?? tags["maxspeed:backward"]).value !==
    null
  )
    confidence += 0.05;
  const version = Number(input.attributes.version);
  if (Number.isFinite(version) && version > 1) confidence += Math.min(0.05, version * 0.005);
  const timestamp = parseOsmDate(input.attributes.timestamp);
  if (timestamp) {
    const ageYears = (Date.now() - timestamp.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
    if (ageYears > 8) confidence -= 0.12;
    else if (ageYears > 4) confidence -= 0.06;
  }
  if (isApproximatePosition(tags)) confidence -= 0.25;
  else if (tags.fixme) confidence -= 0.12;
  return Math.max(0, Math.min(1, Number(confidence.toFixed(3))));
}

function isNegativeFixme(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return [
    "no trace",
    "not found",
    "does not exist",
    "probably removed",
    "remove this",
    "removed",
  ].some((term) => normalized.includes(term));
}

function isApproximateFixme(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return [
    "approx position", "approximate", "position uncertain", "uncertain position",
    "fix position", "esatta posizione", "corretta posizione", "giusta posizione", "ricalcolare",
  ].some((term) => normalized.includes(term));
}

function isApproximatePosition(tags: Record<string, string>): boolean {
  return [tags.fixme, tags.note, tags.description].some((value) => isApproximateFixme(value));
}

function operationalStatusFromTags(tags: Record<string, string>): "operational" | "notOperational" | "unknown" {
  const negativeValues = new Set(["no", "false", "0", "disabled", "inactive", "not_working"]);
  const positiveValues = new Set(["yes", "true", "1", "active", "working"]);
  const working = tags.working?.trim().toLowerCase();
  const disabled = tags.disabled?.trim().toLowerCase();
  const operational = tags.operational?.trim().toLowerCase();
  const status = tags.status?.trim().toLowerCase();
  const disused = tags.disused?.trim().toLowerCase();
  const removed = tags.removed?.trim().toLowerCase();
  const abandoned = tags.abandoned?.trim().toLowerCase();

  if (lifecycleReason(tags)) return "notOperational";
  if (isNegativeFixme(tags.fixme)) return "notOperational";
  if (working && negativeValues.has(working)) return "notOperational";
  if (disabled && positiveValues.has(disabled)) return "notOperational";
  if (operational && negativeValues.has(operational)) return "notOperational";
  if (status && ["removed", "inactive", "disabled", "not_operational", "not operational"].includes(status)) return "notOperational";
  if (disused && positiveValues.has(disused)) return "notOperational";
  if (removed && positiveValues.has(removed)) return "notOperational";
  if (abandoned && positiveValues.has(abandoned)) return "notOperational";
  if (working && positiveValues.has(working)) return "operational";
  if (disabled && negativeValues.has(disabled)) return "operational";
  if (operational && positiveValues.has(operational)) return "operational";
  return "unknown";
}

function operationalStatusReason(tags: Record<string, string>): string | null {
  const lifecycle = lifecycleReason(tags);
  if (lifecycle) return lifecycle;
  if (tags.fixme) return tags.fixme;
  for (const key of ["working", "disabled", "operational", "status", "disused", "removed", "abandoned"] as const) {
    if (tags[key] !== undefined) return `${key}=${tags[key]}`;
  }
  return null;
}

function parseInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseOsmDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
