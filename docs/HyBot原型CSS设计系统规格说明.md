# HyBot 桌面端原型 V5 — CSS 设计系统规格说明

> 分析对象：`docs/HyBot桌面端原型_V5.html` 中 `<style>` 块（第 7–4980 行，`</style>` 结束），对照 HTML 结构（4983–12311 行）与当前应用 `apps/desktop/src/renderer/styles.css`（3832 行）。
> 目标：把真实应用（React + Vite，`apps/desktop/src/renderer`）的 UX 改成原型样式。
> 所有行号均指 `docs/HyBot桌面端原型_V5.html`，除非另注明。

---

## 1. 设计令牌（Design Tokens）

### 1.1 CSS 变量（第 9–38 行 `:root`）

| 变量               | 值                               | 用途                                    |
| ------------------ | -------------------------------- | --------------------------------------- |
| `--bg-main`        | `#ffffff`                        | 主背景（白）                            |
| `--bg-card`        | `#ffffff`                        | 卡片背景（白）                          |
| `--bg-input`       | `#f0f2f5`                        | 输入/分段控件底色                       |
| `--bg-hover`       | `#e6e9f0`                        | 通用 hover 底色                         |
| `--bg-tertiary`    | `#edf0f5`                        | 三级背景（场景提示条等）                |
| `--border-color`   | `#dde0e5`                        | 常规边框                                |
| `--border-light`   | `#ccd0d8`                        | 更浅/更明显的分隔边框                   |
| `--text-primary`   | `#1a1d23`                        | 主文本（近黑）                          |
| `--text-secondary` | `#5a6070`                        | 次级文本                                |
| `--text-muted`     | `#8e94a0`                        | 弱化文本                                |
| `--accent`         | `#3b82f6`                        | 主题蓝（主色）                          |
| `--accent-hover`   | `#2563eb`                        | 主色 hover                              |
| `--accent-bg`      | `#eff6ff`                        | 主色浅底（选中/激活态）                 |
| `--accent-light`   | `#dbeafe`                        | 主色更浅（边框/图标底）                 |
| `--accent-glow`    | `rgba(59,130,246,0.12)`          | 焦点光环/发光                           |
| `--success`        | `#10b981`                        | 成功（绿）                              |
| `--warning`        | `#f59e0b`                        | 警告（琥珀）                            |
| `--danger`         | `#ef4444`                        | 危险（红）                              |
| `--user-bubble`    | `#eff6ff`                        | 用户气泡底色                            |
| `--ai-bubble`      | `#f0f2f5`                        | AI 气泡底色（原型中 AI 气泡实际为透明） |
| `--radius-sm`      | `6px`                            | 小圆角                                  |
| `--radius-md`      | `10px`                           | 中圆角                                  |
| `--radius-lg`      | `16px`                           | 大圆角（输入框）                        |
| `--radius-xl`      | `24px`                           | 超大圆角（弹窗/胶囊）                   |
| `--shadow-sm`      | `0 1px 3px rgba(0,0,0,0.06)`     | 卡片轻阴影                              |
| `--shadow-md`      | `0 4px 12px rgba(0,0,0,0.08)`    | 场景卡片阴影                            |
| `--shadow-glow`    | `0 0 20px var(--accent-glow)`    | 蓝色发光（发送按钮 hover）              |
| `--transition`     | `0.2s cubic-bezier(0.4,0,0.2,1)` | 统一过渡曲线                            |

**注意**：`.menu-item-icon`（548 行）引用了 `var(--desktop-icon)`、`.menu-item.active .menu-item-icon`（550 行）引用 `var(--desktop-icon-active)`，但 `:root` 中**未定义**这两个变量（原型遗留 bug），浏览器会回退到继承色。移植时应在 `:root` 补上，例如 `--desktop-icon: #5a6070; --desktop-icon-active: var(--accent);`。

### 1.2 字体族与字号层级

- 全局字体（505 行）：`font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif;`
- 等宽字体（内联出现）：`ui-monospace, 'SF Mono', Menlo, Consolas, monospace`（2556、2571、2917、3934 行）；调度日志明细用 `"SF Mono", "Menlo", "Consolas", "Microsoft YaHei", monospace`（3934 行）
- Word 纸张正文（3447 行）：`"PingFang SC", "Microsoft YaHei", "SimSun", serif`

字号层级（px）：

| 用途                        | 字号              | 行号示例               |
| --------------------------- | ----------------- | ---------------------- |
| Hero 大标题 h1 / 面板大标题 | 22px / 700        | 1211、981、3608        |
| 弹窗标题                    | 15–16px / 600     | 1567、1802、2300、2653 |
| 页面/卡片标题               | 13–14px / 500–600 | 158、490、1037、2420   |
| 正文/输入                   | 13–14px           | 4491、495、1666        |
| 次级/描述                   | 12–12.5px         | 166、1927、2513        |
| 辅助/时间/元信息            | 10–11.5px         | 163、397、641、4749    |

### 1.3 间距规律

- 4px 基础网格：`gap: 4/6/8/10/12/14/16/18/20/22/24`，几乎全为 2px 的整数倍
- 弹窗内边距惯例：header `16px 22px`（大弹窗）或 `18px 22px 14px`（小弹窗）；body `24px 28px`（config modal）/ `18px 22px`（subagent）/ `8px 22px 18px`（custom model）；footer `14px 22px` + `background: #fafbfc`
- 输入控件：高 38px（`addmodel-input`/`subagent-input`），`padding: 7px 10px`（config-input），圆角 6px，focus 时 `border-color: var(--accent)` + `box-shadow: 0 0 0 3px var(--accent-glow)`

### 1.4 动效与关键帧

| 动画                                                                              | 定义行    | 使用处                   |
| --------------------------------------------------------------------------------- | --------- | ------------------------ |
| `fadeIn`（opacity 0→1, translateY(10px)→0）                                       | 1197      | 遮罩、下拉、弹窗 overlay |
| `msgIn`（opacity 0→1, translateY(8px)→0, 0.3s）                                   | 4375      | 消息入场                 |
| `flyoutSlide`（translateX(-6px)→0, 0.18s ease-out）                               | 948–951   | 左侧 flyout 面板         |
| `toastFade`（2.4s 淡入淡出）                                                      | 952–957   | Toast                    |
| `configModalIn`（translateY(8px) scale(0.98)→1, 0.22s cubic-bezier(0.4,0,0.2,1)） | 1555–1558 | 所有居中弹窗             |
| `subAgentModalIn`（translateY(12px) scale(0.97)→1, 0.22s）                        | 1793–1796 | 子智能体弹窗             |
| `loginFadeIn`（translateY(20px) scale(0.97)→1, 0.5s）                             | 4907–4910 | 登录卡片                 |

### 1.5 z-index 层级表（重要）

| 层级  | 元素                                      | 行号          |
| ----- | ----------------------------------------- | ------------- |
| 10000 | 登录页 overlay                            | 4897          |
| 5000  | IT 便利贴                                 | 1358          |
| 900   | Toast                                     | 961           |
| 999   | model-select-menu（自定义模型下拉）       | 2767          |
| 345   | 新建自动驾驶流程弹窗                      | 3269          |
| 340   | 添加模型 / 添加自动化弹窗                 | 2080、3166    |
| 335   | 文件夹选择器                              | 2987          |
| 330   | 创建项目弹窗                              | 2833          |
| 320   | 导入记忆 / 自定义模型弹窗                 | 2276、2629    |
| 300   | Agent 配置 / 子智能体弹窗                 | 1537、1777    |
| 230   | 管理面板（右侧滑入）                      | 212           |
| 220   | 通知/上下文/版本下拉                      | 107、376、465 |
| 200   | overlay-backdrop（技能市场/项目）         | 1259          |
| 110   | 主区域右上角三弹窗                        | 1410          |
| 100   | main-corner-toolbar / new-project-popup   | 1368、584     |
| 60    | permission / action 下拉                  | 4537、3654    |
| 30    | flyout / doc-panel-toggle                 | 941、3551     |
| 20    | sentiment-event overlay / history-sidebar | 4768、517     |
| 10    | input-bar                                 | 4475          |

---

## 2. 整体布局系统

### 2.1 骨架（43–45、500–502 行）

```
.app-root                     # flex column, height 100vh
├── .app-topbar               # 56px, #FFFFFF（46–50）
│   ├── .app-topbar-left      # 260px, #f7f8fa, padding 0 16px（51–57）
│   ├── .app-topbar-center    # flex:1, justify-content:flex-end, padding 0 20px, gap 18px（58–63）
│   └── .app-topbar-actions   # gap 4px, padding 0 12px（64–69）
└── .app-below                # flex row, overflow hidden, position relative（500–502）
    ├── .history-sidebar      # 260px, #f7f8fa, z-20（514–519）
    ├── .main                 # flex:1, min-width:0, #ffffff, relative（1094–1097）
    │   └── .main-body        # flex column（1100–1103）
    ├── .right-panel          # 300px（遗留，见 6.4）（4721–4727）
    └── .doc-panel            # 520px, 可拖拽/折叠（3364–3373）
```

- body（504–511）：`height:100vh; overflow:hidden; display:flex;`
- 全局 reset（40 行）：`* { margin:0; padding:0; box-sizing:border-box; }`

### 2.2 关键精确尺寸

