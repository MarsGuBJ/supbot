import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildMcpSpawnEnv, McpManager, redactMcpStderr } from "../src/mcpManager";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("McpManager frame limits", () => {
  test("inherits only the MCP process environment whitelist", () => {
    const env = buildMcpSpawnEnv({ CUSTOM_VALUE: "configured" }, {
      PATH: "bin",
      HOME: "home",
      NPM_TOKEN: "host-secret"
    });
    expect(env).toMatchObject({ PATH: "bin", HOME: "home", CUSTOM_VALUE: "configured" });
    expect(env.NPM_TOKEN).toBeUndefined();
  });

  test("redacts common secrets and configured values from stderr", () => {
    expect(redactMcpStderr("token=abc123 Bearer bearer-value custom-secret", { API_SECRET: "custom-secret" }))
      .toBe("token=[REDACTED] Bearer [REDACTED] [REDACTED]");
  });

  test("rejects an oversized Content-Length before buffering the frame body", () => {
    const manager = new McpManager({
      randomId: (prefix) => `${prefix}_test`,
      nowIso: () => "2026-01-01T00:00:00.000Z"
    });
    const server = manager.add({ name: "oversized", command: "node", enabled: true });
    const internal = manager as unknown as {
      connectionFor(id: string): unknown;
      handleData(connection: unknown, chunk: Buffer): void;
    };
    const connection = internal.connectionFor(server.id);

    internal.handleData(connection, Buffer.from(`Content-Length: ${4 * 1024 * 1024 + 1}\r\n\r\n`));

    const snapshot = manager.snapshot().mcpServers.find((item) => item.id === server.id)!;
    expect(snapshot.status.state).toBe("error");
    expect(snapshot.status.lastError).toContain("frame exceeded");
  });

  test("rejects a header that grows beyond the header limit", () => {
    const manager = new McpManager({
      randomId: (prefix) => `${prefix}_test`,
      nowIso: () => "2026-01-01T00:00:00.000Z"
    });
    const server = manager.add({ name: "oversized-header", command: "node", enabled: true });
    const internal = manager as unknown as {
      connectionFor(id: string): unknown;
      handleData(connection: unknown, chunk: Buffer): void;
    };
    const connection = internal.connectionFor(server.id);

    internal.handleData(connection, Buffer.alloc(16 * 1024 + 1, 0x61));

    const snapshot = manager.snapshot().mcpServers.find((item) => item.id === server.id)!;
    expect(snapshot.status.state).toBe("error");
    expect(snapshot.status.lastError).toContain("header exceeded");
  });

  test("deduplicates concurrent connection attempts for the same server", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supbot-mcp-connect-"));
    tempDirs.push(dir);
    const countPath = join(dir, "starts.txt");
    const scriptPath = join(dir, "server.cjs");
    await writeFile(scriptPath, `
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(countPath)}, "started\\n");
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) return;
    const length = Number(buffer.subarray(0, headerEnd).toString("utf8").match(/Content-Length:\\s*(\\d+)/i)?.[1] || 0);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const request = JSON.parse(buffer.subarray(bodyStart, bodyStart + length).toString("utf8"));
    buffer = buffer.subarray(bodyStart + length);
    const result = request.method === "initialize"
      ? { protocolVersion: "2024-11-05", capabilities: {} }
      : request.method === "tools/list" ? { tools: [] } : {};
    const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    process.stdout.write(Buffer.concat([Buffer.from(\`Content-Length: \${payload.length}\\r\\n\\r\\n\`), payload]));
  }
});
`, "utf8");
    const manager = new McpManager({
      randomId: (prefix) => `${prefix}_connect`,
      nowIso: () => new Date().toISOString()
    });
    const server = manager.add({
      name: "deduplicated",
      command: process.execPath,
      args: [scriptPath],
      enabled: true,
      requestTimeoutMs: 2_000
    });

    const [first, second] = await Promise.all([manager.connect(server.id), manager.connect(server.id)]);

    expect(first.state).toBe("connected");
    expect(second.state).toBe("connected");
    expect((await readFile(countPath, "utf8")).trim().split(/\r?\n/)).toHaveLength(1);
    await manager.disconnect(server.id);
  });
});
