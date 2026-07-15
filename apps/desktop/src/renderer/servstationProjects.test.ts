import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ServstationConversation, ServstationProject } from "@supbot/shared";
import { groupServstationConversations, servstationPromptTarget } from "./servstationProjects";

const projects: ServstationProject[] = [{
  id: "project-1",
  agentInstanceId: "agent-1",
  name: "Project One",
  resourceCount: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
}];

function conversation(id: string, projectId?: string): ServstationConversation {
  return {
    id,
    agentInstanceId: "agent-1",
    projectId,
    title: id,
    runtimeSessionId: `runtime-${id}`,
    jobCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("Server Agent projects", () => {
  it("groups project conversations and keeps missing projects unfiled", () => {
    const groups = groupServstationConversations(projects, [
      conversation("project-conversation", "project-1"),
      conversation("missing-project", "project-missing"),
      conversation("unfiled")
    ]);

    expect(groups[0].conversations.map((item) => item.id)).toEqual(["project-conversation"]);
    expect(groups.at(-1)?.conversations.map((item) => item.id)).toEqual(["missing-project", "unfiled"]);
  });

  it("sends projectId only while creating a project conversation", () => {
    expect(servstationPromptTarget(undefined, "project-1")).toEqual({ projectId: "project-1" });
    expect(servstationPromptTarget("conversation-1", "project-1")).toEqual({ conversationId: "conversation-1" });
  });

  it("keeps project actions and project-scoped sending wired into the Server Agent page", () => {
    const source = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");

    expect(source).toContain('data-testid="server-agent-project-list"');
    expect(source).toContain("server-agent-project-new-conversation-");
    expect(source).toContain("server-agent-project-resources-");
    expect(source).toContain("server-agent-project-rename-");
    expect(source).toContain("servstationPromptTarget(activeConversation?.id, draftConversation ? draftProjectId : undefined)");
  });
});
