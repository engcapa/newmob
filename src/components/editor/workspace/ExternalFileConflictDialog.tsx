import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, GitMerge, HardDrive, X } from "lucide-react";
import { threeWayMergeText } from "./threeWayMerge";

export interface ExternalFileConflictDialogProps {
  path: string;
  baseText: string;
  localText: string;
  diskText: string | null;
  onKeepLocal: () => void;
  onLoadDisk: () => void;
  onApplyMerge: (text: string) => void;
  onCancel: () => void;
}

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

export function initialExternalMergeText(
  baseText: string,
  localText: string,
  diskText: string,
): string {
  return threeWayMergeText(baseText, localText, diskText).text;
}

export function ExternalFileConflictDialog({
  path,
  baseText,
  localText,
  diskText,
  onKeepLocal,
  onLoadDisk,
  onApplyMerge,
  onCancel,
}: ExternalFileConflictDialogProps) {
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeText, setMergeText] = useState(() => (
    diskText == null ? localText : initialExternalMergeText(baseText, localText, diskText)
  ));
  const primaryRef = useRef<HTMLButtonElement>(null);

  const pathRef = useRef(path);
  useEffect(() => {
    if (pathRef.current !== path) {
      pathRef.current = path;
      setMergeOpen(false);
      setMergeText(diskText == null
        ? localText
        : initialExternalMergeText(baseText, localText, diskText));
      window.setTimeout(() => primaryRef.current?.focus(), 0);
    }
  }, [baseText, diskText, localText, path]);

  return (
    <div
      className="fixed inset-0 z-[970] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.46)" }}
      onClick={onCancel}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        if (mergeOpen) setMergeOpen(false);
        else onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="External file conflict"
        data-testid="external-file-conflict-dialog"
        className="flex max-h-[min(90vh,760px)] w-[min(1040px,calc(100vw-32px))] flex-col overflow-hidden rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-[var(--taomni-code-border)] px-3">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-semibold text-[var(--taomni-code-text)]">
              File changed outside the editor
            </div>
            <div className="truncate text-[10px] text-[var(--taomni-code-muted)]" title={path}>
              {path}
            </div>
          </div>
          <button
            type="button"
            aria-label="Dismiss external file conflict"
            title="Cancel"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={onCancel}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {mergeOpen && diskText != null ? (
          <>
            <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto md:grid-cols-3 md:overflow-hidden">
              <section className="flex min-h-[180px] flex-col border-b border-[var(--taomni-code-border)] md:min-h-0 md:border-b-0 md:border-r">
                <div className="shrink-0 border-b border-[var(--taomni-code-border)] px-3 py-2 text-[11px] font-semibold">
                  Local changes - {lineCount(localText)} lines
                </div>
                <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-5 text-[var(--taomni-code-text)]">
                  {localText}
                </pre>
              </section>
              <section className="flex min-h-[180px] flex-col border-b border-[var(--taomni-code-border)] md:min-h-0 md:border-b-0 md:border-r">
                <div className="shrink-0 border-b border-[var(--taomni-code-border)] px-3 py-2 text-[11px] font-semibold">
                  Disk version - {lineCount(diskText)} lines
                </div>
                <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-5 text-[var(--taomni-code-text)]">
                  {diskText}
                </pre>
              </section>
              <section className="flex min-h-[240px] flex-col md:min-h-0">
                <div className="shrink-0 border-b border-[var(--taomni-code-border)] px-3 py-2 text-[11px] font-semibold">
                  Merge result - {lineCount(mergeText)} lines
                </div>
                <textarea
                  aria-label="Merge result"
                  value={mergeText}
                  spellCheck={false}
                  className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-[11px] leading-5 text-[var(--taomni-code-text)] outline-none"
                  onChange={(event) => setMergeText(event.target.value)}
                />
              </section>
            </div>
            <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--taomni-code-border)] px-3 py-2">
              <div className="mr-auto min-w-0 text-[10px] text-[var(--taomni-code-muted)]">
                {mergeText.includes("<<<<<<< LOCAL")
                  ? "Resolve the conflict markers before saving the merged result."
                  : "Review the merged result before applying it."}
              </div>
              <button
                type="button"
                className="inline-flex h-8 items-center gap-1.5 rounded px-3 text-[11px] hover:bg-[var(--taomni-code-active-line-bg)]"
                onClick={() => setMergeOpen(false)}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back
              </button>
              <button
                type="button"
                className="inline-flex h-8 items-center gap-1.5 rounded bg-[var(--taomni-accent)] px-3 text-[11px] font-medium text-white hover:brightness-110"
                onClick={() => onApplyMerge(mergeText)}
              >
                <GitMerge className="h-3.5 w-3.5" />
                Apply Merge
              </button>
            </footer>
          </>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-auto px-4 py-4 text-[12px] leading-5 text-[var(--taomni-code-text)]">
              {diskText == null
                ? "The file was deleted on disk while this editor has unsaved changes."
                : "The disk version and this editor buffer both changed since the last save."}
              <div className="mt-3 grid grid-cols-1 gap-px overflow-hidden rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-border)] sm:grid-cols-3">
                <div className="bg-[var(--taomni-code-bg)] px-3 py-2">
                  <div className="text-[10px] text-[var(--taomni-code-muted)]">Saved baseline</div>
                  <div className="mt-1 font-mono text-[11px]">{lineCount(baseText)} lines</div>
                </div>
                <div className="bg-[var(--taomni-code-bg)] px-3 py-2">
                  <div className="text-[10px] text-[var(--taomni-code-muted)]">Local buffer</div>
                  <div className="mt-1 font-mono text-[11px]">{lineCount(localText)} lines</div>
                </div>
                <div className="bg-[var(--taomni-code-bg)] px-3 py-2">
                  <div className="text-[10px] text-[var(--taomni-code-muted)]">Disk</div>
                  <div className="mt-1 font-mono text-[11px]">
                    {diskText == null ? "Deleted" : `${lineCount(diskText)} lines`}
                  </div>
                </div>
              </div>
            </div>
            <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--taomni-code-border)] px-3 py-2">
              <button
                type="button"
                className="h-8 rounded px-3 text-[11px] hover:bg-[var(--taomni-code-active-line-bg)]"
                onClick={onCancel}
              >
                Decide Later
              </button>
              <button
                type="button"
                className="inline-flex h-8 items-center gap-1.5 rounded px-3 text-[11px] hover:bg-[var(--taomni-code-active-line-bg)]"
                onClick={onLoadDisk}
              >
                {diskText == null
                  ? <X className="h-3.5 w-3.5" />
                  : <HardDrive className="h-3.5 w-3.5" />}
                {diskText == null ? "Close File" : "Load Disk"}
              </button>
              {diskText != null && (
                <button
                  type="button"
                  className="inline-flex h-8 items-center gap-1.5 rounded px-3 text-[11px] hover:bg-[var(--taomni-code-active-line-bg)]"
                  onClick={() => setMergeOpen(true)}
                >
                  <GitMerge className="h-3.5 w-3.5" />
                  Merge
                </button>
              )}
              <button
                ref={primaryRef}
                type="button"
                className="h-8 rounded bg-[var(--taomni-accent)] px-3 text-[11px] font-medium text-white hover:brightness-110"
                onClick={onKeepLocal}
              >
                Keep Local
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
