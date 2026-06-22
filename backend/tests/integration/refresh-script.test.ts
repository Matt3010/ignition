import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const script = path.resolve("scripts/refresh-osm.sh");

async function fixture(
  options: {
    importFails?: boolean;
    invalidStaging?: boolean;
    healthFails?: boolean;
    initialTiles?: boolean;
    buildFails?: boolean;
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "ignition-refresh-"));
  const bin = path.join(root, "bin");
  const current = path.join(root, "data", "valhalla");
  await mkdir(bin, { recursive: true });
  if (options.initialTiles !== false) {
    await mkdir(path.join(current, "valhalla_tiles"), { recursive: true });
    await writeFile(path.join(current, "valhalla.json"), "{}\n");
    await writeFile(path.join(current, "valhalla_tiles", "old.tile"), "old\n");
  }
  await writeFile(
    path.join(bin, "docker"),
    `#!/usr/bin/env bash
echo "$*" >> "$FAKE_DOCKER_LOG"
if [[ "$1 $2" == "inspect -f" ]]; then echo true; fi
exit 0
`,
  );
  await writeFile(
    path.join(bin, "curl"),
    `#!/usr/bin/env bash
if [[ "${options.healthFails ?? false}" == "true" ]]; then exit 22; fi
exit 0
`,
  );
  await writeFile(
    path.join(bin, "npm"),
    `#!/usr/bin/env bash
set -e
echo "$*" >> "$FAKE_NPM_LOG"
if [[ "$1 $2" == "run osm:download" ]]; then
  echo "reuse=\${OSM_REUSE_EXISTING_DOWNLOADS:-false}" >> "$FAKE_NPM_LOG"
fi
if [[ "$1 $2" == "run valhalla:build" ]]; then
  if [[ "${options.buildFails ?? false}" == "true" ]]; then exit 10; fi
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
  await chmod(path.join(bin, "curl"), 0o755);
  await chmod(path.join(bin, "npm"), 0o755);
  return {
    root,
    current,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_DOCKER_LOG: path.join(root, "docker.log"),
      FAKE_NPM_LOG: path.join(root, "npm.log"),
      VALHALLA_TILE_DIR: current,
      VALHALLA_STAGING_TILE_DIR: path.join(root, "data", "valhalla.next"),
      VALHALLA_PREVIOUS_TILE_DIR: path.join(root, "data", "valhalla.previous"),
      VALHALLA_FAILED_TILE_DIR: path.join(root, "data", "valhalla.failed"),
      OSM_DATA_DIR: path.join(root, "data", "osm"),
      OSM_REFRESH_LOCK_TIMEOUT_SECONDS: "1",
      VALHALLA_HEALTH_TIMEOUT_SECONDS: "0",
      VALHALLA_HEALTH_INTERVAL_SECONDS: "0",
    },
  };
}

const describeOnUnix = process.platform === "win32" ? describe.skip : describe;

describeOnUnix("OSM refresh script", () => {
  it("activates staged tiles while keeping the mounted root directory stable", async () => {
    const test = await fixture();
    try {
      await execFileAsync("bash", [script], { cwd: process.cwd(), env: test.env });
      await expect(
        readFile(path.join(test.current, "valhalla_tiles", "new.tile"), "utf8"),
      ).resolves.toContain("new");
      await expect(
        readFile(path.join(test.current, "valhalla_tiles", "old.tile"), "utf8"),
      ).rejects.toThrow();
      const dockerLog = await readFile(test.env.FAKE_DOCKER_LOG, "utf8");
      expect(dockerLog).toContain("stop road-context-valhalla");
      expect(dockerLog).toContain("start road-context-valhalla");
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it("waits for Valhalla health before importing alerts", async () => {
    const test = await fixture();
    try {
      await execFileAsync("bash", [script], { cwd: process.cwd(), env: test.env });
      const npmLog = await readFile(test.env.FAKE_NPM_LOG, "utf8");
      expect(npmLog.indexOf("run valhalla:build")).toBeLessThan(
        npmLog.indexOf("run import:osm-alerts"),
      );
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it("rolls back and does not import alerts when Valhalla never becomes healthy", async () => {
    const test = await fixture({ healthFails: true });
    try {
      await expect(
        execFileAsync("bash", [script], { cwd: process.cwd(), env: test.env }),
      ).rejects.toThrow();
      await expect(
        readFile(path.join(test.current, "valhalla_tiles", "old.tile"), "utf8"),
      ).resolves.toContain("old");
      const npmLog = await readFile(test.env.FAKE_NPM_LOG, "utf8");
      expect(npmLog).not.toContain("run import:osm-alerts");
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it("supports first bootstrap when no current tile set exists", async () => {
    const test = await fixture({ initialTiles: false });
    try {
      await execFileAsync("bash", [script], { cwd: process.cwd(), env: test.env });
      await expect(
        readFile(path.join(test.current, "valhalla_tiles", "new.tile"), "utf8"),
      ).resolves.toContain("new");
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it("keeps current tiles when staged output is incomplete", async () => {
    const test = await fixture({ invalidStaging: true });
    try {
      await expect(
        execFileAsync("bash", [script], { cwd: process.cwd(), env: test.env }),
      ).rejects.toThrow();
      await expect(
        readFile(path.join(test.current, "valhalla_tiles", "old.tile"), "utf8"),
      ).resolves.toContain("old");
      await expect(
        readFile(path.join(test.current, "valhalla_tiles", "new.tile"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it("restores the previous tiles when alert import fails", async () => {
    const test = await fixture({ importFails: true });
    try {
      await expect(
        execFileAsync("bash", [script], { cwd: process.cwd(), env: test.env }),
      ).rejects.toThrow();
      await expect(
        readFile(path.join(test.current, "valhalla_tiles", "old.tile"), "utf8"),
      ).resolves.toContain("old");
      await expect(
        readFile(path.join(test.current, "valhalla_tiles", "new.tile"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it("removes an orphaned refresh lock before continuing", async () => {
    const test = await fixture();
    const lockDir = path.join(path.dirname(test.current), ".osm-refresh-lock");
    try {
      await mkdir(lockDir, { recursive: true });
      await writeFile(path.join(lockDir, "owner"), `999999 ${hostname()} 1\n`);
      const result = await execFileAsync("bash", [script], {
        cwd: process.cwd(),
        env: { ...test.env, OSM_REFRESH_LOCK_STALE_SECONDS: "1" },
      });
      expect(result.stderr).toContain("osm_refresh_stale_lock_removed");
      await expect(
        readFile(path.join(test.current, "valhalla_tiles", "new.tile"), "utf8"),
      ).resolves.toContain("new");
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

  it("reuses prepared OSM inputs when retrying an existing staging build", async () => {
    const test = await fixture({ buildFails: true });
    try {
      await mkdir(test.env.VALHALLA_STAGING_TILE_DIR, { recursive: true });
      await expect(
        execFileAsync("bash", [script], { cwd: process.cwd(), env: test.env }),
      ).rejects.toThrow();
      const npmLog = await readFile(test.env.FAKE_NPM_LOG, "utf8");
      expect(npmLog).toContain("run osm:download");
      expect(npmLog).toContain("reuse=true");
    } finally {
      await rm(test.root, { recursive: true, force: true });
    }
  });

});
