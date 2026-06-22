import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const backendRoot = path.resolve(import.meta.dirname, "../..");

const describeOnUnix = process.platform === "win32" ? describe.skip : describe;

describeOnUnix("build-valhalla-tiles.sh", () => {
  it("passes every configured PBF to a single Valhalla build", async () => {
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
      `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "$*" > "$DOCKER_LOG"\n`,
    );
    await chmod(path.join(bin, "docker"), 0o755);

    const result = spawnSync("bash", ["scripts/build-valhalla-tiles.sh"], {
      cwd: backendRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        DOCKER_LOG: dockerLog,
        OSM_DATA_DIR: osmDir,
        OSM_HOST_DATA_DIR: osmDir,
        OSM_REGIONS: "italy, france",
        VALHALLA_TILE_DIR: tileDir,
        VALHALLA_BUILD_HOST_TILE_DIR: tileDir,
      },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const call = await readFile(dockerLog, "utf8");
    expect(call).toContain("/data/osm/italy.osm.pbf");
    expect(call).toContain("/data/osm/france.osm.pbf");
  });
});
