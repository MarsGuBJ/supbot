import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Shared markdown renderer for kb pages (wiki pages, markdown artifacts, chat answers). */
export function MarkdownPreview({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className={`markdown-body assets-markdown ${className}`}>
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
    </div>
  );
}
