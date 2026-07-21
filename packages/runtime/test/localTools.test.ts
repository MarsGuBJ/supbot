import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readLocalFile, runShellCommand } from "../src/localTools";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("local tool resource limits", () => {
  test("rejects files larger than the ReadFile limit before loading them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supbot-read-limit-"));
    tempDirs.push(dir);
    const filePath = join(dir, "large.txt");
    await writeFile(filePath, Buffer.alloc(1024 * 1024 + 1, 0x61));

    await expect(readLocalFile(filePath)).rejects.toThrow("exceeds the 1048576 byte limit");
  });

  test("bounds shell stdout and stderr while the process is running", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supbot-shell-output-"));
    tempDirs.push(dir);
    const script = join(dir, "output.cjs");
    await writeFile(script, "process.stdout.write('x'.repeat(100000)); process.stderr.write('y'.repeat(50000));\n", "utf8");
    const controller = new AbortController();
    const command = process.platform === "win32"
      ? `& ${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`
      : `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;

    const result = await runShellCommand(command, controller.signal, 5_000);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[output truncated");
    expect(result.stderr).toContain("[output truncated");
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(66_000);
    expect(Buffer.byteLength(result.stderr)).toBeLessThan(34_000);
  });

  test.runIf(process.platform === "win32")("kills descendant processes when a shell command is canceled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supbot-shell-tree-"));
    tempDirs.push(dir);
    const marker = join(dir, "descendant-ran.txt");
    const script = join(dir, "descendant.cjs");
    await writeFile(script, `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 500);\n`, "utf8");
    const command = `& ${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
    const controller = new AbortController();
    const running = runShellCommand(command, controller.signal, 5_000, dir);
    setTimeout(() => controller.abort(), 50);

    await expect(running).rejects.toThrow("canceled");
    await new Promise((resolve) => setTimeout(resolve, 700));
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
