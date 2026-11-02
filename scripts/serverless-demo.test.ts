import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { createWebhookHandler } from "../src/serverless/handler.js";
import { localLambdaContext, signedLocalRequest } from "./serverless-local.js";
import { runDemo, validateDemoUrl } from "./serverless-demo.js";

const endpoint = "https://abc123.execute-api.us-east-1.amazonaws.com/webhooks/orders";

test("demo rejects credentials, redirects targets, and non-stack endpoints before sending", async () => {
  for (const url of [
    "http://abc123.execute-api.us-east-1.amazonaws.com/webhooks/orders",
    "https://example.com/webhooks/orders", endpoint + "?secret=x", endpoint + "#x",
    endpoint.replace("abc123", "user:password@abc123"), endpoint.replace("/webhooks/orders", "/"),
    endpoint.replace(".com/", ".com:8443/"),
  ]) {
    assert.throws(() => validateDemoUrl(url));
  }
  let sent = false;
  await assert.rejects(runDemo(endpoint, "short", async () => { sent = true; throw new Error(); }));
  assert.equal(sent, false);
});

test("demo signs real handler requests, reuses exact bytes, and reports only safe evidence", async () => {
  const secret = randomBytes(32).toString("hex");
  let completed: { id: string; hash: string } | undefined;
  const handler = createWebhookHandler({
    getSecret: async () => secret, log: () => undefined,
    store: {
      acquire: async (id, hash) => !completed ? "acquired" : completed.id === id && completed.hash === hash ? "duplicate" : "conflict",
      complete: async (event, hash) => { completed = { id: event.id, hash }; },
      fail: async () => undefined,
    },
  });
  const bodies: unknown[] = [];
  const signatures: string[] = [];
  const send: typeof fetch = async (url, init) => {
    assert.equal(url, endpoint);
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    bodies.push(init?.body);
    const headers = init?.headers as Record<string, string>;
    signatures.push(headers["x-commerce-signature"]!);
    const request: APIGatewayProxyEventV2 = {
      ...signedLocalRequest(String(init?.body), secret), headers,
    };
    const result = await handler(request, localLambdaContext());
    assert.equal(typeof result.statusCode, "number");
    return new Response(result.body, { status: result.statusCode! });
  };
  const results = await runDemo(endpoint, secret, send);
  assert.deepEqual(results.map(({ status, passed }) => ({ status, passed })),
    [200, 200, 401, 409, 400].map(status => ({ status, passed: true })));
  assert.strictEqual(bodies[0], bodies[1]);
  assert.equal(signatures[0], signatures[1]);
  assert.notEqual(signatures[0], signatures[2]);
  const output = JSON.stringify(results);
  assert.ok(!output.includes(secret));
  for (const signature of signatures) assert.ok(!output.includes(signature));
  assert.ok(!output.includes("synthetic-"));
});

test("demo stops on uncertain responses and limits untrusted response size", async () => {
  let calls = 0;
  const secret = randomBytes(32).toString("hex");
  const results = await runDemo(endpoint, secret, async () => {
    calls++;
    return new Response('{"ok":false}', { status: 503 });
  });
  assert.equal(calls, 1);
  assert.equal(results[0]?.passed, false);
  await assert.rejects(runDemo(endpoint, secret, async () => new Response("x".repeat(4097))));
  const malformed = await runDemo(endpoint, secret, async () => new Response("null"));
  assert.equal(malformed[0]?.passed, false);
});
