import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell, type WebContents } from "electron";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import {
  JsonFileStorage,
  SupbotRuntime,
  ensureRuntimeDirs,
  identityContextFromAccessToken,
  oidcTokenSetFromTokenResponse,
  type RuntimeState,
  type StorageAdapter,
} from "@supbot/runtime";
import type {
  AutopilotStartDataRunInput,
  CapabilityUpdateInput,
  CreateConversationInput,
  DataSourceSpec,
  IdentityContext,
  McpConfigTransfer,
  McpServerInput,
  McpServerUpdate,
  MemoryAddInput,
  MemoryImportInput,
  MemoryRecallFeedbackInput,
  MemoryReplayRecallInput,
  MemorySearchQuery,
  MemoryUpdateInput,
  ModelConfigUpdate,
  ModelProviderUpdate,
  PermissionMode,
  PermissionRule,
  PersonalityConfig,
  ProjectCreateFromNameInput,
  ProjectCreateInput,
  ProjectUpdateInput,
  RemoteBridgeConfig,
  ScheduledJobInput,
  SendPromptInput,
  ServstationA2AConfigUpdate,
  ServstationA2AOidcLoginInput,
  ServstationA2AOidcLoginResult,
  ServstationAutopilotStartInput,
  ServstationAutopilotStatusUpdate,
  ServstationClientSnapshotQuery,
  ServstationFlowEngineApprovalDecisionInput,
  ServstationFlowEngineLaunchInput,
  ServstationMailAccountDraft,
  ServstationMessageAttachmentUpload,
  ServstationMessageFolder,
  ServstationMessageAccountRef,
  ServstationScheduledJobInput,
  ServstationSendAgentMessageInput,
  ServstationSendDirectMessageInput,
  ServstationSendPromptInput,
  SubagentConfig,
  ToolMarketConfigUpdate,
  ToolMarketQuery,
} from "@supbot/shared";
import {
  defaultServstationBaseUrl,
  defaultServstationClientId,
  defaultServstationIssuerUrl,
  defaultServstationRedirectUri,
  defaultServstationScope,
  defaultServstationUser,
} from "@supbot/shared";
import { HBClientUpdateManager } from "./updateManager";

let mainWindow: BrowserWindow | null = null;
let runtime: SupbotRuntime | null = null;
let updateManager: HBClientUpdateManager | null = null;
const servstationMessageEventSubscriptions = new Map<string, AbortController>();
const servstationAutopilotEventSubscriptions = new Map<string, AbortController>();
const isDev = !app.isPackaged;
const appDisplayName = "HBClient";
// Dev-only fallback password for the local Botstation login form autofill.
const defaultBotstationPassword = "dev-user";
const allowedDevServerOrigin = "http://127.0.0.1:5173";
const productionCsp =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*; object-src 'none'; base-uri 'self'; form-action 'none'";
const appIconPath = join(__dirname, `../../build/icon.${process.platform === "linux" ? "png" : "ico"}`);
let productionCspInstalled = false;

app.setName(appDisplayName);
app.setAppUserModelId("local.hbclient.desktop");

async function createRuntime(): Promise<SupbotRuntime> {
  const userDataPath =
    process.env.HBCLIENT_USER_DATA_DIR || process.env.SUPBOT_USER_DATA_DIR || app.getPath("userData");
  const dataDir = join(userDataPath, "data");
  await ensureRuntimeDirs(dataDir);
  await seedBundledDefaultData(dataDir);
  const storage = new EncryptedStorage(new JsonFileStorage(dataDir), userDataPath);
  const service = new SupbotRuntime(storage, {
    secretStorageKind: storage.secretStorageKind(),
    marketSecretStorageKind: storage.secretStorageKind(),
  });
  await service.init();
  service.startScheduler();
  service.onEvent((event) => {
    mainWindow?.webContents.send("supbot:event", event);
  });
  return service;
}

async function seedBundledDefaultData(dataDir: string): Promise<void> {
  const bundledDataDir = await resolveBundledDefaultDataDir();
  if (!bundledDataDir) {
    return;
  }
  const markerPath = join(dataDir, "default-data-seed.json");
  if (await pathExists(markerPath)) {
    return;
  }
  for (const folder of ["skills", "tool-market"]) {
    const source = join(bundledDataDir, folder);
    if (await pathExists(source)) {
      await copyMissingTree(source, join(dataDir, folder));
    }
  }
  const manifestRaw = await readFile(join(bundledDataDir, "manifest.json"), "utf8").catch(() => undefined);
  const marker = {
    seededAt: new Date().toISOString(),
    source: bundledDataDir,
    manifest: manifestRaw ? JSON.parse(manifestRaw) : undefined,
  };
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

async function resolveBundledDefaultDataDir(): Promise<string | undefined> {
  const candidates = [join(process.resourcesPath, "default-data"), join(app.getAppPath(), "build", "default-data")];
  for (const candidate of candidates) {
    if (await pathExists(join(candidate, "skills"))) {
      return candidate;
    }
  }
  return undefined;
}

async function copyMissingTree(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) {
      await copyMissingTree(sourcePath, targetPath);
    } else if (entry.isFile() && !(await pathExists(targetPath))) {
      await cp(sourcePath, targetPath);
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

class EncryptedStorage implements StorageAdapter {
  constructor(
    private readonly inner: JsonFileStorage,
    private readonly userDataPath: string,
  ) {}

  getDataDir(): string {
    return this.inner.getDataDir();
  }

  secretStorageKind(): "safeStorage" | "file" {
    return safeStorage.isEncryptionAvailable() ? "safeStorage" : "file";
  }

  async load(): Promise<RuntimeState> {
    const state = await this.inner.load();
    for (const provider of state.modelProviders) {
      if (provider.apiKeySecret) {
        const decoded = this.decryptSecret(provider.apiKeySecret);
        provider.apiKeySecret = decoded.value;
        provider.apiKeyStorage = decoded.kind;
        provider.apiKeySaved = true;
      } else {
        provider.apiKeyStorage = undefined;
        provider.apiKeySaved = false;
      }
    }
    if (state.toolMarketSecret) {
      const decoded = this.decryptSecret(state.toolMarketSecret);
      state.toolMarketSecret = decoded.value;
      state.toolMarketConfig.tokenStorage = decoded.kind;
      state.toolMarketConfig.accessTokenSaved = true;
    }
    if (state.toolMarketPasswordSecret) {
      const decoded = this.decryptSecret(state.toolMarketPasswordSecret);
      state.toolMarketPasswordSecret = decoded.value;
      state.toolMarketConfig.passwordStorage = decoded.kind;
      state.toolMarketConfig.passwordSaved = true;
    }
    if (state.servstationA2ASecret) {
      const decoded = this.decryptSecret(state.servstationA2ASecret);
      state.servstationA2ASecret = decoded.value;
      state.servstationA2AConfig.bearerTokenSaved = true;
    }
    if (state.servstationA2AOidcSecret) {
      const decoded = this.decryptSecret(state.servstationA2AOidcSecret);
      state.servstationA2AOidcSecret = decoded.value;
      state.servstationA2AConfig.oidc = {
        ...(state.servstationA2AConfig.oidc || { refreshTokenSaved: false }),
        refreshTokenSaved: true,
      };
    }
    if (state.servstationA2AStaffAgentPasswordSecret) {
      const decoded = this.decryptSecret(state.servstationA2AStaffAgentPasswordSecret);
      state.servstationA2AStaffAgentPasswordSecret = decoded.value;
      state.servstationA2AConfig.staffAgentPasswordSaved = true;
      state.servstationA2AConfig.staffAgentPasswordStorage = decoded.kind;
    }
    return state;
  }

  async save(state: RuntimeState): Promise<void> {
    const copy: RuntimeState = {
      ...state,
      modelProviders: state.modelProviders.map((provider) => ({ ...provider })),
      toolMarketConfig: { ...state.toolMarketConfig },
      servstationA2AConfig: {
        ...state.servstationA2AConfig,
        oidc: state.servstationA2AConfig.oidc ? { ...state.servstationA2AConfig.oidc } : undefined,
      },
    };
    for (const provider of copy.modelProviders) {
      if (provider.apiKeySecret) {
        const encoded = this.encryptSecret(provider.apiKeySecret);
        provider.apiKeySecret = encoded.value;
        provider.apiKeyStorage = encoded.kind;
        provider.apiKeySaved = true;
      } else {
        provider.apiKeyStorage = undefined;
        provider.apiKeySaved = false;
      }
    }
    if (copy.toolMarketSecret) {
      const encoded = this.encryptSecret(copy.toolMarketSecret);
      copy.toolMarketSecret = encoded.value;
      copy.toolMarketConfig.tokenStorage = encoded.kind;
      copy.toolMarketConfig.accessTokenSaved = true;
    }
    if (copy.toolMarketPasswordSecret) {
      const encoded = this.encryptSecret(copy.toolMarketPasswordSecret);
      copy.toolMarketPasswordSecret = encoded.value;
      copy.toolMarketConfig.passwordStorage = encoded.kind;
      copy.toolMarketConfig.passwordSaved = true;
    }
    if (copy.servstationA2ASecret) {
      const encoded = this.encryptSecret(copy.servstationA2ASecret);
      copy.servstationA2ASecret = encoded.value;
      copy.servstationA2AConfig.bearerTokenSaved = true;
    }
    if (copy.servstationA2AOidcSecret) {
      const encoded = this.encryptSecret(copy.servstationA2AOidcSecret);
      copy.servstationA2AOidcSecret = encoded.value;
      copy.servstationA2AConfig.oidc = {
        ...(copy.servstationA2AConfig.oidc || { refreshTokenSaved: false }),
        refreshTokenSaved: true,
      };
    }
    if (copy.servstationA2AStaffAgentPasswordSecret) {
      const encoded = this.encryptSecret(copy.servstationA2AStaffAgentPasswordSecret);
      copy.servstationA2AStaffAgentPasswordSecret = encoded.value;
      copy.servstationA2AConfig.staffAgentPasswordSaved = true;
      copy.servstationA2AConfig.staffAgentPasswordStorage = encoded.kind;
    }
    await this.inner.save(copy);
  }

  private encryptSecret(secret: string): { value: string; kind: "safeStorage" | "file" } {
    if (safeStorage.isEncryptionAvailable()) {
      return {
        value: `safe:v1:${Buffer.from(safeStorage.encryptString(secret)).toString("base64")}`,
        kind: "safeStorage",
      };
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.fileKey(), iv);
    const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      value: `file:v1:${Buffer.concat([iv, tag, encrypted]).toString("base64")}`,
      kind: "file",
    };
  }

  private decryptSecret(secret: string): { value: string; kind: "safeStorage" | "file" } {
    if (secret.startsWith("safe:v1:")) {
      return {
        value: safeStorage.decryptString(Buffer.from(secret.slice("safe:v1:".length), "base64")),
        kind: "safeStorage",
      };
    }
    if (secret.startsWith("file:v1:")) {
      const payload = Buffer.from(secret.slice("file:v1:".length), "base64");
      const iv = payload.subarray(0, 12);
      const tag = payload.subarray(12, 28);
      const encrypted = payload.subarray(28);
      const decipher = createDecipheriv("aes-256-gcm", this.fileKey(), iv);
      decipher.setAuthTag(tag);
      return {
        value: Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8"),
        kind: "file",
      };
    }
    return { value: secret, kind: "file" };
  }

  private fileKey(): Buffer {
    const username = safeUserName();
    return createHash("sha256").update(`supbot:${this.userDataPath}:${hostname()}:${username}`).digest();
  }
}

function safeUserName(): string {
  try {
    return userInfo().username;
  } catch {
    return "local-user";
  }
}

function getRuntime(): SupbotRuntime {
  if (!runtime) {
    throw new Error("HBClient runtime is not ready.");
  }
  return runtime;
}

interface OidcDiscoveryDocument {
  authorization_endpoint?: string;
  token_endpoint?: string;
}

type OidcCodeResult = { status: "authorized"; code: string } | { status: "canceled" };

interface OidcAutoLogin {
  userId: string;
  password: string;
  issuerOrigin: string;
}

async function loginServstationOidc(input: ServstationA2AOidcLoginInput): Promise<ServstationA2AOidcLoginResult> {
  const service = getRuntime();
  const currentConfig = await service.servstationA2AConfig();
  const currentIdentity = await service.identityContext();
  const baseUrl = normalizeOidcUrl(
    input.baseUrl ||
      currentConfig.baseUrl ||
      currentIdentity?.servstationUrl ||
      process.env.HBCLIENT_BOTSTATION_BASE_URL ||
      defaultServstationBaseUrl,
    "Botstation base URL",
  );
  const issuerUrl = normalizeOidcUrl(
    input.issuerUrl ||
      currentConfig.oidc?.issuerUrl ||
      process.env.HBCLIENT_BOTSTATION_ISSUER_URL ||
      defaultServstationIssuerUrl,
    "Botstation OIDC issuer URL",
  );
  const clientId = requiredString(
    input.clientId ||
      currentConfig.oidc?.clientId ||
      process.env.HBCLIENT_BOTSTATION_CLIENT_ID ||
      defaultServstationClientId,
    "Botstation OIDC client id",
  );
  const scope =
    input.scope || currentConfig.oidc?.scope || process.env.HBCLIENT_BOTSTATION_SCOPE || defaultServstationScope;
  const redirectUri = normalizeOidcUrl(
    input.redirectUri ||
      currentConfig.oidc?.redirectUri ||
      process.env.HBCLIENT_BOTSTATION_REDIRECT_URI ||
      defaultServstationRedirectUri,
    "Botstation OIDC redirect URI",
  );
  const loginHint =
    input.loginHint ||
    currentConfig.staffAgentAccount ||
    process.env.HBCLIENT_BOTSTATION_USERNAME ||
    defaultServstationUser;
  const savedPassword = await service.servstationA2AStaffAgentPassword();
  const autoLogin = localBotstationAutoLogin(
    issuerUrl,
    loginHint,
    savedPassword || process.env.HBCLIENT_BOTSTATION_PASSWORD,
  );
  const discovery = await discoverOidcDocument(issuerUrl);
  if (!discovery.authorization_endpoint || !discovery.token_endpoint) {
    throw new Error("Servstation OIDC discovery document is missing required endpoints.");
  }
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const state = base64Url(randomBytes(16));
  const authorizationUrl = new URL(discovery.authorization_endpoint);
  authorizationUrl.searchParams.set("client_id", clientId);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("scope", scope);
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  if (loginHint?.trim()) {
    authorizationUrl.searchParams.set("login_hint", loginHint.trim());
  }

  const codeResult = await openOidcLoginWindow(authorizationUrl.toString(), redirectUri, state, autoLogin);
  if (codeResult.status === "canceled") {
    return codeResult;
  }
  const tokenResponse = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code: codeResult.code,
      code_verifier: verifier,
    }),
  });
  const tokenPayload = (await tokenResponse.json().catch(() => ({}))) as Parameters<
    typeof oidcTokenSetFromTokenResponse
  >[0] & { error?: string; error_description?: string };
  if (!tokenResponse.ok) {
    const message =
      typeof tokenPayload.error_description === "string"
        ? tokenPayload.error_description
        : typeof tokenPayload.error === "string"
          ? tokenPayload.error
          : `HTTP ${tokenResponse.status}`;
    throw new Error(`Servstation OIDC token exchange failed: ${message}`);
  }
  const tokens = oidcTokenSetFromTokenResponse(tokenPayload, { issuerUrl, clientId });
  const identityContext = identityContextFromAccessToken(tokens.accessToken, {
    ...(currentIdentity || {}),
    servstationUrl: baseUrl,
    agentInstanceId: currentConfig.agentInstanceId || currentIdentity?.agentInstanceId,
  });
  const config = await service.updateServstationA2AOidcSession({
    baseUrl,
    issuerUrl,
    clientId,
    scope,
    redirectUri,
    tokens,
    identityContext,
  });
  return { status: "authenticated", config, identityContext };
}

