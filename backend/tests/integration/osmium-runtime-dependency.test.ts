import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const backendRoot = resolve(import.meta.dirname, "../..");
const repositoryRoot = resolve(backendRoot, "..");

const read = (path: string): string => readFileSync(path, "utf8");

describe("osmium runtime dependency", () => {
  it("installs osmium-tool in the production image", () => {
    const dockerfile = read(resolve(backendRoot, "Dockerfile"));
    expect(dockerfile).toMatch(/apt-get install[^\n]*osmium-tool/);
  });

  it("installs osmium-tool in the Valhalla CI job", () => {
    const workflow = read(resolve(repositoryRoot, ".github/workflows/ci.yml"));
    expect(workflow).toMatch(/apt-get install[^\n]*osmium-tool/);
  });

  it("does not retain the obsolete Osmium Docker fallback configuration", () => {
    const files = [
      resolve(backendRoot, ".env.example"),
      resolve(repositoryRoot, "server-deploy/.env.example"),
      resolve(repositoryRoot, "server-deploy/docker-compose.yml"),
      resolve(backendRoot, "scripts/download-osm-extract.sh"),
    ];

    for (const file of files) {
      expect(read(file)).not.toContain("OSMIUM_DOCKER_IMAGE");
    }
  });

  it("fails explicitly when the local osmium binary is unavailable", () => {
    const script = read(resolve(backendRoot, "scripts/download-osm-extract.sh"));
    expect(script).toContain("Required command is not installed: $command_name");
    expect(script).not.toMatch(/docker run[^\n]*osmium/i);
  });
});
