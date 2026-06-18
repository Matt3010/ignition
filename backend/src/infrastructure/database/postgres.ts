import pg from "pg";
import type { AppConfig } from "../../config/env.js";

export function createPool(config: AppConfig): pg.Pool {
  return new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 3000,
  });
}

export async function databaseHealth(pool: pg.Pool): Promise<"up" | "down"> {
  try {
    await pool.query("select 1");
    return "up";
  } catch {
    return "down";
  }
}
