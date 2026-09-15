import { getConfig } from "../config.js";
import { logger } from "../logger.js";
import { fetchWithBackoff } from "./http.js";
import { ConnectorError, type SupplierClient, type SupplierProduct, type SupplierVariant } from "./types.js";

export type ListUsWarehouseOptions = {
  minVerifiedInventory?: number;
  maxSellPrice?: number;
  hydrateVariants?: boolean;
};

type CjListV2Product = {
  id?: string;
  nameEn?: string;
  sku?: string;
  bigImage?: string;
  sellPrice?: string | number;
  nowPrice?: string | number;
  description?: string;
  threeCategoryName?: string;
  twoCategoryName?: string;
  oneCategoryName?: string;
  warehouseInventoryNum?: number;
  totalVerifiedInventory?: number;
  verifiedWarehouse?: number;
  addMarkStatus?: number;
  productType?: string;
  deliveryCycle?: string;
};

type CjVariantRow = {
  vid?: string;
  variantSku?: string;
  variantNameEn?: string;
  variantKey?: string;
  variantWeight?: number;
  variantSellPrice?: number;
  barcode?: string;
};

type CjStockRow = {
  countryCode?: string;
  areaEn?: string;
  storageNum?: number;
  cjInventoryNum?: number;
  totalInventoryNum?: number;
};

type CjAuthCache = {
  accessToken: string;
  expiresAtMs: number;
};

const AUTH_SKEW_MS = 60_000;
const AUTH_FALLBACK_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const CJ_MIN_INTERVAL_MS = 1_100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dollarsToCents(value: number | string | undefined): number {
  const amount = typeof value === "string" ? Number.parseFloat(value) : value;
  if (typeof amount !== "number" || Number.isNaN(amount)) return 0;
  return Math.round(amount * 100);
}

function stripHtml(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text.slice(0, 4000) : undefined;
}

function parseTransit(deliveryCycle: string | undefined): { min: number; max: number } {
  const match = (deliveryCycle ?? "").match(/(\d+)\s*[-–]\s*(\d+)/);
  if (!match) return { min: 3, max: 5 };
  return { min: Number(match[1]), max: Number(match[2]) };
}

function extractListV2Products(data: unknown): CjListV2Product[] {
  if (!data || typeof data !== "object") return [];
  const content = (data as { content?: Array<{ productList?: CjListV2Product[] }> }).content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => block.productList ?? []);
}

function mapStubVariant(item: CjListV2Product): SupplierVariant {
  return {
    supplierVariantId: String(item.sku ?? item.id ?? ""),
    sku: String(item.sku ?? item.id ?? ""),
    costCents: dollarsToCents(item.nowPrice ?? item.sellPrice),
    shippingCents: 0,
    currency: "USD",
    quantityAvailable: Number(item.warehouseInventoryNum ?? item.totalVerifiedInventory ?? 0),
  };
}

function mapVariantRow(
  row: CjVariantRow,
  fallbackSku: string,
  fallbackPrice: number | string | undefined,
): SupplierVariant {
  return {
    supplierVariantId: String(row.vid ?? ""),
    sku: row.variantSku ?? fallbackSku,
    title: row.variantNameEn ?? row.variantKey,
    costCents: dollarsToCents(row.variantSellPrice ?? fallbackPrice),
    shippingCents: 0,
    currency: "USD",
    weightGrams:
      typeof row.variantWeight === "number" && row.variantWeight > 0 ? Math.round(row.variantWeight) : undefined,
    gtin: row.barcode,
    quantityAvailable: 0,
  };
}

function mapV2Product(item: CjListV2Product, variants: SupplierVariant[]): SupplierProduct {
  const transit = parseTransit(item.deliveryCycle);
  return {
    supplier: "cj",
    supplierProductId: String(item.id ?? ""),
    title: item.nameEn ?? String(item.sku ?? "Untitled CJ product"),
    description: stripHtml(item.description) ?? item.nameEn,
    category: item.threeCategoryName ?? item.twoCategoryName ?? item.oneCategoryName,
    shipsFromCountry: "US",
    warehouseCode: "US",
    warehouseVerified: item.verifiedWarehouse === 1,
    processingDaysMin: 1,
    processingDaysMax: 2,
    transitDaysMin: transit.min,
    transitDaysMax: transit.max,
    competitorBrandedPackaging: false,
    images: item.bigImage ? [item.bigImage] : [],
    variants,
    raw: { ...item, supplier_name: "CJ US" },
  };
}

