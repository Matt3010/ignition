import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";

interface DriveSample {
  latitude: number;
  longitude: number;
  speedKmh: number;
  course: number | null;
  horizontalAccuracyMeters: number;
  timestamp: string;
  sessionId: string;
}

interface RoadContextResponse {
  matched: boolean;
  roadId: string | null;
  speedLimitKmh: number | null;
  confidence: number;
  direction: string;
  alerts: Array<{
    id: string;
    type: string;
    distanceMeters: number;
    confidence: number;
  }>;
}

interface SoakStats {
  startedAt: number;
  iterations: number;
  failures: number;
  matched: number;
  unmatched: number;
  alerts: number;
  lowConfidence: number;
  nullLimits: number;
  maxLatencyMs: number;
}

const baseUrl = process.env.DRIVE_SOAK_BASE_URL;
const realProviders = process.env.DRIVE_SOAK_REAL === "true";
const maxIterations = parseOptionalInteger(process.env.DRIVE_SOAK_MAX_ITERATIONS);
const delayMs = parseInteger(process.env.DRIVE_SOAK_DELAY_MS, 1000);
const sessions = parseInteger(process.env.DRIVE_SOAK_SESSIONS, 3);
const reportEvery = parseInteger(process.env.DRIVE_SOAK_REPORT_EVERY, 25);
const seed = parseInteger(process.env.DRIVE_SOAK_SEED, Date.now());
const startLatitude = parseFloatEnv("DRIVE_SOAK_START_LAT", 45);
const startLongitude = parseFloatEnv("DRIVE_SOAK_START_LON", 11);
const minLatitude = parseFloatEnv("DRIVE_SOAK_MIN_LAT", startLatitude - 0.01);
const maxLatitude = parseFloatEnv("DRIVE_SOAK_MAX_LAT", startLatitude + 0.01);
const minLongitude = parseFloatEnv("DRIVE_SOAK_MIN_LON", startLongitude - 0.002);
const maxLongitude = parseFloatEnv("DRIVE_SOAK_MAX_LON", startLongitude + 0.002);
const minMatchRate = parseOptionalFloat(process.env.DRIVE_SOAK_MIN_MATCH_RATE);
const allowExpectedFailures = process.env.DRIVE_SOAK_EXPECT_FAILURES === "true";
const random = mulberry32(seed);
const stats: SoakStats = {
  startedAt: Date.now(),
  iterations: 0,
  failures: 0,
  matched: 0,
  unmatched: 0,
  alerts: 0,
  lowConfidence: 0,
  nullLimits: 0,
  maxLatencyMs: 0,
};

let app: FastifyInstance | undefined;
let stopped = false;

process.on("SIGINT", () => {
  stopped = true;
});
process.on("SIGTERM", () => {
  stopped = true;
});

const client = await createClient();
await client.ready();
const drivers = Array.from({ length: sessions }, (_, index) => createDriver(index));

console.log(
  JSON.stringify({
    event: "drive_soak_started",
    mode: baseUrl ? "http" : "in-process",
    providers: realProviders ? "real" : "mock",
    baseUrl: baseUrl ?? null,
    sessions,
    delayMs,
    maxIterations,
    seed,
    startLatitude,
    startLongitude,
  }),
);

try {
  while (!stopped && (maxIterations === null || stats.iterations < maxIterations)) {
    const driver = drivers[stats.iterations % drivers.length];
    const sample = nextSample(driver);
    const scenario = realProviders ? null : chooseScenario(sample);
    const startedAt = performance.now();

    try {
      const response = await client.post(sample, scenario);
      const latencyMs = performance.now() - startedAt;
      stats.maxLatencyMs = Math.max(stats.maxLatencyMs, latencyMs);
      assertRoadContext(response, sample, scenario);
      updateStats(response);
    } catch (error) {
      stats.failures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify({
          event: "drive_soak_failure",
          iteration: stats.iterations + 1,
          scenario,
          sessionId: sample.sessionId,
          message,
        }),
      );
      if (!allowExpectedFailures) throw error;
    }

    stats.iterations += 1;
    if (stats.iterations % reportEvery === 0) report();
    if (delayMs > 0 && (maxIterations === null || stats.iterations < maxIterations)) {
      await sleep(jitter(delayMs));
    }
  }
} finally {
  report("drive_soak_finished");
  if (app) await app.close();
}

