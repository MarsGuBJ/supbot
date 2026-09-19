import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Translates English-only SKILL.md files into Simplified Chinese via an
 * LLM caller supplied by the runtime. Files that already contain Chinese
 * (including mixed Chinese/English content) are never translated.
 */

export type SkillTranslationCallLlm = (prompt: string) => Promise<string>;

export type SkillTranslationStatus =
  "translated" | "skipped-chinese" | "skipped-already-translated" | "skipped-no-skillmd" | "failed";

export interface SkillTranslationSummary {
  translated: string[];
  skipped: number;
  failed: string[];
}

/** CJK ranges: U+3400–U+4DBF (ext A), U+4E00–U+9FFF (unified), U+F900–U+FAFF (compat). */
export function containsChinese(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      return true;
    }
  }
  return false;
}

const TRANSLATED_MARKER_FILE = ".translated-zh";

const TRANSLATION_INSTRUCTIONS = [
  "Translate the following SKILL.md file into Simplified Chinese (简体中文).",
  "Rules:",
  "- Keep the YAML frontmatter delimiters (---) and keys unchanged; keep the `name` value unchanged; translate the `description` value.",
  "- Preserve all Markdown structure, headings, lists, links, URLs, file paths, and code blocks exactly as-is (code stays untranslated).",
  "- Output ONLY the translated file content, with no commentary and no wrapping code fence.",
  "",
  "SKILL.md content:",
].join("\n");

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function stripWrappingCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  return match ? match[1] : trimmed;
}

function hasFrontmatter(text: string): boolean {
  return text.trimStart().startsWith("---");
}

function frontmatterIntact(text: string): boolean {
  if (!hasFrontmatter(text)) {
    return false;
  }
  const lines = text.trimStart().split(/\r?\n/);
  return lines.slice(1).some((line) => line.trim() === "---");
}

/**
 * Translate `<skillDir>/SKILL.md` in place when it is English-only. On any
 * LLM or validation failure the original file is left untouched. A
 * `.translated-zh` marker (sha256 of the English source) prevents paying for
 * re-translation of an unchanged file.
 */
export async function translateSkillFile(
  skillDir: string,
  callLlm: SkillTranslationCallLlm,
): Promise<SkillTranslationStatus> {
  const skillFilePath = join(skillDir, "SKILL.md");
  const source = await readFile(skillFilePath, "utf8").catch(() => undefined);
  if (source === undefined) {
    return "skipped-no-skillmd";
  }
  if (containsChinese(source)) {
    return "skipped-chinese";
  }
  const sourceSha256 = sha256(source);
  const markerRaw = await readFile(join(skillDir, TRANSLATED_MARKER_FILE), "utf8").catch(() => undefined);
  if (markerRaw) {
    try {
      const marker = JSON.parse(markerRaw) as { sourceSha256?: unknown };
      if (marker.sourceSha256 === sourceSha256) {
        return "skipped-already-translated";
      }
    } catch {
      // Corrupt marker: fall through and retranslate.
    }
  }
  try {
    const translated = stripWrappingCodeFence(await callLlm(`${TRANSLATION_INSTRUCTIONS}\n\n${source}`)).trim();
    if (!translated) {
      return "failed";
    }
    // Guard against a broken translation destroying the frontmatter structure
    // the loaders rely on; in that case keep the original file.
    if (hasFrontmatter(source) && !frontmatterIntact(translated)) {
      return "failed";
    }
    await writeFile(skillFilePath, `${translated}\n`, "utf8");
    const marker = { sourceSha256, translatedAt: new Date().toISOString() };
    await writeFile(join(skillDir, TRANSLATED_MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
    return "translated";
  } catch {
    return "failed";
  }
}

/**
 * Scan every skill directory directly under `skillsRoot` and translate the
 * English-only ones, serially, to stay within LLM rate limits. Staging /
 * backup directories (dot-prefixed) and bundled default skills (re-seeded on
 * every launch, so translating them would be wasted) are excluded.
 */
export async function translateEnglishSkills(
  skillsRoot: string,
  callLlm: SkillTranslationCallLlm,
  options: { excludeDirs?: ReadonlySet<string> } = {},
): Promise<SkillTranslationSummary> {
  const summary: SkillTranslationSummary = { translated: [], skipped: 0, failed: [] };
  const entries = await readdir(skillsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || options.excludeDirs?.has(entry.name)) {
      continue;
    }
    const status = await translateSkillFile(join(skillsRoot, entry.name), callLlm);
    if (status === "translated") {
      summary.translated.push(entry.name);
    } else if (status === "failed") {
      summary.failed.push(entry.name);
    } else {
      summary.skipped += 1;
    }
  }
  return summary;
}

/** Skill directory names seeded from the bundled default-data (replaced on every launch). */
export async function readBundledSkillNames(dataDir: string): Promise<Set<string>> {
  const raw = await readFile(join(dataDir, "default-data-seed.json"), "utf8").catch(() => undefined);
  if (!raw) {
    return new Set();
  }
  try {
    const skills = (JSON.parse(raw) as { manifest?: { skills?: unknown } }).manifest?.skills;
    return new Set(Array.isArray(skills) ? skills.filter((name): name is string => typeof name === "string") : []);
  } catch {
    return new Set();
  }
}

interface SkillTranslationSchedulerState {
  lastRunDate?: string;
}

const SCHEDULER_STATE_FILE = "skill-translation-state.json";

export async function readSkillTranslationLastRunDate(dataDir: string): Promise<string | undefined> {
  const raw = await readFile(join(dataDir, SCHEDULER_STATE_FILE), "utf8").catch(() => undefined);
  if (!raw) {
    return undefined;
  }
  try {
    const state = JSON.parse(raw) as SkillTranslationSchedulerState;
    return typeof state.lastRunDate === "string" ? state.lastRunDate : undefined;
  } catch {
    return undefined;
  }
}

export async function writeSkillTranslationLastRunDate(dataDir: string, lastRunDate: string): Promise<void> {
  const state: SkillTranslationSchedulerState = { lastRunDate };
  await writeFile(join(dataDir, SCHEDULER_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
