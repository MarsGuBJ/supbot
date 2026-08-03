import type { ServstationA2AAccountSwitchInput, ServstationA2AConfig } from "@supbot/shared";
import type { Translator } from "./lib/types";

export type ServstationAccountSwitchApi = Pick<Window["supbot"], "switchServstationA2AAccount">;

export type ServstationAccountSwitchValues = {
  staffAgentAccount?: string;
  staffAgentPassword?: string;
};

/** Account switching re-runs the OIDC login, so other auth modes only get an informational state. */
export function canSwitchServstationA2AAccount(config: Pick<ServstationA2AConfig, "authMode">): boolean {
  return config.authMode === "oidc";
}

/** Save and switch are mutually exclusive: while one runs, the other stays disabled. */
export function isRemoteStaffAgentConfigBusy(saving: boolean, switching: boolean): boolean {
  return saving || switching;
}

/** Submit stays disabled until both fields hold non-blank text. */
export function isServstationAccountSwitchReady(values: ServstationAccountSwitchValues): boolean {
  return Boolean(values.staffAgentAccount?.trim()) && Boolean(values.staffAgentPassword);
}

/** Trim the account but keep the password verbatim; null means the form is not ready. */
export function buildServstationAccountSwitchInput(
  values: ServstationAccountSwitchValues,
): ServstationA2AAccountSwitchInput | null {
  if (!isServstationAccountSwitchReady(values)) {
    return null;
  }
  return {
    staffAgentAccount: (values.staffAgentAccount || "").trim(),
    staffAgentPassword: values.staffAgentPassword || "",
  };
}

/** The submit button shows the relogin/reconnect progress while the switch runs. */
export function remoteStaffAgentSwitchSubmitLabel(switching: boolean, t: Translator): string {
  return switching ? t("Switching account and reconnecting...") : t("Switch account and reconnect");
}

export type ServstationAccountSwitchHandlers = {
  resetForm: () => void;
  clearPassword: () => void;
  notifySuccess: (text: string) => void;
  notifyError: (text: string) => void;
};

/**
 * Runs the account-switch transaction. The snapshot is refreshed before the
 * success is reported so the card already shows the new account and reverse
 * connection state; the password field is cleared on both outcomes.
 */
export async function switchServstationA2AAccount(
  input: ServstationA2AAccountSwitchInput,
  refresh: () => void | Promise<void>,
  handlers: ServstationAccountSwitchHandlers,
  t: Translator,
  api: ServstationAccountSwitchApi = window.supbot,
): Promise<boolean> {
  try {
    await api.switchServstationA2AAccount(input);
    await refresh();
    handlers.resetForm();
    handlers.notifySuccess(t("Staff-agent account switched successfully."));
    return true;
  } catch (error) {
    handlers.clearPassword();
    handlers.notifyError(t("Failed to switch staff-agent account: {message}", { message: (error as Error).message }));
    return false;
  }
}
