import type { FastifyInstance } from "fastify";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
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
  roadName: string | null;
  speedLimitKmh: number | null;
  roadType: string | null;
  confidence: number;
  direction: string;
  alerts: Array<{
    id: string;
    type: string;
    distanceMeters: number;
    speedLimitKmh?: number | null;
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
  totalLatencyMs: number;
  distanceMeters: number;
  simulatedSeconds: number;
  movingSeconds: number;
  stoppedSamples: number;
  movingSamples: number;
  turns: number;
  speedLimitExceeded: number;
  maxSpeedKmh: number;
  roadChanges: number;
  routeSegments: number;
  shortRouteSegments: number;
  closestAlertMeters: number | null;
  roads: Set<string>;
  roadStats: Map<string, RoadAggregate>;
  speedLimitStats: Map<string, SpeedLimitAggregate>;
  alertStats: Map<string, AlertAggregate>;
  unmatchedSamples: Array<PathSample>;
  pathSamples: PathSample[];
}

interface RoadAggregate {
  label: string;
  roadId: string | null;
  roadType: string | null;
  samples: number;
  matched: number;
  unmatched: number;
  distanceMeters: number;
  speedLimitExceeded: number;
  nullLimits: number;
  alerts: number;
  maxSpeedKmh: number;
}

interface SpeedLimitAggregate {
  speedLimitKmh: number | null;
  samples: number;
  distanceMeters: number;
  exceeded: number;
  maxSpeedKmh: number;
}

interface AlertAggregate {
  type: string;
  count: number;
  closestMeters: number | null;
}

interface PathSample {
  iteration: number;
  timestamp: string;
  latitude: number;
  longitude: number;
  speedKmh: number;
  course: number | null;
  matched: boolean;
  roadId: string | null;
  roadName: string | null;
  roadType: string | null;
  speedLimitKmh: number | null;
  confidence: number;
  nearestAlertType: string | null;
  nearestAlertMeters: number | null;
}

interface DriverState {
  sessionId: string;
  latitude: number;
  longitude: number;
  previousLatitude: number;
  previousLongitude: number;
  speedKmh: number;
  course: number;
  previousCourse: number;
  tick: number;
  stopTicksRemaining: number;
  previousMoving: boolean;
  previousRoadId: string | null;
  lastSpeedLimitKmh: number | null;
  lastRoadType: string | null;
  lastLimitExceeded: boolean;
  route: RoutePath | null;
  routeCursorMeters: number;
  recentPositions: Array<{ latitude: number; longitude: number }>;
}

interface RoutePath {
  points: Array<{ latitude: number; longitude: number }>;
  cumulativeMeters: number[];
  totalMeters: number;
}

interface RouteChoice {
  route: RoutePath;
  score: number;
  initialBearing: number;
  overlapRatio: number;
}

const baseUrl = process.env.DRIVE_SOAK_BASE_URL;
const realProviders = process.env.DRIVE_SOAK_REAL === "true";
const maxIterations = parseOptionalInteger(process.env.DRIVE_SOAK_MAX_ITERATIONS);
const delayMs = parseInteger(process.env.DRIVE_SOAK_DELAY_MS, 1000);
const sessions = parseInteger(process.env.DRIVE_SOAK_SESSIONS, 1);
const reportEvery = parseInteger(process.env.DRIVE_SOAK_REPORT_EVERY, 25);
const seed = parseInteger(process.env.DRIVE_SOAK_SEED, Date.now());
const random = mulberry32(seed);
const startLatitude = parseFloatEnv("DRIVE_SOAK_START_LAT", 45);
const startLongitude = parseFloatEnv("DRIVE_SOAK_START_LON", 11);
const startJitterMeters = parseFloatEnv("DRIVE_SOAK_START_JITTER_METERS", realProviders ? 500 : 0);
const minimumRouteMeters = parseFloatEnv("DRIVE_SOAK_MIN_ROUTE_METERS", 700);
const routeTargetMeters = parseFloatEnv("DRIVE_SOAK_ROUTE_TARGET_METERS", realProviders ? 1800 : 900);
const randomizedStart = randomizeStart(startLatitude, startLongitude, startJitterMeters);
let driveStartLatitude = randomizedStart.latitude;
let driveStartLongitude = randomizedStart.longitude;
const minLatitude = parseFloatEnv("DRIVE_SOAK_MIN_LAT", startLatitude - 0.01);
const maxLatitude = parseFloatEnv("DRIVE_SOAK_MAX_LAT", startLatitude + 0.01);
const minLongitude = parseFloatEnv("DRIVE_SOAK_MIN_LON", startLongitude - 0.002);
const maxLongitude = parseFloatEnv("DRIVE_SOAK_MAX_LON", startLongitude + 0.002);
const minMatchRate = parseOptionalFloat(process.env.DRIVE_SOAK_MIN_MATCH_RATE);
const allowExpectedFailures = process.env.DRIVE_SOAK_EXPECT_FAILURES === "true";
const outputMode = process.env.DRIVE_SOAK_OUTPUT === "json" ? "json" : "human";
const reportDir = process.env.DRIVE_SOAK_REPORT_DIR ?? "reports/drive-soak";
const reportPath = createReportPath(reportDir, seed);
const reportStream = createWriteStream(reportPath.eventsPath, { flags: "a" });
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
  totalLatencyMs: 0,
  distanceMeters: 0,
  simulatedSeconds: 0,
  movingSeconds: 0,
  stoppedSamples: 0,
  movingSamples: 0,
  turns: 0,
  speedLimitExceeded: 0,
  maxSpeedKmh: 0,
  roadChanges: 0,
  routeSegments: 0,
  shortRouteSegments: 0,
  closestAlertMeters: null,
  roads: new Set<string>(),
  roadStats: new Map<string, RoadAggregate>(),
  speedLimitStats: new Map<string, SpeedLimitAggregate>(),
  alertStats: new Map<string, AlertAggregate>(),
  unmatchedSamples: [],
  pathSamples: [],
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
if (realProviders) {
  const matchedStart = await findMatchedStart(client);
  if (matchedStart) {
    driveStartLatitude = matchedStart.latitude;
    driveStartLongitude = matchedStart.longitude;
    logEvent({
      event: "drive_start_matched",
      message: `Partenza agganciata a ${matchedStart.roadLabel}`,
    });
  } else {
    logEvent({
      event: "drive_start_unmatched",
      message: "Partenza non agganciata: uso le coordinate richieste e lascio che il test misuri gli unmatched",
    });
  }
}
const route = realProviders ? await buildRoutePath(driveStartLatitude, driveStartLongitude, 0) : null;
if (route) {
  stats.routeSegments += 1;
  if (route.totalMeters < minimumRouteMeters) stats.shortRouteSegments += 1;
  driveStartLatitude = route.points[0]?.latitude ?? driveStartLatitude;
  driveStartLongitude = route.points[0]?.longitude ?? driveStartLongitude;
  logEvent({
    event: "drive_route_loaded",
    message: `Route Valhalla caricata: ${(route.totalMeters / 1000).toFixed(2)} km, ${route.points.length} punti`,
  });
} else if (realProviders) {
  logEvent({
    event: "drive_route_unavailable",
    message: "Route Valhalla non disponibile: uso simulazione libera con map matching reale",
  });
}
const drivers = Array.from({ length: sessions }, (_, index) => createDriver(index));
if (realProviders) await primeDriverTraces(client, drivers);

