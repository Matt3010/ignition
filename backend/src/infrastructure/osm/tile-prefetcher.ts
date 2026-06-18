import { execFile } from "node:child_process";
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

  constructor(private readonly config: AppConfig) {
    this.recentlyQueued = new TtlCache(config.TILE_PREFETCH_MIN_INTERVAL_SECONDS * 1000);
  }

  async ensureCurrent(sample: GpsSample): Promise<void> {
    const [currentPlan] = this.plan(sample, 0);
    if (!currentPlan) return;
    if (this.recentlyQueued.get(currentPlan.region)) return;
    this.recentlyQueued.set(currentPlan.region, true);
    await this.runPlan(currentPlan, true);
  }

  enqueueLookahead(sample: GpsSample): void {
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
    return {
      enabled: true,
      queued: this.queue.length,
      running: this.running,
      completed: this.completed,
      skipped: this.skipped,
      failed: this.failed,
      lastRegion: this.lastRegion,
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
        await this.runPlan(plan, false);
      }
    } finally {
      this.running = false;
      this.updatedAt = new Date().toISOString();
    }
  }

  private async runPlan(plan: TilePrefetchPlanItem, throwOnFailure: boolean): Promise<void> {
    this.lastRegion = plan.region;
    this.updatedAt = new Date().toISOString();
    const tileDir = path.resolve(this.config.TILE_PREFETCH_TILE_ROOT, plan.region);
    try {
      await execFileAsync("bash", [this.config.TILE_PREFETCH_SCRIPT], {
        env: {
          ...process.env,
          OSM_REGION: plan.region,
          OSM_BBOX: plan.bbox,
          VALHALLA_TILE_DIR: tileDir,
          TILE_PREFETCH_RESTART_VALHALLA: String(this.config.TILE_PREFETCH_RESTART_VALHALLA),
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
      if (throwOnFailure) throw error;
    } finally {
      this.updatedAt = new Date().toISOString();
    }
  }
}
