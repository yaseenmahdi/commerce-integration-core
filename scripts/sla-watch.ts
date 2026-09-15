import { loadConfig } from "../src/config.js";
import { closePool } from "../src/database/pool.js";
import { logger } from "../src/logger.js";
import { runSlaWatch } from "../src/workers/sla-watch.js";

loadConfig();

runSlaWatch()
  .catch((err) => {
    logger.error({ err }, "sla-watch script failed");
    process.exitCode = 1;
  })
  .finally(() => closePool());
