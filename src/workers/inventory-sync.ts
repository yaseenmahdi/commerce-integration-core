import { CjClient } from "../connectors/cj.js";
import { formatListingPayloads } from "../connectors/listing-mapper.js";
import type { SupplierClient } from "../connectors/types.js";
import { ZendropClient } from "../connectors/zendrop.js";
import { getConfig } from "../config.js";
import {
  finishSyncJob,
  getSupplierId,
  startSyncJob,
  upsertChannelListing,
  upsertInventory,
  upsertProduct,
  upsertVariant,
} from "../database/catalog.js";
import { withClient } from "../database/pool.js";
import { logger } from "../logger.js";
import { evaluateShippingPolicy } from "../policy/shipping.js";

const PAGE_SIZE = 20;
const MAX_PAGES = 3;

async function ingestClient(client: SupplierClient): Promise<{ seen: number; written: number }> {
  const config = getConfig();
  let seen = 0;
  let written = 0;

  await withClient(async (db) => {
    const supplierId = await getSupplierId(db, client.code);
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const products = await client.listUsWarehouseProducts(page, PAGE_SIZE);
      if (products.length === 0) break;
      for (const product of products) {
        for (const variant of product.variants) {
          seen += 1;
          const eligibility = evaluateShippingPolicy(
            {
              shipsFromCountry: product.shipsFromCountry,
              warehouseVerified: product.warehouseVerified,
              processingDaysMin: product.processingDaysMin,
              processingDaysMax: product.processingDaysMax,
              transitDaysMin: product.transitDaysMin,
              transitDaysMax: product.transitDaysMax,
              quantityAvailable: variant.quantityAvailable,
              competitorBrandedPackaging: product.competitorBrandedPackaging,
              gtin: variant.gtin ?? product.gtin,
              supplierName: String(product.raw.supplier_name ?? product.supplier),
            },
            {
              minTransit: config.MIN_TRANSIT_DAYS,
              maxTransit: config.MAX_TRANSIT_DAYS,
              maxTiktokTotal: config.MAX_TIKTOK_TOTAL_DAYS,
            },
          );
          const reason = eligibility.reasons.join(",") || "ok";
          const productId = await upsertProduct(db, supplierId, product, eligibility, reason);
          const variantId = await upsertVariant(db, productId, variant);
          await upsertInventory(
            db,
            variantId,
            product.warehouseCode ?? "US",
            product.shipsFromCountry || "US",
            variant.quantityAvailable,
            product.warehouseVerified,
          );

          const formatted = formatListingPayloads(product, variant, config.MARKUP_PERCENT);
          await upsertChannelListing(
            db,
            productId,
            variantId,
            "shopify",
            formatted.sku,
            formatted.priceCents,
            eligibility.shopify ? variant.quantityAvailable : 0,
            formatted.payloads.shopify,
            eligibility.shopify,
          );
          await upsertChannelListing(
            db,
            productId,
            variantId,
            "tiktok_shop_us",
            formatted.sku,
            formatted.priceCents,
            eligibility.tiktok ? variant.quantityAvailable : 0,
            formatted.payloads.tiktok,
            eligibility.tiktok,
          );
          await upsertChannelListing(
            db,
            productId,
            variantId,
            "walmart",
            formatted.sku,
            formatted.priceCents,
            eligibility.walmart ? variant.quantityAvailable : 0,
            formatted.payloads.walmart,
            eligibility.walmart,
          );
          if (eligibility.listable) written += 1;
          logger.info(
            {
              supplier: product.supplier,
              sku: formatted.sku,
              listable: eligibility.listable,
              tiktok: eligibility.tiktok,
              walmart: eligibility.walmart,
              reasons: eligibility.reasons,
            },
            "inventory row evaluated",
          );
        }
      }
    }
  });

  return { seen, written };
}

export async function runInventorySync(): Promise<void> {
  const config = getConfig();
  const jobId = await withClient((db) => startSyncJob(db, "inventory-sync"));
  let seen = 0;
  let written = 0;
  try {
    const clients: SupplierClient[] = [];
    if (config.CJ_ENABLED) clients.push(new CjClient());
    if (config.ZENDROP_ENABLED) clients.push(new ZendropClient());
    if (clients.length === 0) {
      logger.warn("inventory-sync skipped: no suppliers enabled");
    }
    for (const client of clients) {
      const result = await ingestClient(client);
      seen += result.seen;
      written += result.written;
    }
    await withClient((db) => finishSyncJob(db, jobId, "completed", seen, written));
    logger.info({ seen, written }, "inventory-sync completed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await withClient((db) => finishSyncJob(db, jobId, "failed", seen, written, message));
    logger.error({ err, endpoint: "inventory-sync", timestamp: new Date().toISOString() }, "inventory-sync failed");
    throw err;
  }
}
