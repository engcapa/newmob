import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  AlertTriangle,
  Ban,
  ChevronDown,
  ChevronRight,
  Clock,
  Crosshair,
  HelpCircle,
  Loader2,
  Play,
  Plus,
  SquareDashedMousePointer,
  Trash2,
  X,
} from "lucide-react";
import {
  Group as PanelGroup,
  Panel,
  Separator as PanelResizeHandle,
  type PanelImperativeHandle,
  type PanelSize,
} from "react-resizable-panels";
import type { HBaseConnectInfo } from "../../types";
import { loadResizableLayout, saveResizableLayout } from "../../lib/resizableLayout";
import { hbaseStatementRangeAt, splitHBaseStatements } from "../../lib/hbaseStatements";
import {
  displaySqlShortcut,
  loadSqlExecutionPreferences,
  subscribeSqlExecutionPreferences,
} from "../../lib/sqlExecutionPreferences";
import {
  HBASE_COMMANDS,
  commandSupported,
  hbaseResultToGrid,
  writeConfirmMessage,
  type HBaseCommandCategory,
  type HBaseTransport,
} from "../../lib/hbaseCommands";
import { hbaseCompletionSource } from "../../lib/hbaseCompletions";
import {
  hbaseConnect,
  hbaseDisconnect,
  hbaseExecute,
  hbaseCancel,
  type DbQueryResult,
} from "../../lib/ipc";
import { useAppStore } from "../../stores/appStore";
import { useT } from "../../lib/i18n";
import { useConfirmDialog } from "../sidebar/ConfirmDialog";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import {
  QueryResultGrid,
  type QueryRefreshMode,
} from "./QueryResultGrid";
import { SqlEditorPanel, type SqlEditorHandle } from "./SqlEditorPanel";
import { HBaseSchemaTree } from "./HBaseSchemaTree";
import { useDbSessionFontSize } from "./useDbSessionFontSize";

interface HBaseShellTabProps {
  tabId: string;
  info: HBaseConnectInfo;
  visible: boolean;
}

const MAX_PANELS = 4;
const MAX_HISTORY = 200;
const MAX_RESULT_SHEETS = 50;
const DEFAULT_ROW_LIMIT = 50;

type ResultSubTab = "results" | "messages";

interface ResultSheet {
  id: string;
  title: string;
  command: string;
  result: DbQueryResult | null;
  error: string | null;
  warnings: string[];
  running: boolean;
  cancelling: boolean;
  elapsedMs: number;
  resultTab: ResultSubTab;
  createdAt: number;
}

interface PanelState {
  id: string;
  doc: string;
  sheets: ResultSheet[];
  activeSheetId: string | null;
}

function uid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createRuntimeHBaseSessionId(baseSessionId: string): string {
  return `${baseSessionId}::${uid()}`;
}

function newSheet(command: string, ordinal: number): ResultSheet {
  return {
    id: uid(),
    title: `Result ${ordinal}`,
    command,
    result: null,
    error: null,
    warnings: [],
    running: true,
    cancelling: false,
    elapsedMs: 0,
    resultTab: "results",
    createdAt: Date.now(),
  };
}

function newPanel(doc = "list"): PanelState {
  return { id: uid(), doc, sheets: [], activeSheetId: null };
}

function activeSheet(panel: PanelState): ResultSheet | null {
  return panel.sheets.find((s) => s.id === panel.activeSheetId) ?? null;
}

