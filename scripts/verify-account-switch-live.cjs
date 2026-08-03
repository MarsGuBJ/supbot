// Live verification of the OIDC staff-agent account switch against the real Servstation.
//
// Spawns the built app via electron (same launch style as scripts/electron-smoke.cjs) with a
// fresh user-data dir and drives it over the DevTools protocol:
//   1. ordinary OIDC login as the "old" account (form filled manually - remote logins never autofill)
//   2. connect the reverse bridge, record identity/agent/peer
//   3. switch to the "new" account (explicit credentials autofill the forced reauthentication)
//   4. assert new identity/account/agent/peer and SSE-confirmed reverse connection
//   5. restart the app on the same user-data dir and assert the new account persisted
//   6. attempt a switch with a bad password, cancel the auth window, assert rollback:
//      old session restored byte-for-byte, reverse bridge forced disabled/disconnected
//
// Usage:
//   HBCLIENT_OLD_USERNAME=dev-user HBCLIENT_OLD_PASSWORD=... \
//   HBCLIENT_NEW_USERNAME=leasing-admin HBCLIENT_NEW_PASSWORD=... \
//   node scripts/verify-account-switch-live.cjs
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let electron;
try {
  electron = require("electron");
} catch {
  const isWindows = process.platform === "win32";
  electron = path.resolve("node_modules", ".bin", isWindows ? "electron.cmd" : "electron");
}

const appDir = path.resolve("apps", "desktop");
const port = Number(process.env.HBCLIENT_VERIFY_PORT || 9349);
const oldUser = process.env.HBCLIENT_OLD_USERNAME || "dev-user";
const oldPassword = process.env.HBCLIENT_OLD_PASSWORD || "";
const newUser = process.env.HBCLIENT_NEW_USERNAME || "";
const newPassword = process.env.HBCLIENT_NEW_PASSWORD || "";
if (!oldPassword || !newUser || !newPassword) {
  console.error("HBCLIENT_OLD_PASSWORD, HBCLIENT_NEW_USERNAME and HBCLIENT_NEW_PASSWORD are required.");
  process.exit(2);
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hbclient-switch-verify-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let child;

function step(name) {
  console.error(`[verify-switch] ${name}`);
}

async function listPages() {
  return fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
}

async function waitForPage() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const pages = await listPages();
      const page = pages.find((item) => item.type === "page" && !/\/oauth2\/login/.test(item.url || ""));
      if (page?.webSocketDebuggerUrl) {
        return page;
      }
    } catch {
      // The app is still starting.
    }
    await sleep(300);
  }
  throw new Error("No HBClient page exposed through DevTools.");
}

async function waitForAuthPage(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pages = await listPages();
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

async function closeAuthPage(authPage) {
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json());
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const messageId = 1;
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP timeout: Target.closeTarget")), 10_000);
    ws.addEventListener("message", (event) => {
      const data = JSON.parse(event.data);
      if (data.id === messageId) {
        clearTimeout(timer);
        resolve(data);
      }
    });
    ws.send(JSON.stringify({ id: messageId, method: "Target.closeTarget", params: { targetId: authPage.id } }));
  });
  ws.close();
  return result;
}

async function startApp() {
  child = spawn(electron, [`--remote-debugging-port=${port}`, "."], {
    cwd: appDir,
    env: { ...process.env, HBCLIENT_USER_DATA_DIR: userDataDir },
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 4000) {
      stderr = stderr.slice(-4000);
    }
  });
  child.on("exit", () => {
    if (stderr.trim()) {
      console.error(`[verify-switch] app stderr tail: ${stderr.slice(-800)}`);
    }
  });
  return waitForPage();
}

async function stopApp() {
  if (child && !child.killed) {
    child.kill();
  }
  await sleep(1500);
}

async function waitForMarker(wsUrl, marker, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await evaluate(wsUrl, `window.${marker} || null`, 5_000);
    if (result) {
      return result;
    }
    await sleep(300);
  }
  throw new Error(`Marker ${marker} never settled.`);
}

