import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CompressOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  FileTextOutlined,
  FileSearchOutlined,
  FolderOpenOutlined,
  HistoryOutlined,
  PaperClipOutlined,
  PauseCircleOutlined,
  RobotOutlined,
  SearchOutlined,
  SendOutlined,
  StarOutlined,
  StopOutlined,
  ImportOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import { Popover, Tag, Tooltip, message } from "antd";
import type {
  AgentJob,
  Attachment,
  CapabilityDefinition,
  ChatMessage,
  Conversation,
  ModelProviderConfig,
  PendingToolPermission,
  PermissionMode,
  Project,
  SubagentConfig,
  LocalFileReference,
} from "@supbot/shared";
import { buildSlashCommands, conversationTitle, statusLabel } from "@supbot/shared";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { ComposerPermissionPrompt } from "./ComposerPermissionPrompt";
import { FileTypeIcon } from "./FileTypeIcon";
import { MessageBubble } from "./MessageBubble";
import { readClipboardText, selectedTextWithin } from "../lib/clipboard";
import { filesFromPasteEvent, renamePastedFiles } from "../lib/pastedAttachments";
import type { PromptContextMenu, SelectionContextMenu } from "../lib/types";
import { enabledSkillCapabilities, formatSkillPromptDirective } from "../lib/skills";
import {
  getAtToken,
  getSlashToken,
  mergeMentionSuggestions,
  mergeSlashSuggestions,
  type MentionItem,
  type ProjectFileMatch,
  type SlashSuggestion,
} from "../lib/mentions";
import { hasPendingUserQuestion, shouldShowGeneratedFileInChat } from "../lib/chatFormat";
import {
  enqueuePrompt,
  removeQueuedPrompt,
  restoreQueuedPrompt,
  type PromptQueues,
  type QueuedPrompt,
} from "../lib/promptQueue";

const VirtualMessageList = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div {...props} ref={ref} className={["message-stack", className].filter(Boolean).join(" ")} />
  ),
);
VirtualMessageList.displayName = "VirtualMessageList";

type CornerPopup = "search" | "history" | "files" | null;

const permissionOptions: { value: PermissionMode; titleKey: string; descKey: string }[] = [
  { value: "default", titleKey: "Ask every time", descKey: "Every action that needs confirmation pops up a dialog." },
  {
    value: "acceptEdits",
    titleKey: "Auto-approve routine actions",
    descKey: "Safe, user-specified actions are allowed automatically; only high-impact actions ask.",
  },
  {
    value: "bypassPermissions",
    titleKey: "Bypass all",
    descKey: "Everything is allowed except destructive blocked actions.",
  },
  {
    value: "plan",
    titleKey: "Plan mode",
    descKey: "The agent plans steps first and waits for confirmation before executing.",
  },
];

