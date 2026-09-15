import pg from "pg";
import { getConfig } from "../config.js";
import { logger } from "../logger.js";

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (pool) return pool;
  const config = getConfig();
  pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.PG_POOL_MAX,
    ssl: config.NODE_ENV === "production" ? { rejectUnauthorized: true } : false,
  });
  pool.on("error", (err) => {
    logger.error({ err }, "pg pool idle client error");
  });
  return pool;
}

export async function withClient<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = undefined;
}
