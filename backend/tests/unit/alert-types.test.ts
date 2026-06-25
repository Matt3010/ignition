import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { alertTypes } from "../../src/domain/models/alert.js";

const removedStaticTypes = ["mobileSpeedCamera", "accident", "information"] as const;

describe("alert types", () => {
  it("does not expose low-confidence static event categories", () => {
    for (const type of removedStaticTypes) {
      expect(alertTypes).not.toContain(type);
    }
  });

  it("prunes removed alert types at the database constraint", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "migrations/0010_prune_static_alert_types.sql"),
      "utf8",
    );

    for (const type of removedStaticTypes) {
      expect(migration).toContain(`'${type}'`);
    }
    expect(migration).toContain("delete from road_alerts");
    expect(migration).toContain("road_alerts_type_check");

    const constraintDefinition = migration.slice(migration.indexOf("add constraint road_alerts_type_check"));
    for (const type of removedStaticTypes) {
      expect(constraintDefinition).not.toContain(`'${type}'`);
    }
  });
});
