#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const desktopBuildDir = path.join(repoRoot, "apps", "desktop", "build");
const targetRoot = path.join(desktopBuildDir, "default-data");
const sourceDataDir = resolveSourceDataDir();
const sourceSkillsDir = path.join(sourceDataDir, "skills");

if (!isDirectory(sourceSkillsDir)) {
  fail(`Installed skills directory not found: ${sourceSkillsDir}`);
}

const skillNames = fs
  .readdirSync(sourceSkillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(sourceSkillsDir, entry.name, "SKILL.md")))
  .map((entry) => entry.name)
  .sort((a, b) => a.localeCompare(b));

if (!skillNames.length) {
  fail(`No installed skills with SKILL.md found in ${sourceSkillsDir}`);
}

if (!isInside(desktopBuildDir, targetRoot)) {
  fail(`Refusing to clean target outside desktop build directory: ${targetRoot}`);
}

fs.rmSync(targetRoot, { recursive: true, force: true });
fs.mkdirSync(targetRoot, { recursive: true });
fs.cpSync(sourceSkillsDir, path.join(targetRoot, "skills"), { recursive: true, force: true });

const receiptCount = copyMarketReceipts(skillNames);
const manifest = {
  version: 1,
  createdAt: new Date().toISOString(),
  sourceDataDir,
  skillCount: skillNames.length,
  receiptCount,
  skills: skillNames,
};
fs.writeFileSync(path.join(targetRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`Bundled ${skillNames.length} skills and ${receiptCount} tool-market receipts into ${targetRoot}`);

function resolveSourceDataDir() {
  const candidates = [
    process.env.HBCLIENT_BUNDLED_DATA_DIR,
    process.env.SUPBOT_BUNDLED_DATA_DIR,
    process.env.APPDATA ? path.join(process.env.APPDATA, "HBClient", "data") : undefined,
    process.env.APPDATA ? path.join(process.env.APPDATA, "hbclient", "data") : undefined,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (isDirectory(path.join(candidate, "skills"))) {
      return path.resolve(candidate);
    }
  }
  fail(`Unable to find an installed HBClient data directory. Checked: ${candidates.join(", ")}`);
}

function copyMarketReceipts(skillNames) {
  const sourceMarketRoot = path.join(sourceDataDir, "tool-market");
  if (!isDirectory(sourceMarketRoot)) {
    return 0;
  }
  const targetMarketRoot = path.join(targetRoot, "tool-market");
  const skillNameSet = new Set(skillNames);
  let count = 0;
  const copiedSkillNames = new Set();
  for (const originEntry of fs.readdirSync(sourceMarketRoot, { withFileTypes: true })) {
    if (!originEntry.isDirectory()) {
      continue;
    }
    const originPath = path.join(sourceMarketRoot, originEntry.name);
    for (const productEntry of fs.readdirSync(originPath, { withFileTypes: true })) {
      if (!productEntry.isDirectory()) {
        continue;
      }
      const productPath = path.join(originPath, productEntry.name);
      const receiptPath = path.join(productPath, "supbot-market-install.json");
      const manifest = readJson(receiptPath);
      const productId = manifest?.product?.id;
      const localPath = typeof manifest?.localPath === "string" ? manifest.localPath : undefined;
      const localDirName = localPath ? path.basename(localPath) : undefined;
      if (skillNameSet.has(productEntry.name) || skillNameSet.has(productId) || skillNameSet.has(localDirName)) {
        fs.cpSync(productPath, path.join(targetMarketRoot, originEntry.name, productEntry.name), {
          recursive: true,
          force: true,
        });
        count += 1;
        copiedSkillNames.add(productEntry.name);
        if (productId) {
          copiedSkillNames.add(productId);
        }
        if (localDirName) {
          copiedSkillNames.add(localDirName);
        }
      }
    }
  }

  for (const skillName of skillNames) {
    if (copiedSkillNames.has(skillName)) {
      continue;
    }
    const localManifest = readJson(path.join(sourceSkillsDir, skillName, "supbot-local-tool.json"));
    if (localManifest) {
      fs.mkdirSync(path.join(targetMarketRoot, "bundled", skillName), { recursive: true });
      fs.writeFileSync(
        path.join(targetMarketRoot, "bundled", skillName, "supbot-market-install.json"),
        `${JSON.stringify(localManifest, null, 2)}\n`,
        "utf8",
      );
      count += 1;
    }
  }
  return count;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function isDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
