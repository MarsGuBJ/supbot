import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { GraphTemplate } from "@supbot/shared";
import { GraphTemplateStore, validateTemplateName } from "./templates";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "supbot-graph-templates-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function sampleTemplate(): GraphTemplate {
  return {
    name: "供应商关系",
    description: "抽取供应商之间的合作关系",
    entityTypes: ["供应商", "产品"],
    relationTypes: ["供应", "竞争"],
    instructions: "关注长期合作协议。",
  };
}

describe("GraphTemplateStore", () => {
  test("creates the graph-templates directory on construction", () => {
    const root = createTempDir();
    new GraphTemplateStore(root);
    expect(existsSync(join(root, "graph-templates"))).toBe(true);
  });

  test("save + get round-trips frontmatter and instructions", () => {
    const store = new GraphTemplateStore(createTempDir());
    store.save(sampleTemplate());
    expect(existsSync(join(store.dir, "供应商关系.md"))).toBe(true);
    const loaded = store.get("供应商关系");
    expect(loaded).toEqual(sampleTemplate());
  });

  test("save overwrites an existing template (upsert)", () => {
    const store = new GraphTemplateStore(createTempDir());
    store.save(sampleTemplate());
    store.save({ ...sampleTemplate(), description: "更新后的描述", entityTypes: [] });
    const loaded = store.get("供应商关系");
    expect(loaded.description).toBe("更新后的描述");
    expect(loaded.entityTypes).toEqual([]);
    expect(store.list()).toHaveLength(1);
  });

  test("list returns all templates sorted by name", () => {
    const store = new GraphTemplateStore(createTempDir());
    store.save({ name: "beta", entityTypes: [], relationTypes: [] });
    store.save({ name: "alpha", entityTypes: [], relationTypes: [] });
    store.save(sampleTemplate());
    expect(store.list().map((t) => t.name)).toEqual(["alpha", "beta", "供应商关系"]);
  });

  test("get throws for a missing template", () => {
    const store = new GraphTemplateStore(createTempDir());
    expect(() => store.get("missing")).toThrow(/模版不存在/);
  });

  test("delete reports whether a file was removed", () => {
    const store = new GraphTemplateStore(createTempDir());
    store.save(sampleTemplate());
    expect(store.delete("供应商关系")).toBe(true);
    expect(store.delete("供应商关系")).toBe(false);
  });

  test("loads Python-style frontmatter with inline flow arrays", () => {
    const store = new GraphTemplateStore(createTempDir());
    writeFileSync(
      join(store.dir, "竞争对手.md"),
      '---\nname: 竞争对手\ndescription: "抽取竞争格局"\nentity_types: ["公司", "产品"]\nrelation_types: ["竞争"]\n---\n\n注意区分直接与间接竞争。\n',
      "utf8",
    );
    const loaded = store.get("竞争对手");
    expect(loaded).toEqual({
      name: "竞争对手",
      description: "抽取竞争格局",
      entityTypes: ["公司", "产品"],
      relationTypes: ["竞争"],
      instructions: "注意区分直接与间接竞争。",
    });
  });

  test("written file keeps frontmatter + body layout", () => {
    const store = new GraphTemplateStore(createTempDir());
    store.save(sampleTemplate());
    const text = readFileSync(join(store.dir, "供应商关系.md"), "utf8");
    expect(text).toContain("---\n");
    expect(text).toContain("name: 供应商关系\n");
    expect(text).toContain("entity_types:\n  - 供应商\n  - 产品\n");
    expect(text.endsWith("关注长期合作协议。\n")).toBe(true);
  });
});

describe("validateTemplateName", () => {
  test("accepts letters, digits, underscore, hyphen and CJK", () => {
    expect(validateTemplateName("供应商关系")).toBe("供应商关系");
    expect(validateTemplateName("graph_v2-1")).toBe("graph_v2-1");
  });

  test("rejects empty and traversing names", () => {
    expect(() => validateTemplateName("")).toThrow(/非法模版名/);
    expect(() => validateTemplateName("../escape")).toThrow(/非法模版名/);
    expect(() => validateTemplateName("a/b")).toThrow(/非法模版名/);
    expect(() => validateTemplateName("a.md")).toThrow(/非法模版名/);
  });
});