async function discoverOidcDocument(issuerUrl: string): Promise<OidcDiscoveryDocument> {
  const response = await fetch(`${issuerUrl}/.well-known/openid-configuration`);
  const payload = (await response.json().catch(() => ({}))) as OidcDiscoveryDocument;
  if (!response.ok) {
    throw new Error(`Servstation OIDC discovery failed: HTTP ${response.status}`);
  }
  return payload;
}

function openOidcLoginWindow(
  authorizationUrl: string,
  redirectUri: string,
  expectedState: string,
  autoLogin?: OidcAutoLogin,
): Promise<OidcCodeResult> {
  return new Promise((resolve, reject) => {
    const authWindow = new BrowserWindow({
      parent: mainWindow || undefined,
      modal: Boolean(mainWindow),
      width: 540,
      height: 760,
      minWidth: 480,
      minHeight: 620,
      title: "Servstation Sign In",
      icon: appIconPath,
      backgroundColor: "#ffffff",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
    authWindow.removeMenu();
    authWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      fn();
      if (!authWindow.isDestroyed()) {
        authWindow.close();
      }
    };
    const maybeComplete = (rawUrl: string, event?: Electron.Event): void => {
      if (!rawUrl.startsWith(redirectUri)) {
        return;
      }
      event?.preventDefault();
      try {
        const url = new URL(rawUrl);
        const state = url.searchParams.get("state");
        if (state !== expectedState) {
          settle(() => reject(new Error("Servstation OIDC state validation failed.")));
          return;
        }
        const error = url.searchParams.get("error");
        if (error) {
          settle(() => reject(new Error(url.searchParams.get("error_description") || error)));
          return;
        }
        const code = url.searchParams.get("code");
        if (!code) {
          settle(() => reject(new Error("Servstation OIDC redirect did not include an authorization code.")));
          return;
        }
        settle(() => resolve({ status: "authorized", code }));
      } catch (error) {
        settle(() => reject(error));
      }
    };
    const onWillRedirect = (event: Electron.Event, url: string): void => maybeComplete(url, event);
    const onWillNavigate = (event: Electron.Event, url: string): void => maybeComplete(url, event);
    const onDidNavigate = (_event: Electron.Event, url: string): void => maybeComplete(url);
    let autoSubmitted = false;
    const onDidFinishLoad = (): void => {
      if (!autoLogin || autoSubmitted || authWindow.isDestroyed()) {
        return;
      }
      const currentUrl = authWindow.webContents.getURL();
      if (!isLocalBotstationLoginUrl(currentUrl, autoLogin.issuerOrigin)) {
        return;
      }
      autoSubmitted = true;
      const script = `
        (() => {
          const user = document.querySelector('input[name="userId"]');
          const password = document.querySelector('input[name="password"]');
          const form = document.querySelector('form');
          if (!user || !password || !form) return false;
          user.value = ${JSON.stringify(autoLogin.userId)};
          password.value = ${JSON.stringify(autoLogin.password)};
          form.submit();
          return true;
        })()
      `;
      authWindow.webContents.executeJavaScript(script, true).catch(() => undefined);
    };
    const onClosed = (): void => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve({ status: "canceled" });
      }
    };
    const cleanup = (): void => {
      authWindow.webContents.off("will-redirect", onWillRedirect);
      authWindow.webContents.off("will-navigate", onWillNavigate);
      authWindow.webContents.off("did-navigate", onDidNavigate);
      authWindow.webContents.off("did-finish-load", onDidFinishLoad);
      authWindow.off("closed", onClosed);
    };
    authWindow.webContents.on("will-redirect", onWillRedirect);
    authWindow.webContents.on("will-navigate", onWillNavigate);
    authWindow.webContents.on("did-navigate", onDidNavigate);
    authWindow.webContents.on("did-finish-load", onDidFinishLoad);
    authWindow.on("closed", onClosed);
    authWindow.loadURL(authorizationUrl).catch((error) => settle(() => reject(error)));
  });
}

function localBotstationAutoLogin(
  issuerUrl: string,
  userId: string | undefined,
  password: string | undefined,
): OidcAutoLogin | undefined {
  if (!userId?.trim()) {
    return undefined;
  }
  const issuer = new URL(issuerUrl);
  if (!isLoopbackHost(issuer.hostname)) {
    return undefined;
  }
  const resolvedPassword =
    password?.trim() || (isDev && userId.trim() === defaultServstationUser ? defaultBotstationPassword : "");
  if (!resolvedPassword) {
    return undefined;
  }
  return {
    userId: userId.trim(),
    password: resolvedPassword,
    issuerOrigin: issuer.origin,
  };
}

