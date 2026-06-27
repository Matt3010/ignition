import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { createPool } from "../src/infrastructure/database/postgres.js";
import { PostgisAlertImportRepository } from "../src/infrastructure/repositories/postgis-alert-import-repository.js";
import { PostgresImportLogRepository } from "../src/infrastructure/repositories/postgres-import-log-repository.js";
import { parseOsmAlertsFromReadable } from "../src/infrastructure/osm/osm-alert-parser.js";
import { loadConfig } from "../src/config/env.js";

interface CliOptions {
  files: string[];
  source: string;
  version: string;
  deactivateStale: boolean;
}

const config = loadConfig();
const options = await parseArgs(process.argv.slice(2));
const pool = createPool(config);
const alertRepository = new PostgisAlertImportRepository(pool);
const importRepository = new PostgresImportLogRepository(pool);

try {
  const result = await alertRepository.syncAlertBatchesViaStaging({
    batches: parseAlertBatches(options.files, options.source),
    source: options.source,
    deactivateMissing: options.deactivateStale,
    minRetainRatio: config.OSM_IMPORT_MIN_RETAIN_RATIO,
    minExistingForRatioCheck: config.OSM_IMPORT_MIN_EXISTING_FOR_RATIO_CHECK,
  });
  const bounds = result.bounds;
  const bbox = bounds ? formatBounds(bounds) : null;
  const filePath = options.files.join(",");

  try {
    await importRepository.record({
      source: options.source,
      version: options.version,
      status: "success",
      recordsCount: result.upserted,
      bbox,
      filePath,
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
    files: options.files,
    bbox,
    elementsScanned: result.elementsScanned,
    records: result.upserted,
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
      filePath: options.files.join(","),
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

async function* parseAlertBatches(files: string[], source: string) {
  for (const file of files) {
    yield await parseOsmAlertsFromReadable(createReadStream(file, { encoding: "utf8" }), source);
  }
}

async function parseArgs(args: string[]): Promise<CliOptions> {
  const supported = new Set(["file", "files", "source", "version", "deactivate-stale"]);
  const result = new Map<string, string>();

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--")) throw new Error(`Invalid argument: ${flag ?? "<missing>"}`);
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);

    const key = flag.slice(2);
    if (!supported.has(key)) throw new Error(`Unknown option: ${flag}`);
    if (result.has(key)) throw new Error(`Duplicate option: ${flag}`);
    result.set(key, value);
  }

  if (result.has("file") && result.has("files")) {
    throw new Error("Use either --file or --files, not both");
  }
  const files = result.get("files")
    ? splitList(result.get("files")!)
    : result.get("file")
      ? [result.get("file")!]
      : await defaultOsmAlertFiles();
  for (const file of files) {
    if (!file.toLowerCase().endsWith(".osm") && !file.toLowerCase().endsWith(".xml")) {
      throw new Error(`Unsupported OSM alert file: ${file}. Expected .osm or .xml`);
    }
  }

  return {
    files,
    source: result.get("source") ?? "osm",
    version: result.get("version") ?? new Date().toISOString(),
    deactivateStale: parseBoolean(
      result.get("deactivate-stale") ?? process.env.OSM_ALERT_DEACTIVATE_STALE,
      true,
    ),
  };
}

async function defaultOsmAlertFiles(): Promise<string[]> {
  const regions = splitList(config.OSM_REGIONS);
  const candidates = regions.map((region) => join(config.OSM_DATA_DIR, `${region}.alerts.osm`));
  for (const candidate of candidates) {
    try {
      await access(candidate);
    } catch {
      throw new Error(`Missing filtered OSM alert source: ${candidate}. Run npm run osm:refresh first.`);
    }
  }
  return candidates;
}

function splitList(value: string): string[] {
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (values.length === 0) throw new Error("OSM region/file list is empty");
  return values;
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
