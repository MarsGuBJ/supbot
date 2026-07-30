import type { ToolMarketProductType } from "@supbot/shared";

export type InstallSourceKind = "github" | "http-zip" | "local-zip" | "local-dir" | "local-file" | "markdown";

export interface ParsedInstallSource {
  kind: InstallSourceKind;
  url?: string;
  localPath?: string;
  github?: {
    owner: string;
    repo: string;
    ref?: string;
    archiveUrl: string;
  };
  markdown?: {
    text: string;
    suggestedName?: string;
  };
}

const githubRepoPattern = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^?\s#]+))?\/?$/i;
const githubArchivePattern = /^https?:\/\/(?:codeload\.)?github\.com\/([^/\s]+)\/([^/\s]+?)\/(?:zipball|tarball|tar\.gz)\/([^?\s#]+)\/?$/i;
const httpArchiveExtensionPattern = /^https?:\/\/\S+\.(zip|tar|tar\.gz|tgz)(?:\?[^\s]*)?$/i;

export function parseInstallSource(input: string): ParsedInstallSource {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Install source must not be empty.");
  }
  if (/^https?:\/\//i.test(trimmed)) {
    const githubRepoMatch = trimmed.match(githubRepoPattern);
    if (githubRepoMatch) {
      const owner = githubRepoMatch[1];
      const repo = githubRepoMatch[2].replace(/\.git$/i, "");
      const ref = githubRepoMatch[3]?.split("/")[0];
      const archiveUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref || "HEAD"}`;
      return { kind: "github", url: trimmed, github: { owner, repo, ref, archiveUrl } };
    }
    const githubArchiveMatch = trimmed.match(githubArchivePattern);
    if (githubArchiveMatch) {
      const owner = githubArchiveMatch[1];
      const repo = githubArchiveMatch[2].replace(/\.git$/i, "");
      const ref = githubArchiveMatch[3];
      return {
        kind: "github",
        url: trimmed,
        github: { owner, repo, ref, archiveUrl: trimmed }
      };
    }
    if (httpArchiveExtensionPattern.test(trimmed)) {
      return { kind: "http-zip", url: trimmed };
    }
    throw new Error(`Unrecognized remote install URL: ${trimmed}`);
  }
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed.startsWith("~")) {
    return { kind: "local-dir", localPath: trimmed };
  }
  if (trimmed.length > 280) {
    return { kind: "markdown", markdown: { text: trimmed } };
  }
  if (/^---\s*\n/.test(trimmed) || /^[\s\S]*?\n---\s*\n/.test(trimmed)) {
    return { kind: "markdown", markdown: { text: trimmed } };
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return { kind: "markdown", markdown: { text: trimmed } };
  }
  if (trimmed.includes("\n") && trimmed.length > 200) {
    return { kind: "markdown", markdown: { text: trimmed } };
  }
  throw new Error(`Unable to interpret install source: ${trimmed.slice(0, 80)}`);
}

const skillManifestNames = ["skill.md", "SKILL.md"];
const pluginManifestPaths = [".codex-plugin/plugin.json"];
const mcpManifestNames = ["supbot-mcp.json"];
const toolManifestNames = ["supbot-tool.json"];
const marketManifestNames = ["supbot-market-install.json"];

export interface ManifestHeuristics {
  detectedType: ToolMarketProductType | undefined;
  manifestPath: string | undefined;
  manifestText: string | undefined;
}

export function detectManifestKind(files: { path: string }[]): ManifestHeuristics {
  const normalized = files.map((file) => ({ raw: file.path, normalized: file.path.replace(/\\/g, "/").replace(/^\.\/+/, "") }));
  for (const candidate of marketManifestNames) {
    const hit = normalized.find((entry) => entry.normalized.toLowerCase() === candidate.toLowerCase());
    if (hit) {
      return { detectedType: undefined, manifestPath: hit.raw, manifestText: undefined };
    }
  }
  for (const candidate of skillManifestNames) {
    const hit = normalized.find((entry) => entry.normalized.toLowerCase() === candidate.toLowerCase());
    if (hit) {
      return { detectedType: "skill", manifestPath: hit.raw, manifestText: undefined };
    }
  }
  for (const candidate of pluginManifestPaths) {
    const hit = normalized.find((entry) => entry.normalized.toLowerCase() === candidate.toLowerCase());
    if (hit) {
      return { detectedType: "plugin", manifestPath: hit.raw, manifestText: undefined };
    }
  }
  for (const candidate of mcpManifestNames) {
    const hit = normalized.find((entry) => entry.normalized.toLowerCase() === candidate.toLowerCase());
    if (hit) {
      return { detectedType: "mcp", manifestPath: hit.raw, manifestText: undefined };
    }
  }
  for (const candidate of toolManifestNames) {
    const hit = normalized.find((entry) => entry.normalized.toLowerCase() === candidate.toLowerCase());
    if (hit) {
      return { detectedType: "tool", manifestPath: hit.raw, manifestText: undefined };
    }
  }
  return { detectedType: undefined, manifestPath: undefined, manifestText: undefined };
}

export function stripArchivePrefix<T extends { path: string }>(files: T[]): T[] {
  if (files.length === 0) return files;
  const firstSegments = new Set<string>();
  for (const file of files) {
    const forward = file.path.replace(/\\/g, "/").replace(/^\.\/+/, "");
    const top = forward.split("/", 2)[0];
    if (top) firstSegments.add(top);
  }
  if (firstSegments.size === 1) {
    const prefix = [...firstSegments][0];
    return files.map((file) => {
      const forward = file.path.replace(/\\/g, "/").replace(/^\.\/+/, "");
      if (forward.startsWith(`${prefix}/`)) {
        return { ...file, path: forward.slice(prefix.length + 1) };
      }
      return { ...file, path: forward };
    });
  }
  return files.map((file) => ({ ...file, path: file.path.replace(/\\/g, "/").replace(/^\.\/+/, "") }));
}