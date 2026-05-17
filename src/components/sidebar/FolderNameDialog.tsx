import { useEffect, useRef, useState } from "react";
import { folderOptionLabel, normalizeGroupPath } from "../../lib/sessionPaths";

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
  initialName = "New folder",
  title = "New folder",
  confirmLabel = "OK",
  onCancel,
  onSubmit,
}: FolderNameDialogProps) {
  const [name, setName] = useState(initialName);
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
        aria-label={title}
        aria-modal="true"
        data-testid="folder-name-dialog"
        className="w-[420px] rounded shadow-lg p-4"
        style={{ background: "var(--moba-bg)", border: "1px solid var(--moba-card-border)" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="text-sm font-semibold mb-3">{title}</div>

        <div
          className="flex items-stretch text-[12px] rounded overflow-hidden"
          style={{ border: "1px solid var(--moba-input-border)", background: "var(--moba-input-bg)" }}
        >
          <span
            data-testid="folder-name-dialog-parent"
            className="px-2 py-1 select-none whitespace-nowrap"
            style={{ background: "var(--moba-hover)", color: "var(--moba-text-muted)" }}
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
            placeholder="Folder name"
            className="flex-1 min-w-0 px-2 py-1 outline-none"
            style={{ background: "transparent", color: "var(--moba-text)" }}
            aria-label="Folder name"
          />
        </div>

        <div className="flex gap-2 justify-end mt-4">
          <button
            type="button"
            data-testid="folder-name-dialog-cancel"
            className="px-3 py-1 text-[12px] rounded hover:bg-[var(--moba-hover)]"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="folder-name-dialog-confirm"
            className="px-3 py-1 text-[12px] rounded text-white disabled:opacity-50"
            style={{ background: "var(--moba-accent)" }}
            onClick={handleSubmit}
            disabled={!valid}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
