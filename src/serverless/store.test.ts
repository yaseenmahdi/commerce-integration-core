import assert from "node:assert/strict";
import test from "node:test";
import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createEventStore } from "./store.js";
import type { WebhookEvent } from "./event.js";

const clock = () => 1_800_000_000_000;
const event: WebhookEvent = {
  id: "c507db4b-f78c-45d1-af58-97bd31f92ba7",
  type: "order.created",
  occurredAt: "2026-10-30T12:00:00.000Z",
  data: { orderId: "order-42" },
};
const conditionalConflict = () => Object.assign(new Error("private database message"), {
  name: "ConditionalCheckFailedException",
});

type Command = GetCommand | UpdateCommand;

function fixture(...responses: Array<object | Error>) {
  const commands: Command[] = [];
  const client = {
    send: async (command: Command) => {
      commands.push(command);
      assert.ok(responses.length > 0, "unexpected database request");
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  } as unknown as Pick<DynamoDBDocumentClient, "send">;
  return { commands, store: createEventStore(client, "events", clock) };
}

test("store acquires a new event with an atomic conditional write and bounded lease", async () => {
  const { commands, store } = fixture({});
  assert.equal(await store.acquire(event.id, "body-hash", "owner-a"), "acquired");
  const command = commands[0];
  assert.ok(command instanceof UpdateCommand);
  assert.deepEqual(command.input.Key, { id: event.id });
  assert.equal(command.input.TableName, "events");
  assert.equal(command.input.ConditionExpression,
    "attribute_not_exists(#id) OR (payloadHash = :hash AND (#status = :failed OR (#status = :processing AND leaseUntil <= :now)))");
  assert.deepEqual(command.input.ExpressionAttributeValues, {
    ":hash": "body-hash", ":processing": "PROCESSING", ":failed": "FAILED",
    ":owner": "owner-a", ":lease": 1_800_000_030, ":now": 1_800_000_000,
  });
  assert.match(command.input.UpdateExpression ?? "", /firstSeenAt = if_not_exists/);
  assert.doesNotMatch(command.input.UpdateExpression ?? "", /expiresAt/);
});

test("conditional write conflict is a duplicate only after a consistent completed read", async () => {
  const { commands, store } = fixture(conditionalConflict(), {
    Item: { payloadHash: "body-hash", status: "COMPLETED" },
  });
  assert.equal(await store.acquire(event.id, "body-hash", "owner-b"), "duplicate");
  assert.ok(commands[1] instanceof GetCommand);
  assert.equal(commands[1].input.ConsistentRead, true);
});

test("completed receipts still deduplicate while waiting for asynchronous TTL deletion", async () => {
  const { store } = fixture(conditionalConflict(), {
    Item: { payloadHash: "body-hash", status: "COMPLETED", expiresAt: 1 },
  });
  assert.equal(await store.acquire(event.id, "body-hash", "owner-b"), "duplicate");
});

test("the same event identifier with a different signed body is a conflict", async () => {
  const { store } = fixture(conditionalConflict(), {
    Item: { payloadHash: "other-hash", status: "COMPLETED" },
  });
  assert.equal(await store.acquire(event.id, "body-hash", "owner-b"), "conflict");
});

for (const state of ["PROCESSING", "FAILED"]) {
  test(`a competing ${state} receipt is retryable rather than a completed duplicate`, async () => {
    const { store } = fixture(conditionalConflict(), { Item: { payloadHash: "body-hash", status: state } });
    assert.equal(await store.acquire(event.id, "body-hash", "owner-b"), "busy");
  });
}

test("a row removed between conditional conflict and read remains retryable", async () => {
  const { store } = fixture(conditionalConflict(), {});
  assert.equal(await store.acquire(event.id, "body-hash", "owner-b"), "busy");
});

test("acquisition propagates database service errors without misclassifying them as duplicates", async () => {
  const unavailable = new Error("database unavailable");
  const { store, commands } = fixture(unavailable);
  await assert.rejects(store.acquire(event.id, "body-hash", "owner-a"), (error) => error === unavailable);
  assert.equal(commands.length, 1);
});

test("a failed conflict read propagates the service error", async () => {
  const unavailable = new Error("read unavailable");
  const { store } = fixture(conditionalConflict(), unavailable);
  await assert.rejects(store.acquire(event.id, "body-hash", "owner-b"), (error) => error === unavailable);
});

test("completion atomically stores the validated event with TTL and fences stale owners", async () => {
  const { store, commands } = fixture({});
  await store.complete(event, "body-hash", "owner-a");
  const command = commands[0];
  assert.ok(command instanceof UpdateCommand);
  assert.equal(command.input.ConditionExpression,
    "#status = :processing AND #owner = :owner AND payloadHash = :hash AND leaseUntil > :now");
  assert.match(command.input.UpdateExpression ?? "", /#event = :event/);
  assert.match(command.input.UpdateExpression ?? "", /REMOVE #owner, leaseUntil/);
  assert.deepEqual(command.input.ExpressionAttributeValues?.[":event"], event);
  assert.equal(command.input.ExpressionAttributeValues?.[":expires"], 1_800_604_800);
});

test("a lost lease rejects completion instead of reporting success", async () => {
  const conflict = conditionalConflict();
  const { store } = fixture(conflict);
  await assert.rejects(store.complete(event, "body-hash", "owner-old"), (error) => error === conflict);
});

test("failure releases only the owned processing lease and leaves the row without TTL", async () => {
  const { store, commands } = fixture({});
  await store.fail(event.id, "owner-a");
  const command = commands[0];
  assert.ok(command instanceof UpdateCommand);
  assert.equal(command.input.ConditionExpression, "#status = :processing AND #owner = :owner");
  assert.equal(command.input.ExpressionAttributeValues?.[":failed"], "FAILED");
  assert.match(command.input.UpdateExpression ?? "", /REMOVE #owner, leaseUntil/);
  assert.doesNotMatch(command.input.UpdateExpression ?? "", /expiresAt/);
});

test("a failure acknowledgement cannot overwrite a completed receipt or a successor's lease", async () => {
  const { store } = fixture(conditionalConflict());
  await assert.doesNotReject(store.fail(event.id, "owner-old"));
});

test("failure cleanup preserves unexpected service errors", async () => {
  const unavailable = new Error("cleanup unavailable");
  const { store } = fixture(unavailable);
  await assert.rejects(store.fail(event.id, "owner-a"), (error) => error === unavailable);
});

test("failed processing can be reacquired by a new owner and then completed", async () => {
  const { store, commands } = fixture({}, new Error("temporary write error"), {}, {}, {});
  assert.equal(await store.acquire(event.id, "body-hash", "owner-a"), "acquired");
  await assert.rejects(store.complete(event, "body-hash", "owner-a"));
  await store.fail(event.id, "owner-a");
  assert.equal(await store.acquire(event.id, "body-hash", "owner-b"), "acquired");
  await store.complete(event, "body-hash", "owner-b");
  assert.equal(commands.length, 5);
});
