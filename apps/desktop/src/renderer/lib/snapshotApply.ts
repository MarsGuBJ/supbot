import type {
  AgentJob,
  ChatMessage,
  CompactBoundary,
  MemoryCandidate,
  PendingToolPermission,
  RuntimeEventRecord,
  RuntimeSnapshot,
  ToolCallRecord,
} from "@supbot/shared";

export function applyMessageDelta(
  snapshot: RuntimeSnapshot,
  conversationId: string,
  messageId: string,
  delta: string,
): RuntimeSnapshot {
  return {
    ...snapshot,
    conversations: snapshot.conversations.map((conversation) => {
      if (conversation.id !== conversationId) {
        return conversation;
      }
      if (snapshot.activeConversationId !== conversationId) {
        return conversation;
      }
      return {
        ...conversation,
        messages: conversation.messages.map((message) => {
          if (message.id !== messageId) {
            return message;
          }
          const current = message.text.endsWith("is thinking...") ? "" : message.text;
          const text = `${current}${delta}`;
          return {
            ...message,
            text,
            blocks: [{ type: "message_delta" as const, text }],
          };
        }),
      };
    }),
  };
}

export function applyMessageEvent(
  snapshot: RuntimeSnapshot,
  conversationId: string,
  message: ChatMessage,
): RuntimeSnapshot {
  return {
    ...snapshot,
    conversations: snapshot.conversations.map((conversation) => {
      if (conversation.id !== conversationId) {
        return conversation;
      }
      const existing = conversation.messages.some((item) => item.id === message.id);
      if (snapshot.activeConversationId !== conversationId) {
        return {
          ...conversation,
          messageCount: existing
            ? conversation.messageCount || conversation.messages.length
            : (conversation.messageCount || conversation.messages.length) + 1,
          lastMessagePreview: message.text.replace(/\s+/g, " ").trim().slice(0, 180),
          lastMessageAt: message.createdAt,
          updatedAt: message.createdAt,
        };
      }
      const messages = conversation.messages.some((item) => item.id === message.id)
        ? conversation.messages.map((item) => (item.id === message.id ? message : item))
        : [...conversation.messages, message];
      return {
        ...conversation,
        messages,
        messageCount: existing
          ? conversation.messageCount || messages.length
          : Math.max(conversation.messageCount || 0, messages.length),
        lastMessagePreview: message.text.replace(/\s+/g, " ").trim().slice(0, 180),
        lastMessageAt: message.createdAt,
        updatedAt: message.createdAt,
      };
    }),
  };
}

export function applyJobEvent(snapshot: RuntimeSnapshot, job: AgentJob): RuntimeSnapshot {
  const jobs = snapshot.jobs.some((item) => item.id === job.id)
    ? snapshot.jobs.map((item) => (item.id === job.id ? job : item))
    : [job, ...snapshot.jobs];
  const hasActiveJob = jobs.some((item) => item.status === "running" || item.status === "queued");
  return { ...snapshot, status: hasActiveJob ? "running" : "ready", jobs };
}

export function applyToolProgress(snapshot: RuntimeSnapshot, toolCall: ToolCallRecord): RuntimeSnapshot {
  const traces = snapshot.agentLoopTraces.map((trace) => {
    if (trace.jobId !== toolCall.jobId) {
      return trace;
    }
    const toolCalls = trace.toolCalls.some((item) => item.id === toolCall.id)
      ? trace.toolCalls.map((item) => (item.id === toolCall.id ? toolCall : item))
      : [...trace.toolCalls, toolCall];
    return { ...trace, toolCalls, updatedAt: toolCall.updatedAt };
  });
  const nextTraces = traces.some((trace) => trace.jobId === toolCall.jobId)
    ? traces
    : [
        {
          jobId: toolCall.jobId,
          conversationId: toolCall.conversationId,
          turns: 0,
          toolCalls: [toolCall],
          startedAt: toolCall.createdAt,
          updatedAt: toolCall.updatedAt,
        },
        ...traces,
      ];
  return {
    ...snapshot,
    agentLoopTraces: nextTraces,
  };
}

export function applyPendingPermission(snapshot: RuntimeSnapshot, permission: PendingToolPermission): RuntimeSnapshot {
  const pendingToolPermissions = snapshot.pendingToolPermissions.some((item) => item.id === permission.id)
    ? snapshot.pendingToolPermissions.map((item) => (item.id === permission.id ? permission : item))
    : [permission, ...snapshot.pendingToolPermissions];
  return { ...snapshot, pendingToolPermissions };
}

export function clearPendingPermission(snapshot: RuntimeSnapshot, permission: PendingToolPermission): RuntimeSnapshot {
  return {
    ...snapshot,
    pendingToolPermissions: snapshot.pendingToolPermissions.filter((item) => item.id !== permission.id),
  };
}

export function applyCompactBoundary(snapshot: RuntimeSnapshot, boundary: CompactBoundary): RuntimeSnapshot {
  const compactBoundaries = snapshot.compactBoundaries.some((item) => item.id === boundary.id)
    ? snapshot.compactBoundaries.map((item) => (item.id === boundary.id ? boundary : item))
    : [boundary, ...snapshot.compactBoundaries];
  return { ...snapshot, compactBoundaries };
}

export function applyRuntimeEvent(snapshot: RuntimeSnapshot, event: RuntimeEventRecord): RuntimeSnapshot {
  const runtimeEvents = snapshot.runtimeEvents.some((item) => item.id === event.id)
    ? snapshot.runtimeEvents.map((item) => (item.id === event.id ? event : item))
    : [event, ...snapshot.runtimeEvents].slice(0, 300);
  return { ...snapshot, runtimeEvents };
}

export function applyMemoryCandidate(snapshot: RuntimeSnapshot, candidate: MemoryCandidate): RuntimeSnapshot {
  const candidates = snapshot.memory.candidates.some((item) => item.id === candidate.id)
    ? snapshot.memory.candidates.map((item) => (item.id === candidate.id ? candidate : item))
    : [candidate, ...snapshot.memory.candidates];
  return {
    ...snapshot,
    memory: {
      ...snapshot.memory,
      candidates,
    },
  };
}

export function compareCreatedAt(left: { createdAt: string }, right: { createdAt: string }): number {
  return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
}

export function shouldShowJobRuntimeEvent(event: RuntimeEventRecord, traceToolIds: Set<string>): boolean {
  if (event.kind === "tool_use_start") {
    const id = runtimeEventDataId(event);
    return Boolean(id && !traceToolIds.has(id));
  }
  return jobTimelineRuntimeEventKinds.has(event.kind);
}

export function runtimeEventDataId(event: RuntimeEventRecord): string {
  if (!event.data || typeof event.data !== "object") {
    return "";
  }
  const value = (event.data as { id?: unknown }).id;
  return typeof value === "string" ? value : "";
}

export const jobTimelineRuntimeEventKinds = new Set<RuntimeEventRecord["kind"]>([
  "query_start",
  "compact",
  "permission_timeout",
  "memory_recall",
  "memory_candidate",
  "memory_write",
  "subagent_start",
  "subagent_done",
  "worktree_event",
  "turn_complete",
  "turn_failed",
]);
