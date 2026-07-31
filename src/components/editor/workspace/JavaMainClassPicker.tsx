import { useCallback } from "react";
import { Play } from "lucide-react";
import { QuickPickOverlay } from "./QuickPickOverlay";
import { rankFuzzy } from "./fuzzyMatch";
import type { JavaMainClassOption } from "../../../lib/editor/dap";

interface JavaMainClassPickerProps {
  open: boolean;
  candidates: JavaMainClassOption[];
  onClose: () => void;
  onPick: (main: JavaMainClassOption) => void;
}

const MAX_RESULTS = 200;

/**
 * Searchable picker over runnable Java main classes (IDEA's run-configuration
 * chooser). Shown only when the active file does not uniquely resolve a main —
 * so a debug launch never silently runs an arbitrary workspace main.
 */
export function JavaMainClassPicker({ open, candidates, onClose, onPick }: JavaMainClassPickerProps) {
  const filterItems = useCallback(
    (query: string, all: JavaMainClassOption[]) =>
      query.trim()
        ? rankFuzzy(query, all, (item) => `${item.mainClass} ${item.projectName}`, MAX_RESULTS)
        : all.slice(0, MAX_RESULTS),
    [],
  );

  return (
    <QuickPickOverlay
      open={open}
      testId="code-workspace-java-main-picker"
      inputLabel="Select a main class to debug"
      placeholder="Select a main class to debug (type to filter)"
      items={candidates}
      filterItems={filterItems}
      itemKey={(item) => `${item.projectName}:${item.mainClass}`}
      renderItem={(item) => (
        <>
          <Play className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
          <span className="shrink-0 text-[var(--taomni-code-text)]">
            {item.mainClass.split(".").pop() ?? item.mainClass}
          </span>
          <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--taomni-code-muted)]">
            {item.mainClass}{item.projectName ? ` · ${item.projectName}` : ""}
          </span>
        </>
      )}
      emptyText={(query) => (query ? "No matching main class" : "No runnable main classes")}
      footer={
        <>
          <span>↑↓ select</span>
          <span>Enter debug</span>
          <span>Esc cancel</span>
          <span className="ml-auto">
            {candidates.length} main class{candidates.length === 1 ? "" : "es"}
          </span>
        </>
      }
      onClose={onClose}
      onPick={onPick}
    />
  );
}
