import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createPool } from "../src/infrastructure/database/postgres.js";
import { PostgisAlertRepository } from "../src/infrastructure/repositories/postgis-alert-repository.js";
import { PostgresImportLogRepository } from "../src/infrastructure/repositories/postgres-import-log-repository.js";
import { loadConfig } from "../src/config/env.js";
import { alertTypes, type RoadAlert } from "../src/domain/models/alert.js";
import { parseMaxspeedToKmh } from "../src/domain/services/maxspeed.js";
import { normalizeCourse } from "../src/domain/services/geo.js";

interface CliOptions {
  file: string;
  source: string;
  version: string;
}

const options = parseArgs(process.argv.slice(2));
const config = loadConfig();
const pool = createPool(config);
const alertRepository = new PostgisAlertRepository(pool);
const importRepository = new PostgresImportLogRepository(pool);

try {
  const content = await readFile(options.file, "utf8");
  const alerts = options.file.endsWith(".csv")
    ? parseCsv(content, options.source)
    : parseGeoJson(content, options.source);
  const count = await alertRepository.upsertMany(dedupe(alerts));
  await importRepository.record({
    source: options.source,
    version: options.version,
    status: "success",
    recordsCount: count,
  });
  console.log(JSON.stringify({ source: options.source, records: alerts.length, upserted: count }, null, 2));
} catch (error) {
  await importRepository.record({
    source: options.source,
    version: options.version,
    status: "failed",
    recordsCount: 0,
    errorMessage: error instanceof Error ? error.message : String(error),
  });
  throw error;
} finally {
  await pool.end();
}

function parseArgs(args: string[]): CliOptions {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    result.set(args[index].replace(/^--/, ""), args[index + 1]);
  }
  const file = result.get("file");
  if (!file) throw new Error("missing --file");
  return {
    file,
    source: result.get("source") ?? "manual",
    version: result.get("version") ?? new Date().toISOString(),
  };
}

function parseCsv(content: string, source: string): RoadAlert[] {
  const [headerLine, ...lines] = content.trim().split(/\r?\n/);
  const headers = headerLine.split(",").map((item) => item.trim());
  return lines.filter(Boolean).map((line) => {
    const values = line.split(",").map((item) => item.trim());
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
    return normalizeRecord(row, source);
  });
}

function parseGeoJson(content: string, source: string): RoadAlert[] {
  const geojson = JSON.parse(content) as {
    features?: Array<{ id?: string; geometry?: { type?: string; coordinates?: number[] }; properties?: Record<string, unknown> }>;
  };
  return (geojson.features ?? [])
    .filter((feature) => feature.geometry?.type === "Point" && Array.isArray(feature.geometry.coordinates))
    .map((feature) =>
      normalizeRecord(
        {
          id: feature.id,
          longitude: feature.geometry!.coordinates![0],
          latitude: feature.geometry!.coordinates![1],
          ...(feature.properties ?? {}),
        },
        source,
      ),
    );
}

function normalizeRecord(row: Record<string, unknown>, source: string): RoadAlert {
  const type = normalizeType(String(row.type ?? row.highway ?? row.hazard ?? "information"));
  const latitude = Number(row.latitude ?? row.lat);
  const longitude = Number(row.longitude ?? row.lon ?? row.lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error("invalid coordinates");
  const bearing = normalizeCourse(row.bearing === undefined || row.bearing === "" ? null : Number(row.bearing));
  const now = new Date();
  return {
    id: String(row.id ?? deterministicId(type, latitude, longitude, source)),
    type,
    latitude,
    longitude,
    speedLimitKmh: parseMaxspeedToKmh((row.speedLimitKmh ?? row.maxspeed) as string | number | null),
    direction: normalizeDirection(row.direction),
    bearing,
    roadId: row.roadId ? String(row.roadId) : row.road_id ? String(row.road_id) : null,
    confidence: clamp(Number(row.confidence ?? 0.75)),
    active: String(row.active ?? "true") !== "false",
    validFrom: row.validFrom || row.valid_from ? new Date(String(row.validFrom ?? row.valid_from)) : null,
    validUntil: row.validUntil || row.valid_until ? new Date(String(row.validUntil ?? row.valid_until)) : null,
    source,
    createdAt: now,
    updatedAt: now,
  } as RoadAlert;
}

function normalizeType(value: string): RoadAlert["type"] {
  const normalized = value.trim();
  if (alertTypes.includes(normalized as RoadAlert["type"])) return normalized as RoadAlert["type"];
  if (["speed_camera", "speed_camera:fixed", "camera", "fixed"].includes(normalized)) return "fixedSpeedCamera";
  if (["construction", "roadworks"].includes(normalized)) return "roadWorks";
  if (["hazard", "danger"].includes(normalized)) return "roadHazard";
  return "information";
}

function normalizeDirection(value: unknown): RoadAlert["direction"] {
  if (value === "forward" || value === "backward" || value === "unknown") return value;
  return "unknown";
}

function clamp(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.75;
}

function deterministicId(type: string, latitude: number, longitude: number, source: string): string {
  const hash = createHash("sha1")
    .update(`${source}:${type}:${latitude.toFixed(6)}:${longitude.toFixed(6)}`)
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function dedupe(alerts: RoadAlert[]): RoadAlert[] {
  const seen = new Map<string, RoadAlert>();
  for (const alert of alerts) {
    const key = `${alert.source}:${alert.type}:${alert.latitude.toFixed(6)}:${alert.longitude.toFixed(6)}`;
    seen.set(key, alert);
  }
  return [...seen.values()];
}