logEvent({
  event: "drive_soak_started",
  message: `Guida avviata (${realProviders ? "provider reali" : "mock"}, ${baseUrl ? "HTTP" : "in-process"})`,
  details: {
    sessions,
    intervalMs: delayMs,
    maxIterations: maxIterations ?? "infinito",
    seed,
    requestedStart: `${startLatitude.toFixed(6)}, ${startLongitude.toFixed(6)}`,
    actualStart: `${driveStartLatitude.toFixed(6)}, ${driveStartLongitude.toFixed(6)}`,
    startJitterMeters,
    routeTargetMeters,
  },
});

try {
  while (!stopped && (maxIterations === null || stats.iterations < maxIterations)) {
    const driver = drivers[stats.iterations % drivers.length];
    if (realProviders) await ensureDriverRoute(driver);
    const sample = nextSample(driver);
    const scenario = realProviders ? null : chooseScenario(sample);
    const startedAt = performance.now();

    try {
      const response = await client.post(sample, scenario);
      const latencyMs = performance.now() - startedAt;
      stats.maxLatencyMs = Math.max(stats.maxLatencyMs, latencyMs);
      stats.totalLatencyMs += latencyMs;
      assertRoadContext(response, sample, scenario);
      updateStats(response, sample, driver);
      reportDriveEvent(driver, sample, response, latencyMs);
    } catch (error) {
      stats.failures += 1;
      const message = error instanceof Error ? error.message : String(error);
      logEvent(
        {
          event: "drive_soak_failure",
          message: `Errore richiesta ${stats.iterations + 1}: ${message}`,
          details: { scenario, sessionId: sample.sessionId },
        },
        "error",
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
  reportStream.end();
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
      RATE_LIMIT_MAX: process.env.RATE_LIMIT_MAX ?? "100000",
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

async function findMatchedStart(client: {
  post(sample: DriveSample, scenario: string | null): Promise<RoadContextResponse>;
}): Promise<{ latitude: number; longitude: number; roadLabel: string } | null> {
  const offsetsMeters = buildStartProbeOffsets();

  for (const [index, [northMeters, eastMeters]] of offsetsMeters.entries()) {
    const candidate = offsetLatLon(driveStartLatitude, driveStartLongitude, northMeters, eastMeters);
    const approach = offsetLatLon(candidate.latitude, candidate.longitude, -18, 0);
    const sessionId = `550e8400-e29b-41d4-a716-44665544${(9000 + index).toString().padStart(4, "0")}`;
    const firstSample: DriveSample = {
      latitude: Number(approach.latitude.toFixed(6)),
      longitude: Number(approach.longitude.toFixed(6)),
      speedKmh: 20,
      course: 0,
      horizontalAccuracyMeters: 5,
      timestamp: new Date().toISOString(),
      sessionId,
    };
    const sample: DriveSample = {
      latitude: Number(candidate.latitude.toFixed(6)),
      longitude: Number(candidate.longitude.toFixed(6)),
      speedKmh: 20,
      course: 0,
      horizontalAccuracyMeters: 5,
      timestamp: new Date(Date.now() + 1000).toISOString(),
      sessionId,
    };
    try {
      await client.post(firstSample, null);
      const response = await client.post(sample, null);
      if (response.matched) {
        return {
          latitude: sample.latitude,
          longitude: sample.longitude,
        roadLabel: response.roadName ?? readableRoadFallback(response.roadType, response.roadId),
        };
      }
    } catch {
      // Keep probing nearby candidates; the main run will fail loudly if the backend is actually broken.
    }
  }

  return null;
}

async function primeDriverTraces(
  client: { post(sample: DriveSample, scenario: string | null): Promise<RoadContextResponse> },
  drivers: DriverState[],
): Promise<void> {
  for (const driver of drivers) {
    const approach = offsetLatLon(driver.latitude, driver.longitude, -18, 0);
    const sample: DriveSample = {
      latitude: Number(approach.latitude.toFixed(6)),
      longitude: Number(approach.longitude.toFixed(6)),
      speedKmh: 20,
      course: 0,
      horizontalAccuracyMeters: 5,
      timestamp: new Date().toISOString(),
      sessionId: driver.sessionId,
    };
    try {
      await client.post(sample, null);
    } catch {
      // The counted run still reports failures/unmatched normally.
    }
  }
}

async function ensureDriverRoute(driver: DriverState): Promise<void> {
  if (driver.route && driver.routeCursorMeters < driver.route.totalMeters - 2) return;

  const route = await buildRoutePath(driver.latitude, driver.longitude, driver.course, driver.recentPositions);
  if (!route) {
    if (driver.route) {
      logEvent({
        event: "drive_route_unavailable",
        message: "Nuova tratta Valhalla non disponibile: continuo in simulazione libera",
      });
    }
    driver.route = null;
    driver.routeCursorMeters = 0;
    return;
  }

  driver.route = route;
  driver.routeCursorMeters = 0;
  driver.latitude = route.points[0]?.latitude ?? driver.latitude;
  driver.longitude = route.points[0]?.longitude ?? driver.longitude;
  stats.routeSegments += 1;
  if (route.totalMeters < minimumRouteMeters) stats.shortRouteSegments += 1;
  logEvent({
    event: "drive_route_loaded",
    message: `Nuova tratta Valhalla: ${(route.totalMeters / 1000).toFixed(2)} km, ${route.points.length} punti`,
    details: {
      routeSegments: stats.routeSegments,
      shortRoute: route.totalMeters < minimumRouteMeters,
    },
  });
}

async function buildRoutePath(
  startLat: number,
  startLon: number,
  bearing: number,
  recentPositions: Array<{ latitude: number; longitude: number }> = [],
): Promise<RoutePath | null> {
  const base = process.env.VALHALLA_BASE_URL ?? "http://127.0.0.1:8002";
  const candidates = buildRouteEndCandidates(startLat, startLon, bearing);
  let bestChoice: RouteChoice | null = null;
  for (const candidate of candidates) {
    try {
      const route = await fetchValhallaRoute(base, startLat, startLon, candidate.latitude, candidate.longitude);
      if (!route || route.totalMeters < 80) continue;
      const choice = scoreRouteChoice(route, bearing, recentPositions);
      if (!bestChoice || choice.score > bestChoice.score) bestChoice = choice;
    } catch {
      // Try next route candidate.
    }
  }
  return bestChoice?.route ?? null;
}

function scoreRouteChoice(
  route: RoutePath,
  currentBearing: number,
  recentPositions: Array<{ latitude: number; longitude: number }>,
): RouteChoice {
  const initialBearing = initialRouteBearing(route);
  const turnDelta = Math.abs(signedAngleDelta(currentBearing, initialBearing));
  const overlapRatio = routeOverlapRatio(route, recentPositions);
  const endPoint = route.points.at(-1) ?? route.points[0]!;
  const endRevisitPenalty = recentPositions.some(
    (position) => distanceMeters(position.latitude, position.longitude, endPoint.latitude, endPoint.longitude) < 80,
  )
    ? 450
    : 0;
  const lengthScore = Math.min(route.totalMeters, 1600);
  const lengthPenalty = route.totalMeters < minimumRouteMeters ? 600 : 0;
  const turnScore = turnDelta > 140 ? -650 : turnDelta >= 35 && turnDelta <= 115 ? 220 : turnDelta < 20 ? 80 : 120;
  const overlapPenalty = overlapRatio * 1400;
  return {
    route,
    initialBearing,
    overlapRatio,
    score: lengthScore + turnScore - lengthPenalty - overlapPenalty - endRevisitPenalty + random() * 20,
  };
}

function initialRouteBearing(route: RoutePath): number {
  const first = route.points[0]!;
  const next =
    route.points.find((point) => distanceMeters(first.latitude, first.longitude, point.latitude, point.longitude) >= 20) ??
    route.points[1] ??
    first;
  return bearingDegrees(first.latitude, first.longitude, next.latitude, next.longitude);
}

function routeOverlapRatio(route: RoutePath, recentPositions: Array<{ latitude: number; longitude: number }>): number {
  if (recentPositions.length < 5) return 0;
  let checked = 0;
  let overlapping = 0;
  for (let index = 0; index < route.points.length; index += 3) {
    const point = route.points[index];
    const metersFromStart = route.cumulativeMeters[index] ?? 0;
    if (!point || metersFromStart < 80) continue;
    checked += 1;
    if (
      recentPositions.some(
        (position) => distanceMeters(point.latitude, point.longitude, position.latitude, position.longitude) < 25,
      )
    ) {
      overlapping += 1;
    }
  }
  return checked === 0 ? 0 : overlapping / checked;
}

function buildRouteEndCandidates(
  latitude: number,
  longitude: number,
  bearing: number,
): Array<{ latitude: number; longitude: number }> {
  const distances = uniqueNumbers([
    routeTargetMeters,
    routeTargetMeters * 0.75,
    routeTargetMeters * 1.25,
    routeTargetMeters * 0.5,
    Math.max(700, routeTargetMeters * 1.5),
  ]);
  const turnChoices = [0, 35, -35, 70, -70, 110, -110, 160, -160];
  const candidates: Array<{ latitude: number; longitude: number }> = [];
  const shuffledTurns = [...turnChoices].sort(() => random() - 0.5);
  const shuffledDistances = [...distances].sort(() => random() - 0.5);

  for (const meters of shuffledDistances) {
    for (const delta of shuffledTurns) {
      candidates.push(moveByMeters(latitude, longitude, normalizeBearing(bearing + delta), meters));
    }
  }

  return candidates;
}

async function fetchValhallaRoute(
  baseUrl: string,
  startLat: number,
  startLon: number,
  endLat: number,
  endLon: number,
): Promise<RoutePath | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        locations: [
          { lat: startLat, lon: startLon, type: "break" },
          { lat: endLat, lon: endLon, type: "break" },
        ],
        costing: "auto",
        directions_options: { units: "kilometers" },
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      trip?: { legs?: Array<{ shape?: string }> };
    };
    const shape = body.trip?.legs?.find((leg) => typeof leg.shape === "string")?.shape;
    if (!shape) return null;
    return createRoutePath(decodeValhallaShape(shape));
  } finally {
    clearTimeout(timer);
  }
}

function createRoutePath(points: Array<{ latitude: number; longitude: number }>): RoutePath | null {
  if (points.length < 2) return null;
  const cumulativeMeters = [0];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (!previous || !current) continue;
    cumulativeMeters[index] =
      (cumulativeMeters[index - 1] ?? 0) +
      distanceMeters(previous.latitude, previous.longitude, current.latitude, current.longitude);
  }
  const totalMeters = cumulativeMeters.at(-1) ?? 0;
  if (totalMeters <= 0) return null;
  return { points, cumulativeMeters, totalMeters };
}

