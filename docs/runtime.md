# Supbot Runtime 4.2

Supbot runtime is organized around `SupbotRuntime` as the desktop-facing facade and `QueryEngine` as the per-turn execution core. The facade owns IPC-compatible state, jobs, snapshots, scheduled jobs, memory management, and local slash command compatibility. QueryEngine owns the agent turn lifecycle: context assembly, local memory recall, model loop, transcript writing, compact boundaries, runtime events, and final result accounting.

## Query Engine

`QueryEngine.submitTurn()` builds the active runtime context through `ContextManager`, then runs `queryLoop`. The loop repeatedly calls the configured `ModelAdapter`, feeds OpenAI-compatible tool calls into `ToolExecutor`, appends role=`tool` results, and stops on final assistant text or `maxTurns`.

Streaming adapters emit `message_delta` events that update the same assistant message. Non-streaming adapters return the same final `ModelTurnResult` shape, so the rest of the loop does not care which transport was used.

## Tool Execution

Tools are declared in `ToolRegistry` with `name`, `description`, JSON schema parameters, `risk`, `concurrency`, `interruptBehavior`, `summarize`, and `execute`.

`ToolExecutor` validates arguments against the tool schema before permission checks and before calling the implementation. Validation failures are returned as structured tool errors and are fed back to the model. `ReadFile` is safe and concurrent. `WriteFile`, `Shell`, and `Agent` are dangerous and normally require permission.

Slash commands `/read`, `/write`, and `/shell` still exist, but they route through the same `ToolExecutor` and registry.

## Conversation ZIP Package Installation

Uploaded ZIP attachments can be installed by the agent through two normal tools: `InspectPackageArchive` and `InstallPackageArchive`. The install tool is dangerous, so it uses the existing permission card. No extra desktop IPC or package dialog is involved.

`InspectPackageArchive` only accepts ZIP files already attached to the current conversation. It validates the archive before extraction: no absolute paths, parent-directory paths, symlinks, encrypted entries, duplicate paths, archives over 200 MiB, more than 20,000 entries, or more than 1 GiB of extracted data. It supports one wrapping directory around the real package root.

Package formats:

- Skill: root `SKILL.md` with front matter containing non-empty `name` and `description`.
- Plugin: `.codex-plugin/plugin.json`, optional `skills` path, default `skills/`, and `mcpServers` either as an object or as a path such as `./.mcp.json`.
- MCP: `.mcp.json` or legacy `supbot-mcp.json` containing `mcpServer` or `mcpServers`.

Install targets are fixed under the runtime data directory: `skills/<id>`, `plugins/<id>`, and `mcp/<id>`. Successful installs write `supbot-local-package.json` with the package hash, version, components, dependency plan, dependency results, install time, and activated capability ids. Reinstalling the same id swaps directories through a staging path and keeps the old version until dependency installation and MCP activation succeed; failures roll back.

Dependency installation happens only after `InstallPackageArchive` is approved. Node packages choose `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`, `npm ci`, or `npm install` based on lockfiles and `package.json`. Python packages create `.venv`, then install `requirements.txt` or the package root. Commands run without a shell, allow lifecycle/build scripts, and time out after 10 minutes each.

Installed skills become persistent capabilities and are available to future context builds. Plugin skills are scanned from the plugin package root and can reference their own files. Package-managed MCP servers are local stdio only; relative paths and supported root placeholders are resolved to the install directory, Python MCP commands prefer the package `.venv`, and HTTP/SSE configs are skipped with warnings. The model tool definition list is regenerated on every model turn, so newly connected MCP tools can appear in the same task's next turn.

## Local MCP

Runtime 4.x includes a local stdio MCP adapter. `McpManager` stores configured servers in runtime state, starts enabled local commands on demand, performs MCP initialize plus `tools/list`, and maps discovered MCP tools into `ToolRegistry`.

MCP tools keep a public runtime name of `mcp.<serverId>.<toolName>` so they do not collide with built-in tools and so permission rules remain readable. Model requests use a safe alias such as `mcp__serverId__toolName`, because some OpenAI-compatible backends reject dotted function names. `ToolRegistry` owns that alias mapping and `ToolExecutor` resolves aliases back to public names before validation, permission checks, trace records, and UI cards.

MCP tools use the server-provided JSON schema for the same pre-execution validation path as native tools. All MCP tools are treated as dangerous by default, so they enter `PermissionPolicy` unless a rule allows them. Rules can target a single MCP tool or a server wildcard such as `mcp.local-files.*`.

Each server has a request timeout, stderr preview, recent connection/error log ring, pid, last connected time, and last exit reason. Runtime shutdown disconnects MCP child processes and fails pending requests with structured tool errors. `autoConnect` failures do not block runtime initialization; they write `mcp_server` events and update `lastError`.

Runtime 4.2 adds local MCP presets, config transfer, and diagnostics. Presets fill the MCP form as drafts only and never install third-party servers. Tool Market purchases are the installation path for packaged third-party MCP servers. Config export writes local JSON with server settings and MCP permission recommendations while redacting env values. Import creates new server ids when needed and disables `autoConnect` for imported entries. Diagnostics run a temporary stdio process through initialize and `tools/list`, collect timings, stderr, tool metadata, and schema warnings, and do not register tools or change connected server state.

