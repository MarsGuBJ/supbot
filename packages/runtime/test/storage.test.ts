import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { createInitialState, JsonFileStorage, TranscriptStore } from "../src";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "supbot-storage-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("JsonFileStorage", () => {
  test("creates the initial state on first load", async () => {
    const dir = await createTempDir();
    const storage = new JsonFileStorage(dir);
    const state = await storage.load();
    expect(state.agentName).toBeTruthy();
    await stat(join(dir, "state.json"));
  });

  test("recovers from the backup when state.json is corrupted", async () => {
    const dir = await createTempDir();
    const storage = new JsonFileStorage(dir);
    const first = createInitialState();
    first.agentName = "first-good";
    await storage.save(first);
    const second = createInitialState();
    second.agentName = "second-good";
    await storage.save(second);
    expect(JSON.parse(await readFile(join(dir, "state.json.bak"), "utf8")).agentName).toBe("first-good");

    await writeFile(join(dir, "state.json"), "{ not json", "utf8");
    const recovered = await storage.load();
    expect(recovered.agentName).toBe("first-good");
    // The recovered state is written back so the next load is clean.
    expect(JSON.parse(await readFile(join(dir, "state.json"), "utf8")).agentName).toBe("first-good");
  });

  test("rethrows when both state.json and the backup are unreadable", async () => {
    const dir = await createTempDir();
    const storage = new JsonFileStorage(dir);
    await storage.save(createInitialState());
    await writeFile(join(dir, "state.json"), "{ not json", "utf8");
    await writeFile(join(dir, "state.json.bak"), "{ also not json", "utf8");
    await expect(storage.load()).rejects.toThrow();
  });

  test("keeps the write queue usable after a failed save", async () => {
    const dir = await createTempDir();
    const storage = new JsonFileStorage(dir);
    // Force the rename step to fail by putting a directory at state.json.
    await mkdir(join(dir, "state.json"));
    await expect(storage.save(createInitialState())).rejects.toThrow();
    await rm(join(dir, "state.json"), { recursive: true, force: true });
    // A previous rejection must not poison later saves.
    await storage.save(createInitialState());
    await stat(join(dir, "state.json"));
  });

  test("persists conversation metadata without duplicating transcript messages", async () => {
    const dir = await createTempDir();
    const storage = new JsonFileStorage(dir);
    const state = createInitialState();
    state.conversations = [
      {
        id: "conv-1",
        title: "Metadata only",
        createdAt: "2026-07-22T00:00:00.000Z",
        updatedAt: "2026-07-22T00:00:00.000Z",
        messages: [
          {
            id: "msg-1",
            conversationId: "conv-1",
            role: "user",
            text: "must live only in the transcript",
            createdAt: "2026-07-22T00:00:00.000Z",
          },
        ],
      },
    ];

    await storage.save(state);
    const persisted = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
    expect(persisted.conversations[0]).not.toHaveProperty("messages");
    const loaded = await storage.load();
    expect(loaded.conversations[0].messages).toEqual([]);
  });
});

describe("TranscriptStore", () => {
  test("deletes the transcript file for a conversation", async () => {
    const dir = await createTempDir();
    const store = new TranscriptStore(dir);
    const message = {
      id: "msg-1",
      conversationId: "conv-1",
      role: "user" as const,
      text: "hello",
      createdAt: new Date().toISOString(),
    };
    await store.append("conv-1", { type: "message", message });
    await stat(store.pathFor("conv-1"));
    await store.delete("conv-1");
    await expect(stat(store.pathFor("conv-1"))).rejects.toThrow();
    // Deleting a missing transcript is a no-op.
    await store.delete("conv-1");
  });

  test("pages older messages without returning duplicate transcript updates", async () => {
    const dir = await createTempDir();
    const store = new TranscriptStore(dir);
    for (let index = 0; index < 120; index += 1) {
      await store.append("conv-1", {
        type: "message",
        message: {
          id: `msg-${index}`,
          conversationId: "conv-1",
          role: index % 2 ? "assistant" : "user",
          text: `message ${index}`,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        },
      });
    }
    await store.append("conv-1", {
      type: "message",
      message: {
        id: "msg-119",
        conversationId: "conv-1",
        role: "assistant",
        text: "updated message 119",
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 2, 0)).toISOString(),
      },
    });

    const latest = await store.loadPage("conv-1", { limit: 50 });
    expect(latest.total).toBe(120);
    expect(latest.hasMore).toBe(true);
    expect(latest.messages).toHaveLength(50);
    expect(latest.messages[0]?.id).toBe("msg-70");
    expect(latest.messages.at(-1)?.text).toBe("updated message 119");

    const older = await store.loadPage("conv-1", { beforeMessageId: "msg-70", limit: 50 });
    expect(older.messages.map((message) => message.id)).toEqual(
      Array.from({ length: 50 }, (_value, index) => `msg-${index + 20}`),
    );
    expect(older.hasMore).toBe(true);
  });
});
