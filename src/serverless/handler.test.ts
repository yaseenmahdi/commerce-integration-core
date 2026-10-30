import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { createWebhookHandler, handler as lambdaHandler } from "./handler.js";
import type { EventStore } from "./store.js";

const secret = "local-test-secret-with-at-least-32-bytes";
const eventId = "f0b8bc7c-47fb-4c37-ad40-6aa4909f7a3a";
const payload = {
  id: eventId,
  type: "order.created",
  occurredAt: "2026-10-30T12:00:00Z",
  data: { orderId: "order-123" },
};
const context = { awsRequestId: "lambda-request-123" } as Context;

function signature(body: string | Buffer): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

function request(body = JSON.stringify(payload)): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "POST /webhooks/orders",
    rawPath: "/webhooks/orders",
    rawQueryString: "",
    headers: { "content-type": "application/json", "x-commerce-signature": signature(body) },
    requestContext: {
      accountId: "local",
      apiId: "local",
      domainName: "localhost",
      domainPrefix: "localhost",
      http: { method: "POST", path: "/webhooks/orders", protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
      requestId: "gateway-request-123",
      routeKey: "POST /webhooks/orders",
      stage: "$default",
      time: "30/Oct/2026:12:00:00 +0000",
      timeEpoch: 1793361600000,
    },
    body,
    isBase64Encoded: false,
  };
}

function harness(overrides: Partial<EventStore> = {}, getSecret: () => Promise<string> = async () => secret) {
  const calls: { method: string; arguments: unknown[] }[] = [];
  const logs: { level: string; fields: Record<string, unknown>; message: string }[] = [];
  const store: EventStore = {
    async acquire(...arguments_) { calls.push({ method: "acquire", arguments: arguments_ }); return "acquired"; },
    async complete(...arguments_) { calls.push({ method: "complete", arguments: arguments_ }); },
    async fail(...arguments_) { calls.push({ method: "fail", arguments: arguments_ }); },
    ...overrides,
  };
  const handler = createWebhookHandler({
    store,
    getSecret,
    log: (level, fields, message) => { logs.push({ level, fields, message }); },
    newOwner: () => "lease-owner-123",
  });
  return { handler, calls, logs };
}

test("serverless: authenticates exact raw bytes and completes the first event", async () => {
  const body = JSON.stringify(payload, null, 2) + "\n";
  const { handler, calls, logs } = harness();
  const response = await handler(request(body), context);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body!), { ok: true, eventId, duplicate: false });
  assert.deepEqual(calls, [
    { method: "acquire", arguments: [eventId, createHash("sha256").update(body).digest("hex"), "lease-owner-123"] },
    { method: "complete", arguments: [payload, createHash("sha256").update(body).digest("hex"), "lease-owner-123"] },
  ]);
  assert.ok(logs.some(({ fields }) => fields.eventId === eventId));
  assert.ok(logs.some(({ fields }) => typeof fields.requestId === "string"));
  assert.ok(logs.some(({ fields }) => fields.gatewayRequestId === "gateway-request-123"));
});

test("serverless: supports API Gateway base64 transport without changing signed bytes", async () => {
  const body = JSON.stringify({ ...payload, data: { orderId: "order-☕" } });
  const event = request(body);
  event.body = Buffer.from(body).toString("base64");
  event.isBase64Encoded = true;
  const { handler } = harness();
  assert.equal((await handler(event, context)).statusCode, 200);
});

test("serverless: accepts case-insensitive HTTP header names and JSON charset", async () => {
  const event = request();
  event.headers = { "Content-Type": "application/json; charset=utf-8", "X-Commerce-Signature": signature(event.body!) };
  const { handler } = harness();
  assert.equal((await handler(event, context)).statusCode, 200);
});

for (const [name, header] of [
  ["missing", undefined],
  ["empty", ""],
  ["tampered", signature("other-body")],
  ["too short", "aaaa"],
  ["too long", "a".repeat(88)],
  ["hex instead of base64", "a".repeat(64)],
  ["malformed base64", "!".repeat(43) + "="],
  ["extra signature", signature(JSON.stringify(payload)) + "," + signature(JSON.stringify(payload))],
] as const) {
  test(`serverless: rejects ${name} signature before storage`, async () => {
    const event = request();
    if (header === undefined) delete event.headers["x-commerce-signature"];
    else event.headers["x-commerce-signature"] = header;
    const { handler, calls } = harness();
    const response = await handler(event, context);
    assert.equal(response.statusCode, 401);
    assert.deepEqual(JSON.parse(response.body!), { ok: false, error: "invalid_signature" });
    assert.equal(calls.length, 0);
  });
}