Desktop IPC exposes `mcp:listServers`, `mcp:addServer`, `mcp:updateServer`, `mcp:removeServer`, `mcp:connect`, `mcp:disconnect`, `mcp:refreshTools`, `mcp:getLogs`, `mcp:listPresets`, `mcp:export`, `mcp:import`, and `mcp:diagnoseServer`. The config UI shows server status, last error, timeout, stderr preview, recent logs, presets, import/export, diagnostics, tool count, discovered tools, model alias names, and quick permission-rule actions. This adapter intentionally supports only local stdio MCP in 4.2; remote bridge, SSE/HTTP MCP, and automatic third-party server installation outside packaged Tool Market deployments remain out of scope.

## Tool Market Local Deployment

Tool Market products install as local packages, not as remote runtime calls. A catalog item can include a `localDeployment`, `local_deployment`, `deployment`, `install`, or `package` object with local files, command templates, a capability definition, and optional MCP server config. Installing a free or purchased product writes the runnable local package under `tools/<product-id>`, `skills/<product-id>`, `plugins/<product-id>`, or `mcp/<product-id>` in the runtime data directory. The market-specific `tool-market/<origin>/<product-id>/supbot-market-install.json` file is only the install receipt that points back to that local package.

Installed market products are loaded back from those local manifests, so they remain visible after restart and when the remote catalog is unavailable. Skill products contain a local `SKILL.md` when the package does not provide one. Plugin products contain `.codex-plugin/plugin.json` when the package does not provide one. Tool products contain `supbot-tool.json`. MCP products contain `supbot-mcp.json` and, with `mcpServer` metadata, register a normal local stdio MCP server in `McpManager`, then run through the same MCP connection, schema, alias, and permission paths as manually configured local MCP servers.

Uninstall removes the local package directory, the market capability, and any MCP server registered from that package. Paid products must be marked purchased by the catalog before installation.

## Permissions

`PermissionPolicy` supports `default`, `acceptEdits`, `bypassPermissions`, and `plan` modes, plus session rules with `allow`, `deny`, or `ask` behavior. Rules match by tool name or `*`.

Dangerous tool calls create `PendingToolPermission` records unless mode/rules allow or deny them directly. Desktop IPC can approve or deny once. Timeouts and denials are written back as tool errors so the model can continue with a safer plan.

## Transcript, Compact, And Memory

Each conversation has a JSONL transcript under the runtime data directory. Transcript records include messages, runtime events, compact boundaries, permission decisions, and final outputs.

`conversation:loadTranscript` returns a recoverable view, not just raw JSONL. It reads the latest compact boundary, returns active messages after that boundary, and falls back to state messages if the transcript is missing or incomplete. Damaged lines are reported as diagnostics while valid lines remain usable.

`CompactManager` performs automatic compact inside QueryEngine when token estimates cross the threshold. Manual compact writes the same boundary shape and summary block.

`MemoryManager` is the local single-user permanent memory layer. It stores memory pages, facts, chunks, links, pending candidates, recent recall history, and recall feedback inside runtime state. Recall uses keyword matching, scope filters, recency, bounded access-count weighting, and lightweight feedback weighting. It does not use embeddings or vector search yet, but the record shape keeps an optional `embedding` field for later.

Before each model turn, QueryEngine searches active memory with the latest user prompt and injects top results as a `<memory>` block. Recall results include `matchedKeywords`, `reason`, `sourceLabel`, and optional feedback state. QueryEngine records a compact recall history with query, injected hits, budget-excluded hits, score, block preview, and injection size. The memory block has a character budget so high-scored memories are kept while lower-scored overflow is excluded and visible in debug data. Main-agent recall can use global and current-conversation memory. Subagents can also use memory scoped to their own `subagentName`; subagent-scoped records are not recalled by the main agent when a main conversation scope is provided.

`memory:replayRecall` and `memory:evaluateRecall` rerun recall against the current local memory state without calling the model. Replay can compare current results to a stored recall history entry and reports added/removed memory ids. Users can write recall feedback through `memory:addRecallFeedback` with `useful`, `irrelevant`, `stale`, or `wrong`; feedback changes future recall scoring but never edits the memory text itself. Disabled/deleted records and denied candidates remain outside recall even if feedback exists.

Compact boundaries generate pending memory candidates by splitting summaries into shorter facts and filtering transient task/error output. Similar candidates are deduplicated within the same scope. Approving a candidate can merge it into an existing fact/page when the content is similar; otherwise it creates a new fact. Denied candidates remain marked as denied and are not recalled.

Manual memory management is exposed through `memory:list`, `memory:search`, `memory:add`, `memory:update`, `memory:delete`, `memory:approveCandidate`, and `memory:denyCandidate`. Runtime 3.2 also includes local JSON transfer operations: `memory:export`, `memory:import`, `memory:backup`, and `memory:restore`. The transfer format contains pages, facts, chunks, links, candidates, recall history, and recall feedback. Backups are written under `data/memory-backups`.

The active compact summary is excluded from memory recall when it would duplicate the same `<conversation_summary>` in the prompt.

## Subagents

The `Agent` tool delegates to `SubagentRunner`. A subagent runs its own QueryEngine with its own runtime context, abort controller, transcript sidechain, and read cache boundary. It inherits parent summary, tool registry, permission mode, and permission rules, but it does not inherit parent pending permissions.

Subagent events are surfaced as runtime events and desktop task/progress events. Background queues, remote agents, pgvector/embedding search, and worktree isolation remain out of scope for Runtime 4.2.

## Legacy Entry Points

`agentLoop.ts` and `contextBuilder.ts` remain as deprecated compatibility files for direct imports. New runtime work should use `QueryEngine`, `ContextManager`, `queryLoop`, `ToolExecutor`, and `ToolRegistry`.
