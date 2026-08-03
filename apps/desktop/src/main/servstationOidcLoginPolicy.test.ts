import { describe, expect, it, vi } from "vitest";
import type { IdentityContext } from "@supbot/shared";
import {
  buildServstationOidcAuthorizationUrl,
  explicitOidcAutoLogin,
  isBotstationLoginUrl,
  isOidcRedirectUrl,
  localBotstationAutoLogin,
  resolveOidcAutoSubmitOutcome,
  resolveServstationOidcAutoLogin,
  servstationOidcIdentitySeed,
  servstationOidcLoginWindowPartition,
  validateServstationA2AAccountSwitchInput,
} from "./servstationOidcLoginPolicy";

const loopbackIssuer = "http://127.0.0.1:8092";
const remoteIssuer = "http://sso.example.test";
const devOptions = { isDev: true, defaultUser: "dev-user", defaultPassword: "dev-user" };
const prodOptions = { ...devOptions, isDev: false };

describe("servstation OIDC authorization URL", () => {
  const input = {
    clientId: "hbclient",
    redirectUri: "http://127.0.0.1:5186/oauth2/callback",
    scope: "openid profile",
    state: "state-1",
    challenge: "challenge-1",
  };

  it("adds max_age=0 only for forced switching flows", () => {
    const switching = buildServstationOidcAuthorizationUrl(`${remoteIssuer}/oauth2/authorize`, {
      ...input,
      forceReauthentication: true,
    });
    expect(switching.searchParams.get("max_age")).toBe("0");

    const ordinary = buildServstationOidcAuthorizationUrl(`${remoteIssuer}/oauth2/authorize`, input);
    expect(ordinary.searchParams.has("max_age")).toBe(false);
  });

  it("carries the PKCE parameters and a trimmed login hint", () => {
    const url = buildServstationOidcAuthorizationUrl(`${remoteIssuer}/oauth2/authorize`, {
      ...input,
      loginHint: "  staff-1  ",
    });

    expect(url.searchParams.get("client_id")).toBe("hbclient");
    expect(url.searchParams.get("redirect_uri")).toBe(input.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("login_hint")).toBe("staff-1");

    const blank = buildServstationOidcAuthorizationUrl(`${remoteIssuer}/oauth2/authorize`, {
      ...input,
      loginHint: "   ",
    });
    expect(blank.searchParams.has("login_hint")).toBe(false);
  });
});

describe("explicit OIDC auto login", () => {
  it("preserves the untrimmed password bytes while trimming the user id", () => {
    const autoLogin = explicitOidcAutoLogin(loopbackIssuer, "  staff-1 ", "  s3cr3t  ");

    expect(autoLogin).toEqual({
      userId: "staff-1",
      password: "  s3cr3t  ",
      issuerOrigin: loopbackIssuer,
    });
  });

  it("rejects blank passwords and missing user ids", () => {
    expect(explicitOidcAutoLogin(loopbackIssuer, "staff-1", "   ")).toBeUndefined();
    expect(explicitOidcAutoLogin(loopbackIssuer, undefined, "s3cr3t")).toBeUndefined();
    expect(explicitOidcAutoLogin(loopbackIssuer, "  ", "s3cr3t")).toBeUndefined();
  });

  it("may autofill a remote issuer because it only runs for explicit switches", () => {
    expect(explicitOidcAutoLogin(remoteIssuer, "staff-1", "s3cr3t")).toEqual({
      userId: "staff-1",
      password: "s3cr3t",
      issuerOrigin: remoteIssuer,
    });
  });
});

describe("local botstation auto login", () => {
  it("injects the saved password for loopback issuers", () => {
    expect(localBotstationAutoLogin(loopbackIssuer, "staff-1", "saved-secret", prodOptions)).toEqual({
      userId: "staff-1",
      password: "saved-secret",
      issuerOrigin: loopbackIssuer,
    });
  });

  it("never injects a password for remote issuers, even with a saved password", () => {
    expect(localBotstationAutoLogin(remoteIssuer, "staff-1", "saved-secret", prodOptions)).toBeUndefined();
  });

  it("falls back to the dev default password only in dev for the default user", () => {
    expect(localBotstationAutoLogin(loopbackIssuer, "dev-user", undefined, devOptions)?.password).toBe("dev-user");
    expect(localBotstationAutoLogin(loopbackIssuer, "dev-user", undefined, prodOptions)).toBeUndefined();
    expect(localBotstationAutoLogin(loopbackIssuer, "staff-1", undefined, devOptions)).toBeUndefined();
  });
});

