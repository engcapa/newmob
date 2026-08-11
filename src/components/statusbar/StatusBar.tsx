import {
  Bot,
  Check,
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
  Loader2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useAppTheme } from "../../lib/appTheme";
import { writeText } from "../../lib/clipboard";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useAiStore } from "../../stores/aiStore";
import { useCodeWorkspaceStatusStore } from "../../stores/codeWorkspaceStatusStore";
import { useT } from "../../lib/i18n";
import { useAppThemeI18nLabel } from "../../lib/i18n/labels";

/**
 * Copy-with-feedback state shared by status-bar text: copies to the clipboard,
 * then briefly swaps the tooltip to "Copied to clipboard" and appends a check
 * mark. Right-click copy follows the PathBreadcrumb convention for text that
 * has a primary click action.
 */
function useCopyFeedback() {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);
  const copy = useCallback(async (text: string) => {
    if (!text) return;
    try {
      await writeText(text);
      setCopied(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard unavailable — the tooltip still shows the full value.
    }
  }, [t]);
  return { copied, copiedTitle: t("common.copied"), copy };
}

/**
 * Text that truncates with an ellipsis when space runs out: hovering shows the
 * full value in a native tooltip and clicking copies it to the clipboard, so
 * status-bar info stays reachable at any font size / window width.
 */
function CopyableText({
  text,
  title,
  className = "",
  testId,
  children,
}: {
  /** Value copied to the clipboard on click. */
  text: string;
  /** Tooltip text; defaults to the rendered children (or `text`). */
  title?: string;
  className?: string;
  testId?: string;
  children?: ReactNode;
}) {
  const { copied, copiedTitle, copy } = useCopyFeedback();
  const rendered = children ?? text;
  return (
    <span
      data-testid={testId}
      className={`${className}${text ? " cursor-pointer" : ""}`}
      title={copied ? copiedTitle : (title ?? (typeof rendered === "string" ? rendered : text))}
      onClick={() => copy(text)}
    >
      {rendered}
      {copied && text && <Check className="w-3 h-3 shrink-0 text-emerald-500" />}
    </span>
  );
}

