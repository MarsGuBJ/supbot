import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseInstallSource, detectManifestKind, stripArchivePrefix } from "../src/installSource";
import {
  InstallSafetyError,
  normalizeInstallRelativePath,
  resolveInstallLimits,
  sha256Buffer,
  validateAndAuditInstallFiles
} from "../src/installSafety";
import { resolveInstallSource } from "../src/installResolver";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length) {
    await rm(tempDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function makeTemp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "supbot-install-test-"));
  tempDirs.push(dir);
  return dir;
}

async function runTar(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`tar exited with ${code}: ${stderr}`)));
  });
}

describe("parseInstallSource", () => {
  test("recognizes GitHub repo URLs and derives an archive URL", () => {
    const parsed = parseInstallSource("https://github.com/anthropics/claude-code");
    expect(parsed.kind).toBe("github");
    expect(parsed.github?.owner).toBe("anthropics");
    expect(parsed.github?.repo).toBe("claude-code");
    expect(parsed.github?.archiveUrl).toContain("codeload.github.com");
  });

  test("recognizes GitHub repo URLs with a ref", () => {
    const parsed = parseInstallSource("https://github.com/anthropics/claude-code/tree/main");
    expect(parsed.kind).toBe("github");
    expect(parsed.github?.ref).toBe("main");
  });

  test("recognizes codeload GitHub tarball URLs", () => {
    const parsed = parseInstallSource("https://codeload.github.com/anthropics/claude-code/tar.gz/refs/tags/v1.0.0");
    expect(parsed.kind).toBe("github");
    expect(parsed.github?.ref).toBe("refs/tags/v1.0.0");
  });

  test("recognizes generic HTTPS zip URLs", () => {
    const parsed = parseInstallSource("https://example.com/tools/foo.zip");
    expect(parsed.kind).toBe("http-zip");
  });

  test("treats Windows paths as local-dir", () => {
    const parsed = parseInstallSource("C:\\tools\\my-skill");
    expect(parsed.kind).toBe("local-dir");
    expect(parsed.localPath).toBe("C:\\tools\\my-skill");
  });

  test("treats long pasted markdown as markdown source", () => {
    const long = "---\nname: Demo\n---\n\nThis is a long prompt body used as a markdown skill source. ".repeat(5);
    const parsed = parseInstallSource(long);
    expect(parsed.kind).toBe("markdown");
  });
});

describe("detectManifestKind + stripArchivePrefix", () => {
  test("detects SKILL.md", () => {
    expect(detectManifestKind([{ path: "SKILL.md" }, { path: "other.txt" }]).detectedType).toBe("skill");
  });

  test("detects plugin manifest", () => {
    expect(detectManifestKind([{ path: ".codex-plugin/plugin.json" }]).detectedType).toBe("plugin");
  });

  test("detects MCP manifest", () => {
    expect(detectManifestKind([{ path: "supbot-mcp.json" }]).detectedType).toBe("mcp");
  });

  test("strips a single top-level prefix from archive files", () => {
    const stripped = stripArchivePrefix([{ path: "repo-main/SKILL.md" }, { path: "repo-main/README.md" }]);
    expect(stripped.map((file) => file.path)).toEqual(["SKILL.md", "README.md"]);
  });

  test("does not strip when there is no common prefix", () => {
    const stripped = stripArchivePrefix([{ path: "a/SKILL.md" }, { path: "b/README.md" }]);
    expect(stripped.map((file) => file.path)).toEqual(["a/SKILL.md", "b/README.md"]);
  });
});

