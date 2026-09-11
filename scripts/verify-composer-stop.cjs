// Verifies the composer Stop/Send button behavior while a job is executing:
//   1. With a running job and an empty prompt, the composer shows a Stop button.
//   2. Typing a prompt switches it back to Send ("Submit prompt").
//   3. Clicking Send queues the prompt and the button returns to Stop.
//   4. "Insert queued prompt" interrupts the running job and sends the prompt as a new job.
// Run: node scripts/verify-composer-stop.cjs   (after `npm run build` in apps/desktop)
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let electron;
try {
  electron = require("electron");
} catch {
  electron = path.resolve("node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
}
const appDir = path.resolve("apps", "desktop");
const port = 9333;
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hbclient-composer-stop-"));
seedState(userDataDir);

const child = spawn(electron, [`--remote-debugging-port=${port}`, "."], {
  cwd: appDir,
  env: { ...process.env, HBCLIENT_USER_DATA_DIR: userDataDir },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = setTimeout(() => {
  console.error("[verify] timed out", { stderr: stderr.slice(0, 800) });
  child.kill();
  process.exit(1);
}, 60_000);

function waitForWebSocketOpen(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket open timeout")), 5000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket error"));
    });
  });
}

async function evaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  await waitForWebSocketOpen(ws);
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP evaluate timeout")), 15000);
    ws.addEventListener("message", (event) => {
      const data = JSON.parse(event.data);
      if (data.id === 1) {
        clearTimeout(timer);
        resolve(data);
      }
    });
    ws.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true },
      }),
    );
  });
  ws.close();
  if (result.exceptionDetails) {
    throw new Error(`Evaluation failed: ${JSON.stringify(result.exceptionDetails).slice(0, 400)}`);
  }
  return result.result?.result?.value;
}

