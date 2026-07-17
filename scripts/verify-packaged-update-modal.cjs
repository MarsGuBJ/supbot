const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const appPath = process.env.HBCLIENT_PACKAGED_EXE || path.resolve("apps", "desktop", "release", "win-unpacked", "HBClient.exe");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hbclient-update-modal-"));
const debugPort = Number(process.env.HBCLIENT_VERIFY_PORT || 9359);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let child;

async function waitForPage() {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    try {
      const pages = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
      const page = pages.find((item) => item.type === "page") || pages[0];
      if (page?.webSocketDebuggerUrl) {
        return page;
      }
    } catch {
      // The packaged app is still starting.
    }
    await sleep(250);
  }
  throw new Error("No packaged HBClient page exposed through DevTools.");
}

async function evaluate(wsUrl, expression, timeoutMs = 10_000) {
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
    ws.send(JSON.stringify({
      id: messageId,
      method: "Runtime.evaluate",
      params: { expression, awaitPromise: true, returnByValue: true }
    }));
  });
  ws.close();
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime evaluation failed.");
  }
  return result.result.result.value;
}

async function main() {
  if (!fs.existsSync(appPath)) {
    throw new Error(`Packaged app not found: ${appPath}`);
  }
  const updateFeed = http.createServer((req, res) => {
    const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    if (pathname === "/latest.yml") {
      const body = [
        "version: 0.1.3",
        "files:",
        "  - url: HBClient-0.1.3-win-x64.exe",
        "    sha512: dGVzdA==",
        "    size: 1",
        "path: HBClient-0.1.3-win-x64.exe",
        "sha512: dGVzdA==",
        "releaseDate: 2026-07-16T00:00:00Z",
        ""
      ].join("\n");
      res.writeHead(200, {
        "Content-Type": "application/yaml",
        "Content-Length": Buffer.byteLength(body)
      });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end("missing");
  });
  await new Promise((resolve) => updateFeed.listen(0, "127.0.0.1", resolve));
  const feedUrl = `http://127.0.0.1:${updateFeed.address().port}`;
  child = spawn(appPath, [`--remote-debugging-port=${debugPort}`], {
    env: {
      ...process.env,
      HBCLIENT_USER_DATA_DIR: userDataDir,
      HBCLIENT_UPDATE_FEED_URL: feedUrl
    },
    stdio: "ignore",
    windowsHide: true
  });

  try {
    const page = await waitForPage();
    const modal = await evaluate(page.webSocketDebuggerUrl, `(async () => {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const state = await window.supbot.getHBClientUpdateState();
        const text = document.querySelector(".ant-modal")?.textContent || "";
        if (state.status === "available" && text) {
          return { state, text };
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return {
        state: await window.supbot.getHBClientUpdateState(),
        text: document.querySelector(".ant-modal")?.textContent || ""
      };
    })()`, 35_000);

    console.log(JSON.stringify({
      feedUrl,
      status: modal.state.status,
      availableVersion: modal.state.availableVersion,
      modalText: modal.text,
      userDataDir
    }, null, 2));

    if (modal.state.status !== "available" || modal.state.availableVersion !== "0.1.3" || !/0\.1\.3/.test(modal.text)) {
      throw new Error("Update modal did not appear for an available server version.");
    }
  } finally {
    if (child && !child.killed) {
      child.kill();
    }
    updateFeed.close();
    await sleep(800);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
