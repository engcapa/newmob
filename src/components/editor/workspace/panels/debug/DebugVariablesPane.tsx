import type React from "react";
import { useMemo } from "react";
import { ArrowUpDown, Search, X } from "lucide-react";
import {
  Group as PanelGroup,
  Panel,
  Separator as PanelResizeHandle,
} from "react-resizable-panels";
import { VariableRow } from "./VariableRow";
import {
  Empty,
  readDebugSplitLayout,
  writeDebugSplitLayout,
  type VarEditState,
  type VarNode,
} from "./debugPanelShared";

/** localStorage key + panel ids for the Variables/Watches vertical split. */
const DEBUG_VERTICAL_LAYOUT_KEY = "taomni.codeWorkspace.debugSplitVertical.v1";
const DEBUG_VERTICAL_PANEL_IDS = ["debug-variables-section", "debug-watches-section"];

export interface DebugVariablesPaneProps {
  variables: VarNode[];
  watchNodes: VarNode[];
  filterQuery?: string;
  onFilterQueryChange?: (value: string) => void;
  sortMode?: "natural" | "alphabetical";
  onToggleSortMode?: () => void;
  watchInput: string;
  onWatchInputChange: (value: string) => void;
  onAddWatch: () => void;
  onRemoveWatch: (index: number) => void;
  edit: VarEditState;
  onEditChange: (value: string) => void;
  onEditSubmit: () => void;
  onEditCancel: () => void;
  onStartEdit: (node: VarNode) => void;
  onExpandVariable: (node: VarNode) => void;
  onExpandWatch: (node: VarNode) => void;
  onAddDataBreakpoint?: (node: VarNode) => void;
  addingDataBreakpointKey?: string | null;
  dataBreakpointNotice?: { added: boolean; message: string } | null;
  onVariableContextMenu: (e: React.MouseEvent, node: VarNode, onRemove?: () => void) => void;
  stopped: boolean;
  canSetVariable: boolean;
  canAddDataBreakpoint: boolean;
  variableMenuRender?: React.ReactNode;
}

