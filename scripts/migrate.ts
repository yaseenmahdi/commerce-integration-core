import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { closePool, withClient } from "../src/database/pool.js";
import { logger } from "../src/logger.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function migrate(): Promise<void> {
  loadConfig();
  const sql = await readFile(path.join(root, "sql", "schema.sql"), "utf8");
  await withClient(async (client) => {
    await client.query(sql);
  });
  logger.info("schema applied");
}

migrate()
  .catch((err) => {
    logger.error({ err }, "migrate failed");
    process.exitCode = 1;
  })
  .finally(() => closePool());
