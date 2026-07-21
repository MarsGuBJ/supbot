import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { defaultToolMarketConfig } from "@supbot/shared";
import { describe, expect, test } from "vitest";
import { fetchRemoteToolMarketProducts, normalizeMarketApiUrl } from "../src/toolMarket";

describe("remote tool market response limits", () => {
  test("requires HTTPS for non-loopback market URLs", () => {
    expect(() => normalizeMarketApiUrl("http://market.example.com/catalog"))
      .toThrow("must use HTTPS unless it targets loopback");
    expect(normalizeMarketApiUrl("http://127.0.0.1:8787")).toContain("http://127.0.0.1:8787");
  });

  test("rejects a catalog response larger than the configured boundary", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(2 * 1024 * 1024 + 1)
      });
      response.end("[]");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      await expect(fetchRemoteToolMarketProducts({
        ...defaultToolMarketConfig,
        apiUrl: `http://127.0.0.1:${address.port}`
      })).rejects.toThrow("byte limit");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
