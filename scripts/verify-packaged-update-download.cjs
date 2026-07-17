const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { buildBlockMap } = require("../node_modules/app-builder-lib/out/targets/blockmap/blockmap.js");

const appPath = process.env.HBCLIENT_PACKAGED_EXE || path.resolve("apps", "desktop", "release", "win-unpacked", "HBClient.exe");
const oldInstallerPath = process.env.HBCLIENT_CURRENT_INSTALLER || path.resolve("apps", "desktop", "release", "HBClient-0.1.2-win-x64.exe");
const targetInstallerPath = process.env.HBCLIENT_TARGET_INSTALLER ? path.resolve(process.env.HBCLIENT_TARGET_INSTALLER) : "";
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "hbclient-differential-update-"));
const userDataDir = path.join(fixtureDir, "user-data");
const localAppDataDir = path.join(fixtureDir, "local-app-data");
const newInstallerPath = targetInstallerPath || path.join(fixtureDir, "HBClient-0.1.3-win-x64.exe");
const oldInstallerName = path.basename(oldInstallerPath);
const newInstallerName = path.basename(newInstallerPath);
const oldVersion = installerVersion(oldInstallerName);
const newVersion = installerVersion(newInstallerName);
const oldBlockmapName = `${oldInstallerName}.blockmap`;
const newBlockmapName = `${newInstallerName}.blockmap`;
const configuredOldBlockmapPath = process.env.HBCLIENT_CURRENT_BLOCKMAP || `${oldInstallerPath}.blockmap`;
const configuredNewBlockmapPath = process.env.HBCLIENT_TARGET_BLOCKMAP || `${newInstallerPath}.blockmap`;
const oldBlockmapPath = fs.existsSync(configuredOldBlockmapPath) ? configuredOldBlockmapPath : path.join(fixtureDir, oldBlockmapName);
const newBlockmapPath = fs.existsSync(configuredNewBlockmapPath) ? configuredNewBlockmapPath : path.join(fixtureDir, newBlockmapName);
const debugPort = Number(process.env.HBCLIENT_VERIFY_PORT || 9360);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let child;
let temporaryUpdateConfigPath = "";

function installerVersion(fileName) {
  const match = /^HBClient-(\d+\.\d+\.\d+)-win-x64\.exe$/.exec(fileName);
  if (!match) {
    throw new Error(`Installer file name does not contain a valid HBClient version: ${fileName}`);
  }
  return match[1];
}

async function hashFile(filePath, algorithm) {
  const hash = createHash(algorithm);
  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(filePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", resolve);
    input.on("error", reject);
  });
  return hash.digest("base64");
}

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

