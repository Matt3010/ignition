import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createPool } from "../src/infrastructure/database/postgres.js";
import { loadConfig } from "../src/config/env.js";

const config = loadConfig();
const pool = createPool(config);
const migrationsDir = join(process.cwd(), "migrations");

try {
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), "utf8");
    await pool.query(sql);
    console.log(`applied ${file}`);
  }
} finally {
  await pool.end();
}
