import {
  Download,
  FileText,
  FolderOpen,
  HelpCircle,
  Menu,
  MessageSquare,
  Monitor,
  MoreHorizontal,
  Network,
  PanelsTopLeft,
  Info,
  PanelLeft,
  Plus,
  Power,
  RefreshCw,
  Search,
  Server,
  Settings,
  Shield,
  SplitSquareVertical,
  Terminal as TerminalIcon,
  Upload,
  Users,
  Wrench,
  X,
  GitBranch,
  Braces,
} from "lucide-react";
import { useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TabBar } from "./TabBar";
import { OpenTabsMenu } from "./OpenTabsMenu";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { WindowControls } from "../window/WindowControls";
import { WindowDragHandle } from "../window/WindowDragHandle";
import { TitleBarTrayControls } from "../window/TitleBarTrayControls";
import { CaptureIndicators } from "../capture/CaptureIndicators";
import { useSessionImportExport } from "../menubar/useSessionImportExport";
import type { AppCommand } from "../menubar/commands";
import { getAppPlatform } from "../../lib/runtime";
import { useUpdateStore } from "../../stores/updateStore";
import { useT } from "../../lib/i18n";
import type { LocalShellSelection } from "../../types";
import type { SessionConfig } from "../../lib/ipc";
import type { WorkspaceCommandMenuItem } from "../editor/workspace/workspaceCommands";
import type { ActionResult } from "../editor/workspace/workspaceActionRegistry";

const IS_MAC = getAppPlatform() === "macos";
// Width reserved on the left for the native macOS traffic-light controls when
// the overlay title bar is active. Windows/Linux render their own controls on
// the right instead, so no inset is needed there.
const MAC_TRAFFIC_LIGHT_INSET = 76;

