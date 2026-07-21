# Supbot 代码全面 Review 报告（2026-07-19）

> 审查范围：全部源码约 26k 行（apps/desktop、packages/runtime、packages/shared、packages/ui、scripts、CI）。
> 审查方式：四路并行深入审查 —— runtime 核心循环 / runtime 基础设施与外部集成 / 桌面层（main+preload+renderer）/ 工程化与测试。
> 配套的优化实施项见 beads epic「2026-07 代码全面 Review 优化」（`supbot-59g`，子项 `supbot-59g.1` ~ `supbot-59g.16`，`bd list` / `bd ready` 查看）。

## 一、总体评价

功能覆盖面广（聊天、autopilot、MCP、记忆、远端桥接、Servstation 集成），基础功扎实：

- runtime 拥有 95 个真断言集成测试（mock HTTP / mock stdio MCP / 真实 git worktree），含大量负路径用例；
- Electron webPreferences 按最佳实践锁定，`window.open` 一律拒绝，IPC 输入校验细致；
- MCP 用 spawn 数组参数避免命令注入；state.json 采用临时文件 + rename 原子写入；
- OIDC 实现了 PKCE + state 校验；remote bridge 默认只绑回环；逆向桥有指数退避重连；
- 桌面主进程对 6 类密钥做了 safeStorage 加密包装（含版本前缀与降级路径）。

主要问题集中在五个方面：

1. **一个性能黑洞**：流式 token 引发的 I/O 与渲染风暴（最高优先级）；
2. **一批生命周期/恢复路径缺陷**：可导致 run 卡死、状态静默损坏或主进程崩溃；
3. **网络与外部输入缺少资源边界**：普遍无超时、无上限；
4. **安全边界缺口**：凭据覆盖不全、供应链确认缺失、更新校验关闭；
5. **两个巨型文件**：`runtime.ts`（4731 行）与 `main.tsx`（7046 行）触达可维护性天花板。

## 二、性能：流式 token 的 I/O 与渲染风暴【最高优先级】

每个模型 token 到达时，当前链路触发：

1. `queryLoop.ts:71-83` → `queryEngine.ts:283-299` → `runtime.ts:2087-2091`：`persistAndBroadcast()` —— `storage.ts:257-268` 对**全量 state 做 pretty-print JSON 序列化并整文件重写**（队列只串行不合并），外加全量 snapshot 广播 IPC；
2. 每 token 追加一条 transcript JSONL（`runtime.ts:2669-2674`）；autopilot 路径再追加 events.jsonl；
3. 每次 snapshot 重算全部 autopilot metrics **两遍**（`runtime.ts:375, 3001-3004`：metrics map 一次，`calculateAutopilotQuality()` 内部再 map 一次；每次都是 O(runs × (tasks+actions+events)) 全数组 filter）；
4. renderer 每 token 在 App 根组件 `setSnapshot`（`main.tsx:247-292, 3567-3591`），`applyMessageDelta` 对全部会话/消息做 O(n) map，且全树无 `React.memo` → 每个 token 整棵组件树（Topbar/两侧面板/全部消息气泡）重渲染；消息列表全量渲染无虚拟化（`main.tsx:3386, 3450`）。

一轮对话几百 token = 几百次全量写盘 + 全量广播 + 全树渲染，成本随会话历史平方增长。这是线上可感的卡顿与磁盘磨损根源。

**修复方向**：流式 delta 不 persist、不落 transcript，仅内存广播；落盘改为 turn 边界一次写入 + storage 合并窗口；metrics 按 `run.updatedAt` 缓存失效；renderer 流式增量拆成独立轻量 state + memo 化。

次级热路径问题：

