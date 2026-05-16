import { Monitor, Moon, Sun, PanelTopClose, PanelTopOpen } from "lucide-react";
import { appThemeModeLabel, useAppTheme, type AppThemeMode } from "../../lib/appTheme";
import { useAppStore } from "../../stores/appStore";

const THEME_MODES: Array<{ mode: AppThemeMode; icon: React.ReactNode }> = [
  { mode: "light", icon: <Sun className="w-3.5 h-3.5" /> },
  { mode: "dark", icon: <Moon className="w-3.5 h-3.5" /> },
  { mode: "system", icon: <Monitor className="w-3.5 h-3.5" /> },
];

export function TitleBarTrayControls() {
  const { mode, resolvedTheme, setMode } = useAppTheme();
  const compactMode = useAppStore((s) => s.compactMode);
  const toggleCompactMode = useAppStore((s) => s.toggleCompactMode);

  const currentIndex = THEME_MODES.findIndex((item) => item.mode === mode);
  const current = THEME_MODES[currentIndex] ?? THEME_MODES[0];
  const next = THEME_MODES[(currentIndex + 1) % THEME_MODES.length] ?? THEME_MODES[0];

  return (
    <div className="moba-titlebar-tray flex items-stretch self-stretch shrink-0" data-testid="titlebar-tray">
      <TrayButton
        testId="theme-cycle"
        title={`Theme: ${appThemeModeLabel(mode)} (${resolvedTheme}). Click for ${appThemeModeLabel(next.mode)}.`}
        ariaLabel="Cycle application theme"
        onClick={() => setMode(next.mode)}
      >
        {current.icon}
      </TrayButton>
      <TrayButton
        testId="compact-toggle"
        title={compactMode ? "Exit compact mode" : "Enter compact mode"}
        ariaLabel={compactMode ? "Exit compact mode" : "Enter compact mode"}
        active={compactMode}
        onClick={toggleCompactMode}
      >
        {compactMode ? <PanelTopOpen className="w-3.5 h-3.5" /> : <PanelTopClose className="w-3.5 h-3.5" />}
      </TrayButton>
    </div>
  );
}

function TrayButton({
  children,
  title,
  ariaLabel,
  onClick,
  active,
  testId,
}: {
  children: React.ReactNode;
  title: string;
  ariaLabel: string;
  onClick: () => void;
  active?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel}
      data-testid={testId}
      data-active={active || undefined}
      className="moba-titlebar-tray-btn h-full w-10 inline-flex items-center justify-center hover:bg-[var(--moba-hover)]"
      style={{ color: "var(--moba-text)" }}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
