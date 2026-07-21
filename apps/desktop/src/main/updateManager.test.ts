import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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
    off: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, (listeners.get(event) || []).filter((candidate) => candidate !== listener));
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
    quitAndInstall: vi.fn()
  };
});

vi.mock("electron", () => ({
  app: {
    getVersion: () => "1.0.0",
    isPackaged: true
  }
}));

vi.mock("electron-updater", () => ({ autoUpdater: updaterMock }));

import { SupbotUpdateManager } from "./updateManager";

describe("SupbotUpdateManager", () => {
  beforeEach(() => {
    updaterMock.clearListeners();
    updaterMock.setFeedURL.mockReset();
    updaterMock.off.mockClear();
    updaterMock.checkForUpdates.mockReset();
    updaterMock.downloadUpdate.mockReset();
    updaterMock.quitAndInstall.mockReset();
    updaterMock.disableDifferentialDownload = true;
    updaterMock.requestHeaders = {};
    delete process.env.SUPBOT_UPDATE_FEED_URL;
  });

  it("removes updater listeners when disposed", () => {
    const emitState = vi.fn();
    const manager = new SupbotUpdateManager({
      getFeedContext: vi.fn().mockResolvedValue({ baseUrl: "https://servstation.example" }),
      emitState
    });

    manager.dispose();
    updaterMock.emit("update-available", { version: "2.0.0" });

    expect(updaterMock.off).toHaveBeenCalledTimes(6);
    expect(emitState).not.toHaveBeenCalled();
    expect(manager.getState().status).toBe("idle");
  });

  it("checks, downloads, reports progress, and installs an available release", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supbot-update-"));
    tempDirs.push(dir);
    const downloadedFile = join(dir, "Supbot-1.1.0.exe");
    const payload = Buffer.from("verified update payload");
    await writeFile(downloadedFile, payload);
    const files = [{ url: "Supbot-1.1.0.exe", sha512: createHash("sha512").update(payload).digest("base64") }];
    const getFeedContext = vi.fn().mockResolvedValue({ baseUrl: "https://servstation.example", accessToken: "token-1" });
    const states: string[] = [];
    const manager = new SupbotUpdateManager({
      getFeedContext,
      emitState: (state) => states.push(state.status)
    });
    updaterMock.checkForUpdates.mockImplementation(async () => {
      updaterMock.emit("checking-for-update");
      updaterMock.emit("update-available", { version: "1.1.0", files });
      return {};
    });
    updaterMock.downloadUpdate.mockImplementation(async () => {
      updaterMock.emit("download-progress", { percent: 48.5, bytesPerSecond: 2048, transferred: 485, total: 1000 });
      updaterMock.emit("update-downloaded", { version: "1.1.0", downloadedFile, files });
      return [];
    });

    await manager.check(true);
    expect(updaterMock.disableDifferentialDownload).toBe(false);
    expect(manager.getState()).toMatchObject({ status: "available", currentVersion: "1.0.0", availableVersion: "1.1.0" });
    expect(updaterMock.setFeedURL).toHaveBeenCalledWith({
      provider: "generic",
      url: "https://servstation.example/api/v1/supbot/updates/stable/win32-x64",
      useMultipleRangeRequest: false
    });
    expect(updaterMock.requestHeaders).toEqual({ Authorization: "Bearer token-1" });

    await manager.download();
    expect(manager.getState()).toMatchObject({
      status: "downloaded",
      availableVersion: "1.1.0",
      progress: { percent: 100, bytesPerSecond: 2048, transferred: 485, total: 1000 }
    });
    manager.install();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(updaterMock.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(states).toContain("downloading");
    expect(manager.getState().status).toBe("installing");
  });

  it("rejects a downloaded update whose SHA-512 digest does not match", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supbot-update-bad-"));
    tempDirs.push(dir);
    const downloadedFile = join(dir, "Supbot-1.2.0.exe");
    await writeFile(downloadedFile, "tampered");
    const files = [{ url: "Supbot-1.2.0.exe", sha512: createHash("sha512").update("expected").digest("base64") }];
    const manager = new SupbotUpdateManager({
      getFeedContext: vi.fn().mockResolvedValue({ baseUrl: "https://servstation.example" }),
      emitState: vi.fn()
    });
    updaterMock.checkForUpdates.mockImplementation(async () => {
      updaterMock.emit("update-available", { version: "1.2.0", files });
      return {};
    });
    updaterMock.downloadUpdate.mockImplementation(async () => {
      updaterMock.emit("update-downloaded", { version: "1.2.0", downloadedFile, files });
      return [downloadedFile];
    });

    await manager.check(true);
    await expect(manager.download()).rejects.toThrow("SHA-512 verification failed");
    expect(manager.getState()).toMatchObject({ status: "error", error: "Supbot update SHA-512 verification failed." });
  });

  it("refreshes the access token once after a 401", async () => {
    const getFeedContext = vi
      .fn()
      .mockResolvedValueOnce({ baseUrl: "https://servstation.example", accessToken: "expired" })
      .mockResolvedValueOnce({ baseUrl: "https://servstation.example", accessToken: "fresh" });
    const manager = new SupbotUpdateManager({ getFeedContext, emitState: vi.fn() });
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
    const getFeedContext = vi.fn().mockResolvedValue({ baseUrl: "https://servstation.example" });
    const manager = new SupbotUpdateManager({ getFeedContext, emitState: vi.fn() });
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
    const manager = new SupbotUpdateManager({
      getFeedContext: vi.fn().mockResolvedValue({ baseUrl: "https://servstation.example", accessToken: "token" }),
      emitState: vi.fn()
    });
    updaterMock.checkForUpdates.mockRejectedValue(Object.assign(new Error("HTTP 404"), { statusCode: 404 }));

    await expect(manager.check(true)).resolves.toMatchObject({ status: "not_available", error: undefined });
  });

  it("keeps background failures silent and exposes manual failures", async () => {
    const manager = new SupbotUpdateManager({
      getFeedContext: vi.fn().mockRejectedValue(new Error("offline")),
      emitState: vi.fn()
    });

    await expect(manager.check(false)).resolves.toMatchObject({ status: "idle", error: undefined });
    await expect(manager.check(true)).rejects.toThrow("offline");
    expect(manager.getState()).toMatchObject({ status: "error", error: "offline" });
  });
});
