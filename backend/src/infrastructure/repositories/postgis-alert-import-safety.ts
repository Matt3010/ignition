import type pg from "pg";
import type { OsmBounds } from "../osm/osm-alert-parser.js";

type QueryExecutor = Pick<pg.Pool | pg.PoolClient, "query">;

export async function countActiveAlertsInBounds(
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

export function assertSafeImportSize(input: {
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

export function mergeOsmBounds(left: OsmBounds | null, right: OsmBounds | null): OsmBounds | null {
  if (!left) return right;
  if (!right) return left;
  return {
    minLatitude: Math.min(left.minLatitude, right.minLatitude),
    minLongitude: Math.min(left.minLongitude, right.minLongitude),
    maxLatitude: Math.max(left.maxLatitude, right.maxLatitude),
    maxLongitude: Math.max(left.maxLongitude, right.maxLongitude),
  };
}
