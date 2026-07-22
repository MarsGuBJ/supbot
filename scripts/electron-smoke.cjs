const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { createServer } = require("node:http");
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
const servstationPort = 9324;
const servstationBaseUrl = `http://127.0.0.1:${servstationPort}`;
const servstationServer = createSmokeServstationServer();
servstationServer.listen(servstationPort, "127.0.0.1");
const smokeUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hbclient-smoke-"));
const smokeMcpServerPath = writeSmokeMcpServer(smokeUserDataDir);
seedSmokeState(smokeUserDataDir, smokeMcpServerPath);

const child = spawn(electron, [`--remote-debugging-port=${port}`, "."], {
  cwd: appDir,
  env: {
    ...process.env,
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/",
    HBCLIENT_USER_DATA_DIR: smokeUserDataDir,
  },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const smokeDeadline = setTimeout(() => {
  console.error("Electron smoke timed out.", { stderr: stderr.slice(0, 1200) });
  child.kill();
  servstationServer.close();
  process.exit(1);
}, 90_000);

function step(name) {
  console.error(`[smoke] ${name}`);
}

function waitForWebSocketOpen(ws, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out opening WebSocket for ${label}`));
    }, 5000);
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`WebSocket failed for ${label}`));
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
  });
}

async function evaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  await waitForWebSocketOpen(ws, "evaluate");
  let id = 1;
  const send = (method, params) =>
    new Promise((resolve, reject) => {
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

async function waitForMessageStreamAtBottom(wsUrl) {
  let latest = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    latest = await evaluate(
      wsUrl,
      `(() => {
        const stream = document.querySelector(".message-stream");
        if (!stream) return null;
        return {
          distanceFromBottom: stream.scrollHeight - stream.scrollTop - stream.clientHeight,
          scrollTop: stream.scrollTop,
          scrollHeight: stream.scrollHeight,
          clientHeight: stream.clientHeight
        };
      })()`,
    );
    if (latest && latest.distanceFromBottom <= 2) {
      return latest;
    }
    await sleep(150);
  }
  return latest;
}

async function main() {
  step("waiting for Electron");
  await sleep(5000);
  step("fetching DevTools pages");
  const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const page = pages.find((item) => item.type === "page") || pages[0];
  if (!page) {
    throw new Error("No Electron page exposed through DevTools.");
  }
  step(`using page ${page.url}`);
  const diagnostics = await collectDiagnostics(page.webSocketDebuggerUrl);
  step("checking rendered shell");
  const rootChildren = await evaluate(
    page.webSocketDebuggerUrl,
    "document.getElementById('root')?.children.length ?? -1",
  );
  await waitForMessageStreamAtBottom(page.webSocketDebuggerUrl);
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
    })()`,
  );
  const text = String(bodyText);
  const hasHBClient = text.includes("HBClient");
  const hasDefaultChinese = text.includes("本地智能体控制台") && text.includes("对话") && text.includes("配置");
  const collapsedToolUi = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => ({
      hasToolCard: Boolean(document.querySelector(".tool-card")),
      hasToolResultHeader: document.body.innerText.includes("工具结果") || document.body.innerText.includes("Tool result"),
      hasToolResultToggle: Boolean(document.querySelector(".tool-result-toggle[aria-expanded='false']")),
      isToolResultCollapsed: Boolean(document.querySelector(".tool-card.result.is-collapsed")) && !document.querySelector(".tool-result-content"),
      hasTruncatedMarker: document.body.innerText.includes("已截断") || document.body.innerText.includes("truncated")
    }))()`,
  );
  const expandedToolUi = await evaluate(
    page.webSocketDebuggerUrl,
    `(async () => {
      const toggle = document.querySelector(".tool-result-toggle");
      toggle?.click();
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      return {
        hasExpandedToggle: Boolean(document.querySelector(".tool-result-toggle[aria-expanded='true']")),
        hasToolResult: document.body.innerText.includes("Tool completed from smoke"),
        hasToolResultParts: Boolean(document.querySelector(".tool-result-part")),
        hasToolResultPartTypes: document.body.innerText.includes("image/png") && document.body.innerText.includes("resource text")
      };
    })()`,
  );
  console.log(
    JSON.stringify(
      {
        rootChildren,
        hasHBClient,
        hasDefaultChinese,
        layoutMetrics,
        toolUi: { collapsed: collapsedToolUi, expanded: expandedToolUi },
        url: page.url,
        bodyText: text.slice(0, 600),
        bodyHtml: String(bodyHtml).slice(0, 600),
        diagnostics,
        stderr: stderr.slice(0, 600),
      },
      null,
      2,
    ),
  );
  if (!rootChildren || !hasHBClient || !hasDefaultChinese) {
    throw new Error("Electron renderer did not render the HBClient workspace.");
  }
  const securityWarning = diagnostics.events.find((event) => {
    const text = `${event.args || ""} ${event.text || ""}`;
    return text.includes("Electron Security Warning") || text.includes("Insecure Content-Security-Policy");
  });
  if (securityWarning) {
    throw new Error(`Electron security warning emitted: ${JSON.stringify(securityWarning)}`);
  }
  if (
    !collapsedToolUi?.hasToolCard ||
    !collapsedToolUi.hasToolResultHeader ||
    !collapsedToolUi.hasToolResultToggle ||
    !collapsedToolUi.isToolResultCollapsed ||
    !collapsedToolUi.hasTruncatedMarker
  ) {
    throw new Error("Tool result card was not collapsed by default.");
  }
  if (
    !expandedToolUi?.hasExpandedToggle ||
    !expandedToolUi.hasToolResult ||
    !expandedToolUi.hasToolResultParts ||
    !expandedToolUi.hasToolResultPartTypes
  ) {
    throw new Error("Tool call cards did not render in the chat stream.");
  }
  const securityIpc = await evaluate(
    page.webSocketDebuggerUrl,
    `Promise.all([
      window.supbot.setPermissionMode("bypassPermissions").then(() => "allowed", (error) => String(error.message || error)),
      window.supbot.openFile(${JSON.stringify(path.join(os.tmpdir(), "hbclient-smoke-forbidden.txt"))}).then(() => "allowed", (error) => String(error.message || error))
    ]).then(([permissionMode, openFile]) => ({ permissionMode, openFile }))`,
  );
  if (
    !securityIpc?.permissionMode.includes("bypassPermissions") ||
    !securityIpc?.openFile.includes("HBClient can only open")
  ) {
    throw new Error(`Renderer IPC security checks failed: ${JSON.stringify(securityIpc)}`);
  }
  const rightPanelTasks = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const tabs = [...document.querySelectorAll('.activity-panel [role="tab"]')];
      const taskTab = tabs.find((el) => el.textContent?.includes("任务") || el.textContent?.includes("Tasks"));
      return {
        hasTaskTab: Boolean(taskTab),
        tabLabels: tabs.map((el) => el.textContent || "")
      };
    })()`,
  );
  if (rightPanelTasks?.hasTaskTab) {
    throw new Error(`Right panel still renders a tasks tab: ${JSON.stringify(rightPanelTasks)}`);
  }
  const autopilotClick = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const autopilotTab = document.querySelector('#rc-tabs-0-tab-autopilot') ||
        [...document.querySelectorAll('.activity-panel [role="tab"]')].find((el) => el.textContent?.includes("Autopilot") || el.textContent?.includes("自动驾驶"));
      autopilotTab?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return { clickedAutopilot: Boolean(autopilotTab), text: autopilotTab?.textContent || "" };
    })()`,
  );
  await sleep(300);
  const autopilotUi = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => ({
      hasPanel: Boolean(document.querySelector(".autopilot-workbench")),
      hasIcon: Boolean(document.querySelector(".autopilot-workbench .anticon-thunderbolt")),
      hasNewProjectButton: Boolean(document.querySelector(".autopilot-new-project-button")),
      hasInlineProjectForm: Boolean(document.querySelector(".autopilot-workbench .autopilot-folder-picker input[readonly]")),
      hasProjectFolderIpc: typeof window.supbot?.pickProjectFolder === "function",
      hasRunMonitor: Boolean(document.querySelector(".autopilot-run-panel")),
      hasRunMonitorCard: Boolean(document.querySelector(".autopilot-run-monitor-card")),
      hasRunSelect: Boolean(document.querySelector(".autopilot-run-monitor-card .autopilot-run-select .ant-select-selector")),
      hasEmptyRunInfo: document.body.innerText.includes("Register a project and start a data run."),
      hasDataSourceControls: Boolean(document.querySelector(".autopilot-source-row, .autopilot-source-kind, .autopilot-source-value, [name='sourceKind'], [name='sourceValue']")),
      hasProjectText: document.body.innerText.includes("Project data runs") || document.body.innerText.includes("DATA AUTOPILOT") || document.body.innerText.includes("项目数据任务"),
      hasStartRunText: document.body.innerText.includes("Start run") || document.body.innerText.includes("启动运行"),
      hasSurfaceText: document.body.innerText.includes("Autopilot surface") || document.body.innerText.includes("自动驾驶面板"),
      hasAutomationLoopText: document.body.innerText.includes("automation loop") || document.body.innerText.includes("自动化循环")
    }))()`,
  );
  const projectModalUi = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      document.querySelector(".autopilot-new-project-button")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return new Promise((resolve) => {
        window.setTimeout(() => {
          const result = {
            hasModal: Boolean(document.querySelector(".ant-modal")),
            hasFolderPicker: Boolean(document.querySelector(".ant-modal .autopilot-folder-picker input[readonly]")),
            hasFolderButton: Boolean(document.querySelector(".ant-modal .autopilot-folder-picker .anticon-folder-open")),
            hasRegisterText: document.body.innerText.includes("Register project") || document.body.innerText.includes("注册项目")
          };
          document.querySelector(".ant-modal-close")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          resolve(result);
        }, 150);
      });
    })()`,
  );
  console.log(JSON.stringify({ autopilotClick, autopilotUi, projectModalUi }, null, 2));
  if (
    !autopilotClick?.clickedAutopilot ||
    !autopilotUi?.hasPanel ||
    !autopilotUi.hasIcon ||
    !autopilotUi.hasNewProjectButton ||
    autopilotUi.hasInlineProjectForm ||
    !autopilotUi.hasProjectFolderIpc ||
    !autopilotUi.hasRunMonitor ||
    !autopilotUi.hasRunMonitorCard ||
    !autopilotUi.hasRunSelect ||
    autopilotUi.hasEmptyRunInfo ||
    autopilotUi.hasDataSourceControls ||
    !autopilotUi.hasProjectText ||
    !autopilotUi.hasStartRunText ||
    !projectModalUi?.hasModal ||
    !projectModalUi.hasFolderPicker ||
    !projectModalUi.hasFolderButton ||
    !projectModalUi.hasRegisterText
  ) {
    throw new Error(
      `Autopilot panel did not render correctly: ${JSON.stringify({ autopilotClick, autopilotUi, projectModalUi })}`,
    );
  }
  const memoryClick = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const memoryTab = document.querySelector('#rc-tabs-0-tab-memory') ||
        [...document.querySelectorAll('.activity-panel [role="tab"]')].find((el) => el.textContent?.includes("Memory") || el.textContent?.includes("记忆"));
      memoryTab?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return { clickedMemory: Boolean(memoryTab), text: memoryTab?.textContent || "" };
    })()`,
  );
  await sleep(600);
  step("checking memory panel");
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
    }))()`,
  );
  console.log(JSON.stringify({ memoryClick, memoryInitial }, null, 2));
  if (
    !memoryClick?.clickedMemory ||
    !memoryInitial?.hasPanel ||
    !memoryInitial.hasSearch ||
    memoryInitial.pendingCount !== 3 ||
    !memoryInitial.hasRecallHistory ||
    !memoryInitial.hasTransferBox ||
    !memoryInitial.hasSeedRecord ||
    !memoryInitial.hasDeleteButton ||
    !memoryInitial.hasDisableButton
  ) {
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
    })()`,
  );
  let pendingMemoryAfterApprove = 3;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(100);
    pendingMemoryAfterApprove = await evaluate(
      page.webSocketDebuggerUrl,
      `document.querySelectorAll(".memory-candidate-card").length`,
    );
    if (pendingMemoryAfterApprove === 1) {
      break;
    }
  }
  if (batchCandidates?.selected !== 3 || !batchCandidates.clickedApprove || pendingMemoryAfterApprove !== 1) {
    throw new Error("Memory candidate batch approve action did not leave one pending candidate.");
  }
  await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const deny = document.querySelector(".memory-candidate-card button.ant-btn-dangerous") ||
        [...document.querySelectorAll(".memory-candidate-card button")].find((el) => el.textContent?.includes("Deny") || el.textContent?.includes("拒绝"));
      deny?.click();
      return { clicked: Boolean(deny) };
    })()`,
  );
  let pendingMemoryAfterDeny = 1;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(100);
    pendingMemoryAfterDeny = await evaluate(
      page.webSocketDebuggerUrl,
      `document.querySelectorAll(".memory-candidate-card").length`,
    );
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
    })()`,
  );
  await sleep(300);
  const recallDebugVisible = await evaluate(
    page.webSocketDebuggerUrl,
    `Boolean(document.querySelector(".memory-debug-panel")) && Boolean(document.querySelector(".memory-debug-panel input"))`,
  );
  const recallReplay = await evaluate(
    page.webSocketDebuggerUrl,
    `window.supbot.replayMemoryRecall({ query: "Smoke durable", conversationId: "conv_smoke", scope: "all", limit: 5, budgetChars: 500 })
      .then((result) => ({
        resultCount: result.results.length,
        hasPreview: Boolean(result.blockPreview),
        excludedCount: result.excludedResults.length
      }))`,
  );
  if (!recallDebugClick?.clicked || !recallDebugVisible || !recallReplay?.resultCount || !recallReplay.hasPreview) {
    throw new Error("Memory recall debug replay did not render a replay result.");
  }
  const recallFeedback = await evaluate(
    page.webSocketDebuggerUrl,
    `window.supbot.addMemoryRecallFeedback({ memoryId: "mem_fact_smoke", kind: "useful", query: "Smoke durable", recallId: "mem_recall_smoke" })
      .then((feedback) => ({ clicked: Boolean(feedback.id) }))`,
  );
  await sleep(300);
  const feedbackCount = await evaluate(
    page.webSocketDebuggerUrl,
    `window.supbot.snapshot().then((snapshot) => snapshot.memory.recallFeedback.length)`,
  );
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
    })()`,
  );
  await sleep(300);
  const memorySearchCount = await evaluate(
    page.webSocketDebuggerUrl,
    `window.supbot.searchMemory({ query: "Smoke durable", conversationId: "conv_smoke", includeDisabled: true }).then((items) => items.length)`,
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
      })`,
  );
  if (
    transferCheck?.version !== 1 ||
    !transferCheck.hasFacts ||
    !transferCheck.backupPath ||
    !transferCheck.restoredCount
  ) {
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
    })()`,
  );
  let disabledRecords = 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(100);
    disabledRecords = await evaluate(
      page.webSocketDebuggerUrl,
      `document.querySelectorAll(".memory-record.status-disabled").length`,
    );
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
    })()`,
  );
  let memoryRecordsAfterDelete = deleteMemory?.before || 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(100);
    memoryRecordsAfterDelete = await evaluate(
      page.webSocketDebuggerUrl,
      `document.querySelectorAll(".memory-record").length`,
    );
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
    })()`,
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
    })()`,
  );
  await sleep(300);
  const permissionRuleUiAfterClick = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => ({
      hasRuleRow: Boolean(document.querySelector(".permission-rule-row")),
      hasRuleBuilder: Boolean(document.querySelector(".permission-rule-builder")),
      hasShellRule: document.body.innerText.includes("Shell")
    }))()`,
  );
  if (
    !configClick?.clickedConfig ||
    !permissionRuleUi?.clickedCapabilities ||
    !permissionRuleUiAfterClick.hasRuleRow ||
    !permissionRuleUiAfterClick.hasRuleBuilder ||
    !permissionRuleUiAfterClick.hasShellRule
  ) {
    throw new Error("Permission rule UI did not render in the capabilities config.");
  }
  const capabilityCardLayout = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const card = document.querySelector(".capability-card");
      const id = card?.querySelector(".activity-head .mono");
      if (!card || !id) return { hasCard: false };
      id.textContent = "local.skill." + "x".repeat(240);
      const cardRect = card.getBoundingClientRect();
      const idRect = id.getBoundingClientRect();
      return {
        hasCard: true,
        cardScrollWidth: card.scrollWidth,
        cardClientWidth: card.clientWidth,
        idScrollWidth: id.scrollWidth,
        idClientWidth: id.clientWidth,
        idRight: idRect.right,
        cardRight: cardRect.right
      };
    })()`,
  );
  if (
    !capabilityCardLayout?.hasCard ||
    capabilityCardLayout.cardScrollWidth > capabilityCardLayout.cardClientWidth + 1 ||
    capabilityCardLayout.idScrollWidth > capabilityCardLayout.idClientWidth + 1 ||
    capabilityCardLayout.idRight > capabilityCardLayout.cardRight + 1
  ) {
    throw new Error(`Capability card text overflowed its boundary: ${JSON.stringify(capabilityCardLayout)}`);
  }
  const mcpTabClick = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const mcpTab = [...document.querySelectorAll('[role="tab"]')].find((el) => el.textContent?.includes("MCP"));
      mcpTab?.click();
      return { clickedMcp: Boolean(mcpTab) };
    })()`,
  );
  await sleep(300);
  const mcpUi = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => ({
      hasPanel: Boolean(document.querySelector(".mcp-server-card")),
      hasSeedServer: document.body.innerText.includes("Smoke MCP"),
      hasStatusGrid: Boolean(document.querySelector(".mcp-status-grid")),
      hasTimeoutField: document.body.innerText.includes("Request timeout") || document.body.innerText.includes("Timeout") || document.body.innerText.includes("请求超时"),
      hasPresetSelect: Boolean(document.querySelector(".mcp-preset-select")),
      hasTransferButtons: (document.body.innerText.includes("Export MCP") || document.body.innerText.includes("导出 MCP")) && (document.body.innerText.includes("Import MCP") || document.body.innerText.includes("导入 MCP")),
      hasDiagnoseButton: document.body.innerText.includes("Diagnose") || document.body.innerText.includes("诊断"),
      hasCopyButtons: (document.body.innerText.includes("Copy diagnostic summary") || document.body.innerText.includes("复制诊断摘要")) && (document.body.innerText.includes("Copy tool list") || document.body.innerText.includes("复制工具清单")),
      hasSchemaWarning: document.body.innerText.includes("schema warning") || document.body.innerText.includes("schema 警告")
    }))()`,
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
      })`,
  );
  if (
    !mcpTabClick?.clickedMcp ||
    !mcpUi?.hasPanel ||
    !mcpUi.hasSeedServer ||
    !mcpUi.hasStatusGrid ||
    !mcpUi.hasTimeoutField ||
    !mcpUi.hasPresetSelect ||
    !mcpUi.hasTransferButtons ||
    !mcpUi.hasDiagnoseButton ||
    !mcpUi.hasCopyButtons ||
    !mcpIpc?.added ||
    !mcpIpc.logs ||
    mcpIpc.timeout !== 1500 ||
    !mcpIpc.presets ||
    !mcpIpc.redacted ||
    mcpIpc.imported !== 1 ||
    !mcpIpc.diagnosticFailed ||
    !mcpIpc.diagnosticShape?.hasErrorCode ||
    !mcpIpc.diagnosticShape?.hasCapabilities ||
    !mcpIpc.diagnosticShape?.hasProtocol ||
    !mcpIpc.hasSeedToolWarning ||
    !mcpIpc.hasMcpRule ||
    mcpIpc.after !== mcpIpc.before
  ) {
    throw new Error(`MCP server UI or IPC smoke checks failed: ${JSON.stringify({ mcpTabClick, mcpUi, mcpIpc })}`);
  }
  const chatClick = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const chatControl = [...document.querySelectorAll(".topbar .ant-segmented-item-label")]
        .find((el) => el.textContent?.includes("对话") || el.textContent?.includes("Chat"));
      chatControl?.click();
      return { clickedChat: Boolean(chatControl) };
    })()`,
  );
  await sleep(300);
  if (!chatClick?.clickedChat) {
    throw new Error("Could not return to the chat workspace after config smoke checks.");
  }
  const finalLayoutMetrics = await evaluate(
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
    })()`,
  );
  if (
    !finalLayoutMetrics ||
    finalLayoutMetrics.bodyOverflowY !== "hidden" ||
    finalLayoutMetrics.documentScrollHeight > finalLayoutMetrics.viewport + 2
  ) {
    throw new Error("Window-level scrolling is still enabled.");
  }
  if (
    !finalLayoutMetrics.chat ||
    !finalLayoutMetrics.composer ||
    Math.abs(finalLayoutMetrics.composer.bottom - finalLayoutMetrics.chat.bottom) > 2
  ) {
    throw new Error("Composer is not anchored to the bottom of the chat panel.");
  }
  if (finalLayoutMetrics.composer.position === "fixed") {
    throw new Error("Composer is still fixed to the window instead of the chat panel.");
  }
  for (const key of ["leftScroll", "messageStream", "rightScroll"]) {
    if (!finalLayoutMetrics[key] || finalLayoutMetrics[key].overflowY !== "auto") {
      throw new Error(`${key} does not expose an independent scrollbar region.`);
    }
  }
  if (finalLayoutMetrics.messageStream.distanceFromBottom > 2) {
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
    })()`,
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
    })()`,
  );
  console.log(JSON.stringify({ scrollAfterRefresh, scrollAfterSettling }, null, 2));
  if (!scrollAfterSettling || scrollAfterSettling.scrollTop > 2) {
    throw new Error("Message stream ignored manual scrolling away from the bottom.");
  }
  const serverAgentConnection = await evaluate(
    page.webSocketDebuggerUrl,
    `window.supbot.updateIdentityContext({
        tenantId: "tenant-serv-smoke",
        organizationId: "organization-serv-smoke",
        departmentId: "department-serv-smoke",
        userId: "user-serv-smoke",
        roleIds: ["user"],
        source: "servstation",
        agentInstanceId: "agent-serv-smoke",
        servstationUrl: ${JSON.stringify(servstationBaseUrl)}
      })
      .then(() => window.supbot.updateServstationA2AConfig({
        enabled: true,
        baseUrl: ${JSON.stringify(servstationBaseUrl)},
        authMode: "identityHeaders",
        agentInstanceId: "agent-serv-smoke",
        reverseEnabled: false
      }))
      .then(() => window.supbot.connectServstationReverseBridge())
      .then((config) => ({ connected: config.reverse?.status === "connected" }))
      .catch((error) => ({ connected: false, error: String(error?.message || error) }))`,
  );
  await sleep(250);
  const serverAgentClick = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const control = [...document.querySelectorAll(".topbar .ant-segmented-item-label")]
        .find((el) => el.textContent?.includes("Server Agent") || el.textContent?.includes("服务端 Agent"));
      control?.click();
      return { clicked: Boolean(control) };
    })()`,
  );
  await sleep(1200);
  const serverAgentFiles = await evaluate(
    page.webSocketDebuggerUrl,
    `(async () => {
      const links = [...document.querySelectorAll(".server-agent-result-file")];
      try {
        const download = await window.supbot.fetchServstationJobFile("job-serv-smoke", "file-report");
        return {
          hasWorkspace: Boolean(document.querySelector(".server-agent-workspace")),
          names: links.map((link) => link.textContent || ""),
          hasDownloadIcon: links.every((link) => Boolean(link.querySelector(".anticon-download"))),
          hasDownloadIpc: typeof window.supbot.fetchServstationJobFile === "function",
          downloadedFileName: download.fileName,
          downloadedContent: atob(download.contentBase64)
        };
      } catch (error) {
        return {
          error: String(error?.message || error),
          hasWorkspace: Boolean(document.querySelector(".server-agent-workspace")),
          hasDownloadIpc: typeof window.supbot.fetchServstationJobFile === "function",
          names: links.map((link) => link.textContent || "")
        };
      }
    })()`,
  );
  if (
    !serverAgentConnection?.connected ||
    !serverAgentClick?.clicked ||
    !serverAgentFiles?.hasWorkspace ||
    !serverAgentFiles.hasDownloadIcon ||
    !serverAgentFiles.hasDownloadIpc ||
    serverAgentFiles.names.length !== 2 ||
    !serverAgentFiles.names.some((name) => name.includes("report.pdf")) ||
    !serverAgentFiles.names.some((name) => name.includes("data.csv")) ||
    serverAgentFiles.names.some((name) => name.includes("worker.py")) ||
    serverAgentFiles.downloadedFileName !== "report.pdf" ||
    serverAgentFiles.downloadedContent !== "PDF smoke"
  ) {
    throw new Error(
      `Server Agent result files did not render or download correctly: ${JSON.stringify({ serverAgentConnection, serverAgentClick, serverAgentFiles })}`,
    );
  }
}

