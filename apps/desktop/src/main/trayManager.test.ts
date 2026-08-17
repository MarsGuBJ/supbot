import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => {
  const trayInstances: Array<{
    setToolTip: ReturnType<typeof vi.fn>;
    setContextMenu: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }> = [];
  const notificationInstances: Array<{
    on: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    options: { title: string; body: string };
  }> = [];
  return {
    trayInstances,
    notificationInstances,
    menuTemplate: [] as Array<{ label?: string; type?: string }>,
    notificationSupported: true,
  };
});

vi.mock("electron", () => ({
  nativeImage: {
    createFromPath: vi.fn((path: string) => ({ path })),
  },
  Tray: class MockTray {
    setToolTip = vi.fn();
    setContextMenu = vi.fn();
    on = vi.fn();
    destroy = vi.fn();
    constructor() {
      electronMock.trayInstances.push(this);
    }
  },
  Menu: {
    buildFromTemplate: vi.fn((template: Array<{ label?: string; type?: string }>) => {
      electronMock.menuTemplate = template;
      return template;
    }),
  },
  Notification: class MockNotification {
    static isSupported = vi.fn(() => electronMock.notificationSupported);
    on = vi.fn();
    show = vi.fn();
    constructor(public readonly options: { title: string; body: string }) {
      electronMock.notificationInstances.push(this);
    }
  },
}));

import { TrayManager, isTerminalJobStatus, jobNotificationText } from "./trayManager";

function createManager() {
  const showWindow = vi.fn();
  const quit = vi.fn();
  const manager = new TrayManager({
    iconPath: "/tmp/icon.ico",
    displayName: "HyBot",
    showWindow,
    quit,
  });
  return { manager, showWindow, quit };
}

describe("isTerminalJobStatus", () => {
  it("treats completed/failed/canceled as terminal", () => {
    expect(isTerminalJobStatus("completed")).toBe(true);
    expect(isTerminalJobStatus("failed")).toBe(true);
    expect(isTerminalJobStatus("canceled")).toBe(true);
    expect(isTerminalJobStatus("queued")).toBe(false);
    expect(isTerminalJobStatus("running")).toBe(false);
  });
});

describe("jobNotificationText", () => {
  it("maps status to a Chinese title", () => {
    expect(jobNotificationText("completed", "做点什么").title).toBe("任务完成");
    expect(jobNotificationText("failed", "做点什么").title).toBe("任务失败");
    expect(jobNotificationText("canceled", "做点什么").title).toBe("任务已取消");
  });

  it("uses the first non-empty prompt line as body", () => {
    expect(jobNotificationText("completed", "\n  第一行  \n第二行").body).toBe("第一行");
  });

  it("truncates long prompts", () => {
    const { body } = jobNotificationText("completed", "长".repeat(200));
    expect(body.length).toBe(80);
    expect(body.endsWith("...")).toBe(true);
  });
});

describe("TrayManager", () => {
  beforeEach(() => {
    electronMock.trayInstances.length = 0;
    electronMock.notificationInstances.length = 0;
    electronMock.menuTemplate = [];
    electronMock.notificationSupported = true;
  });

  it("creates the tray with tooltip, menu and click handler", () => {
    const { manager, showWindow, quit } = createManager();
    manager.start();

    expect(electronMock.trayInstances).toHaveLength(1);
    const tray = electronMock.trayInstances[0];
    expect(tray.setToolTip).toHaveBeenCalledWith("HyBot");
    expect(electronMock.menuTemplate.map((item) => item.label)).toEqual(["打开 HyBot", undefined, "退出"]);

    const openItem = electronMock.menuTemplate[0] as { click: () => void };
    openItem.click();
    expect(showWindow).toHaveBeenCalledTimes(1);

    const quitItem = electronMock.menuTemplate[2] as { click: () => void };
    quitItem.click();
    expect(quit).toHaveBeenCalledTimes(1);

    const clickHandler = tray.on.mock.calls.find(([event]) => event === "click")?.[1] as () => void;
    clickHandler();
    expect(showWindow).toHaveBeenCalledTimes(2);
  });

  it("does not create a second tray on repeated start", () => {
    const { manager } = createManager();
    manager.start();
    manager.start();
    expect(electronMock.trayInstances).toHaveLength(1);
  });

  it("shows a notification that reopens the window on click", () => {
    const { manager, showWindow } = createManager();
    manager.start();
    manager.notify("任务完成", "第一行");

    expect(electronMock.notificationInstances).toHaveLength(1);
    const notification = electronMock.notificationInstances[0];
    expect(notification.options).toMatchObject({ title: "任务完成", body: "第一行" });
    expect(notification.show).toHaveBeenCalledTimes(1);

    const clickHandler = notification.on.mock.calls.find(([event]) => event === "click")?.[1] as () => void;
    clickHandler();
    expect(showWindow).toHaveBeenCalledTimes(1);
  });

  it("skips notifications when unsupported", () => {
    electronMock.notificationSupported = false;
    const { manager } = createManager();
    manager.start();
    manager.notify("任务完成", "第一行");
    expect(electronMock.notificationInstances).toHaveLength(0);
  });

  it("destroys the tray on dispose", () => {
    const { manager } = createManager();
    manager.start();
    manager.dispose();
    expect(electronMock.trayInstances[0].destroy).toHaveBeenCalledTimes(1);
  });
});