function decodeValhallaShape(shape: string): Array<{ latitude: number; longitude: number }> {
  let index = 0;
  let latitude = 0;
  let longitude = 0;
  const coordinates: Array<{ latitude: number; longitude: number }> = [];

  while (index < shape.length) {
    const latResult = decodePolylineValue(shape, index);
    index = latResult.nextIndex;
    const lonResult = decodePolylineValue(shape, index);
    index = lonResult.nextIndex;
    latitude += latResult.value;
    longitude += lonResult.value;
    coordinates.push({
      latitude: latitude * 1e-6,
      longitude: longitude * 1e-6,
    });
  }

  return coordinates;
}

function decodePolylineValue(value: string, startIndex: number): { value: number; nextIndex: number } {
  let result = 0;
  let shift = 0;
  let index = startIndex;
  let byte: number;
  do {
    byte = value.charCodeAt(index) - 63;
    index += 1;
    result |= (byte & 0x1f) << shift;
    shift += 5;
  } while (byte >= 0x20 && index < value.length);

  return {
    value: result & 1 ? ~(result >> 1) : result >> 1,
    nextIndex: index,
  };
}

function advanceOnRoute(driver: DriverState, stepMeters: number): void {
  if (!driver.route) return;
  driver.routeCursorMeters = Math.min(driver.route.totalMeters, driver.routeCursorMeters + stepMeters);
  const position = interpolateRoute(driver.route, driver.routeCursorMeters);
  driver.latitude = position.latitude;
  driver.longitude = position.longitude;
  driver.course = position.bearing;
}

