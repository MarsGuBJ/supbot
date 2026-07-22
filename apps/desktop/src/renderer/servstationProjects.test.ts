import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ServstationConversation, ServstationProject, ServstationSessionJob } from "@supbot/shared";
import {
  groupServstationConversations,
  servstationJobsForConversation,
  servstationMessagesForConversation,
  servstationPromptTarget,
} from "./servstationProjects";

const projects: ServstationProject[] = [
  {
    id: "project-1",
    agentInstanceId: "agent-1",
    name: "Project One",
    resourceCount: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

function conversation(id: string, projectId?: string): ServstationConversation {
  return {
    id,
    agentInstanceId: "agent-1",
    projectId,
    title: id,
    runtimeSessionId: `runtime-${id}`,
    jobCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("Server Agent projects", () => {
  it("groups project conversations and keeps missing projects unfiled", () => {
    const groups = groupServstationConversations(projects, [
      conversation("project-conversation", "project-1"),
      conversation("missing-project", "project-missing"),
      conversation("unfiled"),
    ]);

    expect(groups[0].conversations.map((item) => item.id)).toEqual(["project-conversation"]);
    expect(groups.at(-1)?.conversations.map((item) => item.id)).toEqual(["missing-project", "unfiled"]);
  });

  it("sends projectId only while creating a project conversation", () => {
    expect(servstationPromptTarget(undefined, "project-1")).toEqual({ projectId: "project-1" });
    expect(servstationPromptTarget("conversation-1", "project-1")).toEqual({ conversationId: "conversation-1" });
  });

  it("keeps message jobs scoped to the selected conversation", () => {
    const jobs = [
      { id: "job-history", conversationId: "conversation-history" },
      { id: "job-new", conversationId: "conversation-new" },
    ] as ServstationSessionJob[];

    expect(servstationJobsForConversation(jobs, "conversation-history").map((job) => job.id)).toEqual(["job-history"]);
    expect(servstationJobsForConversation(jobs, "conversation-new").map((job) => job.id)).toEqual(["job-new"]);
  });

  it("keeps new conversations empty until they have jobs", () => {
    const jobs = [{ id: "job-history", conversationId: "conversation-history" }] as ServstationSessionJob[];

    expect(servstationJobsForConversation(jobs, "conversation-empty")).toEqual([]);
    expect(servstationJobsForConversation(jobs)).toEqual([]);
  });

  it("returns only the selected conversation transcript and keeps drafts empty", () => {
    const historyA = {
      ...conversation("conversation-a"),
      messages: [{ id: "message-a", role: "user" as const, text: "history A", createdAt: "2026-01-01T00:00:01.000Z" }],
    };
    const historyB = {
      ...conversation("conversation-b"),
      messages: [{ id: "message-b", role: "agent" as const, text: "history B", createdAt: "2026-01-01T00:00:02.000Z" }],
    };

    expect(
      servstationMessagesForConversation([historyA, historyB], historyA.id).map((message) => message.text),
    ).toEqual(["history A"]);
    expect(
      servstationMessagesForConversation([historyA, historyB], historyB.id).map((message) => message.text),
    ).toEqual(["history B"]);
    expect(servstationMessagesForConversation([historyA, historyB])).toEqual([]);
    expect(servstationMessagesForConversation([historyA, historyB], "conversation-new")).toEqual([]);
  });

  it("keeps project actions and project-scoped sending wired into the Server Agent page", () => {
    const source = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
    const messagesStart = source.indexOf("function ServerAgentMessages");
    const messagesEnd = source.indexOf("function ServerAgentProjectGroup");
    const serverAgentMessages = source.slice(messagesStart, messagesEnd);

    expect(source).toContain('data-testid="server-agent-project-list"');
    expect(source).toContain("server-agent-project-new-conversation-");
    expect(source).toContain("server-agent-project-resources-");
    expect(source).toContain("server-agent-project-rename-");
    expect(source).toContain(
      "servstationPromptTarget(activeConversation?.id, draftConversation ? draftProjectId : undefined)",
    );
    expect(source).toContain("servstationMessagesForConversation(remote?.conversations || [], activeConversation?.id)");
    expect(serverAgentMessages).toContain("onContextMenu={openSelectionMenu}");
    expect(serverAgentMessages).toContain('runSelectionAction("copy")');
    expect(serverAgentMessages).not.toContain('runSelectionAction("memory")');
    expect(serverAgentMessages).not.toContain("加入记忆");
    expect(serverAgentMessages).toContain("onContextMenu={openPromptMenu}");
    expect(serverAgentMessages).toContain('runPromptAction("paste")');
  });
});
