import pino from "pino";
import { getConfig } from "./config.js";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "commerce-integration-core" },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers['x-shopify-access-token']",
      "req.headers['cj-access-token']",
      "*.accessToken",
      "*.apiKey",
      "*.password",
      "*.secret",
    ],
    censor: "[redacted]",
  },
});

export function childLogger(bindings: Record<string, unknown>) {
  try {
    getConfig();
  } catch {
    // Logger is usable before config is fully loaded (migrate, tests).
  }
  return logger.child(bindings);
}