| 区域           | 尺寸/颜色/边框                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 顶栏           | 高 56px、纯白 `#FFFFFF`                                                                                                |
| 顶栏左侧       | 宽 260px、背景 `#f7f8fa`（与侧栏同色，视觉上连成一片）                                                                 |
| 顶栏中央       | `flex:1`、右对齐、padding `0 20px`、gap `18px`                                                                         |
| 顶栏右侧动作区 | gap `4px`、padding `0 12px`、`margin-left:auto`                                                                        |
| 左侧栏         | 宽 260px、`#f7f8fa`、`border` 无（靠色差分隔）                                                                         |
| 主区域         | `flex:1`、白底、`position:relative`（右上角工具条定位锚点）                                                            |
| 右侧面板       | 宽 300px、白底、`border-left: 1px solid var(--border-color)`（4721–4727，原型中无对应 HTML，遗留）                     |
| Word 文档面板  | 宽 520px、白底、`border-left: 1px solid var(--border-light)`、带 `::before` 拖拽热区（9px 宽 col-resize）（3364–3384） |
| flyout 面板    | `left:255px; top:0; width:calc(100vw - 300px - 255px); bottom:170px;` 背景 `#fafafa`（939–946）                        |

### 2.3 响应式断点（4688–4718）

- `@media (max-width: 900px)`（4689）：`.history-sidebar` 与 `.right-panel` 直接 `display:none`
- `@media (max-width: 1280px)`（4692–4707）：顶栏左/侧栏收窄到 **185px**（padding `0 10px`）、右栏 205px、flyout 左偏移 185px、logo 90×26、输入栏 `max-width:90%`
- `@media (min-width:1281px) and (max-width:1500px)`（4710–4718）：顶栏左/侧栏 **215px**、右栏 245px、输入栏 `width:90%; max-width:960px`
- 移动端（≤900px）仅隐藏侧栏，无专门移动布局（原型是桌面端原型）

---

## 3. 各主要 UI 区块样式规格

### 3.1 顶栏

#### 3.1.1 通用图标按钮 `.topbar-icon-btn`（70–91）

34×34px、无边框透明底、圆角 6px、`color: var(--text-secondary)`；hover：`background: rgba(0,0,0,0.06)`、文字变 `--text-primary`；`.topbar-icon-badge`：8×8px 红点 `#ef4444`、`border: 2px solid #eef0f3`，定位 `top:6px; right:8px`。

#### 3.1.2 模式切换 `.mode-toggle`（1149–1166）

`display:flex`、`background: var(--bg-input)`、`border: 1px solid var(--border-light)`、圆角 `--radius-sm`。按钮 `.mode-toggle-btn`：`padding: 6px 14px`、12px/500、`--text-muted`；`.active`：`background:#e5e7eb`、`color:--text-primary`、`box-shadow: 0 1px 2px rgba(0,0,0,0.04)`；hover（非 active）：`--bg-hover`。

> 注：原型 HTML 中未实际渲染 mode-toggle（仅 CSS 与媒体查询引用 61、4704、4715 行），为遗留样式；移植时可保留作为分段控件模板。

#### 3.1.3 消息通知下拉（93–200）

- 容器 `.topbar-notify-dropdown`：`position:relative`；`.open` 时按钮高亮 `rgba(0,0,0,0.06)`，红点边框变白
- 面板 `.topbar-notify-panel`（97–113）：绝对定位 `top:calc(100% + 6px); right:0`，宽 360px、`max-height:480px`，白底、`border:1px solid var(--border-light)`、圆角 10px、`box-shadow: 0 12px 32px rgba(0,0,0,0.16)`、`z-index:220`、`display:none` + `fadeIn 0.16s`；`.open` 时 `display:flex`
- 头部：`padding:12px 16px`、下边框 `--border-light`；标题 14px/600；"全部已读" 12px `--accent`
- 列表项 `.topbar-notify-item`（130–140）：`padding:12px 16px`、下边框、hover `--bg-hover`；`.unread`：`background: rgba(59,130,246,0.04)`，hover `rgba(59,130,246,0.08)`
- 图标 `.topbar-notify-icon`：32×32 圆形，类型色：update `#dbeafe/#2563eb`、task `#dcfce7/#16a34a`、alert `#fef3c7/#d97706`、system `#f3e8ff/#9333ea`（148–151）
- 描述两行截断：`-webkit-line-clamp:2`（168–169）；时间 11px `--text-muted`；未读红点 6px `#ef4444`
- 底部 footer：`padding:8px 16px`、`background: var(--bg-hover)`、计数 11px

#### 3.1.4 管理面板（右侧栏滑入，202–349 + HTML 12172–12270）

- 触发按钮 `.topbar-text-btn`（185–200）：`padding:6px 12px`、12.5px、`--text-secondary`、hover `rgba(0,0,0,0.06)`
- 面板 `.topbar-manage-panel`（205–222）：`position:fixed; top:0; right:0; bottom:0;` 宽 **480px**、白底、`border-left:1px solid var(--border-color)`、`box-shadow: -8px 0 24px rgba(0,0,0,0.10)`、`z-index:230`、`transform:translateX(100%)` 隐藏，`.open` 时 `translateX(0)`，**`transition: transform 0.24s ease`**（右滑入动画）
- 头部 `.topbar-manage-panel-header`：`padding:6px`、`background:var(--bg-hover)`、下边框
- Tab 条 `.topbar-manage-panel-tabs`（229–235）：`flex:1`、`gap:4px`、下边框 `--border-color`；Tab `.active`：`--accent` + 600 + `::after` 底部 2px 蓝条（`left:8px; right:8px; bottom:-1px`）
- Body：`flex:1; overflow-y:auto; padding:14px 16px`；Pane `.topbar-manage-panel-pane`：`display:none`，`.active` 时 `display:flex; flex-direction:column`，复用主区域的 `mem-intro / mdl-list / mcp-*` 样式
- 内容复用：模型 tab 用 `mem-intro-title + mcp-config-btn + mdl-list`（12188–12195）；MCP tab 用 `mcp-pane/mcp-header/mcp-search/mcp-empty/mcp-cards`（12199–12230）；子智能体 tab 用 `mdl-list`（12258–12266）

#### 3.1.5 上下文压缩下拉（351–432）

- 触发 `.topbar-context-trigger`：`padding:6px 10px`、12px、hover/`.open` 高亮 `rgba(0,0,0,0.06)`
- 菜单 `.topbar-context-menu`（367–380）：`top:calc(100% + 6px); right:0; min-width:240px`、白底、圆角 8px、`box-shadow: 0 8px 24px rgba(0,0,0,0.14)`、`padding:4px`、`z-index:220`、`fadeIn 0.16s`
- 选项 `.topbar-context-option`：`padding:8px 10px`、圆角 5px、hover `--bg-hover`、`.selected` `--accent-light`；标题 13px/500、描述 11px `--text-muted`、选中勾 `--accent` 12px/700
- 用量进度条（404–427）：文字 11.5px，`bar` 高 6px `--bg-hover` 圆角 3px，`fill` 渐变 `linear-gradient(90deg,#3b82f6,#6366f1)`、`transition:width 0.3s ease`
- 分隔线 `.topbar-context-divider`：1px `--border-light`，`margin:4px 6px`

#### 3.1.6 HyBot 版本下拉（个人版/企业版，434–499）

- 按钮 `.hb-version-btn`：`padding:5px 8px`、13px、`--text-primary`、hover `rgba(0,0,0,0.06)`；caret 旋转 180°（`.open`）
- 菜单 `.hb-version-menu`（455–469）：`top:calc(100% + 6px); left:0; min-width:220px`，样式同上下文菜单
- 条目 `.hb-version-item`：`padding:8px 10px`、圆角 5px、hover `--bg-hover`；图标 28×28 圆角 6px `--accent-bg/--accent`；标题 13px/500、描述 11px `--text-muted`；`.active .hb-version-item-check`（✓ `--accent` 14px/600）显示

#### 3.1.7 账号弹窗（764–936）

- 底部条 `.sidebar-account`（769–777）：`padding:10px 12px`、`background:#eaecf0`、`border-top:1px solid var(--border-color)`、hover `--bg-hover`；头像 32×32 渐变 `linear-gradient(135deg, var(--accent), #6366f1)` 白字
- 弹窗 `.account-popup`（798–812）：**向上展开** `position:absolute; bottom:calc(100% + 8px); left:8px; right:8px;`、白底、圆角 12px、`box-shadow: 0 12px 32px rgba(15,23,42,0.22)`、`z-index:80`、`display:none`，`.open` 显示
- 头部：`padding:12px 12px 10px`、下边框；头像 36×36 同渐变；在线绿点 8px `#10b981`；版本号 11px `--text-muted`
- 行 `.account-popup-row`（854–879）：`padding:9px 12px`、圆角 6px、`margin:0 4px`、13px、hover `--bg-hover`；`.logout` 红字 `#ef4444`、hover `#fef2f2`
- 分段控件 `.account-popup-segmented`（909–936）：`background:#f0f2f5` + `border:1px solid var(--border-light)`、圆角 6px、`padding:2px`、`max-width:200px`；按钮 `.account-segmented-btn`：`padding:4px 8px`、11.5px；`.active` 白底 + `box-shadow: 0 1px 2px rgba(0,0,0,0.06)`

### 3.2 左侧历史栏（513–936）

