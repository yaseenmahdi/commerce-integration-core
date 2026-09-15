import { loadConfig } from "../src/config.js";
import { closePool } from "../src/database/pool.js";
import { logger } from "../src/logger.js";
import { runInventorySync } from "../src/workers/inventory-sync.js";

loadConfig();

runInventorySync()
  .catch((err) => {
    logger.error({ err }, "inventory-sync script failed");
    process.exitCode = 1;
  })
  .finally(() => closePool());
