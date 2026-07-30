import { useEffect, useState } from "react";
import { KeyRound, X } from "lucide-react";
import { useVaultStore } from "../../stores/vaultStore";
import { useT } from "../../lib/i18n";

interface AuthPromptProps {
  host: string;
  username: string;
  onSubmit: (password: string, saveToVault: boolean) => void;
  onCancel: () => void;
}

export function AuthPrompt({ host, username, onSubmit, onCancel }: AuthPromptProps) {
  const [password, setPassword] = useState("");
  const [save, setSave] = useState(false);
  const vaultState = useVaultStore((s) => s.state);
  const refreshVault = useVaultStore((s) => s.refresh);
  const t = useT();

  useEffect(() => {
    void refreshVault().catch(() => undefined);
  }, [refreshVault]);

  // If the vault was uninitialized when we mounted but the user set it up
  // mid-prompt (e.g. via another window), `save` stays disabled until they
  // toggle the checkbox; that's fine — keeping behavior minimal.

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    onSubmit(password, save);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(20,30,45,0.4)" }}>
      <form
        data-testid="auth-prompt"
        onSubmit={handleSubmit}
        className="w-[400px] max-w-[calc(100vw-24px)] max-h-[calc(100vh-24px)] flex flex-col rounded-md shadow-2xl border overflow-hidden"
        style={{ background: "var(--taomni-panel-bg)", borderColor: "var(--taomni-chrome-border)", color: "var(--taomni-text)" }}
      >
        <div className="h-8 flex shrink-0 items-center px-3"
             style={{ background: "linear-gradient(to bottom, #5895c8, #2b5d8b)", color: "white" }}>
          <KeyRound className="w-3.5 h-3.5 mr-1.5" />
          <span className="text-[12px] font-semibold">{t("authPrompt.titleRequired")}</span>
          <div className="flex-1" />
          <button data-testid="auth-close" type="button" onClick={onCancel} aria-label={t("authPrompt.closeAria")} className="hover:bg-white/20 rounded p-0.5">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="min-h-0 overflow-y-auto p-4">
          <div className="text-[12px] mb-3 text-[var(--taomni-text-muted)]">
            {t("authPrompt.subtitle", { user: username, host })}
          </div>
          <input
            data-testid="auth-password"
            aria-label={t("authPrompt.sshPasswordAria")}
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="taomni-input w-full h-8 text-[13px]"
            placeholder={t("authPrompt.password")}
          />
          <label
            className="flex items-center gap-1.5 mt-3 text-[11px] cursor-pointer"
            title={
              vaultState === "empty"
                ? t("authPrompt.saveTooltipSetup")
                : t("authPrompt.saveTooltipDefault")
            }
          >
            <input
              type="checkbox"
              data-testid="auth-save-to-vault"
              className="taomni-checkbox"
              checked={save}
              onChange={(e) => setSave(e.target.checked)}
            />
            <span style={{ color: "var(--taomni-text-muted)" }}>
              {t("authPrompt.saveToVault")}
            </span>
          </label>
        </div>

        <div className="min-h-12 flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-3 py-2"
             style={{ background: "var(--taomni-quick-bg)", borderColor: "var(--taomni-divider)" }}>
          <button data-testid="auth-cancel" type="button" onClick={onCancel}
                  className="taomni-btn">
            {t("authPrompt.cancel")}
          </button>
          <button type="submit"
                  data-testid="auth-submit"
                  className="taomni-btn font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={!password}
                  data-primary="true">
            {t("authPrompt.submit")}
          </button>
        </div>
      </form>
    </div>
  );
}