async function collectDiagnostics(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await waitForWebSocketOpen(ws, "diagnostics");
  const events = [];
  ws.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    if (data.method === "Runtime.exceptionThrown") {
      events.push({
        type: "exception",
        text: data.params.exceptionDetails?.text,
        description: data.params.exceptionDetails?.exception?.description,
      });
    }
    if (data.method === "Runtime.consoleAPICalled") {
      events.push({
        type: "console",
        level: data.params.type,
        args: data.params.args?.map((arg) => arg.value || arg.description).join(" "),
      });
    }
    if (data.method === "Log.entryAdded") {
      events.push({ type: "log", level: data.params.entry.level, text: data.params.entry.text });
    }
  });
  let id = 1;
  const send = (method, params) =>
    new Promise((resolve, reject) => {
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
    expression:
      "window.__supbotSmoke = { root: document.getElementById('root')?.innerHTML || '', text: document.body.innerText, errors: [] }",
    returnByValue: true,
  });
  await sleep(500);
  const state = await send("Runtime.evaluate", {
    expression: "window.__supbotSmoke",
    returnByValue: true,
  });
  ws.close();
  return {
    events: events.slice(0, 10),
    state: state.result?.result?.value,
  };
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(smokeDeadline);
    child.kill();
    servstationServer.close();
    fs.rmSync(smokeUserDataDir, { recursive: true, force: true });
  });