#### 3.2.1 主菜单 `.sidebar-menu`（527–598）

- 容器：`padding:8px 10px 4px`
- `.menu-item`（533–540）：`padding:11px 10px`、圆角 6px、13px/400、`color:#374151`、`position:relative`；hover `#eceff3`；`.active` `background:#e7edf7; color:#111827; font-weight:600`
- 图标 18×18，svg 17×17；`.menu-item[data-menu="newtask"]` 去除 gap（554 行）
- `.menu-item-add`（556–572）：22×22、`opacity:0`，hover 行时出现（`opacity:1`），hover 时 `--accent-bg/--accent`
- `.new-project-popup`（573–598）：`position:absolute; top:50%; right:0; transform:translate(4px,-50%);`、`min-width:160px`、白底圆角 8px、`box-shadow: 0 8px 24px rgba(0,0,0,0.18)`、`z-index:100`

#### 3.2.2 会话列表（600–689）

- `.sidebar-history`：`flex:1; min-height:0; padding:20px 6px 4px;`
- 标题行 `.sidebar-history-header`：11px/600 `--text-muted`、`letter-spacing:0.4px; text-transform:uppercase;`；搜索图标 hover 高亮
- 列表 `.sidebar-history-list`：`flex:1; overflow-y:auto; padding:0 4px 6px;`，滚动条 5px、thumb `#d1d5db`（625–627）
- 项 `.sidebar-history-item`（628–643）：`padding:9px 8px`、圆角 5px、12.5px、`margin-bottom:1px`、hover `--bg-hover`；标题单行省略；时间 10px `--text-muted`
- `.sidebar-history-toggle`（648–658）：12px、`margin-top:4px`、hover 变 `--accent`
- 删除按钮 `.sidebar-history-item-delete`（670–689）：20×20、`display:none`、行 hover 显示；hover `rgba(239,68,68,0.1)/#ef4444`
- 项目项激活态 `.sidebar-history-item-project.active`（665–669）：`--accent-bg/--accent/500`

#### 3.2.3 项目分组（660–762）

- `.sidebar-projects`：`flex-shrink:0; padding:8px 6px 4px;`，`.collapsed` 时隐藏列表、caret 旋转 -90°
- 组头 `.sidebar-projects-header`：11px/600 `--text-muted`、`letter-spacing:0.04em; text-transform:uppercase;`
- 计数徽章 `.sidebar-projects-count`：`background:#f0f2f5`、10.5px、圆角 100px
- 项目上下文横幅 `.project-context-banner`（692–726）：`padding:8px 18px`、渐变 `linear-gradient(90deg,#eef2ff,#f0f9ff)`、`border-bottom:1px solid #e0e7ff`、12.5px、文字 `#3730a3`、项目名加粗 `--accent`

#### 3.2.4 账号区（764–795）见 3.1.7

#### 3.2.5 Flyout 面板（技能页风格，938–1091）

- 容器 `.hs-flyout`（939–946）：`position:absolute; left:255px; top:0; width:calc(100vw - 300px - 255px); bottom:170px;`、`#fafafa`、`z-index:30`、`animation: flyoutSlide 0.18s ease-out`
- 头部 `.hs-flyout-header`（973–976）：`padding:24px 28px 16px`、白底、`border-bottom:1px solid var(--border-color)`；标题 22px/600 `letter-spacing:-0.01em`
- Tab 行 `.hs-flyout-tabs`（988–998）：`padding:0 28px`、白底、下边框；Tab `padding:11px 16px`、13px/500、`#6b7280`、`border-bottom:2px solid transparent`；`.active`：`--text-primary` + 2px `--accent` 底边
- Body（1001–1007）：`flex:1; overflow-y:auto; padding:20px 28px; background:#fafafa`，滚动条 5px
- 卡片网格 `.hs-card-grid`（1016–1019）：`repeat(auto-fill, minmax(280px,1fr)); gap:14px`
- 技能卡 `.hs-card`（1022–1053）：白底、`border:1px solid #e5e7eb`、圆角 10px、`padding:18px 20px`、`gap:14px`；hover：`border-color:#c7d2fe; box-shadow: 0 2px 8px rgba(99,102,241,0.08)`；图标 44×44 圆角 10px `#f0effa`；描述 12px `#9ca3af` 两行截断
- 开关 `.hs-plugin-toggle`（1056–1068）：36×20 圆角 10px、`#d1d5db`；`.on` 时 `--success`，thumb 16px 白、`left:2px→18px`
- 分类标签 `.hs-tag`（1074–1080）：`padding:5px 12px`、圆角 100px、白底 `#e5e7eb` 边框 `#6b7280`；hover/`.active` 蓝色系（`--accent`、`.active` 用 `--accent-bg` 底 + `--accent-light` 边框）

### 3.3 主区域

#### 3.3.1 结构（1093–1142）

- `.main`：`flex:1; height:100%; flex-direction:column; min-width:0; background:#ffffff; position:relative;`
- `.main-body`：`flex:1; flex-direction:column; overflow:hidden;`
  - `.idle-mode`：内容**垂直水平居中**，hero `flex:0 0 auto; padding:0 20px 12px; justify-content:center`，输入栏 `flex:0 0 auto; position:static; width:94%; max-width:1050px; padding:12px 5vw 24px; margin:0 auto`（1104–1124）
  - `.scene-active` / `.flyout-open`：`justify-content:flex-end`，隐藏 hero 与 content-wrap（1133–1142）
- 右上角工具栏隐藏规则（1127–1130）：`.main:has(.main-body.idle-mode) .main-corner-toolbar, .main:has(.main-body.menu-mode) .main-corner-toolbar { display:none; }` —— 使用 **`:has()`**，需较新 Chromium/Electron 支持
- `.main-topbar`（1144–1147）：48px、白底、`justify-content:flex-end; padding:0 20px`（遗留，未在 HTML 使用）

#### 3.3.2 Hero 居中标题（1191–1212）

- `.main-hero`：`flex-direction:column; align-items:center; justify-content:flex-end; padding:0 20px 30px; min-height:30vh;`
- Logo svg：140×44；h1：22px/700 `--text-primary`；副标题 13px `--text-secondary`

#### 3.3.3 技能标签 `.skill-tags / .skill-tag`（1215–1231）

- 容器：`display:flex; gap:8px; flex-wrap:nowrap;`
- 标签：`padding:6px 14px`、圆角 `--radius-xl`（24px 胶囊）、12px、白底、`border:1px solid var(--border-color)`、`--text-secondary`；hover：`--accent-bg` 底 + `--accent` 边框/文字 + `translateY(-1px)` + `box-shadow: 0 2px 8px rgba(59,130,246,0.1)`；`.active`：`#e5e7eb` 底、`--text-primary`

#### 3.3.4 技能轮播 Carousel（1233–1255）

- `.skill-carousel-wrap`：`display:flex; align-items:center; gap:4px; padding:0 4px 10px; max-width:66.6%; margin:0 auto;`
- 箭头 `.skill-carousel-arrow`：28×28 圆形、`border:1px solid var(--border-color)`、白底、`box-shadow:var(--shadow-sm)`；hover `--bg-hover` + `--accent`；`:active { transform: scale(0.93); }`
- `.skill-carousel-track`：`display:flex; gap:8px; transition: transform 0.32s cubic-bezier(0.22,0.61,0.36,1);`

#### 3.3.5 技能市场 + 项目覆盖面板（1256–1308）

- 遮罩 `.overlay-backdrop`（1257–1263）：`position:fixed; inset:0; background:rgba(0,0,0,0.35); z-index:200; display:flex; align-items:center; justify-content:center; animation:fadeIn 0.2s;`，`.hidden` 隐藏
- 面板 `.skills-panel / .projects-panel`（1264–1269）：白底、圆角 `--radius-xl`、`max-width:780px; width:90vw; max-height:80vh; overflow-y:auto; box-shadow: 0 20px 60px rgba(0,0,0,0.25); padding:28px 24px 24px;`
- `.panel-header`（1270–1275）：`margin-bottom:20px; padding-bottom:14px; border-bottom:1px solid var(--border-color)`；h2 18px/700
- `.panel-close-btn`：32×32 圆形、`--bg-hover` 底、18px、hover `--border-color`
- 网格 `.skills-grid/.projects-grid`：`repeat(auto-fill, minmax(210px,1fr)); gap:12px`
- 卡 `.skill-card/.project-card`（1287–1308）：`padding:14px 16px`、圆角 `--radius-md`、`border:1px solid var(--border-color)`；hover：`--accent` 边框 + `--accent-bg` 底 + `translateY(-1px)`；状态徽章：active `#dcfce7/#166534`、planning `#fef3c7/#92400e`、done `#f0f2f5/#5a6070`

#### 3.3.6 菜单面板 `.menu-panel`（1322–1326、3603–3699）

