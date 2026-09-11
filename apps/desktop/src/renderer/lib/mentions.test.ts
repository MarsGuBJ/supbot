import type { CapabilityDefinition, SlashCommand, SubagentConfig } from "@supbot/shared";
import { describe, expect, it } from "vitest";
import { getAtToken, getSlashToken, mergeMentionSuggestions, mergeSlashSuggestions } from "./mentions";

describe("getAtToken", () => {
  it("returns the @ token ending at the caret", () => {
    expect(getAtToken("hello @rea", 10)).toEqual({ start: 6, query: "rea" });
  });

  it("matches a bare @ at the start of the input", () => {
    expect(getAtToken("@", 1)).toEqual({ start: 0, query: "" });
  });

  it("returns null when the caret token does not start with @", () => {
    expect(getAtToken("hello world", 11)).toBeNull();
  });

  it("returns null for @ inside a word", () => {
    expect(getAtToken("foo@bar", 7)).toBeNull();
  });

  it("stops at newlines", () => {
    expect(getAtToken("line one\n@doc", 13)).toEqual({ start: 9, query: "doc" });
  });
});

describe("getSlashToken", () => {
  it("returns the / token ending at the caret", () => {
    expect(getSlashToken("/hel", 4)).toEqual({ start: 0, query: "hel" });
  });

  it("triggers after whitespace mid-line", () => {
    expect(getSlashToken("please /ski", 11)).toEqual({ start: 7, query: "ski" });
  });

  it("returns null when the caret token does not start with /", () => {
    expect(getSlashToken("hello", 5)).toBeNull();
  });

  it("returns null for / inside a word or path", () => {
    expect(getSlashToken("src/main", 8)).toBeNull();
  });

  it("respects the caret position rather than the end of the value", () => {
    expect(getSlashToken("/new extra", 4)).toEqual({ start: 0, query: "new" });
  });
});

describe("mergeSlashSuggestions", () => {
  const commands = [
    { command: "/new", action: "new", title: "New conversation", description: "Start a fresh local thread." },
    { command: "/history", action: "history", title: "History", description: "Open conversation history." },
  ] as SlashCommand[];
  const skills = [
    { id: "skill-pdf", name: "PDF Tools", kind: "skill", description: "Work with PDFs.", enabled: true },
    { id: "skill-web", name: "web-search", kind: "skill", description: "Search the web.", enabled: true },
  ] satisfies CapabilityDefinition[];

  it("lists all commands and skills for an empty query", () => {
    const suggestions = mergeSlashSuggestions("", commands, skills);
    expect(suggestions.map((item) => item.label)).toEqual(["/new", "/history", "/PDF Tools", "/web-search"]);
    expect(suggestions.map((item) => item.kind)).toEqual(["command", "command", "skill", "skill"]);
  });

  it("prefix-matches commands and substring-matches skills, case-insensitively", () => {
    const suggestions = mergeSlashSuggestions("Hi", commands, skills);
    expect(suggestions.map((item) => item.label)).toEqual(["/history"]);
    expect(mergeSlashSuggestions("pdf", commands, skills).map((item) => item.label)).toEqual(["/PDF Tools"]);
  });

  it("keeps the original entry in payload", () => {
    const suggestions = mergeSlashSuggestions("web", commands, skills);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].key).toBe("skill:skill-web");
    expect(suggestions[0].payload).toBe(skills[1]);
  });

  it("ignores skills with blank names", () => {
    const blank = [
      { id: "blank", name: "  ", kind: "skill", description: "", enabled: true },
    ] as CapabilityDefinition[];
    expect(mergeSlashSuggestions("", commands, blank)).toHaveLength(2);
  });
});

describe("mergeMentionSuggestions", () => {
  const subagents = [
    { id: "research", name: "research", description: "Collects context.", systemPrompt: "x", enabled: true },
    { id: "equity-analyst", name: "equity-analyst", description: "股票研究分析师", systemPrompt: "x", enabled: true },
    { id: "off", name: "disabled-one", description: "Disabled.", systemPrompt: "x", enabled: false },
  ] satisfies SubagentConfig[];
  const conversationFiles = [
    { key: "att-1-report", name: "report.pdf", path: "/data/report.pdf" },
    { key: "gen-2-report", name: "report.pdf", path: "/data/report.pdf" },
  ];
  const projectFiles = [
    { name: "notes.md", path: "/proj/notes.md", relativePath: "notes.md" },
    { name: "report.pdf", path: "/data/report.pdf", relativePath: "../data/report.pdf" },
  ];

  it("lists subagents and conversation files first for an empty query", () => {
    const items = mergeMentionSuggestions("", subagents, conversationFiles, projectFiles);
    expect(items.map((item) => item.kind)).toEqual(["subagent", "subagent", "conversation-file", "project-file"]);
    expect(items.map((item) => item.name)).toEqual(["research", "equity-analyst", "report.pdf", "notes.md"]);
  });

  it("skips disabled subagents", () => {
    const items = mergeMentionSuggestions("disabled", subagents, [], []);
    expect(items).toHaveLength(0);
  });

  it("matches subagents by name and description, files by name", () => {
    expect(mergeMentionSuggestions("股票", subagents, conversationFiles, []).map((i) => i.name)).toEqual([
      "equity-analyst",
    ]);
    expect(mergeMentionSuggestions("report", subagents, conversationFiles, []).map((i) => i.kind)).toEqual([
      "conversation-file",
    ]);
  });

  it("deduplicates files by path across sources", () => {
    const items = mergeMentionSuggestions("", [], conversationFiles, projectFiles);
    expect(items.map((item) => item.name)).toEqual(["report.pdf", "notes.md"]);
  });

  it("keeps stable keys per source", () => {
    const items = mergeMentionSuggestions("", subagents, conversationFiles, projectFiles);
    expect(items.map((item) => item.key)).toEqual([
      "subagent:research",
      "subagent:equity-analyst",
      "att-1-report",
      "project:/proj/notes.md",
    ]);
  });
});