- `packages/ui/src/index.ts:82-92` `formatDateTime` 每次新建 `Intl.DateTimeFormat`（渲染热路径）；
- `main.tsx:5781-5796` 工具市场搜索每击键发 IPC，无防抖；
- `main.tsx:999-1012` ServerAgent 轮询 effect 依赖 `remote?.jobs`，每次轮询重建 interval，且每 2 秒 `setLoading(true)` 造成闪烁；
- `main.tsx:339-382 + 3342-3356` 滚动贴底逻辑分散在 4 个互相重叠的 effect，流式期间滚动抖动；
- `toolRegistry.ts:66-79 + mcpManager.ts:116-119` 工具定义每次查询都重建；
- `contextManager.ts:103-116` 每个 turn 从磁盘读 AGENTS.md/CLAUDE.md，无缓存。

## 三、正确性 / 生命周期缺陷

### 高

1. **无单实例锁**（`apps/desktop/src/main/index.ts:1401`）：第二个实例创建第二个 `SupbotRuntime`，调度器双跑、并发读写同一 state.json。→ `app.requestSingleInstanceLock()`，第二实例退出并聚焦已有窗口。
2. **窗口重建即重建 runtime**（`main/index.ts:466-490, 1404-1408`）：`createWindow()` 每次 `createRuntime()` + 新建 `SupbotUpdateManager`，旧 runtime 的 scheduler/事件监听从不关闭，updateManager 向单例 autoUpdater 重复注册 6 个监听（`updateManager.ts:35-81`）。→ runtime 只初始化一次，manager 提供 dispose。
3. **重启后审批 autopilot 永久卡死**（`runtime.ts:612-630 + 3310-3312`）：`recoverAutopilotRunsOnStartup` 跳过 `waiting_approval` + pendingDecision 的 run；`decideAutopilotApproval` 把状态转到 `running`/`reviewing`，而 `runAutopilot` 拒绝从这些状态启动 → 永远无人驱动。→ 决策落定时若无活跃 supervisor 则转 `queued` 并重新拉起。
4. **`void` 异步链多处 unhandled rejection**（`runtime.ts:530, 751, 1658-1660, 2274-2291`；scheduler `setInterval` 回调；`remoteBridgeManager.ts:153-154` 的 `new URL` 在 try 外）：`runAutopilot` 的 catch 里 `transitionAutopilotRun(runId,"failed")` 在终态下会再次抛出；Electron 主进程未处理 rejection 可直接崩溃。→ 所有 `void x()` 改 `void x().catch(log)`，catch 内转移失败降级为直接 patch。
5. **storage 写队列中毒**（`storage.ts:257-261`）：一次写失败后 `writeQueue` 永久 rejected，之后所有 `save()` 静默失败。→ `queue.catch(()=>{})` 自愈链接。
6. **state.json 损坏即无法启动**（`storage.ts:242-255`）：JSON 语法错误/写盘半截时 `load()` 直接抛错，无备份回退。→ 备份损坏文件并回退初始状态。
7. **自动更新关闭签名校验**（`apps/desktop/package.json:77` `verifyUpdateCodeSignature: false`）：generic HTTPS feed 拉取未签名 NSIS，无摘要校验 → 供应链攻击面。→ 增加服务端 SHA-512 校验，中期恢复代码签名。

### 中

