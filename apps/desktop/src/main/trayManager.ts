import { Menu, Notification, Tray, nativeImage } from "electron";
import type { JobStatus } from "@supbot/shared";

export interface TrayManagerOptions {
  iconPath: string;
  displayName: string;
  showWindow: () => void;
  quit: () => void;
}

export function isTerminalJobStatus(status: JobStatus): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

export function jobNotificationText(status: JobStatus, prompt: string): { title: string; body: string } {
  const title = status === "completed" ? "任务完成" : status === "failed" ? "任务失败" : "任务已取消";
  const firstLine =
    prompt
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || "";
  const compact = firstLine.replace(/\s+/g, " ");
  return { title, body: compact.length > 80 ? `${compact.slice(0, 77)}...` : compact };
}

export class TrayManager {
  private tray: Tray | null = null;

  constructor(private readonly options: TrayManagerOptions) {}

  start(): void {
    if (this.tray) {
      return;
    }
    this.tray = new Tray(nativeImage.createFromPath(this.options.iconPath));
    this.tray.setToolTip(this.options.displayName);
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `打开 ${this.options.displayName}`, click: () => this.options.showWindow() },
        { type: "separator" },
        { label: "退出", click: () => this.options.quit() },
      ]),
    );
    this.tray.on("click", () => this.options.showWindow());
  }

  notify(title: string, body: string): void {
    if (!Notification.isSupported()) {
      return;
    }
    const notification = new Notification({
      title,
      body,
      icon: nativeImage.createFromPath(this.options.iconPath),
    });
    notification.on("click", () => this.options.showWindow());
    notification.show();
  }

  dispose(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