- 容器：`flex:1; padding:24px 32px; overflow-y:auto; background:var(--bg-main);`
- 头部 `.menu-panel-header`：`display:flex; justify-content:space-between; margin-bottom:18px;`；标题 22px/600、副标题 13px `--text-muted`
- 动作按钮 `.menu-panel-action-btn`（3621–3639）：`padding:7px 14px`、圆角 6px、13px/500、白底 + `--border-light` 边框；`.primary`：`#e5e7eb` 底 `#d1d5db` 边框，hover `#d1d5db` + 轻阴影
- 分段控件 `.segmented-control`（3675–3699）：`background:#f0f2f5; border:1px solid var(--border-light); border-radius:6px; padding:2px;`；`.segmented-btn`：`padding:6px 14px`、12px；`.active` 白底 + `box-shadow: 0 1px 2px rgba(0,0,0,0.06)`
- 动作下拉 `.action-dropdown-menu`（3642–3667）：`top:calc(100% + 4px); min-width:160px`、白底圆角 8px、`box-shadow: 0 8px 24px rgba(0,0,0,0.14)`、`z-index:60`

#### 3.3.7 IT 便利贴/标注覆盖层（1332–1361）

- `.dev-sticky-note`（1343–1361）：`position:fixed; top:88px; right:32px; width:280px; min-height:56px; padding:10px 12px; background:rgba(251,146,60,0.92); color:#1f2937; 12.5px/600; border:1px solid rgba(234,88,12,0.6); border-radius:4px; z-index:5000; pointer-events:none;` —— 开发标注，正式版应删除
- `.account-popup-row-tip`（1333–1342）：右上角小橙色提示胶囊（`#b45309/#fef3c7/#fde68a`）

#### 3.3.8 右上角三个图标工具栏（1363–1531）

- `.main-corner-toolbar`（1364–1369）：`position:absolute; top:12px; right:16px; display:flex; gap:2px; z-index:100;`
- `.main-corner-btn`：32×32、圆角 6px、hover `rgba(0,0,0,0.06)`、`.active` `--accent-bg/--accent`
- 徽章 `.main-corner-badge`（1388–1400）：`min-width:14px; height:14px; border-radius:7px; background:#ef4444; color:#fff; font-size:9px; border:1.5px solid #fff;`（右上角计数）
- 弹窗 `.main-corner-popup`（1401–1416）：`position:absolute; top:50px; right:16px; width:320px; max-height:60vh;` 白底圆角 10px、`box-shadow: 0 8px 28px rgba(0,0,0,0.14)`、`z-index:110`、`fadeIn 0.16s`；搜索条/头部/body/关闭按钮见 1417–1457
- 搜索结果 `mark` 高亮（1476–1477）：`background:#fef3c7; color:#92400e;`

### 3.4 聊天区（4370–4470）

- `.messages`（4371）：`flex:1; display:flex; flex-direction:column; gap:18px;`
- `.message`（4372）：`display:flex; gap:12px; max-width:80%; animation: msgIn 0.3s ease;`
  - `.user`（4376）：`align-self:flex-end; flex-direction:row-reverse; max-width:70%;`
  - `.ai`（4377–4381）：`align-self:flex-start; max-width:100%;`，`.msg-body` 内 `max-width:960px; margin:0 auto;`
- 头像：`.msg-avatar` 32×32 圆形；`.message.user .msg-avatar` 用 `--accent-light` 底；**AI 消息隐藏主头像**（4387），改用头部行 `.msg-header`（4388–4401）：`display:flex; gap:8px; 13px/600; margin-bottom:6px;`，其中 `.msg-header-avatar` 28×28 圆形 `--accent-bg/--accent` 白边
- 气泡 `.msg-bubble`（4402–4414）：`padding:12px 16px; border-radius:var(--radius-md); font-size:13px; line-height:1.6; border:1px solid;`
  - 用户：`background:var(--user-bubble); border-color:var(--accent-light); border-bottom-right-radius:3px;`
  - AI：`background:transparent; border-color:transparent; padding:0;`（无边框气泡，14px/1.8）
- Markdown 元素（4415–4419）：
  - `code`：`background:rgba(0,0,0,0.05); padding:2px 6px; border-radius:3px; font-size:12px; font-family:'SF Mono',monospace;`
  - `pre`：`background:rgba(0,0,0,0.04); padding:10px; border-radius:var(--radius-sm); overflow-x:auto; margin:6px 0; font-size:12px;`
  - `table`：`width:100%; border-collapse:collapse; margin:6px 0; font-size:12px;`，th/td `padding:5px 10px; border:1px solid var(--border-light); text-align:left;`，th `background:rgba(59,130,246,0.07);`
- AI 输出操作条 `.msg-actions`（4422）：`display:flex; gap:4px; margin-top:8px;`
  - `.msg-action-icon`（4423–4434）：28×28、圆角 6px、`--text-muted`；hover `--bg-hover/--text-primary`；`.active` `--accent-bg/--accent`
  - Tooltip（4436–4470）：纯 CSS `[data-tip]::before/::after`，深色 `#1f2937` 文字气泡 + 三角箭头（`::after` 用 `border` 画）
- 文档链接卡 `.chat-doc-link`（3566–3601）：`display:flex; gap:12px; padding:12px 16px; margin-top:10px; background:#f3f3f3; border-radius:18px;` hover `translateY(-1px)` + 蓝色阴影；图标 36×36 圆角 6px `#eff6ff/--accent`；标题 13px/500、元信息 11px `--text-muted`

### 3.5 输入栏（4472–4685）

- `.input-bar`（4473–4477）：`background:var(--bg-main); padding:12px 5vw 24px; width:94%; max-width:1050px; margin:0 auto; z-index:10;`（idle 模式由 1111–1115 覆盖为 `flex:0 0 auto; position:static;`）
- `.input-wrapper`（4479–4494）：白底、`border:1px solid var(--border-color)`、圆角 `--radius-lg`（16px）、`flex-direction:column; max-width:100%;`
  - `:focus-within`：`border-color:var(--accent); box-shadow: 0 0 0 3px var(--accent-glow);`（整体聚焦环）
  - textarea：`flex:1; background:transparent; border:none; outline:none; 14px; padding:10px 14px; resize:none; line-height:1.45; max-height:277px; min-height:72px;`，placeholder 13px `--text-muted`
- `.input-footer`（4496–4500）：`display:flex; justify-content:space-between; padding:4px 10px 5px; gap:8px;`（**底部一行选择器**）
  - 左：`gap:16px`（附件按钮、项目选择器、权限选择器）；右：`gap:12px`（模型选择器、思考模式、语音、发送）
  - 选择器（4502–4510）：11px `--text-muted` 标签 + 无边框原生 select（11px、`min-width:70px`）
- 权限下拉 `.permission-dropdown-menu`（4524–4582）：**向上弹出** `bottom:calc(100% + 6px); left:0; width:300px;` 白底圆角 8px、`box-shadow: 0 6px 24px rgba(0,0,0,0.10)`、`z-index:60`；选项 `padding:12px 14px` + 下边框，`.selected` `--accent-bg`，勾 `--accent` 14px/700
- 思考模式下拉 `.thinking-mode-menu`（4599–4641）：**向上弹出** `bottom:calc(100% + 8px); right:0; min-width:240px;`、`box-shadow: 0 -8px 24px rgba(0,0,0,0.14)`、`z-index:220`；选项结构同上下文菜单
- `.tb-btn`（4642–4649）：28×28 圆角 `--radius-sm`、hover `--bg-hover`
- 附件按钮 `.attach-btn`（4652–4659）：28×28、hover `--bg-hover` + `--accent`
- 发送按钮 `.send-btn`（4660–4667）：**36×36 圆形**、`background:#e5e7eb`、`color:var(--text-primary)`、`margin-right:6px`；hover `--accent-hover`（蓝）+ `box-shadow:var(--shadow-glow)`（发光）；svg 16×16
- 附件条 `.attach-strip`（4670–4685）：`display:none`，`.has-files` 显示，`flex-wrap:wrap; gap:6px; margin-bottom:6px`；`.attach-chip`：`padding:3px 8px 3px 10px; background:var(--accent-bg); border:1px solid var(--accent-light); border-radius:var(--radius-sm); font-size:11px; color:var(--accent); max-width:180px;`；删除 `hover` `--danger`

### 3.6 右侧面板 / Word 文档面板 / 能力市场 / 定时任务 / 舆情事件

#### 3.6.1 右侧面板 `.right-panel`（4720–4763）

- 宽 300px、白底、`border-left:1px solid var(--border-color)`、`transition:width 0.3s ease`；`.collapsed` 宽 0
- 标题 `.right-panel-section-title`：11px/600 `--text-muted`、`padding:6px 14px`、`text-transform:uppercase; letter-spacing:0.5px`
- 项 `.right-panel-item`：`padding:10px 14px`、圆角 `--radius-sm`、13px、hover `--bg-hover`

> 原型 HTML 中无 right-panel 实体（遗留样式，未启用）。

#### 3.6.2 Word 文档面板（3363–3601）

- `.doc-panel`：**520px**、白底、`border-left:1px solid var(--border-light)`、`transition:width 0.3s ease, min-width 0.3s ease`；`:not(.collapsed)::before` 生成 9px 宽 `col-resize` 拖拽热区（`left:-5px`）；`.resizing` 关闭过渡；`.collapsed` 宽 0
- 头部（3391–3432）：`padding:12px 18px`、下边框；图标 32×32 圆角 6px `#eff6ff/--accent`；标题 13px/600、元信息 11px；动作按钮 30×30 圆角 6px
- Body `.doc-panel-body`（3434–3438）：`flex:1; overflow-y:auto; background:#eef0f3; padding:20px 24px;`
- 纸张 `.doc-paper`（3441–3452）：白底、`padding:48px 56px; margin:0 auto 24px; box-shadow:0 2px 8px rgba(15,23,42,0.08); font-family:"PingFang SC","Microsoft YaHei","SimSun",serif; color:#2a2a2a; line-height:1.8; font-size:13.5px; border-radius:2px;`
  - `.doc-h1` 22px/700 居中；`.doc-h2` 17px/600 居中 `--accent`；`.doc-h3` 15px/700 左侧 3px `--accent` 竖条；`.doc-p` 首行缩进 2em；`.doc-meta` 上下边框分隔；`.doc-table` 12.5px、th `#f3f4f6`、偶数行 `#fafafa`；`.doc-rating-box` 蓝色描边评分框（评级等级 36px/700）；`.doc-risk-badge.high` 红底 `#fee2e2/#b91c1c`
