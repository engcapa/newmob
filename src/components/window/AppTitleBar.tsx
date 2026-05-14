import { getCurrentWindow } from "@tauri-apps/api/window";
import { WindowControls } from "./WindowControls";
import { TitleBarTrayControls } from "./TitleBarTrayControls";

export function AppTitleBar() {
  const startDrag = (event: React.MouseEvent) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button")) return;
    void getCurrentWindow().startDragging().catch(() => {});
  };

  const toggleMaximize = (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest("button")) return;
    void getCurrentWindow().toggleMaximize().catch(() => {});
  };

  return (
    <div
      data-testid="app-titlebar"
      className="moba-app-titlebar h-7 flex items-center min-w-0"
      onMouseDown={startDrag}
      onDoubleClick={toggleMaximize}
    >
      <div className="w-28 shrink-0" />
      <div className="flex-1 text-center text-[12px] font-semibold truncate">NewMob</div>
      <TitleBarTrayControls />
      <WindowControls />
    </div>
  );
}
