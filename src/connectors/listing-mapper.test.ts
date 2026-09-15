import test from "node:test";
import assert from "node:assert/strict";
import { formatListingPayloads } from "./listing-mapper.js";
import type { SupplierProduct, SupplierVariant } from "./types.js";

const variant: SupplierVariant = {
  supplierVariantId: "v1",
  sku: "USB-C-HUB",
  costCents: 1200,
  shippingCents: 400,
  currency: "USD",
  quantityAvailable: 18,
  gtin: "012345678905",
  weightGrams: 220,
};

const product: SupplierProduct = {
  supplier: "cj",
  supplierProductId: "p1",
  title: "USB-C Hub",
  description: "7-in-1 hub",
  brand: "Acme",
  category: "Electronics",
  shipsFromCountry: "US",
  warehouseCode: "NJ",
  warehouseVerified: true,
  processingDaysMin: 1,
  processingDaysMax: 1,
  transitDaysMin: 3,
  transitDaysMax: 5,
  competitorBrandedPackaging: false,
  images: ["https://cdn.example.com/hub.jpg"],
  variants: [variant],
  raw: { supplier_name: "CJ US" },
};

test("formats Shopify, TikTok, and Walmart payloads for a US-warehouse SKU", () => {
  const listing = formatListingPayloads(product, variant, 2.2);
  assert.equal(listing.sku, "cj-USB-C-HUB");
  assert.equal(listing.priceCents, 3520);
  assert.equal(listing.eligibility.listable, true);
  assert.equal(listing.eligibility.tiktok, true);
  assert.equal(listing.eligibility.walmart, true);

  const shopify = listing.payloads.shopify as { product: { variants: Array<{ price: string; sku: string }> } };
  assert.equal(shopify.product.variants[0]?.price, "35.20");
  assert.equal(shopify.product.variants[0]?.sku, "cj-USB-C-HUB");

  const tiktok = listing.payloads.tiktok as { shipping_info: { origin_country: string } };
  assert.equal(tiktok.shipping_info.origin_country, "US");

  const walmart = listing.payloads.walmart as { MPItem: Array<{ Orderable: { sku: string } }> };
  assert.equal(walmart.MPItem[0]?.Orderable.sku, "cj-USB-C-HUB");
});

test("blocks Walmart payload quantity path when packaging is competitor-branded", () => {
  const blocked = formatListingPayloads(
    { ...product, competitorBrandedPackaging: true },
    variant,
    2.2,
  );
  assert.equal(blocked.eligibility.walmart, false);
  assert.ok(blocked.eligibility.reasons.includes("walmart_competitor_packaging"));
});
