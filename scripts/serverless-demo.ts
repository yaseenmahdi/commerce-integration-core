import { createHmac, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

/** Only the approved API Gateway endpoint receives a key-derived signature. */
export function validateDemoUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash ||
    !/^[a-z0-9]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/.test(url.hostname) ||
    url.pathname !== "/webhooks/orders") {
    throw new Error("Use the stack's HTTPS WebhookUrl output");
  }
  return url.href;
}

export interface DemoResult {
  case: string;
  status: number;
  passed: boolean;
  eventId: string;
}

/** Synthetic bytes and signatures stay in memory; responses and headers are never logged. */
export async function runDemo(
  endpoint: string,
  secret: string,
  send: typeof fetch = fetch,
): Promise<DemoResult[]> {
  const url = validateDemoUrl(endpoint);
  if (secret.length < 32 || Buffer.byteLength(secret, "utf8") > 4096) {
    throw new Error("Invalid signing key configuration");
  }
  const event = {
    id: randomUUID(), type: "order.created", occurredAt: new Date().toISOString(),
    data: { orderId: `synthetic-${randomUUID()}` },
  };
  // Construct once and reuse this exact Buffer for the duplicate request.
  const body = Buffer.from(JSON.stringify(event), "utf8");
  const changed = Buffer.from(JSON.stringify({ ...event, data: { orderId: "synthetic-conflict" } }));
  const invalid = Buffer.from(JSON.stringify({ ...event, id: randomUUID(), data: {} }));
  const cases = [
    { name: "accepted", bytes: body, status: 200, expected: { ok: true, eventId: event.id, duplicate: false } },
    { name: "duplicate", bytes: body, status: 200, expected: { ok: true, eventId: event.id, duplicate: true } },
    { name: "invalid_signature", bytes: body, status: 401, expected: { ok: false, error: "invalid_signature" } },
    { name: "conflict", bytes: changed, status: 409, expected: { ok: false, error: "event_conflict" } },
    { name: "invalid_payload", bytes: invalid, status: 400, expected: { ok: false, error: "invalid_request" } },
  ];
  const results: DemoResult[] = [];
  for (const item of cases) {
    const digest = createHmac("sha256", secret).update(item.bytes).digest();
    if (item.name === "invalid_signature") digest[0] = digest[0]! ^ 1;
    const response = await send(url, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", "x-commerce-signature": digest.toString("base64") },
      body: item.bytes,
    });
    // Bound response memory; never include returned content in errors or output.
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 4096) throw new Error("Unexpected demo response");
          chunks.push(part.value);
        }
      } finally { await reader.cancel(); }
    }
    let actual: Record<string, unknown> = {};
    try { actual = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* Fail safely below. */ }
    const passed = response.status === item.status && actual !== null &&
      Object.entries(item.expected).every(([key, value]) => actual[key] === value);
    results.push({ case: item.name, status: response.status, passed, eventId: event.id });
    // Stop after an unexpected result so uncertain writes are investigated first.
    if (!passed) break;
  }
  return results;
}

async function main(): Promise<void> {
  const secret = process.env.WEBHOOK_DEMO_SECRET ?? "";
  delete process.env.WEBHOOK_DEMO_SECRET;
  const results = await runDemo(process.env.WEBHOOK_URL ?? "", secret);
  for (const result of results) console.log(JSON.stringify(result));
  if (results.length !== 5 || results.some((result) => !result.passed)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("Webhook demo failed. Check endpoint, key access, and service health; no request details were logged.");
    process.exitCode = 1;
  });
}
