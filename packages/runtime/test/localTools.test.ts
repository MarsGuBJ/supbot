import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";
import { spawn } from "node:child_process";
import { runShellCommand } from "../src/localTools";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const spawnMock = vi.mocked(spawn);

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

function spawnError(code: string) {
  return Object.assign(new Error(`spawn ${code}`), { code });
}

describe("runShellCommand", () => {
  afterEach(() => {
    spawnMock.mockReset();
  });

  // The cmd.exe fallback only exists on Windows; other platforms rethrow EPERM.
  test.skipIf(process.platform !== "win32")(
    "falls back to cmd.exe when Windows denies spawning PowerShell (EPERM)",
    async () => {
      const first = fakeChild();
      const second = fakeChild();
      spawnMock.mockReturnValueOnce(first as never).mockReturnValueOnce(second as never);
      const controller = new AbortController();
      const promise = runShellCommand("echo hi", controller.signal, 5_000);
      queueMicrotask(() => first.emit("error", spawnError("EPERM")));
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
      queueMicrotask(() => {
        second.stdout.emit("data", Buffer.from("hi\r\n"));
        second.emit("close", 0);
      });
      const result = await promise;
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hi\r\n");
      const [fallbackFile, fallbackArgs] = spawnMock.mock.calls[1] as unknown as [string, string[]];
      expect(fallbackFile.toLowerCase()).toContain("cmd.exe");
      expect(fallbackArgs.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      expect(fallbackArgs[3]).toBe("echo hi");
    },
  );

  test("does not fall back for non-permission spawn errors", async () => {
    const first = fakeChild();
    spawnMock.mockReturnValueOnce(first as never);
    const controller = new AbortController();
    const promise = runShellCommand("echo hi", controller.signal, 5_000);
    queueMicrotask(() => first.emit("error", spawnError("EACCES")));
    await expect(promise).rejects.toThrow("EACCES");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  test("drops a working directory that no longer exists", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child as never);
    const controller = new AbortController();
    const missing = join(tmpdir(), "supbot-missing-cwd-4e2f1c");
    const promise = runShellCommand("echo hi", controller.signal, 5_000, missing);
    queueMicrotask(() => child.emit("close", 0));
    await promise;
    const options = spawnMock.mock.calls[0][2] as { cwd?: string };
    expect(options.cwd).toBeUndefined();
  });
});
