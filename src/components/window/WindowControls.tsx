import { Maximize2, Minus, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function WindowControls() {
  return (
    <div className="moba-window-controls flex items-stretch self-stretch shrink-0" data-testid="window-controls">
      <WindowButton testId="window-min" title="Minimize" icon={<Minus className="w-4 h-4" />} onClick={() => void getCurrentWindow().minimize()} />
      <WindowButton testId="window-max" title="Maximize" icon={<Maximize2 className="w-3.5 h-3.5" />} onClick={() => void getCurrentWindow().toggleMaximize()} />
      <WindowButton testId="window-close" danger title="Close" icon={<X className="w-4 h-4" />} onClick={() => void getCurrentWindow().close()} />
    </div>
  );
}

function WindowButton({
  icon,
  title,
  onClick,
  danger,
  testId,
}: {
  icon: React.ReactNode;
  title: string;
  onClick: () => void;
  danger?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      data-testid={testId}
      className="h-full w-10 inline-flex items-center justify-center hover:bg-[var(--moba-hover)]"
      style={danger ? undefined : { color: "var(--moba-text)" }}
      data-danger={danger || undefined}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}
