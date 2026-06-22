import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const script = path.resolve("scripts/refresh-osm.sh");

async function fixture(options: { importFails?: boolean; invalidStaging?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "ignition-refresh-"));
  const bin = path.join(root, "bin");
  const current = path.join(root, "data", "valhalla");
  await mkdir(path.join(current, "valhalla_tiles"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(current, "valhalla.json"), "{}\n");
  await writeFile(path.join(current, "valhalla_tiles", "old.tile"), "old\n");
  await writeFile(
    path.join(bin, "docker"),
    `#!/usr/bin/env bash\necho "$*" >> "$FAKE_DOCKER_LOG"\nexit 0\n`,
  );
  await writeFile(
    path.join(bin, "npm"),
    `#!/usr/bin/env bash
set -e
if [[ "$1 $2" == "run valhalla:build" ]]; then
  mkdir -p "$VALHALLA_TILE_DIR/valhalla_tiles"
  if [[ "${options.invalidStaging ?? false}" != "true" ]]; then
    echo '{}' > "$VALHALLA_TILE_DIR/valhalla.json"
  fi
  echo new > "$VALHALLA_TILE_DIR/valhalla_tiles/new.tile"
fi
if [[ "$1 $2" == "run import:osm-alerts" && "${options.importFails ?? false}" == "true" ]]; then
  exit 9
fi
exit 0
`,
  );
  await chmod(path.join(bin, "docker"), 0o755);
  await chmod(path.join(bin, "npm"), 0o755);
  return {
    root,
    current,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_DOCKER_LOG: path.join(root, "docker.log"),
      VALHALLA_TILE_DIR: current,
      VALHALLA_STAGING_TILE_DIR: path.join(root, "data", "valhalla.next"),
      VALHALLA_PREVIOUS_TILE_DIR: path.join(root, "data", "valhalla.previous"),
      VALHALLA_FAILED_TILE_DIR: path.join(root, "data", "valhalla.failed"),
      OSM_DATA_DIR: path.join(root, "data", "osm"),
      OSM_REFRESH_LOCK_TIMEOUT_SECONDS: "1",
    },
  };
}

const describeOnUnix = process.platform === "win32" ? describe.skip : describe;

describeOnUnix("OSM refresh script", () => {
  it("activates staged tiles while keeping the mounted root directory stable", async () => {
    const test = await fixture();
    try {
      await execFileAsync("bash", [script], { cwd: process.cwd(), env: test.env });
      await expect(readFile(path.join(test.current, "valhalla_tiles", "new.tile"), "utf8")).resolves.toContain("new");
      await expect(readFile(path.join(test.current, "valhalla_tiles", "old.tile"), "utf8")).rejects.toThrow();
      const dockerLog = await readFile(test.env.FAKE_DOCKER_LOG, "utf8");
      expect(dockerLog).toContain("stop road-context-valhalla");
      expect(dockerLog).toContain("start road-context-valhalla");
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it("keeps current tiles when staged output is incomplete", async () => {
    const test = await fixture({ invalidStaging: true });
    try {
      await expect(execFileAsync("bash", [script], { cwd: process.cwd(), env: test.env })).rejects.toThrow();
      await expect(readFile(path.join(test.current, "valhalla_tiles", "old.tile"), "utf8")).resolves.toContain("old");
      await expect(readFile(path.join(test.current, "valhalla_tiles", "new.tile"), "utf8")).rejects.toThrow();
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it("restores the previous tiles when alert import fails", async () => {
    const test = await fixture({ importFails: true });
    try {
      await expect(execFileAsync("bash", [script], { cwd: process.cwd(), env: test.env })).rejects.toThrow();
      await expect(readFile(path.join(test.current, "valhalla_tiles", "old.tile"), "utf8")).resolves.toContain("old");
      await expect(readFile(path.join(test.current, "valhalla_tiles", "new.tile"), "utf8")).rejects.toThrow();
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });
});
