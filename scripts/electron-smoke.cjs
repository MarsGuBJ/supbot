const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let electron;
try {
  electron = require("electron");
} catch {
  const isWindows = process.platform === "win32";
  electron = path.resolve("node_modules", ".bin", isWindows ? "electron.cmd" : "electron");
}
const appDir = path.resolve("apps", "desktop");
const port = 9323;
const smokeUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "supbot-smoke-"));
const smokeMcpServerPath = writeSmokeMcpServer(smokeUserDataDir);
seedSmokeState(smokeUserDataDir, smokeMcpServerPath);

const child = spawn(electron, [`--remote-debugging-port=${port}`, "."], {
  cwd: appDir,
  env: { ...process.env, SUPBOT_USER_DATA_DIR: smokeUserDataDir },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"]
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function evaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 1;
  const send = (method, params) => new Promise((resolve, reject) => {
    const messageId = id++;
    const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 5000);
    const onMessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id === messageId) {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        resolve(data);
      }
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id: messageId, method, params }));
  });
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  ws.close();
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime evaluation failed.");
  }
  return result.result.result.value;
}

async function main() {
  await sleep(5000);
  const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const page = pages.find((item) => item.type === "page") || pages[0];
  if (!page) {
    throw new Error("No Electron page exposed through DevTools.");
  }
  const diagnostics = await collectDiagnostics(page.webSocketDebuggerUrl);
  const rootChildren = await evaluate(page.webSocketDebuggerUrl, "document.getElementById('root')?.children.length ?? -1");
  const bodyText = await evaluate(page.webSocketDebuggerUrl, "document.body.innerText");
  const bodyHtml = await evaluate(page.webSocketDebuggerUrl, "document.body.innerHTML");
  const layoutMetrics = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const rectFor = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          bottom: rect.bottom,
          clientHeight: el.clientHeight,
          height: rect.height,
          overflowY: style.overflowY,
          position: style.position,
          distanceFromBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          top: rect.top
        };
      };
      return {
        bodyOverflowY: getComputedStyle(document.body).overflowY,
        documentScrollHeight: document.documentElement.scrollHeight,
        viewport: window.innerHeight,
        chat: rectFor(".chat-panel"),
        composer: rectFor(".composer"),
        leftScroll: rectFor(".panel-scroll"),
        messageStream: rectFor(".message-stream"),
        rightScroll: rectFor(".activity-list")
      };
    })()`
  );
  const text = String(bodyText);
  const hasSupbot = text.includes("Supbot");
  const hasDefaultChinese = text.includes("本地智能体控制台") && text.includes("对话") && text.includes("配置");
  const toolUi = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => ({
      hasToolCard: Boolean(document.querySelector(".tool-card")),
      hasToolResult: document.body.innerText.includes("Tool completed from smoke"),
      hasToolResultParts: Boolean(document.querySelector(".tool-result-part")),
      hasToolResultPartTypes: document.body.innerText.includes("image/png") && document.body.innerText.includes("resource text"),
      hasTruncatedMarker: document.body.innerText.includes("已截断") || document.body.innerText.includes("truncated")
    }))()`
  );
  console.log(JSON.stringify({
    rootChildren,
    hasSupbot,
    hasDefaultChinese,
    layoutMetrics,
    toolUi,
    url: page.url,
    bodyText: text.slice(0, 600),
    bodyHtml: String(bodyHtml).slice(0, 600),
    diagnostics,
    stderr: stderr.slice(0, 600)
  }, null, 2));
  if (!rootChildren || !hasSupbot || !hasDefaultChinese) {
    throw new Error("Electron renderer did not render the Supbot workspace.");
  }
  if (!toolUi?.hasToolCard || !toolUi?.hasToolResult || !toolUi.hasToolResultParts || !toolUi.hasToolResultPartTypes || !toolUi.hasTruncatedMarker) {
    throw new Error("Tool call cards did not render in the chat stream.");
  }
  await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const tasksTab = [...document.querySelectorAll('[role="tab"]')].find((el) => el.textContent?.includes("任务") || el.textContent?.includes("Tasks"));
      tasksTab?.click();
      return Boolean(tasksTab);
    })()`
  );
  await sleep(300);
  const pendingBeforeDeny = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => ({
      hasPendingPermission: document.body.innerText.includes("smoke pending shell"),
      pendingCount: document.querySelectorAll(".tool-approval").length
    }))()`
  );
  if (!pendingBeforeDeny?.hasPendingPermission || pendingBeforeDeny.pendingCount !== 1) {
    throw new Error("Pending tool approval did not render in the tasks panel.");
  }
  const permissionAfterDeny = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const deny = document.querySelector(".tool-approval button.ant-btn-dangerous") ||
        [...document.querySelectorAll(".tool-approval button")].find((el) => el.textContent?.includes("拒绝") || el.textContent?.includes("Deny"));
      deny?.click();
      return { clicked: Boolean(deny) };
    })()`
  );
  let pendingAfterDeny = 1;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(100);
    pendingAfterDeny = await evaluate(page.webSocketDebuggerUrl, `document.querySelectorAll(".tool-approval").length`);
    if (pendingAfterDeny === 0) {
      break;
    }
  }
  if (!permissionAfterDeny?.clicked || pendingAfterDeny !== 0) {
    throw new Error("Tool approval deny action did not clear the pending permission.");
  }
  const runtimeVisibility = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => ({
      hasCompactHistory: Boolean(document.querySelector(".compact-history-item")) && document.body.innerText.includes("Smoke compact summary"),
      hasRuntimeSession: document.body.innerText.includes("Main agent")
    }))()`
  );
  if (!runtimeVisibility?.hasCompactHistory || !runtimeVisibility?.hasRuntimeSession) {
    throw new Error("Runtime compact history/session UI did not render.");
  }
  const memoryClick = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const memoryTab = document.querySelector('#rc-tabs-0-tab-memory') ||
        [...document.querySelectorAll('.activity-panel [role="tab"]')].find((el) => el.textContent?.includes("Memory") || el.textContent?.includes("记忆"));
      memoryTab?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return { clickedMemory: Boolean(memoryTab), text: memoryTab?.textContent || "" };
    })()`
  );
  await sleep(600);
  const memoryInitial = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => ({
      hasPanel: Boolean(document.querySelector(".memory-panel")),
      hasSearch: Boolean(document.querySelector(".memory-search-row input")),
      pendingCount: document.querySelectorAll(".memory-candidate-card").length,
      hasRecallHistory: Boolean(document.querySelector(".memory-recall-history")) && document.body.innerText.includes("Smoke recall query"),
      hasTransferBox: Boolean(document.querySelector(".memory-transfer-box")),
      hasSeedRecord: document.body.innerText.includes("Smoke recall fact"),
      hasDeleteButton: Boolean(document.querySelector(".memory-record button.ant-btn-dangerous")),
      hasDisableButton: [...document.querySelectorAll(".memory-record button")].some((el) => !el.classList.contains("ant-btn-dangerous"))
    }))()`
  );
  console.log(JSON.stringify({ memoryClick, memoryInitial }, null, 2));
  if (!memoryClick?.clickedMemory || !memoryInitial?.hasPanel || !memoryInitial.hasSearch || memoryInitial.pendingCount !== 3 || !memoryInitial.hasRecallHistory || !memoryInitial.hasTransferBox || !memoryInitial.hasSeedRecord || !memoryInitial.hasDeleteButton || !memoryInitial.hasDisableButton) {
    throw new Error("Memory management UI did not render candidates, records, search, and actions.");
  }
  const batchCandidates = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const boxes = [...document.querySelectorAll(".memory-candidate-card .ant-checkbox-input")];
      boxes.slice(0, 2).forEach((box) => box.click());
      const approve = [...document.querySelectorAll(".memory-candidate-list button")]
        .find((el) => el.textContent?.includes("Approve selected") || el.textContent?.includes("批准"));
      approve?.click();
      return { selected: boxes.length, clickedApprove: Boolean(approve) };
    })()`
  );
  let pendingMemoryAfterApprove = 3;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(100);
    pendingMemoryAfterApprove = await evaluate(page.webSocketDebuggerUrl, `document.querySelectorAll(".memory-candidate-card").length`);
    if (pendingMemoryAfterApprove === 1) {
      break;
    }
  }
  if (batchCandidates?.selected !== 3 || !batchCandidates.clickedApprove || pendingMemoryAfterApprove !== 1) {
    throw new Error("Memory candidate batch approve action did not leave one pending candidate.");
  }
  const denyMemory = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const deny = document.querySelector(".memory-candidate-card button.ant-btn-dangerous") ||
        [...document.querySelectorAll(".memory-candidate-card button")].find((el) => el.textContent?.includes("Deny") || el.textContent?.includes("拒绝"));
      deny?.click();
      return { clicked: Boolean(deny) };
    })()`
  );
  let pendingMemoryAfterDeny = 1;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(100);
    pendingMemoryAfterDeny = await evaluate(page.webSocketDebuggerUrl, `document.querySelectorAll(".memory-candidate-card").length`);
    if (pendingMemoryAfterDeny === 0) {
      break;
    }
  }
  if (pendingMemoryAfterDeny !== 0) {
    throw new Error("Memory candidate deny action did not clear the pending candidate.");
  }
  const recallDebugClick = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const debug = [...document.querySelectorAll(".memory-summary .ant-segmented-item-label")]
        .find((el) => el.textContent?.includes("Recall debug") || el.textContent?.includes("调试"));
      debug?.click();
      return { clicked: Boolean(debug) };
    })()`
  );
  await sleep(300);
  const recallDebugVisible = await evaluate(
    page.webSocketDebuggerUrl,
    `Boolean(document.querySelector(".memory-debug-panel")) && Boolean(document.querySelector(".memory-debug-panel input"))`
  );
  const recallReplay = await evaluate(
    page.webSocketDebuggerUrl,
    `window.supbot.replayMemoryRecall({ query: "Smoke durable", conversationId: "conv_smoke", scope: "all", limit: 5, budgetChars: 500 })
      .then((result) => ({
        resultCount: result.results.length,
        hasPreview: Boolean(result.blockPreview),
        excludedCount: result.excludedResults.length
      }))`
  );
  if (!recallDebugClick?.clicked || !recallDebugVisible || !recallReplay?.resultCount || !recallReplay.hasPreview) {
    throw new Error("Memory recall debug replay did not render a replay result.");
  }
  const recallFeedback = await evaluate(
    page.webSocketDebuggerUrl,
    `window.supbot.addMemoryRecallFeedback({ memoryId: "mem_fact_smoke", kind: "useful", query: "Smoke durable", recallId: "mem_recall_smoke" })
      .then((feedback) => ({ clicked: Boolean(feedback.id) }))`
  );
  await sleep(300);
  const feedbackCount = await evaluate(page.webSocketDebuggerUrl, `window.supbot.snapshot().then((snapshot) => snapshot.memory.recallFeedback.length)`);
  if (!recallFeedback?.clicked || feedbackCount < 1) {
    throw new Error("Memory recall feedback action did not persist feedback.");
  }
  await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const manage = [...document.querySelectorAll(".memory-summary .ant-segmented-item-label")]
        .find((el) => el.textContent?.includes("Manage") || el.textContent?.includes("管理"));
      manage?.click();
      return Boolean(manage);
    })()`
  );
  await sleep(300);
  const memorySearchCount = await evaluate(
    page.webSocketDebuggerUrl,
    `window.supbot.searchMemory({ query: "Smoke durable", conversationId: "conv_smoke", includeDisabled: true }).then((items) => items.length)`
  );
  if (!memorySearchCount) {
    throw new Error("Memory search IPC did not return the seeded memory item.");
  }
  const transferCheck = await evaluate(
    page.webSocketDebuggerUrl,
    `window.supbot.exportMemory()
      .then(async (transfer) => {
        const backup = await window.supbot.backupMemory();
        await window.supbot.importMemory({ data: transfer, mode: "merge" });
        await window.supbot.restoreMemory(backup.path);
        return {
          version: transfer.version,
          hasFacts: transfer.memory.facts.length > 0,
          backupPath: backup.path,
          restoredCount: (await window.supbot.searchMemory({ query: "Smoke durable", includeDisabled: true })).length
        };
      })`
  );
  if (transferCheck?.version !== 1 || !transferCheck.hasFacts || !transferCheck.backupPath || !transferCheck.restoredCount) {
    throw new Error("Memory export/import/backup/restore IPC did not complete.");
  }
  const disableMemory = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const boxes = [...document.querySelectorAll(".memory-record .ant-checkbox-input")];
      boxes.slice(0, 2).forEach((box) => box.click());
      const disable = [...document.querySelectorAll(".memory-record-list button")]
        .find((el) => el.textContent?.includes("Disable selected") || el.textContent?.includes("禁用"));
      disable?.click();
      return { selected: Math.min(boxes.length, 2), clicked: Boolean(disable) };
    })()`
  );
  let disabledRecords = 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(100);
    disabledRecords = await evaluate(page.webSocketDebuggerUrl, `document.querySelectorAll(".memory-record.status-disabled").length`);
    if (disabledRecords > 0) {
      break;
    }
  }
  if (!disableMemory?.clicked || !disableMemory.selected || disabledRecords < 1) {
    throw new Error("Memory disable action did not update a memory record.");
  }
  const deleteMemory = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const before = document.querySelectorAll(".memory-record").length;
      const boxes = [...document.querySelectorAll(".memory-record .ant-checkbox-input")];
      boxes.slice(0, 1).forEach((box) => {
        if (!box.checked) box.click();
      });
      const del = [...document.querySelectorAll(".memory-record-list button")]
        .find((el) => el.textContent?.includes("Delete selected") || el.textContent?.includes("删除"));
      del?.click();
      setTimeout(() => {
        const confirm = document.querySelector(".ant-popconfirm-buttons .ant-btn-primary");
        confirm?.click();
      }, 50);
      return { clicked: Boolean(del), before };
    })()`
  );
  let memoryRecordsAfterDelete = deleteMemory?.before || 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(100);
    memoryRecordsAfterDelete = await evaluate(page.webSocketDebuggerUrl, `document.querySelectorAll(".memory-record").length`);
    if (memoryRecordsAfterDelete < deleteMemory.before) {
      break;
    }
  }
  if (!deleteMemory?.clicked || memoryRecordsAfterDelete >= deleteMemory.before) {
    throw new Error("Memory delete action did not remove a memory record.");
  }
  const configClick = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const configControl = [...document.querySelectorAll(".topbar .ant-segmented-item-label")]
        .find((el) => el.textContent?.includes("配置") || el.textContent?.includes("Config"));
      configControl?.click();
      return { clickedConfig: Boolean(configControl) };
    })()`
  );
  await sleep(300);
  const permissionRuleUi = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const capabilityTab = [...document.querySelectorAll('[role="tab"]')].find((el) => el.textContent?.includes("能力") || el.textContent?.includes("Capabilities"));
      capabilityTab?.click();
      return {
        clickedCapabilities: Boolean(capabilityTab),
        hasRuleRow: Boolean(document.querySelector(".permission-rule-row")),
        hasRuleBuilder: Boolean(document.querySelector(".permission-rule-builder")),
        hasShellRule: document.body.innerText.includes("Shell")
      };
    })()`
  );
  await sleep(300);
  const permissionRuleUiAfterClick = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => ({
      hasRuleRow: Boolean(document.querySelector(".permission-rule-row")),
      hasRuleBuilder: Boolean(document.querySelector(".permission-rule-builder")),
      hasShellRule: document.body.innerText.includes("Shell")
    }))()`
  );
  if (!configClick?.clickedConfig || !permissionRuleUi?.clickedCapabilities || !permissionRuleUiAfterClick.hasRuleRow || !permissionRuleUiAfterClick.hasRuleBuilder || !permissionRuleUiAfterClick.hasShellRule) {
    throw new Error("Permission rule UI did not render in the capabilities config.");
  }
  const mcpTabClick = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const mcpTab = [...document.querySelectorAll('[role="tab"]')].find((el) => el.textContent?.includes("MCP"));
      mcpTab?.click();
      return { clickedMcp: Boolean(mcpTab) };
    })()`
  );
  await sleep(300);
  const mcpUi = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => ({
      hasPanel: Boolean(document.querySelector(".mcp-server-card")),
      hasSeedServer: document.body.innerText.includes("Smoke MCP"),
      hasStatusGrid: Boolean(document.querySelector(".mcp-status-grid")),
      hasTimeoutField: document.body.innerText.includes("Request timeout") || document.body.innerText.includes("Timeout"),
      hasPresetSelect: Boolean(document.querySelector(".mcp-preset-select")),
      hasTransferButtons: document.body.innerText.includes("Export MCP") && document.body.innerText.includes("Import MCP"),
      hasDiagnoseButton: document.body.innerText.includes("Diagnose"),
      hasCopyButtons: (document.body.innerText.includes("Copy diagnostic summary") || document.body.innerText.includes("复制诊断摘要")) && (document.body.innerText.includes("Copy tool list") || document.body.innerText.includes("复制工具清单")),
      hasSchemaWarning: document.body.innerText.includes("schema warning") || document.body.innerText.includes("schema 警告")
    }))()`
  );
  const mcpIpc = await evaluate(
    page.webSocketDebuggerUrl,
    `window.supbot.listMcpServers()
      .then(async (servers) => {
        const seed = servers.find((server) => server.id === "smoke-mcp");
        if (seed) {
          await window.supbot.connectMcpServer(seed.id);
          await window.supbot.refreshMcpTools(seed.id);
        }
        const added = await window.supbot.addMcpServer({ name: "Smoke Added MCP", command: "node", args: ["mock-mcp.cjs"], env: { SECRET_TOKEN: "smoke-secret" }, requestTimeoutMs: 1500, enabled: false });
        await window.supbot.updateMcpServer(added.id, { autoConnect: true, requestTimeoutMs: 2500 });
        const logs = await window.supbot.getMcpLogs(added.id);
        const presets = await window.supbot.listMcpPresets();
        const exported = await window.supbot.exportMcpConfig();
        const imported = await window.supbot.importMcpConfig({
          version: 1,
          exportedAt: new Date().toISOString(),
          servers: [{ name: "Smoke Imported MCP", command: "node", args: ["mock-mcp.cjs"], enabled: false, autoConnect: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
          permissionRules: []
        });
        const diagnostic = await window.supbot.diagnoseMcpServer({ name: "Smoke Bad Diagnostic", command: "definitely-not-a-real-mcp-command", enabled: true, requestTimeoutMs: 1000 });
        const diagnosticShape = {
          hasErrorCode: "errorCode" in diagnostic,
          hasCapabilities: "capabilities" in diagnostic,
          hasProtocol: "protocolVersion" in diagnostic
        };
        await window.supbot.addPermissionRule({ toolName: "mcp.smoke-mcp.*", behavior: "ask" });
        await window.supbot.removeMcpServer(added.id);
        if (imported.servers[0]) {
          await window.supbot.removeMcpServer(imported.servers[0].id);
        }
        const after = await window.supbot.listMcpServers();
        const rules = (await window.supbot.snapshot()).permissionRules;
        const snapshot = await window.supbot.snapshot();
        return {
          before: servers.length,
          after: after.length,
          added: Boolean(added.id),
          logs: Array.isArray(logs),
          timeout: added.requestTimeoutMs,
          presets: presets.length,
          redacted: JSON.stringify(exported).includes("redacted"),
          imported: imported.imported,
          diagnosticFailed: diagnostic.ok === false,
          diagnosticShape,
          hasSeedToolWarning: snapshot.mcpTools.some((tool) => tool.serverId === "smoke-mcp" && tool.schemaValid === false && tool.schemaWarnings.length),
          hasMcpRule: rules.some((rule) => rule.toolName === "mcp.smoke-mcp.*")
        };
      })`
  );
  if (!mcpTabClick?.clickedMcp || !mcpUi?.hasPanel || !mcpUi.hasSeedServer || !mcpUi.hasStatusGrid || !mcpUi.hasTimeoutField || !mcpUi.hasPresetSelect || !mcpUi.hasTransferButtons || !mcpUi.hasDiagnoseButton || !mcpUi.hasCopyButtons || !mcpIpc?.added || !mcpIpc.logs || mcpIpc.timeout !== 1500 || !mcpIpc.presets || !mcpIpc.redacted || mcpIpc.imported !== 1 || !mcpIpc.diagnosticFailed || !mcpIpc.diagnosticShape?.hasErrorCode || !mcpIpc.diagnosticShape?.hasCapabilities || !mcpIpc.diagnosticShape?.hasProtocol || !mcpIpc.hasSeedToolWarning || !mcpIpc.hasMcpRule || mcpIpc.after !== mcpIpc.before) {
    throw new Error(`MCP server UI or IPC smoke checks failed: ${JSON.stringify({ mcpTabClick, mcpUi, mcpIpc })}`);
  }
  const chatClick = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const chatControl = [...document.querySelectorAll(".topbar .ant-segmented-item-label")]
        .find((el) => el.textContent?.includes("对话") || el.textContent?.includes("Chat"));
      chatControl?.click();
      return { clickedChat: Boolean(chatControl) };
    })()`
  );
  await sleep(300);
  if (!chatClick?.clickedChat) {
    throw new Error("Could not return to the chat workspace after config smoke checks.");
  }
  if (!layoutMetrics || layoutMetrics.bodyOverflowY !== "hidden" || layoutMetrics.documentScrollHeight > layoutMetrics.viewport + 2) {
    throw new Error("Window-level scrolling is still enabled.");
  }
  if (!layoutMetrics.chat || !layoutMetrics.composer || Math.abs(layoutMetrics.composer.bottom - layoutMetrics.chat.bottom) > 2) {
    throw new Error("Composer is not anchored to the bottom of the chat panel.");
  }
  if (layoutMetrics.composer.position === "fixed") {
    throw new Error("Composer is still fixed to the window instead of the chat panel.");
  }
  for (const key of ["leftScroll", "messageStream", "rightScroll"]) {
    if (!layoutMetrics[key] || layoutMetrics[key].overflowY !== "auto") {
      throw new Error(`${key} does not expose an independent scrollbar region.`);
    }
  }
  if (layoutMetrics.messageStream.distanceFromBottom > 2) {
    throw new Error("Message stream did not start at the bottom.");
  }
  const scrollAfterRefresh = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const stream = document.querySelector(".message-stream");
      const refresh = document.querySelector(".topbar-actions button");
      if (!stream || !refresh) return null;
      const spacer = document.createElement("div");
      spacer.className = "smoke-scroll-spacer";
      spacer.style.height = "220px";
      stream.appendChild(spacer);
      stream.scrollTop = 0;
      stream.dispatchEvent(new Event("scroll", { bubbles: true }));
      refresh.click();
      return stream.scrollTop;
    })()`
  );
  await sleep(1000);
  const scrollAfterSettling = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const stream = document.querySelector(".message-stream");
      if (!stream) return null;
      return {
        distanceFromBottom: stream.scrollHeight - stream.scrollTop - stream.clientHeight,
        scrollTop: stream.scrollTop
      };
    })()`
  );
  console.log(JSON.stringify({ scrollAfterRefresh, scrollAfterSettling }, null, 2));
  if (!scrollAfterSettling || scrollAfterSettling.scrollTop > 2) {
    throw new Error("Message stream ignored manual scrolling away from the bottom.");
  }
}