export function DebugVariablesPane({
  variables,
  watchNodes,
  filterQuery = "",
  onFilterQueryChange,
  sortMode = "natural",
  onToggleSortMode,
  watchInput,
  onWatchInputChange,
  onAddWatch,
  onRemoveWatch,
  edit,
  onEditChange,
  onEditSubmit,
  onEditCancel,
  onStartEdit,
  onExpandVariable,
  onExpandWatch,
  onAddDataBreakpoint,
  addingDataBreakpointKey,
  dataBreakpointNotice,
  onVariableContextMenu,
  stopped,
  canSetVariable,
  canAddDataBreakpoint,
  variableMenuRender,
}: DebugVariablesPaneProps) {
  const verticalLayout = useMemo(
    () => readDebugSplitLayout(DEBUG_VERTICAL_LAYOUT_KEY, DEBUG_VERTICAL_PANEL_IDS),
    [],
  );
  return (
    <div
      data-testid="debug-variables-pane"
      className="h-full min-h-0 flex flex-col bg-[var(--taomni-code-bg)] text-[11px]"
    >
      <PanelGroup
        orientation="vertical"
        id="debug-variables-split-v2"
        className="flex-1 min-h-0"
        defaultLayout={verticalLayout}
        onLayoutChanged={(layout) => writeDebugSplitLayout(DEBUG_VERTICAL_LAYOUT_KEY, layout)}
      >
        {/* Variables Section */}
        <Panel id="debug-variables-section" defaultSize="60%" minSize="20%" className="flex flex-col min-h-0 min-w-0">
          <div className="h-6 shrink-0 flex items-center justify-between border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)]/40 px-2 font-medium text-[10px] text-[var(--taomni-text-muted)]">
            <div className="flex items-center gap-1.5 min-w-0">
              <span>Variables</span>
              <span className="text-[9px] tabular-nums">{variables.length}</span>
            </div>
            <div className="flex items-center gap-1">
              {onFilterQueryChange && (
                <div className="flex items-center gap-0.5 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1 py-0.5">
                  <Search className="h-2.5 w-2.5 text-[var(--taomni-text-muted)] shrink-0" />
                  <input
                    data-testid="debug-variables-search"
                    className="w-16 sm:w-24 bg-transparent text-[10px] outline-none"
                    placeholder="Filter..."
                    value={filterQuery}
                    onChange={(e) => onFilterQueryChange(e.target.value)}
                  />
                  {filterQuery && (
                    <button
                      type="button"
                      onClick={() => onFilterQueryChange("")}
                      className="text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)]"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  )}
                </div>
              )}
              {onToggleSortMode && (
                <button
                  type="button"
                  data-testid="debug-variables-sort"
                  onClick={onToggleSortMode}
                  className={`h-4 px-1 rounded flex items-center gap-0.5 text-[9px] transition-colors ${
                    sortMode === "alphabetical"
                      ? "bg-[var(--taomni-accent)]/20 text-[var(--taomni-accent)] font-semibold"
                      : "text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)]"
                  }`}
                  title={`Sort: ${sortMode === "alphabetical" ? "A-Z (Alphabetical)" : "Natural (Declaration)"}`}
                >
                  <ArrowUpDown className="h-2.5 w-2.5" />
                  <span>{sortMode === "alphabetical" ? "A-Z" : "Natural"}</span>
                </button>
              )}
            </div>
          </div>
          <div className="flex-1 min-h-0 overflow-auto py-1">
            {variables.length === 0 ? (
              <Empty text={stopped ? "No variables" : "Stopped only"} />
            ) : (
              variables.map((node, i) => (
                <VariableRow
                  key={`${node.name}:${i}`}
                  node={node}
                  depth={0}
                  onExpand={onExpandVariable}
                  onStartEdit={canSetVariable && stopped ? onStartEdit : undefined}
                  edit={edit}
                  onEditChange={onEditChange}
                  onEditSubmit={onEditSubmit}
                  onEditCancel={onEditCancel}
                  onAddDataBreakpoint={canAddDataBreakpoint ? onAddDataBreakpoint : undefined}
                  addingDataBreakpointKey={addingDataBreakpointKey}
                  onContextMenu={onVariableContextMenu}
                />
              ))
            )}
            {dataBreakpointNotice && (
              <div
                data-testid="debug-data-breakpoint-notice"
                role="status"
                className={`px-3 py-1 text-[10px] ${
                  dataBreakpointNotice.added ? "text-emerald-500" : "text-rose-500"
                }`}
              >
                {dataBreakpointNotice.message}
              </div>
            )}
          </div>
        </Panel>

        {/* Resizable Divider */}
        <PanelResizeHandle className="h-[4px] bg-[var(--taomni-code-border)] hover:bg-[var(--taomni-accent)] active:bg-[var(--taomni-accent)] transition-colors cursor-row-resize shrink-0 relative after:absolute after:inset-x-0 after:-top-2 after:-bottom-2 after:z-20" />

        {/* Watches Section */}
        <Panel id="debug-watches-section" defaultSize="40%" minSize="20%" className="flex flex-col min-h-0 min-w-0">
          <div className="h-6 shrink-0 flex items-center justify-between border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)]/40 px-2 font-medium text-[10px] text-[var(--taomni-text-muted)]">
            <span>Watches</span>
            <span className="text-[9px] tabular-nums">{watchNodes.length}</span>
          </div>
          <div className="flex items-center gap-1 px-2 py-1 border-b border-[var(--taomni-code-border)]/40 shrink-0">
            <input
              data-testid="debug-watch-input"
              className="min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-0.5 font-mono text-[11px] outline-none"
              placeholder="+ Add watch expression"
              value={watchInput}
              onChange={(e) => onWatchInputChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onAddWatch();
              }}
            />
          </div>
          <div className="flex-1 min-h-0 overflow-auto py-1">
            {watchNodes.length === 0 ? (
              <Empty text="No watches" />
            ) : (
              watchNodes.map((node, i) => (
                <VariableRow
                  key={`${node.name}:${i}`}
                  node={node}
                  depth={0}
                  onExpand={onExpandWatch}
                  onRemove={() => onRemoveWatch(i)}
                  onAddDataBreakpoint={canAddDataBreakpoint ? onAddDataBreakpoint : undefined}
                  addingDataBreakpointKey={addingDataBreakpointKey}
                  onContextMenu={onVariableContextMenu}
                />
              ))
            )}
          </div>
        </Panel>
      </PanelGroup>

      {variableMenuRender}
    </div>
  );
}
