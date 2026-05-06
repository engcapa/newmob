import {
  FolderOpen,
  HelpCircle,
  Menu,
  PanelLeft,
  Plus,
  RefreshCw,
  Settings,
  Terminal as TerminalIcon,
  Wrench,
  X,
  PanelTopOpen,
} from "lucide-react";
import { TabBar } from "./TabBar";
import { useContextMenu } from "../ContextMenu";
import type { RibbonCommand } from "../menubar/Ribbon";

type CompactCommand = RibbonCommand | "close-active" | "reload-sessions";

interface CompactTitleBarProps {
  activeTabClosable: boolean;
  onCommand: (command: CompactCommand) => void;
  onToggleSidebarDrawer: () => void;
}

export function CompactTitleBar({
  activeTabClosable,
  onCommand,
  onToggleSidebarDrawer,
}: CompactTitleBarProps) {
  const ctx = useContextMenu();

  const openMainMenu = (event: React.MouseEvent) => {
    ctx.show(event, [
      { label: "New local terminal", icon: <TerminalIcon className="w-3 h-3" />, onClick: () => onCommand("new-terminal") },
      { label: "New remote session...", icon: <Plus className="w-3 h-3" />, onClick: () => onCommand("new-session") },
      { label: "New SFTP browser...", icon: <FolderOpen className="w-3 h-3" />, onClick: () => onCommand("new-sftp") },
      { label: "Close active tab", icon: <X className="w-3 h-3" />, onClick: () => onCommand("close-active"), disabled: !activeTabClosable },
      { label: "", separator: true, onClick: () => {} },
      {
        label: "Sessions",
        icon: <PanelLeft className="w-3 h-3" />,
        children: [
          { label: "Show sessions drawer", icon: <PanelLeft className="w-3 h-3" />, onClick: onToggleSidebarDrawer },
          { label: "New session...", icon: <Plus className="w-3 h-3" />, onClick: () => onCommand("new-session") },
          { label: "Reload sessions", icon: <RefreshCw className="w-3 h-3" />, onClick: () => onCommand("reload-sessions") },
        ],
        onClick: () => {},
      },
      {
        label: "View",
        icon: <PanelTopOpen className="w-3 h-3" />,
        children: [
          { label: "Exit compact mode", shortcut: "Ctrl+Shift+M", onClick: () => onCommand("toggle-compact") },
          { label: "Toggle sessions drawer", icon: <PanelLeft className="w-3 h-3" />, onClick: onToggleSidebarDrawer },
          { label: "Split active terminal", onClick: () => onCommand("split") },
        ],
        onClick: () => {},
      },
      { label: "Tunneling", icon: <Wrench className="w-3 h-3" />, onClick: () => onCommand("tunneling") },
      { label: "Settings", icon: <Settings className="w-3 h-3" />, onClick: () => onCommand("settings") },
      { label: "Help", icon: <HelpCircle className="w-3 h-3" />, onClick: () => onCommand("help") },
      { label: "", separator: true, onClick: () => {} },
      { label: "Exit NewMob", onClick: () => onCommand("exit"), danger: true },
    ]);
  };

  return (
    <div
      data-testid="compact-titlebar"
      className="moba-compact-titlebar h-8 flex items-center min-w-0"
    >
      {ctx.render}
      <div className="flex items-center gap-1 px-1.5 shrink-0">
        <TitleBarButton title="Main menu" icon={<Menu className="w-4 h-4" />} onClick={openMainMenu} />
        <TitleBarButton title="Show sessions drawer" icon={<PanelLeft className="w-4 h-4" />} onClick={onToggleSidebarDrawer} />
      </div>
      <div className="min-w-0 flex-1 self-stretch">
        <TabBar />
      </div>
      <div className="w-10 self-stretch shrink-0" />
    </div>
  );
}

function TitleBarButton({
  icon,
  title,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  onClick?: (event: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className="h-6 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--moba-hover)]"
      onClick={onClick}
    >
      {icon}
    </button>
  );
}
