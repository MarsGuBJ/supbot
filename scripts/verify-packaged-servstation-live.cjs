const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const appPath =
  process.env.HBCLIENT_PACKAGED_EXE || path.resolve("apps", "desktop", "release", "win-unpacked", "HBClient.exe");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hbclient-servstation-"));
const port = Number(process.env.HBCLIENT_VERIFY_PORT || 9348);
const loginUser = process.env.HBCLIENT_BOTSTATION_USERNAME || "dev-user";
const loginPassword = process.env.HBCLIENT_BOTSTATION_PASSWORD || "dev-user";
const historyAgentInstanceId = process.env.HBCLIENT_VERIFY_AGENT_INSTANCE_ID || "";
const cleanupConversationIds = (process.env.HBCLIENT_VERIFY_CLEANUP_CONVERSATION_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let child;

async function waitForPage() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const page = pages.find((item) => item.type === "page") || pages[0];
      if (page?.webSocketDebuggerUrl) {
        return page;
      }
    } catch {
      // The packaged app is still starting.
    }
    await sleep(300);
  }
  throw new Error("No packaged HBClient page exposed through DevTools.");
}

async function waitForAuthPage() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const page = pages.find((item) => item.type === "page" && /\/oauth2\/login(?:[?]|$)/.test(item.url || ""));
      if (page?.webSocketDebuggerUrl) {
        return page;
      }
    } catch {
      // The OIDC window is still opening.
    }
    await sleep(250);
  }
  throw new Error("No Servstation OIDC login page exposed through DevTools.");
}

async function evaluate(wsUrl, expression, timeoutMs = 120_000) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const messageId = Math.floor(Math.random() * 1_000_000_000);
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP timeout: Runtime.evaluate")), timeoutMs);
    ws.addEventListener("message", (event) => {
      const data = JSON.parse(event.data);
      if (data.id === messageId) {
        clearTimeout(timer);
        resolve(data);
      }
    });
    ws.send(
      JSON.stringify({
        id: messageId,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    );
  });
  ws.close();
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime evaluation failed.");
  }
  return result.result.result.value;
}

async function waitForLoginResult(wsUrl) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await evaluate(wsUrl, "window.__hbclientServstationLoginResult || null", 5_000);
    if (result) {
      return result;
    }
    await sleep(250);
  }
  throw new Error("Servstation OIDC login did not complete.");
}

