import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import type { WebhookEvent } from "../src/serverless/event.js";
import { createWebhookHandler } from "../src/serverless/handler.js";
import { createEventStore } from "../src/serverless/store.js";

/**
 * Creates a local-only client with deliberately unusable AWS account credentials.
 * Refusing non-loopback HTTP endpoints prevents this demo from accessing AWS.
 */
export function createLocalDynamoClient(endpoint: string): DynamoDBClient {
  const url = new URL(endpoint);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username || url.password || url.search || url.hash || url.pathname !== "/"
  ) {
    throw new Error("DYNAMODB_LOCAL_ENDPOINT must be a loopback HTTP origin");
  }
  return new DynamoDBClient({
    endpoint: url.origin,
    region: "us-east-1",
    credentials: { accessKeyId: "localonly", secretAccessKey: "localonly" },
    maxAttempts: 1,
  });
}

/** Creates an isolated test table; callers must delete only the table they created. */
export async function createLocalEventTable(client: DynamoDBClient, tableName: string): Promise<void> {
  await client.send(new CreateTableCommand({
    TableName: tableName,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
    KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
  }));
}

/** Makes an API Gateway v2 fixture without changing the signed raw-body bytes. */
export function signedLocalRequest(body: string, secret: string): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "POST /webhooks/orders",
    rawPath: "/webhooks/orders",
    rawQueryString: "",
    headers: {
      "content-type": "application/json",
      "x-commerce-signature": createHmac("sha256", secret).update(body).digest("base64"),
    },
    requestContext: {
      accountId: "local",
      apiId: "local",
      domainName: "localhost",
      domainPrefix: "localhost",
      requestId: randomUUID(),
      routeKey: "POST /webhooks/orders",
      stage: "$default",
      time: "30/Oct/2026:12:00:00 +0000",
      timeEpoch: 1_793_361_600_000,
      http: {
        method: "POST", path: "/webhooks/orders", protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1", userAgent: "commerce-local-test",
      },
    },
    body,
    isBase64Encoded: false,
  };
}

/** Minimal deterministic Lambda context for local invocations. */
export function localLambdaContext(): Context {
  return {
    callbackWaitsForEmptyEventLoop: false,
    functionName: "commerce-webhook-local",
    functionVersion: "$LATEST",
    invokedFunctionArn: "local-only",
    memoryLimitInMB: "256",
    awsRequestId: randomUUID(),
    logGroupName: "local-only",
    logStreamName: "local-only",
    getRemainingTimeInMillis: () => 10_000,
    done: () => undefined,
    fail: () => undefined,
    succeed: () => undefined,
  };
}

async function main(): Promise<void> {
  const client = createLocalDynamoClient(process.env.DYNAMODB_LOCAL_ENDPOINT ?? "http://127.0.0.1:8000");
  const documentClient = DynamoDBDocumentClient.from(client);
  const tableName = `commerce-local-${randomUUID()}`;
  let tableCreated = false;
  try {
    await createLocalEventTable(client, tableName);
    tableCreated = true;
    const secret = randomBytes(32).toString("hex");
    const event: WebhookEvent = {
      id: randomUUID(), type: "order.created", occurredAt: new Date().toISOString(),
      data: { orderId: "local-order-42" },
    };
    const invoke = createWebhookHandler({
      store: createEventStore(documentClient, tableName),
      getSecret: async () => secret,
      log: (level, fields, message) => console.log(JSON.stringify({ level, ...fields, message })),
    });
    const request = signedLocalRequest(JSON.stringify(event), secret);
    const first = await invoke(request, localLambdaContext());
    const duplicate = await invoke(request, localLambdaContext());
    assert.equal(first.statusCode, 200);
    assert.equal(duplicate.statusCode, 200);
    assert.equal(JSON.parse(first.body ?? "{}").duplicate, false);
    assert.equal(JSON.parse(duplicate.body ?? "{}").duplicate, true);
    const stored = await documentClient.send(new GetCommand({
      TableName: tableName, Key: { id: event.id }, ConsistentRead: true,
    }));
    assert.ok(stored.Item);
    assert.equal(stored.Item.status, "COMPLETED");
    assert.deepEqual(stored.Item.event, event);
    console.log(JSON.stringify({ ok: true, accepted: true, duplicate: true, storedEventVerified: true }));
  } finally {
    try {
      if (tableCreated) await client.send(new DeleteTableCommand({ TableName: tableName }));
    } finally {
      client.destroy();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("Local webhook demo failed; ensure DynamoDB Local is running on the configured loopback endpoint.");
    process.exitCode = 1;
  });
}
