// 本文件根据 git 提交历史整理（以 "bump version to X.Y.Z" 提交划分版本边界）。
// 每次发版前需人工更新：为新版本追加条目并更新日期。
// Maintained manually from git history; update before each release.

export interface ChangelogEntry {
  version: string;
  date: string; // YYYY-MM-DD
  zh: string[];
  en: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.5.4",
    date: "2026-10-26",
    zh: [
      "自动升级默认以管理员权限运行安装器（自动弹出 UAC 授权），修复装到受保护目录时升级失败（不能打开要写入的文件）",
      "修复生产依赖安全审计问题（axios、undici、body-parser 等）",
    ],
    en: [
      "Auto-updates now run the installer with administrator rights by default (automatic UAC prompt), fixing upgrade failures (cannot open file for writing) when installed to protected locations",
      "Cleared production dependency audit issues (axios, undici, body-parser, and more)",
    ],
  },
  {
    version: "0.5.3",
    date: "2026-10-23",
    zh: ["“关于 HyWork”弹窗新增历次版本更新日志，按版本号倒序展示"],
    en: ["The About HyWork dialog now shows release notes for past versions, newest first"],
  },
  {
    version: "0.5.2",
    date: "2026-10-12",
    zh: ["计划任务新增“立即运行”按钮，可随时手动触发执行", "已登录 HyWork 账户时自动登录工具市场，无需重复操作"],
    en: [
      "Added a Run Now button to execute a scheduled task immediately",
      "Automatically signs in to the tool market when the HyWork account is already logged in",
    ],
  },
  {
    version: "0.5.1",
    date: "2026-10-08",
    zh: [
      "修复 Windows 拦截 PowerShell 启动时任务无法运行的问题，自动回退到 cmd.exe",
      "工具市场翻页复用会话并精简数据加载，浏览更流畅",
    ],
    en: [
      "Fixed tasks failing when Windows blocks the PowerShell spawn, falling back to cmd.exe",
      "Tool market reuses its session across paging with slimmer payloads for smoother browsing",
    ],
  },
  {
    version: "0.5.0",
    date: "2026-10-08",
    zh: ["新增“启动时要求登录”设置选项", "支持手动下载更新安装包", "清理生产环境依赖安全问题"],
    en: [
      "Added a require-login-on-start setting",
      "Support manually downloading update packages",
      "Cleared production dependency audit issues",
    ],
  },
  {
    version: "0.4.10",
    date: "2026-09-24",
    zh: ["修复切换账户后远程会话仍连接旧实例的问题"],
    en: ["Fixed reverse A2A sessions sticking to a stale agent instance after switching accounts"],
  },
  {
    version: "0.4.9",
    date: "2026-09-23",
    zh: ["支持使用已保存的员工智能体账号一键登录工具市场", "安装包不再捆绑技能数据，体积更小"],
    en: [
      "Sign in to the tool market with the stored staff-agent account",
      "Installers no longer bundle skills data, reducing package size",
    ],
  },
  {
    version: "0.4.7",
    date: "2026-09-22",
    zh: ["登录时改为校验密码，不再直接复用单点登录会话"],
    en: ["Login now verifies the OIDC password instead of reusing the SSO session"],
  },
  {
    version: "0.4.6",
    date: "2026-09-22",
    zh: ["工具市场目录支持分页浏览", "工具市场新增登录入口"],
    en: ["Tool market catalog now supports paged browsing", "Added a login entry to the tool market"],
  },
  {
    version: "0.4.5",
    date: "2026-09-22",
    zh: ["已有有效登录会话时直接视为已登录", "登录请求增加 offline_access 权限，避免频繁重新登录"],
    en: [
      "A usable OIDC session is now treated as logged in",
      "Login requests the offline_access scope to avoid frequent re-login",
    ],
  },
  {
    version: "0.4.4",
    date: "2026-09-22",
    zh: ["登录窗口出错时明确提示，不再无声卡住"],
    en: ["OIDC login window failures are now surfaced instead of hanging silently"],
  },
  {
    version: "0.4.3",
    date: "2026-09-22",
    zh: ["任务运行时输入框上方显示浮动运行状态标签", "点击升级时立即检查更新，并提示“已是最新版本”"],
    en: [
      "Shows a floating running tag above the composer while a job runs",
      "Upgrade click now checks for updates and shows an up-to-date notice",
    ],
  },
  {
    version: "0.4.1",
    date: "2026-09-22",
    zh: ["账户弹窗菜单新增登录/退出登录入口"],
    en: ["Added login/logout entries to the account popup menu"],
  },
  {
    version: "0.4.0",
    date: "2026-09-21",
    zh: [
      "产品更名为 HyWork，更新通道切换为 HTTPS",
      "新增资产工作台、知识库与技能翻译功能",
      "智能体达到最大轮次时基于已收集内容作答，不再中断",
    ],
    en: [
      "Rebranded to HyWork with an HTTPS update channel",
      "Added assets workspace, knowledge base, and skill translation",
      "Agent now answers from gathered context when hitting the max-turns limit",
    ],
  },
  {
    version: "0.2.8",
    date: "2026-09-17",
    zh: ["优化企业工作台会话页面的界面与交互"],
    en: ["Polished the enterprise workspace conversation page"],
  },
  {
    version: "0.2.7",
    date: "2026-09-17",
    zh: [
      "技能页支持拖拽排序",
      "子智能体默认描述本地化为中文",
      "工具市场插件聚合为单个插件展示其成员技能",
      "提示词项目选择器新增“无项目”选项",
    ],
    en: [
      "Skills tab now supports drag-to-reorder",
      "Default subagent descriptions localized to Chinese",
      "Tool market plugins shown as one plugin with member skills",
      "Added an explicit no-project option to the prompt project selector",
    ],
  },
  {
    version: "0.2.6",
    date: "2026-09-12",
    zh: [
      "新增技能中心三标签页（技能/专家/市场），支持对话内提问卡片",
      "计划任务支持编辑，运行记录以树形视图展示",
      "任务运行期间可排队发送消息，右侧新增文件预览面板",
      "支持通过 URL 和令牌一键添加远程 MCP 服务",
      "修复多项会话界面显示与文件链接问题",
    ],
    en: [
      "New three-tab skill hub (skills/experts/market) with in-chat question cards",
      "Scheduled tasks can be edited, with run records in a tree view",
      "Queue prompts while a task runs; new right-side file preview panel",
      "One-click remote MCP setup via URL and token",
      "Fixed various chat UI and file-link issues",
    ],
  },
  {
    version: "0.2.0",
    date: "2026-08-24",
    zh: [
      "整体界面按 HyBot 桌面原型 V5 重新设计",
      "新增企业工作台登录页与登录流程",
      "新增托盘通知、拖拽附件、记忆开关与任务标签页",
      "会话中支持选择技能",
    ],
    en: [
      "Redesigned the whole UI per the HyBot desktop prototype V5",
      "Added the enterprise workspace login page and flow",
      "Added tray notifications, drag-drop attachments, memory toggle, and tasks tab",
      "Support picking skills in chat",
    ],
  },
];
