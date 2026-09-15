import type { PoolClient } from "pg";
import type { Eligibility } from "../policy/shipping.js";
import type { SupplierProduct, SupplierVariant } from "../connectors/types.js";

export async function getSupplierId(client: PoolClient, code: "zendrop" | "cj"): Promise<string> {
  const result = await client.query<{ id: string }>("SELECT id FROM suppliers WHERE code = $1", [code]);
  const id = result.rows[0]?.id;
  if (!id) throw new Error(`Supplier ${code} is not seeded`);
  return id;
}

export async function upsertProduct(
  client: PoolClient,
  supplierId: string,
  product: SupplierProduct,
  eligibility: Eligibility,
  reason: string,
): Promise<string> {
  const origin = product.shipsFromCountry === "US" ? "us_warehouse" : product.shipsFromCountry ? "overseas" : "unknown";
  const result = await client.query<{ id: string }>(
    `INSERT INTO products (
       supplier_id, supplier_product_id, title, description, brand, category, origin,
       ships_from_country, processing_days_min, processing_days_max, transit_days_min, transit_days_max,
       competitor_branded_packaging, gtin, images, raw_payload, is_listable, listable_reason,
       tiktok_eligible, walmart_eligible, shopify_eligible, sync_status, error_log
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17,$18,$19,$20,$21,
       $22::sync_status, NULL
     )
     ON CONFLICT (supplier_id, supplier_product_id) DO UPDATE SET
       title = EXCLUDED.title,
       description = EXCLUDED.description,
       origin = EXCLUDED.origin,
       ships_from_country = EXCLUDED.ships_from_country,
       processing_days_min = EXCLUDED.processing_days_min,
       processing_days_max = EXCLUDED.processing_days_max,
       transit_days_min = EXCLUDED.transit_days_min,
       transit_days_max = EXCLUDED.transit_days_max,
       competitor_branded_packaging = EXCLUDED.competitor_branded_packaging,
       gtin = EXCLUDED.gtin,
       images = EXCLUDED.images,
       raw_payload = EXCLUDED.raw_payload,
       is_listable = EXCLUDED.is_listable,
       listable_reason = EXCLUDED.listable_reason,
       tiktok_eligible = EXCLUDED.tiktok_eligible,
       walmart_eligible = EXCLUDED.walmart_eligible,
       shopify_eligible = EXCLUDED.shopify_eligible,
       sync_status = EXCLUDED.sync_status,
       error_log = NULL
     RETURNING id`,
    [
      supplierId,
      product.supplierProductId,
      product.title,
      product.description ?? null,
      product.brand ?? null,
      product.category ?? null,
      origin,
      product.shipsFromCountry.slice(0, 2),
      product.processingDaysMin,
      product.processingDaysMax,
      product.transitDaysMin,
      product.transitDaysMax,
      product.competitorBrandedPackaging,
      product.gtin ?? null,
      JSON.stringify(product.images),
      JSON.stringify(product.raw),
      eligibility.listable,
      reason,
      eligibility.tiktok,
      eligibility.walmart,
      eligibility.shopify,
      eligibility.listable ? "completed" : "failed",
    ],
  );
  return result.rows[0]!.id;
}

