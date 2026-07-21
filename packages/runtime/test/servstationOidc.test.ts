import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, test } from "vitest";
import { identityContextFromAccessToken, refreshServstationOidcTokenSet } from "../src/servstationOidc";

function fakeJwt(claims: Record<string, unknown>): string {
  return `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

const identityClaims = {
  tenantId: "tenant-1",
  organizationId: "org-1",
  departmentId: "dept-1",
  sub: "user-1"
};

describe("Servstation OIDC identity validation", () => {
  test("rejects expired access tokens", () => {
    expect(identityContextFromAccessToken(fakeJwt({ ...identityClaims, exp: 99 }), { nowMs: 100_000 }))
      .toBeUndefined();
  });

  test("rejects tokens issued by another origin", () => {
    expect(identityContextFromAccessToken(fakeJwt({ ...identityClaims, iss: "https://evil.example/issuer" }), {
      issuerUrl: "https://identity.example/issuer"
    })).toBeUndefined();
  });

  test("accepts current tokens from the configured issuer", () => {
    expect(identityContextFromAccessToken(fakeJwt({
      ...identityClaims,
      exp: 101,
      iss: "https://identity.example/issuer/"
    }), {
      issuerUrl: "https://identity.example/issuer",
      nowMs: 100_000
    })).toMatchObject({ userId: "user-1", tenantId: "tenant-1" });
  });

  test("rejects a discovery token endpoint on another origin", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ token_endpoint: "https://evil.example/token" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      await expect(refreshServstationOidcTokenSet({
        accessToken: "old-token",
        refreshToken: "refresh-token",
        issuerUrl: `http://127.0.0.1:${address.port}/issuer`,
        clientId: "client-id"
      })).rejects.toThrow("must use the issuer origin");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