// PLACEHOLDER_REST
function ResultArea({
  panel,
  onSheetSelect,
  onSheetClose,
  onCloseSheets,
  onTabChange,
  onRefreshSheet,
  onCancel,
  onStatus,
}: {
  panel: PanelState;
  onSheetSelect: (sheetId: string) => void;
  onSheetClose: (sheetId: string) => void;
  onCloseSheets: (sheetIds: string[]) => void;
  onTabChange: (sheetId: string, tab: ResultSubTab) => void;
  onRefreshSheet: (sheetId: string, mode: QueryRefreshMode) => void;
  onCancel: () => void;
  onStatus: (message: string) => void;
}) {
  const t = useT();
  const sheetMenu = useContextMenu();
  const sheet = activeSheet(panel);
  const tab = "h-6 px-3 text-[11px] inline-flex items-center";

  const openSheetMenu = (event: ReactMouseEvent, sheetId: string) => {
    const idx = panel.sheets.findIndex((candidate) => candidate.id === sheetId);
    if (idx < 0) return;
    const isFirst = idx === 0;
    const isLast = idx === panel.sheets.length - 1;
    const onlyOne = panel.sheets.length <= 1;
    const items: MenuItem[] = [
      {
        label: t("tabs.close"),
        testId: "result-sheet-close",
        icon: <X className="w-3 h-3" />,
        onClick: () => onSheetClose(sheetId),
      },
      {
        label: t("tabs.closeOthersShort"),
        testId: "result-sheet-close-others",
        icon: <Trash2 className="w-3 h-3" />,
        onClick: () =>
          onCloseSheets(panel.sheets.filter((candidate) => candidate.id !== sheetId).map((candidate) => candidate.id)),
        disabled: onlyOne,
      },
      {
        label: t("tabs.closeLeftShort"),
        testId: "result-sheet-close-left",
        icon: <Trash2 className="w-3 h-3" />,
        onClick: () => onCloseSheets(panel.sheets.slice(0, idx).map((candidate) => candidate.id)),
        disabled: isFirst,
      },
      {
        label: t("tabs.closeRightShort"),
        testId: "result-sheet-close-right",
        icon: <Trash2 className="w-3 h-3" />,
        onClick: () => onCloseSheets(panel.sheets.slice(idx + 1).map((candidate) => candidate.id)),
        disabled: isLast,
      },
      {
        label: t("tabs.closeAll"),
        testId: "result-sheet-close-all",
        icon: <Trash2 className="w-3 h-3" />,
        onClick: () => onCloseSheets(panel.sheets.map((candidate) => candidate.id)),
      },
    ];
    sheetMenu.show(event, items);
  };

  return (
    <div className="h-full flex flex-col min-h-0" style={{ background: "var(--taomni-bg)", fontSize: "var(--taomni-db-font-size, 12px)" }}>
      {sheetMenu.render}
      <div className="h-7 shrink-0 flex items-end gap-1 px-1 overflow-hidden" style={{ background: "var(--taomni-chrome-bg)", borderBottom: "1px solid var(--taomni-divider)" }}>
        {panel.sheets.length === 0 ? (
          <span className="px-2 pb-1 text-[11px] text-[var(--taomni-text-muted)]">Result sheets</span>
        ) : (
          panel.sheets.map((rs) => {
            const active = rs.id === sheet?.id;
            return (
              <button
                key={rs.id}
                type="button"
                data-testid="result-sheet-tab"
                data-sheet-id={rs.id}
                className="h-6 max-w-[170px] px-2 inline-flex items-center gap-1 text-[11px]"
                style={{
                  background: active ? "var(--taomni-tab-active)" : "var(--taomni-tab-inactive)",
                  color: active ? "var(--taomni-accent)" : "var(--taomni-text-muted)",
                  border: "1px solid var(--taomni-tab-border)",
                  borderBottom: active ? "1px solid var(--taomni-tab-active)" : "1px solid var(--taomni-divider)",
                  borderTopLeftRadius: 4,
                  borderTopRightRadius: 4,
                }}
                onClick={() => onSheetSelect(rs.id)}
                onContextMenu={(event) => openSheetMenu(event, rs.id)}
                title={rs.command}
              >
                <span className="truncate">{rs.title}</span>
                {rs.running && <Loader2 className="w-3 h-3 shrink-0 animate-spin" />}
                {(rs.error || rs.warnings.length > 0) && <span className="text-[10px] shrink-0">●</span>}
                <X className="w-3 h-3 shrink-0 hover:text-[var(--taomni-text)]" onClick={(e) => { e.stopPropagation(); onSheetClose(rs.id); }} />
              </button>
            );
          })
        )}
      </div>
      {sheet && (
        <div className="h-7 shrink-0 flex items-center gap-1 px-1" style={{ borderBottom: "1px solid var(--taomni-divider)" }}>
          <button type="button" className={tab} style={{ color: sheet.resultTab === "results" ? "var(--taomni-accent)" : "var(--taomni-text-muted)" }} onClick={() => onTabChange(sheet.id, "results")}>Results</button>
          <button type="button" className={tab} style={{ color: sheet.resultTab === "messages" ? "var(--taomni-accent)" : "var(--taomni-text-muted)" }} onClick={() => onTabChange(sheet.id, "messages")}>
            Messages{(sheet.error || sheet.warnings.length > 0) ? " ●" : ""}
          </button>
          <span className="ml-auto truncate px-2 text-[10px] text-[var(--taomni-text-muted)] font-mono" title={sheet.command}>{sheet.command.replace(/\s+/g, " ")}</span>
        </div>
      )}
      <div className="flex-1 min-h-0 flex flex-col">
        {!sheet ? (
          <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">Run a command to create a result sheet.</div>
        ) : sheet.resultTab === "results" ? (
          sheet.result ? (
            <div className={`flex-1 min-h-0 flex flex-col ${sheet.cancelling ? "opacity-50 pointer-events-none" : ""}`}>
              <QueryResultGrid
                result={sheet.result}
                sourceSql={sheet.command}
                running={sheet.running}
                cancelling={sheet.cancelling}
                onRefresh={(mode) => onRefreshSheet(sheet.id, mode)}
                onCancel={onCancel}
                onStatus={onStatus}
              />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">{sheet.running ? "Running…" : sheet.error ? "See Messages." : "No result."}</div>
          )
        ) : (
          <div className="flex-1 overflow-auto taomni-scroll-y p-2 text-[12px] font-mono" style={{ fontSize: "var(--taomni-db-font-size, 12px)" }}>
            {sheet.error && <div style={{ color: "#d9534f" }}>{sheet.error}</div>}
            {sheet.warnings.map((w, i) => (<div key={i} style={{ color: "#e6a817" }}>{w}</div>))}
            {!sheet.error && sheet.warnings.length === 0 && <div className="text-[var(--taomni-text-muted)]">{sheet.result?.rowsAffected != null ? sheet.command : "No messages."}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBar({ panel }: { panel: PanelState }) {
  const sheet = activeSheet(panel);
  const r = sheet?.result ?? null;
  return (
    <div className="h-6 shrink-0 flex items-center gap-3 px-2 text-[11px] text-[var(--taomni-text-muted)]" style={{ background: "var(--taomni-quick-bg)", borderTop: "1px solid var(--taomni-divider)" }}>
      {sheet?.running ? (
        <span className="inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> {sheet.cancelling ? "Cancelling" : "Running"} {(sheet.elapsedMs / 1000).toFixed(1)}s</span>
      ) : r ? (
        <>
          {r.columns.length > 0 && <span>{r.rows.length} rows</span>}
          {r.columns.length > 0 && <span>{r.columns.length} cols</span>}
          <span>{r.durationMs} ms</span>
        </>
      ) : (
        <span>{panel.sheets.length} result sheet(s)</span>
      )}
    </div>
  );
}

// PLACEHOLDER_MENU
const CATEGORY_ORDER: HBaseCommandCategory[] = ["meta", "read", "ddl", "dml"];
const CATEGORY_LABEL: Record<HBaseCommandCategory, string> = {
  meta: "Meta",
  read: "Read",
  ddl: "DDL (tables)",
  dml: "DML (cells)",
};

function CommandsMenu({
  transport,
  onPick,
  onClose,
}: {
  transport: HBaseTransport;
  onPick: (example: string) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="absolute left-2 top-9 z-50 w-[360px] max-w-[calc(100vw-24px)] max-h-[min(420px,calc(100vh-48px))] overflow-auto taomni-scroll-y rounded shadow-lg py-1 text-[12px]"
        style={{ background: "var(--taomni-panel-bg)", border: "1px solid var(--taomni-divider)", color: "var(--taomni-text)" }}
      >
        {CATEGORY_ORDER.map((cat) => {
          const cmds = HBASE_COMMANDS.filter((c) => c.category === cat);
          if (cmds.length === 0) return null;
          return (
            <div key={cat}>
              <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-[var(--taomni-text-muted)]">{CATEGORY_LABEL[cat]}</div>
              {cmds.map((c) => {
                const supported = commandSupported(c.verb, transport);
                return (
                  <button
                    key={c.verb}
                    type="button"
                    disabled={!supported}
                    className="w-full text-left px-3 py-1.5 hover:bg-[var(--taomni-hover)] disabled:opacity-40 flex flex-col gap-0.5"
                    title={supported ? c.description : `${c.description} (not available on the ${transport} transport)`}
                    onClick={() => { onPick(c.example); onClose(); }}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="taomni-mono font-semibold">{c.verb}</span>
                      {c.isWrite && <span className="text-[9px] rounded px-1" style={{ background: "var(--taomni-divider)", color: c.destructive ? "#d9534f" : "var(--taomni-text-muted)" }}>{c.destructive ? "destructive" : "write"}</span>}
                      {!supported && <span className="text-[9px] text-[var(--taomni-text-muted)]">unsupported</span>}
                    </span>
                    <span className="taomni-mono text-[10px] text-[var(--taomni-text-muted)] truncate">{c.example}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </>
  );
}

function HistoryDropdown({ history, onPick, onClose }: { history: string[]; onPick: (cmd: string) => void; onClose: () => void }) {
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute right-2 top-9 z-50 w-[420px] max-w-[calc(100vw-24px)] max-h-[min(300px,calc(100vh-48px))] overflow-auto rounded shadow-lg taomni-scroll-y flex flex-col" style={{ background: "var(--taomni-panel-bg)", border: "1px solid var(--taomni-divider)" }}>
        {history.length === 0 ? (
          <div className="px-3 py-2 text-[11px] text-[var(--taomni-text-muted)]">No command history yet.</div>
        ) : (
          history.map((cmd, i) => (
            <button key={i} type="button" className="text-left px-3 py-2 text-[11px] truncate font-mono hover:bg-[var(--taomni-hover)] border-b border-[var(--taomni-divider)] last:border-0" onClick={() => onPick(cmd)} title={cmd}>
              {cmd.replace(/\s+/g, " ")}
            </button>
          ))
        )}
      </div>
    </>
  );
}

function HelpDialog({ transport, onClose }: { transport: HBaseTransport; onClose: () => void }) {
  const t = useT();
  return (
    <div className="fixed inset-0 z-[950] flex items-center justify-center" style={{ background: "rgba(0,0,0,0.4)" }} onClick={onClose}>
      <div
        role="dialog"
        aria-label={t("hbaseObjects.helpTitle")}
        aria-modal="true"
        data-testid="hbase-help-dialog"
        className="w-[640px] max-w-[calc(100vw-24px)] max-h-[calc(100vh-24px)] overflow-auto taomni-scroll-y rounded shadow-lg p-4"
        style={{ background: "var(--taomni-bg)", border: "1px solid var(--taomni-card-border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center mb-3">
          <div className="text-sm font-semibold flex-1">{t("hbaseObjects.helpTitle")}</div>
          <button type="button" className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]" onClick={onClose} aria-label={t("hbaseObjects.helpClose")}>
            <X className="w-4 h-4" />
          </button>
        </div>
        {CATEGORY_ORDER.map((cat) => {
          const cmds = HBASE_COMMANDS.filter((c) => c.category === cat);
          return (
            <div key={cat} className="mb-3">
              <div className="text-[10px] uppercase tracking-wide text-[var(--taomni-text-muted)] mb-1">{CATEGORY_LABEL[cat]}</div>
              <table className="w-full text-[12px] border-collapse">
                <tbody>
                  {cmds.map((c) => {
                    const supported = commandSupported(c.verb, transport);
                    return (
                      <tr key={c.verb} className="border-b" style={{ borderColor: "var(--taomni-divider)", opacity: supported ? 1 : 0.55 }}>
                        <td className="py-1 pr-2 align-top taomni-mono font-semibold whitespace-nowrap">{c.verb}</td>
                        <td className="py-1 pr-2 align-top taomni-mono text-[11px] text-[var(--taomni-text-muted)]">{c.syntax}</td>
                        <td className="py-1 align-top text-[11px]">
                          {c.description}
                          {!supported && <div className="text-[10px]" style={{ color: "#d9534f" }}>{t("hbaseObjects.helpRestNote")}</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function HBaseShellTab({ tabId, info, visible }: HBaseShellTabProps) {
  const t = useT();
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);
  const setTabHasNewOutput = useAppStore((s) => s.setTabHasNewOutput);
  const confirmDialog = useConfirmDialog();
  const rootRef = useRef<HTMLDivElement | null>(null);
  useDbSessionFontSize(visible, rootRef);

  const transport: HBaseTransport = (info.connectionMode as HBaseTransport) ?? "rest";

  const [connectionSessionId, setConnectionSessionId] = useState<string | null>(null);
  const [connError, setConnError] = useState<string | null>(null);
  const [hasBeenVisible, setHasBeenVisible] = useState(false);

  // --- workspace state (restored from localStorage) ---
  const workspaceKey = `taomni.hbase.workspace.v1.${info.sessionId}`;
  const [panels, setPanels] = useState<PanelState[]>(() => {
    try {
      const raw = localStorage.getItem(workspaceKey);
      if (raw) {
        const parsed = JSON.parse(raw) as { docs?: string[] };
        if (Array.isArray(parsed.docs) && parsed.docs.length > 0) {
          return parsed.docs.slice(0, MAX_PANELS).map((doc) => newPanel(doc));
        }
      }
    } catch {
      /* ignore */
    }
    return [newPanel("list")];
  });
  const [activePanelId, setActivePanelId] = useState<string>(() => panels[0]?.id ?? "");
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [schemaMap, setSchemaMap] = useState<Record<string, string[]>>({});
  const [showCommands, setShowCommands] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [executionPreferences, setExecutionPreferences] = useState(loadSqlExecutionPreferences);

  const editorHandles = useRef<Record<string, SqlEditorHandle | null>>({});
  const historyRef = useRef<Record<string, string[]>>({});

  useEffect(
    () => subscribeSqlExecutionPreferences(setExecutionPreferences),
    [],
  );

  const activePanel = useMemo(
    () => panels.find((p) => p.id === activePanelId) ?? panels[0],
    [panels, activePanelId],
  );

  // Persist panel docs + active panel for restore-on-mount.
  useEffect(() => {
    try {
      localStorage.setItem(workspaceKey, JSON.stringify({ docs: panels.map((p) => p.doc) }));
    } catch {
      /* ignore quota */
    }
  }, [panels, workspaceKey]);

  useEffect(() => {
    if (visible) setHasBeenVisible(true);
  }, [visible]);

  // --- connection lifecycle ---
  useEffect(() => {
    let cancelled = false;
    const runtimeSessionId = createRuntimeHBaseSessionId(info.sessionId);
    setConnectionSessionId(null);
    setConnError(null);
    void hbaseConnect({ ...info, sessionId: runtimeSessionId })
      .then(() => {
        if (cancelled) {
          void hbaseDisconnect(runtimeSessionId).catch(() => undefined);
          return;
        }
        setConnectionSessionId(runtimeSessionId);
      })
      .catch((err) => {
        if (!cancelled) setConnError(String(err));
      });
    return () => {
      cancelled = true;
      void hbaseDisconnect(runtimeSessionId).catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.sessionId]);

  const anyRunning = panels.some((p) => p.sheets.some((s) => s.running));
  useEffect(() => {
    setTabHasNewOutput(tabId, anyRunning && !visible);
  }, [anyRunning, tabId, visible, setTabHasNewOutput]);

  // --- state patch helpers ---
  const patchPanel = useCallback((id: string, patch: Partial<PanelState>) => {
    setPanels((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);
  const patchSheet = useCallback((panelId: string, sheetId: string, patch: Partial<ResultSheet>) => {
    setPanels((prev) =>
      prev.map((p) =>
        p.id !== panelId ? p : { ...p, sheets: p.sheets.map((s) => (s.id === sheetId ? { ...s, ...patch } : s)) },
      ),
    );
  }, []);

  // EXEC_PLACEHOLDER
  // Forced confirmation before any write command (editor- or tree-initiated).
  const confirmWrite = useCallback(
    async (statement: string): Promise<boolean> => {
      const built = writeConfirmMessage(statement, {
        write: t("hbaseObjects.writeWarning"),
        destructive: t("hbaseObjects.destructiveWarning"),
      });
      if (!built) return true;
      return confirmDialog.confirm({
        title: t("hbaseObjects.confirmWriteTitle"),
        message: built.message,
        confirmLabel: t("hbaseObjects.confirmRun"),
        danger: built.danger,
      });
    },
    [confirmDialog, t],
  );

  const executeIntoSheet = useCallback(
    async (panelId: string, sheetId: string, command: string): Promise<boolean> => {
      if (!connectionSessionId) return false;
      patchSheet(panelId, sheetId, { running: true, cancelling: false, error: null, elapsedMs: 0 });
      const started = Date.now();
      const timer = window.setInterval(() => patchSheet(panelId, sheetId, { elapsedMs: Date.now() - started }), 100);
      try {
        const res = await hbaseExecute(connectionSessionId, command);
        patchSheet(panelId, sheetId, {
          result: hbaseResultToGrid(res),
          warnings: res.warnings ?? [],
          running: false,
          error: null,
          command: res.command || command,
          elapsedMs: Date.now() - started,
        });
        return true;
      } catch (err) {
        patchSheet(panelId, sheetId, {
          error: String(err),
          running: false,
          resultTab: "messages",
          elapsedMs: Date.now() - started,
        });
        return false;
      } finally {
        window.clearInterval(timer);
      }
    },
    [connectionSessionId, patchSheet],
  );

  const runStatements = useCallback(
    async (panelId: string, text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !connectionSessionId) return;
      const panel = panels.find((p) => p.id === panelId);
      if (panel?.sheets.some((s) => s.running)) return;
      const statements = splitHBaseStatements(trimmed);
      if (statements.length === 0) return;
      const h = historyRef.current[panelId] ?? [];
      if (h[0] !== trimmed) historyRef.current[panelId] = [trimmed, ...h].slice(0, MAX_HISTORY);

      let mutated = false;
      let ordinal = panel?.sheets.length ?? 0;
      for (const statement of statements) {
        const ok = await confirmWrite(statement);
        if (!ok) break;
        ordinal += 1;
        const sheet = newSheet(statement, ordinal);
        setPanels((prev) =>
          prev.map((p) =>
            p.id !== panelId ? p : { ...p, sheets: [...p.sheets, sheet].slice(-MAX_RESULT_SHEETS), activeSheetId: sheet.id },
          ),
        );
        const success = await executeIntoSheet(panelId, sheet.id, statement);
        if (/^(create|drop|enable|disable|alter)\b/i.test(statement)) mutated = true;
        if (!success) break;
      }
      if (mutated) setRefreshSignal((s) => s + 1);
    },
    [connectionSessionId, panels, confirmWrite, executeIntoSheet],
  );

  const runCurrentStatement = useCallback(
    (panelId: string) => {
      const panel = panels.find((p) => p.id === panelId);
      if (!panel) return;
      const handle = editorHandles.current[panelId];
      const doc = handle?.getValue() ?? panel.doc;
      const selection = handle?.getSelectionRange() ?? null;
      const position = selection && selection.from !== selection.to
        ? selection.from
        : handle?.getCursorPosition() ?? doc.length;
      const range = hbaseStatementRangeAt(doc, position);
      if (!range) {
        setStatusMessage("No HBase statement at the current cursor.");
        return;
      }
      void runStatements(panelId, range.sql);
    },
    [panels, runStatements],
  );

  const cancelQuery = useCallback(
    (panelId: string) => {
      setPanels((prev) =>
        prev.map((p) =>
          p.id !== panelId ? p : { ...p, sheets: p.sheets.map((s) => (s.running ? { ...s, cancelling: true } : s)) },
        ),
      );
      if (connectionSessionId) void hbaseCancel(connectionSessionId);
    },
    [connectionSessionId],
  );

  const refreshSheet = useCallback(
    (panelId: string, sheetId: string, _mode: QueryRefreshMode) => {
      const panel = panels.find((p) => p.id === panelId);
      const sheet = panel?.sheets.find((s) => s.id === sheetId);
      if (sheet) void executeIntoSheet(panelId, sheetId, sheet.command);
    },
    [panels, executeIntoSheet],
  );

  const closeResultSheets = useCallback((panelId: string, sheetIds: string[]) => {
    if (sheetIds.length === 0) return;
    const idSet = new Set(sheetIds);
    setPanels((prev) =>
      prev.map((p) => {
        if (p.id !== panelId) return p;
        const sheets = p.sheets.filter((s) => !idSet.has(s.id));
        const activeClosed = !!p.activeSheetId && idSet.has(p.activeSheetId);
        return {
          ...p,
          sheets,
          activeSheetId: activeClosed ? sheets[sheets.length - 1]?.id ?? null : p.activeSheetId,
        };
      }),
    );
  }, []);

  const closeResultSheet = useCallback(
    (panelId: string, sheetId: string) => {
      closeResultSheets(panelId, [sheetId]);
    },
    [closeResultSheets],
  );

  const addPanel = useCallback(
    (doc = "") => {
      if (panels.length >= MAX_PANELS) return;
      const panel = newPanel(doc);
      setPanels((prev) => [...prev, panel]);
      setActivePanelId(panel.id);
    },
    [panels.length],
  );

  const closePanel = useCallback(
    (panelId: string) => {
      setPanels((prev) => {
        if (prev.length <= 1) return prev;
        const next = prev.filter((p) => p.id !== panelId);
        if (panelId === activePanelId) setActivePanelId(next[next.length - 1].id);
        return next;
      });
    },
    [activePanelId],
  );

  // --- tree → workspace bridge ---
  const onRunCommand = useCallback((stmt: string) => void runStatements(activePanelId, stmt), [runStatements, activePanelId]);
  const onInsert = useCallback(
    (stmt: string, target: "cursor" | "newPanel" = "cursor") => {
      if (target === "newPanel" && panels.length < MAX_PANELS) {
        addPanel(stmt);
        return;
      }
      const editor = editorHandles.current[activePanelId];
      if (editor) {
        editor.insertText(`${stmt}\n`);
        editor.focus();
      } else {
        patchPanel(activePanelId, { doc: `${activePanel?.doc ?? ""}${activePanel?.doc ? "\n" : ""}${stmt}` });
      }
    },
    [panels.length, addPanel, activePanelId, activePanel, patchPanel],
  );

  const onTablesLoaded = useCallback((tables: string[]) => {
    setSchemaMap((prev) => {
      const next: Record<string, string[]> = {};
      for (const tbl of tables) next[tbl] = prev[tbl] ?? [];
      return next;
    });
  }, []);
  const onFamiliesLoaded = useCallback((table: string, families: string[]) => {
    setSchemaMap((prev) => ({ ...prev, [table]: families }));
  }, []);

  const endpoint = useMemo(() => {
    if (info.connectionMode === "native") {
      const q = info.zkQuorum || (info.host ? `${info.host}:${info.port}` : "") || (info.hbaseSitePath ? "hbase-site.xml" : "ZooKeeper");
      const r = info.zkRoot || "/hbase";
      return `ZK: ${q} (${r})${info.namespace ? ` [${info.namespace}]` : ""}`;
    }
    const scheme = info.ssl ? "https" : "http";
    if (info.connectionMode === "thrift") {
      return `Thrift ${scheme}://${info.host}:${info.port}${info.namespace ? ` [${info.namespace}]` : ""}`;
    }
    const path = info.restPath ? `/${info.restPath.replace(/^\/+|\/+$/g, "")}` : "";
    return `${scheme}://${info.host}:${info.port}${path}${info.namespace ? ` [${info.namespace}]` : ""}`;
  }, [info.connectionMode, info.host, info.namespace, info.port, info.restPath, info.ssl, info.zkQuorum, info.zkRoot, info.hbaseSitePath]);

  // RENDER_MAIN_PLACEHOLDER
  const [rowLimit, setRowLimit] = useState(DEFAULT_ROW_LIMIT);

  // HBase shell command/table autocomplete (replaces lang-sql's SQL keywords).
  const completionSources = useMemo(
    () => [hbaseCompletionSource({ transport, schema: schemaMap })],
    [transport, schemaMap],
  );

  const initialLayout = useMemo(
    () => loadResizableLayout(`hbase-shell-${info.sessionId}`, ["sidebar", "workspace"]),
    [info.sessionId],
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    initialLayout && typeof initialLayout.sidebar === "number" ? initialLayout.sidebar === 0 : false,
  );
  const sidebarPanelRef = useRef<PanelImperativeHandle | null>(null);
  const lastVisibleSidebarWidthRef = useRef<number>(
    initialLayout && typeof initialLayout.sidebar === "number" && initialLayout.sidebar > 0 ? initialLayout.sidebar : 20,
  );
  const expandSidebarPanel = () => {
    const nextSize = Math.min(40, Math.max(15, lastVisibleSidebarWidthRef.current));
    sidebarPanelRef.current?.resize(`${nextSize}%`);
    setSidebarCollapsed(false);
  };
  const handleSidebarResize = (size: PanelSize) => {
    const percentage = size.asPercentage;
    if (percentage > 0) lastVisibleSidebarWidthRef.current = percentage;
    setSidebarCollapsed(percentage === 0);
  };

  if (connError) {
    return (
      <div className="h-full w-full flex items-center justify-center p-6" style={{ background: "var(--taomni-bg)", color: "var(--taomni-text)" }}>
        <div className="max-w-md text-center">
          <AlertTriangle className="w-6 h-6 mx-auto mb-2" style={{ color: "#d9534f" }} />
          <div className="font-semibold mb-1">HBase connection failed</div>
          <div className="text-[12px] text-[var(--taomni-text-muted)] break-words">{connError}</div>
        </div>
      </div>
    );
  }
  if (!hasBeenVisible) {
    return (
      <div className="h-full w-full flex items-center justify-center" style={{ background: "var(--taomni-bg)" }}>
        <Loader2 className="w-6 h-6 animate-spin text-[var(--taomni-text-muted)]" />
      </div>
    );
  }

  const panelRunning = activePanel.sheets.some((s) => s.running);
  const btn = "h-6 px-2 inline-flex items-center gap-1 rounded text-[11px] hover:bg-[var(--taomni-hover)] disabled:opacity-40";

  return (
    <div ref={rootRef} className="h-full w-full flex flex-col relative" style={{ background: "var(--taomni-bg)", color: "var(--taomni-text)" }}>
      {sidebarCollapsed && (
        <button
          type="button"
          data-testid="hbase-sidebar-drawer-handle"
          className="absolute left-0 top-12 z-30 h-24 w-6 inline-flex flex-col items-center justify-center gap-1 rounded-r border-y border-r shadow-sm hover:bg-[var(--taomni-hover)]"
          style={{ background: "var(--taomni-panel-bg)", borderColor: "var(--taomni-divider)", color: "var(--taomni-text-muted)" }}
          title="Show database objects"
          aria-label="Show database objects"
          onClick={expandSidebarPanel}
        >
          <ChevronRight className="w-3.5 h-3.5" />
          <span className="text-[10px] leading-none" style={{ writingMode: "vertical-rl" }}>Objects</span>
        </button>
      )}
      <PanelGroup
        orientation="horizontal"
        id={`hbase-shell-${info.sessionId}`}
        defaultLayout={initialLayout}
        onLayoutChanged={saveResizableLayout(`hbase-shell-${info.sessionId}`)}
        className="flex-1 min-h-0"
      >
        <Panel panelRef={sidebarPanelRef} id="sidebar" defaultSize="20%" minSize="15%" maxSize="40%" collapsible collapsedSize={0} onResize={handleSidebarResize}>
          <div className="h-full border-r" style={{ borderColor: "var(--taomni-divider)" }}>
            <HBaseSchemaTree
              sessionId={connectionSessionId}
              transport={transport}
              namespace={info.namespace}
              endpoint={endpoint}
              refreshSignal={refreshSignal}
              scanLimit={rowLimit}
              onRunCommand={onRunCommand}
              onInsert={onInsert}
              onNewQuery={() => addPanel("")}
              onStatus={setStatusMessage}
              onTablesLoaded={onTablesLoaded}
              onFamiliesLoaded={onFamiliesLoaded}
            />
          </div>
        </Panel>
        <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-col-resize" />
        <Panel id="workspace">
          <div className="h-full flex flex-col min-w-0">
            {/* query-panel tab strip */}
            <div className="h-7 shrink-0 flex items-center gap-1 px-1 overflow-hidden" style={{ background: "var(--taomni-chrome-bg)", borderBottom: "1px solid var(--taomni-divider)" }}>
              {panels.map((p, i) => {
                const running = p.sheets.some((s) => s.running);
                return (
                  <button
                    key={p.id}
                    type="button"
                    className="px-2 h-5 max-w-[190px] rounded inline-flex items-center gap-1"
                    style={{
                      background: p.id === activePanelId ? "var(--taomni-selected)" : "transparent",
                      color: p.id === activePanelId ? "var(--taomni-accent)" : "var(--taomni-text-muted)",
                    }}
                    onClick={() => setActivePanelId(p.id)}
                    title={`Query ${i + 1}`}
                  >
                    <span className="truncate">Query {i + 1}</span>
                    {running && <Loader2 className="w-3 h-3 shrink-0 animate-spin" />}
                    {panels.length > 1 && (
                      <X className="w-3 h-3 shrink-0 hover:text-[var(--taomni-text)]" onClick={(e) => { e.stopPropagation(); closePanel(p.id); }} />
                    )}
                  </button>
                );
              })}
              {panels.length < MAX_PANELS && (
                <button type="button" title="New query panel" className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]" onClick={() => addPanel("")}>
                  <Plus className="w-3 h-3" />
                </button>
              )}
            </div>

            <div key={activePanel.id} className="flex-1 min-h-0 h-full flex flex-col min-w-0 relative">
              {/* editor toolbar */}
              <div className="h-8 shrink-0 flex items-center gap-1 px-2 relative" style={{ background: "var(--taomni-quick-bg)", borderBottom: "1px solid var(--taomni-divider)" }}>
                <button
                  type="button"
                  className={btn}
                  disabled={!connectionSessionId || panelRunning}
                  title={`Run (${displaySqlShortcut(executionPreferences.runAll)})`}
                  onClick={() => void runStatements(activePanel.id, editorHandles.current[activePanel.id]?.getValue() ?? activePanel.doc)}
                >
                  <Play className="w-3.5 h-3.5" style={{ color: "#62d36f" }} /> Run
                </button>
                <button
                  type="button"
                  className={btn}
                  disabled={!connectionSessionId || panelRunning}
                  title={`Run selection (${displaySqlShortcut(executionPreferences.runSelection)})`}
                  onClick={() => void runStatements(activePanel.id, editorHandles.current[activePanel.id]?.getSelectionOrAll() ?? activePanel.doc)}
                >
                  <SquareDashedMousePointer className="w-3.5 h-3.5" /> Selection
                </button>
                <button
                  type="button"
                  className={btn}
                  disabled={!connectionSessionId || panelRunning}
                  title={`Run current statement (${displaySqlShortcut(executionPreferences.runCurrent)})`}
                  data-testid="hbase-run-current-statement"
                  onClick={() => runCurrentStatement(activePanel.id)}
                >
                  <Crosshair className="w-3.5 h-3.5" /> Current
                </button>
                <button type="button" className={btn} disabled={!panelRunning} title="Cancel query" onClick={() => cancelQuery(activePanel.id)}>
                  <Ban className="w-3.5 h-3.5" style={{ color: "#d9534f" }} /> Cancel
                </button>
                <span className="w-px h-4 mx-1" style={{ background: "var(--taomni-divider)" }} />
                <button type="button" className={btn} title="Commands" onClick={() => { setShowCommands((v) => !v); setShowHistory(false); }}>
                  Commands <ChevronDown className="w-3 h-3" />
                </button>
                <button type="button" className={btn} title="Command history" onClick={() => { setShowHistory((v) => !v); setShowCommands(false); }}>
                  <Clock className="w-3.5 h-3.5" /> History
                </button>
                <button type="button" className={btn} title={t("hbaseObjects.helpTitle")} onClick={() => setShowHelp(true)}>
                  <HelpCircle className="w-3.5 h-3.5" /> {t("hbaseObjects.help")}
                </button>
                <div className="flex-1" />
                <label className="h-6 inline-flex items-center gap-1 text-[11px] text-[var(--taomni-text-muted)]">
                  Rows
                  <input className="taomni-input h-6 w-[68px] text-[11px]" type="number" min={1} max={10000} value={rowLimit}
                    title="Default scan row limit" onChange={(e) => setRowLimit(Math.max(1, Math.min(10000, Number(e.target.value) || DEFAULT_ROW_LIMIT)))} />
                </label>
                <span className="text-[10px] text-[var(--taomni-text-muted)]">HBase ({transport})</span>
                {showCommands && <CommandsMenu transport={transport} onPick={(ex) => onInsert(ex, "cursor")} onClose={() => setShowCommands(false)} />}
                {showHistory && <HistoryDropdown history={historyRef.current[activePanel.id] ?? []} onPick={(cmd) => { editorHandles.current[activePanel.id]?.setValue(cmd); setShowHistory(false); }} onClose={() => setShowHistory(false)} />}
              </div>

              <PanelGroup
                orientation="vertical"
                id={`hbase-workspace-${info.sessionId}`}
                defaultLayout={loadResizableLayout(`hbase-workspace-${info.sessionId}`, ["editor", "results"])}
                onLayoutChanged={saveResizableLayout(`hbase-workspace-${info.sessionId}`)}
                className="flex-1 min-h-0"
              >
                <Panel id="editor" defaultSize="35%" minSize="15%">
                  <SqlEditorPanel
                    engine="HBase"
                    initialDoc={activePanel.doc}
                    completionSources={completionSources}
                    handleRef={(h) => { editorHandles.current[activePanel.id] = h; }}
                    onDocChange={(doc) => patchPanel(activePanel.id, { doc })}
                    onFocus={() => setActivePanelId(activePanel.id)}
                    onRun={(sql) => void runStatements(activePanel.id, sql)}
                    onRunCurrent={() => runCurrentStatement(activePanel.id)}
                  />
                </Panel>
                <PanelResizeHandle className="h-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-row-resize" />
                <Panel id="results" minSize="15%">
                  <ResultArea
                    panel={activePanel}
                    onSheetSelect={(sheetId) => patchPanel(activePanel.id, { activeSheetId: sheetId })}
                    onSheetClose={(sheetId) => closeResultSheet(activePanel.id, sheetId)}
                    onCloseSheets={(sheetIds) => closeResultSheets(activePanel.id, sheetIds)}
                    onTabChange={(sheetId, tab) => patchSheet(activePanel.id, sheetId, { resultTab: tab })}
                    onRefreshSheet={(sheetId, mode) => refreshSheet(activePanel.id, sheetId, mode)}
                    onCancel={() => cancelQuery(activePanel.id)}
                    onStatus={setStatusMessage}
                  />
                </Panel>
              </PanelGroup>
              <StatusBar panel={activePanel} />
            </div>
          </div>
        </Panel>

      </PanelGroup>
      {showHelp && <HelpDialog transport={transport} onClose={() => setShowHelp(false)} />}
      {confirmDialog.render}
    </div>
  );
}





