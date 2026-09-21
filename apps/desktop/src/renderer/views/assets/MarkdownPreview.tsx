import { useState, type MouseEvent as ReactMouseEvent } from "react";
import { CopyOutlined } from "@ant-design/icons";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { writeClipboardText } from "../../lib/clipboard";

/** Shared markdown renderer for kb pages (wiki pages, markdown artifacts, chat answers). */
export function MarkdownPreview({
  text,
  className = "",
  copyLabel,
}: {
  text: string;
  className?: string;
  /** When set, right-clicking with an active text selection shows a context menu with a copy item. */
  copyLabel?: string;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; selection: string } | null>(null);

  const handleContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!copyLabel) {
      return;
    }
    const selection = window.getSelection()?.toString() || "";
    if (!selection) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, selection });
  };

  return (
    <div className={`markdown-body assets-markdown ${className}`} onContextMenu={handleContextMenu}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => {
            void node;
            return <a {...props} target="_blank" rel="noreferrer" />;
          },
        }}
      >
        {text}
      </ReactMarkdown>
      {menu && copyLabel ? (
        <div
          className="file-context-menu-overlay"
          onClick={() => setMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu(null);
          }}
        >
          <div
            className="file-context-menu"
            style={{
              left: Math.min(menu.x, window.innerWidth - 180),
              top: Math.min(menu.y, window.innerHeight - 80),
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => {
                const selection = menu.selection;
                setMenu(null);
                void writeClipboardText(selection).catch(() => undefined);
              }}
            >
              <CopyOutlined /> {copyLabel}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