interface ControlBarProps {
  activeTabClosable: boolean;
  /** macOS has a native global menu, so the in-bar app-menu button is hidden. */
  nativeMenu: boolean;
  xServerEnabled: boolean;
  quickConnectVisible: boolean;
  workspaceCommands?: WorkspaceCommandMenuItem[];
  onCommand: (command: AppCommand) => void;
  onWorkspaceCommand?: (commandId: string) => void | Promise<ActionResult>;
  onToggleSidebar: () => void;
  onStartLocalTerminal: (localShell?: LocalShellSelection) => void;
  onConnectSession: (session: SessionConfig) => void;
  onOpenSessionEditor: () => void;
  onDuplicateTab?: (id: string) => void;
  onDetachActiveTab?: () => void;
  onCloseWindow?: () => void;
  /** Receives the DOM node that hosts the active tab's contextual actions. */
  slotRef: (el: HTMLDivElement | null) => void;
}
export function ControlBar({
  activeTabClosable,
  nativeMenu,
  xServerEnabled,
  quickConnectVisible,
  workspaceCommands = [],
  onCommand,
  onWorkspaceCommand,
  onToggleSidebar,
  onStartLocalTerminal,
  onConnectSession,
  onOpenSessionEditor,
  onDuplicateTab,
  onDetachActiveTab,
  onCloseWindow,
  slotRef,
}: ControlBarProps) {
  const ctx = useContextMenu();
  const t = useT();
  const [detailsRevealHovered, setDetailsRevealHovered] = useState(false);
  const {
    hasSessions,
    importJson,
    importMoba,
    importCsv,
    downloadCsvTemplate,
    importOpenSsh,
    exportJson,
    exportMoba,
    exportCsv,
    exportHtml,
    previewNode,
  } = useSessionImportExport();

  // Borderless window: we move it ourselves via startDragging() on every
  // platform, triggered by a left-button press on any [data-window-drag]
  // region. macOS previously relied on the native overlay title bar's
  // data-tauri-drag-region, but that IPC is unreliable there (e.g. macOS 14
  // Intel) and Tauri only honours the exact mousedown target — so the large
  // tab-strip filler never dragged. A double-click toggles maximize to keep
  // the native title-bar gesture on all platforms.
  const startDrag = (event: React.MouseEvent) => {
    if (event.button !== 0) return;
    if (!(event.target as HTMLElement).closest("[data-window-drag]")) return;
    const win = getCurrentWindow();
    if (event.detail === 2) {
      void win.toggleMaximize().catch(() => {});
    } else {
      void win.startDragging().catch(() => {});
    }
  };

  const openMainMenu = (event: React.MouseEvent) => {
    const importExportItems: MenuItem[] = [
      {
        label: t("menu.importSessions"),
        testId: "menu-import-sessions",
        icon: <Upload className="w-3 h-3" />,
        children: [
          { label: t("menu.importTaomni"), testId: "import-json", icon: <Upload className="w-3 h-3" />, onClick: importJson },
          { label: t("menu.importMobaXterm"), testId: "import-mobaxterm", icon: <Upload className="w-3 h-3" />, onClick: importMoba },
          { label: t("menu.importCsv"), testId: "import-csv", icon: <FileText className="w-3 h-3" />, onClick: importCsv },
          { label: t("menu.downloadCsvTemplate"), testId: "download-csv-template", icon: <FileText className="w-3 h-3" />, onClick: downloadCsvTemplate },
          { label: t("menu.importOpenSsh"), testId: "import-openssh", icon: <TerminalIcon className="w-3 h-3" />, onClick: importOpenSsh },
        ],
        onClick: () => {},
      },
      {
        label: t("menu.exportSessions"),
        testId: "menu-export-sessions",
        icon: <Download className="w-3 h-3" />,
        disabled: !hasSessions,
        children: [
          { label: t("menu.exportTaomni"), testId: "export-json", icon: <Download className="w-3 h-3" />, onClick: exportJson },
          { label: t("menu.exportMobaXterm"), testId: "export-mobaxterm", icon: <Download className="w-3 h-3" />, onClick: exportMoba },
          { label: t("menu.exportCsv"), testId: "export-csv", icon: <FileText className="w-3 h-3" />, onClick: exportCsv },
          { label: t("menu.exportHtml"), testId: "export-html", icon: <FileText className="w-3 h-3" />, onClick: exportHtml },
        ],
        onClick: () => {},
      },
    ];
    ctx.show(event, [
      { label: t("menu.newLocalTerminal"), testId: "context-menu-item-new-local-terminal", icon: <TerminalIcon className="w-3 h-3" />, onClick: () => onCommand("new-terminal") },
      { label: t("menu.newRemoteSession"), icon: <Plus className="w-3 h-3" />, onClick: () => onCommand("new-session") },
      { label: t("ribbon.newSftp"), icon: <FolderOpen className="w-3 h-3" />, onClick: () => onCommand("new-sftp") },
      { label: t("menu.closeActiveTab"), icon: <X className="w-3 h-3" />, onClick: () => onCommand("close-active"), disabled: !activeTabClosable },
      { label: "", separator: true, onClick: () => {} },
      {
        label: t("menu.sessions"),
        testId: "context-menu-item-sessions",
        icon: <FolderOpen className="w-3 h-3" />,
        children: [
          { label: t("menu.showSessions"), icon: <FolderOpen className="w-3 h-3" />, onClick: () => onCommand("sessions") },
          { label: t("menu.newSession"), icon: <Plus className="w-3 h-3" />, onClick: () => onCommand("new-session") },
          { label: t("menu.reloadSessions"), testId: "context-menu-item-reload-sessions", icon: <RefreshCw className="w-3 h-3" />, onClick: () => onCommand("reload-sessions") },
          { label: "", separator: true, onClick: () => {} },
          ...importExportItems,
        ],
        onClick: () => {},
      },
      {
        label: t("menu.view"),
        icon: <PanelLeft className="w-3 h-3" />,
        children: [
          { label: t("sidebar.headerTitle"), icon: <PanelLeft className="w-3 h-3" />, onClick: onToggleSidebar },
          { label: t("menu.quickConnectToolbar"), testId: "context-menu-item-toggle-quick-connect", icon: <Search className="w-3 h-3" />, checked: quickConnectVisible, onClick: () => onCommand("toggle-quick-connect") },
          { label: t("menu.splitTerminal"), icon: <SplitSquareVertical className="w-3 h-3" />, onClick: () => onCommand("split") },
          { label: t("ribbon.multiExec"), icon: <Users className="w-3 h-3" />, onClick: () => onCommand("multiexec") },
        ],
        onClick: () => {},
      },
      {
        label: t("menu.tools"),
        testId: "context-menu-item-tools",
        icon: <Wrench className="w-3 h-3" />,
        children: [
          { label: t("servers.dialogTitle"), testId: "context-menu-item-servers", icon: <Server className="w-3 h-3" />, onClick: () => onCommand("servers") },
          { label: t("menu.tunneling"), icon: <Network className="w-3 h-3" />, onClick: () => onCommand("tunneling") },
          { label: t("menu.sockscap"), icon: <Shield className="w-3 h-3" />, onClick: () => onCommand("sockscap") },
          { label: t("menu.gitRepository"), icon: <GitBranch className="w-3 h-3" />, onClick: () => onCommand("git") },
          { label: t("menu.codeWorkspace"), icon: <FileText className="w-3 h-3" />, onClick: () => onCommand("code-workspace") },
          ...(workspaceCommands.length > 0 ? [{
            label: t("menu.codeWorkspaceActions"),
            testId: "context-menu-workspace-actions",
            icon: <Braces className="w-3 h-3" />,
            children: workspaceCommands.map((command): MenuItem => ({
              label: command.keybinding ? `${command.title}  ${command.keybinding}` : command.title,
              testId: `context-menu-workspace-command-${command.id}`,
              disabled: !command.enabled,
              onClick: () => onWorkspaceCommand?.(command.id),
            })),
            onClick: () => {},
          } satisfies MenuItem] : []),
          { label: t("tabs.lanChat"), icon: <MessageSquare className="w-3 h-3" />, onClick: () => onCommand("lan-chat") },
          { label: t("menu.networkTools"), icon: <Wrench className="w-3 h-3" />, onClick: () => onCommand("tools") },
        ],
        onClick: () => {},
      },
      { label: t("menu.xserver"), testId: "context-menu-item-xserver", icon: <Monitor className="w-3 h-3" />, checked: xServerEnabled, onClick: () => onCommand("toggle-xserver") },
      { label: t("menu.settings"), icon: <Settings className="w-3 h-3" />, onClick: () => onCommand("settings") },
      { label: t("menu.help"), icon: <HelpCircle className="w-3 h-3" />, onClick: () => onCommand("help") },
      { label: "", separator: true, onClick: () => {} },
      { label: t("ribbon.exit"), icon: <Power className="w-3 h-3" />, onClick: () => onCommand("exit"), danger: true },
    ]);
  };

  return (
    <div
      data-testid="control-bar"
      className="taomni-control-bar h-8 flex items-center min-w-0"
      onMouseDown={startDrag}
    >
      {ctx.render}
      {previewNode}
      {IS_MAC && (
        <div className="shrink-0 self-stretch" style={{ width: MAC_TRAFFIC_LIGHT_INSET }} data-window-drag />
      )}
      <div className="flex items-center gap-1 px-1.5 shrink-0">
        {!nativeMenu && (
          <BarButton testId="app-main-menu" title={t("compactTitleBar.mainMenu")} icon={<Menu className="w-4 h-4" />} onClick={openMainMenu} />
        )}
      </div>
      <WindowDragHandle />
      <div className="min-w-0 flex-1 self-stretch">
        <TabBar
          onStartLocalTerminal={onStartLocalTerminal}
          onConnectSession={onConnectSession}
          onOpenSessionEditor={onOpenSessionEditor}
          onDuplicateTab={onDuplicateTab}
          detailsRevealExternal={detailsRevealHovered}
        />
      </div>
      {/* Update hint sits just left of the tab-action group (centre-right of the
          bar). It only appears once a new version is staged. */}
      <UpdateHint />
      {/* Per-tab contextual actions portal in here (SFTP / Chat / detach …). */}
      <div ref={slotRef} data-testid="tab-action-slot" className="flex items-center gap-0.5 self-stretch shrink-0 pr-1" />
      <CaptureIndicators />
      <button
        type="button"
        data-testid="tab-details-hover"
        aria-label={t("tabs.detailsShortcutHint", { shortcut: IS_MAC ? "Cmd+Shift+H" : "Ctrl+Shift+H" })}
        title={t("tabs.detailsShortcutHint", { shortcut: IS_MAC ? "Cmd+Shift+H" : "Ctrl+Shift+H" })}
        data-active={detailsRevealHovered || undefined}
        className="taomni-tab-details-button relative h-6 w-7 shrink-0 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)] data-[active=true]:bg-[var(--taomni-selected)]"
        onMouseEnter={() => setDetailsRevealHovered(true)}
        onMouseLeave={() => setDetailsRevealHovered(false)}
        onFocus={() => setDetailsRevealHovered(true)}
        onBlur={() => setDetailsRevealHovered(false)}
      >
        <PanelsTopLeft className="w-4 h-4" />
        <Info className="absolute right-0.5 bottom-0.5 w-2.5 h-2.5 rounded-full" style={{ background: "var(--taomni-chrome-bg)" }} />
      </button>
      {/* Open-tabs `⋯` overflow — also hosts the Screenshot actions. Sits at the
          right end of the tab-action group. */}
      <TabMore onDetachActiveTab={onDetachActiveTab} />
      <div className={IS_MAC ? "w-2 self-stretch shrink-0" : "w-3 self-stretch shrink-0"} />
      {/* Divider between the tab-related buttons and the main-window controls. */}
      <div aria-hidden="true" className="taomni-control-divider self-stretch shrink-0" />
      <TitleBarTrayControls />
      {!IS_MAC && <WindowControls onClose={onCloseWindow} />}
    </div>
  );
}

