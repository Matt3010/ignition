import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const backendRoot = path.resolve(import.meta.dirname, "../..");
const describeOnUnix = process.platform === "win32" ? describe.skip : describe;

async function makeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "valhalla-build-multi-"));
  const bin = path.join(root, "bin");
  const osmDir = path.join(root, "osm");
  const tileDir = path.join(root, "tiles");
  const dockerLog = path.join(root, "docker.log");
  await mkdir(bin, { recursive: true });
  await mkdir(osmDir, { recursive: true });
  await writeFile(path.join(osmDir, "italy.osm.pbf"), "fixture");
  await writeFile(path.join(osmDir, "france.osm.pbf"), "fixture");
  await writeFile(
    path.join(bin, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$DOCKER_LOG"
mkdir -p "$VALHALLA_BUILD_HOST_TILE_DIR/valhalla_tiles/2/000"
touch "$VALHALLA_BUILD_HOST_TILE_DIR/valhalla_tiles/2/000/fixture.gph"
`,
  );
  await chmod(path.join(bin, "docker"), 0o755);
  return { root, bin, osmDir, tileDir, dockerLog };
}

function runFixture(test: Awaited<ReturnType<typeof makeFixture>>) {
  return spawnSync("bash", ["scripts/build-valhalla-tiles.sh"], {
    cwd: backendRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${test.bin}:/usr/bin:/bin`,
      DOCKER_LOG: test.dockerLog,
      OSM_DATA_DIR: test.osmDir,
      OSM_HOST_DATA_DIR: test.osmDir,
      OSM_REGIONS: "italy, france",
      VALHALLA_TILE_DIR: test.tileDir,
      VALHALLA_BUILD_HOST_TILE_DIR: test.tileDir,
    },
  });
}

describeOnUnix("build-valhalla-tiles.sh", () => {
  it("passes every configured PBF through the staged Valhalla build", async () => {
    const test = await makeFixture();
    const result = runFixture(test);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const calls = await readFile(test.dockerLog, "utf8");
    expect(calls).toContain("/data/osm/italy.osm.pbf");
    expect(calls).toContain("/data/osm/france.osm.pbf");
    expect(calls).toContain("-s initialize -e constructedges");
    expect(calls).toContain("-s build -e build");
    expect(calls).toContain("-s enhance -e cleanup");
  });

  it("does not rerun completed stages on restart", async () => {
    const test = await makeFixture();
    const first = runFixture(test);
    expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
    await writeFile(test.dockerLog, "");

    const second = runFixture(test);
    expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);
    expect(await readFile(test.dockerLog, "utf8")).toBe("");
  });

  it("adopts legacy partial tiles and resumes from the build stage", async () => {
    const test = await makeFixture();
    await mkdir(path.join(test.tileDir, "valhalla_tiles", "2"), { recursive: true });
    await writeFile(path.join(test.tileDir, "valhalla_tiles", "2", "partial.gph"), "partial");

    const result = runFixture(test);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const calls = await readFile(test.dockerLog, "utf8");
    expect(calls).not.toContain("-s initialize -e constructedges");
    expect(calls).toContain("-s build -e build");
    expect(result.stdout).toContain("valhalla_build_legacy_progress_detected");
  });
});
