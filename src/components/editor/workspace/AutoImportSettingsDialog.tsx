import { useEffect, useId, useState } from "react";
import { Import, RotateCcw, Save, X } from "lucide-react";
import {
  DEFAULT_AUTO_IMPORT_SETTINGS,
  type AutoImportSettings,
} from "./autoImportModel";
import {
  loadAutoImportPreferences,
  resetAutoImportPreferences,
  saveAutoImportPreferences,
} from "../../../lib/autoImportPreferences";

export interface AutoImportSettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

export function AutoImportSettingsDialog({ open, onClose }: AutoImportSettingsDialogProps) {
  const [settings, setSettings] = useState<AutoImportSettings>({
    ...DEFAULT_AUTO_IMPORT_SETTINGS,
  });
  const [excludedPackagesText, setExcludedPackagesText] = useState("");
  const [savedNotice, setSavedNotice] = useState(false);
  const titleId = useId();

  useEffect(() => {
    if (open) {
      const prefs = loadAutoImportPreferences();
      setSettings(prefs);
      setExcludedPackagesText(prefs.excludedPackages.join("\n"));
      setSavedNotice(false);
    }
  }, [open]);

  if (!open) return null;

  const handleSave = () => {
    const packages = excludedPackagesText
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    saveAutoImportPreferences({
      ...settings,
      excludedPackages: packages,
    });
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 2000);
  };

  const handleReset = () => {
    const defaults = resetAutoImportPreferences();
    setSettings(defaults);
    setExcludedPackagesText(defaults.excludedPackages.join("\n"));
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 2000);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
      onKeyDown={handleKeyDown}
      data-testid="auto-import-settings-dialog"
    >
      <div className="relative w-full max-w-lg rounded-xl border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] p-6 shadow-2xl text-[var(--taomni-code-text)] flex flex-col gap-4">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--taomni-code-border)] pb-3">
          <div className="flex items-center gap-2">
            <Import className="w-5 h-5 text-[var(--taomni-accent)]" />
            <h2 id={titleId} className="text-base font-semibold">
              Auto Import Settings
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-neutral-800 text-[var(--taomni-code-muted)] hover:text-[var(--taomni-code-text)]"
            title="Close (Escape)"
            data-testid="auto-import-close-button"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Controls */}
        <div className="flex flex-col gap-4 text-xs">
          {/* On-the-fly section */}
          <div className="flex flex-col gap-2 rounded-lg border border-[var(--taomni-code-border)] p-3 bg-neutral-900/30">
            <span className="font-semibold text-[13px] text-neutral-300">Java / On The Fly</span>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={settings.addUnambiguousImportsOnTheFly}
                onChange={(e) =>
                  setSettings((prev) => ({
                    ...prev,
                    addUnambiguousImportsOnTheFly: e.target.checked,
                  }))
                }
                className="rounded border-[var(--taomni-code-border)] bg-neutral-800 text-[var(--taomni-accent)] focus:ring-0"
                data-testid="auto-import-on-the-fly-checkbox"
              />
              <span>Add unambiguous imports on the fly</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={settings.optimizeImportsOnTheFly}
                onChange={(e) =>
                  setSettings((prev) => ({
                    ...prev,
                    optimizeImportsOnTheFly: e.target.checked,
                  }))
                }
                className="rounded border-[var(--taomni-code-border)] bg-neutral-800 text-[var(--taomni-accent)] focus:ring-0"
                data-testid="auto-import-optimize-on-the-fly-checkbox"
              />
              <span>Optimize imports on the fly (for current project or module)</span>
            </label>
          </div>

          {/* Paste section */}
          <div className="flex flex-col gap-2 rounded-lg border border-[var(--taomni-code-border)] p-3 bg-neutral-900/30">
            <span className="font-semibold text-[13px] text-neutral-300">Paste</span>
            <div className="flex items-center justify-between gap-4">
              <label htmlFor="auto-import-paste-mode" className="text-neutral-400">
                Insert imports on paste:
              </label>
              <select
                id="auto-import-paste-mode"
                value={settings.pasteImportMode}
                onChange={(e) =>
                  setSettings((prev) => ({
                    ...prev,
                    pasteImportMode: e.target.value as "all" | "ask" | "none",
                  }))
                }
                className="rounded border border-[var(--taomni-code-border)] bg-neutral-800 px-2 py-1 text-xs text-neutral-200 focus:outline-hidden"
                data-testid="auto-import-paste-mode-select"
              >
                <option value="all">All</option>
                <option value="ask">Ask</option>
                <option value="none">None</option>
              </select>
            </div>
            <p className="text-[11px] text-[var(--taomni-code-muted)]">
              {settings.pasteImportMode === "all"
                ? "Unambiguous imports will be inserted automatically with the paste."
                : settings.pasteImportMode === "ask"
                ? "Prompt when candidates or unresolved symbols are detected in pasted code."
                : "No imports will be inserted during paste."}
            </p>
          </div>

          {/* Excluded packages section */}
          <div className="flex flex-col gap-1.5">
            <label className="font-semibold text-neutral-300">
              Exclude from import and completion:
            </label>
            <textarea
              rows={3}
              value={excludedPackagesText}
              onChange={(e) => setExcludedPackagesText(e.target.value)}
              placeholder="e.g. com.sun.*, sun.*, jdk.internal.*"
              className="w-full rounded-md border border-[var(--taomni-code-border)] bg-neutral-900 p-2 font-mono text-xs text-neutral-200 focus:outline-hidden focus:border-[var(--taomni-accent)] resize-none"
              data-testid="auto-import-excluded-packages-input"
            />
            <span className="text-[11px] text-[var(--taomni-code-muted)]">
              Packages matching wildcards (e.g. <code>sun.*</code>) will never be auto-imported.
            </span>
          </div>
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-between pt-2 border-t border-[var(--taomni-code-border)]">
          <button
            type="button"
            onClick={handleReset}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-[var(--taomni-code-muted)] hover:text-neutral-200 hover:bg-neutral-800 rounded transition-colors"
            data-testid="auto-import-reset-button"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset Defaults
          </button>

          <div className="flex items-center gap-2">
            {savedNotice && (
              <span className="text-xs text-emerald-400">Settings saved!</span>
            )}
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs border border-[var(--taomni-code-border)] text-neutral-300 hover:bg-neutral-800 rounded transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[var(--taomni-accent)] text-black font-medium hover:brightness-110 rounded transition-colors"
              data-testid="auto-import-save-button"
            >
              <Save className="w-3.5 h-3.5" />
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
