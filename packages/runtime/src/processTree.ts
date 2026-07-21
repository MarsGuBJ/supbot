import { spawn, type ChildProcess } from "node:child_process";

export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    return;
  }
  if (process.platform !== "win32") {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
  } else {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore"
      });
      killer.on("error", () => resolve());
      killer.on("close", () => resolve());
    });
  }
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolve) => {
      const fallback = setTimeout(resolve, 1_000);
      fallback.unref?.();
      child.once("close", () => {
        clearTimeout(fallback);
        resolve();
      });
    });
  }
}
