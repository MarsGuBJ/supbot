import { randomBytes } from "node:crypto";
import { appendFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AutopilotActionRecord, AutopilotEvent, AutopilotRun, AutopilotTask, DataArtifact } from "@supbot/shared";

export class AutopilotRunStore {
  private readonly writeQueues = new Map<string, Promise<void>>();

  async writeSnapshot(run: AutopilotRun, tasks: AutopilotTask[], artifacts: DataArtifact[]): Promise<void> {
    const path = join(run.projectRoot, ".supbot", "runs", run.id, "state.json");
    await this.enqueue(path, () => atomicJsonWrite(path, {
      schemaVersion: 2,
      run,
      tasks,
      artifacts,
      savedAt: new Date().toISOString()
    }));
  }

  async appendEvent(run: AutopilotRun, event: AutopilotEvent): Promise<void> {
    const path = join(run.projectRoot, ".supbot", "runs", run.id, "events.jsonl");
    await this.enqueue(path, () => appendJsonLine(path, event));
  }

  async appendAction(run: AutopilotRun, action: AutopilotActionRecord): Promise<void> {
    const path = join(run.projectRoot, ".supbot", "runs", run.id, "actions.jsonl");
    await this.enqueue(path, () => appendJsonLine(path, action));
  }

  private enqueue(path: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.writeQueues.get(path) || Promise.resolve();
    let next: Promise<void>;
    next = previous.catch(() => undefined).then(operation).finally(() => {
      if (this.writeQueues.get(path) === next) {
        this.writeQueues.delete(path);
      }
    });
    this.writeQueues.set(path, next);
    return next;
  }
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}
