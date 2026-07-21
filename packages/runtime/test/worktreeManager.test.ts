import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runGit } from "../src/worktreeManager";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runGit", () => {
  test("disables interactive credential prompts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supbot-git-env-"));
    tempDirs.push(dir);
    const script = join(dir, "env.cjs");
    await writeFile(script, "process.stdout.write(`${process.env.GIT_TERMINAL_PROMPT}:${process.env.GCM_INTERACTIVE}`);\n", "utf8");

    const result = await runGit(dir, [script], undefined, 1_000, process.execPath);

    expect(result.stdout).toBe("0:Never");
  });

  test("terminates a command that exceeds the configured timeout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supbot-git-timeout-"));
    tempDirs.push(dir);
    const script = join(dir, "hang.cjs");
    await writeFile(script, "setInterval(() => undefined, 10_000);\n", "utf8");

    await expect(runGit(dir, [script], undefined, 50, process.execPath)).rejects.toThrow("timed out after 50ms");
  });
});
