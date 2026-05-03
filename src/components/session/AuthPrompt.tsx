import { useState } from "react";
import { KeyRound, X } from "lucide-react";

interface AuthPromptProps {
  host: string;
  username: string;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}

export function AuthPrompt({ host, username, onSubmit, onCancel }: AuthPromptProps) {
  const [password, setPassword] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    onSubmit(password);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(20,30,45,0.4)" }}>
      <form
        data-testid="auth-prompt"
        onSubmit={handleSubmit}
        className="w-[400px] rounded-md shadow-2xl border overflow-hidden"
        style={{ background: "var(--moba-panel-bg)", borderColor: "var(--moba-chrome-border)", color: "var(--moba-text)" }}
      >
        <div className="h-8 flex items-center px-3"
             style={{ background: "linear-gradient(to bottom, #5895c8, #2b5d8b)", color: "white" }}>
          <KeyRound className="w-3.5 h-3.5 mr-1.5" />
          <span className="text-[12px] font-semibold">Authentication required</span>
          <div className="flex-1" />
          <button type="button" onClick={onCancel} className="hover:bg-white/20 rounded p-0.5">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="p-4">
          <div className="text-[12px] mb-3 text-[var(--moba-text-muted)]">
            Enter password for <span className="font-semibold text-[var(--moba-text)]">{username}@{host}</span>
          </div>
          <input
            data-testid="auth-password"
            aria-label="SSH password"
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="moba-input w-full h-8 text-[13px]"
            placeholder="Password"
          />
        </div>

        <div className="h-12 flex items-center justify-end px-3 gap-2 border-t"
             style={{ background: "var(--moba-quick-bg)", borderColor: "var(--moba-divider)" }}>
          <button type="button" onClick={onCancel}
                  className="moba-btn">
            Cancel
          </button>
          <button type="submit"
                  data-testid="auth-submit"
                  className="moba-btn font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={!password}
                  data-primary="true">
            Connect
          </button>
        </div>
      </form>
    </div>
  );
}
