const { spawn } = require("node:child_process");
const path = require("node:path");

const appPath = path.resolve("apps", "desktop", "release", "win-unpacked", "HBClient.exe");
const port = 9333;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForPage() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const page = pages.find((item) => item.type === "page") || pages[0];
      if (page?.webSocketDebuggerUrl) {
        return page;
      }
    } catch {
      // The app is still starting.
    }
    await sleep(300);
  }
  throw new Error("No packaged HBClient page exposed through DevTools.");
}

async function evaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const messageId = 1;
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP timeout: Runtime.evaluate")), 5000);
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
      params: { expression, returnByValue: true }
    }));
  });
  ws.close();
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime evaluation failed.");
  }
  return result.result.result.value;
}

async function main() {
  const child = spawn(appPath, [`--remote-debugging-port=${port}`], {
    detached: true,
    stdio: "ignore",
    windowsHide: false
  });
  child.unref();

  const page = await waitForPage();
  const bodyText = String(await evaluate(page.webSocketDebuggerUrl, "document.body.innerText"));
  const railToggleCount = Number(await evaluate(page.webSocketDebuggerUrl, "document.querySelectorAll('.rail-toggle').length"));
  const topbarToggleCount = Number(await evaluate(page.webSocketDebuggerUrl, "document.querySelectorAll('.topbar-actions button .anticon-menu-fold, .topbar-actions button .anticon-menu-unfold').length"));
  const composerBox = await evaluate(
    page.webSocketDebuggerUrl,
    "(() => { const el = document.querySelector('.composer'); if (!el) return null; const r = el.getBoundingClientRect(); return { bottom: r.bottom, viewport: window.innerHeight, position: getComputedStyle(el).position }; })()"
  );
  const leftOverviewRemoved = !bodyText.includes("单用户，本地进程内运行时");
  const leftStartsWithCapabilities = bodyText.includes("就绪\n能力\n");
  const composerFixed = composerBox && composerBox.position === "fixed" && Math.abs(composerBox.bottom - composerBox.viewport) <= 2;

  console.log(JSON.stringify({
    processId: child.pid,
    url: page.url,
    leftOverviewRemoved,
    leftStartsWithCapabilities,
    railToggleCount,
    topbarToggleCount,
    composerFixed,
    bodyStart: bodyText.slice(0, 500)
  }, null, 2));

  if (!leftOverviewRemoved || !leftStartsWithCapabilities || railToggleCount !== 0 || topbarToggleCount < 2 || !composerFixed) {
    throw new Error("Packaged HBClient window did not load the expected updated UI.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
