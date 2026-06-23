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
if [[ "$*" == *"--entrypoint valhalla_build_timezones"* ]]; then
  python3 -c 'import sqlite3,sys,tempfile,os; p=tempfile.mktemp(); c=sqlite3.connect(p); c.execute("create table timezone(id integer)"); c.commit(); c.close(); sys.stdout.buffer.write(open(p,"rb").read()); os.unlink(p)'
  exit 0
fi
if [[ "$*" == *"--entrypoint valhalla_build_admins"* ]]; then
  python3 -c 'import sqlite3,sys; p=sys.argv[1]; c=sqlite3.connect(p); c.execute("create table admins(id integer)"); c.commit(); c.close()' "$VALHALLA_BUILD_HOST_TILE_DIR/admins.sqlite"
  exit 0
fi
mkdir -p "$VALHALLA_BUILD_HOST_TILE_DIR/valhalla_tiles/2/000"
touch "$VALHALLA_BUILD_HOST_TILE_DIR/valhalla_tiles/2/000/fixture.gph"
`,
  );
  await chmod(path.join(bin, "docker"), 0o755);
  await writeFile(
    path.join(bin, "sqlite3"),
    `#!/usr/bin/env bash
set -euo pipefail
python3 - "$3" <<'PYSQL'
import sqlite3, sys
try:
    connection = sqlite3.connect(sys.argv[1])
    result = connection.execute("PRAGMA quick_check").fetchone()
    connection.close()
    print(result[0] if result else "")
except Exception:
    raise SystemExit(1)
PYSQL
`,
  );
  await chmod(path.join(bin, "sqlite3"), 0o755);
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
      VALHALLA_BUILD_PROGRESS_INTERVAL_SECONDS: "3600",
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
    expect(calls).toContain("--entrypoint valhalla_build_timezones");
    expect(calls).toContain("--entrypoint valhalla_build_admins");
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

  it("rebuilds downstream tile stages when support databases are introduced", async () => {
    const test = await makeFixture();
    await mkdir(path.join(test.tileDir, ".build-state"), { recursive: true });
    await writeFile(path.join(test.tileDir, ".build-state", "constructedges.complete"), "");
    await writeFile(path.join(test.tileDir, ".build-state", "build.complete"), "");
    await writeFile(path.join(test.tileDir, ".build-state", "cleanup.complete"), "");

    const result = runFixture(test);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const calls = await readFile(test.dockerLog, "utf8");
    expect(calls).not.toContain("-s initialize -e constructedges");
    expect(calls).toContain("-s build -e build");
    expect(calls).toContain("-s enhance -e cleanup");
    expect(result.stdout).toContain("valhalla_build_downstream_invalidated");
  });

  it("regenerates non-empty but invalid support databases instead of trusting markers", async () => {
    const test = await makeFixture();
    const first = runFixture(test);
    expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);

    await writeFile(path.join(test.tileDir, "admins.sqlite"), "SQLite format 3\0corrupt-payload");
    await writeFile(path.join(test.tileDir, "timezones.sqlite"), "SQLite format 3\0corrupt-payload");
    await writeFile(test.dockerLog, "");

    const second = runFixture(test);
    expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);
    const calls = await readFile(test.dockerLog, "utf8");
    expect(calls).toContain("--entrypoint valhalla_build_timezones");
    expect(calls).toContain("--entrypoint valhalla_build_admins");
    expect(calls).toContain("-s build -e build");
    expect(calls).toContain("-s enhance -e cleanup");
  });

});