assertFinalStats();
if (stats.failures > 0 && !allowExpectedFailures) process.exit(1);

async function createClient(): Promise<{
  ready(): Promise<void>;
  post(sample: DriveSample, scenario: string | null): Promise<RoadContextResponse>;
}> {
  if (baseUrl) {
    return {
      ready: async () => {
        const response = await fetch(`${baseUrl.replace(/\/$/, "")}/ready`);
        const body = (await response.json()) as unknown;
        if (!response.ok) throw new Error(`backend not ready: HTTP ${response.status}: ${JSON.stringify(body)}`);
      },
      post: async (sample, scenario) => {
        const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v1/road-context`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(scenario ? { "x-road-context-scenario": scenario } : {}),
          },
          body: JSON.stringify(sample),
        });
        const body = (await response.json()) as unknown;
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
        return body as RoadContextResponse;
      },
    };
  }

  app = await buildApp(
    loadConfig({
      ...process.env,
      NODE_ENV: process.env.NODE_ENV ?? "test",
      ROAD_CONTEXT_PROVIDER: process.env.ROAD_CONTEXT_PROVIDER ?? (realProviders ? "valhalla" : "mock"),
      LOG_LEVEL: process.env.LOG_LEVEL ?? "silent",
      PORT: process.env.PORT ?? "3000",
    }),
  );
  return {
    ready: async () => {
      const response = await app!.inject({ method: "GET", url: "/ready" });
      const body = response.json() as unknown;
      if (response.statusCode >= 400) {
        throw new Error(`backend not ready: HTTP ${response.statusCode}: ${JSON.stringify(body)}`);
      }
    },
    post: async (sample, scenario) => {
      const response = await app!.inject({
        method: "POST",
        url: "/api/v1/road-context",
        headers: scenario ? { "x-road-context-scenario": scenario } : {},
        payload: sample,
      });
      const body = response.json() as unknown;
      if (response.statusCode >= 400) throw new Error(`HTTP ${response.statusCode}: ${JSON.stringify(body)}`);
      return body as RoadContextResponse;
    },
  };
}

function createDriver(index: number): {
  sessionId: string;
  latitude: number;
  longitude: number;
  speedKmh: number;
  course: number;
  tick: number;
} {
  return {
    sessionId: `550e8400-e29b-41d4-a716-44665544${String(index).padStart(4, "0")}`,
    latitude: startLatitude + index * 0.00015,
    longitude: startLongitude,
    speedKmh: 45 + random() * 35,
    course: 0,
    tick: 0,
  };
}

function nextSample(driver: ReturnType<typeof createDriver>): DriveSample {
  driver.tick += 1;
  const speedDelta = (random() - 0.5) * 12;
  driver.speedKmh = clamp(driver.speedKmh + speedDelta, 15, 110);
  driver.course = random() < 0.08 ? 180 : random() < 0.2 ? 5 + random() * 15 : 0;
  const metersPerSecond = driver.speedKmh / 3.6;
  const stepMeters = Math.max(5, metersPerSecond * (delayMs / 1000 || 1));
  const latDelta = (stepMeters / 111_320) * (driver.course > 90 ? -1 : 1);
  driver.latitude += latDelta;

  if (driver.latitude > maxLatitude || driver.latitude < minLatitude) {
    driver.course = driver.latitude > maxLatitude ? 180 : 0;
  }

  const laneOffset = realProviders ? 0 : random() < 0.04 ? 0.00025 : 0;
  driver.longitude = clamp(
    startLongitude + laneOffset + (random() - 0.5) * 0.00004,
    minLongitude,
    maxLongitude,
  );
  return {
    latitude: Number(driver.latitude.toFixed(6)),
    longitude: Number(driver.longitude.toFixed(6)),
    speedKmh: Number(driver.speedKmh.toFixed(1)),
    course: Number(driver.course.toFixed(1)),
    horizontalAccuracyMeters: Number((4 + random() * 12).toFixed(1)),
    timestamp: new Date(Date.now() + driver.tick * 1000).toISOString(),
    sessionId: driver.sessionId,
  };
}

function chooseScenario(sample: DriveSample): string | null {
  const roll = random();
  if (roll < 0.03) return "matchedFalse";
  if (roll < 0.07) return "lowConfidence";
  if (roll < 0.1) return "nullLimit";
  if (roll < 0.13) return "parallelRoad";
  if (roll < 0.16) return "staleData";
  return sample.speedKmh >= 65 ? "limit70" : "limit50";
}

function assertRoadContext(response: RoadContextResponse, sample: DriveSample, scenario: string | null): void {
  if (typeof response.matched !== "boolean") throw new Error("matched is not boolean");
  if (response.confidence < 0 || response.confidence > 1) throw new Error(`invalid confidence ${response.confidence}`);
  if (!["forward", "backward", "unknown"].includes(response.direction)) {
    throw new Error(`invalid direction ${response.direction}`);
  }
  if (scenario === "matchedFalse" && response.matched) throw new Error("expected unmatched response");
  if (scenario === "nullLimit" && response.speedLimitKmh !== null) throw new Error("expected null speed limit");
  if (scenario === "limit70" && response.speedLimitKmh !== 70) throw new Error("expected 70 km/h speed limit");
  if (scenario === "limit50" && response.speedLimitKmh !== 50) throw new Error("expected 50 km/h speed limit");
  if (sample.horizontalAccuracyMeters > 0 && response.alerts.some((alert) => alert.distanceMeters < 0)) {
    throw new Error("negative alert distance");
  }
  for (const alert of response.alerts) {
    if (alert.confidence < 0 || alert.confidence > 1) throw new Error(`invalid alert confidence ${alert.id}`);
    if (!Number.isFinite(alert.distanceMeters)) throw new Error(`invalid alert distance ${alert.id}`);
  }
}

function updateStats(response: RoadContextResponse): void {
  if (response.matched) stats.matched += 1;
  else stats.unmatched += 1;
  stats.alerts += response.alerts.length;
  if (response.confidence < 0.5) stats.lowConfidence += 1;
  if (response.speedLimitKmh === null) stats.nullLimits += 1;
}

function report(event = "drive_soak_progress"): void {
  const elapsedSeconds = Math.max(1, (Date.now() - stats.startedAt) / 1000);
  console.log(
    JSON.stringify({
      event,
      iterations: stats.iterations,
      failures: stats.failures,
      matched: stats.matched,
      unmatched: stats.unmatched,
      alerts: stats.alerts,
      lowConfidence: stats.lowConfidence,
      nullLimits: stats.nullLimits,
      maxLatencyMs: Number(stats.maxLatencyMs.toFixed(1)),
      requestsPerSecond: Number((stats.iterations / elapsedSeconds).toFixed(2)),
    }),
  );
}

function assertFinalStats(): void {
  if (stats.iterations === 0) return;
  if (minMatchRate !== null) {
    const matchRate = stats.matched / stats.iterations;
    if (matchRate < minMatchRate) {
      throw new Error(`match rate ${matchRate.toFixed(2)} below required ${minMatchRate}`);
    }
  }
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function parseOptionalInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

function parseFloatEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseOptionalFloat(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms: number): number {
  return Math.max(0, Math.round(ms * (0.75 + random() * 0.5)));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function mulberry32(seedValue: number): () => number {
  let value = seedValue >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
