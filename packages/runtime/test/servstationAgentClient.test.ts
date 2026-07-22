import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, test } from "vitest";
import type { IdentityContext, ServstationA2AConfig } from "@supbot/shared";
import { ServstationAgentClient } from "../src/servstationAgentClient";

describe("ServstationAgentClient job files", () => {
  test("downloads binary content with authentication and refreshes once after a 401", async () => {
    let attempts = 0;
    let refreshes = 0;
    let accessToken = "stale-token";
    const authorizations: Array<string | undefined> = [];
    const tenantHeaders: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (request.method !== "GET" || url.pathname !== "/api/v1/agent/agent-1/jobs/job-1/files/file-1/download") {
        response.statusCode = 404;
        response.end("not found");
        return;
      }
      attempts += 1;
      authorizations.push(request.headers.authorization);
      tenantHeaders.push(request.headers["x-tenant-id"] as string | undefined);
      if (attempts === 1) {
        response.statusCode = 401;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ error: "expired" }));
        return;
      }
      response.setHeader("Content-Type", "application/pdf; charset=binary");
      response.setHeader("Content-Disposition", "attachment; filename*=UTF-8''reports%2Ffinal%20report.pdf");
      response.end(Buffer.from([0, 1, 2, 255]));
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
    const client = new ServstationAgentClient({
      getConfig: () => config,
      getAccessToken: async () => accessToken,
      refreshAccessToken: async () => {
        refreshes += 1;
        accessToken = "fresh-token";
        return accessToken;
      },
      getIdentityContext: () => identity,
      updateConfig: async () => config,
      randomId: (prefix) => `${prefix}-1`,
      nowIso: () => "2026-01-01T00:00:00.000Z",
    });

    try {
      await expect(client.fetchJobFile("job-1", "file-1")).resolves.toEqual({
        fileId: "file-1",
        fileName: "final report.pdf",
        contentType: "application/pdf",
        sizeBytes: 4,
        contentBase64: Buffer.from([0, 1, 2, 255]).toString("base64"),
      });
      expect(refreshes).toBe(1);
      expect(authorizations).toEqual(["Bearer stale-token", "Bearer fresh-token"]);
      expect(tenantHeaders).toEqual(["tenant-1", "tenant-1"]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
