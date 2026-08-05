#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_POLL_SECONDS = 1;
const DEFAULT_HEARTBEAT_SECONDS = 15;
const DEFAULT_BACKGROUND_TASK_WAIT_SECONDS = 30 * 60;
const DEFAULT_BACKGROUND_TASK_POLL_SECONDS = 5;
const BACKGROUND_TASK_TERMINAL_STATUSES = new Set(["completed", "failed", "stopped", "timeout"]);
const BACKGROUND_TASK_FAILED_STATUSES = new Set(["failed", "stopped", "timeout"]);
const STARTUP_FAKE_RESPONSE = process.env.BOTSTATION_OPENCLAUDE_FAKE_RESPONSE || "";
const PERSISTED_READ_SAFE_FILE_BYTES = 16 * 1024;
const PERSISTED_READ_TARGET_TOKENS = 16_000;
const PERSISTED_READ_MAX_LINE_CHARS = 8_000;
const PERSISTED_READ_JSON_PARSE_MAX_BYTES = 8 * 1024 * 1024;
const OPENCLAUDE_DEFERRED_TOOL_INSTRUCTIONS = [
  "OpenClaude deferred tool rule:",
  '- Before first using WebSearch, WebFetch, Skill, Task, or another deferred tool, load its schema with ToolSearch using query "select:<ToolName>" (for example: "select:WebSearch").',
  "- If a tool returns InputValidationError or says its schema was not sent, do not retry the same call; call ToolSearch with the select query for that tool, then retry with the exact schema shape.",
  "- If WebSearch or WebFetch returns errors such as 404, timeout, unavailable, or request failed, do not keep retrying similar URLs or queries. After at most two such failures, stop using that failing tool and continue with available information, explicitly noting data gaps instead of aborting the task.",
  "- Oversized MCP results may be saved as single-line files under tool-results. BotStation can redirect Read to a bounded readable view; continue from the returned next line instead of retrying the original path or range.",
  "- For targeted data in a persisted MCP result, prefer Grep or jq against the original file. For full analysis, read the bounded view sequentially until the required content has been covered.",
].join("\n");
const ADMINBOT_CAPABILITY_INSTALL_INSTRUCTIONS = [
  "AdminBot capability-management installation rule:",
  "- Skill ZIP attachments with an explicit install/import request are handled deterministically by the BotStation runtime before the model is started.",
  "- Do not use Skill(skill-creator), Write, Edit, Bash, cp, unzip, or direct writes to AdminBot config/skills or openharness/config/skills for a capability-management installation. Those paths are AdminBot-private and do not create a backend catalog entry.",
  "- If an installation request reaches the model without a usable ZIP attachment, ask for a valid Skill ZIP. Never claim installation success based only on local files.",
].join("\n");
const ADMINBOT_SKILL_INSTALL_ACTION_PATTERN = /(?:安装|导入|注册|添加|上传|install|import|register|add|upload)/i;
const ADMINBOT_SKILL_INSTALL_TARGET_PATTERN = /(?:skill|技能|能力管理|capability\s*management|service\s*catalog)/i;
const SUBJECT_CREDIT_MCP_INSTRUCTIONS = [
  "Dedicated subject-credit report workflow:",
  "- This task names the dedicated `主体信用分析` MCP (`ccx-credit-report-agent`). Use its `generate_credit_report` tool. Do not substitute enterprise-data search tools or manually compose the report from their results.",
  '- Load the tool with ToolSearch query `select:generate_credit_report`, then call it with `{ "name": "<full company name>" }`. The optional `year` must be an integer when the user requests a specific year. Never send `keyword` or unrelated fields.',
  '- The required deliverable is the Word (`.docx`) report produced by the MCP. If `generate_credit_report` returns a `job_id`, load `get_job_status` with ToolSearch and poll it using exactly `{ "job_id": "<job id>" }` until status is `done` or a terminal error is returned.',
  "- When the job is done, download the returned `download_url` to the task output directory stated above using Python `urllib.request`. If the URL path contains non-ASCII characters, percent-encode its path segments before the first download attempt. Do not try `curl` or `wget`. Preserve the `.docx` extension, verify the file is non-empty and a valid Office ZIP, and expose that file as the task artifact.",
  "- Do not silently replace a failed or missing MCP Word report with Markdown, a hand-built DOCX, or a generic narrative. Report the dedicated MCP failure and its job status instead.",
].join("\n");
const SUBJECT_CREDIT_PROMPT_PATTERN = /(?:\u4e3b\u4f53\u4fe1\u7528|subject[\s-]*credit)/i;
const SUBJECT_CREDIT_MCP_SERVER_NAME = "remote-mcp-101-227-67-76-28007";
const SUBJECT_CREDIT_MCP_PORT = "28007";
const SUBJECT_CREDIT_PROXY_TIMEOUT_MS = 30_000;
const SUBJECT_CREDIT_DOWNLOAD_TIMEOUT_MS = 60_000;
const SUBJECT_CREDIT_MAX_REPORT_BYTES = 100 * 1024 * 1024;
const SUBJECT_CREDIT_COMPLETION_TIMEOUT_MS = 12 * 60 * 1000;
const SUBJECT_CREDIT_POLL_INTERVAL_MS = 2_000;
const KNOWLEDGE_BASE_PRIORITY_INSTRUCTIONS = [
  "Knowledge-base priority rule:",
  "- For internal knowledge, document, business data, financial data, policy, process, metric definition, customer, or enterprise lookup requests, query the knowledge-base MCP first.",
  "- For document and free-text knowledge, start with kb_semantic_search.",
  "- Knowledge-base MCP argument names are strict: use limit, not top_k or max_results; for kb_graph_search omit scope and use nodeTypes, properties, depth, and limit.",
  "- For structured SQL/database facts, use kb_semantic_search to find relevant database/table descriptions, then call kb_list_templates or kb_get_template before kb_structured_query.",
  "- For Neo4j graph knowledge, entity relationships, schema descriptions, or directly MCP-written graph content, call kb_graph_schema first, then kb_graph_search; use kb_graph_query only when the typed graph search cannot express the lookup.",
  "- When knowledge-base search returns only unrelated low-confidence chunks, deleted/obsolete descriptions, no graph result, or no template that can query the target database, treat that as a knowledge-base miss.",
  '- If the user explicitly says to use the knowledge base (for example "从知识库", "基于知识库", or "from knowledge-base"), do not substitute enterprise MCP, WebSearch, WebFetch, or other external sources for the final data. If knowledge-base has no usable schema/template/data path, stop and report the missing knowledge-base configuration.',
  "- When the knowledge base returns a MySQL storage path or MySQL connection string, use the mysql-client plugin command for read-only SELECT / EXPLAIN SELECT execution instead of calling raw mysql directly.",
  "- If mysql-client prints MYSQL_CLIENT_QUERY_FAILED, do not retry the same host or connection. Treat it as a database connectivity, credential, or whitelist miss and report the blocking condition.",
  "- Otherwise, use enterprise MCP, WebSearch, WebFetch, or external sources only after the knowledge-base miss is clear, and explicitly state why fallback was used.",
  "- Write user-facing deliverables under the requested output directory when the task produces a report, table, or downloadable answer.",
].join("\n");
const KNOWLEDGE_BASE_MCP_NAME = "knowledge-base";
const activeQueryLifecycles = new Set();
let shutdownRequested = false;
const KNOWLEDGE_BASE_READ_ONLY_TOOLS = new Set([
  "kb_graph_query",
  "kb_graph_search",
  "kb_semantic_search",
  "kb_get_object_versions",
  "kb_structured_query",
  "kb_list_templates",
  "kb_get_template",
  "kb_extraction_status",
  "kb_graph_get_node",
  "kb_graph_get_relationship",
  "kb_graph_schema",
]);
const TINYFISH_WEB_SEARCH_API = "https://api.search.tinyfish.ai";
const TINYFISH_WEB_SEARCH_QUERY_PARAM = "query";
const TINYFISH_WEB_SEARCH_PROVIDER = "custom";
const TINYFISH_MCP_NAME = "tinyfish";
const EXPLICIT_WEB_SEARCH_ENV_VARS = ["WEB_SEARCH_PROVIDER", "WEB_SEARCH_API", "WEB_URL_TEMPLATE", "WEB_PROVIDER"];
const TINYFISH_WEB_SEARCH_BUILTIN_BACKEND_KEYS = [
  "FIRECRAWL_API_KEY",
  "TAVILY_API_KEY",
  "EXA_API_KEY",
  "JINA_API_KEY",
  "BING_API_KEY",
  "MOJEEK_API_KEY",
  "LINKUP_API_KEY",
  "YOU_API_KEY",
  "GOOGLE_CSE_ID",
  "BRAVE_API_KEY",
];

export class StationHTTPError extends Error {
  constructor(statusCode, payload) {
    super(errorMessage(payload) || `station request failed with status ${statusCode}`);
    this.statusCode = statusCode;
    this.payload = payload;
  }
}

export class JobTerminalError extends Error {
  constructor(code, message, options = {}) {
    super(message || code);
    this.terminalCode = code;
    this.terminalMessage = message || code;
    this.result = options.result;
  }
}

export class SessionQueueBridge {
  constructor(
    stationURL,
    { clientID = "openclaude-runtime", internalAuthToken = "", serviceCatalogURL = "", timeoutMs = 10000 } = {},
  ) {
    this.stationURL = stationURL.replace(/\/+$/, "");
    this.serviceCatalogURL = serviceCatalogURL ? serviceCatalogURL.replace(/\/+$/, "") : "";
    this.clientID = clientID;
    this.internalAuthToken = internalAuthToken.trim();
    this.timeoutMs = timeoutMs;
  }

  async claimNext(agentInstanceID, waitSeconds = 0) {
    let path = `/internal/v1/agents/${encodeURIComponent(agentInstanceID)}/jobs/claim`;
    if (waitSeconds > 0) path += `?waitSeconds=${encodeURIComponent(String(waitSeconds))}`;
    try {
      const payload = await this.requestJSON(
        "POST",
        path,
        undefined,
        waitSeconds > 0 ? Math.max(this.timeoutMs, (waitSeconds + 5) * 1000) : this.timeoutMs,
      );
      return normalizeJob(payload);
    } catch (err) {
      if (
        err instanceof StationHTTPError &&
        err.statusCode === 404 &&
        errorMessage(err.payload) === "no queued job available"
      ) {
        return null;
      }
      throw err;
    }
  }

  async heartbeat(jobID, result = undefined) {
    return normalizeJob(
      await this.requestJSON(
        "POST",
        `/internal/v1/jobs/${encodeURIComponent(jobID)}/heartbeat`,
        result === undefined ? undefined : { result },
      ),
    );
  }

  async complete(jobID, { status = "completed", result, terminalCode, terminalMessage } = {}) {
    const body = { status };
    if (result !== undefined) body.result = result;
    if (terminalCode) body.terminalCode = terminalCode;
    if (terminalMessage) body.terminalMessage = terminalMessage;
    return normalizeJob(
      await this.requestJSON("POST", `/internal/v1/jobs/${encodeURIComponent(jobID)}/complete`, body, 60000),
    );
  }

  async listCapabilityAssets(context) {
    const query = new URLSearchParams({
      tenantId: context.tenantID,
      organizationId: context.organizationID,
      departmentId: context.departmentID,
      userId: context.userID,
    });
    const payload = await this.requestJSON("GET", `/internal/v1/capability-assets?${query.toString()}`);
    return Array.isArray(payload?.assets) ? payload.assets.filter(isRecord) : [];
  }

  async listVisibleServices(context) {
    if (!this.serviceCatalogURL) return [];
    const query = new URLSearchParams({
      tenantId: context.tenantID,
      organizationId: context.organizationID,
      departmentId: context.departmentID,
      userId: context.userID,
    });
    for (const roleID of context.roleIDs || []) query.append("roleId", roleID);
    const payload = await requestJSON(`${this.serviceCatalogURL}/internal/v1/services?${query.toString()}`, {
      method: "GET",
      timeoutMs: this.timeoutMs,
      headers: {
        ...(this.internalAuthToken ? { "X-Botstation-Internal-Token": this.internalAuthToken } : {}),
      },
    });
    return Array.isArray(payload?.services) ? payload.services.filter(isRecord) : [];
  }

  async importSkillZIP(attachment) {
    if (!this.serviceCatalogURL) throw new Error("service catalog URL is not configured");
    return requestJSON(`${this.serviceCatalogURL}/internal/v1/admin/services/import/skill-zip`, {
      method: "POST",
      payload: {
        fileName: stringValue(attachment?.fileName),
        contentBase64: stringValue(attachment?.contentBase64),
      },
      timeoutMs: 60000,
      headers: {
        ...(this.internalAuthToken ? { "X-Botstation-Internal-Token": this.internalAuthToken } : {}),
      },
    });
  }

  async getAdminService(serviceID) {
    if (!this.serviceCatalogURL) throw new Error("service catalog URL is not configured");
    return requestJSON(`${this.serviceCatalogURL}/internal/v1/admin/services/${encodeURIComponent(serviceID)}`, {
      method: "GET",
      timeoutMs: this.timeoutMs,
      headers: {
        ...(this.internalAuthToken ? { "X-Botstation-Internal-Token": this.internalAuthToken } : {}),
      },
    });
  }

  async listPublicServants(context) {
    const query = new URLSearchParams({
      tenantId: context.tenantID,
      departmentId: context.departmentID,
      userId: context.userID,
    });
    for (const roleID of context.roleIDs || []) query.append("roleId", roleID);
    const payload = await this.requestJSON("GET", `/internal/v1/public-servants?${query.toString()}`);
    return Array.isArray(payload?.publicServants) ? payload.publicServants.filter(isRecord) : [];
  }

  async reportInstalledServices(agentInstanceID, services, { syncStatus = "success", message = "" } = {}) {
    await this.requestJSON("POST", `/internal/v1/agents/${encodeURIComponent(agentInstanceID)}/installed-services`, {
      services,
      syncStatus,
      message,
    });
  }

  async requestJSON(method, path, payload = undefined, timeoutMs = this.timeoutMs) {
    return requestJSON(`${this.stationURL}${path}`, {
      method,
      payload,
      timeoutMs,
      headers: {
        "X-Botstation-Access-Scope": "runtime",
        ...(this.internalAuthToken ? { "X-Botstation-Internal-Token": this.internalAuthToken } : {}),
      },
    });
  }
}

class MessageCenterClient {
  constructor(baseURL, { internalAuthToken = "", context = {} } = {}) {
    this.baseURL = baseURL.replace(/\/+$/, "");
    this.internalAuthToken = internalAuthToken;
    this.context = context;
  }

