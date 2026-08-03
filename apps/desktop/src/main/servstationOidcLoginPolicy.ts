import type { IdentityContext, ServstationA2AAccountSwitchInput } from "@supbot/shared";

export interface OidcAutoLogin {
  userId: string;
  password: string;
  issuerOrigin: string;
}

export interface ServstationOidcAutoLoginInput {
  loginHint?: string;
  password?: string;
  forceReauthentication?: boolean;
}

export interface ServstationOidcAutoLoginOptions {
  isDev: boolean;
  defaultUser: string;
  defaultPassword: string;
}

export interface ServstationOidcAuthorizationUrlInput {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  challenge: string;
  loginHint?: string;
  forceReauthentication?: boolean;
}

export function buildServstationOidcAuthorizationUrl(
  endpoint: string,
  input: ServstationOidcAuthorizationUrlInput,
): URL {
  const authorizationUrl = new URL(endpoint);
  authorizationUrl.searchParams.set("client_id", input.clientId);
  authorizationUrl.searchParams.set("redirect_uri", input.redirectUri);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("scope", input.scope);
  authorizationUrl.searchParams.set("state", input.state);
  authorizationUrl.searchParams.set("code_challenge", input.challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  if (input.forceReauthentication) {
    authorizationUrl.searchParams.set("max_age", "0");
  }
  if (input.loginHint?.trim()) {
    authorizationUrl.searchParams.set("login_hint", input.loginHint.trim());
  }
  return authorizationUrl;
}

export function explicitOidcAutoLogin(
  issuerUrl: string,
  userId: string | undefined,
  password: string,
): OidcAutoLogin | undefined {
  if (!userId?.trim() || !password.trim()) {
    return undefined;
  }
  return { userId: userId.trim(), password, issuerOrigin: new URL(issuerUrl).origin };
}

/**
 * Picks the auto-login for an authorization run. Explicit switch credentials win and the saved
 * password is never read for them; the saved password is only consulted for ordinary logins
 * against a loopback issuer, so ordinary remote sign-ins never inject a password.
 */
export async function resolveServstationOidcAutoLogin(
  issuerUrl: string,
  input: ServstationOidcAutoLoginInput,
  loadSavedPassword: () => Promise<string | undefined>,
  options: ServstationOidcAutoLoginOptions,
): Promise<OidcAutoLogin | undefined> {
  if (input.password !== undefined && !input.forceReauthentication) {
    throw new Error("Explicit OIDC credentials require forced reauthentication.");
  }
  if (input.forceReauthentication && input.password !== undefined) {
    return explicitOidcAutoLogin(issuerUrl, input.loginHint, input.password);
  }
  if (!isLoopbackHost(new URL(issuerUrl).hostname)) {
    return undefined;
  }
  const savedPassword = await loadSavedPassword();
  return localBotstationAutoLogin(issuerUrl, input.loginHint, savedPassword, options);
}

/**
 * Switching flows sign in through an ephemeral (non-"persist:") in-memory partition, so a failed
 * or canceled switch cannot alter the ordinary browser OIDC session.
 */
export function servstationOidcLoginWindowPartition(
  forceReauthentication: boolean | undefined,
  state: string,
): string | undefined {
  return forceReauthentication ? `servstation-oidc-switch-${state}` : undefined;
}

/**
 * Seeds the identity context derived from fresh tokens. Switching must not inherit the previous
 * agent instance binding, so the seed carries only the Servstation base URL.
 */
export function servstationOidcIdentitySeed(input: {
  forceReauthentication?: boolean;
  servstationUrl: string;
  currentIdentity?: IdentityContext;
  agentInstanceId?: string;
}): Partial<IdentityContext> {
  if (input.forceReauthentication) {
    return { servstationUrl: input.servstationUrl };
  }
  return {
    ...(input.currentIdentity || {}),
    servstationUrl: input.servstationUrl,
    agentInstanceId: input.agentInstanceId || input.currentIdentity?.agentInstanceId,
  };
}

export function localBotstationAutoLogin(
  issuerUrl: string,
  userId: string | undefined,
  password: string | undefined,
  options: ServstationOidcAutoLoginOptions,
): OidcAutoLogin | undefined {
  if (!userId?.trim()) {
    return undefined;
  }
  const issuer = new URL(issuerUrl);
  if (!isLoopbackHost(issuer.hostname)) {
    return undefined;
  }
  const resolvedPassword =
    password?.trim() || (options.isDev && userId.trim() === options.defaultUser ? options.defaultPassword : "");
  if (!resolvedPassword) {
    return undefined;
  }
  return {
    userId: userId.trim(),
    password: resolvedPassword,
    issuerOrigin: issuer.origin,
  };
}

export function isBotstationLoginUrl(rawUrl: string, issuerOrigin: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.origin === issuerOrigin && url.pathname === "/oauth2/login";
  } catch {
    return false;
  }
}

export type OidcAutoSubmitOutcome = "submit" | "rejected" | "ignore";

/**
 * Decides what an auto-login login-window load means. The first arrival at the SSO login page
 * triggers the one-shot autofill; a successful submit navigates away from the login page, so
 * landing on the login page again afterwards means the SSO rejected the credentials and the
 * flow must fail instead of hanging on an unattended window.
 */
export function resolveOidcAutoSubmitOutcome(
  autoSubmitted: boolean,
  currentUrl: string,
  issuerOrigin: string,
): OidcAutoSubmitOutcome {
  if (!isBotstationLoginUrl(currentUrl, issuerOrigin)) {
    return "ignore";
  }
  return autoSubmitted ? "rejected" : "submit";
}

export function isOidcRedirectUrl(rawUrl: string, redirectUri: string): boolean {
  try {
    const actual = new URL(rawUrl);
    const expected = new URL(redirectUri);
    return actual.origin === expected.origin && actual.pathname === expected.pathname;
  } catch {
    return false;
  }
}

export function validateServstationA2AAccountSwitchInput(input: unknown): ServstationA2AAccountSwitchInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("servstation account switch must be an object.");
  }
  const value = input as Record<string, unknown>;
  return {
    staffAgentAccount: requiredTrimmedString(value.staffAgentAccount, "servstation staff-agent account"),
    staffAgentPassword: requiredSecretString(value.staffAgentPassword, "servstation staff-agent password"),
  };
}

function requiredTrimmedString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function requiredSecretString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value;
}

function isLoopbackHost(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1" || value === "[::1]";
}