async function waitFor(wsUrl, expression, label, attempts = 60) {
  let value;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    value = await evaluate(wsUrl, expression);
    if (value) {
      return value;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

async function main() {
  await sleep(4000);
  const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const page = pages.find((item) => item.type === "page") || pages[0];
  if (!page) {
    throw new Error("No Electron page exposed through DevTools.");
  }
  const wsUrl = page.webSocketDebuggerUrl;
  console.error(`[verify] page ${page.url}`);

  await waitFor(wsUrl, `Boolean(document.querySelector(".chat-panel .input-wrapper textarea"))`, "chat composer");

  // 1. Running job + empty prompt -> Stop button.
  const stopState = await waitFor(
    wsUrl,
    `(() => {
      const stop = document.querySelector("button.send-btn.is-stop");
      if (!stop) return null;
      return { aria: stop.getAttribute("aria-label"), disabled: stop.disabled, onlyButton: document.querySelectorAll("button.send-btn").length };
    })()`,
    "stop button while job running",
  );
  console.log(JSON.stringify({ stopState }));
  if (!["停止", "Stop"].includes(stopState.aria) || stopState.disabled || stopState.onlyButton !== 1) {
    throw new Error(`Stop button did not replace Send while the job is running: ${JSON.stringify(stopState)}`);
  }

  // 2. Typing a prompt -> Send button ("Submit prompt").
  await evaluate(
    wsUrl,
    `(() => {
      const textarea = document.querySelector(".chat-panel .input-wrapper textarea");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(textarea, "验证插入提示词 smoke prompt");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      return textarea.value;
    })()`,
  );
  const sendState = await waitFor(
    wsUrl,
    `(() => {
      const send = document.querySelector("button.send-btn:not(.is-stop)");
      if (!send) return null;
      return { aria: send.getAttribute("aria-label"), disabled: send.disabled };
    })()`,
    "send button after typing",
  );
  console.log(JSON.stringify({ sendState }));
  if (!["提交提示词", "Submit prompt"].includes(sendState.aria) || sendState.disabled) {
    throw new Error(
      `Button did not switch back to Send while typing during a running job: ${JSON.stringify(sendState)}`,
    );
  }

  // 3. Click Send -> prompt queued, input cleared, Stop button returns.
  await evaluate(wsUrl, `document.querySelector("button.send-btn:not(.is-stop)").click()`);
  const queuedState = await waitFor(
    wsUrl,
    `(() => {
      const item = document.querySelector(".prompt-queue-item .prompt-queue-text");
      if (!item) return null;
      const stop = document.querySelector("button.send-btn.is-stop");
      const textarea = document.querySelector(".chat-panel .input-wrapper textarea");
      return { queuedText: item.textContent, stopBack: Boolean(stop), inputCleared: textarea && textarea.value === "" };
    })()`,
    "queued prompt chip",
  );
  console.log(JSON.stringify({ queuedState }));
  if (!queuedState.queuedText.includes("验证插入提示词") || !queuedState.stopBack || !queuedState.inputCleared) {
    throw new Error(`Prompt was not queued correctly during the running job: ${JSON.stringify(queuedState)}`);
  }

  // 4. Insert queued prompt -> running job interrupted, prompt sent as a new job.
  await evaluate(
    wsUrl,
    `(() => {
      const insert = document.querySelector('button[aria-label="插入提示词"], button[aria-label="Insert queued prompt"]');
      insert.click();
      return Boolean(insert);
    })()`,
  );
  const inserted = await waitFor(
    wsUrl,
    `window.supbot.snapshot().then((snapshot) => {
      const conversation = snapshot.conversations.find((item) => item.id === "conv_verify");
      const oldJob = snapshot.jobs.find((item) => item.id === "job_verify");
      const newJob = snapshot.jobs.find((item) => item.prompt === "验证插入提示词 smoke prompt");
      const userMessage = conversation && conversation.messages.find((item) => item.role === "user" && item.text === "验证插入提示词 smoke prompt");
      if (!newJob || !userMessage) return null;
      return {
        oldStatus: oldJob && oldJob.status,
        newJobStatus: newJob.status,
        hasUserMessage: Boolean(userMessage),
        queueCleared: !document.querySelector(".prompt-queue-item")
      };
    })`,
    "inserted prompt job",
  );
  console.log(JSON.stringify({ inserted }));
  if (
    !["waiting_user", "canceled"].includes(inserted.oldStatus) ||
    !inserted.hasUserMessage ||
    !inserted.queueCleared
  ) {
    throw new Error(`Inserting the queued prompt did not interrupt and resend: ${JSON.stringify(inserted)}`);
  }

  console.log("VERIFY COMPOSER STOP: PASS");
  clearTimeout(deadline);
  child.kill();
  process.exit(0);
}

function seedState(dir) {
  const dataDir = path.join(dir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(dataDir, "state.json"),
    `${JSON.stringify(
      {
        agentName: "HyBot Local Agent",
        modelConfig: {
          providerName: "OpenAI Compatible",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4.1-mini",
          temperature: 0.2,
          maxTokens: 1600,
          apiKeySaved: false,
        },
        toolMarketConfig: {
          source: "local",
          apiUrl: "",
          accountEmail: "",
          accessTokenSaved: false,
          passwordSaved: false,
        },
        personality: { summary: "", traits: [], instructions: "" },
        capabilities: [],
        subagents: [],
        conversations: [
          {
            id: "conv_verify",
            title: "Composer stop verify",
            createdAt: now,
            updatedAt: now,
            lastMessageAt: now,
            messages: [
              {
                id: "msg_user_verify",
                conversationId: "conv_verify",
                role: "user",
                text: "run a long task",
                createdAt: now,
              },
            ],
          },
        ],
        jobs: [
          {
            id: "job_verify",
            conversationId: "conv_verify",
            prompt: "run a long task",
            status: "running",
            createdAt: now,
            updatedAt: now,
            progress: ["Verifying composer stop button"],
          },
        ],
        scheduledJobs: [],
        pendingToolPermissions: [],
        agentLoopTraces: [],
        querySessions: [],
        runtimeEvents: [],
        compactBoundaries: [],
        memory: { pages: [], facts: [], chunks: [], links: [], candidates: [], recallHistory: [], recallFeedback: [] },
        permissionMode: "default",
        permissionRules: [],
        mcpServers: [],
        mcpTools: [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

main().catch((error) => {
  console.error("VERIFY COMPOSER STOP: FAIL", error.message || error, { stderr: stderr.slice(0, 800) });
  clearTimeout(deadline);
  child.kill();
  process.exit(1);
});
