import test from "node:test";
import assert from "node:assert/strict";
import { applyMarkup, evaluateShippingPolicy } from "./shipping.js";

test("rejects China origin even if transit looks fast", () => {
  const result = evaluateShippingPolicy({
    shipsFromCountry: "CN",
    warehouseVerified: true,
    processingDaysMin: 1,
    processingDaysMax: 1,
    transitDaysMin: 3,
    transitDaysMax: 5,
    quantityAvailable: 20,
    competitorBrandedPackaging: false,
  });
  assert.equal(result.listable, false);
  assert.ok(result.reasons.includes("origin_not_us"));
});

test("accepts verified US 3-5 day stock for Shopify", () => {
  const result = evaluateShippingPolicy({
    shipsFromCountry: "US",
    warehouseVerified: true,
    processingDaysMin: 1,
    processingDaysMax: 1,
    transitDaysMin: 3,
    transitDaysMax: 5,
    quantityAvailable: 12,
    competitorBrandedPackaging: false,
    gtin: "012345678905",
  });
  assert.equal(result.listable, true);
  assert.equal(result.shopify, true);
  assert.equal(result.tiktok, true);
  assert.equal(result.walmart, true);
});

test("TikTok eligibility fails when processing + transit exceeds 6 days", () => {
  const result = evaluateShippingPolicy({
    shipsFromCountry: "US",
    warehouseVerified: true,
    processingDaysMin: 1,
    processingDaysMax: 3,
    transitDaysMin: 3,
    transitDaysMax: 5,
    quantityAvailable: 8,
    competitorBrandedPackaging: false,
  });
  assert.equal(result.listable, true);
  assert.equal(result.tiktok, false);
  assert.ok(result.reasons.includes("tiktok_total_days_exceed_deliver_by_sla"));
});

test("Walmart rejects competitor-branded packaging", () => {
  const result = evaluateShippingPolicy({
    shipsFromCountry: "US",
    warehouseVerified: true,
    processingDaysMin: 1,
    processingDaysMax: 1,
    transitDaysMin: 3,
    transitDaysMax: 4,
    quantityAvailable: 5,
    competitorBrandedPackaging: true,
    gtin: "012345678905",
  });
  assert.equal(result.walmart, false);
  assert.ok(result.reasons.includes("walmart_competitor_packaging"));
});

test("markup is applied to landed cost", () => {
  assert.equal(applyMarkup(1000, 400, 2.2), 3080);
});
