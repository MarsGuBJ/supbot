import { describe, expect, test } from "vitest";
import { validateProjectShellCommand } from "../src/toolExecutor";

describe("validateProjectShellCommand", () => {
  test("does not mistake quoted URLs for absolute filesystem paths", () => {
    const projectRoot = process.platform === "win32" ? "D:\\projects\\demo" : "/projects/demo";
    const allowed = [process.platform === "win32" ? "D:\\projects\\demo\\outputs" : "/projects/demo/outputs"];

    expect(validateProjectShellCommand('curl "https://example.com/api/items"', projectRoot, allowed)).toBeUndefined();
  });
});
