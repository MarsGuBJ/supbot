import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { KbIngestTask, ModelConfig } from "@supbot/shared";
import type { ModelAdapter } from "../modelAdapter";
import { KB_MODEL_REQUIRED_MESSAGE, KbManager } from "./kbManager";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "supbot-kbmanager-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const MODEL_CONFIG: ModelConfig = {
  providerName: "fake",
  baseUrl: "http://localhost",
  model: "fake-model",
  temperature: 0,
  maxTokens: 4096,
  apiKeySaved: true,
};

/** Fake LLM：按 prompt 前缀返回固定输出（Step1 分析 / Step2 空操作集 / Overview / chat）。 */
function createFakeAdapter(): ModelAdapter {
  return {
    complete: async (input) => {
      const last = input.messages.at(-1);
      const text = typeof last?.content === "string" ? last.content : "";
      const first = input.messages[0];
      const system = first?.role === "system" && typeof first.content === "string" ? first.content : "";
      let reply = "{}";
      if (text.includes("【Step1 分析】")) {
        reply = JSON.stringify({ summary: "供应商管理系统测试摘要" });
      } else if (text.includes("【Step2 生成】")) {
        reply = "[]";
      } else if (text.includes("【Overview】")) {
        reply = "测试知识库概览";
      } else if (system.includes("知识库问答助手")) {
        reply = "根据资料回答[1]";
      }
      return { text: reply, toolCalls: [] };
    },
    stream: async function* () {
      yield* [];
      return { text: "", toolCalls: [] };
    },
  };
}

function createManager(options: { withKey?: boolean } = {}) {
  const kbRoot = join(createTempDir(), "kb-root");
  const events: KbIngestTask[] = [];
  const manager = new KbManager({
    kbRoot,
    adapter: createFakeAdapter(),
    resolveModel: () => ({ modelConfig: MODEL_CONFIG, apiKey: options.withKey === false ? undefined : "test-key" }),
    onEvent: (task) => events.push(task),
  });
  return { manager, events, kbRoot };
}

describe("KbManager 项目管理", () => {
  test("createProject 初始化布局并被 listProjects 列出", () => {
    const { manager, kbRoot } = createManager();
    const project = manager.createProject("采购库");
    expect(project.id).toBe("采购库");
    expect(project.rootPath).toBe(join(kbRoot, "projects", "采购库"));
    expect(existsSync(join(project.rootPath, "raw", "sources"))).toBe(true);
    expect(existsSync(join(project.rootPath, "wiki", "entities"))).toBe(true);
    expect(manager.listProjects().map((item) => item.name)).toEqual(["采购库"]);
  });

  test("createProject 拒绝路径穿越与非法字符", () => {
    const { manager } = createManager();
    expect(() => manager.createProject("../evil")).toThrow(/非法知识库项目名/);
    expect(() => manager.createProject("a/b")).toThrow(/非法知识库项目名/);
    expect(() => manager.createProject("")).toThrow(/非法知识库项目名/);
  });

  test("操作不存在的项目时报中文错误", () => {
    const { manager } = createManager();
    expect(() => manager.listDocuments("不存在")).toThrow(/知识库项目不存在/);
  });
});

