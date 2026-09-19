/**
 * Graph extraction template storage: one markdown file per template
 * (YAML frontmatter + free-text instructions). Ported from k-pipeline's
 * app/graph/templates.py (Python/PyYAML) to dependency-free TypeScript.
 *
 * Layout (global, shared across projects — NOT inside a project kb):
 *   <kbRoot>/graph-templates/<name>.md
 *
 * File format matches wiki pages:
 *
 * ```markdown
 * ---
 * name: 供应商关系
 * description: 抽取供应商之间的合作关系
 * entity_types: ["供应商", "产品"]
 * relation_types: ["供应", "竞争"]
 * ---
 *
 * 补充说明（自由文本，注入抽取 prompt）。
 * ```
 *
 * The name is the file stem; a slug check guards against path traversal.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { GraphTemplate } from "@supbot/shared";
import { parseYaml, serializeYaml } from "../kbStore";

const NAME_RE = /^[\p{L}\p{N}_-]+$/u;

/** Template name slug check (letters/digits/underscore/hyphen/CJK), rejects path traversal. */
export function validateTemplateName(name: string): string {
  if (!NAME_RE.test(name)) {
    throw new Error(`非法模版名: ${name}`);
  }
  return name;
}

/** Read/write entry point for template files under <kbRoot>/graph-templates/. */
export class GraphTemplateStore {
  readonly dir: string;

  constructor(kbRoot: string) {
    this.dir = join(kbRoot, "graph-templates");
    mkdirSync(this.dir, { recursive: true });
  }

  private path(name: string): string {
    return join(this.dir, `${validateTemplateName(name)}.md`);
  }

  /** List all templates, sorted by name. */
  list(): GraphTemplate[] {
    const names = existsSync(this.dir)
      ? readdirSync(this.dir)
          .filter((name) => name.endsWith(".md"))
          .sort()
      : [];
    // Codepoint comparison, matching Python's sorted().
    return names
      .map((name) => this.load(join(this.dir, name)))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Get a template by name; throws if it does not exist. */
  get(name: string): GraphTemplate {
    const path = this.path(name);
    if (!existsSync(path)) {
      throw new Error(`模版不存在: ${name}`);
    }
    return this.load(path);
  }

  /** Create or overwrite a template (upsert; the name comes from template.name). */
  save(template: GraphTemplate): GraphTemplate {
    this.dump(this.path(template.name), { ...template, name: validateTemplateName(template.name) });
    return template;
  }

  /** Delete a template; returns whether a file was actually removed. */
  delete(name: string): boolean {
    const path = this.path(name);
    if (existsSync(path)) {
      unlinkSync(path);
      return true;
    }
    return false;
  }

  // ---- File read/write ----

  private load(path: string): GraphTemplate {
    const text = readFileSync(path, "utf8");
    let frontmatter: Record<string, string | number | boolean | string[]> = {};
    let body = text;
    if (text.startsWith("---\n")) {
      const end = text.indexOf("\n---\n", 4);
      if (end !== -1) {
        frontmatter = parseYaml(text.slice(4, end));
        body = text.slice(end + 5).replace(/^\n+/, "");
      }
    }
    return {
      name: basename(path, ".md"),
      description: toText(frontmatter.description),
      entityTypes: toStringList(frontmatter.entity_types),
      relationTypes: toStringList(frontmatter.relation_types),
      instructions: body.trim(),
    };
  }

  private dump(path: string, template: GraphTemplate): void {
    const fm = serializeYaml({
      name: template.name,
      description: template.description ?? "",
      entity_types: template.entityTypes,
      relation_types: template.relationTypes,
    });
    writeFileSync(path, `---\n${fm}---\n\n${(template.instructions ?? "").trim()}\n`, "utf8");
  }
}

function toText(value: string | number | boolean | string[] | undefined): string {
  if (value === undefined || value === null || Array.isArray(value)) {
    return "";
  }
  return String(value);
}

function toStringList(value: string | number | boolean | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (typeof value === "string" && value) {
    return [value];
  }
  return [];
}
