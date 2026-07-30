import { useEffect, useRef, useState } from "react";
import { ShieldAlert, X } from "lucide-react";
import { useT } from "../../lib/i18n";

interface SocksCapRootPromptProps {
  onSubmit: (password: string) => void | Promise<void>;
  onCancel: () => void;
  error?: string | null;
  busy?: boolean;
  /** Why elevation is needed; defaults to the Linux nftables explanation. */
  subtitle?: string;
}

export function SocksCapRootPrompt({
  onSubmit,
  onCancel,
  error,
  busy,
  subtitle,
}: SocksCapRootPromptProps) {
  const [password, setPassword] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const t = useT();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    void onSubmit(password);
  };

  return (
    <div
      data-testid="sockscap-root-prompt-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(20,30,45,0.4)" }}
    >
      <form
        data-testid="sockscap-root-prompt-dialog"
        onSubmit={handleSubmit}
        className="w-[420px] max-w-[calc(100vw-24px)] max-h-[calc(100vh-24px)] flex flex-col rounded-md shadow-2xl border overflow-hidden"
        style={{
          background: "var(--taomni-panel-bg)",
          borderColor: "var(--taomni-chrome-border)",
          color: "var(--taomni-text)",
        }}
      >
        <div
          className="h-8 flex shrink-0 items-center px-3"
          style={{
            background: "linear-gradient(to bottom, #5895c8, #2b5d8b)",
            color: "white",
          }}
        >
          <ShieldAlert className="w-3.5 h-3.5 mr-1.5" />
          <span className="text-[12px] font-semibold">
            {t("sockscap.rootPromptTitle")}
          </span>
          <div className="flex-1" />
          <button
            data-testid="sockscap-root-prompt-close"
            type="button"
            onClick={onCancel}
            aria-label={t("common.close")}
            className="hover:bg-white/20 rounded p-0.5"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="min-h-0 overflow-y-auto p-4">
          <div className="text-[12px] mb-3 text-[var(--taomni-text-muted)]">
            {subtitle ?? t("sockscap.rootPromptSubtitle")}
          </div>

          <label className="block text-[12px] mb-1 font-medium text-[var(--taomni-text)]">
            {t("sockscap.rootPasswordLabel")}
          </label>
          <input
            ref={inputRef}
            data-testid="sockscap-root-password-input"
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="taomni-input w-full h-8 text-[13px]"
            placeholder={t("sockscap.rootPasswordPlaceholder")}
            disabled={busy}
          />

          {error && (
            <div
              data-testid="sockscap-root-prompt-error"
              className="mt-2 text-[12px]"
              style={{ color: "var(--taomni-error, #c33)" }}
            >
              {error}
            </div>
          )}
        </div>

        <div
          className="min-h-12 flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-3 py-2"
          style={{
            background: "var(--taomni-quick-bg)",
            borderColor: "var(--taomni-divider)",
          }}
        >
          <button
            data-testid="sockscap-root-prompt-cancel"
            type="button"
            onClick={onCancel}
            className="taomni-btn"
            disabled={busy}
          >
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            data-testid="sockscap-root-prompt-submit"
            className="taomni-btn font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={!password || busy}
            data-primary="true"
          >
            {busy ? t("sockscap.authenticating") : t("common.confirm")}
          </button>
        </div>
      </form>
    </div>
  );
}
