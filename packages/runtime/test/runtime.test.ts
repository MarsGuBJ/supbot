import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { JsonFileStorage, MemoryManager, OpenAIChatCompletionsAdapter, normalizeChatCompletionsUrl, resolveMentionedSubagent, SupbotRuntime, ToolExecutor, ToolRegistry, TranscriptStore } from "../src";
import { normalizeMarketApiUrl } from "../src/toolMarket";
import { defaultModelConfig } from "@supbot/shared";

const tempDirs: string[] = [];

async function createRuntime() {
  const rootDir = await createGitRoot();
  const dir = await mkdtemp(join(tmpdir(), "supbot-test-"));
  tempDirs.push(dir);
  const runtime = new SupbotRuntime(new JsonFileStorage(dir), { rootDir });
  await runtime.init();
  return runtime;
}

async function createRuntimeWithPaths() {
  const rootDir = await createGitRoot();
  const dir = await mkdtemp(join(tmpdir(), "supbot-test-"));
  tempDirs.push(dir);
  const runtime = new SupbotRuntime(new JsonFileStorage(dir), { rootDir });
  await runtime.init();
  return { runtime, dataDir: dir, rootDir };
}

async function createRuntimeWithoutBaseline() {
  const rootDir = await mkdtemp(join(tmpdir(), "supbot-root-"));
  tempDirs.push(rootDir);
  await runGit(rootDir, ["init"]);
  const dir = await mkdtemp(join(tmpdir(), "supbot-test-"));
  tempDirs.push(dir);
  const runtime = new SupbotRuntime(new JsonFileStorage(dir), { rootDir });
  await runtime.init();
  return runtime;
}

async function createGitRoot(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "supbot-root-"));
  tempDirs.push(rootDir);
  await runGit(rootDir, ["init"]);
  await runGit(rootDir, ["config", "user.email", "supbot@example.test"]);
  await runGit(rootDir, ["config", "user.name", "Supbot Test"]);
  await writeFile(join(rootDir, "README.md"), "baseline\n", "utf8");
  await runGit(rootDir, ["add", "README.md"]);
  await runGit(rootDir, ["commit", "-m", "baseline"]);
  return rootDir;
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `git ${args.join(" ")} failed`)));
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function waitForJob(runtime: SupbotRuntime, jobId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const job = runtime.snapshot().jobs.find((item) => item.id === jobId);
    if (job && ["completed", "failed", "canceled"].includes(job.status)) {
      await waitForCondition(`job ${jobId} cleanup`, () => runtime.snapshot().status === "ready");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for job ${jobId}.`);
}

async function waitForAutopilotRun(runtime: SupbotRuntime, runId: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const run = runtime.snapshot().autopilotRuns.find((item) => item.id === runId);
    if (run && ["completed", "failed", "blocked", "paused", "canceled"].includes(run.status)) {
      await waitForCondition(`autopilot ${runId} cleanup`, () => runtime.snapshot().status === "ready");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for autopilot run ${runId}.`);
}

