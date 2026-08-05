import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { configureUserDataPath, HYBOT_USER_DATA_DIRECTORY, resolveUserDataPath } from "./appIdentity";

describe("HyBot application identity", () => {
  it("uses a dedicated user-data namespace instead of the shared HBClient directory", () => {
    const appDataPath = join("test-root", "AppData", "Roaming");

    expect(HYBOT_USER_DATA_DIRECTORY).toBe("HyBot");
    expect(resolveUserDataPath({}, appDataPath)).toBe(join(appDataPath, "HyBot"));
    expect(resolveUserDataPath({}, appDataPath)).not.toBe(join(appDataPath, "HBClient"));
  });

  it("keeps explicit development and test directory overrides", () => {
    expect(
      resolveUserDataPath(
        {
          HYBOT_USER_DATA_DIR: "hybot-override",
          HBCLIENT_USER_DATA_DIR: "hbclient-override",
          SUPBOT_USER_DATA_DIR: "supbot-override",
        },
        "app-data",
      ),
    ).toBe("hybot-override");
    expect(resolveUserDataPath({ HBCLIENT_USER_DATA_DIR: "hbclient-override" }, "app-data")).toBe("hbclient-override");
    expect(resolveUserDataPath({ SUPBOT_USER_DATA_DIR: "supbot-override" }, "app-data")).toBe("supbot-override");
  });

  it("configures Electron to use the isolated directory", () => {
    const setPath = vi.fn();
    const appDataPath = mkdtempSync(join(tmpdir(), "hybot-app-identity-"));
    const expectedPath = join(appDataPath, "HyBot");

    try {
      expect(configureUserDataPath({ getPath: () => appDataPath, setPath }, {})).toBe(expectedPath);
      expect(existsSync(expectedPath)).toBe(true);
      expect(setPath).toHaveBeenCalledWith("userData", expectedPath);
    } finally {
      rmSync(appDataPath, { recursive: true, force: true });
    }
  });
});
