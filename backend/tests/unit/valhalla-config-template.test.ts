import { readFile } from "node:fs/promises";
import path from "node:path";

describe("Valhalla configuration template", () => {
  it("uses directory tiles without optional tar extracts", async () => {
    const templatePath = path.resolve("docker/valhalla/valhalla.json");
    const config = JSON.parse(await readFile(templatePath, "utf8")) as {
      mjolnir?: Record<string, unknown>;
    };

    expect(config.mjolnir?.tile_dir).toBe("/custom_files/valhalla_tiles");
    expect(config.mjolnir).not.toHaveProperty("tile_extract");
    expect(config.mjolnir).not.toHaveProperty("traffic_extract");
  });
});
