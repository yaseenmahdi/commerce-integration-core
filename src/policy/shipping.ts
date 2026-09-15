export type ShippingPolicyInput = {
  shipsFromCountry: string;
  warehouseVerified: boolean;
  processingDaysMin: number;
  processingDaysMax: number;
  transitDaysMin: number;
  transitDaysMax: number;
  quantityAvailable: number;
  competitorBrandedPackaging: boolean;
  gtin?: string | undefined;
  supplierName?: string | undefined;
};

export type Eligibility = {
  listable: boolean;
  shopify: boolean;
  tiktok: boolean;
  walmart: boolean;
  reasons: string[];
};

const US = "US";
const CHINA_SUPPLIER_MARKERS = ["zendrop fulfillment", "cj china", "cn warehouse"];

function isUsOrigin(country: string): boolean {
  return country.trim().toUpperCase() === US;
}

export function evaluateShippingPolicy(
  input: ShippingPolicyInput,
  bounds = { minTransit: 3, maxTransit: 5, maxTiktokTotal: 6 },
): Eligibility {
  const reasons: string[] = [];

  if (!isUsOrigin(input.shipsFromCountry)) {
    reasons.push("origin_not_us");
  }
  if (!input.warehouseVerified) {
    reasons.push("warehouse_unverified");
  }
  if (input.quantityAvailable <= 0) {
    reasons.push("out_of_stock");
  }
  if (input.transitDaysMin < bounds.minTransit || input.transitDaysMax > bounds.maxTransit) {
    reasons.push("transit_outside_3_to_5_days");
  }
  const supplier = (input.supplierName ?? "").toLowerCase();
  if (CHINA_SUPPLIER_MARKERS.some((m) => supplier.includes(m))) {
    reasons.push("china_fulfillment_supplier");
  }

  const originOk = !reasons.includes("origin_not_us") && !reasons.includes("china_fulfillment_supplier");
  const speedOk = !reasons.includes("transit_outside_3_to_5_days");
  const stockOk = !reasons.includes("out_of_stock") && !reasons.includes("warehouse_unverified");
  const listable = originOk && speedOk && stockOk;

  const totalMax = input.processingDaysMax + input.transitDaysMax;
  const tiktok =
    listable &&
    totalMax <= bounds.maxTiktokTotal &&
    input.processingDaysMax <= 2;

  const walmart =
    listable &&
    Boolean(input.gtin && /^\d{12,14}$/.test(input.gtin)) &&
    !input.competitorBrandedPackaging;

  if (listable && !tiktok) reasons.push("tiktok_total_days_exceed_deliver_by_sla");
  if (listable && !walmart && !input.gtin) reasons.push("walmart_missing_gtin");
  if (listable && input.competitorBrandedPackaging) reasons.push("walmart_competitor_packaging");

  return {
    listable,
    shopify: listable,
    tiktok,
    walmart,
    reasons,
  };
}

export function applyMarkup(costCents: number, shippingCents: number, markup: number): number {
  const landed = costCents + shippingCents;
  const basisPoints = Math.round(markup * 10_000);
  return Math.ceil((landed * basisPoints) / 10_000);
}