- 重新打开按钮 `.doc-panel-toggle-btn`（3550–3563）：`position:fixed; right:16px; bottom:100px; z-index:30;` 40×40 圆形白底带阴影，`.show` 才显示

#### 3.6.3 能力市场面板（3707–4065）

- 头部 `.ability-market-header`：标题 18px/600、副标题 12.5px `--text-muted`
- Tab `.ability-market-tabs`（3718–3743）：`display:inline-flex; background:#f0f2f5; border-radius:8px; padding:3px; margin-top:32px;`；`.ability-tab` `padding:6px 22px`、13px，`.active` 白底 + 轻阴影
- 筛选 chips `.ability-chip`（3749–3765）：`padding:4px 12px`、12px、白底 `--border-light` 边框、圆角 100px；hover/`.active` 深色边框
- 添加按钮 `.ability-market-add-btn`（3773–3790）：12px、白底边框，hover 反色 `--text-primary` 底白字
- 我的按钮 `.ability-market-my-btn`（3794–3810）：`--accent-bg/--accent` 底
- 卡片网格 `.ability-market-grid`（3999–4003）：`repeat(auto-fill, minmax(280px,1fr)); gap:12px`
- 卡片 `.ability-card`（4004–4065）：`padding:14px;` 白底、`border:1px solid var(--border-light)`、圆角 8px、hover 蓝色边 + 轻阴影；图标 36×36 `#f0f2f5` 灰化 `filter:grayscale(100%) brightness(1.4)`；标签 `.ability-card-tag` 10.5px `#f0f2f5`；安装标记 `.ability-card-install-tag`（右上角胶囊，`.installed` 绿色 `#f0fdf4/#166534/#bbf7d0`）

#### 3.6.4 定时任务（3812–3977、4067–4341）

- Tab `.schedule-tabs`（3813–3839）：同能力市场 Tab 风格（`#f0f2f5` 底、padding 3px、白底 active）
- 日志卡 `.schedule-log-card`（3844–3855）：白底、`border:1px solid var(--border-light)`、圆角 10px、`padding:14px 18px`、hover 蓝色轻阴影；`.unread` 左侧 3px `--accent` 竖条、标题 700
- 徽章：`.schedule-log-badge.unread` `--accent-bg/--accent`、`.read` `#f0f2f5/--text-muted`；状态 `status-success/warning/failed`（3891–3893）
- 展开详情 `.schedule-log-detail`（3903–3942）：`display:none`，`.expanded` 显示；`pre` 等宽字体、白底边框、`max-height:360px`
- 任务卡 `.task-card`（4069–4179）：白底 `--border-light` 边框圆角 10px `padding:14px 16px`；图标 36×36 `--accent-bg` 灰化；meta 区 3 列 grid（`repeat(3,1fr)`，上下边框分隔）；步骤 chips `.task-step` 11.5px `#f0f2f5`；动作 `.task-card-action.primary` `--accent` 蓝底白字
- 任务 hero + 模板网格 `.task-hero`（4182–4215）与 `.task-template-grid`（4216–4271）：6 列 `repeat(6,1fr)`、模板卡 `min-height:92px`、图标 30px 灰化、hover 蓝色 + `translateY(-1px)`
- 菜单面板卡片 `.menu-panel-card`（4303–4340）：`repeat(auto-fill, minmax(280px,1fr)); gap:14px`，hover `--accent` 边框

#### 3.6.5 舆情事件弹窗（4765–4801）

- 遮罩 `.sentiment-event-overlay`：`background:rgba(0,0,0,0.45); z-index:20;`
- 模态 `.sentiment-event-modal`：白底圆角 12px、`max-width:560px; width:90%; max-height:80vh; overflow-y:auto; box-shadow:0 20px 60px rgba(0,0,0,0.25);`
- 头部 `padding:16px 20px` + 下边框 `#e5e7eb`；h3 15px `#1a1a2e`
- 正文：`.ev-label` 11px `#9ca3af` 大写；`.ev-value` 13px `#374151`；徽章 `.ev-badge-critical/warning/info`（`#fef2f2/#dc2626`、`#fff7ed/#ea580c`、`#eff6ff/#2563eb`）

### 3.7 弹窗体系（Modal 系统）

所有弹窗统一模式：**overlay（fixed inset:0 + 半透明遮罩 + fadeIn）→ modal（白底圆角 12px + configModalIn 动画）→ header / tabs / body / footer**。

#### 3.7.1 Agent 配置弹窗（1533–2007）

- 遮罩 `.config-modal-overlay`（1534–1542）：`background:rgba(15,23,42,0.45); z-index:300; display:none; align-items:center; justify-content:center;`，`.show` 显示
- 模态 `.config-modal`（1543–1554）：**800px 宽、高 580px**（`max-width:92vw; max-height:86vh`）、圆角 12px、`box-shadow: 0 24px 64px rgba(15,23,42,0.28)`、`animation: configModalIn 0.22s cubic-bezier(0.4,0,0.2,1)`
- 头部（1559–1585）：`padding:16px 22px`、下边框；标题 16px/600 + 图标 30×30 圆角 8px `--accent-bg/--accent`；关闭按钮 32×32 圆角 6px
- Tabs（1588–1620）：`padding:0 22px; background:#fafbfc; gap:2px;`；`.config-tab`：`padding:12px 16px`、13px、下边框 2px 透明；`.active`：`color:#1f2937; border-bottom-color:#1f2937; font-weight:500;`；图标灰化 `filter:grayscale(100%); opacity:0.8`
- Body（1623–1630）：`flex:1; overflow-y:auto; padding:24px 28px; background:#fff;`
- 分区 `.config-section-title`（1636–1643）：13px/600、`margin-bottom:14px; padding-bottom:8px; border-bottom:1px dashed var(--border-light);`
- 表单行 `.config-row`：`display:flex; align-items:center; margin-bottom:14px; gap:12px;`；`.config-label`：宽 130px、12.5px `--text-secondary`、`text-align:right`
- 输入 `.config-input/.config-textarea`（1660–1682）：`flex:1; padding:7px 10px; border:1px solid var(--border-light); border-radius:6px; 13px;` focus：`border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-glow);`；textarea `min-height:80px; resize:vertical; line-height:1.6`
- Slider `.config-slider`（1711–1749）：高 4px、thumb 14×14 圆形 `--accent`（含 webkit/moz 两套）
- 开关 `.config-toggle`（1752–1773）：36×20 圆角 10px `#d1d5db`、thumb 16px 白、`.on` 时 `--accent`、`left:2px→18px`（`transition:left 0.18s`）——**全站复用**（记忆 tab、子智能体、orch 页均用它）
- Footer（1959–2002）：`padding:14px 22px; border-top:1px solid var(--border-light); background:#fafbfc; justify-content:flex-end; gap:10px;`
  - `.config-btn-secondary`：白底 + `--border-light` 边框、`--text-secondary`
  - `.config-btn-primary`：`#e5e7eb` 底 `#d1d5db` 边框 `--text-primary`；`:disabled` `#f1f3f5/#b6bcc4`
- MCP 服务卡 `.mcp-card`（1893–1956）：`padding:12px 14px; border:1px solid var(--border-light); border-radius:8px;` hover `--accent-light` 边框；图标 36×36 `--accent-bg` 灰化；状态徽章 connected `#dcfce7/#166534`、disconnected `#fef3c7/#92400e`；测试按钮白底边框 hover 变蓝

#### 3.7.2 子智能体弹窗（1775–1870）

- 遮罩 `.subagent-modal-overlay`：`z-index:300`、`fadeIn 0.18s`
- 模态 `.subagent-modal`：**480px**、圆角 12px、`animation: subAgentModalIn 0.22s`（1793–1796）
- 头部 `padding:16px 22px`；body `padding:18px 22px; gap:14px; max-height:60vh; overflow-y:auto;`
- 字段 `.subagent-field`：`flex-direction:column; gap:6px;`；标签 12.5px `--text-secondary`（`required-mark` 红 `#ef4444`）；输入 38px 高、`border:1px solid var(--border-color); border-radius:8px; padding:9px 12px;` focus 蓝色光环；textarea `min-height:96px`
- Footer `padding:12px 22px`；`.subagent-btn-primary` `--accent` 蓝底白字 500，`.subagent-btn-secondary` `--bg-hover` 底

#### 3.7.3 Model Tab（2009–2074，管理面板内）

