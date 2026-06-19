import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "../../config/env.js";
import type { TilePrefetcher, TilePrefetchStatus } from "../../application/ports/tile-prefetcher.js";
import type { GpsSample } from "../../domain/models/road-context.js";
import { TtlCache } from "../../domain/services/cache.js";
import { planTilePrefetch, type TilePrefetchPlanItem } from "../../domain/services/tile-prefetch-planner.js";

const execFileAsync = promisify(execFile);

export class NoopTilePrefetcher implements TilePrefetcher {
  status(): TilePrefetchStatus {
    return {
      enabled: false,
      queued: 0,
      running: false,
      completed: 0,
      skipped: 0,
      failed: 0,
      lastRegion: null,
      lastBbox: null,
      lastTileDir: null,
      lastDownloadedAt: null,
      lastBuiltAt: null,
      lastImportStatus: null,
      lastImportAt: null,
      lastImportRecords: null,
      lastImportDeactivated: null,
      lastError: null,
      updatedAt: null,
    };
  }

  async ensureCurrent(): Promise<void> {
    // Disabled by configuration.
  }

  enqueueLookahead(): void {
    // Disabled by configuration.
  }
}

export class LocalScriptTilePrefetcher implements TilePrefetcher {
  private readonly recentlyQueued: TtlCache<string, true>;
  private readonly queue: TilePrefetchPlanItem[] = [];
  private running = false;
  private completed = 0;
  private skipped = 0;
  private failed = 0;
  private lastRegion: string | null = null;
  private lastError: string | null = null;
  private updatedAt: string | null = null;
  private cleanupRunning = false;
  private lastCleanupAt = 0;

  constructor(private readonly config: AppConfig) {
    this.recentlyQueued = new TtlCache(config.TILE_PREFETCH_MIN_INTERVAL_SECONDS * 1000);
  }

  async ensureCurrent(sample: GpsSample): Promise<void> {
    this.maybeCleanup();
    const [currentPlan] = this.plan(sample, 0);
    if (!currentPlan) return;
    if (this.recentlyQueued.get(currentPlan.region)) return;
    if (this.queue.some((queued) => queued.region === currentPlan.region)) return;
    this.recentlyQueued.set(currentPlan.region, true);
    this.queue.unshift(currentPlan);
    void this.drain();
  }

  enqueueLookahead(sample: GpsSample): void {
    this.maybeCleanup();
    const plans = this.plan(sample, this.config.TILE_PREFETCH_LOOKAHEAD_CHUNKS).slice(1);

    for (const plan of plans) {
      if (this.recentlyQueued.get(plan.region)) {
        this.skipped += 1;
        continue;
      }
      if (this.queue.some((queued) => queued.region === plan.region)) {
        this.skipped += 1;
        continue;
      }
      if (this.queue.length >= this.config.TILE_PREFETCH_MAX_QUEUE) {
        this.skipped += 1;
        continue;
      }
      this.recentlyQueued.set(plan.region, true);
      this.queue.push(plan);
    }

    void this.drain();
  }

  private plan(sample: GpsSample, lookaheadChunks: number): TilePrefetchPlanItem[] {
    return planTilePrefetch(sample, {
      prefix: this.config.TILE_PREFETCH_OSM_PREFIX,
      halfLat: this.config.TILE_PREFETCH_HALF_LAT,
      halfLon: this.config.TILE_PREFETCH_HALF_LON,
      gridDegrees: this.config.TILE_PREFETCH_GRID_DEGREES,
      lookaheadChunks,
      lookaheadMeters: this.config.TILE_PREFETCH_LOOKAHEAD_METERS,
    });
  }

