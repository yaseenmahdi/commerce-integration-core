import { createHmac, timingSafeEqual } from "node:crypto";

export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Shopify: HMAC-SHA256 of the raw body, Base64, header X-Shopify-Hmac-Sha256. */
export function verifyShopifyHmac(rawBody: Buffer, hmacHeader: string | undefined, secret: string): void {
  if (!secret) throw new WebhookSignatureError("SHOPIFY_WEBHOOK_SECRET is not configured");
  if (!hmacHeader) throw new WebhookSignatureError("Missing X-Shopify-Hmac-Sha256");
  const digest = createHmac("sha256", secret).update(rawBody).digest("base64");
  if (!safeEqual(digest, hmacHeader)) throw new WebhookSignatureError("Invalid Shopify HMAC");
}

/** TikTok Shop: HMAC-SHA256 hex of timestamp + body using the app secret. */
export function verifyTiktokHmac(
  rawBody: Buffer,
  timestamp: string | undefined,
  signature: string | undefined,
  secret: string,
): void {
  if (!secret) throw new WebhookSignatureError("TIKTOK_SHOP_WEBHOOK_SECRET is not configured");
  if (!timestamp || !signature) throw new WebhookSignatureError("Missing TikTok timestamp or signature");
  const digest = createHmac("sha256", secret).update(`${timestamp}${rawBody.toString("utf8")}`).digest("hex");
  if (!safeEqual(digest, signature.toLowerCase())) throw new WebhookSignatureError("Invalid TikTok signature");
}

/** Walmart event notifications: HMAC-SHA256 hex of the raw body. */
export function verifyWalmartHmac(rawBody: Buffer, signature: string | undefined, secret: string): void {
  if (!secret) throw new WebhookSignatureError("WALMART_WEBHOOK_SECRET is not configured");
  if (!signature) throw new WebhookSignatureError("Missing Walmart signature");
  const digest = createHmac("sha256", secret).update(rawBody).digest("hex");
  if (!safeEqual(digest, signature.toLowerCase())) throw new WebhookSignatureError("Invalid Walmart signature");
}

/** CJ: HMAC-SHA256 hex of the raw body. */
export function verifyCjHmac(rawBody: Buffer, signature: string | undefined, secret: string): void {
  if (!secret) throw new WebhookSignatureError("CJ_WEBHOOK_SECRET is not configured");
  if (!signature) throw new WebhookSignatureError("Missing CJ signature");
  const digest = createHmac("sha256", secret).update(rawBody).digest("hex");
  if (!safeEqual(digest, signature.toLowerCase())) throw new WebhookSignatureError("Invalid CJ signature");
}
