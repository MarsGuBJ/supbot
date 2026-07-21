import { useCallback, useSyncExternalStore } from "react";
import type { ChatMessage, RuntimeSnapshot } from "@supbot/shared";

interface StreamingMessageDelta {
  conversationId: string;
  messageId: string;
  text: string;
}

const streamingMessageDeltas = new Map<string, StreamingMessageDelta>();
const streamingMessageDeltaListeners = new Map<string, Set<() => void>>();

export function appendStreamingMessageDelta(conversationId: string, messageId: string, delta: string): void {
  const key = streamingMessageDeltaKey(conversationId, messageId);
  const current = streamingMessageDeltas.get(key);
  streamingMessageDeltas.set(key, { conversationId, messageId, text: `${current?.text || ""}${delta}` });
  notifyStreamingMessageDelta(key);
}

export function clearStreamingMessageDelta(conversationId: string, messageId: string): void {
  const key = streamingMessageDeltaKey(conversationId, messageId);
  if (streamingMessageDeltas.delete(key)) notifyStreamingMessageDelta(key);
}

export function syncStreamingMessageDelta(message: ChatMessage): void {
  if (message.role !== "assistant" || message.status !== "running") {
    clearStreamingMessageDelta(message.conversationId, message.id);
    return;
  }
  const snapshotText = isAssistantWaitingText(message.text) ? "" : message.text;
  if (!snapshotText) return;
  const key = streamingMessageDeltaKey(message.conversationId, message.id);
  const current = streamingMessageDeltas.get(key);
  if (!current || (snapshotText.length > current.text.length && snapshotText.startsWith(current.text))) {
    streamingMessageDeltas.set(key, { conversationId: message.conversationId, messageId: message.id, text: snapshotText });
    notifyStreamingMessageDelta(key);
  }
}

export function reconcileStreamingMessageDeltas(snapshot: RuntimeSnapshot): void {
  const runningMessageKeys = new Set<string>();
  for (const conversation of snapshot.conversations) {
    for (const message of conversation.messages) {
      if (message.role === "assistant" && message.status === "running") {
        runningMessageKeys.add(streamingMessageDeltaKey(conversation.id, message.id));
        syncStreamingMessageDelta(message);
      }
    }
  }
  for (const [key, delta] of streamingMessageDeltas) {
    if (!runningMessageKeys.has(key)) clearStreamingMessageDelta(delta.conversationId, delta.messageId);
  }
}

export function useStreamingMessageDelta(conversationId: string, messageId: string, enabled: boolean): string | undefined {
  const key = streamingMessageDeltaKey(conversationId, messageId);
  const subscribe = useCallback(
    (listener: () => void) => enabled ? subscribeStreamingMessageDelta(key, listener) : () => undefined,
    [enabled, key]
  );
  const getSnapshot = useCallback(() => enabled ? streamingMessageDeltas.get(key)?.text : undefined, [enabled, key]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function isAssistantWaitingText(text: string): boolean {
  return text === "Supbot is thinking..." || /^@.+ is thinking\.\.\.$/.test(text);
}

function streamingMessageDeltaKey(conversationId: string, messageId: string): string {
  return `${conversationId}\u0000${messageId}`;
}

function notifyStreamingMessageDelta(key: string): void {
  streamingMessageDeltaListeners.get(key)?.forEach((listener) => listener());
}

function subscribeStreamingMessageDelta(key: string, listener: () => void): () => void {
  const listeners = streamingMessageDeltaListeners.get(key) || new Set<() => void>();
  listeners.add(listener);
  streamingMessageDeltaListeners.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) streamingMessageDeltaListeners.delete(key);
  };
}
