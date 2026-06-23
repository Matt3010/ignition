import { readFile } from "node:fs/promises";
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

  it("keeps the standalone real-integration workflow manual or scheduled only", async () => {
    const integration = await readWorkflow("integration.yml");
    const triggerBlock = integration.split(/\npermissions:\n/, 1)[0];

    expect(triggerBlock).toContain("workflow_dispatch:");
    expect(triggerBlock).toContain("schedule:");
    expect(triggerBlock).not.toContain("pull_request:");
    expect(triggerBlock).not.toContain("push:");
  });
});
