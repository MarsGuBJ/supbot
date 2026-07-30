import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ToolMarketCatalogItem } from "@supbot/shared";
import { PromptInstallProvider } from "../src/promptInstallProvider";
import { objectInput } from "../src/toolRegistry";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length) {
    await rm(tempDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function makeTemp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "supbot-prompt-install-"));
  tempDirs.push(dir);
  return dir;
}

function makeContext() {
  return { signal: new AbortController().signal, host: {} as never, subagents: [], runSubagent: async () => ({ text: "" }) };
}

describe("PromptInstallProvider", () => {
  test("registers install_skill / install_plugin / install_mcp", () => {
    const installResolution = vi.fn(async () => ({ id: "x", installed: true }) as unknown as ToolMarketCatalogItem);
    const provider = new PromptInstallProvider({ installResolution });
    const names = provider.list().map((tool) => tool.name).sort();
    expect(names).toEqual(["install_mcp", "install_plugin", "install_skill"]);
  });

  test("install_skill summarizes the source for the permission UI", () => {
    const provider = new PromptInstallProvider({ installResolution: async () => ({}) as ToolMarketCatalogItem });
    const tool = provider.list().find((entry) => entry.name === "install_skill")!;
    const summary = tool.summarize({ source: "https://github.com/anthropics/claude-code", product_id: "claude" });
    expect(summary).toContain("skill");
    expect(summary).toContain("github.com/anthropics/claude-code");
  });

  test("install_skill rejects empty source", async () => {
    const provider = new PromptInstallProvider({ installResolution: async () => ({}) as ToolMarketCatalogItem });
    const tool = provider.list().find((entry) => entry.name === "install_skill")!;
    await expect(tool.execute({ source: "  " }, makeContext())).rejects.toThrow(/non-empty/);
  });

  test("install_skill installs a front-matter markdown skill and returns confirmation", async () => {
    const installResolution = vi.fn(async (resolution) => ({
      id: resolution.product.id,
      name: resolution.product.name,
      installed: true
    } as unknown as ToolMarketCatalogItem));
    const provider = new PromptInstallProvider({ installResolution });
    const tool = provider.list().find((entry) => entry.name === "install_skill")!;
    const text = [
      "---",
      "name: Calendar Helper",
      "kind: skill",
      "---",
      "",
      "Help with scheduling."
    ].join("\n");
    const result = await tool.execute({ source: text }, makeContext());
    expect(installResolution).toHaveBeenCalledOnce();
    const resolution = installResolution.mock.calls[0][0];
    expect(resolution.product.type).toBe("skill");
    expect(resolution.product.name).toBe("Calendar Helper");
    expect(result.text).toContain("Installed as");
    expect(result.text).toContain("Calendar Helper");
  });

  test("install_plugin rejects when markdown manifest type does not match the requested kind", async () => {
    const installResolution = vi.fn();
    const provider = new PromptInstallProvider({ installResolution });
    const tool = provider.list().find((entry) => entry.name === "install_plugin")!;
    const text = "---\nname: My Skill\nkind: skill\n---\n\nBody.";
    await expect(tool.execute({ source: text }, makeContext())).rejects.toThrow(/skill but the agent requested plugin/);
    expect(installResolution).not.toHaveBeenCalled();
  });

  test("install_mcp installs from a local MCP manifest", async () => {
    const dir = await makeTemp();
    await writeFile(join(dir, "supbot-mcp.json"), JSON.stringify({
      name: "demo-mcp",
      command: "node",
      args: ["server.js"]
    }), "utf8");
    await writeFile(join(dir, "server.js"), "module.exports = {};", "utf8");
    const installResolution = vi.fn(async (resolution) => ({
      id: resolution.product.id,
      name: resolution.product.name,
      installed: true
    } as unknown as ToolMarketCatalogItem));
    const provider = new PromptInstallProvider({ installResolution });
    const tool = provider.list().find((entry) => entry.name === "install_mcp")!;
    const result = await tool.execute({ source: dir }, makeContext());
    expect(installResolution).toHaveBeenCalledOnce();
    const resolution = installResolution.mock.calls[0][0];
    expect(resolution.product.type).toBe("mcp");
    expect(resolution.deployment.mcpServer?.command).toBe("node");
    expect(result.text).toContain("Installed as");
  });

  test("agent tool input rejects extra fields via OpenAI schema", () => {
    const provider = new PromptInstallProvider({ installResolution: async () => ({}) as ToolMarketCatalogItem });
    const tool = provider.list().find((entry) => entry.name === "install_skill")!;
    const params = tool.parameters;
    expect(params.additionalProperties).toBe(false);
    expect(params.required).toEqual(["source"]);
  });

  test("objectInput helper handles malformed payloads", () => {
    expect(objectInput(null)).toEqual({});
    expect(objectInput("string")).toEqual({});
    expect(objectInput(["arr"])).toEqual({});
    expect(objectInput({ source: "ok" })).toEqual({ source: "ok" });
  });
});