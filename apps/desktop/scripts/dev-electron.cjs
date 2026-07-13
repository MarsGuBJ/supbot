const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const host = "127.0.0.1";
const preferredPort = positivePort(process.env.SUPBOT_DEV_PORT) || 5173;
const appRoot = path.resolve(__dirname, "..");

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

async function main() {
  const port = await findAvailablePort(preferredPort, host);
  const url = `http://${host}:${port}`;
  if (process.argv.includes("--probe")) {
    process.stdout.write(`${url}\n`);
    return;
  }

  const vite = spawn(process.execPath, [resolvePackageBin("vite"), "--host", host, "--port", String(port), "--strictPort"], {
    cwd: appRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true
  });
  const stopVite = () => terminate(vite);
  process.once("SIGINT", stopVite);
  process.once("SIGTERM", stopVite);

  try {
    await waitForHttp(url, vite, 15_000);
    const electron = spawn(process.execPath, [resolvePackageBin("electron"), "."], {
      cwd: appRoot,
      env: { ...process.env, SUPBOT_DEV_SERVER_URL: url },
      stdio: "inherit",
      windowsHide: true
    });
    electron.once("exit", (code) => {
      terminate(vite);
      process.exitCode = code || 0;
    });
    vite.once("exit", (code) => {
      if (electron.exitCode === null) terminate(electron);
      if (code) process.exitCode = code;
    });
  } catch (error) {
    terminate(vite);
    throw error;
  }
}

async function findAvailablePort(startPort, hostname) {
  for (let port = startPort; port < startPort + 100; port += 1) {
    if (await portAvailable(port, hostname)) return port;
  }
  throw new Error(`No available development port found from ${startPort} to ${startPort + 99}.`);
}

function portAvailable(port, hostname) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host: hostname, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

function waitForHttp(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onExit = (code) => finish(new Error(`Vite exited before becoming ready (code ${code ?? "unknown"}).`));
    const poll = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if ((response.statusCode || 500) < 500) return finish();
        retry();
      });
      request.setTimeout(750, () => request.destroy());
      request.once("error", retry);
    };
    const retry = () => {
      if (settled) return;
      if (Date.now() >= deadline) return finish(new Error(`Vite did not become ready at ${url} within ${timeoutMs}ms.`));
      setTimeout(poll, 100);
    };
    child.once("exit", onExit);
    poll();
  });
}

function terminate(child) {
  if (child && child.exitCode === null && !child.killed) child.kill();
}

function positivePort(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : undefined;
}

function resolvePackageBin(packageName) {
  const packagePath = require.resolve(`${packageName}/package.json`);
  const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[packageName];
  if (!bin) throw new Error(`${packageName} does not declare a CLI binary.`);
  return path.resolve(path.dirname(packagePath), bin);
}
