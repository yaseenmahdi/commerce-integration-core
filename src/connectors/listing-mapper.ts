import { applyMarkup, evaluateShippingPolicy } from "../policy/shipping.js";
import type { ListingPayloads, SupplierProduct, SupplierVariant } from "./types.js";

export type FormattedListing = {
  sku: string;
  eligibility: ReturnType<typeof evaluateShippingPolicy>;
  landedCostCents: number;
  priceCents: number;
  payloads: ListingPayloads;
};

export function formatListingPayloads(
  product: SupplierProduct,
  variant: SupplierVariant,
  markup: number,
): FormattedListing {
  const eligibility = evaluateShippingPolicy({
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
  });

  const landedCostCents = variant.costCents + variant.shippingCents;
  const priceCents = applyMarkup(variant.costCents, variant.shippingCents, markup);
  const sku = `${product.supplier}-${variant.sku}`.slice(0, 40);
  const gtin = variant.gtin ?? product.gtin;

  const payloads: ListingPayloads = {
    shopify: {
      product: {
        title: product.title,
        body_html: product.description ?? product.title,
        vendor: product.brand ?? product.supplier,
        product_type: product.category ?? "",
        status: "draft",
        tags: ["us-warehouse", product.supplier, eligibility.tiktok ? "tiktok-eligible" : "tiktok-blocked"].join(
          ",",
        ),
        images: product.images.slice(0, 8).map((src) => ({ src })),
        variants: [
          {
            sku,
            price: (priceCents / 100).toFixed(2),
            barcode: gtin,
            inventory_management: "shopify",
            inventory_quantity: eligibility.shopify ? variant.quantityAvailable : 0,
            weight: variant.weightGrams ? variant.weightGrams / 1000 : undefined,
            weight_unit: "kg",
            requires_shipping: true,
          },
        ],
      },
    },
    tiktok: {
      title: product.title.slice(0, 255),
      description: (product.description ?? product.title).slice(0, 3000),
      skus: [
        {
          seller_sku: sku,
          price: { amount: (priceCents / 100).toFixed(2), currency: variant.currency },
          inventory: [{ warehouse_id: product.warehouseCode ?? "US", quantity: variant.quantityAvailable }],
          identifier_code: gtin ? { type: "GTIN", code: gtin } : undefined,
        },
      ],
      shipping_info: {
        origin_country: "US",
        handling_days: product.processingDaysMax,
        transit_days_min: product.transitDaysMin,
        transit_days_max: product.transitDaysMax,
      },
      main_images: product.images.slice(0, 9).map((uri) => ({ uri })),
    },
    walmart: {
      MPItem: [
        {
          Orderable: {
            sku,
            productIdentifiers: gtin
              ? { productIdType: gtin.length === 12 ? "UPC" : "GTIN", productId: gtin }
              : undefined,
            productName: product.title.slice(0, 200),
            brand: product.brand ?? "Generic",
            price: Number((priceCents / 100).toFixed(2)),
            ShippingWeight: variant.weightGrams ? Number((variant.weightGrams / 453.592).toFixed(2)) : 1,
            endDate: "2050-12-31",
          },
          Visible: {
            additionalProductAttributes: [{ productAttributeName: "shipsFrom", productAttributeValue: "US" }],
          },
        },
      ],
      inventory: {
        sku,
        quantity: { unit: "EACH", amount: variant.quantityAvailable },
        fulfillmentLagTime: Math.min(2, product.processingDaysMax),
      },
    },
  };

  return { sku, eligibility, landedCostCents, priceCents, payloads };
}
