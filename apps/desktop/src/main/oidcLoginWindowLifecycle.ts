import type { BrowserWindow } from "electron";

interface OidcLoginWindowHandlers {
  onWillRedirect: (event: Electron.Event, url: string) => void;
  onWillNavigate: (event: Electron.Event, url: string) => void;
  onDidNavigate: (event: Electron.Event, url: string) => void;
  onDidFinishLoad: () => void;
  onClosed: () => void;
}

export function removeOidcLoginWindowListeners(authWindow: BrowserWindow, handlers: OidcLoginWindowHandlers): void {
  if (authWindow.isDestroyed()) {
    return;
  }
  authWindow.webContents.off("will-redirect", handlers.onWillRedirect);
  authWindow.webContents.off("will-navigate", handlers.onWillNavigate);
  authWindow.webContents.off("did-navigate", handlers.onDidNavigate);
  authWindow.webContents.off("did-finish-load", handlers.onDidFinishLoad);
  authWindow.off("closed", handlers.onClosed);
}