function isLocalBotstationLoginUrl(rawUrl: string, issuerOrigin: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.origin === issuerOrigin && url.pathname === "/oauth2/login";
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1" || value === "[::1]";
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

function normalizeOidcUrl(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`${label} must use http or https.`);
    }
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/+$/, "");
  } catch (error) {
    if (error instanceof Error && error.message.includes("http or https")) {
      throw error;
    }
    throw new Error(`${label} is invalid.`, { cause: error });
  }
}

function hardenWebContents(webContents: WebContents): void {
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  webContents.on("will-navigate", (event, url) => {
    if (!isAllowedAppUrl(url)) {
      event.preventDefault();
    }
  });
  webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}

function installProductionCsp(webContents: WebContents): void {
  if (productionCspInstalled) {
    return;
  }
  productionCspInstalled = true;
  webContents.session.webRequest.onHeadersReceived((details, callback) => {
    if (!details.url.startsWith("file://")) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [productionCsp],
      },
    });
  });
}

function isAllowedAppUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "file:") {
      return !isDev;
    }
    return isDev && url.origin === allowedDevServerOrigin;
  } catch {
    return false;
  }
}

async function createWindow(): Promise<void> {
  runtime = await createRuntime();
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1060,
    minHeight: 720,
    backgroundColor: "#0a0f16",
    title: appDisplayName,
    icon: appIconPath,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  hardenWebContents(mainWindow.webContents);
  updateManager?.stop();
  updateManager = new HBClientUpdateManager({
    getFeedContext: hbClientUpdateFeedContext,
    emitState: (state) => mainWindow?.webContents.send("hbclient:updateState", state),
  });

  const devServerUrl = process.env.HBCLIENT_DEV_SERVER_URL || process.env.SUPBOT_DEV_SERVER_URL;
  if (devServerUrl) {
    if (!isDev) {
      throw new Error("HBCLIENT_DEV_SERVER_URL is disabled in packaged production builds.");
    }
    if (!isAllowedAppUrl(devServerUrl)) {
      throw new Error(`Unsupported HBClient dev server URL: ${devServerUrl}`);
    }
    await mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    installProductionCsp(mainWindow.webContents);
    await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  void autoConnectLocalBotstation().finally(() => updateManager?.start());

  mainWindow.on("closed", () => {
    updateManager?.stop();
    mainWindow = null;
  });
}

async function hbClientUpdateFeedContext(forceRefresh: boolean): Promise<{ baseUrl: string; accessToken?: string }> {
  const service = getRuntime();
  const [config, identity] = await Promise.all([service.servstationA2AConfig(), service.identityContext()]);
  const baseUrl =
    config.baseUrl || identity?.servstationUrl || process.env.HBCLIENT_BOTSTATION_BASE_URL || defaultServstationBaseUrl;
  let accessToken: string | undefined;
  try {
    accessToken = await service.servstationA2AAccessToken(undefined, forceRefresh);
  } catch (error) {
    if (forceRefresh) {
      throw error;
    }
  }
  return { baseUrl: normalizeOidcUrl(baseUrl, "Botstation base URL"), accessToken };
}

async function autoConnectLocalBotstation(): Promise<void> {
  if (process.env.HBCLIENT_BOTSTATION_AUTO_CONNECT === "0") {
    return;
  }
  const service = getRuntime();
  const config = await service.servstationA2AConfig();
  if (
    !isLocalBotstationConfig(config) ||
    config.reverse?.status === "connected" ||
    config.reverse?.status === "connecting"
  ) {
    return;
  }
  try {
    if (!hasUsableBotstationOidcSession(config)) {
      const login = await loginServstationOidc({});
      if (login.status === "canceled") {
        return;
      }
    }
    await service.connectServstationReverseBridge();
  } catch (error) {
    console.warn(
      "HBClient local Botstation auto-connect failed:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function isLocalBotstationConfig(
  config: ServstationA2AConfigUpdate & {
    oidc?: { issuerUrl?: string; accessTokenExpiresAt?: string };
    reverse?: { status?: string };
  },
): boolean {
  const baseUrl = config.baseUrl || defaultServstationBaseUrl;
  const issuerUrl = config.oidc?.issuerUrl || defaultServstationIssuerUrl;
  try {
    return isLoopbackHost(new URL(baseUrl).hostname) && isLoopbackHost(new URL(issuerUrl).hostname);
  } catch {
    return false;
  }
}

function hasUsableBotstationOidcSession(config: {
  oidc?: { accessTokenExpiresAt?: string; refreshTokenSaved?: boolean };
}): boolean {
  if (config.oidc?.refreshTokenSaved) {
    return true;
  }
  if (!config.oidc?.accessTokenExpiresAt) {
    return false;
  }
  return new Date(config.oidc.accessTokenExpiresAt).getTime() > Date.now() + 60_000;
}

function registerIpc(): void {
  ipcMain.handle("snapshot", (_event, activeConversationId?: string) =>
    getRuntime().snapshot(optionalString(activeConversationId, "active conversation id")),
  );
  ipcMain.handle("hbclient:update:getState", () => updateManager?.getState());
  ipcMain.handle("hbclient:update:check", () => updateManager?.check(true));
  ipcMain.handle("hbclient:update:download", () => updateManager?.download());
  ipcMain.handle("hbclient:update:install", () => updateManager?.install());
  ipcMain.handle("conversation:create", (_event, input?: string | CreateConversationInput) =>
    getRuntime().createConversation(validateCreateConversationInput(input)),
  );
  ipcMain.handle("conversation:delete", (_event, id: string) =>
    getRuntime().deleteConversation(requiredString(id, "conversation id")),
  );
  ipcMain.handle("prompt:send", (_event, input: SendPromptInput) =>
    getRuntime().sendPrompt(validateSendPromptInput(input)),
  );
  ipcMain.handle("clipboard:readText", () => clipboard.readText());
  ipcMain.handle("job:cancel", (_event, id: string) => getRuntime().cancelJob(requiredString(id, "job id")));
  ipcMain.handle("tool:approve", (_event, id: string) =>
    getRuntime().approveToolPermission(requiredString(id, "permission id")),
  );
  ipcMain.handle("tool:deny", (_event, id: string) =>
    getRuntime().denyToolPermission(requiredString(id, "permission id")),
  );
  ipcMain.handle("permission:setMode", (_event, mode: PermissionMode) =>
    getRuntime().setPermissionMode(validateRendererPermissionMode(mode)),
  );
  ipcMain.handle(
    "permission:addRule",
    (_event, rule: Omit<PermissionRule, "id" | "createdAt" | "scope"> & { id?: string }) =>
      getRuntime().addPermissionRule(validatePermissionRuleInput(rule)),
  );
  ipcMain.handle("permission:removeRule", (_event, id: string) =>
    getRuntime().removePermissionRule(requiredString(id, "permission rule id")),
  );
  ipcMain.handle("conversation:compact", (_event, id: string) =>
    getRuntime().compactConversation(requiredString(id, "conversation id")),
  );
  ipcMain.handle("conversation:loadTranscript", (_event, id: string) =>
    getRuntime().loadTranscript(requiredString(id, "conversation id")),
  );
  ipcMain.handle("conversation:loadHistory", (_event, id: string, beforeMessageId?: string, limit?: number) =>
    getRuntime().loadConversationHistory(
      requiredString(id, "conversation id"),
      optionalString(beforeMessageId, "before message id"),
      transcriptPageLimit(limit),
    ),
  );
  ipcMain.handle("project:createFromFolder", (_event, input: ProjectCreateInput) =>
    getRuntime().createProjectFromFolder(validateProjectCreateInput(input)),
  );
  ipcMain.handle("project:createFromName", (_event, input: ProjectCreateFromNameInput) =>
    getRuntime().createProjectFromName(validateProjectCreateFromNameInput(input)),
  );
  ipcMain.handle("project:list", () => getRuntime().listProjects());
  ipcMain.handle("project:pickFolder", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? "" : result.filePaths[0] || "";
  });
  ipcMain.handle("project:open", async (_event, id: string) => {
    const project = getRuntime().openProject(requiredString(id, "project id"));
    await shell.openPath(project.rootPath);
    return project;
  });
  ipcMain.handle("project:update", (_event, id: string, input: ProjectUpdateInput) =>
    getRuntime().updateProject(requiredString(id, "project id"), validateProjectUpdateInput(input)),
  );
  ipcMain.handle("autopilot:startDataRun", (_event, input: AutopilotStartDataRunInput) =>
    getRuntime().startDataRun(validateAutopilotStartInput(input)),
  );
  ipcMain.handle("autopilot:pause", (_event, id: string) =>
    getRuntime().pauseAutopilotRun(requiredString(id, "autopilot run id")),
  );
  ipcMain.handle("autopilot:resume", (_event, id: string) =>
    getRuntime().resumeAutopilotRun(requiredString(id, "autopilot run id")),
  );
  ipcMain.handle("autopilot:cancel", (_event, id: string) =>
    getRuntime().cancelAutopilotRun(requiredString(id, "autopilot run id")),
  );
  ipcMain.handle("autopilot:getRunReport", (_event, id: string) =>
    getRuntime().getAutopilotRunReport(requiredString(id, "autopilot run id")),
  );
  ipcMain.handle("worktree:list", () => getRuntime().listWorktrees());
  ipcMain.handle("worktree:getDiff", (_event, id: string) =>
    getRuntime().getWorktreeDiff(requiredString(id, "worktree id")),
  );
  ipcMain.handle("worktree:apply", (_event, id: string) =>
    getRuntime().applyWorktree(requiredString(id, "worktree id")),
  );
  ipcMain.handle("worktree:discard", (_event, id: string) =>
    getRuntime().discardWorktree(requiredString(id, "worktree id")),
  );
  ipcMain.handle("worktree:openFolder", async (_event, id: string) => {
    const worktree = (await getRuntime().listWorktrees()).find((item) => item.id === requiredString(id, "worktree id"));
    if (!worktree) {
      throw new Error(`Worktree not found: ${id}`);
    }
    await shell.openPath(worktree.path);
  });
  ipcMain.handle("remoteBridge:getConfig", () => getRuntime().remoteBridgeConfig());
  ipcMain.handle(
    "remoteBridge:updateConfig",
    (_event, input: Partial<RemoteBridgeConfig> & { token?: string; clearToken?: boolean }) =>
      getRuntime().updateRemoteBridgeConfig(validateRemoteBridgeUpdate(input)),
  );
  ipcMain.handle("remoteBridge:listSessions", () => getRuntime().listRemoteBridgeSessions());
  ipcMain.handle("remoteBridge:revokeSession", (_event, id: string) =>
    getRuntime().revokeRemoteBridgeSession(requiredString(id, "remote bridge session id")),
  );
  ipcMain.handle("remoteBridge:listAudit", () => getRuntime().listRemoteBridgeAudit());
  ipcMain.handle("identity:get", () => getRuntime().identityContext());
  ipcMain.handle("identity:update", (_event, input: IdentityContext) =>
    getRuntime().updateIdentityContext(validateIdentityContext(input)),
  );
  ipcMain.handle("servstationA2A:getConfig", () => getRuntime().servstationA2AConfig());
  ipcMain.handle("servstationA2A:updateConfig", (_event, input: ServstationA2AConfigUpdate) =>
    getRuntime().updateServstationA2AConfig(validateServstationA2AConfigUpdate(input)),
  );
  ipcMain.handle("servstationA2A:loginOidc", async (_event, input?: ServstationA2AOidcLoginInput) => {
    const result = await loginServstationOidc(validateServstationA2AOidcLoginInput(input));
    if (result.status === "authenticated") {
      void updateManager?.check(false);
    }
    return result;
  });
  ipcMain.handle("servstationA2A:refreshOidc", async () => {
    const result = await getRuntime().refreshServstationA2AOidcSession();
    void updateManager?.check(false);
    return result;
  });
  ipcMain.handle("servstationA2A:logoutOidc", () => getRuntime().clearServstationA2AOidcSession());
  ipcMain.handle("servstationA2A:connectReverse", async () => {
    const result = await getRuntime().connectServstationReverseBridge();
    void updateManager?.check(false);
    return result;
  });
  ipcMain.handle("servstationA2A:disconnectReverse", () => getRuntime().disconnectServstationReverseBridge());
  ipcMain.handle("servstationClient:snapshot", (_event, input?: ServstationClientSnapshotQuery) =>
    getRuntime().getServstationClientSnapshot(validateServstationClientSnapshotQuery(input)),
  );
  ipcMain.handle("servstationClient:createProject", (_event, name: string) =>
    getRuntime().createServstationProject(requiredString(name, "servstation project name")),
  );
  ipcMain.handle("servstationClient:updateProject", (_event, id: string, name: string) =>
    getRuntime().updateServstationProject(
      requiredString(id, "servstation project id"),
      requiredString(name, "servstation project name"),
    ),
  );
  ipcMain.handle("servstationClient:deleteProject", (_event, id: string) =>
    getRuntime().deleteServstationProject(requiredString(id, "servstation project id")),
  );
  ipcMain.handle("servstationClient:listProjectResources", (_event, id: string) =>
    getRuntime().listServstationProjectResources(requiredString(id, "servstation project id")),
  );
  ipcMain.handle("servstationClient:deleteProjectResource", (_event, projectId: string, resourceId: string) =>
    getRuntime().deleteServstationProjectResource(
      requiredString(projectId, "servstation project id"),
      requiredString(resourceId, "servstation project resource id"),
    ),
  );
  ipcMain.handle("servstationClient:createConversation", (_event, title?: string, projectId?: string) =>
    getRuntime().createServstationConversation(
      optionalString(title, "servstation conversation title"),
      optionalString(projectId, "servstation project id"),
    ),
  );
  ipcMain.handle("servstationClient:deleteConversation", (_event, id: string) =>
    getRuntime().deleteServstationConversation(requiredString(id, "servstation conversation id")),
  );
  ipcMain.handle("servstationClient:sendPrompt", (_event, input: ServstationSendPromptInput) =>
    getRuntime().sendServstationPrompt(validateServstationSendPromptInput(input)),
  );
  ipcMain.handle("servstationClient:cancelJob", (_event, id: string) =>
    getRuntime().cancelServstationJob(requiredString(id, "servstation job id")),
  );
  ipcMain.handle("servstationClient:fetchJobFile", (_event, jobId: string, fileId: string) =>
    getRuntime().fetchServstationJobFile(
      requiredString(jobId, "servstation job id"),
      requiredString(fileId, "servstation job file id"),
    ),
  );
  ipcMain.handle("servstationClient:createScheduledJob", (_event, input: ServstationScheduledJobInput) =>
    getRuntime().createServstationScheduledJob(validateServstationScheduledJobInput(input)),
  );
  ipcMain.handle(
    "servstationClient:updateScheduledJob",
    (_event, id: string, input: Partial<ServstationScheduledJobInput>) =>
      getRuntime().updateServstationScheduledJob(
        requiredString(id, "servstation scheduled job id"),
        validateServstationScheduledJobUpdate(input),
      ),
  );
  ipcMain.handle("servstationClient:deleteScheduledJob", (_event, id: string) =>
    getRuntime().deleteServstationScheduledJob(requiredString(id, "servstation scheduled job id")),
  );
  ipcMain.handle("servstationClient:startAutopilotRun", (_event, input: ServstationAutopilotStartInput) =>
    getRuntime().startServstationAutopilotRun(validateServstationAutopilotStartInput(input)),
  );
  ipcMain.handle("servstationClient:updateAutopilotRun", (_event, input: ServstationAutopilotStatusUpdate) =>
    getRuntime().updateServstationAutopilotRun(validateServstationAutopilotStatusUpdate(input)),
  );
  ipcMain.handle("servstationClient:subscribeAutopilotEvents", (event, id: string, runId: string) => {
    const subscriptionId = requiredString(id, "servstation autopilot event subscription id");
    const resolvedRunId = requiredString(runId, "servstation autopilot run id");
    servstationAutopilotEventSubscriptions.get(subscriptionId)?.abort();
    const controller = new AbortController();
    servstationAutopilotEventSubscriptions.set(subscriptionId, controller);
    const channel = `servstationClient:autopilotEvent:${subscriptionId}`;
    void getRuntime()
      .streamServstationAutopilotEvents(
        resolvedRunId,
        (payload) => {
          if (!controller.signal.aborted && !event.sender.isDestroyed()) {
            event.sender.send(channel, payload);
          }
        },
        controller.signal,
      )
      .catch(() => undefined)
      .finally(() => {
        if (servstationAutopilotEventSubscriptions.get(subscriptionId) === controller) {
          servstationAutopilotEventSubscriptions.delete(subscriptionId);
        }
      });
    event.sender.once("destroyed", () => {
      controller.abort();
      servstationAutopilotEventSubscriptions.delete(subscriptionId);
    });
    return { subscriptionId };
  });
  ipcMain.handle("servstationClient:unsubscribeAutopilotEvents", (_event, id: string) => {
    const subscriptionId = requiredString(id, "servstation autopilot event subscription id");
    servstationAutopilotEventSubscriptions.get(subscriptionId)?.abort();
    servstationAutopilotEventSubscriptions.delete(subscriptionId);
  });
  ipcMain.handle("servstationClient:getFlowEngineSnapshot", () => getRuntime().getServstationFlowEngineSnapshot());
  ipcMain.handle("servstationClient:launchFlowEngineWorkflow", (_event, input: ServstationFlowEngineLaunchInput) =>
    getRuntime().launchServstationFlowEngineWorkflow(validateServstationFlowEngineLaunchInput(input)),
  );
  ipcMain.handle("servstationClient:getFlowEngineExecution", (_event, id: string) =>
    getRuntime().getServstationFlowEngineExecution(requiredString(id, "servstation flow execution id")),
  );
  ipcMain.handle("servstationClient:getFlowEngineExecutionEvents", (_event, id: string) =>
    getRuntime().getServstationFlowEngineExecutionEvents(requiredString(id, "servstation flow execution id")),
  );
  ipcMain.handle(
    "servstationClient:decideFlowEngineApproval",
    (_event, input: ServstationFlowEngineApprovalDecisionInput) =>
      getRuntime().decideServstationFlowEngineApproval(validateServstationFlowEngineApprovalDecisionInput(input)),
  );
  ipcMain.handle("servstationClient:listMessages", (_event, folder: ServstationMessageFolder, unreadOnly?: boolean) =>
    getRuntime().listServstationMessages(
      validateServstationMessageFolder(folder),
      optionalBoolean(unreadOnly, "servstation unread only") ?? false,
    ),
  );
  ipcMain.handle("servstationClient:getUnreadMessages", () => getRuntime().getServstationUnreadMessages());
  ipcMain.handle("servstationClient:getMessage", (_event, id: string) =>
    getRuntime().getServstationMessage(requiredString(id, "servstation message id")),
  );
  ipcMain.handle("servstationClient:markMessageRead", (_event, id: string) =>
    getRuntime().markServstationMessageRead(requiredString(id, "servstation message id")),
  );
  ipcMain.handle("servstationClient:setMessageFavorite", (_event, id: string, favorited: boolean) =>
    getRuntime().setServstationMessageFavorite(
      requiredString(id, "servstation message id"),
      optionalBoolean(favorited, "servstation message favorite") ?? false,
    ),
  );
  ipcMain.handle("servstationClient:trashMessage", (_event, id: string) =>
    getRuntime().trashServstationMessage(requiredString(id, "servstation message id")),
  );
  ipcMain.handle("servstationClient:restoreMessage", (_event, id: string) =>
    getRuntime().restoreServstationMessage(requiredString(id, "servstation message id")),
  );
  ipcMain.handle("servstationClient:deleteMessage", (_event, id: string) =>
    getRuntime().deleteServstationMessage(requiredString(id, "servstation message id")),
  );
  ipcMain.handle("servstationClient:fetchMessageAttachment", (_event, messageId: string, attachmentId: string) =>
    getRuntime().fetchServstationMessageAttachment(
      requiredString(messageId, "servstation message id"),
      requiredString(attachmentId, "servstation attachment id"),
    ),
  );
  ipcMain.handle("servstationClient:sendAgentMessage", (_event, input: ServstationSendAgentMessageInput) =>
    getRuntime().sendServstationAgentMessage(validateServstationSendAgentMessageInput(input)),
  );
  ipcMain.handle("servstationClient:sendDirectMessage", (_event, input: ServstationSendDirectMessageInput) =>
    getRuntime().sendServstationDirectMessage(validateServstationSendDirectMessageInput(input)),
  );
  ipcMain.handle("servstationClient:listMailAccounts", () => getRuntime().listServstationMailAccounts());
  ipcMain.handle("servstationClient:createMailAccount", (_event, input: ServstationMailAccountDraft) =>
    getRuntime().createServstationMailAccount(validateServstationMailAccountDraft(input)),
  );
  ipcMain.handle("servstationClient:updateMailAccount", (_event, id: string, input: ServstationMailAccountDraft) =>
    getRuntime().updateServstationMailAccount(
      requiredString(id, "servstation mail account id"),
      validateServstationMailAccountDraft(input),
    ),
  );
  ipcMain.handle("servstationClient:deleteMailAccount", (_event, id: string) =>
    getRuntime().deleteServstationMailAccount(requiredString(id, "servstation mail account id")),
  );
  ipcMain.handle("servstationClient:setDefaultMailAccount", (_event, id: string) =>
    getRuntime().setDefaultServstationMailAccount(requiredString(id, "servstation mail account id")),
  );
  ipcMain.handle("servstationClient:testMailAccountConnection", (_event, id: string) =>
    getRuntime().testServstationMailAccountConnection(requiredString(id, "servstation mail account id")),
  );
  ipcMain.handle("servstationClient:syncMailAccountNow", (_event, id: string) =>
    getRuntime().syncServstationMailAccountNow(requiredString(id, "servstation mail account id")),
  );
  ipcMain.handle("servstationClient:subscribeMessageEvents", (event, id: string) => {
    const subscriptionId = requiredString(id, "servstation message event subscription id");
    servstationMessageEventSubscriptions.get(subscriptionId)?.abort();
    const controller = new AbortController();
    servstationMessageEventSubscriptions.set(subscriptionId, controller);
    const channel = `servstationClient:messageEvent:${subscriptionId}`;
    void getRuntime()
      .streamServstationMessageEvents((payload) => {
        if (!controller.signal.aborted && !event.sender.isDestroyed()) {
          event.sender.send(channel, payload);
        }
      }, controller.signal)
      .catch(() => undefined)
      .finally(() => {
        if (servstationMessageEventSubscriptions.get(subscriptionId) === controller) {
          servstationMessageEventSubscriptions.delete(subscriptionId);
        }
      });
    event.sender.once("destroyed", () => {
      controller.abort();
      servstationMessageEventSubscriptions.delete(subscriptionId);
    });
    return { subscriptionId };
  });
  ipcMain.handle("servstationClient:unsubscribeMessageEvents", (_event, id: string) => {
    const subscriptionId = requiredString(id, "servstation message event subscription id");
    servstationMessageEventSubscriptions.get(subscriptionId)?.abort();
    servstationMessageEventSubscriptions.delete(subscriptionId);
  });
  ipcMain.handle("memory:list", (_event, query?: MemorySearchQuery) =>
    getRuntime().listMemory(validateMemorySearchQuery(query)),
  );
  ipcMain.handle("memory:search", (_event, query?: MemorySearchQuery) =>
    getRuntime().searchMemory(validateMemorySearchQuery(query)),
  );
  ipcMain.handle("memory:add", (_event, input: MemoryAddInput) =>
    getRuntime().addMemory(validateMemoryAddInput(input)),
  );
  ipcMain.handle("memory:update", (_event, id: string, input: MemoryUpdateInput) =>
    getRuntime().updateMemory(requiredString(id, "memory id"), validateMemoryUpdateInput(input)),
  );
  ipcMain.handle("memory:delete", (_event, id: string) => getRuntime().deleteMemory(requiredString(id, "memory id")));
  ipcMain.handle("memory:approveCandidate", (_event, id: string) =>
    getRuntime().approveMemoryCandidate(requiredString(id, "memory candidate id")),
  );
  ipcMain.handle("memory:denyCandidate", (_event, id: string) =>
    getRuntime().denyMemoryCandidate(requiredString(id, "memory candidate id")),
  );
  ipcMain.handle("memory:export", () => getRuntime().exportMemory());
  ipcMain.handle("memory:import", (_event, input: MemoryImportInput) =>
    getRuntime().importMemory(validateMemoryImportInput(input)),
  );
  ipcMain.handle("memory:backup", () => getRuntime().backupMemory());
  ipcMain.handle("memory:restore", (_event, filePath?: string) =>
    getRuntime().restoreMemory(optionalSafePath(filePath)),
  );
  ipcMain.handle("memory:replayRecall", (_event, input: MemoryReplayRecallInput) =>
    getRuntime().replayMemoryRecall(validateMemoryReplayInput(input)),
  );
  ipcMain.handle("memory:evaluateRecall", (_event, input: MemoryReplayRecallInput) =>
    getRuntime().replayMemoryRecall(validateMemoryReplayInput(input)),
  );
  ipcMain.handle("memory:addRecallFeedback", (_event, input: MemoryRecallFeedbackInput) =>
    getRuntime().addMemoryRecallFeedback(validateMemoryRecallFeedbackInput(input)),
  );
  ipcMain.handle("model:update", (_event, input: ModelConfigUpdate) =>
    getRuntime().updateModelConfig(validateModelConfigUpdate(input)),
  );
  ipcMain.handle("model:test", (_event, input?: Partial<ModelConfigUpdate>) =>
    getRuntime().testModelConfig(validatePartialModelConfigUpdate(input)),
  );
  ipcMain.handle("modelProvider:create", (_event, input: ModelProviderUpdate) =>
    getRuntime().createModelProvider(validateModelProviderUpdate(input)),
  );
  ipcMain.handle("modelProvider:update", (_event, id: string, input: ModelProviderUpdate) =>
    getRuntime().updateModelProvider(requiredString(id, "model provider id"), validateModelProviderUpdate(input)),
  );
  ipcMain.handle("modelProvider:delete", (_event, id: string) =>
    getRuntime().deleteModelProvider(requiredString(id, "model provider id")),
  );
  ipcMain.handle("modelProvider:setActive", (_event, id: string) =>
    getRuntime().setActiveModelProvider(requiredString(id, "model provider id")),
  );
  ipcMain.handle("modelProvider:test", (_event, id?: string, input?: Partial<ModelProviderUpdate>) =>
    getRuntime().testModelProvider(optionalString(id, "model provider id"), validatePartialModelProviderUpdate(input)),
  );
  ipcMain.handle("market-config:update", (_event, input: ToolMarketConfigUpdate) =>
    getRuntime().updateToolMarketConfig(validateToolMarketConfigUpdate(input)),
  );
  ipcMain.handle("personality:update", (_event, input: PersonalityConfig) =>
    getRuntime().updatePersonality(validatePersonalityConfig(input)),
  );
  ipcMain.handle("capability:update", (_event, id: string, input: CapabilityUpdateInput) =>
    getRuntime().updateCapability(requiredString(id, "capability id"), validateCapabilityUpdateInput(input)),
  );
  ipcMain.handle("capability:delete", (_event, id: string) =>
    getRuntime().deleteCapability(requiredString(id, "capability id")),
  );
  ipcMain.handle("subagent:save", (_event, input: SubagentConfig) =>
    getRuntime().saveSubagent(validateSubagentConfig(input)),
  );
  ipcMain.handle("subagent:delete", (_event, id: string) =>
    getRuntime().deleteSubagent(requiredString(id, "subagent id")),
  );
  ipcMain.handle("market:list", (_event, query?: ToolMarketQuery) =>
    getRuntime().listToolMarket(validateToolMarketQuery(query)),
  );
  ipcMain.handle("market:install", (_event, id: string) =>
    getRuntime().installToolMarketProduct(requiredString(id, "tool market product id")),
  );
  ipcMain.handle("market:uninstall", (_event, id: string) =>
    getRuntime().uninstallToolMarketProduct(requiredString(id, "tool market product id")),
  );
  ipcMain.handle("mcp:listServers", () => getRuntime().listMcpServers());
  ipcMain.handle("mcp:addServer", (_event, input: McpServerInput) =>
    getRuntime().addMcpServer(validateMcpServerInput(input)),
  );
  ipcMain.handle("mcp:updateServer", (_event, id: string, input: McpServerUpdate) =>
    getRuntime().updateMcpServer(requiredString(id, "MCP server id"), validateMcpServerUpdate(input)),
  );
  ipcMain.handle("mcp:removeServer", (_event, id: string) =>
    getRuntime().removeMcpServer(requiredString(id, "MCP server id")),
  );
  ipcMain.handle("mcp:connect", (_event, id: string) =>
    getRuntime().connectMcpServer(requiredString(id, "MCP server id")),
  );
  ipcMain.handle("mcp:disconnect", (_event, id: string) =>
    getRuntime().disconnectMcpServer(requiredString(id, "MCP server id")),
  );
  ipcMain.handle("mcp:refreshTools", (_event, id: string) =>
    getRuntime().refreshMcpTools(requiredString(id, "MCP server id")),
  );
  ipcMain.handle("mcp:getLogs", (_event, id: string) => getRuntime().getMcpLogs(requiredString(id, "MCP server id")));
  ipcMain.handle("mcp:listPresets", () => getRuntime().listMcpPresets());
  ipcMain.handle("mcp:export", () => getRuntime().exportMcpConfig());
  ipcMain.handle("mcp:import", (_event, input: unknown) => getRuntime().importMcpConfig(input as McpConfigTransfer));
  ipcMain.handle("mcp:diagnoseServer", (_event, input: McpServerInput) =>
    getRuntime().diagnoseMcpServer(validateMcpServerInput(input)),
  );
  ipcMain.handle("schedule:create", (_event, input: ScheduledJobInput) =>
    getRuntime().createScheduledJob(validateScheduledJobInput(input)),
  );
  ipcMain.handle("schedule:update", (_event, id: string, input: Partial<ScheduledJobInput>) =>
    getRuntime().updateScheduledJob(requiredString(id, "scheduled job id"), validateScheduledJobUpdate(input)),
  );
  ipcMain.handle("schedule:delete", (_event, id: string) =>
    getRuntime().deleteScheduledJob(requiredString(id, "scheduled job id")),
  );
  ipcMain.handle("attachment:pick", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled) {
      return [];
    }
    return Promise.all(result.filePaths.map((filePath) => getRuntime().importAttachment(filePath)));
  });
  ipcMain.handle("file:open", async (_event, filePath: string) => {
    const safePath = requiredPath(filePath, "file path");
    const userDataPath =
      process.env.HBCLIENT_USER_DATA_DIR || process.env.SUPBOT_USER_DATA_DIR || app.getPath("userData");
    if (!getRuntime().isKnownSafePath(safePath) && !pathIsInside(userDataPath, safePath)) {
      throw new Error("HBClient can only open files or folders it created, imported, or tracks as a worktree.");
    }
    await shell.openPath(safePath);
  });
  ipcMain.handle(
    "path:userData",
    () => process.env.HBCLIENT_USER_DATA_DIR || process.env.SUPBOT_USER_DATA_DIR || app.getPath("userData"),
  );
}

