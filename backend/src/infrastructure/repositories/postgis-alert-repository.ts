import type pg from "pg";
import type { AlertCandidate, RoadAlert } from "../../domain/models/alert.js";
import type { AlertDatasetStatus, AlertRepository } from "../../application/ports/alert-repository.js";
import type { OsmBounds } from "../osm/osm-alert-parser.js";

type QueryExecutor = Pick<pg.Pool | pg.PoolClient, "query">;
const UPSERT_BATCH_SIZE = 500;
const ALERT_UPSERT_PARAM_COUNT = 33;

interface AlertImportBatch {
  alerts: RoadAlert[];
  bounds: OsmBounds | null;
  elementsScanned: number;
}

export class PostgisAlertRepository implements AlertRepository {
  constructor(private readonly pool: pg.Pool) {}

  async findNearby(input: { latitude: number; longitude: number; radiusMeters: number }): Promise<AlertCandidate[]> {
    const result = await this.pool.query(
      `
      select
        id::text, type, subtype, capabilities, primary_capability, latitude, longitude, speed_limit_kmh, speed_limit_source,
        direction, bearing, road_id, confidence, active, valid_from, valid_until,
        source, osm_type, osm_id, osm_relation_id, osm_version, osm_timestamp,
        osm_changeset, osm_user, osm_uid, source_tags, fixme, position_approximate,
        operational_status, status_reason, direction_bearings, osm_presence_status,
        original_osm_ids, created_at, updated_at,
        ST_DistanceSphere(geometry, ST_SetSRID(ST_MakePoint($1, $2), 4326)) as distance_meters
      from road_alerts
      where active = true
        and osm_presence_status = 'present'
        and (valid_from is null or valid_from <= now())
        and (valid_until is null or valid_until >= now())
        and ST_DWithin(
          geometry::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
          $3
        )
      order by distance_meters asc
      `,
      [input.longitude, input.latitude, input.radiusMeters],
    );
    return result.rows.map((row) => ({
      id: row.id,
      type: row.type,
      subtype: row.subtype,
      capabilities: row.capabilities ?? [],
      primaryCapability: row.primary_capability,
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
      osmVersion: row.osm_version === null ? null : Number(row.osm_version),
      osmTimestamp: row.osm_timestamp ? new Date(row.osm_timestamp) : null,
      osmChangeset: row.osm_changeset,
      osmUser: row.osm_user,
      osmUid: row.osm_uid,
      sourceTags: row.source_tags,
      fixme: row.fixme,
      positionApproximate: row.position_approximate,
      operationalStatus: row.operational_status,
      statusReason: row.status_reason,
      directionBearings: row.direction_bearings ?? [],
      osmPresenceStatus: row.osm_presence_status ?? "present",
      originalOsmIds: row.original_osm_ids ?? [],
      createdAt: row.created_at ? new Date(row.created_at) : undefined,
      updatedAt: row.updated_at ? new Date(row.updated_at) : undefined,
      distanceMeters: Number(row.distance_meters),
    }));
  }

  async hasAvailableAlerts(): Promise<boolean> {
    const result = await this.pool.query(
      `
      select exists(
        select 1
        from road_alerts
        where active = true
          and osm_presence_status = 'present'
          and (valid_from is null or valid_from <= now())
          and (valid_until is null or valid_until >= now())
      ) as available
      `,
    );
    return result.rows[0]?.available === true;
  }

  async getDatasetStatus(): Promise<AlertDatasetStatus> {
    const result = await this.pool.query(
      `
      with active_alerts as (
        select count(*)::int as count
        from road_alerts
        where active = true
          and osm_presence_status = 'present'
          and (valid_from is null or valid_from <= now())
          and (valid_until is null or valid_until >= now())
      ), latest_import as (
        select status, records_count
        from data_imports
        where source = 'osm'
        order by imported_at desc, id desc
        limit 1
      )
      select
        active_alerts.count as active_count,
        latest_import.status as import_status,
        latest_import.records_count as imported_records
      from active_alerts
      left join latest_import on true
      `,
    );
    const row = result.rows[0];
    const activeCount = Number(row?.active_count ?? 0);
    if (activeCount > 0) return "available";
    if (row?.import_status === "success" && Number(row?.imported_records ?? -1) === 0) return "empty";
    return "unavailable";
  }

