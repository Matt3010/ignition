import { createHash } from "node:crypto";
import { createPool } from "../src/infrastructure/database/postgres.js";
import { PostgisAlertRepository } from "../src/infrastructure/repositories/postgis-alert-repository.js";
import { loadConfig } from "../src/config/env.js";
import { createMockAlerts } from "../src/mock/mock-data.js";
import type { RoadAlert } from "../src/domain/models/alert.js";

const config = loadConfig();
const pool = createPool(config);
try {
  const repository = new PostgisAlertRepository(pool);
  const count = await repository.upsertMany(createMockAlerts().map(withUuidId));
  console.log(JSON.stringify({ insertedOrUpdated: count }, null, 2));
} finally {
  await pool.end();
}

function withUuidId(alert: RoadAlert): RoadAlert {
  return {
    ...alert,
    id: isUuid(alert.id) ? alert.id : stableUuid(alert.id),
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function stableUuid(value: string): string {
  const hash = createHash("sha1").update(value).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
