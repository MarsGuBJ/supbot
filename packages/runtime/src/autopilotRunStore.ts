import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AutopilotActionRecord, AutopilotEvent, AutopilotRun, AutopilotTask, DataArtifact } from "@supbot/shared";

export class AutopilotRunStore {
  async writeSnapshot(run: AutopilotRun, tasks: AutopilotTask[], artifacts: DataArtifact[]): Promise<void> {
    const path = join(run.projectRoot, ".supbot", "runs", run.id, "state.json");
    await atomicJsonWrite(path, {
      schemaVersion: 2,
      run,
      tasks,
      artifacts,
      savedAt: new Date().toISOString()
    });
  }

  async appendEvent(run: AutopilotRun, event: AutopilotEvent): Promise<void> {
    await appendJsonLine(join(run.projectRoot, ".supbot", "runs", run.id, "events.jsonl"), event);
  }

  async appendAction(run: AutopilotRun, action: AutopilotActionRecord): Promise<void> {
    await appendJsonLine(join(run.projectRoot, ".supbot", "runs", run.id, "actions.jsonl"), action);
  }
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}