8. **autopilot 权限超时后 pendingDecision 残留**（`runtime.ts:2872-2890` + `toolExecutor.ts:121-127`）：30s 超时记 denied 后无人清除 run 的 pendingDecision/状态，留下陈旧决策走空转路径。
9. **worktree 收尾失败把已成功 job 翻成 failed**（`runtime.ts:2054, 2136, 3528-3536`）：`completeJobWorktree` 在 `updateJob(jobId,"completed")` 之后仍在 try 块内，git 命令抛错即进 catch 改 failed。→ 收尾独立 try/catch，失败只记事件。
10. **手动 compact 丢失全部保留消息**（`runtime.ts:822-830` + `contextManager.ts:50-55`）：边界锚到最后一条消息导致切片为空（summary 是 system 角色被过滤）；`preservedMessageIds` 写入后无消费者。→ 锚点改倒数第 6 条。
11. **revokeSession 形同虚设**（`remoteBridgeManager.ts:233-247`）：所有会话共享同一 bearer token，被 revoke 的会话下次请求自动重建，访问不被阻断。
12. **MCP connect 并发竞态**（`mcpManager.ts:290-320`）：两个并发 connect 各自 spawn，先启动的子进程被覆盖且永不 kill。→ per-server 连接中 Promise 去重。
13. **checkpoint 写盘无队列且临时文件名可碰撞**（`autopilotRunStore.ts:31-36` + `runtime.ts:3089-3094`）：temp 名只有 `pid + Date.now()`，同毫秒并发可共用 temp 路径导致 rename 失败误判 run failed。
14. **非项目会话工具工作目录为 `process.cwd()`**（`runtime.ts:3348` + `localTools.ts:33-37`）：WriteFile 文档声称写到 generated-files 目录，实际写到应用 cwd（生产环境可能是安装目录）。→ 固定为 `dataDir/generated-files`。
15. **`before-quit` 不 await shutdown**（`main/index.ts:1420-1423`）：退出可能发生在状态写盘/scheduler 清理完成前。
16. **Shell 工具项目边界校验误伤 URL**（`toolExecutor.ts:260`）：正则匹配 `https://` 的 `//host`，合法命令被误判拒绝；同时可被变量拼接绕过。→ 先剥离引号内容与 URL scheme 再检测，文档明示启发式定位。
17. **调度执行健壮性弱**（`runtime.ts:1689-1704`）：一个 `sendPrompt` 抛错中断剩余到期任务且 nextRunAt 已推进 → 漏跑；每次调度新建会话，cron 长期运行无限产生会话。
18. **`job.progress` 只增不减**（`runtime.ts:2966`）：长任务 progress 数组无界增长且随全量 state 反复落盘。

### 低

19. `queryLoop.ts:59,73` `events` 数组按 token 累积但 `QueryEngine` 不消费，纯浪费。
20. `runtime.ts:3063, 421` autopilotEvents 全局 cap 500（跨 run 共享）致指标统计被截断 skew；`deleteConversation` 前缀匹配 O(n²)。
21. `runtime.ts:3274-3302` 每次启动为每个无 transcript 会话写恢复事件，噪音 + 必触发全量 save。
22. `runtime.ts:3120-3139` 产物登记整文件读入算 hash/行数，大文件应流式 sha256。

## 四、网络健壮性：无超时、无重试、无上限

1. **模型 HTTP/SSE 调用无超时无重试**（`modelAdapter.ts:66-74, 90-98`、`modelClient.ts:91-99`）：fetch 只挂用户 abort；服务端挂起或 SSE 停滞时任一 job 无限挂死；429/5xx 直接失败。→ `AbortSignal.timeout` 空闲超时 + 429/5xx 有限指数退避。
2. **servstation 全系列 fetch 无超时**（`servstationAgentClient.ts:750-776`、`servstationReverseBridgeClient.ts:504-518`、`servstationA2AProvider.ts:236-242`、`servstationOidc.ts:68-77,143`）；主进程 OIDC discovery/token exchange 无超时（`main/index.ts:260-270, 298-305`）。→ 统一封装带超时的请求助手。
3. **`runGit` 无超时未禁交互提示**（`worktreeManager.ts:205-230`）：git 凭据提示/锁等待会永久阻塞 agent 循环。→ 超时 + `GIT_TERMINAL_PROMPT=0`。
4. **MCP stdio 帧解析无上限**（`mcpManager.ts:509-525`）：恶意服务器不发 `\r\n\r\n` 或声明巨大 Content-Length 时 buffer 无界增长耗尽内存。→ header/单帧/buffer 上限，超限断开。
5. **Shell 子进程 stdout/stderr 无上限累积，Windows 下 kill 不杀进程树**（`localTools.ts:97-123`）：截断发生在收集完之后，几 GB 输出先撑爆内存；`child.kill()` 只杀 powershell 本身。→ 流式截断 + `taskkill /T /F`。
6. **ReadFile 无大小上限**（`localTools.ts:26-31`）：整文件读入内存后才截断到 24k，GB 级文件直接内存暴涨。→ 先 stat 超限拒绝。
7. **工具市场目录响应 `response.json()` 无大小上限**（`toolMarket.ts:197-204`）。
8. **逆向桥 `stop()` 不等待 loop 结束**（`servstationReverseBridgeClient.ts:126-138`）；用匹配服务端英文错误文案判定可恢复错误（`:633-638`），极脆弱 → 约定结构化错误码。