  async upsertMany(alerts: RoadAlert[]): Promise<number> {
    if (!alerts.length) return 0;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const count = await this.upsertManyWith(client, alerts);
      await client.query("commit");
      return count;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async syncMany(input: {
    alerts: RoadAlert[];
    source: string;
    bounds: OsmBounds | null;
    deactivateMissing: boolean;
    minRetainRatio?: number;
    minExistingForRatioCheck?: number;
  }): Promise<{ upserted: number; deactivated: number }> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      if (input.deactivateMissing && input.bounds) {
        const existingCount = await this.countActiveInBoundsWith(client, input.source, input.bounds);
        this.assertSafeImportSize({
          incomingCount: input.alerts.length,
          existingCount,
          minRetainRatio: input.minRetainRatio ?? 0,
          minExistingForRatioCheck: input.minExistingForRatioCheck ?? Number.MAX_SAFE_INTEGER,
        });
      }
      const upserted = await this.upsertManyWith(client, input.alerts);
      const deactivated = input.deactivateMissing && input.bounds
        ? await this.deactivateMissingInBoundsWith(client, {
            source: input.source,
            activeIds: input.alerts.map((alert) => alert.id),
            bounds: input.bounds,
          })
        : 0;
      await client.query("commit");
      return { upserted, deactivated };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async syncManyViaStaging(input: {
    alerts: RoadAlert[];
    source: string;
    bounds: OsmBounds | null;
    deactivateMissing: boolean;
    minRetainRatio?: number;
    minExistingForRatioCheck?: number;
  }): Promise<{ upserted: number; deactivated: number }> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const uniqueAlerts = lastAlertById(input.alerts);
      await this.createAlertStagingTable(client);
      await this.insertAlertStagingRows(client, uniqueAlerts);
      if (input.deactivateMissing && input.bounds) {
        const existingCount = await this.countActiveInBoundsWith(client, input.source, input.bounds);
        this.assertSafeImportSize({
          incomingCount: input.alerts.length,
          existingCount,
          minRetainRatio: input.minRetainRatio ?? 0,
          minExistingForRatioCheck: input.minExistingForRatioCheck ?? Number.MAX_SAFE_INTEGER,
        });
      }
      await this.upsertFromAlertStaging(client);
      const deactivated = input.deactivateMissing && input.bounds
        ? await this.deactivateMissingInBoundsFromStagingWith(client, {
            source: input.source,
            bounds: input.bounds,
          })
        : 0;
      await client.query("commit");
      return { upserted: input.alerts.length, deactivated };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async syncAlertBatchesViaStaging(input: {
    batches: AsyncIterable<AlertImportBatch>;
    source: string;
    deactivateMissing: boolean;
    minRetainRatio?: number;
    minExistingForRatioCheck?: number;
  }): Promise<{
    upserted: number;
    deactivated: number;
    bounds: OsmBounds | null;
    elementsScanned: number;
  }> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await this.createAlertStagingTable(client);

      let bounds: OsmBounds | null = null;
      let elementsScanned = 0;
      for await (const batch of input.batches) {
        bounds = mergeOsmBounds(bounds, batch.bounds);
        elementsScanned += batch.elementsScanned;
        await this.insertAlertStagingRows(client, batch.alerts);
      }

      const importedCount = await this.countAlertStagingRows(client);
      if (input.deactivateMissing && bounds) {
        const existingCount = await this.countActiveInBoundsWith(client, input.source, bounds);
        this.assertSafeImportSize({
          incomingCount: importedCount,
          existingCount,
          minRetainRatio: input.minRetainRatio ?? 0,
          minExistingForRatioCheck: input.minExistingForRatioCheck ?? Number.MAX_SAFE_INTEGER,
        });
      }

      await this.upsertFromAlertStaging(client);
      const deactivated = input.deactivateMissing && bounds
        ? await this.deactivateMissingInBoundsFromStagingWith(client, {
            source: input.source,
            bounds,
          })
        : 0;
      await client.query("commit");
      return { upserted: importedCount, deactivated, bounds, elementsScanned };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async deactivateMissingInBounds(input: { source: string; activeIds: string[]; bounds: OsmBounds }): Promise<number> {
    return this.deactivateMissingInBoundsWith(this.pool, input);
  }

  async health(): Promise<"up" | "down"> {
    try {
      await this.pool.query("select 1 from road_alerts limit 1");
      return "up";
    } catch {
      return "down";
    }
  }

  private async upsertManyWith(executor: QueryExecutor, alerts: RoadAlert[]): Promise<number> {
    const uniqueAlerts = lastAlertById(alerts);
    for (let index = 0; index < uniqueAlerts.length; index += UPSERT_BATCH_SIZE) {
      const batch = uniqueAlerts.slice(index, index + UPSERT_BATCH_SIZE);
      const valuesSql = batch.map((_, batchIndex) => alertValuePlaceholder(batchIndex)).join(",\n");
      const parameters = batch.flatMap((alert) => alertParameters(alert));
      await executor.query(
        `
        insert into road_alerts (
          id, type, subtype, capabilities, primary_capability, latitude, longitude, geometry, speed_limit_kmh, speed_limit_source,
          direction, bearing, road_id, confidence, active, valid_from, valid_until,
          source, osm_type, osm_id, osm_relation_id, osm_version, osm_timestamp,
          osm_changeset, osm_user, osm_uid, source_tags, fixme, position_approximate,
          operational_status, status_reason, direction_bearings, osm_presence_status,
          original_osm_ids, created_at, updated_at
        ) values
          ${valuesSql}
        on conflict (id) do update set
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
        `,
        parameters,
      );
    }
    return alerts.length;
  }

  private async createAlertStagingTable(executor: QueryExecutor): Promise<void> {
    await executor.query(`
      create temporary table road_alerts_import_staging (
        id uuid primary key,
        type text not null,
        subtype text null,
        capabilities text[] not null,
        primary_capability text null,
        latitude double precision not null,
        longitude double precision not null,
        speed_limit_kmh integer null,
        speed_limit_source text not null,
        direction text null,
        bearing double precision null,
        road_id text null,
        confidence double precision not null,
        active boolean not null,
        valid_from timestamptz null,
        valid_until timestamptz null,
        source text not null,
        osm_type text null,
        osm_id text null,
        osm_relation_id text null,
        osm_version integer null,
        osm_timestamp timestamptz null,
        osm_changeset text null,
        osm_user text null,
        osm_uid text null,
        source_tags jsonb null,
        fixme text null,
        position_approximate boolean not null,
        operational_status text not null,
        status_reason text null,
        direction_bearings double precision[] not null,
        osm_presence_status text not null,
        original_osm_ids text[] not null
      ) on commit drop
    `);
  }

  private async insertAlertStagingRows(executor: QueryExecutor, alerts: RoadAlert[]): Promise<void> {
    const uniqueAlerts = lastAlertById(alerts);
    for (let index = 0; index < uniqueAlerts.length; index += UPSERT_BATCH_SIZE) {
      const batch = uniqueAlerts.slice(index, index + UPSERT_BATCH_SIZE);
      const valuesSql = batch.map((_, batchIndex) => alertStagingValuePlaceholder(batchIndex)).join(",\n");
      const parameters = batch.flatMap((alert) => alertParameters(alert));
      await executor.query(
        `
        insert into road_alerts_import_staging (
          id, type, subtype, capabilities, primary_capability, latitude, longitude, speed_limit_kmh, speed_limit_source,
          direction, bearing, road_id, confidence, active, valid_from, valid_until,
          source, osm_type, osm_id, osm_relation_id, osm_version, osm_timestamp,
          osm_changeset, osm_user, osm_uid, source_tags, fixme, position_approximate,
          operational_status, status_reason, direction_bearings, osm_presence_status,
          original_osm_ids
        ) values
          ${valuesSql}
        on conflict (id) do update set
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
        `,
        parameters,
      );
    }
  }

  private async countAlertStagingRows(executor: QueryExecutor): Promise<number> {
    const result = await executor.query("select count(*)::int as count from road_alerts_import_staging");
    return Number(result.rows[0]?.count ?? 0);
  }

  private async upsertFromAlertStaging(executor: QueryExecutor): Promise<void> {
    await executor.query(`
      insert into road_alerts (
        id, type, subtype, capabilities, primary_capability, latitude, longitude, geometry, speed_limit_kmh, speed_limit_source,
        direction, bearing, road_id, confidence, active, valid_from, valid_until,
        source, osm_type, osm_id, osm_relation_id, osm_version, osm_timestamp,
        osm_changeset, osm_user, osm_uid, source_tags, fixme, position_approximate,
        operational_status, status_reason, direction_bearings, osm_presence_status,
        original_osm_ids, created_at, updated_at
      )
      select
        id, type, subtype, capabilities, primary_capability, latitude, longitude,
        ST_SetSRID(ST_MakePoint(longitude, latitude), 4326), speed_limit_kmh, speed_limit_source,
        direction, bearing, road_id, confidence, active, valid_from, valid_until,
        source, osm_type, osm_id, osm_relation_id, osm_version, osm_timestamp,
        osm_changeset, osm_user, osm_uid, source_tags, fixme, position_approximate,
        operational_status, status_reason, direction_bearings, osm_presence_status,
        original_osm_ids, now(), now()
      from road_alerts_import_staging
      on conflict (id) do update set
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
    `);
  }


  private async countActiveInBoundsWith(executor: QueryExecutor, source: string, bounds: OsmBounds): Promise<number> {
    const result = await executor.query(
      `
      select count(*)::int as count
      from road_alerts
      where source = $1
        and active = true
        and ST_Covers(ST_MakeEnvelope($2, $3, $4, $5, 4326), geometry)
      `,
      [source, bounds.minLongitude, bounds.minLatitude, bounds.maxLongitude, bounds.maxLatitude],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  private assertSafeImportSize(input: {
    incomingCount: number;
    existingCount: number;
    minRetainRatio: number;
    minExistingForRatioCheck: number;
  }): void {
    if (input.existingCount > 0 && input.incomingCount === 0) {
      throw new Error(`Refusing empty OSM import over ${input.existingCount} active alerts`);
    }
    if (input.existingCount < input.minExistingForRatioCheck) return;
    const retainRatio = input.incomingCount / input.existingCount;
    if (retainRatio < input.minRetainRatio) {
      throw new Error(
        `Refusing anomalous OSM import: ${input.incomingCount}/${input.existingCount} alerts ` +
        `(retain ratio ${retainRatio.toFixed(3)}, minimum ${input.minRetainRatio})`,
      );
    }
  }

  private async deactivateMissingInBoundsWith(
    executor: QueryExecutor,
    input: { source: string; activeIds: string[]; bounds: OsmBounds },
  ): Promise<number> {
    const result = await executor.query(
      `
      update road_alerts
      set active = false, osm_presence_status = 'missingFromLatestImport', updated_at = now()
      where source = $1
        and active = true
        and not (id = any($2::uuid[]))
        and ST_Covers(ST_MakeEnvelope($3, $4, $5, $6, 4326), geometry)
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

  private async deactivateMissingInBoundsFromStagingWith(
    executor: QueryExecutor,
    input: { source: string; bounds: OsmBounds },
  ): Promise<number> {
    const result = await executor.query(
      `
      update road_alerts
      set active = false, osm_presence_status = 'missingFromLatestImport', updated_at = now()
      where source = $1
        and active = true
        and not exists (
          select 1
          from road_alerts_import_staging staging
          where staging.id = road_alerts.id
        )
        and ST_Covers(ST_MakeEnvelope($2, $3, $4, $5, 4326), geometry)
      `,
      [
        input.source,
        input.bounds.minLongitude,
        input.bounds.minLatitude,
        input.bounds.maxLongitude,
        input.bounds.maxLatitude,
      ],
    );
    return result.rowCount ?? 0;
  }
}

function alertValuePlaceholder(batchIndex: number): string {
  const offset = batchIndex * ALERT_UPSERT_PARAM_COUNT;
  const parameter = (position: number): string => `$${offset + position}`;
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

function alertStagingValuePlaceholder(batchIndex: number): string {
  const offset = batchIndex * ALERT_UPSERT_PARAM_COUNT;
  const parameter = (position: number): string => `$${offset + position}`;
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

function lastAlertById(alerts: RoadAlert[]): RoadAlert[] {
  const byId = new Map<string, RoadAlert>();
  for (const alert of alerts) byId.set(alert.id, alert);
  return [...byId.values()];
}

function alertParameters(alert: RoadAlert): unknown[] {
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

function mergeOsmBounds(left: OsmBounds | null, right: OsmBounds | null): OsmBounds | null {
  if (!left) return right;
  if (!right) return left;
  return {
    minLatitude: Math.min(left.minLatitude, right.minLatitude),
    minLongitude: Math.min(left.minLongitude, right.minLongitude),
    maxLatitude: Math.max(left.maxLatitude, right.maxLatitude),
    maxLongitude: Math.max(left.maxLongitude, right.maxLongitude),
  };
}
