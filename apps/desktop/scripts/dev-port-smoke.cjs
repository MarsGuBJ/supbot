const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const server = net.createServer();
server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
  const occupiedPort = server.address().port;
  const child = spawn(process.execPath, [path.join(__dirname, "dev-electron.cjs"), "--probe"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, SUPBOT_DEV_PORT: String(occupiedPort) },
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.once("exit", (code) => {
    server.close();
    if (code !== 0) process.exit(code || 1);
    const selected = Number(stdout.trim().match(/:(\d+)\/?$/)?.[1]);
    if (!selected || selected === occupiedPort) {
      console.error(`Expected an alternate port after occupying ${occupiedPort}, received: ${stdout.trim()}`);
      process.exit(1);
    }
    console.log(JSON.stringify({ occupiedPort, selectedPort: selected }));
  });
});
