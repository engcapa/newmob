import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileWarning, HardDrive, RotateCcw, ShieldCheck, Trash2, X } from "lucide-react";
import type { WorkspaceDiskEffectLedgerEntryV4, WorkspaceRecoveryEntry } from "./workspaceRecovery";

export interface WorkspaceRecoveryDialogProps {
  entries: WorkspaceRecoveryEntry[];
  onRecover: (entry: WorkspaceRecoveryEntry) => void | Promise<void>;
  onDiscard: (entry: WorkspaceRecoveryEntry) => void;
  onRecoverAll: () => void | Promise<void>;
  onDiscardAll: () => void;
  onClose: () => void;
  /**
   * §8.19.1 disk-effect ledger rows for this workspace: committed-but-
   * discarded writebacks and unresolved unknown/foreign disk outcomes.
   * Acknowledge clears only the explicitly selected row.
   */
  ledgerEntries?: readonly WorkspaceDiskEffectLedgerEntryV4[];
  onAcknowledgeLedgerEntry?: (entry: WorkspaceDiskEffectLedgerEntryV4) => void;
  onReopenLedgerEntry?: (entry: WorkspaceDiskEffectLedgerEntryV4) => void;
}

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

function capturedLabel(timestamp: number): string {
  if (!timestamp) return "Unknown time";
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return "Unknown time";
  }
}

function hashDigest(hash: string | null | undefined): string {
  if (!hash) return "—";
  return hash.length > 10 ? `${hash.slice(0, 10)}…` : hash;
}

function resolutionBadgeLabel(entry: WorkspaceDiskEffectLedgerEntryV4): string {
  switch (entry.resolution) {
    case "confirmed-committed":
      return entry.memoryEffect === "writeback-discarded"
        ? "Saved to disk · editor writeback discarded"
        : "Confirmed committed";
    case "confirmed-none":
      return "Confirmed no change";
    case "foreign-blocked":
      return "Foreign content · retries blocked";
    case "pending-readback":
      return "Unverified · retries blocked";
    default:
      return "User resolved";
  }
}

function resolutionBadgeTone(entry: WorkspaceDiskEffectLedgerEntryV4): "blocked" | "info" {
  return entry.resolution === "pending-readback" || entry.resolution === "foreign-blocked"
    ? "blocked"
    : "info";
}

