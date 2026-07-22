import type {
  ServstationConversation,
  ServstationConversationMessage,
  ServstationProject,
  ServstationSessionJob,
} from "@supbot/shared";

export interface ServstationConversationGroup {
  key: string;
  project?: ServstationProject;
  conversations: ServstationConversation[];
}

export function groupServstationConversations(
  projects: ServstationProject[],
  conversations: ServstationConversation[],
): ServstationConversationGroup[] {
  const projectIds = new Set(projects.map((project) => project.id));
  const conversationsByProject = new Map<string, ServstationConversation[]>();
  for (const conversation of conversations) {
    const projectId = conversation.projectId && projectIds.has(conversation.projectId) ? conversation.projectId : "";
    const group = conversationsByProject.get(projectId);
    if (group) {
      group.push(conversation);
    } else {
      conversationsByProject.set(projectId, [conversation]);
    }
  }
  return [
    ...projects.map((project) => ({
      key: project.id,
      project,
      conversations: conversationsByProject.get(project.id) || [],
    })),
    {
      key: "",
      conversations: conversationsByProject.get("") || [],
    },
  ];
}

export function servstationPromptTarget(
  conversationId?: string,
  projectId?: string,
): { conversationId?: string; projectId?: string } {
  if (conversationId) {
    return { conversationId };
  }
  return projectId ? { projectId } : {};
}

export function servstationJobsForConversation(
  jobs: ServstationSessionJob[],
  conversationId?: string,
): ServstationSessionJob[] {
  if (!conversationId) {
    return [];
  }
  return jobs.filter((job) => job.conversationId === conversationId);
}

export function servstationMessagesForConversation(
  conversations: ServstationConversation[],
  conversationId?: string,
): ServstationConversationMessage[] {
  if (!conversationId) {
    return [];
  }
  return conversations.find((conversation) => conversation.id === conversationId)?.messages || [];
}
