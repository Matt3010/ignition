import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const script = resolve("scripts/ensure-osm-alerts.sh");
const bashAvailable = spawnSync("bash", ["-lc", "true"], { encoding: "utf8" }).status === 0;
const describeWithBash = bashAvailable ? describe : describe.skip;

function bashPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const drive = normalized.match(/^([A-Za-z]):\/(.*)$/);
  return drive ? `/${drive[1].toLowerCase()}/${drive[2]}` : normalized;
}

describeWithBash("OSM alert self-healing", () => {
  let root: string;
  let bin: string;
  let data: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ignition-alert-repair-"));
    bin = join(root, "bin");
    data = join(root, "data");
    await mkdir(bin);
    await mkdir(data);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function installFakes(states: string[]): Promise<void> {
    const state = join(root, "states");
    await writeFile(state, `${states.join("\n")}\n`);
    const node = join(bin, "node");
    await writeFile(node, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"JSON.stringify"* ]]; then printf '%s' "$2"; exit 0; fi
state=${JSON.stringify(bashPath(state))}
first=$(head -n1 "$state")
tail -n +2 "$state" > "$state.next" || true
mv "$state.next" "$state"
printf '%b' "$first"
`);
    await chmod(node, 0o755);
    const npm = join(bin, "npm");
    await writeFile(npm, `#!/usr/bin/env bash
echo "$*" >> ${JSON.stringify(bashPath(join(root, "npm.log")))}
`);
    await chmod(npm, 0o755);
  }

  function run(): ReturnType<typeof spawnSync> {
    return spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bashPath(bin)}:${process.env.PATH}`,
        DATABASE_URL: "postgres://example",
        OSM_REGIONS: "italy",
        OSM_DATA_DIR: bashPath(data),
      },
    });
  }

  it("does nothing when active alerts already exist", async () => {
    await installFakes(["42\\tsuccess\\t42"]);
    await writeFile(join(data, "italy.alerts.osm"), "<osm version=\"0.6\"></osm>");
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"status":"available"');
    await expect(readFile(join(root, "npm.log"), "utf8")).rejects.toThrow();
  });

  it("keeps an available dataset healthy while reporting a missing source extract", async () => {
    await installFakes(["42\\tsuccess\\t42"]);
    const result = run();
    expect(result.status).toBe(5);
    expect(result.stdout).toContain('"status":"available"');
    expect(result.stderr).toContain('"event":"osm_alert_sources_missing"');
    expect(result.stderr).toContain('"datasetStatus":"available"');
    await expect(readFile(join(root, "npm.log"), "utf8")).rejects.toThrow();
  });

  it("accepts a successful import with zero records as a legitimate empty dataset", async () => {
    await installFakes(["0\\tsuccess\\t0"]);
    await writeFile(join(data, "italy.alerts.osm"), "<osm version=\"0.6\"></osm>");
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"status":"empty"');
    await expect(readFile(join(root, "npm.log"), "utf8")).rejects.toThrow();
  });

  it("keeps an empty dataset healthy while reporting a missing source extract", async () => {
    await installFakes(["0\\tsuccess\\t0"]);
    const result = run();
    expect(result.status).toBe(5);
    expect(result.stdout).toContain('"status":"empty"');
    expect(result.stderr).toContain('"event":"osm_alert_sources_missing"');
    expect(result.stderr).toContain('"datasetStatus":"empty"');
    await expect(readFile(join(root, "npm.log"), "utf8")).rejects.toThrow();
  });

  it("imports a valid local extract when the dataset was never imported", async () => {
    await installFakes(["0\\tnever\\t-1", "123\\tsuccess\\t123"]);
    await writeFile(join(data, "italy.alerts.osm"), "<osm version=\"0.6\"></osm>");
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"event":"osm_alert_repair_started"');
    expect(result.stdout).toContain('"status":"available"');
    expect(await readFile(join(root, "npm.log"), "utf8")).toContain("run import:osm-alerts");
  });

  it("repairs a failed last import when a valid source exists", async () => {
    await installFakes(["0\\tfailed\\t0", "0\\tsuccess\\t0"]);
    await writeFile(join(data, "italy.alerts.osm"), "<osm version=\"0.6\"></osm>");
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"lastImportStatus":"failed"');
    expect(result.stdout).toContain('"status":"empty"');
  });

  it("repairs inconsistent metadata when records were imported but none are active", async () => {
    await installFakes(["0\\tsuccess\\t10", "10\\tsuccess\\t10"]);
    await writeFile(join(data, "italy.alerts.osm"), "<osm version=\"0.6\"></osm>");
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"event":"osm_alert_repair_started"');
  });

  it("requests a full refresh when an unavailable dataset has no source extract", async () => {
    await installFakes(["0\\tnever\\t-1"]);
    const result = run();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('"reason":"missing_sources"');
  });

  it("fails when import metadata remains inconsistent", async () => {
    await installFakes(["0\\tnever\\t-1", "0\\tsuccess\\t12"]);
    await writeFile(join(data, "italy.alerts.osm"), "<osm version=\"0.6\"></osm>");
    const result = run();
    expect(result.status).toBe(4);
    expect(result.stderr).toContain('"reason":"import_state_inconsistent"');
  });

  it("imports alerts before starting the expensive Valhalla build", async () => {
    const refresh = await readFile(resolve("scripts/refresh-osm.sh"), "utf8");
    expect(refresh.indexOf("npm run import:osm-alerts")).toBeGreaterThan(-1);
    expect(refresh.indexOf("npm run import:osm-alerts")).toBeLessThan(refresh.indexOf("npm run valhalla:build"));
    expect(refresh).toContain("osm_alerts_ready_before_valhalla_build");
  });

  it("schedules an early source repair without immediate refresh when the dataset is healthy", async () => {
    const loop = await readFile(resolve("scripts/osm-refresh-loop.sh"), "utf8");
    expect(loop).toContain("OSM_REFRESH_SOURCE_REPAIR_DELAY_SECONDS");
    expect(loop).toContain('"action":"schedule_source_repair"');
    expect(loop).toContain('[[ "$status" -eq 5 ]]');
  });
});
