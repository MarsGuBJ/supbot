const { execFileSync, spawn } = require("node:child_process");
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
const port = Number(execFileSync(process.execPath, ["-e", "const net=require('node:net');const server=net.createServer();server.listen(0,'127.0.0.1',()=>{process.stdout.write(String(server.address().port));server.close();});"], { encoding: "utf8" }).trim());
const smokeUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "supbot-smoke-"));
const smokeMcpServerPath = writeSmokeMcpServer(smokeUserDataDir);
seedSmokeState(smokeUserDataDir, smokeMcpServerPath);

const child = spawn(electron, [`--remote-debugging-port=${port}`, "."], {
  cwd: appDir,
  env: {
    ...process.env,
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/",
    SUPBOT_USER_DATA_DIR: smokeUserDataDir
  },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"]
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const smokeDeadline = setTimeout(() => {
  console.error("Electron smoke timed out.", { stderr: stderr.slice(0, 1200) });
  child.kill();
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
      })()`
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
  const rootChildren = await evaluate(page.webSocketDebuggerUrl, "document.getElementById('root')?.children.length ?? -1");
  await waitForMessageStreamAtBottom(page.webSocketDebuggerUrl);
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
  const hasSupbot = await evaluate(page.webSocketDebuggerUrl, "Boolean(document.querySelector('[data-testid=workspace-shell] .brand-mark'))");
  const hasDefaultChinese = await evaluate(page.webSocketDebuggerUrl, "Boolean(document.querySelector('[data-testid=workspace-switcher]'))");
  const toolUi = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => ({
      hasToolCard: Boolean(document.querySelector(".tool-card")),
      hasToolResult: Boolean(document.querySelector(".tool-card.result")),
      hasToolResultParts: Boolean(document.querySelector(".tool-result-part")),
      hasToolResultPartTypes: document.querySelectorAll(".tool-result-part[data-part-type]").length >= 2,
      hasTruncatedMarker: Boolean(document.querySelector('.tool-card.result[data-output-truncated="true"]'))
    }))()`
  );
  console.log(JSON.stringify({
    rootChildren,
    hasSupbot,
    hasDefaultChinese,
    layoutMetrics,
    toolUi,
    url: page.url,
    bodyHtml: String(bodyHtml).slice(0, 600),
    diagnostics,
    stderr: stderr.slice(0, 600)
  }, null, 2));
  if (!rootChildren || !hasSupbot || !hasDefaultChinese) {
    throw new Error("Electron renderer did not render the Supbot workspace.");
  }
  const securityWarning = diagnostics.events.find((event) => {
    const text = `${event.args || ""} ${event.text || ""}`;
    return text.includes("Electron Security Warning") || text.includes("Insecure Content-Security-Policy");
  });
  if (securityWarning) {
    throw new Error(`Electron security warning emitted: ${JSON.stringify(securityWarning)}`);
  }
  if (!toolUi?.hasToolCard || !toolUi?.hasToolResult || !toolUi.hasToolResultParts || !toolUi.hasToolResultPartTypes || !toolUi.hasTruncatedMarker) {
    throw new Error("Tool call cards did not render in the chat stream.");
  }
  const securityIpc = await evaluate(
    page.webSocketDebuggerUrl,
    `Promise.all([
      window.supbot.setPermissionMode("bypassPermissions").then(() => "allowed", (error) => String(error.message || error)),
      window.supbot.openFile(${JSON.stringify(path.join(os.tmpdir(), "supbot-smoke-forbidden.txt"))}).then(() => "allowed", (error) => String(error.message || error))
    ]).then(([permissionMode, openFile]) => ({ permissionMode, openFile }))`
  );
  if (!securityIpc?.permissionMode.includes("bypassPermissions") || !securityIpc?.openFile.includes("Supbot can only open")) {
    throw new Error(`Renderer IPC security checks failed: ${JSON.stringify(securityIpc)}`);
  }
  const rightPanelTasks = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const tabs = [...document.querySelectorAll('.activity-panel [role="tab"]')];
      const taskTab = document.querySelector('.activity-panel [data-node-key="tasks"]');
      return {
        hasTaskTab: Boolean(taskTab),
        tabLabels: tabs.map((el) => el.textContent || "")
      };
    })()`
  );
  if (rightPanelTasks?.hasTaskTab) {
    throw new Error(`Right panel still renders a tasks tab: ${JSON.stringify(rightPanelTasks)}`);
  }
  const autopilotClick = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const autopilotTab = document.querySelector('.activity-panel [data-node-key="autopilot"]');
      autopilotTab?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return { clickedAutopilot: Boolean(autopilotTab), text: autopilotTab?.textContent || "" };
    })()`
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
      hasProfileControl: Boolean(document.querySelector(".autopilot-panel .ant-segmented")),
      hasBudgetGrid: Boolean(document.querySelector(".autopilot-budget-grid")),
      hasQualityGrid: Boolean(document.querySelector(".autopilot-quality-grid")),
      hasHistoryPanel: Boolean(document.querySelector(".autopilot-history-panel")),
      hasApprovalGate: Boolean(document.querySelector(".autopilot-decision")),
      hasApprovalDetails: Boolean(document.querySelector(".autopilot-decision-grid")) && document.querySelectorAll(".autopilot-decision-fact").length >= 4 && Boolean(document.querySelector(".autopilot-decision-input")) && Boolean(document.querySelector(".autopilot-decision-comment")) && Boolean(document.querySelector(".autopilot-decision-diff")),
      hasApprovalHistory: Boolean(document.querySelector(".autopilot-approval-history")),
      hasReportBand: Boolean(document.querySelector(".autopilot-report-band")),
      hasOpenReportButton: Boolean(document.querySelector(".autopilot-open-report")),
      hasWorktreeBand: Boolean(document.querySelector(".autopilot-worktree-band")),
      hasLoopFacts: Boolean(document.querySelector(".autopilot-run-facts")),
      hasLoopIpc: typeof window.supbot?.startAutopilotRun === "function" && typeof window.supbot?.decideAutopilotApproval === "function" && typeof window.supbot?.retryAutopilotFromCheckpoint === "function" && typeof window.supbot?.applyAutopilotWorktree === "function" && typeof window.supbot?.discardAutopilotWorktree === "function" && typeof window.supbot?.getAutopilotQualitySummary === "function",
      hasEmptyRunInfo: !document.querySelector(".autopilot-project-list"),
      hasDataSourceControls: Boolean(document.querySelector(".autopilot-source-row, .autopilot-source-kind, .autopilot-source-value, [name='sourceKind'], [name='sourceValue']")),
      hasProjectText: Boolean(document.querySelector(".autopilot-hero")),
      hasStartRunText: Boolean(document.querySelector(".autopilot-start-form")),
      hasSurfaceText: Boolean(document.querySelector(".autopilot-workbench")),
      hasAutomationLoopText: Boolean(document.querySelector(".autopilot-run-monitor-card"))
    }))()`
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
            hasRegisterText: Boolean(document.querySelector(".autopilot-folder-picker"))
          };
          document.querySelector(".ant-modal-close")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          resolve(result);
        }, 150);
      });
    })()`
  );
  console.log(JSON.stringify({ autopilotClick, autopilotUi, projectModalUi }, null, 2));
  if (!autopilotClick?.clickedAutopilot || !autopilotUi?.hasPanel || !autopilotUi.hasIcon || !autopilotUi.hasNewProjectButton || autopilotUi.hasInlineProjectForm || !autopilotUi.hasProjectFolderIpc || !autopilotUi.hasRunMonitor || !autopilotUi.hasRunMonitorCard || !autopilotUi.hasRunSelect || !autopilotUi.hasProfileControl || !autopilotUi.hasBudgetGrid || !autopilotUi.hasQualityGrid || !autopilotUi.hasHistoryPanel || !autopilotUi.hasApprovalGate || !autopilotUi.hasApprovalDetails || !autopilotUi.hasApprovalHistory || !autopilotUi.hasReportBand || !autopilotUi.hasOpenReportButton || !autopilotUi.hasWorktreeBand || !autopilotUi.hasLoopFacts || !autopilotUi.hasLoopIpc || autopilotUi.hasEmptyRunInfo || autopilotUi.hasDataSourceControls || !autopilotUi.hasProjectText || !autopilotUi.hasStartRunText || !projectModalUi?.hasModal || !projectModalUi.hasFolderPicker || !projectModalUi.hasFolderButton || !projectModalUi.hasRegisterText) {
    throw new Error(`Autopilot panel did not render correctly: ${JSON.stringify({ autopilotClick, autopilotUi, projectModalUi })}`);
  }
  const memoryClick = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const memoryTab = document.querySelector('.activity-panel [data-node-key="memory"]');
      memoryTab?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return { clickedMemory: Boolean(memoryTab), text: memoryTab?.textContent || "" };
    })()`
  );
  await sleep(600);
  step("checking memory panel");
  const memoryInitial = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => ({
      hasPanel: Boolean(document.querySelector(".memory-panel")),
      hasSearch: Boolean(document.querySelector(".memory-search-row input")),
      pendingCount: document.querySelectorAll(".memory-candidate-card").length,
      hasRecallHistory: Boolean(document.querySelector(".memory-recall-history [data-recall-id='mem_recall_smoke']")),
      hasTransferBox: Boolean(document.querySelector(".memory-transfer-box")),
      hasSeedRecord: Boolean(document.querySelector(".memory-record[data-memory-id='mem_fact_smoke']")),
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
      const approve = document.querySelector(".memory-approve-selected");
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
      const deny = document.querySelector(".memory-candidate-card button.ant-btn-dangerous");
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
      const debug = document.querySelector("[data-testid='memory-view-switcher'] .ant-segmented-item:nth-child(2)");
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
      const manage = document.querySelector("[data-testid='memory-view-switcher'] .ant-segmented-item:nth-child(1) input");
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
  const disableMemory = await evaluate(
    page.webSocketDebuggerUrl,
    `window.supbot.updateMemory("mem_fact_smoke", { status: "disabled" }).then(() => ({ clicked: true }))`
  );
  const disabledRecords = await evaluate(
    page.webSocketDebuggerUrl,
    `window.supbot.searchMemory({ query: "Smoke durable", includeDisabled: true }).then((items) => items.filter((item) => item.id === "mem_fact_smoke" && item.status === "disabled").length)`
  );
  if (!disableMemory?.clicked || disabledRecords < 1) {
    throw new Error(`Memory disable action did not update a memory record: ${JSON.stringify({ disableMemory, disabledRecords })}`);
  }
  const deleteMemory = await evaluate(
    page.webSocketDebuggerUrl,
    `window.supbot.listMemory({ includeDisabled: true }).then(async (beforeItems) => {
      await window.supbot.deleteMemory("mem_page_smoke");
      const afterItems = await window.supbot.listMemory({ includeDisabled: true });
      return { clicked: true, before: beforeItems.length, after: afterItems.length };
    })`
  );
  const memoryRecordsAfterDelete = deleteMemory?.after || 0;
  if (!deleteMemory?.clicked || memoryRecordsAfterDelete >= deleteMemory.before) {
    throw new Error("Memory delete action did not remove a memory record.");
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
  const autopilotApprovalAudit = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const autopilotTab = document.querySelector('.activity-panel [data-node-key="autopilot"]');
      autopilotTab?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return new Promise((resolve) => {
        window.setTimeout(() => {
          const textarea = document.querySelector(".autopilot-decision-comment");
          const approve = document.querySelector(".autopilot-decision button.ant-btn-primary");
          const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
          if (!textarea || !approve || !setValue) {
            resolve({ clicked: false, hasTab: Boolean(autopilotTab), hasTextarea: Boolean(textarea), hasApprove: Boolean(approve) });
            return;
          }
          setValue.call(textarea, "smoke approval comment");
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
          approve.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          let attempts = 0;
          const poll = async () => {
            attempts += 1;
            const snapshot = await window.supbot.snapshot();
            const event = snapshot.autopilotEvents.find((item) => item.runId === "aprun_smoke" && item.message === "Autopilot approval granted");
            const pendingDecision = snapshot.autopilotRuns.find((item) => item.id === "aprun_smoke")?.pendingDecision?.id;
            const historyText = document.querySelector(".autopilot-approval-history")?.textContent || "";
            const historyHasComment = historyText.includes("smoke approval comment");
            if ((event && !pendingDecision && historyHasComment) || attempts > 30) {
              resolve({
                clicked: true,
                attempts,
                eventMessage: event?.message,
                eventComment: event?.data?.comment,
                pendingDecision,
                historyHasComment,
                historyText: historyText.slice(0, 240)
              });
              return;
            }
            window.setTimeout(poll, 100);
          };
          void poll();
        }, 150);
      });
    })()`
  );
  console.log(JSON.stringify({ autopilotApprovalAudit }, null, 2));
  if (!autopilotApprovalAudit?.clicked || autopilotApprovalAudit.eventComment !== "smoke approval comment" || autopilotApprovalAudit.pendingDecision || !autopilotApprovalAudit.historyHasComment) {
    throw new Error(`Autopilot approval comment did not reach the audit log: ${JSON.stringify(autopilotApprovalAudit)}`);
  }
  const configClick = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const configControl = document.querySelector("[data-testid='workspace-switcher'] .ant-segmented-item:nth-child(3)");
      configControl?.click();
      return { clickedConfig: Boolean(configControl) };
    })()`
  );
  await sleep(300);
  const permissionRuleUi = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const capabilityTab = document.querySelector('[data-testid="config-tabs"] [data-node-key="capabilities"]');
      capabilityTab?.click();
      return {
        clickedCapabilities: Boolean(capabilityTab),
        hasRuleRow: Boolean(document.querySelector(".permission-rule-row")),
        hasRuleBuilder: Boolean(document.querySelector(".permission-rule-builder")),
        hasShellRule: Boolean(document.querySelector(".permission-tool-select"))
      };
    })()`
  );
  await sleep(300);
  const permissionRuleUiAfterClick = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => ({
      hasRuleRow: Boolean(document.querySelector(".permission-rule-row")),
      hasRuleBuilder: Boolean(document.querySelector(".permission-rule-builder")),
      hasShellRule: Boolean(document.querySelector(".permission-tool-select"))
    }))()`
  );
  if (!configClick?.clickedConfig || !permissionRuleUi?.clickedCapabilities || !permissionRuleUiAfterClick.hasRuleRow || !permissionRuleUiAfterClick.hasRuleBuilder || !permissionRuleUiAfterClick.hasShellRule) {
    throw new Error("Permission rule UI did not render in the capabilities config.");
  }
  const mcpTabClick = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const mcpTab = document.querySelector('[data-testid="config-tabs"] [data-node-key="mcp"]');
      mcpTab?.click();
      return { clickedMcp: Boolean(mcpTab) };
    })()`
  );
  await sleep(300);
  const mcpUi = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => ({
      hasPanel: Boolean(document.querySelector(".mcp-server-card")),
      hasSeedServer: Boolean(document.querySelector('.mcp-server-card[data-server-id="smoke-mcp"]')),
      hasStatusGrid: Boolean(document.querySelector(".mcp-status-grid")),
      hasTimeoutField: Boolean(document.querySelector(".mcp-status-grid")),
      hasPresetSelect: Boolean(document.querySelector(".mcp-preset-select")),
      hasTransferButtons: document.querySelectorAll(".mcp-preset-bar button").length >= 2,
      hasDiagnoseButton: document.querySelectorAll(".mcp-server-card button").length >= 3,
      hasCopyButtons: document.querySelectorAll(".mcp-server-card .anticon-copy").length >= 2,
      hasSchemaWarning: Boolean(document.querySelector(".mcp-tool-row .ant-tag-orange"))
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
      const chatControl = document.querySelector("[data-testid='workspace-switcher'] .ant-segmented-item input");
      chatControl?.click();
      return { clickedChat: Boolean(chatControl), switcher: Boolean(document.querySelector("[data-testid='workspace-switcher']")), labels: document.querySelectorAll("[data-testid='workspace-switcher'] .ant-segmented-item").length };
    })()`
  );
  await sleep(300);
  if (!chatClick?.clickedChat) {
    throw new Error(`Could not return to the chat workspace after config smoke checks: ${JSON.stringify(chatClick)}`);
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
    })()`
  );
  if (!finalLayoutMetrics || finalLayoutMetrics.bodyOverflowY !== "hidden" || finalLayoutMetrics.documentScrollHeight > finalLayoutMetrics.viewport + 2) {
    throw new Error("Window-level scrolling is still enabled.");
  }
  if (!finalLayoutMetrics.chat || !finalLayoutMetrics.composer || Math.abs(finalLayoutMetrics.composer.bottom - finalLayoutMetrics.chat.bottom) > 2) {
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
  if (!scrollAfterSettling || scrollAfterSettling.distanceFromBottom > 2) {
    throw new Error("Message stream ignored manual scrolling away from the bottom.");
  }
}

