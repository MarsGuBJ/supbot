async function evaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const data = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP timeout")), 15000);
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
      params: { expression, returnByValue: true, awaitPromise: true }
    }));
  });
  ws.close();
  if (data.exceptionDetails) {
    throw new Error(data.exceptionDetails.text || "Runtime evaluation failed");
  }
  return data.result.result.value;
}

async function main() {
  const email = process.env.TOOLSMARKET_EMAIL || process.env.TOOL_MARKET_EMAIL || "subscriber@toolsmarket.local";
  const password = process.env.TOOLSMARKET_PASSWORD || process.env.TOOL_MARKET_PASSWORD;
  if (!password) {
    throw new Error("Set TOOLSMARKET_PASSWORD to run the live ToolsMarket verification.");
  }
  const pages = await fetch("http://127.0.0.1:9333/json/list").then((response) => response.json());
  const page =
    pages.find((item) => item.type === "page" && item.title === "Supbot") ||
    pages.find((item) => item.type === "page" && item.url.includes("127.0.0.1:5173")) ||
    pages.find((item) => item.type === "page" && !item.url.startsWith("devtools://")) ||
    pages[0];
  if (!page) {
    throw new Error("No Supbot page found on port 9333.");
  }
  const wsUrl = page.webSocketDebuggerUrl;
  const config = { source: "hybrid", apiUrl: "https://i-shu.com", accountEmail: email, password };
  const result = await evaluate(wsUrl, `new Promise(async (resolve) => {
    try {
      await window.supbot.updateToolMarketConfig(${JSON.stringify(config)});
      const products = await window.supbot.listToolMarket({});
      const labels = [...document.querySelectorAll('.topbar .ant-segmented-item-label')];
      labels.find((item) => (item.textContent || '').includes('工具市场'))?.click();
      setTimeout(() => {
        resolve({
          ok: true,
          productCount: products.length,
          remoteCount: products.filter((item) => item.origin === 'remote').length,
          firstRemote: products.find((item) => item.origin === 'remote')?.name || ''
        });
      }, 1000);
    } catch (error) {
      resolve({ ok: false, message: error.message });
    }
  })`);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    throw new Error(result.message || "Remote ToolsMarket verification failed.");
  }
  if (result.remoteCount < 1 || !result.firstRemote) {
    throw new Error("Remote ToolsMarket products were not listed.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