/** The `⋯` open-tabs overflow button + its dropdown, relocated from the tab
 *  strip to the right end of the tab-action group. The dropdown also lists the
 *  active tab's Screenshot actions (see OpenTabsMenu). */
function TabMore({ onDetachActiveTab }: { onDetachActiveTab?: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={wrapRef} className="relative shrink-0 pr-1">
      <BarButton
        testId="tab-more"
        title={t("tabs.moreWithDetailsShortcut", {
          shortcut: IS_MAC ? "Cmd+Shift+H" : "Ctrl+Shift+H",
        })}
        icon={<MoreHorizontal className="w-4 h-4" />}
        onClick={() => setOpen((v) => !v)}
      />
      <OpenTabsMenu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={wrapRef}
        onDetachActiveTab={onDetachActiveTab}
      />
    </div>
  );
}

/** Non-intrusive update indicator: a small badge that appears only once a new
 *  version is available/staged. Clicking it opens the update window. */
function UpdateHint() {
  const t = useT();
  const status = useUpdateStore((s) => s.status);
  const version = useUpdateStore((s) => s.availableVersion);
  const openDialog = useUpdateStore((s) => s.openDialog);
  if (status !== "available" && status !== "ready") return null;
  const title = t("titlebar.updateAvailable", { version: version ?? "" });
  return (
    <BarButton
      testId="titlebar-update-available"
      title={title}
      onClick={openDialog}
      icon={
        <span className="relative inline-flex">
          <Download className="w-4 h-4" />
          <span
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 w-[7px] h-[7px] rounded-full"
            style={{ background: "#e5534b", boxShadow: "0 0 0 1.5px var(--taomni-chrome-bg)" }}
          />
        </span>
      }
    />
  );
}

function BarButton({
  icon,
  title,
  onClick,
  testId,
}: {
  icon: React.ReactNode;
  title: string;
  onClick?: (event: React.MouseEvent) => void;
  testId?: string;
}) {
  return (
    <button
      data-testid={testId}
      type="button"
      title={title}
      aria-label={title}
      className="h-6 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]"
      onClick={onClick}
    >
      {icon}
    </button>
  );
}
