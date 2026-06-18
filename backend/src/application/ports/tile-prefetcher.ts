import type { GpsSample } from "../../domain/models/road-context.js";

export interface TilePrefetchStatus {
  enabled: boolean;
  queued: number;
  running: boolean;
  completed: number;
  skipped: number;
  failed: number;
  lastRegion: string | null;
  lastBbox: string | null;
  lastTileDir: string | null;
  lastDownloadedAt: string | null;
  lastBuiltAt: string | null;
  lastImportStatus: string | null;
  lastImportAt: string | null;
  lastImportRecords: number | null;
  lastImportDeactivated: number | null;
  lastError: string | null;
  updatedAt: string | null;
}

export interface TilePrefetcher {
  ensureCurrent(sample: GpsSample): Promise<void>;
  enqueueLookahead(sample: GpsSample): void;
  status(): TilePrefetchStatus;
}
