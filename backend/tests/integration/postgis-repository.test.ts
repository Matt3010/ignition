import { PostgisAlertRepository } from "../../src/infrastructure/repositories/postgis-alert-repository.js";

describe("PostGIS alert repository", () => {
  it("uses spatial query and parameterized values", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const repository = new PostgisAlertRepository({
      query: async (sql: string, values: unknown[]) => {
        calls.push({ sql, values });
        return { rows: [] };
      },
    } as any);
    await repository.findNearby({
      latitude: 45,
      longitude: 11,
      radiusMeters: 1000,
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(calls[0].sql).toContain("ST_DWithin");
    expect(calls[0].sql).toContain("ST_DistanceSphere");
    expect(calls[0].values).toEqual([11, 45, 1000, new Date("2026-01-01T00:00:00Z")]);
  });
});
