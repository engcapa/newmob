import {
  FolderOpen,
  HelpCircle,
  PanelLeft,
  Plus,
  RefreshCw,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import { useContextMenu } from "../ContextMenu";
import { AppThemeIconButton } from "../settings/AppThemeSwitcher";
import type { RibbonCommand } from "./Ribbon";

interface MenuBarProps {
  activeTabClosable: boolean;
  onCommand: (command: RibbonCommand | "close-active" | "reload-sessions") => void;
}

export function MenuBar({ activeTabClosable, onCommand }: MenuBarProps) {
  const ctx = useContextMenu();
  const items = [
    "Terminal", "Sessions", "View", "X server", "Tools", "Games", "Settings", "Macros", "Help",
  ];

  const openMenu = (event: React.MouseEvent, menu: string) => {
    if (menu === "Terminal") {
      ctx.show(event, [
        { label: "New local terminal", icon: <TerminalIcon className="w-3 h-3" />, onClick: () => onCommand("new-terminal") },
        { label: "New remote session…", icon: <Plus className="w-3 h-3" />, onClick: () => onCommand("new-session") },
        { label: "", separator: true, onClick: () => {} },
        { label: "Close active tab", icon: <X className="w-3 h-3" />, onClick: () => onCommand("close-active"), disabled: !activeTabClosable },
      ]);
      return;
    }

    if (menu === "Sessions") {
      ctx.show(event, [
        { label: "New session…", icon: <Plus className="w-3 h-3" />, onClick: () => onCommand("new-session") },
        { label: "Show sessions", icon: <FolderOpen className="w-3 h-3" />, onClick: () => onCommand("sessions") },
        { label: "Reload sessions", icon: <RefreshCw className="w-3 h-3" />, onClick: () => onCommand("reload-sessions") },
      ]);
      return;
    }

    if (menu === "View") {
      ctx.show(event, [
        { label: "Toggle sidebar", icon: <PanelLeft className="w-3 h-3" />, onClick: () => onCommand("view") },
        { label: "Split active terminal", icon: <PanelLeft className="w-3 h-3" />, onClick: () => onCommand("split") },
      ]);
      return;
    }

    if (menu === "X server") {
      ctx.show(event, [
        { label: "Toggle X server status", onClick: () => onCommand("toggle-xserver") },
      ]);
      return;
    }

    if (menu === "Help") {
      ctx.show(event, [
        { label: "About NewMob", icon: <HelpCircle className="w-3 h-3" />, onClick: () => onCommand("help") },
      ]);
      return;
    }

    const command = menu.toLowerCase() as RibbonCommand;
    ctx.show(event, [
      { label: `Open ${menu}`, onClick: () => onCommand(command) },
    ]);
  };

  return (
    <div
      data-testid="menu-bar"
      className="h-6 flex items-center text-[12px] px-2 gap-3 border-b"
      style={{ borderColor: "var(--moba-chrome-border)", background: "var(--moba-menubar-bg)" }}
    >
      {ctx.render}
      {items.map((m) => (
        <button
          key={m}
          className="px-1 hover:bg-[var(--moba-hover)] rounded"
          onClick={(event) => openMenu(event, m)}
          type="button"
        >
          <span className="underline-offset-2">
            <span className="underline">{m[0]}</span>
            {m.slice(1)}
          </span>
        </button>
      ))}
      <div className="ml-auto">
        <AppThemeIconButton />
      </div>
    </div>
  );
}