export class CjClient implements SupplierClient {
  readonly code = "cj" as const;
  private authCache: CjAuthCache | null = null;
  private authInflight: Promise<string> | null = null;
  private lastCallAt = 0;

  private async throttle(): Promise<void> {
    if (process.env.NODE_ENV === "test") return;
    const wait = this.lastCallAt + CJ_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastCallAt = Date.now();
  }

  /**
   * Exchange CJ_API_KEY for a short-lived access token (default 15 days).
   * Never send the API key as CJ-Access-Token — that yields error 1600001.
   */
  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.authCache && this.authCache.expiresAtMs - AUTH_SKEW_MS > now) {
      return this.authCache.accessToken;
    }
    if (this.authInflight) return this.authInflight;
    this.authInflight = this.fetchAccessToken().finally(() => {
      this.authInflight = null;
    });
    return this.authInflight;
  }

  private async fetchAccessToken(): Promise<string> {
    const config = getConfig();
    const apiKey = config.CJ_API_KEY;
    const endpoint = "/api2.0/v1/authentication/getAccessToken";
    if (!apiKey) {
      throw new ConnectorError("CJ_API_KEY is required to mint a CJ access token", {
        supplier: "cj",
        endpoint,
        timestamp: new Date().toISOString(),
      });
    }

    await this.throttle();
    const url = new URL(endpoint, config.CJ_API_BASE_URL);
    const res = await fetchWithBackoff(
      url.toString(),
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ apiKey }),
      },
      { supplier: "cj", endpoint },
    );

    const body = (await res.json()) as {
      code?: number;
      result?: boolean;
      message?: string;
      data?: { accessToken?: string; accessTokenExpiryDate?: string };
    };
    const accessToken = body.data?.accessToken;
    if (!res.ok || body.result === false || !accessToken) {
      logger.error(
        {
          endpoint,
          status: res.status,
          code: body.code,
          message: body.message,
          timestamp: new Date().toISOString(),
        },
        "CJ getAccessToken failed",
      );
      throw new ConnectorError(body.message ?? `CJ auth failed (${res.status})`, {
        supplier: "cj",
        endpoint,
        status: res.status,
        body: { code: body.code, result: body.result, message: body.message },
        timestamp: new Date().toISOString(),
      });
    }

    const parsedExpiry = Date.parse(body.data?.accessTokenExpiryDate ?? "");
    this.authCache = {
      accessToken,
      expiresAtMs: Number.isFinite(parsedExpiry) ? parsedExpiry : Date.now() + AUTH_FALLBACK_TTL_MS,
    };
    return accessToken;
  }

  private async authHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
    return {
      "CJ-Access-Token": await this.getAccessToken(),
      Accept: "application/json",
      ...extra,
    };
  }

  async listUsWarehouseProducts(
    page: number,
    pageSize: number,
    options: ListUsWarehouseOptions = {},
  ): Promise<SupplierProduct[]> {
    const config = getConfig();
    if (!config.CJ_ENABLED) return [];
    const endpoint = "/api2.0/v1/product/listV2";
    const url = new URL(endpoint, config.CJ_API_BASE_URL);
    url.searchParams.set("page", String(page));
    url.searchParams.set("size", String(Math.min(pageSize, 100)));
    url.searchParams.set("countryCode", config.CJ_US_COUNTRY_CODE);
    if (config.CJ_VERIFIED_WAREHOUSE_ONLY) {
      url.searchParams.set("verifiedWarehouse", "1");
    }
    if (options.minVerifiedInventory !== undefined) {
      url.searchParams.set("startWarehouseInventory", String(options.minVerifiedInventory));
    }
    if (options.maxSellPrice !== undefined) {
      url.searchParams.set("endSellPrice", String(options.maxSellPrice));
    }

    await this.throttle();
    const res = await fetchWithBackoff(
      url.toString(),
      { method: "GET", headers: await this.authHeaders() },
      { supplier: "cj", endpoint },
    );

    const body = (await res.json()) as {
      result?: boolean;
      message?: string;
      data?: { totalRecords?: number; content?: Array<{ productList?: CjListV2Product[] }> };
    };
    if (!res.ok || body.result === false) {
      throw new ConnectorError(body.message ?? `CJ listV2 failed (${res.status})`, {
        supplier: "cj",
        endpoint,
        status: res.status,
        body: { result: body.result, message: body.message },
        timestamp: new Date().toISOString(),
      });
    }

    const items = extractListV2Products(body.data);
    logger.info(
      { endpoint, page, returned: items.length, totalRecords: body.data?.totalRecords },
      "CJ listV2 page fetched",
    );

    const products: SupplierProduct[] = [];
    for (const item of items) {
      if (!options.hydrateVariants) {
        products.push(mapV2Product(item, [mapStubVariant(item)]));
        continue;
      }
      const rows = await this.queryVariants(String(item.id ?? ""));
      const variants: SupplierVariant[] = [];
      for (const row of rows) {
        const mapped = mapVariantRow(row, String(item.sku ?? item.id ?? ""), item.nowPrice ?? item.sellPrice);
        if (!mapped.supplierVariantId) continue;
        const stock = await this.getInventory(mapped.supplierVariantId);
        mapped.quantityAvailable = stock?.quantity ?? 0;
        variants.push(mapped);
      }
      if (variants.length === 0) continue;
      products.push(mapV2Product(item, variants));
    }
    return products;
  }

  async queryVariants(pid: string): Promise<CjVariantRow[]> {
    if (!pid) return [];
    const config = getConfig();
    const endpoint = "/api2.0/v1/product/variant/query";
    const url = new URL(endpoint, config.CJ_API_BASE_URL);
    url.searchParams.set("pid", pid);
    await this.throttle();
    const res = await fetchWithBackoff(
      url.toString(),
      { headers: await this.authHeaders() },
      { supplier: "cj", endpoint },
    );
    const body = (await res.json()) as { result?: boolean; data?: CjVariantRow[] };
    if (!res.ok || body.result === false || !Array.isArray(body.data)) return [];
    return body.data;
  }

  async getInventory(supplierVariantId: string) {
    const config = getConfig();
    const endpoint = "/api2.0/v1/product/stock/queryByVid";
    const url = new URL(endpoint, config.CJ_API_BASE_URL);
    url.searchParams.set("vid", supplierVariantId);
    await this.throttle();
    const res = await fetchWithBackoff(
      url.toString(),
      { headers: await this.authHeaders() },
      { supplier: "cj", endpoint },
    );
    const body = (await res.json()) as { data?: CjStockRow[] };
    const us = (body.data ?? []).find((row) => (row.countryCode ?? "").toUpperCase() === "US");
    if (!us) return null;
    return {
      quantity: Number(us.storageNum ?? us.cjInventoryNum ?? us.totalInventoryNum ?? 0),
      warehouseCode: us.areaEn ?? "US",
      country: "US",
    };
  }

  /** Cheapest US→US standard freight in cents, or null if CJ has no quote. */
  async getUsStandardShippingCents(supplierVariantId: string): Promise<number | null> {
    const config = getConfig();
    if (!supplierVariantId) return null;
    const endpoint = "/api2.0/v1/logistic/freightCalculate";
    const url = new URL(endpoint, config.CJ_API_BASE_URL);
    await this.throttle();
    const res = await fetchWithBackoff(
      url.toString(),
      {
        method: "POST",
        headers: await this.authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          startCountryCode: "US",
          endCountryCode: "US",
          products: [{ vid: supplierVariantId, quantity: 1 }],
        }),
      },
      { supplier: "cj", endpoint },
    );
    const body = (await res.json()) as {
      result?: boolean;
      data?: Array<{ logisticPrice?: number; postage?: number }>;
    };
    if (!res.ok || body.result === false) return null;
    const prices = (body.data ?? [])
      .map((row) => row.logisticPrice ?? row.postage)
      .filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0);
    if (prices.length === 0) return null;
    return dollarsToCents(Math.min(...prices));
  }
}
