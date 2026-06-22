import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
      `#!/usr/bin/env bash\nset -euo pipefail\nout=""\nwhile [[ $# -gt 0 ]]; do\n  if [[ "$1" == "--output" ]]; then out="$2"; shift 2; else shift; fi\ndone\nmkdir -p "$(dirname "$out")"\n: > "$out"\n`,
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
        OSM_REGION: "test-region",
        OSM_EXTRACT_URL: "https://example.test/test.osm.pbf",
      },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const calls = await readFile(dockerLog, "utf8");
    expect(calls).toContain(`-v ${dataDir}:/data`);
    expect(calls).not.toContain(`${backendRoot}/${dataDir}`);
  });
});
