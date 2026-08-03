import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import type { IdentityContext, ServstationA2AOidcSessionUpdate } from "@supbot/shared";
import { afterEach, describe, expect, test } from "vitest";
import { JsonFileStorage, SupbotRuntime } from "../src";

const tempDirs: string[] = [];

interface SwitchTestRuntime {
  runtime: SupbotRuntime;
  storage: JsonFileStorage;
  dataDir: string;
  statePath: string;
}

async function createSwitchRuntime(): Promise<SwitchTestRuntime> {
  const rootDir = await createGitRoot();
  const dataDir = await mkdtemp(join(tmpdir(), "supbot-test-"));
  tempDirs.push(dataDir);
  const storage = new JsonFileStorage(dataDir);
  const runtime = new SupbotRuntime(storage, { rootDir });
  await runtime.init();
  return { runtime, storage, dataDir, statePath: join(dataDir, "state.json") };
}

async function createGitRoot(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "supbot-root-"));
  tempDirs.push(rootDir);
  await runGit(rootDir, ["init"]);
  await runGit(rootDir, ["config", "user.email", "supbot@example.test"]);
  await runGit(rootDir, ["config", "user.name", "Supbot Test"]);
  await writeFile(join(rootDir, "README.md"), "baseline\n", "utf8");
  await runGit(rootDir, ["add", "README.md"]);
  await runGit(rootDir, ["commit", "-m", "baseline"]);
  return rootDir;
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr || `git ${args.join(" ")} failed`))));
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function waitForCondition(label: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface ServstationRequestLog {
  method: string;
  path: string;
  userId?: string;
  authorization?: string;
}

interface FakeServstation {
  baseUrl: string;
  requests: ServstationRequestLog[];
  failUserIds: Set<string>;
  streamRequested: () => boolean;
  releaseStream: () => void;
  close: () => Promise<void>;
}

async function startFakeServstation(options?: { holdFirstStream?: boolean }): Promise<FakeServstation> {
  const requests: ServstationRequestLog[] = [];
  const failUserIds = new Set<string>();
  const openStreams = new Set<ServerResponse>();
  let holdStream = Boolean(options?.holdFirstStream);
  let pendingStream: (() => void) | undefined;
  const server: Server = createServer((request, response) => {
    request.on("data", () => undefined);
    request.on("end", () => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const userIdHeader = request.headers["x-user-id"];
      requests.push({
        method: request.method || "",
        path: url.pathname,
        userId: typeof userIdHeader === "string" ? userIdHeader : undefined,
        authorization: typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
      });
      response.setHeader("Content-Type", "application/json");

      if (request.method === "POST" && url.pathname === "/api/v1/agent/connect") {
        if (userIdHeader && failUserIds.has(String(userIdHeader))) {
          response.statusCode = 401;
          response.end(JSON.stringify({ error: "invalid credentials" }));
          return;
        }
        response.end(JSON.stringify({ agentInstanceId: `agent-${String(userIdHeader)}` }));
        return;
      }
      const registration = url.pathname.match(/^\/api\/v1\/agent\/([^/]+)\/a2a-peers\/reverse-connections$/);
      if (request.method === "POST" && registration) {
        const agent = registration[1];
        response.end(
          JSON.stringify({
            peer: { id: `peer-${agent}` },
            streamUrl: `/api/v1/agent/${agent}/a2a-peers/peer-${agent}/events`,
          }),
        );
        return;
      }
      const events = url.pathname.match(/^\/api\/v1\/agent\/([^/]+)\/a2a-peers\/([^/]+)\/events$/);
      if (request.method === "GET" && events) {
        const open = () => {
          response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          openStreams.add(response);
          response.on("close", () => openStreams.delete(response));
          response.write(`event: heartbeat\ndata: {"ok":true}\n\n`);
        };
        if (holdStream) {
          holdStream = false;
          pendingStream = open;
          return;
        }
        open();
        return;
      }
      const heartbeat = url.pathname.match(/^\/api\/v1\/agent\/([^/]+)\/a2a-peers\/([^/]+)\/heartbeat$/);
      if (request.method === "POST" && heartbeat) {
        response.end(JSON.stringify({ status: "online" }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    failUserIds,
    streamRequested: () =>
      requests.some((entry) => entry.method === "GET" && entry.path.endsWith("/events")) || Boolean(pendingStream),
    releaseStream: () => {
      const open = pendingStream;
      pendingStream = undefined;
      open?.();
    },
    close: async () => {
      for (const stream of openStreams) {
        stream.end();
      }
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

function staffIdentity(userId: string, agentInstanceId?: string): IdentityContext {
  return {
    tenantId: `tenant-${userId}`,
    organizationId: `org-${userId}`,
    departmentId: `dept-${userId}`,
    userId,
    roleIds: ["staff"],
    source: "servstation",
    agentInstanceId,
  };
}

function sessionUpdate(baseUrl: string, userId: string, agentInstanceId?: string): ServstationA2AOidcSessionUpdate {
  return {
    baseUrl,
    issuerUrl: `${baseUrl}/issuer`,
    clientId: "agent-client",
    tokens: {
      accessToken: `${userId}-access-token`,
      refreshToken: `${userId}-refresh-token`,
      issuerUrl: `${baseUrl}/issuer`,
      clientId: "agent-client",
    },
    identityContext: staffIdentity(userId, agentInstanceId),
  };
}

async function configureOldAccount(
  runtime: SupbotRuntime,
  baseUrl: string,
  staffAgentPassword = "old-secret",
): Promise<void> {
  await runtime.updateServstationA2AConfig({
    enabled: true,
    baseUrl,
    authMode: "oidc",
    oidcIssuerUrl: `${baseUrl}/issuer`,
    oidcClientId: "agent-client",
    staffAgentAccount: "old-user",
    staffAgentPassword,
  });
  await runtime.updateServstationA2AOidcSession(sessionUpdate(baseUrl, "old-user", "agent-old-user"));
}

async function readPersistedState(statePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
}

describe("SupbotRuntime Servstation account switch", () => {
  test("commits the new account, identity, agent and peer only after the reverse SSE stream opens", async () => {
    const { runtime, statePath } = await createSwitchRuntime();
    const servstation = await startFakeServstation({ holdFirstStream: true });
    try {
      await configureOldAccount(runtime, servstation.baseUrl);

      let settled = false;
      const switching = runtime
        .switchServstationA2AAccount(
          { staffAgentAccount: "new-user", staffAgentPassword: "  new password  " },
          async () => sessionUpdate(servstation.baseUrl, "new-user"),
        )
        .then(
          (result) => {
            settled = true;
            return result;
          },
          (error) => {
            settled = true;
            throw error;
          },
        );

      await waitForCondition("held reverse SSE stream request", () => servstation.streamRequested());
      await delay(300);

      // The SSE stream is not open yet, so nothing may be committed or persisted.
      expect(settled).toBe(false);
      const beforeCommit = await readPersistedState(statePath);
      expect(beforeCommit.servstationA2AStaffAgentPasswordSecret).toBe("old-secret");
      expect(JSON.stringify(beforeCommit)).not.toContain("new password");

      servstation.releaseStream();
      const result = await switching;
      expect(settled).toBe(true);

      // The reverse connection used the candidate account, token and identity.
      const streamRequest = servstation.requests.find(
        (entry) => entry.method === "GET" && entry.path.endsWith("/events"),
      );
      expect(streamRequest).toMatchObject({
        userId: "new-user",
        authorization: "Bearer new-user-access-token",
      });

      // The old agent instance id was cleared and a fresh one was provisioned for the new account.
      const connectRequest = servstation.requests.find(
        (entry) => entry.method === "POST" && entry.path === "/api/v1/agent/connect",
      );
      expect(connectRequest?.userId).toBe("new-user");
      expect(result.agentInstanceId).toBe("agent-new-user");
      expect(result.staffAgentAccount).toBe("new-user");
      expect(result.staffAgentPasswordSaved).toBe(true);
      expect("staffAgentPassword" in result).toBe(false);
      expect(result.reverse).toMatchObject({ status: "connected", peerId: "peer-agent-new-user" });
      expect(runtime.snapshot().identityContext).toMatchObject({
        userId: "new-user",
        agentInstanceId: "agent-new-user",
      });

      // Persistence ordering: the new password (bytes preserved) and tokens land only after SSE opened.
      const afterCommit = await readPersistedState(statePath);
      expect(afterCommit.servstationA2AStaffAgentPasswordSecret).toBe("  new password  ");
      expect(JSON.parse(String(afterCommit.servstationA2AOidcSecret))).toEqual({
        accessToken: "new-user-access-token",
        refreshToken: "new-user-refresh-token",
        issuerUrl: `${servstation.baseUrl}/issuer`,
        clientId: "agent-client",
      });
      expect(JSON.stringify(afterCommit)).not.toContain("old-secret");
    } finally {
      servstation.releaseStream();
      await runtime.shutdown().catch(() => undefined);
      await servstation.close();
    }
  });

  test("restores the exact old session and disables the reverse bridge when authentication fails", async () => {
    const { runtime, statePath } = await createSwitchRuntime();
    const servstation = await startFakeServstation();
    try {
      await configureOldAccount(runtime, servstation.baseUrl, "  old-secret  ");
      const before = await runtime.servstationA2AConfig();

      await expect(
        runtime.switchServstationA2AAccount(
          { staffAgentAccount: "new-user", staffAgentPassword: "new-password" },
          async () => {
            throw new Error("authorization failed");
          },
        ),
      ).rejects.toThrow("authorization failed");

      const after = await runtime.servstationA2AConfig();
      expect({ ...after, reverse: undefined, updatedAt: undefined }).toEqual({
        ...before,
        reverse: undefined,
        updatedAt: undefined,
      });
      expect(after.reverse).toMatchObject({ enabled: false, status: "disconnected" });
      expect(runtime.snapshot().identityContext).toMatchObject({
        userId: "old-user",
        agentInstanceId: "agent-old-user",
      });

      const persisted = await readPersistedState(statePath);
      expect(persisted.servstationA2AStaffAgentPasswordSecret).toBe("  old-secret  ");
      expect(JSON.parse(String(persisted.servstationA2AOidcSecret))).toEqual({
        accessToken: "old-user-access-token",
        refreshToken: "old-user-refresh-token",
        issuerUrl: `${servstation.baseUrl}/issuer`,
        clientId: "agent-client",
      });
      expect(JSON.stringify(persisted)).not.toContain("new-password");
    } finally {
      await runtime.shutdown().catch(() => undefined);
      await servstation.close();
    }
  });

  test("restores the old session and forces the reverse bridge off when the new connection fails", async () => {
    const { runtime, statePath } = await createSwitchRuntime();
    const servstation = await startFakeServstation();
    try {
      await configureOldAccount(runtime, servstation.baseUrl, "  old-secret  ");
      await runtime.connectServstationReverseBridge();
      await waitForCondition(
        "old reverse connection",
        () => runtime.snapshot().servstationA2A.config.reverse?.status === "connected",
      );
      const before = await runtime.servstationA2AConfig();
      expect(before.reverse?.peerId).toBe("peer-agent-old-user");

      servstation.failUserIds.add("new-user");
      await expect(
        runtime.switchServstationA2AAccount(
          { staffAgentAccount: "new-user", staffAgentPassword: "new-password" },
          async () => sessionUpdate(servstation.baseUrl, "new-user"),
        ),
      ).rejects.toThrow("invalid credentials");

      const after = await runtime.servstationA2AConfig();
      expect({ ...after, reverse: undefined, updatedAt: undefined }).toEqual({
        ...before,
        reverse: undefined,
        updatedAt: undefined,
      });
      expect(after.reverse).toMatchObject({ enabled: false, status: "disconnected" });
      expect(after.reverse?.connectedAt).toBeUndefined();
      expect(runtime.snapshot().identityContext).toMatchObject({
        userId: "old-user",
        agentInstanceId: "agent-old-user",
      });

      const persisted = await readPersistedState(statePath);
      expect(persisted.servstationA2AStaffAgentPasswordSecret).toBe("  old-secret  ");
      const serialized = JSON.stringify(persisted);
      expect(serialized).toContain("old-user-refresh-token");
      expect(serialized).not.toContain("new-password");
      expect(serialized).not.toContain("new-user-access-token");
      expect(serialized).not.toContain("new-user-refresh-token");
    } finally {
      await runtime.shutdown().catch(() => undefined);
      await servstation.close();
    }
  });

  test("rejects a second switch and conflicting mutations while a switch is in progress", async () => {
    const { runtime } = await createSwitchRuntime();
    const servstation = await startFakeServstation();
    try {
      await configureOldAccount(runtime, servstation.baseUrl);

      const gate = deferred<void>();
      let authorizeCalled = false;
      const switching = runtime.switchServstationA2AAccount(
        { staffAgentAccount: "new-user", staffAgentPassword: "new-password" },
        async () => {
          authorizeCalled = true;
          await gate.promise;
          return sessionUpdate(servstation.baseUrl, "new-user");
        },
      );
      await waitForCondition("authorize invocation", () => authorizeCalled);

      await expect(
        runtime.switchServstationA2AAccount(
          { staffAgentAccount: "other-user", staffAgentPassword: "other-password" },
          async () => sessionUpdate(servstation.baseUrl, "other-user"),
        ),
      ).rejects.toThrow(/already in progress/);
      await expect(runtime.updateServstationA2AConfig({ staffAgentAccount: "other-user" })).rejects.toThrow(
        /already in progress/,
      );
      await expect(runtime.updateIdentityContext(staffIdentity("other-user"))).rejects.toThrow(/already in progress/);
      await expect(
        runtime.updateServstationA2AOidcSession(sessionUpdate(servstation.baseUrl, "other-user")),
      ).rejects.toThrow(/already in progress/);
      await expect(runtime.clearServstationA2AOidcSession()).rejects.toThrow(/already in progress/);
      await expect(runtime.connectServstationReverseBridge()).rejects.toThrow(/already in progress/);
      await expect(runtime.disconnectServstationReverseBridge()).rejects.toThrow(/already in progress/);
      await expect(runtime.servstationA2AAccessToken()).rejects.toThrow(/already in progress/);

      gate.resolve();
      const result = await switching;
      expect(result.staffAgentAccount).toBe("new-user");
      expect(result.reverse?.status).toBe("connected");
    } finally {
      await runtime.shutdown().catch(() => undefined);
      await servstation.close();
    }
  });

  test("surfaces rollback persistence failures as an aggregate error", async () => {
    const { runtime, storage } = await createSwitchRuntime();
    const servstation = await startFakeServstation();
    try {
      await configureOldAccount(runtime, servstation.baseUrl);

      const originalSave = storage.save.bind(storage);
      storage.save = async () => {
        throw new Error("simulated disk failure");
      };
      const failure = await runtime
        .switchServstationA2AAccount(
          { staffAgentAccount: "new-user", staffAgentPassword: "new-password" },
          async () => {
            throw new Error("authorization failed");
          },
        )
        .catch((error: unknown) => error);
      storage.save = originalSave;

      expect(failure).toBeInstanceOf(AggregateError);
      const aggregate = failure as AggregateError;
      expect(aggregate.message).toMatch(/rollback was incomplete/);
      expect(aggregate.errors.length).toBeGreaterThanOrEqual(2);
      expect(
        aggregate.errors.some((error) => String((error as Error).message).includes("simulated disk failure")),
      ).toBe(true);
    } finally {
      await runtime.shutdown().catch(() => undefined);
      await servstation.close();
    }
  });

  test("stops the reverse bridge during shutdown after a successful switch", async () => {
    const { runtime } = await createSwitchRuntime();
    const servstation = await startFakeServstation();
    try {
      await configureOldAccount(runtime, servstation.baseUrl);
      const result = await runtime.switchServstationA2AAccount(
        { staffAgentAccount: "new-user", staffAgentPassword: "new-password" },
        async () => sessionUpdate(servstation.baseUrl, "new-user"),
      );
      expect(result.reverse?.status).toBe("connected");

      await runtime.shutdown();
      expect(runtime.snapshot().servstationA2A.config.reverse).toMatchObject({ status: "disconnected" });
    } finally {
      await servstation.close();
    }
  });

  test("stores the staff-agent password bytes exactly as provided and rejects blank passwords", async () => {
    const { runtime, statePath } = await createSwitchRuntime();
    const servstation = await startFakeServstation();
    try {
      await runtime.updateServstationA2AConfig({
        enabled: true,
        baseUrl: servstation.baseUrl,
        authMode: "oidc",
        oidcIssuerUrl: `${servstation.baseUrl}/issuer`,
        oidcClientId: "agent-client",
        staffAgentAccount: "old-user",
        staffAgentPassword: "  padded secret  ",
      });
      const persisted = await readPersistedState(statePath);
      expect(persisted.servstationA2AStaffAgentPasswordSecret).toBe("  padded secret  ");

      await expect(
        runtime.switchServstationA2AAccount({ staffAgentAccount: "new-user", staffAgentPassword: "   " }, async () =>
          sessionUpdate(servstation.baseUrl, "new-user"),
        ),
      ).rejects.toThrow(/password is required/);
    } finally {
      await runtime.shutdown().catch(() => undefined);
      await servstation.close();
    }
  });

  test("rejects account switching when the auth mode is not OIDC", async () => {
    const { runtime, statePath } = await createSwitchRuntime();
    const servstation = await startFakeServstation();
    try {
      await runtime.updateServstationA2AConfig({
        enabled: true,
        baseUrl: servstation.baseUrl,
        authMode: "bearer",
        bearerToken: "static-token",
        staffAgentAccount: "old-user",
      });

      let authorizeCalled = false;
      await expect(
        runtime.switchServstationA2AAccount(
          { staffAgentAccount: "new-user", staffAgentPassword: "new-password" },
          async () => {
            authorizeCalled = true;
            return sessionUpdate(servstation.baseUrl, "new-user");
          },
        ),
      ).rejects.toThrow(/requires Servstation OIDC authentication/);
      expect(authorizeCalled).toBe(false);

      // The bearer configuration and credentials are untouched.
      expect(runtime.snapshot().servstationA2A.config.authMode).toBe("bearer");
      expect(runtime.snapshot().servstationA2A.config.staffAgentAccount).toBe("old-user");
      const persisted = await readPersistedState(statePath);
      expect(JSON.stringify(persisted)).not.toContain("new-password");
    } finally {
      await runtime.shutdown().catch(() => undefined);
      await servstation.close();
    }
  });
});
