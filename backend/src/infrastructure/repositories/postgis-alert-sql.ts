import type { RoadAlert } from "../../domain/models/alert.js";

export const ALERT_SQL_PARAM_COUNT = 33;

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
