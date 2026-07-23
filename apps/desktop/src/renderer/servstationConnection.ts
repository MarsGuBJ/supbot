import {
  defaultServstationBaseUrl,
  defaultServstationClientId,
  defaultServstationIssuerUrl,
  defaultServstationRedirectUri,
  defaultServstationScope,
  defaultServstationUser,
  type RuntimeSnapshot,
} from "@supbot/shared";

export type ServstationConnectionApi = Pick<
  Window["supbot"],
  "connectServstationReverseBridge" | "loginServstationOidc" | "refreshServstationOidc"
>;

export function hasUsableServstationOidcSession(config: RuntimeSnapshot["servstationA2A"]["config"]): boolean {
  if (config.oidc?.refreshTokenSaved) {
    return true;
  }
  if (!config.oidc?.accessTokenExpiresAt) {
    return false;
  }
  return new Date(config.oidc.accessTokenExpiresAt).getTime() > Date.now() + 60_000;
}

export async function ensureServstationOidcSession(
  config: RuntimeSnapshot["servstationA2A"]["config"],
  identity: RuntimeSnapshot["identityContext"],
  loginHint?: string,
  api: ServstationConnectionApi = window.supbot,
): Promise<boolean> {
  if (config.authMode !== "oidc") {
    return true;
  }
  const login = async () => {
    const result = await api.loginServstationOidc({
      baseUrl: config.baseUrl || identity?.servstationUrl || defaultServstationBaseUrl,
      issuerUrl: config.oidc?.issuerUrl || defaultServstationIssuerUrl,
      clientId: config.oidc?.clientId || defaultServstationClientId,
      scope: config.oidc?.scope || defaultServstationScope,
      redirectUri: config.oidc?.redirectUri || defaultServstationRedirectUri,
      loginHint: loginHint || defaultServstationUser,
    });
    return result.status === "authenticated";
  };
  if (!hasUsableServstationOidcSession(config)) {
    return login();
  }
  try {
    await api.refreshServstationOidc();
    return true;
  } catch {
    return login();
  }
}

export async function connectServstationAgent(
  config: RuntimeSnapshot["servstationA2A"]["config"],
  identity: RuntimeSnapshot["identityContext"],
  loginHint?: string,
  api: ServstationConnectionApi = window.supbot,
): Promise<boolean> {
  if (!(await ensureServstationOidcSession(config, identity, loginHint, api))) {
    return false;
  }
  await api.connectServstationReverseBridge();
  return true;
}