- `.mdl-localfile`（2014–2029）：`background:#f7f8fa; border-radius:8px; padding:16px 18px; margin-bottom:26px;` 标题 13.5px/600
- `.mdl-item`（2044–2049）：`background:#f7f8fa; border-radius:8px; padding:13px 16px; gap:14px;` 名称 13px/600、描述 12px
- `.mdl-icon-btn`（2064–2074）：28×28 圆角 6px，`.danger:hover` `#fee2e2/#ef4444`
- `.mdl-add-btn`（2030–2042）：白底边框 12.5px

#### 3.7.4 添加模型弹窗（2076–2198）

- 遮罩 `z-index:340`；模态 `.addmodel-modal` **470px**
- 头部 `padding:18px 22px 8px`（**无边框**）；标题 15.5px/600
- body `padding:8px 22px 4px`；`.addmodel-row` `margin-bottom:16px`
- 标签 `.addmodel-label`：12.5px/600、`margin-bottom:7px`
- 输入/下拉 `.addmodel-select/.addmodel-input`（2119–2140）：高 38px、`padding:0 34px 0 12px`、圆角 7px、`border:1px solid var(--border-light)`、`appearance:none`；placeholder `#a8b0ba`；focus `--accent` 边框；select 带左侧图标 `padding-left:36px`、右侧 caret 绝对定位
- 眼睛按钮 `.addmodel-eye` 26×26
- Footer `padding:14px 22px 18px`；**`.addmodel-btn-primary`：`background:#1a1a1a; color:#fff;`**（黑色主按钮，与其它弹窗的灰色不同）

#### 3.7.5 Memory Tab（2200–2270，Agent 配置内）

- `.mem-intro`（2201–2205）：`padding-bottom:16px; border-bottom:1px solid var(--border-light); margin-bottom:20px;` 标题 19px/600
- `.mem-block`（2218–2230）：`display:flex; gap:20px; margin-bottom:16px;` 标题 13.5px/600、描述 12.5px `--text-secondary` 行高 1.7
- `.mem-card`（2244–2270）：`border:1px solid var(--border-light); border-radius:8px; padding:14px 16px; margin-bottom:26px;` 文本两行截断、右侧 meta 宽 132px 右对齐
- `.mem-import-link`（2231–2243）：13px 文字按钮，hover `--accent/--accent-bg`

#### 3.7.6 导入记忆弹窗（2272–2400）

- 遮罩 `z-index:320`；模态 `.import-memory-modal`：**760px、max-height:88vh**、**背景 `#f7f8fa`**（与其它白底不同）
- 头部 `padding:18px 24px 14px`（白底）；标题 16px/600
- body `padding:4px 24px 20px; gap:16px; background:#fff;`
- 步骤卡 `.import-step-card`（2318–2323）：`border:1px solid var(--border-light); border-radius:10px; padding:14px 16px 16px; background:#f7f8fa;`
- 步骤序号 `.import-step-num`：20×20 圆角 5px `#eef1f5`
- 复制按钮 `.import-copy-btn`（2340–2361）：白底边框 12px，`.copied` 态 `--accent` 系
- 提示词框 `.import-prompt-box`（2362–2373）：白底、`white-space:pre-wrap; max-height:180px; overflow-y:auto;` 12.5px/1.85
- 粘贴区 `.import-paste-area`（2374–2393）：`min-height:130px; resize:vertical;` focus `--accent-light` 边框
- Footer `padding:14px 24px`（白底），复用 `config-btn-*`

#### 3.7.7 MCP Pane（2402–2623）

- `.mcp-pane`：`flex-direction:column; flex:1; min-height:0;`
- `.mcp-header`（2406–2445）：`gap:12px; padding-bottom:14px; border-bottom:1px solid var(--border-light); margin-bottom:14px;` 图标 32×32 `#eef1f5`；标题 14px/600、副标题 12px；`.mcp-config-btn` 白底边框 12.5px
- 搜索框 `.mcp-search`（2448–2466）：高 34px、白底 `--border-light` 边框圆角 7px、`:focus-within` `--accent` 边框
- 空态 `.mcp-empty`（2469–2495）：图标 64×64 圆角 12px `#f0f2f6/#b6bcc6`、标题 14px/600、按钮白底边框
- 列表行 `.mcp-row`（2498–2513）：`background:#f7f8fa; border-radius:8px; padding:13px 16px;` 图标 30×30 白底圆角 6px
- JSON 编辑器 `.mcp-editor`（2564–2623）：`flex:1; min-height:360px;` 白底边框圆角 8px、等宽字体 12.5px/1.6；行号列 44px `#fafbfc/#b6bcc6`；高亮层+透明 textarea 叠加（`caret-color:var(--text-primary)`）；语法色：key `#1f4fb8`、str `#c2410c`、num `#15803d`、bool/null `#7c3aed`、punct `#8e94a0`
- 配置按钮 `.mcp-cfg-btn-primary`：`#1a1a1a` 黑底白字（与 addmodel 一致）；`:disabled` 灰
- 路径 code（2555–2563）：`background:#f0f2f6; padding:1px 5px; border-radius:4px;`

#### 3.7.8 自定义模型弹窗（2625–2827）

- 遮罩 `z-index:320`；模态 `.custom-model-modal` **480px**
- 头部 `padding:18px 22px 14px`；标题 16px/600；body `padding:8px 22px 18px; gap:14px;`
- 行 `.custom-model-row`：`gap:12px;`；标签宽 **70px** 右对齐
- 输入 `.custom-model-input`：`padding:7px 10px; border:1px solid var(--border-light); border-radius:6px;` focus 蓝色光环；密码眼按钮 28×28 绝对定位 `right:4px`
- 模型下拉 `.model-select-dropdown/.model-select-menu`（2745–2789）：菜单 `top:calc(100% + 4px); max-height:360px; z-index:999;`；`.model-option.selected` `--accent-bg/--accent`；分组标题 `.model-option-group` 11px/600 `#fafbfc` 底、上边框分隔
- Footer `padding:14px 22px; background:#fafbfc;`；按钮同 config-btn 灰系（`#e5e7eb/#d1d5db`）

#### 3.7.9 创建项目弹窗（2829–2981）

- 遮罩 `z-index:330`；模态 `.create-project-modal` **460px**
- 头部 `padding:18px 22px 14px`；标题 16px/600；body `padding:4px 22px 20px; gap:16px;`
- 行 `.create-project-row`：标签宽 **100px** 右对齐；输入同 config-input
- 路径组 `.create-project-path-group`（2897–2935）：`background:#f5f6fa; border:1px solid var(--border-light); border-radius:6px; padding:4px 6px 4px 10px;` 内嵌无边框 input（等宽字体）+ 浏览按钮 26×26；focus 时 input 变白底
- Footer `padding:14px 22px; background:#fafbfc; border-radius:0 0 12px 12px;`
- 保存按钮 `.create-project-btn-primary`：默认**禁用态** `#e5e7eb/#9ca3af` `cursor:not-allowed`，`.active` 才可点（hover `#d1d5db`）

#### 3.7.10 文件夹选择器（2983–3160）

- 遮罩 `z-index:335`；模态 `.folder-picker-modal`：**720px、高 520px**（`max-height:86vh`）
- 头部 `padding:14px 22px 10px` + 下边框；标题 15px/600
- 面包屑 `.folder-picker-breadcrumb`（3021–3039）：`padding:8px 22px; background:#fafbfc;` 12.5px，crumb hover `--bg-hover`
- Body 双栏：左 `.folder-picker-sidebar` **180px**（`#fafbfc`、右边框），右 `.folder-picker-main` `flex:1`
- 侧栏项 hover `#f0f2f5`、`.active` `--accent-bg/--accent`（图标去灰）；主列表项 `.selected` `--accent-bg/--accent`
- Footer `padding:12px 18px; background:#fafbfc;` 左显示已选路径、右侧动作按钮（复用 create-project-btn-*）

#### 3.7.11 添加自动化任务弹窗（3162–3263）

- 遮罩 `z-index:340`；模态 `.add-automation-modal` **640px、max-height:88vh**
- 头部 `padding:14px 22px` + 下边框；标题 15px/600；body `padding:18px 22px 22px; gap:16px; overflow-y:auto;`
- 字段 `.add-automation-field`：`flex-direction:column; gap:6px;` 标签在上（12.5px/500）
- 输入高 `padding:7px 10px` 圆角 6px focus 蓝环；textarea `min-height:180px`
- 频率行 `.add-automation-freq-fields`：`gap:10px`，周期 select `flex:1`、时间 input `flex:0 0 140px`

#### 3.7.12 新建自动驾驶流程弹窗（3265–3361）

- 遮罩 `z-index:345`；模态 `.autodrive-flow-modal` **520px、max-height:88vh**
- 头部 `padding:14px 22px`；标题带图标 `.autodrive-flow-title-icon` 26×26 圆角 6px `#eff6ff/#3b82f6`
- body 复用 `add-automation-field/input/textarea`；footer `padding:14px 22px; background:#fafbfc; border-radius:0 0 12px 12px;`
- **`.autodrive-flow-btn-primary`：`background:#3b82f6; color:#fff;`** 真蓝底主按钮，hover `#2563eb` + `box-shadow: 0 2px 8px rgba(59,130,246,0.35)`（与 addmodel/mcp 的黑底、config 的灰底都不同）

### 3.8 流程编排页（Orchestration，4803–4877）

