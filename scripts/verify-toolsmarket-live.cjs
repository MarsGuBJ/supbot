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
  const pages = await fetch("http://127.0.0.1:9333/json/list").then((response) => response.json());
  const page = pages.find((item) => item.type === "page") || pages[0];
  if (!page) {
    throw new Error("No Supbot page found on port 9333.");
  }
  const wsUrl = page.webSocketDebuggerUrl;
  const result = await evaluate(wsUrl, `new Promise(async (resolve) => {
    await window.supbot.updateToolMarketConfig({
      source: 'hybrid',
      apiUrl: 'http://localhost:3000',
      accountEmail: 'subscriber@example.com',
      password: 'market123'
    });
    const products = await window.supbot.listToolMarket({});
    const labels = [...document.querySelectorAll('.topbar .ant-segmented-item-label')];
    labels.find((item) => (item.textContent || '').includes('工具市场'))?.click();
    setTimeout(() => {
      const body = document.body.innerText;
      resolve({
        productCount: products.length,
        remoteCount: products.filter((item) => item.origin === 'remote').length,
        firstRemote: products.find((item) => item.origin === 'remote')?.name || '',
        bodyHasRemote: body.includes('Anthropic Plugin') || body.includes('平台官方店铺'),
        source: products.length
      });
    }, 1000);
  })`);
  console.log(JSON.stringify(result, null, 2));
  if (result.remoteCount < 1 || !result.firstRemote) {
    throw new Error("Remote ToolsMarket products were not listed.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
