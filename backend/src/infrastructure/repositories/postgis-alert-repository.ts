import type pg from "pg";
import type { AlertCandidate, RoadAlert } from "../../domain/models/alert.js";
import type { AlertRepository } from "../../application/ports/alert-repository.js";

export class PostgisAlertRepository implements AlertRepository {
  constructor(private readonly pool: pg.Pool) {}

  async findNearby(input: {
    latitude: number;
    longitude: number;
    radiusMeters: number;
    now: Date;
  }): Promise<AlertCandidate[]> {
    const result = await this.pool.query(
      `
      select
        id::text,
        type,
        latitude,
        longitude,
        speed_limit_kmh,
        speed_limit_source,
        direction,
        bearing,
        road_id,
        confidence,
        active,
        valid_from,
        valid_until,
        source,
        osm_type,
        osm_id,
        osm_relation_id,
        source_tags,
        fixme,
        position_approximate,
        operational_status,
        status_reason,
        original_osm_ids,
        ST_DistanceSphere(geometry, ST_SetSRID(ST_MakePoint($1, $2), 4326)) as distance_meters
      from road_alerts
      where ST_DWithin(
          geometry::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
          $3
        )
      order by distance_meters asc
      limit 1000
      `,
      [input.longitude, input.latitude, input.radiusMeters, input.now],
    );
    return result.rows.map((row) => ({
      id: row.id,
      type: row.type,
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      speedLimitKmh: row.speed_limit_kmh === null ? null : Number(row.speed_limit_kmh),
      speedLimitSource: row.speed_limit_source,
      direction: row.direction,
      bearing: row.bearing === null ? null : Number(row.bearing),
      roadId: row.road_id,
      confidence: Number(row.confidence),
      active: row.active,
      validFrom: row.valid_from,
      validUntil: row.valid_until,
      source: row.source,
      osmType: row.osm_type,
      osmId: row.osm_id,
      osmRelationId: row.osm_relation_id,
      sourceTags: row.source_tags,
      fixme: row.fixme,
      positionApproximate: row.position_approximate,
      operationalStatus: row.operational_status,
      statusReason: row.status_reason,
      originalOsmIds: row.original_osm_ids ?? [],
      distanceMeters: Number(row.distance_meters),
    }));
  }

  async upsertMany(alerts: RoadAlert[]): Promise<number> {
    if (!alerts.length) return 0;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      for (const alert of alerts) {
        await client.query(
          `
          insert into road_alerts (
            id, type, latitude, longitude, geometry, speed_limit_kmh, speed_limit_source, direction, bearing,
            road_id, confidence, active, valid_from, valid_until, source, osm_type, osm_id, osm_relation_id, source_tags, fixme, position_approximate, operational_status, status_reason, original_osm_ids, created_at, updated_at
          )
          values (
            $1, $2, $3, $4, ST_SetSRID(ST_MakePoint($4, $3), 4326), $5, $6, $7, $8,
            $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19, $20, $21, $22, $23::text[], now(), now()
          )
          on conflict (id) do update set
            type = excluded.type,
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
            source_tags = excluded.source_tags,
            fixme = excluded.fixme,
            position_approximate = excluded.position_approximate,
            operational_status = excluded.operational_status,
            status_reason = excluded.status_reason,
            original_osm_ids = excluded.original_osm_ids,
            updated_at = now()
          `,
          [
            alert.id,
            alert.type,
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
            JSON.stringify(alert.sourceTags ?? {}),
            alert.fixme ?? null,
            alert.positionApproximate ?? false,
            alert.operationalStatus ?? "unknown",
            alert.statusReason ?? alert.fixme ?? null,
            alert.originalOsmIds ?? [],
          ],
        );
      }
      await client.query("commit");
      return alerts.length;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async deactivateMissingInBounds(input: {
    source: string;
    activeIds: string[];
    bounds: {
      minLatitude: number;
      minLongitude: number;
      maxLatitude: number;
      maxLongitude: number;
    };
  }): Promise<number> {
    const result = await this.pool.query(
      `
      update road_alerts
      set active = false, updated_at = now()
      where source = $1
        and active = true
        and id <> all($2::uuid[])
        and ST_Covers(
          ST_MakeEnvelope($3, $4, $5, $6, 4326),
          geometry
        )
      `,
      [
        input.source,
        input.activeIds,
        input.bounds.minLongitude,
        input.bounds.minLatitude,
        input.bounds.maxLongitude,
        input.bounds.maxLatitude,
      ],
    );
    return result.rowCount ?? 0;
  }

  async health(): Promise<"up" | "down"> {
    try {
      await this.pool.query("select 1 from road_alerts limit 1");
      return "up";
    } catch {
      return "down";
    }
  }
}
