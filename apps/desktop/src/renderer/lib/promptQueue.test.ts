import { describe, expect, test } from "vitest";
import { enqueuePrompt, removeQueuedPrompt, restoreQueuedPrompt, type PromptQueues } from "./promptQueue";

const item = (id: string) => ({ id, text: id, attachments: [] });

describe("prompt queue", () => {
  test("keeps FIFO order and isolates conversations", () => {
    let queues: PromptQueues = {};
    queues = enqueuePrompt(queues, "a", item("one"));
    queues = enqueuePrompt(queues, "a", item("two"));
    queues = enqueuePrompt(queues, "b", item("other"));
    expect(queues.a?.map((entry) => entry.id)).toEqual(["one", "two"]);
    expect(queues.b?.map((entry) => entry.id)).toEqual(["other"]);
  });

  test("removes only the requested item and restores at the front", () => {
    let queues: PromptQueues = { a: [item("one"), item("two")] };
    queues = removeQueuedPrompt(queues, "a", "two");
    expect(queues.a?.map((entry) => entry.id)).toEqual(["one"]);
    queues = restoreQueuedPrompt(queues, "a", item("retry"));
    expect(queues.a?.map((entry) => entry.id)).toEqual(["retry", "one"]);
  });

  test("keeps attachments attached to the queued prompt", () => {
    const attachment = { id: "file-1", name: "notes.txt", size: 12, path: "C:/notes.txt" };
    const queues = enqueuePrompt({}, "a", { ...item("with-file"), attachments: [attachment] });
    expect(queues.a?.[0].attachments).toEqual([attachment]);
  });
});