function createSmokeServstationServer() {
  const now = "2026-01-01T00:00:00.000Z";
  const conversation = {
    id: "conversation-serv-smoke",
    agentInstanceId: "agent-serv-smoke",
    title: "Smoke generated files",
    runtimeSessionId: "runtime-serv-smoke",
    jobCount: 1,
    lastMessageAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const messages = [
    {
      id: "message-serv-user",
      role: "user",
      text: "Create result files",
      jobId: "job-serv-smoke",
      createdAt: now,
    },
    {
      id: "message-serv-agent",
      role: "agent",
      text: "Generated the requested files.",
      status: "completed",
      jobId: "job-serv-smoke",
      createdAt: now,
    },
  ];
  const job = {
    id: "job-serv-smoke",
    agentInstanceId: "agent-serv-smoke",
    requestId: "request-serv-smoke",
    clientId: "smoke-client",
    jobType: "interactive",
    conversationId: conversation.id,
    runtimeSessionId: conversation.runtimeSessionId,
    payload: { prompt: "Create result files" },
    status: "completed",
    queuePosition: 0,
    result: {
      assistantText: "Generated the requested files.",
      generatedFiles: [
        {
          fileId: "file-report",
          fileName: "report.pdf",
          contentType: "application/pdf",
          sizeBytes: 9,
        },
        {
          file_id: "file-data",
          file_name: "data.csv",
          content_type: "text/csv",
          size_bytes: 12,
        },
        {
          fileId: "file-script",
          fileName: "worker.py",
          contentType: "text/x-python",
          sizeBytes: 18,
        },
      ],
    },
    createdAt: now,
    finishedAt: now,
  };
  return createServer((request, response) => {
    const url = new URL(request.url || "/", servstationBaseUrl);
    const json = (value) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(value));
    };
    if (request.method === "POST" && url.pathname === "/api/v1/agent/agent-serv-smoke/a2a-peers/reverse-connections") {
      json({
        peer: { id: "peer-serv-smoke" },
        streamUrl: "/api/v1/agent/agent-serv-smoke/a2a-peers/peer-serv-smoke/events",
      });
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/v1/agent/agent-serv-smoke/a2a-peers/peer-serv-smoke/events"
    ) {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      response.write('event: heartbeat\ndata: {"status":"ok"}\n\n');
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/v1/agent/agent-serv-smoke/a2a-peers/peer-serv-smoke/heartbeat"
    ) {
      json({ status: "online" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/agent/agent-serv-smoke/projects") {
      json({ projects: [] });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/agent/agent-serv-smoke/conversations") {
      json({ conversations: [conversation] });
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/v1/agent/agent-serv-smoke/conversations/conversation-serv-smoke"
    ) {
      json({ ...conversation, messages });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/agent/agent-serv-smoke/jobs") {
      json({ jobs: [job] });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/agent/agent-serv-smoke/scheduled-tasks") {
      json({ tasks: [] });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/agent/agent-serv-smoke/autopilot-runs/current") {
      json({});
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/services") {
      json({ services: [] });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/agent/agent-serv-smoke/installed-services") {
      json({ services: [] });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/capabilities/local") {
      json({ assets: [] });
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/v1/agent/agent-serv-smoke/jobs/job-serv-smoke/files/file-report/download"
    ) {
      response.setHeader("Content-Type", "application/pdf");
      response.setHeader("Content-Disposition", 'attachment; filename="report.pdf"');
      response.end("PDF smoke");
      return;
    }
    response.statusCode = 404;
    json({ error: "not found", path: url.pathname });
  });
}

function writeSmokeMcpServer(userDataDir) {
  const serverPath = path.join(userDataDir, "mock-mcp.cjs");
  fs.writeFileSync(
    serverPath,
    `
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
`,
    "utf8",
  );
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
  fs.writeFileSync(
    path.join(dataDir, "state.json"),
    `${JSON.stringify(
      {
        agentName: "HBClient Local Agent",
        modelConfig: {
          providerName: "OpenAI Compatible",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4.1-mini",
          temperature: 0.2,
          maxTokens: 1600,
          apiKeySaved: false,
        },
        toolMarketConfig: {
          source: "hybrid",
          apiUrl: "https://i-shu.com",
          accountEmail: "subscriber@toolsmarket.local",
          accessTokenSaved: false,
          passwordSaved: false,
        },
        personality: {
          summary: "A careful local desktop agent for coding, documents, and day-to-day automation.",
          traits: ["precise", "calm", "proactive"],
          instructions: "Work locally, explain important actions, and keep user data on this machine.",
        },
        capabilities: [],
        subagents: [],
        conversations: [
          {
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
                  {
                    type: "tool_use",
                    toolCallId,
                    toolName: "ReadFile",
                    input: { path: "D:/tmp/smoke.txt" },
                    status: "completed",
                  },
                  {
                    type: "tool_result",
                    toolCallId,
                    toolName: "mcp.smoke-mcp.rich",
                    output:
                      "Tool completed from smoke.\n[image image/png, 12 base64 chars]\nresource text\n[truncated]",
                    outputParts: [
                      { type: "text", text: "Tool completed from smoke." },
                      { type: "image", text: "[image image/png, 12 base64 chars]", mimeType: "image/png" },
                      { type: "resource", text: "resource text", mimeType: "text/plain" },
                    ],
                    outputTruncated: true,
                  },
                  { type: "text", text: "Tool completed from smoke." },
                ],
              },
            ],
          },
        ],
        jobs: [
          {
            id: jobId,
            conversationId,
            prompt: "smoke pending shell",
            status: "running",
            createdAt: now,
            updatedAt: now,
            progress: ["Shell: pending_permission"],
          },
        ],
        scheduledJobs: [],
        pendingToolPermissions: [
          {
            id: "perm_smoke",
            jobId,
            conversationId,
            toolCallId: "call_pending_smoke",
            toolName: "Shell",
            input: { command: "smoke pending shell" },
            summary: "smoke pending shell",
            createdAt: now,
          },
        ],
        agentLoopTraces: [
          {
            jobId,
            conversationId,
            turns: 1,
            toolCalls: [],
            startedAt: now,
            updatedAt: now,
          },
        ],
        querySessions: [
          {
            id: "query_smoke",
            jobId,
            conversationId,
            status: "running",
            turns: 1,
            startedAt: now,
            updatedAt: now,
          },
        ],
        runtimeEvents: [
          {
            id: "event_smoke",
            jobId,
            conversationId,
            kind: "query_start",
            message: "Smoke query started",
            createdAt: now,
          },
        ],
        compactBoundaries: [
          {
            id: compactId,
            conversationId,
            messageId: "msg_user_smoke",
            summary: "Smoke compact summary for visible history.",
            preservedMessageIds: ["msg_assistant_smoke"],
            originalMessageCount: 2,
            createdAt: now,
          },
        ],
        memory: {
          pages: [
            {
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
              accessCount: 0,
            },
          ],
          facts: [
            {
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
              confidence: 0.9,
            },
          ],
          chunks: [
            {
              id: "mem_chunk_smoke",
              memoryId: memoryFactId,
              memoryType: "fact",
              ordinal: 0,
              heading: "Smoke recall fact",
              content: "Smoke durable fact memory item for search and disable.",
              keywords: ["smoke", "durable", "fact"],
              createdAt: now,
            },
          ],
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
              updatedAt: now,
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
              updatedAt: now,
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
              updatedAt: now,
            },
          ],
          recallHistory: [
            {
              id: "mem_recall_smoke",
              conversationId,
              query: "Smoke recall query",
              resultIds: [memoryFactId],
              resultCount: 1,
              injected: true,
              budgetChars: 6000,
              usedChars: 180,
              createdAt: now,
              results: [
                {
                  id: memoryFactId,
                  title: "Smoke recall fact",
                  score: 4.2,
                  matchedKeywords: ["smoke", "durable"],
                  reason: "Matched smoke, durable",
                  sourceLabel: "Smoke seed",
                },
              ],
              excludedResults: [
                {
                  id: memoryPageId,
                  title: "Smoke durable page",
                  score: 2.1,
                  matchedKeywords: ["smoke"],
                  reason: "Budget excluded",
                  sourceLabel: "Smoke seed",
                },
              ],
              blockPreview:
                "<memory>\\n#1 [conversation] Smoke recall fact\\nSmoke durable fact memory item for search and disable.\\n</memory>",
            },
          ],
          recallFeedback: [],
        },
        permissionMode: "default",
        permissionRules: [
          {
            id: ruleId,
            toolName: "Shell",
            behavior: "ask",
            scope: "session",
            createdAt: now,
          },
        ],
        mcpServers: [
          {
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
              lastExitReason: "smoke exit",
            },
          },
        ],
        mcpTools: [
          {
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
              additionalProperties: false,
            },
            schemaValid: false,
            schemaWarnings: ["smoke schema warning"],
            connected: false,
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}
