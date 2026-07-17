const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const appPath = process.env.HBCLIENT_PACKAGED_EXE || path.resolve("apps", "desktop", "release", "win-unpacked", "HBClient.exe");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hbclient-packaged-"));
const port = Number(process.env.HBCLIENT_VERIFY_PORT || 9347);
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

async function evaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const messageId = Math.floor(Math.random() * 1_000_000_000);
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP timeout: Runtime.evaluate")), 10_000);
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
  child = spawn(appPath, [`--remote-debugging-port=${port}`], {
    env: { ...process.env, HBCLIENT_USER_DATA_DIR: userDataDir },
    stdio: "ignore",
    windowsHide: true
  });
  const page = await waitForPage();
  const result = await evaluate(page.webSocketDebuggerUrl, `(async () => {
    const snapshot = await window.supbot.snapshot();
    const market = await window.supbot.listToolMarket({ query: "anthropic" });
    const anthropicCapabilities = snapshot.capabilities
      .filter((item) => item.kind === "skill" && item.id.includes("anthropic"))
      .map((item) => item.id)
      .sort();
    return {
      url: location.href,
      capabilityCount: anthropicCapabilities.length,
      hasDocx: anthropicCapabilities.includes("market.skill.anthropic.docx"),
      hasPdf: anthropicCapabilities.includes("market.skill.anthropic.pdf"),
      installedMarketCount: market.filter((item) => item.installed).length,
      capabilitySample: anthropicCapabilities.slice(0, 5)
    };
  })()`);
  const seededSkillsDir = path.join(userDataDir, "data", "skills");
  const seededSkillCount = fs.existsSync(seededSkillsDir)
    ? fs.readdirSync(seededSkillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
    : 0;
  const markerExists = fs.existsSync(path.join(userDataDir, "data", "default-data-seed.json"));
  const updateConfigPath = path.join(path.dirname(appPath), "resources", "app-update.yml");
  const updateConfig = fs.existsSync(updateConfigPath) ? fs.readFileSync(updateConfigPath, "utf8") : "";
  const hasUpdateConfig = updateConfig.includes("provider: generic")
    && updateConfig.includes("101.227.67.76:8800")
    && updateConfig.includes("useMultipleRangeRequest: false");
  const verification = { ...result, seededSkillCount, markerExists, hasUpdateConfig, userDataDir };
  console.log(JSON.stringify(verification, null, 2));
  if (result.capabilityCount < 17 || !result.hasDocx || !result.hasPdf || result.installedMarketCount < 17 || seededSkillCount < 17 || !markerExists || !hasUpdateConfig) {
    throw new Error("Packaged app did not seed bundled default skills or update config correctly.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (child && !child.killed) {
    child.kill();
  }
  await sleep(800);
  fs.rmSync(userDataDir, { recursive: true, force: true });
});