function validateRendererPermissionMode(mode: PermissionMode): PermissionMode {
  if (mode === "default" || mode === "acceptEdits" || mode === "plan") {
    return mode;
  }
  throw new Error("Renderer cannot enable bypassPermissions mode.");
}

function validateSendPromptInput(input: SendPromptInput): SendPromptInput {
  const value = object(input, "prompt input");
  const workspaceMode = optionalString(value.workspaceMode, "workspace mode");
  if (workspaceMode && workspaceMode !== "main" && workspaceMode !== "isolated" && workspaceMode !== "readOnly") {
    throw new Error(`Invalid workspace mode: ${workspaceMode}`);
  }
  return {
    conversationId: optionalString(value.conversationId, "conversation id"),
    projectId: optionalString(value.projectId, "project id"),
    prompt: requiredString(value.prompt, "prompt"),
    workspaceMode: workspaceMode as SendPromptInput["workspaceMode"],
    attachments: Array.isArray(value.attachments) ? value.attachments.map(validateAttachment) : [],
  };
}

function validateProjectCreateInput(input: ProjectCreateInput): ProjectCreateInput {
  const value = object(input, "project input");
  return {
    rootPath: requiredString(value.rootPath, "project folder"),
    name: optionalString(value.name, "project name"),
  };
}

