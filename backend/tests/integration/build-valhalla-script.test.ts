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
  await writeFile(
    path.join(bin, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
output=""
url=""
while (( $# > 0 )); do
  if [[ "$1" == "--output" ]]; then
    output="$2"
    shift 2
  elif [[ "$1" == http* ]]; then
    url="$1"
    shift
  else
    shift
  fi
done
if [[ -n "$output" ]]; then
  : > "$output"
else
  printf '%s' '{"assets":[{"name":"timezones-with-oceans.shapefile.zip","digest":"sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}]}'
fi
`,
  );
  await chmod(path.join(bin, "curl"), 0o755);
  await writeFile(
    path.join(bin, "unzip"),
    `#!/usr/bin/env bash
set -euo pipefail
output_dir=""
while (( $# > 0 )); do
  if [[ "$1" == "-d" ]]; then output_dir="$2"; shift 2; else shift; fi
done
mkdir -p "$output_dir"
: > "$output_dir/combined-shapefile-with-oceans.shp"
`,
  );
  await chmod(path.join(bin, "unzip"), 0o755);
  await writeFile(
    path.join(bin, "spatialite_tool"),
    `#!/usr/bin/env bash
set -euo pipefail
target=""
while (( $# > 0 )); do
  if [[ "$1" == "-d" ]]; then target="$2"; shift 2; else shift; fi
done
python3 -c 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("create table tz_world(id integer)"); c.commit(); c.close()' "$target"
`,
  );
  await chmod(path.join(bin, "spatialite_tool"), 0o755);
  await writeFile(path.join(bin, "spatialite"), `#!/usr/bin/env bash
exit 0
`);
  await chmod(path.join(bin, "spatialite"), 0o755);
  return { root, bin, osmDir, tileDir, dockerLog };
}

function runFixture(
  test: Awaited<ReturnType<typeof makeFixture>>,
  envOverrides: NodeJS.ProcessEnv = {},
) {
  return spawnSync("bash", ["scripts/build-valhalla-tiles.sh"], {
    cwd: backendRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${test.bin}:${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
      DOCKER_LOG: test.dockerLog,
      OSM_DATA_DIR: test.osmDir,
      OSM_HOST_DATA_DIR: test.osmDir,
      OSM_REGIONS: "italy, france",
      VALHALLA_TILE_DIR: test.tileDir,
      VALHALLA_BUILD_HOST_TILE_DIR: test.tileDir,
      VALHALLA_BUILD_PROGRESS_INTERVAL_SECONDS: "3600",
      VALHALLA_TIMEZONE_ARCHIVE_SHA256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ...envOverrides,
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
    expect(calls).not.toContain("--entrypoint valhalla_build_timezones");
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
    expect(calls).not.toContain("--entrypoint valhalla_build_timezones");
    expect(calls).toContain("--entrypoint valhalla_build_admins");
    expect(calls).toContain("-s build -e build");
    expect(calls).toContain("-s enhance -e cleanup");
  });


  it("resolves and verifies the digest from the official GitHub release metadata", async () => {
    const test = await makeFixture();
    const result = runFixture(test, {
      VALHALLA_TIMEZONE_ARCHIVE_SHA256: "",
    });

    expect(result.status, `${result.stdout}
${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("valhalla_timezone_archive_verified");
    expect(result.stdout).toContain("2026b");
  });

  it("rejects a timezone archive whose SHA256 does not match", async () => {
    const test = await makeFixture();
    const result = runFixture(test, {
      VALHALLA_TIMEZONE_ARCHIVE_SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}
${result.stderr}`).toContain("Timezone archive SHA256 mismatch");
  });

  it("requires an explicit checksum for a custom timezone archive URL", async () => {
    const test = await makeFixture();
    const result = runFixture(test, {
      VALHALLA_TIMEZONE_ARCHIVE_URL: "https://example.invalid/custom-timezones.zip",
      VALHALLA_TIMEZONE_ARCHIVE_SHA256: "",
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}
${result.stderr}`).toContain(
      "VALHALLA_TIMEZONE_ARCHIVE_SHA256 is required",
    );
  });

  it("rebuilds downstream stages when the pinned timezone source changes", async () => {
    const test = await makeFixture();
    const first = runFixture(test);
    expect(first.status, `${first.stdout}
${first.stderr}`).toBe(0);
    await writeFile(test.dockerLog, "");

    const second = runFixture(test, {
      VALHALLA_TIMEZONE_RELEASE: "custom-release",
      VALHALLA_TIMEZONE_ARCHIVE_URL:
        "https://example.invalid/timezones-with-oceans.shapefile.zip",
      VALHALLA_TIMEZONE_ARCHIVE_SHA256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });

    expect(second.status, `${second.stdout}
${second.stderr}`).toBe(0);
    const calls = await readFile(test.dockerLog, "utf8");
    expect(calls).not.toContain("-s initialize -e constructedges");
    expect(calls).toContain("-s build -e build");
    expect(calls).toContain("-s enhance -e cleanup");
    expect(second.stdout).toContain("valhalla_timezone_archive_verified");
  });

});
