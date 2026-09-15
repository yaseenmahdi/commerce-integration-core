import { ConnectorError, type SalesChannel, type SupplierCode } from "./types.js";

const DEFAULT_MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(res: Response, attempt: number): number {
  const header = res.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  }
  const jitter = Math.random() * 150;
  return BASE_DELAY_MS * 2 ** attempt + jitter;
}

export async function fetchWithBackoff(
  url: string,
  init: RequestInit,
  meta: { supplier?: SupplierCode; channel?: SalesChannel; endpoint: string },
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < DEFAULT_MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, init);
      if (res.status === 429 || res.status >= 500) {
        if (attempt === DEFAULT_MAX_ATTEMPTS - 1) {
          const body = await res.text().catch(() => "");
          throw new ConnectorError(`HTTP ${res.status} after retries`, {
            ...meta,
            status: res.status,
            body,
            timestamp: new Date().toISOString(),
          });
        }
        await sleep(retryAfterMs(res, attempt));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (err instanceof ConnectorError) throw err;
      if (attempt === DEFAULT_MAX_ATTEMPTS - 1) break;
      await sleep(BASE_DELAY_MS * 2 ** attempt);
    }
  }
  throw new ConnectorError("Network failure after retries", {
    ...meta,
    body: lastError instanceof Error ? lastError.message : lastError,
    timestamp: new Date().toISOString(),
  });
}
