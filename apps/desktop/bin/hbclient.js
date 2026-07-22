#!/usr/bin/env node
const { spawn } = require("node:child_process");
const path = require("node:path");

let electron;
try {
  electron = require("electron");
} catch {
  electron = path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "node_modules",
    ".bin",
    process.platform === "win32" ? "electron.cmd" : "electron",
  );
}
const appRoot = path.resolve(__dirname, "..");
const child = spawn(electron, [appRoot], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
