import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useT } from "../../lib/i18n";

export interface VaultUnlockDialogProps {
  onCancel?: () => void;
  onSubmit: (masterPassword: string) => Promise<void>;
  /** Optional context line shown below the title (e.g. why we're prompting). */
  reason?: string;
  /** When false, the dialog cannot be dismissed without unlocking. */
  cancellable?: boolean;
  /** Override stacking for app-level locks that must sit above all app chrome. */
  zIndex?: number;
}

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

export function VaultUnlockDialog({
  onCancel,
  onSubmit,
  reason,
  cancellable = true,
  zIndex = 50,
}: VaultUnlockDialogProps) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const t = useT();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const valid = pw.length > 0;

  const handleSubmit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(pw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        msg.includes("VAULT_BAD_PASSWORD") ? t("vault.incorrectPassword") : msg,
      );
    } finally {
      setBusy(false);
    }
  };

  const handleBackdropMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    inputRef.current?.focus();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      if (cancellable) onCancel?.();
    } else if (event.key === "Enter") {
      const target = event.target as HTMLElement;
      if (target.tagName !== "BUTTON") {
        event.preventDefault();
        void handleSubmit();
      }
    } else if (event.key === "Tab") {
      const dialog = dialogRef.current;
      if (!dialog) return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((element) => element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!active || !dialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div
      data-testid="vault-unlock-backdrop"
      className="fixed inset-0 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)", zIndex }}
      onMouseDown={handleBackdropMouseDown}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-label={t("vault.unlockTitle")}
        aria-modal="true"
        tabIndex={-1}
        data-testid="vault-unlock-dialog"
        className="w-[420px] max-w-[calc(100vw-24px)] max-h-[calc(100vh-24px)] overflow-y-auto rounded shadow-lg p-4"
        style={{ background: "var(--taomni-bg)", border: "1px solid var(--taomni-card-border)" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="text-sm font-semibold mb-1">{t("vault.unlockTitle")}</div>
        {reason && (
          <div
            className="text-[12px] mb-3"
            style={{ color: "var(--taomni-text-muted)" }}
            data-testid="vault-unlock-reason"
          >
            {reason}
          </div>
        )}

        <label className="block text-[12px] mb-1" style={{ color: "var(--taomni-text-muted)" }}>
          {t("vault.masterPassword")}
        </label>
        <input
          ref={inputRef}
          data-testid="vault-unlock-pw"
          type="password"
          value={pw}
          onChange={(event) => setPw(event.target.value)}
          className="taomni-input w-full"
          autoComplete="current-password"
        />

        {error && (
          <div
            className="mt-2 text-[12px]"
            style={{ color: "var(--taomni-error, #c33)" }}
            data-testid="vault-unlock-error"
          >
            {error}
          </div>
        )}

        <div className="flex gap-2 justify-end mt-4">
          {cancellable && (
            <button
              type="button"
              data-testid="vault-unlock-cancel"
              className="px-3 py-1 text-[12px] rounded hover:bg-[var(--taomni-hover)]"
              onClick={onCancel}
              disabled={busy}
            >
              {t("vault.cancel")}
            </button>
          )}
          <button
            type="button"
            data-testid="vault-unlock-confirm"
            className="px-3 py-1 text-[12px] rounded text-white disabled:opacity-50"
            style={{ background: "var(--taomni-accent)" }}
            onClick={() => void handleSubmit()}
            disabled={!valid || busy}
          >
            {busy ? t("vault.unlocking") : t("vault.unlock")}
          </button>
        </div>
      </div>
    </div>
  );
}
