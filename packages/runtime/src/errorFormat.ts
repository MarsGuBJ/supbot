/**
 * Format an error for display, walking the `cause` chain so low-level
 * details (undici socket errors, errno codes, TLS failures) are not lost.
 * `fetch` failures surface as a bare "fetch failed" TypeError whose real
 * reason only lives on `error.cause`.
 */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      const code = (current as { code?: unknown }).code;
      parts.push(typeof code === "string" ? `${current.message} [${code}]` : current.message);
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.length > 0 ? parts.join(" | cause: ") : "Unknown error";
}
