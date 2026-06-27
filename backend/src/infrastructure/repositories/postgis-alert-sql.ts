import type { RoadAlert } from "../../domain/models/alert.js";

export const ALERT_SQL_PARAM_COUNT = 33;

export const ROAD_ALERT_INSERT_COLUMNS = `
  id, type, subtype, capabilities, primary_capability, latitude, longitude, geometry, speed_limit_kmh, speed_limit_source,
  direction, bearing, road_id, confidence, active, valid_from, valid_until,
  source, osm_type, osm_id, osm_relation_id, osm_version, osm_timestamp,
  osm_changeset, osm_user, osm_uid, source_tags, fixme, position_approximate,
  operational_status, status_reason, direction_bearings, osm_presence_status,
  original_osm_ids, created_at, updated_at
`;

export const ROAD_ALERT_STAGING_COLUMNS = `
  id, type, subtype, capabilities, primary_capability, latitude, longitude, speed_limit_kmh, speed_limit_source,
  direction, bearing, road_id, confidence, active, valid_from, valid_until,
  source, osm_type, osm_id, osm_relation_id, osm_version, osm_timestamp,
  osm_changeset, osm_user, osm_uid, source_tags, fixme, position_approximate,
  operational_status, status_reason, direction_bearings, osm_presence_status,
  original_osm_ids
`;

export const ROAD_ALERT_SELECT_FROM_STAGING = `
  id, type, subtype, capabilities, primary_capability, latitude, longitude,
  ST_SetSRID(ST_MakePoint(longitude, latitude), 4326), speed_limit_kmh, speed_limit_source,
  direction, bearing, road_id, confidence, active, valid_from, valid_until,
  source, osm_type, osm_id, osm_relation_id, osm_version, osm_timestamp,
  osm_changeset, osm_user, osm_uid, source_tags, fixme, position_approximate,
  operational_status, status_reason, direction_bearings, osm_presence_status,
  original_osm_ids, now(), now()
`;

export const ROAD_ALERT_UPSERT_SET = `
  type = excluded.type,
  subtype = excluded.subtype,
  capabilities = excluded.capabilities,
  primary_capability = excluded.primary_capability,
  latitude = excluded.latitude,
  longitude = excluded.longitude,
  geometry = excluded.geometry,
  speed_limit_kmh = excluded.speed_limit_kmh,
  speed_limit_source = excluded.speed_limit_source,
  direction = excluded.direction,
  bearing = excluded.bearing,
  road_id = excluded.road_id,
  confidence = excluded.confidence,
  active = excluded.active,
  valid_from = excluded.valid_from,
  valid_until = excluded.valid_until,
  source = excluded.source,
  osm_type = excluded.osm_type,
  osm_id = excluded.osm_id,
  osm_relation_id = excluded.osm_relation_id,
  osm_version = excluded.osm_version,
  osm_timestamp = excluded.osm_timestamp,
  osm_changeset = excluded.osm_changeset,
  osm_user = excluded.osm_user,
  osm_uid = excluded.osm_uid,
  source_tags = excluded.source_tags,
  fixme = excluded.fixme,
  position_approximate = excluded.position_approximate,
  operational_status = excluded.operational_status,
  status_reason = excluded.status_reason,
  direction_bearings = excluded.direction_bearings,
  osm_presence_status = excluded.osm_presence_status,
  original_osm_ids = excluded.original_osm_ids,
  updated_at = now()
`;

export const ROAD_ALERT_STAGING_UPSERT_SET = `
  type = excluded.type,
  subtype = excluded.subtype,
  capabilities = excluded.capabilities,
  primary_capability = excluded.primary_capability,
  latitude = excluded.latitude,
  longitude = excluded.longitude,
  speed_limit_kmh = excluded.speed_limit_kmh,
  speed_limit_source = excluded.speed_limit_source,
  direction = excluded.direction,
  bearing = excluded.bearing,
  road_id = excluded.road_id,
  confidence = excluded.confidence,
  active = excluded.active,
  valid_from = excluded.valid_from,
  valid_until = excluded.valid_until,
  source = excluded.source,
  osm_type = excluded.osm_type,
  osm_id = excluded.osm_id,
  osm_relation_id = excluded.osm_relation_id,
  osm_version = excluded.osm_version,
  osm_timestamp = excluded.osm_timestamp,
  osm_changeset = excluded.osm_changeset,
  osm_user = excluded.osm_user,
  osm_uid = excluded.osm_uid,
  source_tags = excluded.source_tags,
  fixme = excluded.fixme,
  position_approximate = excluded.position_approximate,
  operational_status = excluded.operational_status,
  status_reason = excluded.status_reason,
  direction_bearings = excluded.direction_bearings,
  osm_presence_status = excluded.osm_presence_status,
  original_osm_ids = excluded.original_osm_ids
`;