- `.orch-page`：`display:none; flex:1; flex-direction:column; overflow:hidden;`，`.show` 显示
- 顶栏 `.orch-topbar`（4806）：高 52px、白底、`border-bottom:1px solid var(--border-color)`、`padding:0 20px; gap:12px`
- 返回按钮 `.orch-back`：`padding:6px 10px`、13px、hover `--bg-hover`
- 模型选择 `.orch-model-select`：`margin-left:auto;` `--bg-input` 底 + `--border-light` 边框圆角 `--radius-sm`、12px
- 左栏 `.orch-left`（4818）：**340px**、白底、`border-right:1px solid var(--border-color)`、flex column
- Tab `.orch-tab`（4820–4822）：`flex:1; padding:10px 12px; text-align:center; 12px; border-bottom:2px solid transparent;` `.active` `--accent` + 2px 蓝边
- 字段行 `.orch-field-row`：标签 11px/600 `--text-muted` 宽 80px 右对齐；输入 `padding:7px 10px; border:1px solid var(--border-light); border-radius:var(--radius-sm); 12px;` focus 蓝色 + `box-shadow:0 0 0 2px var(--accent-glow)`（注意这里是 **2px** 光环，比其它 3px 弱）
- 分区标题 `.orch-section-title`（4831–4832）：13px/600、下边框、`.badge` 10px 胶囊 `--accent-light/--accent`
- 项行 `.orch-item-row`（4833–4842）：`padding:8px; border-radius:var(--radius-sm);` hover `--bg-hover`；图标 32×32 `--bg-tertiary` 底（`.tool` `#eef2ff`、`.kb` `#fef7ed`）；删除 hover `--danger`
- 开关 `.orch-toggle`（4843–4846）：36×20（同 config-toggle）
- 添加按钮 `.orch-add-btn`（4847–4848）：**虚线边框** `border:1px dashed var(--border-light)`、`width:100%`、hover `--accent`
- Footer `.orch-footer`（4850–4855）：`padding:12px 14px; border-top:1px solid var(--border-color);` 双按钮各 `flex:1`；`.orch-btn-primary` `--accent` 蓝底白字
- 右栏 `.orch-right`（4856）：`flex:1; background:var(--bg-main);`
- 预览聊天 `.orch-preview-chat`（4858–4860）：`padding:16px; gap:14px;` 滚动条 3px；消息 `.orch-preview-msg .bubble`：`max-width:85%; padding:10px 14px; border-radius:var(--radius-md);` user 蓝底 `--user-bubble`/`--accent-light` 边框、ai 白底 `--bg-card`/`--border-color` 边框，均带 3px 小角
- 预览输入 `.orch-preview-input`（4868–4873）：`background:var(--bg-input); border:1px solid var(--border-light); border-radius:var(--radius-md); padding:4px;` 内嵌 input + 30×30 圆形蓝发送钮

### 3.9 登录页（4895–4978）

- 遮罩 `.login-overlay`：`position:fixed; inset:0; z-index:10000; display:flex; align-items:center; justify-content:center; background:#ffffff;`，`.hidden` 隐藏
- 卡片 `.login-card`（4902–4906）：白底、圆角 20px、`box-shadow: 0 24px 80px rgba(0,0,0,0.12), 0 4px 20px rgba(0,0,0,0.06); padding:48px 44px 40px; width:420px; max-width:92vw; animation:loginFadeIn 0.5s ease;`
- 标题 22px/700、副标题 13px `--text-muted`（`margin-bottom:32px`）
- 输入 `.login-input-wrap input`（4933–4943）：高 46px、`border:1.5px solid var(--border-color); border-radius:10px; padding:0 44px 0 14px; background:#f8fafc;` focus：`--accent` 边框 + 白底 + `box-shadow:0 0 0 3px var(--accent-glow)`；右侧图标 18×18 绝对定位
- 登录按钮 `.login-btn`（4963–4970）：全宽 46px 高、圆角 10px、`--accent` 蓝底白字 15px/600、hover `--accent-hover` + `box-shadow: 0 4px 16px var(--accent-glow)`、`:active { transform: scale(0.98); }`
- 错误提示 `.login-error`：`--danger` 12px、`min-height:18px`

### 3.10 Toast（952–970）

- `.hy-toast`（958–970）：`position:fixed; left:50%; bottom:48px; transform:translateX(-50%); z-index:900; padding:9px 18px; border-radius:8px; background:rgba(31,41,55,0.92); color:#fff; font-size:13px; box-shadow:0 8px 24px rgba(15,23,42,0.22); pointer-events:none; animation:toastFade 2.4s ease forwards;`

---

## 4. 与当前应用 styles.css 的差异点

对比 `apps/desktop/src/renderer/styles.css`（3832 行）与原型：

| 维度              | 当前应用 styles.css                                                                                                                                           | 原型 V5                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **主题色**        | 暖橙/奶油色系：`--bg:#fffaf5`、`--panel:rgba(255,255,255,0.86)`、主色 `--teal:#d4750a`（橙）、`--cyan:#b8650a`                                                | 冷蓝白系：`--bg-main:#ffffff`、`--accent:#3b82f6`（蓝）、`--accent-hover:#2563eb`、蓝浅底 `#eff6ff/#dbeafe`                                          |
| **字体**          | `Aptos, Bahnschrift, "Segoe UI", sans-serif`（12–30 行）                                                                                                      | `-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif`（505 行）                                                          |
| **背景**          | body 带格子纸渐变（`linear-gradient` 网格 + 径向光晕，34–48 行）                                                                                              | 纯白 `#ffffff`，侧栏/顶栏左 `#f7f8fa`                                                                                                                |
| **顶栏**          | 72px 高、`grid-template-columns:1fr auto 1fr`、`backdrop-filter:blur(18px)`、半透明米白（73–82）                                                              | 56px、三段式（左 260px 与侧栏同底、中 flex、右 actions），纯白                                                                                       |
| **布局**          | `.workspace-shell` grid：`72px + 1fr`；`.workspace-grid` 三列 `312px / minmax(420px,1fr) / clamp(280px,25vw,380px)`，左右可折叠为 52px rail（67–71、266–284） | `.app-root` flex column + `.app-below` flex row；侧栏固定 260px、右面板 300px（遗留）、文档面板 520px                                                |
| **组件体系**      | 大量使用 **antd**（`.ant-btn/.ant-select/.ant-modal/.ant-tabs/.ant-alert` 等），并整体重写 antd 主题（3621–3732 行）                                          | 纯手写 HTML/CSS：自定义 modal overlay、dropdown、toggle、segmented、tooltip                                                                          |
| **消息气泡**      | `.message-row` + `.message-bubble`：白底 1px 边框盒、用户气泡橙色底 `rgba(255,239,224,0.92)`、hover 右上角复制按钮（641–677）                                 | `.message.user` 蓝底 `--user-bubble`/`--accent-light` 边框 + 3px 小角；AI 透明气泡 + `msg-header`（Hy 徽标）+ 下方复制/朗读/分享图标栏 + CSS tooltip |
| **输入栏**        | `.composer`：顶部渐变 + 底部 1px 边框、`backdrop-filter:blur(18px)`、`box-shadow:0 -18px 46px`（849–860）                                                     | `.input-wrapper` 卡片式：`border + radius-lg + :focus-within 蓝环`，底部一行选择器（模型/项目/权限/思考模式），发送按钮圆形发光                      |
| **弹窗**          | antd Modal（`ant-modal-content` 等）                                                                                                                          | 自绘 13 套 modal（见 3.7），统一 `configModalIn` 动画                                                                                                |
| **消息间距/宽度** | `width:min(760px,88%)`、`margin:14px 0`                                                                                                                       | `.message` `max-width:80%`（user 70%、ai 100%），`.message.ai .msg-body` 内 `max-width:960px`                                                        |
| **卡片/边框**     | 半透明 `rgba(255,255,255,0.72~0.92)` + `rgba(212,117,10,0.18~0.42)` 橙色边框                                                                                  | 实色白底 + `--border-light #ccd0d8` / `--border-color #dde0e5`                                                                                       |
| **选中/高亮色**   | 橙 `rgba(212,117,10,0.1~0.16)`                                                                                                                                | 蓝 `--accent-bg #eff6ff`、`#e7edf7`（侧栏菜单 active）                                                                                               |
| **响应式**        | `@media(max-width:980px)` 整体改为单列堆叠（3734–3831）                                                                                                       | `@media(max-width:900px)` 隐藏侧栏/右栏；1280/1500 两档收窄尺寸                                                                                      |
| **hover 反馈**    | `rgba(212,117,10,0.36)` 橙边、`box-shadow:inset 3px 0 0 var(--teal)`                                                                                          | `rgba(0,0,0,0.06)` 灰底、蓝色 `--accent` 边框/阴影                                                                                                   |

**结论**：当前应用是「暖橙奶油 + antd + 三栏 grid + 半透明卡片」风格，原型是「冷蓝白 + 手写组件 + 顶栏侧栏一体 + 实色卡片」风格。改造本质上是**主题令牌替换 + 布局结构对齐 + 组件视觉统一**，不是局部微调。

---

## 5. 可直接移植的 CSS 代码清单

以下段落与原型 JS/HTML 无强耦合（纯 class 选择器），可**整体复制**到 `apps/desktop/src/renderer/styles.css`（或独立文件后 import）。注意第 5.4 节的两处前置条件与类名冲突检查。

