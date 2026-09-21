/**
 * kb PDF 摄入冒烟测试：在 Electron 主进程里用真实配置跑一遍摄入管线。
 *
 * 用法: electron scripts/kb-pdf-smoke.cjs <pdf路径>
 * - 从 %APPDATA%/HyBot/data/state.json 读模型服务商，safeStorage 解密 API key
 * - 文本用激活服务商，视觉/OCR 用多模态勾选服务商（与 runtime 选型逻辑一致）
 * - 在临时目录建 kbRoot，不碰运行中应用的数据
 */
const { app, safeStorage } = require("electron");
const { mkdtempSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

async function main() {
  // 与 dev 应用共用 userData：safeStorage 的 AES key 存在该目录 Local State 里（DPAPI 包裹），
  // 不指向这里则解密不了应用保存的 API key。
  app.setPath("userData", join(process.env.APPDATA, "HyBot"));
  await app.whenReady();
  const { KbManager, OpenAIChatCompletionsAdapter } = require("../packages/runtime/dist");

  const statePath = join(process.env.APPDATA, "HyBot", "data", "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const decrypt = (secret) => {
    if (!secret || !secret.startsWith("safe:v1:")) {
      return secret;
    }
    try {
      return safeStorage.decryptString(Buffer.from(secret.slice("safe:v1:".length), "base64"));
    } catch {
      return undefined; // 安装版加密 app-bound 到 HyWork.exe，dev electron 解不开
    }
  };
  const providers = (state.modelProviders || []).map((p) => ({ ...p, apiKey: decrypt(p.apiKeySecret) }));
  for (const p of providers) {
    console.log(
      `[smoke] provider ${p.providerName}/${p.model} multimodal=${p.multimodal === true} key=${p.apiKey ? "ok" : "unavailable"}`,
    );
  }
  const usable = providers.filter((p) => p.apiKey);
  const activeRaw = providers.find((p) => p.id === state.activeModelProviderId) || providers[0];
  // 激活服务商 key 解不开时，用任一可用 key 的服务商顶替文本路径，保证管线能跑通
  const active = activeRaw?.apiKey ? activeRaw : usable[0];
  if (!active?.apiKey) {
    throw new Error("没有可解密的 API key（请在 dev 窗体里重新保存一次服务商的 API key）");
  }
  if (active !== activeRaw) {
    console.log(
      `[smoke] active provider key unavailable, falling back to ${active.providerName}/${active.model} for text path`,
    );
  }
  // 与 runtime.resolveVisionModelProvider 同规则：激活且多模态 > 第一个多模态 > 回退激活
  const vision =
    activeRaw.multimodal && activeRaw.apiKey ? activeRaw : providers.find((p) => p.multimodal && p.apiKey) || active;
  console.log(`[smoke] text provider: ${active.providerName}/${active.model}`);
  console.log(
    `[smoke] vision provider: ${vision.providerName}/${vision.model} (multimodal=${vision.multimodal === true})`,
  );

  const toConfig = (p) => ({
    providerName: p.providerName,
    baseUrl: p.baseUrl,
    model: p.model,
    temperature: p.temperature,
    maxTokens: p.maxTokens,
    apiKeySaved: Boolean(p.apiKey),
  });
  const kbRoot = mkdtempSync(join(tmpdir(), "kb-smoke-"));
  const kb = new KbManager({
    kbRoot,
    adapter: new OpenAIChatCompletionsAdapter(),
    resolveModel: () => ({ modelConfig: toConfig(active), apiKey: active.apiKey }),
    resolveVisionModel: () => ({ modelConfig: toConfig(vision), apiKey: vision.apiKey }),
    onEvent: (task) => console.log(`[task] ${task.status} progress=${task.progress} ${task.error || ""}`),
  });

  kb.createProject("smoke");
  const files = process.argv.slice(2);
  if (!files.length) {
    throw new Error("用法: electron scripts/kb-pdf-smoke.cjs <文件路径>...");
  }
  const tasks = await kb.uploadDocuments(
    "smoke",
    files.map((file) => ({ name: file.split(/[\\/]/).pop(), data: readFileSync(file) })),
  );
  for (const task of tasks) {
    console.log(`[final] ${task.status}${task.error ? ` error=${task.error}` : ""}`);
  }
  console.log(
    "[docs]",
    JSON.stringify(kb.listDocuments("smoke").map((d) => ({ file: d.fileName, status: d.task?.status }))),
  );
  console.log("[wiki]", JSON.stringify(kb.listWikiPages("smoke")));
  console.log("[reviews]", JSON.stringify(kb.listReviews("smoke")));

  for (const file of files) {
    const stem = file
      .split(/[\\/]/)
      .pop()
      .replace(/\.[^.]*$/, "");
    const deleted = await kb.deleteSource("smoke", stem);
    console.log(`[delete] ${stem}:`, JSON.stringify(deleted));
  }
  app.exit(0);
}

main().catch((error) => {
  console.error("[smoke] FAILED:", error);
  app.exit(1);
});
