import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

async function readWorkflow(name: string): Promise<string> {
  return (await readFile(
    path.join(repositoryRoot, ".github", "workflows", name),
    "utf8",
  )).replaceAll("\r\n", "\n");
}

describe("GHCR publication gate", () => {
  it("requires backend checks and both real integration jobs before publishing", async () => {
    const ci = await readWorkflow("ci.yml");
    const publishJob = ci.split(/\n\x20{2}publish-image:\n/, 2)[1];

    expect(publishJob).toBeDefined();
    expect(publishJob).toContain("needs: [changes, backend, postgis, valhalla]");
    expect(publishJob).not.toContain("ios-build");
    expect(publishJob).toContain("needs.backend.result == 'success'");
    expect(publishJob).toContain("needs.postgis.result == 'success'");
    expect(publishJob).toContain("needs.valhalla.result == 'success'");
    expect(ci).toContain("  postgis:\n");
    expect(ci).toContain("  valhalla:\n");
    expect(ci).toContain("Run live PostGIS tests");
    expect(ci).toContain("Run live Valhalla tests");
  });


  it("builds the compiled server before running the real runtime lifecycle test", async () => {
    const ci = await readWorkflow("ci.yml");
    const valhallaJob = ci.split(/\n\x20{2}valhalla:\n/, 2)[1]?.split(/\n\x20{2}publish-image:\n/, 1)[0];

    expect(valhallaJob).toBeDefined();
    const buildIndex = valhallaJob!.indexOf("- name: Build\n        run: npm run build");
    const runtimeIndex = valhallaJob!.indexOf("- name: Run real server lifecycle tests");

    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(runtimeIndex).toBeGreaterThan(buildIndex);
  });


  it("pulls and runs the published Toxiproxy image from GHCR", async () => {
    const ci = await readWorkflow("ci.yml");

    expect(ci).toContain("- name: Pull Toxiproxy\n        run: docker pull ghcr.io/shopify/toxiproxy:2.12.0");
    expect(ci).toContain("ghcr.io/shopify/toxiproxy:2.12.0");
    expect(ci).not.toMatch(/(^|\s)shopify\/toxiproxy:2\.12\.0(?:\s|$)/m);
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