  status(): TilePrefetchStatus {
    const tileDir = this.lastRegion ? path.resolve(this.config.TILE_PREFETCH_TILE_ROOT, this.lastRegion) : null;
    const metadata = tileDir ? readPrefetchMetadata(tileDir) : null;
    return {
      enabled: true,
      queued: this.queue.length,
      running: this.running,
      completed: this.completed,
      skipped: this.skipped,
      failed: this.failed,
      lastRegion: this.lastRegion,
      lastBbox: metadata?.bbox ?? null,
      lastTileDir: tileDir,
      lastDownloadedAt: metadata?.downloadedAt ?? null,
      lastBuiltAt: metadata?.builtAt ?? null,
      lastImportStatus: metadata?.lastImport?.status ?? null,
      lastImportAt: metadata?.lastImport?.at ?? null,
      lastImportRecords: metadata?.lastImport?.records ?? null,
      lastImportDeactivated: metadata?.lastImport?.deactivated ?? null,
      lastError: this.lastError,
      updatedAt: this.updatedAt,
    };
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const plan = this.queue.shift();
        if (!plan) continue;
        await this.runPlan(plan);
      }
    } finally {
      this.running = false;
      this.updatedAt = new Date().toISOString();
    }
  }

  private async runPlan(plan: TilePrefetchPlanItem): Promise<void> {
    this.lastRegion = plan.region;
    this.updatedAt = new Date().toISOString();
    const tileDir = path.resolve(this.config.TILE_PREFETCH_TILE_ROOT, plan.region);
    const hostTileDir = this.config.TILE_PREFETCH_HOST_TILE_ROOT
      ? path.resolve(this.config.TILE_PREFETCH_HOST_TILE_ROOT, plan.region)
      : "";
    try {
      await execFileAsync("bash", [this.config.TILE_PREFETCH_SCRIPT], {
        env: {
          ...process.env,
          OSM_HOST_DATA_DIR: this.config.OSM_HOST_DATA_DIR ?? "",
          OSM_REGION: plan.region,
          OSM_BBOX: plan.bbox,
          VALHALLA_TILE_DIR: tileDir,
          VALHALLA_BUILD_HOST_TILE_DIR: hostTileDir,
          VALHALLA_ACTIVE_TILE_DIR: this.config.VALHALLA_ACTIVE_TILE_DIR ?? "",
          VALHALLA_HOST_TILE_DIR: this.config.VALHALLA_HOST_TILE_DIR ?? "",
          VALHALLA_CONTAINER_NAME: this.config.VALHALLA_CONTAINER_NAME ?? "",
          TILE_PREFETCH_RESTART_VALHALLA: String(this.config.TILE_PREFETCH_RESTART_VALHALLA),
          TILE_PREFETCH_IMPORT_ALERTS: String(this.config.TILE_PREFETCH_IMPORT_ALERTS),
          TILE_PREFETCH_MAX_AGE_HOURS: String(this.config.TILE_PREFETCH_MAX_AGE_HOURS),
          TILE_PREFETCH_RETRIES: String(this.config.TILE_PREFETCH_RETRIES),
          TILE_PREFETCH_RETRY_DELAY_SECONDS: String(this.config.TILE_PREFETCH_RETRY_DELAY_SECONDS),
          TILE_PREFETCH_LOCK_TIMEOUT_SECONDS: String(this.config.TILE_PREFETCH_LOCK_TIMEOUT_SECONDS),
          TILE_PREFETCH_DRY_RUN: process.env.TILE_PREFETCH_DRY_RUN ?? "false",
        },
        timeout: this.config.REQUEST_TIMEOUT_MS * 120,
        maxBuffer: 1024 * 1024 * 8,
      });
      this.completed += 1;
      this.lastError = null;
    } catch (error) {
      this.failed += 1;
      this.lastError = error instanceof Error ? error.message : "Unknown tile prefetch error";
      this.recentlyQueued.delete(plan.region);
      console.error(
        JSON.stringify({
          event: "tile_prefetch_failed",
          region: plan.region,
          bbox: plan.bbox,
          error: this.lastError,
        }),
      );
    } finally {
      this.updatedAt = new Date().toISOString();
    }
  }

  private maybeCleanup(): void {
    const now = Date.now();
    if (this.cleanupRunning) return;
    if (now - this.lastCleanupAt < this.config.TILE_PREFETCH_CLEANUP_INTERVAL_SECONDS * 1000) return;
    this.cleanupRunning = true;
    this.lastCleanupAt = now;
    const protectedRegions = new Set(this.queue.map((queued) => queued.region));
    if (this.running && this.lastRegion) protectedRegions.add(this.lastRegion);
    void cleanupPrefetchStorage(this.config, protectedRegions)
      .catch((error) => {
        console.error(
          JSON.stringify({
            event: "tile_prefetch_cleanup_failed",
            error: error instanceof Error ? error.message : "Unknown cleanup error",
          }),
        );
      })
      .finally(() => {
        this.cleanupRunning = false;
        this.updatedAt = new Date().toISOString();
      });
  }
}

