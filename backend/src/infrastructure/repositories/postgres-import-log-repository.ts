import type pg from "pg";
import type { ImportLogRepository } from "../../application/ports/import-log-repository.js";

export class PostgresImportLogRepository implements ImportLogRepository {
  constructor(private readonly pool: pg.Pool) {}

  async record(input: {
    source: string;
    version: string;
    status: "success" | "failed";
    recordsCount: number;
    errorMessage?: string | null;
  }): Promise<void> {
    await this.pool.query(
      `
      insert into data_imports (source, version, imported_at, status, records_count, error_message)
      values ($1, $2, now(), $3, $4, $5)
      `,
      [input.source, input.version, input.status, input.recordsCount, input.errorMessage ?? null],
    );
  }
}