async function collectDiagnostics(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const events = [];
  ws.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    if (data.method === "Runtime.exceptionThrown") {
      events.push({ type: "exception", text: data.params.exceptionDetails?.text, description: data.params.exceptionDetails?.exception?.description });
    }
    if (data.method === "Runtime.consoleAPICalled") {
      events.push({ type: "console", level: data.params.type, args: data.params.args?.map((arg) => arg.value || arg.description).join(" ") });
    }
    if (data.method === "Log.entryAdded") {
      events.push({ type: "log", level: data.params.entry.level, text: data.params.entry.text });
    }
  });
  let id = 1;
  const send = (method, params) => new Promise((resolve, reject) => {
    const messageId = id++;
    const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 5000);
    const onMessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id === messageId) {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        resolve(data);
      }
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id: messageId, method, params }));
  });
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Runtime.evaluate", {
    expression: "window.__supbotSmoke = { root: document.getElementById('root')?.innerHTML || '', text: document.body.innerText, errors: [] }",
    returnByValue: true
  });
  await sleep(500);
  const state = await send("Runtime.evaluate", {
    expression: "window.__supbotSmoke",
    returnByValue: true
  });
  ws.close();
  return {
    events: events.slice(0, 10),
    state: state.result?.result?.value
  };
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    child.kill();
    fs.rmSync(smokeUserDataDir, { recursive: true, force: true });
  });

