import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { HBClientUpdateProgress, HBClientUpdateState } from "@supbot/shared";

const defaultCheckIntervalMs = 30 * 60 * 1000;

interface UpdateFeedContext {
  baseUrl: string;
  accessToken?: string;
}

interface HBClientUpdateManagerOptions {
  getFeedContext: (forceRefresh: boolean) => Promise<UpdateFeedContext>;
  emitState: (state: HBClientUpdateState) => void;
}

type HBClientUpdatePlatform = "win32-x64" | "linux-x64";

export class HBClientUpdateManager {
  private state: HBClientUpdateState = {
    status: "idle",
    currentVersion: app.getVersion(),
  };
  private interval?: NodeJS.Timeout;
  private checkPromise?: Promise<HBClientUpdateState>;

  constructor(private readonly options: HBClientUpdateManagerOptions) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.autoRunAppAfterInstall = true;
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.disableDifferentialDownload = false;
    if (!app.isPackaged && process.env.HBCLIENT_ENABLE_DEV_UPDATES === "1") {
      autoUpdater.forceDevUpdateConfig = true;
    }
    autoUpdater.on("checking-for-update", () => this.setState({ status: "checking", error: undefined }));
    autoUpdater.on("update-available", (info) => {
      this.setState({
        status: "available",
        availableVersion: info.version,
        progress: undefined,
        error: undefined,
        checkedAt: new Date().toISOString(),
      });
    });
    autoUpdater.on("update-not-available", () => {
      this.setState({
        status: "not_available",
        availableVersion: undefined,
        progress: undefined,
        error: undefined,
        checkedAt: new Date().toISOString(),
      });
    });
    autoUpdater.on("download-progress", (progress) => {
      this.setState({
        status: "downloading",
        progress: normalizeProgress(progress),
        error: undefined,
      });
    });
    autoUpdater.on("update-downloaded", (info) => {
      this.setState({
        status: "downloaded",
        availableVersion: info.version || this.state.availableVersion,
        progress: this.state.progress ? { ...this.state.progress, percent: 100 } : undefined,
        error: undefined,
      });
    });
    autoUpdater.on("error", (error) => {
      if (isMissingUpdateManifest(error)) {
        this.setState({
          status: "not_available",
          availableVersion: undefined,
          progress: undefined,
          error: undefined,
          checkedAt: new Date().toISOString(),
        });
        return;
      }
      this.setState({ status: "error", error: error.message || String(error) });
    });
  }

  getState(): HBClientUpdateState {
    return { ...this.state, progress: this.state.progress ? { ...this.state.progress } : undefined };
  }

  start(): void {
    if (!this.isEnabled() || this.interval) {
      return;
    }
    void this.check(false);
    const configured = Number(process.env.HBCLIENT_UPDATE_CHECK_INTERVAL_MS || defaultCheckIntervalMs);
    const intervalMs = Number.isFinite(configured) && configured >= 60_000 ? configured : defaultCheckIntervalMs;
    this.interval = setInterval(() => void this.check(false), intervalMs);
    this.interval.unref();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  check(manual = true): Promise<HBClientUpdateState> {
    if (!this.isEnabled()) {
      return Promise.resolve(this.getState());
    }
    if (this.checkPromise) {
      return this.checkPromise;
    }
    this.checkPromise = this.performCheck(manual).finally(() => {
      this.checkPromise = undefined;
    });
    return this.checkPromise;
  }

  async download(): Promise<HBClientUpdateState> {
    if (this.state.status !== "available" && !(this.state.status === "error" && this.state.availableVersion)) {
      return this.getState();
    }
    this.setState({ status: "downloading", progress: undefined, error: undefined });
    try {
      await this.withAuthenticatedFeed(() => autoUpdater.downloadUpdate());
      return this.getState();
    } catch (error) {
      const message = errorMessage(error);
      this.setState({ status: "error", error: message });
      throw new Error(message, { cause: error });
    }
  }

  install(): HBClientUpdateState {
    if (this.state.status !== "downloaded") {
      return this.getState();
    }
    this.setState({ status: "installing", error: undefined });
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return this.getState();
  }

  private async performCheck(manual: boolean): Promise<HBClientUpdateState> {
    this.setState({ status: "checking", error: undefined });
    try {
      await this.withAuthenticatedFeed(() => autoUpdater.checkForUpdates());
      return this.getState();
    } catch (error) {
      if (isMissingUpdateManifest(error)) {
        this.setState({
          status: "not_available",
          availableVersion: undefined,
          progress: undefined,
          error: undefined,
          checkedAt: new Date().toISOString(),
        });
        return this.getState();
      }
      const message = errorMessage(error);
      this.setState(manual ? { status: "error", error: message } : { status: "idle", error: undefined });
      if (manual) {
        throw new Error(message, { cause: error });
      }
      return this.getState();
    }
  }

  private async withAuthenticatedFeed<T>(action: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const context = await this.options.getFeedContext(attempt > 0);
      const configuredUrl =
        process.env.HBCLIENT_UPDATE_FEED_URL?.trim() ||
        `${context.baseUrl.replace(/\/$/, "")}/api/v1/hbclient/updates/stable/${requireUpdatePlatform()}`;
      const feedUrl = requireHttpsUpdateFeedUrl(configuredUrl);
      autoUpdater.setFeedURL({ provider: "generic", url: feedUrl, useMultipleRangeRequest: false });
      autoUpdater.requestHeaders = context.accessToken ? { Authorization: `Bearer ${context.accessToken}` } : {};
      try {
        return await action();
      } catch (error) {
        if (attempt === 0 && isUnauthorized(error)) {
          continue;
        }
        throw error;
      }
    }
    throw new Error("HBClient update authorization failed.");
  }

  private isEnabled(): boolean {
    return isUpdateRuntimeSupported({
      platform: process.platform,
      arch: process.arch,
      isPackaged: app.isPackaged,
      appImagePath: process.env.APPIMAGE,
      enableDevUpdates: process.env.HBCLIENT_ENABLE_DEV_UPDATES === "1",
    });
  }

  private setState(patch: Partial<HBClientUpdateState>): void {
    this.state = { ...this.state, ...patch, currentVersion: app.getVersion() };
    this.options.emitState(this.getState());
  }
}

