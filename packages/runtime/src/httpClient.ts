export interface FetchWithRetryOptions {
  timeoutMs?: number;
  idleTimeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

const defaultTimeoutMs = 30_000;
const defaultIdleTimeoutMs = 60_000;
const defaultMaxRetries = 2;
const defaultRetryDelayMs = 250;

export async function fetchWithRetry(
  input: string | URL | Request,
  init: RequestInit = {},
  options: FetchWithRetryOptions = {}
): Promise<Response> {
  const timeoutMs = positiveDuration(options.timeoutMs, defaultTimeoutMs);
  const idleTimeoutMs = positiveDuration(options.idleTimeoutMs, defaultIdleTimeoutMs);
  const maxRetries = Math.max(0, Math.round(options.maxRetries ?? defaultMaxRetries));
  const retryDelayMs = positiveDuration(options.retryDelayMs, defaultRetryDelayMs);

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const detachSignal = forwardAbort(init.signal, controller);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`HTTP request timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    timeout.unref?.();
    let response: Response;
    try {
      response = await fetch(input, { ...init, signal: controller.signal });
    } catch (error) {
      if (timedOut) {
        throw new Error(`HTTP request timed out after ${timeoutMs}ms.`, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      detachSignal();
    }

    if (!isRetryableStatus(response.status) || attempt >= maxRetries) {
      return withIdleTimeout(response, idleTimeoutMs);
    }
    await response.body?.cancel().catch(() => undefined);
    await waitForRetry(retryDelay(response, retryDelayMs, attempt), init.signal);
  }

  throw new Error("HTTP request retry loop ended unexpectedly.");
}

export async function readResponseTextLimited(response: Response, maxBytes: number): Promise<string> {
  const limit = Math.max(1, Math.round(maxBytes));
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`HTTP response exceeded the ${limit} byte limit.`);
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > limit) {
        throw new Error(`HTTP response exceeded the ${limit} byte limit.`);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

function withIdleTimeout(response: Response, idleTimeoutMs: number): Response {
  if (!response.body || idleTimeoutMs <= 0) {
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(`HTTP response body was idle for ${idleTimeoutMs}ms.`)), idleTimeoutMs);
            timeout.unref?.();
          })
        ]);
        if (result.done) {
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        controller.error(error);
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    }
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryDelay(response: Response, baseDelayMs: number, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(30_000, seconds * 1_000);
    }
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) {
      return Math.min(30_000, Math.max(0, at - Date.now()));
    }
  }
  return Math.min(10_000, baseDelayMs * 2 ** attempt);
}

function waitForRetry(delayMs: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason || new Error("HTTP request aborted."));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason || new Error("HTTP request aborted."));
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function forwardAbort(signal: AbortSignal | null | undefined, controller: AbortController): () => void {
  if (!signal) {
    return () => undefined;
  }
  const onAbort = () => controller.abort(signal.reason);
  if (signal.aborted) {
    onAbort();
    return () => undefined;
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.round(Number(value)) : fallback;
}
