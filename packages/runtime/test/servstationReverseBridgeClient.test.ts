import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { IdentityContext, ServstationA2AConfig } from "@supbot/shared";
import { describe, expect, test } from "vitest";
import { ServstationReverseBridgeClient } from "../src/servstationReverseBridgeClient";

describe("ServstationReverseBridgeClient", () => {
  test("reconnects the Agent instance when reverse registration rejects a stale id", async () => {
    const requests: string[] = [];
    let heartbeatPosts = 0;
    let eventStream: import("node:http").ServerResponse | undefined;
    const server = createServer((request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      requests.push(`${request.method} ${url.pathname}`);
      response.setHeader("Content-Type", "application/json");

      if (request.method === "POST" && url.pathname === "/api/v1/agent/agent-stale/a2a-peers/reverse-connections") {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "agent instance not found" }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/agent/connect") {
        response.end(JSON.stringify({ agentInstanceId: "agent-fresh" }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/agent/agent-fresh/a2a-peers/reverse-connections") {
        response.end(
          JSON.stringify({
            peer: { id: "peer-fresh" },
            streamUrl: "/api/v1/agent/agent-fresh/a2a-peers/peer-fresh/events",
          }),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/agent/agent-fresh/a2a-peers/peer-fresh/events") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        eventStream = response;
        response.write(`event: heartbeat\ndata: {"ok":true}\n\n`);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/agent/agent-fresh/a2a-peers/peer-fresh/heartbeat") {
        heartbeatPosts += 1;
        response.end(JSON.stringify({ status: "online" }));
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const identity: IdentityContext = {
      tenantId: "tenant-1",
      organizationId: "organization-1",
      departmentId: "department-1",
      userId: "user-1",
      roleIds: ["user"],
      source: "servstation",
      agentInstanceId: "agent-stale",
    };
    let config: ServstationA2AConfig = {
      enabled: true,
      baseUrl: `http://127.0.0.1:${address.port}`,
      authMode: "identityHeaders",
      bearerTokenSaved: false,
      staffAgentPasswordSaved: false,
      agentInstanceId: "agent-stale",
      reverse: {
        enabled: true,
        status: "disconnected",
        clientInstanceId: "hbclient-1",
      },
    };
    const client = new ServstationReverseBridgeClient({
      getConfig: () => config,
      getAccessToken: async () => undefined,
      getIdentityContext: () => identity,
      updateConfig: async (input) => {
        if (input.agentInstanceId !== undefined) {
          config = { ...config, agentInstanceId: input.agentInstanceId };
        }
        return config;
      },
      updateReverseState: async (input) => {
        config = { ...config, reverse: { ...config.reverse!, ...input } };
      },
      sendReadOnlyPromptAndWait: async () => ({ status: "completed" }),
      getSnapshot: () => {
        throw new Error("not used");
      },
      loadTranscript: async () => {
        throw new Error("not used");
      },
      createScheduledJob: async () => {
        throw new Error("not used");
      },
      updateScheduledJob: async () => {
        throw new Error("not used");
      },
      deleteScheduledJob: async () => undefined,
      startAutopilotDataRun: async () => {
        throw new Error("not used");
      },
      pauseAutopilotRun: async () => {
        throw new Error("not used");
      },
      resumeAutopilotRun: async () => {
        throw new Error("not used");
      },
      cancelAutopilotRun: async () => {
        throw new Error("not used");
      },
      randomId: (prefix) => `${prefix}-1`,
      nowIso: () => "2026-08-03T00:00:00.000Z",
    });

    try {
      client.start();
      await waitFor(() => config.reverse?.status === "connected" && heartbeatPosts > 0, "fresh reverse connection");

      expect(config.agentInstanceId).toBe("agent-fresh");
      expect(requests.slice(0, 4)).toEqual([
        "POST /api/v1/agent/agent-stale/a2a-peers/reverse-connections",
        "POST /api/v1/agent/connect",
        "POST /api/v1/agent/agent-fresh/a2a-peers/reverse-connections",
        "GET /api/v1/agent/agent-fresh/a2a-peers/peer-fresh/events",
      ]);
    } finally {
      await client.stop(false);
      eventStream?.end();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