/** Lists unsaved buffers and unresolved disk effects left by a previous lifetime. */
export function WorkspaceRecoveryDialog({
  entries,
  onRecover,
  onDiscard,
  onRecoverAll,
  onDiscardAll,
  onClose,
  ledgerEntries = [],
  onAcknowledgeLedgerEntry,
  onReopenLedgerEntry,
}: WorkspaceRecoveryDialogProps) {
  const [tab, setTab] = useState<"buffers" | "disk">(
    entries.length > 0 ? "buffers" : ledgerEntries.length > 0 ? "disk" : "buffers",
  );
  const [selectedKey, setSelectedKey] = useState(entries[0]?.key ?? null);
  const [busy, setBusy] = useState(false);
  const primaryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!entries.some((entry) => entry.key === selectedKey)) {
      setSelectedKey(entries[0]?.key ?? null);
    }
    window.setTimeout(() => primaryRef.current?.focus(), 0);
  }, [entries, selectedKey]);

  const selected = useMemo(
    () => entries.find((entry) => entry.key === selectedKey) ?? entries[0] ?? null,
    [entries, selectedKey],
  );

  // Group ledger rows by path so multi-attempt history on one file reads as
  // one incident (§8.19.1 recovery-center grouping).
  const ledgerByPath = useMemo(() => {
    const groups = new Map<string, WorkspaceDiskEffectLedgerEntryV4[]>();
    for (const entry of ledgerEntries) {
      const group = groups.get(entry.path) ?? [];
      group.push(entry);
      groups.set(entry.path, group);
    }
    return [...groups.entries()].sort((left, right) =>
      left[0].localeCompare(right[0]),
    );
  }, [ledgerEntries]);

  const runRecoverAll = async () => {
    setBusy(true);
    try {
      await onRecoverAll();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[965] flex items-center justify-center bg-black/45 p-4"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Workspace recovery"
        data-testid="workspace-recovery-dialog"
        className="flex h-[min(680px,90vh)] w-[min(980px,calc(100vw-32px))] flex-col overflow-hidden rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-[var(--taomni-code-border)] px-3">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-semibold text-[var(--taomni-code-text)]">
              Workspace recovery
            </div>
            <div className="truncate text-[10px] text-[var(--taomni-code-muted)]">
              Unsaved buffers and unresolved disk results from previous sessions.
            </div>
          </div>
          <button
            type="button"
            aria-label="Close workspace recovery"
            title="Decide later"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {(entries.length > 0 || ledgerEntries.length > 0) && (
          <div className="flex shrink-0 items-center gap-1 border-b border-[var(--taomni-code-border)] px-3 py-1.5">
            <button
              type="button"
              className={`inline-flex h-7 items-center gap-1.5 rounded px-2.5 text-[11px] ${
                tab === "buffers" ? "bg-[var(--taomni-code-selection-match-bg)] text-[var(--taomni-code-text)]" : "text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
              }`}
              onClick={() => setTab("buffers")}
              disabled={entries.length === 0}
            >
              Unsaved buffers ({entries.length})
            </button>
            <button
              type="button"
              data-testid="workspace-recovery-disk-results-tab"
              className={`inline-flex h-7 items-center gap-1.5 rounded px-2.5 text-[11px] ${
                tab === "disk" ? "bg-[var(--taomni-code-selection-match-bg)] text-[var(--taomni-code-text)]" : "text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
              }`}
              onClick={() => setTab("disk")}
              disabled={ledgerEntries.length === 0}
            >
              Disk results ({ledgerEntries.length})
            </button>
          </div>
        )}

        {tab === "disk" ? (
          <section className="min-h-0 flex-1 overflow-auto p-3" data-testid="workspace-recovery-disk-results">
            {ledgerByPath.length === 0 ? (
              <div className="flex h-full items-center justify-center text-[11px] text-[var(--taomni-code-muted)]">
                No unresolved disk results. Every write settled cleanly.
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {ledgerByPath.map(([path, group]) => (
                  <li
                    key={path}
                    className="rounded border border-[var(--taomni-code-border)] px-3 py-2"
                  >
                    <div className="mb-1.5 flex items-center gap-2">
                      <FileWarning className={`h-3.5 w-3.5 shrink-0 ${resolutionBadgeTone(group[0]) === "blocked" ? "text-red-400" : "text-sky-400"}`} />
                      <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-[var(--taomni-code-text)]" title={path}>
                        {path}
                      </span>
                      {group.some((row) => resolutionBadgeTone(row) === "blocked") && (
                        <span className="shrink-0 rounded bg-red-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-red-400">
                          Save blocked
                        </span>
                      )}
                    </div>
                    <ul className="flex flex-col gap-1.5">
                      {group.map((row) => (
                        <li
                          key={`${row.transactionId}:${row.operationId}:${row.path}`}
                          className="rounded bg-[var(--taomni-code-active-line-bg)] px-2 py-1.5"
                          data-testid="workspace-recovery-disk-result-row"
                        >
                          <div className="flex items-start gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-[var(--taomni-code-muted)]">
                                <span className={resolutionBadgeTone(row) === "blocked" ? "font-semibold text-red-400" : "font-semibold text-[var(--taomni-code-text)]"}>
                                  {resolutionBadgeLabel(row)}
                                </span>
                                <span>·</span>
                                <span>disk {row.diskEffect} / buffer {row.memoryEffect} / provider {row.providerEffect}</span>
                              </div>
                              <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 font-mono text-[10px] text-[var(--taomni-code-muted)]">
                                <span>before</span>
                                <span className="break-all">{hashDigest(row.expectedOldHash)}</span>
                                <span>intended</span>
                                <span className="break-all">{hashDigest(row.intendedNewHash)}</span>
                                <span>observed</span>
                                <span className="break-all">{hashDigest(row.observedHash)}</span>
                              </div>
                              <div className="mt-1 text-[10px] text-[var(--taomni-code-muted)]">
                                {capturedLabel(row.createdAt)}
                                {row.verifiedAt !== null ? ` · verified ${capturedLabel(row.verifiedAt)}` : ""}
                                {` · ${row.transactionId}`}
                              </div>
                            </div>
                            <div className="flex shrink-0 flex-col gap-1">
                              {onReopenLedgerEntry && (
                                <button
                                  type="button"
                                  className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[10px] hover:bg-[var(--taomni-code-selection-match-bg)]"
                                  title="Open the file as it is on disk right now"
                                  onClick={() => onReopenLedgerEntry(row)}
                                >
                                  <RotateCcw className="h-3 w-3" />
                                  Reopen
                                </button>
                              )}
                              {onAcknowledgeLedgerEntry && (
                                <button
                                  type="button"
                                  className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[10px] hover:bg-emerald-500/15 hover:text-emerald-400"
                                  title="Acknowledge only this row and unblock saving this path"
                                  onClick={() => onAcknowledgeLedgerEntry(row)}
                                >
                                  <CheckCircle2 className="h-3 w-3" />
                                  Acknowledge
                                </button>
                              )}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[280px_1fr]">
            <aside className="min-h-0 overflow-auto border-b border-[var(--taomni-code-border)] md:border-b-0 md:border-r">
              <div className="border-b border-[var(--taomni-code-border)] px-3 py-2 text-[10px] text-[var(--taomni-code-muted)]">
                {entries.length} unsaved {entries.length === 1 ? "buffer" : "buffers"}
              </div>
              <ul className="py-1">
                {entries.map((entry) => (
                  <li key={entry.key}>
                    <div
                      className="flex items-start gap-1 px-2 py-1 hover:bg-[var(--taomni-code-active-line-bg)] data-[selected=true]:bg-[var(--taomni-code-selection-match-bg)]"
                      data-selected={entry.key === selected?.key || undefined}
                    >
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate px-1 py-1 text-left"
                        onClick={() => setSelectedKey(entry.key)}
                      >
                        <span className="block truncate text-[11px] text-[var(--taomni-code-text)]" title={entry.path}>
                          {entry.path}
                        </span>
                        <span className="block truncate text-[10px] text-[var(--taomni-code-muted)]">
                          {capturedLabel(entry.capturedAt)} · {lineCount(entry.text)} lines
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label={`Discard recovery for ${entry.path}`}
                        title="Discard"
                        className="mt-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-red-500/15 hover:text-red-400"
                        onClick={() => onDiscard(entry)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </aside>

            <section className="flex min-h-0 flex-col">
              {selected ? (
                <>
                  <div className="shrink-0 border-b border-[var(--taomni-code-border)] px-3 py-2">
                    <div className="truncate text-[11px] font-semibold text-[var(--taomni-code-text)]" title={selected.path}>
                      {selected.path}
                    </div>
                    <div className="mt-0.5 text-[10px] text-[var(--taomni-code-muted)]">
                      {capturedLabel(selected.capturedAt)} · {selected.text.length.toLocaleString()} characters
                    </div>
                  </div>
                  <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-5 text-[var(--taomni-code-text)]">
                    {selected.text}
                  </pre>
                  <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--taomni-code-border)] px-3 py-2">
                    <button
                      type="button"
                      className="inline-flex h-8 items-center gap-1.5 rounded px-3 text-[11px] hover:bg-[var(--taomni-code-active-line-bg)]"
                      onClick={() => onDiscard(selected)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Discard selected
                    </button>
                    <button
                      ref={primaryRef}
                      type="button"
                      disabled={busy}
                      className="inline-flex h-8 items-center gap-1.5 rounded bg-[var(--taomni-accent)] px-3 text-[11px] font-medium text-white hover:brightness-110 disabled:opacity-50"
                      onClick={() => void onRecover(selected)}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      Recover selected
                    </button>
                  </footer>
                </>
              ) : (
                <div className="flex flex-1 items-center justify-center p-6 text-[11px] text-[var(--taomni-code-muted)]">
                  No recovery buffers remain.
                </div>
              )}
            </section>
          </div>
        )}

        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-[var(--taomni-code-border)] px-3 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[10px] text-[var(--taomni-code-muted)]">
            <HardDrive className="h-3.5 w-3.5 shrink-0" />
            Recovery data stays local to this workspace.
            <ShieldCheck className="ml-1 h-3 w-3 shrink-0" />
            Acknowledge clears only the row you choose.
          </div>
          {tab === "buffers" && (
            <>
              <button
                type="button"
                disabled={busy || entries.length === 0}
                className="h-8 rounded px-3 text-[11px] hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40"
                onClick={() => void runRecoverAll()}
              >
                Recover all
              </button>
              <button
                type="button"
                disabled={busy || entries.length === 0}
                className="h-8 rounded px-3 text-[11px] hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40"
                onClick={onDiscardAll}
              >
                Discard all
              </button>
            </>
          )}
          <button
            type="button"
            className="h-8 rounded px-3 text-[11px] hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={onClose}
          >
            Decide later
          </button>
        </footer>
      </div>
    </div>
  );
}