async function evaluate(wsUrl, expression, timeoutMs = 45_000) {
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

function serveInstaller(req, res, filePath, stats) {
  const size = fs.statSync(filePath).size;
  const range = req.headers.range;
  if (!range) {
    if (req.method !== "HEAD") {
      stats.fullInstallerRequests += 1;
      stats.transferredInstallerBytes += size;
    }
    res.writeHead(200, {
      "Accept-Ranges": "bytes",
      "Content-Type": "application/vnd.microsoft.portable-executable",
      "Content-Length": size
    });
    if (req.method === "HEAD") {
      res.end();
    } else {
      fs.createReadStream(filePath).pipe(res);
    }
    return;
  }
  if (range.includes(",")) {
    stats.multiRangeRequests += 1;
    res.writeHead(416);
    res.end();
    return;
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!match) {
    res.writeHead(416);
    res.end();
    return;
  }
  const start = Number(match[1]);
  const end = Math.min(match[2] ? Number(match[2]) : size - 1, size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    res.writeHead(416);
    res.end();
    return;
  }
  const length = end - start + 1;
  stats.rangeRequests.push(range);
  stats.transferredInstallerBytes += req.method === "HEAD" ? 0 : length;
  res.writeHead(206, {
    "Accept-Ranges": "bytes",
    "Content-Type": "application/vnd.microsoft.portable-executable",
    "Content-Length": length,
    "Content-Range": `bytes ${start}-${end}/${size}`
  });
  if (req.method === "HEAD") {
    res.end();
  } else {
    fs.createReadStream(filePath, { start, end }).pipe(res);
  }
}

async function main() {
  for (const requiredPath of [appPath, oldInstallerPath, ...(targetInstallerPath ? [targetInstallerPath] : [])]) {
    if (!fs.existsSync(requiredPath)) {
      throw new Error(`Required packaged artifact not found: ${requiredPath}`);
    }
  }
  const updateConfigPath = path.join(path.dirname(appPath), "resources", "app-update.yml");
  if (!fs.existsSync(updateConfigPath)) {
    const packageConfig = JSON.parse(fs.readFileSync(path.resolve("apps", "desktop", "package.json"), "utf8"));
    const publish = packageConfig.build?.publish?.[0];
    if (publish?.provider !== "generic" || !publish.url || publish.useMultipleRangeRequest !== false) {
      throw new Error("Desktop publish configuration is not ready for single-range differential updates.");
    }
    fs.writeFileSync(updateConfigPath, [
      "provider: generic",
      `url: ${publish.url}`,
      "useMultipleRangeRequest: false",
      "updaterCacheDirName: hbclient-updater",
      ""
    ].join("\n"));
    temporaryUpdateConfigPath = updateConfigPath;
  }
  const updateConfig = fs.readFileSync(updateConfigPath, "utf8");
  if (!updateConfig.includes("useMultipleRangeRequest: false")) {
    throw new Error("Packaged update config does not disable multiple range requests.");
  }

  fs.mkdirSync(userDataDir, { recursive: true });
  const updaterCacheDir = path.join(localAppDataDir, "hbclient-updater");
  fs.mkdirSync(updaterCacheDir, { recursive: true });
  fs.copyFileSync(oldInstallerPath, path.join(updaterCacheDir, "installer.exe"));
  if (!targetInstallerPath) {
    fs.copyFileSync(oldInstallerPath, newInstallerPath);
    fs.appendFileSync(newInstallerPath, Buffer.from("\nHBClient differential verification fixture\n", "utf8"));
  }
  if (!fs.existsSync(oldBlockmapPath)) {
    await buildBlockMap(oldInstallerPath, "gzip", oldBlockmapPath);
  }
  if (!fs.existsSync(newBlockmapPath)) {
    await buildBlockMap(newInstallerPath, "gzip", newBlockmapPath);
  }

  const newInstallerSize = fs.statSync(newInstallerPath).size;
  const newSha512 = await hashFile(newInstallerPath, "sha512");
  const blockmaps = new Map([
    [`/${oldBlockmapName}`, fs.readFileSync(oldBlockmapPath)],
    [`/${newBlockmapName}`, fs.readFileSync(newBlockmapPath)]
  ]);
  const stats = {
    blockmapRequests: [],
    fullInstallerRequests: 0,
    multiRangeRequests: 0,
    rangeRequests: [],
    transferredInstallerBytes: 0
  };
  const updateFeed = http.createServer((req, res) => {
    const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    if (pathname === "/latest.yml") {
      const body = [
        `version: ${newVersion}`,
        "files:",
        `  - url: ${newInstallerName}`,
        `    sha512: ${newSha512}`,
        `    size: ${newInstallerSize}`,
        `path: ${newInstallerName}`,
        `sha512: ${newSha512}`,
        "releaseDate: 2026-07-16T00:00:00Z",
        ""
      ].join("\n");
      res.writeHead(200, { "Content-Type": "application/yaml", "Content-Length": Buffer.byteLength(body) });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    if (blockmaps.has(pathname)) {
      const body = blockmaps.get(pathname);
      stats.blockmapRequests.push(pathname);
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    if (pathname === `/${newInstallerName}`) {
      serveInstaller(req, res, newInstallerPath, stats);
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
      HBCLIENT_UPDATE_FEED_URL: feedUrl,
      LOCALAPPDATA: localAppDataDir
    },
    stdio: "ignore",
    windowsHide: true
  });

  try {
    const page = await waitForPage();
    const result = await evaluate(page.webSocketDebuggerUrl, `(async () => {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const state = await window.supbot.getHBClientUpdateState();
        if (state.status === "available") break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      try {
        return { ok: true, state: await window.supbot.downloadHBClientUpdate() };
      } catch (error) {
        return { ok: false, error: String(error?.message || error), state: await window.supbot.getHBClientUpdateState() };
      }
    })()`, 60_000);
    const downloadedPath = path.join(updaterCacheDir, "pending", newInstallerName);
    const downloadedSha512 = fs.existsSync(downloadedPath) ? await hashFile(downloadedPath, "sha512") : "";
    const transferredRatio = stats.transferredInstallerBytes / newInstallerSize;
    const verification = { feedUrl, oldVersion, newVersion, ...result, downloadedSha512, expectedSha512: newSha512, transferredRatio, stats };
    console.log(JSON.stringify(verification, null, 2));

    if (!result.ok || result.state?.status !== "downloaded") {
      throw new Error(`Packaged differential download failed: ${result.error || result.state?.status}`);
    }
    if (downloadedSha512 !== newSha512) {
      throw new Error("Differentially downloaded installer checksum does not match.");
    }
    if (stats.fullInstallerRequests !== 0 || stats.multiRangeRequests !== 0 || stats.rangeRequests.length === 0) {
      throw new Error("Updater did not use single-range differential requests.");
    }
    if (!stats.blockmapRequests.includes(`/${oldBlockmapName}`) || !stats.blockmapRequests.includes(`/${newBlockmapName}`)) {
      throw new Error("Updater did not request both old and new blockmaps.");
    }
    if (transferredRatio >= 0.1) {
      throw new Error(`Differential transfer was too large: ${(transferredRatio * 100).toFixed(2)}%`);
    }
  } finally {
    if (child && !child.killed) child.kill();
    updateFeed.close();
    await sleep(800);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  if (temporaryUpdateConfigPath) {
    fs.rmSync(temporaryUpdateConfigPath, { force: true });
  }
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});
