import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { AutopilotRun } from "@supbot/shared";
import { AutopilotRunStore } from "../src/autopilotRunStore";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("AutopilotRunStore", () => {
  test("serializes concurrent snapshots and leaves no colliding temp files", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supbot-run-store-"));
    tempDirs.push(projectRoot);
    const store = new AutopilotRunStore();
    const base: AutopilotRun = {
      schemaVersion: 2,
      id: "run_concurrent",
      projectId: "project_concurrent",
      projectRoot,
      title: "snapshot-0",
      goal: "Persist snapshots",
      status: "running",
      currentStage: "collect",
      writePolicy: {
        mode: "projectSandbox",
        allowedWriteRoots: ["."],
        allowNetwork: true,
        allowMcp: true,
        maxRuntimeMinutes: 120,
        maxTasks: 16,
        maxRetries: 1
      },
      dataSources: [],
      taskIds: [],
      artifactIds: [],
      checkpointIds: [],
      evidence: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };

    await Promise.all(Array.from({ length: 20 }, (_, index) => store.writeSnapshot({
      ...base,
      title: `snapshot-${index}`,
      updatedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`
    }, [], [])));

    const runDir = join(projectRoot, ".supbot", "runs", base.id);
    const saved = JSON.parse(await readFile(join(runDir, "state.json"), "utf8")) as { run: AutopilotRun };
    expect(saved.run.title).toBe("snapshot-19");
    expect((await readdir(runDir)).filter((file) => file.endsWith(".tmp"))).toEqual([]);
  });
});
