import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const backendRoot = resolve(import.meta.dirname, "../..");
const read = (relativePath: string): string =>
  readFileSync(resolve(backendRoot, relativePath), "utf8");

describe("OSM refresh resilience", () => {
  it("resumes partial downloads and avoids a fixed wall-clock timeout", () => {
    const script = read("scripts/download-osm-extract.sh");

    expect(script).toContain("--continue-at -");
    expect(script).not.toContain("--max-time");
    expect(script).not.toContain("OSM_DOWNLOAD_MAX_TIME_SECONDS");
    expect(script).toContain("osm_download_interrupted");
    expect(script).toContain("retained partial download");
  });

  it("only claims prepared OSM reuse after validating every configured region", () => {
    const script = read("scripts/refresh-osm.sh");

    expect(script).toContain("prepared_osm_available");
    expect(script).toContain("osmium fileinfo");
    expect(script).toContain("osm_refresh_staging_without_valid_osm");
  });

  it("retries failed refreshes sooner than the normal scheduled interval", () => {
    const script = read("scripts/osm-refresh-loop.sh");

    expect(script).toContain("OSM_REFRESH_FAILURE_RETRY_INITIAL_SECONDS");
    expect(script).toContain("OSM_REFRESH_FAILURE_RETRY_MAX_SECONDS");
    expect(script).toContain("failure_delay=$((failure_delay * 2))");
    expect(script).toContain("osm_refresh_waiting");
  });
});
