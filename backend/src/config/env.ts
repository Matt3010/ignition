import { z } from "zod";

const booleanEnv = z.preprocess((value) => {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off", ""].includes(normalized)) return false;
  }
  return value;
}, z.boolean());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().default("postgres://road:road@localhost:5432/road_context"),
  VALHALLA_BASE_URL: z.string().url().default("http://localhost:8002"),
  ROAD_CONTEXT_PROVIDER: z.enum(["valhalla", "mock"]).default("valhalla"),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  VALHALLA_TIMEOUT_MS: z.coerce.number().int().positive().default(2500),
  MAX_GPS_ACCURACY_METERS: z.coerce.number().positive().default(50),
  ALERT_SEARCH_RADIUS_METERS: z.coerce.number().positive().default(1500),
  ALERT_DIRECTION_TOLERANCE_DEGREES: z.coerce.number().min(0).max(180).default(45),
  SESSION_TRACE_TTL_SECONDS: z.coerce.number().positive().default(180),
  CACHE_TTL_SECONDS: z.coerce.number().positive().default(5),
  LOG_LEVEL: z.string().default("info"),
  CORS_ORIGIN: z.string().default("*"),
  PAYLOAD_LIMIT_BYTES: z.coerce.number().int().positive().default(8192),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(180),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),
  MIN_CLIENT_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  API_VERSION: z.string().default("1.0.0"),
  OSM_EXTRACT_URL: z.string().url().optional(),
  OSM_REGION: z.string().default("veneto"),
  OSM_DATA_DIR: z.string().default("./data/osm"),
  VALHALLA_TILE_DIR: z.string().default("./data/valhalla"),
  VALHALLA_ACTIVE_TILE_DIR: z.string().optional(),
  VALHALLA_HOST_TILE_DIR: z.string().optional(),
  VALHALLA_CONTAINER_NAME: z.string().optional(),
  OSM_UPDATE_CRON: z.string().default("0 4 * * 0"),
  TILE_PREFETCH_SCRIPT: z.string().default("scripts/prefetch-valhalla-bbox.sh"),
  TILE_PREFETCH_TILE_ROOT: z.string().default("./data/valhalla-prefetch"),
  TILE_PREFETCH_OSM_PREFIX: z.string().default("prefetch"),
  TILE_PREFETCH_HALF_LAT: z.coerce.number().positive().default(0.01),
  TILE_PREFETCH_HALF_LON: z.coerce.number().positive().default(0.01),
  TILE_PREFETCH_GRID_DEGREES: z.coerce.number().positive().default(0.01),
  TILE_PREFETCH_LOOKAHEAD_CHUNKS: z.coerce.number().int().min(0).max(5).default(1),
  TILE_PREFETCH_LOOKAHEAD_METERS: z.coerce.number().positive().default(800),
  TILE_PREFETCH_MIN_INTERVAL_SECONDS: z.coerce.number().positive().default(60),
  TILE_PREFETCH_MAX_QUEUE: z.coerce.number().int().positive().default(4),
  TILE_PREFETCH_RESTART_VALHALLA: booleanEnv.default(true),
  TILE_PREFETCH_IMPORT_ALERTS: booleanEnv.default(true),
  TILE_PREFETCH_MAX_AGE_HOURS: z.coerce.number().positive().default(168),
  TILE_PREFETCH_RETRIES: z.coerce.number().int().positive().default(2),
  TILE_PREFETCH_RETRY_DELAY_SECONDS: z.coerce.number().positive().default(3),
  TILE_PREFETCH_LOCK_TIMEOUT_SECONDS: z.coerce.number().positive().default(300),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = envSchema.parse(env);
  if (config.NODE_ENV === "production" && config.ROAD_CONTEXT_PROVIDER === "mock") {
    throw new Error("ROAD_CONTEXT_PROVIDER=mock is not allowed in production");
  }
  return config;
}
