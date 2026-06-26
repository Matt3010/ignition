import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = resolve(process.cwd(), "scripts/refresh-osm.sh");

describe("OSM refresh tile activation portability", () => {
  it("does not use hard links for the rollback snapshot", async () => {
    const script = await readFile(scriptPath, "utf8");

    expect(script).not.toMatch(/\bcp\s+-[^\n]*l/);
    expect(script).not.toContain("cp -al");
  });

  it("moves active tiles to the rollback directory before activating staging", async () => {
    const script = await readFile(scriptPath, "utf8");
    const snapshotStart = script.indexOf("snapshot_current_tiles() {");
    const activationStart = script.indexOf("activate_staging_tiles() {");
    const rollbackStart = script.indexOf("rollback_tiles() {");

    expect(snapshotStart).toBeGreaterThanOrEqual(0);
    expect(activationStart).toBeGreaterThan(snapshotStart);
    expect(rollbackStart).toBeGreaterThan(activationStart);

    const snapshot = script.slice(snapshotStart, activationStart);
    const activation = script.slice(activationStart, rollbackStart);

    expect(snapshot).toContain(
      'move_directory_contents "$VALHALLA_TILE_DIR" "$VALHALLA_PREVIOUS_TILE_DIR"',
    );
    expect(activation).toContain(
      'move_directory_contents "$VALHALLA_STAGING_TILE_DIR" "$VALHALLA_TILE_DIR"',
    );
    expect(activation).not.toContain('clear_directory "$VALHALLA_TILE_DIR"');
  });
  it("escalates cleanup through the Valhalla image for container-owned files", async () => {
    const script = await readFile(scriptPath, "utf8");

    expect(script).toContain("clear_directory_as_root() {");
    expect(script).toContain("--user 0:0");
    expect(script).toContain('-v "$directory:/cleanup"');
    expect(script).toContain('remove_directory "$VALHALLA_PREVIOUS_TILE_DIR"');
    expect(script).toContain('remove_directory "$VALHALLA_FAILED_TILE_DIR"');
    expect(script).not.toContain('rm -rf "$VALHALLA_PREVIOUS_TILE_DIR" "$VALHALLA_FAILED_TILE_DIR"');
  });

  it("removes rollback and failed tile directories only after metadata validation succeeds", async () => {
    const script = await readFile(scriptPath, "utf8");
    const metadataFailure = script.indexOf("valhalla_metadata");
    const previousCleanup = script.indexOf('remove_directory "$VALHALLA_PREVIOUS_TILE_DIR"');
    const failedCleanup = script.indexOf('remove_directory "$VALHALLA_FAILED_TILE_DIR"');
    const osmExtractCleanup = script.lastIndexOf("cleanup_unconfigured_osm_extracts");
    const finished = script.indexOf("osm_refresh_finished");

    expect(metadataFailure).toBeGreaterThanOrEqual(0);
    expect(previousCleanup).toBeGreaterThan(metadataFailure);
    expect(failedCleanup).toBeGreaterThan(previousCleanup);
    expect(osmExtractCleanup).toBeGreaterThan(failedCleanup);
    expect(finished).toBeGreaterThan(osmExtractCleanup);
  });

  it("removes OSM extracts that are not part of the configured region set", async () => {
    const script = await readFile(scriptPath, "utf8");

    expect(script).toContain("cleanup_unconfigured_osm_extracts() {");
    expect(script).toContain('"$OSM_DATA_DIR"/*.osm.pbf "$OSM_DATA_DIR"/*.alerts.osm');
    expect(script).toContain('*.download.osm.pbf) stale_region="${basename%.download.osm.pbf}"');
    expect(script).toContain('*.alerts.osm) stale_region="${basename%.alerts.osm}"');
    expect(script).toContain('*.osm.pbf) stale_region="${basename%.osm.pbf}"');
    expect(script).toContain("osm_unconfigured_extract_removed");
  });

});
