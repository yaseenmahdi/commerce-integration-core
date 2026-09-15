import { Router, type Request, type Response } from "express";
import { getConfig } from "../config.js";
import { armSlaWatch, upsertInboundOrder } from "../database/catalog.js";
import { withClient } from "../database/pool.js";
import { logger } from "../logger.js";
import { computeTiktokSla } from "../policy/sla.js";
import {
  WebhookSignatureError,
  verifyCjHmac,
  verifyShopifyHmac,
  verifyTiktokHmac,
  verifyWalmartHmac,
} from "./hmac.js";

export const webhookRouter = Router();

function rawBody(req: Request): Buffer {
  const buf = (req as Request & { rawBody?: Buffer }).rawBody;
  if (buf) return buf;
  return Buffer.from(JSON.stringify(req.body ?? {}));
}

async function recordEvent(
  channel: string,
  eventName: string,
  externalEventId: string,
  signatureValid: boolean,
  payload: unknown,
): Promise<boolean> {
  const inserted = await withClient(async (db) => {
    const result = await db.query(
      `INSERT INTO webhook_events (channel, event_name, external_event_id, signature_valid, payload, sync_status)
       VALUES ($1,$2,$3,$4,$5::jsonb,'pending')
       ON CONFLICT (channel, external_event_id) DO NOTHING
       RETURNING id`,
      [channel, eventName, externalEventId, signatureValid, JSON.stringify(payload)],
    );
    return Boolean(result.rowCount);
  });
  return inserted;
}

webhookRouter.post("/shopify/orders", async (req: Request, res: Response) => {
  const config = getConfig();
  try {
    verifyShopifyHmac(rawBody(req), req.header("x-shopify-hmac-sha256") ?? undefined, config.SHOPIFY_WEBHOOK_SECRET);
    const orderId = String(req.body?.id ?? "");
    const inserted = await recordEvent("shopify", String(req.header("x-shopify-topic") ?? "orders"), orderId, true, req.body);
    res.status(200).json({ ok: true, duplicate: !inserted });
  } catch (err) {
    handleWebhookError(res, "shopify", err);
  }
});

webhookRouter.post("/tiktok/orders", async (req: Request, res: Response) => {
  const config = getConfig();
  try {
    verifyTiktokHmac(
      rawBody(req),
      req.header("x-tts-timestamp") ?? undefined,
      req.header("x-tts-signature") ?? undefined,
      config.TIKTOK_SHOP_WEBHOOK_SECRET,
    );
    const orderId = String(req.body?.data?.order_id ?? req.body?.order_id ?? "");
    const inserted = await recordEvent("tiktok_shop_us", String(req.body?.type ?? "order"), orderId, true, req.body);
    if (inserted && orderId) {
      const sla = computeTiktokSla(new Date(), config.TIKTOK_TRACKING_SLA_HOURS, config.TIKTOK_SLA_ESCALATE_HOURS);
      await withClient(async (db) => {
        const dbOrderId = await upsertInboundOrder(db, {
          channel: "tiktok_shop_us",
          externalOrderId: orderId,
          payload: req.body,
          paidAt: new Date(),
        });
        await armSlaWatch(db, dbOrderId, "tiktok_shop_us", sla.dispatchBy, sla.escalateAt);
      });
      logger.info(
        {
          orderId,
          trackingUploadBy: sla.trackingUploadBy.toISOString(),
          dispatchBy: sla.dispatchBy.toISOString(),
          endpoint: "tiktok/orders",
          timestamp: new Date().toISOString(),
        },
        "tiktok order accepted — SLA watch armed",
      );
    }
    res.status(200).json({ ok: true, duplicate: !inserted });
  } catch (err) {
    handleWebhookError(res, "tiktok_shop_us", err);
  }
});

webhookRouter.post("/walmart/orders", async (req: Request, res: Response) => {
  const config = getConfig();
  try {
    verifyWalmartHmac(rawBody(req), req.header("x-walmart-signature") ?? undefined, config.WALMART_WEBHOOK_SECRET);
    const orderId = String(req.body?.purchaseOrderId ?? "");
    const inserted = await recordEvent("walmart", "orders.created", orderId, true, req.body);
    res.status(200).json({ ok: true, duplicate: !inserted });
  } catch (err) {
    handleWebhookError(res, "walmart", err);
  }
});

webhookRouter.post("/cj/orders", async (req: Request, res: Response) => {
  const config = getConfig();
  try {
    verifyCjHmac(rawBody(req), req.header("x-cj-signature") ?? undefined, config.CJ_WEBHOOK_SECRET);
    const orderId = String(req.body?.orderId ?? req.body?.data?.orderId ?? "");
    const inserted = await recordEvent("cj", String(req.body?.eventType ?? "order"), orderId, true, req.body);
    if (req.body?.data?.trackingNumber) {
      logger.info(
        { orderId, tracking: req.body.data.trackingNumber, endpoint: "cj/orders", timestamp: new Date().toISOString() },
        "CJ tracking webhook — push to channel immediately",
      );
    }
    res.status(200).json({ ok: true, duplicate: !inserted });
  } catch (err) {
    handleWebhookError(res, "cj", err);
  }
});

function handleWebhookError(res: Response, channel: string, err: unknown): void {
  if (err instanceof WebhookSignatureError) {
    logger.warn({ channel, err: err.message, timestamp: new Date().toISOString() }, "webhook signature rejected");
    res.status(401).json({ ok: false, error: "invalid_signature" });
    return;
  }
  logger.error({ channel, err, timestamp: new Date().toISOString() }, "webhook handler failed");
  res.status(500).json({ ok: false, error: "handler_failed" });
}
