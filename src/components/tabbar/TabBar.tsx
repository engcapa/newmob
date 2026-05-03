import {
  Plus,
  X,
  Terminal as TerminalIcon,
  Folder,
  Monitor,
  Network as NetworkIcon,
  SplitSquareVertical,
  Users,
  Maximize2,
  MoreHorizontal,
  Copy,
  Trash2,
} from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useContextMenu } from "../ContextMenu";
import type { Tab, TabKind } from "../../types";

export function TabBar() {
  const { tabs, activeTabId, setActiveTab, removeTab, removeTabs, addTab } = useAppStore();
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
      { label: "New local terminal", icon: <TerminalIcon className="w-3 h-3" />, onClick: handleNewTab },
      { label: "Close all terminals", icon: <Trash2 className="w-3 h-3" />, onClick: () => removeTabs(tabs.filter((t) => t.type === "terminal" && t.closable).map((t) => t.id)) },
    ]);
  };

  return (
    <div
      data-testid="tab-bar"
      className="h-8 flex items-end pl-2 pr-1 pt-1.5 gap-0"
      style={{ background: "linear-gradient(to bottom, var(--moba-tab-inactive), var(--moba-chrome-bg))" }}
    >
      {ctx.render}
      {tabs.map((tab) => (
        <div
          key={tab.id}
          data-testid="tab-item"
          data-tab-title={tab.title}
          data-tab-type={tab.type}
          className="moba-tab"
          data-active={activeTabId === tab.id}
          onClick={() => setActiveTab(tab.id)}
          onMouseDown={(e) => handleMouseDown(e, tab)}
          onContextMenu={(e) => handleTabContext(e, tab)}
        >
          <TabIcon kind={tab.type} ssh={!!tab.ssh} />
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
      ))}

      <button
        data-testid="new-local-terminal"
        className="moba-tab"
        data-active={false}
        onClick={handleNewTab}
        title="New tab"
      >
        <Plus className="w-3 h-3" />
      </button>

      <div className="flex-1" />
      <div className="flex items-center gap-1 pr-1 pb-0.5">
        <IconBtn title="Split view is not active in this phase" icon={<SplitSquareVertical className="w-3.5 h-3.5" />} disabled />
        <IconBtn title="MultiExec is not active in this phase" icon={<Users className="w-3.5 h-3.5" />} disabled />
        <IconBtn title="Detach is not active in this phase" icon={<Maximize2 className="w-3.5 h-3.5" />} disabled />
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
}: {
  icon: React.ReactNode;
  title: string;
  onClick?: (event: React.MouseEvent) => void;
  disabled?: boolean;
}) {
  return (
    <button
      title={title}
      className="w-6 h-6 inline-flex items-center justify-center rounded hover:bg-[var(--moba-hover)] disabled:opacity-40 disabled:cursor-default"
      onClick={onClick}
      disabled={disabled}
      type="button"
    >
      {icon}
    </button>
  );
}
