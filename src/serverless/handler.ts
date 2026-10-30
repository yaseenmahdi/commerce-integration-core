import { createHash, randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context } from "aws-lambda";
import { verifyShopifyHmac } from "../webhooks/hmac.js";
import { webhookEventSchema } from "./event.js";
import { createSecretProvider } from "./secret.js";
import { createEventStore, type EventStore } from "./store.js";

const MAX_BODY_BYTES = 128 * 1024;
const BASE64_DIGEST = /^[A-Za-z0-9+/]{43}=$/;

/** Only approved metadata is logged; request bodies, headers and exceptions are excluded. */
export type WebhookLog = (level: "info" | "warn" | "error", fields: Record<string, unknown>, message: string) => void;

/** Injectable boundaries allow request/retry tests without credentials or a live AWS account. */
export interface WebhookDependencies {
  store: EventStore;
  getSecret: () => Promise<string>;
  log: WebhookLog;
  newOwner?: () => string;
}

function response(statusCode: number, body: Record<string, unknown>): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(statusCode === 503 ? { "retry-after": "5" } : {}),
      ...(statusCode === 405 ? { allow: "POST" } : {}),
    },
    body: JSON.stringify(body),
  };
}

function header(event: APIGatewayProxyEventV2, name: string): string | undefined {
  const matches = Object.entries(event.headers ?? {}).filter(([key]) => key.toLowerCase() === name);
  // API Gateway combines repeated HTTP headers with commas. Neither signature nor
  // content type accepts a combined value, so ambiguous headers fail closed.
  return matches.length === 1 ? matches[0]?.[1] : undefined;
}

function rawBody(event: APIGatewayProxyEventV2): Buffer {
  if (typeof event.body !== "string" || !event.body) throw new Error("missing body");
  // Bound allocation before decoding a base64 transport representation.
  if (event.body.length > Math.ceil(MAX_BODY_BYTES / 3) * 4) throw new RangeError("body too large");
  if (!event.isBase64Encoded) {
    const result = Buffer.from(event.body, "utf8");
    if (result.length > MAX_BODY_BYTES) throw new RangeError("body too large");
    return result;
  }
  const result = Buffer.from(event.body, "base64");
  if (result.toString("base64") !== event.body) throw new Error("invalid base64");
  if (result.length > MAX_BODY_BYTES) throw new RangeError("body too large");
  return result;
}

/** HTTP API v2 endpoint. Success means the validated event is durably stored in DynamoDB. */
export function createWebhookHandler(dependencies: WebhookDependencies) {
  return async (event: APIGatewayProxyEventV2, context: Context): Promise<APIGatewayProxyStructuredResultV2> => {
    const requestId = context.awsRequestId;
    let eventId: string | undefined;
    let owner: string | undefined;
    let acquired = false;
    let stage = "request";
    const log = (level: "info" | "warn" | "error", message: string): void => {
      dependencies.log(level, {
        requestId,
        gatewayRequestId: event.requestContext?.requestId,
        ...(eventId ? { eventId } : {}),
        stage,
      }, message);
    };

    try {
      if (event.version !== "2.0" || event.requestContext?.http?.method !== "POST") {
        return response(405, { ok: false, error: "method_not_allowed" });
      }
      const contentType = header(event, "content-type");
      if (!contentType || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
        return response(415, { ok: false, error: "unsupported_media_type" });
      }
      let body: Buffer;
      try {
        body = rawBody(event);
      } catch (error) {
        return response(error instanceof RangeError ? 413 : 400, {
          ok: false, error: error instanceof RangeError ? "payload_too_large" : "invalid_request",
        });
      }
      const signature = header(event, "x-commerce-signature");
      if (!signature || !BASE64_DIGEST.test(signature) || Buffer.from(signature, "base64").toString("base64") !== signature) {
        log("warn", "webhook signature rejected");
        return response(401, { ok: false, error: "invalid_signature" });
      }
      stage = "secret";
      const secret = await dependencies.getSecret();
      if (secret.length < 32) throw new Error("invalid secret configuration");
      try {
        // The existing base64 HMAC verifier compares equal-length digests with
        // timingSafeEqual. Verify bytes before parsing or reserializing JSON.
        verifyShopifyHmac(body, signature, secret);
      } catch {
        log("warn", "webhook signature rejected");
        return response(401, { ok: false, error: "invalid_signature" });
      }
      stage = "validation";
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
      } catch {
        return response(400, { ok: false, error: "invalid_request" });
      }
      const parsed = webhookEventSchema.safeParse(payload);
      if (!parsed.success) return response(400, { ok: false, error: "invalid_request" });
      eventId = parsed.data.id;
      const payloadHash = createHash("sha256").update(body).digest("hex");
      owner = (dependencies.newOwner ?? randomUUID)();
      stage = "acquire";
      const result = await dependencies.store.acquire(eventId, payloadHash, owner);
      if (result === "conflict") {
        log("warn", "event identity reused with different content");
        return response(409, { ok: false, error: "event_conflict" });
      }
      if (result === "busy") {
        log("info", "event processing in progress; retry required");
        return response(503, { ok: false, error: "temporarily_unavailable" });
      }
      if (result === "duplicate") {
        log("info", "completed event acknowledged");
        return response(200, { ok: true, eventId, duplicate: true });
      }
      acquired = true;
      stage = "complete";
      // Event persistence and COMPLETED status share one atomic write. No external
      // effects occur between lease acquisition and completion.
      await dependencies.store.complete(parsed.data, payloadHash, owner);
      log("info", "event durably accepted");
      return response(200, { ok: true, eventId, duplicate: false });
    } catch {
      log("error", "webhook operation failed; retry required");
      if (acquired && eventId && owner) {
        try {
          await dependencies.store.fail(eventId, owner);
        } catch {
          // If cleanup also fails, the lease expires and a sender retry can recover.
          log("error", "lease release failed; expiry will permit retry");
        }
      }
      return response(503, { ok: false, error: "temporarily_unavailable" });
    }
  };
}

let configuredHandler: ReturnType<typeof createWebhookHandler> | undefined;

/** Lambda entry point; clients and the short-lived secret cache survive warm invocations. */
export async function handler(event: APIGatewayProxyEventV2, context: Context): Promise<APIGatewayProxyStructuredResultV2> {
  if (!configuredHandler) {
    const tableName = process.env.WEBHOOK_TABLE_NAME;
    const secretArn = process.env.WEBHOOK_SECRET_ARN;
    if (!tableName || !secretArn) return response(503, { ok: false, error: "temporarily_unavailable" });
    // Bound each SDK attempt so ordinary network failures can return a retryable
    // response before the Lambda deadline. A hard timeout still relies on lease expiry.
    const clientOptions = {
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 500, requestTimeout: 1500, throwOnRequestTimeout: true },
    };
    const client = DynamoDBDocumentClient.from(new DynamoDBClient(clientOptions));
    configuredHandler = createWebhookHandler({
      store: createEventStore(client, tableName),
      getSecret: createSecretProvider(new SecretsManagerClient(clientOptions), secretArn),
      log: (level, fields, message) => console.log(JSON.stringify({ level, ...fields, message })),
    });
  }
  return configuredHandler(event, context);
}