describe("installSafety", () => {
  test("normalizes install paths and rejects traversal", () => {
    expect(normalizeInstallRelativePath("a/b/c.txt")).toBe("a/b/c.txt");
    expect(normalizeInstallRelativePath("./a/b.txt")).toBe("a/b.txt");
    expect(() => normalizeInstallRelativePath("../escape.txt")).toThrow(InstallSafetyError);
    expect(() => normalizeInstallRelativePath("a/../../escape.txt")).toThrow(InstallSafetyError);
    expect(() => normalizeInstallRelativePath("C:\\evil\\path")).toThrow(InstallSafetyError);
    expect(() => normalizeInstallRelativePath("/etc/passwd")).toThrow(InstallSafetyError);
    expect(() => normalizeInstallRelativePath("\\\\server\\share\\file.txt")).toThrow(InstallSafetyError);
  });

  test("rejects duplicate install paths", () => {
    expect(() => validateAndAuditInstallFiles(".", [
      { path: "SKILL.md", content: "a" },
      { path: "skill.md", content: "b" }
    ])).toThrow(/Duplicate install path/);
  });

  test("respects file size cap", () => {
    const limits = resolveInstallLimits({ maxFileBytes: 4, maxExtractedBytes: 4 });
    expect(() => validateAndAuditInstallFiles(".", [{ path: "x.txt", content: "toolong" }], limits)).toThrow(InstallSafetyError);
  });

  test("emits a sha256 for each file", () => {
    const result = validateAndAuditInstallFiles(".", [
      { path: "a.txt", content: "alpha" },
      { path: "b.txt", content: "beta" }
    ]);
    expect(result.report.files.map((file) => file.sha256)).toEqual([
      sha256Buffer(Buffer.from("alpha")),
      sha256Buffer(Buffer.from("beta"))
    ]);
  });
});

describe("resolveInstallSource (markdown)", () => {
  test("parses a front-matter skill markdown", async () => {
    const text = [
      "---",
      "name: Quick Note",
      "kind: skill",
      "tags: [notes, productivity]",
      "---",
      "",
      "# Quick Note",
      "",
      "Capture a quick note inline."
    ].join("\n");
    const result = await resolveInstallSource(text);
    expect(result.product.type).toBe("skill");
    expect(result.product.name).toBe("Quick Note");
    expect(result.deployment.files[0].path).toBe("SKILL.md");
  });

  test("parses a JSON manifest", async () => {
    const text = JSON.stringify({
      id: "calendar-helper",
      name: "Calendar Helper",
      kind: "plugin",
      description: "Plan meetings.",
      tags: ["calendar"],
      files: [{ path: "README.md", content: "# Calendar Helper" }]
    });
    const result = await resolveInstallSource(text);
    expect(result.product.type).toBe("plugin");
    expect(result.deployment.files).toHaveLength(1);
  });
});

describe("resolveInstallSource (local directory)", () => {
  test("installs from a local directory containing SKILL.md", async () => {
    const dir = await makeTemp();
    await writeFile(join(dir, "SKILL.md"), "# Local Skill\n\nBody", "utf8");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "index.js"), "module.exports = {};", "utf8");

    const result = await resolveInstallSource(dir);
    expect(result.source.kind).toBe("local-dir");
    expect(result.product.type).toBe("skill");
    const paths = result.deployment.files!.map((file) => file.path).sort();
    expect(paths).toContain("SKILL.md");
    expect(paths).toContain("src/index.js");
  });
});

describe("resolveInstallSource (remote archive)", () => {
  test("downloads the GitHub archive and preserves text and binary file contents", async () => {
    const dir = await makeTemp();
    const archiveRoot = join(dir, "archive-root");
    const repoRoot = join(archiveRoot, "demo-main");
    await mkdir(repoRoot, { recursive: true });
    await writeFile(join(repoRoot, "SKILL.md"), "# Downloaded Skill\n\nRemote body", "utf8");
    const binary = Buffer.from([0, 255, 1, 254, 2, 253]);
    await writeFile(join(repoRoot, "asset.bin"), binary);
    const archivePath = join(dir, "demo.tar.gz");
    await runTar(["-czf", archivePath, "-C", archiveRoot, "demo-main"]);
    const archive = await readFile(archivePath);
    const requestedUrls: string[] = [];

    const result = await resolveInstallSource("https://github.com/acme/demo", {
      fetchImpl: async (input) => {
        requestedUrls.push(String(input));
        return new Response(archive, {
          status: 200,
          headers: { "content-length": String(archive.byteLength) }
        });
      }
    });

    expect(requestedUrls).toEqual(["https://codeload.github.com/acme/demo/tar.gz/HEAD"]);
    expect(result.product.type).toBe("skill");
    expect(result.deployment.files?.find((file) => file.path === "SKILL.md")?.content).toContain("Downloaded Skill");
    const binaryFile = result.deployment.files?.find((file) => file.path === "asset.bin");
    expect(binaryFile?.encoding).toBe("base64");
    expect(Buffer.from(binaryFile?.content || "", "base64")).toEqual(binary);
    expect(result.archiveSha256).toBe(sha256Buffer(archive));
  });
});
