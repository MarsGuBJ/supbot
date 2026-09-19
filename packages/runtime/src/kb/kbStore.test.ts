import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { extractWikilinks, KbStore, parseYaml, serializeYaml, WIKI_SECTIONS } from "./kbStore";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "supbot-kbstore-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("KbStore layout", () => {
  test("initializes the kb_root directory layout", () => {
    const root = createTempDir();
    new KbStore(root);
    for (const rel of ["raw/sources", "raw/markdown", "raw/assets", ".kbase"]) {
      expect(existsSync(join(root, rel))).toBe(true);
    }
    for (const section of WIKI_SECTIONS) {
      expect(existsSync(join(root, "wiki", section))).toBe(true);
    }
    expect(readFileSync(join(root, "purpose.md"), "utf8")).toContain("知识库目标");
    expect(readFileSync(join(root, "schema.md"), "utf8")).toContain("结构规则");
    expect(readFileSync(join(root, "wiki", "index.md"), "utf8")).toBe("");
    expect(readFileSync(join(root, "wiki", "overview.md"), "utf8")).toBe("");
    expect(readFileSync(join(root, "wiki", "log.md"), "utf8")).toContain("| 时间 | 操作 | 页面 | 来源 |");
  });

  test("does not overwrite existing files on re-init", () => {
    const root = createTempDir();
    new KbStore(root);
    writeFileSync(join(root, "purpose.md"), "custom purpose", "utf8");
    writeFileSync(join(root, "wiki", "overview.md"), "custom overview", "utf8");
    new KbStore(root);
    expect(readFileSync(join(root, "purpose.md"), "utf8")).toBe("custom purpose");
    expect(readFileSync(join(root, "wiki", "overview.md"), "utf8")).toBe("custom overview");
  });
});

describe("KbStore pages", () => {
  test("write/read page round-trips frontmatter and body", () => {
    const store = new KbStore(createTempDir());
    const body = "# 供应商管理系统\n\n参见 [[供应商评估模型]] 与 [[供应商评估模型|评估模型]]。\n";
    store.writePage(
      "entities/供应商管理系统.md",
      {
        type: "entity",
        title: "供应商管理系统",
        tags: ["srm", "采购"],
        sources: ["raw/sources/采购白皮书.pdf"],
        created: "2026-08-29",
      },
      body,
    );
    const page = store.readPage("entities/供应商管理系统.md");
    expect(page.meta.type).toBe("entity");
    expect(page.meta.title).toBe("供应商管理系统");
    expect(page.meta.tags).toEqual(["srm", "采购"]);
    expect(page.meta.sources).toEqual(["raw/sources/采购白皮书.pdf"]);
    expect(page.meta.created).toBe("2026-08-29");
    expect(page.body).toBe(body);
  });

  test("accepts paths with a leading wiki/ prefix", () => {
    const store = new KbStore(createTempDir());
    store.writePage("concepts/a.md", { title: "A" }, "body a");
    expect(store.readPage("wiki/concepts/a.md").body).toBe("body a");
  });

  test("reads pages without frontmatter as body-only", () => {
    const store = new KbStore(createTempDir());
    writeFileSync(join(store.wikiDir, "concepts", "plain.md"), "plain body", "utf8");
    const page = store.readPage("concepts/plain.md");
    expect(page.meta).toEqual({});
    expect(page.body).toBe("plain body");
  });

  test("rejects absolute and traversing page paths", () => {
    const store = new KbStore(createTempDir());
    expect(() => store.readPage("../escape.md")).toThrow();
    expect(() => store.writePage("/abs/path.md", {}, "")).toThrow();
  });

  test("deletePage reports whether a file was removed", () => {
    const store = new KbStore(createTempDir());
    store.writePage("queries/q.md", {}, "q");
    expect(store.deletePage("queries/q.md")).toBe(true);
    expect(store.deletePage("queries/q.md")).toBe(false);
  });

  test("pageWikilinks extracts deduped targets in order", () => {
    const store = new KbStore(createTempDir());
    store.writePage("concepts/a.md", {}, "[[b]] then [[c|alias]] then [[b]]");
    expect(store.pageWikilinks("concepts/a.md")).toEqual(["b", "c"]);
  });
});

