import type { SupplierProduct, SupplierVariant } from "../connectors/types.js";

/** Landed supplier cost cap: item + US standard shipping. */
export const MAX_LANDED_COST_CENTS = 1500;
export const RETAIL_MIN_CENTS = 2999;
export const RETAIL_MAX_CENTS = 4499;
export const MIN_GROSS_MARGIN = 0.6;
export const MAX_PACKAGED_WEIGHT_GRAMS = 680;
export const MIN_US_WAREHOUSE_UNITS = 200;

/** Conservative US standard shipping when CJ freight is unavailable. */
export const FALLBACK_US_SHIPPING_CENTS = 699;

const HAZARD_PATTERNS: RegExp[] = [
  /\bglass\b/i,
  /\btempered\s+glass\b/i,
  /\bliquid\b/i,
  /\bserum\b/i,
  /\bshampoo\b/i,
  /\bconditioner\b/i,
  /\blotion\b/i,
  /\bcream\b/i,
  /\bgel\b/i,
  /\bspray\b/i,
  /\btoner\b/i,
  /\bmascara\b/i,
  /\blipstick\b/i,
  /\bdye\b/i,
  /\bpeel-?off\s+mask\b/i,
  /\bpepper\s+spray\b/i,
  /\boil\s+diffuser\b/i,
  /\bessential\s+oil\b/i,
  /\bpowder\b/i,
  /\bingestible\b/i,
  /\bedible\b/i,
  /\bsupplement\b/i,
  /\bvitamin\b/i,
  /\bcapsule\b/i,
  /\btablet\b/i,
  /\bpill\b/i,
  /\bdrink\b/i,
  /\bbeverage\b/i,
  /\btea\b/i,
  /\bcoffee\s+bean\b/i,
  /\bprotein\s+powder\b/i,
  /\bcreatine\b/i,
  /\bcbd\b/i,
  /\bthc\b/i,
  /\bvape\b/i,
  /\bnicotine\b/i,
  /\blaptop\b/i,
  /\bsmartphone\b/i,
  /\biphone\b/i,
  /\btablet\s+pc\b/i,
  /\bdrone\b/i,
  /\bgpu\b/i,
  /\bmotherboard\b/i,
  /\bplaystation\b/i,
  /\bxbox\b/i,
  /\blithium\s+batter(?:y|ies)\b/i,
  /\belectric\s+scooter\b/i,
];

const BRAND_PATTERNS: RegExp[] = [
  /\bnike\b/i,
  /\badidas\b/i,
  /\bgucci\b/i,
  /\bprada\b/i,
  /\bchanel\b/i,
  /\blouis\s+vuitton\b/i,
  /\bherm[eè]s\b/i,
  /\brolex\b/i,
  /\bapple\b/i,
  /\biphone\b/i,
  /\bairpods\b/i,
  /\bmacbook\b/i,
  /\bsamsung\b/i,
  /\bdisney\b/i,
  /\bmarvel\b/i,
  /\bpokemon\b/i,
  /\bnintendo\b/i,
  /\bsony\b/i,
  /\bmicrosoft\b/i,
  /\bsupreme\b/i,
  /\bbalenciaga\b/i,
  /\bjordan\b/i,
  /\blevi'?s\b/i,
  /\bnorth\s+face\b/i,
  /\bpatagonia\b/i,
  /\bcoach\b/i,
  /\byeti\b/i,
  /\breplica\b/i,
  /\binspired\s+by\b/i,
];

const HEALTH_CLAIM_PATTERNS: RegExp[] = [
  /\bcure[sd]?\b/i,
  /\bheal[sd]?\b/i,
  /\btreat(?:s|ment)\b/i,
  /\banti[-\s]?ag(?:e|ing)\b/i,
  /\bwrinkle\b/i,
  /\bacne\b/i,
  /\bblackhead\b/i,
  /\bdandruff\b/i,
  /\bhair\s+growth\b/i,
  /\bhair\s+loss\b/i,
  /\bitch\s+relief\b/i,
  /\bweight\s+loss\b/i,
  /\bfat\s+burn/i,
  /\bfda\s+approved\b/i,
  /\bclinically\s+proven\b/i,
  /\bdermatologist\b/i,
  /\bmedical\b/i,
  /\bprescription\b/i,
  /\bdisease\b/i,
  /\bdiabetes\b/i,
  /\bcancer\b/i,
  /\bcollagen\s+(?:drink|supplement|pill)/i,
  /\bskin\s+whitening\b/i,
  /\beczema\b/i,
];

export type ResearchGateResult = {
  pass: boolean;
  reasons: string[];
  suggestedRetailCents: number;
  grossMargin: number;
};

function haystack(product: SupplierProduct, variant: SupplierVariant): string {
  return [
    product.title,
    product.description ?? "",
    product.category ?? "",
    product.brand ?? "",
    variant.title ?? "",
    variant.sku,
  ].join(" ");
}

function firstMatch(text: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const hit = text.match(pattern);
    if (hit?.[0]) return hit[0].toLowerCase();
  }
  return undefined;
}

/** Round up to a .99 price, then clamp to the $29.99–$44.99 band. */
export function suggestedRetailCents(landedCostCents: number): number {
  const minForMargin = Math.ceil(landedCostCents / (1 - MIN_GROSS_MARGIN));
  const roundedUp = Math.ceil(minForMargin / 100) * 100 - 1;
  return Math.min(Math.max(roundedUp, RETAIL_MIN_CENTS), RETAIL_MAX_CENTS);
}

export function grossMargin(retailCents: number, landedCostCents: number): number {
  if (retailCents <= 0) return 0;
  return (retailCents - landedCostCents) / retailCents;
}

/**
 * Rules 1–4. Rule 5 (Gemini scores) is applied after this gate.
 * `landedCostCents` must already include US standard shipping.
 */
export function evaluateResearchGates(
  product: SupplierProduct,
  variant: SupplierVariant,
  landedCostCents: number,
): ResearchGateResult {
  const reasons: string[] = [];
  const text = haystack(product, variant);

  if (landedCostCents > MAX_LANDED_COST_CENTS) {
    reasons.push("landed_cost_above_15");
  }

  const retail = suggestedRetailCents(landedCostCents);
  const margin = grossMargin(retail, landedCostCents);
  if (margin < MIN_GROSS_MARGIN) {
    reasons.push("gross_margin_below_60");
  }

  if (variant.weightGrams === undefined) {
    reasons.push("missing_weight");
  } else if (variant.weightGrams > MAX_PACKAGED_WEIGHT_GRAMS) {
    reasons.push("weight_above_1_5_lb");
  }

  const hazard = firstMatch(text, HAZARD_PATTERNS);
  if (hazard) reasons.push(`hazard:${hazard}`);

  if (!product.warehouseVerified) {
    reasons.push("warehouse_unverified");
  }
  if (product.shipsFromCountry.toUpperCase() !== "US") {
    reasons.push("origin_not_us");
  }
  if (variant.quantityAvailable < MIN_US_WAREHOUSE_UNITS) {
    reasons.push("us_stock_below_200");
  }

  const brand = firstMatch(text, BRAND_PATTERNS);
  if (brand) reasons.push(`brand:${brand}`);

  const claim = firstMatch(text, HEALTH_CLAIM_PATTERNS);
  if (claim) reasons.push(`health_claim:${claim}`);

  return {
    pass: reasons.length === 0,
    reasons,
    suggestedRetailCents: retail,
    grossMargin: margin,
  };
}

export function cjProductUrl(supplierProductId: string): string {
  return `https://www.cjdropshipping.com/product/${encodeURIComponent(supplierProductId)}.html`;
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
