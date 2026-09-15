export type SalesChannel = "shopify" | "tiktok_shop_us" | "walmart";
export type SupplierCode = "zendrop" | "cj";

export type SupplierProduct = {
  supplier: SupplierCode;
  supplierProductId: string;
  title: string;
  description?: string | undefined;
  brand?: string | undefined;
  category?: string | undefined;
  shipsFromCountry: string;
  warehouseCode?: string | undefined;
  warehouseVerified: boolean;
  processingDaysMin: number;
  processingDaysMax: number;
  transitDaysMin: number;
  transitDaysMax: number;
  competitorBrandedPackaging: boolean;
  gtin?: string | undefined;
  images: string[];
  variants: SupplierVariant[];
  raw: Record<string, unknown>;
};

export type SupplierVariant = {
  supplierVariantId: string;
  sku: string;
  title?: string | undefined;
  optionValues?: Record<string, string> | undefined;
  costCents: number;
  shippingCents: number;
  currency: string;
  weightGrams?: number | undefined;
  gtin?: string | undefined;
  quantityAvailable: number;
};

export type ListingPayloads = {
  shopify: Record<string, unknown>;
  tiktok: Record<string, unknown>;
  walmart: Record<string, unknown>;
};

export interface SupplierClient {
  readonly code: SupplierCode;
  listUsWarehouseProducts(page: number, pageSize: number): Promise<SupplierProduct[]>;
  getInventory(supplierVariantId: string): Promise<{ quantity: number; warehouseCode: string; country: string } | null>;
}

export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly context: {
      supplier?: SupplierCode | undefined;
      channel?: SalesChannel | undefined;
      endpoint: string;
      status?: number | undefined;
      body?: unknown;
      timestamp: string;
    },
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}
