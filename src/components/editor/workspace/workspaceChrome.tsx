import type { ReactNode } from "react";
import { useT } from "../../../lib/i18n";
import type { LspDiagnostic } from "../../../lib/editor/lsp";
import type { LspFileState } from "./codeWorkspaceModel";

/**
 * True when the user should open Language Server settings.
 * Missing binary / config only — not "available but still starting", and not
 * a pure install-hint while the server is already on PATH.
 */
export function lspNeedsSetup(state: LspFileState | null): boolean {
  if (!state?.status || state.syncing) return false;
  if (state.error) return true;
  const status = state.status;
  if (status.active) return false;
  // Prefer install/settings only when the binary is missing, or a real error
  // (e.g. custom command path wrong) needs attention.
  if (!status.available) return true;
  return !!status.error;
}

export function LspStatusPill({
  state,
  diagnostics,
  onOpenSettings,
}: {
  state: LspFileState | null;
  diagnostics: LspDiagnostic[];
  onOpenSettings?: () => void;
}) {
  const t = useT();
  if (!state?.status) {
    return (
      <span className="shrink-0 text-[10px] font-medium text-[var(--taomni-code-text)]/75">
        LSP idle
      </span>
    );
  }
  const status = state.status;
  const errors = diagnostics.filter((item) => item.severity === 1).length;
  const warnings = diagnostics.filter((item) => item.severity === 2).length;
  const runtimeError = status.error ?? state.error;
  const name = status.displayName ?? "LSP";
  // "starting…" only while a sync/open is in flight. A silent available+!active
  // after the process exits used to look stuck forever on "Java starting…".
  const label = status.active
    ? `${name}${errors || warnings ? ` · ${errors}E ${warnings}W` : ""}`
    : runtimeError
      ? runtimeError
      : !status.available && status.installHint
        ? `Install: ${status.installHint}`
        : !status.available
          ? "No LSP"
          : state.syncing
            ? `${name} starting…`
            : `${name} inactive`;
  const showSettingsLink = lspNeedsSetup(state) && !!onOpenSettings;
  const settingsLabel = t("settings.languageServersOpenSettings");
  const title = showSettingsLink ? `${label} · ${settingsLabel}` : label;
  // Use primary code text (not muted) so names like "Java" stay legible on the
  // light editor chrome. App theming is data-app-theme, not Tailwind `dark:`.
  return (
    <span
      title={title}
      data-testid="code-workspace-lsp-status-pill"
      data-active={status.active || undefined}
      data-error={!!state.error || (!status.active && !!status.error) || undefined}
      className="max-w-[50%] shrink-0 inline-flex min-w-0 items-center gap-1 rounded border border-[var(--taomni-code-border)] px-1.5 py-0.5 text-[11px] font-medium bg-[var(--taomni-code-bg)] text-[var(--taomni-code-text)] data-[active=true]:border-[var(--taomni-selected-border)] data-[active=true]:bg-[var(--taomni-selected)] data-[active=true]:font-semibold data-[active=true]:text-[var(--taomni-accent)] data-[error=true]:border-amber-500/50 data-[error=true]:text-amber-700 dark:data-[error=true]:text-amber-400"
    >
      <span className="min-w-0 truncate">{label}</span>
      {showSettingsLink && (
        <button
          type="button"
          data-testid="code-workspace-lsp-open-settings"
          title={settingsLabel}
          className="shrink-0 underline decoration-dotted underline-offset-2 text-[var(--taomni-code-text)] hover:text-[var(--taomni-accent)]"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onOpenSettings?.();
          }}
        >
          {settingsLabel}
        </button>
      )}
    </span>
  );
}

export function IconButton({
  label,
  icon,
  disabled,
  testId,
  active,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  testId?: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      data-testid={testId}
      data-active={active || undefined}
      disabled={disabled}
      className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-code-active-line-bg)] data-[active=true]:bg-[var(--taomni-code-selection-match-bg)] data-[active=true]:text-[var(--taomni-accent)] disabled:opacity-40 disabled:cursor-default"
      onClick={onClick}
    >
      {icon}
    </button>
  );
}


