import { useEffect, useRef, useState } from "react";
import { folderOptionLabel, normalizeGroupPath } from "../../lib/sessionPaths";
import { useT } from "../../lib/i18n";

export interface FolderNameDialogProps {
  parentPath: string | null;
  initialName?: string;
  title?: string;
  confirmLabel?: string;
  onCancel: () => void;
  onSubmit: (folderPath: string) => void;
}

export function FolderNameDialog({
  parentPath,
  initialName,
  title,
  confirmLabel,
  onCancel,
  onSubmit,
}: FolderNameDialogProps) {
  const t = useT();
  const resolvedTitle = title ?? t("sidebar.newFolder");
  const resolvedConfirm = confirmLabel ?? t("common.ok");
  const [name, setName] = useState(initialName ?? t("sidebar.newFolder"));
  const inputRef = useRef<HTMLInputElement>(null);

  const parentLabel = folderOptionLabel(parentPath);
  const trimmedName = name.trim();
  const composed = trimmedName ? `${parentLabel} / ${trimmedName}` : parentLabel;
  const normalized = normalizeGroupPath(composed);
  const valid = !!normalized && !!trimmedName;

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const handleSubmit = () => {
    if (!valid || !normalized) return;
    onSubmit(normalized);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCancel();
    } else if (event.key === "Enter") {
      const target = event.target as HTMLElement;
      if (target.tagName !== "BUTTON") {
        event.preventDefault();
        handleSubmit();
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
        aria-label={resolvedTitle}
        aria-modal="true"
        data-testid="folder-name-dialog"
        className="w-[420px] max-w-[calc(100vw-24px)] max-h-[calc(100vh-24px)] overflow-y-auto rounded shadow-lg p-4"
        style={{ background: "var(--taomni-bg)", border: "1px solid var(--taomni-card-border)" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="text-sm font-semibold mb-3">{resolvedTitle}</div>

        <div
          className="flex items-stretch text-[12px] rounded overflow-hidden"
          style={{ border: "1px solid var(--taomni-input-border)", background: "var(--taomni-input-bg)" }}
        >
          <span
            data-testid="folder-name-dialog-parent"
            className="px-2 py-1 select-none whitespace-nowrap max-w-[180px] truncate"
            style={{ background: "var(--taomni-hover)", color: "var(--taomni-text-muted)" }}
            title={parentLabel}
          >
            {parentLabel} /
          </span>
          <input
            ref={inputRef}
            data-testid="folder-name-dialog-input"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("sidebar.folderNamePlaceholder")}
            className="flex-1 min-w-0 px-2 py-1 outline-none"
            style={{ background: "transparent", color: "var(--taomni-text)" }}
            aria-label={t("sidebar.folderNamePlaceholder")}
          />
        </div>

        <div className="flex gap-2 justify-end mt-4">
          <button
            type="button"
            data-testid="folder-name-dialog-cancel"
            className="px-3 py-1 text-[12px] rounded hover:bg-[var(--taomni-hover)]"
            onClick={onCancel}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            data-testid="folder-name-dialog-confirm"
            className="px-3 py-1 text-[12px] rounded text-white disabled:opacity-50"
            style={{ background: "var(--taomni-accent)" }}
            onClick={handleSubmit}
            disabled={!valid}
          >
            {resolvedConfirm}
          </button>
        </div>
      </div>
    </div>
  );
}
