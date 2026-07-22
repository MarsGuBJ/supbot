import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { fetchWithRetry } from "../src/fetchWithRetry";

const servers: Server[] = [];

async function startServer(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  while (servers.length) {
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
  }
});

describe("fetchWithRetry", () => {
  test("returns the response on a first-try success", async () => {
    let hits = 0;
    const url = await startServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const response = await fetchWithRetry(url);
    expect(response.status).toBe(200);
    expect(hits).toBe(1);
  });

  test("retries retryable status codes with backoff", async () => {
    let hits = 0;
    const url = await startServer((_req, res) => {
      hits += 1;
      if (hits < 3) {
        res.writeHead(503);
        res.end("busy");
        return;
      }
      res.writeHead(200);
      res.end("ok");
    });
    const response = await fetchWithRetry(url);
    expect(response.status).toBe(200);
    expect(hits).toBe(3);
  });

  test("does not retry non-retryable status codes", async () => {
    let hits = 0;
    const url = await startServer((_req, res) => {
      hits += 1;
      res.writeHead(400);
      res.end("bad request");
    });
    const response = await fetchWithRetry(url);
    expect(response.status).toBe(400);
    expect(hits).toBe(1);
  });

  test("retries network errors", async () => {
    let hits = 0;
    const url = await startServer((req, res) => {
      hits += 1;
      if (hits === 1) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200);
      res.end("ok");
    });
    const response = await fetchWithRetry(url);
    expect(response.status).toBe(200);
    expect(hits).toBe(2);
  });

  test("never retries after the caller aborts", async () => {
    let hits = 0;
    const url = await startServer((_req, res) => {
      hits += 1;
      res.writeHead(503);
      res.end("busy");
    });
    const controller = new AbortController();
    controller.abort();
    await expect(fetchWithRetry(url, {}, { signal: controller.signal })).rejects.toThrow();
    expect(hits).toBe(0);
  });

  test("times out unresponsive attempts", async () => {
    const url = await startServer(() => {
      // never respond
    });
    const started = Date.now();
    await expect(fetchWithRetry(url, {}, { timeoutMs: 100, retries: 0 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
