import { z } from "zod";

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
  MAX_SAMPLE_AGE_SECONDS: z.coerce.number().positive().default(60),
  MAX_SAMPLE_FUTURE_SECONDS: z.coerce.number().min(0).default(5),
  ALERT_SEARCH_RADIUS_METERS: z.coerce.number().positive().default(1500),
  ALERT_BEHIND_MIN_ANGLE_DEGREES: z.coerce.number().min(90).max(180).default(135),
  ALERT_BEHIND_IMMEDIATE_ANGLE_DEGREES: z.coerce.number().min(135).max(180).default(170),
  ALERT_BEHIND_MIN_SPEED_KMH: z.coerce.number().min(0).default(5),
  ALERT_BEHIND_MAX_GPS_ACCURACY_METERS: z.coerce.number().positive().default(25),
  ALERT_BEHIND_MIN_DISTANCE_INCREASE_METERS: z.coerce.number().min(0).default(5),
  SESSION_TRACE_TTL_SECONDS: z.coerce.number().positive().default(180),
  LOG_LEVEL: z.string().default("info"),
  CORS_ORIGIN: z.string().default("*"),
  PAYLOAD_LIMIT_BYTES: z.coerce.number().int().positive().default(65536),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(180),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),
  MIN_CLIENT_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  APP_DEBUG_LOG_DIR: z.string().default("./reports/app-debug-logs"),
  APP_DEBUG_LOG_MAX_FILE_BYTES: z.coerce.number().int().positive().default(5_000_000),
  APP_DEBUG_LOG_MAX_FILES: z.coerce.number().int().positive().default(200),
  APP_DEBUG_LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(14),
  OSM_REGIONS: z.string().default("italy"),
  OSM_DATA_DIR: z.string().default("./data/osm"),
  OSM_IMPORT_MIN_RETAIN_RATIO: z.coerce.number().min(0).max(1).default(0.2),
  OSM_IMPORT_MIN_EXISTING_FOR_RATIO_CHECK: z.coerce.number().int().min(0).default(20),
  VALHALLA_TILE_DIR: z.string().default("./data/valhalla"),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = envSchema.parse(env);
  if (config.NODE_ENV === "production" && config.ROAD_CONTEXT_PROVIDER === "mock") {
    throw new Error("ROAD_CONTEXT_PROVIDER=mock is not allowed in production");
  }
  if (config.ALERT_BEHIND_IMMEDIATE_ANGLE_DEGREES < config.ALERT_BEHIND_MIN_ANGLE_DEGREES) {
    throw new Error("ALERT_BEHIND_IMMEDIATE_ANGLE_DEGREES must be greater than or equal to ALERT_BEHIND_MIN_ANGLE_DEGREES");
  }
  return config;
}