describe("extractWikilinks", () => {
  test("supports aliases and dedupes in order of appearance", () => {
    expect(extractWikilinks("[[a]] [[b|B]] [[a]] [[ ]]")).toEqual(["a", "b"]);
    expect(extractWikilinks("no links")).toEqual([]);
  });
});

describe("yaml subset", () => {
  test("round-trips flat scalars and arrays", () => {
    const meta = {
      type: "entity",
      title: "标题: 带冒号",
      count: 3,
      ratio: 0.5,
      draft: false,
      tags: ["a", "b"],
      empty: [] as string[],
    };
    const parsed = parseYaml(serializeYaml(meta));
    expect(parsed).toEqual(meta);
  });

  test("parses inline [a, b] arrays and quoted scalars", () => {
    const parsed = parseYaml('sources: ["raw/sources/a.pdf", raw/sources/b.pdf]\ntitle: "quoted: value"\n');
    expect(parsed.sources).toEqual(["raw/sources/a.pdf", "raw/sources/b.pdf"]);
    expect(parsed.title).toBe("quoted: value");
  });
});

describe("KbStore index/log/overview", () => {
  test("rebuildIndex is deterministic and grouped by section", () => {
    const store = new KbStore(createTempDir());
    store.writePage("concepts/zeta.md", { type: "concept", title: "Zeta" }, "z");
    store.writePage("entities/beta.md", { type: "entity", title: "Beta" }, "b");
    store.writePage("concepts/alpha.md", { title: "Alpha" }, "a");
    const first = store.rebuildIndex();
    const second = store.rebuildIndex();
    expect(first).toBe(second);
    expect(readFileSync(join(store.wikiDir, "index.md"), "utf8")).toBe(first);
    const entities = first.indexOf("## entities");
    const concepts = first.indexOf("## concepts");
    expect(entities).toBeGreaterThan(-1);
    expect(concepts).toBeGreaterThan(entities);
    expect(first.indexOf("[[alpha]]")).toBeLessThan(first.indexOf("[[zeta]]"));
    expect(first).toContain("- [[alpha]] — concept · Alpha");
    expect(first).toContain("- [[beta]] — entity · Beta");
    // Sections without pages are omitted.
    expect(first).not.toContain("## sources");
  });

  test("appendLog appends parseable rows and sanitizes pipes/newlines", () => {
    const store = new KbStore(createTempDir());
    store.appendLog("ingest", "entities/a.md", "raw/sources/a.pdf");
    store.appendLog("bad|action\nmulti", "", "");
    const log = readFileSync(join(store.wikiDir, "log.md"), "utf8");
    const rows = log.trim().split("\n").slice(4);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(
      /^\| \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00 \| ingest \| entities\/a\.md \| raw\/sources\/a\.pdf \|$/,
    );
    expect(rows[1]).toContain("bad/action multi");
    expect(rows[1]).toMatch(/\| - \| - \|$/);
  });

  test("overview and root docs round-trip", () => {
    const store = new KbStore(createTempDir());
    expect(store.readOverview()).toBe("");
    store.writeOverview("# 总览\n");
    expect(store.readOverview()).toBe("# 总览\n");
    expect(store.readRootDoc("purpose.md")).toContain("知识库目标");
    store.writeRootDoc("purpose.md", "updated");
    expect(store.readRootDoc("purpose.md")).toBe("updated");
    expect(store.readRootDoc("missing.md")).toBe("");
  });

  test("listPages excludes index/log/overview and sorts by path", () => {
    const store = new KbStore(createTempDir());
    store.writePage("sources/s.md", {}, "s");
    store.writePage("entities/e.md", {}, "e");
    mkdirSync(join(store.wikiDir, "entities"), { recursive: true });
    writeFileSync(join(store.wikiDir, "entities", "note.txt"), "not a page", "utf8");
    expect(store.listPages()).toEqual(["entities/e.md", "sources/s.md"]);
  });
});
