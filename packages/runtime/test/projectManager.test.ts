import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveProjectWriteTargetReal } from "../src/projectManager";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("project write target realpath checks", () => {
  test("rejects writes that escape through a directory link", async () => {
    const root = await mkdtemp(join(tmpdir(), "supbot-project-root-"));
    const outside = await mkdtemp(join(tmpdir(), "supbot-project-outside-"));
    tempDirs.push(root, outside);
    const outputs = join(root, "outputs");
    await mkdir(outputs, { recursive: true });
    await symlink(outside, join(outputs, "escape"), process.platform === "win32" ? "junction" : "dir");

    await expect(resolveProjectWriteTargetReal(root, "outputs/escape/result.txt", [outputs]))
      .rejects.toThrow("resolves outside");
  });
});
