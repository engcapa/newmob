import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bug,
  CirclePlay,
  Plug,
  RotateCcw,
} from "lucide-react";
import type { CodeDebugSession } from "../useCodeDebugSession";
import type { DebugStackFrame } from "../dapDebugModel";
import {
  useCodeWorkspaceStore,
  type DebugSubTabId,
} from "../../../../stores/codeWorkspaceStore";
import {
  configurationAvailabilityLabel,
  configurationSourceLabel,
  readDebugSplitLayout,
  writeDebugSplitLayout,
} from "./debug/debugPanelShared";
import { useDebugVariables } from "./debug/useDebugVariables";
import { DebugSubTabBar } from "./debug/DebugSubTabBar";
import { DebugFramesPane } from "./debug/DebugFramesPane";
import { DebugVariablesPane } from "./debug/DebugVariablesPane";
import { DebugConsolePane } from "./debug/DebugConsolePane";
import { DebugBreakpointsPane } from "./debug/DebugBreakpointsPane";
import { DebugMemoryPane } from "./debug/DebugMemoryPane";
import {
  Group as PanelGroup,
  Panel,
  Separator as PanelResizeHandle,
} from "react-resizable-panels";

/** localStorage key + panel ids for the Debugger tab's horizontal split. */
const DEBUG_HORIZONTAL_LAYOUT_KEY = "taomni.codeWorkspace.debugSplitHorizontal.v1";
const DEBUG_HORIZONTAL_PANEL_IDS = ["debug-frames", "debug-variables"];

export interface DebugPanelProps {
  debug: CodeDebugSession;
  /** Start debugging the active file (parent builds the launch config). */
  onStart: (() => void) | null;
  /** Attach to a remote JVM (IDEA "Remote JVM Debug"); null when unavailable. */
  onAttach?: (() => void) | null;
  /** Reveal a stack frame's source location. */
  onOpenFrame: (frame: DebugStackFrame) => void;
  /** Reveal a breakpoint's line from the breakpoints view. */
  onOpenBreakpoint?: (path: string, line: number) => void;
  /**
   * Breakpoint whose editor should be open (gutter right-click / Ctrl+Shift+F8
   * routes here instead of opening a chain of modal prompts).
   */
  editingBreakpoint?: { path: string; line: number } | null;
  onEditingBreakpointChange?: (target: { path: string; line: number } | null) => void;
  /**
   * False in the browser dev-preview, where the DAP backend is unavailable.
   * The panel then explains the desktop requirement instead of implying that
   * pressing start would work.
   */
  runtimeAvailable?: boolean;
  /** Run/Debug configurations associated with the active source file. */
  configurations?: Array<{
    id: string;
    label: string;
    source?: "provider" | "shared" | "local";
    /** False when the adapter/configuration cannot be launched on this host. */
    available?: boolean;
    /** Human-readable reason surfaced when `available` is false. */
    diagnostic?: string;
  }>;
  activeConfigurationId?: string | null;
  onActiveConfigurationChange?: (configurationId: string) => void;
  /** Workspace instance ID for tab state persistence */
  workspaceInstanceId?: string;
  /** Controlled sub tab override */
  activeSubTab?: DebugSubTabId;
  onSubTabChange?: (tab: DebugSubTabId) => void;
}