test("serverless: a semantically identical body with a changed byte fails HMAC", async () => {
  const event = request();
  event.body += " ";
  const { handler, calls } = harness();
  assert.equal((await handler(event, context)).statusCode, 401);
  assert.equal(calls.length, 0);
});

for (const [name, body] of [
  ["malformed JSON", "{"],
  ["JSON null", "null"],
  ["JSON array", "[]"],
  ["missing event identifier", JSON.stringify({ type: payload.type, occurredAt: payload.occurredAt, data: payload.data })],
  ["invalid event identifier", JSON.stringify({ ...payload, id: "not-an-event-uuid" })],
  ["unsupported event type", JSON.stringify({ ...payload, type: "order.deleted" })],
  ["invalid occurrence time", JSON.stringify({ ...payload, occurredAt: "yesterday" })],
  ["missing order identifier", JSON.stringify({ ...payload, data: {} })],
  ["empty order identifier", JSON.stringify({ ...payload, data: { orderId: "" } })],
  ["oversized order identifier", JSON.stringify({ ...payload, data: { orderId: "x".repeat(129) } })],
  ["unknown envelope field", JSON.stringify({ ...payload, unexpected: true })],
] as const) {
  test(`serverless: rejects authenticated ${name}`, async () => {
    const { handler, calls } = harness();
    const response = await handler(request(body), context);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(JSON.parse(response.body!), { ok: false, error: "invalid_request" });
    assert.equal(calls.length, 0);
  });
}

test("serverless: rejects missing body", async () => {
  const event = request();
  delete event.body;
  const { handler, calls } = harness();
  assert.equal((await handler(event, context)).statusCode, 400);
  assert.equal(calls.length, 0);
});

test("serverless: rejects malformed base64 transport", async () => {
  const event = request();
  event.body = "%%%not-base64%%%";
  event.isBase64Encoded = true;
  const { handler, calls } = harness();
  assert.equal((await handler(event, context)).statusCode, 400);
  assert.equal(calls.length, 0);
});

test("serverless: rejects authenticated invalid UTF-8 instead of replacing bytes", async () => {
  const rawBody = Buffer.from([0xff, 0xfe]);
  const event = request();
  event.body = rawBody.toString("base64");
  event.isBase64Encoded = true;
  event.headers["x-commerce-signature"] = signature(rawBody);
  const { handler, calls } = harness();
  assert.equal((await handler(event, context)).statusCode, 400);
  assert.equal(calls.length, 0);
});

test("serverless: bounds raw request size before writing DynamoDB", async () => {
  const { handler, calls } = harness();
  assert.equal((await handler(request("x".repeat(128 * 1024 + 1)), context)).statusCode, 413);
  assert.equal(calls.length, 0);
});

for (const contentType of [undefined, "text/plain", "application/xml"]) {
  test(`serverless: rejects unsupported content type ${String(contentType)}`, async () => {
    const event = request();
    if (contentType === undefined) delete event.headers["content-type"];
    else event.headers["content-type"] = contentType;
    const { handler, calls } = harness();
    assert.equal((await handler(event, context)).statusCode, 415);
    assert.equal(calls.length, 0);
  });
}

test("serverless: rejects the wrong HTTP method", async () => {
  const event = request();
  event.requestContext.http.method = "GET";
  const { handler, calls } = harness();
  assert.equal((await handler(event, context)).statusCode, 405);
  assert.equal(calls.length, 0);
});

test("serverless: acknowledges a completed duplicate without repeating completion", async () => {
  const { handler, calls } = harness({ acquire: async () => "duplicate" });
  const response = await handler(request(), context);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body!), { ok: true, eventId, duplicate: true });
  assert.equal(calls.length, 0);
});

test("serverless: concurrent conditional conflict returns a retryable response", async () => {
  const { handler, calls } = harness({ acquire: async () => "busy" });
  const response = await handler(request(), context);
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers?.["Retry-After"] ?? response.headers?.["retry-after"], "5");
  assert.deepEqual(JSON.parse(response.body!), { ok: false, error: "temporarily_unavailable" });
  assert.equal(calls.length, 0);
});

test("serverless: rejects event identifier reuse with different signed bytes", async () => {
  const { handler, calls } = harness({ acquire: async () => "conflict" });
  const response = await handler(request(), context);
  assert.equal(response.statusCode, 409);
  assert.deepEqual(JSON.parse(response.body!), { ok: false, error: "event_conflict" });
  assert.equal(calls.length, 0);
});