function interpolateRoute(route: RoutePath, distanceAlongRoute: number): {
  latitude: number;
  longitude: number;
  bearing: number;
} {
  const target = clamp(distanceAlongRoute, 0, route.totalMeters);
  let segmentIndex = 1;
  while (
    segmentIndex < route.cumulativeMeters.length &&
    (route.cumulativeMeters[segmentIndex] ?? 0) < target
  ) {
    segmentIndex += 1;
  }
  const previous = route.points[Math.max(0, segmentIndex - 1)] ?? route.points[0]!;
  const next = route.points[segmentIndex] ?? previous;
  const previousMeters = route.cumulativeMeters[Math.max(0, segmentIndex - 1)] ?? 0;
  const nextMeters = route.cumulativeMeters[segmentIndex] ?? previousMeters;
  const ratio = nextMeters === previousMeters ? 0 : (target - previousMeters) / (nextMeters - previousMeters);
  return {
    latitude: previous.latitude + (next.latitude - previous.latitude) * ratio,
    longitude: previous.longitude + (next.longitude - previous.longitude) * ratio,
    bearing: bearingDegrees(previous.latitude, previous.longitude, next.latitude, next.longitude),
  };
}

function buildStartProbeOffsets(): Array<readonly [number, number]> {
  const offsets: Array<readonly [number, number]> = [[0, 0]];
  for (const radius of [25, 50, 75, 100, 150, 200, 300]) {
    offsets.push(
      [radius, 0],
      [-radius, 0],
      [0, radius],
      [0, -radius],
      [radius, radius],
      [radius, -radius],
      [-radius, radius],
      [-radius, -radius],
    );
  }
  return offsets;
}

function createDriver(index: number): DriverState {
  return {
    sessionId: `550e8400-e29b-41d4-a716-44665544${String(index).padStart(4, "0")}`,
    latitude: driveStartLatitude + index * 0.00015,
    longitude: driveStartLongitude,
    previousLatitude: driveStartLatitude + index * 0.00015,
    previousLongitude: driveStartLongitude,
    speedKmh: 30 + random() * 20,
    course: 0,
    previousCourse: 0,
    tick: 0,
    stopTicksRemaining: 0,
    previousMoving: true,
    previousRoadId: null,
    lastSpeedLimitKmh: null,
    lastRoadType: null,
    lastLimitExceeded: false,
    route,
    routeCursorMeters: 0,
    recentPositions: [{ latitude: driveStartLatitude + index * 0.00015, longitude: driveStartLongitude }],
  };
}