  async deliver(payload) {
    return requestJSON(`${this.baseURL}/internal/v1/messages/deliver`, {
      method: "POST",
      payload,
      timeoutMs: 30000,
      headers: {
        ...(this.internalAuthToken ? { "X-Botstation-Internal-Token": this.internalAuthToken } : {}),
        "X-Botstation-Tenant-Id": this.context.tenantID || "",
        "X-Botstation-Organization-Id": this.context.organizationID || "",
        "X-Botstation-Department-Id": this.context.departmentID || "",
        "X-Botstation-User-Id": this.context.userID || "",
      },
    });
  }
}

async function requestJSON(url, { method, payload = undefined, timeoutMs = 10000, headers: extraHeaders = {} }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    Accept: "application/json",
    ...extraHeaders,
  };
  let body;
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(payload);
  }
  try {
    const response = await fetch(url, { method, headers, body, signal: controller.signal });
    const text = await response.text();
    const decoded = text ? JSON.parse(text) : {};
    if (!response.ok) throw new StationHTTPError(response.status, decoded);
    return decoded;
  } finally {
    clearTimeout(timer);
  }
}

export async function syncVisibleServices({ bridge, args }) {
  const context = userContextFromArgs(args);
  await mkdir(args.openclaudeConfigDir, { recursive: true });
  const assets = await bridge.listCapabilityAssets(context);
  const catalogServices =
    typeof bridge.listVisibleServices === "function" ? await bridge.listVisibleServices(context) : [];
  const syncAssets = mergeCapabilityAssets(catalogServices.flatMap(catalogServiceToCapabilityAsset), assets);
  const publicServants = await bridge.listPublicServants(context);
  const mcpServers = buildKnowledgeBaseMCPServers(args);
  const pluginBinDirs = [];
  const installed = [];

  for (const asset of syncAssets) {
    if (asset.enabled === false) continue;
    const assetID = stringValue(asset.assetId || asset.name);
    if (!assetID) continue;
    if (typeof asset.skillMarkdown === "string" && asset.skillMarkdown.trim()) {
      const skillDir = join(args.openclaudeConfigDir, "skills", safeSegment(asset.name || assetID));
      await rm(skillDir, { recursive: true, force: true });
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), asset.skillMarkdown.trimEnd() + "\n", "utf8");
      await materializeSkillFiles(skillDir, asset.skillFiles);
    }
    if (isRecord(asset.mcpServers)) Object.assign(mcpServers, asset.mcpServers);
    if (isRecord(asset.pluginSpec)) {
      const pluginState = await installPluginAsset(asset, args.openclaudeConfigDir);
      if (isRecord(pluginState.mcpServers)) Object.assign(mcpServers, pluginState.mcpServers);
      if (pluginState.binDir) pluginBinDirs.push(pluginState.binDir);
    }
    installed.push({
      agentInstanceId: args.agentInstanceID,
      serviceId: stringValue(asset.sourceServiceId || assetID),
      serviceVersion: stringValue(asset.baseServiceVersion || "openclaude"),
      status: "installed",
    });
  }

  const agents = {};
  for (const servant of publicServants) {
    if (servant.enabled === false) continue;
    const id = safeSegment(servant.id || servant.name);
    if (!id) continue;
    agents[id] = {
      description: stringValue(servant.description || servant.name),
      prompt: stringValue(servant.systemPrompt || servant.description || servant.name),
      model: stringValue(servant.model) || undefined,
    };
    for (const cap of Array.isArray(servant.capabilities) ? servant.capabilities : []) {
      if (isRecord(cap?.mcpServers)) Object.assign(mcpServers, cap.mcpServers);
      if (typeof cap?.skillMarkdown === "string" && cap.skillMarkdown.trim()) {
        const skillDir = join(
          args.openclaudeConfigDir,
          "skills",
          safeSegment(`${id}-${cap.name || cap.assetId || "skill"}`),
        );
        await mkdir(skillDir, { recursive: true });
        await writeFile(join(skillDir, "SKILL.md"), cap.skillMarkdown.trimEnd() + "\n", "utf8");
      }
    }
  }

  const settingsPath = join(args.openclaudeConfigDir, "settings.json");
  const settings = await readJSON(settingsPath);
  settings.mcpServers = { ...(isRecord(settings.mcpServers) ? settings.mcpServers : {}), ...mcpServers };
  await writeJSON(settingsPath, settings);
  await writeJSON(join(args.openclaudeConfigDir, ".botstation-openclaude-services.json"), {
    mcpServers,
    agents,
    installed,
    pluginBinDirs: uniqueStrings(pluginBinDirs),
  });
  if (installed.length) {
    await bridge.reportInstalledServices(args.agentInstanceID, installed, {
      message: `synced ${installed.length} OpenClaude service assets`,
    });
  }
  return {
    installedCount: installed.length,
    updatedCount: 0,
    disabledCount: 0,
    publicServantCount: Object.keys(agents).length,
    message: "OpenClaude services synced",
    mcpServers,
    agents,
  };
}

export function buildKnowledgeBaseMCPServers(args) {
  const url = stringValue(args?.knowledgeBaseMCPURL).trim();
  if (!url) return {};
  const context = userContextFromArgs(args || {});
  const headers = {
    ...(stringValue(args?.internalAuthToken).trim()
      ? { "X-Botstation-Internal-Token": stringValue(args.internalAuthToken).trim() }
      : {}),
    ...(stringValue(context.tenantID).trim() ? { "X-Botstation-Tenant-Id": stringValue(context.tenantID).trim() } : {}),
    ...(stringValue(context.organizationID).trim()
      ? { "X-Botstation-Organization-Id": stringValue(context.organizationID).trim() }
      : {}),
    ...(stringValue(context.departmentID).trim()
      ? { "X-Botstation-Department-Id": stringValue(context.departmentID).trim() }
      : {}),
    ...(stringValue(context.userID).trim() ? { "X-Botstation-User-Id": stringValue(context.userID).trim() } : {}),
  };
  const roleIDs = (Array.isArray(context.roleIDs) ? context.roleIDs : [])
    .map((roleID) => stringValue(roleID).trim())
    .filter(Boolean);
  if (roleIDs.length) headers["X-Botstation-Role-Ids"] = roleIDs.join(",");
  return {
    [KNOWLEDGE_BASE_MCP_NAME]: {
      type: "http",
      url,
      headers,
      timeout_seconds: 60,
    },
  };
}

export function prepareMCPServersForJob({ resolved, serviceState, sdk, fetchFn = fetch }) {
  const source = isRecord(serviceState?.mcpServers) ? serviceState.mcpServers : {};
  if (!SUBJECT_CREDIT_PROMPT_PATTERN.test(stringValue(resolved?.prompt))) return source;

  const prepared = { ...source };
  for (const [serverName, serverConfig] of Object.entries(source)) {
    if (!isSubjectCreditMCPServer(serverName, serverConfig)) continue;
    prepared[serverName] = createSubjectCreditMCPProxy({ serverName, serverConfig, sdk, fetchFn });
  }
  return prepared;
}

function isSubjectCreditMCPServer(serverName, serverConfig) {
  if (!isRecord(serverConfig)) return false;
  if (stringValue(serverName).toLowerCase() === SUBJECT_CREDIT_MCP_SERVER_NAME) return true;
  try {
    const url = new URL(stringValue(serverConfig.url));
    return url.port === SUBJECT_CREDIT_MCP_PORT && url.pathname.replace(/\/+$/, "") === "/mcp";
  } catch {
    return false;
  }
}

function createSubjectCreditMCPProxy({ serverName, serverConfig, sdk, fetchFn }) {
  if (typeof sdk?.tool !== "function" || typeof sdk?.createSdkMcpServer !== "function") {
    throw new Error("OpenClaude SDK MCP helpers are unavailable");
  }
  const remoteURL = stringValue(serverConfig.url);
  const headers = isRecord(serverConfig.headers) ? serverConfig.headers : {};
  const requestKey = randomUUID();
  let boundEnterpriseName = "";
  let boundJobID = "";
  let generationResult;
  const requestMeta = () => ({
    botstationRequestKey: requestKey,
    ...(boundEnterpriseName ? { expectedEnterpriseName: boundEnterpriseName } : {}),
  });
  const callRemote = (toolName, args) =>
    callSubjectCreditMCPTool({
      remoteURL,
      headers,
      toolName,
      args,
      requestMeta: requestMeta(),
      fetchFn,
    });
  const tools = [
    sdk.tool(
      "generate_credit_report",
      "Generate a complete subject-credit Word report. Returns a job_id immediately; poll get_job_status until done.",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1, description: "Full enterprise name" },
          year: { type: "integer", description: "Report base year, defaults to 2025" },
          enable_thinking: { type: "boolean", description: "Enable model thinking mode" },
        },
        required: ["name"],
      },
      async (args) => {
        const enterpriseName = stringValue(args?.name).trim();
        if (
          boundEnterpriseName &&
          normalizeEnterpriseName(enterpriseName) !== normalizeEnterpriseName(boundEnterpriseName)
        ) {
          throw new Error(
            `Subject-credit task is already bound to ${boundEnterpriseName}; refusing a second enterprise ${enterpriseName}.`,
          );
        }
        if (generationResult !== undefined) return generationResult;
        boundEnterpriseName = enterpriseName;
        generationResult = await callRemote("generate_credit_report", args);
        boundJobID = subjectCreditJobIDFromMCPResult(generationResult);
        return generationResult;
      },
    ),
    sdk.tool(
      "get_job_status",
      "Poll an asynchronous subject-credit report job until it is done or reaches a terminal error.",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          job_id: { type: "string", minLength: 1, description: "Job ID returned by generate_credit_report" },
        },
        required: ["job_id"],
      },
      (args) =>
        callRemote("get_job_status", {
          ...args,
          job_id: boundJobID || stringValue(args?.job_id).trim(),
        }),
    ),
  ];
  return sdk.createSdkMcpServer({ type: "sdk", name: serverName, tools });
}

function subjectCreditJobIDFromMCPResult(result) {
  const metaJobID = firstNonEmptyString(result?._meta?.job_id, result?._meta?.jobId);
  if (/^[A-Za-z0-9_-]{8,128}$/.test(metaJobID)) return metaJobID;
  const text = extractText(result);
  const match = text.match(/\bJob ID\s*[:=]\s*['"]?([A-Za-z0-9_-]{8,128})/iu);
  return match?.[1] || "";
}

async function callSubjectCreditMCPTool({ remoteURL, headers, toolName, args, requestMeta = {}, fetchFn }) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
    SUBJECT_CREDIT_PROXY_TIMEOUT_MS,
  );
  timer.unref?.();
  try {
    const response = await fetchFn(remoteURL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, stringValue(value)])),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `botstation-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        method: "tools/call",
        params: { name: toolName, arguments: args, _meta: requestMeta },
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Subject-credit MCP returned invalid JSON (${response.status})`);
    }
    if (!response.ok)
      throw new Error(`Subject-credit MCP HTTP ${response.status}: ${stringValue(payload?.detail || text)}`);
    if (isRecord(payload?.error))
      throw new Error(
        `Subject-credit MCP error ${stringValue(payload.error.code)}: ${stringValue(payload.error.message)}`,
      );
    if (!isRecord(payload?.result)) throw new Error("Subject-credit MCP returned no result");
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

