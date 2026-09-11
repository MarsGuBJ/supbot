import type { CapabilityDefinition, SlashCommand, SubagentConfig } from "@supbot/shared";

export interface ProjectFileMatch {
  name: string;
  path: string;
  relativePath: string;
}

export interface ConversationFileMatch {
  key: string;
  name: string;
  path: string;
}

// One entry in the composer "@" popup. Subagents insert an @name token; files
// additionally get attached to the outgoing prompt.
export type MentionItem =
  | { kind: "subagent"; key: string; name: string; description: string }
  | { kind: "conversation-file" | "project-file"; key: string; name: string; path: string; relativePath: string };

// Merges the three "@" mention sources into one popup list: enabled subagents,
// files already present in the conversation, and project file search results.
// Subagents match on name/description; files match on file name.
export function mergeMentionSuggestions(
  query: string,
  subagents: SubagentConfig[],
  conversationFiles: ConversationFileMatch[],
  projectFiles: ProjectFileMatch[],
): MentionItem[] {
  const needle = query.trim().toLowerCase();
  const subagentItems: MentionItem[] = subagents
    .filter((item) => item.enabled && item.name.trim())
    .filter(
      (item) =>
        !needle || item.name.trim().toLowerCase().includes(needle) || item.description.toLowerCase().includes(needle),
    )
    .map((item) => ({
      kind: "subagent",
      key: `subagent:${item.id}`,
      name: item.name.trim(),
      description: item.description,
    }));
  const seenPaths = new Set<string>();
  const conversationItems: MentionItem[] = conversationFiles
    .filter((item) => !needle || item.name.toLowerCase().includes(needle))
    .filter((item) => {
      if (seenPaths.has(item.path)) {
        return false;
      }
      seenPaths.add(item.path);
      return true;
    })
    .map((item) => ({
      kind: "conversation-file",
      key: item.key,
      name: item.name,
      path: item.path,
      relativePath: item.path,
    }));
  const projectItems: MentionItem[] = projectFiles
    .filter((item) => !seenPaths.has(item.path))
    .map((item) => ({
      kind: "project-file",
      key: `project:${item.path}`,
      name: item.name,
      path: item.path,
      relativePath: item.relativePath,
    }));
  return [...subagentItems, ...conversationItems, ...projectItems];
}

export interface PromptToken {
  start: number;
  query: string;
}

// Finds the whitespace-delimited token ending at the caret; returns it when it
// starts with the given trigger character. Because the scan stops at the
// previous whitespace, triggers only fire at the start of a line or after
// whitespace — never inside an existing word.
function getTriggerToken(value: string, caret: number, trigger: string): PromptToken | null {
  const position = Math.max(0, Math.min(caret, value.length));
  let start = position;
  while (start > 0 && !/\s/.test(value[start - 1])) {
    start -= 1;
  }
  const token = value.slice(start, position);
  if (!token.startsWith(trigger)) {
    return null;
  }
  return { start, query: token.slice(trigger.length) };
}

export function getAtToken(value: string, caret: number): PromptToken | null {
  return getTriggerToken(value, caret, "@");
}

export function getSlashToken(value: string, caret: number): PromptToken | null {
  return getTriggerToken(value, caret, "/");
}

export interface SlashSuggestion {
  key: string;
  label: string;
  title: string;
  description: string;
  kind: "command" | "skill";
  payload: SlashCommand | CapabilityDefinition;
}

// Merges built-in slash commands and enabled skills (shown as `/<name>`) into
// one suggestion list for the composer "/" popup. Commands match by prefix on
// the command itself; skills match by case-insensitive substring on the name.
export function mergeSlashSuggestions(
  query: string,
  commands: SlashCommand[],
  skills: CapabilityDefinition[],
): SlashSuggestion[] {
  const needle = query.trim().toLowerCase();
  const commandItems: SlashSuggestion[] = commands
    .filter((item) => item.command.toLowerCase().startsWith(`/${needle}`))
    .map((item) => ({
      key: `command:${item.command}`,
      label: item.command,
      title: item.title,
      description: item.description,
      kind: "command",
      payload: item,
    }));
  const skillItems: SlashSuggestion[] = skills
    .filter((skill) => skill.name.trim())
    .filter((skill) => !needle || skill.name.trim().toLowerCase().includes(needle))
    .map((skill) => ({
      key: `skill:${skill.id}`,
      label: `/${skill.name.trim()}`,
      title: skill.name.trim(),
      description: skill.description,
      kind: "skill",
      payload: skill,
    }));
  return [...commandItems, ...skillItems];
}
