import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { fetchWithRetry } from "../src/httpClient";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("fetchWithRetry", () => {
  test("fails a request that never returns headers within the configured timeout", async () => {
    const server = createServer(() => undefined);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;

    await expect(fetchWithRetry(`http://127.0.0.1:${address.port}/hang`, {}, {
      timeoutMs: 40,
      idleTimeoutMs: 40,
      maxRetries: 0
    })).rejects.toThrow("timed out");
  });

  test("retries 429 and 5xx responses with bounded backoff", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      if (requests < 3) {
        response.writeHead(requests === 1 ? 429 : 503, { "Retry-After": "0" });
        response.end("retry");
        return;
      }
      response.end("ok");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;

    const response = await fetchWithRetry(`http://127.0.0.1:${address.port}/retry`, {}, {
      timeoutMs: 500,
      idleTimeoutMs: 500,
      maxRetries: 2,
      retryDelayMs: 1
    });

    expect(await response.text()).toBe("ok");
    expect(requests).toBe(3);
  });

  test("fails when a response body stops producing data", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.write("partial");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;

    const response = await fetchWithRetry(`http://127.0.0.1:${address.port}/idle`, {}, {
      timeoutMs: 500,
      idleTimeoutMs: 40,
      maxRetries: 0
    });

    await expect(response.text()).rejects.toThrow("idle");
  });
});
