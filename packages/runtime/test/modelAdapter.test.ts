import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { listProviderModels, normalizeModelsUrl } from "../src/modelAdapter";

const servers: Server[] = [];

async function startServer(handler: Parameters<typeof createServer>[0]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/v1`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("normalizeModelsUrl", () => {
  test("appends /v1/models to bare origins and /models to versioned roots", () => {
    expect(normalizeModelsUrl("https://api.example.com")).toBe("https://api.example.com/v1/models");
    expect(normalizeModelsUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1/models");
    expect(normalizeModelsUrl("https://open.bigmodel.cn/api/paas/v4")).toBe(
      "https://open.bigmodel.cn/api/paas/v4/models",
    );
    expect(normalizeModelsUrl("https://api.example.com/v1/models")).toBe("https://api.example.com/v1/models");
  });
});

describe("listProviderModels", () => {
  test("returns model ids from an OpenAI-compatible response", async () => {
    const baseUrl = await startServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }, { name: "no-id" }] }));
    });
    await expect(listProviderModels(baseUrl)).resolves.toEqual(["model-a", "model-b"]);
  });

  test("sends the api key as a bearer token", async () => {
    let authorization = "";
    const baseUrl = await startServer((req, res) => {
      authorization = req.headers.authorization || "";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "model-a" }] }));
    });
    await expect(listProviderModels(baseUrl, "test-key")).resolves.toEqual(["model-a"]);
    expect(authorization).toBe("Bearer test-key");
  });

  test("throws on HTTP errors and non-OpenAI payloads", async () => {
    const errorUrl = await startServer((_req, res) => {
      res.statusCode = 401;
      res.end("unauthorized");
    });
    await expect(listProviderModels(errorUrl)).rejects.toThrow("Model list request failed (401)");

    const weirdUrl = await startServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ models: [] }));
    });
    await expect(listProviderModels(weirdUrl)).rejects.toThrow("not OpenAI-compatible");
  });
});
