import type { TranslateFn } from "../../lib/i18n";

// A searchable unit in the Settings panel. `id` doubles as the DOM anchor id
// (see SettingsAnchor in SettingsPanel.tsx). `titleKeys` are i18n keys whose
// resolved text is matched in the active locale, so search tracks whatever
// language the UI is showing. `terms` are extra literal aliases (kept bilingual
// where useful) for synonyms the visible labels don't contain.
//
// To make a newly-added settings panel searchable, add one entry here in the
// same order it renders and wrap its markup in <SettingsAnchor id="...">.
// Also place the entry id in the matching SETTINGS_GROUPS[].entryIds list.
export interface SettingsSearchEntry {
  id: string;
  titleKeys: string[];
  terms: string[];
}

// Collapsible group in the Settings panel. Order MUST match the render order
// in SettingsPanel. `titleKey` is the group header shown when collapsed.
export interface SettingsGroupDef {
  id: string;
  titleKey: string;
  entryIds: string[];
}

// Order MUST match the render order in SettingsPanel so prev/next navigation
// walks matches top-to-bottom.
export const SETTINGS_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    id: "language",
    titleKeys: ["settings.languageTitle", "settings.languageLabel"],
    terms: ["language", "locale", "i18n", "语言", "区域", "本地化"],
  },
  {
    id: "app-theme",
    titleKeys: ["settings.appThemeTitle"],
    terms: ["theme", "appearance", "dark", "light", "system", "color scheme", "主题", "外观", "深色", "浅色", "暗色", "亮色", "跟随系统"],
  },
  {
    id: "welcome-history",
    titleKeys: ["settings.welcomeHistoryTitle"],
    terms: ["welcome", "startup", "recent sessions", "session history", "restore sessions", "history limit", "欢迎页", "启动", "最近会话", "会话历史", "恢复会话", "历史数量"],
  },
  {
    id: "global-ui",
    titleKeys: ["settings.globalUiTitle"],
    terms: ["ui font", "font family", "font size", "typography", "interface font", "界面字体", "字体", "字号", "排版"],
  },
  {
    id: "code-view-appearance",
    titleKeys: ["settings.codeViewAppearanceTitle"],
    terms: [
      "code view", "code editor", "diff viewer", "syntax highlighting", "code font", "code theme",
      "match app", "app theme", "taomni theme",
      "代码视图", "代码编辑器", "diff", "差异", "语法高亮", "代码字体", "代码主题",
      "跟随应用", "应用主题", "Taomni 主题",
    ],
  },
  {
    id: "sdks",
    titleKeys: ["settings.sdkTitle", "settings.sdkSubtitle"],
    terms: [
      "sdk", "toolchain", "runtime", "interpreter", "compiler", "jdk", "java home",
      "kotlin", "kotlinc", "scala", "scalac", "python", "virtual environment", "venv",
      "软件开发工具包", "工具链", "运行时", "解释器", "编译器", "jdk", "java",
      "kotlin", "scala", "python", "虚拟环境",
    ],
  },
  {
    id: "language-servers",
    titleKeys: [
      "settings.languageServersTitle",
      "settings.languageServersSubtitle",
      "settings.languageServersJavaHome",
    ],
    terms: [
      "language server", "lsp", "jdtls", "rust-analyzer", "gopls", "clangd", "pyright",
      "install", "language intelligence", "code intelligence",
      "java", "jdk", "java 21", "java home", "runtime",
      "语言服务器", "语言智能", "安装", "补全", "代码智能",
      "java", "jdk", "java21", "运行时", "java路径",
    ],
  },
  {
    id: "live-templates",
    titleKeys: ["settings.liveTemplatesTitle", "settings.liveTemplatesSubtitle"],
    terms: [
      "live templates", "live template", "postfix", "snippet", "abbreviation", "sout", "psvm", "fori",
      "code template", "expand", "tab", "intellij", "idea templates",
      "实时模板", "后缀模板", "代码模板", "缩写", "代码片段", "模板补全",
    ],
  },
  {
    id: "sql-completion",
    titleKeys: ["settings.sqlCompletionTitle", "settings.sqlCompletionTriggerShortcut"],
    terms: [
      "sql", "database", "query editor", "autocomplete", "completion", "suggestions", "shortcut", "key binding",
      "数据库", "查询编辑器", "自动完成", "自动补全", "补全", "建议", "快捷键", "按键绑定",
    ],
  },
  {
    id: "sql-execution",
    titleKeys: [
      "settings.sqlExecutionTitle",
      "settings.sqlExecutionRunAll",
      "settings.sqlExecutionRunSelection",
      "settings.sqlExecutionRunCurrent",
    ],
    terms: [
      "sql execution", "run all", "run selection", "run current", "current statement", "execute", "shortcut",
      "执行全部", "执行选区", "当前语句", "执行光标", "快捷键", "sql 执行",
    ],
  },
  {
    id: "sftp",
    titleKeys: [
      "settings.sftpTitle",
      "settings.sftpLocalDoubleClickLabel",
      "settings.sftpLocalDoubleClickOpen",
      "settings.sftpLocalDoubleClickUpload",
    ],
    terms: [
      "sftp", "file browser", "double click", "upload", "open local file", "local pane",
      "sftp pane", "sidebar sftp", "transfer",
      "双击", "上传", "打开本地文件", "本地面板", "侧边 sftp", "文件传输", "文件浏览器",
    ],
  },
  {
    id: "terminal-defaults",
    titleKeys: ["settings.terminalDefaultsTitle", "terminalAppearance.behaviorHeading"],
    terms: [
      "terminal", "ssh terminal", "local terminal", "terminal defaults", "terminal behavior", "terminal font", "terminal theme",
      "cursor", "scrollback", "right click", "copy on select", "bracketed paste", "osc 52",
      "终端", "ssh 终端", "本地终端", "终端默认", "终端行为", "终端字体", "终端主题",
      "光标", "回滚", "右键", "选中即复制", "括号粘贴",
    ],
  },
  {
    id: "vault",
    titleKeys: ["vaultSettings.sectionTitle"],
    terms: ["vault", "password", "secret", "master password", "credentials", "credential vault", "encryption", "unlock", "startup unlock", "on demand unlock", "密钥库", "保险库", "密码", "凭据", "主密码", "加密", "解锁", "启动解锁", "按需解锁"],
  },
  {
    id: "app-proxy",
    titleKeys: ["settings.appProxyTitle"],
    terms: ["proxy", "socks", "socks5", "http proxy", "network", "vpn", "outbound", "代理", "网络", "出站"],
  },
  {
    id: "lanchat",
    titleKeys: ["settings.lanChatSection"],
    terms: ["lanchat", "lan", "messenger", "chat", "broadcast", "局域网", "内网", "通讯", "聊天", "广播", "消息"],
  },
  {
    id: "ai-master",
    titleKeys: ["settings.aiSection", "settings.aiMaster"],
    terms: ["ai", "artificial intelligence", "master switch", "assistant", "人工智能", "智能", "主开关", "助手"],
  },
  {
    id: "ai-privacy",
    titleKeys: ["settings.privacySection", "aiSettings.fullLocal", "settings.fullLocal"],
    terms: ["privacy", "full local", "offline", "cloud", "隐私", "全本地", "本地", "离线", "云端"],
  },
  {
    id: "ai-shell",
    titleKeys: ["aiSettings.aiShellTitle"],
    terms: ["voice shell", "voice", "shell", "command", "语音", "终端命令", "语音命令"],
  },
  {
    id: "ai-asr",
    titleKeys: ["aiSettings.asrTitle", "settings.asrSection"],
    terms: ["asr", "speech", "voice recognition", "dictation", "microphone", "语音识别", "听写", "麦克风"],
  },
  {
    id: "ai-llm",
    titleKeys: ["settings.llmSection"],
    terms: ["llm", "provider", "model", "openai", "anthropic", "api key", "endpoint", "大模型", "模型", "服务商", "密钥", "接口"],
  },
  {
    id: "ai-websearch",
    titleKeys: ["settings.webSearchSection"],
    terms: ["web search", "search", "internet", "browse", "网页搜索", "联网", "搜索", "浏览"],
  },
  {
    id: "ai-claude",
    titleKeys: ["aiSettings.ccTitle", "settings.claudeCodeSection"],
    terms: ["claude", "claude code", "bridge", "桥接"],
  },
  {
    id: "ai-codex",
    titleKeys: ["aiSettings.codexTitle"],
    terms: ["codex", "codex app-server", "openai codex", "bridge", "config", "科德", "配置", "桥接"],
  },
  {
    id: "ai-acp",
    titleKeys: ["aiSettings.acpTitle"],
    terms: ["acp", "agent client protocol", "grok", "local agent", "proxy", "智能体", "本地 agent", "代理", "通用桥接"],
  },
  {
    id: "ai-chatformat",
    titleKeys: ["settings.chatOutputFormat"],
    terms: ["output format", "markdown", "html", "rendering", "输出格式", "渲染"],
  },
  {
    id: "ai-chatsend",
    titleKeys: ["settings.chatSendShortcut", "aiSettings.chatSendShortcutTitle"],
    terms: [
      "send", "shortcut", "hotkey", "keyboard", "enter", "ctrl+enter", "cmd+enter",
      "composer", "send key",
      "发送", "快捷键", "热键", "回车", "ctrl+enter", "发送快捷键",
    ],
  },
  {
    id: "ai-answerlang",
    titleKeys: ["settings.answerLanguage", "aiSettings.answerLanguageTitle"],
    terms: [
      "answer language", "reply language", "explain language", "chinese", "english",
      "editor ai", "explain", "syntax",
      "回答语言", "答复语言", "解释语言", "中文", "英文", "语言", "编辑器 ai",
    ],
  },
  {
    id: "ai-chathistory",
    titleKeys: ["aiSettings.chatHistoryTitle", "settings.chatHistory"],
    terms: ["chat history", "retention", "clear history", "对话历史", "聊天记录", "保留", "清除"],
  },
  {
    id: "ai-models",
    titleKeys: ["settings.modelsAdvanced"],
    terms: ["models", "advanced", "model scope", "preference", "模型", "高级", "偏好"],
  },
];

