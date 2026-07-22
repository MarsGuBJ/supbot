import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CompressOutlined,
  CopyOutlined,
  FileTextOutlined,
  PaperClipOutlined,
  RobotOutlined,
  SendOutlined,
  StarOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { Button, Input, Space, Tag, Tooltip, Typography, message } from "antd";
import type { TextAreaRef } from "antd/es/input/TextArea";
import type { AgentJob, Attachment, Conversation, PendingToolPermission } from "@supbot/shared";
import { buildSlashCommands, conversationTitle, statusLabel } from "@supbot/shared";
import { Virtuoso } from "react-virtuoso";
import { ComposerPermissionPrompt } from "./ComposerPermissionPrompt";
import { MessageBubble } from "./MessageBubble";
import { readClipboardText, selectedTextWithin } from "../lib/clipboard";
import type { PromptContextMenu, SelectionContextMenu } from "../lib/types";

const VirtualMessageList = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div {...props} ref={ref} className={["message-stack", className].filter(Boolean).join(" ")} />
  ),
);
VirtualMessageList.displayName = "VirtualMessageList";

export function ChatPanel({
  conversation,
  attachments,
  setAttachments,
  sending,
  runningJob,
  pendingToolPermissions,
  approveToolPermission,
  denyToolPermission,
  send,
  stopRunning,
  pickAttachments,
  copyLatest,
  copySelectedText,
  addSelectedTextToMemory,
  compactConversation,
  loadTranscript,
  loadOlderMessages,
  hasOlderMessages,
  historyLoading,
  scrollRef,
  onMessageScroll,
  t,
  slashCommands,
}: {
  conversation?: Conversation;
  attachments: Attachment[];
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  sending: boolean;
  runningJob?: AgentJob;
  pendingToolPermissions: PendingToolPermission[];
  approveToolPermission: (id: string) => Promise<void>;
  denyToolPermission: (id: string) => Promise<void>;
  send: (text: string) => Promise<boolean>;
  stopRunning: () => void;
  pickAttachments: () => void;
  copyLatest: () => void;
  copySelectedText: (text: string) => Promise<void>;
  addSelectedTextToMemory: (text: string) => Promise<void>;
  compactConversation: () => void;
  loadTranscript: () => void;
  loadOlderMessages: () => Promise<void>;
  hasOlderMessages: boolean;
  historyLoading: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onMessageScroll: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  slashCommands: ReturnType<typeof buildSlashCommands>;
}) {
  const selectionMenuRef = useRef<HTMLDivElement | null>(null);
  const promptMenuRef = useRef<HTMLDivElement | null>(null);
  const promptInputRef = useRef<TextAreaRef | null>(null);
  const [selectionMenu, setSelectionMenu] = useState<SelectionContextMenu | null>(null);
  const [selectionAction, setSelectionAction] = useState<"copy" | "memory" | null>(null);
  const [promptMenu, setPromptMenu] = useState<PromptContextMenu | null>(null);
  const [promptAction, setPromptAction] = useState<"copy" | "paste" | null>(null);
  const [prompt, setPrompt] = useState("");
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const conversationDraftsRef = useRef(new Map<string, string>());
  const previousConversationIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const previousId = previousConversationIdRef.current;
    const nextId = conversation?.id;
    if (previousId === nextId) {
      return;
    }
    if (previousId) {
      conversationDraftsRef.current.set(previousId, promptRef.current);
    }
    previousConversationIdRef.current = nextId;
    setPrompt(nextId ? conversationDraftsRef.current.get(nextId) || "" : "");
  }, [conversation?.id]);
  const handleSend = useCallback(async () => {
    const text = prompt.trim();
    if (!text) {
      return;
    }
    setPrompt("");
    const sent = await send(text);
    if (!sent) {
      setPrompt(text);
    }
  }, [prompt, send]);
  const filteredCommands = useMemo(() => {
    if (!prompt.startsWith("/")) {
      return [];
    }
    const query = prompt.trim().toLowerCase();
    return slashCommands.filter((item) => item.command.startsWith(query));
  }, [prompt, slashCommands]);
  const composerPermissions = useMemo(() => {
    const conversationId = conversation?.id || "";
    return pendingToolPermissions.filter((permission) => {
      if (conversationId && permission.conversationId === conversationId) {
        return true;
      }
      if (runningJob && (permission.jobId === runningJob.id || permission.jobId.startsWith(`${runningJob.id}:`))) {
        return true;
      }
      return !conversationId;
    });
  }, [conversation?.id, pendingToolPermissions, runningJob]);

  const closeSelectionMenu = useCallback(() => setSelectionMenu(null), []);
  const closePromptMenu = useCallback(() => setPromptMenu(null), []);

  const openSelectionMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const text = selectedTextWithin(event.currentTarget);
    if (!text) {
      setSelectionMenu(null);
      return;
    }
    event.preventDefault();
    const menuWidth = 176;
    const menuHeight = 92;
    setSelectionMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
      text,
    });
  }, []);

  const openPromptMenu = useCallback(
    (event: React.MouseEvent<HTMLTextAreaElement>) => {
      event.preventDefault();
      closeSelectionMenu();
      const target = event.currentTarget;
      const selectionStart = target.selectionStart ?? prompt.length;
      const selectionEnd = target.selectionEnd ?? selectionStart;
      const start = Math.min(selectionStart, selectionEnd);
      const end = Math.max(selectionStart, selectionEnd);
      const menuWidth = 176;
      const menuHeight = 92;
      setPromptMenu({
        x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
        y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
        selectionStart: start,
        selectionEnd: end,
        selectedText: prompt.slice(start, end),
      });
    },
    [closeSelectionMenu, prompt],
  );

  const handleMessageScroll = useCallback(() => {
    closeSelectionMenu();
    onMessageScroll();
  }, [closeSelectionMenu, onMessageScroll]);

  const runSelectionAction = useCallback(
    async (action: "copy" | "memory") => {
      if (!selectionMenu) {
        return;
      }
      setSelectionAction(action);
      try {
        if (action === "copy") {
          await copySelectedText(selectionMenu.text);
        } else {
          await addSelectedTextToMemory(selectionMenu.text);
        }
        closeSelectionMenu();
      } finally {
        setSelectionAction(null);
      }
    },
    [addSelectedTextToMemory, closeSelectionMenu, copySelectedText, selectionMenu],
  );

  const runPromptAction = useCallback(
    async (action: "copy" | "paste") => {
      if (!promptMenu) {
        return;
      }
      setPromptAction(action);
      try {
        if (action === "copy") {
          if (promptMenu.selectedText) {
            await copySelectedText(promptMenu.selectedText);
          }
          closePromptMenu();
          return;
        }
        const clipboardText = await readClipboardText();
        const nextPrompt = `${prompt.slice(0, promptMenu.selectionStart)}${clipboardText}${prompt.slice(promptMenu.selectionEnd)}`;
        const caret = promptMenu.selectionStart + clipboardText.length;
        setPrompt(nextPrompt);
        closePromptMenu();
        window.requestAnimationFrame(() => {
          const textarea = promptInputRef.current?.resizableTextArea?.textArea;
          textarea?.focus();
          textarea?.setSelectionRange(caret, caret);
        });
        message.success(t("已粘贴剪贴板内容。"));
      } catch (error) {
        message.error((error as Error).message);
      } finally {
        setPromptAction(null);
      }
    },
    [closePromptMenu, copySelectedText, prompt, promptMenu, setPrompt, t],
  );

  useEffect(() => {
    if (!selectionMenu) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (selectionMenuRef.current?.contains(event.target as Node)) {
        return;
      }
      closeSelectionMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeSelectionMenu();
      }
    };
    const onSelectionChange = () => {
      const stream = scrollRef.current;
      if (!stream || !selectedTextWithin(stream)) {
        closeSelectionMenu();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [closeSelectionMenu, scrollRef, selectionMenu]);

  useEffect(() => {
    if (!promptMenu) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (promptMenuRef.current?.contains(event.target as Node)) {
        return;
      }
      closePromptMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closePromptMenu();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [closePromptMenu, promptMenu]);

  useEffect(() => {
    const stream = scrollRef.current;
    if (!stream) {
      return;
    }
    const pin = () => {
      stream.scrollTop = Math.max(0, stream.scrollHeight - stream.clientHeight);
    };
    const frame = window.requestAnimationFrame(pin);
    const timer = window.setTimeout(pin, 80);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [conversation?.id, scrollRef]);

  const messages = conversation?.messages || [];
  const firstItemIndex = Math.max(0, (conversation?.messageCount || messages.length) - messages.length);
  const virtuosoComponents = useMemo(
    () => ({
      List: VirtualMessageList,
      Header: () => (
        <div className="history-page-status" aria-live="polite">
          {historyLoading ? <span className="history-page-spinner" /> : null}
        </div>
      ),
    }),
    [historyLoading],
  );

  return (
    <section className="chat-panel">
      <div className="chat-banner">
        <div>
          <div className="chat-banner-label">{t("Conversation")}</div>
          <div className="chat-banner-text">
            {conversation ? conversationTitle(conversation, t("New conversation")) : t("No conversation yet")}
          </div>
        </div>
        <Space>
          <Tooltip title={t("Compact conversation")}>
            <Button
              icon={<CompressOutlined />}
              onClick={compactConversation}
              disabled={!conversation?.messages.length}
            />
          </Tooltip>
          <Tooltip title={t("Load transcript")}>
            <Button icon={<FileTextOutlined />} onClick={loadTranscript} disabled={!conversation} />
          </Tooltip>
          <Tooltip title={t("Copy latest response")}>
            <Button icon={<CopyOutlined />} onClick={copyLatest} />
          </Tooltip>
          {runningJob ? (
            <Tag color="cyan">
              <ClockCircleOutlined /> {statusLabel(runningJob.status, t)}
            </Tag>
          ) : (
            <Tag color="green">
              <CheckCircleOutlined /> {t("Ready")}
            </Tag>
          )}
        </Space>
      </div>
      {!conversation || messages.length === 0 ? (
        <div className="message-stream" ref={scrollRef} onContextMenu={openSelectionMenu}>
          <div className="message-stack">
            <div className="chat-empty">
              <div className="brand-mark">
                <RobotOutlined />
              </div>
              <Typography.Title level={3}>{t("HBClient is ready")}</Typography.Title>
              <p className="muted">
                {t("Ask a question, attach local files, use /commands, or mention @research and @builder.")}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <Virtuoso
          className="message-stream"
          data={messages}
          firstItemIndex={firstItemIndex}
          followOutput={(atBottom) => (atBottom ? "smooth" : false)}
          components={virtuosoComponents}
          computeItemKey={(_index, item) => item.id}
          itemContent={(_index, item) => <MessageBubble message={item} t={t} />}
          startReached={() => {
            if (hasOlderMessages && !historyLoading) {
              void loadOlderMessages();
            }
          }}
          scrollerRef={(element) => {
            scrollRef.current = element instanceof HTMLDivElement ? element : null;
          }}
          onScroll={handleMessageScroll}
          onContextMenu={openSelectionMenu}
        />
      )}
      {selectionMenu ? (
        <div
          ref={selectionMenuRef}
          className="selection-context-menu"
          style={{ left: selectionMenu.x, top: selectionMenu.y }}
          role="menu"
          aria-label={t("选中文本操作")}
        >
          <button
            type="button"
            role="menuitem"
            disabled={Boolean(selectionAction)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void runSelectionAction("copy")}
          >
            <CopyOutlined />
            <span>{t("复制")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={Boolean(selectionAction)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void runSelectionAction("memory")}
          >
            <StarOutlined />
            <span>{t("加入记忆")}</span>
          </button>
        </div>
      ) : null}
      {promptMenu ? (
        <div
          ref={promptMenuRef}
          className="selection-context-menu"
          style={{ left: promptMenu.x, top: promptMenu.y }}
          role="menu"
          aria-label={t("提示词输入框操作")}
        >
          <button
            type="button"
            role="menuitem"
            disabled={!promptMenu.selectedText || Boolean(promptAction)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void runPromptAction("copy")}
          >
            <CopyOutlined />
            <span>{t("复制")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={Boolean(promptAction)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void runPromptAction("paste")}
          >
            <FileTextOutlined />
            <span>{t("粘贴")}</span>
          </button>
        </div>
      ) : null}
      <div className="composer">
        <ComposerPermissionPrompt
          permissions={composerPermissions}
          approveToolPermission={approveToolPermission}
          denyToolPermission={denyToolPermission}
          t={t}
        />
        {attachments.length ? (
          <div className="attachment-row">
            {attachments.map((attachment) => (
              <Tag
                key={attachment.id}
                closable
                onClose={() => setAttachments((items) => items.filter((item) => item.id !== attachment.id))}
              >
                <PaperClipOutlined /> {attachment.name}
              </Tag>
            ))}
          </div>
        ) : null}
        <div className="composer-body">
          <Tooltip title={t("Attach files")}>
            <Button icon={<PaperClipOutlined />} onClick={pickAttachments} />
          </Tooltip>
          <div className="composer-input-shell">
            <Input.TextArea
              ref={promptInputRef}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onContextMenu={openPromptMenu}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (runningJob) {
                    void stopRunning();
                  } else {
                    void handleSend();
                  }
                }
              }}
              autoSize={{ minRows: 2, maxRows: 6 }}
              placeholder={t("Message HBClient, use /config, or mention @research...")}
            />
            {filteredCommands.length ? (
              <div className="slash-menu">
                {filteredCommands.map((command) => (
                  <button
                    key={command.command}
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setPrompt(command.command)}
                  >
                    <span className="mono">{command.command}</span>
                    <span>
                      <strong>{command.title}</strong>
                      <small>{command.description}</small>
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <Button
            type="primary"
            icon={runningJob ? <StopOutlined /> : <SendOutlined />}
            loading={sending}
            danger={Boolean(runningJob)}
            onClick={runningJob ? stopRunning : () => void handleSend()}
          >
            {runningJob ? t("Stop") : t("Send")}
          </Button>
        </div>
      </div>
    </section>
  );
}
