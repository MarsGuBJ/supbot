import { useState } from "react";
import { CloseOutlined, EyeInvisibleOutlined, EyeOutlined, LoginOutlined } from "@ant-design/icons";
import { message } from "antd";
import {
  defaultServstationBaseUrl,
  defaultServstationClientId,
  defaultServstationIssuerUrl,
  defaultServstationRedirectUri,
  defaultServstationScope,
  type RuntimeSnapshot,
} from "@supbot/shared";

const loginUsernameKey = "hbclient.login.username";
const loginRememberKey = "hbclient.login.remember";

export function EnterpriseLoginOverlay({
  snapshot,
  refreshRuntime,
  onBack,
  t,
}: {
  snapshot: RuntimeSnapshot;
  refreshRuntime: () => Promise<void> | void;
  onBack: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [username, setUsername] = useState(() => {
    try {
      return window.localStorage.getItem(loginUsernameKey) || "";
    } catch {
      return "";
    }
  });
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(() => {
    try {
      return window.localStorage.getItem(loginRememberKey) === "1";
    } catch {
      return false;
    }
  });
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (busy) {
      return;
    }
    if (!username.trim()) {
      setError(t("Please enter your username."));
      return;
    }
    setBusy(true);
    setError("");
    try {
      try {
        if (remember) {
          window.localStorage.setItem(loginUsernameKey, username.trim());
        } else {
          window.localStorage.removeItem(loginUsernameKey);
        }
        window.localStorage.setItem(loginRememberKey, remember ? "1" : "0");
      } catch {
        // In-memory state still works.
      }
      const config = snapshot.servstationA2A.config;
      const identity = snapshot.identityContext;
      const result = await window.supbot.loginServstationOidc({
        baseUrl: config.baseUrl || identity?.servstationUrl || defaultServstationBaseUrl,
        issuerUrl: config.oidc?.issuerUrl || defaultServstationIssuerUrl,
        clientId: config.oidc?.clientId || defaultServstationClientId,
        scope: config.oidc?.scope || defaultServstationScope,
        redirectUri: config.oidc?.redirectUri || defaultServstationRedirectUri,
        loginHint: username.trim(),
        password: password || undefined,
      });
      if (result.status === "canceled") {
        return;
      }
      await window.supbot.connectServstationReverseBridge();
      await refreshRuntime();
    } catch (submitError) {
      setError((submitError as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-overlay" role="dialog" aria-label={t("Enterprise workspace sign in")}>
      <button className="login-close-btn" type="button" onClick={onBack} aria-label={t("Back to personal space")}>
        <CloseOutlined />
      </button>
      <div className="login-card">
        <div className="login-logo">
          <svg viewBox="0 0 160 36" width="140" height="32">
            <defs>
              <linearGradient id="loginLogoGrad" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#3b82f6" />
                <stop offset="100%" stopColor="#8b5cf6" />
              </linearGradient>
            </defs>
            <circle cx="18" cy="18" r="16" fill="url(#loginLogoGrad)" opacity="0.12" />
            <text
              x="42"
              y="26"
              fontFamily="-apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif"
              fontSize="24"
              fontWeight="700"
            >
              <tspan fill="#3b82f6">Hy</tspan>
              <tspan fill="#f59e0b">Bot</tspan>
            </text>
          </svg>
        </div>
        <div className="login-title">{t("Welcome back")}</div>
        <div className="login-subtitle">{t("Log in to your HyBot account to continue smart workflows")}</div>

        <div className="login-field">
          <label className="login-field-label" htmlFor="enterpriseLoginUsername">
            {t("Username")}
          </label>
          <div className="login-input-wrap">
            <input
              id="enterpriseLoginUsername"
              type="text"
              placeholder={t("Enter username")}
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void submit();
                }
              }}
            />
          </div>
        </div>

        <div className="login-field">
          <label className="login-field-label" htmlFor="enterpriseLoginPassword">
            {t("Password")}
          </label>
          <div className="login-input-wrap">
            <input
              id="enterpriseLoginPassword"
              type={showPassword ? "text" : "password"}
              placeholder={t("Enter password")}
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void submit();
                }
              }}
            />
            <button
              type="button"
              className="login-input-icon"
              onClick={() => setShowPassword((value) => !value)}
              aria-label={t(showPassword ? "Hide password" : "Show password")}
            >
              {showPassword ? <EyeInvisibleOutlined /> : <EyeOutlined />}
            </button>
          </div>
        </div>

        <div className="login-options">
          <label className="login-remember">
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
            <span>{t("Remember me")}</span>
          </label>
          <button
            type="button"
            className="login-forgot"
            onClick={() => message.info(t("Password reset is not available yet."))}
          >
            {t("Forgot password?")}
          </button>
        </div>

        <button className="login-btn" type="button" disabled={busy} onClick={() => void submit()}>
          <LoginOutlined />
          {busy ? t("Signing in…") : t("Log in")}
        </button>

        <div className="login-error" aria-live="polite">
          {error}
        </div>
        <div className="login-footer">{t("HyBot © 2026 · Intelligent work platform")}</div>
      </div>
    </div>
  );
}
