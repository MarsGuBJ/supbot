async function evaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const data = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP timeout")), 5000);
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id === 1) {
        clearTimeout(timer);
        resolve(msg);
      }
    });
    ws.send(JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression, returnByValue: true }
    }));
  });
  ws.close();
  if (data.exceptionDetails) {
    throw new Error(data.exceptionDetails.text || "Runtime evaluation failed");
  }
  return data.result.result.value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const pages = await fetch("http://127.0.0.1:9333/json/list").then((response) => response.json());
  const page = pages.find((item) => item.type === "page") || pages[0];
  if (!page) {
    throw new Error("No packaged Supbot page found on port 9333.");
  }
  const wsUrl = page.webSocketDebuggerUrl;
  const clickByText = (text, selector = ".ant-segmented-item-label, .ant-tabs-tab-btn, button") => evaluate(wsUrl, `(() => {
    const elements = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const target = elements.find((item) => (item.textContent || '').includes(${JSON.stringify(text)}));
    if (!target) return false;
    target.click();
    return true;
  })()`);

  await clickByText("对话", ".topbar .ant-segmented-item-label");
  await sleep(300);
  const initialBody = String(await evaluate(wsUrl, "document.body.innerText"));
  const leftPanel = String(await evaluate(wsUrl, "document.querySelector('.side-panel')?.innerText || ''"));
  const railToggleCount = Number(await evaluate(wsUrl, "document.querySelectorAll('.rail-toggle').length"));
  const topbarToggleCount = Number(await evaluate(wsUrl, `document.querySelectorAll('.topbar-actions button [aria-label="menu-fold"], .topbar-actions button [aria-label="menu-unfold"]').length`));

  if (!await clickByText("工具市场", ".topbar .ant-segmented-item-label")) {
    throw new Error("Tool market tab was not clickable.");
  }
  await sleep(3500);
  const market = await evaluate(wsUrl, `(() => {
    const body = document.body.innerText;
    return {
      hasMarketTitle: body.includes('工具市场'),
      hasLocalCatalog: body.includes('内置目录') || body.includes('本地目录') || body.includes('http://localhost:3000'),
      productCount: document.querySelectorAll('.market-product').length,
      hasInstallAction: [...document.querySelectorAll('.market-product-action')].some((item) => /安装|卸载/.test(item.textContent || '')),
      bodyStart: body.slice(0, 900)
    };
  })()`);

  if (!await clickByText("市场配置", "button")) {
    throw new Error("Market settings button was not clickable.");
  }
  await sleep(600);
  const config = await evaluate(wsUrl, `(() => {
    const body = document.body.innerText;
    const inputs = [...document.querySelectorAll('input')].map((input) => input.value);
    return {
      hasMarketSource: body.includes('工具市场来源'),
      hasTestApiUrl: inputs.some((value) => value.includes('localhost:3000')),
      hasTestAccount: inputs.includes('subscriber@example.com'),
      hasPasswordLabel: body.includes('市场密码'),
      bodyStart: body.slice(0, 900)
    };
  })()`);

  const result = {
    url: page.url,
    hasAppAsar: page.url.includes("app.asar"),
    hasOldOverview: initialBody.includes("Single user, in-process runtime"),
    hasOldStatsBlock: /Capabilities\s*\n4\s*\nSubagents\s*\n2/.test(initialBody),
    railToggleCount,
    topbarToggleCount,
    leftPanelStart: leftPanel.slice(0, 260),
    market,
    config
  };
  console.log(JSON.stringify(result, null, 2));
  if (
    !result.hasAppAsar ||
    result.hasOldOverview ||
    result.hasOldStatsBlock ||
    result.railToggleCount !== 0 ||
    result.topbarToggleCount < 2 ||
    !market.hasMarketTitle ||
    market.productCount < 5 ||
    !market.hasInstallAction ||
    !config.hasMarketSource ||
    !config.hasTestApiUrl ||
    !config.hasTestAccount ||
    !config.hasPasswordLabel
  ) {
    throw new Error("Packaged window did not load the expected tool market UI.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
