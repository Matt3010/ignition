import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { RoadAlert } from "../../src/domain/models/alert.js";
import { PostgisAlertImportRepository } from "../../src/infrastructure/repositories/postgis-alert-import-repository.js";
import { PostgisAlertRepository } from "../../src/infrastructure/repositories/postgis-alert-repository.js";

describe("PostgisAlertRepository batching", () => {
  it("upserts alerts in multi-row batches", async () => {
    const queries: Array<{ sql: string; parameters?: unknown[] }> = [];
    const client = {
      query: async (sql: string, parameters?: unknown[]) => {
        queries.push({ sql, parameters });
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };
    const pool = {
      connect: async () => client,
    } as unknown as pg.Pool;
    const repository = new PostgisAlertRepository(pool);

    await expect(repository.upsertMany(makeAlerts(501))).resolves.toBe(501);

    const insertQueries = queries.filter((query) => query.sql.includes("insert into road_alerts"));
    expect(insertQueries).toHaveLength(2);
    expect(insertQueries[0].parameters).toHaveLength(500 * 33);
    expect(insertQueries[1].parameters).toHaveLength(33);
    expect(queries.map((query) => query.sql.trim())).toEqual([
      "begin",
      expect.stringContaining("insert into road_alerts"),
      expect.stringContaining("insert into road_alerts"),
      "commit",
    ]);
  });

  it("keeps last-write-wins behavior for duplicate alert ids inside a batch", async () => {
    const queries: Array<{ sql: string; parameters?: unknown[] }> = [];
    const client = {
      query: async (sql: string, parameters?: unknown[]) => {
        queries.push({ sql, parameters });
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };
    const pool = {
      connect: async () => client,
    } as unknown as pg.Pool;
    const repository = new PostgisAlertRepository(pool);
    const id = randomUUID();

    await expect(repository.upsertMany([
      { ...makeAlert(1), id, speedLimitKmh: 50 },
      { ...makeAlert(2), id, speedLimitKmh: 70 },
    ])).resolves.toBe(2);

    const insertQuery = queries.find((query) => query.sql.includes("insert into road_alerts"));
    expect(insertQuery?.parameters).toHaveLength(33);
    expect(insertQuery?.parameters?.[7]).toBe(70);
  });

  it("syncs through a temporary staging table", async () => {
    const queries: Array<{ sql: string; parameters?: unknown[] }> = [];
    const client = {
      query: async (sql: string, parameters?: unknown[]) => {
        queries.push({ sql, parameters });
        if (sql.includes("select count(*)::int as count")) return { rows: [{ count: 10 }], rowCount: 1 };
        if (sql.includes("update road_alerts")) return { rows: [], rowCount: 3 };
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };
    const pool = {
      connect: async () => client,
    } as unknown as pg.Pool;
    const repository = new PostgisAlertImportRepository(pool);

    await expect(repository.syncManyViaStaging({
      alerts: makeAlerts(2),
      source: "unit-test",
      bounds: {
        minLatitude: 44,
        minLongitude: 10,
        maxLatitude: 46,
        maxLongitude: 12,
      },
      deactivateMissing: true,
      minRetainRatio: 0.1,
      minExistingForRatioCheck: 1,
    })).resolves.toEqual({ upserted: 2, deactivated: 3 });

    expect(queries.some((query) => query.sql.includes("create temporary table road_alerts_import_staging"))).toBe(true);
    expect(queries.some((query) => query.sql.includes("insert into road_alerts_import_staging"))).toBe(true);
    expect(queries.some((query) => query.sql.includes("from road_alerts_import_staging"))).toBe(true);
    expect(queries.some((query) => query.sql.includes("not exists"))).toBe(true);
  });

  it("syncs async alert batches through staging without pre-aggregating them", async () => {
    const queries: Array<{ sql: string; parameters?: unknown[] }> = [];
    const client = {
      query: async (sql: string, parameters?: unknown[]) => {
        queries.push({ sql, parameters });
        if (sql.includes("select count(*)::int as count from road_alerts_import_staging")) {
          return { rows: [{ count: 3 }], rowCount: 1 };
        }
        if (sql.includes("select count(*)::int as count")) return { rows: [{ count: 10 }], rowCount: 1 };
        if (sql.includes("update road_alerts")) return { rows: [], rowCount: 2 };
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };
    const pool = {
      connect: async () => client,
    } as unknown as pg.Pool;
    const repository = new PostgisAlertImportRepository(pool);

    await expect(repository.syncAlertBatchesViaStaging({
      batches: (async function* () {
        yield {
          alerts: makeAlerts(2),
          bounds: { minLatitude: 44, minLongitude: 10, maxLatitude: 45, maxLongitude: 11 },
          elementsScanned: 5,
        };
        yield {
          alerts: makeAlerts(1),
          bounds: { minLatitude: 43, minLongitude: 9, maxLatitude: 46, maxLongitude: 12 },
          elementsScanned: 7,
        };
      })(),
      source: "unit-test",
      deactivateMissing: true,
      minRetainRatio: 0.1,
      minExistingForRatioCheck: 1,
    })).resolves.toEqual({
      upserted: 3,
      deactivated: 2,
      bounds: { minLatitude: 43, minLongitude: 9, maxLatitude: 46, maxLongitude: 12 },
      elementsScanned: 12,
    });

    expect(queries.filter((query) => query.sql.includes("insert into road_alerts_import_staging"))).toHaveLength(2);
    expect(queries.some((query) => query.sql.includes("select count(*)::int as count from road_alerts_import_staging"))).toBe(true);
  });
});

function makeAlerts(count: number): RoadAlert[] {
  return Array.from({ length: count }, (_, index) => makeAlert(index));
}

function makeAlert(index: number): RoadAlert {
  return {
    id: randomUUID(),
    type: "fixedSpeedCamera",
    subtype: "fixed",
    capabilities: ["maxspeed"],
    primaryCapability: "maxspeed",
    latitude: 45 + index / 100_000,
    longitude: 11 + index / 100_000,
    speedLimitKmh: 50,
    speedLimitSource: "explicit",
    direction: "forward",
    bearing: 90,
    roadId: `way-${index}`,
    confidence: 0.9,
    active: true,
    validFrom: null,
    validUntil: null,
    source: "unit-test",
    osmType: "node",
    osmId: String(index),
    osmRelationId: null,
    osmVersion: 1,
    osmTimestamp: null,
    osmChangeset: null,
    osmUser: null,
    osmUid: null,
    sourceTags: { highway: "speed_camera" },
    fixme: null,
    positionApproximate: false,
    operationalStatus: "operational",
    statusReason: null,
    directionBearings: [90],
    osmPresenceStatus: "present",
    originalOsmIds: [`node/${index}`],
  };
}