export function ChatPanel({
  conversation,
  attachments,
  setAttachments,
  sending,
  runningJob,
  waitingJob,
  interruptRunning,
  resumeWaiting,
  discardWaiting,
  pendingToolPermissions,
  approveToolPermission,
  denyToolPermission,
  send,
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
  locateMessageRef,
  onMessageScroll,
  t,
  slashCommands,
  skills,
  subagents,
  projects,
  activeProjectId,
  onSelectProject,
  permissionMode,
  onPermissionModeChange,
  modelProviders,
  activeModelProviderId,
  currentModelLabel,
  onModelProviderChange,
  onOpenModelConfig,
  onOpenFile,
  promptInjection,
  onPromptInjectionConsumed,
}: {
  conversation?: Conversation;
  attachments: Attachment[];
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  sending: boolean;
  runningJob?: AgentJob;
  waitingJob?: AgentJob;
  interruptRunning: () => Promise<boolean>;
  resumeWaiting: () => Promise<void>;
  discardWaiting: () => Promise<void>;
  pendingToolPermissions: PendingToolPermission[];
  approveToolPermission: (id: string) => Promise<void>;
  denyToolPermission: (id: string) => Promise<void>;
  send: (text: string, attachments?: Attachment[]) => Promise<boolean>;
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
  locateMessageRef: React.MutableRefObject<((messageId: string) => void) | null>;
  onMessageScroll: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  slashCommands: ReturnType<typeof buildSlashCommands>;
  skills: CapabilityDefinition[];
  subagents: SubagentConfig[];
  projects: Project[];
  activeProjectId: string;
  onSelectProject: (projectId: string) => void;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  modelProviders: ModelProviderConfig[];
  activeModelProviderId?: string;
  currentModelLabel: string;
  onModelProviderChange: (providerId: string) => void;
  onOpenModelConfig: () => void;
  onOpenSkillView: () => void;
  onOpenFile: (file: LocalFileReference) => void;
  promptInjection?: { text: string; nonce: number };
  onPromptInjectionConsumed?: (nonce: number) => void;
}) {
  const selectionMenuRef = useRef<HTMLDivElement | null>(null);
  const promptMenuRef = useRef<HTMLDivElement | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const cornerRef = useRef<HTMLDivElement | null>(null);
  const permissionRef = useRef<HTMLDivElement | null>(null);
  const [selectionMenu, setSelectionMenu] = useState<SelectionContextMenu | null>(null);
  const [selectionAction, setSelectionAction] = useState<"copy" | "memory" | null>(null);
  const [promptMenu, setPromptMenu] = useState<PromptContextMenu | null>(null);
  const [promptAction, setPromptAction] = useState<"copy" | "paste" | null>(null);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [cornerPopup, setCornerPopup] = useState<CornerPopup>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [prompt, setPrompt] = useState("");
  const [promptQueues, setPromptQueues] = useState<PromptQueues>({});
  const [queueActionId, setQueueActionId] = useState<string | null>(null);
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
    setSearchQuery("");
    setCornerPopup(null);
  }, [conversation?.id]);

  const resizeTextarea = useCallback(() => {
    const textarea = promptInputRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 280)}px`;
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [prompt, resizeTextarea]);

  useEffect(() => {
    if (!promptInjection) {
      return;
    }
    const currentValue = promptRef.current;
    const separator = currentValue && !/\s$/.test(currentValue) ? " " : "";
    const nextPrompt = `${currentValue}${separator}${promptInjection.text}`;
    setPrompt(nextPrompt);
    onPromptInjectionConsumed?.(promptInjection.nonce);
    window.requestAnimationFrame(() => {
      const textArea = promptInputRef.current;
      textArea?.focus();
      textArea?.setSelectionRange(nextPrompt.length, nextPrompt.length);
      resizeTextarea();
    });
  }, [promptInjection, promptInjection?.nonce, onPromptInjectionConsumed, resizeTextarea]);

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

  const currentConversationId = conversation?.id || "";
  const queuedPrompts = promptQueues[currentConversationId] || [];
  const updateQueue = setPromptQueues;
  const queuePrompt = useCallback(() => {
    const text = prompt.trim();
    if (!text || !currentConversationId) {
      return;
    }
    const item: QueuedPrompt = {
      id: `queued-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      text,
      attachments: attachments.map((attachment) => ({ ...attachment })),
    };
    updateQueue(enqueuePrompt(promptQueues, currentConversationId, item));
    setPrompt("");
    setAttachments([]);
  }, [attachments, currentConversationId, prompt, promptQueues, setAttachments, updateQueue]);

  const submitPrompt = useCallback(() => {
    if (runningJob) {
      queuePrompt();
    } else {
      void handleSend();
    }
  }, [handleSend, queuePrompt, runningJob]);

  const [stopping, setStopping] = useState(false);
  const stopRunning = useCallback(async () => {
    if (!runningJob || stopping) {
      return;
    }
    setStopping(true);
    try {
      await interruptRunning();
    } finally {
      setStopping(false);
    }
  }, [interruptRunning, runningJob, stopping]);

  // While a job is executing the composer shows a Stop button; typing a prompt
  // (or the job finishing/failing, which clears runningJob) switches it back to Send.
  const showStopButton = Boolean(runningJob) && !prompt.trim();

  const editQueuedPrompt = useCallback(
    (item: QueuedPrompt) => {
      if (!currentConversationId) {
        return;
      }
      updateQueue(removeQueuedPrompt(promptQueues, currentConversationId, item.id));
      setPrompt(item.text);
      setAttachments(item.attachments.map((attachment) => ({ ...attachment })));
      window.requestAnimationFrame(() => {
        const textarea = promptInputRef.current;
        textarea?.focus();
        textarea?.setSelectionRange(item.text.length, item.text.length);
        resizeTextarea();
      });
    },
    [currentConversationId, promptQueues, resizeTextarea, setAttachments, updateQueue],
  );

  const deleteQueuedPrompt = useCallback(
    (item: QueuedPrompt) => {
      if (currentConversationId) {
        updateQueue(removeQueuedPrompt(promptQueues, currentConversationId, item.id));
      }
    },
    [currentConversationId, promptQueues, updateQueue],
  );

  const insertQueuedPrompt = useCallback(
    async (item: QueuedPrompt) => {
      if (!currentConversationId || queueActionId) {
        return;
      }
      setQueueActionId(item.id);
      updateQueue(removeQueuedPrompt(promptQueues, currentConversationId, item.id));
      try {
        if (runningJob) {
          const interrupted = await interruptRunning();
          if (!interrupted) {
            updateQueue((current) => restoreQueuedPrompt(current, currentConversationId, item));
            return;
          }
        }
        const sent = await send(item.text, item.attachments);
        if (!sent) {
          updateQueue((current) => restoreQueuedPrompt(current, currentConversationId, item));
        }
      } catch {
        updateQueue((current) => restoreQueuedPrompt(current, currentConversationId, item));
      } finally {
        setQueueActionId(null);
      }
    },
    [currentConversationId, interruptRunning, promptQueues, queueActionId, runningJob, send, updateQueue],
  );

  const [dropActive, setDropActive] = useState(false);
  const handleFileDrop = useCallback(
    async (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDropActive(false);
      const files = Array.from(event.dataTransfer.files);
      if (!files.length) {
        return;
      }
      try {
        const imported = await window.supbot.importDroppedAttachments(files);
        if (imported.length) {
          setAttachments((items) => [...items, ...imported]);
        }
      } catch (error) {
        message.error(error instanceof Error ? error.message : t("Failed to attach dropped files."));
      }
    },
    [setAttachments, t],
  );

  const handleFilePaste = useCallback(
    async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = filesFromPasteEvent(event);
      if (!files.length) {
        return;
      }
      event.preventDefault();
      try {
        const imported = await window.supbot.importClipboardAttachments(renamePastedFiles(files));
        if (imported.length) {
          setAttachments((items) => [...items, ...imported]);
        }
      } catch (error) {
        message.error(error instanceof Error ? error.message : t("Failed to attach pasted files."));
      }
    },
    [setAttachments, t],
  );

  const availableSkills = useMemo(() => enabledSkillCapabilities(skills), [skills]);
  const insertSkill = useCallback(
    (skill: CapabilityDefinition) => {
      const directive = formatSkillPromptDirective(skill);
      const textArea = promptInputRef.current;
      const currentValue = textArea?.value ?? prompt;
      const fallbackPosition = currentValue.length;
      const start = Math.max(0, Math.min(textArea?.selectionStart ?? fallbackPosition, currentValue.length));
      const end = Math.max(start, Math.min(textArea?.selectionEnd ?? start, currentValue.length));
      const nextPrompt = `${currentValue.slice(0, start)}${directive}${currentValue.slice(end)}`;
      const caret = start + directive.length;
      setPrompt(nextPrompt);
      setSkillsOpen(false);
      window.requestAnimationFrame(() => {
        const nextTextArea = promptInputRef.current;
        nextTextArea?.focus();
        nextTextArea?.setSelectionRange(caret, caret);
        resizeTextarea();
      });
    },
    [prompt, resizeTextarea],
  );

  // "/" popup: merged built-in commands + skills, triggered by a /token at the caret.
  const slashToken = getSlashToken(prompt, promptInputRef.current?.selectionStart ?? prompt.length);
  const slashSuggestions = slashToken ? mergeSlashSuggestions(slashToken.query, slashCommands, availableSkills) : [];

  const messages = conversation?.messages || [];

  const conversationFiles = useMemo(() => {
    const files: Array<{ key: string; name: string; path: string }> = [];
    // Pending composer attachments are mentionable too, even though they have
    // not been sent into the conversation yet.
    for (const attachment of attachments) {
      if (attachment.path) {
        files.push({ key: `pending-${attachment.id}`, name: attachment.name, path: attachment.path });
      }
    }
    for (const item of messages) {
      for (const file of item.generatedFiles || []) {
        if (!shouldShowGeneratedFileInChat(file)) {
          continue;
        }
        files.push({ key: `gen-${item.id}-${file.name}`, name: file.name, path: file.path });
      }
      for (const attachment of item.attachments || []) {
        if (attachment.path) {
          files.push({ key: `att-${item.id}-${attachment.name}`, name: attachment.name, path: attachment.path });
        }
      }
    }
    return files;
  }, [attachments, messages]);

  // "@" popup: merged subagents + conversation files + debounced project file
  // search, triggered by an @token at the caret.
  const [mentionOpen, setMentionOpen] = useState(false);
  const [projectFileMatches, setProjectFileMatches] = useState<ProjectFileMatch[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const mentionMenuRef = useRef<HTMLDivElement | null>(null);
  const mentionSearchTimerRef = useRef<number | null>(null);
  const mentionRequestRef = useRef(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);

  const mentionQuery = mentionOpen
    ? (getAtToken(prompt, promptInputRef.current?.selectionStart ?? prompt.length)?.query ?? null)
    : null;
  const mentionItems = useMemo(
    () =>
      mentionQuery === null
        ? []
        : mergeMentionSuggestions(mentionQuery, subagents, conversationFiles, projectFileMatches),
    [mentionQuery, subagents, conversationFiles, projectFileMatches],
  );

  const closeMention = useCallback(() => {
    if (mentionSearchTimerRef.current !== null) {
      window.clearTimeout(mentionSearchTimerRef.current);
      mentionSearchTimerRef.current = null;
    }
    mentionRequestRef.current += 1;
    setMentionOpen(false);
    setProjectFileMatches([]);
    setMentionLoading(false);
  }, []);

  useEffect(
    () => () => {
      if (mentionSearchTimerRef.current !== null) {
        window.clearTimeout(mentionSearchTimerRef.current);
      }
    },
    [],
  );

  const refreshMention = useCallback(
    (value: string, caret: number) => {
      if (mentionSearchTimerRef.current !== null) {
        window.clearTimeout(mentionSearchTimerRef.current);
        mentionSearchTimerRef.current = null;
      }
      const token = getAtToken(value, caret);
      if (!token) {
        closeMention();
        return;
      }
      setMentionOpen(true);
      setActiveIndex(0);
      // Subagents and conversation files are listed without a project; the
      // debounced project file search only runs when a project is active.
      if (!activeProjectId) {
        mentionRequestRef.current += 1;
        setProjectFileMatches([]);
        setMentionLoading(false);
        return;
      }
      const query = token.query;
      const requestId = ++mentionRequestRef.current;
      setMentionLoading(true);
      mentionSearchTimerRef.current = window.setTimeout(() => {
        mentionSearchTimerRef.current = null;
        window.supbot
          .searchProjectFiles(activeProjectId, query)
          .then((items) => {
            if (mentionRequestRef.current === requestId) {
              setProjectFileMatches(items);
              setMentionLoading(false);
            }
          })
          .catch(() => {
            if (mentionRequestRef.current === requestId) {
              setProjectFileMatches([]);
              setMentionLoading(false);
            }
          });
      }, 200);
    },
    [activeProjectId, closeMention],
  );

  const applyMentionItem = useCallback(
    async (item: MentionItem) => {
      const textArea = promptInputRef.current;
      const currentValue = textArea?.value ?? prompt;
      const caret = Math.max(0, Math.min(textArea?.selectionStart ?? currentValue.length, currentValue.length));
      const token = getAtToken(currentValue, caret);
      closeMention();
      if (item.kind !== "subagent") {
        // Skip the import when the file is already attached to the composer —
        // re-importing would add a duplicate attachment chip.
        const alreadyAttached = attachments.some((attachment) => attachment.path && attachment.path === item.path);
        if (!alreadyAttached) {
          try {
            const imported = await window.supbot.importAttachmentPaths([item.path]);
            if (imported.length) {
              setAttachments((items) => [...items, ...imported]);
            }
          } catch (error) {
            message.error(error instanceof Error ? error.message : t("Failed to attach file."));
          }
        }
      }
      const insertion = `@${item.name} `;
      const start = token ? token.start : caret;
      const nextPrompt = `${currentValue.slice(0, start)}${insertion}${currentValue.slice(caret)}`;
      const nextCaret = start + insertion.length;
      setPrompt(nextPrompt);
      window.requestAnimationFrame(() => {
        const nextTextArea = promptInputRef.current;
        nextTextArea?.focus();
        nextTextArea?.setSelectionRange(nextCaret, nextCaret);
        resizeTextarea();
      });
    },
    [attachments, closeMention, prompt, resizeTextarea, setAttachments, t],
  );

  const applySlashSuggestion = useCallback(
    (suggestion: SlashSuggestion) => {
      if (suggestion.kind === "command") {
        setPrompt(suggestion.label);
        return;
      }
      const textArea = promptInputRef.current;
      const currentValue = textArea?.value ?? prompt;
      const caret = Math.max(0, Math.min(textArea?.selectionStart ?? currentValue.length, currentValue.length));
      const token = getSlashToken(currentValue, caret);
      const insertion = `${suggestion.label} `;
      const start = token ? token.start : caret;
      const nextPrompt = `${currentValue.slice(0, start)}${insertion}${currentValue.slice(caret)}`;
      const nextCaret = start + insertion.length;
      setPrompt(nextPrompt);
      window.requestAnimationFrame(() => {
        const nextTextArea = promptInputRef.current;
        nextTextArea?.focus();
        nextTextArea?.setSelectionRange(nextCaret, nextCaret);
        resizeTextarea();
      });
    },
    [prompt, resizeTextarea],
  );

  const slashMenuOpen = !slashDismissed && slashSuggestions.length > 0;
  const mentionMenuOpen = mentionOpen;
  const popupCount = mentionMenuOpen ? mentionItems.length : slashSuggestions.length;
  const popupActiveIndex = popupCount ? Math.min(activeIndex, popupCount - 1) : 0;

  useEffect(() => {
    if (!slashMenuOpen && !mentionMenuOpen) {
      return;
    }
    const activeItem = document.querySelector(
      ".input-wrapper .slash-menu button.active, .input-wrapper .mention-menu button.active",
    );
    activeItem?.scrollIntoView({ block: "nearest" });
  }, [popupActiveIndex, slashMenuOpen, mentionMenuOpen]);

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
          const textarea = promptInputRef.current;
          textarea?.focus();
          textarea?.setSelectionRange(caret, caret);
          resizeTextarea();
        });
        message.success(t("已粘贴剪贴板内容。"));
      } catch (error) {
        message.error((error as Error).message);
      } finally {
        setPromptAction(null);
      }
    },
    [closePromptMenu, copySelectedText, prompt, promptMenu, resizeTextarea, t],
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

  const escGuardRef = useRef({ menuOpen: false, interrupt: undefined as (() => Promise<boolean>) | undefined });
  escGuardRef.current = {
    menuOpen: Boolean(selectionMenu || promptMenu || cornerPopup || permissionOpen || mentionOpen || slashMenuOpen),
    interrupt: runningJob ? interruptRunning : undefined,
  };

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (cornerRef.current && !cornerRef.current.contains(event.target as Node)) {
        setCornerPopup(null);
      }
      if (permissionRef.current && !permissionRef.current.contains(event.target as Node)) {
        setPermissionOpen(false);
      }
      const target = event.target as Node;
      if (!mentionMenuRef.current?.contains(target) && !promptInputRef.current?.contains(target)) {
        closeMention();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        const { menuOpen, interrupt } = escGuardRef.current;
        setCornerPopup(null);
        setPermissionOpen(false);
        closeMention();
        // Never interrupt while an antd modal (e.g. config) is open — Esc belongs to the modal.
        const modalOpen = Array.from(document.querySelectorAll(".ant-modal-wrap")).some(
          (element) => (element as HTMLElement).offsetParent !== null,
        );
        if (!menuOpen && !modalOpen && interrupt) {
          void interrupt();
        }
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [closeMention]);

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

  const firstItemIndex = Math.max(0, (conversation?.messageCount || messages.length) - messages.length);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [highlightMessageId, setHighlightMessageId] = useState("");
  useEffect(() => {
    locateMessageRef.current = (messageId: string) => {
      const index = messages.findIndex((item) => item.id === messageId);
      if (index < 0) {
        return;
      }
      virtuosoRef.current?.scrollToIndex({ index, align: "center", behavior: "smooth" });
      setHighlightMessageId(messageId);
    };
    return () => {
      locateMessageRef.current = null;
    };
  }, [locateMessageRef, messages]);
  useEffect(() => {
    if (!highlightMessageId) {
      return;
    }
    const timer = window.setTimeout(() => setHighlightMessageId(""), 2000);
    return () => window.clearTimeout(timer);
  }, [highlightMessageId]);
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
  const skillsContent = (
    <div className="chat-skill-popover">
      <div className="chat-skill-grid" role="list">
        {availableSkills.length ? (
          availableSkills.map((skill) => (
            <button
              className="chat-skill-card"
              key={skill.id}
              type="button"
              role="listitem"
              onClick={() => insertSkill(skill)}
            >
              <ToolOutlined />
              <span>
                <strong>{skill.name}</strong>
                {skill.description ? <small>{skill.description}</small> : null}
              </span>
            </button>
          ))
        ) : (
          <div className="chat-skill-empty">{t("No matching capabilities")}</div>
        )}
      </div>
    </div>
  );

  // Corner popup data
  const searchResults = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return [];
    }
    const results: { message: ChatMessage; snippet: string }[] = [];
    for (const item of messages) {
      const text = item.text || "";
      if (!text.toLowerCase().includes(query)) {
        continue;
      }
      const index = text.toLowerCase().indexOf(query);
      const start = Math.max(0, index - 40);
      const end = Math.min(text.length, index + query.length + 60);
      results.push({
        message: item,
        snippet: `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
      });
    }
    return results.slice(0, 30);
  }, [messages, searchQuery]);

  const userMessages = useMemo(
    () =>
      [...messages]
        .filter((item) => item.role === "user")
        .reverse()
        .slice(0, 20),
    [messages],
  );

  const highlightMatch = (text: string, query: string) => {
    const index = text.toLowerCase().indexOf(query.toLowerCase());
    if (index < 0) {
      return text;
    }
    return (
      <>
        {text.slice(0, index)}
        <mark>{text.slice(index, index + query.length)}</mark>
        {text.slice(index + query.length)}
      </>
    );
  };

  const activePermission = permissionOptions.find((item) => item.value === permissionMode) || permissionOptions[0];
  const modelSelectValue = activeModelProviderId || (modelProviders.length ? "" : "__current__");
  const runningStatusAnimating = Boolean(
    runningJob &&
    runningJob.status === "running" &&
    !messages.some((item) => item.jobId === runningJob.id && item.role === "assistant" && hasPendingUserQuestion(item)),
  );

  return (
    <section className={`chat-panel${!conversation || messages.length === 0 ? " chat-panel--empty" : ""}`}>
      {conversation && messages.length ? (
        <div className="main-corner-toolbar" ref={cornerRef}>
          <Tooltip title={t("Search in conversation")}>
            <button
              type="button"
              className={`main-corner-btn ${cornerPopup === "search" ? "active" : ""}`}
              onClick={() => setCornerPopup(cornerPopup === "search" ? null : "search")}
              aria-label={t("Search in conversation")}
            >
              <SearchOutlined />
            </button>
          </Tooltip>
          <Tooltip title={t("Recent prompts")}>
            <button
              type="button"
              className={`main-corner-btn ${cornerPopup === "history" ? "active" : ""}`}
              onClick={() => setCornerPopup(cornerPopup === "history" ? null : "history")}
              aria-label={t("Recent prompts")}
            >
              <HistoryOutlined />
            </button>
          </Tooltip>
          <Tooltip title={t("Files in conversation")}>
            <button
              type="button"
              className={`main-corner-btn ${cornerPopup === "files" ? "active" : ""}`}
              onClick={() => setCornerPopup(cornerPopup === "files" ? null : "files")}
              aria-label={t("Files in conversation")}
            >
              <FolderOpenOutlined />
            </button>
          </Tooltip>
          <Popover
            title={t("Skills")}
            content={skillsContent}
            trigger="click"
            placement="bottomRight"
            open={skillsOpen}
            onOpenChange={setSkillsOpen}
            overlayClassName="chat-skill-overlay"
          >
            <Tooltip title={t("Skills")}>
              <button type="button" className="main-corner-btn" aria-label={t("Skills")}>
                <ToolOutlined />
              </button>
            </Tooltip>
          </Popover>
          <Tooltip title={t("Compact conversation")}>
            <button
              type="button"
              className="main-corner-btn"
              onClick={compactConversation}
              disabled={!conversation?.messages.length}
              aria-label={t("Compact conversation")}
            >
              <CompressOutlined />
            </button>
          </Tooltip>
          <Tooltip title={t("Load transcript")}>
            <button
              type="button"
              className="main-corner-btn"
              onClick={loadTranscript}
              disabled={!conversation}
              aria-label={t("Load transcript")}
            >
              <FileTextOutlined />
            </button>
          </Tooltip>
          <Tooltip title={t("Copy latest response")}>
            <button
              type="button"
              className="main-corner-btn"
              onClick={copyLatest}
              aria-label={t("Copy latest response")}
            >
              <CopyOutlined />
            </button>
          </Tooltip>
          {runningJob ? (
            <Tag
              className={
                runningStatusAnimating ? "chat-running-status-tag is-running-active" : "chat-running-status-tag"
              }
              color="blue"
            >
              <ClockCircleOutlined /> {statusLabel(runningJob.status, t)}
            </Tag>
          ) : waitingJob ? (
            <Tag color="gold">
              <PauseCircleOutlined /> {statusLabel(waitingJob.status, t)}
            </Tag>
          ) : (
            <Tag color="green">
              <CheckCircleOutlined /> {t("Ready")}
            </Tag>
          )}

          {cornerPopup === "search" ? (
            <div className="main-corner-popup">
              <div className="main-corner-popup-search">
                <SearchOutlined />
                <input
                  type="text"
                  autoFocus
                  value={searchQuery}
                  placeholder={t("Search in the current conversation…")}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
                <button
                  type="button"
                  className="main-corner-popup-close"
                  onClick={() => setCornerPopup(null)}
                  aria-label={t("Close")}
                >
                  ×
                </button>
              </div>
              <div className="main-corner-popup-body">
                {searchResults.map((result) => (
                  <button
                    type="button"
                    className="corner-search-result"
                    key={result.message.id}
                    onClick={() => {
                      locateMessageRef.current?.(result.message.id);
                      setCornerPopup(null);
                    }}
                  >
                    <div className="corner-search-result-title">
                      {result.message.role === "user" ? t("You") : t("HyBot")}:{" "}
                      {(result.message.text || "").slice(0, 40)}
                    </div>
                    <div className="corner-search-result-snippet">{highlightMatch(result.snippet, searchQuery)}</div>
                  </button>
                ))}
                {searchQuery && !searchResults.length ? (
                  <div className="main-corner-popup-empty">{t("No matching messages")}</div>
                ) : null}
                {!searchQuery ? (
                  <div className="main-corner-popup-empty">{t("Type keywords to search this conversation.")}</div>
                ) : null}
              </div>
            </div>
          ) : null}

          {cornerPopup === "history" ? (
            <div className="main-corner-popup">
              <div className="main-corner-popup-header">
                <span>{t("Recent prompts")}</span>
                <button
                  type="button"
                  className="main-corner-popup-close"
                  onClick={() => setCornerPopup(null)}
                  aria-label={t("Close")}
                >
                  ×
                </button>
              </div>
              <div className="main-corner-popup-body">
                {userMessages.map((item) => (
                  <button
                    type="button"
                    className="corner-history-item"
                    key={item.id}
                    onClick={() => {
                      locateMessageRef.current?.(item.id);
                      setCornerPopup(null);
                    }}
                  >
                    <span className="corner-history-item-icon">
                      <HistoryOutlined />
                    </span>
                    <span className="corner-history-item-body">
                      <span className="corner-history-item-title">
                        {(item.text || "").slice(0, 80) || t("Empty message")}
                      </span>
                    </span>
                  </button>
                ))}
                {!userMessages.length ? (
                  <div className="main-corner-popup-empty">{t("No prompts in this conversation")}</div>
                ) : null}
              </div>
            </div>
          ) : null}

          {cornerPopup === "files" ? (
            <div className="main-corner-popup">
              <div className="main-corner-popup-header">
                <span>{t("Files in conversation")}</span>
                <button
                  type="button"
                  className="main-corner-popup-close"
                  onClick={() => setCornerPopup(null)}
                  aria-label={t("Close")}
                >
                  ×
                </button>
              </div>
              <div className="main-corner-popup-body">
                {conversationFiles.map((file) => (
                  <button
                    type="button"
                    className="corner-file-item"
                    key={file.key}
                    onClick={() => {
                      if (file.path) {
                        onOpenFile({ path: file.path, name: file.name });
                      }
                    }}
                    disabled={!file.path}
                  >
                    <FileSearchOutlined />
                    <span>{file.name}</span>
                  </button>
                ))}
                {!conversationFiles.length ? (
                  <div className="main-corner-popup-empty">{t("No files in this conversation")}</div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="chat-title-bar">
        <strong>{conversation ? conversationTitle(conversation, t("New conversation")) : t("New conversation")}</strong>
      </div>

      {!conversation || messages.length === 0 ? (
        <div className="message-stream" ref={scrollRef} onContextMenu={openSelectionMenu}>
          <div className="message-stack">
            <div className="main-hero" id="mainHero">
              <div className="main-hero-logo">
                <RobotOutlined />
              </div>
              <h1>{t("Hi, let's get started")}</h1>
              <p className="main-hero-sub">
                {t(
                  "I can help you solve problems, manage your computer, create and run skills, and keep growing with long-term memory.",
                )}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <Virtuoso
          ref={virtuosoRef}
          className="message-stream"
          data={messages}
          firstItemIndex={firstItemIndex}
          followOutput={(atBottom) => (atBottom ? "smooth" : false)}
          components={virtuosoComponents}
          computeItemKey={(_index, item) => item.id}
          itemContent={(_index, item) => (
            <MessageBubble
              message={item}
              highlighted={item.id === highlightMessageId}
              t={t}
              onOpenFile={onOpenFile}
              knownFiles={conversationFiles}
            />
          )}
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
      <div
        className={`input-bar ${dropActive ? "is-drop-target" : ""}`}
        onDragEnter={(event) => {
          if (event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
            setDropActive(true);
          }
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDropActive(false);
          }
        }}
        onDrop={(event) => void handleFileDrop(event)}
      >
        {queuedPrompts.length ? (
          <div className="prompt-queue" aria-label={t("Queued prompts")}>
            <div className="prompt-queue-header">
              <span>{t("Queued prompts")}</span>
              <span className="prompt-queue-count">{queuedPrompts.length}</span>
            </div>
            <div className="prompt-queue-list">
              {queuedPrompts.map((item) => {
                const actionBusy = queueActionId === item.id;
                return (
                  <div className="prompt-queue-item" key={item.id}>
                    <span className="prompt-queue-text" title={item.text}>
                      {item.text}
                    </span>
                    <span className="prompt-queue-actions">
                      <Tooltip title={t("Insert queued prompt")}>
                        <button
                          type="button"
                          className="prompt-queue-action"
                          aria-label={t("Insert queued prompt")}
                          disabled={Boolean(queueActionId)}
                          onClick={() => void insertQueuedPrompt(item)}
                        >
                          <ImportOutlined />
                        </button>
                      </Tooltip>
                      <Tooltip title={t("Edit queued prompt")}>
                        <button
                          type="button"
                          className="prompt-queue-action"
                          aria-label={t("Edit queued prompt")}
                          disabled={Boolean(queueActionId) || actionBusy}
                          onClick={() => editQueuedPrompt(item)}
                        >
                          <EditOutlined />
                        </button>
                      </Tooltip>
                      <Tooltip title={t("Delete queued prompt")}>
                        <button
                          type="button"
                          className="prompt-queue-action danger"
                          aria-label={t("Delete queued prompt")}
                          disabled={Boolean(queueActionId) || actionBusy}
                          onClick={() => deleteQueuedPrompt(item)}
                        >
                          <DeleteOutlined />
                        </button>
                      </Tooltip>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
        {waitingJob ? (
          <div className="waiting-bar" role="status">
            <span className="waiting-bar-text">
              <PauseCircleOutlined /> {t("Run interrupted — waiting for your input")}
            </span>
            <span className="waiting-bar-actions">
              <button type="button" className="waiting-bar-btn primary" onClick={() => void resumeWaiting()}>
                {t("Resume")}
              </button>
              <button type="button" className="waiting-bar-btn" onClick={() => void discardWaiting()}>
                {t("Discard")}
              </button>
            </span>
          </div>
        ) : null}
        <ComposerPermissionPrompt
          permissions={composerPermissions}
          approveToolPermission={approveToolPermission}
          denyToolPermission={denyToolPermission}
          t={t}
        />
        {attachments.length ? (
          <div className="attach-strip">
            {attachments.map((attachment) => (
              <span className="attach-chip" key={attachment.id}>
                <PaperClipOutlined /> {attachment.name}
                <button
                  type="button"
                  aria-label={t("Remove attachment")}
                  onClick={() => setAttachments((items) => items.filter((item) => item.id !== attachment.id))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="input-wrapper">
          <textarea
            ref={promptInputRef}
            value={prompt}
            rows={1}
            placeholder={t(
              "What can I help you with today? @ to reference files and experts, / for skills and commands",
            )}
            onChange={(event) => {
              setPrompt(event.target.value);
              setSlashDismissed(false);
              refreshMention(event.target.value, event.target.selectionStart ?? event.target.value.length);
            }}
            onClick={(event) =>
              refreshMention(event.currentTarget.value, event.currentTarget.selectionStart ?? prompt.length)
            }
            onPaste={(event) => void handleFilePaste(event)}
            onContextMenu={openPromptMenu}
            onKeyDown={(event) => {
              if (slashMenuOpen || mentionMenuOpen) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActiveIndex((index) => (popupCount ? (index + 1) % popupCount : 0));
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveIndex((index) => (popupCount ? (index - 1 + popupCount) % popupCount : 0));
                  return;
                }
                if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
                  if (popupCount) {
                    event.preventDefault();
                    if (mentionMenuOpen) {
                      void applyMentionItem(mentionItems[popupActiveIndex]);
                    } else {
                      applySlashSuggestion(slashSuggestions[popupActiveIndex]);
                    }
                  }
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  closeMention();
                  setSlashDismissed(true);
                  return;
                }
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submitPrompt();
              }
            }}
          />
          {slashMenuOpen ? (
            <div className="slash-menu">
              {slashSuggestions.map((suggestion, index) => (
                <button
                  key={suggestion.key}
                  type="button"
                  className={index === popupActiveIndex && !mentionMenuOpen ? "active" : ""}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => applySlashSuggestion(suggestion)}
                >
                  <span className="mono">{suggestion.label}</span>
                  <span>
                    <strong>{suggestion.title}</strong>
                    <small>{suggestion.description}</small>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          {mentionMenuOpen ? (
            <div className="mention-menu" ref={mentionMenuRef}>
              {mentionItems.length ? (
                mentionItems.map((item, index) => (
                  <button
                    key={item.key}
                    type="button"
                    className={index === popupActiveIndex ? "active" : ""}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => void applyMentionItem(item)}
                  >
                    {item.kind === "subagent" ? <RobotOutlined /> : <FileTypeIcon name={item.name} />}
                    <span>
                      <strong>{item.kind === "subagent" ? `@${item.name}` : item.name}</strong>
                      <small>{item.kind === "subagent" ? item.description : item.relativePath}</small>
                    </span>
                  </button>
                ))
              ) : mentionLoading ? (
                <div className="mention-menu-status">{t("Searching files…")}</div>
              ) : (
                <div className="mention-menu-status">{t("No matches")}</div>
              )}
            </div>
          ) : null}
          <div className="input-footer">
            <div className="input-footer-left">
              <Tooltip title={t("Attach files")}>
                <button type="button" className="attach-btn" onClick={pickAttachments} aria-label={t("Attach files")}>
                  <PaperClipOutlined />
                </button>
              </Tooltip>
              <div className="project-selector">
                <select
                  value={activeProjectId}
                  aria-label={t("Choose project")}
                  onChange={(event) => onSelectProject(event.target.value)}
                >
                  <option value="">{t("No project")}</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id} disabled={project.status === "archived"}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="permission-selector permission-dropdown" ref={permissionRef}>
                <button
                  type="button"
                  className="permission-dropdown-trigger"
                  onClick={() => setPermissionOpen((value) => !value)}
                  aria-expanded={permissionOpen}
                >
                  <span>{t(activePermission.titleKey)}</span>
                </button>
                {permissionOpen ? (
                  <div className="permission-dropdown-menu">
                    {permissionOptions.map((option) => (
                      <button
                        type="button"
                        className={`permission-option ${option.value === permissionMode ? "selected" : ""}`}
                        key={option.value}
                        onClick={() => {
                          onPermissionModeChange(option.value);
                          setPermissionOpen(false);
                        }}
                      >
                        <span className="permission-option-info">
                          <span className="permission-option-title">
                            {t(option.titleKey)}
                            {option.value === permissionMode ? (
                              <span className="permission-option-check">✓</span>
                            ) : null}
                          </span>
                          <span className="permission-option-desc">{t(option.descKey)}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
            <div className="input-footer-right">
              <div className="model-selector">
                <select
                  value={modelSelectValue}
                  aria-label={t("Choose model")}
                  onChange={(event) => {
                    if (event.target.value === "__custom__") {
                      onOpenModelConfig();
                      return;
                    }
                    onModelProviderChange(event.target.value);
                  }}
                >
                  {!activeModelProviderId ? (
                    <option value="__current__" disabled>
                      {currentModelLabel}
                    </option>
                  ) : null}
                  {modelProviders.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.providerName} / {provider.model}
                    </option>
                  ))}
                  <option value="__custom__">{t("Configure custom model…")}</option>
                </select>
              </div>
              {showStopButton ? (
                <Tooltip title={t("Stop")}>
                  <button
                    type="button"
                    className="send-btn is-stop"
                    disabled={stopping}
                    aria-label={t("Stop")}
                    onClick={() => void stopRunning()}
                  >
                    <StopOutlined />
                  </button>
                </Tooltip>
              ) : (
                <Tooltip title={runningJob ? t("Submit prompt") : t("Send")}>
                  <button
                    type="button"
                    className="send-btn"
                    disabled={!prompt.trim() || sending}
                    aria-label={runningJob ? t("Submit prompt") : t("Send")}
                    onClick={submitPrompt}
                  >
                    <SendOutlined />
                  </button>
                </Tooltip>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
