import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const backendRoot = resolve(import.meta.dirname, "../..");
const script = readFileSync(
  resolve(backendRoot, "scripts/build-valhalla-tiles.sh"),
  "utf8",
);

function recoveryFunction(): string {
  const match = script.match(
    /recover_corrupted_graph_tiles\(\) \{[\s\S]*?\n\}/,
  );
  if (!match) {
    throw new Error("recover_corrupted_graph_tiles function not found");
  }
  return match[0];
}

describe("Valhalla graph-tile corruption recovery", () => {
  it("detects the Valhalla offset-mismatch corruption error", () => {
    expect(script).toContain("recover_corrupted_graph_tiles() {");
    expect(script).toContain("Mismatch in end offset =");
    expect(script).toContain("Tile file might (me|be) corrupted");
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
    execFileSync("bash", ["-c", harness, "bash", stateDir, root], {
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
    execFileSync("bash", ["-c", harness, "bash", stateDir, root], {
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
