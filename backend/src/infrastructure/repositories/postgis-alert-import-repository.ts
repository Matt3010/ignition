import type pg from "pg";
import type { RoadAlert } from "../../domain/models/alert.js";
import type { OsmBounds } from "../osm/osm-alert-parser.js";
import { assertSafeImportSize, countActiveAlertsInBounds, mergeOsmBounds } from "./postgis-alert-import-safety.js";
import {
  ROAD_ALERT_INSERT_COLUMNS,
  ROAD_ALERT_SELECT_FROM_STAGING,
  ROAD_ALERT_STAGING_COLUMNS,
  ROAD_ALERT_STAGING_UPSERT_SET,
  ROAD_ALERT_UPSERT_SET,
  alertParameters,
  alertStagingValuePlaceholder,
  lastAlertById,
} from "./postgis-alert-sql.js";

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
        const existingCount = await countActiveAlertsInBounds(client, input.source, bounds);
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
        ${ROAD_ALERT_STAGING_COLUMNS}
      ) values
        ${valuesSql}
      on conflict (id) do update set
        ${ROAD_ALERT_STAGING_UPSERT_SET}
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
      ${ROAD_ALERT_INSERT_COLUMNS}
    )
    select
      ${ROAD_ALERT_SELECT_FROM_STAGING}
    from road_alerts_import_staging
    on conflict (id) do update set
      ${ROAD_ALERT_UPSERT_SET}
  `);
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
