import { describe, expect, it } from "vitest";
import type { ChatMessage, GeneratedFile } from "@supbot/shared";
import {
  hasPendingUserQuestion,
  listVisibleGeneratedFiles,
  shouldAnimateRunningStatus,
  shouldShowGeneratedFileInChat,
} from "./chatFormat";

function message(patch: Partial<ChatMessage>): ChatMessage {
  return {
    id: "message-1",
    conversationId: "conversation-1",
    role: "assistant",
    text: "",
    createdAt: "2026-09-05T00:00:00.000Z",
    ...patch,
  };
}

describe("shouldAnimateRunningStatus", () => {
  it("animates while the task is actively running", () => {
    expect(shouldAnimateRunningStatus(message({ status: "running" }))).toBe(true);
  });

  it("stops while waiting for a user answer", () => {
    expect(
      shouldAnimateRunningStatus(
        message({
          status: "running",
          blocks: [
            {
              type: "question",
              questionId: "question-1",
              questions: [{ question: "Continue?", options: [], multiSelect: false }],
              status: "pending",
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("does not animate an interrupted task", () => {
    expect(shouldAnimateRunningStatus(message({ status: "waiting_user" }))).toBe(false);
  });

  it("resumes after the user question is answered", () => {
    expect(
      shouldAnimateRunningStatus(
        message({
          status: "running",
          blocks: [
            {
              type: "question",
              questionId: "question-1",
              questions: [{ question: "Continue?", options: [], multiSelect: false }],
              status: "answered",
            },
          ],
        }),
      ),
    ).toBe(true);
  });
});

describe("hasPendingUserQuestion", () => {
  it("detects pending question blocks", () => {
    expect(
      hasPendingUserQuestion(
        message({
          blocks: [
            {
              type: "question",
              questionId: "question-1",
              questions: [{ question: "Continue?", options: [], multiSelect: false }],
              status: "pending",
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("returns false for completed or missing messages", () => {
    expect(hasPendingUserQuestion(message({ status: "running" }))).toBe(false);
    expect(hasPendingUserQuestion(undefined)).toBe(false);
  });
});

describe("shouldShowGeneratedFileInChat", () => {
  it("shows target deliverables", () => {
    expect(
      shouldShowGeneratedFileInChat({ name: "report.docx", path: "/out/target/report.docx", role: "target" }),
    ).toBe(true);
  });

  it("hides intermediate process files", () => {
    expect(shouldShowGeneratedFileInChat({ name: "draft.md", path: "/out/process/draft.md", role: "process" })).toBe(
      false,
    );
  });

  it("keeps files without a role visible for backward compatibility", () => {
    expect(shouldShowGeneratedFileInChat({ name: "notes.txt", path: "/out/notes.txt" })).toBe(true);
  });

  it("still hides script-type files even when marked as target", () => {
    expect(shouldShowGeneratedFileInChat({ name: "build.py", path: "/out/target/build.py", role: "target" })).toBe(
      false,
    );
  });
});

describe("listVisibleGeneratedFiles", () => {
  function generatedFile(patch: Partial<GeneratedFile>): GeneratedFile {
    return {
      id: "file-1",
      name: "deck.pptx",
      path: "/out/target/deck.pptx",
      size: 1024,
      createdAt: "2026-09-05T00:00:00.000Z",
      ...patch,
    };
  }

  it("deduplicates entries that point to the same file path", () => {
    const files = [
      generatedFile({ id: "file-1" }),
      generatedFile({ id: "file-2" }),
      generatedFile({ id: "file-3" }),
    ];
    const visible = listVisibleGeneratedFiles(files);
    expect(visible).toHaveLength(1);
    expect(visible[0]?.id).toBe("file-1");
  });

  it("keeps distinct files and still filters hidden ones", () => {
    const files = [
      generatedFile({ id: "file-1" }),
      generatedFile({ id: "file-2", name: "notes.md", path: "/out/target/notes.md" }),
      generatedFile({ id: "file-3", name: "draft.md", path: "/out/process/draft.md", role: "process" }),
    ];
    expect(listVisibleGeneratedFiles(files).map((file) => file.id)).toEqual(["file-1", "file-2"]);
  });

  it("handles an empty or missing list", () => {
    expect(listVisibleGeneratedFiles(undefined)).toEqual([]);
    expect(listVisibleGeneratedFiles([])).toEqual([]);
  });
});
