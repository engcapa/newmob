import { useState } from "react";
import { DEFAULT_SCOPE_SELECTION, usagesScopeOptions, type UsagesScopeSelection } from "./usageQuerySession";

interface UsagesScopeDialogProps {
  open: boolean;
  symbolHint: string | null;
  onConfirm: (selection: UsagesScopeSelection) => void;
  onCancel: () => void;
}

/**
 * §8.20.5 Find Usages scope dialog. Toggles over ONE document-scope LSP
 * response — every bucket is honest client-side scoping, and the dialog says
 * so instead of implying provider-side scope parameters.
 */
export function UsagesScopeDialog({ open, symbolHint, onConfirm, onCancel }: UsagesScopeDialogProps) {
  const [selection, setSelection] = useState<UsagesScopeSelection>({ ...DEFAULT_SCOPE_SELECTION });
  if (!open) return null;
  const options = usagesScopeOptions(selection);
  return (
    <div
      data-testid="usages-scope-dialog"
      role="dialog"
      aria-label="Find Usages scope"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onCancel}
    >
      <div
        className="w-[380px] rounded-md border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] p-3 text-[12px] shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-1 font-medium text-[var(--taomni-code-text)]">Find Usages</div>
        <div className="mb-2 truncate text-[10px] text-[var(--taomni-code-muted)]">
          {symbolHint ? `Symbol: ${symbolHint}` : "Scope the usages request"}
        </div>
        <div className="space-y-1 rounded border border-[var(--taomni-code-border)] p-2">
          {options.map((option) => (
            <label key={option.id} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                data-testid={`usages-scope-${option.id}`}
                checked={option.checked}
                disabled={option.disabled}
                onChange={() => setSelection((current) => option.toggle(current))}
                className="align-middle"
              />
              {option.label}
            </label>
          ))}
        </div>
        <div className="mt-1 text-[10px] text-[var(--taomni-code-muted)]">
          References are requested from the language server with project scope (provider-requested); sub-scopes are client-post-filtered.
        </div>
        <div className="mt-2 flex justify-end gap-1">
          <button
            type="button"
            data-testid="usages-scope-cancel"
            className="h-7 rounded px-2 text-[11px] hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="usages-scope-confirm"
            className="h-7 rounded px-2 text-[11px]"
            style={{ background: "var(--taomni-accent)", color: "#fff" }}
            onClick={() => onConfirm(selection)}
          >
            Find Usages
          </button>
        </div>
      </div>
    </div>
  );
}
