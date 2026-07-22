export type WorkspaceView = "chat" | "server" | "config" | "market";
export type DetailPanel = "memory" | "schedule" | "autopilot" | null;
export type Translator = (key: string, vars?: Record<string, string | number>) => string;
export type SelectionContextMenu = { x: number; y: number; text: string };
export type PromptContextMenu = { x: number; y: number; selectionStart: number; selectionEnd: number; selectedText: string };
