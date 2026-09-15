import { getConfig } from "../config.js";
import { withClient } from "../database/pool.js";
import { logger } from "../logger.js";
import { computeTiktokSla, nextSlaAction } from "../policy/sla.js";

type OpenWatch = {
  id: string;
  order_id: string;
  channel: string;
  deadline_at: Date;
  escalate_at: Date;
  tracking_number: string | null;
  awaiting_at: Date;
};

export async function runSlaWatch(): Promise<void> {
  const config = getConfig();
  const now = new Date();

  await withClient(async (db) => {
    const result = await db.query<OpenWatch>(
      `SELECT w.id, w.order_id, w.channel, w.deadline_at, w.escalate_at,
              o.tracking_number, COALESCE(o.paid_at, o.created_at) AS awaiting_at
       FROM sla_watches w
       JOIN orders o ON o.id = w.order_id
       WHERE w.tracking_pushed_at IS NULL
         AND w.channel = 'tiktok_shop_us'
       ORDER BY w.deadline_at ASC
       LIMIT 100`,
    );

    for (const row of result.rows) {
      const clock = computeTiktokSla(row.awaiting_at, config.TIKTOK_TRACKING_SLA_HOURS, config.TIKTOK_SLA_ESCALATE_HOURS);
      const action = nextSlaAction(now, clock, Boolean(row.tracking_number));
      await db.query(`UPDATE sla_watches SET last_polled_at = NOW() WHERE id = $1`, [row.id]);

      if (action === "wait") {
        await db.query(
          `UPDATE sla_watches
           SET tracking_pushed_at = COALESCE(tracking_pushed_at, NOW()), sync_status = 'completed'
           WHERE id = $1`,
          [row.id],
        );
        continue;
      }

      if (action === "poll_supplier" || action === "escalate" || action === "upload_tracking") {
        if (action !== "poll_supplier") {
          await db.query(
            `UPDATE sla_watches
             SET alert_sent_at = COALESCE(alert_sent_at, NOW()), sync_status = 'processing'
             WHERE id = $1`,
            [row.id],
          );
        }
        logger.warn(
          {
            orderId: row.order_id,
            action,
            trackingUploadBy: clock.trackingUploadBy.toISOString(),
            dispatchBy: clock.dispatchBy.toISOString(),
            endpoint: "sla-watch",
            timestamp: now.toISOString(),
          },
          "TikTok SLA watch — poll supplier and push tracking immediately",
        );
      }

      if (action === "breach") {
        await db.query(
          `UPDATE sla_watches SET sync_status = 'failed', error_log = $2 WHERE id = $1`,
          [row.id, "tiktok_dispatch_sla_breached"],
        );
        await db.query(
          `UPDATE orders
           SET fulfillment_state = 'sla_breached', sla_breached_at = NOW(),
               sync_status = 'failed', error_log = $2
           WHERE id = $1`,
          [row.order_id, "tiktok_dispatch_sla_breached"],
        );
        logger.error(
          { orderId: row.order_id, endpoint: "sla-watch", timestamp: now.toISOString() },
          "TikTok dispatch SLA breached",
        );
      }
    }
  });
}
