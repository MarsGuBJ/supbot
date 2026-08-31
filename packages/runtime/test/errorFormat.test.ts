import { describe, expect, test } from "vitest";
import { describeError } from "../src/errorFormat";

describe("describeError", () => {
  test("returns the message for a plain Error", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });

  test("appends errno-style codes", () => {
    const error = new Error("connect failed") as Error & { code: string };
    error.code = "ECONNREFUSED";
    expect(describeError(error)).toBe("connect failed [ECONNREFUSED]");
  });

  test("walks the cause chain like undici fetch failures", () => {
    const cause = new Error("connect ECONNREFUSED 127.0.0.1:443") as Error & { code: string };
    cause.code = "ECONNREFUSED";
    const error = new TypeError("fetch failed", { cause });
    expect(describeError(error)).toBe("fetch failed | cause: connect ECONNREFUSED 127.0.0.1:443 [ECONNREFUSED]");
  });

  test("handles non-Error values and cyclic causes", () => {
    expect(describeError("plain string")).toBe("plain string");
    const error = new Error("cycle") as Error & { cause?: unknown };
    error.cause = error;
    expect(describeError(error)).toBe("cycle");
  });
});
