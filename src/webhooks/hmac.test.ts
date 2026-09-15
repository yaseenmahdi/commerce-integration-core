import { createHmac } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { verifyShopifyHmac, verifyTiktokHmac, WebhookSignatureError } from "./hmac.js";

test("accepts a valid Shopify HMAC", () => {
  const secret = "shopify-secret";
  const body = Buffer.from('{"id":1}');
  const hmac = createHmac("sha256", secret).update(body).digest("base64");
  assert.doesNotThrow(() => verifyShopifyHmac(body, hmac, secret));
});

test("rejects a tampered Shopify HMAC", () => {
  const body = Buffer.from('{"id":1}');
  assert.throws(
    () => verifyShopifyHmac(body, "aaaa", "shopify-secret"),
    WebhookSignatureError,
  );
});

test("accepts a valid TikTok HMAC", () => {
  const secret = "tts-secret";
  const body = Buffer.from('{"order_id":"T1"}');
  const timestamp = "1710000000";
  const signature = createHmac("sha256", secret).update(`${timestamp}${body.toString("utf8")}`).digest("hex");
  assert.doesNotThrow(() => verifyTiktokHmac(body, timestamp, signature, secret));
});
