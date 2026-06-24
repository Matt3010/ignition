import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const backendRoot = resolve(import.meta.dirname, "../..");

function read(relativePath: string): string {
  return readFileSync(resolve(backendRoot, relativePath), "utf8");
}

describe("Valhalla package portability", () => {
  it("normalizes archive ownership and read/traverse permissions", () => {
    const script = read("scripts/package-valhalla-tiles.sh");

    expect(script).toContain("--owner=0");
    expect(script).toContain("--group=0");
    expect(script).toContain("--numeric-owner");
    expect(script).toContain("--mode='u+rwX,go+rX'");
  });

  it("makes the temporary bind-mount root traversable and validates package modes", () => {
    const script = read("scripts/verify-valhalla-package.sh");

    expect(script).toContain('chmod 0755 "$extract_dir"');
    expect(script).toContain('[[ -r "$extract_dir/valhalla.json" ]]');
    expect(script).toContain("! -perm -0005");
    expect(script).toContain("! -perm -0004");
  });
});