export function updatePlatform(platform: NodeJS.Platform, arch: string): HBClientUpdatePlatform | undefined {
  if (arch !== "x64") {
    return undefined;
  }
  if (platform === "win32" || platform === "linux") {
    return `${platform}-${arch}`;
  }
  return undefined;
}

export function isUpdateRuntimeSupported(options: {
  platform: NodeJS.Platform;
  arch: string;
  isPackaged: boolean;
  appImagePath?: string;
  enableDevUpdates: boolean;
}): boolean {
  const platform = updatePlatform(options.platform, options.arch);
  if (!platform) {
    return false;
  }
  if (options.enableDevUpdates) {
    return true;
  }
  if (!options.isPackaged) {
    return false;
  }
  return platform === "win32-x64" || Boolean(options.appImagePath);
}

function requireUpdatePlatform(): HBClientUpdatePlatform {
  const platform = updatePlatform(process.platform, process.arch);
  if (!platform) {
    throw new Error(`HBClient updates are not supported on ${process.platform}-${process.arch}.`);
  }
  return platform;
}

export function requireHttpsUpdateFeedUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error("HBClient update feed URL is invalid.", { cause: error });
  }
  if (url.protocol !== "https:") {
    throw new Error("HBClient update feed requires HTTPS; refusing an unencrypted update channel.");
  }
  url.username = "";
  url.password = "";
  return url.toString().replace(/\/+$/, "");
}

function normalizeProgress(progress: {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}): HBClientUpdateProgress {
  return {
    percent: Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : 0,
    bytesPerSecond: Math.max(0, progress.bytesPerSecond || 0),
    transferred: Math.max(0, progress.transferred || 0),
    total: Math.max(0, progress.total || 0),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnauthorized(error: unknown): boolean {
  const candidate = error as { statusCode?: number; message?: string };
  return candidate?.statusCode === 401 || /\b401\b/.test(candidate?.message || "");
}

function isMissingUpdateManifest(error: unknown): boolean {
  const candidate = error as { statusCode?: number; message?: string };
  return candidate?.statusCode === 404 || /\b404\b/.test(candidate?.message || "");
}