export async function upsertVariant(
  client: PoolClient,
  productId: string,
  variant: SupplierVariant,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO product_variants (
       product_id, supplier_variant_id, sku, title, option_values, cost_cents, shipping_cents,
       currency, weight_grams, gtin
     ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)
     ON CONFLICT (product_id, supplier_variant_id) DO UPDATE SET
       sku = EXCLUDED.sku,
       title = EXCLUDED.title,
       cost_cents = EXCLUDED.cost_cents,
       shipping_cents = EXCLUDED.shipping_cents,
       weight_grams = EXCLUDED.weight_grams,
       gtin = EXCLUDED.gtin
     RETURNING id`,
    [
      productId,
      variant.supplierVariantId,
      variant.sku,
      variant.title ?? null,
      JSON.stringify(variant.optionValues ?? {}),
      variant.costCents,
      variant.shippingCents,
      variant.currency,
      variant.weightGrams ?? null,
      variant.gtin ?? null,
    ],
  );
  return result.rows[0]!.id;
}

export async function upsertInventory(
  client: PoolClient,
  variantId: string,
  warehouseCode: string,
  country: string,
  quantity: number,
  verified: boolean,
): Promise<void> {
  await client.query(
    `INSERT INTO supplier_inventory (
       variant_id, warehouse_code, warehouse_country, quantity_available, is_verified, fetched_at, sync_status
     ) VALUES ($1,$2,$3,$4,$5, NOW(), 'completed')
     ON CONFLICT (variant_id, warehouse_code) DO UPDATE SET
       quantity_available = EXCLUDED.quantity_available,
       warehouse_country = EXCLUDED.warehouse_country,
       is_verified = EXCLUDED.is_verified,
       fetched_at = NOW(),
       sync_status = 'completed',
       error_log = NULL`,
    [variantId, warehouseCode, country.slice(0, 2), quantity, verified],
  );
}

export async function upsertChannelListing(
  client: PoolClient,
  productId: string,
  variantId: string,
  channel: "shopify" | "tiktok_shop_us" | "walmart",
  channelSku: string,
  priceCents: number,
  quantity: number,
  payload: Record<string, unknown>,
  eligible: boolean,
): Promise<void> {
  await client.query(
    `INSERT INTO channel_listings (
       product_id, variant_id, channel, channel_sku, price_cents, listed_quantity, listing_payload, sync_status, error_log
     ) VALUES ($1,$2,$3::sales_channel,$4,$5,$6,$7::jsonb,$8::sync_status,$9)
     ON CONFLICT (channel, variant_id) DO UPDATE SET
       channel_sku = EXCLUDED.channel_sku,
       price_cents = EXCLUDED.price_cents,
       listed_quantity = EXCLUDED.listed_quantity,
       listing_payload = EXCLUDED.listing_payload,
       sync_status = EXCLUDED.sync_status,
       error_log = EXCLUDED.error_log`,
    [
      productId,
      variantId,
      channel,
      channelSku,
      priceCents,
      quantity,
      JSON.stringify(payload),
      eligible ? "pending" : "failed",
      eligible ? null : "channel_ineligible",
    ],
  );
}

export async function startSyncJob(client: PoolClient, jobName: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO sync_jobs (job_name, sync_status) VALUES ($1, 'processing') RETURNING id`,
    [jobName],
  );
  return result.rows[0]!.id;
}

export async function finishSyncJob(
  client: PoolClient,
  jobId: string,
  status: "completed" | "failed",
  seen: number,
  written: number,
  errorLog?: string,
): Promise<void> {
  await client.query(
    `UPDATE sync_jobs
     SET finished_at = NOW(), sync_status = $2::sync_status, rows_seen = $3, rows_written = $4, error_log = $5
     WHERE id = $1`,
    [jobId, status, seen, written, errorLog ?? null],
  );
}

export async function upsertInboundOrder(
  client: PoolClient,
  input: {
    channel: "shopify" | "tiktok_shop_us" | "walmart";
    externalOrderId: string;
    payload: unknown;
    paidAt?: Date;
  },
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO orders (
       channel, external_order_id, idempotency_key, shipping_address,
       subtotal_cents, shipping_cents, total_cents, paid_at, raw_payload,
       fulfillment_state, sync_status
     ) VALUES (
       $1::sales_channel, $2, $3, '{}'::jsonb, 0, 0, 0, $4, $5::jsonb, 'received', 'pending'
     )
     ON CONFLICT (channel, external_order_id) DO UPDATE SET
       raw_payload = EXCLUDED.raw_payload,
       paid_at = COALESCE(orders.paid_at, EXCLUDED.paid_at)
     RETURNING id`,
    [
      input.channel,
      input.externalOrderId,
      `${input.channel}:${input.externalOrderId}`,
      input.paidAt ?? null,
      JSON.stringify(input.payload ?? {}),
    ],
  );
  return result.rows[0]!.id;
}

export async function armSlaWatch(
  client: PoolClient,
  orderId: string,
  channel: "shopify" | "tiktok_shop_us" | "walmart",
  deadlineAt: Date,
  escalateAt: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO sla_watches (order_id, channel, deadline_at, escalate_at, sync_status)
     VALUES ($1, $2::sales_channel, $3, $4, 'pending')
     ON CONFLICT (order_id) DO NOTHING`,
    [orderId, channel, deadlineAt, escalateAt],
  );
}
