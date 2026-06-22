import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const backendRoot = resolve(import.meta.dirname, "../..");
const projectRoot = resolve(backendRoot, "..");

const composeFiles = [
  resolve(backendRoot, "docker-compose.yml"),
  resolve(backendRoot, "docker-compose.registry.yml"),
  resolve(projectRoot, "server-deploy/docker-compose.yml"),
];

describe("portable host paths in Docker Compose", () => {
  it.each(composeFiles)("resolves the Valhalla staging bind mount through PWD in %s", (file) => {
    const compose = readFileSync(file, "utf8");

    expect(compose).toContain(
      "VALHALLA_STAGING_BUILD_HOST_TILE_DIR: ${PWD}/data/valhalla.next",
    );
    expect(compose).not.toMatch(
      /VALHALLA_STAGING_BUILD_HOST_TILE_DIR:\s*\$\{VALHALLA_STAGING_BUILD_HOST_TILE_DIR/,
    );
  });

  it("does not expose a relative host staging path in the server env template", () => {
    const envExample = readFileSync(
      resolve(projectRoot, "server-deploy/.env.example"),
      "utf8",
    );

    expect(envExample).not.toContain("VALHALLA_STAGING_BUILD_HOST_TILE_DIR=");
  });
});
