import { GetSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

const CACHE_DURATION_MS = 60_000;
const MAX_SECRET_BYTES = 4_096;

/**
 * Loads a raw text HMAC key from Secrets Manager, sharing concurrent requests.
 * Keys are cached for at most one minute so rotation takes effect in warm Lambdas.
 * The key is used exactly as stored; JSON and binary secret formats are unsupported.
 */
export function createSecretProvider(
  client: Pick<SecretsManagerClient, "send">,
  secretArn: string,
  now: () => number = Date.now,
): () => Promise<string> {
  if (!secretArn.trim()) throw new Error("Webhook secret ARN is required");

  let cached: { value: string; loadedAt: number } | undefined;
  let inFlight: Promise<string> | undefined;

  async function load(): Promise<string> {
    const result = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const value = result.SecretString;
    if (
      result.SecretBinary !== undefined ||
      typeof value !== "string" ||
      value.length < 32 ||
      Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES
    ) {
      // Never include the returned secret or service response in an error.
      throw new Error("Webhook secret must be raw text between 32 characters and 4096 bytes");
    }
    cached = { value, loadedAt: now() };
    return value;
  }

  return async () => {
    const currentTime = now();
    if (cached && currentTime >= cached.loadedAt && currentTime - cached.loadedAt < CACHE_DURATION_MS) {
      return cached.value;
    }

    // A failed refresh must not extend the old key's lifetime or poison retries.
    if (!inFlight) {
      inFlight = load().finally(() => {
        inFlight = undefined;
      });
    }
    return inFlight;
  };
}