async function main() {
  if (!fs.existsSync(appPath)) {
    throw new Error(`Packaged app not found: ${appPath}`);
  }
  child = spawn(appPath, [`--remote-debugging-port=${port}`], {
    env: { ...process.env, HBCLIENT_USER_DATA_DIR: userDataDir },
    stdio: "ignore",
    windowsHide: true,
  });
  const page = await waitForPage();
  const before = await evaluate(page.webSocketDebuggerUrl, "window.supbot.snapshot()");
  await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
    window.__hbclientServstationLoginResult = null;
    window.supbot.loginServstationOidc({}).then(
      (login) => { window.__hbclientServstationLoginResult = { ok: true, login }; },
      (error) => { window.__hbclientServstationLoginResult = { ok: false, error: String(error?.message || error) }; }
    );
    return true;
  })()`,
  );
  const loginRace = await Promise.race([
    waitForAuthPage().then((authPage) => ({ authPage })),
    waitForLoginResult(page.webSocketDebuggerUrl).then((loginResult) => ({ loginResult })),
  ]);
  let loginResult = loginRace.loginResult;
  if (loginRace.authPage) {
    const submitted = await evaluate(
      loginRace.authPage.webSocketDebuggerUrl,
      `(() => {
      const user = document.querySelector('input[name="userId"]');
      const password = document.querySelector('input[name="password"]');
      const form = document.querySelector('form');
      if (!user || !password || !form) return false;
      user.value = ${JSON.stringify(loginUser)};
      password.value = ${JSON.stringify(loginPassword)};
      form.submit();
      return true;
    })()`,
    );
    if (!submitted) {
      throw new Error("Servstation OIDC login form was not ready.");
    }
    loginResult = await waitForLoginResult(page.webSocketDebuggerUrl);
  }
  if (!loginResult.ok) {
    throw new Error(`Servstation OIDC login failed: ${loginResult.error}`);
  }
  const result = await evaluate(
    page.webSocketDebuggerUrl,
    `(async () => {
    const historyAgentInstanceId = ${JSON.stringify(historyAgentInstanceId)};
    if (historyAgentInstanceId) {
      await window.supbot.updateServstationA2AConfig({ agentInstanceId: historyAgentInstanceId });
    }
    const connected = await window.supbot.connectServstationReverseBridge();
    for (const conversationId of ${JSON.stringify(cleanupConversationIds)}) {
      await window.supbot.deleteServstationConversation(conversationId).catch(() => undefined);
    }
    const summary = await window.supbot.getServstationClientSnapshot();
    let historyConversation;
    let history = null;
    const historyConversations = [];
    const declaredHistoryWithoutMessages = [];
    for (const conversation of summary.conversations) {
      const candidate = await window.supbot.getServstationClientSnapshot({ conversationId: conversation.id });
      const hydratedConversation = candidate.conversations.find((item) => item.id === conversation.id);
      const messageCount = hydratedConversation?.messages?.length || 0;
      if (messageCount > 0) {
        historyConversations.push({
          id: conversation.id,
          title: conversation.title,
          declaredJobCount: conversation.jobCount,
          returnedJobCount: candidate.jobs.length,
          returnedMessageCount: messageCount,
          firstMessageText: hydratedConversation.messages[0]?.text || ""
        });
        if (!historyConversation) {
          historyConversation = conversation;
          history = candidate;
        }
      } else if (conversation.jobCount > 0) {
        declaredHistoryWithoutMessages.push({
          id: conversation.id,
          title: conversation.title,
          declaredJobCount: conversation.jobCount
        });
      }
    }
    const firstHistory = historyConversations[0];
    const secondHistory = historyConversations.find((item) =>
      item.id !== firstHistory?.id && item.firstMessageText && item.firstMessageText !== firstHistory?.firstMessageText
    );
    return {
      reverseStatus: connected.reverse?.status,
      peerId: connected.reverse?.peerId,
      agentInstanceId: summary.agentInstanceId,
      conversationCount: summary.conversations.length,
      historyConversationCount: historyConversations.length,
      historyConversations: historyConversations.slice(0, 12).map(({ firstMessageText, ...conversation }) => conversation),
      declaredHistoryWithoutMessages: declaredHistoryWithoutMessages.slice(0, 12),
      historyConversationId: historyConversation?.id,
      historyConversationTitle: historyConversation?.title,
      historyFirstMessageText: firstHistory?.firstMessageText,
      secondHistoryConversationId: secondHistory?.id,
      secondHistoryFirstMessageText: secondHistory?.firstMessageText,
      historyMessageCount: history?.conversations.find((item) => item.id === historyConversation?.id)?.messages?.length || 0,
      historyJobCount: history?.jobs.length || 0,
      historyJobsScoped: Boolean(historyConversation && history?.jobs.every((job) => job.conversationId === historyConversation.id))
    };
  })()`,
  );
  let uiResult;
  try {
    if (historyAgentInstanceId && result.historyConversationId) {
      uiResult = await evaluate(
        page.webSocketDebuggerUrl,
        `(async () => {
      const historyConversationId = ${JSON.stringify(result.historyConversationId || "")};
      const historyFirstMessageText = ${JSON.stringify(result.historyFirstMessageText || "")};
      const secondHistoryConversationId = ${JSON.stringify(result.secondHistoryConversationId || "")};
      const secondHistoryFirstMessageText = ${JSON.stringify(result.secondHistoryFirstMessageText || "")};
      const waitUntil = async (predicate, timeoutMs = 20_000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (predicate()) return true;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        return false;
      };
      const serverTab = [...document.querySelectorAll(".topbar .ant-segmented-item-label")]
        .find((item) => /服务端 Agent|Server Agent/.test(item.textContent || ""));
      serverTab?.click();
      await waitUntil(() => Boolean(document.querySelector('[data-conversation-id="' + historyConversationId + '"]')));
      const historyButton = document.querySelector('[data-conversation-id="' + historyConversationId + '"]');
      historyButton?.click();
      const visibleMessageTexts = () => [...document.querySelectorAll(".server-agent-message-stream .message-text")]
        .map((item) => (item.textContent || "").trim());
      const historyVisible = await waitUntil(() => visibleMessageTexts().includes(historyFirstMessageText));
      const historyMessageCount = document.querySelectorAll(".server-agent-message-stream .message-row").length;
      const secondHistoryButton = document.querySelector('[data-conversation-id="' + secondHistoryConversationId + '"]');
      secondHistoryButton?.click();
      const secondHistoryVisible = await waitUntil(() => {
        const texts = visibleMessageTexts();
        return texts.includes(secondHistoryFirstMessageText) && !texts.includes(historyFirstMessageText);
      });
      const secondHistoryMessageCount = document.querySelectorAll(".server-agent-message-stream .message-row").length;
      const projectDraftButton = document.querySelector('[data-testid^="server-agent-project-new-conversation-"]');
      const draftButton = projectDraftButton || document.querySelector('[data-testid="server-agent-new-conversation"]');
      draftButton?.click();
      const draftEmpty = await waitUntil(() =>
        document.querySelectorAll(".server-agent-message-stream .message-row").length === 0 &&
        Boolean(document.querySelector(".server-agent-message-stream .ant-empty"))
      );
      const createdConversationId = projectDraftButton
        ? ""
        : document.querySelector(".server-agent-project-conversation.is-active button")?.getAttribute("data-conversation-id") || "";
      return {
        serverTabFound: Boolean(serverTab),
        historyButtonFound: Boolean(historyButton),
        historyVisible,
        historyMessageCount,
        secondHistoryButtonFound: Boolean(secondHistoryButton),
        secondHistoryVisible,
        secondHistoryMessageCount,
        draftButtonFound: Boolean(draftButton),
        draftEmpty,
        usedProjectDraft: Boolean(projectDraftButton),
        createdConversationId
      };
      })()`,
        45_000,
      );
      if (uiResult?.createdConversationId && uiResult.createdConversationId !== result.historyConversationId) {
        await evaluate(
          page.webSocketDebuggerUrl,
          `window.supbot.deleteServstationConversation(${JSON.stringify(uiResult.createdConversationId)})`,
        );
        const cleanupSnapshot = await evaluate(
          page.webSocketDebuggerUrl,
          "window.supbot.getServstationClientSnapshot()",
        );
        uiResult.cleanedCreatedConversation = !cleanupSnapshot.conversations.some(
          (conversation) => conversation.id === uiResult.createdConversationId,
        );
      } else if (uiResult) {
        uiResult.cleanedCreatedConversation = true;
      }
    }
  } finally {
    await evaluate(page.webSocketDebuggerUrl, "window.supbot.disconnectServstationReverseBridge()").catch(
      () => undefined,
    );
  }
  const printableResult = Object.fromEntries(
    Object.entries(result).filter(
      ([key]) => key !== "historyFirstMessageText" && key !== "secondHistoryFirstMessageText",
    ),
  );
  console.log(
    JSON.stringify(
      {
        baseUrl: before.servstationA2A.config.baseUrl,
        issuerUrl: before.servstationA2A.config.oidc?.issuerUrl,
        loginUserId: loginResult.login?.identityContext?.userId,
        ...printableResult,
        uiResult,
        userDataDir,
      },
      null,
      2,
    ),
  );
  if (
    before.servstationA2A.config.baseUrl !== "http://101.227.67.76:8800" ||
    before.servstationA2A.config.oidc?.issuerUrl !== "http://101.227.67.76:8092" ||
    loginResult.login?.identityContext?.userId !== loginUser ||
    result.reverseStatus !== "connected" ||
    !result.peerId ||
    (historyAgentInstanceId &&
      (!result.historyConversationId ||
        result.historyMessageCount < 1 ||
        !result.historyJobsScoped ||
        !uiResult?.serverTabFound ||
        !uiResult.historyButtonFound ||
        !uiResult.historyVisible ||
        uiResult.historyMessageCount < 1 ||
        !uiResult.secondHistoryButtonFound ||
        !uiResult.secondHistoryVisible ||
        uiResult.secondHistoryMessageCount < 1 ||
        !uiResult.draftButtonFound ||
        !uiResult.draftEmpty ||
        !uiResult.cleanedCreatedConversation))
  ) {
    throw new Error("Packaged app failed the live Servstation history conversation check.");
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (child && !child.killed) {
      child.kill();
    }
    await sleep(800);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
