import { PostgisAlertRepository } from "../../src/infrastructure/repositories/postgis-alert-repository.js";
import type pg from "pg";

function repository(row: Record<string, unknown>) {
  const pool = { query: async () => ({ rows: [row] }) } as unknown as pg.Pool;
  return new PostgisAlertRepository(pool);
}

describe("alert dataset status", () => {
  it("is available whenever usable alerts exist", async () => {
    await expect(repository({ active_count: 4, import_status: "failed", imported_records: 0 }).getDatasetStatus())
      .resolves.toBe("available");
  });

  it("is empty only after a successful zero-record import", async () => {
    await expect(repository({ active_count: 0, import_status: "success", imported_records: 0 }).getDatasetStatus())
      .resolves.toBe("empty");
  });

  it.each([
    { active_count: 0, import_status: null, imported_records: null },
    { active_count: 0, import_status: "failed", imported_records: 0 },
    { active_count: 0, import_status: "success", imported_records: 12 },
  ])("is unavailable for never-run, failed, or inconsistent imports: %o", async (row) => {
    await expect(repository(row).getDatasetStatus()).resolves.toBe("unavailable");
  });
});
