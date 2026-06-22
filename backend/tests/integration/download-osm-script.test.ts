import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const backendRoot = path.resolve(import.meta.dirname, "../..");

describe("download-osm-extract.sh", () => {
  it("mounts an absolute OSM_DATA_DIR without prefixing the working directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "osm-download-script-"));
    const bin = path.join(root, "bin");
    const dataDir = path.join(root, "absolute-osm-data");
    const dockerLog = path.join(root, "docker.log");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(bin, { recursive: true }));

    const curl = path.join(bin, "curl");
    await writeFile(
      curl,
      `#!/usr/bin/env bash\nset -euo pipefail\nout=""\nwhile [[ $# -gt 0 ]]; do\n  if [[ "$1" == "--output" ]]; then out="$2"; shift 2; else shift; fi\ndone\nmkdir -p "$(dirname "$out")"\nprintf 'ok' > "$out"\n`,
    );
    const docker = path.join(bin, "docker");
    await writeFile(
      docker,
      `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "$*" >> "$DOCKER_LOG"\n`,
    );
    await chmod(curl, 0o755);
    await chmod(docker, 0o755);

    const result = spawnSync("bash", ["scripts/download-osm-extract.sh"], {
      cwd: backendRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        DOCKER_LOG: dockerLog,
        OSM_DATA_DIR: dataDir,
        OSM_REGIONS: "italy",
        OSM_DOWNLOAD_MIN_BYTES: "1",
      },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const calls = await readFile(dockerLog, "utf8");
    expect(calls).toContain(`-v ${dataDir}:/data`);
    expect(calls).not.toContain(`${backendRoot}/${dataDir}`);
  });

  it("downloads and filters every configured region", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "osm-download-multi-"));
    const bin = path.join(root, "bin");
    const dataDir = path.join(root, "data");
    const curlLog = path.join(root, "curl.log");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(bin, { recursive: true }));
    await writeFile(
      path.join(bin, "curl"),
      `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "$*" >> "$CURL_LOG"\nout=""\nwhile [[ $# -gt 0 ]]; do if [[ "$1" == "--output" ]]; then out="$2"; shift 2; else shift; fi; done\nmkdir -p "$(dirname "$out")"\nprintf 'ok' > "$out"\n`,
    );
    await writeFile(path.join(bin, "docker"), `#!/usr/bin/env bash\nexit 0\n`);
    await chmod(path.join(bin, "curl"), 0o755);
    await chmod(path.join(bin, "docker"), 0o755);

    const result = spawnSync("bash", ["scripts/download-osm-extract.sh"], {
      cwd: backendRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        CURL_LOG: curlLog,
        OSM_DATA_DIR: dataDir,
        OSM_REGIONS: "italy,france",
        OSM_DOWNLOAD_MIN_BYTES: "1",
      },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const calls = await readFile(curlLog, "utf8");
    expect(calls).toContain("italy-latest.osm.pbf");
    expect(calls).toContain("france-latest.osm.pbf");
    await expect(readFile(path.join(dataDir, "italy.osm.pbf"))).resolves.toBeDefined();
    await expect(readFile(path.join(dataDir, "france.osm.pbf"))).resolves.toBeDefined();
  });
  it("rejects unknown region presets instead of accepting custom URLs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "osm-download-unknown-"));
    const result = spawnSync("bash", ["scripts/download-osm-extract.sh"], {
      cwd: backendRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        OSM_DATA_DIR: path.join(root, "data"),
        OSM_REGIONS: "custom-region",
      },
    });

    expect(result.status).toBe(64);
    expect(result.stderr).toContain("Unknown OSM region preset: custom-region");
  });

  it("follows redirects and requests resumable downloads", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "osm-download-options-"));
    const bin = path.join(root, "bin");
    const dataDir = path.join(root, "data");
    const curlLog = path.join(root, "curl.log");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(bin, { recursive: true }));
    await writeFile(
      path.join(bin, "curl"),
      `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\n' "$*" > "$CURL_LOG"\nout=""\nwhile [[ $# -gt 0 ]]; do if [[ "$1" == "--output" ]]; then out="$2"; shift 2; else shift; fi; done\nprintf 'valid' > "$out"\n`,
    );
    await writeFile(path.join(bin, "docker"), `#!/usr/bin/env bash\nexit 0\n`);
    await chmod(path.join(bin, "curl"), 0o755);
    await chmod(path.join(bin, "docker"), 0o755);

    const result = spawnSync("bash", ["scripts/download-osm-extract.sh"], {
      cwd: backendRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        CURL_LOG: curlLog,
        OSM_DATA_DIR: dataDir,
        OSM_REGIONS: "italy",
        OSM_DOWNLOAD_MIN_BYTES: "1",
      },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const args = await readFile(curlLog, "utf8");
    expect(args).toContain("--location");
    expect(args).toContain("--continue-at -");
    expect(args).toContain("--retry-all-errors");
  });

  it("keeps a partial download after a curl failure so the next run can resume", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "osm-download-resume-"));
    const bin = path.join(root, "bin");
    const dataDir = path.join(root, "data");
    await Promise.all([
      mkdir(bin, { recursive: true }),
      mkdir(dataDir, { recursive: true }),
    ]);
    const partial = path.join(dataDir, "italy.download.osm.pbf");
    await writeFile(partial, "partial-content");
    await writeFile(path.join(bin, "curl"), `#!/usr/bin/env bash\nexit 7\n`);
    await chmod(path.join(bin, "curl"), 0o755);

    const result = spawnSync("bash", ["scripts/download-osm-extract.sh"], {
      cwd: backendRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        OSM_DATA_DIR: dataDir,
        OSM_REGIONS: "italy",
      },
    });

    expect(result.status).not.toBe(0);
    await expect(readFile(partial, "utf8")).resolves.toBe("partial-content");
    expect(result.stdout).toContain("Resuming partial download for italy");
  });

  it("rejects and removes a completed download that is implausibly small", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "osm-download-small-"));
    const bin = path.join(root, "bin");
    const dataDir = path.join(root, "data");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(bin, { recursive: true }));
    await writeFile(
      path.join(bin, "curl"),
      `#!/usr/bin/env bash\nset -euo pipefail\nout=""\nwhile [[ $# -gt 0 ]]; do if [[ "$1" == "--output" ]]; then out="$2"; shift 2; else shift; fi; done\nprintf 'tiny' > "$out"\n`,
    );
    await chmod(path.join(bin, "curl"), 0o755);

    const result = spawnSync("bash", ["scripts/download-osm-extract.sh"], {
      cwd: backendRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        OSM_DATA_DIR: dataDir,
        OSM_REGIONS: "italy",
        OSM_DOWNLOAD_MIN_BYTES: "100",
      },
    });

    expect(result.status).toBe(65);
    expect(result.stderr).toContain("unexpectedly small");
    await expect(readFile(path.join(dataDir, "italy.download.osm.pbf"))).rejects.toThrow();
    await expect(readFile(path.join(dataDir, "italy.osm.pbf"))).rejects.toThrow();
  });

});
