import { useEffect, useRef, useState } from "react";
import type { ConflictAction, ConflictActionType } from "../../lib/zmodem";

export interface ZmodemConflictDialogProps {
  fileName: string;
  hasMore: boolean;
  mode: "receive" | "send";
  onResolve: (action: ConflictAction) => void;
}

export function ZmodemConflictDialog({ fileName, hasMore, mode, onResolve }: ZmodemConflictDialogProps) {
  const [applyToAll, setApplyToAll] = useState(false);
  const firstButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstButtonRef.current?.focus();
  }, []);

  const resolve = (type: ConflictActionType) => {
    onResolve({ type, applyToAll: hasMore && applyToAll });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") resolve("skip");
  };

  const title = mode === "send" ? "File already exists on remote" : "File already exists";

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
        className="w-[400px] rounded shadow-lg p-4"
        style={{ background: "var(--moba-bg)", border: "1px solid var(--moba-card-border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold mb-1">{title}</div>
        <div
          className="text-[12px] mb-4 break-all"
          style={{ color: "var(--moba-text-muted)" }}
          title={fileName}
        >
          {fileName}
        </div>

        <div className="flex flex-col gap-2 mb-4">
          {mode === "receive" && (
            <button
              ref={firstButtonRef}
              type="button"
              className="w-full px-3 py-1.5 text-[12px] rounded text-left hover:opacity-90"
              style={{ background: "var(--moba-accent)", color: "#fff" }}
              onClick={() => resolve("overwrite")}
            >
              Overwrite
            </button>
          )}
          <button
            ref={mode === "send" ? firstButtonRef : undefined}
            type="button"
            className="w-full px-3 py-1.5 text-[12px] rounded text-left"
            style={{
              background: mode === "send" ? "var(--moba-accent)" : "var(--moba-input-bg)",
              border: mode === "send" ? "none" : "1px solid var(--moba-input-border)",
              color: mode === "send" ? "#fff" : "var(--moba-text)",
            }}
            onClick={() => resolve("rename")}
          >
            Rename (add number)
          </button>
          <button
            type="button"
            className="w-full px-3 py-1.5 text-[12px] rounded text-left"
            style={{
              background: "var(--moba-input-bg)",
              border: "1px solid var(--moba-input-border)",
              color: "var(--moba-text)",
            }}
            onClick={() => resolve("skip")}
          >
            Skip
          </button>
        </div>

        {hasMore && (
          <label className="flex items-center gap-2 text-[12px] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={applyToAll}
              onChange={(e) => setApplyToAll(e.target.checked)}
            />
            <span>Apply to all remaining files</span>
          </label>
        )}
      </div>
    </div>
  );
}