## 五、安全边界

### 凭据与传输

1. **已核实**：桌面主进程对 6 类密钥（modelSecret、toolMarket×2、servstationA2A×3）做了 safeStorage 包装（`main/index.ts:100-144`）。**缺口**：
   - remoteBridge bearer token 未纳入加密包装；
   - file 降级路径密钥由 `userDataPath+hostname+username` 哈希派生，均为本机可猜测值，仅有混淆价值（`main/index.ts:179-182`）→ 引入随机 salt 文件 + UI 明示降级风险；
   - state.json 写盘使用默认权限（0666）→ `chmod 600`。
2. **远程绑定纯 HTTP 无 TLS**（`remoteBridgeManager.ts:132, 327-333` + `storage.ts:802`）：`allowRemoteBind` 允许绑非回环地址，bearer token 与 prompt 内容局域网明文传输；`pairingCode` 直接暴露 token 前 6 位（`:293-295`）。→ 非回环绑定时强制风险提示，pairing code 与 token 解耦。
3. **OIDC `token_endpoint` 未校验与 issuer 同源**（`servstationOidc.ts:141-149`）：恶意 issuer URL 可让客户端把 refresh token POST 到攻击者端点（SSRF + 令牌外泄）。
4. **多处 URL 归一化放行 `http://`**（`toolMarket.ts:303-312, 222-231`、`main/index.ts:403`、`storage.ts normalizeHttpUrl`）：登录密码/授权码可经明文传输 → 仅 loopback 放行 http。
5. **本地 JWT 解码不验签、不校验 exp/iss**（`servstationOidc.ts:112-139`），claims 被用作身份头与本地角色判断依据。

### 供应链与输入边界

6. **工具市场 mcpServer.command/args/env 无用户确认即可注册并 autoConnect spawn**（`toolMarket.ts:447-468` + `runtime.ts:4016-4045, 1902-1904`）→ 供应链 RCE 通道。→ 安装前展示将执行的命令并要求显式确认，忽略远端 `autoConnect`。
7. **MCP spawn 透传宿主完整 `process.env`**（`mcpManager.ts:189-191, 314-316`）：含 LLM API key 等全部泄露给第三方服务器进程。→ 白名单透传。
8. **附件按路径 readFile 任意本地文件并 base64 上传远端**（`servstationAgentClient.ts:803-817`）：无路径白名单/大小上限 → 本地文件外泄风险。
9. **写沙箱只做字符串路径判定未 realpath**（`projectManager.ts:108-125`）：目录内符号链接可逃逸项目根。
10. **worktree 清理用裸 `startsWith`**（`worktreeManager.ts:167-171`）：`worktrees-evil` 同前缀兄弟目录可绕过；且 `worktree.path` 来自可被篡改的 state.json。→ `path.relative` 判定。
11. **MCP stderr 原样写入日志并广播**（`mcpManager.ts:323-330`）：可能回显 env 注入的密钥 → 密钥模式脱敏。
12. **全部 100+ 个 `ipcMain.handle` 未校验 `event.sender`**（`main/index.ts:515-701`）：纵深防御缺口 → 统一包 `assertMainSender(event)`。
13. **生产 `will-navigate` 放行任意 `file:` URL**（`main/index.ts:448-464`）→ 限定在 renderer 构建目录内。
14. **memory `importSnapshot` 不校验记录字段形状**（`memoryManager.ts:129-163, 321-338`）：导入脏数据产生 NaN 分数等问题；pages/facts/chunks 无上限。

## 六、架构债