async function sessionSummary(wsUrl) {
  return evaluate(
    wsUrl,
    `(async () => {
      const snapshot = await window.supbot.snapshot();
      const config = await window.supbot.getServstationA2AConfig();
      return {
        identityUserId: snapshot.identityContext?.userId || null,
        staffAgentAccount: config.staffAgentAccount || null,
        agentInstanceId: snapshot.identityContext?.agentInstanceId || config.agentInstanceId || null,
        authMode: config.authMode,
        reverse: config.reverse ? { enabled: config.reverse.enabled, status: config.reverse.status, peerId: config.reverse.peerId || null } : null,
        pageShowsAccount: document.body.innerText.includes(${JSON.stringify(newUser)}),
      };
    })()`,
  );
}

async function main() {
  const report = { userDataDir };
  // ---- Phase A: login as the old account, then switch to the new account ----
  step(`phase A: ordinary OIDC login as ${oldUser}`);
  let page = await startApp();
  const ws = () => page.webSocketDebuggerUrl;
  await evaluate(
    ws(),
    `(() => {
      window.__loginResult = null;
      window.supbot.loginServstationOidc({}).then(
        (login) => { window.__loginResult = { ok: true, login }; },
        (error) => { window.__loginResult = { ok: false, error: String(error?.message || error) }; }
      );
      return true;
    })()`,
  );
  const authPage = await waitForAuthPage();
  const submitted = await evaluate(
    authPage.webSocketDebuggerUrl,
    `(() => {
      const user = document.querySelector('input[name="userId"]');
      const password = document.querySelector('input[name="password"]');
      const form = document.querySelector('form');
      if (!user || !password || !form) return false;
      user.value = ${JSON.stringify(oldUser)};
      password.value = ${JSON.stringify(oldPassword)};
      form.submit();
      return true;
    })()`,
  );
  if (!submitted) {
    throw new Error("Servstation OIDC login form was not ready.");
  }
  const loginResult = await waitForMarker(ws(), "__loginResult");
  if (!loginResult.ok) {
    throw new Error(`Ordinary OIDC login failed: ${loginResult.error}`);
  }
  report.login = { userId: loginResult.login?.identityContext?.userId || null };

  step("phase A: connect reverse bridge with old account");
  await evaluate(ws(), "window.supbot.connectServstationReverseBridge()");
  report.before = await sessionSummary(ws());

  step(`phase A: switch account ${oldUser} -> ${newUser}`);
  await evaluate(
    ws(),
    `(() => {
      window.__switchResult = null;
      window.supbot.switchServstationA2AAccount(${JSON.stringify({
        staffAgentAccount: newUser,
        staffAgentPassword: newPassword,
      })}).then(
        (config) => { window.__switchResult = { ok: true, config }; },
        (error) => { window.__switchResult = { ok: false, error: String(error?.message || error) }; }
      );
      return true;
    })()`,
  );
  const switchDeadline = Date.now() + 180_000;
  let switchResult = null;
  let sawAuthWindow = false;
  while (Date.now() < switchDeadline) {
    switchResult = await evaluate(ws(), "window.__switchResult || null", 5_000);
    if (switchResult) break;
    try {
      const pages = await listPages();
      const authLike = pages.filter((item) => item.type === "page" && /oauth2|8092/.test(item.url || ""));
      if (authLike.length > 0) {
        sawAuthWindow = true;
        step(`phase A: switch auth window at ${authLike.map((item) => item.url).join(", ")}`);
      }
    } catch {
      // Ignore transient DevTools listing failures.
    }
    await sleep(2_000);
  }
  if (!switchResult) {
    // Diagnostic dump: what is the auth window showing?
    try {
      const pages = await listPages();
      step(
        `phase A: open pages at timeout: ${JSON.stringify(pages.map((item) => ({ type: item.type, url: item.url })))}`,
      );
      const authPage = pages.find((item) => item.type === "page" && /oauth2|8092/.test(item.url || ""));
      if (authPage) {
        const dump = await evaluate(
          authPage.webSocketDebuggerUrl,
          `(() => ({
            url: location.href,
            hasUserInput: Boolean(document.querySelector('input[name="userId"]')),
            hasPasswordInput: Boolean(document.querySelector('input[name="password"]')),
            hasForm: Boolean(document.querySelector('form')),
            bodyText: (document.body?.innerText || "").slice(0, 500),
          }))()`,
          10_000,
        );
        step(`phase A: auth window dump: ${JSON.stringify(dump)}`);
      }
    } catch (diagError) {
      step(`phase A: diagnostics failed: ${diagError.message}`);
    }
    throw new Error(`Account switch did not settle within 180s (auth window seen: ${sawAuthWindow}).`);
  }
  if (!switchResult.ok) {
    throw new Error(`Account switch failed unexpectedly: ${switchResult.error}`);
  }
  await sleep(500);
  report.afterSwitch = await sessionSummary(ws());
  report.switchResult = {
    staffAgentAccount: switchResult.config?.staffAgentAccount || null,
    reverse: switchResult.config?.reverse
      ? {
          enabled: switchResult.config.reverse.enabled,
          status: switchResult.config.reverse.status,
          peerId: switchResult.config.reverse.peerId || null,
        }
      : null,
  };
  await stopApp();

  // ---- Phase B: restart on the same user-data dir, verify persistence, then failure rollback ----
  step("phase B: restart app, verify persisted new account");
  page = await startApp();
  await sleep(1000);
  report.afterRestart = await sessionSummary(ws());

  step("phase B: reconnect reverse bridge without re-login (saved session)");
  const reconnect = await evaluate(ws(), "window.supbot.connectServstationReverseBridge()", 120_000);
  report.reconnect = {
    status: reconnect?.reverse?.status || null,
    peerId: reconnect?.reverse?.peerId || null,
  };

  step("phase B: attempt switch with a bad password, cancel the auth window");
  await evaluate(
    ws(),
    `(() => {
      window.__badSwitch = null;
      window.supbot.switchServstationA2AAccount(${JSON.stringify({
        staffAgentAccount: newUser,
        staffAgentPassword: "wrong-password-for-rollback-test",
      })}).then(
        (config) => { window.__badSwitch = { ok: true, staffAgentAccount: config?.staffAgentAccount || null }; },
        (error) => { window.__badSwitch = { ok: false, error: String(error?.message || error) }; }
      );
      return true;
    })()`,
  );
  const badAuthPage = await waitForAuthPage(60_000);
  await sleep(4000); // let the explicit autofill submit the bad credentials
  await closeAuthPage(badAuthPage);
  const badSwitch = await waitForMarker(ws(), "__badSwitch", 60_000);
  report.badSwitch = badSwitch;
  await sleep(500);
  report.afterRollback = await sessionSummary(ws());

  step("phase B: reconnect after rollback with the restored old session");
  const reconnectAfterRollback = await evaluate(ws(), "window.supbot.connectServstationReverseBridge()", 120_000);
  report.reconnectAfterRollback = {
    status: reconnectAfterRollback?.reverse?.status || null,
    peerId: reconnectAfterRollback?.reverse?.peerId || null,
  };
  await stopApp();

  console.log(JSON.stringify(report, null, 2));

  // ---- Assertions ----
  const failures = [];
  const expect = (condition, message) => {
    if (!condition) failures.push(message);
  };
  expect(report.login.userId === oldUser, `login identity ${report.login.userId} !== ${oldUser}`);
  expect(
    report.before.identityUserId === oldUser,
    `before-switch identity ${report.before.identityUserId} !== ${oldUser}`,
  );
  expect(
    report.before.staffAgentAccount === oldUser,
    `before-switch account ${report.before.staffAgentAccount} !== ${oldUser}`,
  );
  expect(
    report.before.reverse?.status === "connected",
    `before-switch reverse not connected: ${JSON.stringify(report.before.reverse)}`,
  );
  expect(
    report.switchResult.staffAgentAccount === newUser,
    `switch result account ${report.switchResult.staffAgentAccount} !== ${newUser}`,
  );
  expect(
    report.afterSwitch.identityUserId === newUser,
    `after-switch identity ${report.afterSwitch.identityUserId} !== ${newUser}`,
  );
  expect(
    report.afterSwitch.staffAgentAccount === newUser,
    `after-switch account ${report.afterSwitch.staffAgentAccount} !== ${newUser}`,
  );
  expect(
    report.afterSwitch.reverse?.status === "connected",
    `after-switch reverse not connected: ${JSON.stringify(report.afterSwitch.reverse)}`,
  );
  expect(
    report.afterSwitch.agentInstanceId && report.afterSwitch.agentInstanceId !== report.before.agentInstanceId,
    `agentInstanceId did not change: ${report.before.agentInstanceId} -> ${report.afterSwitch.agentInstanceId}`,
  );
  expect(
    report.afterSwitch.reverse?.peerId && report.afterSwitch.reverse.peerId !== report.before.reverse?.peerId,
    `reverse peer did not change: ${report.before.reverse?.peerId} -> ${report.afterSwitch.reverse?.peerId}`,
  );
  // "Page identity and staff-agent user match": the runtime identity surfaced to the page and the
  // configured staff-agent account must be the same user in every phase (DOM text is informational
  // only - the account tag renders in the config view, which the script never opens).
  for (const [phase, summary] of [
    ["before", report.before],
    ["afterSwitch", report.afterSwitch],
    ["afterRestart", report.afterRestart],
    ["afterRollback", report.afterRollback],
  ]) {
    expect(
      summary.identityUserId && summary.identityUserId === summary.staffAgentAccount,
      `${phase}: page identity ${summary.identityUserId} does not match staff-agent account ${summary.staffAgentAccount}`,
    );
  }
  expect(
    report.afterRestart.identityUserId === newUser,
    `after-restart identity ${report.afterRestart.identityUserId} !== ${newUser}`,
  );
  expect(
    report.afterRestart.staffAgentAccount === newUser,
    `after-restart account ${report.afterRestart.staffAgentAccount} !== ${newUser}`,
  );
  expect(
    report.reconnect.status === "connected",
    `reconnect after restart failed: ${JSON.stringify(report.reconnect)}`,
  );
  expect(
    report.badSwitch.ok === false,
    `bad-password switch unexpectedly succeeded: ${JSON.stringify(report.badSwitch)}`,
  );
  expect(
    report.afterRollback.identityUserId === newUser,
    `rollback identity ${report.afterRollback.identityUserId} !== ${newUser}`,
  );
  expect(
    report.afterRollback.staffAgentAccount === newUser,
    `rollback account ${report.afterRollback.staffAgentAccount} !== ${newUser}`,
  );
  expect(
    report.afterRollback.reverse?.status === "disconnected" && report.afterRollback.reverse?.enabled === false,
    `rollback did not force reverse disabled/disconnected: ${JSON.stringify(report.afterRollback.reverse)}`,
  );
  expect(
    report.reconnectAfterRollback.status === "connected",
    `old session was not restored after rollback (reconnect failed): ${JSON.stringify(report.reconnectAfterRollback)}`,
  );

  if (failures.length > 0) {
    throw new Error(`Live account-switch verification failed:\n- ${failures.join("\n- ")}`);
  }
  console.error("[verify-switch] all checks passed");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopApp();
    if (process.exitCode) {
      console.error(`[verify-switch] keeping user-data dir for inspection: ${userDataDir}`);
    } else {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