export function roadAlertValuePlaceholder(batchIndex: number): string {
  const parameter = alertParameterAt(batchIndex);
  return `(
    ${parameter(1)}, ${parameter(2)}, ${parameter(3)}, ${parameter(4)}::text[], ${parameter(5)},
    ${parameter(6)}, ${parameter(7)}, ST_SetSRID(ST_MakePoint(${parameter(7)}, ${parameter(6)}), 4326),
    ${parameter(8)}, ${parameter(9)}, ${parameter(10)}, ${parameter(11)}, ${parameter(12)},
    ${parameter(13)}, ${parameter(14)}, ${parameter(15)}, ${parameter(16)}, ${parameter(17)},
    ${parameter(18)}, ${parameter(19)}, ${parameter(20)}, ${parameter(21)}, ${parameter(22)},
    ${parameter(23)}, ${parameter(24)}, ${parameter(25)}, ${parameter(26)}::jsonb, ${parameter(27)},
    ${parameter(28)}, ${parameter(29)}, ${parameter(30)}, ${parameter(31)}::double precision[],
    ${parameter(32)}, ${parameter(33)}::text[], now(), now()
  )`;
}

export function alertStagingValuePlaceholder(batchIndex: number): string {
  const parameter = alertParameterAt(batchIndex);
  return `(
    ${parameter(1)}, ${parameter(2)}, ${parameter(3)}, ${parameter(4)}::text[], ${parameter(5)},
    ${parameter(6)}, ${parameter(7)}, ${parameter(8)}, ${parameter(9)}, ${parameter(10)},
    ${parameter(11)}, ${parameter(12)}, ${parameter(13)}, ${parameter(14)}, ${parameter(15)},
    ${parameter(16)}, ${parameter(17)}, ${parameter(18)}, ${parameter(19)}, ${parameter(20)},
    ${parameter(21)}, ${parameter(22)}, ${parameter(23)}, ${parameter(24)}, ${parameter(25)},
    ${parameter(26)}::jsonb, ${parameter(27)}, ${parameter(28)}, ${parameter(29)}, ${parameter(30)},
    ${parameter(31)}::double precision[], ${parameter(32)}, ${parameter(33)}::text[]
  )`;
}

export function lastAlertById(alerts: RoadAlert[]): RoadAlert[] {
  const byId = new Map<string, RoadAlert>();
  for (const alert of alerts) byId.set(alert.id, alert);
  return [...byId.values()];
}

export function alertParameters(alert: RoadAlert): unknown[] {
  return [
    alert.id,
    alert.type,
    alert.subtype ?? null,
    alert.capabilities ?? [],
    alert.primaryCapability ?? null,
    alert.latitude,
    alert.longitude,
    alert.speedLimitKmh,
    alert.speedLimitSource,
    alert.direction,
    alert.bearing,
    alert.roadId,
    alert.confidence,
    alert.active,
    alert.validFrom,
    alert.validUntil,
    alert.source,
    alert.osmType ?? null,
    alert.osmId ?? null,
    alert.osmRelationId ?? null,
    alert.osmVersion ?? null,
    alert.osmTimestamp ?? null,
    alert.osmChangeset ?? null,
    alert.osmUser ?? null,
    alert.osmUid ?? null,
    JSON.stringify(alert.sourceTags ?? {}),
    alert.fixme ?? null,
    alert.positionApproximate ?? false,
    alert.operationalStatus ?? "unknown",
    alert.statusReason ?? alert.fixme ?? null,
    alert.directionBearings ?? [],
    alert.osmPresenceStatus ?? "present",
    alert.originalOsmIds ?? [],
  ];
}

function alertParameterAt(batchIndex: number): (position: number) => string {
  const offset = batchIndex * ALERT_SQL_PARAM_COUNT;
  return (position: number) => `$${offset + position}`;
}