describe("resolveServstationOidcAutoLogin", () => {
  it("lets explicit switch credentials override saved credentials without reading the saved password", async () => {
    const loadSavedPassword = vi.fn(async () => "saved-secret");

    const autoLogin = await resolveServstationOidcAutoLogin(
      loopbackIssuer,
      { loginHint: "staff-2", password: "  switch-secret  ", forceReauthentication: true },
      loadSavedPassword,
      prodOptions,
    );

    expect(loadSavedPassword).not.toHaveBeenCalled();
    expect(autoLogin).toEqual({
      userId: "staff-2",
      password: "  switch-secret  ",
      issuerOrigin: loopbackIssuer,
    });
  });

  it("reads the saved password only for an ordinary local login", async () => {
    const loadSavedPassword = vi.fn(async () => "saved-secret");

    const autoLogin = await resolveServstationOidcAutoLogin(
      loopbackIssuer,
      { loginHint: "staff-1" },
      loadSavedPassword,
      prodOptions,
    );

    expect(loadSavedPassword).toHaveBeenCalledTimes(1);
    expect(autoLogin?.password).toBe("saved-secret");
  });

  it("never reads the saved password for an ordinary remote login", async () => {
    const loadSavedPassword = vi.fn(async () => "saved-secret");

    const autoLogin = await resolveServstationOidcAutoLogin(
      remoteIssuer,
      { loginHint: "staff-1" },
      loadSavedPassword,
      prodOptions,
    );

    expect(loadSavedPassword).not.toHaveBeenCalled();
    expect(autoLogin).toBeUndefined();
  });

  it("rejects explicit credentials without forced reauthentication", async () => {
    const loadSavedPassword = vi.fn(async () => "saved-secret");

    await expect(
      resolveServstationOidcAutoLogin(
        loopbackIssuer,
        { loginHint: "staff-1", password: "s3cr3t" },
        loadSavedPassword,
        prodOptions,
      ),
    ).rejects.toThrow("forced reauthentication");
    expect(loadSavedPassword).not.toHaveBeenCalled();
  });
});

describe("servstationOidcLoginWindowPartition", () => {
  it("keeps ordinary logins on the default browser session", () => {
    expect(servstationOidcLoginWindowPartition(undefined, "state-1")).toBeUndefined();
    expect(servstationOidcLoginWindowPartition(false, "state-1")).toBeUndefined();
  });

  it("uses an ephemeral in-memory partition per switching attempt", () => {
    const partition = servstationOidcLoginWindowPartition(true, "state-1");

    expect(partition).toBe("servstation-oidc-switch-state-1");
    // Electron persists only partitions with the "persist:" prefix; this one stays in memory.
    expect(partition?.startsWith("persist:")).toBe(false);
    expect(servstationOidcLoginWindowPartition(true, "state-2")).not.toBe(partition);
  });
});