function validateProjectCreateFromNameInput(input: ProjectCreateFromNameInput): ProjectCreateFromNameInput {
  const value = object(input, "project input");
  const name = requiredString(value.name, "project name");
  if (name.length > 80) {
    throw new Error("Project name must be 80 characters or fewer.");
  }
  return { name };
}

function validateProjectUpdateInput(input: ProjectUpdateInput): ProjectUpdateInput {
  const value = object(input, "project update");
  return {
    name: optionalString(value.name, "project name"),
    status: optionalEnum(value.status, ["active", "archived", "error"], "project status"),
  };
}

function validateAutopilotStartInput(input: AutopilotStartDataRunInput): AutopilotStartDataRunInput {
  const value = object(input, "autopilot data run");
  const policy =
    value.writePolicy && typeof value.writePolicy === "object" && !Array.isArray(value.writePolicy)
      ? (value.writePolicy as Record<string, unknown>)
      : {};
  return {
    projectId: requiredString(value.projectId, "project id"),
    goal: requiredString(value.goal, "autopilot goal"),
    title: optionalString(value.title, "autopilot title"),
    dataSources: Array.isArray(value.dataSources) ? value.dataSources.map(validateDataSourceSpec) : [],
    writePolicy: compactUndefined({
      allowNetwork: optionalBoolean(policy.allowNetwork, "allow network"),
      allowMcp: optionalBoolean(policy.allowMcp, "allow MCP"),
      maxRuntimeMinutes: optionalNumber(policy.maxRuntimeMinutes, "max runtime minutes"),
      maxTasks: optionalNumber(policy.maxTasks, "max tasks"),
      maxRetries: optionalNumber(policy.maxRetries, "max retries"),
    }),
  };
}

