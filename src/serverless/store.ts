import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { WebhookEvent } from "./event.js";

const LEASE_SECONDS = 30;
const RETENTION_SECONDS = 7 * 24 * 60 * 60;

/** Outcome of acquiring exclusive responsibility for one signed event. */
export type AcquisitionResult = "acquired" | "duplicate" | "busy" | "conflict";

/**
 * Durable event receipt with a fenced processing lease. Completion means the
 * validated event was persisted; it does not mean an external order was placed.
 */
export interface EventStore {
  acquire(eventId: string, payloadHash: string, owner: string): Promise<AcquisitionResult>;
  complete(event: WebhookEvent, payloadHash: string, owner: string): Promise<void>;
  fail(eventId: string, owner: string): Promise<void>;
}

function isConditionalConflict(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

/**
 * Creates a store using the caller's AWS identity. A 30-second lease exceeds the
 * function's 10-second timeout; crashed invocations can be retried after expiry.
 * The injected clock returns milliseconds, while persisted times use seconds.
 */
export function createEventStore(
  client: Pick<DynamoDBDocumentClient, "send">,
  tableName: string,
  now: () => number = Date.now,
): EventStore {
  const epochSeconds = () => Math.floor(now() / 1000);

  return {
    async acquire(eventId, payloadHash, owner) {
      const currentTime = epochSeconds();
      try {
        await client.send(new UpdateCommand({
          TableName: tableName,
          Key: { id: eventId },
          UpdateExpression: "SET payloadHash = :hash, #status = :processing, #owner = :owner, leaseUntil = :lease, firstSeenAt = if_not_exists(firstSeenAt, :now), updatedAt = :now",
          ConditionExpression: "attribute_not_exists(#id) OR (payloadHash = :hash AND (#status = :failed OR (#status = :processing AND leaseUntil <= :now)))",
          ExpressionAttributeNames: { "#id": "id", "#status": "status", "#owner": "owner" },
          ExpressionAttributeValues: {
            ":hash": payloadHash,
            ":processing": "PROCESSING",
            ":failed": "FAILED",
            ":owner": owner,
            ":lease": currentTime + LEASE_SECONDS,
            ":now": currentTime,
          },
        }));
        return "acquired";
      } catch (error) {
        if (!isConditionalConflict(error)) throw error;
      }

      // Read after losing the write race. Never infer a successful completion
      // merely because another invocation already owns the processing lease.
      const result = await client.send(new GetCommand({
        TableName: tableName,
        Key: { id: eventId },
        ConsistentRead: true,
      }));
      if (!result.Item) return "busy";
      if (result.Item.payloadHash !== payloadHash) return "conflict";
      // DynamoDB TTL removal is asynchronous. Existing completed rows continue
      // to deduplicate even after expiresAt until DynamoDB actually removes them.
      return result.Item.status === "COMPLETED" ? "duplicate" : "busy";
    },

    async complete(event, payloadHash, owner) {
      const currentTime = epochSeconds();
      // Persisting the event and recording completion are one atomic write. If
      // the acknowledgement is lost, a retry observes COMPLETED safely.
      await client.send(new UpdateCommand({
        TableName: tableName,
        Key: { id: event.id },
        UpdateExpression: "SET #status = :completed, #event = :event, updatedAt = :now, expiresAt = :expires REMOVE #owner, leaseUntil",
        ConditionExpression: "#status = :processing AND #owner = :owner AND payloadHash = :hash AND leaseUntil > :now",
        ExpressionAttributeNames: { "#status": "status", "#owner": "owner", "#event": "event" },
        ExpressionAttributeValues: {
          ":completed": "COMPLETED",
          ":processing": "PROCESSING",
          ":owner": owner,
          ":hash": payloadHash,
          ":event": event,
          ":now": currentTime,
          ":expires": currentTime + RETENTION_SECONDS,
        },
      }));
    },

    async fail(eventId, owner) {
      try {
        await client.send(new UpdateCommand({
          TableName: tableName,
          Key: { id: eventId },
          UpdateExpression: "SET #status = :failed, updatedAt = :now REMOVE #owner, leaseUntil",
          ConditionExpression: "#status = :processing AND #owner = :owner",
          ExpressionAttributeNames: { "#status": "status", "#owner": "owner" },
          ExpressionAttributeValues: {
            ":processing": "PROCESSING",
            ":failed": "FAILED",
            ":owner": owner,
            ":now": epochSeconds(),
          },
        }));
      } catch (error) {
        // A stale invocation cannot release its successor's lease or undo a
        // completion whose acknowledgement was lost.
        if (!isConditionalConflict(error)) throw error;
      }
    },
  };
}
