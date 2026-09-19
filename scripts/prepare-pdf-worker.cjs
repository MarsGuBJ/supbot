/**
 * 把 pdfjs-dist 的 fake worker 复制到桌面端 main bundle 旁边。
 *
 * pdfjs 在 Node 下通过 eval("require")(workerSrc) 加载 "./pdf.worker.js"，
 * 相对路径按调用模块解析；esbuild 打包后调用模块变成 dist/main/index.js，
 * 因此需要 dist/main/pdf.worker.js 存在（dev 与打包 asar 同理，
 * electron-builder 的 files 已包含 dist/**）。
 */
const { copyFileSync, mkdirSync } = require("node:fs");
const { createRequire } = require("node:module");
const { dirname, join } = require("node:path");

const desktopRequire = createRequire(join(__dirname, "../apps/desktop/package.json"));
const source = desktopRequire.resolve("pdfjs-dist/legacy/build/pdf.worker.js");
const target = join(__dirname, "../apps/desktop/dist/main/pdf.worker.js");

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.log(`[prepare-pdf-worker] copied ${source} -> ${target}`);
