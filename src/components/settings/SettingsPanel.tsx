import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { appThemeModeLabel, useAppTheme } from "../../lib/appTheme";
import {
  DEFAULT_TERMINAL_PROFILE,
  loadGlobalTerminalProfile,
  saveGlobalTerminalProfile,
  type TerminalProfile,
} from "../../lib/terminalProfile";
import { TerminalAppearanceSettings } from "../terminal/TerminalAppearanceSettings";
import { AppThemeSwitcher } from "./AppThemeSwitcher";

export function SettingsPanel() {
  const [profile, setProfile] = useState<TerminalProfile>(() => loadGlobalTerminalProfile());
  const { mode, resolvedTheme } = useAppTheme();

  useEffect(() => {
    saveGlobalTerminalProfile(profile);
  }, [profile]);

  return (
    <div
      data-testid="settings-panel"
      className="h-full overflow-auto"
      style={{ background: "var(--moba-bg)", color: "var(--moba-text)" }}
    >
      <div className="mx-auto max-w-5xl p-5">
        <div className="mb-4">
          <div className="text-[18px] font-semibold">Settings</div>
          <div className="text-[12px] text-[var(--moba-text-muted)]">
            Application appearance and terminal defaults
          </div>
        </div>

        <section className="mb-5 rounded-md border border-[var(--moba-divider)] bg-[var(--moba-panel-bg)] p-3">
          <div className="mb-2 flex items-center gap-3">
            <div>
              <div className="text-[14px] font-semibold">Application Theme</div>
              <div className="text-[12px] text-[var(--moba-text-muted)]">
                Current appearance: {appThemeModeLabel(mode)} ({resolvedTheme})
              </div>
            </div>
          </div>
          <AppThemeSwitcher />
        </section>

        <div className="mb-4 flex items-center gap-3">
          <div>
            <div className="text-[18px] font-semibold">Terminal Appearance</div>
            <div className="text-[12px] text-[var(--moba-text-muted)]">Font and theme defaults</div>
          </div>
          <button
            className="moba-btn ml-auto h-8 inline-flex items-center gap-1.5"
            type="button"
            onClick={() => setProfile(DEFAULT_TERMINAL_PROFILE)}
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset
          </button>
        </div>
        <TerminalAppearanceSettings profile={profile} onProfileChange={setProfile} showCustomColors />
      </div>
    </div>
  );
}
