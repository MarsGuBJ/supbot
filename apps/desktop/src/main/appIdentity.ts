import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const HYBOT_USER_DATA_DIRECTORY = "HyBot";

interface UserDataEnvironment {
  HYBOT_USER_DATA_DIR?: string;
  HBCLIENT_USER_DATA_DIR?: string;
  SUPBOT_USER_DATA_DIR?: string;
}

interface ElectronPathApp {
  getPath(name: "appData"): string;
  setPath(name: "userData", path: string): void;
}

export function resolveUserDataPath(environment: UserDataEnvironment, appDataPath: string): string {
  return (
    environment.HYBOT_USER_DATA_DIR ||
    environment.HBCLIENT_USER_DATA_DIR ||
    environment.SUPBOT_USER_DATA_DIR ||
    join(appDataPath, HYBOT_USER_DATA_DIRECTORY)
  );
}

export function configureUserDataPath(app: ElectronPathApp, environment: UserDataEnvironment): string {
  const userDataPath = resolveUserDataPath(environment, app.getPath("appData"));
  mkdirSync(userDataPath, { recursive: true });
  app.setPath("userData", userDataPath);
  return userDataPath;
}