describe("KbManager 文档摄入", () => {
  test("uploadDocuments 阻断可执行/脚本扩展名", async () => {
    const { manager } = createManager();
    manager.createProject("p1");
    await expect(manager.uploadDocuments("p1", [{ name: "evil.exe", data: Buffer.from("x") }])).rejects.toThrow(
      /不允许上传可执行\/脚本文件/,
    );
    await expect(manager.uploadDocuments("p1", [{ name: "evil.sh", data: Buffer.from("x") }])).rejects.toThrow(
      /不允许上传/,
    );
    await expect(manager.uploadDocuments("p1", [{ name: "../escape.txt", data: Buffer.from("x") }])).rejects.toThrow(
      /非法文件名/,
    );
  });

  test("上传 txt → 摄入完成 → 进度事件 → search 命中 → listDocuments 关联任务", async () => {
    const { manager, events } = createManager();
    manager.createProject("p1");
    const tasks = await manager.uploadDocuments("p1", [
      { name: "供应商.txt", data: Buffer.from("供应商管理系统负责采购流程与供应商评估。", "utf8") },
    ]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).toBe("done");
    expect(tasks[0]!.progress).toBe(1);

    const statuses = events.map((task) => task.status);
    expect(statuses).toContain("pending");
    expect(statuses).toContain("parsing");
    expect(statuses).toContain("ingesting");
    expect(statuses.at(-1)).toBe("done");

    // 保底源摘要页（Step2 返回空操作集）
    expect(manager.listWikiPages("p1")).toEqual(["sources/供应商.md"]);

    const hits = manager.search("p1", "供应商");
    expect(hits.length).toBeGreaterThan(0);

    const docs = manager.listDocuments("p1");
    expect(docs).toHaveLength(1);
    expect(docs[0]!.fileName).toBe("供应商.txt");
    expect(docs[0]!.task?.status).toBe("done");
    expect(docs[0]!.sha256).toBeTruthy();

    const markdown = manager.readMarkdown("p1", "供应商");
    expect(markdown.markdown).toContain("供应商管理系统");
  });

  test("readMarkdown 对未转换文档报错", () => {
    const { manager } = createManager();
    manager.createProject("p1");
    expect(() => manager.readMarkdown("p1", "不存在")).toThrow(/尚未转换出 Markdown/);
  });

  test("rescan：sha 未变跳过，源文件消失后级联删除", async () => {
    const { manager, kbRoot } = createManager();
    manager.createProject("p1");
    await manager.uploadDocuments("p1", [{ name: "文档.txt", data: Buffer.from("采购流程说明", "utf8") }]);

    const first = await manager.rescan("p1");
    expect(first.enqueued).toEqual([]);
    expect(first.skipped).toEqual(["文档.txt"]);
    expect(first.deletedSources).toEqual([]);

    rmSync(join(kbRoot, "projects", "p1", "raw", "sources", "文档.txt"));
    const second = await manager.rescan("p1");
    expect(second.deletedSources).toEqual(["文档"]);
    expect(manager.listDocuments("p1")).toEqual([]);
    expect(manager.listWikiPages("p1")).toEqual([]);
  });

  test("deleteSource 级联删除源文件、markdown 产物与 wiki 页", async () => {
    const { manager, kbRoot } = createManager();
    manager.createProject("p1");
    await manager.uploadDocuments("p1", [{ name: "合同.txt", data: Buffer.from("合同条款内容", "utf8") }]);
    expect(manager.listWikiPages("p1")).toEqual(["sources/合同.md"]);

    const result = await manager.deleteSource("p1", "合同");
    expect(result.deletedPages).toEqual(["sources/合同.md"]);
    expect(existsSync(join(kbRoot, "projects", "p1", "raw", "sources", "合同.txt"))).toBe(false);
    expect(existsSync(join(kbRoot, "projects", "p1", "raw", "markdown", "合同.md"))).toBe(false);
    expect(manager.listWikiPages("p1")).toEqual([]);
  });
});

describe("KbManager 问答与 LLM 降级", () => {
  test("chat 返回带引用的回答", async () => {
    const { manager } = createManager();
    manager.createProject("p1");
    await manager.uploadDocuments("p1", [
      { name: "供应商.txt", data: Buffer.from("供应商管理系统负责采购流程。", "utf8") },
    ]);
    const response = await manager.chat("p1", "供应商管理系统负责什么？", [
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好，请问。" },
    ]);
    expect(response.answer).toBe("根据资料回答[1]");
    expect(response.citations).toHaveLength(1);
    expect(response.citations[0]!.ref).toBe(1);
  });

  test("未配置 API Key 时 chat / graphExtract 抛中文错误", async () => {
    const { manager } = createManager({ withKey: false });
    manager.createProject("p1");
    await expect(manager.chat("p1", "问题")).rejects.toThrow(KB_MODEL_REQUIRED_MESSAGE);
    await expect(manager.graphExtract("p1", "文档", "模版")).rejects.toThrow(KB_MODEL_REQUIRED_MESSAGE);
  });
});

describe("KbManager 图谱模版", () => {
  test("模版 CRUD（全局，不依赖项目）", () => {
    const { manager } = createManager();
    expect(manager.listGraphTemplates()).toEqual([]);
    manager.saveGraphTemplate({
      name: "供应商关系",
      description: "抽取供应商合作关系",
      entityTypes: ["供应商"],
      relationTypes: ["供应"],
      instructions: "注意多级供应",
    });
    expect(manager.listGraphTemplates().map((item) => item.name)).toEqual(["供应商关系"]);
    expect(manager.deleteGraphTemplate("供应商关系")).toBe(true);
    expect(manager.listGraphTemplates()).toEqual([]);
    expect(manager.deleteGraphTemplate("供应商关系")).toBe(false);
  });

  test("graphStatus 反映抽取状态（未抽取）", async () => {
    const { manager } = createManager();
    manager.createProject("p1");
    await manager.uploadDocuments("p1", [{ name: "文档.txt", data: Buffer.from("内容", "utf8") }]);
    manager.saveGraphTemplate({ name: "t1", entityTypes: [], relationTypes: [] });
    expect(manager.graphStatus("p1", "文档")).toEqual([{ templateName: "t1", extracted: false, page: undefined }]);
  });
});
