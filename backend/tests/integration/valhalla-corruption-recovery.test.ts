import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const backendRoot = resolve(import.meta.dirname, "../..");
const script = readFileSync(
  resolve(backendRoot, "scripts/build-valhalla-tiles.sh"),
  "utf8",
);
const bashAvailable = spawnSync("bash", ["-lc", "true"], { encoding: "utf8" }).status === 0;
const describeWithBash = bashAvailable ? describe : describe.skip;

function bashPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const drive = normalized.match(/^([A-Za-z]):\/(.*)$/);
  return drive ? `/${drive[1].toLowerCase()}/${drive[2]}` : normalized;
}

function recoveryFunction(): string {
  const match = script.match(
    /recover_corrupted_graph_tiles\(\) \{[\s\S]*?\n\}/,
  );
  if (!match) {
    throw new Error("recover_corrupted_graph_tiles function not found");
  }
  return match[0];
}

function coreDumpCleanupFunction(): string {
  const match = script.match(
    /cleanup_core_dumps\(\) \{[\s\S]*?\n\}/,
  );
  if (!match) {
    throw new Error("cleanup_core_dumps function not found");
  }
  return match[0];
}

function failedBuildRecoveryFunctions(): string {
  const corruptedMatch = script.match(
    /recover_corrupted_graph_tiles\(\) \{[\s\S]*?\n\}/,
  );
  const nativeMatch = script.match(
    /recover_failed_build_stage\(\) \{[\s\S]*?\n\}/,
  );
  if (!corruptedMatch || !nativeMatch) {
    throw new Error("build recovery functions not found");
  }
  return `${corruptedMatch[0]}\n\n${nativeMatch[0]}`;
}