1. **`runtime.ts` 4731 行上帝类**：聊天 job、autopilot supervisor、memory CRUD、tool market、MCP 管理、remote bridge、servstation 代理、调度器、cron 解析全在一个类（100+ 方法）。优先拆出 autopilot 段（约 1200 行）与 tool market 段，Runtime 只做编排。
2. **`main.tsx` 7046 行 / 60+ 组件**：App 持 20+ 个 useState，`t`/`snapshot` 透传 4-5 层。拆分方案：
   - `app/`：根组件、布局骨架、`LanguageProvider`（useT hook 替代透传）、`useSnapshotStore`（useReducer 集中管理 applyXxx）、`useStickToBottom`；
   - `chat/`：ChatPanel、MessageBubble、MessageBlocks、HistoryPanel、composer、TranscriptModal；
   - `server/`（+`server/mail/`）：ServerAgent 各工作区与邮件专用工具；
   - `autopilot/`：AutopilotPanel 及审批/报告/预算/质量子组件；
   - `config/`：ConfigWorkspace 各卡片与四个 Modal；
   - `market/`：MarketWorkspace；
   - `panels/` + `lib/`：右侧面板群与跨域纯函数。
   配合工作区级 `React.lazy` + vite `manualChunks` 拆 antd（当前无代码分割，`vite.config.ts`）。
3. **死代码与重复**：`runAgentLoop`（`agentLoop.ts:43`）全仓无引用；modelClient 旧链路仅 `testModelConfig` 使用；`buildSystemPrompt`/`formatUserMessage` 在 contextBuilder 与 contextManager 逐行重复；`parseToolArguments`×3、`stableJson`×2、`pathIsInside`×2；`defaultToolMarketApiUrl` 在 shared 与 renderer 双份定义（`packages/shared/src/index.ts:24`、`main.tsx:155`）。
4. **jsonSchema 校验器只支持子集关键字且静默放过未知关键字**（`jsonSchema.ts:29-91`）：`pattern`/`minLength`/数值界限等完全不校验，给出虚假安全感；`deepEqual` 键序敏感。→ 补全常用关键字。
5. **i18n 以英文原文为 key、动态 key 无法静态审计**（`i18n.ts:656-662`）：`t(event.kind)` 等漏译不可发现；`I18nValue` 接口未使用。→ 动态枚举改查表函数 + 开发期缺译告警。

## 七、工程化缺口

### 高

1. **桌面端全链路无类型检查**（`apps/desktop/package.json:18-20`）：vite/esbuild 不做 typecheck，tsconfig `noEmit` 但无人调用 tsc → 渲染进程类型错误 CI 永远发现不了。→ `typecheck` 脚本挂进 verify 与 CI。
2. **desktop 测试脚本硬编码单文件**（`apps/desktop/package.json:24`）：`vitest run src/main/updateManager.test.ts`，新增测试静默跳过 → 改 `vitest run`。
3. **未声明依赖**（`apps/desktop/package.json:29-46`）：renderer import `@supbot/ui`、test 用 `vitest` 均未声明，靠 workspace hoisting 侥幸可用。
4. **全仓无 lint/format 工具链**：无 eslint/prettier/biome 任何配置与 CI 关卡。
5. **主进程 IPC 层零单测**：1423 行含路径边界校验等安全逻辑，仅靠一条 E2E smoke 兜底 → 校验函数抽纯函数补单测。

### 中

6. **CI 仅 Windows 单 job**（`.github/workflows/verify.yml`）：无 typecheck/lint/audit 步骤、无 concurrency 取消、无 Linux 构建（尽管存在 `dist:linux`）。
7. **3 个孤儿脚本**（`packaged-window-smoke.cjs`、`verify-packaged-window.cjs`、`verify-toolsmarket-live.cjs`）未被任何 npm script 或 CI 引用；前者 `spawn(detached)+unref()` 后从不 kill，进程泄漏；后者硬编码默认邮箱打生产环境。
8. **Electron 版本双处维护**（`apps/desktop/package.json:42,50`）：devDeps 与 `build.electronVersion` 易漂移 → 去掉 electronVersion 字段。
9. **`dev` 脚本漏构建 `@supbot/ui`**（根 `package.json:17`）：全新 clone 直接 `npm run dev` 失败。
10. **无 `engines` 声明**：CI 用 Node 22、esbuild target node22，但任何 package.json 未声明。
11. **smoke 断言中文 UI 文案**（`packaged-window-smoke.cjs:71-72`、`verify-packaged-window.cjs:89-90`）：文案微调即误报 → 改断言 DOM 结构/测试 id；调试端口 9323/9333 硬编码 → 随机空闲端口。
12. **shared（1862 行含逻辑）与 ui 零测试**，两包连 `test` 脚本都没有 → 纯函数补低成本单测；全仓无 coverage 统计。

