import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = resolve(process.cwd(), "scripts/import-osm-alerts.ts");

describe("OSM alert import pipeline", () => {
  it("streams parsed alert batches directly into PostGIS staging", async () => {
    const script = await readFile(scriptPath, "utf8");

    expect(script).toContain("parseOsmAlertsFromReadable");
    expect(script).toContain("PostgisAlertImportRepository");
    expect(script).toContain("syncAlertBatchesViaStaging");
    expect(script).toContain("parseAlertBatches");
    expect(script).not.toContain("readFile(");
    expect(script).not.toContain("parsedFiles");
    expect(script).not.toContain("alertsById");
  });
});
