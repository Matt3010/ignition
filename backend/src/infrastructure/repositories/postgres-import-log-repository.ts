import type pg from "pg";
import type { ImportLogRepository } from "../../application/ports/import-log-repository.js";

export class PostgresImportLogRepository implements ImportLogRepository {
  constructor(private readonly pool: pg.Pool) {}

  async record(input: {
    source: string;
    version: string;
    status: "success" | "failed";
    recordsCount: number;
    bbox?: string | null;
    filePath?: string | null;
    deactivatedCount?: number;
    errorMessage?: string | null;
  }): Promise<void> {
    await this.pool.query(
      `
      insert into data_imports (
        source, version, imported_at, status, records_count, bbox, file_path, deactivated_count, error_message
      )
      values ($1, $2, now(), $3, $4, $5, $6, $7, $8)
      `,
      [
        input.source,
        input.version,
        input.status,
        input.recordsCount,
        input.bbox ?? null,
        input.filePath ?? null,
        input.deactivatedCount ?? 0,
        input.errorMessage ?? null,
      ],
    );
  }
}