export function DebugPanel({
  debug,
  onStart,
  onAttach,
  onOpenFrame,
  onOpenBreakpoint,
  editingBreakpoint = null,
  onEditingBreakpointChange,
  runtimeAvailable = true,
  configurations = [],
  activeConfigurationId = null,
  onActiveConfigurationChange,
  workspaceInstanceId,
  activeSubTab,
  onSubTabChange,
}: DebugPanelProps) {
  const { state } = debug;
  const running = debug.sessions.length > 0
    ? debug.sessions.some((session) => session.status !== "terminated")
    : !!state && state.status !== "terminated";
  const activeRunning = !!state && state.status !== "terminated";
  const stopped = state?.status === "stopped";

  // Sub-tab persistence via codeWorkspaceStore
  const storeSubTab = useCodeWorkspaceStore((s) => (
    workspaceInstanceId ? s.byInstanceId[workspaceInstanceId]?.debugSubTab : undefined
  ));
  const patchInstance = useCodeWorkspaceStore((s) => s.patchInstance);
  const [localSubTab, setLocalSubTab] = useState<DebugSubTabId>("debugger");

  const currentTab = activeSubTab ?? (workspaceInstanceId ? (storeSubTab ?? "debugger") : localSubTab);

  const handleTabChange = (tab: DebugSubTabId) => {
    onSubTabChange?.(tab);
    if (workspaceInstanceId) {
      patchInstance(workspaceInstanceId, { debugSubTab: tab });
    } else {
      setLocalSubTab(tab);
    }
  };

  // If a breakpoint editor is requested to open, switch to the Breakpoints tab
  useEffect(() => {
    if (editingBreakpoint) {
      handleTabChange("breakpoints");
    }
  }, [editingBreakpoint]);

  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(800);
  const [compactDebuggerTab, setCompactDebuggerTab] = useState<"frames" | "variables">("frames");

  useEffect(() => {
    if (typeof ResizeObserver === "undefined" || !containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0) {
          setContainerWidth(entry.contentRect.width);
        }
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const isCompact = containerWidth < 640;

  const frameId = stopped ? state?.selectedFrameId ?? state?.frames[0]?.id ?? null : null;
  const variablesHook = useDebugVariables(debug, frameId, stopped);

  // Persisted frames/variables split ratio (read once; defaultLayout only
  // applies at mount).
  const horizontalLayout = useMemo(
    () => readDebugSplitLayout(DEBUG_HORIZONTAL_LAYOUT_KEY, DEBUG_HORIZONTAL_PANEL_IDS),
    [],
  );

  const activeConfiguration = configurations.find((configuration) => (
    configuration.id === (activeConfigurationId ?? configurations[0]?.id)
  )) ?? configurations[0] ?? null;

  const configurationDiagnostic = activeConfiguration && (
    activeConfiguration.diagnostic?.trim()
    || (activeConfiguration.available === false ? "Debug configuration is unavailable" : "")
  ) || null;

  const totalBreakpointsCount = Object.values(debug.breakpoints).reduce((sum, list) => sum + list.length, 0)
    + debug.functionBreakpoints.length
    + debug.instructionBreakpoints.length
    + debug.dataBreakpoints.length;

  const controlBtn = "h-7 w-7 inline-flex items-center justify-center rounded-md transition-colors disabled:opacity-30 disabled:pointer-events-none";

  const renderVariablesPane = () => (
    <DebugVariablesPane
      variables={variablesHook.displayedVariables}
      watchNodes={variablesHook.displayedWatchNodes}
      filterQuery={variablesHook.filterQuery}
      onFilterQueryChange={variablesHook.setFilterQuery}
      sortMode={variablesHook.sortMode}
      onToggleSortMode={() =>
        variablesHook.setSortMode((m) => (m === "natural" ? "alphabetical" : "natural"))
      }
      watchInput={variablesHook.watchInput}
      onWatchInputChange={variablesHook.setWatchInput}
      onAddWatch={variablesHook.addWatch}
      onRemoveWatch={variablesHook.removeWatch}
      edit={variablesHook.edit}
      onEditChange={(value) => variablesHook.setEdit((current) => ({ ...current, value }))}
      onEditSubmit={variablesHook.submitEdit}
      onEditCancel={variablesHook.cancelEdit}
      onStartEdit={variablesHook.startEdit}
      onExpandVariable={variablesHook.expandVariable}
      onExpandWatch={variablesHook.expandWatch}
      onAddDataBreakpoint={variablesHook.canAddDataBreakpoint ? variablesHook.addDataBreakpointForNode : undefined}
      addingDataBreakpointKey={variablesHook.addingDataBreakpointKey}
      dataBreakpointNotice={variablesHook.dataBreakpointNotice}
      onVariableContextMenu={variablesHook.handleVariableContextMenu}
      stopped={stopped}
      canSetVariable={variablesHook.canSetVariable}
      canAddDataBreakpoint={variablesHook.canAddDataBreakpoint}
      variableMenuRender={variablesHook.variableMenu.render}
    />
  );

  return (
    <div
      ref={containerRef}
      data-testid="code-workspace-debug-panel"
      className="h-full min-h-0 flex flex-col text-[11px] bg-[var(--taomni-code-bg)]"
    >
      {/* Sub-tab bar */}
      <DebugSubTabBar
        activeTab={currentTab}
        onTabChange={handleTabChange}
        badges={{
          breakpoints: totalBreakpointsCount > 0 ? totalBreakpointsCount : undefined,
          console: state?.output.length
            ? (state.output.length > 99 ? "99+" : state.output.length)
            : undefined,
        }}
        statusText={state ? `${state.status}${state.stoppedReason ? ` · ${state.stoppedReason}` : ""}` : null}
        trailing={
          isCompact && currentTab === "debugger" && state ? (
            <div className="flex items-center rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] p-0.5 text-[10px]">
              <button
                type="button"
                data-testid="debug-compact-tab-frames"
                onClick={() => setCompactDebuggerTab("frames")}
                className={`px-1.5 py-0.5 rounded transition-colors ${
                  compactDebuggerTab === "frames"
                    ? "bg-[var(--taomni-accent)]/20 text-[var(--taomni-accent)] font-semibold"
                    : "text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)]"
                }`}
              >
                Frames
              </button>
              <button
                type="button"
                data-testid="debug-compact-tab-variables"
                onClick={() => setCompactDebuggerTab("variables")}
                className={`px-1.5 py-0.5 rounded transition-colors ${
                  compactDebuggerTab === "variables"
                    ? "bg-[var(--taomni-accent)]/20 text-[var(--taomni-accent)] font-semibold"
                    : "text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)]"
                }`}
              >
                Variables
              </button>
            </div>
          ) : undefined
        }
      />

      {/* Debugger Sub-tab */}
      <div
        id="debug-panel-debugger"
        role="tabpanel"
        aria-labelledby="debug-subtab-debugger"
        className={`flex-1 min-h-0 flex flex-col ${currentTab === "debugger" ? "" : "hidden"}`}
      >
        {/* Configuration top bar when not running */}
        {!running && (
          <div className="h-8 shrink-0 flex items-center gap-1 border-b border-[var(--taomni-code-border)] px-2 bg-[var(--taomni-code-gutter-bg)]/30">
            <Bug className="h-4 w-4 text-[var(--taomni-text-muted)]" />
            <span className="font-medium">Debug</span>
            {configurations.length > 0 && (
              <select
                data-testid="debug-active-configuration"
                aria-label="Debug configuration"
                title="Select Run/Debug configuration"
                value={activeConfigurationId ?? configurations[0].id}
                onChange={(event) => onActiveConfigurationChange?.(event.target.value)}
                className="ml-2 h-6 min-w-0 max-w-52 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1 text-[10px]"
              >
                {configurations.map((configuration) => (
                  <option
                    key={configuration.id}
                    value={configuration.id}
                    data-configuration-available={configuration.available === false ? "false" : "true"}
                  >
                    {configuration.label} [{configurationSourceLabel(configuration.source)}]
                    {configurationAvailabilityLabel(configuration.available)}
                  </option>
                ))}
              </select>
            )}
            {configurationDiagnostic && (
              <div
                data-testid="debug-configuration-diagnostic"
                role="status"
                className="max-w-64 truncate text-[10px] text-amber-600 dark:text-amber-400"
                title={configurationDiagnostic}
              >
                {configurationDiagnostic}
              </div>
            )}
            <div className="ml-auto flex items-center gap-0.5 rounded-md border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] p-0.5 shadow-xs">
              <button
                type="button"
                data-testid="debug-start"
                className={`${controlBtn} hover:bg-emerald-500/15`}
                onClick={() => onStart?.()}
                disabled={!onStart}
                title="Start debugging the active file"
              >
                <CirclePlay className="h-4 w-4 text-emerald-500 dark:text-emerald-400" />
              </button>
              {onAttach && (
                <button
                  type="button"
                  data-testid="debug-attach"
                  className={`${controlBtn} hover:bg-sky-500/15`}
                  onClick={onAttach}
                  title="Attach to a remote JVM process"
                >
                  <Plug className="h-4 w-4 text-sky-500 dark:text-sky-400" />
                </button>
              )}
              {debug.canRestart && (
                <button
                  type="button"
                  data-testid="debug-restart"
                  className={`${controlBtn} hover:bg-emerald-500/15`}
                  onClick={() => debug.restart()}
                  title="Restart debug session"
                >
                  <RotateCcw className="h-4 w-4 text-emerald-500 dark:text-emerald-400" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Empty state when no session */}
        {!state ? (
          <div className="flex-1 min-h-0 overflow-auto p-4">
            <div className="text-[var(--taomni-text-muted)]" data-testid="debug-empty-state">
              {runtimeAvailable
                ? "No debug session. Open a Java file and press start (requires the java-debug bundle)."
                : "Java debugging runs in the desktop app only. Start Taomni with the desktop runtime (pnpm tauri dev) to debug; the browser preview has no debug adapter."}
            </div>
          </div>
        ) : isCompact ? (
          /* Compact mode (< 640px): single pane with segmented switch */
          <div className="flex-1 min-h-0 flex flex-col">
            {compactDebuggerTab === "frames" ? (
              <DebugFramesPane
                debug={debug}
                activeRunning={activeRunning}
                stopped={stopped}
                onOpenFrame={onOpenFrame}
              />
            ) : (
              renderVariablesPane()
            )}
          </div>
        ) : (
          /* Dual-column IDEA debugger layout (>= 640px) */
          <div className="flex-1 min-h-0">
            <PanelGroup
              orientation="horizontal"
              id="debug-layout-horizontal-v3"
              className="h-full min-h-0"
              defaultLayout={horizontalLayout}
              onLayoutChanged={(layout) => writeDebugSplitLayout(DEBUG_HORIZONTAL_LAYOUT_KEY, layout)}
            >
              {/* Left Column: Frames & Threads + Controls */}
              <Panel id="debug-frames" defaultSize="45%" minSize="15%" maxSize="85%" className="min-h-0 min-w-0">
                <DebugFramesPane
                  debug={debug}
                  activeRunning={activeRunning}
                  stopped={stopped}
                  onOpenFrame={onOpenFrame}
                />
              </Panel>

              {/* Resizable Divider */}
              <PanelResizeHandle className="w-[4px] bg-[var(--taomni-code-border)] hover:bg-[var(--taomni-accent)] active:bg-[var(--taomni-accent)] transition-colors cursor-col-resize shrink-0 relative after:absolute after:inset-y-0 after:-left-2 after:-right-2 after:z-20" />

              {/* Right Column: Variables & Watches */}
              <Panel id="debug-variables" defaultSize="55%" minSize="15%" className="min-h-0 min-w-0">
                {renderVariablesPane()}
              </Panel>
            </PanelGroup>
          </div>
        )}
      </div>

      {/* Console Sub-tab */}
      <div
        id="debug-panel-console"
        role="tabpanel"
        aria-labelledby="debug-subtab-console"
        className={`flex-1 min-h-0 flex flex-col ${currentTab === "console" ? "" : "hidden"}`}
      >
        <DebugConsolePane debug={debug} stopped={stopped} visible={currentTab === "console"} />
      </div>

      {/* Breakpoints Sub-tab */}
      <div
        id="debug-panel-breakpoints"
        role="tabpanel"
        aria-labelledby="debug-subtab-breakpoints"
        className={`flex-1 min-h-0 flex flex-col ${currentTab === "breakpoints" ? "" : "hidden"}`}
      >
        <DebugBreakpointsPane
          debug={debug}
          onOpenBreakpoint={onOpenBreakpoint}
          editingBreakpoint={editingBreakpoint}
          onEditingBreakpointChange={onEditingBreakpointChange}
          preferredDataBreakpointMode={variablesHook.preferredDataBreakpointMode}
          onPreferredDataBreakpointModeChange={variablesHook.setPreferredDataBreakpointMode}
        />
      </div>

      {/* Memory Sub-tab */}
      <div
        id="debug-panel-memory"
        role="tabpanel"
        aria-labelledby="debug-subtab-memory"
        className={`flex-1 min-h-0 flex flex-col ${currentTab === "memory" ? "" : "hidden"}`}
      >
        <DebugMemoryPane debug={debug} />
      </div>
    </div>
  );
}
