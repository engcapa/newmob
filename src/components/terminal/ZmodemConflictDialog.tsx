import { useEffect, useRef, useState } from "react";
import type { ConflictAction, ConflictActionType } from "../../lib/zmodem";
import { useT } from "../../lib/i18n";

export interface ZmodemConflictDialogProps {
  fileName: string;
  hasMore: boolean;
  mode: "receive" | "send";
  onResolve: (action: ConflictAction) => void;
}

export function ZmodemConflictDialog({ fileName, hasMore, mode, onResolve }: ZmodemConflictDialogProps) {
  const [applyToAll, setApplyToAll] = useState(false);
  const firstButtonRef = useRef<HTMLButtonElement>(null);
  const t = useT();

  useEffect(() => {
    firstButtonRef.current?.focus();
  }, []);

  const resolve = (type: ConflictActionType) => {
    onResolve({ type, applyToAll: hasMore && applyToAll });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") resolve("skip");
  };

  const title = mode === "send" ? t("terminal.zmodemConflictTitleSend") : t("terminal.zmodemConflictTitleReceive");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onKeyDown={handleKeyDown}
    >
      <div
        role="dialog"
        aria-label={title}
        aria-modal="true"
        data-testid="zmodem-conflict"
        className="w-[400px] max-w-[calc(100vw-24px)] max-h-[calc(100vh-24px)] overflow-y-auto rounded shadow-lg p-4"
        style={{ background: "var(--taomni-bg)", border: "1px solid var(--taomni-card-border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold mb-1">{title}</div>
        <div
          className="text-[12px] mb-4 break-all"
          style={{ color: "var(--taomni-text-muted)" }}
          title={fileName}
        >
          {fileName}
        </div>

        <div className="flex flex-col gap-2 mb-4">
          {mode === "receive" && (
            <button
              ref={firstButtonRef}
              type="button"
              data-testid="zmodem-overwrite"
              className="w-full px-3 py-1.5 text-[12px] rounded text-left hover:opacity-90"
              style={{ background: "var(--taomni-accent)", color: "#fff" }}
              onClick={() => resolve("overwrite")}
            >
              {t("terminal.zmodemOverwrite")}
            </button>
          )}
          <button
            ref={mode === "send" ? firstButtonRef : undefined}
            type="button"
            data-testid="zmodem-rename"
            className="w-full px-3 py-1.5 text-[12px] rounded text-left"
            style={{
              background: mode === "send" ? "var(--taomni-accent)" : "var(--taomni-input-bg)",
              border: mode === "send" ? "none" : "1px solid var(--taomni-input-border)",
              color: mode === "send" ? "#fff" : "var(--taomni-text)",
            }}
            onClick={() => resolve("rename")}
          >
            {t("terminal.zmodemRename")}
          </button>
          <button
            type="button"
            data-testid="zmodem-skip"
            className="w-full px-3 py-1.5 text-[12px] rounded text-left"
            style={{
              background: "var(--taomni-input-bg)",
              border: "1px solid var(--taomni-input-border)",
              color: "var(--taomni-text)",
            }}
            onClick={() => resolve("skip")}
          >
            {t("terminal.zmodemSkip")}
          </button>
        </div>

        {hasMore && (
          <label className="flex items-center gap-2 text-[12px] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={applyToAll}
              onChange={(e) => setApplyToAll(e.target.checked)}
            />
            <span>{t("terminal.zmodemApplyToAll")}</span>
          </label>
        )}
      </div>
    </div>
  );
}
