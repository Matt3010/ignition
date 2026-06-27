import type pg from "pg";
import type { RoadAlert } from "../../domain/models/alert.js";
import type { OsmBounds } from "../osm/osm-alert-parser.js";
import { alertParameters, alertStagingValuePlaceholder, lastAlertById } from "./postgis-alert-sql.js";

type QueryExecutor = Pick<pg.Pool | pg.PoolClient, "query">;
const IMPORT_BATCH_SIZE = 500;

export interface AlertImportBatch {
  alerts: RoadAlert[];
  bounds: OsmBounds | null;
  elementsScanned: number;
}

export class PostgisAlertImportRepository {
  constructor(private readonly pool: pg.Pool) {}

  async syncManyViaStaging(input: {
    alerts: RoadAlert[];
    source: string;
    bounds: OsmBounds | null;
    deactivateMissing: boolean;
    minRetainRatio?: number;
    minExistingForRatioCheck?: number;
  }): Promise<{ upserted: number; deactivated: number }> {
    const result = await this.syncAlertBatchesViaStaging({
      batches: (async function* () {
        yield {
          alerts: input.alerts,
          bounds: input.bounds,
          elementsScanned: 0,
        };
      })(),
      source: input.source,
      deactivateMissing: input.deactivateMissing,
      minRetainRatio: input.minRetainRatio,
      minExistingForRatioCheck: input.minExistingForRatioCheck,
    });
    return { upserted: input.alerts.length, deactivated: result.deactivated };
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
      await createAlertStagingTable(client);

      let bounds: OsmBounds | null = null;
      let elementsScanned = 0;
      for await (const batch of input.batches) {
        bounds = mergeOsmBounds(bounds, batch.bounds);
        elementsScanned += batch.elementsScanned;
        await insertAlertStagingRows(client, batch.alerts);
      }

      const importedCount = await countAlertStagingRows(client);
      if (input.deactivateMissing && bounds) {
        const existingCount = await countActiveInBoundsWith(client, input.source, bounds);
        assertSafeImportSize({
          incomingCount: importedCount,
          existingCount,
          minRetainRatio: input.minRetainRatio ?? 0,
          minExistingForRatioCheck: input.minExistingForRatioCheck ?? Number.MAX_SAFE_INTEGER,
        });
      }

      await upsertFromAlertStaging(client);
      const deactivated = input.deactivateMissing && bounds
        ? await deactivateMissingInBoundsFromStagingWith(client, {
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
}

async function createAlertStagingTable(executor: QueryExecutor): Promise<void> {
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

async function insertAlertStagingRows(executor: QueryExecutor, alerts: RoadAlert[]): Promise<void> {
  const uniqueAlerts = lastAlertById(alerts);
  for (let index = 0; index < uniqueAlerts.length; index += IMPORT_BATCH_SIZE) {
    const batch = uniqueAlerts.slice(index, index + IMPORT_BATCH_SIZE);
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

async function countAlertStagingRows(executor: QueryExecutor): Promise<number> {
  const result = await executor.query("select count(*)::int as count from road_alerts_import_staging");
  return Number(result.rows[0]?.count ?? 0);
}

async function upsertFromAlertStaging(executor: QueryExecutor): Promise<void> {
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

async function countActiveInBoundsWith(
  executor: QueryExecutor,
  source: string,
  bounds: OsmBounds,
): Promise<number> {
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

function assertSafeImportSize(input: {
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

async function deactivateMissingInBoundsFromStagingWith(
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