function validateDataSourceSpec(input: unknown): DataSourceSpec {
  const value = object(input, "data source");
  return {
    id: optionalString(value.id, "data source id") || "",
    kind:
      optionalEnum(
        value.kind,
        ["localFiles", "folderScan", "httpApi", "webUrl", "mcpTool", "shellCommand"],
        "data source kind",
      ) || "folderScan",
    label: optionalString(value.label, "data source label") || "",
    path: optionalString(value.path, "data source path"),
    paths: optionalStringArray(value.paths, "data source paths"),
    url: optionalString(value.url, "data source url"),
    method: optionalEnum(value.method, ["GET", "POST"], "HTTP method"),
    headers:
      value.headers && typeof value.headers === "object" && !Array.isArray(value.headers)
        ? (Object.fromEntries(
            Object.entries(value.headers).filter(([key, entry]) => key.trim() && typeof entry === "string"),
          ) as Record<string, string>)
        : undefined,
    body: optionalString(value.body, "HTTP body"),
    mcpToolName: optionalString(value.mcpToolName, "MCP tool name"),
    shellCommand: optionalString(value.shellCommand, "shell command"),
  };
}

function validateAttachment(input: unknown) {
  const value = object(input, "attachment");
  return {
    id: requiredString(value.id, "attachment id"),
    name: requiredString(value.name, "attachment name"),
    path: optionalSafePath(value.path),
    size: optionalNumber(value.size, "attachment size") ?? 0,
    mimeType: optionalString(value.mimeType, "attachment mime type"),
  };
}

function validatePermissionRuleInput(input: Omit<PermissionRule, "id" | "createdAt" | "scope"> & { id?: string }) {
  const value = object(input, "permission rule");
  const behavior = optionalEnum(value.behavior, ["allow", "deny", "ask"], "permission behavior");
  if (!behavior) {
    throw new Error("permission behavior is required.");
  }
  return {
    id: optionalString(value.id, "permission rule id"),
    toolName: requiredString(value.toolName, "permission tool name"),
    behavior,
  };
}

function validateRemoteBridgeUpdate(input: Partial<RemoteBridgeConfig> & { token?: string; clearToken?: boolean }) {
  const value = object(input, "remote bridge config");
  const host = optionalString(value.host, "remote bridge host");
  const allowRemoteBind = optionalBoolean(value.allowRemoteBind, "allow remote bridge bind");
  if (host && !isLocalhost(host) && !allowRemoteBind) {
    throw new Error("Production HBClient only allows Remote Bridge to bind localhost.");
  }
  return compactUndefined({
    enabled: optionalBoolean(value.enabled, "remote bridge enabled"),
    host,
    port: optionalNumber(value.port, "remote bridge port"),
    allowRemoteBind,
    token: optionalString(value.token, "remote bridge token"),
    clearToken: optionalBoolean(value.clearToken, "clear remote bridge token"),
  });
}

function validateIdentityContext(input: IdentityContext): IdentityContext {
  const value = object(input, "identity context");
  return compactUndefined({
    tenantId: requiredString(value.tenantId, "tenant id"),
    organizationId: requiredString(value.organizationId, "organization id"),
    departmentId: requiredString(value.departmentId, "department id"),
    userId: requiredString(value.userId, "user id"),
    roleIds: optionalStringArray(value.roleIds, "role ids") || [],
    source: optionalEnum(value.source, ["manual", "servstation"], "identity source"),
    agentInstanceId: optionalString(value.agentInstanceId, "agent instance id"),
    servstationUrl: optionalString(value.servstationUrl, "servstation url"),
    updatedAt: optionalString(value.updatedAt, "identity updated at"),
  }) as IdentityContext;
}

function validateServstationA2AConfigUpdate(input: ServstationA2AConfigUpdate): ServstationA2AConfigUpdate {
  const value = object(input, "servstation A2A config");
  return compactUndefined({
    enabled: optionalBoolean(value.enabled, "servstation A2A enabled"),
    baseUrl: optionalString(value.baseUrl, "servstation A2A base url"),
    authMode: optionalEnum(value.authMode, ["identityHeaders", "bearer", "oidc"], "servstation A2A auth mode"),
    bearerToken: optionalString(value.bearerToken, "servstation A2A bearer token"),
    clearBearerToken: optionalBoolean(value.clearBearerToken, "clear servstation A2A bearer token"),
    staffAgentAccount: optionalString(value.staffAgentAccount, "servstation staff-agent account"),
    staffAgentPassword: optionalString(value.staffAgentPassword, "servstation staff-agent password"),
    clearStaffAgentPassword: optionalBoolean(value.clearStaffAgentPassword, "clear servstation staff-agent password"),
    agentInstanceId: optionalString(value.agentInstanceId, "servstation agent instance id"),
    oidcIssuerUrl: optionalString(value.oidcIssuerUrl, "servstation OIDC issuer URL"),
    oidcClientId: optionalString(value.oidcClientId, "servstation OIDC client id"),
    oidcScope: optionalString(value.oidcScope, "servstation OIDC scope"),
    oidcRedirectUri: optionalString(value.oidcRedirectUri, "servstation OIDC redirect URI"),
    reverseEnabled: optionalBoolean(value.reverseEnabled, "servstation reverse A2A enabled"),
    reverseClientInstanceId: optionalString(value.reverseClientInstanceId, "servstation reverse client instance id"),
  });
}

function validateServstationA2AOidcLoginInput(
  input: ServstationA2AOidcLoginInput | undefined,
): ServstationA2AOidcLoginInput {
  if (!input) {
    return {};
  }
  const value = object(input, "servstation OIDC login");
  return compactUndefined({
    baseUrl: optionalString(value.baseUrl, "servstation A2A base url"),
    issuerUrl: optionalString(value.issuerUrl, "servstation OIDC issuer URL"),
    clientId: optionalString(value.clientId, "servstation OIDC client id"),
    scope: optionalString(value.scope, "servstation OIDC scope"),
    redirectUri: optionalString(value.redirectUri, "servstation OIDC redirect URI"),
    loginHint: optionalString(value.loginHint, "servstation OIDC login hint"),
  });
}

function validateServstationClientSnapshotQuery(
  input: ServstationClientSnapshotQuery | undefined,
): ServstationClientSnapshotQuery {
  if (!input) {
    return {};
  }
  const value = object(input, "servstation client snapshot query");
  return compactUndefined({
    conversationId: optionalString(value.conversationId, "servstation conversation id"),
  });
}