function writeSmokeMcpServer(userDataDir) {
  const serverPath = path.join(userDataDir, "mock-mcp.cjs");
  fs.writeFileSync(serverPath, `
let buffer = Buffer.alloc(0);
process.stderr.write("smoke mcp stderr tail\\n");
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\\s*(\\d+)/i);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
    buffer = buffer.subarray(bodyStart + length);
    handle(JSON.parse(body));
  }
});
function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n", "utf8"), body]));
}
function handle(request) {
  if (!request.id) return;
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "smoke-mcp", version: "1.0.0" } } });
    return;
  }
  if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "rich", description: "Smoke rich result tool.", inputSchema: { type: "object", properties: { message: { type: "bogus" } }, required: ["missing"], additionalProperties: false } }] } });
    return;
  }
  if (request.method === "tools/call") {
    send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "smoke" }] } });
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown method" } });
}
`, "utf8");
  return serverPath;
}

function seedSmokeState(userDataDir, smokeMcpServerPath) {
  const dataDir = path.join(userDataDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const now = new Date().toISOString();
  const conversationId = "conv_smoke";
  const jobId = "job_smoke";
  const toolCallId = "call_smoke";
  const compactId = "compact_smoke";
  const ruleId = "rule_smoke";
  const memoryFactId = "mem_fact_smoke";
  const memoryPageId = "mem_page_smoke";
  fs.writeFileSync(path.join(dataDir, "state.json"), `${JSON.stringify({
    agentName: "Supbot Local Agent",
    modelConfig: {
      providerName: "OpenAI Compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      temperature: 0.2,
      maxTokens: 1600,
      apiKeySaved: false
    },
    toolMarketConfig: {
      source: "hybrid",
      apiUrl: "http://localhost:3000/subscriber/market/api",
      accountEmail: "subscriber@example.com",
      accessTokenSaved: false,
      passwordSaved: false
    },
    personality: {
      summary: "A careful local desktop agent for coding, documents, and day-to-day automation.",
      traits: ["precise", "calm", "proactive"],
      instructions: "Work locally, explain important actions, and keep user data on this machine."
    },
    capabilities: [],
    subagents: [],
    conversations: [{
      id: conversationId,
      title: "Smoke tool call",
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
      messages: [
        { id: "msg_user_smoke", conversationId, role: "user", text: "show tool cards", createdAt: now },
        {
          id: "msg_assistant_smoke",
          conversationId,
          role: "assistant",
          text: "Tool completed from smoke.",
          createdAt: now,
          status: "completed",
          blocks: [
            { type: "tool_use", toolCallId, toolName: "ReadFile", input: { path: "D:/tmp/smoke.txt" }, status: "completed" },
            {
              type: "tool_result",
              toolCallId,
              toolName: "mcp.smoke-mcp.rich",
              output: "Tool completed from smoke.\n[image image/png, 12 base64 chars]\nresource text\n[truncated]",
              outputParts: [
                { type: "text", text: "Tool completed from smoke." },
                { type: "image", text: "[image image/png, 12 base64 chars]", mimeType: "image/png" },
                { type: "resource", text: "resource text", mimeType: "text/plain" }
              ],
              outputTruncated: true
            },
            { type: "text", text: "Tool completed from smoke." }
          ]
        }
      ]
    }],
    jobs: [{
      id: jobId,
      conversationId,
      prompt: "smoke pending shell",
      status: "running",
      createdAt: now,
      updatedAt: now,
      progress: ["Shell: pending_permission"]
    }],
    scheduledJobs: [],
    pendingToolPermissions: [{
      id: "perm_smoke",
      jobId,
      conversationId,
      toolCallId: "call_pending_smoke",
      toolName: "Shell",
      input: { command: "smoke pending shell" },
      summary: "smoke pending shell",
      createdAt: now
    }],
    agentLoopTraces: [{
      jobId,
      conversationId,
      turns: 1,
      toolCalls: [],
      startedAt: now,
      updatedAt: now
    }],
    querySessions: [{
      id: "query_smoke",
      jobId,
      conversationId,
      status: "running",
      turns: 1,
      startedAt: now,
      updatedAt: now
    }],
    runtimeEvents: [{
      id: "event_smoke",
      jobId,
      conversationId,
      kind: "query_start",
      message: "Smoke query started",
      createdAt: now
    }],
    compactBoundaries: [{
      id: compactId,
      conversationId,
      messageId: "msg_user_smoke",
      summary: "Smoke compact summary for visible history.",
      preservedMessageIds: ["msg_assistant_smoke"],
      originalMessageCount: 2,
      createdAt: now
    }],
    memory: {
      pages: [{
        id: memoryPageId,
        type: "page",
        scope: "global",
        title: "Smoke durable page",
        content: "Smoke durable page memory item for desktop management.",
        source: "smoke",
        status: "active",
        keywords: ["smoke", "durable", "page"],
        createdAt: now,
        updatedAt: now,
        accessCount: 0
      }],
      facts: [{
        id: memoryFactId,
        type: "fact",
        scope: "conversation",
        conversationId,
        title: "Smoke recall fact",
        content: "Smoke durable fact memory item for search and disable.",
        source: "smoke",
        status: "active",
        keywords: ["smoke", "durable", "fact"],
        createdAt: now,
        updatedAt: now,
        accessCount: 0,
        kind: "fact",
        confidence: 0.9
      }],
      chunks: [{
        id: "mem_chunk_smoke",
        memoryId: memoryFactId,
        memoryType: "fact",
        ordinal: 0,
        heading: "Smoke recall fact",
        content: "Smoke durable fact memory item for search and disable.",
        keywords: ["smoke", "durable", "fact"],
        createdAt: now
      }],
      links: [],
      candidates: [
        {
          id: "mem_candidate_smoke_approve",
          scope: "conversation",
          conversationId,
          title: "Smoke approve candidate",
          content: "Smoke candidate content that should become durable memory when approved.",
          source: `compact:${compactId}:approve`,
          kind: "fact",
          confidence: 0.72,
          keywords: ["smoke", "candidate", "approve"],
          status: "pending",
          createdAt: now,
          updatedAt: now
        },
        {
          id: "mem_candidate_smoke_deny",
          scope: "conversation",
          conversationId,
          title: "Smoke deny candidate",
          content: "Smoke candidate content that should stay out of permanent memory when denied.",
          source: `compact:${compactId}:deny`,
          kind: "warning",
          confidence: 0.61,
          keywords: ["smoke", "candidate", "deny"],
          status: "pending",
          createdAt: now,
          updatedAt: now
        },
        {
          id: "mem_candidate_smoke_extra",
          scope: "conversation",
          conversationId,
          title: "Smoke extra candidate",
          content: "Smoke extra candidate content keeps one pending item for denial after batch approval.",
          source: `compact:${compactId}:extra`,
          kind: "fact",
          confidence: 0.64,
          keywords: ["smoke", "candidate", "extra"],
          status: "pending",
          createdAt: now,
          updatedAt: now
        }
      ],
      recallHistory: [{
        id: "mem_recall_smoke",
        conversationId,
        query: "Smoke recall query",
        resultIds: [memoryFactId],
        resultCount: 1,
        injected: true,
        budgetChars: 6000,
        usedChars: 180,
        createdAt: now,
        results: [{
          id: memoryFactId,
          title: "Smoke recall fact",
          score: 4.2,
          matchedKeywords: ["smoke", "durable"],
          reason: "Matched smoke, durable",
          sourceLabel: "Smoke seed"
        }],
        excludedResults: [{
          id: memoryPageId,
          title: "Smoke durable page",
          score: 2.1,
          matchedKeywords: ["smoke"],
          reason: "Budget excluded",
          sourceLabel: "Smoke seed"
        }],
        blockPreview: "<memory>\\n#1 [conversation] Smoke recall fact\\nSmoke durable fact memory item for search and disable.\\n</memory>"
      }],
      recallFeedback: []
    },
    permissionMode: "default",
    permissionRules: [{
      id: ruleId,
      toolName: "Shell",
      behavior: "ask",
      scope: "session",
      createdAt: now
    }],
    mcpServers: [{
      id: "smoke-mcp",
      name: "Smoke MCP",
      command: process.execPath,
      args: [smokeMcpServerPath],
      requestTimeoutMs: 1500,
      enabled: true,
      autoConnect: false,
      createdAt: now,
      updatedAt: now,
      status: {
        serverId: "smoke-mcp",
        state: "disconnected",
        toolCount: 1,
        updatedAt: now,
        stderrPreview: "smoke stderr tail",
        lastExitReason: "smoke exit"
      }
    }],
    mcpTools: [{
      serverId: "smoke-mcp",
      serverName: "Smoke MCP",
      name: "rich",
      runtimeToolName: "mcp.smoke-mcp.rich",
      modelToolName: "mcp__smoke-mcp__rich",
      description: "Smoke rich result tool.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
        additionalProperties: false
      },
      schemaValid: false,
      schemaWarnings: ["smoke schema warning"],
      connected: false
    }]
  }, null, 2)}\n`, "utf8");
}
