import {
  Plus,
  X,
  Terminal as TerminalIcon,
  Folder,
  Monitor,
  Network as NetworkIcon,
  PanelTopClose,
  PanelTopOpen,
  SplitSquareVertical,
  Users,
  MoreHorizontal,
  Copy,
  Trash2,
} from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useContextMenu } from "../ContextMenu";
import type { Tab, TabKind } from "../../types";

export function TabBar() {
  const {
    tabs,
    activeTabId,
    compactMode,
    setActiveTab,
    removeTab,
    removeTabs,
    addTab,
    toggleCompactMode,
    multiExecActive,
    multiExecSelectedTabIds,
    toggleMultiExec,
    toggleMultiExecTab,
  } = useAppStore();
  const ctx = useContextMenu();

  const handleNewTab = () => {
    const id = `terminal-${Date.now()}`;
    addTab({
      id,
      type: "terminal",
      title: `Terminal ${tabs.length}`,
      closable: true,
    });
  };

  const handleMouseDown = (e: React.MouseEvent, tab: Tab) => {
    if (e.button === 1 && tab.closable) {
      e.preventDefault();
      removeTab(tab.id);
    }
  };

  const handleTabContext = (e: React.MouseEvent, tab: Tab) => {
    ctx.show(e, [
      { label: "Close", icon: <X className="w-3 h-3" />, onClick: () => removeTab(tab.id), disabled: !tab.closable },
      { label: "Close others", icon: <Trash2 className="w-3 h-3" />, onClick: () => removeTabs(tabs.filter((t) => t.id !== tab.id && t.closable).map((t) => t.id)) },
      { label: "Close all", icon: <Trash2 className="w-3 h-3" />, onClick: () => removeTabs(tabs.filter((t) => t.closable).map((t) => t.id)) },
      { label: "", separator: true, onClick: () => {} },
      { label: "Duplicate tab", icon: <Copy className="w-3 h-3" />, onClick: () => {
        addTab({ ...tab, id: `dup-${Date.now()}`, closable: true });
      }, disabled: tab.type === "welcome" },
    ]);
  };

  const handleMore = (event: React.MouseEvent) => {
    ctx.show(event, [
      {
        label: compactMode ? "Exit compact mode" : "Enter compact mode",
        icon: compactMode ? <PanelTopOpen className="w-3 h-3" /> : <PanelTopClose className="w-3 h-3" />,
        shortcut: "Ctrl+Shift+M",
        onClick: toggleCompactMode,
      },
      { label: "", separator: true, onClick: () => {} },
      { label: "New local terminal", icon: <TerminalIcon className="w-3 h-3" />, onClick: handleNewTab },
      { label: "Close all terminals", icon: <Trash2 className="w-3 h-3" />, onClick: () => removeTabs(tabs.filter((t) => t.type === "terminal" && t.closable).map((t) => t.id)) },
    ]);
  };

  return (
    <div
      data-testid="tab-bar"
      data-compact={compactMode}
      className="moba-tabbar h-8 flex items-end pl-2 pr-1 pt-1.5 gap-0"
      style={{ background: "linear-gradient(to bottom, var(--moba-tab-inactive), var(--moba-chrome-bg))" }}
    >
      {ctx.render}
      {tabs.map((tab) => {
        const isSelected = multiExecActive && tab.type === "terminal" && multiExecSelectedTabIds.has(tab.id);
        return (
          <div
            key={tab.id}
            data-testid="tab-item"
            data-tab-title={tab.title}
            data-tab-type={tab.type}
            data-multiexec-selected={isSelected || undefined}
            className="moba-tab relative"
            data-active={activeTabId === tab.id}
            onClick={() => setActiveTab(tab.id)}
            onMouseDown={(e) => handleMouseDown(e, tab)}
            onContextMenu={(e) => handleTabContext(e, tab)}
          >
            {multiExecActive && tab.type === "terminal" && (
              <button
                type="button"
                title={isSelected ? "Remove from MultiExec" : "Add to MultiExec"}
                className="absolute -top-0.5 -left-0.5 w-3 h-3 rounded-full border flex items-center justify-center z-10 flex-shrink-0"
                style={{
                  background: isSelected ? "var(--moba-accent)" : "var(--moba-chrome-bg)",
                  borderColor: isSelected ? "var(--moba-accent)" : "var(--moba-divider)",
                  fontSize: 7,
                  color: isSelected ? "#fff" : "var(--moba-text-muted)",
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleMultiExecTab(tab.id);
                }}
              >
                {isSelected ? "✓" : ""}
              </button>
            )}
            <div className="relative flex-shrink-0">
              <TabIcon kind={tab.type} ssh={!!tab.ssh} />
              {tab.hasNewOutput && (
                <span
                  className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-emerald-500 pointer-events-none"
                  aria-label="New output"
                />
              )}
            </div>
            <span className="truncate max-w-[180px]">{tab.title}</span>
            {tab.closable && (
              <X
                className="w-3 h-3 ml-1 opacity-60 hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  removeTab(tab.id);
                }}
              />
            )}
          </div>
        );
      })}

      <button
        data-testid="new-local-terminal"
        className="moba-tab"
        data-active={false}
        onClick={handleNewTab}
        title="New tab"
      >
        <Plus className="w-3 h-3" />
      </button>

      <div className="flex-1 self-stretch" data-window-drag />
      <div className="flex items-center gap-1 pr-1 pb-0.5">
        {!compactMode && (
          <>
            <IconBtn title="Split view is not active in this phase" icon={<SplitSquareVertical className="w-3.5 h-3.5" />} disabled />
            <IconBtn
              title={multiExecActive ? "Disable MultiExec" : "Enable MultiExec"}
              icon={<Users className="w-3.5 h-3.5" />}
              onClick={toggleMultiExec}
              active={multiExecActive}
            />
          </>
        )}
        <IconBtn
          title={compactMode ? "Exit compact mode" : "Enter compact mode"}
          icon={compactMode ? <PanelTopOpen className="w-3.5 h-3.5" /> : <PanelTopClose className="w-3.5 h-3.5" />}
          onClick={toggleCompactMode}
          active={compactMode}
          compactToggle
        />
        <IconBtn title="More" icon={<MoreHorizontal className="w-3.5 h-3.5" />} onClick={handleMore} />
      </div>
    </div>
  );
}