function validateServstationSendPromptInput(input: ServstationSendPromptInput): ServstationSendPromptInput {
  const value = object(input, "servstation prompt input");
  return compactUndefined({
    conversationId: optionalString(value.conversationId, "servstation conversation id"),
    projectId: optionalString(value.projectId, "servstation project id"),
    prompt: requiredString(value.prompt, "servstation prompt"),
    requestId: optionalString(value.requestId, "servstation request id"),
    attachments: Array.isArray(value.attachments) ? value.attachments.map(validateAttachment) : [],
    allowWebSearch: optionalBoolean(value.allowWebSearch, "servstation web search"),
  });
}

function validateServstationScheduledJobInput(input: ServstationScheduledJobInput): ServstationScheduledJobInput {
  const value = object(input, "servstation scheduled job");
  return compactUndefined({
    title: optionalString(value.title, "servstation scheduled job title"),
    prompt: requiredString(value.prompt, "servstation scheduled job prompt"),
    scheduleKind: requiredString(value.scheduleKind, "servstation scheduled job kind"),
    runAt: optionalString(value.runAt, "servstation scheduled job run at"),
    cronExpr: optionalString(value.cronExpr, "servstation scheduled job cron expression"),
    conversationId: optionalString(value.conversationId, "servstation scheduled job conversation id"),
    enabled: optionalBoolean(value.enabled, "servstation scheduled job enabled"),
  });
}

function validateServstationScheduledJobUpdate(
  input: Partial<ServstationScheduledJobInput>,
): Partial<ServstationScheduledJobInput> {
  return validatePartialObject(input, {
    title: (value) => optionalString(value, "servstation scheduled job title"),
    prompt: (value) => optionalString(value, "servstation scheduled job prompt"),
    scheduleKind: (value) => optionalString(value, "servstation scheduled job kind"),
    runAt: (value) => optionalString(value, "servstation scheduled job run at"),
    cronExpr: (value) => optionalString(value, "servstation scheduled job cron expression"),
    conversationId: (value) => optionalString(value, "servstation scheduled job conversation id"),
    enabled: (value) => optionalBoolean(value, "servstation scheduled job enabled"),
  }) as Partial<ServstationScheduledJobInput>;
}

function validateServstationAutopilotStartInput(input: ServstationAutopilotStartInput): ServstationAutopilotStartInput {
  const value = object(input, "servstation autopilot start");
  return compactUndefined({
    conversationId: optionalString(value.conversationId, "servstation autopilot conversation id"),
    goal: optionalString(value.goal, "servstation autopilot goal"),
    prompt: optionalString(value.prompt, "servstation autopilot prompt"),
    requestId: optionalString(value.requestId, "servstation autopilot request id"),
  });
}

function validateServstationAutopilotStatusUpdate(
  input: ServstationAutopilotStatusUpdate,
): ServstationAutopilotStatusUpdate {
  const value = object(input, "servstation autopilot update");
  const status = requiredString(value.status, "servstation autopilot status");
  if (status !== "paused" && status !== "watching" && status !== "stopped") {
    throw new Error(`Invalid Servstation autopilot status: ${status}`);
  }
  return {
    runId: requiredString(value.runId, "servstation autopilot run id"),
    status,
  };
}

function validateServstationFlowEngineLaunchInput(
  input: ServstationFlowEngineLaunchInput,
): ServstationFlowEngineLaunchInput {
  const value = object(input, "servstation flow launch");
  return {
    workflowId: requiredString(value.workflowId, "servstation flow workflow id"),
    input: value.input === undefined ? {} : object(value.input, "servstation flow input"),
  };
}

function validateServstationFlowEngineApprovalDecisionInput(
  input: ServstationFlowEngineApprovalDecisionInput,
): ServstationFlowEngineApprovalDecisionInput {
  const value = object(input, "servstation flow approval decision");
  const decision = requiredString(value.decision, "servstation flow approval decision");
  if (decision !== "approved" && decision !== "rejected") {
    throw new Error(`Invalid Servstation flow approval decision: ${decision}`);
  }
  return compactUndefined({
    approvalId: requiredString(value.approvalId, "servstation flow approval id"),
    decision,
    comment: optionalString(value.comment, "servstation flow approval comment"),
  }) as ServstationFlowEngineApprovalDecisionInput;
}

function validateServstationMessageFolder(input: unknown): ServstationMessageFolder {
  return optionalEnum(input, ["inbox", "trash"], "servstation message folder") || "inbox";
}

function validateServstationMessageAccountRef(input: unknown): ServstationMessageAccountRef {
  const value = object(input, "servstation message account");
  return {
    tenantId: requiredString(value.tenantId, "tenant id"),
    organizationId: requiredString(value.organizationId, "organization id"),
    departmentId: requiredString(value.departmentId, "department id"),
    userId: requiredString(value.userId, "user id"),
  };
}

function validateServstationMessageAttachmentUpload(input: unknown): ServstationMessageAttachmentUpload {
  const value = object(input, "servstation message attachment");
  return {
    fileName: requiredString(value.fileName, "attachment file name"),
    contentType: optionalString(value.contentType, "attachment content type") || "application/octet-stream",
    contentBase64: requiredString(value.contentBase64, "attachment content"),
  };
}

function validateServstationSendAgentMessageInput(
  input: ServstationSendAgentMessageInput,
): ServstationSendAgentMessageInput {
  const value = object(input, "servstation agent message");
  return {
    recipients: requiredArray(value.recipients, "servstation message recipients").map(
      validateServstationMessageAccountRef,
    ),
    subject: requiredString(value.subject, "servstation message subject"),
    body: requiredString(value.body, "servstation message body"),
    attachments: Array.isArray(value.attachments)
      ? value.attachments.map(validateServstationMessageAttachmentUpload)
      : [],
  };
}

function validateServstationSendDirectMessageInput(
  input: ServstationSendDirectMessageInput,
): ServstationSendDirectMessageInput {
  const value = object(input, "servstation direct message");
  return {
    recipients: Array.isArray(value.recipients) ? value.recipients.map(validateServstationMessageAccountRef) : [],
    externalRecipients: optionalStringArray(value.externalRecipients, "external message recipients") || [],
    senderMailAccountId: optionalString(value.senderMailAccountId, "servstation sender mail account"),
    subject: requiredString(value.subject, "servstation message subject"),
    body: requiredString(value.body, "servstation message body"),
    attachments: Array.isArray(value.attachments)
      ? value.attachments.map(validateServstationMessageAttachmentUpload)
      : [],
  };
}

function validateServstationMailAccountDraft(input: ServstationMailAccountDraft): ServstationMailAccountDraft {
  const value = object(input, "servstation mail account");
  return compactUndefined({
    emailAddress: requiredString(value.emailAddress, "mail account email address"),
    displayName: optionalString(value.displayName, "mail account display name") || "",
    smtpHost: requiredString(value.smtpHost, "SMTP host"),
    smtpPort: optionalNumber(value.smtpPort, "SMTP port") ?? 587,
    smtpSecurity: optionalEnum(value.smtpSecurity, ["starttls", "tls", "none"], "SMTP security") || "starttls",
    smtpUsername: requiredString(value.smtpUsername, "SMTP username"),
    smtpPassword: optionalString(value.smtpPassword, "SMTP password"),
    imapHost: requiredString(value.imapHost, "IMAP host"),
    imapPort: optionalNumber(value.imapPort, "IMAP port") ?? 993,
    imapSecurity: optionalEnum(value.imapSecurity, ["starttls", "tls", "none"], "IMAP security") || "tls",
    imapUsername: requiredString(value.imapUsername, "IMAP username"),
    imapPassword: optionalString(value.imapPassword, "IMAP password"),
    isDefault: optionalBoolean(value.isDefault, "mail account default") ?? false,
    enabled: optionalBoolean(value.enabled, "mail account enabled") ?? true,
  }) as ServstationMailAccountDraft;
}

function validateMemorySearchQuery(input: MemorySearchQuery | undefined): MemorySearchQuery {
  if (!input) {
    return {};
  }
  const value = object(input, "memory query");
  return {
    query: optionalString(value.query, "memory query"),
    scope: optionalEnum(value.scope, ["global", "conversation", "subagent", "all"], "memory scope"),
    conversationId: optionalString(value.conversationId, "conversation id"),
    subagentName: optionalString(value.subagentName, "subagent name"),
    excludeSources: optionalStringArray(value.excludeSources, "excluded memory sources"),
    includeDisabled: optionalBoolean(value.includeDisabled, "include disabled memory"),
    limit: optionalNumber(value.limit, "memory limit"),
    budgetChars: optionalNumber(value.budgetChars, "memory budget"),
  };
}

function validateMemoryAddInput(input: MemoryAddInput): MemoryAddInput {
  const value = object(input, "memory input");
  return {
    type: optionalEnum(value.type, ["page", "fact"], "memory type"),
    scope: optionalEnum(value.scope, ["global", "conversation", "subagent"], "memory scope") || "global",
    conversationId: optionalString(value.conversationId, "conversation id"),
    subagentName: optionalString(value.subagentName, "subagent name"),
    title: requiredString(value.title, "memory title"),
    content: requiredString(value.content, "memory content"),
    source: optionalString(value.source, "memory source"),
    kind: optionalEnum(value.kind, ["fact", "preference", "decision", "task", "warning"], "memory kind"),
    confidence: optionalNumber(value.confidence, "memory confidence"),
    keywords: optionalStringArray(value.keywords, "memory keywords"),
  };
}

function validateMemoryUpdateInput(input: MemoryUpdateInput): MemoryUpdateInput {
  const value = object(input, "memory update");
  return {
    title: optionalString(value.title, "memory title"),
    content: optionalString(value.content, "memory content"),
    status: optionalEnum(value.status, ["active", "disabled"], "memory status"),
    scope: optionalEnum(value.scope, ["global", "conversation", "subagent"], "memory scope"),
    conversationId: optionalString(value.conversationId, "conversation id"),
    subagentName: optionalString(value.subagentName, "subagent name"),
    kind: optionalEnum(value.kind, ["fact", "preference", "decision", "task", "warning"], "memory kind"),
    confidence: optionalNumber(value.confidence, "memory confidence"),
    keywords: optionalStringArray(value.keywords, "memory keywords"),
  };
}

function validateMemoryImportInput(input: MemoryImportInput): MemoryImportInput {
  const value = object(input, "memory import");
  const mode = optionalEnum(value.mode, ["merge", "replace"], "memory import mode");
  if (!value.data || typeof value.data !== "object") {
    throw new Error("Memory import data is required.");
  }
  return { data: value.data as MemoryImportInput["data"], mode };
}

