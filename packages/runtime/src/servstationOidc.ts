import { Buffer } from "node:buffer";

import type {
  IdentityContext,
  ServstationA2AOidcTokenSet
} from "@supbot/shared";

interface TokenEndpointResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
}

interface OidcDiscovery {
  token_endpoint?: string;
}

export function parseServstationOidcSecret(secret: string | undefined): ServstationA2AOidcTokenSet | undefined {
  if (!secret?.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(secret) as Partial<ServstationA2AOidcTokenSet>;
    if (typeof parsed.accessToken !== "string" || !parsed.accessToken.trim()) {
      return undefined;
    }
    if (typeof parsed.issuerUrl !== "string" || typeof parsed.clientId !== "string") {
      return undefined;
    }
    return {
      accessToken: parsed.accessToken,
      refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : undefined,
      idToken: typeof parsed.idToken === "string" ? parsed.idToken : undefined,
      tokenType: typeof parsed.tokenType === "string" ? parsed.tokenType : undefined,
      scope: typeof parsed.scope === "string" ? parsed.scope : undefined,
      expiresAt: typeof parsed.expiresAt === "string" ? parsed.expiresAt : undefined,
      issuerUrl: parsed.issuerUrl,
      clientId: parsed.clientId
    };
  } catch {
    return undefined;
  }
}

export function serializeServstationOidcSecret(tokens: ServstationA2AOidcTokenSet): string {
  return JSON.stringify(tokens);
}

export function oidcAccessTokenExpiringSoon(tokens: ServstationA2AOidcTokenSet, skewMs = 60_000): boolean {
  if (!tokens.expiresAt) {
    return false;
  }
  const expiresAt = new Date(tokens.expiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt <= Date.now() + skewMs;
}

export async function refreshServstationOidcTokenSet(
  tokens: ServstationA2AOidcTokenSet,
  signal?: AbortSignal,
): Promise<ServstationA2AOidcTokenSet> {
  if (!tokens.refreshToken) {
    throw new Error("Servstation OIDC refresh token is not saved.");
  }
  const tokenEndpoint = await discoverTokenEndpoint(tokens.issuerUrl, signal);
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: tokens.clientId,
      refresh_token: tokens.refreshToken
    })
  });
  const payload = await response.json().catch(() => ({})) as TokenEndpointResponse & { error?: string; error_description?: string };
  if (!response.ok || !payload.access_token) {
    const message = payload.error_description || payload.error || `HTTP ${response.status}`;
    throw new Error(`Servstation OIDC refresh failed: ${message}`);
  }
  return oidcTokenSetFromTokenResponse(payload, {
    issuerUrl: tokens.issuerUrl,
    clientId: tokens.clientId,
    fallbackRefreshToken: tokens.refreshToken
  });
}

export function oidcTokenSetFromTokenResponse(
  payload: TokenEndpointResponse,
  context: { issuerUrl: string; clientId: string; fallbackRefreshToken?: string },
): ServstationA2AOidcTokenSet {
  if (!payload.access_token) {
    throw new Error("Servstation OIDC token response did not include an access token.");
  }
  const expiresAt = typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
    ? new Date(Date.now() + Math.max(0, payload.expires_in - 30) * 1000).toISOString()
    : undefined;
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || context.fallbackRefreshToken,
    idToken: payload.id_token,
    tokenType: payload.token_type,
    scope: payload.scope,
    expiresAt,
    issuerUrl: normalizeUrl(context.issuerUrl),
    clientId: context.clientId
  };
}

export function identityContextFromAccessToken(accessToken: string, base: Partial<IdentityContext> = {}): IdentityContext | undefined {
  const claims = decodeJwtPayload(accessToken);
  if (!claims) {
    return undefined;
  }
  const tenantId = firstString(claims.tenantId, claims.tenant_id, base.tenantId);
  const organizationId = firstString(claims.organizationId, claims.organization_id, base.organizationId);
  const departmentId = firstString(claims.departmentId, claims.department_id, base.departmentId);
  const userId = firstString(claims.userId, claims.user_id, claims.preferred_username, claims.sub, base.userId);
  if (!tenantId || !organizationId || !departmentId || !userId) {
    return undefined;
  }
  return {
    tenantId,
    organizationId,
    departmentId,
    userId,
    roleIds: claimStringArray(claims.roleIds)
      || claimStringArray(claims.roles)
      || claimStringArray((claims.realm_access as Record<string, unknown> | undefined)?.roles)
      || base.roleIds
      || [],
    source: "servstation",
    agentInstanceId: base.agentInstanceId,
    servstationUrl: base.servstationUrl,
    updatedAt: new Date().toISOString()
  };
}

async function discoverTokenEndpoint(issuerUrl: string, signal?: AbortSignal): Promise<string> {
  const issuer = normalizeUrl(issuerUrl);
  const response = await fetch(`${issuer}/.well-known/openid-configuration`, { signal });
  const payload = await response.json().catch(() => ({})) as OidcDiscovery;
  if (!response.ok || !payload.token_endpoint) {
    throw new Error(`Servstation OIDC discovery failed for ${issuer}`);
  }
  return payload.token_endpoint;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length < 2) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function claimStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim());
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return undefined;
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}
