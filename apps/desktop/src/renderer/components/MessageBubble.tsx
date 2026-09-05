import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  CompressOutlined,
  CopyOutlined,
  DownloadOutlined,
  DownOutlined,
  PaperClipOutlined,
  RightOutlined,
  ShareAltOutlined,
  SoundOutlined,
  ThunderboltOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import { Alert, Button, message, Tag, Tooltip } from "antd";
import type { ChatMessage, ChatMessageBlock, GeneratedFile, LocalFileReference } from "@supbot/shared";
import { statusColor, statusLabel } from "@supbot/shared";
import { formatToolPayload, shouldAnimateRunningStatus, shouldShowGeneratedFileInChat } from "../lib/chatFormat";
import { writeClipboardText } from "../lib/clipboard";
import { resolveLocalFileHref } from "../lib/filePreview";
import { QuestionBlock } from "./QuestionBlock";
import { FileTypeIcon } from "./FileTypeIcon";

export const MessageBubble = memo(function MessageBubble({
  message: item,
  highlighted = false,
  t,
  onOpenFile,
  knownFiles: externalKnownFiles = [],
}: {
  message: ChatMessage;
  highlighted?: boolean;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onOpenFile?: (file: LocalFileReference) => void;
  knownFiles?: LocalFileReference[];
}) {
  const visibleGeneratedFiles = item.generatedFiles?.filter(shouldShowGeneratedFileInChat) || [];
  const messageFiles: LocalFileReference[] = [
    ...(item.generatedFiles || []).map((file) => ({ path: file.path, name: file.name, size: file.size })),
    ...(item.attachments || [])
      .filter((attachment): attachment is typeof attachment & { path: string } => Boolean(attachment.path))
      .map((attachment) => ({
        path: attachment.path,
        name: attachment.name,
        size: attachment.size,
        mimeType: attachment.mimeType,
      })),
  ];
  const knownFiles = [...externalKnownFiles, ...messageFiles].filter(
    (file, index, files) => files.findIndex((candidate) => candidate.path === file.path) === index,
  );
  const copyable = (item.role === "user" || item.role === "assistant") && item.text.trim().length > 0;
  const animateRunningStatus = shouldAnimateRunningStatus(item);
  const copyMessage = async () => {
    try {
      await writeClipboardText(item.text);
      message.success(t("Copied message."));
    } catch {
      message.error(t("Copy failed."));
    }
  };
  const downloadGeneratedFile = async (file: GeneratedFile) => {
    try {
      const saved = await window.supbot.downloadFile(file.path, file.name);
      if (saved) {
        message.success(t("File saved."));
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("Download failed."));
    }
  };
  const speakMessage = () => {
    if (!("speechSynthesis" in window)) {
      message.info(t("Read aloud is not supported."));
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(item.text.slice(0, 4000));
    utterance.lang = document.documentElement.lang === "en" ? "en-US" : "zh-CN";
    window.speechSynthesis.speak(utterance);
  };
  const shareMessage = async () => {
    try {
      await writeClipboardText(item.text);
      message.success(t("Copied message."));
    } catch {
      message.error(t("Copy failed."));
    }
  };
  const messageContent = (
    <>
      {copyable ? (
        <Tooltip title={t("Copy message")}>
          <Button
            type="text"
            size="small"
            className="message-copy-btn"
            icon={<CopyOutlined />}
            aria-label={t("Copy message")}
            onClick={() => void copyMessage()}
          />
        </Tooltip>
      ) : null}
      <MessageBlocks message={item} t={t} onOpenFile={onOpenFile} knownFiles={knownFiles} />
      {item.attachments?.length ? (
        <div className="attachment-row">
          {item.attachments.map((attachment) =>
            attachment.path ? (
              <button
                type="button"
                className="attachment-file-link"
                key={attachment.id}
                onClick={() =>
                  onOpenFile?.({
                    path: attachment.path!,
                    name: attachment.name,
                    size: attachment.size,
                    mimeType: attachment.mimeType,
                  })
                }
              >
                <PaperClipOutlined /> {attachment.name}
              </button>
            ) : (
              <Tag key={attachment.id}>
                <PaperClipOutlined /> {attachment.name}
              </Tag>
            ),
          )}
        </div>
      ) : null}
      {visibleGeneratedFiles.length ? (
        <div className="generated-files">
          {visibleGeneratedFiles.map((file) => (
            <span className="generated-file-item" key={file.id}>
              <button
                className="generated-file"
                type="button"
                onClick={() =>
                  onOpenFile
                    ? onOpenFile({ path: file.path, name: file.name, size: file.size })
                    : void window.supbot.openFile(file.path)
                }
              >
                <FileTypeIcon name={file.name} />
                <span className="generated-file-name">{file.name}</span>
                <small className="generated-file-size">{file.size} bytes</small>
              </button>
              <Tooltip title={t("Download")}>
                <Button
                  type="text"
                  size="small"
                  className="generated-file-download"
                  icon={<DownloadOutlined />}
                  aria-label={t("Download")}
                  onClick={() => void downloadGeneratedFile(file)}
                />
              </Tooltip>
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
  if (item.role === "user") {
    return (
      <div className={`message-row ${item.role} ${highlighted ? "is-highlighted" : ""}`}>
        <div className="message-bubble">{messageContent}</div>
        <div className="msg-avatar msg-avatar-user" aria-hidden="true">
          {t("You").charAt(0)}
        </div>
      </div>
    );
  }
  return (
    <div className={`message-row ${item.role} ${highlighted ? "is-highlighted" : ""}`}>
      <div className="msg-avatar msg-avatar-ai" aria-hidden="true">
        Hy
      </div>
      <div className="msg-body">
        <div className="msg-header">
          <span className="msg-header-name">
            {item.role === "assistant" ? "HyBot" : item.role === "tool" ? t("Tool") : t("System")}
          </span>
          {item.status ? (
            <Tag
              className={`message-status-tag${animateRunningStatus ? " is-running-active" : ""}`}
              color={statusColor(item.status)}
            >
              {statusLabel(item.status, t)}
            </Tag>
          ) : null}
        </div>
        <div className="message-bubble">{messageContent}</div>
        {copyable ? (
          <div className="msg-actions">
            <Tooltip title={t("Copy message")}>
              <button
                type="button"
                className="msg-action-icon"
                aria-label={t("Copy message")}
                onClick={() => void copyMessage()}
              >
                <CopyOutlined />
              </button>
            </Tooltip>
            <Tooltip title={t("Read aloud")}>
              <button type="button" className="msg-action-icon" aria-label={t("Read aloud")} onClick={speakMessage}>
                <SoundOutlined />
              </button>
            </Tooltip>
            <Tooltip title={t("Share")}>
              <button
                type="button"
                className="msg-action-icon"
                aria-label={t("Share")}
                onClick={() => void shareMessage()}
              >
                <ShareAltOutlined />
              </button>
            </Tooltip>
          </div>
        ) : null}
      </div>
    </div>
  );
});

export function MessageBlocks({
  message,
  t,
  onOpenFile,
  knownFiles,
}: {
  message: ChatMessage;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onOpenFile?: (file: LocalFileReference) => void;
  knownFiles: LocalFileReference[];
}) {
  const blocks = message.blocks?.length ? message.blocks : [{ type: "text" as const, text: message.text }];
  const jobActive = message.status === "queued" || message.status === "running";
  const groups = groupToolFlowBlocks(blocks);
  const renderMarkdown = message.role === "assistant";
  return (
    <>
      {groups.map((group, index) =>
        Array.isArray(group) ? (
          <ToolProcessGroup
            blocks={group}
            messageId={message.id}
            jobActive={jobActive}
            t={t}
            key={`${message.id}-tools-${index}-${group[0]?.toolCallId || ""}`}
          />
        ) : (
          renderMessageBlock(group, message.id, index, t, renderMarkdown, onOpenFile, knownFiles)
        ),
      )}
    </>
  );
}

function MarkdownText({
  text,
  live = false,
  knownFiles,
  onOpenFile,
}: {
  text: string;
  live?: boolean;
  knownFiles: LocalFileReference[];
  onOpenFile?: (file: LocalFileReference) => void;
}) {
  return (
    <div className={`message-text markdown-body${live ? " is-live" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => {
            void node;
            const localFile = resolveLocalFileHref(typeof props.href === "string" ? props.href : undefined, knownFiles);
            if (localFile && onOpenFile) {
              return (
                <a
                  {...props}
                  href={props.href}
                  onClick={(event) => {
                    event.preventDefault();
                    onOpenFile(localFile);
                  }}
                />
              );
            }
            return <a {...props} target="_blank" rel="noreferrer" />;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

type ToolFlowMessageBlock = ToolUseMessageBlock | ToolResultMessageBlock;

function groupToolFlowBlocks(blocks: ChatMessageBlock[]): Array<ChatMessageBlock | ToolFlowMessageBlock[]> {
  const groups: Array<ChatMessageBlock | ToolFlowMessageBlock[]> = [];
  for (const block of blocks) {
    if (block.type === "tool_use" || block.type === "tool_result") {
      const last = groups[groups.length - 1];
      if (Array.isArray(last)) {
        last.push(block);
      } else {
        groups.push([block]);
      }
    } else {
      groups.push(block);
    }
  }
  return groups;
}

export function ToolProcessGroup({
  blocks,
  messageId,
  jobActive,
  t,
}: {
  blocks: ToolFlowMessageBlock[];
  messageId: string;
  jobActive: boolean;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [toggled, setToggled] = useState<boolean | null>(null);
  const expanded = toggled ?? jobActive;
  const stepCount = new Set(blocks.map((block) => block.toolCallId)).size;
  const hasError = blocks.some(
    (block) =>
      (block.type === "tool_result" && block.isError) ||
      (block.type === "tool_use" && (block.status === "failed" || block.status === "denied")),
  );
  return (
    <div
      className={`tool-card tool-process ${hasError ? "is-error" : ""} ${expanded ? "is-expanded" : "is-collapsed"}`}
    >
      <div className="tool-card-head tool-result-head">
        <ToolOutlined />
        <strong>{t("Execution process")}</strong>
        <Tag>{stepCount}</Tag>
        <Tooltip title={t(expanded ? "Collapse" : "Expand")}>
          <Button
            type="text"
            size="small"
            className="tool-result-toggle"
            icon={expanded ? <DownOutlined /> : <RightOutlined />}
            aria-label={t(expanded ? "Collapse" : "Expand")}
            aria-expanded={expanded}
            onClick={() => setToggled(!expanded)}
          />
        </Tooltip>
      </div>
      {expanded ? (
        <div className="tool-process-list">
          {blocks.map((block) =>
            block.type === "tool_use" ? (
              <ToolUseBlock block={block} t={t} key={`${messageId}-${block.toolCallId}-use`} />
            ) : (
              <ToolResultBlock
                block={block}
                messageId={messageId}
                t={t}
                key={`${messageId}-${block.toolCallId}-result`}
              />
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

function renderMessageBlock(
  block: ChatMessageBlock,
  messageId: string,
  index: number,
  t: (key: string, vars?: Record<string, string | number>) => string,
  renderMarkdown = false,
  onOpenFile?: (file: LocalFileReference) => void,
  knownFiles: LocalFileReference[] = [],
) {
  if (block.type === "text") {
    if (!block.text) {
      return null;
    }
    return renderMarkdown ? (
      <MarkdownText text={block.text} key={`${messageId}-${index}`} onOpenFile={onOpenFile} knownFiles={knownFiles} />
    ) : (
      <div className="message-text" key={`${messageId}-${index}`}>
        {block.text}
      </div>
    );
  }
  if (block.type === "tool_use") {
    return <ToolUseBlock block={block} t={t} key={`${messageId}-${block.toolCallId}-use`} />;
  }
  if (block.type === "tool_result") {
    return (
      <ToolResultBlock block={block} messageId={messageId} t={t} key={`${messageId}-${block.toolCallId}-result`} />
    );
  }
  if (block.type === "thinking" || block.type === "message_delta") {
    if (!block.text) {
      return null;
    }
    return renderMarkdown ? (
      <MarkdownText
        text={block.text}
        live
        key={`${messageId}-${index}`}
        onOpenFile={onOpenFile}
        knownFiles={knownFiles}
      />
    ) : (
      <div className="message-text is-live" key={`${messageId}-${index}`}>
        {block.text}
      </div>
    );
  }
  if (block.type === "progress") {
    return (
      <div className="progress-card" key={`${messageId}-${index}`}>
        <ClockCircleOutlined /> {block.text}
      </div>
    );
  }
  if (block.type === "compact_summary") {
    return (
      <div className="compact-card" key={`${messageId}-${index}`}>
        <div className="tool-card-head">
          <CompressOutlined />
          <strong>{t("Compact summary")}</strong>
        </div>
        <pre>{block.summary.slice(0, 2400)}</pre>
      </div>
    );
  }
  if (block.type === "subagent_start") {
    return (
      <div className="subagent-card" key={`${messageId}-${index}`}>
        <div className="tool-card-head">
          <ThunderboltOutlined />
          <strong>@{block.agentName}</strong>
          <Tag>{t("running")}</Tag>
        </div>
        <pre>{block.prompt.slice(0, 1200)}</pre>
      </div>
    );
  }
  if (block.type === "subagent_done") {
    return (
      <div className={`subagent-card ${block.isError ? "is-error" : ""}`} key={`${messageId}-${index}`}>
        <div className="tool-card-head">
          {block.isError ? <CloseCircleOutlined /> : <CheckCircleOutlined />}
          <strong>@{block.agentName}</strong>
          <Tag>{t(block.isError ? "failed" : "completed")}</Tag>
        </div>
        <pre>{block.output.slice(0, 2400)}</pre>
      </div>
    );
  }
  if (block.type === "question") {
    return <QuestionBlock block={block} t={t} key={`${messageId}-${block.questionId}`} />;
  }
  return <Alert key={`${messageId}-${index}`} type="error" message={block.message} />;
}

export type ToolUseMessageBlock = Extract<NonNullable<ChatMessage["blocks"]>[number], { type: "tool_use" }>;

export function ToolUseBlock({
  block,
  t,
}: {
  block: ToolUseMessageBlock;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const sourceLabel = mcpToolSourceLabel(block.toolName);
  return (
    <div className={`tool-card status-${block.status} ${expanded ? "is-expanded" : "is-collapsed"}`}>
      <div className="tool-card-head tool-result-head">
        <ToolOutlined />
        <strong>{block.toolName}</strong>
        {sourceLabel ? <span className="tool-source">{sourceLabel}</span> : null}
        <Tag>{t(block.status)}</Tag>
        <Tooltip title={t(expanded ? "Collapse" : "Expand")}>
          <Button
            type="text"
            size="small"
            className="tool-result-toggle"
            icon={expanded ? <DownOutlined /> : <RightOutlined />}
            aria-label={t(expanded ? "Collapse" : "Expand")}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          />
        </Tooltip>
      </div>
      {expanded ? <pre>{formatToolPayload(block.input)}</pre> : null}
    </div>
  );
}

export type ToolResultMessageBlock = Extract<NonNullable<ChatMessage["blocks"]>[number], { type: "tool_result" }>;

export function ToolResultBlock({
  block,
  messageId,
  t,
}: {
  block: ToolResultMessageBlock;
  messageId: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`tool-card result ${block.isError ? "is-error" : ""} ${expanded ? "is-expanded" : "is-collapsed"}`}>
      <div className="tool-card-head tool-result-head">
        {block.isError ? <CloseCircleOutlined /> : <CheckCircleOutlined />}
        <strong>{t("Tool result")}</strong>
        {block.outputTruncated ? <Tag color="gold">{t("truncated")}</Tag> : null}
        <Tooltip title={t(expanded ? "Collapse" : "Expand")}>
          <Button
            type="text"
            size="small"
            className="tool-result-toggle"
            icon={expanded ? <DownOutlined /> : <RightOutlined />}
            aria-label={t(expanded ? "Collapse" : "Expand")}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          />
        </Tooltip>
      </div>
      {expanded ? (
        <div className="tool-result-content">
          {block.outputParts?.length ? (
            <div className="tool-result-parts">
              {block.outputParts.map((part, partIndex) => (
                <div className="tool-result-part" key={`${messageId}-${block.toolCallId}-part-${partIndex}`}>
                  <div>
                    <Tag>{part.type}</Tag>
                    {part.mimeType ? <Tag>{part.mimeType}</Tag> : null}
                  </div>
                  <span>{part.text.slice(0, 360)}</span>
                </div>
              ))}
            </div>
          ) : null}
          <pre>{block.output.slice(0, 2400)}</pre>
        </div>
      ) : null}
    </div>
  );
}

export function mcpToolSourceLabel(toolName: string): string {
  const match = toolName.match(/^mcp\.([^.]+)\.(.+)$/);
  return match ? `MCP ${match[1]} / ${match[2]}` : "";
}
