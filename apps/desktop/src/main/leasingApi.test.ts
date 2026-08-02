import { describe, expect, it, vi } from "vitest";
import type { IdentityContext, LeasingRequestInput, ServstationA2AConfig } from "@supbot/shared";
import {
  hasLeasingScopes,
  mergeLeasingScopes,
  parseResponseBody,
  requestLeasing,
  resolveLeasingApiBaseUrl,
  validateLeasingRequest,
  type LeasingRuntime,
} from "./leasingApi";

const identity: IdentityContext = {
  tenantId: "tenant-1",
  organizationId: "org-1",
  departmentId: "dept-1",
  userId: "user-1",
  roleIds: ["leasing-reader", "leasing-operator"],
};

const config = (authMode: ServstationA2AConfig["authMode"]): ServstationA2AConfig => ({
  enabled: true,
  baseUrl: "http://gateway.test:8800",
  authMode,
  bearerTokenSaved: authMode === "bearer",
  staffAgentPasswordSaved: false,
  oidc: { refreshTokenSaved: authMode === "oidc", scope: "openid profile email leasing.read leasing.command" },
});

function runtime(
  authMode: ServstationA2AConfig["authMode"],
  token = "token-1",
): LeasingRuntime & {
  refreshes: boolean[];
} {
  const refreshes: boolean[] = [];
  return {
    refreshes,
    servstationA2AConfig: vi.fn(async () => config(authMode)),
    identityContext: vi.fn(async () => identity),
    servstationA2AAccessToken: vi.fn(async (_signal?: AbortSignal, forceRefresh?: boolean) => {
      refreshes.push(Boolean(forceRefresh));
      return token;
    }),
  };
}

function response(body: BodyInit | null, init: ResponseInit = {}): Response {
  return new Response(body, init);
}