// Collapsible groups. Entry ids must cover every SETTINGS_SEARCH_ENTRIES id
// exactly once, in the same top-to-bottom order as the panel renders.
export const SETTINGS_GROUPS: SettingsGroupDef[] = [
  {
    id: "general",
    titleKey: "settings.groupGeneral",
    entryIds: ["language", "app-theme", "welcome-history", "global-ui"],
  },
  {
    id: "code",
    titleKey: "settings.groupCode",
    entryIds: ["code-view-appearance", "sdks", "language-servers", "live-templates"],
  },
  {
    id: "database",
    titleKey: "settings.groupDatabase",
    entryIds: ["sql-completion", "sql-execution"],
  },
  {
    id: "terminal",
    titleKey: "settings.groupTerminal",
    entryIds: ["sftp", "terminal-defaults"],
  },
  {
    id: "security",
    titleKey: "settings.groupSecurity",
    entryIds: ["vault"],
  },
  {
    id: "network",
    titleKey: "settings.groupNetwork",
    entryIds: ["app-proxy", "lanchat"],
  },
  {
    id: "ai",
    titleKey: "settings.groupAi",
    entryIds: [
      "ai-master",
      "ai-privacy",
      "ai-shell",
      "ai-asr",
      "ai-llm",
      "ai-websearch",
      "ai-claude",
      "ai-codex",
      "ai-acp",
      "ai-chatformat",
      "ai-chatsend",
      "ai-answerlang",
      "ai-chathistory",
      "ai-models",
    ],
  },
];

