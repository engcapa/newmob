import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowLeftRight, Check, Copy, X } from "lucide-react";
import { writeText } from "../../../lib/clipboard";
import type { CompareDocumentDescriptor, EditorCompareSession } from "./editorCompareModel";

interface EditorCompareDialogProps {
  session: EditorCompareSession;
  onClose: () => void;
  onApplyRight?: (newText: string) => void | Promise<void>;
}

function metadataLabel(document: CompareDocumentDescriptor): string {
  const parts = [
    document.encoding ?? "UTF-8",
    document.eol ?? "LF",
    document.bom ? "BOM" : "No BOM",
    document.sizeBytes == null ? null : `${document.sizeBytes} B`,
  ];
  return parts.filter((part): part is string => part !== null).join(" · ");
}

function lineRows(leftText: string, rightText: string): Array<{
  left: string | null;
  right: string | null;
  kind: "same" | "changed" | "removed" | "added";
}> {
  const leftLines = leftText.split("\n");
  const rightLines = rightText.split("\n");
  const max = Math.max(leftLines.length, rightLines.length);
  return Array.from({ length: max }, (_, index) => {
    const left = leftLines[index] ?? null;
    const right = rightLines[index] ?? null;
    return {
      left,
      right,
      kind: left === right
        ? "same"
        : left == null
          ? "added"
          : right == null
            ? "removed"
            : "changed",
    };
  });
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(
    "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
  ));
}

