import {
  Terminal as TerminalIcon,
  Server,
  Wrench,
  Gamepad2,
  Bookmark,
  Layout,
  SplitSquareVertical,
  Users,
  Network,
  Package,
  Settings,
  HelpCircle,
  Monitor,
  Power,
  FolderTree,
} from "lucide-react";

export type RibbonCommand =
  | "new-session"
  | "new-terminal"
  | "new-sftp"
  | "servers"
  | "tools"
  | "games"
  | "sessions"
  | "view"
  | "split"
  | "multiexec"
  | "tunneling"
  | "packages"
  | "settings"
  | "macros"
  | "help"
  | "toggle-xserver"
  | "exit";

interface RibbonProps {
  xServerEnabled: boolean;
  onCommand: (command: RibbonCommand) => void;
}

export function Ribbon({ xServerEnabled, onCommand }: RibbonProps) {
  return (
    <div data-testid="ribbon" className="moba-ribbon px-2 pt-1.5 pb-1 flex items-end gap-1">
      <RibbonBtn icon={<TerminalIcon className="w-6 h-6" style={{ color: "#2b5d8b" }} />} label="Session" highlight onClick={() => onCommand("new-session")} />
      <RibbonBtn icon={<FolderTree className="w-6 h-6" style={{ color: "#1f7a4a" }} />} label="SFTP" onClick={() => onCommand("new-sftp")} />
      <RibbonBtn icon={<Server className="w-6 h-6" style={{ color: "#3b7ac2" }} />} label="Servers" onClick={() => onCommand("servers")} />
      <RibbonBtn icon={<Wrench className="w-6 h-6" style={{ color: "#5b8a4a" }} />} label="Tools" onClick={() => onCommand("tools")} />
      <RibbonBtn icon={<Gamepad2 className="w-6 h-6" style={{ color: "#a04b9c" }} />} label="Games" onClick={() => onCommand("games")} />
      <RibbonBtn icon={<Bookmark className="w-6 h-6" style={{ color: "#c97a23" }} />} label="Sessions" onClick={() => onCommand("sessions")} />
      <RibbonBtn icon={<Layout className="w-6 h-6" style={{ color: "#3b7ac2" }} />} label="View" onClick={() => onCommand("view")} />
      <RibbonBtn icon={<SplitSquareVertical className="w-6 h-6" style={{ color: "#2b5d8b" }} />} label="Split" onClick={() => onCommand("split")} />
      <RibbonBtn icon={<Users className="w-6 h-6" style={{ color: "#7a3d9d" }} />} label="MultiExec" onClick={() => onCommand("multiexec")} />
      <RibbonBtn icon={<Network className="w-6 h-6" style={{ color: "#236a98" }} />} label="Tunneling" onClick={() => onCommand("tunneling")} />
      <RibbonBtn icon={<Package className="w-6 h-6" style={{ color: "#7a4f1a" }} />} label="Packages" onClick={() => onCommand("packages")} />
      <RibbonBtn icon={<Settings className="w-6 h-6" style={{ color: "var(--moba-text-muted)" }} />} label="Settings" onClick={() => onCommand("settings")} />
      <RibbonBtn icon={<HelpCircle className="w-6 h-6" style={{ color: "#1f6db8" }} />} label="Help" onClick={() => onCommand("help")} />
      <div className="flex-1" />
      <div className="flex items-center gap-2 mr-2">
        <span className="moba-pill">
          <span className={`w-1.5 h-1.5 rounded-full inline-block ${xServerEnabled ? "bg-emerald-500" : "bg-slate-400"}`} /> X server: {xServerEnabled ? "on" : "off"}
        </span>
        <RibbonBtn icon={<Monitor className="w-6 h-6" style={{ color: "#2b5d8b" }} />} label="X server" onClick={() => onCommand("toggle-xserver")} />
        <RibbonBtn icon={<Power className="w-6 h-6" style={{ color: "#b22222" }} />} label="Exit" onClick={() => onCommand("exit")} />
      </div>
    </div>
  );
}

function RibbonBtn({
  icon,
  label,
  highlight,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  highlight?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      data-testid={`ribbon-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
      className="moba-ribbon-btn"
      onClick={onClick}
      type="button"
      style={
        highlight
          ? { background: "var(--moba-control-hover)", outline: "1px solid var(--moba-tab-border)" }
          : undefined
      }
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
