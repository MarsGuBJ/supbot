import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const updaterMock = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    autoRunAppAfterInstall: false,
    allowDowngrade: true,
    allowPrerelease: true,
    disableDifferentialDownload: false,
    forceDevUpdateConfig: false,
    requestHeaders: {} as Record<string, string>,
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) || []), listener]);
    }),
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) || []) {
        listener(...args);
      }
    },
    clearListeners() {
      listeners.clear();
    },
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  };
});

const appMock = vi.hoisted(() => ({
  getVersion: () => "1.0.0",
  isPackaged: true,
  quit: vi.fn(),
}));

const spawnMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  app: appMock,
}));

vi.mock("electron-updater", () => ({ autoUpdater: updaterMock }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: existsSyncMock,
}));

import { HBClientUpdateManager, isUpdateRuntimeSupported, updatePlatform } from "./updateManager";

function setResourcesPath(value: string | undefined): void {
  Object.defineProperty(process, "resourcesPath", { value, configurable: true, writable: true });
}

describe("HBClientUpdateManager", () => {
  beforeEach(() => {
    updaterMock.clearListeners();
    updaterMock.setFeedURL.mockReset();
    updaterMock.checkForUpdates.mockReset();
    updaterMock.downloadUpdate.mockReset();
    updaterMock.quitAndInstall.mockReset();
    appMock.quit.mockReset();
    spawnMock.mockReset();
    existsSyncMock.mockReset();
    updaterMock.disableDifferentialDownload = true;
    updaterMock.requestHeaders = {};
    delete process.env.HBCLIENT_UPDATE_FEED_URL;
    process.env.HBCLIENT_ENABLE_DEV_UPDATES = "1";
  });

  afterEach(() => {
    delete process.env.HBCLIENT_ENABLE_DEV_UPDATES;
  });

  it("checks, downloads, reports progress, and installs an available release", async () => {
    const getFeedContext = vi.fn().mockResolvedValue({ baseUrl: "https://botstation.example", accessToken: "token-1" });
    const states: string[] = [];
    const manager = new HBClientUpdateManager({
      getFeedContext,
      emitState: (state) => states.push(state.status),
    });
    updaterMock.checkForUpdates.mockImplementation(async () => {
      updaterMock.emit("checking-for-update");
      updaterMock.emit("update-available", { version: "1.1.0" });
      return {};
    });
    updaterMock.downloadUpdate.mockImplementation(async () => {
      updaterMock.emit("download-progress", { percent: 48.5, bytesPerSecond: 2048, transferred: 485, total: 1000 });
      updaterMock.emit("update-downloaded", { version: "1.1.0" });
      return [];
    });

    await manager.check(true);
    expect(updaterMock.disableDifferentialDownload).toBe(false);
    expect(manager.getState()).toMatchObject({
      status: "available",
      currentVersion: "1.0.0",
      availableVersion: "1.1.0",
    });
    expect(updaterMock.setFeedURL).toHaveBeenCalledWith({
      provider: "generic",
      url: `https://botstation.example/api/v1/hbclient/updates/stable/${updatePlatform(process.platform, process.arch)}`,
      useMultipleRangeRequest: false,
    });
    expect(updaterMock.requestHeaders).toEqual({ Authorization: "Bearer token-1" });

    await manager.download();
    expect(manager.getState()).toMatchObject({
      status: "downloaded",
      availableVersion: "1.1.0",
      progress: { percent: 100, bytesPerSecond: 2048, transferred: 485, total: 1000 },
    });
    manager.install();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(updaterMock.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(states).toContain("downloading");
    expect(manager.getState().status).toBe("installing");
  });

  it("runs the Windows update installer with admin rights by default", async () => {
    const manager = new HBClientUpdateManager({
      getFeedContext: vi.fn().mockResolvedValue({ baseUrl: "https://botstation.example" }),
      emitState: vi.fn(),
    });
    updaterMock.checkForUpdates.mockImplementation(async () => {
      updaterMock.emit("update-available", { version: "1.1.0" });
      return {};
    });
    const installerPath = "C:\\cache\\HyWork-1.1.0-win-x64.exe";
    updaterMock.downloadUpdate.mockImplementation(async () => {
      updaterMock.emit("update-downloaded", { version: "1.1.0" });
      return [installerPath];
    });
    existsSyncMock.mockReturnValue(true);
    spawnMock.mockReturnValue({ pid: 4321, unref: vi.fn() });
    const previousResourcesPath = process.resourcesPath;
    setResourcesPath("C:\\app\\resources");

    try {
      await manager.check(true);
      await manager.download();
      manager.install();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      if (process.platform === "win32") {
        const elevatePath = join("C:\\app\\resources", "elevate.exe");
        expect(existsSyncMock).toHaveBeenCalledWith(elevatePath);
        expect(spawnMock).toHaveBeenCalledWith(elevatePath, [installerPath, "--updated", "--force-run"], {
          detached: true,
          stdio: "ignore",
        });
        expect(updaterMock.quitAndInstall).not.toHaveBeenCalled();
        expect(appMock.quit).toHaveBeenCalledTimes(1);
      } else {
        expect(spawnMock).not.toHaveBeenCalled();
        expect(updaterMock.quitAndInstall).toHaveBeenCalledWith(false, true);
      }
    } finally {
      setResourcesPath(previousResourcesPath);
    }
  });

  it("falls back to the standard installer when the elevate helper is missing", async () => {
    const manager = new HBClientUpdateManager({
      getFeedContext: vi.fn().mockResolvedValue({ baseUrl: "https://botstation.example" }),
      emitState: vi.fn(),
    });
    updaterMock.checkForUpdates.mockImplementation(async () => {
      updaterMock.emit("update-available", { version: "1.1.0" });
      return {};
    });
    updaterMock.downloadUpdate.mockImplementation(async () => {
      updaterMock.emit("update-downloaded", { version: "1.1.0" });
      return ["C:\\cache\\HyWork-1.1.0-win-x64.exe"];
    });
    existsSyncMock.mockReturnValue(false);
    setResourcesPath("C:\\app\\resources");

    try {
      await manager.check(true);
      await manager.download();
      manager.install();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(spawnMock).not.toHaveBeenCalled();
      expect(updaterMock.quitAndInstall).toHaveBeenCalledWith(false, true);
      expect(appMock.quit).not.toHaveBeenCalled();
    } finally {
      setResourcesPath(undefined);
    }
  });

  it("refreshes the access token once after a 401", async () => {
    const getFeedContext = vi
      .fn()
      .mockResolvedValueOnce({ baseUrl: "https://botstation.example", accessToken: "expired" })
      .mockResolvedValueOnce({ baseUrl: "https://botstation.example", accessToken: "fresh" });
    const manager = new HBClientUpdateManager({ getFeedContext, emitState: vi.fn() });
    updaterMock.checkForUpdates
      .mockRejectedValueOnce(Object.assign(new Error("HTTP 401"), { statusCode: 401 }))
      .mockImplementationOnce(async () => {
        updaterMock.emit("update-not-available");
        return {};
      });

    await manager.check(true);
    expect(getFeedContext).toHaveBeenNthCalledWith(1, false);
    expect(getFeedContext).toHaveBeenNthCalledWith(2, true);
    expect(updaterMock.requestHeaders).toEqual({ Authorization: "Bearer fresh" });
    expect(manager.getState().status).toBe("not_available");
  });

  it("checks a public update feed without an access token", async () => {
    const getFeedContext = vi.fn().mockResolvedValue({ baseUrl: "https://botstation.example" });
    const manager = new HBClientUpdateManager({ getFeedContext, emitState: vi.fn() });
    updaterMock.checkForUpdates.mockImplementation(async () => {
      updaterMock.emit("update-available", { version: "1.1.0" });
      return {};
    });

    await manager.check(false);

    expect(getFeedContext).toHaveBeenCalledWith(false);
    expect(updaterMock.requestHeaders).toEqual({});
    expect(manager.getState()).toMatchObject({ status: "available", availableVersion: "1.1.0" });
  });

  it("maps a missing manifest to no update", async () => {
    const manager = new HBClientUpdateManager({
      getFeedContext: vi.fn().mockResolvedValue({ baseUrl: "https://botstation.example", accessToken: "token" }),
      emitState: vi.fn(),
    });
    updaterMock.checkForUpdates.mockRejectedValue(Object.assign(new Error("HTTP 404"), { statusCode: 404 }));

    await expect(manager.check(true)).resolves.toMatchObject({ status: "not_available", error: undefined });
  });

  it("refuses an unencrypted update feed before contacting the updater", async () => {
    const manager = new HBClientUpdateManager({
      getFeedContext: vi.fn().mockResolvedValue({ baseUrl: "http://botstation.example", accessToken: "token" }),
      emitState: vi.fn(),
    });

    await expect(manager.check(true)).rejects.toThrow("requires HTTPS");
    expect(updaterMock.setFeedURL).not.toHaveBeenCalled();
    expect(updaterMock.checkForUpdates).not.toHaveBeenCalled();
  });

  it("keeps background failures silent and exposes manual failures", async () => {
    const manager = new HBClientUpdateManager({
      getFeedContext: vi.fn().mockRejectedValue(new Error("offline")),
      emitState: vi.fn(),
    });

    await expect(manager.check(false)).resolves.toMatchObject({ status: "idle", error: undefined });
    await expect(manager.check(true)).rejects.toThrow("offline");
    expect(manager.getState()).toMatchObject({ status: "error", error: "offline" });
  });

  it("uses a distinct Linux x64 update channel", () => {
    expect(updatePlatform("win32", "x64")).toBe("win32-x64");
    expect(updatePlatform("linux", "x64")).toBe("linux-x64");
    expect(updatePlatform("linux", "arm64")).toBeUndefined();
    expect(updatePlatform("darwin", "x64")).toBeUndefined();
  });

  it("enables packaged Linux updates only for AppImage installs", () => {
    expect(
      isUpdateRuntimeSupported({
        platform: "linux",
        arch: "x64",
        isPackaged: true,
        appImagePath: "/home/user/Applications/HyWork.AppImage",
        enableDevUpdates: false,
      }),
    ).toBe(true);
    expect(
      isUpdateRuntimeSupported({
        platform: "linux",
        arch: "x64",
        isPackaged: true,
        enableDevUpdates: false,
      }),
    ).toBe(false);
    expect(
      isUpdateRuntimeSupported({
        platform: "win32",
        arch: "x64",
        isPackaged: true,
        enableDevUpdates: false,
      }),
    ).toBe(true);
  });
});
