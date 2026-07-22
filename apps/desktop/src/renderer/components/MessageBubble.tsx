import { memo, useState } from "react";
import { CheckCircleOutlined, ClockCircleOutlined, CloseCircleOutlined, CompressOutlined, DownOutlined, PaperClipOutlined, RightOutlined, ThunderboltOutlined, ToolOutlined } from "@ant-design/icons";
import { Alert, Button, Tag, Tooltip, message } from "antd";
import type { ChatMessage } from "@supbot/shared";
import { formatDateTime, statusColor, statusLabel } from "@supbot/shared";
import { formatToolPayload, shouldShowGeneratedFileInChat } from "../lib/chatFormat";

export const MessageBubble = memo(function MessageBubble({ message: item, t }: { message: ChatMessage; t: (key: string, vars?: Record<string, string | number>) => string }) {
  const visibleGeneratedFiles = item.generatedFiles?.filter(shouldShowGeneratedFileInChat) || [];
  return (
    <div className={`message-row ${item.role}`}>
      <div className="message-bubble">
        <div className="message-meta">
          <span>{item.role === "user" ? t("You") : item.role === "assistant" ? "HBClient" : item.role === "tool" ? t("Tool") : t("System")}</span>
          <span>{formatDateTime(item.createdAt)}</span>
          {item.status ? <Tag color={statusColor(item.status)}>{statusLabel(item.status, t)}</Tag> : null}
        </div>
        <MessageBlocks message={item} t={t} />
        {item.attachments?.length ? (
          <div className="attachment-row">
            {item.attachments.map((attachment) => <Tag key={attachment.id}><PaperClipOutlined /> {attachment.name}</Tag>)}
          </div>
        ) : null}
        {visibleGeneratedFiles.length ? (
          <div className="generated-files">
            {visibleGeneratedFiles.map((file) => (
              <button className="generated-file" type="button" key={file.id} onClick={() => void window.supbot.openFile(file.path)}>
                <PaperClipOutlined />
                <span>{file.name}</span>
                <small>{file.size} bytes</small>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
});

export function MessageBlocks({ message, t }: { message: ChatMessage; t: (key: string, vars?: Record<string, string | number>) => string }) {
  const blocks = message.blocks?.length ? message.blocks : [{ type: "text" as const, text: message.text }];
  return (
    <>
      {blocks.map((block, index) => {
        if (block.type === "text") {
          return block.text ? <div className="message-text" key={`${message.id}-${index}`}>{block.text}</div> : null;
        }
        if (block.type === "tool_use") {
          const sourceLabel = mcpToolSourceLabel(block.toolName);
          return (
            <div className={`tool-card status-${block.status}`} key={`${message.id}-${block.toolCallId}-use`}>
              <div className="tool-card-head">
                <ToolOutlined />
                <strong>{block.toolName}</strong>
                {sourceLabel ? <span className="tool-source">{sourceLabel}</span> : null}
                <Tag>{t(block.status)}</Tag>
              </div>
              <pre>{formatToolPayload(block.input)}</pre>
            </div>
          );
        }
        if (block.type === "tool_result") {
          return <ToolResultBlock block={block} messageId={message.id} t={t} key={`${message.id}-${block.toolCallId}-result`} />;
        }
        if (block.type === "thinking" || block.type === "message_delta") {
          return block.text ? <div className="message-text is-live" key={`${message.id}-${index}`}>{block.text}</div> : null;
        }
        if (block.type === "progress") {
          return <div className="progress-card" key={`${message.id}-${index}`}><ClockCircleOutlined /> {block.text}</div>;
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
              <div className="tool-card-head"><ThunderboltOutlined /><strong>@{block.agentName}</strong><Tag>{t("running")}</Tag></div>
              <pre>{block.prompt.slice(0, 1200)}</pre>
            </div>
          );
        }
        if (block.type === "subagent_done") {
          return (
            <div className={`subagent-card ${block.isError ? "is-error" : ""}`} key={`${message.id}-${index}`}>
              <div className="tool-card-head">{block.isError ? <CloseCircleOutlined /> : <CheckCircleOutlined />}<strong>@{block.agentName}</strong><Tag>{t(block.isError ? "failed" : "completed")}</Tag></div>
              <pre>{block.output.slice(0, 2400)}</pre>
            </div>
          );
        }
        return <Alert key={`${message.id}-${index}`} type="error" message={block.message} />;
      })}
    </>
  );
}

export type ToolResultMessageBlock = Extract<NonNullable<ChatMessage["blocks"]>[number], { type: "tool_result" }>;

export function ToolResultBlock({
  block,
  messageId,
  t
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
