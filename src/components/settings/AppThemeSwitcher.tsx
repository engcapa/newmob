import { Monitor, Moon, Sun } from "lucide-react";
import { appThemeModeLabel, useAppTheme, type AppThemeMode } from "../../lib/appTheme";

const THEME_MODES: Array<{ mode: AppThemeMode; icon: React.ReactNode }> = [
  { mode: "light", icon: <Sun className="w-4 h-4" /> },
  { mode: "dark", icon: <Moon className="w-4 h-4" /> },
  { mode: "system", icon: <Monitor className="w-4 h-4" /> },
];

export function AppThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const { mode, resolvedTheme, setMode } = useAppTheme();

  if (compact) {
    return (
      <label className="inline-flex items-center gap-1.5 text-[11px]">
        <span className="text-[var(--moba-text-muted)]">Theme</span>
        <select
          className="moba-input h-6 w-[122px]"
          aria-label="Application theme"
          value={mode}
          title={`Current appearance: ${appThemeModeLabel(mode)} (${resolvedTheme})`}
          onChange={(event) => setMode(event.target.value as AppThemeMode)}
        >
          {THEME_MODES.map((item) => (
            <option key={item.mode} value={item.mode}>
              {appThemeModeLabel(item.mode)}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <div className="inline-flex rounded-md border border-[var(--moba-input-border)] overflow-hidden">
      {THEME_MODES.map((item) => (
        <ThemeModeButton
          key={item.mode}
          mode={item.mode}
          currentMode={mode}
          onSelect={setMode}
          icon={item.icon}
        />
      ))}
    </div>
  );
}

export function AppThemeIconButton() {
  const { mode, resolvedTheme, setMode } = useAppTheme();
  const currentIndex = THEME_MODES.findIndex((item) => item.mode === mode);
  const current = THEME_MODES[currentIndex] ?? THEME_MODES[0];
  const next = THEME_MODES[(currentIndex + 1) % THEME_MODES.length] ?? THEME_MODES[0];

  return (
    <button
      type="button"
      className="h-6 px-2 inline-flex items-center gap-1.5 rounded border text-[11px] hover:bg-[var(--moba-control-hover)]"
      style={{
        borderColor: "var(--moba-input-border)",
        background: "var(--moba-input-bg)",
        color: "var(--moba-text)",
      }}
      title={`Theme: ${appThemeModeLabel(mode)} (${resolvedTheme}). Click for ${appThemeModeLabel(next.mode)}.`}
      aria-label="Cycle application theme"
      onClick={() => setMode(next.mode)}
    >
      {current.icon}
      <span>{appThemeModeLabel(mode)}</span>
    </button>
  );
}

function ThemeModeButton({
  mode,
  currentMode,
  onSelect,
  icon,
}: {
  mode: AppThemeMode;
  currentMode: AppThemeMode;
  onSelect: (mode: AppThemeMode) => void;
  icon: React.ReactNode;
}) {
  const selected = mode === currentMode;

  return (
    <button
      data-testid={`app-theme-${mode}`}
      type="button"
      aria-pressed={selected}
      className="h-9 px-3 inline-flex items-center gap-2 text-[12px] border-r last:border-r-0 border-[var(--moba-input-border)]"
      style={{
        background: selected ? "var(--moba-selected)" : "var(--moba-input-bg)",
        color: selected ? "var(--moba-accent)" : "var(--moba-text)",
        fontWeight: selected ? 600 : 400,
      }}
      onClick={() => onSelect(mode)}
    >
      {icon}
      {appThemeModeLabel(mode)}
    </button>
  );
}
