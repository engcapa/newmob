import {
  Bot,
  GitBranch,
  Monitor,
  Wifi,
  KeyRound,
  Eye,
  Moon,
  Sun,
  Mic,
  Search,
  Shield,
  Sparkles,
  Cpu,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useAppTheme } from "../../lib/appTheme";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useAiStore } from "../../stores/aiStore";
import { useCodeWorkspaceStatusStore } from "../../stores/codeWorkspaceStatusStore";
import { useT } from "../../lib/i18n";
import { useAppThemeI18nLabel } from "../../lib/i18n/labels";

function StatusSegment({
  testId,
  title,
  onClick,
  children,
}: {
  testId?: string;
  title?: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  // Primary status text (not muted/slate) so language/LSP labels like "Java"
  // stay readable on the light status bar background.
  const className = "flex items-center gap-1 text-[11px] font-medium max-w-[220px] truncate text-[var(--taomni-status-text)]"
    + (onClick ? " rounded px-1 hover:bg-[var(--taomni-hover)] cursor-pointer" : "");
  if (onClick) {
    return (
      <button type="button" data-testid={testId} title={title} className={className} onClick={onClick}>
        {children}
      </button>
    );
  }
  return (
    <span data-testid={testId} title={title} className={className}>
      {children}
    </span>
  );
}

export function StatusBar() {
  const { tabs, activeTabId, xServerEnabled, xServerStatus, statusMessage } = useAppStore();
  const { sessions, selectedSessionId } = useSessionStore();
  const workspaceStatus = useCodeWorkspaceStatusStore((s) => s.status);
  const workspaceActions = useCodeWorkspaceStatusStore((s) => s.actions);
  const { mode, resolvedTheme } = useAppTheme();
  const [online, setOnline] = useState(navigator.onLine);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const selected = sessions.find((session) => session.id === selectedSessionId);
  const aiConfig = useAiStore((s) => s.config);
  const activeProvider = aiConfig?.llm.active ?? "—";
  const activeAsr = aiConfig?.asr.active ?? "—";
  const fullLocal = !!aiConfig?.full_local_mode;
  const fullyDisabled = !!aiConfig?.fully_disabled;
  const ccEnabled = !!aiConfig?.cc_bridge.enabled;
  const codexEnabled = !!aiConfig?.codex_bridge.enabled;
  const searchEnabled = !!aiConfig?.web_search.client_enabled;
  const t = useT();
  const themeLabel = useAppThemeI18nLabel();
  const showWorkspaceSegments = activeTab?.type === "code-workspace"
    && workspaceStatus?.tabId === activeTabId;

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  const dot = (cls: string) => (
    <span className={`w-1.5 h-1.5 rounded-full ${cls}`} />
  );

  return (
    <div data-testid="status-bar" className="taomni-status h-6 flex items-center px-2 gap-3">
      <span className="flex items-center gap-1">
        <Eye className="w-3 h-3" /> {t("statusBar.sessions", { count: sessions.length })} • {selected ? selected.name : t("statusBar.none")}
      </span>
      <span className="taomni-divider-v h-3" />
      <span className="flex items-center gap-1">
        <Wifi className={`w-3 h-3 ${online ? "text-emerald-600" : "text-red-600"}`} /> {online ? t("statusBar.networkOnline") : t("statusBar.networkOffline")}
      </span>
      <span className="flex items-center gap-1" title={xServerStatus?.provider ? `${xServerStatus.provider} · ${xServerStatus.endpoint}` : undefined}>
        <Monitor className={`w-3 h-3 ${xServerEnabled ? "text-emerald-600" : "text-slate-500"}`} /> X11: {xServerEnabled ? (xServerStatus?.display || xServerStatus?.endpoint || "") : t("statusBar.x11Off")}
      </span>
      <span className="flex items-center gap-1">
        <KeyRound className="w-3 h-3 text-slate-500" /> {t("statusBar.auth")}
      </span>

      {!fullyDisabled && (
        <>
          <span className="taomni-divider-v h-3" />

          {/* ASR segment */}
          <span
            className="flex items-center gap-1 text-[11px]"
            title={t("statusBar.asrTooltip", { provider: activeAsr })}
          >
            <Mic className="w-3 h-3" />
            {dot(aiConfig ? "bg-green-400" : "bg-gray-400")}
            <span className="hidden xl:inline">ASR</span>
          </span>

          {/* LLM segment */}
          <span
            className="flex items-center gap-1 text-[11px]"
            title={t("statusBar.llmTooltip", { provider: activeProvider })}
          >
            <Bot className="w-3 h-3" />
            {dot(aiConfig ? "bg-green-400" : "bg-gray-400")}
            {t("statusBar.llm", { provider: activeProvider })}
          </span>

          {/* Web search segment */}
          <span
            className="flex items-center gap-1 text-[11px]"
            title={t("statusBar.webSearchTooltip", {
              state: searchEnabled ? t("common.enabled") : t("common.disabled"),
              provider: aiConfig?.web_search.client_provider ?? "—",
            })}
          >
            <Search className="w-3 h-3" />
            {dot(searchEnabled ? "bg-green-400" : "bg-gray-400")}
          </span>

          {/* Claude Code segment */}
          {ccEnabled && (
            <span
              className="flex items-center gap-1 text-[11px]"
              title={t("statusBar.claudeCodeTooltip")}
            >
              <Cpu className="w-3 h-3" />
              {dot("bg-green-400")}
              CC
            </span>
          )}

          {codexEnabled && (
            <span
              className="flex items-center gap-1 text-[11px]"
              title="Codex app-server enabled"
            >
              <Cpu className="w-3 h-3" />
              {dot("bg-green-400")}
              Codex
            </span>
          )}

          {/* Privacy segment */}
          {fullLocal && (
            <span
              className="flex items-center gap-1 text-[11px] text-purple-300"
              title={t("statusBar.fullLocalTooltip")}
            >
              <Shield className="w-3 h-3" />
              {t("statusBar.fullLocalShort")}
            </span>
          )}
        </>
      )}

      {fullyDisabled && (
        <>
          <span className="taomni-divider-v h-3" />
          <span
            className="flex items-center gap-1 text-[11px] text-yellow-300"
            title={t("statusBar.aiOffTooltip")}
          >
            <Sparkles className="w-3 h-3" />
            {t("statusBar.aiOff")}
          </span>
        </>
      )}

      <div className="flex-1" />
      <span className="truncate max-w-[260px]">{statusMessage}</span>

      {showWorkspaceSegments && workspaceStatus && (
        <>
          <span className="taomni-divider-v h-3" />
          <StatusSegment
            testId="status-bar-workspace-cursor"
            title={`Cursor · line ${workspaceStatus.line}, column ${workspaceStatus.column}`}
          >
            <span className="taomni-mono">Ln {workspaceStatus.line}, Col {workspaceStatus.column}</span>
          </StatusSegment>
          <StatusSegment
            testId="status-bar-workspace-encoding"
            title="File encoding (workspace currently reads/writes UTF-8)"
          >
            {workspaceStatus.encoding}
          </StatusSegment>
          <StatusSegment
            testId="status-bar-workspace-eol"
            title="Detected line endings"
          >
            {workspaceStatus.eol}
          </StatusSegment>
          <StatusSegment
            testId="status-bar-workspace-language"
            title={workspaceStatus.languageId
              ? `Language: ${workspaceStatus.languageId} · open Language Servers settings`
              : "Language unknown · open Language Servers settings"}
            onClick={workspaceActions?.openLanguagePanel}
          >
            <span className="rounded border border-[var(--taomni-divider)] bg-[var(--taomni-card-bg)] px-1.5 py-px text-[var(--taomni-text)]">
              {workspaceStatus.languageId ?? "Plain Text"}
            </span>
          </StatusSegment>
          <StatusSegment
            testId="status-bar-workspace-lsp"
            title={`${workspaceStatus.lspLabel ?? (workspaceStatus.lspActive ? "LSP active" : "No language server")} · open Language Servers settings`}
            onClick={workspaceActions?.openLanguagePanel}
          >
            {dot(workspaceStatus.lspError
              ? "bg-amber-500"
              : workspaceStatus.lspActive
                ? "bg-emerald-500"
                : "bg-slate-500")}
            <span className="truncate text-[var(--taomni-text)]">
              {workspaceStatus.lspLabel ?? (workspaceStatus.lspActive ? "LSP" : "No LSP")}
            </span>
          </StatusSegment>
          {workspaceStatus.gitBranch && (
            <StatusSegment
              testId="status-bar-workspace-git"
              title={`Git branch ${workspaceStatus.gitBranch}${workspaceStatus.gitAhead || workspaceStatus.gitBehind
                ? ` · ahead ${workspaceStatus.gitAhead} · behind ${workspaceStatus.gitBehind}`
                : ""}`}
              onClick={workspaceActions?.openGitManager}
            >
              <GitBranch className="w-3 h-3 shrink-0" />
              <span className="truncate">{workspaceStatus.gitBranch}</span>
              {(workspaceStatus.gitAhead > 0 || workspaceStatus.gitBehind > 0) && (
                <span className="taomni-mono shrink-0 text-[10px] opacity-80">
                  {workspaceStatus.gitAhead > 0 ? `↑${workspaceStatus.gitAhead}` : ""}
                  {workspaceStatus.gitBehind > 0 ? `↓${workspaceStatus.gitBehind}` : ""}
                </span>
              )}
            </StatusSegment>
          )}
          {workspaceStatus.largeFile && (
            <StatusSegment
              testId="status-bar-workspace-large-file"
              title="Large file mode: semantic highlighting, inlay hints and usage highlight are off for performance. Syntax highlighting and on-demand features (completion, hover, go-to) still work."
            >
              {t("statusBar.largeFileMode")}
            </StatusSegment>
          )}
          <StatusSegment
            testId="status-bar-workspace-zoom"
            title="Editor font size"
          >
            {workspaceStatus.fontSize}px
          </StatusSegment>
        </>
      )}

      <span className="taomni-divider-v h-3" />
      <span className="flex items-center gap-1">
        {resolvedTheme === "dark" ? <Moon className="w-3 h-3" /> : <Sun className="w-3 h-3" />}
        {t("statusBar.themeLabel", { mode: themeLabel(mode) })}
      </span>
      <span className="taomni-divider-v h-3" />
      <span className="taomni-mono">
        {activeTab?.type ?? t("statusBar.activeTabNone")} • {t("statusBar.terminalsCount", { count: tabs.filter((tab) => tab.type === "terminal").length })}
      </span>
      <span className="taomni-divider-v h-3" />
      <span>{t("statusBar.versionTag", { version: "0.2.0" })}</span>
    </div>
  );
}
