import { useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";

export interface ExternalVaultUnlockDialogProps {
  /** Source tool name, e.g. "Tabby". Drives the dialog title. */
  toolName: string;
  /** Optional title override for tools that do not call this a vault unlock. */
  title?: string;
  /** Body copy shown above the password field. */
  description: string;
  /** Optional password-label override, e.g. "SecureCRT passphrase". */
  passwordLabel?: string;
  /** Resolves on success; throw to display an error and stay open. */
  onSubmit: (masterPassword: string) => Promise<void>;
  onSkip: () => void;
  /** Optional message rendered after a failed attempt (e.g. "Incorrect password"). */
  errorMessage?: string | null;
}

/**
 * Generic, prop-driven master-password prompt for unlocking a third-party
 * tool's encrypted secret vault during session import. Distinct from
 * `VaultUnlockDialog` (which unlocks Taomni's own vault) so users can tell
 * the two prompts apart.
 */
export function ExternalVaultUnlockDialog({
  toolName,
  title,
  description,
  passwordLabel,
  onSubmit,
  onSkip,
  errorMessage,
}: ExternalVaultUnlockDialogProps) {
  const t = useT();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (errorMessage) setLocalError(errorMessage);
  }, [errorMessage]);

  const valid = pw.length > 0;

  const handleSubmit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setLocalError(null);
    try {
      await onSubmit(pw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLocalError(msg);
    } finally {
      setBusy(false);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onSkip();
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
      onClick={onSkip}
      onKeyDown={handleKeyDown}
    >
      <div
        role="dialog"
        aria-label={t("externalVault.ariaLabel", { tool: toolName })}
        aria-modal="true"
        data-testid="external-vault-unlock-dialog"
        className="w-[460px] max-w-[calc(100vw-24px)] max-h-[calc(100vh-24px)] overflow-y-auto rounded shadow-lg p-4"
        style={{
          background: "var(--taomni-bg)",
          border: "1px solid var(--taomni-card-border)",
          borderLeft: "3px solid var(--taomni-accent)",
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="text-sm font-semibold mb-1">{title ?? t("externalVault.title", { tool: toolName })}</div>
        <div
          className="text-[12px] mb-3"
          style={{ color: "var(--taomni-text-muted)" }}
          data-testid="external-vault-unlock-description"
        >
          {description}
        </div>

        <label className="block text-[12px] mb-1" style={{ color: "var(--taomni-text-muted)" }}>
          {passwordLabel ?? t("externalVault.masterPasswordLabel", { tool: toolName })}
        </label>
        <input
          ref={inputRef}
          data-testid="external-vault-unlock-pw"
          type="password"
          value={pw}
          onChange={(event) => setPw(event.target.value)}
          className="taomni-input w-full"
          autoComplete="off"
        />

        {localError && (
          <div
            className="mt-2 text-[12px]"
            style={{ color: "var(--taomni-error, #c33)" }}
            data-testid="external-vault-unlock-error"
          >
            {localError}
          </div>
        )}

        <div className="flex gap-2 justify-end mt-4">
          <button
            type="button"
            data-testid="external-vault-unlock-skip"
            className="px-3 py-1 text-[12px] rounded hover:bg-[var(--taomni-hover)]"
            onClick={onSkip}
            disabled={busy}
          >
            {t("externalVault.skip")}
          </button>
          <button
            type="button"
            data-testid="external-vault-unlock-confirm"
            className="px-3 py-1 text-[12px] rounded text-white disabled:opacity-50"
            style={{ background: "var(--taomni-accent)" }}
            onClick={() => void handleSubmit()}
            disabled={!valid || busy}
          >
            {busy ? t("externalVault.unlocking") : t("externalVault.unlock")}
          </button>
        </div>
      </div>
    </div>
  );
}