interface PrefetchMetadata {
  bbox?: string;
  tileDir?: string;
  downloadedAt?: string;
  builtAt?: string;
  lastImport?: {
    status?: string;
    at?: string;
    records?: number | null;
    deactivated?: number | null;
  };
}

function readPrefetchMetadata(tileDir: string): PrefetchMetadata | null {
  const file = path.join(tileDir, "prefetch-meta.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as PrefetchMetadata;
  } catch {
    return null;
  }
}

interface PrefetchChunkCandidate {
  region: string;
  tileDir: string;
  timestampMs: number;
  ageHours: number;
  protected: boolean;
}

async function cleanupPrefetchStorage(config: AppConfig, protectedRegions: Set<string>): Promise<void> {
  const root = path.resolve(config.TILE_PREFETCH_TILE_ROOT);
  const activeDirs = [config.VALHALLA_TILE_DIR, config.VALHALLA_ACTIVE_TILE_DIR]
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(value));
  if (activeDirs.includes(root)) {
    console.error(
      JSON.stringify({
        event: "tile_prefetch_cleanup_skipped",
        reason: "prefetch_root_is_active_valhalla_dir",
        root,
      }),
    );
    return;
  }

  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const now = Date.now();
  const candidates: PrefetchChunkCandidate[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const tileDir = path.join(root, entry.name);
    const metadata = readPrefetchMetadata(tileDir);
    const stats = await stat(tileDir);
    const timestampMs = parseMetadataTimestamp(metadata) ?? stats.mtimeMs;
    candidates.push({
      region: metadata?.region ?? entry.name,
      tileDir,
      timestampMs,
      ageHours: (now - timestampMs) / 36e5,
      protected: protectedRegions.has(metadata?.region ?? entry.name),
    });
  }

  const deleted = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.protected) continue;
    if (candidate.ageHours <= config.TILE_PREFETCH_RETENTION_HOURS) continue;
    await deletePrefetchChunk(config, candidate, "expired");
    deleted.add(candidate.region);
  }

  const remaining = candidates
    .filter((candidate) => !deleted.has(candidate.region))
    .sort((left, right) => right.timestampMs - left.timestampMs);
  let storedCount = remaining.length;
  for (const candidate of [...remaining].reverse()) {
    if (storedCount <= config.TILE_PREFETCH_MAX_STORED_CHUNKS) break;
    if (candidate.protected) continue;
    await deletePrefetchChunk(config, candidate, "max_stored_chunks");
    storedCount -= 1;
  }
}

async function deletePrefetchChunk(
  config: AppConfig,
  candidate: PrefetchChunkCandidate,
  reason: "expired" | "max_stored_chunks",
): Promise<void> {
  await rm(candidate.tileDir, { recursive: true, force: true });
  const osmFiles = [
    path.resolve(config.OSM_DATA_DIR, `${candidate.region}.osm`),
    path.resolve(config.OSM_DATA_DIR, `${candidate.region}.osm.pbf`),
  ];
  for (const file of osmFiles) {
    await rm(file, { force: true });
  }
  console.log(
    JSON.stringify({
      event: "tile_prefetch_cleanup_deleted",
      reason,
      region: candidate.region,
      tileDir: candidate.tileDir,
      ageHours: Number(candidate.ageHours.toFixed(2)),
      osmFiles,
    }),
  );
}

function parseMetadataTimestamp(metadata: PrefetchMetadata | null): number | null {
  const value = metadata?.builtAt ?? metadata?.downloadedAt;
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