### 低

13. 根与 runtime 重复声明 `vitest` devDependency。
14. `docs/production-windows.md:10` 发布清单写 `npm install`，与可复现构建矛盾 → `npm ci`。
15. `tsconfig.base.json:5,9` 旧式 `moduleResolution: "Node"`，未开 `noUncheckedIndexedAccess`，`skipLibCheck` 掩盖类型冲突。
16. `scripts/electron-smoke.cjs:876` smoke 种子数据写入生产 apiUrl `https://i-shu.com` → 改 mock 地址。
17. `updateManager.ts:189` 配置了 Linux AppImage/deb 但 updater 仅 win32-x64 启用且 feed 写死 → 文档注明或按平台参数化。
18. autopilot benchmark 仅两个场景 fixture，作为发布门禁偏薄。

## 八、优化方案与 issue 映射

执行顺序 P0 → P1 → P2 → P4 → P3（P3 拆分放最后，避免大 diff 掩盖行为修复）。每个阶段对应 beads issue（epic「2026-07 代码全面 Review 优化」）：

| 阶段 | Issue | 内容 |
|------|-------|------|
| P0 | #1 流式 message_delta 轻量化 | delta 不 persist/不落 transcript，turn 边界落盘 |
| P0 | #2 storage 保存合并与韧性 | dirty+合并窗口、写队列自愈、损坏回退、chmod 600 |
| P0 | #3 snapshot metrics 缓存 | 按 updatedAt 失效（blocked by #1） |
| P0 | #4 renderer 流式渲染分层 | 独立 delta state + memo + 热路径小修 |
| P1 | #5 Electron 生命周期 | 单实例锁、runtime 单例、退出 await |
| P1 | #6 异步兜底 | void().catch、scheduler 容错、终态降级 |
| P1 | #7 autopilot 恢复路径 | 重启审批恢复、超时清 pendingDecision |
| P1 | #8 网络超时/重试 | fetch 助手、模型+servstation 接入、runGit |
| P1 | #9 资源边界 | MCP 帧/Shell/ReadFile/流式 hash |
| P1 | #10 正确性散修 | connect 竞态、revokeSession、worktree 收尾等 |
| P2 | #11 凭据与传输安全 | token 加密、降级 salt、OIDC 同源、http 限制 |
| P2 | #12 供应链与输入边界 | 市场安装确认、env 白名单、realpath、更新校验 |
| P4 | #13 桌面端工程化 | typecheck、测试通配、依赖、lint、CI |
| P4 | #14 脚本与测试卫生 | 孤儿脚本、smoke 断言、shared/ui 单测 |
| P3 | #15 runtime.ts 拆分 | autopilot 段 + tool market 段（blocked by #1,#2,#6,#7,#10） |
| P3 | #16 main.tsx 拆分 | 8 模块 + 懒加载 + 死代码清理（blocked by #4） |

## 九、验证策略与取舍

- 每阶段：`npm run test` + `npm run smoke:electron`；P0 前后各跑 `npm run benchmark:autopilot` 对比；P4 后跑完整 `npm run verify`。
- 每个 bug 修复附回归测试（runtime 已有 mock HTTP/MCP/git worktree 基建）。
- 取舍：流式 delta 不落盘 → 极端崩溃丢失最后几百 ms 流式文本（可接受，turn 边界有完整记录）；拆分为纯移动式重构；工具市场安装确认改变自动化体验但供应链风险必须用户知情；jsonSchema 补全关键字而非引 ajv（不新增依赖）。