describe("leasing transport", () => {
  it("resolves the gateway leasing namespace and preserves explicit overrides", () => {
    expect(resolveLeasingApiBaseUrl("http://gateway.test:8800", undefined, {})).toBe(
      "http://gateway.test:8800/api/v1/leasing",
    );
    expect(resolveLeasingApiBaseUrl("http://gateway.test:8800/api/v1", undefined, {})).toBe(
      "http://gateway.test:8800/api/v1/leasing",
    );
    expect(
      resolveLeasingApiBaseUrl(undefined, undefined, { HBCLIENT_LEASING_API_BASE_URL: "http://api.test:8095/api/v1" }),
    ).toBe("http://api.test:8095/api/v1");
  });

  it("adds trusted identity headers without allowing renderer auth overrides", async () => {
    const service = runtime("identityHeaders");
    let seen: Request | undefined;
    const result = await requestLeasing(
      service,
      {
        path: "/dashboard",
        headers: { Accept: "application/json" },
      },
      {
        fetch: vi.fn(async (input, init) => {
          seen = new Request(input, init);
          return response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }),
      },
    );
    expect(result.body).toEqual({ encoding: "json", data: { ok: true } });
    expect(seen?.url).toBe("http://gateway.test:8800/api/v1/leasing/dashboard");
    expect(seen?.headers.get("X-Botstation-Tenant-Id")).toBe("tenant-1");
    expect(seen?.headers.get("X-Botstation-Organization-Id")).toBe("org-1");
    expect(seen?.headers.get("X-Botstation-Department-Id")).toBe("dept-1");
    expect(seen?.headers.get("X-Botstation-User-Id")).toBe("user-1");
    expect(seen?.headers.get("X-Botstation-Role-Ids")).toBe("leasing-reader,leasing-operator");
    expect(seen?.headers.get("Authorization")).toBeNull();
  });

  it("uses an OIDC bearer token and refreshes once after a 401", async () => {
    const service = runtime("oidc");
    const calls: Request[] = [];
    let attempts = 0;
    const result = await requestLeasing(
      service,
      { path: "/rating/models", method: "GET" },
      {
        fetch: vi.fn(async (input, init) => {
          calls.push(new Request(input, init));
          attempts += 1;
          return attempts === 1
            ? response(JSON.stringify({ error: "expired" }), {
                status: 401,
                headers: { "content-type": "application/json" },
              })
            : response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } });
        }),
      },
    );
    expect(result.status).toBe(200);
    expect(service.refreshes).toEqual([false, true]);
    expect(calls[0].headers.get("Authorization")).toBe("Bearer token-1");
    expect(calls[1].headers.get("Authorization")).toBe("Bearer token-1");
  });

  it("preserves leasing authorization and conflict responses for the renderer", async () => {
    const service = runtime("identityHeaders");
    const denied = await requestLeasing(
      service,
      { path: "/commands/customer.create", method: "POST", body: "{}" },
      {
        fetch: vi.fn(async () =>
          response(JSON.stringify({ error: { code: "forbidden", message: "role denied" }, requestId: "req-1" }), {
            status: 403,
            headers: { "content-type": "application/problem+json" },
          }),
        ),
      },
    );
    expect(denied).toMatchObject({
      ok: false,
      status: 403,
      body: { encoding: "json", data: { error: { code: "forbidden", message: "role denied" }, requestId: "req-1" } },
    });

    const conflict = await requestLeasing(
      service,
      { path: "/commands/customer.create", method: "POST", body: "{}" },
      {
        fetch: vi.fn(async () =>
          response('{"message":"version conflict"}', {
            status: 409,
            headers: { "content-type": "application/json" },
          }),
        ),
      },
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ encoding: "json", data: { message: "version conflict" } });
  });

  it("returns binary content as base64 and supports multipart bodies", async () => {
    const service = runtime("identityHeaders");
    let seen: Request | undefined;
    const bytes = Uint8Array.from([0, 1, 2, 255]);
    const binary = await requestLeasing(
      service,
      { path: "/risk-imports/template" },
      {
        fetch: vi.fn(async () =>
          response(bytes, {
            status: 200,
            headers: { "content-type": "application/pdf", "content-disposition": "attachment; filename=template.pdf" },
          }),
        ),
      },
    );
    expect(binary.body).toEqual({ encoding: "base64", data: "AAEC/w==" });

    await requestLeasing(
      service,
      {
        path: "/partners/p-1/evidence/files",
        method: "POST",
        body: {
          encoding: "multipart",
          fields: [{ name: "description", value: "evidence" }],
          files: [
            { fieldName: "file", fileName: "evidence.txt", contentType: "text/plain", contentBase64: "aGVsbG8=" },
          ],
        },
      },
      {
        fetch: vi.fn(async (input, init) => {
          seen = new Request(input, init);
          return response(null, { status: 204 });
        }),
      },
    );
    expect(seen?.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
    expect(await seen?.formData()).toBeInstanceOf(FormData);
  });

  it("rejects path traversal and renderer-supplied credentials", () => {
    const valid: LeasingRequestInput = { path: "/dashboard" };
    expect(validateLeasingRequest(valid)).toMatchObject({ path: "/dashboard", method: "GET" });
    expect(() => validateLeasingRequest({ path: "/../dashboard" })).toThrow(/traversal/);
    expect(() => validateLeasingRequest({ path: "/audit/overview" })).toThrow(/supported leasing workspace/);
    expect(() => validateLeasingRequest({ path: "/dashboard", headers: { Authorization: "Bearer forged" } })).toThrow(
      /header is not allowed/,
    );
  });

  it("merges leasing scopes without duplicating existing values", () => {
    expect(mergeLeasingScopes("openid profile leasing.read")).toBe("openid profile leasing.read leasing.command");
    expect(mergeLeasingScopes(undefined)).toBe("leasing.read leasing.command");
    expect(parseResponseBody(new TextEncoder().encode('{"status":"ok"}'), "")).toEqual({
      encoding: "json",
      data: { status: "ok" },
    });
    expect(hasLeasingScopes(undefined)).toBe(false);
    expect(hasLeasingScopes("openid profile leasing.read leasing.command")).toBe(true);
  });
});