/** Map search-entry id → group id (built once from SETTINGS_GROUPS). */
export const ENTRY_TO_GROUP: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const group of SETTINGS_GROUPS) {
    for (const entryId of group.entryIds) {
      map.set(entryId, group.id);
    }
  }
  return map;
})();

export function groupIdForEntry(entryId: string): string | undefined {
  return ENTRY_TO_GROUP.get(entryId);
}

/** Default expand map: every group collapsed so the panel opens as a compact TOC. */
export function defaultExpandedGroups(): Record<string, boolean> {
  return Object.fromEntries(SETTINGS_GROUPS.map((g) => [g.id, false]));
}

// True when `query` matches the entry's resolved titles or any literal term.
// Empty/whitespace queries never match (caller treats that as "no search").
export function matchesEntry(entry: SettingsSearchEntry, query: string, t: TranslateFn): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  for (const key of entry.titleKeys) {
    const label = t(key);
    // resolveKey returns the key itself when a translation is missing; skip
    // those so a stray dotted key can't accidentally match.
    if (label && label !== key && label.toLowerCase().includes(q)) return true;
  }
  return entry.terms.some((term) => term.toLowerCase().includes(q));
}

// Ordered list of matching entry ids, preserving registry (render) order.
export function matchingIds(query: string, t: TranslateFn): string[] {
  if (!query.trim()) return [];
  return SETTINGS_SEARCH_ENTRIES.filter((entry) => matchesEntry(entry, query, t)).map((e) => e.id);
}

/** Ordered unique group ids that contain at least one of the given entry ids. */
export function matchingGroupIds(entryIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entryId of entryIds) {
    const groupId = ENTRY_TO_GROUP.get(entryId);
    if (!groupId || seen.has(groupId)) continue;
    seen.add(groupId);
    out.push(groupId);
  }
  return out;
}
