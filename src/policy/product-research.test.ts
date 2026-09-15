import test from "node:test";
import assert from "node:assert/strict";
import type { SupplierProduct, SupplierVariant } from "../connectors/types.js";
import { heuristicViabilityScores } from "../enrichment/viability-score.js";
import {
  evaluateResearchGates,
  suggestedRetailCents,
  grossMargin,
} from "./product-research.js";

function variant(overrides: Partial<SupplierVariant> = {}): SupplierVariant {
  return {
    supplierVariantId: "vid-1",
    sku: "GARLIC-PRESS",
    costCents: 800,
    shippingCents: 0,
    currency: "USD",
    weightGrams: 220,
    quantityAvailable: 400,
    ...overrides,
  };
}

function product(overrides: Partial<SupplierProduct> = {}, variants?: SupplierVariant[]): SupplierProduct {
  const v = variants ?? [variant()];
  return {
    supplier: "cj",
    supplierProductId: "pid-1",
    title: "Magnetic Garlic Press",
    description: "Peel and press garlic without the mess.",
    category: "Kitchen",
    shipsFromCountry: "US",
    warehouseVerified: true,
    processingDaysMin: 1,
    processingDaysMax: 2,
    transitDaysMin: 3,
    transitDaysMax: 5,
    competitorBrandedPackaging: false,
    images: [],
    raw: { supplier_name: "CJ US" },
    ...overrides,
    variants: overrides.variants ?? v,
  };
}

test("Rule 1: landed cost at $15 suggests retail in band with >= 60% margin", () => {
  const retail = suggestedRetailCents(1500);
  assert.ok(retail >= 2999 && retail <= 4499);
  assert.ok(grossMargin(retail, 1500) >= 0.6);
});

test("Rule 1: rejects landed cost above $15", () => {
  const result = evaluateResearchGates(product(), variant({ costCents: 1600 }), 1699);
  assert.equal(result.pass, false);
  assert.ok(result.reasons.includes("landed_cost_above_15"));
});

test("Rule 2: rejects packaged weight above 680g", () => {
  const heavy = variant({ weightGrams: 900 });
  const result = evaluateResearchGates(product({}, [heavy]), heavy, 1200);
  assert.equal(result.pass, false);
  assert.ok(result.reasons.includes("weight_above_1_5_lb"));
});

test("Rule 2: rejects glass / liquid / ingestible / complex electronics", () => {
  const v = variant();
  const glass = evaluateResearchGates(product({ title: "Tempered glass screen protector" }, [v]), v, 900);
  assert.ok(glass.reasons.some((r) => r.startsWith("hazard:")));
  const drink = evaluateResearchGates(product({ title: "Collagen drink mix" }, [v]), v, 900);
  assert.ok(drink.reasons.some((r) => r.startsWith("hazard:")));
  const shampoo = evaluateResearchGates(product({ title: "Anti-dandruff shampoo" }, [v]), v, 900);
  assert.ok(shampoo.reasons.some((r) => r.startsWith("hazard:")));
});

test("Rule 3: rejects US warehouse stock below 200", () => {
  const low = variant({ quantityAvailable: 50 });
  const result = evaluateResearchGates(product({}, [low]), low, 900);
  assert.equal(result.pass, false);
  assert.ok(result.reasons.includes("us_stock_below_200"));
});

test("Rule 4: rejects brand keywords and health claims", () => {
  const v = variant();
  const nike = evaluateResearchGates(product({ title: "Nike inspired running socks" }, [v]), v, 900);
  assert.ok(nike.reasons.some((r) => r.startsWith("brand:")));
  const acne = evaluateResearchGates(product({ title: "Acne treatment roller" }, [v]), v, 900);
  assert.ok(acne.reasons.some((r) => r.startsWith("health_claim:")));
});

test("Rule 4: pineapple does not trip the Apple brand gate", () => {
  const v = variant();
  const result = evaluateResearchGates(
    product({ title: "Pineapple corer", description: "Kitchen gadget for pineapple" }, [v]),
    v,
    900,
  );
  assert.equal(result.reasons.some((r) => r.includes("apple")), false);
});

test("healthy kitchen gadget passes rules 1–4", () => {
  const v = variant({ costCents: 700, weightGrams: 180, quantityAvailable: 500 });
  const result = evaluateResearchGates(product({}, [v]), v, 700 + 699);
  assert.equal(result.pass, true);
  assert.ok(result.suggestedRetailCents >= 2999);
  assert.ok(result.suggestedRetailCents <= 4499);
});

test("Rule 5 heuristic boosts demo and problem language", () => {
  const dull = heuristicViabilityScores("Plastic widget", "A generic item");
  const demo = heuristicViabilityScores("Magnetic garlic press", "Peel garlic and stop the kitchen mess and clutter");
  assert.ok(demo.viralVideoPotential >= dull.viralVideoPotential);
  assert.ok(demo.problemSolvingValue >= dull.problemSolvingValue);
  assert.equal(demo.source, "heuristic");
});
