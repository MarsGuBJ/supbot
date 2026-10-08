/**
 * 生产依赖审计门禁：npm audit --omit=dev 的例外放行封装。
 *
 * npm audit 本身不支持例外名单。这里对无上游修复、且经评估
 * 在本产品中不可达的 advisory 做显式放行；其余漏洞依然阻断发布。
 * 例外必须记录阻断原因与不可达依据，上游修复后立即移除。
 *
 * 当前例外（详见 docs/production-windows.md）：
 * - GHSA-86w9-cpqp-85rv（node-forge，2026-10-08 起放行）：
 *   上游未发布修复版本。漏洞在 RSA PKCS#1 v1.5 签名验证路径；
 *   唯一引入方 @anthropic-ai/sandbox-runtime 仅用 node-forge 生成
 *   MITM CA 密钥对与证书，不做第三方签名验证，且沙箱功能仅在
 *   Linux/macOS 启用，Windows 桌面发布不加载该模块。
 */
const { execSync } = require("node:child_process");

const ALLOWED_ADVISORY_URLS = new Set(["https://github.com/advisories/GHSA-86w9-cpqp-85rv"]);

let raw;
try {
  raw = execSync("npm audit --omit=dev --registry=https://registry.npmjs.org --json", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
} catch (error) {
  // npm audit 发现漏洞时以非零码退出，stdout 仍带 JSON 报告
  raw = error.stdout;
  if (!raw) {
    throw error;
  }
}

const report = JSON.parse(raw);
const blocked = [];
for (const [name, finding] of Object.entries(report.vulnerabilities ?? {})) {
  const advisories = finding.via.filter((item) => typeof item === "object" && item !== null);
  const unallowed = advisories.filter((advisory) => !ALLOWED_ADVISORY_URLS.has(advisory.url));
  if (unallowed.length > 0) {
    blocked.push({
      name,
      advisories: unallowed.map((advisory) => `${advisory.severity}: ${advisory.title} (${advisory.url})`),
    });
  }
}

if (blocked.length > 0) {
  console.error("Production audit blocked by unallowlisted vulnerabilities:");
  for (const entry of blocked) {
    console.error(`- ${entry.name}`);
    for (const line of entry.advisories) {
      console.error(`    ${line}`);
    }
  }
  process.exit(1);
}

console.log(
  `Production audit passed (${ALLOWED_ADVISORY_URLS.size} documented exception(s), see docs/production-windows.md).`,
);