function CompareSide({
  side,
  sideKind,
  rows,
  onCopy,
  copyStatus,
}: {
  side: CompareDocumentDescriptor;
  sideKind: "left" | "right";
  rows: ReturnType<typeof lineRows>;
  onCopy: () => void;
  copyStatus: string | null;
}) {
  const sideName = side.title;
  const isLeft = sideKind === "left";
  return (
    <section
      className="flex min-w-0 flex-1 flex-col rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)]"
      aria-label={`${sideName} comparison side`}
    >
      <div className="flex min-w-0 items-center justify-between gap-2 border-b border-[var(--taomni-code-border)] px-3 py-1.5">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium">{side.title}</div>
          <div className="truncate text-[10px] text-[var(--taomni-code-muted)]">
            {side.path ?? side.source ?? "buffer"} · {metadataLabel(side)}
          </div>
        </div>
        <button
          type="button"
          data-testid={isLeft ? "compare-copy-left" : "compare-copy-right"}
          aria-label={`Copy ${side.title}`}
          title={`Copy ${side.title}`}
          disabled={!!side.unavailable}
          onClick={onCopy}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-border)] hover:text-[var(--taomni-code-text)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Copy className="h-3 w-3" />
        </button>
      </div>
      {copyStatus && (
        <div role="status" className="border-b border-[var(--taomni-code-border)] px-3 py-1 text-[10px] text-amber-400">
          {copyStatus}
        </div>
      )}
      {side.unavailable ? (
        <div
          role="alert"
          data-testid={`${isLeft ? "compare-left" : "compare-right"}-unavailable`}
          className="m-3 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-300"
        >
          <div className="font-medium">Unavailable: {side.unavailable.reason}</div>
          <div className="mt-1 break-words">{side.unavailable.message}</div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-2 font-mono text-xs leading-5">
          {rows.map((row, index) => {
            const value = isLeft ? row.left : row.right;
            const changed = row.kind !== "same";
            const color = isLeft ? "bg-red-500/10 text-red-300" : "bg-emerald-500/10 text-emerald-300";
            return (
              <div
                key={`${index}:${row.kind}`}
                data-testid={`${isLeft ? "compare-left" : "compare-right"}-line-${index}`}
                data-diff-kind={row.kind}
                className={`flex min-h-5 gap-3 px-2 ${changed ? color : ""}`}
              >
                <span className="w-8 shrink-0 select-none text-right text-[var(--taomni-code-muted)]">
                  {value == null ? "" : index + 1}
                </span>
                <pre className="min-w-0 whitespace-pre-wrap break-all">{value || " "}</pre>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function EditorCompareDialog({
  session,
  onClose,
  onApplyRight,
}: EditorCompareDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [copyStatus, setCopyStatus] = useState<Record<"left" | "right", string | null>>({
    left: null,
    right: null,
  });
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const rows = lineRows(session.left.text, session.right.text);
  const canApply = !!onApplyRight
    && !session.left.unavailable
    && !session.right.unavailable
    && !session.right.readOnly;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const initial = dialog.querySelector<HTMLElement>("[data-compare-autofocus='true']")
      ?? focusableElements(dialog)[0];
    initial?.focus();
  }, [session.id]);

  useEffect(() => {
    const handleEscape = (event: WindowEventMap["keydown"]) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = focusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const nextIndex = event.shiftKey
      ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
      : (currentIndex + 1) % focusable.length;
    event.preventDefault();
    focusable[nextIndex]?.focus();
  };

  const copySide = async (side: "left" | "right") => {
    const document = side === "left" ? session.left : session.right;
    if (document.unavailable) return;
    setCopyStatus((current) => ({ ...current, [side]: null }));
    try {
      await writeText(document.text);
      setCopyStatus((current) => ({ ...current, [side]: "Copied" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCopyStatus((current) => ({ ...current, [side]: `Copy failed: ${message}` }));
    }
  };

  const applyLeftToRight = async () => {
    if (!canApply || !onApplyRight || applying) return;
    setApplying(true);
    setApplyError(null);
    try {
      await onApplyRight(session.left.text);
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : String(error));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={session.title}
      tabIndex={-1}
      data-testid="code-workspace-compare-dialog"
      onKeyDown={handleKeyDown}
      className="fixed inset-0 z-50 flex min-h-0 flex-col bg-[var(--taomni-code-bg)]/95 p-4 text-[var(--taomni-code-text)] backdrop-blur-sm"
    >
      <div className="flex min-w-0 shrink-0 items-start justify-between gap-3 border-b border-[var(--taomni-code-border)] pb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ArrowLeftRight className="h-4 w-4 shrink-0 text-[var(--taomni-accent)]" />
            <h2 className="truncate text-sm font-semibold">{session.title}</h2>
          </div>
          <div data-testid="compare-session-metadata" className="mt-1 truncate text-[10px] text-[var(--taomni-code-muted)]">
            {session.source ?? "file"} · {session.target ? `target revision ${session.target.documentRevision}` : "read-only comparison"}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onApplyRight && (
            <button
              type="button"
              data-testid="compare-apply-left-to-right"
              data-compare-autofocus={canApply ? "true" : undefined}
              aria-label="Apply left side to right side"
              disabled={!canApply || applying}
              onClick={() => void applyLeftToRight()}
              className="inline-flex min-h-7 items-center gap-1 rounded bg-[var(--taomni-accent)] px-2.5 py-1 text-xs font-medium text-[var(--taomni-code-bg)] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Check className="h-3.5 w-3.5" />
              <span>{applying ? "Applying…" : "Apply Left to Right"}</span>
            </button>
          )}
          <button
            type="button"
            aria-label="Close compare dialog"
            data-testid="compare-dialog-close"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded p-1 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-border)] hover:text-[var(--taomni-code-text)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      {applyError && (
        <div role="alert" data-testid="compare-apply-error" className="mt-3 shrink-0 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          Apply failed: {applyError}
        </div>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 pt-3 md:grid-cols-2">
        <CompareSide
          side={session.left}
          sideKind="left"
          rows={rows}
          onCopy={() => void copySide("left")}
          copyStatus={copyStatus.left}
        />
        <CompareSide
          side={session.right}
          sideKind="right"
          rows={rows}
          onCopy={() => void copySide("right")}
          copyStatus={copyStatus.right}
        />
      </div>
    </div>
  );
}
