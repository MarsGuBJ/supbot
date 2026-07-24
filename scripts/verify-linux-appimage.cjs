#!/usr/bin/env node

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

if (process.platform !== "linux") {
  fail("Linux AppImage smoke verification must run on Linux.");
}

const repoRoot = path.resolve(__dirname, "..");
const desktopPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, "apps", "desktop", "package.json"), "utf8"));
const defaultAppImage = path.join(
  repoRoot,
  "apps",
  "desktop",
  "release",
  `HBClient-${desktopPackage.version}-linux-x86_64.AppImage`,
);
const appImagePath = path.resolve(process.env.HBCLIENT_LINUX_APPIMAGE || defaultAppImage);
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hbclient-linux-smoke-"));
const debugPort = Number(process.env.HBCLIENT_VERIFY_PORT || 9400 + (process.pid % 500));
const output = [];
let child;

async function main() {
  if (!fs.existsSync(appImagePath)) {
    fail(`Linux AppImage not found: ${appImagePath}`);
  }

  const args = [];
  if (process.env.HBCLIENT_APPIMAGE_EXTRACT_AND_RUN === "1") {
    args.push("--appimage-extract-and-run");
  }
  args.push(`--remote-debugging-port=${debugPort}`);

  child = spawn(appImagePath, args, {
    detached: true,
    env: {
      ...process.env,
      HBCLIENT_BOTSTATION_AUTO_CONNECT: "0",
      HBCLIENT_USER_DATA_DIR: userDataDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", collectOutput);
  child.stderr.on("data", collectOutput);

  const page = await waitForPage();
  const result = await waitForMountedUi(page.webSocketDebuggerUrl);

  console.log(JSON.stringify({ appImage: appImagePath, debugPort, ...result }, null, 2));
}

async function waitForPage() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`AppImage exited with code ${child.exitCode}.\n${output.join("").slice(-8000)}`);
    }
    try {
      const pages = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
      const page = pages.find((item) => item.type === "page") || pages[0];
      if (page?.webSocketDebuggerUrl) {
        return page;
      }
    } catch {
      // The packaged application is still starting.
    }
    await sleep(250);
  }
  throw new Error(`No packaged Linux page exposed through DevTools.\n${output.join("").slice(-8000)}`);
}

async function waitForMountedUi(webSocketUrl) {
  const deadline = Date.now() + 30_000;
  let lastResult;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`AppImage exited with code ${child.exitCode}.\n${output.join("").slice(-8000)}`);
    }
    try {
      lastResult = await evaluate(
        webSocketUrl,
        `(async () => {
          if (!window.supbot) return null;
          const snapshot = await window.supbot.snapshot();
          return {
            title: document.title,
            agentName: snapshot.agentName,
            topbar: Boolean(document.querySelector(".topbar")),
            composer: Boolean(document.querySelector(".composer")),
            bodyLength: document.body.innerText.length
          };
        })()`,
      );
      if (lastResult?.topbar && lastResult?.composer && lastResult?.agentName && lastResult.bodyLength >= 20) {
        return lastResult;
      }
    } catch {
      // The renderer or preload bridge is still starting.
    }
    await sleep(250);
  }
  throw new Error(
    `Packaged Linux UI did not mount correctly: ${JSON.stringify(lastResult)}\n${output.join("").slice(-8000)}`,
  );
}

async function evaluate(webSocketUrl, expression) {
  const webSocket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    webSocket.onopen = resolve;
    webSocket.onerror = reject;
  });
  const id = 1;
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP Runtime.evaluate timed out.")), 10_000);
    webSocket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id === id) {
        clearTimeout(timer);
        resolve(message);
      }
    };
    webSocket.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    );
  });
  webSocket.close();
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text || "CDP Runtime.evaluate failed.");
  }
  return response.result.result.value;
}

function collectOutput(chunk) {
  output.push(String(chunk));
  if (output.length > 100) {
    output.shift();
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (child?.pid && child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // The application already exited.
      }
      await sleep(500);
    }
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });
