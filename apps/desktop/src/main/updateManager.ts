import { app } from "electron";
import { createReadStream } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { basename } from "node:path";
import { autoUpdater, type ProgressInfo, type UpdateDownloadedEvent, type UpdateInfo } from "electron-updater";
import type { SupbotUpdateProgress, SupbotUpdateState } from "@supbot/shared";

const defaultCheckIntervalMs = 30 * 60 * 1000;

interface UpdateFeedContext {
  baseUrl: string;
}

interface SupbotUpdateManagerOptions {
  getFeedContext: () => Promise<UpdateFeedContext>;
  emitState: (state: SupbotUpdateState) => void;
  autoInstallAfterDownload?: boolean;
}

export class SupbotUpdateManager {
  private state: SupbotUpdateState = {
    status: "idle",
    currentVersion: app.getVersion()
  };
  private interval?: NodeJS.Timeout;
  private checkPromise?: Promise<SupbotUpdateState>;
  private downloadVerification?: Promise<void>;
  private disposed = false;
  private readonly autoInstallAfterDownload: boolean;
  private readonly onCheckingForUpdate = () => this.setState({ status: "checking", error: undefined });
  private readonly onUpdateAvailable = (info: UpdateInfo) => {
    this.availableUpdateInfo = info;
    this.setState({
      status: "available",
      availableVersion: info.version,
      progress: undefined,
      error: undefined,
      checkedAt: new Date().toISOString()
    });
  };
  private readonly onUpdateNotAvailable = () => {
    this.availableUpdateInfo = undefined;
    this.setState({
      status: "not_available",
      availableVersion: undefined,
      progress: undefined,
      error: undefined,
      checkedAt: new Date().toISOString()
    });
  };
  private readonly onDownloadProgress = (progress: ProgressInfo) => {
    this.setState({
      status: "downloading",
      progress: normalizeProgress(progress),
      error: undefined
    });
  };
  private availableUpdateInfo?: UpdateInfo;
  private readonly onUpdateDownloaded = (info: UpdateDownloadedEvent) => {
    this.downloadVerification = this.verifyDownloadedUpdate(info).then(() => {
      this.setState({
        status: "downloaded",
        availableVersion: info.version || this.state.availableVersion,
        progress: this.state.progress ? { ...this.state.progress, percent: 100 } : undefined,
        error: undefined
      });
      if (this.shouldAutoInstallAfterDownload()) {
        this.install();
      }
    }).catch((error) => {
      this.onError(error as Error);
      throw error;
    });
    void this.downloadVerification.catch(() => undefined);
  };
  private readonly onError = (error: Error) => {
    if (isMissingUpdateManifest(error)) {
      this.setState({
        status: "not_available",
        availableVersion: undefined,
        progress: undefined,
        error: undefined,
        checkedAt: new Date().toISOString()
      });
      return;
    }
    this.setState({ status: "error", error: error.message || String(error) });
  };

  constructor(private readonly options: SupbotUpdateManagerOptions) {
    this.autoInstallAfterDownload = options.autoInstallAfterDownload ?? true;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.autoRunAppAfterInstall = true;
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.disableDifferentialDownload = false;
    if (!app.isPackaged && process.env.SUPBOT_ENABLE_DEV_UPDATES === "1") {
      autoUpdater.forceDevUpdateConfig = true;
    }
    autoUpdater.on("checking-for-update", this.onCheckingForUpdate);
    autoUpdater.on("update-available", this.onUpdateAvailable);
    autoUpdater.on("update-not-available", this.onUpdateNotAvailable);
    autoUpdater.on("download-progress", this.onDownloadProgress);
    autoUpdater.on("update-downloaded", this.onUpdateDownloaded);
    autoUpdater.on("error", this.onError);
  }

  getState(): SupbotUpdateState {
    return { ...this.state, progress: this.state.progress ? { ...this.state.progress } : undefined };
  }

  start(): void {
    if (!this.isEnabled() || this.interval) {
      return;
    }
    void this.check(false);
    const configured = Number(process.env.SUPBOT_UPDATE_CHECK_INTERVAL_MS || defaultCheckIntervalMs);
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

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stop();
    autoUpdater.off("checking-for-update", this.onCheckingForUpdate);
    autoUpdater.off("update-available", this.onUpdateAvailable);
    autoUpdater.off("update-not-available", this.onUpdateNotAvailable);
    autoUpdater.off("download-progress", this.onDownloadProgress);
    autoUpdater.off("update-downloaded", this.onUpdateDownloaded);
    autoUpdater.off("error", this.onError);
  }

