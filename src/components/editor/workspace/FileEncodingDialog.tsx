import { useEffect, useMemo, useRef, useState } from "react";
import { HardDrive, RefreshCw, Save, X } from "lucide-react";

export const WORKSPACE_FILE_ENCODINGS = [
  "UTF-8",
  "UTF-16LE",
  "UTF-16BE",
  "ISO-8859-1",
  "windows-1252",
  "GBK",
  "Big5",
  "Shift_JIS",
  "EUC-JP",
  "ISO-8859-2",
  "KOI8-R",
] as const;

export type WorkspaceFileEncoding = typeof WORKSPACE_FILE_ENCODINGS[number];

export interface FileEncodingDialogProps {
  path: string;
  currentEncoding: string;
  currentBom: boolean;
  dirty: boolean;
  onReload: (encoding: string) => Promise<void> | void;
  onConvert: (encoding: string, bom: boolean) => void;
  onClose: () => void;
}

function supportsBom(encoding: string): boolean {
  const normalized = encoding.trim().toLowerCase().replace(/_/g, "-");
  return normalized === "utf-8" || normalized === "utf-16le" || normalized === "utf-16be";
}

function displayEncoding(value: string): string {
  const match = WORKSPACE_FILE_ENCODINGS.find((candidate) => candidate.toLowerCase() === value.toLowerCase());
  return match ?? value;
}

export function FileEncodingDialog({
  path,
  currentEncoding,
  currentBom,
  dirty,
  onReload,
  onConvert,
  onClose,
}: FileEncodingDialogProps) {
  const [encoding, setEncoding] = useState(displayEncoding(currentEncoding || "UTF-8"));
  const [bom, setBom] = useState(currentBom);
  const [busy, setBusy] = useState(false);
  const selectRef = useRef<HTMLSelectElement>(null);
  const bomRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const nextEncoding = displayEncoding(currentEncoding || "UTF-8");
    setEncoding(nextEncoding);
    setBom(currentBom);
    if (bomRef.current) {
      bomRef.current.checked = supportsBom(nextEncoding) && currentBom;
    }
    window.setTimeout(() => selectRef.current?.focus(), 0);
  }, [currentBom, currentEncoding, path]);

  const bomEnabled = useMemo(() => supportsBom(encoding), [encoding]);

  const reload = async () => {
    setBusy(true);
    try {
      await onReload(encoding);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[980] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.46)" }}
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="File encoding"
        data-testid="file-encoding-dialog"
        className="w-[min(460px,calc(100vw-32px))] overflow-hidden rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex min-h-11 items-center gap-2 border-b border-[var(--taomni-code-border)] px-3">
          <HardDrive className="h-4 w-4 shrink-0 text-[var(--taomni-accent)]" />
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-semibold text-[var(--taomni-code-text)]">File encoding</div>
            <div className="truncate text-[10px] text-[var(--taomni-code-muted)]" title={path}>{path}</div>
          </div>
          <button
            type="button"
            aria-label="Close file encoding dialog"
            title="Close"
            className="inline-flex h-7 w-7 items-center justify-center rounded hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-4 p-4">
          <label className="block text-[11px] text-[var(--taomni-code-muted)]">
            Encoding
            <select
              ref={selectRef}
              data-testid="file-encoding-select"
              aria-label="Encoding"
              value={encoding}
              disabled={busy}
              className="mt-1 h-8 w-full rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-2 text-[12px] text-[var(--taomni-code-text)] outline-none focus:border-[var(--taomni-accent)]"
              onChange={(event) => {
                const next = event.target.value;
                setEncoding(next);
                if (!supportsBom(next)) {
                  setBom(false);
                  if (bomRef.current) bomRef.current.checked = false;
                }
              }}
            >
              {WORKSPACE_FILE_ENCODINGS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>

          <label className={`flex items-center gap-2 text-[11px] ${bomEnabled ? "text-[var(--taomni-code-text)]" : "text-[var(--taomni-code-muted)]"}`}>
            <input
              ref={bomRef}
              data-testid="file-encoding-bom"
              type="checkbox"
              defaultChecked={supportsBom(currentEncoding) && currentBom}
              disabled={!bomEnabled || busy}
              onClick={(event) => setBom(event.currentTarget.checked)}
              onChange={(event) => setBom(event.target.checked)}
            />
            Write byte-order marker (BOM)
          </label>

          {dirty && (
            <p className="text-[10px] leading-4 text-amber-500">
              Reload discards unsaved changes. Convert on save keeps the current buffer and marks it dirty.
            </p>
          )}
        </div>

        <footer className="flex flex-wrap justify-end gap-2 border-t border-[var(--taomni-code-border)] px-3 py-2">
          <button
            type="button"
            data-testid="file-encoding-reload"
            className="inline-flex h-8 items-center gap-1.5 rounded px-3 text-[11px] hover:bg-[var(--taomni-code-active-line-bg)]"
            disabled={busy}
            onClick={() => void reload()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Reload from Disk
          </button>
          <button
            type="button"
            data-testid="file-encoding-convert"
            className="inline-flex h-8 items-center gap-1.5 rounded bg-[var(--taomni-accent)] px-3 text-[11px] text-white hover:brightness-110 disabled:opacity-50"
            disabled={busy}
            onClick={() => {
              onConvert(encoding, bomEnabled && (bomRef.current?.checked ?? bom));
              onClose();
            }}
          >
            <Save className="h-3.5 w-3.5" />
            Convert on Save
          </button>
        </footer>
      </div>
    </div>
  );
}
