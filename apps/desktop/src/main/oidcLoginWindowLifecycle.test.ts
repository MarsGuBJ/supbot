import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { removeOidcLoginWindowListeners } from "./oidcLoginWindowLifecycle";

const handlers = {
  onWillRedirect: vi.fn(),
  onWillNavigate: vi.fn(),
  onDidNavigate: vi.fn(),
  onDidFinishLoad: vi.fn(),
  onClosed: vi.fn(),
};

describe("OIDC login window lifecycle", () => {
  it("does not access webContents after the login window is destroyed", () => {
    const authWindow = {
      isDestroyed: () => true,
      get webContents() {
        throw new Error("Object has been destroyed");
      },
      off: vi.fn(),
    } as unknown as BrowserWindow;

    expect(() => removeOidcLoginWindowListeners(authWindow, handlers)).not.toThrow();
  });

  it("removes every login listener while the window is still alive", () => {
    const webContents = { off: vi.fn() };
    const off = vi.fn();
    const authWindow = {
      isDestroyed: () => false,
      webContents,
      off,
    } as unknown as BrowserWindow;

    removeOidcLoginWindowListeners(authWindow, handlers);

    expect(webContents.off).toHaveBeenCalledTimes(4);
    expect(off).toHaveBeenCalledWith("closed", handlers.onClosed);
  });
});