async function waitForCondition(label: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function fakeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.`;
}

async function withMockModel(
  runtime: SupbotRuntime,
  handler: (body: string, call: number) => unknown
): Promise<{ close(): Promise<void>; calls(): number }> {
  let calls = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      calls += 1;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(handler(body, calls)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  await runtime.updateModelConfig({
    providerName: "Mock",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "mock-model",
    temperature: 0.1,
    maxTokens: 1000,
    apiKey: "test-key"
  });
  return {
    calls: () => calls,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

type MockMcpMode =
  | "ok"
  | "init-error"
  | "list-error"
  | "call-error"
  | "hang-call"
  | "exit-on-call"
  | "complex-schema"
  | "invalid-schema"
  | "rich-result"
  | "notifications";

async function writeMockMcpServer(mode: MockMcpMode = "ok"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "supbot-mcp-"));
  tempDirs.push(dir);
  const filePath = join(dir, "mock-mcp.cjs");
  await writeFile(filePath, `
const mode = ${JSON.stringify(mode)};
let buffer = Buffer.alloc(0);
process.stderr.write("mock mcp stderr ready\\n");
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\\s*(\\d+)/i);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
    buffer = buffer.subarray(bodyStart + length);
    handle(JSON.parse(body));
  }
});
function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n", "utf8"), body]));
}
function handle(request) {
  if (!request.id) return;
  if (request.method === "initialize") {
    if (mode === "init-error") {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Initialize boom", data: { stage: "initialize" } } });
      return;
    }
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock-mcp", version: "1.0.0" } } });
    if (mode === "notifications") {
      send({ jsonrpc: "2.0", method: "notifications/progress", params: { message: "warming up" } });
      send({ jsonrpc: "2.0", id: 99999, result: { ignored: true } });
    }
    return;
  }
  if (request.method === "tools/list") {
    if (mode === "list-error") {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32001, message: "Tools list boom", data: { stage: "tools/list" } } });
      return;
    }
    if (mode === "complex-schema") {
      send({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "complex", description: "Validate nested payload.", inputSchema: { type: "object", properties: { config: { type: "object", properties: { mode: { type: "string", enum: ["fast", "safe"] }, labels: { type: "array", items: { type: "string" } } }, required: ["mode"], additionalProperties: false }, target: { oneOf: [{ type: "string" }, { type: "number" }] } }, required: ["config", "target"], additionalProperties: false } }] } });
      return;
    }
    if (mode === "invalid-schema") {
      send({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "broken", description: "Broken schema.", inputSchema: { type: "object", properties: { value: { type: "bogus" } }, required: ["missing"], oneOf: { bad: true }, additionalProperties: false } }] } });
      return;
    }
    if (mode === "rich-result") {
      send({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "rich", description: "Return rich content.", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false } }] } });
      return;
    }
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "echo", description: "Echo a message.", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false } }] } });
    return;
  }
  if (request.method === "tools/call") {
    if (mode === "call-error") {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32002, message: "Call boom", data: { reason: "bad-call", retryable: false } } });
      return;
    }
    if (mode === "hang-call") {
      return;
    }
    if (mode === "exit-on-call") {
      process.exit(7);
    }
    if (mode === "complex-schema") {
      send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "complex:" + request.params.arguments.config.mode + ":" + request.params.arguments.target }] } });
      return;
    }
    if (mode === "rich-result") {
      send({ jsonrpc: "2.0", id: request.id, result: { isError: false, content: [
        { type: "text", text: "rich:" + request.params.arguments.message },
        { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
        { type: "resource", resource: { uri: "file:///tmp/mock.txt", mimeType: "text/plain", text: "resource text" } },
        { type: "custom", value: 123 }
      ] } });
      return;
    }
    send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "echo:" + request.params.arguments.message }] } });
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown method" } });
}
`, "utf8");
  return filePath;
}

describe("model client helpers", () => {
  test("normalizes OpenAI-compatible chat completion URLs", () => {
    expect(normalizeChatCompletionsUrl("https://api.example.com")).toBe("https://api.example.com/v1/chat/completions");
    expect(normalizeChatCompletionsUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1/chat/completions");
    expect(normalizeChatCompletionsUrl("https://api.example.com/v1/chat/completions")).toBe("https://api.example.com/v1/chat/completions");
  });

  test("parses streaming chat completion deltas and tool call fragments", async () => {
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        expect(JSON.parse(body).stream).toBe(true);
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache"
        });
        const writeEvent = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);
        writeEvent({ choices: [{ delta: { content: "Hel" } }] });
        writeEvent({ choices: [{ delta: { content: "lo" } }] });
        writeEvent({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "Read", arguments: "{\"path\"" }
              }]
            }
          }]
        });
        writeEvent({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                function: { name: "File", arguments: ":\"a.txt\"}" }
              }]
            }
          }]
        });
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      const adapter = new OpenAIChatCompletionsAdapter();
      const deltas: string[] = [];
      let doneText = "";
      let doneTool = "";
      for await (const event of adapter.stream({
        modelConfig: { ...defaultModelConfig, baseUrl: `http://127.0.0.1:${address.port}/v1` },
        apiKey: "test-key",
        messages: [{ role: "user", content: "stream" }]
      })) {
        if (event.type === "message_delta") {
          deltas.push(event.delta);
        }
        if (event.type === "done") {
          doneText = event.result.text;
          doneTool = event.result.toolCalls[0].function.name;
          expect(event.result.toolCalls[0].function.arguments).toBe("{\"path\":\"a.txt\"}");
        }
      }
      expect(deltas).toEqual(["Hel", "lo"]);
      expect(doneText).toBe("Hello");
      expect(doneTool).toBe("ReadFile");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe("SupbotRuntime", () => {
  test("saves model config while redacting the API key", async () => {
    const runtime = await createRuntime();
    const saved = await runtime.updateModelConfig({
      providerName: "Local gateway",
      baseUrl: "http://127.0.0.1:8000/v1",
      model: "test-model",
      temperature: 0.4,
      maxTokens: 2048,
      apiKey: "secret-token"
    });

    expect(saved.apiKeySaved).toBe(true);
    expect(JSON.stringify(saved)).not.toContain("secret-token");
    expect(runtime.snapshot().modelConfig.apiKeySaved).toBe(true);
  });

  test("creates a conversation and runs a fallback local job", async () => {
    const runtime = await createRuntime();
    const result = await runtime.sendPrompt({ prompt: "hello local agent" });
    expect(result.conversation.messages).toHaveLength(1);
    expect(result.job.status).toBe("queued");

    await new Promise((resolve) => setTimeout(resolve, 100));
    const snapshot = runtime.snapshot();
    const conversation = snapshot.conversations.find((item) => item.id === result.conversation.id);
    expect(conversation?.messages.some((message) => message.role === "assistant")).toBe(true);
    const assistant = conversation?.messages.find((message) => message.role === "assistant");
    expect(assistant?.text).toContain("本地回退模式");
    expect(assistant?.text).toContain("Local fallback");
    expect(snapshot.jobs.find((job) => job.id === result.job.id)?.status).toBe("completed");
    expect(snapshot.memory).toMatchObject({ pages: [], facts: [], chunks: [], links: [], candidates: [] });
  });

  test("recalls active memory into the model context by keyword and scope", async () => {
    const runtime = await createRuntime();
    const conversation = await runtime.createConversation("Memory recall");
    await runtime.addMemory({
      type: "fact",
      scope: "conversation",
      conversationId: conversation.id,
      title: "Project codename",
      content: "The Supbot memory MVP project codename is Lantern.",
      kind: "fact",
      keywords: ["lantern", "memory"]
    });
    await runtime.addMemory({
      type: "fact",
      scope: "subagent",
      subagentName: "research",
      title: "Research-only detail",
      content: "Research-only memory should not appear in main agent recall.",
      kind: "fact",
      keywords: ["lantern", "research-only"]
    });
    const mock = await withMockModel(runtime, (body) => {
      const parsed = JSON.parse(body);
      const system = parsed.messages.find((message: { role: string }) => message.role === "system")?.content || "";
      expect(system).toContain("<memory>");
      expect(system).toContain("Lantern");
      expect(system).not.toContain("Research-only memory");
      return { choices: [{ message: { content: "Memory used." } }] };
    });
    try {
      const result = await runtime.sendPrompt({ conversationId: conversation.id, prompt: "What is the Lantern memory codename?" });
      await waitForJob(runtime, result.job.id);
      expect(runtime.snapshot().runtimeEvents.some((event) => event.kind === "memory_recall")).toBe(true);
      const recalled = runtime.snapshot().memory.facts.find((fact) => fact.title === "Project codename");
      expect(recalled?.accessCount).toBeGreaterThan(0);
      expect(mock.calls()).toBe(1);
    } finally {
      await mock.close();
    }
  });

  test("disabled and deleted memory items are not recalled", async () => {
    const runtime = await createRuntime();
    const conversation = await runtime.createConversation("Memory lifecycle");
    const disabled = await runtime.addMemory({
      type: "fact",
      scope: "conversation",
      conversationId: conversation.id,
      title: "Disabled memory",
      content: "The hidden keyword is Moonstone.",
      keywords: ["moonstone"]
    });
    const deleted = await runtime.addMemory({
      type: "fact",
      scope: "conversation",
      conversationId: conversation.id,
      title: "Deleted memory",
      content: "The deleted keyword is Sunstone.",
      keywords: ["sunstone"]
    });
    await runtime.updateMemory(disabled.id, { status: "disabled" });
    await runtime.deleteMemory(deleted.id);
    const mock = await withMockModel(runtime, (body) => {
      const parsed = JSON.parse(body);
      const system = parsed.messages.find((message: { role: string }) => message.role === "system")?.content || "";
      expect(system).not.toContain("Moonstone");
      expect(system).not.toContain("Sunstone");
      return { choices: [{ message: { content: "No recalled memory." } }] };
    });
    try {
      const result = await runtime.sendPrompt({ conversationId: conversation.id, prompt: "Moonstone Sunstone" });
      await waitForJob(runtime, result.job.id);
      expect(runtime.snapshot().runtimeEvents.some((event) => event.kind === "memory_recall")).toBe(false);
    } finally {
      await mock.close();
    }
  });

  test("searches memory with keyword, scope, and disabled filters", async () => {
    const runtime = await createRuntime();
    const conversation = await runtime.createConversation("Search memory");
    const active = await runtime.addMemory({
      type: "page",
      scope: "conversation",
      conversationId: conversation.id,
      title: "Keyword page",
      content: "This page contains the durable keyword Amberline.",
      keywords: ["amberline"]
    });
    const disabled = await runtime.addMemory({
      type: "fact",
      scope: "conversation",
      conversationId: conversation.id,
      title: "Disabled keyword",
      content: "Disabled Amberline item.",
      keywords: ["amberline"]
    });
    await runtime.updateMemory(disabled.id, { status: "disabled" });

    const activeOnly = await runtime.searchMemory({ query: "Amberline", conversationId: conversation.id });
    expect(activeOnly.map((item) => item.id)).toContain(active.id);
    expect(activeOnly.map((item) => item.id)).not.toContain(disabled.id);

    const all = await runtime.listMemory({ query: "Amberline", conversationId: conversation.id, includeDisabled: true });
    expect(all.map((item) => item.id)).toEqual(expect.arrayContaining([active.id, disabled.id]));
    expect(all.find((item) => item.id === active.id)?.matchedKeywords).toContain("amberline");
    expect(all.find((item) => item.id === active.id)?.reason).toContain("amberline");
    expect(all.find((item) => item.id === active.id)?.sourceLabel).toBe("Manual memory");
  });

  test("trims recalled memory to the budget while keeping higher-scored items", async () => {
    const manager = new MemoryManager({ randomId: (prefix) => `${prefix}_${Math.random().toString(36).slice(2)}`, nowIso: () => "2026-06-21T00:00:00.000Z" });
    let memory = {
      pages: [],
      facts: [],
      chunks: [],
      links: [],
      candidates: [],
      recallHistory: [],
      recallFeedback: []
    };
    memory = manager.add(memory, {
      type: "fact",
      scope: "global",
      title: "High priority Codename",
      content: "Codename Quasar is the durable high priority memory.",
      keywords: ["codename", "quasar", "priority"]
    }).memory;
    memory = manager.add(memory, {
      type: "fact",
      scope: "global",
      title: "Long lower priority Codename",
      content: `Codename filler ${"low value ".repeat(120)}`,
      keywords: ["codename"]
    }).memory;

    const recall = manager.recall(memory, { query: "quasar codename priority", scope: "all", limit: 5, budgetChars: 360 });
    expect(recall.usedChars).toBeLessThanOrEqual(360);
    expect(recall.results[0]?.title).toBe("High priority Codename");
    expect(recall.block).toContain("Quasar");
  });

  test("approves similar candidates by merging into existing memory", async () => {
    const runtime = await createRuntime();
    const conversation = await runtime.createConversation("Merge memory");
    const existing = await runtime.addMemory({
      type: "fact",
      scope: "conversation",
      conversationId: conversation.id,
      title: "Release branch",
      content: "The release branch for the memory project is v3-memory-mvp.",
      keywords: ["release", "branch", "memory"]
    });

    const result = await runtime.sendPrompt({ conversationId: conversation.id, prompt: "Remember that the release branch for memory also requires candidate merge review." });
    await waitForJob(runtime, result.job.id);
    const boundary = await runtime.compactConversation(conversation.id);
    const candidate = runtime.snapshot().memory.candidates.find((item) => item.source === `compact:${boundary.id}`);
    expect(candidate?.status).toBe("pending");

    const approved = await runtime.approveMemoryCandidate(candidate!.id);
    expect(approved.id).toBe(existing.id);
    expect(runtime.snapshot().memory.facts).toHaveLength(1);
    expect(runtime.snapshot().memory.facts[0].content).toContain("candidate merge review");
  });

  test("exports, imports, backs up, and restores local memory", async () => {
    const runtime = await createRuntime();
    const memory = await runtime.addMemory({
      type: "fact",
      scope: "global",
      title: "Export marker",
      content: "Memory export marker is Citrine.",
      keywords: ["citrine"]
    });
    const transfer = await runtime.exportMemory();
    expect(transfer.version).toBe(1);
    expect(transfer.memory.facts.some((item) => item.id === memory.id)).toBe(true);

    const backup = await runtime.backupMemory();
    expect(backup.path).toContain("memory-backups");

    await runtime.deleteMemory(memory.id);
    expect((await runtime.searchMemory({ query: "Citrine" })).length).toBe(0);

    const imported = await runtime.importMemory({ data: transfer, mode: "merge" });
    expect(imported.imported.facts).toBeGreaterThan(0);
    expect((await runtime.searchMemory({ query: "Citrine" })).length).toBe(1);

    await runtime.deleteMemory(memory.id);
    await runtime.restoreMemory(backup.path);
    expect((await runtime.searchMemory({ query: "Citrine" })).length).toBe(1);
  });

  test("replays memory recall without calling the model and reports excluded budget items", async () => {
    const runtime = await createRuntime();
    await runtime.addMemory({
      type: "fact",
      scope: "global",
      title: "Replay high marker",
      content: "Replay keyword Zircon should fit into the memory replay preview.",
      keywords: ["zircon", "replay"]
    });
    await runtime.addMemory({
      type: "fact",
      scope: "global",
      title: "Replay overflow marker",
      content: `Replay keyword overflow ${"long text ".repeat(120)}`,
      keywords: ["replay"]
    });

    const replay = await runtime.replayMemoryRecall({ query: "Zircon replay", scope: "all", limit: 10, budgetChars: 360 });
    expect(replay.results[0]?.title).toBe("Replay high marker");
    expect(replay.excludedResults.length).toBeGreaterThanOrEqual(1);
    expect(replay.blockPreview).toContain("<memory>");
  });

  test("recall feedback changes future replay scoring and survives export/import", async () => {
    const runtime = await createRuntime();
    const stale = await runtime.addMemory({
      type: "fact",
      scope: "global",
      title: "Atlas old answer",
      content: "Atlas answer is stale and should move down after feedback.",
      keywords: ["atlas", "answer"]
    });
    const useful = await runtime.addMemory({
      type: "fact",
      scope: "global",
      title: "Atlas useful answer",
      content: "Atlas answer is useful and should move up after feedback.",
      keywords: ["atlas", "answer"]
    });

    await runtime.addMemoryRecallFeedback({ memoryId: stale.id, kind: "wrong", query: "Atlas answer" });
    await runtime.addMemoryRecallFeedback({ memoryId: useful.id, kind: "useful", query: "Atlas answer" });
    const replay = await runtime.replayMemoryRecall({ query: "Atlas answer", scope: "all", limit: 5 });
    expect(replay.results[0]?.id).toBe(useful.id);
    expect(replay.results.find((item) => item.id === stale.id)?.feedback).toBe("wrong");

    const transfer = await runtime.exportMemory();
    expect(transfer.memory.recallFeedback.length).toBe(2);
    await runtime.importMemory({ data: transfer, mode: "replace" });
    expect(runtime.snapshot().memory.recallFeedback.length).toBe(2);
  });

  test("disabled or deleted memory is not replayed even with positive feedback", async () => {
    const runtime = await createRuntime();
    const disabled = await runtime.addMemory({
      type: "fact",
      scope: "global",
      title: "Hidden useful replay",
      content: "Hidden keyword Onyx should not replay when disabled.",
      keywords: ["onyx"]
    });
    const deleted = await runtime.addMemory({
      type: "fact",
      scope: "global",
      title: "Deleted useful replay",
      content: "Deleted keyword Garnet should not replay when deleted.",
      keywords: ["garnet"]
    });
    await runtime.addMemoryRecallFeedback({ memoryId: disabled.id, kind: "useful", query: "Onyx Garnet" });
    await runtime.addMemoryRecallFeedback({ memoryId: deleted.id, kind: "useful", query: "Onyx Garnet" });
    await runtime.updateMemory(disabled.id, { status: "disabled" });
    await runtime.deleteMemory(deleted.id);

    const replay = await runtime.replayMemoryRecall({ query: "Onyx Garnet", scope: "all", limit: 5 });
    expect(replay.results.map((item) => item.id)).not.toContain(disabled.id);
    expect(replay.results.map((item) => item.id)).not.toContain(deleted.id);
  });

  test("subagent replay scope does not leak into main agent recall", async () => {
    const runtime = await createRuntime();
    const conversation = await runtime.createConversation("Replay scope");
    await runtime.addMemory({
      type: "fact",
      scope: "subagent",
      subagentName: "research",
      title: "Research replay secret",
      content: "Research replay secret keyword is Heliodor.",
      keywords: ["heliodor"]
    });

    const main = await runtime.replayMemoryRecall({ query: "Heliodor", scope: "all", conversationId: conversation.id, limit: 5 });
    expect(main.results.map((item) => item.title)).not.toContain("Research replay secret");
    const subagent = await runtime.replayMemoryRecall({ query: "Heliodor", scope: "subagent", subagentName: "research", limit: 5 });
    expect(subagent.results.map((item) => item.title)).toContain("Research replay secret");
  });

  test("resolves mentioned subagents", async () => {
    const runtime = await createRuntime();
    const snapshot = runtime.snapshot();
    expect(resolveMentionedSubagent("@research check this", snapshot.subagents)?.name).toBe("research");
    expect(resolveMentionedSubagent("@missing check this", snapshot.subagents)).toBeUndefined();
  });

  test("installs and uninstalls local tool market products as local deployment packages", async () => {
    const runtime = await createRuntime();
    const dataDir = tempDirs[tempDirs.length - 1];
    const initial = (await runtime.listToolMarket({ query: "Shell" })).find((item) => item.id === "shell-runner");
    expect(initial?.installed).toBe(false);

    const installed = await runtime.installToolMarketProduct("shell-runner");
    expect(installed.installed).toBe(true);
    expect(runtime.snapshot().capabilities.some((item) => item.id === installed.capabilityId)).toBe(true);
    const localToolDir = join(dataDir, "tools", "shell-runner");
    const localManifestPath = join(localToolDir, "supbot-local-tool.json");
    const receiptPath = join(dataDir, "tool-market", "local", "shell-runner", "supbot-market-install.json");
    const manifest = JSON.parse(await readFile(localManifestPath, "utf8")) as { product: { id: string }; deployment: { kind: string }; localPath: string };
    expect(manifest.product.id).toBe("shell-runner");
    expect(manifest.deployment.kind).toBe("tool");
    expect(manifest.localPath).toBe(localToolDir);
    expect(JSON.parse(await readFile(join(localToolDir, "supbot-tool.json"), "utf8"))).toMatchObject({ id: "shell-runner", kind: "tool" });
    expect(JSON.parse(await readFile(receiptPath, "utf8"))).toMatchObject({ product: { id: "shell-runner" }, localPath: localToolDir });

    const uninstalled = await runtime.uninstallToolMarketProduct("shell-runner");
    expect(uninstalled.installed).toBe(false);
    expect(runtime.snapshot().capabilities.some((item) => item.id === uninstalled.capabilityId)).toBe(false);
    await expect(readFile(localManifestPath, "utf8")).rejects.toThrow();
    await expect(readFile(receiptPath, "utf8")).rejects.toThrow();
  });

  test("edits and deletes capabilities", async () => {
    const runtime = await createRuntime();
    const updated = await runtime.updateCapability("tool.scheduler", {
      name: "Local timers",
      description: "Updated scheduler description.",
      enabled: false
    });
    expect(updated).toMatchObject({
      id: "tool.scheduler",
      kind: "scheduler",
      name: "Local timers",
      description: "Updated scheduler description.",
      enabled: false
    });
    expect(runtime.snapshot().capabilities.find((item) => item.id === "tool.scheduler")).toMatchObject(updated);

    const installed = await runtime.installToolMarketProduct("shell-runner");
    expect(runtime.snapshot().capabilities.some((item) => item.id === installed.capabilityId)).toBe(true);

    await runtime.deleteCapability(installed.capabilityId);
    expect(runtime.snapshot().capabilities.some((item) => item.id === installed.capabilityId)).toBe(false);

    await runtime.installToolMarketProduct("shell-runner");
    expect(runtime.snapshot().capabilities.some((item) => item.id === installed.capabilityId)).toBe(true);
  });

  test("deleted default capabilities stay deleted after restart", async () => {
    const rootDir = await createGitRoot();
    const dir = await mkdtemp(join(tmpdir(), "supbot-test-"));
    tempDirs.push(dir);
    const runtime = new SupbotRuntime(new JsonFileStorage(dir), { rootDir });
    await runtime.init();
    await runtime.deleteCapability("tool.scheduler");
    expect(runtime.snapshot().capabilities.some((item) => item.id === "tool.scheduler")).toBe(false);

    const restarted = new SupbotRuntime(new JsonFileStorage(dir), { rootDir });
    await restarted.init();
    expect(restarted.snapshot().capabilities.some((item) => item.id === "tool.scheduler")).toBe(false);
  });

  test("installs market skills and plugins into native local folders", async () => {
    const runtime = await createRuntime();
    const dataDir = tempDirs[tempDirs.length - 1];

    const skill = await runtime.installToolMarketProduct("document-skills");
    expect(skill.installed).toBe(true);
    const skillDir = join(dataDir, "skills", "document-skills");
    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toContain("Document Skills");
    expect(JSON.parse(await readFile(join(skillDir, "supbot-local-tool.json"), "utf8"))).toMatchObject({
      product: { id: "document-skills" },
      deployment: { kind: "skill" },
      localPath: skillDir
    });

    const plugin = await runtime.installToolMarketProduct("planner-subagent-kit");
    expect(plugin.installed).toBe(true);
    const pluginDir = join(dataDir, "plugins", "planner-subagent-kit");
    expect(JSON.parse(await readFile(join(pluginDir, ".codex-plugin", "plugin.json"), "utf8"))).toMatchObject({
      id: "planner-subagent-kit",
      name: "Planner Subagent Kit"
    });
    expect(await readFile(join(pluginDir, "README.md"), "utf8")).toContain("Planner Subagent Kit");

    await runtime.uninstallToolMarketProduct("document-skills");
    await runtime.uninstallToolMarketProduct("planner-subagent-kit");
    await expect(readFile(join(skillDir, "SKILL.md"), "utf8")).rejects.toThrow();
    await expect(readFile(join(pluginDir, ".codex-plugin", "plugin.json"), "utf8")).rejects.toThrow();
  });

  test("saves remote tool market config while redacting the access token", async () => {
    const runtime = await createRuntime();
    const saved = await runtime.updateToolMarketConfig({
      source: "hybrid",
      apiUrl: "https://i-shu.com",
      accountEmail: "subscriber@example.com",
      accessToken: "market-secret",
      password: "market123"
    });

    expect(saved.accessTokenSaved).toBe(true);
    expect(saved.passwordSaved).toBe(true);
    expect(JSON.stringify(saved)).not.toContain("market-secret");
    expect(JSON.stringify(saved)).not.toContain("market123");
    expect(runtime.snapshot().toolMarketConfig.accessTokenSaved).toBe(true);
  });

  test("normalizes the production tool market origin to the catalog API", () => {
    expect(normalizeMarketApiUrl("https://i-shu.com")).toBe("https://i-shu.com/subscriber/market/api");
  });

  test("migrates old local-only market state with a remote API to hybrid source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supbot-test-"));
    tempDirs.push(dir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "state.json"), JSON.stringify({
      agentName: "Supbot Local Agent",
      modelConfig: {},
      toolMarketConfig: {
        source: "local",
        apiUrl: "http://localhost:3000/subscriber/market/api",
        accountEmail: "subscriber@example.com"
      },
      personality: {},
      capabilities: [],
      subagents: [],
      conversations: [],
      jobs: [],
      scheduledJobs: []
    }), "utf8");

    const runtime = new SupbotRuntime(new JsonFileStorage(dir));
    await runtime.init();
    expect(runtime.snapshot().toolMarketConfig.source).toBe("hybrid");
  });

  test("falls back to local tool market products when hybrid remote sync fails", async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 401;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ error: { message: "missing subscriber session" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const runtime = await createRuntime();
      const events: string[] = [];
      runtime.onEvent((event) => {
        if (event.type === "error") {
          events.push(event.message);
        }
      });
      const address = server.address() as AddressInfo;
      await runtime.updateToolMarketConfig({
        source: "hybrid",
        apiUrl: `http://127.0.0.1:${address.port}`,
        accountEmail: "subscriber@example.com",
        clearPassword: true
      });

      const products = await runtime.listToolMarket({});
      expect(products.some((item) => item.origin === "local")).toBe(true);
      expect(products.some((item) => item.origin === "remote")).toBe(false);
      expect(events).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  test("reports remote tool market login failures with a clear message", async () => {
    const server = createServer((request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.searchParams.get("action") === "login") {
        response.statusCode = 401;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ error: { message: "email or password is incorrect" } }));
        return;
      }
      response.statusCode = 500;
      response.end("unexpected catalog request");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const runtime = await createRuntime();
      const address = server.address() as AddressInfo;
      await runtime.updateToolMarketConfig({
        source: "remote",
        apiUrl: `http://127.0.0.1:${address.port}`,
        accountEmail: "subscriber@example.com",
        password: "wrong-password"
      });

      await expect(runtime.listToolMarket({})).rejects.toThrow("Tool market login failed: email or password is incorrect");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  test("lists and installs remote tool market products as local deployment packages", async () => {
    let loggedIn = false;
    const server = createServer((request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.searchParams.get("action") === "login") {
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          expect(JSON.parse(body)).toEqual({ email: "subscriber@example.com", password: "market123" });
          loggedIn = true;
          response.setHeader("Set-Cookie", "toolsmarket_session=session-1; Path=/; HttpOnly");
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ authenticated: true }));
        });
        return;
      }
      expect(request.headers.cookie).toContain("toolsmarket_session=session-1");
      if (url.searchParams.has("type")) {
        expect(url.searchParams.get("type")).toBe("mcp");
      }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        items: [{
          id: "calendar-mcp",
          name: "Calendar MCP",
          type: "mcp",
          provider_name: "ToolsMarket",
          description: "Calendar automation from a remote market.",
          billing_mode: "free",
          source_health: "healthy",
          local_deployment: {
            kind: "mcp",
            files: [{
              path: "calendar-mcp.cjs",
              content: "process.stdin.resume();\n"
            }],
            mcp_server: {
              id: "calendar-mcp",
              name: "Calendar MCP",
              command: "node",
              args: ["{installDir}\\calendar-mcp.cjs"],
              enabled: true,
              autoConnect: false
            }
          }
        }]
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const runtime = await createRuntime();
      const address = server.address() as AddressInfo;
      await runtime.updateToolMarketConfig({
        source: "remote",
        apiUrl: `http://127.0.0.1:${address.port}`,
        accountEmail: "subscriber@example.com",
        password: "market123"
      });

      const products = await runtime.listToolMarket({ type: "mcp" });
      expect(loggedIn).toBe(true);
      expect(products).toHaveLength(1);
      expect(products[0]).toMatchObject({ id: "calendar-mcp", origin: "remote", installed: false });

      const installed = await runtime.installToolMarketProduct("calendar-mcp");
      expect(installed.installed).toBe(true);
      expect(runtime.snapshot().capabilities.some((item) => item.id === installed.capabilityId)).toBe(true);
      const dataDir = tempDirs[tempDirs.length - 1];
      const rootDir = tempDirs[tempDirs.length - 2];
      const installPath = join(dataDir, "mcp", "calendar-mcp");
      const receiptPath = join(dataDir, "tool-market", "remote", "calendar-mcp");
      expect(await readFile(join(installPath, "calendar-mcp.cjs"), "utf8")).toBe("process.stdin.resume();\n");
      expect(JSON.parse(await readFile(join(installPath, "supbot-local-tool.json"), "utf8"))).toMatchObject({
        product: { id: "calendar-mcp", origin: "remote" },
        deployment: { kind: "mcp", mcpServer: { id: "calendar-mcp" } },
        localPath: installPath
      });
      expect(JSON.parse(await readFile(join(receiptPath, "supbot-market-install.json"), "utf8"))).toMatchObject({
        product: { id: "calendar-mcp", origin: "remote" },
        deployment: { kind: "mcp", mcpServer: { id: "calendar-mcp" } },
        localPath: installPath
      });
      expect(runtime.snapshot().mcpServers.find((item) => item.id === "calendar-mcp")).toMatchObject({
        name: "Calendar MCP",
        command: "node",
        cwd: installPath,
        args: [join(installPath, "calendar-mcp.cjs")]
      });

      const restarted = new SupbotRuntime(new JsonFileStorage(dataDir), { rootDir });
      await restarted.init();
      await restarted.updateToolMarketConfig({ source: "local", apiUrl: "", accountEmail: "", clearPassword: true });
      const installedFromDisk = await restarted.listToolMarket({ query: "Calendar" });
      expect(installedFromDisk).toHaveLength(1);
      expect(installedFromDisk[0]).toMatchObject({ id: "calendar-mcp", installed: true });

      const uninstalled = await restarted.uninstallToolMarketProduct("calendar-mcp");
      expect(uninstalled.installed).toBe(false);
      expect(restarted.snapshot().mcpServers.some((item) => item.id === "calendar-mcp")).toBe(false);
      await expect(readFile(join(installPath, "supbot-local-tool.json"), "utf8")).rejects.toThrow();
      await expect(readFile(join(receiptPath, "supbot-market-install.json"), "utf8")).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  test("runs local write tool and records generated files", async () => {
    const runtime = await createRuntime();
    const result = await runtime.sendPrompt({ prompt: "/write note.txt\nhello from supbot" });
    await waitForCondition("pending slash write permission", () => runtime.snapshot().pendingToolPermissions.length === 1);
    expect(runtime.snapshot().pendingToolPermissions[0].toolName).toBe("WriteFile");
    await runtime.approveToolPermission(runtime.snapshot().pendingToolPermissions[0].id);
    await waitForJob(runtime, result.job.id);

    const conversation = runtime.snapshot().conversations.find((item) => item.id === result.conversation.id);
    const assistant = conversation?.messages.find((item) => item.role === "assistant");
    expect(assistant?.generatedFiles?.[0]?.name).toBe("note.txt");
    expect(await readFile(assistant!.generatedFiles![0].path, "utf8")).toBe("hello from supbot");
    const job = runtime.snapshot().jobs.find((item) => item.id === result.job.id);
    expect(job?.workspaceMode).toBe("isolated");
    expect(runtime.snapshot().worktrees.find((item) => item.id === job?.worktreeId)?.diffStatus).toBe("dirty");
  });

  test("blocks approved slash writes outside the isolated workspace", async () => {
    const runtime = await createRuntime();
    const outsideDir = await mkdtemp(join(tmpdir(), "supbot-outside-"));
    tempDirs.push(outsideDir);
    const outsidePath = join(outsideDir, "system-ish.txt");
    const result = await runtime.sendPrompt({ prompt: `/write "${outsidePath}"\nblocked` });
    await waitForCondition("pending outside write permission", () => runtime.snapshot().pendingToolPermissions.length === 1);
    expect(runtime.snapshot().pendingToolPermissions[0].toolName).toBe("WriteFile");
    await runtime.approveToolPermission(runtime.snapshot().pendingToolPermissions[0].id);
    await waitForJob(runtime, result.job.id);

    const conversation = runtime.snapshot().conversations.find((item) => item.id === result.conversation.id);
    const assistant = conversation?.messages.find((item) => item.role === "assistant");
    expect(assistant?.text).toContain("WriteFile target must stay inside");
    await expect(readFile(outsidePath, "utf8")).rejects.toThrow();
    expect(runtime.snapshot().agentLoopTraces.find((item) => item.jobId === result.job.id)?.toolCalls[0].status).toBe("failed");
  });

  test("blocks write path traversal outside the isolated workspace", async () => {
    const runtime = await createRuntime();
    await runtime.addPermissionRule({ toolName: "WriteFile", behavior: "allow" });
    const result = await runtime.sendPrompt({ prompt: "/write ../escape.txt\nblocked" });
    await waitForJob(runtime, result.job.id);

    const conversation = runtime.snapshot().conversations.find((item) => item.id === result.conversation.id);
    const assistant = conversation?.messages.find((item) => item.role === "assistant");
    const job = runtime.snapshot().jobs.find((item) => item.id === result.job.id);
    const worktree = runtime.snapshot().worktrees.find((item) => item.id === job?.worktreeId);
    expect(assistant?.text).toContain("WriteFile target must stay inside");
    expect(runtime.snapshot().agentLoopTraces.find((item) => item.jobId === result.job.id)?.toolCalls[0].status).toBe("failed");
    await expect(readFile(join(dirname(worktree!.path), "escape.txt"), "utf8")).rejects.toThrow();
  });

  test("fails writable tools with a clear worktree error when no baseline commit exists", async () => {
    const runtime = await createRuntimeWithoutBaseline();
    await runtime.addPermissionRule({ toolName: "WriteFile", behavior: "allow" });
    const result = await runtime.sendPrompt({ prompt: "/write note.txt\nhello" });
    await waitForJob(runtime, result.job.id);

    const conversation = runtime.snapshot().conversations.find((item) => item.id === result.conversation.id);
    const assistant = conversation?.messages.find((item) => item.role === "assistant");
    expect(assistant?.text).toContain("Create a baseline Git commit");
    expect(runtime.snapshot().runtimeEvents.some((event) => event.kind === "worktree_event")).toBe(true);
  });

  test("reads local UTF-8 files with the read tool", async () => {
    const runtime = await createRuntime();
    const filePath = join(tempDirs[tempDirs.length - 1], "sample.txt");
    await writeFile(filePath, "hello from a local file", "utf8");

    const result = await runtime.sendPrompt({ prompt: `/read "${filePath}"` });
    await waitForJob(runtime, result.job.id);

    const conversation = runtime.snapshot().conversations.find((item) => item.id === result.conversation.id);
    const assistant = conversation?.messages.find((item) => item.role === "assistant");
    expect(assistant?.text).toContain(`Read ${filePath}`);
    expect(assistant?.text).toContain("hello from a local file");
  });

  test("runs local shell commands through PowerShell on Windows", async () => {
    const runtime = await createRuntime();
    const command = process.platform === "win32"
      ? "Get-PSDrive D | Format-List Used,Free"
      : "printf 'Used : 1\\nFree : 2\\n'";

    const result = await runtime.sendPrompt({ prompt: `/shell ${command}` });
    await waitForCondition("pending slash shell permission", () => runtime.snapshot().pendingToolPermissions.length === 1);
    expect(runtime.snapshot().pendingToolPermissions[0].toolName).toBe("Shell");
    await runtime.approveToolPermission(runtime.snapshot().pendingToolPermissions[0].id);
    await waitForJob(runtime, result.job.id);

    const conversation = runtime.snapshot().conversations.find((item) => item.id === result.conversation.id);
    const assistant = conversation?.messages.find((item) => item.role === "assistant");
    expect(assistant?.text).toContain("Exit code: 0");
    expect(assistant?.text).toContain("Cwd:");
    expect(assistant?.text).toContain("Used");
    expect(assistant?.text).toContain("Free");
  });

  test("denies dangerous slash commands through the normal permission flow", async () => {
    const runtime = await createRuntime();
    const result = await runtime.sendPrompt({ prompt: "/shell should-not-run" });
    await waitForCondition("pending slash shell permission", () => runtime.snapshot().pendingToolPermissions.length === 1);
    await runtime.denyToolPermission(runtime.snapshot().pendingToolPermissions[0].id);
    await waitForJob(runtime, result.job.id);

    const conversation = runtime.snapshot().conversations.find((item) => item.id === result.conversation.id);
    const assistant = conversation?.messages.find((item) => item.role === "assistant");
    expect(assistant?.text).toContain("User denied Shell");
    expect(runtime.snapshot().agentLoopTraces.find((item) => item.jobId === result.job.id)?.toolCalls[0].status).toBe("denied");
  });

  test("registers project folders and enforces project sandbox writes", async () => {
    const runtime = await createRuntime();
    const projectDir = await mkdtemp(join(tmpdir(), "supbot-project-"));
    tempDirs.push(projectDir);
    const project = await runtime.createProjectFromFolder({ rootPath: projectDir, name: "Data Project" });
    expect(project.metadataPath).toBe(join(projectDir, ".supbot", "project.json"));
    expect(await readFile(project.metadataPath, "utf8")).toContain("Data Project");

    const executor = new ToolExecutor();
    const registry = new ToolRegistry();
    const records: unknown[] = [];
    const context = {
      signal: new AbortController().signal,
      workspaceMode: "main" as const,
      projectId: project.id,
      projectRoot: project.rootPath,
      allowedWriteRoots: ["datasets/raw", "datasets/processed", "outputs", "reports", ".supbot/runs"].map((root) => join(project.rootPath, root)),
      host: {
        dataDir: project.rootPath,
        workspacePath: project.rootPath,
        cwd: project.rootPath,
        projectId: project.id,
        projectRoot: project.rootPath,
        allowedWriteRoots: ["datasets/raw", "datasets/processed", "outputs", "reports", ".supbot/runs"].map((root) => join(project.rootPath, root)),
        randomId: (prefix: string) => `${prefix}_test`,
        nowIso: () => "2026-07-04T00:00:00.000Z"
      },
      subagents: [],
      runSubagent: async () => ({ text: "unused" })
    };

    const allowed = await executor.execute({
      jobId: "job_project",
      conversationId: "conv_project",
      toolCall: {
        id: "call_project_allowed",
        type: "function",
        function: { name: "WriteFile", arguments: JSON.stringify({ path: "datasets/raw/source.txt", content: "raw" }) }
      },
      registry,
      context,
      permissionMode: "bypassPermissions",
      permissionRules: [],
      requestPermission: async () => "approved",
      onProgress: async (record) => {
        records.push(record);
      }
    });
    expect(allowed.record.status).toBe("completed");
    expect(await readFile(join(project.rootPath, "datasets/raw/source.txt"), "utf8")).toBe("raw");

    const denied = await executor.execute({
      jobId: "job_project",
      conversationId: "conv_project",
      toolCall: {
        id: "call_project_denied",
        type: "function",
        function: { name: "WriteFile", arguments: JSON.stringify({ path: "README.md", content: "bad" }) }
      },
      registry,
      context,
      permissionMode: "bypassPermissions",
      permissionRules: [],
      requestPermission: async () => "approved",
      onProgress: async (record) => {
        records.push(record);
      }
    });
    expect(denied.record.status).toBe("denied");
    await expect(readFile(join(project.rootPath, "README.md"), "utf8")).rejects.toThrow();
  });

  test("runs a project data autopilot workflow and records artifacts", async () => {
    const runtime = await createRuntime();
    const projectDir = await mkdtemp(join(tmpdir(), "supbot-data-run-"));
    tempDirs.push(projectDir);
    const project = await runtime.createProjectFromFolder({ rootPath: projectDir, name: "Data Run" });
    const mock = await withMockModel(runtime, (body) => {
      const parsed = JSON.parse(body);
      const userText = parsed.messages.filter((message: { role: string }) => message.role === "user").at(-1)?.content || "";
      const hasToolResult = parsed.messages.some((message: { role: string }) => message.role === "tool");
      const write = (id: string, path: string, content: string) => ({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id,
              type: "function",
              function: { name: "WriteFile", arguments: JSON.stringify({ path, content }) }
            }]
          }
        }]
      });
      if (!hasToolResult && userText.includes("Stage: collect")) {
        return write("call_collect", "datasets/raw/source.csv", "name,value\\na,1\\nb,2\\n");
      }
      if (!hasToolResult && userText.includes("Stage: process")) {
        return write("call_process", "datasets/processed/clean.csv", "name,value\\na,1\\nb,2\\n");
      }
      if (!hasToolResult && userText.includes("Stage: analyze")) {
        return write("call_analyze", "outputs/findings.txt", "Total value: 3\\nEvidence: datasets/processed/clean.csv\\n");
      }
      if (!hasToolResult && userText.includes("Stage: report")) {
        return write("call_report", "reports/final.md", "# Report\\nTotal value is 3.\\nEvidence: outputs/findings.txt\\n");
      }
      if (userText.includes("Goal-output alignment review")) {
        return { choices: [{ message: { content: "PASS\nThe report satisfies the goal and cites outputs/findings.txt." } }] };
      }
      return { choices: [{ message: { content: `Stage complete. Evidence: ${projectDir}\\reports\\final.md` } }] };
    });
    try {
      const run = await runtime.startDataRun({
        projectId: project.id,
        title: "Analyze sample data",
        goal: "Collect a small CSV, process it, analyze totals, and write a report.",
        dataSources: [{ id: "source", kind: "folderScan", label: "project", path: project.rootPath }]
      });
      await waitForAutopilotRun(runtime, run.id);
      const snapshot = runtime.snapshot();
      const completed = snapshot.autopilotRuns.find((item) => item.id === run.id);
      expect(completed?.status).toBe("completed");
      expect(completed?.reportPath).toContain("reports");
      const artifacts = snapshot.dataArtifacts.filter((artifact) => artifact.runId === run.id);
      expect(artifacts.map((artifact) => artifact.kind)).toEqual(expect.arrayContaining(["raw", "processed", "analysis", "report"]));
      expect(snapshot.autopilotTasks.filter((task) => task.runId === run.id).every((task) => task.status === "completed")).toBe(true);
      expect(await readFile(join(project.rootPath, ".supbot", "runs", run.id, "checkpoint.json"), "utf8")).toContain("Completed");
    } finally {
      await mock.close();
    }
  });

  test("continues autopilot until outputs match the goal", async () => {
    const runtime = await createRuntime();
    const projectDir = await mkdtemp(join(tmpdir(), "supbot-data-loop-"));
    tempDirs.push(projectDir);
    const project = await runtime.createProjectFromFolder({ rootPath: projectDir, name: "Loop Run" });
    let reviewCount = 0;
    const mock = await withMockModel(runtime, (body) => {
      const parsed = JSON.parse(body);
      const userText = parsed.messages.filter((message: { role: string }) => message.role === "user").at(-1)?.content || "";
      const hasToolResult = parsed.messages.some((message: { role: string }) => message.role === "tool");
      const write = (id: string, path: string, content: string) => ({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id,
              type: "function",
              function: { name: "WriteFile", arguments: JSON.stringify({ path, content }) }
            }]
          }
        }]
      });
      if (!hasToolResult && userText.includes("Stage: collect")) {
        return write("call_loop_collect", "datasets/raw/source.csv", "name,value\\na,1\\nb,2\\n");
      }
      if (!hasToolResult && userText.includes("Stage: process")) {
        return write("call_loop_process", "datasets/processed/clean.csv", "name,value\\na,1\\nb,2\\n");
      }
      if (!hasToolResult && userText.includes("Stage: analyze")) {
        return write("call_loop_analyze", "outputs/findings.txt", "Total value: 3\\nEvidence: datasets/processed/clean.csv\\n");
      }
      if (!hasToolResult && userText.includes("Revise outputs to match goal")) {
        return write("call_loop_fix", "reports/final.md", "# Report\\nTotal value is 3.\\nAverage value is 1.5.\\nEvidence: outputs/findings.txt\\n");
      }
      if (!hasToolResult && userText.includes("Stage: report")) {
        return write("call_loop_report", "reports/final.md", "# Report\\nTotal value is 3.\\nEvidence: outputs/findings.txt\\n");
      }
      if (userText.includes("Goal-output alignment review")) {
        reviewCount += 1;
        if (reviewCount === 1) {
          return { choices: [{ message: { content: "FAIL\nThe report is missing the requested average value." } }] };
        }
        return { choices: [{ message: { content: "PASS\nThe revised report includes total and average values with evidence." } }] };
      }
      return { choices: [{ message: { content: "Stage complete." } }] };
    });
    try {
      const run = await runtime.startDataRun({
        projectId: project.id,
        title: "Analyze totals and average",
        goal: "Collect a CSV, process it, analyze totals, and write a report that includes both total and average value.",
        dataSources: [],
        writePolicy: { maxTasks: 12 }
      });
      await waitForAutopilotRun(runtime, run.id);
      const snapshot = runtime.snapshot();
      const completed = snapshot.autopilotRuns.find((item) => item.id === run.id);
      expect(completed?.status).toBe("completed");
      expect(reviewCount).toBe(2);
      const tasks = snapshot.autopilotTasks.filter((task) => task.runId === run.id);
      expect(tasks.some((task) => task.title.startsWith("Goal-output alignment review"))).toBe(true);
      expect(tasks.some((task) => task.title.startsWith("Revise outputs to match goal"))).toBe(true);
      expect(snapshot.autopilotEvents.some((event) => event.runId === run.id && event.message.includes("queued fix iteration"))).toBe(true);
      expect(await readFile(join(project.rootPath, "reports", "final.md"), "utf8")).toContain("Average value is 1.5");
    } finally {
      await mock.close();
    }
  });

  test("recovers active autopilot runs as paused with a checkpoint", async () => {
    const { runtime, dataDir, rootDir } = await createRuntimeWithPaths();
    await runtime.shutdown();
    const projectDir = await mkdtemp(join(tmpdir(), "supbot-recover-project-"));
    tempDirs.push(projectDir);
    await mkdir(join(projectDir, ".supbot"), { recursive: true });
    const storage = new JsonFileStorage(dataDir);
    const state = await storage.load();
    const now = new Date().toISOString();
    const project = {
      id: "project_recover",
      name: "Recover Project",
      rootPath: projectDir,
      metadataPath: join(projectDir, ".supbot", "project.json"),
      status: "active" as const,
      createdAt: now,
      updatedAt: now
    };
    state.projects = [project];
    state.autopilotRuns = [{
      id: "run_recover",
      projectId: project.id,
      projectRoot: project.rootPath,
      title: "Recover run",
      goal: "Recover after restart",
      status: "running",
      currentStage: "collect",
      writePolicy: {
        mode: "projectSandbox",
        allowedWriteRoots: ["datasets/raw", "datasets/processed", "outputs", "reports", ".supbot/runs"],
        allowNetwork: true,
        allowMcp: true,
        maxRuntimeMinutes: 120,
        maxTasks: 16,
        maxRetries: 1
      },
      dataSources: [],
      taskIds: [],
      artifactIds: [],
      checkpointIds: [],
      evidence: [],
      createdAt: now,
      updatedAt: now,
      startedAt: now
    }];
    await storage.save(state);
    const restarted = new SupbotRuntime(storage, { rootDir });
    await restarted.init();
    const recovered = restarted.snapshot().autopilotRuns.find((run) => run.id === "run_recover");
    expect(recovered?.status).toBe("paused");
    expect(recovered?.error).toContain("Recovered");
    expect(await readFile(join(project.rootPath, ".supbot", "runs", "run_recover", "checkpoint.json"), "utf8")).toContain("Recovered");
    await restarted.shutdown();
  });

  test("runs model-requested read tools and feeds results back to the model", async () => {
    const runtime = await createRuntime();
    const filePath = join(tempDirs[tempDirs.length - 1], "tool-read.txt");
    await writeFile(filePath, "agent loop file content", "utf8");
    let calls = 0;
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        calls += 1;
        response.setHeader("Content-Type", "application/json");
        if (calls === 1) {
          const parsed = JSON.parse(body);
          expect(parsed.tools.some((tool: { function: { name: string } }) => tool.function.name === "ReadFile")).toBe(true);
          response.end(JSON.stringify({
            choices: [{
              message: {
                content: null,
                tool_calls: [{
                  id: "call_read_1",
                  type: "function",
                  function: { name: "ReadFile", arguments: JSON.stringify({ path: filePath }) }
                }]
              }
            }]
          }));
          return;
        }
        const parsed = JSON.parse(body);
        expect(parsed.messages.some((message: { role: string; content: string }) => message.role === "tool" && message.content.includes("agent loop file content"))).toBe(true);
        response.end(JSON.stringify({ choices: [{ message: { content: "Read complete." } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      await runtime.updateModelConfig({
        providerName: "Mock",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "mock-model",
        temperature: 0.1,
        maxTokens: 1000,
        apiKey: "test-key"
      });
      const result = await runtime.sendPrompt({ prompt: "read the file" });
      await waitForJob(runtime, result.job.id);
      const conversation = runtime.snapshot().conversations.find((item) => item.id === result.conversation.id);
      const assistant = conversation?.messages.find((item) => item.role === "assistant");
      expect(assistant?.text).toBe("Read complete.");
      expect(assistant?.blocks?.some((block) => block.type === "tool_use" && block.toolName === "ReadFile")).toBe(true);
      expect(calls).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  test("executes concurrent ReadFile tool calls and returns tool results in call order", async () => {
    const runtime = await createRuntime();
    const firstPath = join(tempDirs[tempDirs.length - 1], "first.txt");
    const secondPath = join(tempDirs[tempDirs.length - 1], "second.txt");
    await writeFile(firstPath, "first content", "utf8");
    await writeFile(secondPath, "second content", "utf8");
    let calls = 0;
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        calls += 1;
        response.setHeader("Content-Type", "application/json");
        if (calls === 1) {
          response.end(JSON.stringify({
            choices: [{
              message: {
                content: null,
                tool_calls: [
                  { id: "call_read_first", type: "function", function: { name: "ReadFile", arguments: JSON.stringify({ path: firstPath }) } },
                  { id: "call_read_second", type: "function", function: { name: "ReadFile", arguments: JSON.stringify({ path: secondPath }) } }
                ]
              }
            }]
          }));
          return;
        }
        const parsed = JSON.parse(body);
        const toolMessages = parsed.messages.filter((message: { role: string }) => message.role === "tool");
        expect(toolMessages.map((message: { tool_call_id: string }) => message.tool_call_id)).toEqual(["call_read_first", "call_read_second"]);
        expect(toolMessages[0].content).toContain("first content");
        expect(toolMessages[1].content).toContain("second content");
        response.end(JSON.stringify({ choices: [{ message: { content: "Both files read." } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      await runtime.updateModelConfig({
        providerName: "Mock",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "mock-model",
        temperature: 0.1,
        maxTokens: 1000,
        apiKey: "test-key"
      });
      const result = await runtime.sendPrompt({ prompt: "read both files" });
      await waitForJob(runtime, result.job.id);
      const trace = runtime.snapshot().agentLoopTraces.find((item) => item.jobId === result.job.id);
      expect(trace?.toolCalls.map((call) => call.id)).toEqual(["call_read_first", "call_read_second"]);
      expect(runtime.snapshot().runtimeEvents.some((event) => event.kind === "tool_result")).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  test("requires approval for shell tools and continues after approval", async () => {
    const runtime = await createRuntime();
    let calls = 0;
    const server = createServer((_request, response) => {
      calls += 1;
      response.setHeader("Content-Type", "application/json");
      if (calls === 1) {
        response.end(JSON.stringify({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call_shell_1",
                type: "function",
                function: { name: "Shell", arguments: JSON.stringify({ command: process.platform === "win32" ? "Write-Output approved" : "printf approved" }) }
              }]
            }
          }]
        }));
        return;
      }
      response.end(JSON.stringify({ choices: [{ message: { content: "Shell approved." } }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      await runtime.updateModelConfig({
        providerName: "Mock",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "mock-model",
        temperature: 0.1,
        maxTokens: 1000,
        apiKey: "test-key"
      });
      const result = await runtime.sendPrompt({ prompt: "run a shell command" });
      await waitForCondition("pending shell permission", () => runtime.snapshot().pendingToolPermissions.length === 1);
      await runtime.approveToolPermission(runtime.snapshot().pendingToolPermissions[0].id);
      await waitForJob(runtime, result.job.id);
      expect(runtime.snapshot().pendingToolPermissions).toHaveLength(0);
      const job = runtime.snapshot().jobs.find((item) => item.id === result.job.id);
      expect(job?.status).toBe("completed");
      const trace = runtime.snapshot().agentLoopTraces.find((item) => item.jobId === result.job.id);
      expect(trace?.toolCalls[0].status).toBe("completed");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  test("feeds denied tool calls back to the model", async () => {
    const runtime = await createRuntime();
    let calls = 0;
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        calls += 1;
        response.setHeader("Content-Type", "application/json");
        if (calls === 1) {
          response.end(JSON.stringify({
            choices: [{
              message: {
                content: null,
                tool_calls: [{
                  id: "call_write_1",
                  type: "function",
                  function: { name: "WriteFile", arguments: JSON.stringify({ path: "denied.txt", content: "nope" }) }
                }]
              }
            }]
          }));
          return;
        }
        const parsed = JSON.parse(body);
        expect(parsed.messages.some((message: { role: string; content: string }) => message.role === "tool" && message.content.includes("User denied"))).toBe(true);
        response.end(JSON.stringify({ choices: [{ message: { content: "I will not write the file." } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      await runtime.updateModelConfig({
        providerName: "Mock",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "mock-model",
        temperature: 0.1,
        maxTokens: 1000,
        apiKey: "test-key"
      });
      const result = await runtime.sendPrompt({ prompt: "write a file" });
      await waitForCondition("pending write permission", () => runtime.snapshot().pendingToolPermissions.length === 1);
      await runtime.denyToolPermission(runtime.snapshot().pendingToolPermissions[0].id);
      await waitForJob(runtime, result.job.id);
      const conversation = runtime.snapshot().conversations.find((item) => item.id === result.conversation.id);
      const assistant = conversation?.messages.find((item) => item.role === "assistant");
      expect(assistant?.text).toBe("I will not write the file.");
      expect(runtime.snapshot().agentLoopTraces.find((item) => item.jobId === result.job.id)?.toolCalls[0].status).toBe("denied");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  test("allows dangerous tools through an allow permission rule without pending approval", async () => {
    const runtime = await createRuntime();
    await runtime.addPermissionRule({ toolName: "Shell", behavior: "allow" });
    const command = process.platform === "win32" ? "Write-Output allow-rule" : "printf allow-rule";
    const mock = await withMockModel(runtime, (body, call) => {
      if (call === 1) {
        return {
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call_shell_allow",
                type: "function",
                function: { name: "Shell", arguments: JSON.stringify({ command }) }
              }]
            }
          }]
        };
      }
      const parsed = JSON.parse(body);
      expect(parsed.messages.some((message: { role: string; content: string }) => message.role === "tool" && message.content.includes("allow-rule"))).toBe(true);
      return { choices: [{ message: { content: "Allowed by rule." } }] };
    });
    try {
      const result = await runtime.sendPrompt({ prompt: "run allowed shell" });
      await waitForJob(runtime, result.job.id);
      expect(runtime.snapshot().pendingToolPermissions).toHaveLength(0);
      expect(runtime.snapshot().agentLoopTraces.find((item) => item.jobId === result.job.id)?.toolCalls[0].status).toBe("completed");
      expect(mock.calls()).toBe(2);
    } finally {
      await mock.close();
    }
  });

  test("deletes jobs and task execution records when deleting a conversation", async () => {
    const runtime = await createRuntime();
    await runtime.addPermissionRule({ toolName: "WriteFile", behavior: "allow" });
    const mock = await withMockModel(runtime, (body, call) => {
      if (call === 1) {
        return {
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call_write_cleanup",
                type: "function",
                function: { name: "WriteFile", arguments: JSON.stringify({ path: "cleanup.txt", content: "delete me with the conversation" }) }
              }]
            }
          }]
        };
      }
      const parsed = JSON.parse(body);
      expect(parsed.messages.some((message: { role: string; content: string }) => message.role === "tool" && message.content.includes("cleanup.txt"))).toBe(true);
      return { choices: [{ message: { content: "Cleanup task completed." } }] };
    });
    try {
      const result = await runtime.sendPrompt({ prompt: "write a cleanup file" });
      await waitForJob(runtime, result.job.id);

      const before = runtime.snapshot();
      expect(before.jobs.some((item) => item.id === result.job.id)).toBe(true);
      expect(before.agentLoopTraces.some((item) => item.jobId === result.job.id)).toBe(true);
      expect(before.querySessions.some((item) => item.jobId === result.job.id)).toBe(true);
      expect(before.runtimeEvents.some((item) => item.jobId === result.job.id || item.conversationId === result.conversation.id)).toBe(true);
      expect(before.worktrees.some((item) => item.jobId === result.job.id)).toBe(true);

      await runtime.deleteConversation(result.conversation.id);

      const after = runtime.snapshot();
      expect(after.conversations.some((item) => item.id === result.conversation.id)).toBe(false);
      expect(after.jobs.some((item) => item.id === result.job.id || item.conversationId === result.conversation.id)).toBe(false);
      expect(after.agentLoopTraces.some((item) => item.jobId === result.job.id || item.conversationId === result.conversation.id)).toBe(false);
      expect(after.querySessions.some((item) => item.jobId === result.job.id || item.conversationId === result.conversation.id)).toBe(false);
      expect(after.runtimeEvents.some((item) => item.jobId === result.job.id || item.conversationId === result.conversation.id)).toBe(false);
      expect(after.pendingToolPermissions.some((item) => item.jobId === result.job.id || item.conversationId === result.conversation.id)).toBe(false);
      expect(after.worktrees.some((item) => item.jobId === result.job.id || item.conversationId === result.conversation.id)).toBe(false);
    } finally {
      await mock.close();
    }
  });

  test("denies dangerous tools through a deny permission rule and continues the loop", async () => {
    const runtime = await createRuntime();
    await runtime.addPermissionRule({ toolName: "WriteFile", behavior: "deny" });
    const mock = await withMockModel(runtime, (body, call) => {
      if (call === 1) {
        return {
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call_write_denied_rule",
                type: "function",
                function: { name: "WriteFile", arguments: JSON.stringify({ path: "rule-denied.txt", content: "blocked" }) }
              }]
            }
          }]
        };
      }
      const parsed = JSON.parse(body);
      expect(parsed.messages.some((message: { role: string; content: string }) => message.role === "tool" && message.content.includes("Permission rule denied WriteFile"))).toBe(true);
      return { choices: [{ message: { content: "Denied by rule." } }] };
    });
    try {
      const result = await runtime.sendPrompt({ prompt: "write denied by rule" });
      await waitForJob(runtime, result.job.id);
      expect(runtime.snapshot().pendingToolPermissions).toHaveLength(0);
      expect(runtime.snapshot().agentLoopTraces.find((item) => item.jobId === result.job.id)?.toolCalls[0].status).toBe("denied");
    } finally {
      await mock.close();
    }
  });

  test("can force read tools to ask with a permission rule", async () => {
    const runtime = await createRuntime();
    const filePath = join(tempDirs[tempDirs.length - 1], "ask-read.txt");
    await writeFile(filePath, "ask me first", "utf8");
    await runtime.addPermissionRule({ toolName: "ReadFile", behavior: "ask" });
    const mock = await withMockModel(runtime, (body, call) => {
      if (call === 1) {
        return {
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call_read_ask_rule",
                type: "function",
                function: { name: "ReadFile", arguments: JSON.stringify({ path: filePath }) }
              }]
            }
          }]
        };
      }
      const parsed = JSON.parse(body);
      expect(parsed.messages.some((message: { role: string; content: string }) => message.role === "tool" && message.content.includes("User denied ReadFile"))).toBe(true);
      return { choices: [{ message: { content: "Read was denied." } }] };
    });
    try {
      const result = await runtime.sendPrompt({ prompt: "read with ask rule" });
      await waitForCondition("pending read permission", () => runtime.snapshot().pendingToolPermissions.length === 1);
      await runtime.denyToolPermission(runtime.snapshot().pendingToolPermissions[0].id);
      await waitForJob(runtime, result.job.id);
      expect(runtime.snapshot().agentLoopTraces.find((item) => item.jobId === result.job.id)?.toolCalls[0].status).toBe("denied");
    } finally {
      await mock.close();
    }
  });

  test("returns structured tool errors for invalid tool arguments before executing", async () => {
    const runtime = await createRuntime();
    const mock = await withMockModel(runtime, (body, call) => {
      if (call === 1) {
        return {
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call_shell_invalid",
                type: "function",
                function: { name: "Shell", arguments: JSON.stringify({ command: 42 }) }
              }]
            }
          }]
        };
      }
      const parsed = JSON.parse(body);
      expect(parsed.messages.some((message: { role: string; content: string }) => message.role === "tool" && message.content.includes("Tool input.command must be string"))).toBe(true);
      return { choices: [{ message: { content: "Invalid arguments handled." } }] };
    });
    try {
      const result = await runtime.sendPrompt({ prompt: "run invalid shell args" });
      await waitForJob(runtime, result.job.id);
      const toolCall = runtime.snapshot().agentLoopTraces.find((item) => item.jobId === result.job.id)?.toolCalls[0];
      expect(toolCall?.status).toBe("failed");
      expect(toolCall?.error).toContain("command must be string");
      expect(runtime.snapshot().pendingToolPermissions).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  test("runs configured subagents through the Agent tool", async () => {
    const runtime = await createRuntime();
    let calls = 0;
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        calls += 1;
        response.setHeader("Content-Type", "application/json");
        const parsed = JSON.parse(body);
        const isSubagent = parsed.messages.some((message: { role: string; content: string }) => message.role === "system" && message.content.includes("subagent @research"));
        if (isSubagent) {
          response.end(JSON.stringify({ choices: [{ message: { content: "Research says yes." } }] }));
          return;
        }
        if (calls === 1) {
          response.end(JSON.stringify({
            choices: [{
              message: {
                content: null,
                tool_calls: [{
                  id: "call_agent_1",
                  type: "function",
                  function: { name: "Agent", arguments: JSON.stringify({ subagent_type: "research", prompt: "check this" }) }
                }]
              }
            }]
          }));
          return;
        }
        expect(parsed.messages.some((message: { role: string; content: string }) => message.role === "tool" && message.content.includes("Research says yes."))).toBe(true);
        response.end(JSON.stringify({ choices: [{ message: { content: "Subagent complete." } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      await runtime.updateModelConfig({
        providerName: "Mock",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "mock-model",
        temperature: 0.1,
        maxTokens: 1000,
        apiKey: "test-key"
      });
      const result = await runtime.sendPrompt({ prompt: "delegate research" });
      await waitForCondition("pending agent permission", () => runtime.snapshot().pendingToolPermissions.length === 1);
      await runtime.approveToolPermission(runtime.snapshot().pendingToolPermissions[0].id);
      await waitForJob(runtime, result.job.id);
      const conversation = runtime.snapshot().conversations.find((item) => item.id === result.conversation.id);
      expect(conversation?.messages.find((item) => item.role === "assistant")?.text).toBe("Subagent complete.");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  test("keeps subagent memory isolated from the main agent and recalls it inside the subagent", async () => {
    const runtime = await createRuntime();
    await runtime.addMemory({
      type: "fact",
      scope: "subagent",
      subagentName: "research",
      title: "Research signal",
      content: "Research subagent should remember the keyword Nebula.",
      keywords: ["nebula", "research"]
    });
    await runtime.addPermissionRule({ toolName: "Agent", behavior: "allow" });
    let sawMainWithoutResearchMemory = false;
    let sawSubagentWithResearchMemory = false;
    const mock = await withMockModel(runtime, (body, call) => {
      const parsed = JSON.parse(body);
      const system = parsed.messages.find((message: { role: string }) => message.role === "system")?.content || "";
      const isSubagent = system.includes("subagent @research");
      if (isSubagent) {
        expect(system).toContain("<memory>");
        expect(system).toContain("Nebula");
        sawSubagentWithResearchMemory = true;
        return { choices: [{ message: { content: "Research memory recalled." } }] };
      }
      expect(system).not.toContain("Nebula");
      sawMainWithoutResearchMemory = true;
      if (call === 1) {
        return {
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call_agent_memory",
                type: "function",
                function: { name: "Agent", arguments: JSON.stringify({ subagent_type: "research", prompt: "Use Nebula research memory." }) }
              }]
            }
          }]
        };
      }
      return { choices: [{ message: { content: "Subagent memory complete." } }] };
    });
    try {
      const result = await runtime.sendPrompt({ prompt: "Ask research about Nebula." });
      await waitForJob(runtime, result.job.id);
      expect(sawMainWithoutResearchMemory).toBe(true);
      expect(sawSubagentWithResearchMemory).toBe(true);
      expect(runtime.snapshot().runtimeEvents.some((event) => event.kind === "memory_recall" && event.conversationId?.startsWith("subagent_"))).toBe(true);
    } finally {
      await mock.close();
    }
  });

  test("discovers MCP stdio tools and exposes them in runtime snapshots", async () => {
    const runtime = await createRuntime();
    const serverPath = await writeMockMcpServer();
    const disabled = await runtime.addMcpServer({
      name: "disabled tools",
      command: process.execPath,
      args: [serverPath],
      enabled: false
    });
    expect(runtime.snapshot().mcpServers.find((server) => server.id === disabled.id)?.enabled).toBe(false);
    expect(runtime.snapshot().mcpTools).toHaveLength(0);

    const server = await runtime.addMcpServer({
      name: "mock tools",
      command: process.execPath,
      args: [serverPath],
      enabled: true
    });
    await runtime.connectMcpServer(server.id);
    const snapshot = runtime.snapshot();
    expect(snapshot.mcpServers.find((item) => item.id === server.id)?.status.state).toBe("connected");
    expect(snapshot.mcpServers.find((item) => item.id === server.id)?.status.pid).toBeTypeOf("number");
    expect(snapshot.mcpServers.find((item) => item.id === server.id)?.status.lastConnectedAt).toBeTruthy();
    expect(snapshot.mcpServers.find((item) => item.id === server.id)?.status.stderrPreview).toContain("mock mcp stderr ready");
    const tool = snapshot.mcpTools.find((item) => item.runtimeToolName === `mcp.${server.id}.echo`);
    expect(tool?.modelToolName).toBe(`mcp__${server.id}__echo`);
    expect(await runtime.getMcpLogs(server.id)).not.toHaveLength(0);
  });

  test("lists MCP presets without connecting or registering tools", async () => {
    const runtime = await createRuntime();
    const presets = await runtime.listMcpPresets();
    expect(presets.length).toBeGreaterThan(0);
    expect(presets[0].serverInput.autoConnect).toBe(false);
    expect(runtime.snapshot().mcpTools).toHaveLength(0);
  });

  test("exports redacted MCP config and imports duplicate ids as disabled autoconnect-safe configs", async () => {
    const runtime = await createRuntime();
    const serverPath = await writeMockMcpServer();
    const server = await runtime.addMcpServer({
      name: "secret tools",
      command: process.execPath,
      args: [serverPath],
      env: { SECRET_TOKEN: "super-secret" },
      autoConnect: true,
      enabled: true
    });
    await runtime.addPermissionRule({ toolName: `mcp.${server.id}.*`, behavior: "ask" });
    const exported = await runtime.exportMcpConfig();
    expect(JSON.stringify(exported)).not.toContain("super-secret");
    expect(exported.servers[0].env?.SECRET_TOKEN.redacted).toBe(true);
    expect(exported.permissionRules.some((rule) => rule.toolName === `mcp.${server.id}.*`)).toBe(true);

    const result = await runtime.importMcpConfig(exported);
    expect(result.imported).toBe(1);
    expect(result.servers[0].id).not.toBe(server.id);
    expect(result.servers[0].autoConnect).toBe(false);
    expect(runtime.snapshot().mcpServers.some((item) => item.id === result.servers[0].id)).toBe(true);
  });

  test("diagnoses MCP servers without registering tools", async () => {
    const runtime = await createRuntime();
    const serverPath = await writeMockMcpServer();
    const beforeTools = runtime.snapshot().mcpTools.length;
    const result = await runtime.diagnoseMcpServer({
      name: "diagnostic tools",
      command: process.execPath,
      args: [serverPath],
      requestTimeoutMs: 1000,
      enabled: true
    });
    expect(result.ok).toBe(true);
    expect(result.toolCount).toBe(1);
    expect(result.stderrPreview).toContain("mock mcp stderr ready");
    expect(result.initializeMs).toBeTypeOf("number");
    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.capabilities).toMatchObject({ tools: {} });
    expect(runtime.snapshot().mcpTools).toHaveLength(beforeTools);
  });

  test("returns structured MCP diagnostics for initialize and tools/list failures", async () => {
    const runtime = await createRuntime();
    const initPath = await writeMockMcpServer("init-error");
    const initResult = await runtime.diagnoseMcpServer({
      name: "bad init",
      command: process.execPath,
      args: [initPath],
      requestTimeoutMs: 1000,
      enabled: true
    });
    expect(initResult.ok).toBe(false);
    expect(initResult.error).toContain("Initialize boom");
    expect(initResult.errorCode).toBe(-32000);
    expect(initResult.errorData).toMatchObject({ stage: "initialize" });

    const listPath = await writeMockMcpServer("list-error");
    const listResult = await runtime.diagnoseMcpServer({
      name: "bad list",
      command: process.execPath,
      args: [listPath],
      requestTimeoutMs: 1000,
      enabled: true
    });
    expect(listResult.ok).toBe(false);
    expect(listResult.error).toContain("Tools list boom");
    expect(listResult.errorCode).toBe(-32001);
    expect(listResult.errorData).toMatchObject({ stage: "tools/list" });
    expect(runtime.snapshot().mcpTools).toHaveLength(0);
  });

  test("validates nested MCP schemas and keeps invalid schemas diagnosable", async () => {
    const runtime = await createRuntime();
    const complexPath = await writeMockMcpServer("complex-schema");
    const complexServer = await runtime.addMcpServer({
      name: "complex schema",
      command: process.execPath,
      args: [complexPath],
      enabled: true
    });
    await runtime.connectMcpServer(complexServer.id);
    await runtime.addPermissionRule({ toolName: `mcp.${complexServer.id}.*`, behavior: "allow" });
    let mock = await withMockModel(runtime, (body, call) => {
      if (call === 1) {
        return {
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call_mcp_complex_invalid",
                type: "function",
                function: { name: `mcp__${complexServer.id}__complex`, arguments: JSON.stringify({ config: { mode: "turbo", labels: ["a"] }, target: true }) }
              }]
            }
          }]
        };
      }
      const parsed = JSON.parse(body);
      expect(parsed.messages.some((message: { role: string; content: string }) => message.role === "tool" && message.content.includes("config.mode must be one of fast, safe"))).toBe(true);
      expect(parsed.messages.some((message: { role: string; content: string }) => message.role === "tool" && message.content.includes("Tool input.target must match exactly one schema"))).toBe(true);
      return { choices: [{ message: { content: "Complex schema rejected." } }] };
    });
    try {
      const result = await runtime.sendPrompt({ prompt: "call invalid complex mcp" });
      await waitForJob(runtime, result.job.id);
      const record = runtime.snapshot().agentLoopTraces.find((item) => item.jobId === result.job.id)?.toolCalls[0];
      expect(record?.status).toBe("failed");
      expect(record?.error).toContain("config.mode");
    } finally {
      await mock.close();
    }

    mock = await withMockModel(runtime, (body, call) => {
      if (call === 1) {
        return {
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call_mcp_complex_valid",
                type: "function",
                function: { name: `mcp__${complexServer.id}__complex`, arguments: JSON.stringify({ config: { mode: "safe", labels: ["x", "y"] }, target: "repo" }) }
              }]
            }
          }]
        };
      }
      const parsed = JSON.parse(body);
      expect(parsed.messages.some((message: { role: string; content: string }) => message.role === "tool" && message.content.includes("complex:safe:repo"))).toBe(true);
      return { choices: [{ message: { content: "Complex schema accepted." } }] };
    });
    try {
      const result = await runtime.sendPrompt({ prompt: "call valid complex mcp" });
      await waitForJob(runtime, result.job.id);
      const record = runtime.snapshot().agentLoopTraces.find((item) => item.jobId === result.job.id)?.toolCalls[0];
      expect(record?.status).toBe("completed");
    } finally {
      await mock.close();
    }

    const invalidPath = await writeMockMcpServer("invalid-schema");
    const diagnostic = await runtime.diagnoseMcpServer({
      name: "invalid schema",
      command: process.execPath,
      args: [invalidPath],
      enabled: true
    });
    expect(diagnostic.ok).toBe(true);
    expect(diagnostic.tools[0].schemaValid).toBe(false);
    expect(diagnostic.schemaWarnings.join("\n")).toContain("unsupported value");

    const invalidServer = await runtime.addMcpServer({
      name: "invalid schema",
      command: process.execPath,
      args: [invalidPath],
      enabled: true
    });
    await runtime.connectMcpServer(invalidServer.id);
    const invalidTool = runtime.snapshot().mcpTools.find((tool) => tool.serverId === invalidServer.id);
    expect(invalidTool?.schemaValid).toBe(false);
    await runtime.addPermissionRule({ toolName: `mcp.${invalidServer.id}.*`, behavior: "allow" });
    mock = await withMockModel(runtime, (body, call) => {
      if (call === 1) {
        return {
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call_mcp_invalid_schema",
                type: "function",
                function: { name: `mcp__${invalidServer.id}__broken`, arguments: JSON.stringify({ value: "x" }) }
              }]
            }
          }]
        };
      }
      const parsed = JSON.parse(body);
      expect(parsed.messages.some((message: { role: string; content: string }) => message.role === "tool" && message.content.includes("MCP tool schema is invalid"))).toBe(true);
      return { choices: [{ message: { content: "Invalid schema handled." } }] };
    });
    try {
      const result = await runtime.sendPrompt({ prompt: "call broken mcp schema" });
      await waitForJob(runtime, result.job.id);
      const record = runtime.snapshot().agentLoopTraces.find((item) => item.jobId === result.job.id)?.toolCalls[0];
      expect(record?.status).toBe("failed");
      expect(record?.error).toContain("MCP tool schema is invalid");
    } finally {
      await mock.close();
    }
  });

  test("uses safe MCP model aliases and executes public runtime tool names", async () => {
    const runtime = await createRuntime();
    const serverPath = await writeMockMcpServer();
    const server = await runtime.addMcpServer({
      name: "alias tools",
      command: process.execPath,
      args: [serverPath],
      requestTimeoutMs: 1500,
      enabled: true
    });
    await runtime.connectMcpServer(server.id);
    await runtime.addPermissionRule({ toolName: `mcp.${server.id}.*`, behavior: "allow" });
    const aliasName = `mcp__${server.id}__echo`;
    const publicName = `mcp.${server.id}.echo`;
    const mock = await withMockModel(runtime, (body, call) => {
      const parsed = JSON.parse(body);
      if (call === 1) {
        const toolNames = parsed.tools.map((tool: { function: { name: string } }) => tool.function.name);
        expect(toolNames).toContain(aliasName);
        expect(toolNames).not.toContain(publicName);
        return {
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call_mcp_alias",
                type: "function",
                function: { name: aliasName, arguments: JSON.stringify({ message: "alias works" }) }
              }]
            }
          }]
        };
      }
      expect(parsed.messages.some((message: { role: string; content: string }) => message.role === "tool" && message.content.includes("alias works"))).toBe(true);
      return { choices: [{ message: { content: "Alias handled." } }] };
    });
    try {
      const result = await runtime.sendPrompt({ prompt: "call aliased mcp echo" });
      await waitForJob(runtime, result.job.id);
      const record = runtime.snapshot().agentLoopTraces.find((item) => item.jobId === result.job.id)?.toolCalls[0];
      expect(record?.toolName).toBe(publicName);
      expect(record?.status).toBe("completed");
    } finally {
      await mock.close();
    }
  });

  test("validates MCP tool arguments before permission and feeds tool errors back", async () => {
    const runtime = await createRuntime();
    const serverPath = await writeMockMcpServer();
    const server = await runtime.addMcpServer({
      name: "schema tools",
      command: process.execPath,
      args: [serverPath],
      enabled: true
    });
    await runtime.connectMcpServer(server.id);
    const mock = await withMockModel(runtime, (body, call) => {
      if (call === 1) {
        return {
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call_mcp_invalid",
                type: "function",
                function: { name: `mcp__${server.id}__echo`, arguments: JSON.stringify({ message: 42 }) }
              }]
            }
          }]
        };
      }
      const parsed = JSON.parse(body);
      expect(parsed.messages.some((message: { role: string; content: string }) => message.role === "tool" && message.content.includes("message must be string"))).toBe(true);
      return { choices: [{ message: { content: "MCP invalid args handled." } }] };
    });
    try {
      const result = await runtime.sendPrompt({ prompt: "call invalid mcp args" });
      await waitForJob(runtime, result.job.id);
      expect(runtime.snapshot().pendingToolPermissions).toHaveLength(0);
      expect(runtime.snapshot().agentLoopTraces.find((item) => item.jobId === result.job.id)?.toolCalls[0].status).toBe("failed");
    } finally {
      await mock.close();
    }
  });

  test("requires permission for MCP tools and runs after approval", async () => {
    const runtime = await createRuntime();
    const serverPath = await writeMockMcpServer();
    const server = await runtime.addMcpServer({
      name: "approval tools",
      command: process.execPath,
      args: [serverPath],
      enabled: true
    });
    await runtime.connectMcpServer(server.id);
    const mock = await withMockModel(runtime, (body, call) => {
      if (call === 1) {
        return {
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call_mcp_echo",
                type: "function",
                function: { name: `mcp__${server.id}__echo`, arguments: JSON.stringify({ message: "approved mcp" }) }
              }]
            }
          }]
        };
      }
      const parsed = JSON.parse(body);
      expect(parsed.messages.some((message: { role: string; content: string }) => message.role === "tool" && message.content.includes("approved mcp"))).toBe(true);
      return { choices: [{ message: { content: "MCP approved." } }] };
    });
    try {
      const result = await runtime.sendPrompt({ prompt: "call mcp echo" });
      await waitForCondition("pending mcp permission", () => runtime.snapshot().pendingToolPermissions.length === 1);
      expect(runtime.snapshot().pendingToolPermissions[0].toolName).toBe(`mcp.${server.id}.echo`);
      await runtime.approveToolPermission(runtime.snapshot().pendingToolPermissions[0].id);
      await waitForJob(runtime, result.job.id);
      expect(runtime.snapshot().agentLoopTraces.find((item) => item.jobId === result.job.id)?.toolCalls[0].status).toBe("completed");
    } finally {
      await mock.close();
    }
  });

  test("applies wildcard MCP permission rules and records server failures", async () => {
    const runtime = await createRuntime();
    const serverPath = await writeMockMcpServer();
    const server = await runtime.addMcpServer({
      name: "wildcard tools",
      command: process.execPath,
      args: [serverPath],
      enabled: true
    });
    await runtime.connectMcpServer(server.id);
    await runtime.addPermissionRule({ toolName: `mcp.${server.id}.*`, behavior: "deny" });
    const mock = await withMockModel(runtime, (body, call) => {
      if (call === 1) {
        return {
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call_mcp_denied",
                type: "function",
                function: { name: `mcp__${server.id}__echo`, arguments: JSON.stringify({ message: "blocked" }) }
              }]
            }
          }]
        };
      }
      const parsed = JSON.parse(body);
      expect(parsed.messages.some((message: { role: string; content: string }) => message.role === "tool" && message.content.includes(`Permission rule denied mcp.${server.id}.echo`))).toBe(true);
      return { choices: [{ message: { content: "MCP denied." } }] };
    });
    try {
      const result = await runtime.sendPrompt({ prompt: "deny mcp echo" });
      await waitForJob(runtime, result.job.id);
      expect(runtime.snapshot().pendingToolPermissions).toHaveLength(0);
      expect(runtime.snapshot().agentLoopTraces.find((item) => item.jobId === result.job.id)?.toolCalls[0].status).toBe("denied");
    } finally {
      await mock.close();
    }

    await expect(runtime.addMcpServer({ name: "bad mcp", command: "definitely-not-a-real-mcp-command", enabled: true })
      .then((bad) => runtime.connectMcpServer(bad.id))).rejects.toThrow();
    expect(runtime.snapshot().runtimeEvents.some((event) => event.kind === "mcp_server")).toBe(true);
  });

  test("records MCP startup and tools/list failures without blocking normal runtime", async () => {
    const runtime = await createRuntime();
    const initPath = await writeMockMcpServer("init-error");
    const initServer = await runtime.addMcpServer({
      name: "init failure",
      command: process.execPath,
      args: [initPath],
      requestTimeoutMs: 1000,
      enabled: true
    });
    await expect(runtime.connectMcpServer(initServer.id)).rejects.toThrow("Initialize boom");
    expect(runtime.snapshot().mcpServers.find((server) => server.id === initServer.id)?.status.state).toBe("error");
    expect((await runtime.getMcpLogs(initServer.id)).some((log) => log.message.includes("Initialize boom"))).toBe(true);

    const listPath = await writeMockMcpServer("list-error");
    const listServer = await runtime.addMcpServer({
      name: "list failure",
      command: process.execPath,
      args: [listPath],
      requestTimeoutMs: 1000,
      enabled: true
    });
    await expect(runtime.connectMcpServer(listServer.id)).rejects.toThrow("Tools list boom");
    const listStatus = runtime.snapshot().mcpServers.find((server) => server.id === listServer.id)?.status;
    expect(listStatus?.state).toBe("error");
    expect((await runtime.getMcpLogs(listServer.id)).some((log) => log.message.includes("Tools list boom"))).toBe(true);
    expect(runtime.snapshot().status).toBe("ready");
  });

  test("feeds MCP call failures, timeouts, and process exits back as tool errors", async () => {
    const runtime = await createRuntime();
    const callPath = await writeMockMcpServer("call-error");
    const callServer = await runtime.addMcpServer({
      name: "call failure",
      command: process.execPath,
      args: [callPath],
      requestTimeoutMs: 1000,
      enabled: true
    });
    await runtime.connectMcpServer(callServer.id);
    await runtime.addPermissionRule({ toolName: `mcp.${callServer.id}.*`, behavior: "allow" });
    let mock = await withMockModel(runtime, (body, call) => {
      if (call === 1) {
        return {
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call_mcp_failure",
                type: "function",
                function: { name: `mcp__${callServer.id}__echo`, arguments: JSON.stringify({ message: "boom" }) }
              }]
            }
          }]
        };
      }
      const parsed = JSON.parse(body);
      expect(parsed.messages.some((message: { role: string; content: string }) => message.role === "tool" && message.content.includes("Call boom"))).toBe(true);
      expect(parsed.messages.some((message: { role: string; content: string }) => message.role === "tool" && message.content.includes("MCP code -32002"))).toBe(true);
      expect(parsed.messages.some((message: { role: string; content: string }) => message.role === "tool" && message.content.includes("bad-call"))).toBe(true);
      return { choices: [{ message: { content: "Call failure handled." } }] };
    });
    try {
      const result = await runtime.sendPrompt({ prompt: "call failing mcp" });
      await waitForJob(runtime, result.job.id);
      const record = runtime.snapshot().agentLoopTraces.find((item) => item.jobId === result.job.id)?.toolCalls[0];
      expect(record?.status).toBe("failed");
      expect(record?.error).toContain("MCP code -32002");
      expect(record?.error).toContain("bad-call");
    } finally {
      await mock.close();
    }

    const timeoutPath = await writeMockMcpServer("hang-call");
    const timeoutServer = await runtime.addMcpServer({
      name: "timeout failure",
      command: process.execPath,
      args: [timeoutPath],
      requestTimeoutMs: 1000,
      enabled: true
    });
    await runtime.connectMcpServer(timeoutServer.id);
    await runtime.addPermissionRule({ toolName: `mcp.${timeoutServer.id}.*`, behavior: "allow" });
    mock = await withMockModel(runtime, (body, call) => {
      if (call === 1) {
        return {
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call_mcp_timeout",
                type: "function",
                function: { name: `mcp__${timeoutServer.id}__echo`, arguments: JSON.stringify({ message: "slow" }) }
              }]
            }
          }]
        };
      }
      const parsed = JSON.parse(body);
      expect(parsed.messages.some((message: { role: string; content: string }) => message.role === "tool" && message.content.includes("timed out"))).toBe(true);
      return { choices: [{ message: { content: "Timeout handled." } }] };
    });
    try {
      const result = await runtime.sendPrompt({ prompt: "call hanging mcp" });
      await waitForJob(runtime, result.job.id);
      expect(runtime.snapshot().agentLoopTraces.find((item) => item.jobId === result.job.id)?.toolCalls[0].status).toBe("failed");
    } finally {
      await mock.close();
    }

    const exitPath = await writeMockMcpServer("exit-on-call");
    const exitServer = await runtime.addMcpServer({
      name: "exit failure",
      command: process.execPath,
      args: [exitPath],
      requestTimeoutMs: 1000,
      enabled: true
    });
    await runtime.connectMcpServer(exitServer.id);
    await runtime.addPermissionRule({ toolName: `mcp.${exitServer.id}.*`, behavior: "allow" });
    mock = await withMockModel(runtime, (body, call) => {
      if (call === 1) {
        return {
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call_mcp_exit",
                type: "function",
                function: { name: `mcp__${exitServer.id}__echo`, arguments: JSON.stringify({ message: "exit" }) }
              }]
            }
          }]
        };
      }
      const parsed = JSON.parse(body);
      expect(parsed.messages.some((message: { role: string; content: string }) => message.role === "tool" && message.content.includes("MCP server exited"))).toBe(true);
      return { choices: [{ message: { content: "Exit handled." } }] };
    });
    try {
      const result = await runtime.sendPrompt({ prompt: "call exiting mcp" });
      await waitForJob(runtime, result.job.id);
      const snapshot = runtime.snapshot();
      expect(snapshot.agentLoopTraces.find((item) => item.jobId === result.job.id)?.toolCalls[0].status).toBe("failed");
      expect(snapshot.mcpServers.find((server) => server.id === exitServer.id)?.status.lastExitReason).toContain("code 7");
    } finally {
      await mock.close();
    }
  });

  test("formats MCP rich content parts and ignores notifications or unrelated responses", async () => {
    const runtime = await createRuntime();
    const notificationPath = await writeMockMcpServer("notifications");
    const notificationServer = await runtime.addMcpServer({
      name: "notification tools",
      command: process.execPath,
      args: [notificationPath],
      enabled: true
    });
    await runtime.connectMcpServer(notificationServer.id);
    const logs = await runtime.getMcpLogs(notificationServer.id);
    expect(logs.some((log) => log.message.includes("MCP notification: notifications/progress"))).toBe(true);
    expect(logs.some((log) => log.message.includes("unknown request id 99999"))).toBe(true);

    const richPath = await writeMockMcpServer("rich-result");
    const richServer = await runtime.addMcpServer({
      name: "rich tools",
      command: process.execPath,
      args: [richPath],
      enabled: true
    });
    await runtime.connectMcpServer(richServer.id);
    await runtime.addPermissionRule({ toolName: `mcp.${richServer.id}.*`, behavior: "allow" });
    const mock = await withMockModel(runtime, (body, call) => {
      if (call === 1) {
        return {
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call_mcp_rich",
                type: "function",
                function: { name: `mcp__${richServer.id}__rich`, arguments: JSON.stringify({ message: "payload" }) }
              }]
            }
          }]
        };
      }
      const parsed = JSON.parse(body);
      expect(parsed.messages.some((message: { role: string; content: string }) => message.role === "tool" && message.content.includes("rich:payload"))).toBe(true);
      expect(parsed.messages.some((message: { role: string; content: string }) => message.role === "tool" && message.content.includes("[image image/png"))).toBe(true);
      expect(parsed.messages.some((message: { role: string; content: string }) => message.role === "tool" && message.content.includes("resource text"))).toBe(true);
      return { choices: [{ message: { content: "Rich result handled." } }] };
    });
    try {
      const result = await runtime.sendPrompt({ prompt: "call rich mcp" });
      await waitForJob(runtime, result.job.id);
      const record = runtime.snapshot().agentLoopTraces.find((item) => item.jobId === result.job.id)?.toolCalls[0];
      expect(record?.status).toBe("completed");
      expect(record?.outputParts?.map((part) => part.type)).toEqual(["text", "image", "resource", "custom"]);
      expect(record?.outputParts?.find((part) => part.type === "image")?.mimeType).toBe("image/png");
      expect(record?.outputTruncated).toBe(false);
      const snapshotConversation = runtime.snapshot().conversations.find((conversation) => conversation.id === result.conversation.id);
      const messageBlock = snapshotConversation?.messages
        .find((message) => message.role === "assistant")
        ?.blocks?.find((block) => block.type === "tool_result");
      expect(messageBlock && messageBlock.type === "tool_result" ? messageBlock.outputParts?.map((part) => part.type) : []).toContain("resource");
    } finally {
      await mock.close();
    }
  });

  test("does not block runtime init when MCP autoConnect fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supbot-autoconnect-"));
    tempDirs.push(dir);
    const storage = new JsonFileStorage(dir);
    const state = await storage.load();
    const now = new Date().toISOString();
    state.mcpServers = [{
      id: "bad-auto",
      name: "bad auto",
      command: "definitely-not-a-real-mcp-command",
      args: [],
      requestTimeoutMs: 1000,
      enabled: true,
      autoConnect: true,
      createdAt: now,
      updatedAt: now
    }];
    await storage.save(state);
    const runtime = new SupbotRuntime(storage);
    await runtime.init();
    const snapshot = runtime.snapshot();
    expect(snapshot.status).toBe("ready");
    expect(snapshot.mcpServers[0].status.state).toBe("error");
    expect(snapshot.runtimeEvents.some((event) => event.kind === "mcp_server")).toBe(true);
  });

  test("records compact boundaries, runtime events, transcripts, and permission mode", async () => {
    const runtime = await createRuntime();
    await runtime.setPermissionMode("plan");
    const rule = await runtime.addPermissionRule({ toolName: "Shell", behavior: "deny" });
    expect(runtime.snapshot().permissionMode).toBe("plan");
    expect(runtime.snapshot().permissionRules.some((item) => item.id === rule.id)).toBe(true);

    const result = await runtime.sendPrompt({ prompt: "compact me later" });
    await waitForJob(runtime, result.job.id);
    const boundary = await runtime.compactConversation(result.conversation.id);
    const snapshot = runtime.snapshot();
    expect(snapshot.compactBoundaries.some((item) => item.id === boundary.id)).toBe(true);
    expect(snapshot.conversations.find((item) => item.id === result.conversation.id)?.messages.at(-1)?.blocks?.[0]?.type).toBe("compact_summary");
    expect(snapshot.runtimeEvents.some((event) => event.kind === "query_start")).toBe(true);

    const transcript = await runtime.loadTranscript(result.conversation.id);
    expect(transcript.entries.some((entry: { type: string }) => entry.type === "event")).toBe(true);
    expect(transcript.compactBoundary?.id).toBe(boundary.id);
    expect(transcript.activeMessages).toEqual([]);
    expect(transcript.source).toBe("transcript");

    await runtime.removePermissionRule(rule.id);
    expect(runtime.snapshot().permissionRules.some((item) => item.id === rule.id)).toBe(false);
  });

  test("serves read-only remote bridge status and blocks writable remote tool execution", async () => {
    const runtime = await createRuntime();
    const token = "remote-test-token";
    let config = await runtime.updateRemoteBridgeConfig({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      token
    });
    expect(config.enabled).toBe(true);
    config = await runtime.updateRemoteBridgeConfig({ host: "0.0.0.0" });
    expect(config.host).toBe("127.0.0.1");
    config = await runtime.updateRemoteBridgeConfig({ host: "0.0.0.0", allowRemoteBind: true });
    expect(config.host).toBe("0.0.0.0");
    config = await runtime.updateRemoteBridgeConfig({ host: "127.0.0.1", allowRemoteBind: false });
    expect(config.host).toBe("127.0.0.1");
    const bridgeUrl = `http://127.0.0.1:${config.port}`;

    const snapshotResponse = await fetch(`${bridgeUrl}/snapshot`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(snapshotResponse.status).toBe(200);
    const remoteSnapshot = await snapshotResponse.json() as { remoteBridge: { config: { enabled: boolean } } };
    expect(remoteSnapshot.remoteBridge.config.enabled).toBe(true);

    const unauthorized = await fetch(`${bridgeUrl}/snapshot`);
    expect(unauthorized.status).toBe(401);

    const invalidJson = await fetch(`${bridgeUrl}/prompt`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{"
    });
    expect(invalidJson.status).toBe(400);

    const oversizedBody = await fetch(`${bridgeUrl}/prompt`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "x".repeat(70 * 1024) })
    });
    expect(oversizedBody.status).toBe(413);

    const slashResponse = await fetch(`${bridgeUrl}/prompt`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "/write remote.txt\nblocked" })
    });
    expect(slashResponse.status).toBe(200);
    const slashSent = await slashResponse.json() as { job: { id: string } };
    await waitForJob(runtime, slashSent.job.id);
    expect(runtime.snapshot().agentLoopTraces.find((trace) => trace.jobId === slashSent.job.id)?.toolCalls[0].status).toBe("denied");

    await runtime.addPermissionRule({ toolName: "WriteFile", behavior: "allow" });
    const mock = await withMockModel(runtime, (body, call) => {
      if (call === 1) {
        return {
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call_remote_write",
                type: "function",
                function: { name: "WriteFile", arguments: JSON.stringify({ path: "remote.txt", content: "blocked" }) }
              }]
            }
          }]
        };
      }
      const parsed = JSON.parse(body);
      expect(parsed.messages.some((message: { role: string; content: string }) => message.role === "tool" && message.content.includes("read-only"))).toBe(true);
      return { choices: [{ message: { content: "Remote write blocked." } }] };
    });
    try {
      const promptResponse = await fetch(`${bridgeUrl}/prompt`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "x-a2a-request-id": "req-remote-1",
          "x-a2a-peer-id": "peer-supbot-1",
          "x-servstation-agent-id": "agent-dev-1",
          "x-tenant-id": "dev-tenant",
          "x-organization-id": "dev-org",
          "x-department-id": "dev-dept",
          "x-user-id": "dev-user",
          "x-role-ids": "admin,user"
        },
        body: JSON.stringify({ prompt: "write remotely" })
      });
      expect(promptResponse.status).toBe(200);
      const sent = await promptResponse.json() as { job: { id: string } };
      await waitForJob(runtime, sent.job.id);
      expect(runtime.snapshot().jobs.find((job) => job.id === sent.job.id)?.workspaceMode).toBe("readOnly");
      expect(runtime.snapshot().agentLoopTraces.find((trace) => trace.jobId === sent.job.id)?.toolCalls[0].status).toBe("denied");
      expect(runtime.snapshot().remoteBridge.audit.length).toBeGreaterThan(0);
      const audit = runtime.snapshot().remoteBridge.audit.find((record) => record.peerId === "peer-supbot-1");
      expect(audit?.requestId).toBe("req-remote-1");
      expect(audit?.agentInstanceId).toBe("agent-dev-1");
      expect(audit?.caller?.userContext?.userId).toBe("dev-user");
    } finally {
      await mock.close();
      await runtime.shutdown();
    }
  });

  test("exposes Servstation as a permission-gated outbound A2A tool", async () => {
    const runtime = await createRuntime();
    const servstationCalls: Array<{ path: string; method: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }> = [];
    const servstation = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const url = new URL(request.url || "/", "http://127.0.0.1");
        const path = url.pathname;
        servstationCalls.push({
          path: `${url.pathname}${url.search}`,
          method: request.method || "GET",
          headers: request.headers,
          body: body ? JSON.parse(body) as Record<string, unknown> : {}
        });
        response.setHeader("Content-Type", "application/json");
        if (request.method === "POST" && path === "/api/v1/agent/connect") {
          response.end(JSON.stringify({ agentInstanceId: "agent-serv-1", connectionMode: "reused", sessionToken: "redacted" }));
          return;
        }
        if (request.method === "POST" && path === "/api/v1/agent/agent-serv-1/conversations") {
          response.end(JSON.stringify({ id: "conv-serv-1", title: "New conversation" }));
          return;
        }
        if (request.method === "POST" && path === "/api/v1/agent/agent-serv-1/jobs") {
          response.end(JSON.stringify({ id: "job-serv-1", agentInstanceId: "agent-serv-1", conversationId: "conv-serv-1", status: "queued" }));
          return;
        }
        if (request.method === "GET" && path === "/api/v1/agent/agent-serv-1/jobs") {
          expect(url.searchParams.get("conversationId")).toBe("conv-serv-1");
          response.end(JSON.stringify({
            jobs: [{
              id: "job-serv-1",
              agentInstanceId: "agent-serv-1",
              conversationId: "conv-serv-1",
              status: "completed",
              result: {
                prompt: "remote system prompt should not be returned to Supbot",
                assistantText: "Remote staff-agent done.",
                assistantMessages: ["Remote staff-agent done."],
                statusEvents: ["turn_1_complete"],
                model: "mock-remote",
                usage: { inputTokens: 10, outputTokens: 4 }
              },
              progress: { phase: "turn_complete" }
            }]
          }));
          return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "not found" }));
      });
    });
    await new Promise<void>((resolve) => servstation.listen(0, "127.0.0.1", resolve));
    const address = servstation.address() as AddressInfo;
    const servstationUrl = `http://127.0.0.1:${address.port}`;
    await runtime.updateIdentityContext({
      tenantId: "tenant-A",
      organizationId: "org-A",
      departmentId: "dept-A",
      userId: "user-A",
      roleIds: ["operator", "user"],
      source: "servstation",
      servstationUrl
    });
    await runtime.updateServstationA2AConfig({ enabled: true, baseUrl: servstationUrl, authMode: "identityHeaders" });
    await runtime.addPermissionRule({ toolName: "ServstationPrompt", behavior: "allow" });
    const mock = await withMockModel(runtime, (body, call) => {
      if (call === 1) {
        const parsed = JSON.parse(body);
        expect(parsed.tools.some((tool: { function: { name: string } }) => tool.function.name === "servstation_prompt")).toBe(true);
        return {
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call_servstation_prompt",
                type: "function",
                function: { name: "servstation_prompt", arguments: JSON.stringify({ prompt: "coordinate remote planning" }) }
              }]
            }
          }]
        };
      }
      const parsed = JSON.parse(body);
      const toolMessage = parsed.messages.find((message: { role: string }) => message.role === "tool");
      expect(toolMessage.content).toContain("job-serv-1");
      expect(toolMessage.content).toContain("Remote staff-agent done.");
      expect(toolMessage.content).not.toContain("remote system prompt should not be returned");
      const toolResult = JSON.parse(toolMessage.content);
      expect(toolResult).toMatchObject({
        status: "completed",
        assistantText: "Remote staff-agent done.",
        result: {
          assistantText: "Remote staff-agent done.",
          model: "mock-remote",
          usage: { inputTokens: 10, outputTokens: 4 }
        },
        progress: { phase: "turn_complete" }
      });
      return { choices: [{ message: { content: "Servstation result: Remote staff-agent done." } }] };
    });
    try {
      const result = await runtime.sendPrompt({ prompt: "ask Servstation" });
      await waitForJob(runtime, result.job.id);
      expect(servstationCalls.map((call) => `${call.method} ${call.path}`)).toEqual([
        "POST /api/v1/agent/connect",
        "POST /api/v1/agent/agent-serv-1/conversations",
        "POST /api/v1/agent/agent-serv-1/jobs",
        "GET /api/v1/agent/agent-serv-1/jobs?conversationId=conv-serv-1"
      ]);
      expect(servstationCalls[0].headers["x-tenant-id"]).toBe("tenant-A");
      expect(servstationCalls[0].headers["x-organization-id"]).toBe("org-A");
      expect(servstationCalls[0].headers["x-department-id"]).toBe("dept-A");
      expect(servstationCalls[0].headers["x-user-id"]).toBe("user-A");
      expect(servstationCalls[0].headers["x-role-ids"]).toBe("operator,user");
      expect(runtime.snapshot().servstationA2A.config.agentInstanceId).toBe("agent-serv-1");
      const trace = runtime.snapshot().agentLoopTraces.find((item) => item.jobId === result.job.id);
      expect(trace?.toolCalls[0].toolName).toBe("ServstationPrompt");
      expect(trace?.toolCalls[0].status).toBe("completed");
    } finally {
      await mock.close();
      await new Promise<void>((resolve, reject) => servstation.close((error) => error ? reject(error) : resolve()));
    }
  });

  test("connects to Servstation reverse SSE and returns read-only prompt results", async () => {
    const runtime = await createRuntime();
    let eventStream: import("node:http").ServerResponse | undefined;
    let closeStream: (() => void) | undefined;
    let resultBody: Record<string, unknown> | undefined;
    let resolveResult: (() => void) | undefined;
    const resultReceived = new Promise<void>((resolve) => {
      resolveResult = resolve;
    });
    const servstation = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const url = new URL(request.url || "/", "http://127.0.0.1");
        response.setHeader("Content-Type", "application/json");
        if (request.method === "POST" && url.pathname === "/api/v1/agent/connect") {
          response.end(JSON.stringify({ agentInstanceId: "agent-reverse-1" }));
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/v1/agent/agent-reverse-1/a2a-peers/reverse-connections") {
          expect(request.headers["x-tenant-id"]).toBe("tenant-rev");
          const parsed = JSON.parse(body) as Record<string, unknown>;
          expect(parsed.capabilities).toEqual(["prompt.readOnly"]);
          response.end(JSON.stringify({
            peer: { id: "peer-reverse-1" },
            streamUrl: "/api/v1/agent/agent-reverse-1/a2a-peers/peer-reverse-1/events",
            heartbeatMs: 500
          }));
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/v1/agent/agent-reverse-1/a2a-peers/peer-reverse-1/events") {
          response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive"
          });
          eventStream = response;
          closeStream = () => response.end();
          response.write(`event: heartbeat\ndata: {"ok":true}\n\n`);
          return;
        }
        if (request.method === "POST" && url.pathname.endsWith("/ack")) {
          response.end(JSON.stringify({ ok: true }));
          return;
        }
        if (request.method === "POST" && url.pathname.endsWith("/result")) {
          resultBody = JSON.parse(body) as Record<string, unknown>;
          resolveResult?.();
          response.end(JSON.stringify({ ok: true }));
          return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "not found" }));
      });
    });
    await new Promise<void>((resolve) => servstation.listen(0, "127.0.0.1", resolve));
    const address = servstation.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await runtime.updateIdentityContext({
      tenantId: "tenant-rev",
      organizationId: "org-rev",
      departmentId: "dept-rev",
      userId: "user-rev",
      roleIds: ["user"],
      source: "servstation",
      servstationUrl: baseUrl
    });
    await runtime.updateServstationA2AConfig({ enabled: true, baseUrl, authMode: "identityHeaders" });
    const mock = await withMockModel(runtime, () => ({
      choices: [{ message: { content: "Local Supbot reverse result." } }]
    }));
    try {
      await runtime.connectServstationReverseBridge();
      await waitForCondition("reverse stream connected", () => runtime.snapshot().servstationA2A.config.reverse?.status === "connected" && Boolean(eventStream));
      eventStream!.write([
        "id: inv-reverse-1",
        "event: invoke_prompt",
        `data: ${JSON.stringify({
          invocationId: "inv-reverse-1",
          requestId: "req-reverse-1",
          prompt: "Run a read-only local Supbot task",
          timeoutMs: 5_000,
          userContext: {
            tenantId: "tenant-rev",
            organizationId: "org-rev",
            departmentId: "dept-rev",
            userId: "user-rev",
            roleIds: ["user"],
            source: "servstation"
          },
          agentInstanceId: "agent-reverse-1"
        })}`,
        "",
        ""
      ].join("\n"));
      await resultReceived;
      expect(resultBody).toMatchObject({
        status: "completed",
        assistantText: "Local Supbot reverse result."
      });
      expect(resultBody?.result).toMatchObject({
        assistantText: "Local Supbot reverse result.",
        workspaceMode: "readOnly"
      });
      const reverseJob = runtime.snapshot().jobs.find((job) => job.prompt === "Run a read-only local Supbot task");
      expect(reverseJob?.workspaceMode).toBe("readOnly");
    } finally {
      closeStream?.();
      await runtime.disconnectServstationReverseBridge();
      await mock.close();
      await new Promise<void>((resolve, reject) => servstation.close((error) => error ? reject(error) : resolve()));
    }
  });

  test("refreshes Servstation OIDC sessions and updates bound identity", async () => {
    const runtime = await createRuntime();
    const refreshBodies: string[] = [];
    let issuerUrl = "";
    let tokenEndpoint = "";
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const path = request.url || "/";
        response.setHeader("Content-Type", "application/json");
        if (path === "/issuer/.well-known/openid-configuration") {
          response.end(JSON.stringify({ token_endpoint: tokenEndpoint }));
          return;
        }
        if (request.method === "POST" && path === "/issuer/token") {
          refreshBodies.push(body);
          response.end(JSON.stringify({
            access_token: fakeJwt({
              tenantId: "tenant-oidc",
              organizationId: "org-oidc",
              departmentId: "dept-oidc",
              preferred_username: "oidc-user",
              realm_access: { roles: ["user", "offline_access"] }
            }),
            refresh_token: "refresh-token-2",
            token_type: "Bearer",
            scope: "openid profile offline_access",
            expires_in: 300
          }));
          return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "not found" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    issuerUrl = `${baseUrl}/issuer`;
    tokenEndpoint = `${issuerUrl}/token`;
    try {
      const initial = await runtime.updateServstationA2AOidcSession({
        baseUrl,
        issuerUrl,
        clientId: "agent-client-web-dev",
        scope: "openid profile offline_access",
        tokens: {
          accessToken: fakeJwt({
            tenantId: "tenant-old",
            organizationId: "org-old",
            departmentId: "dept-old",
            preferred_username: "old-user"
          }),
          refreshToken: "refresh-token-1",
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
          issuerUrl,
          clientId: "agent-client-web-dev"
        },
        identityContext: {
          tenantId: "tenant-old",
          organizationId: "org-old",
          departmentId: "dept-old",
          userId: "old-user",
          roleIds: ["user"],
          source: "servstation",
          servstationUrl: baseUrl
        }
      });
      expect(initial.authMode).toBe("oidc");
      expect(initial.oidc?.refreshTokenSaved).toBe(true);
      const refreshed = await runtime.refreshServstationA2AOidcSession();
      expect(refreshBodies).toHaveLength(1);
      expect(new URLSearchParams(refreshBodies[0]).get("grant_type")).toBe("refresh_token");
      expect(new URLSearchParams(refreshBodies[0]).get("refresh_token")).toBe("refresh-token-1");
      expect(refreshed.oidc?.refreshTokenSaved).toBe(true);
      expect(refreshed.oidc?.userId).toBe("oidc-user");
      expect(refreshed.oidc?.accessTokenExpiresAt).toBeTruthy();
      const identity = await runtime.identityContext();
      expect(identity).toMatchObject({
        tenantId: "tenant-oidc",
        organizationId: "org-oidc",
        departmentId: "dept-oidc",
        userId: "oidc-user"
      });
      expect(identity?.roleIds).toEqual(["user", "offline_access"]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  test("creates compact memory candidates and only persists approved candidates", async () => {
    const runtime = await createRuntime();
    const result = await runtime.sendPrompt({ prompt: "Remember that the release branch is v3-memory-mvp." });
    await waitForJob(runtime, result.job.id);
    const firstBoundary = await runtime.compactConversation(result.conversation.id);
    const firstCandidate = runtime.snapshot().memory.candidates.find((candidate) => candidate.source === `compact:${firstBoundary.id}`);
    expect(firstCandidate?.status).toBe("pending");

    const approved = await runtime.approveMemoryCandidate(firstCandidate!.id);
    expect(approved.content).toContain("release branch");
    expect(runtime.snapshot().memory.facts.some((fact) => fact.id === approved.id && fact.status === "active")).toBe(true);
    expect(runtime.snapshot().memory.candidates.find((candidate) => candidate.id === firstCandidate!.id)?.status).toBe("approved");

    const denyConversation = await runtime.createConversation("Deny candidate");
    const second = await runtime.sendPrompt({ conversationId: denyConversation.id, prompt: "Remember that the deny candidate path is v3-memory-deny-flow." });
    await waitForJob(runtime, second.job.id);
    const secondBoundary = await runtime.compactConversation(denyConversation.id);
    const secondCandidate = runtime.snapshot().memory.candidates.find((candidate) => candidate.source === `compact:${secondBoundary.id}`);
    expect(secondCandidate?.status).toBe("pending");

    await runtime.denyMemoryCandidate(secondCandidate!.id);
    expect(runtime.snapshot().memory.candidates.find((candidate) => candidate.id === secondCandidate!.id)?.status).toBe("denied");
    expect(runtime.snapshot().memory.facts.some((fact) => fact.source === secondCandidate!.source)).toBe(false);
    expect(runtime.snapshot().runtimeEvents.some((event) => event.kind === "memory_write")).toBe(true);
  });

  test("deduplicates similar compact memory candidates", async () => {
    const runtime = await createRuntime();
    const result = await runtime.sendPrompt({ prompt: "Remember that the Polaris launch branch is release/polaris." });
    await waitForJob(runtime, result.job.id);
    const firstBoundary = await runtime.compactConversation(result.conversation.id);
    const firstCandidate = runtime.snapshot().memory.candidates.find((candidate) => candidate.source === `compact:${firstBoundary.id}`);
    expect(firstCandidate?.status).toBe("pending");
    const before = runtime.snapshot().memory.candidates.length;

    const secondBoundary = await runtime.compactConversation(result.conversation.id);
    expect(runtime.snapshot().memory.candidates.find((candidate) => candidate.source === `compact:${secondBoundary.id}`)).toBeUndefined();
    expect(runtime.snapshot().memory.candidates.length).toBe(before);
  });

  test("does not duplicate the active compact summary through memory recall", async () => {
    const runtime = await createRuntime();
    const result = await runtime.sendPrompt({ prompt: "The current compact topic is Orchid recall." });
    await waitForJob(runtime, result.job.id);
    const boundary = await runtime.compactConversation(result.conversation.id);
    const candidate = runtime.snapshot().memory.candidates.find((item) => item.source === `compact:${boundary.id}`)!;
    await runtime.approveMemoryCandidate(candidate.id);

    const mock = await withMockModel(runtime, (body) => {
      const parsed = JSON.parse(body);
      const system = parsed.messages.find((message: { role: string }) => message.role === "system")?.content || "";
      expect(system).toContain("<conversation_summary>");
      expect(system).not.toContain("<memory>");
      return { choices: [{ message: { content: "No duplicate compact memory." } }] };
    });
    try {
      const followup = await runtime.sendPrompt({ conversationId: result.conversation.id, prompt: "Orchid recall follow-up" });
      await waitForJob(runtime, followup.job.id);
    } finally {
      await mock.close();
    }
  });

  test("loads transcript recovery from state when transcript is missing", async () => {
    const runtime = await createRuntime();
    const result = await runtime.sendPrompt({ prompt: "state fallback context" });
    await waitForJob(runtime, result.job.id);
    const store = new TranscriptStore(tempDirs[tempDirs.length - 1]);
    await rm(store.pathFor(result.conversation.id), { force: true });

    const transcript = await runtime.loadTranscript(result.conversation.id);
    expect(transcript.source).toBe("state");
    expect(transcript.entries).toEqual([]);
    expect(transcript.activeMessages.length).toBeGreaterThanOrEqual(2);
    expect(transcript.diagnostics[0]?.message).toContain("Transcript file was not found");
  });

  test("loads transcript recovery with diagnostics for damaged lines", async () => {
    const runtime = await createRuntime();
    const result = await runtime.sendPrompt({ prompt: "damaged transcript context" });
    await waitForJob(runtime, result.job.id);
    const conversation = runtime.snapshot().conversations.find((item) => item.id === result.conversation.id)!;
    const store = new TranscriptStore(tempDirs[tempDirs.length - 1]);
    await mkdir(dirname(store.pathFor(conversation.id)), { recursive: true });
    await writeFile(store.pathFor(conversation.id), [
      "not-json",
      JSON.stringify({ type: "message", message: conversation.messages[0] }),
      JSON.stringify({ type: "message", message: conversation.messages[1] })
    ].join("\n"), "utf8");

    const transcript = await runtime.loadTranscript(conversation.id);
    expect(transcript.source).toBe("transcript");
    expect(transcript.entries).toHaveLength(2);
    expect(transcript.activeMessages.map((message) => message.id)).toEqual(conversation.messages.slice(0, 2).map((message) => message.id));
    expect(transcript.diagnostics.some((diagnostic) => diagnostic.level === "error" && diagnostic.line === 1)).toBe(true);
  });

  test("recovers active transcript context after the latest compact boundary", async () => {
    const runtime = await createRuntime();
    const result = await runtime.sendPrompt({ prompt: "first message" });
    await waitForJob(runtime, result.job.id);
    const boundary = await runtime.compactConversation(result.conversation.id);
    const second = await runtime.sendPrompt({ conversationId: result.conversation.id, prompt: "after compact" });
    await waitForJob(runtime, second.job.id);

    const transcript = await runtime.loadTranscript(result.conversation.id);
    expect(transcript.source).toBe("transcript");
    expect(transcript.compactBoundary?.id).toBe(boundary.id);
    expect(transcript.activeMessages.length).toBeGreaterThan(0);
    expect(transcript.activeMessages.some((message) => message.text.includes("after compact"))).toBe(true);
    expect(transcript.activeMessages.some((message) => message.id === boundary.messageId)).toBe(false);
  });

  test("fails jobs when agent loop reaches max turns", async () => {
    const runtime = await createRuntime();
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: `call_read_${Date.now()}_${Math.random()}`,
              type: "function",
              function: { name: "ReadFile", arguments: JSON.stringify({ path: join(tempDirs[tempDirs.length - 1], "missing.txt") }) }
            }]
          }
        }]
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      await runtime.updateModelConfig({
        providerName: "Mock",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "mock-model",
        temperature: 0.1,
        maxTokens: 1000,
        apiKey: "test-key"
      });
      const result = await runtime.sendPrompt({ prompt: "loop forever" });
      await waitForJob(runtime, result.job.id);
      const job = runtime.snapshot().jobs.find((item) => item.id === result.job.id);
      expect(job?.status).toBe("failed");
      expect(job?.error).toContain("maxTurns");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  test("runs due one-time scheduled jobs", async () => {
    const runtime = await createRuntime();
    await runtime.createScheduledJob({
      title: "Ping",
      prompt: "scheduled hello",
      scheduleKind: "once",
      runAt: new Date(Date.now() - 1000).toISOString(),
      enabled: true
    });

    const count = await runtime.runDueScheduledJobs(new Date());
    expect(count).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const snapshot = runtime.snapshot();
    expect(snapshot.scheduledJobs[0].enabled).toBe(false);
    expect(snapshot.conversations[0].messages[0].text).toContain("[Scheduled] Ping");
  });
});
