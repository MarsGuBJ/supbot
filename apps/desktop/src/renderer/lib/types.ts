export type WorkspaceView = "chat" | "server" | "config" | "skill" | "schedule" | "autodrive";
export type DetailPanel = "tasks" | "file" | null;
export type Translator = (key: string, vars?: Record<string, string | number>) => string;
export type SelectionContextMenu = { x: number; y: number; text: string };
export type PromptContextMenu = {
  x: number;
  y: number;
  selectionStart: number;
  selectionEnd: number;
  selectedText: string;
};
