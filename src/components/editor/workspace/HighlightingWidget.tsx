import { useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Settings,
  ShieldAlert,
} from "lucide-react";
import type { LspDiagnostic } from "../../../lib/editor/lsp";
import type { HighlightingLevel } from "./highlightingLevelModel";

interface HighlightingWidgetProps {
  diagnostics: LspDiagnostic[];
  level: HighlightingLevel;
  onChangeLevel: (level: HighlightingLevel) => void;
  providerName?: string | null;
  providerActive?: boolean;
  onNavigateNextError?: () => void;
  onNavigatePrevError?: () => void;
  onOpenSettings?: () => void;
}

export function HighlightingWidget({
  diagnostics,
  level,
  onChangeLevel,
  providerName,
  providerActive = false,
  onNavigateNextError,
  onNavigatePrevError,
  onOpenSettings,
}: HighlightingWidgetProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  const errors = diagnostics.filter((item) => item.severity === 1).length;
  const warnings = diagnostics.filter((item) => item.severity === 2).length;

  const levelLabel = level === "none" ? "None" : level === "syntax" ? "Syntax" : "All Problems";

  return (
    <div
      role="region"
      aria-label="Highlighting level and problems"
      data-testid="code-workspace-highlighting-widget"
      className="relative shrink-0 inline-flex items-center gap-1.5 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-1.5 py-0.5 text-[11px] text-[var(--taomni-code-text)]"
    >
      {/* Problems count badge */}
      {errors > 0 ? (
        <span className="inline-flex items-center gap-0.5 font-semibold text-red-400" title={`${errors} error(s)`}>
          <AlertCircle className="h-3 w-3" />
          <span>{errors}</span>
        </span>
      ) : null}

      {warnings > 0 ? (
        <span className="inline-flex items-center gap-0.5 font-semibold text-amber-400" title={`${warnings} warning(s)`}>
          <AlertTriangle className="h-3 w-3" />
          <span>{warnings}</span>
        </span>
      ) : null}

      {errors === 0 && warnings === 0 && (
        <span className="inline-flex items-center gap-0.5 text-emerald-400" title="No problems found">
          <CheckCircle2 className="h-3 w-3" />
        </span>
      )}

      {/* Up/down error jump buttons */}
      <div className="flex items-center">
        <button
          type="button"
          aria-label="Previous Error (Shift+F2)"
          title="Previous Error (Shift+F2)"
          data-testid="highlighting-widget-prev-error"
          onClick={onNavigatePrevError}
          disabled={errors === 0 && warnings === 0}
          className="rounded p-0.5 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-border)] hover:text-[var(--taomni-code-text)] disabled:opacity-40"
        >
          <ChevronUp className="h-3 w-3" />
        </button>
        <button
          type="button"
          aria-label="Next Error (F2)"
          title="Next Error (F2)"
          data-testid="highlighting-widget-next-error"
          onClick={onNavigateNextError}
          disabled={errors === 0 && warnings === 0}
          className="rounded p-0.5 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-border)] hover:text-[var(--taomni-code-text)] disabled:opacity-40"
        >
          <ChevronDown className="h-3 w-3" />
        </button>
      </div>

      {/* Level selector button */}
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-testid="highlighting-widget-level-button"
        onClick={() => setMenuOpen((open) => !open)}
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium hover:bg-[var(--taomni-code-border)]"
      >
        <ShieldAlert className="h-3 w-3 text-[var(--taomni-accent)]" />
        <span>{levelLabel}</span>
      </button>

      {/* Dropdown menu */}
      {menuOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setMenuOpen(false)}
          />
          <div
            data-testid="highlighting-widget-menu"
            className="absolute right-0 top-full z-50 mt-1 min-w-[200px] rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] p-1.5 shadow-lg text-[11px]"
          >
            <div className="px-2 py-1 font-semibold text-[var(--taomni-code-muted)] uppercase tracking-wider text-[9px]">
              Highlighting Level
            </div>
            {(["all", "syntax", "none"] as HighlightingLevel[]).map((lvl) => (
              <button
                key={lvl}
                type="button"
                data-testid={`highlighting-level-option-${lvl}`}
                onClick={() => {
                  onChangeLevel(lvl);
                  setMenuOpen(false);
                }}
                className={`flex w-full items-center justify-between rounded px-2 py-1 text-left ${
                  level === lvl
                    ? "bg-[var(--taomni-selected)] text-[var(--taomni-accent)] font-semibold"
                    : "hover:bg-[var(--taomni-code-active-line-bg)] text-[var(--taomni-code-text)]"
                }`}
              >
                <span>{lvl === "all" ? "All Problems" : lvl === "syntax" ? "Syntax" : "None"}</span>
                {level === lvl && <CheckCircle2 className="h-3 w-3 text-[var(--taomni-accent)]" />}
              </button>
            ))}

            <div className="my-1 border-t border-[var(--taomni-code-border)]" />

            <div className="px-2 py-1 text-[10px] text-[var(--taomni-code-muted)]">
              <span className="block font-medium text-[var(--taomni-code-text)]">
                Scope: {providerActive && providerName ? providerName : "No active language server"}
              </span>
              <span>{providerActive ? "Inspections from server" : "Local syntax parser"}</span>
            </div>

            {onOpenSettings && (
              <button
                type="button"
                data-testid="highlighting-widget-open-settings"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenSettings();
                }}
                className="mt-1 flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[var(--taomni-code-text)] hover:bg-[var(--taomni-code-active-line-bg)]"
              >
                <Settings className="h-3 w-3" />
                <span>Configure Inspections…</span>
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
