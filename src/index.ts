import express from "express";
import helmet from "helmet";
import cron from "node-cron";
import { loadConfig } from "./config.js";
import { closePool } from "./database/pool.js";
import { logger } from "./logger.js";
import { webhookRouter } from "./webhooks/router.js";
import { runInventorySync } from "./workers/inventory-sync.js";
import { runSlaWatch } from "./workers/sla-watch.js";

const config = loadConfig();
const app = express();

app.use(helmet());
app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "commerce-integration-core" });
});

app.use("/webhooks", webhookRouter);

cron.schedule(config.INVENTORY_SYNC_CRON, () => {
  runInventorySync().catch((err) => logger.error({ err, endpoint: "cron:inventory" }, "cron inventory failed"));
});
cron.schedule(config.SLA_WATCH_CRON, () => {
  runSlaWatch().catch((err) => logger.error({ err, endpoint: "cron:sla" }, "cron sla-watch failed"));
});

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, "commerce integration service listening");
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  server.close();
  await closePool();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
