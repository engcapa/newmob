import { useEffect, useId, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  Settings,
  ShieldAlert,
} from "lucide-react";
import type { LspDiagnostic } from "../../../lib/editor/lsp";
import type { DiagnosticScope } from "./diagnosticScopeModel";
import type { HighlightingLevel } from "./highlightingLevelModel";

interface HighlightingWidgetProps {
  diagnostics: LspDiagnostic[];
  fileKey?: string;
  diagnosticScope?: DiagnosticScope | null;
  diagnosticsReady?: boolean;
  diagnosticsError?: string | null;
  level: HighlightingLevel;
  onChangeLevel: (level: HighlightingLevel) => void;
  providerName?: string | null;
  providerActive?: boolean;
  onNavigateNextError?: () => void;
  onNavigatePrevError?: () => void;
  onOpenSettings?: () => void;
  onRestoreEditorFocus?: () => void;
}

export function HighlightingWidget({
  diagnostics,
  fileKey,
  diagnosticScope,
  diagnosticsReady = true,
  diagnosticsError = null,
  level,
  onChangeLevel,
  providerName,
  providerActive = false,
  onNavigateNextError,
  onNavigatePrevError,
  onOpenSettings,
  onRestoreEditorFocus,
}: HighlightingWidgetProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = `highlighting-widget-menu-${useId().replace(/:/g, "")}`;
  const levelButtonRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Partial<Record<HighlightingLevel, HTMLButtonElement | null>>>({});
  const levels: HighlightingLevel[] = ["all", "syntax", "none"];

  const errors = diagnostics.filter((item) => item.severity === 1).length;
  const warnings = diagnostics.filter((item) => item.severity === 2).length;

  const levelLabel = level === "none" ? "None" : level === "syntax" ? "Syntax" : "All Problems";
  const providerLabel = providerActive && providerName ? providerName : "No active language server";
  const diagnosticsStatus = diagnosticsError
    ? `Diagnostics failed: ${diagnosticsError}`
    : !providerActive
      ? "Diagnostics unavailable without a language server"
      : !diagnosticsReady
        ? "Waiting for diagnostics for the current file"
        : errors || warnings
          ? `${errors} error(s), ${warnings} warning(s)`
          : "No problems found";

  useEffect(() => {
    if (menuOpen) optionRefs.current[level]?.focus();
  }, [level, menuOpen]);

  const selectLevel = (next: HighlightingLevel) => {
    onChangeLevel(next);
    setMenuOpen(false);
    onRestoreEditorFocus?.();
  };

  const moveLevelFocus = (current: HighlightingLevel, offset: number) => {
    const index = levels.indexOf(current);
    const next = levels[(index + offset + levels.length) % levels.length];
    optionRefs.current[next]?.focus();
  };

  return (
    <div
      role="region"
      aria-label="Highlighting level and problems"
      data-testid="code-workspace-highlighting-widget"
      data-file-key={fileKey}
      data-diagnostic-revision={diagnosticScope ? diagnosticScope.revision : undefined}
      data-diagnostic-provider={diagnosticScope?.providerId ?? "none"}
      data-diagnostic-generation={diagnosticScope ? diagnosticScope.providerGeneration : undefined}
      data-diagnostics-ready={diagnosticsReady ? "true" : "false"}
      data-diagnostics-state={diagnosticsError ? "failed" : diagnosticsReady ? "ready" : "pending"}
      className="relative shrink-0 inline-flex items-center gap-1.5 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-1.5 py-0.5 text-[11px] text-[var(--taomni-code-text)]"
    >
      {/* Problems count badge */}
      {diagnosticsReady && errors > 0 ? (
        <span className="inline-flex items-center gap-0.5 font-semibold text-red-400" title={`${errors} error(s)`}>
          <AlertCircle className="h-3 w-3" />
          <span>{errors}</span>
        </span>
      ) : null}

      {diagnosticsReady && warnings > 0 ? (
        <span className="inline-flex items-center gap-0.5 font-semibold text-amber-400" title={`${warnings} warning(s)`}>
          <AlertTriangle className="h-3 w-3" />
          <span>{warnings}</span>
        </span>
      ) : null}

      {diagnosticsReady && errors === 0 && warnings === 0 && (
        <span className="inline-flex items-center gap-0.5 text-emerald-400" title="No problems found">
          <CheckCircle2 className="h-3 w-3" />
        </span>
      )}

      {!diagnosticsReady && providerActive && (
        <span
          className="inline-flex items-center text-[var(--taomni-code-muted)]"
          title={diagnosticsStatus}
          aria-label={diagnosticsStatus}
        >
          <Loader2 className="h-3 w-3 animate-spin" />
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
          disabled={!diagnosticsReady || (errors === 0 && warnings === 0)}
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
          disabled={!diagnosticsReady || (errors === 0 && warnings === 0)}
          className="rounded p-0.5 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-border)] hover:text-[var(--taomni-code-text)] disabled:opacity-40"
        >
          <ChevronDown className="h-3 w-3" />
        </button>
      </div>

      {/* Level selector button */}
      <button
        ref={levelButtonRef}
        type="button"
        aria-label="Highlighting level"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuId}
        data-testid="highlighting-widget-level-button"
        onClick={() => setMenuOpen((open) => !open)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && menuOpen) {
            event.preventDefault();
            setMenuOpen(false);
            return;
          }
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setMenuOpen(true);
          }
        }}
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
            id={menuId}
            role="menu"
            aria-label="Highlighting level options"
            data-testid="highlighting-widget-menu"
            className="absolute right-0 top-full z-50 mt-1 min-w-[200px] rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] p-1.5 shadow-lg text-[11px]"
          >
            <div className="px-2 py-1 font-semibold text-[var(--taomni-code-muted)] uppercase tracking-wider text-[9px]">
              Highlighting Level
            </div>
            {levels.map((lvl) => (
              <button
                key={lvl}
                type="button"
                role="menuitemradio"
                aria-checked={level === lvl}
                data-testid={`highlighting-level-option-${lvl}`}
                ref={(element) => { optionRefs.current[lvl] = element; }}
                onClick={() => selectLevel(lvl)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    moveLevelFocus(lvl, 1);
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    moveLevelFocus(lvl, -1);
                  } else if (event.key === "Home") {
                    event.preventDefault();
                    optionRefs.current[levels[0]]?.focus();
                  } else if (event.key === "End") {
                    event.preventDefault();
                    optionRefs.current[levels[levels.length - 1]]?.focus();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setMenuOpen(false);
                    levelButtonRef.current?.focus();
                  } else if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    selectLevel(lvl);
                  }
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
                <span data-testid="highlighting-widget-provider">Scope: {providerLabel}</span>
              </span>
              <span data-testid="highlighting-widget-diagnostic-status">{diagnosticsStatus}</span>
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