function validateMemoryReplayInput(input: MemoryReplayRecallInput): MemoryReplayRecallInput {
  return {
    ...validateMemorySearchQuery(input),
    query: requiredString(object(input, "memory replay").query, "memory replay query"),
    recallId: optionalString(object(input, "memory replay").recallId, "recall id"),
  };
}

function validateMemoryRecallFeedbackInput(input: MemoryRecallFeedbackInput): MemoryRecallFeedbackInput {
  const value = object(input, "memory recall feedback");
  return {
    memoryId: requiredString(value.memoryId, "memory id"),
    kind: optionalEnum(value.kind, ["useful", "irrelevant", "stale", "wrong"], "feedback kind") || "useful",
    query: optionalString(value.query, "feedback query"),
    recallId: optionalString(value.recallId, "recall id"),
    note: optionalString(value.note, "feedback note"),
  };
}

function validateModelConfigUpdate(input: ModelConfigUpdate): ModelConfigUpdate {
  return validateModelProviderUpdate(input);
}

function validateModelProviderUpdate(input: ModelProviderUpdate): ModelProviderUpdate {
  const value = object(input, "model config");
  return {
    providerName: requiredString(value.providerName, "provider name"),
    baseUrl: requiredString(value.baseUrl, "model base URL"),
    model: requiredString(value.model, "model name"),
    temperature: optionalNumber(value.temperature, "temperature") ?? 0.2,
    maxTokens: optionalNumber(value.maxTokens, "max tokens") ?? 4096,
    apiKey: optionalString(value.apiKey, "API key"),
    clearApiKey: optionalBoolean(value.clearApiKey, "clear API key"),
  };
}

function validateCreateConversationInput(input?: string | CreateConversationInput): string | CreateConversationInput {
  if (typeof input === "string") {
    return optionalString(input, "title") || "New conversation";
  }
  if (input === undefined) {
    return {};
  }
  const value = object(input, "conversation input");
  return {
    title: optionalString(value.title, "title"),
    projectId: optionalString(value.projectId, "project id"),
  };
}

function validatePartialModelConfigUpdate(
  input: Partial<ModelConfigUpdate> | undefined,
): Partial<ModelConfigUpdate> | undefined {
  return validatePartialModelProviderUpdate(input);
}

function validatePartialModelProviderUpdate(
  input: Partial<ModelProviderUpdate> | undefined,
): Partial<ModelProviderUpdate> | undefined {
  if (!input) {
    return undefined;
  }
  const value = object(input, "model test config");
  return {
    providerName: optionalString(value.providerName, "provider name"),
    baseUrl: optionalString(value.baseUrl, "model base URL"),
    model: optionalString(value.model, "model name"),
    temperature: optionalNumber(value.temperature, "temperature"),
    maxTokens: optionalNumber(value.maxTokens, "max tokens"),
    apiKey: optionalString(value.apiKey, "API key"),
    clearApiKey: optionalBoolean(value.clearApiKey, "clear API key"),
  };
}

function validateToolMarketConfigUpdate(input: ToolMarketConfigUpdate): ToolMarketConfigUpdate {
  const value = object(input, "tool market config");
  return {
    source: optionalEnum(value.source, ["local", "remote", "hybrid"], "tool market source") || "local",
    apiUrl: requiredString(value.apiUrl, "tool market API URL"),
    accountEmail: optionalString(value.accountEmail, "tool market account email"),
    accessToken: optionalString(value.accessToken, "tool market access token"),
    password: optionalString(value.password, "tool market password"),
    clearAccessToken: optionalBoolean(value.clearAccessToken, "clear access token"),
    clearPassword: optionalBoolean(value.clearPassword, "clear password"),
  };
}

function validatePersonalityConfig(input: PersonalityConfig): PersonalityConfig {
  const value = object(input, "personality config");
  return {
    summary: optionalString(value.summary, "personality summary") || "",
    traits: optionalStringArray(value.traits, "personality traits") || [],
    instructions: optionalString(value.instructions, "personality instructions") || "",
  };
}

function validateCapabilityUpdateInput(input: CapabilityUpdateInput): CapabilityUpdateInput {
  return validatePartialObject(input, {
    name: (value) => optionalString(value, "capability name"),
    description: (value) => optionalString(value, "capability description"),
    enabled: (value) => optionalBoolean(value, "capability enabled"),
  }) as CapabilityUpdateInput;
}

function validateSubagentConfig(input: SubagentConfig): SubagentConfig {
  const value = object(input, "subagent config");
  return {
    id: optionalString(value.id, "subagent id") || "",
    name: requiredString(value.name, "subagent name"),
    description: optionalString(value.description, "subagent description") || "",
    systemPrompt: optionalString(value.systemPrompt, "subagent system prompt") || "",
    enabled: optionalBoolean(value.enabled, "subagent enabled") ?? true,
  };
}

function validateToolMarketQuery(input: ToolMarketQuery | undefined): ToolMarketQuery {
  if (!input) {
    return {};
  }
  const value = object(input, "tool market query");
  return {
    query: optionalString(value.query, "tool market query"),
    type: optionalEnum(value.type, ["tool", "skill", "plugin", "mcp", "all"], "tool market type"),
  };
}

function validateMcpServerInput(input: McpServerInput): McpServerInput {
  const value = object(input, "MCP server");
  return {
    name: requiredString(value.name, "MCP server name"),
    command: requiredString(value.command, "MCP command"),
    args: optionalStringArray(value.args, "MCP args") || [],
    cwd: optionalSafePath(value.cwd),
    env: optionalStringRecord(value.env, "MCP env"),
    requestTimeoutMs: optionalNumber(value.requestTimeoutMs, "MCP request timeout"),
    enabled: optionalBoolean(value.enabled, "MCP enabled"),
    autoConnect: optionalBoolean(value.autoConnect, "MCP auto-connect"),
  };
}

function validateMcpServerUpdate(input: McpServerUpdate): McpServerUpdate {
  return validatePartialObject(input, {
    name: (value) => optionalString(value, "MCP server name"),
    command: (value) => optionalString(value, "MCP command"),
    args: (value) => optionalStringArray(value, "MCP args"),
    cwd: (value) => optionalSafePath(value),
    env: (value) => optionalStringRecord(value, "MCP env"),
    requestTimeoutMs: (value) => optionalNumber(value, "MCP request timeout"),
    enabled: (value) => optionalBoolean(value, "MCP enabled"),
    autoConnect: (value) => optionalBoolean(value, "MCP auto-connect"),
  }) as McpServerUpdate;
}

function validateScheduledJobInput(input: ScheduledJobInput): ScheduledJobInput {
  const value = object(input, "scheduled job");
  return {
    projectId: optionalString(value.projectId, "project id"),
    title: optionalString(value.title, "scheduled job title") || "",
    prompt: requiredString(value.prompt, "scheduled job prompt"),
    scheduleKind: optionalEnum(value.scheduleKind, ["once", "daily", "cron"], "schedule kind") || "once",
    runAt: optionalString(value.runAt, "run at"),
    cronExpr: optionalString(value.cronExpr, "cron expression"),
    enabled: optionalBoolean(value.enabled, "scheduled job enabled"),
  };
}

function validateScheduledJobUpdate(input: Partial<ScheduledJobInput>): Partial<ScheduledJobInput> {
  return validatePartialObject(input, {
    projectId: (value) => optionalString(value, "project id"),
    title: (value) => optionalString(value, "scheduled job title"),
    prompt: (value) => optionalString(value, "scheduled job prompt"),
    scheduleKind: (value) => optionalEnum(value, ["once", "daily", "cron"], "schedule kind"),
    runAt: (value) => optionalString(value, "run at"),
    cronExpr: (value) => optionalString(value, "cron expression"),
    enabled: (value) => optionalBoolean(value, "scheduled job enabled"),
  }) as Partial<ScheduledJobInput>;
}

function validatePartialObject(
  input: unknown,
  validators: Record<string, (value: unknown) => unknown>,
): Record<string, unknown> {
  const value = object(input, "input");
  const output: Record<string, unknown> = {};
  for (const [key, validate] of Object.entries(validators)) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const next = validate(value[key]);
      if (next !== undefined) {
        output[key] = next;
      }
    }
  }
  return output;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} is required.`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  return value.trim() || undefined;
}

function requiredPath(value: unknown, label: string): string {
  const filePath = requiredString(value, label);
  if (!isAbsolute(filePath)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return normalize(filePath);
}

function optionalSafePath(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return requiredPath(value, "path");
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

function transcriptPageLimit(value: unknown): number | undefined {
  const limit = optionalNumber(value, "transcript page limit");
  if (limit === undefined) {
    return undefined;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("transcript page limit must be an integer between 1 and 200.");
  }
  return limit;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a string array.`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function optionalStringRecord(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const entries = Object.entries(value);
  if (entries.some(([key, item]) => !key.trim() || typeof item !== "string")) {
    throw new Error(`${label} must map strings to strings.`);
  }
  return Object.fromEntries(entries.map(([key, item]) => [key.trim(), item.trim()]));
}

function optionalEnum<const T extends readonly string[]>(
  value: unknown,
  choices: T,
  label: string,
): T[number] | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string" || !choices.includes(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as T[number];
}

type Compacted<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

function compactUndefined<T extends Record<string, unknown>>(value: T): Compacted<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Compacted<T>;
}

function isLocalhost(host: string): boolean {
  const normalizedHost = host.trim().toLowerCase();
  return normalizedHost === "127.0.0.1" || normalizedHost === "localhost" || normalizedHost === "::1";
}

export function pathIsInside(parent: string, child: string): boolean {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  const relativePath = relative(resolvedParent, resolvedChild);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

app
  .whenReady()
  .then(async () => {
    registerIpc();
    await createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow();
      }
    });
  })
  .catch((error) => {
    dialog.showErrorBox("HBClient failed to start", error instanceof Error ? error.message : String(error));
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => updateManager?.stop());

app.on("before-quit", () => {
  for (const controller of servstationMessageEventSubscriptions.values()) {
    controller.abort();
  }
  servstationMessageEventSubscriptions.clear();
  for (const controller of servstationAutopilotEventSubscriptions.values()) {
    controller.abort();
  }
  servstationAutopilotEventSubscriptions.clear();
  void runtime?.shutdown();
});
