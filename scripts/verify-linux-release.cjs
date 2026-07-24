#!/usr/bin/env node

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const desktopPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, "apps", "desktop", "package.json"), "utf8"));
const releaseDir = path.resolve(
  process.env.HBCLIENT_LINUX_RELEASE_DIR || path.join(repoRoot, "apps", "desktop", "release"),
);
const manifestPath = path.join(releaseDir, "latest-linux.yml");

if (!fs.existsSync(manifestPath)) {
  fail(`Linux update manifest not found: ${manifestPath}`);
}

const manifest = fs.readFileSync(manifestPath, "utf8");
const version = requiredMatch(manifest, /^version:\s*([^\r\n]+)$/m, "version");
const artifactName = requiredMatch(manifest, /^\s*-\s+url:\s*([^\r\n]+\.AppImage)\s*$/m, "AppImage URL");
const sha512 = requiredMatch(manifest, /^\s+sha512:\s*([^\r\n]+)$/m, "sha512");
const size = Number(requiredMatch(manifest, /^\s+size:\s*(\d+)\s*$/m, "size"));
const blockMapSize = Number(requiredMatch(manifest, /^\s+blockMapSize:\s*(\d+)\s*$/m, "blockMapSize"));
const artifactPath = path.join(releaseDir, artifactName);

if (version !== desktopPackage.version) {
  fail(`Manifest version ${version} does not match desktop package version ${desktopPackage.version}.`);
}
if (!/^HBClient-\d+\.\d+\.\d+-linux-(?:x86_64|x64)\.AppImage$/.test(artifactName)) {
  fail(`Unexpected Linux artifact name: ${artifactName}`);
}
if (!fs.existsSync(artifactPath)) {
  fail(`Linux AppImage not found: ${artifactPath}`);
}

const artifact = fs.readFileSync(artifactPath);
const actualSha512 = createHash("sha512").update(artifact).digest("base64");
if (actualSha512 !== sha512) {
  fail("AppImage SHA-512 does not match latest-linux.yml.");
}
if (artifact.length !== size) {
  fail(`AppImage size ${artifact.length} does not match manifest size ${size}.`);
}
if (!Number.isSafeInteger(blockMapSize) || blockMapSize <= 0 || blockMapSize >= artifact.length) {
  fail(`Invalid embedded block map size: ${blockMapSize}.`);
}
if (!artifact.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
  fail("AppImage does not start with an ELF header.");
}

console.log(
  JSON.stringify(
    {
      version,
      artifact: artifactPath,
      size,
      blockMapSize,
      manifest: manifestPath,
      sha512,
    },
    null,
    2,
  ),
);

function requiredMatch(input, pattern, label) {
  const match = pattern.exec(input);
  if (!match) {
    fail(`Linux update manifest is missing ${label}.`);
  }
  return match[1].trim();
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
