import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@supbot/shared";
import { hasPendingUserQuestion, shouldAnimateRunningStatus, shouldShowGeneratedFileInChat } from "./chatFormat";

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