  check(manual = true): Promise<SupbotUpdateState> {
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

  async download(): Promise<SupbotUpdateState> {
    if (this.state.status !== "available" && !(this.state.status === "error" && this.state.availableVersion)) {
      return this.getState();
    }
    this.setState({ status: "downloading", progress: undefined, error: undefined });
    this.downloadVerification = undefined;
    try {
      await this.withFeed(() => autoUpdater.downloadUpdate());
      if (!this.downloadVerification) {
        throw new Error("Supbot update download did not provide verification metadata.");
      }
      await this.downloadVerification;
      return this.getState();
    } catch (error) {
      const message = errorMessage(error);
      this.setState({ status: "error", error: message });
      throw new Error(message);
    }
  }

  install(): SupbotUpdateState {
    if (this.state.status !== "downloaded") {
      return this.getState();
    }
    this.setState({ status: "installing", error: undefined });
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return this.getState();
  }

  private async performCheck(manual: boolean): Promise<SupbotUpdateState> {
    this.setState({ status: "checking", error: undefined });
    try {
      await this.withFeed(() => autoUpdater.checkForUpdates());
      return this.getState();
    } catch (error) {
      if (isMissingUpdateManifest(error)) {
        this.setState({
          status: "not_available",
          availableVersion: undefined,
          progress: undefined,
          error: undefined,
          checkedAt: new Date().toISOString()
        });
        return this.getState();
      }
      const message = errorMessage(error);
      this.setState(manual ? { status: "error", error: message } : { status: "idle", error: undefined });
      if (manual) {
        throw new Error(message);
      }
      return this.getState();
    }
  }

  private async withFeed<T>(action: () => Promise<T>): Promise<T> {
    const context = await this.options.getFeedContext();
    const configuredUrl =
      process.env.SUPBOT_UPDATE_FEED_URL?.trim() ||
      `${context.baseUrl.replace(/\/$/, "")}/api/v1/supbot/updates/stable/win32-x64`;
    autoUpdater.setFeedURL({ provider: "generic", url: configuredUrl, useMultipleRangeRequest: false });
    autoUpdater.requestHeaders = {};
    return action();
  }

  private async verifyDownloadedUpdate(info: UpdateDownloadedEvent): Promise<void> {
    const downloadedFile = info.downloadedFile;
    if (!downloadedFile) {
      throw new Error("Supbot update download did not report the downloaded file path.");
    }
    const files = info.files?.length ? info.files : this.availableUpdateInfo?.files || [];
    const downloadedName = basename(downloadedFile).toLowerCase();
    const expected = files.find((file) => updateFileName(file.url).toLowerCase() === downloadedName)
      || (files.length === 1 ? files[0] : undefined);
    if (!expected?.sha512) {
      throw new Error("Supbot update manifest is missing the SHA-512 digest.");
    }
    const actual = await sha512File(downloadedFile);
    const expectedBytes = digestBytes(expected.sha512);
    const actualBytes = Buffer.from(actual, "base64");
    if (expectedBytes.length !== actualBytes.length || !timingSafeEqual(expectedBytes, actualBytes)) {
      throw new Error("Supbot update SHA-512 verification failed.");
    }
  }

  private isEnabled(): boolean {
    return process.platform === "win32" && process.arch === "x64" && (app.isPackaged || process.env.SUPBOT_ENABLE_DEV_UPDATES === "1");
  }

  private shouldAutoInstallAfterDownload(): boolean {
    return this.autoInstallAfterDownload && process.platform === "win32";
  }

  private setState(patch: Partial<SupbotUpdateState>): void {
    if (this.disposed) {
      return;
    }
    this.state = { ...this.state, ...patch, currentVersion: app.getVersion() };
    this.options.emitState(this.getState());
  }
}

async function sha512File(filePath: string): Promise<string> {
  const hash = createHash("sha512");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("base64");
}

function digestBytes(value: string): Buffer {
  return /^[a-f0-9]{128}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
}

function updateFileName(value: string): string {
  try {
    return basename(decodeURIComponent(new URL(value, "https://updates.invalid/").pathname));
  } catch {
    return basename(value);
  }
}

function normalizeProgress(progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }): SupbotUpdateProgress {
  return {
    percent: Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : 0,
    bytesPerSecond: Math.max(0, progress.bytesPerSecond || 0),
    transferred: Math.max(0, progress.transferred || 0),
    total: Math.max(0, progress.total || 0)
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingUpdateManifest(error: unknown): boolean {
  const candidate = error as { statusCode?: number; message?: string };
  return candidate?.statusCode === 404 || /\b404\b/.test(candidate?.message || "");
}