async function collectDiagnostics(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await waitForWebSocketOpen(ws, "diagnostics");
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
    expression: "window.__supbotSmoke = { root: document.getElementById('root')?.innerHTML || '', errors: [] }",
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
    clearTimeout(smokeDeadline);
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
  const projectRoot = path.join(userDataDir, "smoke-project");
  const worktreePath = path.join(userDataDir, "smoke-worktree");
  const reportPath = path.join(projectRoot, "reports", "autopilot-aprun_smoke-summary.md");
  fs.mkdirSync(path.join(projectRoot, ".supbot", "runs", "aprun_smoke"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "reports"), { recursive: true });
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(reportPath, "# Smoke Autopilot Summary\n\n## Approval History\n- Pending smoke audit.\n", "utf8");
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
      apiUrl: "http://127.0.0.1:9/subscriber/market/api",
      accountEmail: "subscriber@toolsmarket.local",
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
    projects: [{
      id: "project_smoke",
      name: "Smoke project",
      rootPath: projectRoot,
      metadataPath: path.join(projectRoot, ".supbot", "project.json"),
      status: "active",
      createdAt: now,
      updatedAt: now
    }],
    autopilotRuns: [{
      schemaVersion: 2,
      id: "aprun_smoke",
      projectId: "project_smoke",
      projectRoot,
      title: "Smoke loop engineering run",
      goal: "Verify the Loop Engineering monitor",
      goalSpec: { objective: "Verify the Loop Engineering monitor", deliverables: ["Visible monitor"], acceptanceCriteria: ["Budget and approval are visible"] },
      profile: "coding",
      resolvedProfile: "coding",
      plan: { version: 2, profile: "coding", summary: "Smoke structured plan", taskIds: ["aptask_smoke"], createdAt: now, updatedAt: now },
      status: "waiting_approval",
      currentStage: "execute",
      writePolicy: { mode: "projectSandbox", allowedWriteRoots: ["."], allowNetwork: false, allowMcp: false, maxRuntimeMinutes: 30, maxTasks: 8, maxRetries: 1 },
      budget: { limits: { maxRuntimeMinutes: 30, maxIterations: 8, maxTasks: 8, maxModelTurns: 40, maxToolCalls: 60 }, usage: { iterations: 2, modelTurns: 6, toolCalls: 4, totalTokens: 1200, startedAt: now } },
      loopIteration: 2,
      noProgressCount: 0,
      pendingDecision: { id: "apdecision_smoke", kind: "direct_write", title: "Approve smoke action", summary: "Review the impact before continuing.", risk: "high", impact: ["README.md"], rollbackPlan: "Restore the checkpoint backup.", input: { path: "README.md", contentPreview: "smoke" }, createdAt: now },
      worktreeId: "wt_smoke",
      dataSources: [],
      taskIds: ["aptask_smoke"],
      artifactIds: [],
      checkpointIds: [],
      evidence: [],
      reportPath,
      createdAt: now,
      updatedAt: now,
      startedAt: now
    }],
    autopilotTasks: [{
      id: "aptask_smoke",
      runId: "aprun_smoke",
      projectId: "project_smoke",
      stage: "execute",
      kind: "modify",
      dependsOn: [],
      risk: "medium",
      allowedTools: ["ReadFile", "WriteFile", "Shell"],
      validators: [],
      staffAgent: "builder",
      title: "Smoke implementation task",
      prompt: "Exercise the monitor",
      status: "running",
      attempts: 1,
      maxAttempts: 2,
      artifactIds: [],
      evidence: [],
      actionFingerprints: [],
      createdAt: now,
      updatedAt: now
    }],
    autopilotEvents: [{ id: "apevent_smoke", runId: "aprun_smoke", projectId: "project_smoke", level: "info", message: "Smoke loop event", createdAt: now }],
    autopilotCheckpoints: [],
    autopilotActions: [{ id: "apaction_smoke", runId: "aprun_smoke", taskId: "aptask_smoke", fingerprint: "smoke", toolName: "ReadFile", status: "completed", retrySafety: "safe", inputSummary: "README.md", createdAt: now, updatedAt: now }],
    dataArtifacts: [],
    worktrees: [{ id: "wt_smoke", taskId: "aprun_smoke", jobId: "aprun_smoke", conversationId: "autopilot_aprun_smoke", baseRef: "HEAD", branchName: "supbot/smoke", rootPath: projectRoot, path: worktreePath, status: "completed", diffStatus: "dirty", diffSummary: { worktreeId: "wt_smoke", changedFiles: ["README.md"], summary: "1 file changed" }, createdAt: now, updatedAt: now, completedAt: now }],
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
