import { describe, expect, it, vi } from "vitest";
import type { ServstationA2AOidcTokenSet } from "@supbot/shared";
import {
  defaultLeasingOidcClientId,
  defaultLeasingOidcRedirectUri,
  LeasingOidcSession,
  type LeasingOidcAuthorizer,
} from "./leasingOidc";

const loginInput = {
  baseUrl: "http://gateway.test:8800",
  issuerUrl: "http://sso.test:8092",
  loginHint: "dev-user",
  expectedIdentity: {
    tenantId: "tenant-1",
    organizationId: "org-1",
    departmentId: "dept-1",
    userId: "dev-user",
  },
};

describe("leasing OIDC session", () => {
  it("rejects the primary gateway audience and requests the dedicated leasing client", async () => {
    const authorize = vi.fn<LeasingOidcAuthorizer>(async (input) => token("gateway-api", input.clientId || ""));
    const session = new LeasingOidcSession(authorize);

    await expect(session.accessToken(loginInput)).rejects.toThrow("audience must include leasing-api");
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: defaultLeasingOidcClientId,
        redirectUri: defaultLeasingOidcRedirectUri,
        scope: expect.stringContaining("leasing.read"),
      }),
    );
  });

  it("caches a leasing audience token without requiring a refresh token", async () => {
    let sequence = 0;
    const authorize = vi.fn<LeasingOidcAuthorizer>(async (input) => {
      sequence += 1;
      return token("leasing-api", input.clientId || "", sequence);
    });
    const session = new LeasingOidcSession(authorize);

    const first = await session.accessToken(loginInput);
    expect(await session.accessToken(loginInput)).toBe(first);
    expect(authorize).toHaveBeenCalledTimes(1);

    const replacement = await session.accessToken(loginInput, true);
    expect(replacement).not.toBe(first);
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it("accepts a read-only leasing token", async () => {
    const authorize = vi.fn<LeasingOidcAuthorizer>(async (input) =>
      token("leasing-api", input.clientId || "", 1, loginInput.expectedIdentity, "openid leasing.read"),
    );
    const session = new LeasingOidcSession(authorize);

    await expect(session.accessToken(loginInput)).resolves.toContain(".");
  });

  it("rejects a leasing token issued for a different account", async () => {
    const authorize = vi.fn<LeasingOidcAuthorizer>(async (input) =>
      token("leasing-api", input.clientId || "", 1, { ...loginInput.expectedIdentity, userId: "other-user" }),
    );
    const session = new LeasingOidcSession(authorize);

    await expect(session.accessToken(loginInput)).rejects.toThrow("identity does not match");
  });

  it("binds cached tokens to the current HBClient identity", async () => {
    const otherIdentity = { ...loginInput.expectedIdentity, userId: "other-user" };
    let sequence = 0;
    const authorize = vi.fn<LeasingOidcAuthorizer>(async (input) => {
      sequence += 1;
      return token(
        "leasing-api",
        input.clientId || "",
        sequence,
        sequence === 1 ? loginInput.expectedIdentity : otherIdentity,
      );
    });
    const session = new LeasingOidcSession(authorize);

    const first = await session.accessToken(loginInput);
    const second = await session.accessToken({ ...loginInput, expectedIdentity: otherIdentity });

    expect(second).not.toBe(first);
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it("does not restore an in-flight token after the session is cleared", async () => {
    const resolvers: Array<(tokens: ServstationA2AOidcTokenSet) => void> = [];
    const authorize = vi.fn<LeasingOidcAuthorizer>(
      async () => new Promise<ServstationA2AOidcTokenSet>((resolve) => resolvers.push(resolve)),
    );
    const session = new LeasingOidcSession(authorize);

    const staleRequest = session.accessToken(loginInput);
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    session.clear();
    const currentRequest = session.accessToken(loginInput);
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));

    resolvers[1](token("leasing-api", defaultLeasingOidcClientId, 2));
    const current = await currentRequest;
    resolvers[0](token("leasing-api", defaultLeasingOidcClientId, 1));
    await staleRequest;

    expect(await session.accessToken(loginInput)).toBe(current);
    expect(authorize).toHaveBeenCalledTimes(2);
  });
});

function token(
  audience: string,
  clientId: string,
  sequence = 1,
  identity = loginInput.expectedIdentity,
  scope = "openid profile email leasing.read leasing.command",
): ServstationA2AOidcTokenSet {
  const expiresAt = Date.now() + 300_000;
  return {
    accessToken: fakeJwt({
      aud: [audience],
      exp: Math.floor(expiresAt / 1000),
      jti: `token-${sequence}`,
      ...identity,
    }),
    issuerUrl: loginInput.issuerUrl,
    clientId,
    scope,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

function fakeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.`;
}
