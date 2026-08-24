import { memo, useState } from "react";
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
import type { ChatMessage, GeneratedFile } from "@supbot/shared";
import { statusColor, statusLabel } from "@supbot/shared";
import { formatToolPayload, shouldShowGeneratedFileInChat } from "../lib/chatFormat";
import { writeClipboardText } from "../lib/clipboard";

export const MessageBubble = memo(function MessageBubble({
  message: item,
  highlighted = false,
  t,
}: {
  message: ChatMessage;
  highlighted?: boolean;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const visibleGeneratedFiles = item.generatedFiles?.filter(shouldShowGeneratedFileInChat) || [];
  const copyable = (item.role === "user" || item.role === "assistant") && item.text.trim().length > 0;
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
      <MessageBlocks message={item} t={t} />
      {item.attachments?.length ? (
        <div className="attachment-row">
          {item.attachments.map((attachment) => (
            <Tag key={attachment.id}>
              <PaperClipOutlined /> {attachment.name}
            </Tag>
          ))}
        </div>
      ) : null}
      {visibleGeneratedFiles.length ? (
        <div className="generated-files">
          {visibleGeneratedFiles.map((file) => (
            <span className="generated-file-item" key={file.id}>
              <button className="generated-file" type="button" onClick={() => void window.supbot.openFile(file.path)}>
                <PaperClipOutlined />
                <span>{file.name}</span>
                <small>{file.size} bytes</small>
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
          {item.status ? <Tag color={statusColor(item.status)}>{statusLabel(item.status, t)}</Tag> : null}
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
}: {
  message: ChatMessage;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const blocks = message.blocks?.length ? message.blocks : [{ type: "text" as const, text: message.text }];
  return (
    <>
      {blocks.map((block, index) => {
        if (block.type === "text") {
          return block.text ? (
            <div className="message-text" key={`${message.id}-${index}`}>
              {block.text}
            </div>
          ) : null;
        }
        if (block.type === "tool_use") {
          return <ToolUseBlock block={block} t={t} key={`${message.id}-${block.toolCallId}-use`} />;
        }
        if (block.type === "tool_result") {
          return (
            <ToolResultBlock
              block={block}
              messageId={message.id}
              t={t}
              key={`${message.id}-${block.toolCallId}-result`}
            />
          );
        }
        if (block.type === "thinking" || block.type === "message_delta") {
          return block.text ? (
            <div className="message-text is-live" key={`${message.id}-${index}`}>
              {block.text}
            </div>
          ) : null;
        }
        if (block.type === "progress") {
          return (
            <div className="progress-card" key={`${message.id}-${index}`}>
              <ClockCircleOutlined /> {block.text}
            </div>
          );
        }
        if (block.type === "compact_summary") {
          return (
            <div className="compact-card" key={`${message.id}-${index}`}>
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
            <div className="subagent-card" key={`${message.id}-${index}`}>
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
            <div className={`subagent-card ${block.isError ? "is-error" : ""}`} key={`${message.id}-${index}`}>
              <div className="tool-card-head">
                {block.isError ? <CloseCircleOutlined /> : <CheckCircleOutlined />}
                <strong>@{block.agentName}</strong>
                <Tag>{t(block.isError ? "failed" : "completed")}</Tag>
              </div>
              <pre>{block.output.slice(0, 2400)}</pre>
            </div>
          );
        }
        return <Alert key={`${message.id}-${index}`} type="error" message={block.message} />;
      })}
    </>
  );
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
