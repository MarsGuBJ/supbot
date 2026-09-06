import type { Attachment } from "@supbot/shared";

export interface QueuedPrompt {
  id: string;
  text: string;
  attachments: Attachment[];
}

export type PromptQueues = Record<string, QueuedPrompt[]>;

export function enqueuePrompt(queues: PromptQueues, conversationId: string, item: QueuedPrompt): PromptQueues {
  return {
    ...queues,
    [conversationId]: [...(queues[conversationId] || []), item],
  };
}

export function removeQueuedPrompt(queues: PromptQueues, conversationId: string, id: string): PromptQueues {
  const current = queues[conversationId] || [];
  const next = current.filter((item) => item.id !== id);
  if (next.length === current.length) {
    return queues;
  }
  const result = { ...queues };
  if (next.length) {
    result[conversationId] = next;
  } else {
    delete result[conversationId];
  }
  return result;
}

export function restoreQueuedPrompt(queues: PromptQueues, conversationId: string, item: QueuedPrompt): PromptQueues {
  return {
    ...queues,
    [conversationId]: [item, ...(queues[conversationId] || [])],
  };
}