function StatusSegment({
  testId,
  title,
  onClick,
  copyText,
  children,
}: {
  testId?: string;
  title?: string;
  onClick?: () => void;
  /** Full value copied to the clipboard on right-click (e.g. a truncated name). */
  copyText?: string;
  children: ReactNode;
}) {
  const { copied, copiedTitle, copy } = useCopyFeedback();
  const onContextMenu = copyText
    ? (e: ReactMouseEvent) => {
        e.preventDefault();
        copy(copyText);
      }
    : undefined;
  // Primary status text (not muted/slate) so language/LSP labels like "Java"
  // stay readable on the light status bar background. Font size is inherited
  // from .taomni-status so segments scale with the app UI font size.
  const className = "flex items-center gap-1 font-medium max-w-[220px] truncate text-[var(--taomni-status-text)]"
    + (onClick ? " rounded px-1 hover:bg-[var(--taomni-hover)] cursor-pointer" : "");
  const common = {
    "data-testid": testId,
    title: copied ? copiedTitle : title,
    className,
    onContextMenu,
  };
  if (onClick) {
    return (
      <button type="button" {...common} onClick={onClick}>
        {children}
        {copied && <Check className="w-3 h-3 shrink-0 text-emerald-500" />}
      </button>
    );
  }
  return (
    <span {...common}>
      {children}
      {copied && <Check className="w-3 h-3 shrink-0 text-emerald-500" />}
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
    <div data-testid="status-bar" className="taomni-status min-h-6 flex items-center px-2 gap-3">
      <span className="flex items-center gap-1 min-w-0">
        <Eye className="w-3 h-3 shrink-0" />
        <span className="shrink-0">{t("statusBar.sessions", { count: sessions.length })}</span>
        <span className="shrink-0">•</span>
        {selected ? (
          <CopyableText text={selected.name} className="truncate min-w-0" testId="status-bar-selected-session">
            {selected.name}
          </CopyableText>
        ) : (
          <span className="truncate min-w-0">{t("statusBar.none")}</span>
        )}
      </span>
      <span className="taomni-divider-v h-3" />
      <span className="flex items-center gap-1 min-w-0" title={online ? t("statusBar.networkOnline") : t("statusBar.networkOffline")}>
        <Wifi className={`w-3 h-3 shrink-0 ${online ? "text-emerald-600" : "text-red-600"}`} />
        <span className="truncate min-w-0">{online ? t("statusBar.networkOnline") : t("statusBar.networkOffline")}</span>
      </span>
      <span className="flex items-center gap-1 min-w-0" title={xServerStatus?.provider ? `${xServerStatus.provider} · ${xServerStatus.endpoint}` : undefined}>
        <Monitor className={`w-3 h-3 shrink-0 ${xServerEnabled ? "text-emerald-600" : "text-slate-500"}`} />
        <span className="shrink-0">X11:</span>
        {xServerEnabled ? (
          <CopyableText text={xServerStatus?.display || xServerStatus?.endpoint || ""} className="truncate min-w-0" />
        ) : (
          <span className="truncate min-w-0">{t("statusBar.x11Off")}</span>
        )}
      </span>
      <span className="flex items-center gap-1 min-w-0" title={t("statusBar.auth")}>
        <KeyRound className="w-3 h-3 shrink-0 text-slate-500" />
        <span className="truncate min-w-0">{t("statusBar.auth")}</span>
      </span>

      {!fullyDisabled && (
        <>
          <span className="taomni-divider-v h-3" />

          {/* ASR segment */}
          <span
            className="flex items-center gap-1 min-w-0"
            title={t("statusBar.asrTooltip", { provider: activeAsr })}
          >
            <Mic className="w-3 h-3 shrink-0" />
            {dot(aiConfig ? "bg-green-400" : "bg-gray-400")}
            <span className="hidden xl:inline truncate min-w-0">ASR</span>
          </span>

          {/* LLM segment */}
          <span
            className="flex items-center gap-1 min-w-0"
            title={t("statusBar.llmTooltip", { provider: activeProvider })}
          >
            <Bot className="w-3 h-3 shrink-0" />
            {dot(aiConfig ? "bg-green-400" : "bg-gray-400")}
            <CopyableText
              text={aiConfig ? activeProvider : ""}
              title={t("statusBar.llmTooltip", { provider: activeProvider })}
              className="truncate min-w-0"
            >
              {t("statusBar.llm", { provider: activeProvider })}
            </CopyableText>
          </span>

          {/* Web search segment */}
          <span
            className="flex items-center gap-1 min-w-0"
            title={t("statusBar.webSearchTooltip", {
              state: searchEnabled ? t("common.enabled") : t("common.disabled"),
              provider: aiConfig?.web_search.client_provider ?? "—",
            })}
          >
            <Search className="w-3 h-3 shrink-0" />
            {dot(searchEnabled ? "bg-green-400" : "bg-gray-400")}
          </span>

          {/* Claude Code segment */}
          {ccEnabled && (
            <span
              className="flex items-center gap-1 min-w-0"
              title={t("statusBar.claudeCodeTooltip")}
            >
              <Cpu className="w-3 h-3 shrink-0" />
              {dot("bg-green-400")}
              <span className="truncate min-w-0">CC</span>
            </span>
          )}

          {codexEnabled && (
            <span
              className="flex items-center gap-1 min-w-0"
              title="Codex app-server enabled"
            >
              <Cpu className="w-3 h-3 shrink-0" />
              {dot("bg-green-400")}
              <span className="truncate min-w-0">Codex</span>
            </span>
          )}

          {/* Privacy segment */}
          {fullLocal && (
            <span
              className="flex items-center gap-1 min-w-0 text-purple-300"
              title={t("statusBar.fullLocalTooltip")}
            >
              <Shield className="w-3 h-3 shrink-0" />
              <span className="truncate min-w-0">{t("statusBar.fullLocalShort")}</span>
            </span>
          )}
        </>
      )}

      {fullyDisabled && (
        <>
          <span className="taomni-divider-v h-3" />
          <span
            className="flex items-center gap-1 min-w-0 text-yellow-300"
            title={t("statusBar.aiOffTooltip")}
          >
            <Sparkles className="w-3 h-3 shrink-0" />
            <span className="truncate min-w-0">{t("statusBar.aiOff")}</span>
          </span>
        </>
      )}

      <div className="flex-1" />
      {statusMessage && (
        <CopyableText text={statusMessage} className="truncate max-w-[260px]" testId="status-bar-message" />
      )}

      {showWorkspaceSegments && workspaceStatus?.lspProgress && (
        <span
          data-testid="status-bar-workspace-lsp-progress"
          className="flex min-w-0 max-w-[300px] items-center gap-1 text-[var(--taomni-status-text)]"
          title={`${workspaceStatus.lspProgress.label}${workspaceStatus.lspProgress.message
            ? ` · ${workspaceStatus.lspProgress.message}`
            : ""}${workspaceStatus.lspProgress.cancellable ? " · cancel" : ""}`}
        >
          <Loader2 className="w-3 h-3 shrink-0 animate-spin" />
          <span className="truncate">{workspaceStatus.lspProgress.label}</span>
          {workspaceStatus.lspProgress.percentage !== null && (
            <span className="taomni-mono shrink-0 text-[10px]">
              {workspaceStatus.lspProgress.percentage}%
            </span>
          )}
          {workspaceStatus.lspProgress.cancellable && workspaceActions?.cancelLspProgress && (
            <button
              type="button"
              aria-label="Cancel language server task"
              title="Cancel language server task"
              className="shrink-0 rounded p-0.5 hover:bg-[var(--taomni-hover)]"
              onClick={workspaceActions.cancelLspProgress}
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </span>
      )}

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
            title={workspaceStatus.encoding === "UTF-8 BOM"
              ? "UTF-8 with BOM · click to remove BOM"
              : "UTF-8 · click to add BOM"}
            onClick={workspaceActions?.toggleBom}
          >
            {workspaceStatus.encoding}
          </StatusSegment>
          <StatusSegment
            testId="status-bar-workspace-eol"
            title="Line endings · click to cycle LF, CRLF, and CR"
            onClick={workspaceActions?.cycleEol}
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
            copyText={workspaceStatus.lspLabel ?? ""}
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
              copyText={workspaceStatus.gitBranch}
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

      <span className="taomni-divider-v h-3 shrink-0" />
      <span
        className="flex items-center gap-1 min-w-0"
        title={t("statusBar.themeLabel", { mode: themeLabel(mode) })}
      >
        {resolvedTheme === "dark" ? <Moon className="w-3 h-3 shrink-0" /> : <Sun className="w-3 h-3 shrink-0" />}
        <span className="truncate min-w-0">{t("statusBar.themeLabel", { mode: themeLabel(mode) })}</span>
      </span>
      <span className="taomni-divider-v h-3 shrink-0" />
      <span
        className="taomni-mono min-w-0 truncate"
        title={`${activeTab?.type ?? t("statusBar.activeTabNone")} • ${t("statusBar.terminalsCount", { count: tabs.filter((tab) => tab.type === "terminal").length })}`}
      >
        {activeTab?.type ?? t("statusBar.activeTabNone")} • {t("statusBar.terminalsCount", { count: tabs.filter((tab) => tab.type === "terminal").length })}
      </span>
      <span className="taomni-divider-v h-3 shrink-0" />
      <span className="min-w-0 truncate" title={t("statusBar.versionTag", { version: "0.2.0" })}>
        {t("statusBar.versionTag", { version: "0.2.0" })}
      </span>
    </div>
  );
}
