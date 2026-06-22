import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const backendRoot = path.resolve(import.meta.dirname, "../..");
const describeOnUnix = process.platform === "win32" ? describe.skip : describe;

function runInit(template: string, target: string) {
  return spawnSync("bash", ["scripts/init-valhalla-config.sh"], {
    cwd: backendRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      VALHALLA_CONFIG_TEMPLATE: template,
      VALHALLA_CONFIG_PATH: target,
    },
  });
}

describeOnUnix("init-valhalla-config.sh", () => {
  it("creates a valid configuration when the target is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "valhalla-init-"));
    const template = path.join(root, "template.json");
    const target = path.join(root, "data", "valhalla.json");
    await writeFile(template, JSON.stringify({ service: { listen: "tcp://*:8002" } }));

    const result = runInit(template, target);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({
      service: { listen: "tcp://*:8002" },
    });
  });

  it("replaces an empty or invalid target atomically", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "valhalla-init-invalid-"));
    const template = path.join(root, "template.json");
    const targetDir = path.join(root, "data");
    const target = path.join(targetDir, "valhalla.json");
    await mkdir(targetDir, { recursive: true });
    await writeFile(template, JSON.stringify({ mjolnir: { tile_dir: "/custom_files/valhalla_tiles" } }));
    await writeFile(target, "");

    const result = runInit(template, target);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({
      mjolnir: { tile_dir: "/custom_files/valhalla_tiles" },
    });
  });

  it("replaces an existing valid but outdated configuration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "valhalla-init-existing-"));
    const template = path.join(root, "template.json");
    const target = path.join(root, "valhalla.json");
    await writeFile(template, JSON.stringify({ version: "template" }));
    await writeFile(target, JSON.stringify({ version: "custom" }));

    const result = runInit(template, target);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ version: "template" });
  });

  it("preserves an existing configuration that already matches the template", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "valhalla-init-current-"));
    const template = path.join(root, "template.json");
    const target = path.join(root, "valhalla.json");
    const config = { mjolnir: { tile_dir: "/custom_files/valhalla_tiles" } };
    await writeFile(template, JSON.stringify(config));
    await writeFile(target, JSON.stringify(config));

    const result = runInit(template, target);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("already up to date");
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(config);
  });

  it("fails before touching the target when the template is invalid", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "valhalla-init-template-"));
    const template = path.join(root, "template.json");
    const target = path.join(root, "valhalla.json");
    await writeFile(template, "not-json");

    const result = runInit(template, target);

    expect(result.status).not.toBe(0);
    await expect(readFile(target, "utf8")).rejects.toThrow();
  });
});
