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

  it("uses five days as the default successful refresh interval", () => {
    const script = read("scripts/osm-refresh-loop.sh");
    const backendCompose = read("docker-compose.yml");
    const registryCompose = read("docker-compose.registry.yml");

    expect(script).toContain('OSM_REFRESH_INTERVAL_SECONDS="${OSM_REFRESH_INTERVAL_SECONDS:-432000}"');
    expect(backendCompose).toContain("${OSM_REFRESH_INTERVAL_SECONDS:-432000}");
    expect(registryCompose).toContain("${OSM_REFRESH_INTERVAL_SECONDS:-432000}");
  });

  it("retries failed refreshes sooner than the normal scheduled interval", () => {
    const script = read("scripts/osm-refresh-loop.sh");

    expect(script).toContain("OSM_REFRESH_FAILURE_RETRY_INITIAL_SECONDS");
    expect(script).toContain("OSM_REFRESH_FAILURE_RETRY_MAX_SECONDS");
    expect(script).toContain("failure_delay=$((failure_delay * 2))");
    expect(script).toContain("osm_refresh_waiting");
  });

  it("persists OSM refresh logs to the reports directory", () => {
    const script = read("scripts/osm-refresh-loop.sh");
    const backendCompose = read("docker-compose.yml");
    const registryCompose = read("docker-compose.registry.yml");
    const deployCompose = read("../server-deploy/docker-compose.yml");

    expect(script).toContain("OSM_REFRESH_LOG_FILE");
    expect(script).toContain("tee -a");
    expect(script).toContain("osm_refresh_file_logging_enabled");
    expect(script).toContain("OSM_REFRESH_INTEGRITY_CHECK_INTERVAL_SECONDS");
    for (const compose of [backendCompose, registryCompose, deployCompose]) {
      expect(compose).toContain("OSM_REFRESH_LOG_DIR: /app/reports/osm-refresh");
      expect(compose).toContain("- ./reports:/app/reports");
    }
  });
});
