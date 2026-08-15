import { useCallback } from "react";
import { Circle, File } from "lucide-react";
import { QuickPickOverlay } from "./QuickPickOverlay";
import { rankFuzzy } from "./fuzzyMatch";
import type { CodeWorkspaceFileRef } from "../../../types";

export interface RecentFileEntry {
  key: string;
  ref: CodeWorkspaceFileRef;
  title: string;
  subtitle: string;
  open: boolean;
}

interface RecentFilesPopupProps {
  open: boolean;
  entries: RecentFileEntry[];
  /** Bump while open to advance the selection (repeated Ctrl+E). */
  advanceNonce?: number;
  changedOnly?: boolean;
  onClose: () => void;
  onPick: (entry: RecentFileEntry) => void;
}

const MAX_RESULTS = 50;

export function RecentFilesPopup({
  open,
  entries,
  advanceNonce,
  changedOnly = false,
  onClose,
  onPick,
}: RecentFilesPopupProps) {
  const filterItems = useCallback(
    (query: string, all: RecentFileEntry[]) =>
      query.trim()
        ? rankFuzzy(query, all, (entry) => entry.subtitle, MAX_RESULTS)
        // No query: keep most-recent-first order instead of fuzzy ranking.
        : all.slice(0, MAX_RESULTS),
    [],
  );

  return (
    <QuickPickOverlay
      open={open}
      testId="code-workspace-recent-files"
      inputLabel={changedOnly ? "Recently changed files" : "Recent files"}
      placeholder={changedOnly ? "Recently changed files (type to filter)" : "Recent files (type to filter)"}
      items={entries}
      // Preselect the previous file so Ctrl+E, Enter flips back to it.
      initialIndex={entries.length > 1 ? 1 : 0}
      advanceNonce={advanceNonce}
      filterItems={filterItems}
      itemKey={(entry) => entry.key}
      renderItem={(entry) => (
        <>
          <File className="h-3.5 w-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
          <span className="shrink-0 text-[var(--taomni-code-text)]">{entry.title}</span>
          <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--taomni-code-muted)]">
            {entry.subtitle}
          </span>
          {entry.open && (
            <Circle
              aria-label="Open in editor"
              className="h-2 w-2 shrink-0 fill-[var(--taomni-accent)] text-[var(--taomni-accent)]"
            />
          )}
        </>
      )}
      emptyText={(query) =>
        query
          ? "No matching recent files"
          : changedOnly
            ? "No recently changed files"
            : "No recent files yet"
      }
      footer={
        <>
          <span>↑↓ select</span>
          <span>Enter open</span>
          <span>{changedOnly ? "Ctrl+Shift+E" : "Ctrl+E"} next</span>
          <span>Esc close</span>
          <span className="ml-auto">
            {entries.length} {changedOnly ? "changed" : "recent"} file{entries.length === 1 ? "" : "s"}
          </span>
        </>
      }
      onClose={onClose}
      onPick={onPick}
    />
  );
}
