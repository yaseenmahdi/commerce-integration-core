import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import { CjClient } from "./cj.js";

process.env.NODE_ENV = "test";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response,
): { calls: Array<{ url: string; method: string; token: string | null; body: string }>; restore: () => void } {
  const calls: Array<{ url: string; method: string; token: string | null; body: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      token: headers.get("CJ-Access-Token"),
      body: typeof init?.body === "string" ? init.body : "",
    });
    return handler(url, init);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function authPayload() {
  return {
    code: 200,
    result: true,
    message: "Success",
    data: {
      accessToken: "minted-temp-token",
      accessTokenExpiryDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
    },
  };
}

test("listUsWarehouseProducts mints CJ-Access-Token from CJ_API_KEY and queries listV2", async () => {
  loadConfig({
    DATABASE_URL: "postgres://commerce:commerce_local_password@127.0.0.1:5432/commerce_integration",
    CJ_ENABLED: "true",
    CJ_API_KEY: "cj-api-key-from-env",
    CJ_ACCESS_TOKEN: "stale-env-token-must-not-be-sent",
    CJ_VERIFIED_WAREHOUSE_ONLY: "true",
    CJ_US_COUNTRY_CODE: "US",
  });

  const { calls, restore } = mockFetch((url) => {
    if (url.includes("/authentication/getAccessToken")) return jsonResponse(authPayload());
    if (url.includes("/product/listV2")) {
      return jsonResponse({ result: true, data: { content: [{ productList: [] }], totalRecords: 0 } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  try {
    const client = new CjClient();
    await client.listUsWarehouseProducts(1, 50);
    await client.listUsWarehouseProducts(2, 50);

    const authCalls = calls.filter((c) => c.url.includes("/authentication/getAccessToken"));
    const listCalls = calls.filter((c) => c.url.includes("/product/listV2"));
    assert.equal(authCalls.length, 1);
    assert.equal(authCalls[0]?.method, "POST");
    assert.equal(authCalls[0]?.token, null);
    assert.deepEqual(JSON.parse(authCalls[0]?.body ?? "{}"), { apiKey: "cj-api-key-from-env" });

    assert.equal(listCalls.length, 2);
    for (const call of listCalls) {
      assert.equal(call.token, "minted-temp-token");
      assert.ok(call.url.includes("countryCode=US"));
      assert.ok(call.url.includes("verifiedWarehouse=1"));
    }
  } finally {
    restore();
  }
});

test("hydrateVariants attaches CJ variant weight and US warehouse stock", async () => {
  loadConfig({
    DATABASE_URL: "postgres://commerce:commerce_local_password@127.0.0.1:5432/commerce_integration",
    CJ_ENABLED: "true",
    CJ_API_KEY: "cj-api-key-from-env",
    CJ_VERIFIED_WAREHOUSE_ONLY: "true",
    CJ_US_COUNTRY_CODE: "US",
  });

  const { restore } = mockFetch((url) => {
    if (url.includes("/authentication/getAccessToken")) return jsonResponse(authPayload());
    if (url.includes("/product/listV2")) {
      return jsonResponse({
        result: true,
        data: {
          totalRecords: 1,
          content: [
            {
              productList: [
                {
                  id: "pid-garlic",
                  nameEn: "Magnetic Garlic Press",
                  sku: "CJ-GARLIC",
                  sellPrice: "8.23",
                  description: "<p>Press garlic without the mess.</p>",
                  threeCategoryName: "Kitchen Tools",
                  bigImage: "https://img.example/garlic.jpg",
                  warehouseInventoryNum: 250,
                  verifiedWarehouse: 1,
                  addMarkStatus: 1,
                },
              ],
            },
          ],
        },
      });
    }
    if (url.includes("/product/variant/query")) {
      return jsonResponse({
        result: true,
        data: [
          {
            vid: "vid-garlic",
            variantSku: "CJ-GARLIC-1",
            variantNameEn: "Default",
            variantWeight: 50,
            variantSellPrice: 8.23,
          },
        ],
      });
    }
    if (url.includes("/product/stock/queryByVid")) {
      return jsonResponse({
        result: true,
        data: [{ countryCode: "US", areaEn: "US Warehouse", storageNum: 250, cjInventoryNum: 250 }],
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  try {
    const client = new CjClient();
    const products = await client.listUsWarehouseProducts(1, 20, { hydrateVariants: true, minVerifiedInventory: 200 });
    assert.equal(products.length, 1);
    const product = products[0];
    assert.equal(product?.shipsFromCountry, "US");
    assert.equal(product?.warehouseVerified, true);
    assert.equal(product?.title, "Magnetic Garlic Press");
    assert.equal(product?.description, "Press garlic without the mess.");
    assert.equal(product?.variants.length, 1);
    assert.equal(product?.variants[0]?.supplierVariantId, "vid-garlic");
    assert.equal(product?.variants[0]?.weightGrams, 50);
    assert.equal(product?.variants[0]?.quantityAvailable, 250);
    assert.equal(product?.variants[0]?.costCents, 823);
  } finally {
    restore();
  }
});
