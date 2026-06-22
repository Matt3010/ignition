import { z } from "zod";

const optionalUrlEnv = z.preprocess((value) => {
  if (typeof value === "string" && value.trim() === "") return undefined;
  return value;
}, z.string().url().optional());

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
  ALERT_UNASSIGNED_RADIUS_METERS: z.coerce.number().positive().default(500),
  ALERT_UNMATCHED_RADIUS_METERS: z.coerce.number().positive().default(300),
  ALERT_AHEAD_TOLERANCE_DEGREES: z.coerce.number().min(0).max(180).default(80),
  ALERT_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0),
  ALERT_RESULT_LIMIT: z.coerce.number().int().positive().max(1000).default(250),
  SESSION_TRACE_TTL_SECONDS: z.coerce.number().positive().default(180),
  CACHE_TTL_SECONDS: z.coerce.number().positive().default(5),
  LOG_LEVEL: z.string().default("info"),
  CORS_ORIGIN: z.string().default("*"),
  PAYLOAD_LIMIT_BYTES: z.coerce.number().int().positive().default(65536),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(180),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),
  MIN_CLIENT_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  API_VERSION: z.string().default("1.0.0"),
  APP_DEBUG_LOG_DIR: z.string().default("./reports/app-debug-logs"),
  OSM_EXTRACT_PRESET: z.string().default("italy"),
  OSM_EXTRACT_URL: optionalUrlEnv,
  OSM_REGION: z.string().default("italy"),
  OSM_DATA_DIR: z.string().default("./data/osm"),
  OSM_HOST_DATA_DIR: z.string().optional(),
  VALHALLA_TILE_DIR: z.string().default("./data/valhalla"),
  OSM_UPDATE_CRON: z.string().default("0 4 * * 0"),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = envSchema.parse(env);
  if (config.NODE_ENV === "production" && config.ROAD_CONTEXT_PROVIDER === "mock") {
    throw new Error("ROAD_CONTEXT_PROVIDER=mock is not allowed in production");
  }
  return config;
}
