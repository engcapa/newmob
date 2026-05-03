import {
  Monitor,
  Wifi,
  KeyRound,
  Eye,
  Moon,
  Sun,
} from "lucide-react";
import { useEffect, useState } from "react";
import { appThemeModeLabel, useAppTheme } from "../../lib/appTheme";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";

export function StatusBar() {
  const { tabs, activeTabId, xServerEnabled, statusMessage } = useAppStore();
  const { sessions, selectedSessionId } = useSessionStore();
  const { mode, resolvedTheme } = useAppTheme();
  const [online, setOnline] = useState(navigator.onLine);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const selected = sessions.find((session) => session.id === selectedSessionId);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  return (
    <div data-testid="status-bar" className="moba-status h-6 flex items-center px-2 gap-3">
      <span className="flex items-center gap-1">
        <Eye className="w-3 h-3" /> {sessions.length} sessions • {selected ? selected.name : "none selected"}
      </span>
      <span className="moba-divider-v h-3" />
      <span className="flex items-center gap-1">
        <Wifi className={`w-3 h-3 ${online ? "text-emerald-600" : "text-red-600"}`} /> {online ? "Network online" : "Network offline"}
      </span>
      <span className="flex items-center gap-1">
        <Monitor className={`w-3 h-3 ${xServerEnabled ? "text-emerald-600" : "text-slate-500"}`} /> X11: {xServerEnabled ? "127.0.0.1:0.0" : "off"}
      </span>
      <span className="flex items-center gap-1">
        <KeyRound className="w-3 h-3 text-slate-500" /> auth: password/key prompt
      </span>
      <div className="flex-1" />
      <span className="truncate max-w-[260px]">{statusMessage}</span>
      <span className="moba-divider-v h-3" />
      <span className="flex items-center gap-1">
        {resolvedTheme === "dark" ? <Moon className="w-3 h-3" /> : <Sun className="w-3 h-3" />}
        Theme: {appThemeModeLabel(mode)}
      </span>
      <span className="moba-divider-v h-3" />
      <span className="moba-mono">{activeTab?.type ?? "none"} • {tabs.filter((tab) => tab.type === "terminal").length} terminals</span>
      <span className="moba-divider-v h-3" />
      <span>v0.1.0 • MVP</span>
    </div>
  );
}
