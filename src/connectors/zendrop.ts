import { getConfig } from "../config.js";
import { fetchWithBackoff } from "./http.js";
import { ConnectorError, type SupplierClient, type SupplierProduct, type SupplierVariant } from "./types.js";

type ZendropMcpResponse = {
  products?: Array<Record<string, unknown>>;
  error?: string;
};

const CHINA_SUPPLIER = "zendrop fulfillment";

export class ZendropClient implements SupplierClient {
  readonly code = "zendrop" as const;

  private async mcp<T>(action: string, payload: Record<string, unknown>): Promise<T> {
    const config = getConfig();
    const res = await fetchWithBackoff(
      config.ZENDROP_MCP_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.ZENDROP_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ action, ...payload }),
      },
      { supplier: "zendrop", endpoint: `mcp:${action}` },
    );
    const body = (await res.json()) as ZendropMcpResponse & T;
    if (!res.ok || body.error) {
      throw new ConnectorError(body.error ?? `Zendrop MCP ${action} failed`, {
        supplier: "zendrop",
        endpoint: `mcp:${action}`,
        status: res.status,
        body,
        timestamp: new Date().toISOString(),
      });
    }
    return body;
  }

  async listUsWarehouseProducts(page: number, pageSize: number): Promise<SupplierProduct[]> {
    const config = getConfig();
    if (!config.ZENDROP_ENABLED) return [];
    const body = await this.mcp<ZendropMcpResponse>("get_catalog_trending_products", {
      filters: { ships_from: "US", page, page_size: pageSize },
    });
    return (body.products ?? []).map(mapZendropProduct).filter((product) => {
      const supplierName = String(product.raw.supplier_name ?? "").toLowerCase();
      return supplierName !== CHINA_SUPPLIER && product.shipsFromCountry === "US";
    });
  }

  async getInventory(supplierVariantId: string) {
    const body = await this.mcp<{ inventory?: number; warehouse?: string }>("get_catalog_product", {
      product_id: supplierVariantId,
    });
    return {
      quantity: Number(body.inventory ?? 0),
      warehouseCode: body.warehouse ?? "US",
      country: "US",
    };
  }
}

function dollarsToCents(value: unknown): number {
  const n = typeof value === "string" ? Number.parseFloat(value) : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function mapZendropProduct(row: Record<string, unknown>): SupplierProduct {
  const shipping = Array.isArray(row.shipping_estimates)
    ? (row.shipping_estimates[0] as { estimated_days?: number; cost?: number })
    : undefined;
  const days = Number(shipping?.estimated_days ?? row.delivery_days ?? 99);
  const variantsRaw = Array.isArray(row.variants) ? (row.variants as Array<Record<string, unknown>>) : [row];
  const variants: SupplierVariant[] = variantsRaw.map((variant, index) => ({
    supplierVariantId: String(variant.id ?? row.id ?? `${index}`),
    sku: String(variant.sku ?? row.sku ?? row.id ?? `zd-${index}`),
    title: String(variant.name ?? variant.title ?? row.name ?? "Variant"),
    costCents: dollarsToCents(variant.price ?? row.price),
    shippingCents: dollarsToCents(shipping?.cost ?? 0),
    currency: "USD",
    quantityAvailable: Number(variant.inventory ?? row.inventory ?? 0),
    gtin: variant.gtin ? String(variant.gtin) : undefined,
  }));

  const supplierName = String(row.supplier_name ?? row.supplierName ?? "");
  return {
    supplier: "zendrop",
    supplierProductId: String(row.id ?? ""),
    title: String(row.name ?? row.title ?? "Untitled Zendrop product"),
    description: row.description ? String(row.description) : undefined,
    brand: row.brand ? String(row.brand) : undefined,
    shipsFromCountry: supplierName.toLowerCase() === CHINA_SUPPLIER ? "CN" : "US",
    warehouseVerified: supplierName.toLowerCase() !== CHINA_SUPPLIER && Boolean(supplierName),
    processingDaysMin: 1,
    processingDaysMax: 3,
    transitDaysMin: days,
    transitDaysMax: days,
    competitorBrandedPackaging: supplierName.toLowerCase().includes("amazon"),
    images: Array.isArray(row.images) ? row.images.map(String) : [],
    variants,
    raw: { ...row, supplier_name: supplierName },
  };
}