export async function materializeSubjectCreditReport({
  resolved,
  serviceState,
  assistantText,
  toolCalls = [],
  beforeFiles = new Set(),
  fetchFn = fetch,
  pollIntervalMs = SUBJECT_CREDIT_POLL_INTERVAL_MS,
  completionTimeoutMs = SUBJECT_CREDIT_COMPLETION_TIMEOUT_MS,
  onProgress = () => undefined,
}) {
  if (!SUBJECT_CREDIT_PROMPT_PATTERN.test(stringValue(resolved?.prompt))) return null;
  const expectedEnterpriseName = subjectCreditEnterpriseName(toolCalls);
  const existing = await collectGeneratedFiles(beforeFiles, resolved.outputDir);
  const existingReports = existing.filter((file) => extname(file.fileName).toLowerCase() === ".docx");
  for (const report of existingReports) {
    if (expectedEnterpriseName && !subjectCreditReportMatchesEnterprise(report.fileName, expectedEnterpriseName)) {
      await quarantineSubjectCreditReport(resolved.outputDir, report.relativePath);
    }
  }
  const existingReport = existingReports.find(
    (file) => !expectedEnterpriseName || subjectCreditReportMatchesEnterprise(file.fileName, expectedEnterpriseName),
  );
  if (existingReport) return join(resolved.outputDir, existingReport.relativePath);

  const candidates = subjectCreditDownloadURLs({ assistantText, toolCalls });
  const connections = subjectCreditMCPConnections(serviceState);
  const allowedOrigins = new Set(connections.map((connection) => connection.origin));
  const allowedCandidates = candidates.filter((candidate) =>
    isAllowedSubjectCreditDownloadURL(candidate, allowedOrigins),
  );
  if (candidates.length && !allowedCandidates.length) {
    throw new JobTerminalError(
      "subject_credit_report_invalid_url",
      "The dedicated subject-credit MCP returned a Word report URL outside its configured origin.",
    );
  }
  let downloadURL = allowedCandidates.find(
    (candidate) =>
      !expectedEnterpriseName ||
      subjectCreditReportMatchesEnterprise(new URL(candidate).pathname, expectedEnterpriseName),
  );
  if (!downloadURL) {
    const jobID = subjectCreditJobID({ assistantText, toolCalls });
    if (!jobID) {
      throw new JobTerminalError(
        "subject_credit_report_missing",
        "The dedicated subject-credit MCP completed without a Word report download URL or recoverable job ID.",
      );
    }
    const job = await waitForSubjectCreditJob({
      jobID,
      connections,
      fetchFn,
      pollIntervalMs,
      completionTimeoutMs,
      onProgress,
      expectedEnterpriseName,
    });
    downloadURL = subjectCreditJobDownloadURL(job, connections[0]?.origin);
    if (!downloadURL) {
      throw new JobTerminalError(
        "subject_credit_report_missing",
        `The dedicated subject-credit MCP job ${jobID} completed without a Word report download URL or output path.`,
      );
    }
    if (!isAllowedSubjectCreditDownloadURL(downloadURL, allowedOrigins)) {
      throw new JobTerminalError(
        "subject_credit_report_invalid_url",
        `The dedicated subject-credit MCP job ${jobID} returned a Word report URL outside its configured origin.`,
      );
    }
  }

  const url = new URL(downloadURL);
  const encodedName = url.pathname.split("/").filter(Boolean).at(-1) || "subject-credit-report.docx";
  let decodedName;
  try {
    decodedName = decodeURIComponent(encodedName);
  } catch {
    decodedName = encodedName;
  }
  const fileName = safeFilename(decodedName);
  if (extname(fileName).toLowerCase() !== ".docx") {
    throw new JobTerminalError(
      "subject_credit_report_invalid_url",
      "The dedicated subject-credit MCP download URL is not a .docx file.",
    );
  }
  if (expectedEnterpriseName && !subjectCreditReportMatchesEnterprise(fileName, expectedEnterpriseName)) {
    throw new JobTerminalError(
      "subject_credit_report_company_mismatch",
      `The dedicated subject-credit MCP returned ${fileName}, which does not match requested enterprise ${expectedEnterpriseName}.`,
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
    SUBJECT_CREDIT_DOWNLOAD_TIMEOUT_MS,
  );
  timer.unref?.();
  const target = join(resolved.outputDir, fileName);
  const temporary = join(resolved.outputDir, `.${fileName}.${process.pid}.${Date.now()}.tmp`);
  try {
    const connection = connections.find((item) => item.origin === url.origin);
    const response = await fetchFn(url, {
      headers: {
        Accept: "application/vnd.openxmlformats-officedocument.wordprocessingml.document, application/octet-stream",
        ...connection?.headers,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new JobTerminalError(
        "subject_credit_report_download_failed",
        `Subject-credit Word report download failed with HTTP ${response.status}.`,
      );
    }
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > SUBJECT_CREDIT_MAX_REPORT_BYTES) {
      throw new JobTerminalError(
        "subject_credit_report_too_large",
        "The subject-credit Word report exceeds the 100 MB download limit.",
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > SUBJECT_CREDIT_MAX_REPORT_BYTES) {
      throw new JobTerminalError(
        "subject_credit_report_too_large",
        "The subject-credit Word report exceeds the 100 MB download limit.",
      );
    }
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
      throw new JobTerminalError(
        "subject_credit_report_invalid_file",
        "The dedicated subject-credit MCP download is not a valid Office ZIP file.",
      );
    }
    await writeFile(temporary, bytes);
    await rename(temporary, target);
    return target;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (error instanceof JobTerminalError) throw error;
    throw new JobTerminalError(
      "subject_credit_report_download_failed",
      `Failed to download the subject-credit Word report: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function subjectCreditEnterpriseName(toolCalls) {
  for (const toolCall of Array.isArray(toolCalls) ? toolCalls : []) {
    if (stringValue(toolCall?.toolName) !== "generate_credit_report" || toolCall?.isError) continue;
    const enterpriseName = stringValue(toolCall?.toolInput?.name).trim();
    if (enterpriseName) return enterpriseName;
  }
  return "";
}

function normalizeEnterpriseName(value) {
  return stringValue(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function subjectCreditReportMatchesEnterprise(fileName, enterpriseName) {
  const expected = normalizeEnterpriseName(enterpriseName);
  if (!expected) return true;
  let decoded = stringValue(fileName);
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep the original value when a URL path contains malformed escapes.
  }
  return normalizeEnterpriseName(basename(decoded, extname(decoded))).startsWith(expected);
}

async function quarantineSubjectCreditReport(outputDir, relativePath) {
  const source = join(outputDir, relativePath);
  const rejectedDir = join(outputDir, ".rejected-subject-credit");
  await mkdir(rejectedDir, { recursive: true });
  let target = join(rejectedDir, basename(source));
  if (existsSync(target)) target = join(rejectedDir, `${Date.now()}-${basename(source)}`);
  await rename(source, target);
}

function subjectCreditJobID({ assistantText, toolCalls }) {
  for (const toolCall of Array.isArray(toolCalls) ? toolCalls : []) {
    const direct = firstNonEmptyString(toolCall?.toolInput?.job_id, toolCall?.toolInput?.jobId);
    if (/^[A-Za-z0-9_-]{8,128}$/.test(direct)) return direct;
  }
  const texts = [stringValue(assistantText)];
  for (const toolCall of Array.isArray(toolCalls) ? toolCalls : []) {
    texts.push(stringValue(toolCall?.output));
    if (isRecord(toolCall?.toolInput)) texts.push(JSON.stringify(toolCall.toolInput));
  }
  const patterns = [
    /\bJob ID\s*[:=]\s*['"]?([A-Za-z0-9_-]{8,128})/iu,
    /["']job_id["']\s*:\s*["']([A-Za-z0-9_-]{8,128})["']/iu,
    /\/jobs\/([A-Za-z0-9_-]{8,128})/iu,
  ];
  for (const text of texts) {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[1];
    }
  }
  return "";
}

async function waitForSubjectCreditJob({
  jobID,
  connections,
  fetchFn,
  pollIntervalMs,
  completionTimeoutMs,
  onProgress,
  expectedEnterpriseName = "",
}) {
  const connection = connections[0];
  if (!connection) {
    throw new JobTerminalError(
      "subject_credit_report_invalid_url",
      "The dedicated subject-credit MCP server is not configured.",
    );
  }
  const deadline = Date.now() + Math.max(Number(completionTimeoutMs) || SUBJECT_CREDIT_COMPLETION_TIMEOUT_MS, 1);
  let latestStatus = "";
  while (Date.now() <= deadline) {
    const job = await fetchSubjectCreditJobStatus({ jobID, connection, fetchFn });
    const actualEnterpriseName = stringValue(job.enterprise_name || job.enterpriseName).trim();
    if (
      expectedEnterpriseName &&
      actualEnterpriseName &&
      normalizeEnterpriseName(actualEnterpriseName) !== normalizeEnterpriseName(expectedEnterpriseName)
    ) {
      throw new JobTerminalError(
        "subject_credit_report_company_mismatch",
        `Subject-credit MCP job ${jobID} belongs to ${actualEnterpriseName}, not requested enterprise ${expectedEnterpriseName}.`,
      );
    }
    latestStatus = stringValue(job.status).trim().toLowerCase();
    const progress = Number(job.progress);
    const phase = stringValue(job.current_phase || job.currentPhase).trim();
    onProgress(
      [
        `Subject-credit MCP job ${jobID}: ${latestStatus || "running"}`,
        Number.isFinite(progress) ? `${progress}%` : "",
        phase,
      ]
        .filter(Boolean)
        .join(" - "),
    );
    if (latestStatus === "done" || latestStatus === "completed" || latestStatus === "success") return job;
    if (["failed", "error", "cancelled", "canceled", "stopped", "timeout"].includes(latestStatus)) {
      const reason = firstNonEmptyString(job.error, job.message, job.detail) || `status ${latestStatus}`;
      throw new JobTerminalError(
        "subject_credit_report_failed",
        `The dedicated subject-credit MCP job ${jobID} failed: ${reason}`,
      );
    }
    await sleep(Math.max(Number(pollIntervalMs) || SUBJECT_CREDIT_POLL_INTERVAL_MS, 1));
  }
  throw new JobTerminalError(
    "subject_credit_report_timeout",
    `Timed out waiting for dedicated subject-credit MCP job ${jobID}${latestStatus ? ` (last status: ${latestStatus})` : ""}.`,
  );
}

async function fetchSubjectCreditJobStatus({ jobID, connection, fetchFn }) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
    SUBJECT_CREDIT_PROXY_TIMEOUT_MS,
  );
  timer.unref?.();
  try {
    const url = new URL(`/jobs/${encodeURIComponent(jobID)}`, connection.origin);
    const response = await fetchFn(url, {
      headers: { Accept: "application/json", ...connection.headers },
      signal: controller.signal,
    });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new JobTerminalError(
        "subject_credit_report_status_failed",
        `Subject-credit MCP job status returned invalid JSON (${response.status}).`,
      );
    }
    if (!response.ok) {
      throw new JobTerminalError(
        "subject_credit_report_status_failed",
        `Subject-credit MCP job status failed with HTTP ${response.status}.`,
      );
    }
    if (!isRecord(payload)) {
      throw new JobTerminalError(
        "subject_credit_report_status_failed",
        "Subject-credit MCP job status returned no object.",
      );
    }
    return payload;
  } catch (error) {
    if (error instanceof JobTerminalError) throw error;
    throw new JobTerminalError(
      "subject_credit_report_status_failed",
      `Failed to read subject-credit MCP job status: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function subjectCreditJobDownloadURL(job, origin) {
  const direct = stringValue(job?.download_url || job?.downloadURL).trim();
  if (direct) return direct;
  const outputPath = stringValue(job?.output_path || job?.outputPath).trim();
  const fileName = basename(outputPath);
  if (!origin || extname(fileName).toLowerCase() !== ".docx") return "";
  return new URL(`/downloads/${encodeURIComponent(fileName)}`, origin).toString();
}

function subjectCreditDownloadURLs({ assistantText, toolCalls }) {
  const texts = [stringValue(assistantText)];
  for (const toolCall of Array.isArray(toolCalls) ? toolCalls : []) texts.push(stringValue(toolCall?.output));
  const urls = [];
  const seen = new Set();
  const pattern = /https?:\/\/[^\s<>"']+?\.docx(?:\?[^\s<>"']*)?/giu;
  for (const text of texts) {
    for (const match of text.matchAll(pattern)) {
      const candidate = match[0].replace(/[),.;:!?\]}]+$/g, "");
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      urls.push(candidate);
    }
  }
  return urls;
}

function subjectCreditMCPConnections(serviceState) {
  const connections = [];
  const servers = isRecord(serviceState?.mcpServers) ? serviceState.mcpServers : {};
  for (const [serverName, serverConfig] of Object.entries(servers)) {
    if (!isSubjectCreditMCPServer(serverName, serverConfig)) continue;
    try {
      connections.push({
        origin: new URL(stringValue(serverConfig.url)).origin,
        headers: isRecord(serverConfig.headers)
          ? Object.fromEntries(Object.entries(serverConfig.headers).map(([key, value]) => [key, stringValue(value)]))
          : {},
      });
    } catch {
      // Invalid MCP configuration is handled by the normal MCP connection path.
    }
  }
  return connections;
}

function isAllowedSubjectCreditDownloadURL(candidate, allowedOrigins) {
  try {
    const url = new URL(candidate);
    return (
      allowedOrigins.has(url.origin) &&
      url.pathname.startsWith("/downloads/") &&
      extname(url.pathname).toLowerCase() === ".docx"
    );
  } catch {
    return false;
  }
}

function catalogServiceToCapabilityAsset(service) {
  if (!isRecord(service) || stringValue(service.status) !== "published") return [];
  const serviceType = stringValue(service.serviceType).toLowerCase();
  const installSpec = isRecord(service.installSpec) ? service.installSpec : {};
  const serviceID = stringValue(service.serviceId);
  if (!serviceID) return [];
  const asset = {
    assetId: `catalog-${serviceID}`,
    assetKind: "catalog_published",
    sourceServiceId: serviceID,
    baseServiceVersion: stringValue(service.currentVersion || service.version || "catalog"),
    name: stringValue(service.name || serviceID),
    description: stringValue(service.description),
    enabled: true,
  };
  if (serviceType === "skill") {
    const skill = isRecord(installSpec.skill) ? installSpec.skill : {};
    const skillMarkdown = firstString(skill, "content", "markdown", "skillMarkdown");
    if (!skillMarkdown) return [];
    return [
      { ...asset, capabilityType: "skill", skillMarkdown, skillFiles: Array.isArray(skill.files) ? skill.files : [] },
    ];
  }
  if (serviceType === "mcp") {
    const mcpServers = isRecord(installSpec.mcpServers) ? installSpec.mcpServers : {};
    if (!Object.keys(mcpServers).length) return [];
    return [{ ...asset, capabilityType: "mcp", mcpServers }];
  }
  if (serviceType === "plugin") {
    const pluginSpec = isRecord(installSpec.plugin) ? installSpec.plugin : {};
    const pluginName = firstString(pluginSpec, "name") || serviceID;
    if (!pluginName) return [];
    return [{ ...asset, capabilityType: "plugin", name: pluginName, pluginSpec }];
  }
  return [];
}

async function installPluginAsset(asset, openclaudeConfigDir) {
  const spec = isRecord(asset.pluginSpec) ? asset.pluginSpec : {};
  const pluginName = firstString(spec, "name") || stringValue(asset.name || asset.assetId);
  const pluginSegment = safeSegment(pluginName);
  const pluginRoot = join(openclaudeConfigDir, "plugins", pluginSegment);
  const binDir = join(pluginRoot, "bin");
  await mkdir(pluginRoot, { recursive: true });

  const pluginManifest = {
    name: pluginName,
    version: firstString(spec, "version") || stringValue(asset.baseServiceVersion || "0.1.0"),
    description: firstString(spec, "description") || stringValue(asset.description),
    skills: Array.isArray(spec.skills) && spec.skills.length ? "./skills/" : undefined,
    interface: {
      displayName: firstString(spec, "displayName") || stringValue(asset.name || pluginName),
      shortDescription: firstString(spec, "description") || stringValue(asset.description),
      longDescription: firstString(spec, "description") || stringValue(asset.description),
      developerName: firstString(spec, "developerName") || "BotStation",
      category: firstString(spec, "category") || "Developer Tools",
      capabilities: ["Database", "CLI"],
    },
  };
  await writeJSON(join(pluginRoot, "plugin.json"), stripUndefined(pluginManifest));

  for (const file of Array.isArray(spec.files) ? spec.files : []) {
    if (!isRecord(file)) continue;
    const relPath = firstString(file, "path");
    if (!relPath) continue;
    const target = resolvePluginPath(pluginRoot, relPath);
    const content =
      typeof file.content === "string"
        ? file.content
        : typeof file.contentBase64 === "string"
          ? Buffer.from(file.contentBase64, "base64")
          : "";
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, typeof content === "string" ? "utf8" : undefined);
    if (file.executable === true || /^0?755$/.test(stringValue(file.mode))) await chmod(target, 0o755);
  }

  for (const skill of Array.isArray(spec.skills) ? spec.skills : []) {
    if (!isRecord(skill)) continue;
    const skillName = firstString(skill, "name") || `${pluginName}-skill`;
    const content = firstString(skill, "content", "markdown", "skillMarkdown");
    if (!content) continue;
    const localSkillDir = join(pluginRoot, "skills", safeSegment(skillName));
    await mkdir(localSkillDir, { recursive: true });
    await writeFile(join(localSkillDir, "SKILL.md"), content.trimEnd() + "\n", "utf8");
    const runtimeSkillDir = join(openclaudeConfigDir, "skills", safeSegment(skillName));
    await mkdir(runtimeSkillDir, { recursive: true });
    await writeFile(join(runtimeSkillDir, "SKILL.md"), content.trimEnd() + "\n", "utf8");
  }

  const commands = Array.isArray(spec.commands) ? spec.commands : [];
  for (const command of commands) {
    if (!isRecord(command)) continue;
    const rawCommandName = firstString(command, "name");
    const commandName = rawCommandName ? safeSegment(rawCommandName) : "";
    const commandPath = firstString(command, "path", "script", "commandPath");
    if (!commandName || !commandPath) continue;
    resolvePluginPath(pluginRoot, commandPath);
    await mkdir(binDir, { recursive: true });
    const wrapper = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      'PLUGIN_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"',
      `TARGET_REL=${shellQuote(commandPath)}`,
      'exec node "${PLUGIN_DIR}/${TARGET_REL}" "$@"',
      "",
    ].join("\n");
    const wrapperPath = join(binDir, commandName);
    await writeFile(wrapperPath, wrapper, "utf8");
    await chmod(wrapperPath, 0o755);
  }

  return {
    mcpServers: isRecord(spec.mcpServers) ? spec.mcpServers : {},
    binDir: commands.length ? binDir : "",
  };
}

function mergeCapabilityAssets(catalogAssets, userAssets) {
  const merged = new Map();
  for (const asset of catalogAssets) {
    merged.set(capabilityAssetMergeKey(asset), asset);
  }
  for (const asset of userAssets) {
    merged.set(capabilityAssetMergeKey(asset), asset);
  }
  return [...merged.values()];
}

function capabilityAssetMergeKey(asset) {
  return stringValue(asset.sourceServiceId || asset.assetId || asset.name).toLowerCase();
}

export function isAdminbotSkillZIPInstall(job, args) {
  if (!args?.adminbot) return false;
  const payload = isRecord(job?.payload) ? job.payload : {};
  const prompt = firstString(payload, "prompt");
  if (!ADMINBOT_SKILL_INSTALL_ACTION_PATTERN.test(prompt) || !ADMINBOT_SKILL_INSTALL_TARGET_PATTERN.test(prompt))
    return false;
  return Array.isArray(payload.attachments) && payload.attachments.some(isSkillZIPAttachment);
}

function isSkillZIPAttachment(attachment) {
  if (!isRecord(attachment)) return false;
  const fileName = stringValue(attachment.fileName).trim().toLowerCase();
  const contentType = stringValue(attachment.contentType).trim().toLowerCase();
  return (
    fileName.endsWith(".zip") || contentType === "application/zip" || contentType === "application/x-zip-compressed"
  );
}

export async function executeAdminbotSkillZIPImport(job, { bridge }) {
  const payload = isRecord(job?.payload) ? job.payload : {};
  const attachments = Array.isArray(payload.attachments) ? payload.attachments.filter(isSkillZIPAttachment) : [];
  const imports = [];
  const failures = [];

  for (const attachment of attachments) {
    const fileName = stringValue(attachment?.fileName) || "skill.zip";
    try {
      if (!stringValue(attachment?.contentBase64)) throw new Error("attachment content is missing");
      const imported = await bridge.importSkillZIP(attachment);
      const service = isRecord(imported?.service) ? imported.service : {};
      const version = isRecord(imported?.version) ? imported.version : {};
      const serviceID = stringValue(service.serviceId);
      const versionID = stringValue(version.version);
      if (!serviceID || !versionID) throw new Error("service catalog returned an incomplete import response");
      const verified = await bridge.getAdminService(serviceID);
      if (stringValue(verified?.serviceId) !== serviceID || stringValue(verified?.currentVersion) !== versionID) {
        throw new Error(`service catalog verification failed for ${serviceID}`);
      }
      imports.push({
        fileName,
        serviceId: serviceID,
        name: stringValue(service.name || verified.name || serviceID),
        version: versionID,
        status: stringValue(verified.status || service.status || version.status),
        idempotent: imported?.idempotent === true,
        packageSha256: stringValue(imported?.packageSha256),
        resourceFileCount: Number(imported?.resourceFileCount || 0),
      });
    } catch (err) {
      failures.push({
        fileName,
        code: capabilityImportErrorCode(err),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const status = imports.length === 0 ? "failed" : failures.length ? "partial" : "completed";
  const assistantText = capabilityImportAssistantText(status, imports, failures);
  const result = {
    mode: "capability_import",
    status,
    requestId: stringValue(job?.requestId),
    assistantText,
    imports,
    failures,
  };
  if (imports.length === 0) {
    throw new JobTerminalError("capability_import_failed", failures[0]?.message || "no Skill ZIP could be imported", {
      result,
    });
  }
  return result;
}

function capabilityImportErrorCode(err) {
  if (err instanceof StationHTTPError) {
    if (err.statusCode === 400) return "invalid_skill_zip";
    if (err.statusCode === 401 || err.statusCode === 403) return "capability_import_unauthorized";
    return "service_catalog_error";
  }
  return "capability_import_error";
}

function capabilityImportAssistantText(status, imports, failures) {
  const lines = [];
  if (status === "completed") lines.push(`已将 ${imports.length} 个 Skill ZIP 导入能力管理。`);
  else if (status === "partial")
    lines.push(`Skill ZIP 部分导入成功：成功 ${imports.length} 个，失败 ${failures.length} 个。`);
  else lines.push("Skill ZIP 导入能力管理失败。");
  for (const item of imports) {
    const repeated = item.idempotent ? "（相同包已存在，未重复创建版本）" : "";
    lines.push(
      `- ${item.fileName}：${item.name}，serviceId=${item.serviceId}，${item.status} ${item.version}，资源文件 ${item.resourceFileCount} 个${repeated}`,
    );
  }
  for (const item of failures) lines.push(`- ${item.fileName}：失败，${item.message}`);
  if (imports.length)
    lines.push(
      "导入结果保持为草稿，未自动发布。请在能力管理中审核并发布；发布后系统会同步符合授权范围的 staff-agent。",
    );
  return lines.join("\n");
}

export async function executeJob(job, { bridge, args }) {
  if (job.jobType === "service_sync") {
    const result = await syncVisibleServices({ bridge, args });
    return {
      mode: "service_sync",
      jobType: "service_sync",
      requestId: job.requestId,
      installedCount: result.installedCount,
      updatedCount: result.updatedCount,
      disabledCount: result.disabledCount,
      publicServantCount: result.publicServantCount,
      message: result.message,
    };
  }
  if (job.jobType === "message_delivery") {
    return deliverMessage(job, args);
  }
  if (job.jobType === "service_invocation") {
    return executeServiceInvocation(job, { bridge, args });
  }
  if (job.jobType !== "interactive" && job.jobType !== "prompt") {
    throw new JobTerminalError("unsupported_job_type", `unsupported job type: ${job.jobType}`);
  }
  if (isAdminbotSkillZIPInstall(job, args)) {
    return executeAdminbotSkillZIPImport(job, { bridge, args });
  }
  await syncVisibleServices({ bridge, args });
  return executePromptJob(job, { bridge, args });
}

async function deliverMessage(job, args) {
  const payload = isRecord(job.payload) ? job.payload : {};
  if (!Array.isArray(payload.recipients) || payload.recipients.length === 0) {
    throw new JobTerminalError("message_validation_failed", "payload.recipients must be a non-empty array");
  }
  if (!firstString(payload, "subject")) {
    throw new JobTerminalError("message_validation_failed", "payload.subject is required");
  }
  if (!firstString(payload, "body")) {
    throw new JobTerminalError("message_validation_failed", "payload.body is required");
  }
  const client = new MessageCenterClient(args.messageCenterURL, {
    internalAuthToken: args.internalAuthToken,
    context: userContextFromArgs(args),
  });
  const response = await client.deliver({
    senderAgentInstanceId: args.agentInstanceID,
    recipients: payload.recipients.filter(isRecord),
    externalRecipients: Array.isArray(payload.externalRecipients) ? payload.externalRecipients : undefined,
    senderMailAccountId: firstString(payload, "senderMailAccountId"),
    subject: firstString(payload, "subject"),
    body: firstString(payload, "body"),
    attachments: Array.isArray(payload.attachments) ? payload.attachments.filter(isRecord) : [],
  });
  return {
    mode: "message_delivery",
    message: response.message,
    requestId: job.requestId,
  };
}

async function executeServiceInvocation(job, { bridge, args }) {
  const payload = isRecord(job.payload) ? job.payload : {};
  const serviceID = firstString(payload, "serviceId");
  if (!serviceID) throw new JobTerminalError("service_validation_failed", "payload.serviceId is required");
  const inputs = isRecord(payload.inputs) ? payload.inputs : null;
  if (!inputs) throw new JobTerminalError("service_validation_failed", "payload.inputs must be an object");
  const context = userContextFromArgs(args);
  const assets = await bridge.listCapabilityAssets(context);
  const service = assets.find((asset) =>
    [asset.sourceServiceId, asset.assetId, asset.name].map(stringValue).includes(serviceID),
  );
  if (!service) throw new JobTerminalError("service_not_synced", `service ${serviceID} is not synced for this agent`);
  const template = stringValue(service.effectivePromptTemplate);
  if (!template.trim()) {
    throw new JobTerminalError(
      "unsupported_service_invocation_type",
      `service ${serviceID} is not a prompt-template capability`,
    );
  }
  const renderedPrompt = renderTemplate(template, inputs);
  const outputDir =
    firstString(payload, "outputDir", "output_dir") ||
    join(
      resolve(args.cwd),
      ".botstation",
      "agents",
      safeSegment(args.agentInstanceID),
      "outputs",
      safeSegment(job.id || "job"),
    );
  const promptJob = {
    ...job,
    jobType: "interactive",
    payload: {
      ...payload,
      prompt: renderedPrompt,
      outputDir,
      appendSystemPrompt: [
        firstString(payload, "appendSystemPrompt", "append_system_prompt"),
        `Service invocation ${serviceID}. Write generated artifacts under: ${outputDir}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  };
  const result = await executePromptJob(promptJob, { bridge, args });
  delete result.prompt;
  result.mode = "service_invocation";
  result.jobType = "service_invocation";
  result.serviceId = serviceID;
  result.serviceVersion = stringValue(service.baseServiceVersion || service.serviceVersion || "openclaude");
  result.requestId = firstString(payload, "requestId") || job.requestId;
  return result;
}

export async function executePromptJob(job, { bridge, args, queryFn }) {
  const resolved = resolveJob(job, args);
  await mkdir(resolved.outputDir, { recursive: true });
  const beforeFiles = await snapshotFiles(resolved.outputDir);
  const attachments = await materializeAttachments(job.payload?.attachments, resolved.cwd, job.id);
  const prompt = buildPrompt(resolved, attachments, args);
  const heartbeat = (result) => bridge.heartbeat(job.id, result).catch(() => undefined);
  const progress = new ProgressReporter((result) => heartbeat(result));

  if (STARTUP_FAKE_RESPONSE) {
    const assistantText = STARTUP_FAKE_RESPONSE;
    return finalizeResult({ resolved, assistantText, beforeFiles, statusEvents: ["fake response"] });
  }

  const serviceState = await readJSON(join(args.openclaudeConfigDir, ".botstation-openclaude-services.json"));
  const mergedEnv = runtimeEnvironmentOverrides(resolved, serviceState, process.env);
  const permissionArgs = {
    ...args,
    knowledgeBaseStrictMode: isKnowledgeBaseStrictPrompt(resolved.prompt),
  };
  const toolGuard = createRuntimeToolGuard({ args: permissionArgs, jobID: job.id });
  let queryRunner = queryFn;
  let mcpServers = isRecord(serviceState.mcpServers) ? serviceState.mcpServers : undefined;
  if (!queryRunner) {
    const sdk = await import("@gitlawb/openclaude/sdk");
    queryRunner = sdk.query;
    mcpServers = prepareMCPServersForJob({ resolved, serviceState, sdk });
  }
  const envRestore = applyTemporaryEnv(mergedEnv);
  const queryLifecycle = createQueryLifecycle();
  activeQueryLifecycles.add(queryLifecycle);
  let stream;
  try {
    stream = queryRunner({
      prompt,
      options: {
        cwd: resolved.cwd,
        abortController: queryLifecycle.controller,
        model: resolved.model || undefined,
        permissionMode: normalizePermissionMode(resolved.permissionMode),
        includePartialMessages: true,
        systemPrompt: resolved.systemPrompt ? { type: "custom", content: resolved.systemPrompt } : undefined,
        mcpServers,
        agents: isRecord(serviceState.agents) ? serviceState.agents : undefined,
        env: mergedEnv,
        canUseTool: (name, input) => toolGuard.decide(name, input),
        stderr: (line) => progress.add(String(line)),
      },
    });
    queryLifecycle.attach(stream);

    const assistantMessages = [];
    const statusEvents = [];
    const toolCalls = new Map();
    const backgroundTasks = new Map();
    let assistantText = "";
    let usage = {};
    let structuredPayload = null;
    let sessionID = "";
    const startedAt = Date.now();

    for await (const message of stream) {
      sessionID = stringValue(message?.session_id || message?.sessionId || sessionID);
      consumeSDKMessage(message, {
        assistantMessages,
        statusEvents,
        toolCalls,
        backgroundTasks,
        onText: (text) => {
          assistantText += text;
          progress.add(text);
        },
      });
      if (message?.type === "result") {
        if (typeof message.result === "string" && message.result.trim()) assistantText = message.result;
        usage = normalizeUsage(message.usage);
        if (isRecord(message.structured_output)) structuredPayload = message.structured_output;
      }
    }

    const settledBackground = await settleBackgroundTasks({
      backgroundTasks,
      progress,
      args,
      resolved,
      sessionID,
    });
    const finalBackgroundTasks = settledBackground.backgroundTasks;
    const finalAssistantText = appendBackgroundTaskSummary(
      assistantText.trim() || assistantMessages.at(-1) || "",
      finalBackgroundTasks,
    );
    await materializeSubjectCreditReport({
      resolved,
      serviceState,
      assistantText: finalAssistantText,
      toolCalls: [...toolCalls.values()],
      beforeFiles,
      onProgress: (message) => progress.add(message),
    });
    const result = await finalizeResult({
      resolved,
      assistantText: finalAssistantText,
      assistantMessages,
      toolCalls: [...toolCalls.values()],
      statusEvents,
      usage,
      structuredPayload,
      beforeFiles,
      sessionID,
      timings: { totalMs: Date.now() - startedAt, backgroundWaitMs: settledBackground.backgroundWaitMs },
      backgroundTasks: finalBackgroundTasks,
    });
    await progress.flush(result);
    const failedTask = finalBackgroundTasks.find((task) => BACKGROUND_TASK_FAILED_STATUSES.has(task.status));
    if (failedTask) {
      throw new JobTerminalError(
        failedTask.status === "timeout" ? "background_task_timeout" : "background_task_failed",
        backgroundTaskFailureMessage(failedTask),
        { result },
      );
    }
    return result;
  } finally {
    queryLifecycle.detach();
    activeQueryLifecycles.delete(queryLifecycle);
    await toolGuard.cleanup().catch(() => undefined);
    envRestore();
  }
}

export function createQueryLifecycle() {
  const controller = new AbortController();
  let query = null;
  return {
    controller,
    attach(nextQuery) {
      query = nextQuery;
    },
    detach() {
      query = null;
    },
    abort(reason = "runtime shutdown") {
      if (!controller.signal.aborted) {
        controller.abort(reason);
      }
      try {
        query?.interrupt?.();
      } catch {
        // Continue to close even when the SDK interrupt hook fails.
      }
      try {
        query?.close?.();
      } catch {
        // The process-group fallback in agent-station remains the last resort.
      }
    },
  };
}

export function abortActiveQueries(reason = "runtime shutdown") {
  for (const lifecycle of activeQueryLifecycles) {
    lifecycle.abort(reason);
  }
}

export function installShutdownHandlers(processRef = process) {
  shutdownRequested = false;
  const handler = (signal) => {
    shutdownRequested = true;
    abortActiveQueries(signal);
  };
  processRef.once("SIGINT", handler);
  processRef.once("SIGTERM", handler);
  return () => {
    processRef.removeListener("SIGINT", handler);
    processRef.removeListener("SIGTERM", handler);
  };
}

export function resolveJob(job, args) {
  const payload = isRecord(job.payload) ? job.payload : {};
  const prompt = firstString(payload, "prompt");
  if (!prompt) throw new JobTerminalError("payload_validation_failed", "job payload.prompt is required");
  const baseCwd = resolve(args.cwd || process.cwd());
  const rawCwd = firstString(payload, "cwd");
  const cwd = rawCwd ? resolveWorkspacePath(baseCwd, rawCwd, "cwd") : baseCwd;
  const rawOutputDir = firstString(payload, "outputDir", "output_dir");
  const outputDir = rawOutputDir
    ? resolveWorkspacePath(baseCwd, rawOutputDir, "outputDir")
    : join(
        baseCwd,
        ".botstation",
        "agents",
        safeSegment(args.agentInstanceID || "runtime"),
        "outputs",
        safeSegment(job.id || "job"),
      );
  if (firstString(payload, "permissionMode", "permission_mode")) {
    throw new JobTerminalError("payload_validation_failed", "job payload.permissionMode is controlled by the runtime");
  }
  return {
    prompt,
    cwd,
    model: firstString(payload, "model") || args.model || "",
    baseURL: firstString(payload, "baseUrl", "base_url") || args.baseURL || "",
    apiFormat: firstString(payload, "apiFormat", "api_format") || args.apiFormat || "openai",
    activeProfile: firstString(payload, "activeProfile", "active_profile") || args.activeProfile || "",
    apiKey:
      firstString(payload, "apiKey", "api_key") || apiKeyFromEnv(firstString(payload, "apiKeyEnv", "api_key_env")),
    permissionMode: args.permissionMode || "",
    systemPrompt: firstString(payload, "systemPrompt", "system_prompt") || "",
    appendSystemPrompt: firstString(payload, "appendSystemPrompt", "append_system_prompt") || "",
    outputDir,
    knowledgeBaseMCPURL: args.knowledgeBaseMCPURL || "",
    contextMessages: Array.isArray(payload.contextMessages || payload.context_messages)
      ? payload.contextMessages || payload.context_messages
      : [],
    staffMemoryEntries: Array.isArray(payload.staffMemoryEntries || payload.staff_memory_entries)
      ? payload.staffMemoryEntries || payload.staff_memory_entries
      : [],
    contextMeta: isRecord(payload.contextMeta || payload.context_meta)
      ? payload.contextMeta || payload.context_meta
      : null,
    platformContext: isRecord(payload.platformContext || payload.platform_context)
      ? payload.platformContext || payload.platform_context
      : null,
    userContext: firstString(payload, "userContext", "user_context") || "",
  };
}

export function buildPrompt(resolved, attachments, args = {}) {
  const blocks = [];
  blocks.push(`<platform_instructions>\n${OPENCLAUDE_DEFERRED_TOOL_INSTRUCTIONS}\n</platform_instructions>`);
  if (args.adminbot)
    blocks.push(`<platform_instructions>\n${ADMINBOT_CAPABILITY_INSTALL_INSTRUCTIONS}\n</platform_instructions>`);
  if (resolved.knowledgeBaseMCPURL)
    blocks.push(`<platform_instructions>\n${KNOWLEDGE_BASE_PRIORITY_INSTRUCTIONS}\n</platform_instructions>`);
  if (resolved.appendSystemPrompt)
    blocks.push(`<platform_instructions>\n${resolved.appendSystemPrompt}\n</platform_instructions>`);
  if (resolved.contextMessages.length)
    blocks.push(
      `<conversation_context>\n${JSON.stringify(resolved.contextMessages, null, 2)}\n</conversation_context>`,
    );
  if (resolved.staffMemoryEntries.length)
    blocks.push(`<staff_memory>\n${JSON.stringify(resolved.staffMemoryEntries, null, 2)}\n</staff_memory>`);
  if (resolved.contextMeta)
    blocks.push(`<context_meta>\n${JSON.stringify(resolved.contextMeta, null, 2)}\n</context_meta>`);
  if (resolved.platformContext)
    blocks.push(`<platform_context>\n${JSON.stringify(resolved.platformContext, null, 2)}\n</platform_context>`);
  if (resolved.userContext) blocks.push(`<user_context>\n${resolved.userContext}\n</user_context>`);
  if (attachments.paths.length)
    blocks.push(`Attachments are available at:\n${attachments.paths.map((item) => `- ${item}`).join("\n")}`);
  if (attachments.extractedRoots.length)
    blocks.push(
      `Extracted attachment directories:\n${attachments.extractedRoots.map((item) => `- ${item}`).join("\n")}`,
    );
  blocks.push(`Write any generated artifacts under: ${resolved.outputDir}`);
  blocks.push(resolved.prompt);
  if (SUBJECT_CREDIT_PROMPT_PATTERN.test(resolved.prompt)) {
    blocks.push(`<platform_instructions>\n${SUBJECT_CREDIT_MCP_INSTRUCTIONS}\n</platform_instructions>`);
  }
  return blocks.join("\n\n");
}

export async function finalizeResult({
  resolved,
  assistantText,
  assistantMessages = [],
  toolCalls = [],
  statusEvents = [],
  usage = {},
  structuredPayload = null,
  beforeFiles = new Set(),
  sessionID = "",
  timings = {},
  backgroundTasks = [],
}) {
  let generatedFiles = await collectGeneratedFiles(beforeFiles, resolved.outputDir);
  if (
    !generatedFiles.length &&
    !SUBJECT_CREDIT_PROMPT_PATTERN.test(stringValue(resolved.prompt)) &&
    shouldWriteAssistantArtifact(resolved.prompt, assistantText)
  ) {
    await writeFile(join(resolved.outputDir, "task-output.md"), assistantText.trimEnd() + "\n", "utf8");
    generatedFiles = await collectGeneratedFiles(beforeFiles, resolved.outputDir);
  }
  if (generatedFiles.length) await writeJSON(join(resolved.outputDir, "manifest.json"), { files: generatedFiles });
  const result = {
    mode: "openclaude",
    prompt: resolved.prompt,
    cwd: resolved.cwd,
    model: resolved.model,
    assistantText,
    structuredPayload,
    assistantMessages: assistantMessages.length ? assistantMessages : assistantText ? [assistantText] : [],
    toolCalls,
    recommendedSkills: [],
    statusEvents,
    usage: { inputTokens: usage.inputTokens || 0, outputTokens: usage.outputTokens || 0 },
    restoredMessages: [{ role: "assistant", text: assistantText, sessionId: sessionID }].filter((item) => item.text),
    contextMeta: resolved.contextMeta || undefined,
    timings,
  };
  if (generatedFiles.length) result.generatedFiles = generatedFiles;
  if (backgroundTasks.length) result.backgroundTasks = backgroundTasks;
  return result;
}

function shouldWriteAssistantArtifact(prompt, assistantText) {
  const text = String(assistantText || "").trim();
  if (text.length < 400) return false;
  if (/^\[tool results received\]$/i.test(text)) return false;
  const promptText = String(prompt || "").toLowerCase();
  if (/[|]\s*-{3,}\s*[|]|^#{1,3}\s+/m.test(text)) return true;
  return /知识库|财务|数据|报告|查询|查一下|生成|输出|文件|下载|knowledge|financial|finance|data|report|file|download/i.test(
    promptText,
  );
}

function consumeSDKMessage(message, state) {
  if (!isRecord(message)) return;
  applyBackgroundTaskMessage(message, state.backgroundTasks);
  if (message.type === "stream_event") {
    const text = extractText(message);
    if (text) state.onText(text);
    return;
  }
  if (message.type === "assistant") {
    const text = extractText(message.message || message);
    if (text) state.assistantMessages.push(text);
    collectToolUses(message.message || message, state.toolCalls);
    return;
  }
  if (message.type === "user") {
    collectToolResults(message, state.toolCalls, state.backgroundTasks);
    return;
  }
  const status = statusText(message);
  if (status) state.statusEvents.push(status);
}

function collectToolUses(message, toolCalls) {
  for (const block of contentBlocks(message)) {
    if (!isRecord(block) || block.type !== "tool_use") continue;
    const id = stringValue(block.id || block.tool_use_id || `${block.name}-${toolCalls.size}`);
    toolCalls.set(id, {
      toolName: stringValue(block.name),
      toolInput: isRecord(block.input) ? block.input : {},
      output: "",
      isError: false,
    });
  }
}

function collectToolResults(rawMessage, toolCalls, backgroundTasks) {
  const message = isRecord(rawMessage?.message) ? rawMessage.message : rawMessage;
  const topLevelResult = isRecord(rawMessage) ? rawMessage.toolUseResult || rawMessage.tool_use_result : undefined;
  const blocks = contentBlocks(message);
  for (const block of blocks) {
    if (!isRecord(block) || block.type !== "tool_result") continue;
    const id = stringValue(block.tool_use_id || block.id);
    const existing = toolCalls.get(id) || { toolName: "", toolInput: {}, output: "", isError: false };
    existing.output = extractText(block);
    existing.isError = Boolean(block.is_error || block.isError);
    const structuredResult = toolResultForBlock(block, topLevelResult, blocks.length);
    const backgroundTask = detectBackgroundTaskFromToolCall({
      ...existing,
      toolUseId: id,
      toolResult: structuredResult,
    });
    if (backgroundTask) upsertBackgroundTask(backgroundTasks, backgroundTask);
    toolCalls.set(id, existing);
  }
}

function toolResultForBlock(block, topLevelResult, blockCount) {
  if (isRecord(block.toolUseResult)) return block.toolUseResult;
  if (isRecord(block.tool_use_result)) return block.tool_use_result;
  if (isRecord(topLevelResult) && blockCount === 1) return topLevelResult;
  return undefined;
}

export function detectBackgroundTaskFromToolCall(toolCall) {
  if (!isRecord(toolCall)) return null;
  const toolName = stringValue(toolCall.toolName || toolCall.name);
  const rawResult = isRecord(toolCall.toolResult) ? toolCall.toolResult : {};
  const output = stringValue(toolCall.output || extractText(rawResult));
  const asyncStatus = stringValue(rawResult.status || rawResult.taskStatus || rawResult.task_status).toLowerCase();
  const isAsync =
    rawResult.isAsync === true ||
    rawResult.is_async === true ||
    asyncStatus === "async_launched" ||
    /Async agent launched successfully/i.test(output);
  if (!isAsync && toolName.toLowerCase() !== "agent") return null;
  if (!isAsync) return null;
  const taskId = firstNonEmptyString(
    rawResult.agentId,
    rawResult.agent_id,
    rawResult.taskId,
    rawResult.task_id,
    taggedLine(output, "agentId"),
    taggedLine(output, "taskId"),
  );
  const outputFile = firstNonEmptyString(
    rawResult.outputFile,
    rawResult.output_file,
    taggedLine(output, "output_file"),
    taggedLine(output, "outputFile"),
  );
  const toolUseId = stringValue(
    toolCall.toolUseId || toolCall.tool_use_id || rawResult.toolUseId || rawResult.tool_use_id,
  );
  const description = firstNonEmptyString(toolCall.toolInput?.description, rawResult.description, rawResult.summary);
  const id = taskId || toolUseId;
  if (!id) return null;
  return compactBackgroundTask({
    taskId: id,
    toolUseId,
    description,
    status: "running",
    summary: firstNonEmptyString(rawResult.summary, "后台任务已启动"),
    outputFile,
  });
}

export function applyBackgroundTaskMessage(message, backgroundTasks = new Map()) {
  if (!(backgroundTasks instanceof Map) || !isRecord(message)) return backgroundTasks;
  const event = backgroundTaskEventFromMessage(message);
  if (event) upsertBackgroundTask(backgroundTasks, event);
  return backgroundTasks;
}

export async function settleBackgroundTasks({ backgroundTasks, progress, args, resolved, sessionID }) {
  if (!(backgroundTasks instanceof Map) || !hasPendingBackgroundTasks(backgroundTasks)) {
    return { backgroundTasks: backgroundTaskResultList(backgroundTasks), backgroundWaitMs: 0 };
  }

  const startedAt = Date.now();
  const waitMs = Math.max(Number(args.backgroundTaskWaitSeconds || DEFAULT_BACKGROUND_TASK_WAIT_SECONDS), 0) * 1000;
  const pollMs = Math.max(Number(args.backgroundTaskPollSeconds || DEFAULT_BACKGROUND_TASK_POLL_SECONDS), 0.25) * 1000;
  const deadline = startedAt + waitMs;
  let transcriptPath = "";
  let transcriptSearched = false;

  while (hasPendingBackgroundTasks(backgroundTasks)) {
    if (!transcriptSearched) {
      transcriptPath = await findSessionTranscriptPath(args.openclaudeConfigDir, resolved.cwd, sessionID);
      transcriptSearched = true;
    }
    await refreshBackgroundTasksFromFiles(backgroundTasks, transcriptPath);

    const tasks = backgroundTaskResultList(backgroundTasks);
    const message = backgroundTaskProgressText(tasks);
    if (message) {
      progress?.add(message);
      await progress?.flush({
        mode: "openclaude",
        assistantText: message,
        backgroundTasks: tasks,
        timings: { backgroundWaitMs: Date.now() - startedAt },
      });
    }

    if (!hasPendingBackgroundTasks(backgroundTasks)) break;
    if (Date.now() >= deadline) {
      for (const task of backgroundTasks.values()) {
        if (!BACKGROUND_TASK_TERMINAL_STATUSES.has(task.status)) {
          upsertBackgroundTask(backgroundTasks, {
            ...task,
            status: "timeout",
            summary: `后台任务等待超过 ${Math.round(waitMs / 1000)} 秒`,
          });
        }
      }
      break;
    }
    await sleep(Math.min(pollMs, Math.max(deadline - Date.now(), 0)));
  }

  return {
    backgroundTasks: backgroundTaskResultList(backgroundTasks),
    backgroundWaitMs: Date.now() - startedAt,
  };
}

function backgroundTaskEventFromMessage(message) {
  if (message.type === "system") {
    const subtype = stringValue(message.subtype);
    if (subtype === "task_started") {
      return compactBackgroundTask({
        taskId: firstString(message, "task_id", "taskId"),
        toolUseId: firstString(message, "tool_use_id", "toolUseId"),
        description: firstString(message, "description"),
        status: "running",
        summary: firstString(message, "description"),
      });
    }
    if (subtype === "task_progress") {
      return compactBackgroundTask({
        taskId: firstString(message, "task_id", "taskId"),
        toolUseId: firstString(message, "tool_use_id", "toolUseId"),
        description: firstString(message, "description"),
        status: "running",
        summary: firstNonEmptyString(firstString(message, "summary"), firstString(message, "description")),
      });
    }
    if (subtype === "task_notification") {
      return compactBackgroundTask({
        taskId: firstString(message, "task_id", "taskId"),
        toolUseId: firstString(message, "tool_use_id", "toolUseId"),
        status: normalizeBackgroundTaskStatus(firstString(message, "status")),
        outputFile: firstString(message, "output_file", "outputFile"),
        summary: firstString(message, "summary"),
        result: firstString(message, "result"),
      });
    }
  }

  if (message.type === "queue-operation" && typeof message.content === "string") {
    return parseTaskNotificationText(message.content);
  }
  if (typeof message.content === "string" && message.content.includes("<task-notification>")) {
    return parseTaskNotificationText(message.content);
  }
  return null;
}

function parseTaskNotificationText(text) {
  const value = String(text || "");
  if (!value.includes("<task-notification>")) return null;
  return compactBackgroundTask({
    taskId: xmlTagValue(value, "task-id"),
    toolUseId: xmlTagValue(value, "tool-use-id"),
    outputFile: xmlTagValue(value, "output-file"),
    status: normalizeBackgroundTaskStatus(xmlTagValue(value, "status")),
    summary: xmlTagValue(value, "summary"),
    result: xmlTagValue(value, "result"),
  });
}

function upsertBackgroundTask(backgroundTasks, update) {
  const task = compactBackgroundTask(update);
  if (!task?.taskId) return;
  const existing = backgroundTasks.get(task.taskId) || {};
  const currentStatus = normalizeBackgroundTaskStatus(existing.status) || "running";
  const incomingStatus = normalizeBackgroundTaskStatus(task.status);
  const status = chooseBackgroundTaskStatus(currentStatus, incomingStatus);
  backgroundTasks.set(
    task.taskId,
    compactBackgroundTask({
      ...existing,
      ...task,
      status,
      taskId: existing.taskId || task.taskId,
      toolUseId: firstNonEmptyString(task.toolUseId, existing.toolUseId),
      description: firstNonEmptyString(task.description, existing.description),
      outputFile: firstNonEmptyString(task.outputFile, existing.outputFile),
      summary: firstNonEmptyString(task.summary, existing.summary),
      result: firstNonEmptyString(task.result, existing.result),
    }),
  );
}

function chooseBackgroundTaskStatus(currentStatus, incomingStatus) {
  if (!incomingStatus) return currentStatus || "running";
  if (BACKGROUND_TASK_FAILED_STATUSES.has(currentStatus) && incomingStatus === "completed") return currentStatus;
  if (BACKGROUND_TASK_FAILED_STATUSES.has(incomingStatus)) return incomingStatus;
  if (BACKGROUND_TASK_TERMINAL_STATUSES.has(currentStatus) && incomingStatus === "running") return currentStatus;
  return incomingStatus;
}

function compactBackgroundTask(task) {
  if (!isRecord(task)) return null;
  const taskId = firstNonEmptyString(
    task.taskId,
    task.task_id,
    task.agentId,
    task.agent_id,
    task.toolUseId,
    task.tool_use_id,
  );
  if (!taskId) return null;
  const out = {
    taskId,
    status: normalizeBackgroundTaskStatus(task.status) || "running",
  };
  for (const [key, value] of Object.entries({
    toolUseId: firstNonEmptyString(task.toolUseId, task.tool_use_id),
    description: task.description,
    summary: trimTaskText(task.summary, 1000),
    result: trimTaskText(task.result, 6000),
    outputFile: task.outputFile || task.output_file,
  })) {
    const text = stringValue(value).trim();
    if (text) out[key] = text;
  }
  return out;
}

function normalizeBackgroundTaskStatus(value) {
  const normalized = stringValue(value).trim().toLowerCase().replace(/_/g, "-");
  switch (normalized) {
    case "completed":
    case "complete":
    case "success":
    case "succeeded":
      return "completed";
    case "failed":
    case "failure":
    case "error":
      return "failed";
    case "stopped":
    case "cancelled":
    case "canceled":
      return "stopped";
    case "timeout":
    case "timed-out":
      return "timeout";
    case "running":
    case "started":
    case "progress":
    case "async-launched":
      return "running";
    default:
      return normalized || "";
  }
}

function hasPendingBackgroundTasks(backgroundTasks) {
  if (!(backgroundTasks instanceof Map)) return false;
  return [...backgroundTasks.values()].some(
    (task) => !BACKGROUND_TASK_TERMINAL_STATUSES.has(normalizeBackgroundTaskStatus(task.status)),
  );
}

function backgroundTaskResultList(backgroundTasks) {
  if (!(backgroundTasks instanceof Map)) return [];
  return [...backgroundTasks.values()]
    .map(compactBackgroundTask)
    .filter(Boolean)
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
}

async function refreshBackgroundTasksFromFiles(backgroundTasks, transcriptPath) {
  if (transcriptPath) await applyBackgroundTaskTranscript(backgroundTasks, transcriptPath);
  for (const task of [...backgroundTasks.values()]) {
    if (task.outputFile) await applyBackgroundTaskOutputFile(backgroundTasks, task);
  }
}

async function applyBackgroundTaskTranscript(backgroundTasks, path) {
  const text = await readTextIfExists(path);
  if (!text) return;
  for (const line of text.split(/\r?\n/)) {
    const message = parseJSONLine(line);
    if (message) applyBackgroundTaskMessage(message, backgroundTasks);
  }
}

async function applyBackgroundTaskOutputFile(backgroundTasks, task) {
  const text = await readTextIfExists(task.outputFile);
  if (!text) return;
  const inferred = inferBackgroundTaskFromOutput(text, task);
  if (inferred) upsertBackgroundTask(backgroundTasks, inferred);
}

function inferBackgroundTaskFromOutput(text, task) {
  let lastAssistant = null;
  let failed = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    const message = parseJSONLine(line);
    if (!message) continue;
    if (message.isApiErrorMessage || message.error) {
      failed = {
        status: "failed",
        summary: firstNonEmptyString(message.error, "后台任务执行失败"),
        result: assistantTextFromTranscriptMessage(message),
      };
    }
    if (message.type === "assistant") lastAssistant = message;
  }
  if (failed) return compactBackgroundTask({ ...task, ...failed });
  if (!lastAssistant) return null;
  const stopReason = assistantStopReason(lastAssistant);
  if (!["stop_sequence", "end_turn", "stop"].includes(stopReason)) return null;
  if (assistantMessageHasToolUse(lastAssistant)) return null;
  return compactBackgroundTask({
    ...task,
    status: "completed",
    summary: task.summary || "后台任务已完成",
    result: assistantTextFromTranscriptMessage(lastAssistant),
  });
}

function assistantTextFromTranscriptMessage(message) {
  const payload = isRecord(message?.message) ? message.message : message;
  return trimTaskText(extractText(payload), 6000);
}

function assistantStopReason(message) {
  const payload = isRecord(message?.message) ? message.message : message;
  return stringValue(payload.stop_reason || payload.stopReason).trim();
}

function assistantMessageHasToolUse(message) {
  const payload = isRecord(message?.message) ? message.message : message;
  return contentBlocks(payload).some((block) => isRecord(block) && block.type === "tool_use");
}

async function findSessionTranscriptPath(openclaudeConfigDir, cwd, sessionID) {
  const session = stringValue(sessionID).trim();
  if (!session || !openclaudeConfigDir) return "";
  const projectsRoot = join(openclaudeConfigDir, "projects");
  if (!existsSync(projectsRoot)) return "";
  const candidate = join(projectsRoot, transcriptProjectSegment(cwd), `${session}.jsonl`);
  if (existsSync(candidate)) return candidate;
  for await (const file of walk(projectsRoot)) {
    if (basename(file) === `${session}.jsonl`) return file;
  }
  return "";
}

function transcriptProjectSegment(cwd) {
  const normalized = normalizeRelativePath(resolve(cwd || "."));
  return normalized
    .replace(/^\//, "-")
    .replace(/\//g, "-")
    .replace(/[^A-Za-z0-9_.-]/g, "-");
}

async function readTextIfExists(path) {
  const target = stringValue(path).trim();
  if (!target || !existsSync(target)) return "";
  return readFile(target, "utf8").catch(() => "");
}

function parseJSONLine(line) {
  const text = String(line || "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function appendBackgroundTaskSummary(assistantText, backgroundTasks) {
  const tasks = Array.isArray(backgroundTasks) ? backgroundTasks : [];
  if (!tasks.length) return assistantText;
  const lines = ["", "---", "", "后台任务结果："];
  for (const task of tasks) {
    const label = firstNonEmptyString(task.description, task.taskId);
    lines.push(`- ${label}: ${task.status}${task.summary ? ` - ${task.summary}` : ""}`);
    if (task.result) lines.push(`  ${task.result}`);
  }
  return `${String(assistantText || "").trimEnd()}${lines.join("\n")}`.trim();
}

function backgroundTaskProgressText(tasks) {
  const pending = tasks.filter((task) => !BACKGROUND_TASK_TERMINAL_STATUSES.has(task.status));
  if (!pending.length) return "";
  const names = pending.map((task) => firstNonEmptyString(task.description, task.taskId)).join(", ");
  return `等待后台任务完成：${names}`;
}

function backgroundTaskFailureMessage(task) {
  const label = firstNonEmptyString(task.description, task.taskId, "background task");
  const detail = firstNonEmptyString(task.summary, task.result, task.status);
  return `${label} ${task.status}${detail ? `: ${detail}` : ""}`;
}

function taggedLine(text, key) {
  const match = String(text || "").match(new RegExp(`^${escapeRegExp(key)}:\\s*(.+)$`, "im"));
  return match ? match[1].trim() : "";
}

function xmlTagValue(text, tag) {
  const match = String(text || "").match(new RegExp(`<${escapeRegExp(tag)}>([\\s\\S]*?)</${escapeRegExp(tag)}>`, "i"));
  return match ? match[1].trim() : "";
}

function trimTaskText(value, limit) {
  const text = stringValue(value).trim();
  if (!text || text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}\n...[truncated]`;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = stringValue(value).trim();
    if (text) return text;
  }
  return "";
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function contentBlocks(message) {
  const content = message?.content;
  if (Array.isArray(content)) return content;
  if (isRecord(content) && Array.isArray(content.content)) return content.content;
  return [];
}

function extractText(value) {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.delta === "string") return value.delta;
  if (isRecord(value.delta) && typeof value.delta.text === "string") return value.delta.text;
  const blocks = contentBlocks(value);
  if (blocks.length) return blocks.map(extractText).filter(Boolean).join("");
  return "";
}

function statusText(message) {
  if (typeof message.message === "string") return message.message;
  if (typeof message.status === "string") return message.status;
  if (typeof message.type === "string" && !["assistant", "user", "result"].includes(message.type)) return message.type;
  return "";
}

function normalizeUsage(raw) {
  if (!isRecord(raw)) return {};
  return {
    inputTokens: Number(raw.input_tokens ?? raw.inputTokens ?? 0) || 0,
    outputTokens: Number(raw.output_tokens ?? raw.outputTokens ?? 0) || 0,
  };
}

export function renderTemplate(template, inputs) {
  return String(template || "").replace(
    /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}|\$\{\s*([A-Za-z0-9_.-]+)\s*\}/g,
    (_match, mustacheKey, dollarKey) => {
      const key = mustacheKey || dollarKey;
      const value = lookupInput(inputs, key);
      return value == null ? "" : String(value);
    },
  );
}

function lookupInput(inputs, key) {
  return String(key)
    .split(".")
    .reduce((current, part) => {
      if (!isRecord(current) && !Array.isArray(current)) return undefined;
      return current[part];
    }, inputs);
}

export function providerEnvironment(resolved) {
  const env = {};
  const apiFormat = String(resolved.apiFormat || "openai").toLowerCase();
  const apiKey = resolved.apiKey || apiKeyFromEnv();
  if (apiFormat === "openai") {
    env.CLAUDE_CODE_USE_OPENAI = "1";
    if (resolved.model) env.OPENAI_MODEL = resolved.model;
    if (resolved.baseURL) env.OPENAI_BASE_URL = resolved.baseURL;
    if (apiKey) env.OPENAI_API_KEY = apiKey;
    return env;
  }
  if (apiFormat === "anthropic") {
    if (resolved.model) env.ANTHROPIC_MODEL = resolved.model;
    if (resolved.baseURL) env.ANTHROPIC_BASE_URL = resolved.baseURL;
    if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
    return env;
  }
  throw new JobTerminalError(
    "runtime_model_unsupported",
    `OpenClaude adapter does not support api_format=${resolved.apiFormat}`,
  );
}

export function deriveWebSearchProviderEnv(serviceState, env = process.env) {
  const explicit = EXPLICIT_WEB_SEARCH_ENV_VARS.some((name) => hasEnvValue(env, name));
  if (explicit) return {};
  const builtinBackend = TINYFISH_WEB_SEARCH_BUILTIN_BACKEND_KEYS.some((name) => hasEnvValue(env, name));
  if (builtinBackend) return {};
  const apiKey = extractTinyFishAPIKey(serviceState);
  if (!apiKey) return {};
  return {
    WEB_SEARCH_PROVIDER: TINYFISH_WEB_SEARCH_PROVIDER,
    WEB_SEARCH_API: TINYFISH_WEB_SEARCH_API,
    WEB_QUERY_PARAM: TINYFISH_WEB_SEARCH_QUERY_PARAM,
    WEB_KEY: apiKey,
    WEB_AUTH_HEADER: "X-API-Key",
    WEB_AUTH_SCHEME: "",
  };
}

export function derivePluginCommandEnv(serviceState, env = process.env) {
  const dirs = Array.isArray(serviceState?.pluginBinDirs)
    ? serviceState.pluginBinDirs.map((item) => stringValue(item).trim()).filter(Boolean)
    : [];
  if (!dirs.length) return {};
  const currentPath = stringValue(env?.PATH || env?.Path || "").trim();
  return { PATH: uniqueStrings([...dirs, currentPath].filter(Boolean)).join(":") };
}

export function runtimeEnvironmentOverrides(resolved, serviceState, env = process.env) {
  return {
    ...providerEnvironment(resolved),
    ...deriveWebSearchProviderEnv(serviceState, env),
    ...derivePluginCommandEnv(serviceState, env),
  };
}

function hasEnvValue(env, name) {
  if (!env || typeof env !== "object") return false;
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0;
}

function extractTinyFishAPIKey(serviceState) {
  if (!isRecord(serviceState)) return "";
  const servers = serviceState.mcpServers;
  if (!isRecord(servers)) return "";
  for (const [name, server] of Object.entries(servers)) {
    if (!/tinyfish/i.test(String(name || ""))) continue;
    const key = readAPIKeyFromServer(server);
    if (key) return key;
  }
  return "";
}

function readAPIKeyFromServer(server) {
  if (!isRecord(server)) return "";
  const headers = server.headers;
  if (isRecord(headers)) {
    for (const [headerName, headerValue] of Object.entries(headers)) {
      if (String(headerName || "").toLowerCase() !== "x-api-key") continue;
      if (typeof headerValue === "string" && headerValue.trim()) return headerValue.trim();
    }
  }
  const env = server.env;
  if (isRecord(env)) {
    for (const [envName, envValue] of Object.entries(env)) {
      if (String(envName || "").toLowerCase() !== "x-api-key") continue;
      if (typeof envValue === "string" && envValue.trim()) return envValue.trim();
    }
  }
  return "";
}

export function applyTemporaryEnv(overrides) {
  const entries = Object.entries(overrides || {});
  if (!entries.length) return () => undefined;
  const previous = entries.map(([name]) => ({
    name,
    had: Object.prototype.hasOwnProperty.call(process.env, name),
    value: process.env[name],
  }));
  for (const [name, value] of entries) {
    if (value === undefined || value === null) {
      delete process.env[name];
    } else {
      process.env[name] = String(value);
    }
  }
  return () => {
    for (const snapshot of previous) {
      if (snapshot.had) process.env[snapshot.name] = snapshot.value;
      else delete process.env[snapshot.name];
    }
  };
}

export function runtimePermissionDecision(name, input, args) {
  if (args.adminbot) return { behavior: "allow" };
  const kbTool = knowledgeBaseToolName(name);
  if (kbTool && !KNOWLEDGE_BASE_READ_ONLY_TOOLS.has(kbTool)) {
    return {
      behavior: "deny",
      message: "BotStation knowledge-base policy allows read-only KB tools for staff-agent runtime",
    };
  }
  if (args.knowledgeBaseStrictMode && isExternalToolDeniedForKnowledgeBaseStrictMode(name)) {
    return {
      behavior: "deny",
      message:
        "This task explicitly requested knowledge-base data; use knowledge-base MCP and local database clients only, not external MCP or web tools",
    };
  }
  const sandboxEnabled = process.env.BOTSTATION_RUNTIME_SANDBOX_ENABLED === "true";
  const sandboxRequired = process.env.BOTSTATION_RUNTIME_SANDBOX_FAIL_IF_UNAVAILABLE === "true";
  if (!sandboxEnabled) return { behavior: "allow" };
  const lower = String(name || "").toLowerCase();
  const serialized = JSON.stringify(input || {}).toLowerCase();
  const destructive =
    /(delete|remove|write|edit|replace|bash|shell|run|exec)/.test(lower) ||
    /\brm\s+-|\bchmod\b|\bchown\b|\bdd\b/.test(serialized);
  if (destructive && sandboxRequired) {
    return { behavior: "deny", message: "BotStation sandbox policy denied this tool call" };
  }
  return { behavior: "allow" };
}

export function createRuntimeToolGuard({ args, jobID }) {
  const cacheDir = join(args.openclaudeDataDir, "read-cache", safeSegment(jobID || "job"));
  const entries = new Map();
  const entriesByView = new Map();

  return {
    async decide(name, input) {
      const permission = runtimePermissionDecision(name, input, args);
      if (permission.behavior !== "allow" || name !== "Read" || !isRecord(input) || input.pages !== undefined) {
        return permission;
      }
      const rawPath = stringValue(input.file_path);
      if (!rawPath) return permission;

      const requestedPath = resolve(rawPath);
      let entry = entriesByView.get(requestedPath);
      if (!entry) {
        if (!isPersistedToolResultPath(requestedPath, args.openclaudeConfigDir)) return permission;
        let sourceStat;
        try {
          sourceStat = await stat(requestedPath);
        } catch {
          return permission;
        }
        if (!sourceStat.isFile() || sourceStat.size <= PERSISTED_READ_SAFE_FILE_BYTES) return permission;

        const cacheKey = `${requestedPath}\0${sourceStat.size}\0${sourceStat.mtimeMs}`;
        let entryPromise = entries.get(cacheKey);
        if (!entryPromise) {
          entryPromise = createPersistedReadCacheEntry({
            sourcePath: requestedPath,
            sourceStat,
            cacheDir,
            cacheKey,
          });
          entries.set(cacheKey, entryPromise);
        }
        entry = await entryPromise;
        entriesByView.set(resolve(entry.viewPath), entry);
      }

      return {
        ...permission,
        updatedInput: boundedPersistedReadInput(input, entry),
      };
    },
    async cleanup() {
      entries.clear();
      entriesByView.clear();
      await rm(cacheDir, { recursive: true, force: true });
    },
  };
}

function isPersistedToolResultPath(filePath, openclaudeConfigDir) {
  if (!openclaudeConfigDir) return false;
  const projectsRoot = resolve(openclaudeConfigDir, "projects");
  const pathWithinProjects = relative(projectsRoot, filePath);
  if (
    !pathWithinProjects ||
    pathWithinProjects.startsWith(`..${sep}`) ||
    pathWithinProjects === ".." ||
    isAbsolute(pathWithinProjects)
  ) {
    return false;
  }
  return pathWithinProjects.split(sep).includes("tool-results");
}

async function createPersistedReadCacheEntry({ sourcePath, sourceStat, cacheDir, cacheKey }) {
  await mkdir(cacheDir, { recursive: true });
  const digest = createHash("sha256").update(cacheKey).digest("hex").slice(0, 20);
  const viewPath = join(cacheDir, `${digest}.txt`);
  let lineTokenEstimates;

  if (sourceStat.size <= PERSISTED_READ_JSON_PARSE_MAX_BYTES) {
    const source = await readFile(sourcePath, "utf8");
    const readable = formatPersistedReadContent(source);
    const lines = wrapPersistedReadLines(readable);
    await writeFile(viewPath, lines.join("\n"), "utf8");
    lineTokenEstimates = lines.map((line) => estimatePersistedReadTokens(line) + 8);
  } else {
    lineTokenEstimates = await streamPersistedReadView(sourcePath, viewPath);
  }

  return {
    sourcePath,
    viewPath,
    lineTokenEstimates,
  };
}

function formatPersistedReadContent(source) {
  try {
    return JSON.stringify(JSON.parse(source), null, 2);
  } catch {
    return source;
  }
}

function wrapPersistedReadLines(content) {
  const lines = [];
  for (const line of String(content).split(/\r?\n/)) {
    if (!line) {
      lines.push("");
      continue;
    }
    let remaining = line;
    while (remaining.length > PERSISTED_READ_MAX_LINE_CHARS) {
      const end = safeTextChunkEnd(remaining, PERSISTED_READ_MAX_LINE_CHARS);
      lines.push(remaining.slice(0, end));
      remaining = remaining.slice(end);
    }
    lines.push(remaining);
  }
  return lines.length ? lines : [""];
}

async function streamPersistedReadView(sourcePath, viewPath) {
  const output = createWriteStream(viewPath, { encoding: "utf8" });
  const finished = once(output, "finish");
  const lineTokenEstimates = [];
  let firstOutputLine = true;
  let pending = "";

  const writeLine = async (line) => {
    const prefix = firstOutputLine ? "" : "\n";
    if (!output.write(`${prefix}${line}`, "utf8")) await once(output, "drain");
    firstOutputLine = false;
    lineTokenEstimates.push(estimatePersistedReadTokens(line) + 8);
  };
  const writeLogicalLine = async (line) => {
    let remaining = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!remaining) {
      await writeLine("");
      return;
    }
    while (remaining.length > PERSISTED_READ_MAX_LINE_CHARS) {
      const end = safeTextChunkEnd(remaining, PERSISTED_READ_MAX_LINE_CHARS);
      await writeLine(remaining.slice(0, end));
      remaining = remaining.slice(end);
    }
    await writeLine(remaining);
  };

  try {
    for await (const chunk of createReadStream(sourcePath, { encoding: "utf8" })) {
      pending += chunk;
      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex >= 0) {
        await writeLogicalLine(pending.slice(0, newlineIndex));
        pending = pending.slice(newlineIndex + 1);
        newlineIndex = pending.indexOf("\n");
      }
      while (pending.length > PERSISTED_READ_MAX_LINE_CHARS) {
        const end = safeTextChunkEnd(pending, PERSISTED_READ_MAX_LINE_CHARS);
        await writeLine(pending.slice(0, end));
        pending = pending.slice(end);
      }
    }
    if (pending || firstOutputLine) await writeLogicalLine(pending);
    output.end();
    await finished;
  } catch (err) {
    output.destroy();
    throw err;
  }

  return lineTokenEstimates;
}

function safeTextChunkEnd(value, maximum) {
  let end = Math.min(value.length, maximum);
  const lastCodeUnit = value.charCodeAt(end - 1);
  const nextCodeUnit = value.charCodeAt(end);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff && nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
    end -= 1;
  }
  return Math.max(1, end);
}

function boundedPersistedReadInput(input, entry) {
  const rawOffset = Number(input.offset);
  const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? Math.max(1, rawOffset) : 1;
  const rawLimit = Number(input.limit);
  const requestedLimit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? rawLimit : Number.POSITIVE_INFINITY;
  const startIndex = offset - 1;
  let estimatedTokens = 0;
  let safeLimit = 0;

  for (let index = startIndex; index < entry.lineTokenEstimates.length && safeLimit < requestedLimit; index += 1) {
    const nextEstimate = entry.lineTokenEstimates[index];
    if (safeLimit > 0 && estimatedTokens + nextEstimate > PERSISTED_READ_TARGET_TOKENS) break;
    estimatedTokens += nextEstimate;
    safeLimit += 1;
    if (estimatedTokens >= PERSISTED_READ_TARGET_TOKENS) break;
  }
  if (safeLimit === 0) safeLimit = 1;

  return {
    ...input,
    file_path: entry.viewPath,
    offset,
    limit: safeLimit,
  };
}

export function estimatePersistedReadTokens(value) {
  const text = String(value || "");
  return Math.max(1, Math.ceil(text.length / 2), Math.ceil(Buffer.byteLength(text, "utf8") / 3));
}

function knowledgeBaseToolName(name) {
  const lower = String(name || "").toLowerCase();
  const match = lower.match(/kb_[a-z0-9_]+/);
  if (!match) return "";
  const toolName = match[0];
  if (
    lower.startsWith(toolName) ||
    lower.includes(`__${toolName}`) ||
    lower.includes(`:${toolName}`) ||
    lower.includes(`.${toolName}`) ||
    lower.includes(KNOWLEDGE_BASE_MCP_NAME) ||
    lower.includes("knowledge_base")
  ) {
    return toolName;
  }
  return "";
}

function isKnowledgeBaseStrictPrompt(prompt) {
  const text = String(prompt || "").toLowerCase();
  if (!text) return false;
  return [
    "从知识库",
    "基于知识库",
    "使用知识库",
    "知识库优先",
    "knowledge-base",
    "knowledge base",
    "use knowledge base",
    "from knowledge base",
  ].some((marker) => text.includes(marker));
}

function isExternalToolDeniedForKnowledgeBaseStrictMode(name) {
  const lower = String(name || "").toLowerCase();
  if (lower === "websearch" || lower === "webfetch" || lower.includes("web_search") || lower.includes("web_fetch")) {
    return true;
  }
  const mcpMatch = lower.match(/^mcp__([^_]+(?:_[^_]+)*)__/);
  if (!mcpMatch) return false;
  const serverName = mcpMatch[1].replace(/_/g, "-");
  return serverName !== KNOWLEDGE_BASE_MCP_NAME;
}

export function webSearchUnavailableForResolved() {
  return false;
}

export function normalizePermissionMode(value) {
  const normalized = stringValue(value).trim();
  if (normalized === "accept-edits" || normalized === "acceptEdits") return "acceptEdits";
  if (normalized === "plan") return "plan";
  return "default";
}

function resolveWorkspacePath(workspaceRoot, value, fieldName) {
  const root = resolve(workspaceRoot);
  const target = resolve(root, stringValue(value).trim());
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new JobTerminalError(
      "payload_validation_failed",
      `job payload.${fieldName} must stay within the runtime workspace`,
    );
  }
  return target;
}

async function processNextJob({ bridge, args }) {
  const job = await bridge.claimNext(args.agentInstanceID, args.claimWaitSeconds);
  if (!job) return false;
  const heartbeat = setInterval(
    () => bridge.heartbeat(job.id).catch(() => undefined),
    Math.max(args.heartbeatIntervalSeconds, 1) * 1000,
  );
  try {
    const result = await executeJob(job, { bridge, args });
    await completeWithRetry(bridge, job.id, { status: "completed", result });
  } catch (err) {
    if (shutdownRequested) {
      throw err;
    }
    const terminalCode = err instanceof JobTerminalError ? err.terminalCode : "runtime_handler_failed";
    const terminalMessage = err instanceof Error ? err.message : String(err);
    const payload = { status: "failed", terminalCode, terminalMessage };
    if (err instanceof JobTerminalError && err.result !== undefined) payload.result = err.result;
    await completeWithRetry(bridge, job.id, payload);
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

async function completeWithRetry(bridge, jobID, payload) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await bridge.complete(jobID, payload);
    } catch (err) {
      lastError = err;
      await sleep(Math.min(2 ** attempt, 4) * 1000);
    }
  }
  throw lastError;
}

export async function runWorker(args) {
  const bridge = new SessionQueueBridge(args.stationURL, {
    clientID: args.clientID,
    internalAuthToken: args.internalAuthToken,
    serviceCatalogURL: args.serviceCatalogURL,
  });
  await mkdir(args.openclaudeConfigDir, { recursive: true });
  await mkdir(args.openclaudeDataDir, { recursive: true });
  process.env.OPENCLAUDE_CONFIG_DIR = args.openclaudeConfigDir;
  process.env.OPENCLAUDE_DATA_DIR = args.openclaudeDataDir;
  let iterations = 0;
  while (!shutdownRequested && (!args.maxIterations || iterations < args.maxIterations)) {
    iterations += 1;
    const processed = await processNextJob({ bridge, args }).catch((err) => {
      console.warn(`openclaude-runtime: job failed: ${err?.stack || err}`);
      return true;
    });
    if (!processed && args.stopWhenIdle) break;
    if (!processed) await sleep(args.pollIntervalSeconds * 1000);
  }
}

export function parseArgs(argv) {
  const args = {
    stationURL: "http://localhost:8082",
    serviceCatalogURL: "http://service-catalog.local",
    messageCenterURL: "http://message-center.local",
    knowledgeBaseMCPURL:
      process.env.AGENT_STATION_KNOWLEDGE_BASE_MCP_URL || process.env.BOTSTATION_KNOWLEDGE_BASE_MCP_URL || "",
    internalAuthToken: process.env.BOTSTATION_INTERNAL_AUTH_TOKEN || "",
    agentInstanceID: "",
    tenantID: "tenant",
    organizationID: "org",
    departmentID: "dept",
    userID: "openclaude-runtime",
    clientID: "openclaude-runtime",
    roleIDs: [],
    cwd: process.cwd(),
    model: "",
    baseURL: "",
    apiFormat: "",
    activeProfile: "",
    permissionMode: "",
    openclaudeConfigDir: "",
    openclaudeDataDir: "",
    extraPluginRoot: [],
    pollIntervalSeconds: DEFAULT_POLL_SECONDS,
    claimWaitSeconds: 0,
    heartbeatIntervalSeconds: DEFAULT_HEARTBEAT_SECONDS,
    backgroundTaskWaitSeconds:
      Number(process.env.BOTSTATION_BACKGROUND_TASK_WAIT_SECONDS || DEFAULT_BACKGROUND_TASK_WAIT_SECONDS) ||
      DEFAULT_BACKGROUND_TASK_WAIT_SECONDS,
    backgroundTaskPollSeconds:
      Number(process.env.BOTSTATION_BACKGROUND_TASK_POLL_SECONDS || DEFAULT_BACKGROUND_TASK_POLL_SECONDS) ||
      DEFAULT_BACKGROUND_TASK_POLL_SECONDS,
    maxIterations: 0,
    stopWhenIdle: false,
    adminbot: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const next = () => argv[++index] || "";
    switch (item) {
      case "--station-url":
        args.stationURL = next();
        break;
      case "--service-catalog-url":
        args.serviceCatalogURL = next();
        break;
      case "--message-center-url":
        args.messageCenterURL = next();
        break;
      case "--knowledge-base-mcp-url":
        args.knowledgeBaseMCPURL = next();
        break;
      case "--internal-auth-token":
        args.internalAuthToken = next();
        break;
      case "--agent-instance-id":
        args.agentInstanceID = next();
        break;
      case "--tenant-id":
        args.tenantID = next();
        break;
      case "--organization-id":
        args.organizationID = next();
        break;
      case "--department-id":
        args.departmentID = next();
        break;
      case "--user-id":
        args.userID = next();
        break;
      case "--client-id":
        args.clientID = next();
        break;
      case "--role-id":
        args.roleIDs.push(next());
        break;
      case "--cwd":
        args.cwd = next();
        break;
      case "--model":
        args.model = next();
        break;
      case "--base-url":
        args.baseURL = next();
        break;
      case "--api-format":
        args.apiFormat = next();
        break;
      case "--active-profile":
        args.activeProfile = next();
        break;
      case "--permission-mode":
        args.permissionMode = next();
        break;
      case "--openclaude-config-dir":
        args.openclaudeConfigDir = next();
        break;
      case "--openclaude-data-dir":
        args.openclaudeDataDir = next();
        break;
      case "--openharness-config-dir":
        args.openclaudeConfigDir = next();
        break;
      case "--openharness-data-dir":
        args.openclaudeDataDir = next();
        break;
      case "--extra-plugin-root":
        args.extraPluginRoot.push(next());
        break;
      case "--poll-interval-seconds":
        args.pollIntervalSeconds = Number(next()) || DEFAULT_POLL_SECONDS;
        break;
      case "--claim-wait-seconds":
        args.claimWaitSeconds = Number(next()) || 0;
        break;
      case "--heartbeat-interval-seconds":
        args.heartbeatIntervalSeconds = Number(next()) || DEFAULT_HEARTBEAT_SECONDS;
        break;
      case "--background-task-wait-seconds":
        args.backgroundTaskWaitSeconds = Number(next()) || DEFAULT_BACKGROUND_TASK_WAIT_SECONDS;
        break;
      case "--background-task-poll-seconds":
        args.backgroundTaskPollSeconds = Number(next()) || DEFAULT_BACKGROUND_TASK_POLL_SECONDS;
        break;
      case "--max-iterations":
        args.maxIterations = Number(next()) || 0;
        break;
      case "--stop-when-idle":
        args.stopWhenIdle = true;
        break;
      case "--adminbot":
        args.adminbot = true;
        break;
      case "--experimental-async-sync":
      case "--experimental-installer-cache":
        break;
      default:
        if (item && !item.startsWith("--") && !args.workerScriptPath) args.workerScriptPath = item;
        break;
    }
  }
  if (!args.agentInstanceID) args.agentInstanceID = "openclaude-runtime";
  if (!args.openclaudeConfigDir)
    args.openclaudeConfigDir = join(
      args.cwd,
      ".botstation",
      "agents",
      safeSegment(args.agentInstanceID),
      "openclaude",
      "config",
    );
  if (!args.openclaudeDataDir)
    args.openclaudeDataDir = join(
      args.cwd,
      ".botstation",
      "agents",
      safeSegment(args.agentInstanceID),
      "openclaude",
      "data",
    );
  return args;
}

class ProgressReporter {
  constructor(send) {
    this.send = send;
    this.events = [];
    this.lastSent = 0;
  }
  add(message) {
    const text = String(message || "").trim();
    if (!text) return;
    if (this.events.at(-1) !== text) this.events.push(text);
    this.events = this.events.slice(-24);
    if (Date.now() - this.lastSent > 500) void this.flush();
  }
  async flush(extra = {}) {
    if (!this.events.length) return;
    this.lastSent = Date.now();
    await this.send({ mode: "openclaude", progressEvents: this.events, assistantText: this.events.at(-1), ...extra });
  }
}

async function materializeAttachments(raw, cwd, jobID) {
  const result = { paths: [], extractedRoots: [] };
  if (!Array.isArray(raw) || !raw.length) return result;
  const root = join(cwd, ".botstation", "attachments", safeSegment(jobID || "job"));
  await mkdir(root, { recursive: true });
  let index = 0;
  for (const item of raw) {
    index += 1;
    if (!isRecord(item) || typeof item.contentBase64 !== "string") continue;
    const filename = safeFilename(item.fileName || `attachment-${index}.bin`);
    const target = join(root, `${String(index).padStart(2, "0")}-${filename}`);
    try {
      await writeFile(target, Buffer.from(item.contentBase64, "base64"));
      result.paths.push(target);
    } catch {
      // Invalid attachments are ignored here; upload validation happens in Go.
    }
  }
  return result;
}

async function snapshotFiles(root) {
  const files = new Set();
  if (!existsSync(root)) return files;
  for await (const file of walk(root)) files.add(file);
  return files;
}

async function collectGeneratedFiles(beforeFiles, root) {
  if (!existsSync(root)) return [];
  const generated = [];
  for await (const file of walk(root)) {
    if (beforeFiles.has(file)) continue;
    if (basename(file) === "manifest.json") continue;
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) continue;
    const relativePath = normalizeRelativePath(relative(root, file));
    if (!isDeliverableFile(relativePath)) continue;
    const fileName = basename(file);
    generated.push({
      fileId: generatedFileID(relativePath),
      fileName,
      relativePath,
      contentType: contentTypeFromName(fileName),
      sizeBytes: info.size,
    });
  }
  return dedupeGeneratedFiles(generated);
}

