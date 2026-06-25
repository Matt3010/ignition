import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const backendRoot = resolve(import.meta.dirname, "../..");
const script = readFileSync(
  resolve(backendRoot, "scripts/build-valhalla-tiles.sh"),
  "utf8",
);

describe("Valhalla graph-tile corruption recovery", () => {
  it("detects the Valhalla offset-mismatch corruption error", () => {
    expect(script).toContain("recover_corrupted_graph_tiles() {");
    expect(script).toContain("Mismatch in end offset =");
    expect(script).toContain("Tile file might (me|be) corrupted");
  });

  it("preserves constructedges but invalidates and rebuilds downstream stages", () => {
    const recoveryStart = script.indexOf("recover_corrupted_graph_tiles() {");
    const stageExecutionStart = script.indexOf(
      'if [[ ! -f "$STATE_DIR/constructedges.complete" ]]',
      recoveryStart,
    );
    const recovery = script.slice(recoveryStart, stageExecutionStart);

    expect(recovery).toContain(
      'rm -f "$STATE_DIR/build.complete" "$STATE_DIR/cleanup.complete"',
    );
    expect(recovery).toContain(
      'find "$VALHALLA_TILE_DIR_ABS/valhalla_tiles" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +',
    );
    expect(recovery).not.toContain('rm -f "$STATE_DIR/constructedges.complete"');
    expect(script).toContain("run_stage build build build.complete");
    expect(script).toContain("run_stage enhance cleanup cleanup.complete");
  });

  it("performs at most one automatic recovery attempt per invocation", () => {
    const guardedRetry = script.match(
      /if ! run_stage enhance cleanup cleanup\.complete; then[\s\S]*?recover_corrupted_graph_tiles[\s\S]*?run_stage build build build\.complete[\s\S]*?run_stage enhance cleanup cleanup\.complete/,
    );

    expect(guardedRetry).not.toBeNull();
  });
});
