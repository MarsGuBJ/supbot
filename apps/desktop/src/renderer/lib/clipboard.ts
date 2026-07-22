export function nodeInside(container: HTMLElement, node: Node | null): boolean {
  return Boolean(node && (node === container || container.contains(node)));
}

export function selectedTextWithin(container: HTMLElement): string {
  const selection = window.getSelection();
  if (
    !selection ||
    selection.rangeCount === 0 ||
    !nodeInside(container, selection.anchorNode) ||
    !nodeInside(container, selection.focusNode)
  ) {
    return "";
  }
  return selection.toString().trim();
}

export function selectionMemoryTitle(text: string): string {
  const firstLine =
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || "Chat selection";
  const compact = firstLine.replace(/\s+/g, " ");
  return compact.length > 60 ? `${compact.slice(0, 57)}...` : compact;
}

export function copyTextFallback(text: string): void {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    const copied = document.execCommand("copy");
    if (!copied) {
      throw new Error("Copy failed.");
    }
  } finally {
    document.body.removeChild(textarea);
  }
}

export async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the textarea path for older or restricted Electron clipboard contexts.
    }
  }
  copyTextFallback(text);
}

export async function readClipboardText(): Promise<string> {
  if (window.supbot?.readClipboardText) {
    return window.supbot.readClipboardText();
  }
  if (!navigator.clipboard?.readText) {
    throw new Error("Paste failed.");
  }
  return navigator.clipboard.readText();
}