describe("servstationOidcIdentitySeed", () => {
  const currentIdentity: IdentityContext = {
    tenantId: "tenant-1",
    organizationId: "org-1",
    departmentId: "dept-1",
    userId: "staff-1",
    roleIds: ["role-1"],
    source: "servstation",
    agentInstanceId: "agent-old",
    servstationUrl: "http://gateway.old:8800",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("clears the inherited identity and agent instance when switching", () => {
    const seed = servstationOidcIdentitySeed({
      forceReauthentication: true,
      servstationUrl: "http://gateway.test:8800",
      currentIdentity,
      agentInstanceId: "agent-old",
    });

    expect(seed).toEqual({ servstationUrl: "http://gateway.test:8800" });
    expect(seed.agentInstanceId).toBeUndefined();
    expect(seed.userId).toBeUndefined();
  });

  it("inherits the configured agent instance for ordinary logins", () => {
    const seed = servstationOidcIdentitySeed({
      servstationUrl: "http://gateway.test:8800",
      currentIdentity,
      agentInstanceId: "agent-configured",
    });

    expect(seed.agentInstanceId).toBe("agent-configured");
    expect(seed.userId).toBe("staff-1");
    expect(seed.servstationUrl).toBe("http://gateway.test:8800");
  });
});

describe("isOidcRedirectUrl", () => {
  const redirectUri = "http://127.0.0.1:5186/oauth2/callback";

  it("accepts the exact redirect target, including its query string", () => {
    expect(isOidcRedirectUrl(`${redirectUri}?code=abc&state=xyz`, redirectUri)).toBe(true);
  });

  it("rejects redirect lookalikes that a prefix match would accept", () => {
    expect(isOidcRedirectUrl(`${redirectUri}.evil`, redirectUri)).toBe(false);
    expect(isOidcRedirectUrl(`${redirectUri}/extra?code=abc`, redirectUri)).toBe(false);
    expect(isOidcRedirectUrl("http://127.0.0.1:5186.evil.test/oauth2/callback?code=abc", redirectUri)).toBe(false);
    expect(isOidcRedirectUrl("http://127.0.0.1:5186@evil.test/oauth2/callback?code=abc", redirectUri)).toBe(false);
    expect(isOidcRedirectUrl("https://127.0.0.1:5186/oauth2/callback?code=abc", redirectUri)).toBe(false);
    expect(isOidcRedirectUrl("not a url", redirectUri)).toBe(false);
  });
});

describe("isBotstationLoginUrl", () => {
  it("matches only the issuer login form", () => {
    expect(isBotstationLoginUrl(`${loopbackIssuer}/oauth2/login`, loopbackIssuer)).toBe(true);
    expect(isBotstationLoginUrl(`${loopbackIssuer}/oauth2/login/extra`, loopbackIssuer)).toBe(false);
    expect(isBotstationLoginUrl(`${remoteIssuer}/oauth2/login`, loopbackIssuer)).toBe(false);
  });
});

describe("resolveOidcAutoSubmitOutcome", () => {
  it("submits the autofill on the first arrival at the login page", () => {
    expect(resolveOidcAutoSubmitOutcome(false, `${remoteIssuer}/oauth2/login`, remoteIssuer)).toBe("submit");
  });

  it("treats a return to the login page after submitting as an SSO rejection", () => {
    // A successful submit navigates away from the login page, so landing here again
    // means the credentials were refused and the flow must fail instead of hanging.
    expect(resolveOidcAutoSubmitOutcome(true, `${remoteIssuer}/oauth2/login`, remoteIssuer)).toBe("rejected");
  });

  it("ignores unrelated pages in both states", () => {
    for (const autoSubmitted of [false, true]) {
      expect(resolveOidcAutoSubmitOutcome(autoSubmitted, `${remoteIssuer}/oauth2/authorize`, remoteIssuer)).toBe(
        "ignore",
      );
      expect(resolveOidcAutoSubmitOutcome(autoSubmitted, `${loopbackIssuer}/oauth2/login`, remoteIssuer)).toBe(
        "ignore",
      );
    }
  });
});

describe("validateServstationA2AAccountSwitchInput", () => {
  it("rejects non-object inputs", () => {
    for (const input of [undefined, null, "staff-1", 42, ["staff-1", "s3cr3t"]]) {
      expect(() => validateServstationA2AAccountSwitchInput(input)).toThrow("must be an object");
    }
  });

  it("rejects blank accounts and blank passwords", () => {
    expect(() =>
      validateServstationA2AAccountSwitchInput({ staffAgentAccount: "   ", staffAgentPassword: "s3cr3t" }),
    ).toThrow("staff-agent account");
    expect(() =>
      validateServstationA2AAccountSwitchInput({ staffAgentAccount: "staff-1", staffAgentPassword: "   " }),
    ).toThrow("staff-agent password");
    expect(() => validateServstationA2AAccountSwitchInput({ staffAgentAccount: "staff-1" })).toThrow(
      "staff-agent password",
    );
  });

  it("trims the account but preserves the untrimmed password bytes", () => {
    expect(
      validateServstationA2AAccountSwitchInput({ staffAgentAccount: "  staff-1  ", staffAgentPassword: "  s3cr3t  " }),
    ).toEqual({ staffAgentAccount: "staff-1", staffAgentPassword: "  s3cr3t  " });
  });

  it("drops extra fields so the renderer cannot smuggle token, identity, or reverse state", () => {
    const validated = validateServstationA2AAccountSwitchInput({
      staffAgentAccount: "staff-1",
      staffAgentPassword: "s3cr3t",
      tokens: { accessToken: "forged" },
      identityContext: { userId: "admin" },
      reverse: { enabled: true },
      agentInstanceId: "agent-forged",
    });

    expect(Object.keys(validated).sort()).toEqual(["staffAgentAccount", "staffAgentPassword"]);
  });
});
