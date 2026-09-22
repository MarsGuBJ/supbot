#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const desktopBuildDir = path.join(repoRoot, "apps", "desktop", "build");
const targetRoot = path.join(desktopBuildDir, "default-data");
// Plugins that must never ship inside the installer.
const excludedPluginNames = new Set(["anthropic-agent-skills"]);
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

const pluginNames = copyMarketPlugins();
const receiptCount = copyMarketReceipts(skillNames, pluginNames);
const manifest = {
  version: 2,
  createdAt: new Date().toISOString(),
  skillCount: skillNames.length,
  receiptCount,
  skills: skillNames,
  plugins: pluginNames.map((pluginName) => describeBundledPlugin(pluginName)),
};
fs.writeFileSync(path.join(targetRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(
  `Bundled ${skillNames.length} skills, ${pluginNames.length} plugins and ${receiptCount} tool-market receipts into ${targetRoot}`,
);

function resolveSourceDataDir() {
  const candidates = [
    process.env.HBCLIENT_BUNDLED_DATA_DIR,
    process.env.SUPBOT_BUNDLED_DATA_DIR,
    process.env.APPDATA ? path.join(process.env.APPDATA, "HyBot", "data") : undefined,
    process.env.APPDATA ? path.join(process.env.APPDATA, "HBClient", "data") : undefined,
    process.env.APPDATA ? path.join(process.env.APPDATA, "hbclient", "data") : undefined,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (isDirectory(path.join(candidate, "skills"))) {
      return path.resolve(candidate);
    }
  }
  fail(`Unable to find an installed HyBot data directory. Checked: ${candidates.join(", ")}`);
}

function copyMarketPlugins() {
  const sourcePluginsDir = path.join(sourceDataDir, "plugins");
  if (!isDirectory(sourcePluginsDir)) {
    return [];
  }
  const pluginNames = fs
    .readdirSync(sourcePluginsDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !excludedPluginNames.has(entry.name) &&
        fs.existsSync(path.join(sourcePluginsDir, entry.name, "supbot-local-tool.json")),
    )
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  for (const pluginName of pluginNames) {
    const target = path.join(targetRoot, "plugins", pluginName);
    fs.cpSync(path.join(sourcePluginsDir, pluginName), target, { recursive: true, force: true });
    // supbot-local-package.json holds machine-specific absolute skill paths;
    // the runtime rewrites it on first launch when missing.
    fs.rmSync(path.join(target, "supbot-local-package.json"), { force: true });
    stripLocalPath(path.join(target, "supbot-local-tool.json"));
  }
  return pluginNames;
}

function describeBundledPlugin(pluginName) {
  const pluginDir = path.join(targetRoot, "plugins", pluginName);
  const skillsDir = path.join(pluginDir, "skills");
  const skills = isDirectory(skillsDir)
    ? fs
        .readdirSync(skillsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(skillsDir, entry.name, "SKILL.md")))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b))
    : [];
  return {
    id: pluginName,
    capabilityId: readJson(path.join(pluginDir, "supbot-local-tool.json"))?.deployment?.capability?.id,
    skills,
  };
}

// A shipped plugin receipt must not carry the bundling machine's absolute
// localPath: reconcile uses it to locate member skills, and a stale path
// would silently break member expansion on user machines. Without localPath
// the runtime falls back to <dataDir>/plugins/<install-slug>.
function stripLocalPath(filePath) {
  const manifest = readJson(filePath);
  if (!manifest) {
    return;
  }
  delete manifest.localPath;
  fs.writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function copyMarketReceipts(skillNames, pluginNames = []) {
  const sourceMarketRoot = path.join(sourceDataDir, "tool-market");
  if (!isDirectory(sourceMarketRoot)) {
    return 0;
  }
  const targetMarketRoot = path.join(targetRoot, "tool-market");
  const skillNameSet = new Set(skillNames);
  const pluginNameSet = new Set(pluginNames);
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
      const isBundledPlugin = manifest?.localKind === "plugin" && pluginNameSet.has(productEntry.name);
      if (
        skillNameSet.has(productEntry.name) ||
        skillNameSet.has(productId) ||
        skillNameSet.has(localDirName) ||
        isBundledPlugin
      ) {
        const target = path.join(targetMarketRoot, originEntry.name, productEntry.name);
        fs.cpSync(productPath, target, {
          recursive: true,
          force: true,
        });
        if (isBundledPlugin) {
          stripLocalPath(path.join(target, "supbot-market-install.json"));
        }
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
