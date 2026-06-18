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
        direction,
        bearing,
        road_id,
        confidence,
        active,
        valid_from,
        valid_until,
        source,
        ST_DistanceSphere(geometry, ST_SetSRID(ST_MakePoint($1, $2), 4326)) as distance_meters
      from road_alerts
      where active = true
        and (valid_from is null or valid_from <= $4)
        and (valid_until is null or valid_until >= $4)
        and ST_DWithin(
          geometry::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
          $3
        )
      order by distance_meters asc
      limit 50
      `,
      [input.longitude, input.latitude, input.radiusMeters, input.now],
    );
    return result.rows.map((row) => ({
      id: row.id,
      type: row.type,
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      speedLimitKmh: row.speed_limit_kmh === null ? null : Number(row.speed_limit_kmh),
      direction: row.direction,
      bearing: row.bearing === null ? null : Number(row.bearing),
      roadId: row.road_id,
      confidence: Number(row.confidence),
      active: row.active,
      validFrom: row.valid_from,
      validUntil: row.valid_until,
      source: row.source,
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
            id, type, latitude, longitude, geometry, speed_limit_kmh, direction, bearing,
            road_id, confidence, active, valid_from, valid_until, source, created_at, updated_at
          )
          values (
            $1, $2, $3, $4, ST_SetSRID(ST_MakePoint($4, $3), 4326), $5, $6, $7,
            $8, $9, $10, $11, $12, $13, now(), now()
          )
          on conflict (id) do update set
            type = excluded.type,
            latitude = excluded.latitude,
            longitude = excluded.longitude,
            geometry = excluded.geometry,
            speed_limit_kmh = excluded.speed_limit_kmh,
            direction = excluded.direction,
            bearing = excluded.bearing,
            road_id = excluded.road_id,
            confidence = excluded.confidence,
            active = excluded.active,
            valid_from = excluded.valid_from,
            valid_until = excluded.valid_until,
            source = excluded.source,
            updated_at = now()
          `,
          [
            alert.id,
            alert.type,
            alert.latitude,
            alert.longitude,
            alert.speedLimitKmh,
            alert.direction,
            alert.bearing,
            alert.roadId,
            alert.confidence,
            alert.active,
            alert.validFrom,
            alert.validUntil,
            alert.source,
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
