import { describe, expect, it, vi } from "vitest";
import type { RuntimeSnapshot } from "@supbot/shared";
import { connectServstationAgent, type ServstationConnectionApi } from "./servstationConnection";

const config = {
  enabled: true,
  baseUrl: "http://servstation.test",
  authMode: "oidc",
  bearerTokenSaved: false,
  staffAgentAccount: "staff-user",
  staffAgentPasswordSaved: false,
  oidc: {
    issuerUrl: "http://issuer.test",
    clientId: "hbclient",
    scope: "openid",
    redirectUri: "http://127.0.0.1:8765/callback",
    refreshTokenSaved: false,
  },
  reverse: {
    enabled: false,
    status: "disconnected",
  },
} satisfies RuntimeSnapshot["servstationA2A"]["config"];

describe("Server Agent connection", () => {
  it("stops quietly when the OIDC login window is canceled", async () => {
    const connectServstationReverseBridge = vi.fn(async () => config);
    const api = {
      loginServstationOidc: vi.fn(async () => ({ status: "canceled" as const })),
      refreshServstationOidc: vi.fn(async () => config),
      connectServstationReverseBridge,
    } satisfies ServstationConnectionApi;

    await expect(connectServstationAgent(config, undefined, config.staffAgentAccount, api)).resolves.toBe(false);
    expect(connectServstationReverseBridge).not.toHaveBeenCalled();
  });

  it("connects after a completed OIDC login", async () => {
    const connectServstationReverseBridge = vi.fn(async () => config);
    const api = {
      loginServstationOidc: vi.fn(async () => ({ status: "authenticated" as const, config })),
      refreshServstationOidc: vi.fn(async () => config),
      connectServstationReverseBridge,
    } satisfies ServstationConnectionApi;

    await expect(connectServstationAgent(config, undefined, config.staffAgentAccount, api)).resolves.toBe(true);
    expect(connectServstationReverseBridge).toHaveBeenCalledOnce();
  });

  it("preserves real OIDC login failures", async () => {
    const connectServstationReverseBridge = vi.fn(async () => config);
    const api = {
      loginServstationOidc: vi.fn(async () => {
        throw new Error("OIDC discovery failed");
      }),
      refreshServstationOidc: vi.fn(async () => config),
      connectServstationReverseBridge,
    } satisfies ServstationConnectionApi;

    await expect(connectServstationAgent(config, undefined, config.staffAgentAccount, api)).rejects.toThrow(
      "OIDC discovery failed",
    );
    expect(connectServstationReverseBridge).not.toHaveBeenCalled();
  });
});
