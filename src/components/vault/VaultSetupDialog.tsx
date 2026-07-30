import { useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";

export interface VaultSetupDialogProps {
  onCancel: () => void;
  onSubmit: (masterPassword: string) => Promise<void>;
}

export function VaultSetupDialog({ onCancel, onSubmit }: VaultSetupDialogProps) {
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const t = useT();

  const tooShort = pw1.length > 0 && pw1.length < 8;
  const mismatch = pw2.length > 0 && pw1 !== pw2;
  const valid = pw1.length >= 8 && pw1 === pw2;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(pw1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCancel();
    } else if (event.key === "Enter") {
      const target = event.target as HTMLElement;
      if (target.tagName !== "BUTTON") {
        event.preventDefault();
        void handleSubmit();
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={onCancel}
      onKeyDown={handleKeyDown}
    >
      <div
        role="dialog"
        aria-label={t("vault.setupTitleSet")}
        aria-modal="true"
        data-testid="vault-setup-dialog"
        className="w-[440px] max-w-[calc(100vw-24px)] max-h-[calc(100vh-24px)] overflow-y-auto rounded shadow-lg p-4"
        style={{ background: "var(--taomni-bg)", border: "1px solid var(--taomni-card-border)" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="text-sm font-semibold mb-1">{t("vault.setupTitleSet")}</div>
        <div className="text-[12px] mb-3" style={{ color: "var(--taomni-text-muted)" }}>
          {t("vault.setupDescription")}
        </div>

        <label className="block text-[12px] mb-1" style={{ color: "var(--taomni-text-muted)" }}>
          {t("vault.masterPasswordHint")}
        </label>
        <input
          ref={inputRef}
          data-testid="vault-setup-pw1"
          type="password"
          value={pw1}
          onChange={(event) => setPw1(event.target.value)}
          className="taomni-input w-full mb-2"
          autoComplete="new-password"
          aria-invalid={tooShort ? true : undefined}
        />

        <label className="block text-[12px] mb-1" style={{ color: "var(--taomni-text-muted)" }}>
          {t("vault.confirmLabel")}
        </label>
        <input
          data-testid="vault-setup-pw2"
          type="password"
          value={pw2}
          onChange={(event) => setPw2(event.target.value)}
          className="taomni-input w-full"
          autoComplete="new-password"
          aria-invalid={mismatch ? true : undefined}
        />

        {tooShort && (
          <div
            className="mt-2 text-[12px]"
            style={{ color: "var(--taomni-error, #c33)" }}
            data-testid="vault-setup-too-short"
          >
            {t("vault.tooShort")}
          </div>
        )}
        {mismatch && (
          <div
            className="mt-2 text-[12px]"
            style={{ color: "var(--taomni-error, #c33)" }}
            data-testid="vault-setup-mismatch"
          >
            {t("vault.mismatchLong")}
          </div>
        )}
        {error && (
          <div
            className="mt-2 text-[12px]"
            style={{ color: "var(--taomni-error, #c33)" }}
            data-testid="vault-setup-error"
          >
            {error}
          </div>
        )}

        <div className="flex gap-2 justify-end mt-4">
          <button
            type="button"
            data-testid="vault-setup-cancel"
            className="px-3 py-1 text-[12px] rounded hover:bg-[var(--taomni-hover)]"
            onClick={onCancel}
            disabled={busy}
          >
            {t("vault.cancel")}
          </button>
          <button
            type="button"
            data-testid="vault-setup-confirm"
            className="px-3 py-1 text-[12px] rounded text-white disabled:opacity-50"
            style={{ background: "var(--taomni-accent)" }}
            onClick={() => void handleSubmit()}
            disabled={!valid || busy}
          >
            {busy ? t("vault.settingUp") : t("vault.createVault")}
          </button>
        </div>
      </div>
    </div>
  );
}
