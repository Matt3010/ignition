import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createPool } from "../src/infrastructure/database/postgres.js";
import { loadConfig } from "../src/config/env.js";

const config = loadConfig();
const pool = createPool(config);
const migrationsDir = join(process.cwd(), "migrations");
const lockName = "ignition_schema_migrations";
const client = await pool.connect();

try {
  await client.query("select pg_advisory_lock(hashtext($1))", [lockName]);
  await client.query(`
    create table if not exists schema_migrations (
      filename text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);

  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  const existingResult = await client.query<{ filename: string; checksum: string }>(
    "select filename, checksum from schema_migrations",
  );
  const existing = new Map(existingResult.rows.map((row) => [row.filename, row.checksum]));

  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const previousChecksum = existing.get(file);
    if (previousChecksum) {
      if (previousChecksum !== checksum) {
        throw new Error(`Migration ${file} changed after it was applied`);
      }
      console.log(`skipped ${file}`);
      continue;
    }

    await client.query("begin");
    try {
      await client.query(sql);
      await client.query(
        "insert into schema_migrations (filename, checksum) values ($1, $2)",
        [file, checksum],
      );
      await client.query("commit");
      console.log(`applied ${file}`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
} finally {
  try {
    await client.query("select pg_advisory_unlock(hashtext($1))", [lockName]);
  } finally {
    client.release();
    await pool.end();
  }
}
