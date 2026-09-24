import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, test } from "vitest";
import type { IdentityContext, ServstationA2AConfig, ServstationA2AReverseConfig } from "@supbot/shared";
import { ServstationReverseBridgeClient } from "../src/servstationReverseBridgeClient";

describe("ServstationReverseBridgeClient", () => {
  test("survives a persistence failure in updateReverseState and keeps reconnecting", { timeout: 20_000 }, async () => {
    let registrations = 0;
    const server = createServer((request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (request.method === "POST" && url.pathname === "/api/v1/agent/agent-1/a2a-peers/reverse-connections") {
        registrations += 1;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ peer: { id: "peer-1" } }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/agent/agent-1/a2a-peers/peer-1/events") {
        // SSE 流立即结束：驱动 runLoop 进入 "stream ended" 错误路径。
        response.setHeader("Content-Type", "text/event-stream");
        response.end(": bye\n\n");
        return;
      }
      response.statusCode = 404;
      response.end("not found");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;

    const config: ServstationA2AConfig = {
      enabled: true,
      baseUrl: `http://127.0.0.1:${address.port}`,
      authMode: "oidc",
      bearerTokenSaved: false,
      staffAgentPasswordSaved: false,
      agentInstanceId: "agent-1",
      reverse: { enabled: true, status: "connected" },
    };
    const identity: IdentityContext = {
      tenantId: "tenant-1",
      organizationId: "organization-1",
      departmentId: "department-1",
      userId: "user-1",
      roleIds: ["user"],
      source: "servstation",
    };
    let failNextErrorUpdate = true;
    const reverseStatuses: Array<string | undefined> = [];
    const notImplemented = (name: string) => (): never => {
      throw new Error(`${name} not implemented in test`);
    };
    const client = new ServstationReverseBridgeClient({
      getConfig: () => config,
      getAccessToken: async () => "token",
      getIdentityContext: () => identity,
      updateConfig: async () => config,
      updateReverseState: async (input: Partial<ServstationA2AReverseConfig>) => {
        reverseStatuses.push(input.status);
        // 模拟 state.json 被占用导致的持久化 EPERM：首次记录 error 状态时抛出。
        if (failNextErrorUpdate && input.status === "error") {
          failNextErrorUpdate = false;
          throw new Error("EPERM: operation not permitted, rename state.json");
        }
      },
      sendReadOnlyPromptAndWait: notImplemented("sendReadOnlyPromptAndWait"),
      getSnapshot: notImplemented("getSnapshot"),
      loadTranscript: notImplemented("loadTranscript"),
      createScheduledJob: notImplemented("createScheduledJob"),
      updateScheduledJob: notImplemented("updateScheduledJob"),
      deleteScheduledJob: notImplemented("deleteScheduledJob"),
      startAutopilotDataRun: notImplemented("startAutopilotDataRun"),
      pauseAutopilotRun: notImplemented("pauseAutopilotRun"),
      resumeAutopilotRun: notImplemented("resumeAutopilotRun"),
      cancelAutopilotRun: notImplemented("cancelAutopilotRun"),
      randomId: (prefix: string) => `${prefix}-1`,
      nowIso: () => "2026-01-01T00:00:00.000Z",
    });

    client.start();
    try {
      const deadline = Date.now() + 15_000;
      while (registrations < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(reverseStatuses).toContain("error");
      // 持久化失败不得杀死重连循环：第一次失败重试后应再次发起注册。
      expect(registrations).toBeGreaterThanOrEqual(2);
    } finally {
      await client.stop();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  test("mints a fresh agent instance when the stored one is not accessible", { timeout: 20_000 }, async () => {
    let connectCalls = 0;
    const server = createServer((request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (request.method === "POST" && url.pathname === "/api/v1/agent/connect") {
        connectCalls += 1;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ agentInstanceId: "agent-fresh" }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/agent/agent-stale/a2a-peers/reverse-connections") {
        response.statusCode = 403;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ error: "agent instance is not accessible in current user context" }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/agent/agent-fresh/a2a-peers/reverse-connections") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ peer: { id: "peer-1" } }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/agent/agent-fresh/a2a-peers/peer-1/events") {
        response.setHeader("Content-Type", "text/event-stream");
        response.end(": bye\n\n");
        return;
      }
      response.statusCode = 404;
      response.end("not found");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;

    const config: ServstationA2AConfig = {
      enabled: true,
      baseUrl: `http://127.0.0.1:${address.port}`,
      authMode: "oidc",
      bearerTokenSaved: false,
      staffAgentPasswordSaved: false,
      agentInstanceId: "agent-stale",
      reverse: { enabled: true, status: "connected" },
    };
    const identity: IdentityContext = {
      tenantId: "tenant-1",
      organizationId: "organization-1",
      departmentId: "department-1",
      userId: "user-1",
      roleIds: ["user"],
      source: "servstation",
    };
    const notImplemented = (name: string) => (): never => {
      throw new Error(`${name} not implemented in test`);
    };
    const client = new ServstationReverseBridgeClient({
      getConfig: () => config,
      getAccessToken: async () => "token",
      getIdentityContext: () => identity,
      updateConfig: async (input) => {
        if (input.agentInstanceId !== undefined) {
          config.agentInstanceId = input.agentInstanceId;
        }
        return config;
      },
      updateReverseState: async () => {},
      sendReadOnlyPromptAndWait: notImplemented("sendReadOnlyPromptAndWait"),
      getSnapshot: notImplemented("getSnapshot"),
      loadTranscript: notImplemented("loadTranscript"),
      createScheduledJob: notImplemented("createScheduledJob"),
      updateScheduledJob: notImplemented("updateScheduledJob"),
      deleteScheduledJob: notImplemented("deleteScheduledJob"),
      startAutopilotDataRun: notImplemented("startAutopilotDataRun"),
      pauseAutopilotRun: notImplemented("pauseAutopilotRun"),
      resumeAutopilotRun: notImplemented("resumeAutopilotRun"),
      cancelAutopilotRun: notImplemented("cancelAutopilotRun"),
      randomId: (prefix: string) => `${prefix}-1`,
      nowIso: () => "2026-01-01T00:00:00.000Z",
    });

    client.start();
    try {
      const deadline = Date.now() + 15_000;
      while (config.agentInstanceId !== "agent-fresh" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // 403 “not accessible” 时应换一个绑定当前用户的新实例并重试注册。
      expect(connectCalls).toBeGreaterThanOrEqual(1);
      expect(config.agentInstanceId).toBe("agent-fresh");
    } finally {
      await client.stop();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
