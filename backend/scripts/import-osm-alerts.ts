import { stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createPool } from "../src/infrastructure/database/postgres.js";
import { PostgisAlertRepository } from "../src/infrastructure/repositories/postgis-alert-repository.js";
import { PostgresImportLogRepository } from "../src/infrastructure/repositories/postgres-import-log-repository.js";
import { parseOsmAlerts } from "../src/infrastructure/osm/osm-alert-parser.js";
import { loadConfig } from "../src/config/env.js";

interface CliOptions {
  file: string;
  source: string;
  version: string;
  deactivateStale: boolean;
}

const config = loadConfig();
const options = await parseArgs(process.argv.slice(2));
const pool = createPool(config);
const alertRepository = new PostgisAlertRepository(pool);
const importRepository = new PostgresImportLogRepository(pool);

try {
  const content = await readFile(options.file, "utf8");
  const parsed = parseOsmAlerts(content, options.source);
  const count = await alertRepository.upsertMany(parsed.alerts);
  const deactivatedCount =
    options.deactivateStale && parsed.bounds
      ? await alertRepository.deactivateMissingInBounds({
          source: options.source,
          activeIds: parsed.alerts.map((alert) => alert.id),
          bounds: parsed.bounds,
        })
      : 0;
  const bbox = parsed.bounds ? formatBounds(parsed.bounds) : null;
  await importRepository.record({
    source: options.source,
    version: options.version,
    status: "success",
    recordsCount: count,
    bbox,
    filePath: options.file,
    deactivatedCount,
  });
  console.log(
    JSON.stringify({
      source: options.source,
      file: options.file,
      bbox,
      elementsScanned: parsed.elementsScanned,
      records: parsed.alerts.length,
      upserted: count,
      deactivated: deactivatedCount,
    }),
  );
} catch (error) {
  await importRepository.record({
    source: options.source,
    version: options.version,
    status: "failed",
    recordsCount: 0,
    filePath: options.file,
    errorMessage: error instanceof Error ? error.message : String(error),
  });
  throw error;
} finally {
  await pool.end();
}

async function parseArgs(args: string[]): Promise<CliOptions> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    result.set(args[index].replace(/^--/, ""), args[index + 1]);
  }
  const file = result.get("file") ?? join(config.OSM_DATA_DIR, `${config.OSM_REGION}.osm`);
  await stat(file);
  return {
    file,
    source: result.get("source") ?? "osm",
    version: result.get("version") ?? new Date().toISOString(),
    deactivateStale: parseBoolean(result.get("deactivate-stale") ?? process.env.OSM_ALERT_DEACTIVATE_STALE, true),
  };
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !["false", "0", "no"].includes(value.toLowerCase());
}

function formatBounds(bounds: {
  minLatitude: number;
  minLongitude: number;
  maxLatitude: number;
  maxLongitude: number;
}): string {
  return `${bounds.minLongitude.toFixed(6)},${bounds.minLatitude.toFixed(6)},${bounds.maxLongitude.toFixed(6)},${bounds.maxLatitude.toFixed(6)}`;
}