function nextSample(driver: DriverState): DriveSample {
  driver.tick += 1;
  driver.previousLatitude = driver.latitude;
  driver.previousLongitude = driver.longitude;
  driver.previousCourse = driver.course;

  if (driver.stopTicksRemaining > 0) {
    driver.stopTicksRemaining -= 1;
    driver.speedKmh = 0;
  } else {
    if (driver.tick % 28 === 0 || random() < 0.02) {
      driver.stopTicksRemaining = 3 + Math.floor(random() * 6);
      driver.speedKmh = 0;
    } else {
      const targetSpeed = targetSpeedFor(driver);
      const speedDelta = (targetSpeed - driver.speedKmh) * 0.35 + (random() - 0.5) * 10;
      driver.speedKmh = clamp(driver.speedKmh + speedDelta, 8, 118);
    }
  }

  if (driver.speedKmh > 0) {
    if (driver.tick % 17 === 0) driver.course = normalizeBearing(driver.course + 90);
    else if (driver.tick % 29 === 0) driver.course = normalizeBearing(driver.course - 90);
    else if (driver.tick % 43 === 0) driver.course = normalizeBearing(driver.course + 180);
    else if (random() < 0.09) driver.course = normalizeBearing(driver.course + (random() - 0.5) * 24);
  }

  const metersPerSecond = driver.speedKmh / 3.6;
  const stepMeters =
    driver.tick === 1 || driver.speedKmh === 0 ? 0 : Math.max(5, metersPerSecond * (delayMs / 1000 || 1));
  if (driver.route) {
    advanceOnRoute(driver, stepMeters);
  } else {
    const next = moveByMeters(driver.latitude, driver.longitude, driver.course, stepMeters);
    driver.latitude = next.latitude;
    driver.longitude = next.longitude;
  }

  if (!driver.route && (driver.latitude > maxLatitude || driver.latitude < minLatitude)) {
    driver.course = driver.latitude > maxLatitude ? 180 : 0;
    driver.latitude = clamp(driver.latitude, minLatitude, maxLatitude);
  }
  if (!driver.route && (driver.longitude > maxLongitude || driver.longitude < minLongitude)) {
    driver.course = normalizeBearing(360 - driver.course);
    driver.longitude = clamp(driver.longitude, minLongitude, maxLongitude);
  }

  const laneOffset = realProviders ? 0 : random() < 0.04 ? 0.00025 : 0;
  const gpsNoise = driver.tick === 1 ? 0 : (random() - 0.5) * 0.00002;
  if (driver.route && realProviders) {
    const noisy = offsetLatLon(driver.latitude, driver.longitude, 0, gpsNoise * 111_320);
    driver.latitude = noisy.latitude;
    driver.longitude = noisy.longitude;
  } else {
    driver.longitude = clamp(driver.longitude + laneOffset + gpsNoise, minLongitude, maxLongitude);
  }
  rememberDriverPosition(driver);
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

function rememberDriverPosition(driver: DriverState): void {
  const last = driver.recentPositions.at(-1);
  if (!last || distanceMeters(last.latitude, last.longitude, driver.latitude, driver.longitude) >= 8) {
    driver.recentPositions.push({ latitude: driver.latitude, longitude: driver.longitude });
  }
  if (driver.recentPositions.length > 260) driver.recentPositions.splice(0, driver.recentPositions.length - 260);
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

function updateStats(response: RoadContextResponse, sample: DriveSample, driver: DriverState): void {
  if (response.matched) stats.matched += 1;
  else stats.unmatched += 1;
  stats.alerts += response.alerts.length;
  if (response.confidence < 0.5) stats.lowConfidence += 1;
  if (response.speedLimitKmh === null) stats.nullLimits += 1;
  const stepDistance = distanceMeters(
    driver.previousLatitude,
    driver.previousLongitude,
    sample.latitude,
    sample.longitude,
  );
  stats.distanceMeters += stepDistance;
  const sampleSeconds = sampleStepSeconds();
  stats.simulatedSeconds += sampleSeconds;
  if (sample.speedKmh < 1) stats.stoppedSamples += 1;
  else {
    stats.movingSamples += 1;
    stats.movingSeconds += sampleSeconds;
  }
  stats.maxSpeedKmh = Math.max(stats.maxSpeedKmh, sample.speedKmh);
  if (response.roadId) stats.roads.add(response.roadName ?? readableRoadFallback(response.roadType, response.roadId));
  if (response.roadId && driver.previousRoadId && response.roadId !== driver.previousRoadId) stats.roadChanges += 1;
  if (turnDescription(driver.previousCourse, sample.course) !== null) stats.turns += 1;
  if (response.speedLimitKmh !== null && sample.speedKmh > response.speedLimitKmh + 2) stats.speedLimitExceeded += 1;
  const nearest = response.alerts[0]?.distanceMeters;
  if (nearest !== undefined) {
    stats.closestAlertMeters =
      stats.closestAlertMeters === null ? nearest : Math.min(stats.closestAlertMeters, nearest);
  }
  updateAggregates(response, sample, stepDistance);
}

function updateAggregates(response: RoadContextResponse, sample: DriveSample, stepDistance: number): void {
  const nearestAlert = response.alerts[0] ?? null;
  const pathSample: PathSample = {
    iteration: stats.iterations + 1,
    timestamp: sample.timestamp,
    latitude: sample.latitude,
    longitude: sample.longitude,
    speedKmh: sample.speedKmh,
    course: sample.course,
    matched: response.matched,
    roadId: response.roadId,
    roadName: response.roadName,
    roadType: response.roadType,
    speedLimitKmh: response.speedLimitKmh,
    confidence: Number(response.confidence.toFixed(3)),
    nearestAlertType: nearestAlert?.type ?? null,
    nearestAlertMeters: nearestAlert ? Math.round(nearestAlert.distanceMeters) : null,
  };
  stats.pathSamples.push(pathSample);
  if (!response.matched && stats.unmatchedSamples.length < 100) stats.unmatchedSamples.push(pathSample);

  const roadKey = response.matched
    ? response.roadId ?? `${response.roadName ?? "unknown"}:${response.roadType ?? "unknown"}`
    : "unmatched";
  const roadLabel = response.matched
    ? response.roadName ?? readableRoadFallback(response.roadType, response.roadId)
    : "strada non agganciata";
  const roadAggregate =
    stats.roadStats.get(roadKey) ??
    {
      label: roadLabel,
      roadId: response.roadId,
      roadType: response.roadType,
      samples: 0,
      matched: 0,
      unmatched: 0,
      distanceMeters: 0,
      speedLimitExceeded: 0,
      nullLimits: 0,
      alerts: 0,
      maxSpeedKmh: 0,
    };
  roadAggregate.samples += 1;
  if (response.matched) roadAggregate.matched += 1;
  else roadAggregate.unmatched += 1;
  roadAggregate.distanceMeters += stepDistance;
  roadAggregate.alerts += response.alerts.length;
  roadAggregate.maxSpeedKmh = Math.max(roadAggregate.maxSpeedKmh, sample.speedKmh);
  if (response.speedLimitKmh === null) roadAggregate.nullLimits += 1;
  if (response.speedLimitKmh !== null && sample.speedKmh > response.speedLimitKmh + 2) {
    roadAggregate.speedLimitExceeded += 1;
  }
  stats.roadStats.set(roadKey, roadAggregate);

  const limitKey = response.speedLimitKmh === null ? "unknown" : String(response.speedLimitKmh);
  const limitAggregate =
    stats.speedLimitStats.get(limitKey) ??
    {
      speedLimitKmh: response.speedLimitKmh,
      samples: 0,
      distanceMeters: 0,
      exceeded: 0,
      maxSpeedKmh: 0,
    };
  limitAggregate.samples += 1;
  limitAggregate.distanceMeters += stepDistance;
  limitAggregate.maxSpeedKmh = Math.max(limitAggregate.maxSpeedKmh, sample.speedKmh);
  if (response.speedLimitKmh !== null && sample.speedKmh > response.speedLimitKmh + 2) limitAggregate.exceeded += 1;
  stats.speedLimitStats.set(limitKey, limitAggregate);

  for (const alert of response.alerts) {
    const aggregate = stats.alertStats.get(alert.type) ?? {
      type: alert.type,
      count: 0,
      closestMeters: null,
    };
    aggregate.count += 1;
    aggregate.closestMeters =
      aggregate.closestMeters === null ? alert.distanceMeters : Math.min(aggregate.closestMeters, alert.distanceMeters);
    stats.alertStats.set(alert.type, aggregate);
  }
}

function report(event = "drive_soak_progress"): void {
  const elapsedSeconds = Math.max(1, (Date.now() - stats.startedAt) / 1000);
  const payload = summaryPayload(event, elapsedSeconds);
  if (event === "drive_soak_finished") {
    logFinalSummary(payload);
  } else {
    logEvent({
      event,
      message: `Checkpoint: ${payload.kmPercorsi} km, match ${payload.matchRatePct}%, ${payload.superamentiLimite} superamenti limite`,
      details: payload,
    });
  }
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

function randomizeStart(latitude: number, longitude: number, maxMeters: number): {
  latitude: number;
  longitude: number;
} {
  if (maxMeters <= 0) return { latitude, longitude };
  const radius = Math.sqrt(random()) * maxMeters;
  const bearing = random() * 360;
  return moveByMeters(latitude, longitude, bearing, radius);
}

function reportDriveEvent(
  driver: DriverState,
  sample: DriveSample,
  response: RoadContextResponse,
  latencyMs: number,
): void {
  const moving = sample.speedKmh >= 1;
  const stoppedNow = !moving && driver.previousMoving;
  const restartedNow = moving && !driver.previousMoving;
  const turn = turnDescription(driver.previousCourse, sample.course);
  const roadLabel = response.matched
    ? `${response.roadName ?? readableRoadFallback(response.roadType, response.roadId)}${response.roadType ? ` (${response.roadType})` : ""}`
    : "strada non agganciata";
  const limitLabel = response.speedLimitKmh === null ? "limite sconosciuto" : `limite ${response.speedLimitKmh} km/h`;
  const speedStatus =
    response.speedLimitKmh !== null && sample.speedKmh > response.speedLimitKmh + 2
      ? `LIMITE SUPERATO di ${Math.round(sample.speedKmh - response.speedLimitKmh)} km/h`
      : response.speedLimitKmh === null
        ? "limite non verificabile"
        : "velocita ok";
  const nearestAlert = response.alerts[0]
    ? `alert ${response.alerts[0].type} a ${Math.round(response.alerts[0].distanceMeters)} m`
    : "nessun alert vicino";

  const markers = [
    stoppedNow ? "ti sei fermato" : null,
    restartedNow ? "ripartenza" : null,
    turn,
    response.roadId && driver.previousRoadId && response.roadId !== driver.previousRoadId ? "cambio strada" : null,
  ].filter(Boolean);

  logEvent({
    event: "drive_sample",
    message: `${sample.speedKmh.toFixed(0)} km/h, ${roadLabel}, ${limitLabel}, ${speedStatus}, ${nearestAlert}${
      markers.length > 0 ? `, ${markers.join(", ")}` : ""
    }`,
    details: {
      iteration: stats.iterations + 1,
      latitude: sample.latitude,
      longitude: sample.longitude,
      speedKmh: sample.speedKmh,
      course: sample.course,
      matched: response.matched,
      roadId: response.roadId,
      roadName: response.roadName,
      roadType: response.roadType,
      speedLimitKmh: response.speedLimitKmh,
      alerts: response.alerts,
      kmPercorsi: Number((stats.distanceMeters / 1000).toFixed(3)),
      confidence: Number(response.confidence.toFixed(2)),
      direction: response.direction,
      latencyMs: Number(latencyMs.toFixed(1)),
    },
  });

  driver.previousMoving = moving;
  driver.previousRoadId = response.roadId;
  driver.lastSpeedLimitKmh = response.speedLimitKmh;
  driver.lastRoadType = response.roadType;
  driver.lastLimitExceeded = response.speedLimitKmh !== null && sample.speedKmh > response.speedLimitKmh + 2;
}

function targetSpeedFor(driver: DriverState): number {
  const fallbackByRoadType = driver.lastRoadType?.includes("motorway")
    ? 95
    : driver.lastRoadType?.includes("primary")
      ? 70
      : driver.lastRoadType?.includes("secondary")
        ? 60
        : driver.lastRoadType?.includes("residential")
          ? 32
          : 50;
  const baseLimit = driver.lastSpeedLimitKmh ?? fallbackByRoadType;
  const deliberateOverspeed = driver.tick % 19 === 0 || random() < 0.08;
  const slowTraffic = random() < 0.1;
  if (slowTraffic) return Math.max(8, baseLimit * (0.45 + random() * 0.25));
  if (deliberateOverspeed) return baseLimit + 5 + random() * 15;
  return Math.max(8, baseLimit - 8 + random() * 10);
}

function readableRoadFallback(roadType: string | null, roadId?: string | null): string {
  const suffix = roadId ? ` (${roadId})` : "";
  switch (roadType) {
    case "residential":
      return `Strada residenziale senza nome${suffix}`;
    case "unclassified":
      return `Strada locale senza nome${suffix}`;
    case "primary":
      return `Strada primaria senza nome${suffix}`;
    case "secondary":
      return `Strada secondaria senza nome${suffix}`;
    case "tertiary":
      return `Strada terziaria senza nome${suffix}`;
    case "service":
      return `Strada di servizio senza nome${suffix}`;
    case "primary_link":
    case "secondary_link":
    case "tertiary_link":
    case "motorway_link":
    case "trunk_link":
      return `Rampa senza nome${suffix}`;
    default:
      return `Strada senza nome${suffix}`;
  }
}

function summaryPayload(event: string, elapsedSeconds: number): Record<string, unknown> {
  const movingHours = Math.max(0.0001, stats.movingSeconds / 3600);
  const simulatedHours = Math.max(0.0001, stats.simulatedSeconds / 3600);
  const matchRate = stats.iterations > 0 ? (stats.matched / stats.iterations) * 100 : 0;
  return {
    event,
    richieste: stats.iterations,
    fallimenti: stats.failures,
    kmPercorsi: Number((stats.distanceMeters / 1000).toFixed(3)),
    durataRealeMinuti: Number((elapsedSeconds / 60).toFixed(1)),
    tempoGuidaSimulatoMinuti: Number((stats.simulatedSeconds / 60).toFixed(1)),
    velocitaMediaKmh: Number(((stats.distanceMeters / 1000) / simulatedHours).toFixed(1)),
    velocitaMediaInMovimentoKmh: Number(((stats.distanceMeters / 1000) / movingHours).toFixed(1)),
    velocitaMassimaKmh: Number(stats.maxSpeedKmh.toFixed(1)),
    campioniFermo: stats.stoppedSamples,
    campioniInMovimento: stats.movingSamples,
    svolte: stats.turns,
    cambiStrada: stats.roadChanges,
    stradeUniche: stats.roads.size,
    tratteValhalla: stats.routeSegments,
    tratteBreviValhalla: stats.shortRouteSegments,
    matched: stats.matched,
    unmatched: stats.unmatched,
    matchRatePct: Number(matchRate.toFixed(1)),
    confidenceBassa: stats.lowConfidence,
    limitiSconosciuti: stats.nullLimits,
    superamentiLimite: stats.speedLimitExceeded,
    alertTotali: stats.alerts,
    alertPiuVicinoMetri: stats.closestAlertMeters === null ? null : Math.round(stats.closestAlertMeters),
    latenzaMassimaMs: Number(stats.maxLatencyMs.toFixed(1)),
    latenzaMediaMs: stats.iterations > 0 ? Number((stats.totalLatencyMs / stats.iterations).toFixed(1)) : 0,
    richiesteAlSecondo: Number((stats.iterations / elapsedSeconds).toFixed(2)),
    topStrade: topRoads(),
    limiti: speedLimitBreakdown(),
    alertPerTipo: alertBreakdown(),
    unmatchedSamples: stats.unmatchedSamples.slice(0, 20),
    reportEventi: reportPath.eventsPath,
    reportRiepilogo: reportPath.summaryPath,
    reportGeoJson: reportPath.geojsonPath,
    reportGpx: reportPath.gpxPath,
    avvisi: summaryWarnings(matchRate).join("; ") || null,
  };
}

function logFinalSummary(payload: Record<string, unknown>): void {
  writeDriveGeoJson();
  writeDriveGpx();
  writeFileSync(reportPath.summaryPath, `${JSON.stringify(payload, null, 2)}\n`);
  if (outputMode === "json") {
    console.log(JSON.stringify(payload));
    return;
  }
  console.log("");
  console.log("=== Riepilogo guida ===");
  console.log(`Distanza percorsa: ${payload.kmPercorsi} km`);
  console.log(`Tempo guida simulato: ${payload.tempoGuidaSimulatoMinuti} min, durata reale test: ${payload.durataRealeMinuti} min`);
  console.log(`Velocita media: ${payload.velocitaMediaKmh} km/h (${payload.velocitaMediaInMovimentoKmh} km/h in movimento)`);
  console.log(`Velocita massima: ${payload.velocitaMassimaKmh} km/h`);
  console.log(`Campioni: ${payload.richieste}, fallimenti: ${payload.fallimenti}, match rate: ${payload.matchRatePct}%`);
  console.log(`Fermo: ${payload.campioniFermo} campioni, in movimento: ${payload.campioniInMovimento}`);
  console.log(`Svolte: ${payload.svolte}, cambi strada: ${payload.cambiStrada}, strade uniche: ${payload.stradeUniche}`);
  console.log(`Tratte Valhalla: ${payload.tratteValhalla}, tratte troppo brevi: ${payload.tratteBreviValhalla}`);
  if (stats.roads.size > 0) console.log(`Strade viste: ${[...stats.roads].slice(0, 8).join(", ")}`);
  console.log(`Superamenti limite: ${payload.superamentiLimite}, limiti sconosciuti: ${payload.limitiSconosciuti}`);
  console.log(`Alert totali: ${payload.alertTotali}, alert piu vicino: ${payload.alertPiuVicinoMetri ?? "n/d"} m`);
  console.log(`Latenza media/max: ${payload.latenzaMediaMs}/${payload.latenzaMassimaMs} ms`);
  logBreakdowns();
  if (payload.avvisi) console.log(`Avvisi: ${payload.avvisi}`);
  console.log(`Report eventi: ${reportPath.eventsPath}`);
  console.log(`Report riepilogo: ${reportPath.summaryPath}`);
  console.log(`Report GeoJSON: ${reportPath.geojsonPath}`);
  console.log(`Report GPX: ${reportPath.gpxPath}`);
}

function summaryWarnings(matchRate: number): string[] {
  const warnings: string[] = [];
  if (realProviders && stats.iterations >= 100 && stats.roads.size <= 1) {
    warnings.push("copertura bassa: il test ha visto una sola strada");
  }
  if (realProviders && stats.iterations >= 100 && stats.alerts === 0) {
    warnings.push("nessun alert incontrato: percorso senza alert OSM/PostGIS vicini");
  }
  if (realProviders && stats.shortRouteSegments > 0) {
    warnings.push("Valhalla ha restituito almeno una tratta piu corta del target");
  }
  if (matchRate < 95) {
    warnings.push("match rate sotto 95%");
  }
  if (stats.maxLatencyMs > 1000) {
    warnings.push("latenza massima sopra 1 secondo");
  }
  return warnings;
}

function topRoads(): Array<Record<string, string | number | null>> {
  return [...stats.roadStats.values()]
    .sort((left, right) => right.distanceMeters - left.distanceMeters)
    .slice(0, 20)
    .map((road) => ({
      label: road.label,
      roadId: road.roadId,
      roadType: road.roadType,
      samples: road.samples,
      matched: road.matched,
      unmatched: road.unmatched,
      km: Number((road.distanceMeters / 1000).toFixed(3)),
      speedLimitExceeded: road.speedLimitExceeded,
      nullLimits: road.nullLimits,
      alerts: road.alerts,
      maxSpeedKmh: Number(road.maxSpeedKmh.toFixed(1)),
    }));
}

function speedLimitBreakdown(): Array<Record<string, string | number | null>> {
  return [...stats.speedLimitStats.values()]
    .sort((left, right) => {
      if (left.speedLimitKmh === null) return 1;
      if (right.speedLimitKmh === null) return -1;
      return left.speedLimitKmh - right.speedLimitKmh;
    })
    .map((limit) => ({
      speedLimitKmh: limit.speedLimitKmh,
      samples: limit.samples,
      km: Number((limit.distanceMeters / 1000).toFixed(3)),
      exceeded: limit.exceeded,
      maxSpeedKmh: Number(limit.maxSpeedKmh.toFixed(1)),
    }));
}

function alertBreakdown(): Array<Record<string, string | number | null>> {
  return [...stats.alertStats.values()]
    .sort((left, right) => right.count - left.count)
    .map((alert) => ({
      type: alert.type,
      count: alert.count,
      closestMeters: alert.closestMeters === null ? null : Math.round(alert.closestMeters),
    }));
}

function logBreakdowns(): void {
  const roads = topRoads().slice(0, 5);
  if (roads.length > 0) {
    console.log("Top strade:");
    for (const road of roads) {
      console.log(
        `- ${road.label}: ${road.km} km, campioni ${road.samples}, superamenti ${road.speedLimitExceeded}, alert ${road.alerts}`,
      );
    }
  }
  const limits = speedLimitBreakdown();
  if (limits.length > 0) {
    console.log(
      `Limiti visti: ${limits
        .map((limit) => `${limit.speedLimitKmh ?? "n/d"} km/h (${limit.samples} campioni, ${limit.exceeded} over)`)
        .join(", ")}`,
    );
  }
  const alerts = alertBreakdown();
  if (alerts.length > 0) {
    console.log(
      `Alert per tipo: ${alerts
        .map((alert) => `${alert.type}: ${alert.count} (min ${alert.closestMeters ?? "n/d"} m)`)
        .join(", ")}`,
    );
  }
}

function writeDriveGeoJson(): void {
  const features = [
    {
      type: "Feature",
      properties: {
        type: "drive_path",
        samples: stats.pathSamples.length,
        distanceMeters: Math.round(stats.distanceMeters),
      },
      geometry: {
        type: "LineString",
        coordinates: stats.pathSamples.map((sample) => [sample.longitude, sample.latitude]),
      },
    },
    ...stats.pathSamples.map((sample) => ({
      type: "Feature",
      properties: {
        type: "sample",
        iteration: sample.iteration,
        timestamp: sample.timestamp,
        speedKmh: sample.speedKmh,
        course: sample.course,
        matched: sample.matched,
        roadId: sample.roadId,
        roadName: sample.roadName,
        roadType: sample.roadType,
        speedLimitKmh: sample.speedLimitKmh,
        confidence: sample.confidence,
        nearestAlertType: sample.nearestAlertType,
        nearestAlertMeters: sample.nearestAlertMeters,
      },
      geometry: {
        type: "Point",
        coordinates: [sample.longitude, sample.latitude],
      },
    })),
  ];
  writeFileSync(
    reportPath.geojsonPath,
    `${JSON.stringify({ type: "FeatureCollection", features }, null, 2)}\n`,
  );
}

function writeDriveGpx(): void {
  const points = stats.pathSamples
    .map(
      (sample) =>
        `    <trkpt lat="${sample.latitude.toFixed(6)}" lon="${sample.longitude.toFixed(6)}"><time>${escapeXml(sample.timestamp)}</time><name>${sample.iteration}</name><desc>${escapeXml(
          `${sample.speedKmh} km/h ${sample.roadName ?? sample.roadId ?? "unmatched"}`,
        )}</desc></trkpt>`,
    )
    .join("\n");
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="motorcycle-road-assistant-backend" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>drive-soak-${seed}</name>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>
`;
  writeFileSync(reportPath.gpxPath, gpx);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function logEvent(
  payload: { event: string; message: string; details?: Record<string, unknown> },
  stream: "log" | "error" = "log",
  printToTerminal = true,
): void {
  reportStream.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      event: payload.event,
      message: payload.message,
      ...(payload.details ?? {}),
    })}\n`,
  );
  if (outputMode === "json") {
    const writer = stream === "error" ? console.error : console.log;
    if (printToTerminal) writer(JSON.stringify({ event: payload.event, ...(payload.details ?? {}), message: payload.message }));
    return;
  }
  if (!printToTerminal) return;
  const writer = stream === "error" ? console.error : console.log;
  writer(`[${new Date().toLocaleTimeString("it-IT")}] ${payload.message}`);
}

function createReportPath(directory: string, seedValue: number): {
  eventsPath: string;
  summaryPath: string;
  geojsonPath: string;
  gpxPath: string;
} {
  const absoluteDirectory = path.resolve(directory);
  mkdirSync(absoluteDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = `drive-${stamp}-${seedValue}`;
  return {
    eventsPath: path.join(absoluteDirectory, `${baseName}.jsonl`),
    summaryPath: path.join(absoluteDirectory, `${baseName}.summary.json`),
    geojsonPath: path.join(absoluteDirectory, `${baseName}.geojson`),
    gpxPath: path.join(absoluteDirectory, `${baseName}.gpx`),
  };
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values.map((value) => Math.round(value)).filter((value) => value > 0))];
}

function sampleStepSeconds(): number {
  return Math.max(1, delayMs / 1000 || 1);
}

function turnDescription(previousCourse: number, currentCourse: number | null): string | null {
  if (currentCourse === null) return null;
  const delta = signedAngleDelta(previousCourse, currentCourse);
  if (Math.abs(delta) < 45) return null;
  if (Math.abs(delta) >= 135) return "inversione";
  return delta > 0 ? "hai girato a destra" : "hai girato a sinistra";
}

function signedAngleDelta(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

function normalizeBearing(value: number): number {
  return ((value % 360) + 360) % 360;
}

function moveByMeters(latitude: number, longitude: number, bearing: number, meters: number): {
  latitude: number;
  longitude: number;
} {
  const radians = (bearing * Math.PI) / 180;
  const northMeters = Math.cos(radians) * meters;
  const eastMeters = Math.sin(radians) * meters;
  return {
    latitude: latitude + northMeters / 111_320,
    longitude: longitude + eastMeters / (111_320 * Math.cos((latitude * Math.PI) / 180)),
  };
}

function offsetLatLon(latitude: number, longitude: number, northMeters: number, eastMeters: number): {
  latitude: number;
  longitude: number;
} {
  return {
    latitude: latitude + northMeters / 111_320,
    longitude: longitude + eastMeters / (111_320 * Math.cos((latitude * Math.PI) / 180)),
  };
}

function bearingDegrees(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const lambda1 = (lon1 * Math.PI) / 180;
  const lambda2 = (lon2 * Math.PI) / 180;
  const y = Math.sin(lambda2 - lambda1) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(lambda2 - lambda1);
  return normalizeBearing((Math.atan2(y, x) * 180) / Math.PI);
}

function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radius = 6_371_000;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(deltaPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