describeWithBash("Valhalla graph-tile corruption recovery", () => {
  it("removes Valhalla core dumps without touching graph data", () => {
    const root = mkdtempSync(join(tmpdir(), "valhalla-core-dumps-"));
    writeFileSync(join(root, "core"), "dump");
    writeFileSync(join(root, "core.1"), "dump");
    writeFileSync(join(root, "ways.bin"), "ways");

    const harness = `set -euo pipefail
VALHALLA_TILE_DIR_ABS="$1"
json_number() { [[ "$1" =~ ^[0-9]+$ ]] && printf '%s' "$1" || printf '0'; }
${coreDumpCleanupFunction()}
cleanup_core_dumps
`;
    execFileSync("bash", ["-c", harness, "bash", bashPath(root)], {
      stdio: "pipe",
    });

    expect(() => readFileSync(join(root, "core"))).toThrow();
    expect(() => readFileSync(join(root, "core.1"))).toThrow();
    expect(() => readFileSync(join(root, "ways.bin"))).not.toThrow();
  });

  it("detects the Valhalla offset-mismatch corruption error", () => {
    expect(script).toContain("recover_corrupted_graph_tiles() {");
    expect(script).toContain("Mismatch in end offset =");
    expect(script).toContain("Invalid tile data size = 0");
    expect(script).toContain("GraphTile NodeTransition index out of bounds");
    expect(script).toContain("Tile file might (me|be) corrupted");
  });

  it("passes an explicit Valhalla build concurrency when configured", () => {
    expect(script).toContain('VALHALLA_BUILD_CONCURRENCY="${VALHALLA_BUILD_CONCURRENCY:-}"');
    expect(script).toContain('concurrency_args=(-j "$stage_concurrency")');
    expect(script).toMatch(/concurrency.*json_number.*stage_concurrency/);
    expect(script).toContain('"$VALHALLA_BUILD_CRASH_RETRY_CONCURRENCY"');
  });

  it("removes only graph tiles and preserves constructedges intermediates", () => {
    const root = mkdtempSync(join(tmpdir(), "valhalla-corruption-"));
    const stateDir = join(root, ".build-state");
    const tileDir = join(root, "valhalla_tiles");
    const nestedTileDir = join(tileDir, "2", "001");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(nestedTileDir, { recursive: true });

    writeFileSync(
      join(stateDir, "current-stage.log"),
      "what(): Mismatch in end offset = 1358408 vs raw tile data size = 1064960. Tile file might me corrupted\n",
    );
    writeFileSync(join(stateDir, "constructedges.complete"), "");
    writeFileSync(join(stateDir, "build.complete"), "");
    writeFileSync(join(stateDir, "cleanup.complete"), "");
    writeFileSync(join(tileDir, "ways.bin"), "ways");
    writeFileSync(join(tileDir, "osmdata_counts.bin"), "counts");
    writeFileSync(join(tileDir, "way_nodes.bin"), "nodes");
    writeFileSync(join(nestedTileDir, "corrupted.gph"), "broken");

    const harness = `set -euo pipefail\nSTATE_DIR="$1"\nVALHALLA_TILE_DIR_ABS="$2"\n${recoveryFunction()}\nrecover_corrupted_graph_tiles\n`;
    execFileSync("bash", ["-c", harness, "bash", bashPath(stateDir), bashPath(root)], {
      stdio: "pipe",
    });

    expect(() => readFileSync(join(tileDir, "ways.bin"))).not.toThrow();
    expect(() => readFileSync(join(tileDir, "osmdata_counts.bin"))).not.toThrow();
    expect(() => readFileSync(join(tileDir, "way_nodes.bin"))).not.toThrow();
    expect(() => readFileSync(join(stateDir, "constructedges.complete"))).not.toThrow();
    expect(() => readFileSync(join(nestedTileDir, "corrupted.gph"))).toThrow();
    expect(() => readFileSync(join(stateDir, "build.complete"))).toThrow();
    expect(() => readFileSync(join(stateDir, "cleanup.complete"))).toThrow();
  });

  it.each([
    "what():  Invalid tile data size = 0. Tile file might me corrupted\n",
    "what():  GraphTile NodeTransition index out of bounds: 779799,2,0 transitioncount= 0\n",
  ])("recovers from Valhalla graph corruption: %s", (message) => {
    const root = mkdtempSync(join(tmpdir(), "valhalla-corruption-real-"));
    const stateDir = join(root, ".build-state");
    const tileDir = join(root, "valhalla_tiles");
    const nestedTileDir = join(tileDir, "2", "001");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(nestedTileDir, { recursive: true });

    writeFileSync(join(stateDir, "current-stage.log"), message);
    writeFileSync(join(stateDir, "constructedges.complete"), "");
    writeFileSync(join(stateDir, "build.complete"), "");
    writeFileSync(join(tileDir, "ways.bin"), "ways");
    writeFileSync(join(tileDir, "osmdata_counts.bin"), "counts");
    writeFileSync(join(tileDir, "way_nodes.bin"), "nodes");
    writeFileSync(join(nestedTileDir, "corrupted.gph"), "broken");

    const harness = `set -euo pipefail\nSTATE_DIR="$1"\nVALHALLA_TILE_DIR_ABS="$2"\n${recoveryFunction()}\nrecover_corrupted_graph_tiles\n`;
    execFileSync("bash", ["-c", harness, "bash", bashPath(stateDir), bashPath(root)], {
      stdio: "pipe",
    });

    expect(() => readFileSync(join(tileDir, "ways.bin"))).not.toThrow();
    expect(() => readFileSync(join(nestedTileDir, "corrupted.gph"))).toThrow();
    expect(() => readFileSync(join(stateDir, "build.complete"))).toThrow();
  });

  it("recovers from a native Valhalla double-free build crash", () => {
    const root = mkdtempSync(join(tmpdir(), "valhalla-native-crash-"));
    const stateDir = join(root, ".build-state");
    const tileDir = join(root, "valhalla_tiles");
    const nestedTileDir = join(tileDir, "2", "001");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(nestedTileDir, { recursive: true });

    writeFileSync(join(stateDir, "current-stage.log"), "double free or corruption (out)\n");
    writeFileSync(join(stateDir, "constructedges.complete"), "");
    writeFileSync(join(stateDir, "build.complete"), "");
    writeFileSync(join(tileDir, "ways.bin"), "ways");
    writeFileSync(join(tileDir, "osmdata_counts.bin"), "counts");
    writeFileSync(join(tileDir, "way_nodes.bin"), "nodes");
    writeFileSync(join(nestedTileDir, "partial.gph"), "partial");

    const harness = `set -euo pipefail
STATE_DIR="$1"
VALHALLA_TILE_DIR_ABS="$2"
json_number() { [[ "$1" =~ ^[0-9]+$ ]] && printf '%s' "$1" || printf '0'; }
${failedBuildRecoveryFunctions()}
recover_failed_build_stage 133 1
`;
    execFileSync("bash", ["-c", harness, "bash", bashPath(stateDir), bashPath(root)], {
      stdio: "pipe",
    });

    expect(() => readFileSync(join(tileDir, "ways.bin"))).not.toThrow();
    expect(() => readFileSync(join(tileDir, "osmdata_counts.bin"))).not.toThrow();
    expect(() => readFileSync(join(tileDir, "way_nodes.bin"))).not.toThrow();
    expect(() => readFileSync(join(nestedTileDir, "partial.gph"))).toThrow();
    expect(() => readFileSync(join(stateDir, "constructedges.complete"))).not.toThrow();
    expect(() => readFileSync(join(stateDir, "build.complete"))).toThrow();
  });


  it("falls back to a full graph rebuild when preserved intermediates are already missing", () => {
    const root = mkdtempSync(join(tmpdir(), "valhalla-missing-intermediates-"));
    const stateDir = join(root, ".build-state");
    const tileDir = join(root, "valhalla_tiles");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(tileDir, { recursive: true });

    writeFileSync(join(stateDir, "constructedges.complete"), "");
    writeFileSync(join(stateDir, "build.complete"), "");
    writeFileSync(join(stateDir, "cleanup.complete"), "");
    writeFileSync(join(tileDir, "stale.gph"), "broken");

    const helpers = script.match(
      /has_constructedges_intermediates\(\) \{[\s\S]*?\n\}\n\nreset_incomplete_constructedges_state\(\) \{[\s\S]*?\n\}/,
    );
    if (!helpers) {
      throw new Error("constructedges validation helpers not found");
    }

    const harness = `set -euo pipefail
STATE_DIR="$1"
VALHALLA_TILE_DIR_ABS="$2"
${helpers[0]}
if ! has_constructedges_intermediates; then reset_incomplete_constructedges_state; fi
`;
    execFileSync("bash", ["-c", harness, "bash", bashPath(stateDir), bashPath(root)], {
      stdio: "pipe",
    });

    expect(() => readFileSync(join(stateDir, "constructedges.complete"))).toThrow();
    expect(() => readFileSync(join(stateDir, "build.complete"))).toThrow();
    expect(() => readFileSync(join(stateDir, "cleanup.complete"))).toThrow();
    expect(() => readFileSync(join(tileDir, "stale.gph"))).toThrow();
  });

  it("performs at most one automatic recovery attempt per invocation", () => {
    const guardedRetry = script.match(
      /if ! run_stage enhance cleanup cleanup\.complete; then[\s\S]*?recover_corrupted_graph_tiles[\s\S]*?run_stage build build build\.complete[\s\S]*?run_stage enhance cleanup cleanup\.complete/,
    );

    expect(guardedRetry).not.toBeNull();
  });
});