### 5.1 直接复制（无改动）

| #   | 内容                                                                                                   | 原型行号                                             | 说明                                                 |
| --- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------- |
| 1   | `:root` 全部设计令牌 + `*` reset                                                                       | 9–40                                                 | 需先改名避免与现有 `:root` 冲突（如并到现有 :root）  |
| 2   | body / `.app-root` / `.app-topbar` 系 / `.app-below`                                                   | 43–69、500–511                                       | 顶栏三明治布局骨架                                   |
| 3   | `.topbar-icon-btn`、badge、`.topbar-text-btn`                                                          | 70–91、185–200                                       | 通用顶栏按钮                                         |
| 4   | 通知下拉全套                                                                                           | 93–200                                               |                                                      |
| 5   | 管理面板全套（滑入右侧栏 + tab + segmented）                                                           | 202–349                                              | 依赖 `mem-intro/mdl-list/mcp-*`（见 19/21）          |
| 6   | 上下文压缩下拉全套                                                                                     | 351–432                                              | 含进度条                                             |
| 7   | 版本下拉全套                                                                                           | 434–499                                              |                                                      |
| 8   | 历史侧栏全套（菜单、项目、会话、账号、账号弹窗）                                                       | 513–936                                              | 补 `--desktop-icon` 变量                             |
| 9   | Flyout 面板全套 + `flyoutSlide`                                                                        | 938–1091                                             |                                                      |
| 10  | 主区域骨架 + idle/scene 模式 + `:has()` 规则 + `.main-topbar`                                          | 1093–1147                                            | 需 Chromium≥105（Electron 22+）                      |
| 11  | mode-toggle / 用户区                                                                                   | 1148–1180                                            |                                                      |
| 12  | `.main-hero` 全套 + `fadeIn`                                                                           | 1191–1212                                            |                                                      |
| 13  | `.skill-tags` / `.skill-carousel` 全套                                                                 | 1215–1255                                            |                                                      |
| 14  | overlay-backdrop + skills/projects panel + 卡片网格                                                    | 1256–1308                                            |                                                      |
| 15  | 右上角 corner 工具栏 + 三个弹窗 + 搜索/历史/文件项                                                     | 1363–1531                                            |                                                      |
| 16  | **Agent 配置弹窗全套**（含 toggle/slider/input 体系、config-btn、mcp-card、config-add-btn）            | 1533–2007                                            | 这是整个表单/弹窗体系的基座，复用度最高              |
| 17  | 子智能体弹窗全套                                                                                       | 1775–1870                                            |                                                      |
| 18  | Model Tab（mdl-*）+ 添加模型弹窗                                                                       | 2009–2198                                            |                                                      |
| 19  | Memory Tab + 导入记忆弹窗                                                                              | 2200–2400                                            |                                                      |
| 20  | MCP Pane（含 JSON 编辑器 + 语法高亮）                                                                  | 2402–2623                                            |                                                      |
| 21  | 自定义模型弹窗（含 model-select-menu）                                                                 | 2625–2827                                            |                                                      |
| 22  | 创建项目弹窗                                                                                           | 2829–2981                                            |                                                      |
| 23  | 文件夹选择器                                                                                           | 2983–3160                                            |                                                      |
| 24  | 添加自动化任务弹窗                                                                                     | 3162–3263                                            |                                                      |
| 25  | 新建自动驾驶流程弹窗                                                                                   | 3265–3361                                            |                                                      |
| 26  | Word 文档面板（doc-panel/doc-paper/chat-doc-link/toggle）                                              | 3363–3601                                            |                                                      |
| 27  | 菜单面板 + action-dropdown + segmented + 能力市场全套                                                  | 3603–4065                                            |                                                      |
| 28  | 定时任务 + 任务卡 + 任务 hero/模板网格 + 菜单面板卡片                                                  | 3812–4341                                            | 注意 3812–3977 与 3603–4065 部分重叠，复制时合并去重 |
| 29  | 聊天区（messages/msg-bubble/msg-actions/tooltip）                                                      | 4370–4470                                            | 需与 React 现有 `.message-*` 类名协调（见 5.4）      |
| 30  | 输入栏全套（input-bar/wrapper/footer/选择器/附件/发送）                                                | 4472–4685                                            |                                                      |
| 31  | 右侧面板（遗留，可选）                                                                                 | 4720–4763                                            |                                                      |
| 32  | 舆情事件弹窗                                                                                           | 4765–4801                                            |                                                      |
| 33  | 流程编排页全套                                                                                         | 4803–4877                                            | 含 orch 预览聊天                                     |
| 34  | 登录页全套 + `loginFadeIn`                                                                             | 4895–4978                                            |                                                      |
| 35  | Toast（`.hy-toast` + `toastFade`）                                                                     | 952–970                                              |                                                      |
| 36  | 响应式断点                                                                                             | 4688–4718                                            | 与当前 980px 断点策略不同，移植时取舍                |
| 37  | 全部关键帧：`fadeIn`/`msgIn`/`flyoutSlide`/`toastFade`/`configModalIn`/`subAgentModalIn`/`loginFadeIn` | 948–957、1197、1555–1558、1793–1796、4375、4907–4910 | 一次性复制                                           |

### 5.2 需要小幅适配再移植

- **滚动条样式**（625–627、1005–1007、1187–1189、4859–4860）：5px/3px 细滚动条，建议提为公共规则。
- **`--desktop-icon` / `--desktop-icon-active`**（548、550 行引用）：在 `:root` 补定义。
- **`.hs-tab`**（4699–4701 媒体查询引用但无基础样式）：补基础样式或删引用。
- **dev-sticky-note / account-popup-row-tip**（1332–1361）：IT 标注，正式版**不要**移植。

### 5.3 移植优先级建议（按视觉收益）

1. 令牌 + 布局骨架（#1–3、8、10）→ 整体换成蓝白底色
2. 输入栏（#30）→ 最常驻的交互组件
3. 聊天区（#29）+ 消息渲染结构对齐
4. 弹窗体系（#16 基座 + #17–25 各弹窗）
5. 顶栏下拉（#4–7）+ 管理面板（#5）
6. 主区域 hero/技能/轮播（#12–15）+ 菜单面板/能力市场（#27–28）
7. 编排页（#33）、登录页（#34）、Toast（#35）

### 5.4 移植前置条件与风险

1. **`:has()` 依赖**（1127–1130）：主区域角标隐藏用了 `:has()`，Electron 需 ≥22（Chromium 105+），否则需改用 class 切换。
2. **类名冲突**：原型使用大量通用类名（`.main`、`.message`、`.menu-item`、`.content-wrap`、`.config-*`、`.input-*`）。React 应用中若已有同名类，需加前缀（如 `.hb-`）或用 CSS Modules/`@scope` 限定。当前应用用 `.message-row/.message-bubble/.composer/.history-item` 等，与原型 `.message/.msg-bubble/.input-bar/.sidebar-history-item` 不重叠，冲突风险集中在 `.menu-item`、`.config-*`（antd 无同名，安全）。
3. **antd 组件**：原型是纯手写组件；若 React 应用继续用 antd，需用令牌值重写 antd 主题（对齐当前 styles.css 3621–3732 的做法，只是换成蓝色系）：`--accent` 蓝底主按钮、`--border-light` 边框、白底 `--bg-main`。
4. **原型 CSS 顺序**：`</style>` 前所有规则互相覆盖（如 `.main-body.idle-mode .input-bar` 覆盖 `.input-bar`），整段复制可保持原顺序；若拆分，注意这些覆盖关系。
5. **字体**：原型用系统字体栈，无网络字体依赖，直接可用。
6. 当前应用的 `.workspace-shell/.workspace-grid` grid 结构与原型 flex 结构不同，**结构改造**（React JSX）与样式改造需同步进行；单改 CSS 无法完成布局对齐。

---

## 附：原型 HTML 结构速查（React 实现参照）

- 顶栏左（5041–5068）：`.app-topbar-left > .hb-version-dropdown > .hb-version-btn + .hb-version-menu`
- 顶栏右（5072–5130）：`.app-topbar-actions > .topbar-context-dropdown + .topbar-manage-dropdown + .topbar-notify-dropdown`
- 侧栏（5136–5254）：`.history-sidebar > .sidebar-menu（.menu-item[data-menu=newtask|project|skill|schedule|autodrive]）+ .sidebar-projects + .sidebar-history + .sidebar-account-wrapper(.account-popup)`
- 主区（5257–5635）：`.main > .main-corner-toolbar + .main-corner-popup×3 + .main-body（.main-hero + .project-context-banner + .content-wrap(.chat-area + .menu-panel) + .input-bar）+ .overlay-backdrop×2 + .orch-page + .sentiment-event-overlay`
- 文档面板（5638–5661）：`.doc-panel.collapsed + .doc-panel-toggle-btn`
- 弹窗（5663–6119、12172–12308）：config-modal、import-memory、custom-model、addmodel、create-project、folder-picker、add-automation、autodrive-flow、manage-panel、subagent-modal
- 聊天消息结构（10279–10325 JS 生成）：`.messages > .message.user（.msg-avatar + .msg-bubble）` 与 `.message.ai.full-width > .msg-body（.msg-header(.msg-header-avatar "Hy" + .msg-header-name) + .msg-bubble + .chat-doc-link + .msg-actions(.msg-action-icon[data-tip])`