test("serverless: DynamoDB service errors return safe retry responses and sanitized logs", async () => {
  const sensitiveError = new Error(`database failed: ${secret} customer@example.com`);
  const { handler, logs } = harness({ acquire: async () => { throw sensitiveError; } });
  const event = request();
  const response = await handler(event, context);
  assert.equal(response.statusCode, 503);
  assert.deepEqual(JSON.parse(response.body!), { ok: false, error: "temporarily_unavailable" });
  const emitted = JSON.stringify({ response, logs });
  assert.ok(!emitted.includes(secret));
  assert.ok(!emitted.includes("customer@example.com"));
  assert.ok(!emitted.includes(event.body!));
  assert.ok(!emitted.includes(event.headers["x-commerce-signature"]!));
  assert.ok(logs.some(({ level }) => level === "error"));
});

test("serverless: failed completion releases its lease and a sender retry can succeed", async () => {
  let completed = false;
  let attempts = 0;
  let releases = 0;
  const { handler } = harness({
    async acquire() { return completed ? "duplicate" : "acquired"; },
    async complete() {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary storage failure");
      completed = true;
    },
    async fail() { releases += 1; },
  });
  assert.equal((await handler(request(), context)).statusCode, 503);
  assert.equal(releases, 1);
  assert.equal((await handler(request(), context)).statusCode, 200);
  const duplicate = await handler(request(), context);
  assert.equal(JSON.parse(duplicate.body!).duplicate, true);
  assert.equal(attempts, 2);
});

test("serverless: lost completion acknowledgement is retried as a duplicate", async () => {
  let completed = false;
  const { handler } = harness({
    async acquire() { return completed ? "duplicate" : "acquired"; },
    async complete() { completed = true; throw new Error("response lost after durable commit"); },
    async fail() { /* An owned PROCESSING condition cannot undo durable completion. */ },
  });
  assert.equal((await handler(request(), context)).statusCode, 503);
  const retry = await handler(request(), context);
  assert.equal(retry.statusCode, 200);
  assert.equal(JSON.parse(retry.body!).duplicate, true);
});

test("serverless: cleanup failure stays retryable without exposing either error", async () => {
  const { handler, logs } = harness({
    async complete() { throw new Error(`write error ${secret}`); },
    async fail() { throw new Error(`cleanup error ${secret}`); },
  });
  const response = await handler(request(), context);
  assert.equal(response.statusCode, 503);
  assert.ok(!JSON.stringify({ response, logs }).includes(secret));
});

for (const configuredSecret of ["", "too-short"]) {
  test(`serverless: invalid secret configuration fails closed (${configuredSecret.length} bytes)`, async () => {
    const { handler, calls } = harness({}, async () => configuredSecret);
    const response = await handler(request(), context);
    assert.equal(response.statusCode, 503);
    assert.deepEqual(JSON.parse(response.body!), { ok: false, error: "temporarily_unavailable" });
    assert.equal(calls.length, 0);
  });
}

test("serverless: secret service errors and non-Error failures are sanitized", async () => {
  const { handler, calls, logs } = harness({}, async () => { throw `unavailable ${secret}`; });
  const response = await handler(request(), context);
  assert.equal(response.statusCode, 503);
  assert.equal(calls.length, 0);
  assert.ok(!JSON.stringify({ response, logs }).includes(secret));
});

test("serverless: missing or blank bootstrap configuration returns a safe response", async () => {
  const originalTable = process.env.WEBHOOK_TABLE_NAME;
  const originalSecretArn = process.env.WEBHOOK_SECRET_ARN;
  const event = request();
  // A wrong method avoids all SDK requests if a regression initializes clients.
  // The configuration boundary must still reject the invocation before routing.
  event.requestContext.http.method = "GET";
  try {
    for (const [tableName, secretArn] of [
      [undefined, undefined],
      ["local-test-table", undefined],
      ["local-test-table", "   "],
      ["   ", "local-test-secret-reference"],
    ]) {
      if (tableName === undefined) delete process.env.WEBHOOK_TABLE_NAME;
      else process.env.WEBHOOK_TABLE_NAME = tableName;
      if (secretArn === undefined) delete process.env.WEBHOOK_SECRET_ARN;
      else process.env.WEBHOOK_SECRET_ARN = secretArn;
      const response = await lambdaHandler(event, context);
      assert.equal(response.statusCode, 503);
      assert.deepEqual(JSON.parse(response.body!), { ok: false, error: "temporarily_unavailable" });
    }
  } finally {
    if (originalTable === undefined) delete process.env.WEBHOOK_TABLE_NAME;
    else process.env.WEBHOOK_TABLE_NAME = originalTable;
    if (originalSecretArn === undefined) delete process.env.WEBHOOK_SECRET_ARN;
    else process.env.WEBHOOK_SECRET_ARN = originalSecretArn;
  }
});
