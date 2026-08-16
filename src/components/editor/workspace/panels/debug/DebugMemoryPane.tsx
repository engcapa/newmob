import type { CodeDebugSession } from "../../useCodeDebugSession";
import { MemoryDisassemblyView } from "./MemoryDisassemblyView";

export interface DebugMemoryPaneProps {
  debug: CodeDebugSession;
}

export function DebugMemoryPane({ debug }: DebugMemoryPaneProps) {
  return (
    <div
      data-testid="debug-memory-pane"
      className="h-full min-h-0 flex flex-col bg-[var(--taomni-code-bg)] text-[11px] overflow-auto"
    >
      <MemoryDisassemblyView debug={debug} />
    </div>
  );
}
