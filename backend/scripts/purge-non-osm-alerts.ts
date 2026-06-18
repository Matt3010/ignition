import { createPool } from "../src/infrastructure/database/postgres.js";
import { loadConfig } from "../src/config/env.js";

const config = loadConfig();
const pool = createPool(config);

try {
  const result = await pool.query("delete from road_alerts where source <> $1", ["osm"]);
  console.log(JSON.stringify({ deleted: result.rowCount ?? 0, keptSource: "osm" }, null, 2));
} finally {
  await pool.end();
}
