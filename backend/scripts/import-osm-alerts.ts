import { access, readFile } from "node:fs/promises";
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
  const result = await alertRepository.syncMany({
    alerts: parsed.alerts,
    source: options.source,
    bounds: parsed.bounds,
    deactivateMissing: options.deactivateStale,
  });
  const bbox = parsed.bounds ? formatBounds(parsed.bounds) : null;

  try {
    await importRepository.record({
      source: options.source,
      version: options.version,
      status: "success",
      recordsCount: result.upserted,
      bbox,
      filePath: options.file,
      deactivatedCount: result.deactivated,
    });
  } catch (logError) {
    console.error(JSON.stringify({
      event: "osm_import_log_failed",
      status: "success",
      error: logError instanceof Error ? logError.message : String(logError),
    }));
  }

  console.log(JSON.stringify({
    source: options.source,
    file: options.file,
    bbox,
    elementsScanned: parsed.elementsScanned,
    records: parsed.alerts.length,
    upserted: result.upserted,
    deactivated: result.deactivated,
  }));
} catch (error) {
  try {
    await importRepository.record({
      source: options.source,
      version: options.version,
      status: "failed",
      recordsCount: 0,
      filePath: options.file,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  } catch (logError) {
    console.error(JSON.stringify({
      event: "osm_import_log_failed",
      status: "failed",
      error: logError instanceof Error ? logError.message : String(logError),
    }));
  }
  throw error;
} finally {
  await pool.end();
}

async function parseArgs(args: string[]): Promise<CliOptions> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    result.set(args[index].replace(/^--/, ""), args[index + 1]);
  }
  const file = result.get("file") ?? (await defaultOsmAlertFile());
  return {
    file,
    source: result.get("source") ?? "osm",
    version: result.get("version") ?? new Date().toISOString(),
    deactivateStale: parseBoolean(
      result.get("deactivate-stale") ?? process.env.OSM_ALERT_DEACTIVATE_STALE,
      true,
    ),
  };
}

async function defaultOsmAlertFile(): Promise<string> {
  const candidates = [
    join(config.OSM_DATA_DIR, `${config.OSM_REGION}.alerts.osm`),
    join(config.OSM_DATA_DIR, `${config.OSM_REGION}.osm`),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next supported OSM alert source.
    }
  }
  throw new Error(`Missing OSM alert source. Expected ${candidates.join(" or ")}`);
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
