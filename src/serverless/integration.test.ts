import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  createLocalDynamoClient, createLocalEventTable, localLambdaContext, signedLocalRequest,
} from "../../scripts/serverless-local.js";
import type { WebhookEvent } from "./event.js";
import { createWebhookHandler } from "./handler.js";
import { createEventStore, type EventStore } from "./store.js";

function newEvent(): WebhookEvent {
  return {
    id: randomUUID(), type: "order.created", occurredAt: "2026-10-30T12:00:00.000Z",
    data: { orderId: "local-integration-order" },
  };
}

test("local test clients reject account endpoints and ambiguous URL configuration", () => {
  for (const endpoint of [
    "https://dynamodb.us-east-1.amazonaws.com", "http://example.com:8000", "https://localhost:8000",
    "http://localhost:8000/path", "http://user:password@localhost:8000", "http://localhost:8000?remote=1",
  ]) {
    assert.throws(() => createLocalDynamoClient(endpoint));
  }
  for (const endpoint of ["http://127.0.0.1:8000", "http://localhost:8000", "http://[::1]:8000"]) {
    const client = createLocalDynamoClient(endpoint);
    client.destroy();
  }
});

test("DynamoDB Local validates the actual conditional writes and signed handler lifecycle", {
  skip: !process.env.DYNAMODB_LOCAL_ENDPOINT,
}, async (suite) => {
  const client = createLocalDynamoClient(process.env.DYNAMODB_LOCAL_ENDPOINT ?? "");
  const documentClient = DynamoDBDocumentClient.from(client);
  const tableName = `commerce-integration-${randomUUID()}`;
  let tableCreated = false;
  let now = 1_800_000_000_000;
  const store = createEventStore(documentClient, tableName, () => now);
  const read = (id: string) => documentClient.send(new GetCommand({
    TableName: tableName, Key: { id }, ConsistentRead: true,
  }));

  try {
    await createLocalEventTable(client, tableName);
    tableCreated = true;

    await suite.test("concurrent acquisitions have exactly one owner and an incomplete event stays retryable", async () => {
      const event = newEvent();
      const results = await Promise.all([
        store.acquire(event.id, "hash-race", "owner-a"),
        store.acquire(event.id, "hash-race", "owner-b"),
      ]);
      assert.equal(results.filter((result) => result === "acquired").length, 1);
      assert.equal(results.filter((result) => result === "busy").length, 1);
      const receipt = await read(event.id);
      assert.equal(receipt.Item?.status, "PROCESSING");
      assert.equal(receipt.Item?.event, undefined);
      const winner = results[0] === "acquired" ? "owner-a" : "owner-b";
      await store.complete(event, "hash-race", winner);
      assert.equal(await store.acquire(event.id, "hash-race", "owner-c"), "duplicate");
      assert.equal(await store.acquire(event.id, "different-hash", "owner-c"), "conflict");
    });

    await suite.test("lease expiry allows takeover while fencing the crashed owner", async () => {
      const event = newEvent();
      assert.equal(await store.acquire(event.id, "hash-lease", "owner-old"), "acquired");
      now += 31_000;
      assert.equal(await store.acquire(event.id, "hash-lease", "owner-new"), "acquired");
      await assert.rejects(store.complete(event, "hash-lease", "owner-old"), {
        name: "ConditionalCheckFailedException",
      });
      await store.fail(event.id, "owner-old");
      assert.equal((await read(event.id)).Item?.owner, "owner-new");
      await store.complete(event, "hash-lease", "owner-new");
      assert.equal((await read(event.id)).Item?.status, "COMPLETED");
    });

    await suite.test("an expired owner cannot complete before a successor takes over", async () => {
      const event = newEvent();
      await store.acquire(event.id, "hash-expired", "owner-old");
      now += 31_000;
      await assert.rejects(store.complete(event, "hash-expired", "owner-old"), {
        name: "ConditionalCheckFailedException",
      });
      assert.equal((await read(event.id)).Item?.status, "PROCESSING");
    });

    await suite.test("explicit failure releases the event for a retry without TTL deletion", async () => {
      const event = newEvent();
      await store.acquire(event.id, "hash-failed", "owner-a");
      await store.fail(event.id, "owner-a");
      const failed = await read(event.id);
      assert.equal(failed.Item?.status, "FAILED");
      assert.equal(failed.Item?.expiresAt, undefined);
      assert.equal(await store.acquire(event.id, "hash-failed", "owner-b"), "acquired");
      await store.complete(event, "hash-failed", "owner-b");
      assert.deepEqual((await read(event.id)).Item?.event, event);
    });

    await suite.test("a lost completion acknowledgement cannot undo success", async () => {
      const event = newEvent();
      await store.acquire(event.id, "hash-ack", "owner-a");
      await store.complete(event, "hash-ack", "owner-a");
      // Model an invocation receiving a network error after DynamoDB committed.
      await store.fail(event.id, "owner-a");
      assert.equal(await store.acquire(event.id, "hash-ack", "owner-b"), "duplicate");
      const completed = await read(event.id);
      assert.equal(completed.Item?.expiresAt, Math.floor(now / 1000) + 7 * 24 * 60 * 60);
      assert.equal(completed.Item?.owner, undefined);
      assert.equal(completed.Item?.leaseUntil, undefined);
    });

    await suite.test("a real signed request persists the exact validated event and detects duplicates", async () => {
      const event = newEvent();
      const secret = randomBytes(32).toString("hex");
      const body = JSON.stringify(event);
      const request = signedLocalRequest(body, secret);
      const invoke = createWebhookHandler({ store, getSecret: async () => secret, log: () => undefined });
      const response = await invoke(request, localLambdaContext());
      assert.equal(response.statusCode, 200);
      assert.deepEqual(JSON.parse(response.body ?? "{}"), { ok: true, eventId: event.id, duplicate: false });
      const completed = await read(event.id);
      assert.deepEqual(completed.Item?.event, event);
      assert.equal(completed.Item?.payloadHash, createHash("sha256").update(body).digest("hex"));
      const duplicate = await invoke(request, localLambdaContext());
      assert.equal(duplicate.statusCode, 200);
      assert.equal(JSON.parse(duplicate.body ?? "{}").duplicate, true);
    });

    await suite.test("a partial failure produces 503 and can later finish using the same signed event", async () => {
      const event = newEvent();
      const secret = randomBytes(32).toString("hex");
      const request = signedLocalRequest(JSON.stringify(event), secret);
      const failingStore: EventStore = {
        ...store,
        complete: async () => { throw new Error("simulated connection loss before completion"); },
      };
      const first = createWebhookHandler({ store: failingStore, getSecret: async () => secret, log: () => undefined });
      const failed = await first(request, localLambdaContext());
      assert.equal(failed.statusCode, 503);
      assert.equal((await read(event.id)).Item?.status, "FAILED");
      const retry = createWebhookHandler({ store, getSecret: async () => secret, log: () => undefined });
      const completed = await retry(request, localLambdaContext());
      assert.equal(completed.statusCode, 200);
      assert.equal(JSON.parse(completed.body ?? "{}").duplicate, false);
      assert.equal((await read(event.id)).Item?.status, "COMPLETED");
    });

    await suite.test("a signed ID reused with changed content is a conflict", async () => {
      const event = newEvent();
      const secret = randomBytes(32).toString("hex");
      const invoke = createWebhookHandler({ store, getSecret: async () => secret, log: () => undefined });
      assert.equal((await invoke(signedLocalRequest(JSON.stringify(event), secret), localLambdaContext())).statusCode, 200);
      const changed = { ...event, data: { orderId: "another-order" } };
      assert.equal((await invoke(signedLocalRequest(JSON.stringify(changed), secret), localLambdaContext())).statusCode, 409);
      assert.deepEqual((await read(event.id)).Item?.event, event);
    });
  } finally {
    try {
      if (tableCreated) await client.send(new DeleteTableCommand({ TableName: tableName }));
    } finally {
      client.destroy();
    }
  }
});
