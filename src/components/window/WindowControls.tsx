import { Maximize2, Minus, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function WindowControls() {
  return (
    <div className="moba-window-controls flex items-stretch self-stretch shrink-0">
      <WindowButton title="Minimize" icon={<Minus className="w-4 h-4" />} onClick={() => void getCurrentWindow().minimize()} />
      <WindowButton title="Maximize" icon={<Maximize2 className="w-3.5 h-3.5" />} onClick={() => void getCurrentWindow().toggleMaximize()} />
      <WindowButton danger title="Close" icon={<X className="w-4 h-4" />} onClick={() => void getCurrentWindow().close()} />
    </div>
  );
}

function WindowButton({
  icon,
  title,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  title: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className="h-full w-10 inline-flex items-center justify-center hover:bg-[var(--moba-hover)]"
      style={danger ? undefined : { color: "var(--moba-text)" }}
      data-danger={danger || undefined}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}
