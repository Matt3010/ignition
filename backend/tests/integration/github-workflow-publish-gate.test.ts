import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

async function readWorkflow(name: string): Promise<string> {
  return readFile(path.join(repositoryRoot, ".github", "workflows", name), "utf8");
}

describe("GHCR publication gate", () => {
  it("requires static checks and both real integration jobs before publishing", async () => {
    const ci = await readWorkflow("ci.yml");
    const publishJob = ci.split(/\n\x20{2}publish-image:\n/, 2)[1];

    expect(publishJob).toBeDefined();
    expect(publishJob).toContain("needs: [backend, swift-syntax, postgis, valhalla]");
    expect(ci).toContain("  postgis:\n");
    expect(ci).toContain("  valhalla:\n");
    expect(ci).toContain("Run live PostGIS tests");
    expect(ci).toContain("Run live Valhalla tests");
  });

  it("keeps all automated checks in the single CI workflow", async () => {
    const workflowsDir = path.join(repositoryRoot, ".github", "workflows");

    await expect(access(path.join(workflowsDir, "integration.yml"))).rejects.toThrow();

    const ci = await readWorkflow("ci.yml");
    expect(ci).toContain("workflow_dispatch:");
    expect(ci).toContain("push:");
    expect(ci).toContain("pull_request:");
  });
});