function TabIcon({ kind, ssh }: { kind: TabKind; ssh?: boolean }) {
  if (kind === "terminal" && ssh) {
    return <TerminalIcon className="w-3 h-3" style={{ color: "#2b5d8b" }} />;
  }
  switch (kind) {
    case "terminal":
      return <TerminalIcon className="w-3 h-3" style={{ color: "#62d36f" }} />;
    case "sftp":
      return <Folder className="w-3 h-3" style={{ color: "#3b7ac2" }} />;
    case "rdp":
    case "vnc":
      return <Monitor className="w-3 h-3" style={{ color: "#a04b9c" }} />;
    case "nettools":
      return <NetworkIcon className="w-3 h-3" style={{ color: "#236a98" }} />;
    default:
      return <TerminalIcon className="w-3 h-3" style={{ color: "#2b5d8b" }} />;
  }
}

function IconBtn({
  icon,
  title,
  onClick,
  disabled,
  active,
  compactToggle,
}: {
  icon: React.ReactNode;
  title: string;
  onClick?: (event: React.MouseEvent) => void;
  disabled?: boolean;
  active?: boolean;
  compactToggle?: boolean;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      data-active={active || undefined}
      data-compact-toggle={compactToggle || undefined}
      className="w-6 h-6 inline-flex items-center justify-center rounded hover:bg-[var(--moba-hover)] disabled:opacity-40 disabled:cursor-default"
      style={active ? { background: "var(--moba-selected)", color: "var(--moba-accent)" } : undefined}
      onClick={onClick}
      disabled={disabled}
      type="button"
    >
      {icon}
    </button>
  );
}
