import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { alertTypes } from "../../src/domain/models/alert.js";

const removedAlertTypes = [
  "mobileSpeedCamera",
  "accident",
  "information",
  "weightControl",
  "genericEnforcement",
  "policeControl",
  "roadHazard",
  "roadWorks",
  "roadClosure",
] as const;

describe("alert types", () => {
  it("does not expose low-confidence static event categories", () => {
    for (const type of removedAlertTypes) {
      expect(alertTypes).not.toContain(type);
    }
  });

  it("prunes removed alert types at the database constraint", () => {
    const firstPruneMigration = readFileSync(
      resolve(process.cwd(), "migrations/0010_prune_static_alert_types.sql"),
      "utf8",
    );
    const latestPruneMigration = readFileSync(
      resolve(process.cwd(), "migrations/0012_prune_road_closure.sql"),
      "utf8",
    );
    const secondPruneMigration = readFileSync(
      resolve(process.cwd(), "migrations/0011_prune_road_hazard_and_works.sql"),
      "utf8",
    );
    const pruningMigrations = `${firstPruneMigration}\n${secondPruneMigration}\n${latestPruneMigration}`;

    for (const type of removedAlertTypes) {
      expect(pruningMigrations).toContain(`'${type}'`);
    }
    expect(pruningMigrations).toContain("delete from road_alerts");
    expect(latestPruneMigration).toContain("road_alerts_type_check");

    const constraintDefinition = latestPruneMigration.slice(
      latestPruneMigration.indexOf("add constraint road_alerts_type_check"),
    );
    for (const type of removedAlertTypes) {
      expect(constraintDefinition).not.toContain(`'${type}'`);
    }
  });
});
