import { Buffer } from "node:buffer";
import {
  defaultServstationScope,
  type IdentityContext,
  type ServstationA2AOidcLoginInput,
  type ServstationA2AOidcTokenSet,
} from "@supbot/shared";
import { mergeLeasingScopes } from "./leasingApi";

export const defaultLeasingOidcClientId = "botstation-leasing-cli";
export const defaultLeasingOidcRedirectUri = "http://127.0.0.1:5186/oauth2/callback";
export const leasingOidcAudience = "leasing-api";

type LeasingIdentityBinding = Pick<IdentityContext, "tenantId" | "organizationId" | "departmentId" | "userId">;

export interface LeasingOidcLoginInput {
  baseUrl: string;
  issuerUrl: string;
  clientId?: string;
  scope?: string;
  redirectUri?: string;
  loginHint?: string;
  expectedIdentity: LeasingIdentityBinding;
}

export type LeasingOidcAuthorizer = (input: ServstationA2AOidcLoginInput) => Promise<ServstationA2AOidcTokenSet>;

type ResolvedLeasingOidcLoginInput = ServstationA2AOidcLoginInput & {
  expectedIdentity: LeasingIdentityBinding;
};

/** Keeps the audience-bound leasing access token separate from the gateway session. */
export class LeasingOidcSession {
  private cached: { key: string; tokens: ServstationA2AOidcTokenSet } | undefined;
  private pendingLogin: { key: string; generation: number; promise: Promise<ServstationA2AOidcTokenSet> } | undefined;
  private generation = 0;

  constructor(
    private readonly authorize: LeasingOidcAuthorizer,
    private readonly now: () => number = Date.now,
  ) {}

  async accessToken(input: LeasingOidcLoginInput, forceSignIn = false): Promise<string> {
    const resolved = resolveLoginInput(input);
    const key = contextKey(resolved);
    if (!forceSignIn && this.cached?.key === key && tokenIsUsable(this.cached.tokens, resolved, this.now())) {
      return this.cached.tokens.accessToken;
    }
    if (forceSignIn) {
      this.invalidate();
    }
    if (this.pendingLogin?.key !== key) {
      this.invalidate();
      const generation = this.generation;
      const promise = this.authorize(resolved)
        .then((tokens) => {
          validateLeasingToken(tokens, resolved);
          if (this.generation === generation) {
            this.cached = { key, tokens };
          }
          return tokens;
        })
        .finally(() => {
          if (this.pendingLogin?.promise === promise) {
            this.pendingLogin = undefined;
          }
        });
      this.pendingLogin = { key, generation, promise };
    }
    const tokens = await this.pendingLogin.promise;
    validateLeasingToken(tokens, resolved);
    return tokens.accessToken;
  }

  clear(): void {
    this.invalidate();
  }

  private invalidate(): void {
    this.generation += 1;
    this.cached = undefined;
    this.pendingLogin = undefined;
  }
}

function resolveLoginInput(input: LeasingOidcLoginInput): ResolvedLeasingOidcLoginInput {
  return {
    baseUrl: input.baseUrl,
    issuerUrl: normalizeUrl(input.issuerUrl),
    clientId: input.clientId?.trim() || defaultLeasingOidcClientId,
    scope: mergeLeasingScopes(input.scope || defaultServstationScope),
    redirectUri: input.redirectUri?.trim() || defaultLeasingOidcRedirectUri,
    loginHint: input.loginHint,
    expectedIdentity: input.expectedIdentity,
  };
}

function tokenIsUsable(tokens: ServstationA2AOidcTokenSet, input: ResolvedLeasingOidcLoginInput, now: number): boolean {
  if (!tokenMatchesLeasingContext(tokens, input)) {
    return false;
  }
  const expiresAt = tokenExpiry(tokens);
  return expiresAt !== undefined && expiresAt > now + 60_000;
}

function validateLeasingToken(tokens: ServstationA2AOidcTokenSet, input: ResolvedLeasingOidcLoginInput): void {
  if (normalizeUrl(tokens.issuerUrl) !== normalizeUrl(input.issuerUrl || "")) {
    throw new Error("Leasing OIDC token issuer does not match the configured issuer.");
  }
  if (tokens.clientId !== input.clientId) {
    throw new Error("Leasing OIDC token client does not match the dedicated leasing client.");
  }
  if (!hasAudience(tokens.accessToken, leasingOidcAudience)) {
    throw new Error(`Leasing OIDC token audience must include ${leasingOidcAudience}.`);
  }
  if (!hasScope(tokens.scope || input.scope, "leasing.read")) {
    throw new Error("Leasing OIDC token is missing leasing.read scope.");
  }
  if (!tokenMatchesIdentity(tokens.accessToken, input.expectedIdentity)) {
    throw new Error("Leasing OIDC token identity does not match the current HBClient account.");
  }
}

function tokenMatchesLeasingContext(tokens: ServstationA2AOidcTokenSet, input: ResolvedLeasingOidcLoginInput): boolean {
  return (
    normalizeUrl(tokens.issuerUrl) === normalizeUrl(input.issuerUrl || "") &&
    tokens.clientId === input.clientId &&
    hasAudience(tokens.accessToken, leasingOidcAudience) &&
    hasScope(tokens.scope || input.scope, "leasing.read") &&
    tokenMatchesIdentity(tokens.accessToken, input.expectedIdentity)
  );
}

function contextKey(input: ResolvedLeasingOidcLoginInput): string {
  return JSON.stringify({
    baseUrl: normalizeUrl(input.baseUrl || ""),
    issuerUrl: normalizeUrl(input.issuerUrl || ""),
    clientId: input.clientId,
    scope: input.scope,
    redirectUri: input.redirectUri,
    identity: input.expectedIdentity,
  });
}

function hasAudience(accessToken: string, expected: string): boolean {
  const audience = jwtPayload(accessToken)?.aud;
  if (typeof audience === "string") {
    return audience === expected;
  }
  return Array.isArray(audience) && audience.some((item) => item === expected);
}

function hasScope(scope: string | undefined, expected: string): boolean {
  return Boolean(scope?.split(/\s+/).includes(expected));
}

function tokenMatchesIdentity(accessToken: string, expected: LeasingIdentityBinding): boolean {
  const claims = jwtPayload(accessToken);
  return Boolean(
    claims &&
    claimString(claims.tenantId, claims.tenant_id) === expected.tenantId &&
    claimString(claims.organizationId, claims.organization_id) === expected.organizationId &&
    claimString(claims.departmentId, claims.department_id) === expected.departmentId &&
    claimString(claims.userId, claims.user_id, claims.preferred_username, claims.sub) === expected.userId,
  );
}

function claimString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim();
}

function tokenExpiry(tokens: ServstationA2AOidcTokenSet): number | undefined {
  if (tokens.expiresAt) {
    const value = new Date(tokens.expiresAt).getTime();
    if (Number.isFinite(value)) {
      return value;
    }
  }
  const exp = jwtPayload(tokens.accessToken)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
}

function jwtPayload(accessToken: string): Record<string, unknown> | undefined {
  const parts = accessToken.split(".");
  if (parts.length < 2) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}