function isDeliverableFile(relativePath) {
  const normalized = normalizeRelativePath(relativePath).toLowerCase();
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) return false;
  if (parts.some((part) => part.startsWith("."))) return false;
  if (parts.some((part) => ["research", "scripts", "tmp", "temp", "cache", "__pycache__"].includes(part))) return false;
  switch (extname(normalized)) {
    case ".txt":
    case ".md":
    case ".csv":
    case ".pdf":
    case ".doc":
    case ".docx":
    case ".xls":
    case ".xlsx":
    case ".ppt":
    case ".pptx":
      return true;
    default:
      return false;
  }
}

function dedupeGeneratedFiles(files) {
  const sorted = [...files].sort((left, right) => {
    const leftDepth = left.relativePath.split("/").length;
    const rightDepth = right.relativePath.split("/").length;
    if (leftDepth !== rightDepth) return leftDepth - rightDepth;
    if (left.relativePath.length !== right.relativePath.length)
      return left.relativePath.length - right.relativePath.length;
    return left.relativePath.localeCompare(right.relativePath);
  });
  const seen = new Set();
  const result = [];
  for (const file of sorted) {
    const key = `${file.fileName}\0${file.sizeBytes}\0${file.contentType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(file);
  }
  return result;
}

function normalizeRelativePath(path) {
  return String(path || "")
    .split(sep)
    .join("/");
}

function generatedFileID(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  const ext = extname(normalized).replace(/[^A-Za-z0-9.]/g, "");
  return `file-${digest}${ext}`;
}

function contentTypeFromName(name) {
  switch (extname(String(name || "")).toLowerCase()) {
    case ".txt":
    case ".log":
    case ".md":
    case ".csv":
      return "text/plain; charset=utf-8";
    case ".json":
      return "application/json";
    case ".pdf":
      return "application/pdf";
    case ".doc":
      return "application/msword";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xls":
      return "application/vnd.ms-excel";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".ppt":
      return "application/vnd.ms-powerpoint";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".html":
      return "text/html; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

async function* walk(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

function normalizeJob(value) {
  return {
    id: stringValue(value?.id),
    agentInstanceId: stringValue(value?.agentInstanceId),
    requestId: stringValue(value?.requestId),
    clientId: stringValue(value?.clientId),
    jobType: stringValue(value?.jobType || "interactive"),
    payload: isRecord(value?.payload) ? value.payload : {},
    status: stringValue(value?.status),
    queuePosition: Number(value?.queuePosition || 0),
  };
}

async function readJSON(path) {
  try {
    const raw = await readFile(path, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function writeJSON(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!isRecord(value)) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = stripUndefined(item);
  }
  return out;
}

function resolvePluginPath(root, relPath) {
  const path = stringValue(relPath).trim();
  if (!path || isAbsolute(path))
    throw new JobTerminalError("plugin_install_failed", `invalid plugin file path: ${relPath}`);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new JobTerminalError("plugin_install_failed", `plugin file path escapes plugin root: ${relPath}`);
  }
  return target;
}

async function materializeSkillFiles(skillRoot, files) {
  for (const file of Array.isArray(files) ? files : []) {
    if (!isRecord(file)) continue;
    const relPath = firstString(file, "path");
    if (!relPath || relPath.toLowerCase() === "skill.md") continue;
    const target = resolveSkillPath(skillRoot, relPath);
    const content =
      typeof file.content === "string"
        ? file.content
        : typeof file.contentBase64 === "string"
          ? Buffer.from(file.contentBase64, "base64")
          : null;
    if (content === null) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, typeof content === "string" ? "utf8" : undefined);
  }
}

function resolveSkillPath(root, relPath) {
  const path = stringValue(relPath).trim();
  if (!path || isAbsolute(path))
    throw new JobTerminalError("skill_install_failed", `invalid skill file path: ${relPath}`);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new JobTerminalError("skill_install_failed", `skill file path escapes skill root: ${relPath}`);
  }
  return target;
}

function shellQuote(value) {
  return `'${stringValue(value).replace(/'/g, `'\\''`)}'`;
}

function uniqueStrings(items) {
  return [...new Set(items.map((item) => stringValue(item).trim()).filter(Boolean))];
}

function userContextFromArgs(args) {
  return {
    tenantID: args.tenantID,
    organizationID: args.organizationID,
    departmentID: args.departmentID,
    userID: args.userID,
    roleIDs: args.roleIDs,
  };
}

function apiKeyFromEnv(name = "") {
  if (name && process.env[name]) return process.env[name];
  return (
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    process.env.GO_API_KEY ||
    ""
  );
}

function firstString(record, ...keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function stringValue(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function safeSegment(value) {
  return (
    stringValue(value)
      .trim()
      .replace(/[^\p{L}\p{N}._-]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "item"
  );
}

function safeFilename(value) {
  return basename(safeSegment(value));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(payload) {
  return typeof payload?.error === "string" ? payload.error : "";
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const removeShutdownHandlers = installShutdownHandlers();
  try {
    await runWorker(args);
  } finally {
    removeShutdownHandlers();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err?.stack || err);
    process.exitCode = 1;
  });
}
