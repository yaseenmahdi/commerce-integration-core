import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  PORT: z.coerce.number().int().positive().default(8080),
  PUBLIC_BASE_URL: z.string().url().default("http://127.0.0.1:8080"),
  DATABASE_URL: z.string().min(1),
  PG_POOL_MAX: z.coerce.number().int().positive().default(5),

  ZENDROP_MCP_URL: z.string().url().default("https://app.zendrop.com/mcp/v1"),
  ZENDROP_ACCESS_TOKEN: z.string().optional().default(""),
  ZENDROP_ENABLED: z.coerce.boolean().default(false),

  CJ_API_BASE_URL: z.string().url().default("https://developers.cjdropshipping.com"),
  CJ_API_KEY: z.string().optional().default(""),
  CJ_ACCESS_TOKEN: z.string().optional().default(""),
  CJ_WEBHOOK_SECRET: z.string().optional().default(""),
  CJ_ENABLED: z.coerce.boolean().default(false),
  CJ_US_COUNTRY_CODE: z.string().length(2).default("US"),
  CJ_VERIFIED_WAREHOUSE_ONLY: z.coerce.boolean().default(true),

  SHOPIFY_STORE_DOMAIN: z.string().optional().default(""),
  SHOPIFY_ADMIN_API_VERSION: z.string().default("2025-01"),
  SHOPIFY_ACCESS_TOKEN: z.string().optional().default(""),
  SHOPIFY_API_SECRET: z.string().optional().default(""),
  SHOPIFY_WEBHOOK_SECRET: z.string().optional().default(""),

  TIKTOK_SHOP_APP_KEY: z.string().optional().default(""),
  TIKTOK_SHOP_APP_SECRET: z.string().optional().default(""),
  TIKTOK_SHOP_ACCESS_TOKEN: z.string().optional().default(""),
  TIKTOK_SHOP_CIPHER: z.string().optional().default(""),
  TIKTOK_SHOP_WEBHOOK_SECRET: z.string().optional().default(""),
  TIKTOK_API_BASE_URL: z.string().url().default("https://open-api.tiktokglobalshop.com"),
  TIKTOK_TRACKING_SLA_HOURS: z.coerce.number().positive().default(24),
  TIKTOK_SLA_ESCALATE_HOURS: z.coerce.number().positive().default(12),

  WALMART_CLIENT_ID: z.string().optional().default(""),
  WALMART_CLIENT_SECRET: z.string().optional().default(""),
  WALMART_CHANNEL_TYPE: z.string().optional().default(""),
  WALMART_API_BASE_URL: z.string().url().default("https://sandbox.walmartapis.com"),
  WALMART_WEBHOOK_SECRET: z.string().optional().default(""),

  GEMINI_API_KEY: z.string().optional().default(""),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  LLM_PROVIDER: z.enum(["gemini", "anthropic", "none"]).default("none"),

  REQUIRE_US_ORIGIN: z.coerce.boolean().default(true),
  MIN_TRANSIT_DAYS: z.coerce.number().int().min(1).default(3),
  MAX_TRANSIT_DAYS: z.coerce.number().int().min(1).default(5),
  MAX_TIKTOK_TOTAL_DAYS: z.coerce.number().int().min(1).default(6),
  INVENTORY_SYNC_CRON: z.string().default("0 */2 * * *"),
  SLA_WATCH_CRON: z.string().default("*/10 * * * *"),
  MARKUP_PERCENT: z.coerce.number().positive().default(2.2),
  DEFAULT_CURRENCY: z.string().length(3).default("USD"),
});

export type AppConfig = z.infer<typeof EnvSchema>;

let cached: AppConfig | undefined;

export function loadConfig(overrides?: Record<string, string | undefined>): AppConfig {
  const parsed = EnvSchema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function getConfig(): AppConfig {
  return cached ?? loadConfig();
}
