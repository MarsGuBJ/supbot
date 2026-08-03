import { describe, expect, it, vi } from "vitest";
import type { RuntimeSnapshot } from "@supbot/shared";
import { translate } from "./i18n";
import {
  buildServstationAccountSwitchInput,
  canSwitchServstationA2AAccount,
  isRemoteStaffAgentConfigBusy,
  isServstationAccountSwitchReady,
  remoteStaffAgentSwitchSubmitLabel,
  switchServstationA2AAccount,
  type ServstationAccountSwitchApi,
} from "./servstationAccountSwitch";

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

const switchCopyKeys = [
  "Switch staff-agent account",
  "Re-authenticate with another account and reconnect the server staff-agent.",
  "New staff-agent account",
  "New staff-agent password",
  "Switch account and reconnect",
  "Switching account and reconnecting...",
  "Staff-agent account switched successfully.",
  "Failed to switch staff-agent account: {message}",
  "Staff-agent account is required.",
  "Staff-agent password is required.",
  "Account switching requires OIDC authentication.",
];

describe("Server Agent account switching", () => {
  it("only offers the switch form for OIDC auth mode", () => {
    expect(canSwitchServstationA2AAccount(config)).toBe(true);
    expect(canSwitchServstationA2AAccount({ ...config, authMode: "identityHeaders" })).toBe(false);
    expect(canSwitchServstationA2AAccount({ ...config, authMode: "bearer" })).toBe(false);
  });

  it("keeps submit disabled until both fields are non-blank", () => {
    expect(isServstationAccountSwitchReady({})).toBe(false);
    expect(isServstationAccountSwitchReady({ staffAgentAccount: "", staffAgentPassword: "" })).toBe(false);
    expect(isServstationAccountSwitchReady({ staffAgentAccount: "   ", staffAgentPassword: "secret" })).toBe(false);
    expect(isServstationAccountSwitchReady({ staffAgentAccount: "staff-user", staffAgentPassword: "" })).toBe(false);
    expect(isServstationAccountSwitchReady({ staffAgentAccount: "staff-user", staffAgentPassword: "secret" })).toBe(
      true,
    );
  });

  it("trims the account but keeps the password verbatim", () => {
    expect(buildServstationAccountSwitchInput({ staffAgentAccount: "  ", staffAgentPassword: "secret" })).toBeNull();
    expect(
      buildServstationAccountSwitchInput({ staffAgentAccount: "  staff-user ", staffAgentPassword: " se cret " }),
    ).toEqual({ staffAgentAccount: "staff-user", staffAgentPassword: " se cret " });
  });

  it("disables save and switch while either flow is running", () => {
    expect(isRemoteStaffAgentConfigBusy(false, false)).toBe(false);
    expect(isRemoteStaffAgentConfigBusy(true, false)).toBe(true);
    expect(isRemoteStaffAgentConfigBusy(false, true)).toBe(true);
    expect(isRemoteStaffAgentConfigBusy(true, true)).toBe(true);
  });

  it("shows the localized relogin/reconnect label while switching", () => {
    const t = (key: string) => key;
    expect(remoteStaffAgentSwitchSubmitLabel(false, t)).toBe("Switch account and reconnect");
    expect(remoteStaffAgentSwitchSubmitLabel(true, t)).toBe("Switching account and reconnecting...");
    expect(remoteStaffAgentSwitchSubmitLabel(true, (key) => translate("zh", key))).toBe("正在切换账号并重新连接...");
  });

  it("refreshes before reporting success and clears the form", async () => {
    const events: string[] = [];
    const api = {
      switchServstationA2AAccount: vi.fn(async (input: { staffAgentAccount: string; staffAgentPassword: string }) => {
        events.push(`switch:${input.staffAgentAccount}`);
        return config;
      }),
    } satisfies ServstationAccountSwitchApi;
    const result = await switchServstationA2AAccount(
      { staffAgentAccount: "new-user", staffAgentPassword: "secret" },
      async () => {
        events.push("refresh");
      },
      {
        resetForm: () => events.push("resetForm"),
        clearPassword: () => events.push("clearPassword"),
        notifySuccess: () => events.push("success"),
        notifyError: () => events.push("error"),
      },
      (key) => key,
      api,
    );

    expect(result).toBe(true);
    expect(api.switchServstationA2AAccount).toHaveBeenCalledWith({
      staffAgentAccount: "new-user",
      staffAgentPassword: "secret",
    });
    expect(events).toEqual(["switch:new-user", "refresh", "resetForm", "success"]);
  });

  it("reports the localized failure without a false success and still clears the password", async () => {
    const events: string[] = [];
    const api = {
      switchServstationA2AAccount: vi.fn(async () => {
        events.push("switch");
        throw new Error("Servstation reverse A2A connection was not confirmed.");
      }),
    } satisfies ServstationAccountSwitchApi;
    const errors: string[] = [];
    const result = await switchServstationA2AAccount(
      { staffAgentAccount: "new-user", staffAgentPassword: "secret" },
      async () => {
        events.push("refresh");
      },
      {
        resetForm: () => events.push("resetForm"),
        clearPassword: () => events.push("clearPassword"),
        notifySuccess: () => events.push("success"),
        notifyError: (text) => {
          events.push("error");
          errors.push(text);
        },
      },
      (key, vars) => translate("zh", key, vars),
      api,
    );

    expect(result).toBe(false);
    expect(events).toEqual(["switch", "clearPassword", "error"]);
    expect(errors).toEqual(["切换 staff-agent 账号失败：Servstation reverse A2A connection was not confirmed."]);
  });

  it("has Chinese and English copy for every account-switch message", () => {
    for (const key of switchCopyKeys) {
      expect(translate("en", key)).toBe(key);
      expect(translate("zh", key)).not.toBe(key);
    }
    expect(translate("en", "Failed to switch staff-agent account: {message}", { message: "boom" })).toBe(
      "Failed to switch staff-agent account: boom",
    );
    expect(translate("zh", "Failed to switch staff-agent account: {message}", { message: "boom" })).toBe(
      "切换 staff-agent 账号失败：boom",
    );
  });
});
