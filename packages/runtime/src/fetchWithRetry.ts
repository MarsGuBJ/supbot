const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRIES = 2;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export interface FetchWithRetryOptions {
  /** Per-attempt timeout. Set to 0 to disable. Defaults to 60s. */
  timeoutMs?: number;
  /** Extra attempts after the first one. Defaults to 2. */
  retries?: number;
  /** Caller cancellation. A caller abort never retries. */
  signal?: AbortSignal;
  onRetry?(attempt: number, reason: string): void;
}

/**
 * fetch with a per-attempt timeout and exponential backoff for transient
 * failures (network errors, 429 and 5xx). Retry only covers establishing the
 * response; once headers arrive the body streams through untouched, so SSE
 * callers are never retried mid-stream.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const signal = combineSignals([options.signal, timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined]);
    try {
      const response = await fetch(url, { ...init, signal });
      if (!RETRYABLE_STATUS.has(response.status) || attempt === retries) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}`);
      await response.arrayBuffer().catch(() => undefined);
    } catch (error) {
      if (options.signal?.aborted) {
        throw error;
      }
      lastError = error;
      if (attempt === retries) {
        throw error;
      }
    }
    const delayMs = 500 * 2 ** attempt;
    options.onRetry?.(attempt + 1, lastError instanceof Error ? lastError.message : String(lastError));
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw lastError;
}

function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (!active.length) {
    return undefined;
  }
  if (active.length === 1) {
    return active[0];
  }
  return AbortSignal.any(active);
}
