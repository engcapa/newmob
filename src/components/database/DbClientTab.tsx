import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import {
  Group as PanelGroup,
  Panel,
  Separator as PanelResizeHandle,
  type PanelImperativeHandle,
  type PanelSize,
} from "react-resizable-panels";
import {
  Play,
  SquareDashedMousePointer,
  Ban,
  Sparkles,
  Clock,
  Plus,
  X,
  Save,
  AlertTriangle,
  Loader2,
  Bot,
  ExternalLink,
  Maximize2,
  Minimize2,
  ChevronRight,
  Star,
  Files,
  Database,
  FileJson,
  MessageSquare,
  RefreshCw,
  Trash2,
  Crosshair,
} from "lucide-react";
import type { DbConnectInfo } from "../../types";
import {
  checkFileExists,
  dbConnect,
  dbDisconnect,
  dbExecute,
  dbExecuteStream,
  dbCancel,
  dbAppendHistory,
  dbClearHistory,
  dbDeleteHistory,
  dbDescribeTable,
  dbGetSavedQuery,
  dbCloseQueryWorkspaceTabs,
  dbListHistory,
  dbLoadQueryWorkspace,
  dbRewriteResultSql,
  dbSaveQueryWorkspace,
  dbSaveSavedQuery,
  readFileBytes,
  selectSaveFilePath,
  writeStreamAbort,
  writeStreamAppend,
  writeStreamClose,
  writeStreamOpen,
  type DbColumnDescription,
  type DbQueryResult,
  type DbResultSqlRewriteRequest,
  type DbQueryWorkspaceTab,
  type DbSavedQuery,
  type DbSqlHistoryEntry,
} from "../../lib/ipc";
import { SchemaTree, type SchemaTreeSelectedObject } from "./SchemaTree";
import { QueryLibraryPanel } from "./QueryLibraryPanel";
import { SqlEditorPanel, type SqlEditorHandle, type SqlEditorRunContext } from "./SqlEditorPanel";
import {
  QueryResultGrid,
  type QueryGridCommitPayload,
  type QueryGeneratedSqlSyncMode,
  type QueryRefreshMode,
} from "./QueryResultGrid";
import { formatSql } from "./formatSql";
import {
  displaySqlShortcut,
  loadSqlExecutionPreferences,
  subscribeSqlExecutionPreferences,
} from "../../lib/sqlExecutionPreferences";
import { useAppStore } from "../../stores/appStore";
import { TabActions } from "../tabbar/TabActionSlot";
import { useCaptureStore, type CaptureSource } from "../../stores/captureStore";
import { useChatStore } from "../../stores/chatStore";
import { CaptureMenuButton } from "../capture/CaptureMenuButton";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import {
  FT_BUTTON_STYLE,
  FT_BUTTON_ACTIVE_OVERRIDE,
  FT_ICON_BUTTON_STYLE,
} from "../floating-toolbar/floatingToolbarStyles";
import { captureElementPng, renderElementToCanvas, safeFilePart } from "../../lib/capture";
import { useT } from "../../lib/i18n";
import { registerQueryTab } from "../../lib/queryRegistry";
import { useDbSessionFontSize } from "./useDbSessionFontSize";
import { splitSqlStatementRanges, sqlStatementRangesForExecution, type SqlStatementRange } from "../../lib/sqlStatements";
import { writeText } from "../../lib/clipboard";
import { createDbMetadataCache } from "../../lib/dbMetadataCache";
import { sqlNamespaceFromMetadata } from "../../lib/sqlMetadataCompletions";
import {
  asSqlEngine,
  quoteIdent as dialectQuoteIdent,
  qualifiedName as dialectQualifiedName,
  sqlLiteral as dialectSqlLiteral,
  setDefaultSchemaSql,
  selectStatement as dialectSelectStatement,
} from "../../lib/sqlDialect";

interface DbClientTabProps {
  tabId: string;
  info: DbConnectInfo;
  visible: boolean;
  onDetach?: () => void;
  chatToggle?: {
    open: boolean;
    onToggle: () => void;
  };
  detachedWindowControls?: {
    onReattach: () => void;
    onToggleOsFullscreen: () => void;
    osFullscreen: boolean;
  };
}

const MAX_HISTORY = 200;
const MAX_PANELS = 4;
const DEFAULT_MAX_RESULT_SHEETS = 50;
const MIN_RESULT_SHEETS = 1;
const MAX_RESULT_SHEETS_LIMIT = 200;
const DEFAULT_ROW_LIMIT = 1000;
const MIN_ROW_LIMIT = 1;
const MAX_ROW_LIMIT = 1_000_000;
const QUERY_WORKSPACE_CACHE_VERSION = 1;
const QUERY_AUTO_SAVE_MS = 5000;

function createRuntimeDbSessionId(baseSessionId: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${baseSessionId}::${suffix}`;
}

type ResultSubTab = "results" | "messages";

interface ResultSheet {
  id: string;
  title: string;
  baseSql: string;
  sql: string;
  sourceRef: SqlStatementSourceRef | null;
  generatedTargetPanelId: string | null;
  result: DbQueryResult | null;
  error: string | null;
  warnings: string[];
  running: boolean;
  cancelling: boolean;
  elapsedMs: number;
  resultTab: ResultSubTab;
  rowLimit: number;
  createdAt: number;
}

interface SqlStatementSourceRef {
  id: string;
  panelId: string;
  origin: "editor" | "history" | "generated";
  sql: string;
  from: number | null;
  to: number | null;
  exactHash: string;
  historyId?: string;
  parentSheetId?: string;
}

interface QueryExecutionSummary {
  ok: boolean;
  durationMs: number | null;
  rowsAffected: number | null;
  rowCount: number | null;
  hasResultSet: boolean;
  error: string | null;
}

interface EditorStatementAction {
  panelId: string;
  doc: string;
  range: SqlStatementRange;
}

interface PanelState {
  id: string;
  doc: string;
  sheets: ResultSheet[];
  activeSheetId: string | null;
  filePath: string | null;
  fileName: string | null;
  savedQuery: DbSavedQuery | null;
  dirty: boolean;
  createdAt: number;
}

interface QueryWorkspacePanelCache {
  id: string;
  filePath: string | null;
  fileName: string | null;
  cachePath: string | null;
}

interface QueryWorkspaceCache {
  version: typeof QUERY_WORKSPACE_CACHE_VERSION;
  activePanelId: string | null;
  panels: QueryWorkspacePanelCache[];
}

function widthKey(engine: string): string {
  return `taomni.db.schemaWidth.${engine}`;
}

function settingKey(engine: string, name: string): string {
  return `taomni.db.${engine}.${name}`;
}

function settingDefaultMigrationKey(engine: string, name: string): string {
  return `${settingKey(engine, name)}.defaultsFixed.v1`;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readIntSetting(engine: string, name: string, fallback: number, min: number, max: number): number {
  try {
    const key = settingKey(engine, name);
    const migrationKey = settingDefaultMigrationKey(engine, name);
    const rawValue = localStorage.getItem(key);
    if (rawValue === null || rawValue.trim() === "") {
      localStorage.setItem(migrationKey, "1");
      return fallback;
    }
    const raw = Number(rawValue);
    if (!Number.isFinite(raw)) {
      localStorage.setItem(migrationKey, "1");
      return fallback;
    }
    const clamped = clampInt(raw, min, max);
    const migrated = localStorage.getItem(migrationKey) === "1";
    localStorage.setItem(migrationKey, "1");
    if (!migrated && clamped === min && fallback > min) {
      return fallback;
    }
    return clamped;
  } catch {
    return fallback;
  }
}

function writeIntSetting(engine: string, name: string, value: number): void {
  try {
    localStorage.setItem(settingKey(engine, name), String(value));
  } catch {
    /* ignore */
  }
}

function workspaceKey(sessionId: string): string {
  return `taomni.db.queryWorkspace.v${QUERY_WORKSPACE_CACHE_VERSION}.${sessionId}`;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatClockTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function formatFullDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${formatClockTime(timestamp)}`;
}

function formatDurationMs(durationMs: number | null | undefined): string | null {
  if (durationMs === null || durationMs === undefined || !Number.isFinite(durationMs)) return null;
  const ms = Math.max(0, Math.round(durationMs));
  if (ms < 1000) return `${ms} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 1000)} s`;
}

function hashSqlText(sql: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < sql.length; i += 1) {
    hash ^= sql.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function replacementEndWithExistingTerminator(sourceDoc: string, to: number, replacementSql: string): number {
  if (!replacementSql.trimEnd().endsWith(";")) return to;
  const trailingTerminator = /^[ \t]*;/.exec(sourceDoc.slice(to));
  return trailingTerminator ? to + trailingTerminator[0].length : to;
}

function sourceRefForRange(
  panelId: string,
  range: SqlStatementRange,
  origin: SqlStatementSourceRef["origin"] = "editor",
  patch: Partial<Pick<SqlStatementSourceRef, "historyId" | "parentSheetId">> = {},
): SqlStatementSourceRef {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    id: `${panelId}:${range.from}:${range.to}:${hashSqlText(range.sql)}:${suffix}`,
    panelId,
    origin,
    sql: range.sql,
    from: range.from,
    to: range.to,
    exactHash: hashSqlText(range.sql),
    ...patch,
  };
}

function resultSheetTimingTitle(sheet: ResultSheet): string {
  const lines = [`Started: ${formatFullDateTime(sheet.createdAt)}`];
  const duration = sheet.running
    ? formatDurationMs(sheet.elapsedMs)
    : formatDurationMs(sheet.result?.durationMs);
  if (duration) {
    lines.push(`${sheet.running ? "Elapsed" : "Duration"}: ${duration}`);
  }
  if (sheet.sql.trim()) {
    lines.push("", sheet.sql);
  }
  return lines.join("\n");
}

function readLegacyWorkspaceCache(sessionId: string): QueryWorkspaceCache | null {
  try {
    const raw = localStorage.getItem(workspaceKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<QueryWorkspaceCache>;
    if (parsed.version !== QUERY_WORKSPACE_CACHE_VERSION || !Array.isArray(parsed.panels)) {
      return null;
    }
    return {
      version: QUERY_WORKSPACE_CACHE_VERSION,
      activePanelId: typeof parsed.activePanelId === "string" ? parsed.activePanelId : null,
      panels: parsed.panels
        .map((panel) => ({
          id: typeof panel?.id === "string" ? panel.id : "",
          filePath: typeof panel?.filePath === "string" ? panel.filePath : null,
          fileName: typeof panel?.fileName === "string" ? panel.fileName : null,
          cachePath: typeof panel?.cachePath === "string" ? panel.cachePath : null,
        }))
        .filter((panel) => panel.id && (panel.filePath || panel.cachePath)),
    };
  } catch {
    return null;
  }
}

async function readTextFile(path: string): Promise<string> {
  return new TextDecoder().decode(await readFileBytes(path));
}

async function writeTextFile(path: string, text: string): Promise<void> {
  let handleId: string | null = null;
  try {
    handleId = await writeStreamOpen(path);
    await writeStreamAppend(handleId, new TextEncoder().encode(text));
    await writeStreamClose(handleId);
  } catch (err) {
    if (handleId) await writeStreamAbort(handleId).catch(() => undefined);
    throw err;
  }
}

function quoteIdent(engine: string, ident: string): string {
  return dialectQuoteIdent(asSqlEngine(engine), ident);
}

function qualifiedName(engine: string, schema: string | null, table: string, catalog?: string | null): string {
  return dialectQualifiedName(asSqlEngine(engine), { catalog, schema, name: table });
}

function schemaSwitchSql(engine: string, schema: string, catalog?: string | null): string {
  return setDefaultSchemaSql(asSqlEngine(engine), schema, catalog);
}

function engineUsesDatabaseAsSchema(engine: string): boolean {
  return engine === "MySQL" || engine === "StarRocks" || engine === "ClickHouse" || engine === "Presto";
}

function initialActiveSchema(info: DbConnectInfo): string | null {
  return engineUsesDatabaseAsSchema(info.engine) ? (info.database ?? null) : null;
}

function unquoteIdent(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("`") && trimmed.endsWith("`")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return trimmed.slice(1, -1).replace(/""/g, '"').replace(/``/g, "`").replace(/]]/g, "]");
  }
  return trimmed;
}

function parseEditableSelectTarget(sql: string): { schema: string | null; table: string } | null {
  const cleaned = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .trim();
  if (!/^select\b/i.test(cleaned)) return null;
  if (/\b(join|union|group\s+by|having)\b/i.test(cleaned)) return null;
  const ident = String.raw`(?:"[^"]+"|` + "`[^`]+`" + String.raw`|\[[^\]]+\]|[A-Za-z_][\w$]*)`;
  const match = cleaned.match(new RegExp(String.raw`\bfrom\s+(${ident})(?:\s*\.\s*(${ident}))?(?:\s*\.\s*(${ident}))?`, "i"));
  if (!match) return null;
  return match[3]
    ? { schema: unquoteIdent(match[2]), table: unquoteIdent(match[3]) }
    : match[2]
    ? { schema: unquoteIdent(match[1]), table: unquoteIdent(match[2]) }
    : { schema: null, table: unquoteIdent(match[1]) };
}

function sqlLiteral(value: string | null): string {
  return dialectSqlLiteral(value);
}

function whereForColumns(engine: string, columns: string[], allColumns: string[], values: (string | null)[]): string {
  const clauses = columns.map((column) => {
    const index = allColumns.findIndex((name) => name === column);
    const value = index >= 0 ? values[index] : null;
    const ident = quoteIdent(engine, column);
    return value === null ? `${ident} IS NULL` : `${ident} = ${sqlLiteral(value)}`;
  });
  return clauses.length > 0 ? clauses.join(" AND ") : "1 = 0";
}

function newPanel(patch: Partial<PanelState> = {}): PanelState {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `panel-${Date.now()}-${Math.random()}`,
    doc: "",
    sheets: [],
    activeSheetId: null,
    filePath: null,
    fileName: null,
    savedQuery: null,
    dirty: false,
    createdAt: Date.now(),
    ...patch,
  };
}

function workspaceTabFromPanel(
  workspaceId: string,
  panel: PanelState,
  tabOrder: number,
  content: string,
  updatedAt: number,
  dirty = panel.dirty,
): DbQueryWorkspaceTab {
  return {
    workspaceId,
    panelId: panel.id,
    tabOrder,
    content,
    filePath: panel.filePath,
    fileName: panel.fileName,
    savedQueryId: panel.savedQuery?.id ?? null,
    dirty,
    isOpen: true,
    closedAt: null,
    createdAt: panel.createdAt,
    updatedAt,
  };
}

function newResultSheet(
  sql: string,
  ordinal: number,
  rowLimit: number,
  sourceRef: SqlStatementSourceRef | null = null,
): ResultSheet {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `sheet-${Date.now()}-${Math.random()}`,
    title: `Result ${ordinal}`,
    baseSql: sql,
    sql,
    sourceRef,
    generatedTargetPanelId: null,
    result: emptyQueryResult(),
    error: null,
    warnings: [],
    running: true,
    cancelling: false,
    elapsedMs: 0,
    resultTab: "results",
    rowLimit,
    createdAt: Date.now(),
  };
}

function activeSheet(panel: PanelState): ResultSheet | null {
  return panel.sheets.find((sheet) => sheet.id === panel.activeSheetId) ?? panel.sheets.at(-1) ?? null;
}

function emptyQueryResult(): DbQueryResult {
  return {
    columns: [],
    rows: [],
    rowsAffected: 0,
    durationMs: 0,
    warnings: [],
  };
}

function createSqlHistoryId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `sql-history-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function uniqueResultColumnNames(result: DbQueryResult): string[] {
  const seen = new Map<string, number>();
  return result.columns.map((column, index) => {
    const base = column.name || `column_${index + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

function resultToJsonText(result: DbQueryResult): string {
  const names = uniqueResultColumnNames(result);
  const rows = result.rows.map((row) =>
    Object.fromEntries(names.map((name, index) => [name, row[index] ?? null])),
  );
  return JSON.stringify(rows, null, 2);
}

export default function DbClientTab({
  tabId,
  info,
  visible,
  onDetach,
  chatToggle,
  detachedWindowControls,
}: DbClientTabProps) {
  const t = useT();
  const queryTabMenu = useContextMenu();
  const [connectionSessionId, setConnectionSessionId] = useState<string | null>(null);
  const [connError, setConnError] = useState<string | null>(null);
  const [panels, setPanels] = useState<PanelState[]>(() => [newPanel()]);
  const [activePanelId, setActivePanelId] = useState<string>(() => panels[0].id);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [rowLimit, setRowLimit] = useState(() =>
    readIntSetting(info.engine, "rowLimit", DEFAULT_ROW_LIMIT, MIN_ROW_LIMIT, MAX_ROW_LIMIT),
  );
  const [maxResultSheets, setMaxResultSheets] = useState(() =>
    readIntSetting(
      info.engine,
      "maxResultSheets",
      DEFAULT_MAX_RESULT_SHEETS,
      MIN_RESULT_SHEETS,
      MAX_RESULT_SHEETS_LIMIT,
    ),
  );
  const [schemas, setSchemas] = useState<string[]>([]);
  const [activeSchema, setActiveSchema] = useState<string | null>(() => initialActiveSchema(info));
  const [schemaMap, setSchemaMap] = useState<Record<string, string[]>>({});
  const [metadataVersion, setMetadataVersion] = useState(0);
  const [historyPanelId, setHistoryPanelId] = useState<string | null>(null);
  const [statementAction, setStatementAction] = useState<EditorStatementAction | null>(null);
  const [executionPreferences, setExecutionPreferences] = useState(loadSqlExecutionPreferences);
  const [historyEntries, setHistoryEntries] = useState<DbSqlHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [leftPanelTab, setLeftPanelTab] = useState<"schema" | "queries">("schema");
  const addQueryTriggerRef = useRef<(() => void) | null>(null);
  const historyRef = useRef<Record<string, string[]>>({});
  const editorHandles = useRef<Record<string, SqlEditorHandle | null>>({});
  // Stable "echo target" panel for AI/Claude Code SQL echo (queryRegistry
  // `appendEchoSql`): once chosen it's reused so a whole chat session's SQL
  // accumulates in one editor, instead of scattering across panels.
  const echoPanelIdRef = useRef<string | null>(null);
  const timersRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const panelsRef = useRef<PanelState[]>(panels);
  const activePanelIdRef = useRef(activePanelId);
  const autoSaveInFlightRef = useRef<Promise<void> | null>(null);
  const autoSaveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAutoSavedDocRef = useRef<Record<string, string>>({});
  const savedQueriesRef = useRef<Record<string, DbSavedQuery>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const schemaPanelRef = useRef<PanelImperativeHandle | null>(null);
  const lastVisibleSchemaWidthRef = useRef(24);
  const [schemaCollapsed, setSchemaCollapsed] = useState(false);
  const setTabHasNewOutput = useAppStore((s) => s.setTabHasNewOutput);
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);
  const setTabDbConn = useAppStore((s) => s.setTabDbConn);
  const setTabDbSelectedObjects = useAppStore((s) => s.setTabDbSelectedObjects);
  const { fontSize: dbFontSize } = useDbSessionFontSize(visible, rootRef);
  const dbFontStyle = useMemo(
    () => ({
      "--taomni-db-font-size": `${dbFontSize}px`,
      "--taomni-db-font-size-sm": `${Math.max(10, dbFontSize - 2)}px`,
    }) as CSSProperties,
    [dbFontSize],
  );

  const sessionId = info.sessionId;
  const workspaceSessionId = info.workspaceSessionId ?? info.sessionId;
  const metadataCache = useMemo(
    () =>
      connectionSessionId
        ? createDbMetadataCache({
            sessionId: connectionSessionId,
            defaultCatalog: info.catalog,
          })
        : null,
    [connectionSessionId, info.catalog],
  );

  useEffect(() => {
    panelsRef.current = panels;
  }, [panels]);

  useEffect(() => {
    activePanelIdRef.current = activePanelId;
  }, [activePanelId]);

  useEffect(() => {
    if (!metadataCache) return;
    setMetadataVersion((version) => version + 1);
    return metadataCache.subscribe(() => {
      setMetadataVersion((version) => version + 1);
    });
  }, [metadataCache]);

  // Global keyboard shortcut to save the active editor as a query: Ctrl+Alt+B / Cmd+Alt+B
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        e.stopPropagation();
        addQueryTriggerRef.current?.();
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  // Connect on mount, disconnect on unmount.
  useEffect(() => {
    let cancelled = false;
    const runtimeSessionId = createRuntimeDbSessionId(sessionId);
    setConnectionSessionId(null);
    setConnError(null);
    setTabDbSelectedObjects(tabId, null);
    void dbConnect({ ...info, sessionId: runtimeSessionId })
      .then(() => {
        if (cancelled) {
          void dbDisconnect(runtimeSessionId).catch(() => undefined);
          return;
        }
        setConnectionSessionId(runtimeSessionId);
        // Phase 6 — publish the live connection id so the CC DB MCP (when a
        // chat thread is bound to this tab) can target it each turn.
        setTabDbConn(tabId, runtimeSessionId);
      })
      .catch((err) => {
        if (!cancelled) setConnError(String(err));
      });
    return () => {
      cancelled = true;
      void dbDisconnect(runtimeSessionId).catch(() => undefined);
      setTabDbConn(tabId, null);
      setTabDbSelectedObjects(tabId, null);
      Object.values(timersRef.current).forEach(clearInterval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    setWorkspaceReady(false);
    void (async () => {
      const workspace = await dbLoadQueryWorkspace(workspaceSessionId);
      if (cancelled) return;
      if (workspace) {
        if (workspace.tabs.length === 0) {
          setWorkspaceReady(true);
          return;
        }
        const restored = await Promise.all(
          workspace.tabs.slice(0, MAX_PANELS).map(async (entry) => {
            const savedQuery = entry.savedQueryId
              ? await dbGetSavedQuery(entry.savedQueryId).catch(() => null)
              : null;
            if (savedQuery) savedQueriesRef.current[entry.panelId] = savedQuery;
            return newPanel({
              id: entry.panelId,
              doc: entry.content,
              filePath: entry.filePath ?? null,
              fileName: entry.fileName ?? (entry.filePath ? basename(entry.filePath) : null),
              savedQuery,
              dirty: entry.dirty,
              createdAt: entry.createdAt,
            });
          }),
        );
        lastAutoSavedDocRef.current = Object.fromEntries(
          restored.map((panel) => [panel.id, panel.doc]),
        );
        setPanels(restored);
        setActivePanelId(
          workspace.activePanelId && restored.some((panel) => panel.id === workspace.activePanelId)
            ? workspace.activePanelId
            : restored[0].id,
        );
        setWorkspaceReady(true);
        return;
      }

      const cache = readLegacyWorkspaceCache(workspaceSessionId);
      if (!cache || cache.panels.length === 0) {
        setWorkspaceReady(true);
        return;
      }
      const restored: PanelState[] = [];
      const restoredDocs: Record<string, string> = {};
      for (const [index, entry] of cache.panels.entries()) {
        const path = entry.filePath ?? entry.cachePath;
        if (!path) continue;
        const exists = await checkFileExists(path).catch(() => false);
        if (!exists) continue;
        const doc = await readTextFile(path).catch(() => null);
        if (doc === null) continue;
        restoredDocs[entry.id] = doc;
        restored.push(
          newPanel({
            id: entry.id,
            doc,
            filePath: entry.filePath,
            fileName: entry.filePath ? basename(entry.filePath) : entry.fileName,
            dirty: !entry.filePath,
            createdAt: Date.now() + index,
          }),
        );
        if (restored.length >= MAX_PANELS) break;
        if (index >= MAX_PANELS - 1) break;
      }
      if (cancelled) return;
      if (restored.length === 0) {
        setWorkspaceReady(true);
        return;
      }
      const activePanelId =
        cache.activePanelId && restored.some((panel) => panel.id === cache.activePanelId)
          ? cache.activePanelId
          : restored[0].id;
      const importedAt = Date.now();
      await dbSaveQueryWorkspace({
        workspaceId: workspaceSessionId,
        activePanelId,
        tabs: restored.map((panel, index) =>
          workspaceTabFromPanel(
            workspaceSessionId,
            panel,
            index,
            panel.doc,
            importedAt,
          ),
        ),
        updatedAt: importedAt,
      });
      if (cancelled) return;
      lastAutoSavedDocRef.current = restoredDocs;
      setPanels(restored);
      setActivePanelId(activePanelId);
      setWorkspaceReady(true);
    })().catch((err) => {
      if (!cancelled) {
        setStatusMessage(`Query workspace restore failed: ${String(err)}`);
        setWorkspaceReady(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [setStatusMessage, workspaceSessionId]);

  useEffect(() => {
    writeIntSetting(info.engine, "rowLimit", rowLimit);
  }, [info.engine, rowLimit]);

  useEffect(() => {
    writeIntSetting(info.engine, "maxResultSheets", maxResultSheets);
  }, [info.engine, maxResultSheets]);

  const patchPanel = useCallback((id: string, patch: Partial<PanelState>) => {
    setPanels((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  const updatePanel = useCallback((id: string, updater: (panel: PanelState) => PanelState) => {
    setPanels((prev) => prev.map((p) => (p.id === id ? updater(p) : p)));
  }, []);

  const patchSheet = useCallback((panelId: string, sheetId: string, patch: Partial<ResultSheet>) => {
    updatePanel(panelId, (panel) => ({
      ...panel,
      sheets: panel.sheets.map((sheet) => (sheet.id === sheetId ? { ...sheet, ...patch } : sheet)),
    }));
  }, [updatePanel]);

  const updateSheet = useCallback(
    (panelId: string, sheetId: string, updater: (sheet: ResultSheet) => ResultSheet) => {
      updatePanel(panelId, (panel) => ({
        ...panel,
        sheets: panel.sheets.map((sheet) => (sheet.id === sheetId ? updater(sheet) : sheet)),
      }));
    },
    [updatePanel],
  );

  const persistWorkspaceSnapshot = useCallback(
    async (sourcePanels: PanelState[], snapshotActivePanelId: string | null) => {
      const savedAt = Date.now();
      const dirtyUpdates: Record<string, boolean> = {};
      const savedQueryUpdates: Record<string, DbSavedQuery> = {};
      const savedQueryErrors: string[] = [];
      const tabs: DbQueryWorkspaceTab[] = [];
      const panelDocuments = sourcePanels.map((panel) => ({
        panel,
        content: editorHandles.current[panel.id]?.getValue() ?? panel.doc,
      }));

      for (const [index, { panel, content }] of panelDocuments.entries()) {
        let dirty = panel.dirty;
        let savedQuery = savedQueriesRef.current[panel.id] ?? panel.savedQuery;
        if (panel.filePath && lastAutoSavedDocRef.current[panel.id] !== content) {
          await writeTextFile(panel.filePath, content);
          dirty = false;
          dirtyUpdates[panel.id] = false;
        }
        if (savedQuery && savedQuery.content !== content) {
          try {
            savedQuery = await dbSaveSavedQuery({
              ...savedQuery,
              content,
              updatedAt: savedAt,
            });
            savedQueriesRef.current[panel.id] = savedQuery;
            savedQueryUpdates[panel.id] = savedQuery;
            dirty = false;
            dirtyUpdates[panel.id] = false;
          } catch (error) {
            dirty = true;
            dirtyUpdates[panel.id] = true;
            savedQueryErrors.push(`${savedQuery.name}: ${String(error)}`);
          }
        }
        tabs.push(
          workspaceTabFromPanel(
            workspaceSessionId,
            savedQuery === panel.savedQuery ? panel : { ...panel, savedQuery },
            index,
            content,
            savedAt,
            dirty,
          ),
        );
      }

      await dbSaveQueryWorkspace({
        workspaceId: workspaceSessionId,
        activePanelId: snapshotActivePanelId,
        tabs,
        updatedAt: savedAt,
      });
      for (const tab of tabs) {
        lastAutoSavedDocRef.current[tab.panelId] = tab.content;
      }
      return { dirtyUpdates, savedQueryUpdates, savedQueryErrors };
    },
    [workspaceSessionId],
  );

  const autoSaveWorkspace = useCallback(async () => {
    if (!workspaceReady) return;
    if (autoSaveInFlightRef.current) return autoSaveInFlightRef.current;
    const save = (async () => {
      try {
        const currentPanels = panelsRef.current;
        const { dirtyUpdates, savedQueryUpdates, savedQueryErrors } =
          await persistWorkspaceSnapshot(currentPanels, activePanelIdRef.current);
        if (Object.keys(dirtyUpdates).length > 0 || Object.keys(savedQueryUpdates).length > 0) {
          setPanels((prev) => {
            const next = prev.map((panel) =>
              dirtyUpdates[panel.id] === undefined && savedQueryUpdates[panel.id] === undefined
                ? panel
                : {
                    ...panel,
                    dirty: dirtyUpdates[panel.id] ?? panel.dirty,
                    savedQuery: savedQueryUpdates[panel.id] ?? panel.savedQuery,
                  },
            );
            panelsRef.current = next;
            return next;
          });
        }
        if (savedQueryErrors.length > 0) {
          setStatusMessage(`Saved query auto-save failed: ${savedQueryErrors.join("; ")}`);
        }
      } catch (err) {
        setStatusMessage(`Query auto-save failed: ${String(err)}`);
      }
    })();
    autoSaveInFlightRef.current = save;
    try {
      await save;
    } finally {
      if (autoSaveInFlightRef.current === save) autoSaveInFlightRef.current = null;
    }
  }, [persistWorkspaceSnapshot, setStatusMessage, workspaceReady]);

  const flushWorkspace = useCallback(async () => {
    await autoSaveWorkspace();
    await autoSaveWorkspace();
  }, [autoSaveWorkspace]);

  const scheduleWorkspaceSave = useCallback(() => {
    if (autoSaveDebounceRef.current) clearTimeout(autoSaveDebounceRef.current);
    autoSaveDebounceRef.current = setTimeout(() => {
      autoSaveDebounceRef.current = null;
      void autoSaveWorkspace();
    }, 1000);
  }, [autoSaveWorkspace]);

  useEffect(() => {
    const timer = setInterval(() => {
      void autoSaveWorkspace();
    }, QUERY_AUTO_SAVE_MS);
    return () => {
      clearInterval(timer);
      if (autoSaveDebounceRef.current) {
        clearTimeout(autoSaveDebounceRef.current);
        autoSaveDebounceRef.current = null;
      }
      void flushWorkspace();
    };
  }, [autoSaveWorkspace, flushWorkspace]);

  const anyRunning = panels.some((p) => p.sheets.some((sheet) => sheet.running));
  useEffect(() => {
    setTabHasNewOutput(tabId, anyRunning && !visible);
  }, [anyRunning, visible, tabId, setTabHasNewOutput]);

  const streamQueryIntoSheet = useCallback(
    async (
      panelId: string,
      sheetId: string,
      sql: string,
      maxRows: number,
      resetRowsOnColumns = false,
    ): Promise<QueryExecutionSummary> => {
      const started = Date.now();
      const timer = setInterval(() => {
        patchSheet(panelId, sheetId, { elapsedMs: Date.now() - started });
      }, 100);
      timersRef.current[sheetId] = timer;
      let sawDone = false;
      let columnCount = 0;
      let rowCount = 0;
      let summary: QueryExecutionSummary | null = null;
      try {
        if (!connectionSessionId) throw new Error("Database connection is still starting.");
        await dbExecuteStream(connectionSessionId, sql, maxRows, (event) => {
          if (event.kind === "columns") {
            columnCount = event.columns.length;
            updateSheet(panelId, sheetId, (current) => {
              const result = current.result ?? emptyQueryResult();
              return {
                ...current,
                result: {
                  ...result,
                  columns: event.columns,
                  rows: resetRowsOnColumns ? [] : result.rows,
                },
              };
            });
          } else if (event.kind === "rows") {
            rowCount += event.rows.length;
            updateSheet(panelId, sheetId, (current) => {
              const result = current.result ?? emptyQueryResult();
              const remaining = Math.max(0, current.rowLimit - result.rows.length);
              const rows = remaining > 0 ? event.rows.slice(0, remaining) : [];
              return { ...current, result: { ...result, rows: [...result.rows, ...rows] } };
            });
          } else {
            sawDone = true;
            const warnings = event.warnings ?? [];
            const elapsedMs = Date.now() - started;
            summary = {
              ok: true,
              durationMs: event.durationMs,
              rowsAffected: event.rowsAffected,
              rowCount,
              hasResultSet: columnCount > 0,
              error: null,
            };
            updateSheet(panelId, sheetId, (current) => {
              const result = current.result ?? emptyQueryResult();
              return {
                ...current,
                result: {
                  ...result,
                  rowsAffected: event.rowsAffected,
                  durationMs: event.durationMs,
                  warnings,
                },
                warnings,
                running: false,
                cancelling: false,
                elapsedMs,
                error: null,
                resultTab: warnings.length > 0 ? "messages" : "results",
              };
            });
          }
        });
        if (!sawDone) {
          patchSheet(panelId, sheetId, { running: false, cancelling: false, elapsedMs: Date.now() - started });
          summary = {
            ok: true,
            durationMs: Date.now() - started,
            rowsAffected: null,
            rowCount,
            hasResultSet: columnCount > 0,
            error: null,
          };
        }
        metadataCache?.invalidateSql(sql, {
          engine: info.engine,
          activeSchema,
          defaultCatalog: info.catalog,
        });
        return summary ?? {
          ok: true,
          durationMs: Date.now() - started,
          rowsAffected: null,
          rowCount,
          hasResultSet: columnCount > 0,
          error: null,
        };
      } catch (err) {
        const error = String(err);
        patchSheet(panelId, sheetId, {
          running: false,
          cancelling: false,
          elapsedMs: Date.now() - started,
          error,
          warnings: [],
          resultTab: "messages",
        });
        return {
          ok: false,
          durationMs: Date.now() - started,
          rowsAffected: null,
          rowCount,
          hasResultSet: columnCount > 0,
          error,
        };
      } finally {
        if (timersRef.current[sheetId] === timer) {
          clearInterval(timer);
          delete timersRef.current[sheetId];
        }
      }
    },
    [activeSchema, connectionSessionId, info.catalog, info.engine, metadataCache, patchSheet, updateSheet],
  );

  const statementRangesForRun = useCallback(
    (sqlText: string, context?: SqlEditorRunContext): SqlStatementRange[] => {
      const ranges = sqlStatementRangesForExecution(info.engine, sqlText);
      const selection = context?.selectionRange;
      if (!selection) return ranges;
      const selectedText = context.doc.slice(selection.from, selection.to);
      if (selectedText !== sqlText) return ranges;
      return ranges.map((range) => ({
        ...range,
        from: range.from + selection.from,
        to: range.to + selection.from,
      }));
    },
    [info.engine],
  );

  const refreshHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const entries = await dbListHistory({
        savedSessionId: workspaceSessionId,
        engine: info.engine,
        limit: MAX_HISTORY,
      });
      setHistoryEntries(entries);
    } catch (err) {
      setStatusMessage(`Query history load failed: ${String(err)}`);
    } finally {
      setHistoryLoading(false);
    }
  }, [info.engine, setStatusMessage, workspaceSessionId]);

  const appendSqlHistory = useCallback(
    async (
      sql: string,
      startedAt: number,
      summary: QueryExecutionSummary,
    ) => {
      const entry: DbSqlHistoryEntry = {
        id: createSqlHistoryId(),
        savedSessionId: workspaceSessionId,
        engine: info.engine,
        host: info.host,
        port: info.port,
        catalog: info.catalog ?? null,
        databaseName: info.database ?? null,
        schemaName: activeSchema ?? null,
        sqlContent: sql,
        startedAt,
        durationMs: summary.durationMs,
        rowsAffected: summary.rowsAffected,
        rowCount: summary.rowCount,
        hasResultSet: summary.hasResultSet,
        error: summary.error,
        createdAt: Date.now(),
      };
      try {
        await dbAppendHistory(entry);
        if (historyPanelId) {
          await refreshHistory();
        }
      } catch (err) {
        setStatusMessage(`Query history save failed: ${String(err)}`);
      }
    },
    [activeSchema, historyPanelId, info.catalog, info.database, info.engine, info.host, info.port, refreshHistory, setStatusMessage, workspaceSessionId],
  );

  const runQuery = useCallback(
    async (
      panelId: string,
      sqlText: string,
      options: {
        context?: SqlEditorRunContext;
        origin?: SqlStatementSourceRef["origin"];
        historyId?: string;
        parentSheetId?: string;
      } = {},
    ) => {
      const trimmed = sqlText.trim();
      if (!trimmed) return;
      const panel = panelsRef.current.find((p) => p.id === panelId);
      if (panel?.sheets.some((sheet) => sheet.running)) return;
      const statementRanges = statementRangesForRun(sqlText, options.context);
      if (statementRanges.length === 0) return;
      // Record in-memory history per executable statement (newest first, dedup consecutive).
      const panelHistory = historyRef.current[panelId] ?? [];
      const nextHistory = [...panelHistory];
      for (const range of [...statementRanges].reverse()) {
        if (nextHistory[0] !== range.sql) {
          nextHistory.unshift(range.sql);
        }
      }
      historyRef.current[panelId] = nextHistory.slice(0, MAX_HISTORY);

      const baseOrdinal = panel?.sheets.length ?? 0;
      for (const [index, statement] of statementRanges.entries()) {
        const sourceRef = sourceRefForRange(panelId, statement, options.origin ?? "editor", {
          historyId: options.historyId,
          parentSheetId: options.parentSheetId,
        });
        const sheet = newResultSheet(statement.sql, baseOrdinal + index + 1, rowLimit, sourceRef);
        setPanels((prev) =>
          prev.map((p) => {
            if (p.id !== panelId) return p;
            const sheets = [...p.sheets, sheet].slice(-maxResultSheets);
            return {
              ...p,
              sheets,
              activeSheetId: sheet.id,
            };
          }),
        );
        const summary = await streamQueryIntoSheet(panelId, sheet.id, statement.sql, rowLimit);
        await appendSqlHistory(statement.sql, sheet.createdAt, summary);
        if (!summary.ok) break;
      }
    },
    [appendSqlHistory, maxResultSheets, rowLimit, statementRangesForRun, streamQueryIntoSheet],
  );

  const insertQueryFromOutside = useCallback(
    (
      sql: string,
      options?: {
        run?: boolean;
        destination?: "current" | "new";
        position?: "caret" | "first" | "last" | "replaceAll";
      },
    ) => {
      const text = sql.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      if (!text.trim()) return;
      if (options?.destination === "new" && panels.length < MAX_PANELS) {
        const panel = newPanel({ doc: text, dirty: true });
        setPanels((prev) => [...prev, panel]);
        setActivePanelId(panel.id);
        if (options.run) {
          void runQuery(panel.id, text);
        }
        return;
      }
      const panelId = activePanelId;
      const editor = editorHandles.current[panelId];
      const current = editor?.getValue() ?? panels.find((p) => p.id === panelId)?.doc ?? "";
      const position = options?.position ?? "replaceAll";
      const next =
        position === "first"
          ? `${text}${current ? `\n${current}` : ""}`
          : position === "last"
            ? `${current}${current ? "\n" : ""}${text}`
            : position === "caret"
              ? null
              : text;
      if (next === null) {
        editor?.insertText(text);
        patchPanel(panelId, { doc: editor?.getValue() ?? `${current}${text}`, dirty: true });
      } else {
        editor?.setValue(next);
        patchPanel(panelId, { doc: next, dirty: true });
      }
      if (options?.run) {
        void runQuery(panelId, next ?? text);
      }
    },
    [activePanelId, panels, patchPanel, runQuery],
  );

  // Append a statement echoed from an AI/Claude Code SQL execution to a stable
  // "echo target" panel — never runs it. The whole chat session's SQL
  // accumulates in one editor (reusing the remembered panel, else the active
  // panel, else a fresh one when the tab has none).
  const appendEchoSqlFromOutside = useCallback((sql: string, note?: string) => {
    const cleaned = sql.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    if (!cleaned) return;
    // Each statement ends with exactly one semicolon; prepend the comment note.
    const stmt = `${cleaned.replace(/;+\s*$/, "")};`;
    const block = note ? `${note}\n${stmt}` : stmt;

    const livePanels = panelsRef.current;
    const remembered =
      echoPanelIdRef.current && livePanels.some((p) => p.id === echoPanelIdRef.current)
        ? echoPanelIdRef.current
        : null;
    const activeId = activePanelIdRef.current;
    const targetId =
      remembered ??
      (livePanels.some((p) => p.id === activeId) ? activeId : livePanels[0]?.id ?? null);

    if (!targetId) {
      // Tab has no panel yet → open one seeded with the statement.
      const panel = newPanel({ doc: block, dirty: true });
      echoPanelIdRef.current = panel.id;
      setPanels((prev) => {
        const next = [...prev, panel].slice(-MAX_PANELS);
        panelsRef.current = next;
        return next;
      });
      setActivePanelId(panel.id);
      return;
    }

    echoPanelIdRef.current = targetId;
    const editor = editorHandles.current[targetId];
    const current = editor?.getValue() ?? livePanels.find((p) => p.id === targetId)?.doc ?? "";
    const joined = current.trim() ? `${current.replace(/\n+$/, "")}\n\n${block}` : block;
    // `editor` is only live for the mounted (active) panel; for others the doc
    // patch is enough — the editor picks it up when that panel mounts.
    editor?.setValue(joined);
    panelsRef.current = livePanels.map((p) =>
      p.id === targetId ? { ...p, doc: joined, dirty: true } : p
    );
    patchPanel(targetId, { doc: joined, dirty: true });
    setActivePanelId(targetId);
    editor?.focus();
  }, [patchPanel]);

  const queryRegistryTitle = useMemo(() => {
    const database = info.engine === "Presto"
      ? [info.catalog, info.database].filter(Boolean).join(".")
      : info.database;
    return `${info.engine} ${info.host}:${info.port}${database ? `/${database}` : ""}`;
  }, [info.catalog, info.database, info.engine, info.host, info.port]);

  useEffect(() => {
    return registerQueryTab({
      tabId,
      title: queryRegistryTitle,
      engine: info.engine,
      insertQuery: insertQueryFromOutside,
      appendEchoSql: appendEchoSqlFromOutside,
      flushWorkspace,
    });
  }, [appendEchoSqlFromOutside, flushWorkspace, info.engine, insertQueryFromOutside, queryRegistryTitle, tabId]);

  const captureDbFrame = useCallback(async () => {
    if (!rootRef.current) return null;
    return await renderElementToCanvas(rootRef.current);
  }, []);

  // Publish this DB view as the active capture source while visible, so the
  // screenshot actions (tab-strip `⋯` menu / detached capture button) target it.
  useEffect(() => {
    if (!visible) return;
    const source: CaptureSource = {
      filenamePrefix: safeFilePart(`db-${info.engine}-${info.host}`),
      getVisible: async () => {
        if (!rootRef.current) throw new Error("Database view not ready");
        return await captureElementPng(rootRef.current);
      },
      getFull: async () => {
        if (!rootRef.current) throw new Error("Database view not ready");
        return await captureElementPng(rootRef.current);
      },
      getScrollFrame: captureDbFrame,
      getGifFrame: captureDbFrame,
      onStatus: setStatusMessage,
    };
    useCaptureStore.getState().setSource(source);
    return () => useCaptureStore.getState().clearSource(source);
  }, [visible, info.engine, info.host, captureDbFrame, setStatusMessage]);

  const cancelQuery = useCallback((panelId?: string) => {
    setPanels((prev) =>
      prev.map((p) =>
        panelId && p.id !== panelId
          ? p
          : {
              ...p,
              sheets: p.sheets.map((sheet) => (sheet.running ? { ...sheet, cancelling: true } : sheet)),
            },
      ),
    );
    if (connectionSessionId) {
      void dbCancel(connectionSessionId).catch(() => undefined);
    }
  }, [connectionSessionId]);

  const refreshSheet = useCallback(
    async (panelId: string, sheetId: string, mode: QueryRefreshMode, sqlOverride?: string) => {
      const panel = panelsRef.current.find((p) => p.id === panelId);
      const sheet = panel?.sheets.find((candidate) => candidate.id === sheetId);
      const trimmed = (sqlOverride ?? sheet?.sql ?? "").trim();
      if (!panel || !sheet || !trimmed) return;
      if (panel.sheets.some((candidate) => candidate.running)) return;

      const effectiveLimit = mode === "currentLimit" ? rowLimit : sheet.rowLimit;
      if (timersRef.current[sheetId]) {
        clearInterval(timersRef.current[sheetId]);
        delete timersRef.current[sheetId];
      }
      patchSheet(panelId, sheetId, {
        sql: trimmed,
        result: mode === "clearView" ? emptyQueryResult() : sheet.result ?? emptyQueryResult(),
        error: null,
        warnings: [],
        running: true,
        cancelling: false,
        elapsedMs: 0,
        createdAt: Date.now(),
        rowLimit: effectiveLimit,
        resultTab: "results",
      });

      await streamQueryIntoSheet(panelId, sheetId, trimmed, effectiveLimit, true);
    },
    [patchSheet, rowLimit, streamQueryIntoSheet],
  );

  const commitGridChanges = useCallback(
    async (panelId: string, sheetId: string, payload: QueryGridCommitPayload) => {
      const panel = panels.find((p) => p.id === panelId);
      const sheet = panel?.sheets.find((candidate) => candidate.id === sheetId);
      if (!panel || !sheet) throw new Error("Result sheet is no longer available.");
      const target = parseEditableSelectTarget(sheet.sql);
      if (!target) {
        throw new Error("Grid write-back supports simple SELECT ... FROM table result sheets only.");
      }
      const schema = target.schema ?? activeSchema;
      const tableName = qualifiedName(info.engine, schema, target.table, info.catalog);
      let described: DbColumnDescription[] = [];
      try {
        if (!connectionSessionId) throw new Error("Database connection is still starting.");
        described = metadataCache
          ? await metadataCache.describeTable(schema, target.table, info.catalog)
          : await dbDescribeTable(connectionSessionId, schema, target.table, info.catalog);
      } catch {
        described = [];
      }
      const resultColumnNames = payload.columns.map((column) => column.name);
      const primaryKeys = described
        .filter((column) => column.primaryKey && resultColumnNames.includes(column.name))
        .map((column) => column.name);
      const whereColumns = primaryKeys.length > 0 ? primaryKeys : resultColumnNames;
      const statements: string[] = [];
      for (const change of payload.changes) {
        if (change.status === "inserted") {
          const cols = resultColumnNames.map((name) => quoteIdent(info.engine, name)).join(", ");
          const values = change.values.map(sqlLiteral).join(", ");
          statements.push(`INSERT INTO ${tableName} (${cols}) VALUES (${values})`);
        } else if (change.status === "updated") {
          if (!change.original) continue;
          const assignments = resultColumnNames
            .map((name, index) =>
              change.values[index] === change.original?.[index]
                ? null
                : `${quoteIdent(info.engine, name)} = ${sqlLiteral(change.values[index])}`,
            )
            .filter((value): value is string => Boolean(value));
          if (assignments.length === 0) continue;
          const where = whereForColumns(info.engine, whereColumns, resultColumnNames, change.original);
          statements.push(`UPDATE ${tableName} SET ${assignments.join(", ")} WHERE ${where}`);
        } else if (change.status === "deleted") {
          if (!change.original) continue;
          const where = whereForColumns(info.engine, whereColumns, resultColumnNames, change.original);
          statements.push(`DELETE FROM ${tableName} WHERE ${where}`);
        }
      }
      if (statements.length === 0) return;
      for (const sql of statements) {
        if (!connectionSessionId) throw new Error("Database connection is still starting.");
        await dbExecute(connectionSessionId, sql);
      }
      setStatusMessage(
        `Submitted grid changes: ${payload.counts.inserted} added, ${payload.counts.updated} modified, ${payload.counts.deleted} deleted.`,
      );
      await refreshSheet(panelId, sheetId, "clearView");
    },
    [activeSchema, connectionSessionId, info.catalog, info.engine, metadataCache, panels, refreshSheet, setStatusMessage],
  );

  const onSchemaLoaded = useCallback((tables: Map<string, string[]>) => {
    setSchemaMap((prev) => {
      const next = { ...prev };
      for (const [name, cols] of tables) {
        if (!next[name] || cols.length > 0) next[name] = cols;
      }
      return next;
    });
  }, []);

  const onSchemasLoaded = useCallback((names: string[]) => {
    setSchemas(names);
    setActiveSchema((current) => {
      if (current && names.includes(current)) return current;
      if (engineUsesDatabaseAsSchema(info.engine) && info.database && names.includes(info.database)) return info.database;
      return names[0] ?? null;
    });
  }, [info.database, info.engine]);

  useEffect(() => {
    if (!metadataCache) return;
    let cancelled = false;
    void metadataCache
      .listSchemas(info.catalog)
      .then((names) => {
        if (!cancelled) onSchemasLoaded(names);
      })
      .catch((error) => {
        if (!cancelled) setStatusMessage(`Schema metadata failed: ${String(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [info.catalog, metadataCache, onSchemasLoaded, setStatusMessage]);

  const metadataSchema = useMemo(
    () =>
      metadataCache
        ? sqlNamespaceFromMetadata({
            cache: metadataCache,
            engine: info.engine,
            activeSchema,
            catalog: info.catalog,
          })
        : undefined,
    [activeSchema, info.catalog, info.engine, metadataCache, metadataVersion],
  );

  const editorSchema = metadataSchema ?? (Object.keys(schemaMap).length > 0 ? schemaMap : undefined);

  const switchSchema = useCallback(
    async (schema: string) => {
      if (!schema || schema === activeSchema) return;
      if (info.engine === "SQLServer") {
        setActiveSchema(schema);
        setStatusMessage(`Active schema: ${schema}`);
        return;
      }
      const panelId = activePanelId;
      const sql = schemaSwitchSql(info.engine, schema, info.catalog);
      try {
        if (!connectionSessionId) throw new Error("Database connection is still starting.");
        await dbExecute(connectionSessionId, sql);
        // Update UI active schema (toolbar dropdown + tree highlight) without
        // dumping a success result sheet on every click.
        setActiveSchema(schema);
        setStatusMessage(`Active schema: ${schema}`);
      } catch (err) {
        const panel = panels.find((p) => p.id === panelId);
        const sheet = newResultSheet(sql, (panel?.sheets.length ?? 0) + 1, rowLimit);
        sheet.title = "Schema";
        setPanels((prev) =>
          prev.map((p) =>
            p.id === panelId
              ? {
                  ...p,
                  sheets: [
                    ...p.sheets,
                    {
                      ...sheet,
                      result: null,
                      running: false,
                      error: String(err),
                      warnings: [],
                      resultTab: "messages" as ResultSubTab,
                    },
                  ].slice(-maxResultSheets),
                  activeSheetId: sheet.id,
                }
              : p,
          ),
        );
        setStatusMessage(`Schema switch failed: ${String(err)}`);
      }
    },
    [activePanelId, activeSchema, connectionSessionId, info.catalog, info.engine, maxResultSheets, panels, rowLimit],
  );
  const insertIntoActive = useCallback(
    (text: string) => {
      editorHandles.current[activePanelId]?.insertText(text);
    },
    [activePanelId],
  );

  const quickSelect = useCallback(
    (schema: string | null, table: string) => {
      const sql = dialectSelectStatement(
        asSqlEngine(info.engine),
        { catalog: info.catalog, schema: schema ?? activeSchema, name: table },
        [],
        rowLimit,
      );
      editorHandles.current[activePanelId]?.setValue(sql);
      void runQuery(activePanelId, sql);
    },
    [activePanelId, activeSchema, info.catalog, info.engine, rowLimit, runQuery],
  );

  const handleSchemaSelectionChange = useCallback(
    (objects: SchemaTreeSelectedObject[]) => {
      setTabDbSelectedObjects(
        tabId,
        objects.map((object) => ({
          catalog: info.catalog ?? null,
          schema: object.schema,
          name: object.name,
          kind: object.kind,
        })),
      );
    },
    [info.catalog, setTabDbSelectedObjects, tabId],
  );

  const addPanel = () => {
    if (panels.length >= MAX_PANELS) return;
    const p = newPanel();
    setPanels((prev) => [...prev, p]);
    setActivePanelId(p.id);
  };

  const cleanupClosedPanels = (closingPanels: PanelState[]) => {
    if (closingPanels.some((panel) => panel.sheets.some((sheet) => sheet.running))) {
      if (connectionSessionId) {
        void dbCancel(connectionSessionId).catch(() => undefined);
      }
    }
    closingPanels.forEach((panel) => {
      panel.sheets.forEach((sheet) => {
        if (timersRef.current[sheet.id]) {
          clearInterval(timersRef.current[sheet.id]);
          delete timersRef.current[sheet.id];
        }
      });
      delete editorHandles.current[panel.id];
      delete historyRef.current[panel.id];
      delete lastAutoSavedDocRef.current[panel.id];
      delete savedQueriesRef.current[panel.id];
    });
  };

  const closePanel = async (id: string) => {
    if (panels.length <= 1) return;
    const closing = panels.find((p) => p.id === id);
    if (!closing) return;
    const next = panels.filter((p) => p.id !== id);
    const nextActivePanelId = activePanelId === id ? next[0].id : activePanelId;
    try {
      await persistWorkspaceSnapshot(panels, activePanelId);
      await dbCloseQueryWorkspaceTabs(workspaceSessionId, [id], Date.now());
    } catch (err) {
      setStatusMessage(`Query tab close failed: ${String(err)}`);
      return;
    }
    cleanupClosedPanels([closing]);
    panelsRef.current = next;
    setPanels(next);
    if (activePanelId === id) setActivePanelId(nextActivePanelId);
    void persistWorkspaceSnapshot(next, nextActivePanelId).catch((err) => {
      setStatusMessage(`Query workspace save failed: ${String(err)}`);
    });
  };

  const closeOtherPanels = async (id: string) => {
    const target = panels.find((p) => p.id === id);
    if (!target || panels.length <= 1) return;
    const closing = panels.filter((p) => p.id !== id);
    try {
      await persistWorkspaceSnapshot(panels, activePanelId);
      await dbCloseQueryWorkspaceTabs(
        workspaceSessionId,
        closing.map((panel) => panel.id),
        Date.now(),
      );
    } catch (err) {
      setStatusMessage(`Query tabs close failed: ${String(err)}`);
      return;
    }
    cleanupClosedPanels(closing);
    panelsRef.current = [target];
    setPanels([target]);
    setActivePanelId(id);
    void persistWorkspaceSnapshot([target], id).catch((err) => {
      setStatusMessage(`Query workspace save failed: ${String(err)}`);
    });
  };

  const closeAllPanels = async () => {
    try {
      await persistWorkspaceSnapshot(panels, activePanelId);
      await dbCloseQueryWorkspaceTabs(
        workspaceSessionId,
        panels.map((panel) => panel.id),
        Date.now(),
      );
    } catch (err) {
      setStatusMessage(`Query tabs close failed: ${String(err)}`);
      return;
    }
    cleanupClosedPanels(panels);
    const p = newPanel();
    panelsRef.current = [p];
    setPanels([p]);
    setActivePanelId(p.id);
    void persistWorkspaceSnapshot([p], p.id).catch((err) => {
      setStatusMessage(`Query workspace save failed: ${String(err)}`);
    });
  };

  const panelSql = (panel: PanelState) => editorHandles.current[panel.id]?.getValue() ?? panel.doc;

  const editorRunPayload = (panel: PanelState, selectionOnly: boolean) => {
    const handle = editorHandles.current[panel.id];
    const doc = handle?.getValue() ?? panel.doc;
    const selectionRange = selectionOnly ? handle?.getSelectionRange() ?? null : null;
    const cursorPosition = handle?.getCursorPosition() ?? doc.length;
    return {
      sql: selectionRange ? doc.slice(selectionRange.from, selectionRange.to) : doc,
      context: {
        doc,
        cursorPosition,
        selectionRange,
      } satisfies SqlEditorRunContext,
    };
  };

  const formatPanel = (panel: PanelState) => {
    const handle = editorHandles.current[panel.id];
    const formatted = formatSql(handle?.getValue() ?? panel.doc, info.engine);
    if (handle) {
      handle.setValue(formatted);
    } else {
      patchPanel(panel.id, { doc: formatted, dirty: true });
    }
  };

  const openPanelMenu = (event: ReactMouseEvent, panel: PanelState) => {
    setActivePanelId(panel.id);
    const running = panel.sheets.some((sheet) => sheet.running);
    const sqlText = panelSql(panel);
    const hasEditor = !!editorHandles.current[panel.id];
    const items: MenuItem[] = [
      {
        label: "Run query",
        icon: <Play className="w-3 h-3" />,
        onClick: () => {
          const payload = editorRunPayload(panel, false);
          void runQuery(panel.id, payload.sql, { context: payload.context });
        },
        disabled: running || !sqlText.trim(),
      },
      {
        label: "Run selection",
        icon: <SquareDashedMousePointer className="w-3 h-3" />,
        onClick: () => {
          const payload = editorRunPayload(panel, true);
          void runQuery(panel.id, payload.sql, { context: payload.context });
        },
        disabled: running || !hasEditor,
      },
      {
        label: "Run current statement",
        icon: <Crosshair className="w-3 h-3" />,
        onClick: () => {
          setActivePanelId(panel.id);
          runCurrentStatement(panel.id);
        },
        disabled: running || !hasEditor,
      },
      {
        label: "Format SQL",
        icon: <Sparkles className="w-3 h-3" />,
        onClick: () => formatPanel(panel),
        disabled: !sqlText.trim(),
      },
      {
        label: "Save query tab",
        icon: <Save className="w-3 h-3" />,
        onClick: () => void saveQueryFile(panel),
      },
      { label: "", separator: true, onClick: () => {} },
      {
        label: "New query tab",
        icon: <Plus className="w-3 h-3" />,
        onClick: addPanel,
        disabled: panels.length >= MAX_PANELS,
      },
      {
        label: "Close",
        icon: <X className="w-3 h-3" />,
        onClick: () => void closePanel(panel.id),
        disabled: panels.length <= 1,
      },
      {
        label: "Close others",
        icon: <X className="w-3 h-3" />,
        onClick: () => void closeOtherPanels(panel.id),
        disabled: panels.length <= 1,
      },
      {
        label: "Close all",
        icon: <X className="w-3 h-3" />,
        onClick: () => void closeAllPanels(),
      },
    ];
    queryTabMenu.show(event, items);
  };

  const closeResultSheets = (panelId: string, sheetIds: string[]) => {
    if (sheetIds.length === 0) return;
    const idSet = new Set(sheetIds);
    const panel = panels.find((p) => p.id === panelId);
    if (!panel) return;
    const closing = panel.sheets.filter((sheet) => idSet.has(sheet.id));
    if (closing.length === 0) return;
    if (closing.some((sheet) => sheet.running) && connectionSessionId) {
      void dbCancel(connectionSessionId).catch(() => undefined);
    }
    for (const sheet of closing) {
      if (timersRef.current[sheet.id]) {
        clearInterval(timersRef.current[sheet.id]);
        delete timersRef.current[sheet.id];
      }
    }
    setPanels((prev) =>
      prev.map((candidate) => {
        if (candidate.id !== panelId) return candidate;
        const sheets = candidate.sheets.filter((sheet) => !idSet.has(sheet.id));
        const activeClosed = !!candidate.activeSheetId && idSet.has(candidate.activeSheetId);
        return {
          ...candidate,
          sheets,
          activeSheetId: activeClosed ? sheets.at(-1)?.id ?? null : candidate.activeSheetId,
        };
      }),
    );
  };

  const closeResultSheet = (panelId: string, sheetId: string) => {
    closeResultSheets(panelId, [sheetId]);
  };

  const showPanelError = (panelId: string, message: string) => {
    const panel = panels.find((p) => p.id === panelId);
    const sheet = newResultSheet("", (panel?.sheets.length ?? 0) + 1, rowLimit);
    sheet.title = "Message";
    setPanels((prev) =>
      prev.map((p) =>
        p.id === panelId
          ? {
              ...p,
              sheets: [
                ...p.sheets,
                { ...sheet, running: false, result: null, error: message, resultTab: "messages" as ResultSubTab },
              ].slice(-maxResultSheets),
              activeSheetId: sheet.id,
            }
          : p,
      ),
    );
  };

  const saveQueryFile = async (panel: PanelState) => {
    const sql = editorHandles.current[panel.id]?.getValue() ?? panel.doc;
    const defaultName = panel.fileName ?? `query-${Date.now()}.sql`;
    const path = await selectSaveFilePath(defaultName, panel.filePath ?? undefined);
    if (!path) return;
    try {
      await writeTextFile(path, sql);
      lastAutoSavedDocRef.current[panel.id] = sql;
      patchPanel(panel.id, {
        filePath: path,
        fileName: basename(path) || defaultName,
        dirty: false,
      });
      const nextPanels = panels.map((candidate) =>
        candidate.id === panel.id
          ? { ...candidate, filePath: path, fileName: basename(path) || defaultName, dirty: false }
          : candidate,
      );
      panelsRef.current = nextPanels;
      await persistWorkspaceSnapshot(nextPanels, activePanelId);
    } catch (err) {
      showPanelError(panel.id, String(err));
    }
  };

  const initialWidth = useMemo(() => {
    try {
      const v = Number(localStorage.getItem(widthKey(info.engine)));
      return Number.isFinite(v) && v >= 0 && v <= 50 ? v : 24;
    } catch {
      return 24;
    }
  }, [info.engine]);

  const activePanel = panels.find((panel) => panel.id === activePanelId) ?? panels[0];

  const setPanelDocState = (panelId: string, doc: string) => {
    setPanels((prev) => {
      const next = prev.map((panel) => (panel.id === panelId ? { ...panel, doc, dirty: true } : panel));
      panelsRef.current = next;
      return next;
    });
  };

  const writePanelDocument = (panelId: string, doc: string) => {
    const editor = activePanelIdRef.current === panelId ? editorHandles.current[panelId] : null;
    editor?.setValue(doc);
    setPanelDocState(panelId, doc);
  };

  const syncGeneratedSqlPanel = (
    resultPanelId: string,
    sheetId: string,
    generatedSql: string,
    status: string | null = "Synced generated SQL to query editor.",
    options: { activate?: boolean } = {},
  ): string | null => {
    const activate = options.activate ?? true;
    const livePanels = panelsRef.current;
    const resultPanel = livePanels.find((panel) => panel.id === resultPanelId);
    const sheet = resultPanel?.sheets.find((candidate) => candidate.id === sheetId);
    if (!resultPanel || !sheet) {
      setStatusMessage("Result sheet is no longer available.");
      return null;
    }

    const existingTargetId =
      sheet.generatedTargetPanelId && livePanels.some((panel) => panel.id === sheet.generatedTargetPanelId)
        ? sheet.generatedTargetPanelId
        : null;
    if (existingTargetId) {
      writePanelDocument(existingTargetId, generatedSql);
      if (activate) setActivePanelId(existingTargetId);
      if (status) setStatusMessage(status);
      return existingTargetId;
    }

    if (livePanels.length >= MAX_PANELS) {
      setStatusMessage(`Maximum query panels reached (${MAX_PANELS}).`);
      return null;
    }

    const targetPanel = newPanel({ doc: generatedSql, dirty: true, fileName: "Generated SQL" });
    setPanels((prev) => {
      const next = [
        ...prev.map((panel) =>
          panel.id === resultPanelId
            ? {
                ...panel,
                sheets: panel.sheets.map((candidate) =>
                  candidate.id === sheetId
                    ? { ...candidate, generatedTargetPanelId: targetPanel.id }
                    : candidate,
                ),
              }
            : panel,
        ),
        targetPanel,
      ];
      panelsRef.current = next;
      return next;
    });
    if (activate) setActivePanelId(targetPanel.id);
    if (status) setStatusMessage(status);
    return targetPanel.id;
  };

  const replaceGeneratedSqlSource = (
    resultPanelId: string,
    sheetId: string,
    generatedSql: string,
    options: {
      activate?: boolean;
      focus?: boolean;
      status?: string | null;
      fallback?: boolean;
      updateSheetSql?: boolean;
    } = {},
  ): boolean => {
    const activate = options.activate ?? true;
    const focus = options.focus ?? true;
    const status = options.status ?? "Replaced source SQL with generated SQL.";
    const fallbackEnabled = options.fallback ?? true;
    const updateSheetSql = options.updateSheetSql ?? false;
    const fallback = () =>
      fallbackEnabled
        ? syncGeneratedSqlPanel(
            resultPanelId,
            sheetId,
            generatedSql,
            "Source SQL changed; synced generated SQL to a query editor instead.",
          )
        : null;
    const livePanels = panelsRef.current;
    const resultPanel = livePanels.find((panel) => panel.id === resultPanelId);
    const sheet = resultPanel?.sheets.find((candidate) => candidate.id === sheetId);
    const sourceRef = sheet?.sourceRef;
    if (!sheet || !sourceRef || sourceRef.origin !== "editor" || sourceRef.from === null || sourceRef.to === null) {
      fallback();
      return false;
    }

    const sourcePanel = livePanels.find((panel) => panel.id === sourceRef.panelId);
    if (!sourcePanel) {
      fallback();
      return false;
    }

    const from = sourceRef.from;
    const to = sourceRef.to;
    const editor = activePanelIdRef.current === sourcePanel.id ? editorHandles.current[sourcePanel.id] : null;
    const sourceDoc = editor?.getValue() ?? sourcePanel.doc;
    if (from < 0 || to < from || to > sourceDoc.length) {
      fallback();
      return false;
    }

    const currentSql = sourceDoc.slice(from, to);
    if (currentSql !== sourceRef.sql || hashSqlText(currentSql) !== sourceRef.exactHash) {
      fallback();
      return false;
    }

    const replaceTo = replacementEndWithExistingTerminator(sourceDoc, to, generatedSql);
    const nextDoc = `${sourceDoc.slice(0, from)}${generatedSql}${sourceDoc.slice(replaceTo)}`;
    const delta = generatedSql.length - (replaceTo - from);
    editor?.replaceRange(from, replaceTo, generatedSql, { focus });
    const nextPanels = livePanels.map((panel) => {
      const patchedPanel =
        panel.id === sourcePanel.id ? { ...panel, doc: nextDoc, dirty: true } : panel;
      const sheets = patchedPanel.sheets.map((candidate) => {
        const candidateRef = candidate.sourceRef;
        let nextRef = candidateRef;
        if (
          candidateRef &&
          candidateRef.panelId === sourcePanel.id &&
          candidateRef.from !== null &&
          candidateRef.to !== null
        ) {
          if (candidateRef.id === sourceRef.id) {
            nextRef = {
              ...candidateRef,
              sql: generatedSql,
              to: from + generatedSql.length,
              exactHash: hashSqlText(generatedSql),
              parentSheetId: sheetId,
            };
          } else if (candidateRef.from >= replaceTo) {
            nextRef = {
              ...candidateRef,
              from: candidateRef.from + delta,
              to: candidateRef.to + delta,
            };
          }
        }
        return {
          ...candidate,
          baseSql: updateSheetSql && panel.id === resultPanelId && candidate.id === sheetId
            ? generatedSql
            : candidate.baseSql,
          sql: updateSheetSql && panel.id === resultPanelId && candidate.id === sheetId
            ? generatedSql
            : candidate.sql,
          sourceRef: nextRef,
        };
      });
      return { ...patchedPanel, sheets };
    });
    panelsRef.current = nextPanels;
    setPanels(nextPanels);
    if (activate) setActivePanelId(sourcePanel.id);
    if (status) setStatusMessage(status);
    return true;
  };

  const queryGeneratedSqlFromSheet = async (
    resultPanelId: string,
    sheetId: string,
    generatedSql: string,
    rewriteRequest?: DbResultSqlRewriteRequest,
  ) => {
    let sql = generatedSql;
    if (rewriteRequest) {
      try {
        const rewritten = await dbRewriteResultSql(rewriteRequest);
        if (rewritten.mode !== "inline" || !rewritten.sql) {
          setStatusMessage(rewritten.reason ?? "SQL rewrite is not available for this result.");
          return;
        }
        sql = rewritten.sql;
      } catch (err) {
        setStatusMessage(`SQL rewrite failed: ${String(err)}`);
        return;
      }
    }

    const replaced = replaceGeneratedSqlSource(resultPanelId, sheetId, sql, {
      activate: false,
      focus: false,
      status: null,
      updateSheetSql: true,
    });
    if (!replaced) return;
    setStatusMessage("Applied result filters to SQL; refreshing result.");
    await refreshSheet(resultPanelId, sheetId, "clearView", sql);
  };

  const syncGeneratedSqlFromSheet = (
    resultPanelId: string,
    sheetId: string,
    generatedSql: string,
    mode: QueryGeneratedSqlSyncMode,
  ) => {
    if (mode === "replaceSource") {
      replaceGeneratedSqlSource(resultPanelId, sheetId, generatedSql, { updateSheetSql: true });
      return;
    }
    syncGeneratedSqlPanel(resultPanelId, sheetId, generatedSql);
  };

  const toggleHistoryPanel = () => {
    const opening = historyPanelId !== activePanel.id;
    setHistoryPanelId(opening ? activePanel.id : null);
    if (opening) setStatementAction(null);
    if (opening) void refreshHistory();
  };

  const selectSqlInActivePanel = (sql: string) => {
    const handle = editorHandles.current[activePanel.id];
    handle?.setValue(sql);
    handle?.selectRange(0, sql.length);
    patchPanel(activePanel.id, { doc: sql, dirty: true });
    setHistoryPanelId(null);
  };

  const openSqlInNewPanel = (
    sql: string,
    run = false,
    origin: SqlStatementSourceRef["origin"] = "history",
    savedQuery: DbSavedQuery | null = null,
  ) => {
    if (panelsRef.current.length >= MAX_PANELS) {
      setStatusMessage(`Maximum query panels reached (${MAX_PANELS}).`);
      return;
    }
    const panel = newPanel({ doc: sql, savedQuery, dirty: !savedQuery });
    if (savedQuery) savedQueriesRef.current[panel.id] = savedQuery;
    setPanels((prev) => {
      const next = [...prev, panel];
      panelsRef.current = next;
      return next;
    });
    setActivePanelId(panel.id);
    setHistoryPanelId(null);
    if (run) {
      setTimeout(() => {
        void runQuery(panel.id, sql, { origin });
      }, 0);
    }
  };

  const handleSavedQuery = (query: DbSavedQuery, created: boolean) => {
    const targetPanelId = created ? activePanel.id : null;
    setPanels((prev) => {
      const next = prev.map((panel) => {
        const matches = panel.id === targetPanelId || panel.savedQuery?.id === query.id;
        if (!matches) return panel;
        savedQueriesRef.current[panel.id] = query;
        if (!created && panel.doc !== query.content) {
          editorHandles.current[panel.id]?.setValue(query.content);
        }
        lastAutoSavedDocRef.current[panel.id] = query.content;
        return {
          ...panel,
          doc: created ? panel.doc : query.content,
          savedQuery: query,
          dirty: false,
        };
      });
      panelsRef.current = next;
      return next;
    });
    scheduleWorkspaceSave();
  };

  useEffect(
    () => subscribeSqlExecutionPreferences(setExecutionPreferences),
    [],
  );

  const currentEditorStatement = (panelId: string = activePanel.id): EditorStatementAction | null => {
    const panel = panels.find((p) => p.id === panelId) ?? activePanel;
    const handle = editorHandles.current[panel.id];
    const doc = handle?.getValue() ?? panel.doc;
    const selection = handle?.getSelectionRange() ?? null;
    const position = selection && selection.from !== selection.to
      ? selection.from
      : handle?.getCursorPosition() ?? doc.length;
    const ranges = splitSqlStatementRanges(doc, { splitGo: info.engine === "SQLServer" });
    const range =
      ranges.find((candidate) => candidate.from <= position && position <= candidate.to) ??
      (ranges.length === 1 ? ranges[0] : null);
    if (!range) {
      setStatusMessage("No SQL statement at the current cursor.");
      return null;
    }
    return { panelId: panel.id, doc, range };
  };

  const toggleStatementPanel = () => {
    if (statementAction?.panelId === activePanel.id) {
      setStatementAction(null);
      return;
    }
    const action = currentEditorStatement();
    if (!action) return;
    setHistoryPanelId(null);
    setStatementAction(action);
  };

  const runEditorStatement = (action: EditorStatementAction) => {
    void runQuery(action.panelId, action.range.sql, {
      context: {
        doc: action.doc,
        cursorPosition: action.range.from,
        selectionRange: { from: action.range.from, to: action.range.to },
      },
    });
    setStatementAction(null);
  };

  const runCurrentStatement = (panelId: string = activePanel.id) => {
    const action = currentEditorStatement(panelId);
    if (!action) return;
    runEditorStatement(action);
  };

  const selectEditorStatement = (action: EditorStatementAction) => {
    setActivePanelId(action.panelId);
    editorHandles.current[action.panelId]?.selectRange(action.range.from, action.range.to);
    setStatementAction(null);
  };

  const openEditorStatementInNewPanel = (action: EditorStatementAction) => {
    openSqlInNewPanel(action.range.sql, true, "editor");
    setStatementAction(null);
  };

  const latestResultForSql = (sql: string): DbQueryResult | null => {
    const target = sql.trim();
    for (const panel of [...panelsRef.current].reverse()) {
      for (const sheet of [...panel.sheets].reverse()) {
        if (sheet.sql.trim() === target && sheet.result && sheet.result.columns.length > 0) {
          return sheet.result;
        }
      }
    }
    return null;
  };

  const copyHistoryJson = async (entry: DbSqlHistoryEntry) => {
    const result = latestResultForSql(entry.sqlContent);
    if (!result) {
      setStatusMessage("No in-memory result is available for this SQL. Run it again to export JSON.");
      return;
    }
    try {
      await writeText(resultToJsonText(result));
      setStatusMessage("Copied query result JSON.");
    } catch (err) {
      setStatusMessage(`Copy JSON failed: ${String(err)}`);
    }
  };

  const copyStatementJson = async (action: EditorStatementAction) => {
    const result = latestResultForSql(action.range.sql);
    if (!result) {
      setStatusMessage("No in-memory result is available for this statement. Run it again to export JSON.");
      return;
    }
    try {
      await writeText(resultToJsonText(result));
      setStatusMessage("Copied statement result JSON.");
    } catch (err) {
      setStatusMessage(`Copy JSON failed: ${String(err)}`);
    }
  };

  const askAiAboutHistory = async (entry: DbSqlHistoryEntry) => {
    const result = latestResultForSql(entry.sqlContent);
    const resultSummary = result
      ? `\n\nResult summary: ${result.rows.length} row(s), ${result.columns.length} column(s).`
      : "";
    const prompt = [
      "请分析这条数据库 SQL，并结合执行信息说明含义、潜在问题和可优化点：",
      "",
      "```sql",
      entry.sqlContent,
      "```",
      "",
      `Engine: ${entry.engine}`,
      `Database: ${entry.databaseName ?? "-"}`,
      `Schema: ${entry.schemaName ?? "-"}`,
      `Duration: ${formatDurationMs(entry.durationMs) ?? "-"}`,
      `Rows: ${entry.rowCount ?? "-"}`,
      entry.error ? `Error: ${entry.error}` : null,
      resultSummary,
    ].filter((line): line is string => line !== null).join("\n");
    await useChatStore.getState().openTabChat(tabId);
    await useChatStore.getState().attachToComposer(prompt);
    setHistoryPanelId(null);
  };

  const askAiAboutStatement = async (action: EditorStatementAction) => {
    const result = latestResultForSql(action.range.sql);
    const resultSummary = result
      ? `\n\nResult summary: ${result.rows.length} row(s), ${result.columns.length} column(s).`
      : "";
    const prompt = [
      "请分析当前编辑器中的这条数据库 SQL，并说明含义、潜在问题和可优化点：",
      "",
      "```sql",
      action.range.sql,
      "```",
      "",
      `Engine: ${info.engine}`,
      `Database: ${info.database ?? "-"}`,
      `Schema: ${activeSchema ?? "-"}`,
      resultSummary,
    ].join("\n");
    await useChatStore.getState().openTabChat(tabId);
    await useChatStore.getState().attachToComposer(prompt);
    setStatementAction(null);
  };

  const deleteHistoryEntry = async (entry: DbSqlHistoryEntry) => {
    try {
      await dbDeleteHistory(entry.id);
      await refreshHistory();
    } catch (err) {
      setStatusMessage(`Delete query history failed: ${String(err)}`);
    }
  };

  const clearCurrentHistory = async () => {
    try {
      await dbClearHistory(workspaceSessionId);
      await refreshHistory();
    } catch (err) {
      setStatusMessage(`Clear query history failed: ${String(err)}`);
    }
  };

  useEffect(() => {
    setSchemaCollapsed(initialWidth === 0);
    if (initialWidth > 0) {
      lastVisibleSchemaWidthRef.current = initialWidth;
    }
  }, [initialWidth]);

  const expandSchemaPanel = () => {
    const nextSize = clampInt(lastVisibleSchemaWidthRef.current || 24, 12, 50);
    schemaPanelRef.current?.resize(`${nextSize}%`);
    setSchemaCollapsed(false);
    try {
      localStorage.setItem(widthKey(info.engine), String(nextSize));
    } catch {
      /* ignore */
    }
  };

  const handleSchemaResize = (size: PanelSize) => {
    const percentage = size.asPercentage;
    if (percentage > 0) {
      lastVisibleSchemaWidthRef.current = percentage;
    }
    setSchemaCollapsed(percentage === 0);
    try {
      localStorage.setItem(widthKey(info.engine), String(percentage));
    } catch {
      /* ignore */
    }
  };

  if (!workspaceReady) {
    return (
      <div
        ref={rootRef}
        className="h-full w-full flex items-center justify-center text-sm"
        style={{ ...dbFontStyle, background: "var(--taomni-bg)", color: "var(--taomni-text-muted)" }}
      >
        Loading query workspace...
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="h-full w-full flex flex-col relative"
      style={{ ...dbFontStyle, background: "var(--taomni-bg)", color: "var(--taomni-text)" }}
    >
      {queryTabMenu.render}
      {connError && (
        <div
          className="h-7 shrink-0 px-2 flex items-center gap-2 text-[11px] border-b"
          style={{ color: "#d9534f", borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
          title={connError}
          data-testid="db-connection-error-banner"
        >
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span className="font-semibold">Connection failed.</span>
          <span className="truncate text-[var(--taomni-text-muted)]">Query drafts and the Query Library remain available. {connError}</span>
        </div>
      )}
      <TabActions active={visible}>
        {chatToggle && (
          <button
            type="button"
            data-testid="db-chat-toggle"
            onClick={chatToggle.onToggle}
            title={chatToggle.open ? t("terminal.chatFloatingTitleClose") : t("terminal.chatFloatingTitleOpen")}
            aria-label={chatToggle.open ? t("terminal.chatFloatingLabelClose") : t("terminal.chatFloatingLabelOpen")}
            style={{
              ...FT_ICON_BUTTON_STYLE,
              ...(chatToggle.open ? FT_BUTTON_ACTIVE_OVERRIDE : {}),
            }}
          >
            <Bot size={14} />
          </button>
        )}
        {onDetach && (
          <button
            type="button"
            data-testid="db-detach"
            onClick={onDetach}
            title={t("rdp.detach")}
            aria-label={t("rdp.detach")}
            style={FT_ICON_BUTTON_STYLE}
          >
            <ExternalLink size={14} />
          </button>
        )}
        {detachedWindowControls && (
          <>
            <CaptureMenuButton />
            <button
              type="button"
              data-testid="detached-reattach"
              onClick={detachedWindowControls.onReattach}
              title={t("rdp.reattach")}
              aria-label={t("rdp.reattach")}
              style={FT_BUTTON_STYLE}
            >
              <ExternalLink size={14} />
              <span>{t("rdp.reattach")}</span>
            </button>
            <button
              type="button"
              data-testid="detached-os-fullscreen"
              onClick={detachedWindowControls.onToggleOsFullscreen}
              title={t("rdp.osFullscreen")}
              aria-label={t("rdp.osFullscreen")}
              style={FT_ICON_BUTTON_STYLE}
            >
              {detachedWindowControls.osFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          </>
        )}
      </TabActions>
      {schemaCollapsed && (
        <button
          type="button"
          data-testid="db-schema-drawer-handle"
          className="absolute left-0 top-12 z-30 h-24 w-6 inline-flex flex-col items-center justify-center gap-1 rounded-r border-y border-r shadow-sm hover:bg-[var(--taomni-hover)]"
          style={{
            background: "var(--taomni-panel-bg)",
            borderColor: "var(--taomni-divider)",
            color: "var(--taomni-text-muted)",
          }}
          title="Show database objects"
          aria-label="Show database objects"
          onClick={expandSchemaPanel}
        >
          <ChevronRight className="w-3.5 h-3.5" />
          <span className="text-[10px] leading-none" style={{ writingMode: "vertical-rl" }}>
            Objects
          </span>
        </button>
      )}
      <PanelGroup orientation="horizontal" id={`db-client-${info.engine}`} className="flex-1 min-h-0">
        <Panel
          panelRef={schemaPanelRef}
          id="schema"
          defaultSize={`${initialWidth}%`}
          minSize="12%"
          collapsedSize={0}
          collapsible
          maxSize="50%"
          onResize={handleSchemaResize}
        >
          <div className="h-full flex flex-col min-h-0 bg-[var(--taomni-bg)]" style={{ borderRight: "1px solid var(--taomni-divider)" }}>
            {/* Tab Headers */}
            <div className="h-7 shrink-0 flex border-b border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)]">
              <button
                type="button"
                className="flex-1 text-[11px] font-semibold flex items-center justify-center gap-1.5 h-full transition-colors"
                style={{
                  color: leftPanelTab === "schema" ? "var(--taomni-accent)" : "var(--taomni-text-muted)",
                  background: leftPanelTab === "schema" ? "var(--taomni-bg)" : "transparent",
                  borderRight: "1px solid var(--taomni-divider)",
                }}
                onClick={() => setLeftPanelTab("schema")}
              >
                <Database className="w-3.5 h-3.5" />
                Schema
              </button>
              <button
                type="button"
                className="flex-1 text-[11px] font-semibold flex items-center justify-center gap-1.5 h-full transition-colors"
                style={{
                  color: leftPanelTab === "queries" ? "var(--taomni-accent)" : "var(--taomni-text-muted)",
                  background: leftPanelTab === "queries" ? "var(--taomni-bg)" : "transparent",
                }}
                onClick={() => setLeftPanelTab("queries")}
                data-testid="db-query-library-tab"
              >
                <Files className="w-3.5 h-3.5" />
                Queries
              </button>
            </div>
            {/* Tab Body */}
            <div className="flex-1 min-h-0">
              {leftPanelTab === "schema" ? (
                connectionSessionId && (
                  <SchemaTree
                    sessionId={connectionSessionId}
                    engine={info.engine}
                    catalog={info.catalog}
                    databaseName={info.database}
                    activeSchema={activeSchema}
                    onSelectionChange={handleSchemaSelectionChange}
                    onInsertTable={insertIntoActive}
                    onQuickSelect={quickSelect}
                    quickSelectLimit={rowLimit}
                    onInsertSql={(sql) => insertQueryFromOutside(sql, { destination: "new" })}
                    onNewQuery={addPanel}
                    onSetDefaultSchema={(schema) => void switchSchema(schema)}
                    onStatus={setStatusMessage}
                    onSchemasLoaded={onSchemasLoaded}
                    onSchemaLoaded={onSchemaLoaded}
                    metadataCache={metadataCache ?? undefined}
                  />
                )
              ) : (
                <QueryLibraryPanel
                  engine={info.engine}
                  connectionId={workspaceSessionId}
                  activeContent={editorHandles.current[activePanel.id]?.getValue() ?? activePanel.doc}
                  catalogName={info.catalog}
                  databaseName={info.database}
                  schemaName={activeSchema}
                  onOpenQuery={(query) => openSqlInNewPanel(query.content, false, "generated", query)}
                  onRunQuery={(query) => openSqlInNewPanel(query.content, true, "generated", query)}
                  onSavedQuery={handleSavedQuery}
                  onAddTriggerRef={addQueryTriggerRef}
                />
              )}
            </div>
          </div>
        </Panel>
        <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-col-resize" />
        <Panel id="workspace">
          {/* Panel tab strip */}
          <div className="h-full flex flex-col min-w-0">
            <div
              className="h-7 shrink-0 flex items-center gap-1 px-1 text-[11px]"
              style={{ background: "var(--taomni-chrome-bg)", borderBottom: "1px solid var(--taomni-divider)" }}
            >
              {panels.map((p, i) => {
                const panelRunning = p.sheets.some((sheet) => sheet.running);
                const label = p.fileName ?? p.savedQuery?.name ?? `Query ${i + 1}`;
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
                    onContextMenu={(event) => openPanelMenu(event, p)}
                    title={p.filePath ?? label}
                  >
                    <span className="truncate">{label}{p.dirty ? "*" : ""}</span>
                    {panelRunning && <Loader2 className="w-3 h-3 shrink-0 animate-spin" />}
                    {panels.length > 1 && (
                      <X
                        className="w-3 h-3 shrink-0 hover:text-[var(--taomni-text)]"
                        onClick={(e) => {
                          e.stopPropagation();
                          void closePanel(p.id);
                        }}
                      />
                    )}
                  </button>
                );
              })}
              {panels.length < MAX_PANELS && (
                <button
                  type="button"
                  title="New query panel"
                  className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]"
                  onClick={addPanel}
                >
                  <Plus className="w-3 h-3" />
                </button>
              )}
            </div>

            <div
              key={activePanel.id}
              className="flex-1 min-h-0 h-full flex flex-col min-w-0 relative"
              data-active
            >
              <EditorToolbar
                engine={info.engine}
                schemas={schemas}
                activeSchema={activeSchema}
                running={activePanel.sheets.some((sheet) => sheet.running)}
                runAllTitle={`Run (${displaySqlShortcut(executionPreferences.runAll)})`}
                runSelectionTitle={`Run selection (${displaySqlShortcut(executionPreferences.runSelection)})`}
                runCurrentTitle={`Run current statement (${displaySqlShortcut(executionPreferences.runCurrent)})`}
                onRun={() => {
                  const payload = editorRunPayload(activePanel, false);
                  void runQuery(activePanel.id, payload.sql, { context: payload.context });
                }}
                onRunSelection={() => {
                  const payload = editorRunPayload(activePanel, true);
                  void runQuery(activePanel.id, payload.sql, { context: payload.context });
                }}
                onRunCurrent={runCurrentStatement}
                onCancel={() => cancelQuery(activePanel.id)}
                onFormat={() => formatPanel(activePanel)}
                onToggleStatement={toggleStatementPanel}
                onToggleHistory={toggleHistoryPanel}
                onSave={() => void saveQueryFile(activePanel)}
                onSaveQuery={() => addQueryTriggerRef.current?.()}
                onSchemaChange={(schema) => void switchSchema(schema)}
                rowLimit={rowLimit}
                maxResultSheets={maxResultSheets}
                onRowLimitChange={(value) =>
                  setRowLimit(clampInt(value, MIN_ROW_LIMIT, MAX_ROW_LIMIT))
                }
                onMaxResultSheetsChange={(value) =>
                  setMaxResultSheets(clampInt(value, MIN_RESULT_SHEETS, MAX_RESULT_SHEETS_LIMIT))
                }
              />
              {historyPanelId === activePanel.id && (
                <HistoryDropdown
                  entries={historyEntries}
                  loading={historyLoading}
                  onRefresh={() => void refreshHistory()}
                  onRun={(entry) => void runQuery(activePanel.id, entry.sqlContent, { origin: "history", historyId: entry.id })}
                  onSelect={(entry) => selectSqlInActivePanel(entry.sqlContent)}
                  onOpenTab={(entry) => openSqlInNewPanel(entry.sqlContent, true, "history")}
                  onJson={(entry) => void copyHistoryJson(entry)}
                  onAskAi={(entry) => void askAiAboutHistory(entry)}
                  onDelete={(entry) => void deleteHistoryEntry(entry)}
                  onClear={() => void clearCurrentHistory()}
                  onClose={() => setHistoryPanelId(null)}
                />
              )}
              {statementAction?.panelId === activePanel.id && (
                <StatementDropdown
                  action={statementAction}
                  hasJson={latestResultForSql(statementAction.range.sql) !== null}
                  onRun={runEditorStatement}
                  onSelect={selectEditorStatement}
                  onOpenTab={openEditorStatementInNewPanel}
                  onJson={(action) => void copyStatementJson(action)}
                  onAskAi={(action) => void askAiAboutStatement(action)}
                  onClose={() => setStatementAction(null)}
                />
              )}
              <PanelGroup orientation="vertical" className="flex-1 min-h-0">
                <Panel defaultSize="45%" minSize="15%">
                  <div
                    className="h-full w-full"
                    onContextMenu={(event) => openPanelMenu(event, activePanel)}
                  >
                    <SqlEditorPanel
                      engine={info.engine}
                      initialDoc={activePanel.doc}
                      schema={editorSchema}
                      metadataCache={metadataCache}
                      activeSchema={activeSchema}
                      catalog={info.catalog}
                      onMetadataStatus={setStatusMessage}
                      handleRef={(h) => {
                        editorHandles.current[activePanel.id] = h;
                      }}
                      onDocChange={(doc) => {
                        patchPanel(activePanel.id, { doc, dirty: true });
                        scheduleWorkspaceSave();
                      }}
                      onFocus={() => setActivePanelId(activePanel.id)}
                      onRun={(sql, context) => void runQuery(activePanel.id, sql, { context })}
                      onRunCurrent={() => runCurrentStatement()}
                    />
                  </div>
                </Panel>
                <PanelResizeHandle className="h-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors cursor-row-resize" />
                <Panel minSize="15%">
                  <ResultArea
                    panel={activePanel}
                    sqlEngine={info.engine}
                    onSheetSelect={(sheetId) => patchPanel(activePanel.id, { activeSheetId: sheetId })}
                    onSheetClose={(sheetId) => closeResultSheet(activePanel.id, sheetId)}
                    onCloseSheets={(sheetIds) => closeResultSheets(activePanel.id, sheetIds)}
                    onTabChange={(sheetId, tab) => patchSheet(activePanel.id, sheetId, { resultTab: tab })}
                    onRefreshSheet={(sheetId, mode) => void refreshSheet(activePanel.id, sheetId, mode)}
                    onCommitGridChanges={(sheetId, payload) => commitGridChanges(activePanel.id, sheetId, payload)}
                    onGeneratedSqlSync={(sheetId, sql, mode) =>
                      syncGeneratedSqlFromSheet(activePanel.id, sheetId, sql, mode)
                    }
                    onGeneratedSqlQuery={(sheetId, sql, rewriteRequest) =>
                      queryGeneratedSqlFromSheet(activePanel.id, sheetId, sql, rewriteRequest)
                    }
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
    </div>
  );
}

function EditorToolbar({
  engine,
  schemas,
  activeSchema,
  running,
  runAllTitle,
  runSelectionTitle,
  runCurrentTitle,
  onRun,
  onRunSelection,
  onRunCurrent,
  onCancel,
  onFormat,
  onToggleStatement,
  onToggleHistory,
  onSave,
  onSaveQuery,
  onSchemaChange,
  rowLimit,
  maxResultSheets,
  onRowLimitChange,
  onMaxResultSheetsChange,
}: {
  engine: string;
  schemas: string[];
  activeSchema: string | null;
  running: boolean;
  runAllTitle: string;
  runSelectionTitle: string;
  runCurrentTitle: string;
  onRun: () => void;
  onRunSelection: () => void;
  onRunCurrent: () => void;
  onCancel: () => void;
  onFormat: () => void;
  onToggleStatement: () => void;
  onToggleHistory: () => void;
  onSave: () => void;
  onSaveQuery: () => void;
  onSchemaChange: (schema: string) => void;
  rowLimit: number;
  maxResultSheets: number;
  onRowLimitChange: (value: number) => void;
  onMaxResultSheetsChange: (value: number) => void;
}) {
  const btn = "h-6 px-2 inline-flex items-center gap-1 rounded text-[11px] hover:bg-[var(--taomni-hover)] disabled:opacity-40";
  const input = "taomni-input h-6 w-[68px] text-[11px]";
  return (
    <div
      className="h-8 shrink-0 flex items-center gap-1 px-2"
      style={{ background: "var(--taomni-quick-bg)", borderBottom: "1px solid var(--taomni-divider)" }}
    >
      <button type="button" className={btn} onClick={onRun} disabled={running} title={runAllTitle}>
        <Play className="w-3.5 h-3.5" style={{ color: "#62d36f" }} /> Run
      </button>
      <button type="button" className={btn} onClick={onRunSelection} disabled={running} title={runSelectionTitle}>
        <SquareDashedMousePointer className="w-3.5 h-3.5" /> Selection
      </button>
      <button
        type="button"
        className={btn}
        onClick={onRunCurrent}
        disabled={running}
        title={runCurrentTitle}
        data-testid="db-run-current-statement"
      >
        <Crosshair className="w-3.5 h-3.5" /> Current
      </button>
      <button type="button" className={btn} onClick={onCancel} disabled={!running} title="Cancel query">
        <Ban className="w-3.5 h-3.5" style={{ color: "#d9534f" }} /> Cancel
      </button>
      <span className="w-px h-4 mx-1" style={{ background: "var(--taomni-divider)" }} />
      <button type="button" className={btn} onClick={onFormat} title="Format SQL">
        <Sparkles className="w-3.5 h-3.5" /> Format
      </button>
      <button type="button" className={btn} onClick={onToggleStatement} title="Current statement actions">
        <SquareDashedMousePointer className="w-3.5 h-3.5" /> Statement
      </button>
      <button type="button" className={btn} onClick={onToggleHistory} title="Query history">
        <Clock className="w-3.5 h-3.5" /> History
      </button>
      <button type="button" className={btn} onClick={onSave} title="Save query tab as SQL file">
        <Save className="w-3.5 h-3.5" /> Save
      </button>
      <button type="button" className={btn} onClick={onSaveQuery} title="Save to query library" data-testid="db-save-query">
        <Star className="w-3.5 h-3.5 text-[var(--taomni-accent)]" /> Save Query
      </button>
      <span className="w-px h-4 mx-1" style={{ background: "var(--taomni-divider)" }} />
      <label className="h-6 inline-flex items-center gap-1 text-[11px] text-[var(--taomni-text-muted)]">
        Rows
        <input
          className={input}
          type="number"
          min={MIN_ROW_LIMIT}
          max={MAX_ROW_LIMIT}
          value={rowLimit}
          title="Maximum rows returned by each query"
          onChange={(event) => onRowLimitChange(Number(event.target.value))}
        />
      </label>
      <label className="h-6 inline-flex items-center gap-1 text-[11px] text-[var(--taomni-text-muted)]">
        Sheets
        <input
          className={input}
          type="number"
          min={MIN_RESULT_SHEETS}
          max={MAX_RESULT_SHEETS_LIMIT}
          value={maxResultSheets}
          title="Maximum open result sheets in this DB tab"
          onChange={(event) => onMaxResultSheetsChange(Number(event.target.value))}
        />
      </label>
      <div className="flex-1" />
      {schemas.length > 0 && (
        <select
          className="taomni-input h-6 max-w-[180px] text-[11px]"
          value={activeSchema ?? ""}
          aria-label="Schema"
          title="Schema / database"
          onChange={(event) => onSchemaChange(event.target.value)}
        >
          {schemas.map((schema) => (
            <option key={schema} value={schema}>
              {schema}
            </option>
          ))}
        </select>
      )}
      <span className="text-[10px] text-[var(--taomni-text-muted)]">{engine}</span>
    </div>
  );
}

function StatementDropdown({
  action,
  hasJson,
  onRun,
  onSelect,
  onOpenTab,
  onJson,
  onAskAi,
  onClose,
}: {
  action: EditorStatementAction;
  hasJson: boolean;
  onRun: (action: EditorStatementAction) => void;
  onSelect: (action: EditorStatementAction) => void;
  onOpenTab: (action: EditorStatementAction) => void;
  onJson: (action: EditorStatementAction) => void;
  onAskAi: (action: EditorStatementAction) => void;
  onClose: () => void;
}) {
  const iconButton = "h-6 px-1.5 inline-flex items-center gap-1 rounded text-[10px] hover:bg-[var(--taomni-hover)] disabled:opacity-40";
  const compactSql = action.range.sql.replace(/\s+/g, " ").trim();
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        data-testid="db-current-statement-panel"
        className="absolute right-2 top-9 z-50 w-[560px] max-w-[calc(100vw-24px)] overflow-hidden rounded shadow-lg flex flex-col"
        style={{ background: "var(--taomni-panel-bg)", border: "1px solid var(--taomni-divider)" }}
      >
        <div
          className="h-8 shrink-0 flex items-center gap-2 px-2"
          style={{ borderBottom: "1px solid var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
        >
          <SquareDashedMousePointer className="w-3.5 h-3.5 text-[var(--taomni-accent)]" />
          <span className="text-[12px] font-semibold">Current statement</span>
          <span className="text-[10px] text-[var(--taomni-text-muted)]">
            {action.range.from}-{action.range.to}
          </span>
        </div>
        <div className="px-2 py-2">
          <div
            className="truncate font-mono text-[11px] text-[var(--taomni-text)]"
            title={action.range.sql}
          >
            {compactSql}
          </div>
          <div className="mt-2 flex items-center gap-1">
            <button type="button" data-testid="db-current-statement-run" className={iconButton} onClick={() => onRun(action)} title="Run this SQL statement">
              <Play className="w-3 h-3" /> Run
            </button>
            <button type="button" data-testid="db-current-statement-select" className={iconButton} onClick={() => onSelect(action)} title="Select this SQL statement in the editor">
              <SquareDashedMousePointer className="w-3 h-3" /> Select
            </button>
            <button type="button" data-testid="db-current-statement-open-tab" className={iconButton} onClick={() => onOpenTab(action)} title="Open and run in a new query panel">
              <Plus className="w-3 h-3" /> +Tab
            </button>
            <button type="button" data-testid="db-current-statement-json" className={iconButton} onClick={() => onJson(action)} disabled={!hasJson} title={hasJson ? "Copy in-memory result as JSON" : "Run this statement to make JSON available"}>
              <FileJson className="w-3 h-3" /> JSON
            </button>
            <button type="button" data-testid="db-current-statement-ask-ai" className={iconButton} onClick={() => onAskAi(action)} title="Ask AI about this SQL statement">
              <MessageSquare className="w-3 h-3" /> Ask AI
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function HistoryDropdown({
  entries,
  loading,
  onRefresh,
  onRun,
  onSelect,
  onOpenTab,
  onJson,
  onAskAi,
  onDelete,
  onClear,
  onClose,
}: {
  entries: DbSqlHistoryEntry[];
  loading: boolean;
  onRefresh: () => void;
  onRun: (entry: DbSqlHistoryEntry) => void;
  onSelect: (entry: DbSqlHistoryEntry) => void;
  onOpenTab: (entry: DbSqlHistoryEntry) => void;
  onJson: (entry: DbSqlHistoryEntry) => void;
  onAskAi: (entry: DbSqlHistoryEntry) => void;
  onDelete: (entry: DbSqlHistoryEntry) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const iconButton = "h-6 px-1.5 inline-flex items-center gap-1 rounded text-[10px] hover:bg-[var(--taomni-hover)] disabled:opacity-40";
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        data-testid="db-query-history-panel"
        className="absolute right-2 top-9 z-50 w-[620px] max-w-[calc(100vw-24px)] max-h-[440px] overflow-hidden rounded shadow-lg flex flex-col"
        style={{ background: "var(--taomni-panel-bg)", border: "1px solid var(--taomni-divider)" }}
      >
        <div
          className="h-8 shrink-0 flex items-center gap-2 px-2"
          style={{ borderBottom: "1px solid var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
        >
          <Clock className="w-3.5 h-3.5 text-[var(--taomni-accent)]" />
          <span className="text-[12px] font-semibold">Query history</span>
          <span className="text-[10px] text-[var(--taomni-text-muted)]">{entries.length}</span>
          <div className="flex-1" />
          <button type="button" data-testid="db-query-history-refresh" className={iconButton} onClick={onRefresh} title="Refresh query history">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
          <button type="button" data-testid="db-query-history-clear" className={iconButton} onClick={onClear} disabled={entries.length === 0} title="Clear this session history">
            <Trash2 className="w-3.5 h-3.5" /> Clear
          </button>
        </div>
        {loading ? (
          <div className="px-3 py-4 text-[11px] text-[var(--taomni-text-muted)] inline-flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading query history...
          </div>
        ) : entries.length === 0 ? (
          <div className="px-3 py-4 text-[11px] text-[var(--taomni-text-muted)]">No query history yet.</div>
        ) : (
          <div className="overflow-auto taomni-scroll-y">
            {entries.map((entry) => {
              const duration = formatDurationMs(entry.durationMs);
              const sql = entry.sqlContent.replace(/\s+/g, " ").trim();
              const hasJson = entry.hasResultSet && !entry.error;
              return (
                <div
                  key={entry.id}
                  data-testid="db-query-history-entry"
                  className="px-2 py-2 border-b border-[var(--taomni-divider)] last:border-0 hover:bg-[var(--taomni-hover)]"
                >
                  <div className="flex items-center gap-2 text-[10px] text-[var(--taomni-text-muted)]">
                    <span className="font-mono">{formatFullDateTime(entry.startedAt)}</span>
                    {duration && <span>{duration}</span>}
                    {entry.hasResultSet ? <span>{entry.rowCount ?? 0} rows</span> : <span>{entry.rowsAffected ?? 0} affected</span>}
                    {entry.error && <span className="text-[#d9534f] truncate">Error</span>}
                    <span className="ml-auto truncate">{entry.schemaName ?? entry.databaseName ?? entry.engine}</span>
                  </div>
                  <button
                    type="button"
                    className="mt-1 w-full text-left truncate font-mono text-[11px] text-[var(--taomni-text)]"
                    title={entry.sqlContent}
                    onClick={() => onSelect(entry)}
                  >
                    {sql}
                  </button>
                  {entry.error && (
                    <div className="mt-1 truncate text-[10px] text-[#d9534f]" title={entry.error}>
                      {entry.error}
                    </div>
                  )}
                  <div className="mt-1.5 flex items-center gap-1">
                    <button type="button" data-testid="db-query-history-run" className={iconButton} onClick={() => onRun(entry)} title="Run this historical SQL">
                      <Play className="w-3 h-3" /> Run
                    </button>
                    <button type="button" data-testid="db-query-history-select" className={iconButton} onClick={() => onSelect(entry)} title="Select this SQL in the current editor">
                      <SquareDashedMousePointer className="w-3 h-3" /> Select
                    </button>
                    <button type="button" data-testid="db-query-history-open-tab" className={iconButton} onClick={() => onOpenTab(entry)} title="Open and run in a new query panel">
                      <Plus className="w-3 h-3" /> +Tab
                    </button>
                    <button type="button" data-testid="db-query-history-json" className={iconButton} onClick={() => onJson(entry)} disabled={!hasJson} title={hasJson ? "Copy in-memory result as JSON" : "Run this SQL again to make JSON available"}>
                      <FileJson className="w-3 h-3" /> JSON
                    </button>
                    <button type="button" data-testid="db-query-history-ask-ai" className={iconButton} onClick={() => onAskAi(entry)} title="Ask AI about this SQL">
                      <MessageSquare className="w-3 h-3" /> Ask AI
                    </button>
                    <div className="flex-1" />
                    <button type="button" data-testid="db-query-history-delete" className={iconButton} onClick={() => onDelete(entry)} title="Delete this history entry">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

function ResultArea({
  panel,
  sqlEngine,
  onSheetSelect,
  onSheetClose,
  onCloseSheets,
  onTabChange,
  onRefreshSheet,
  onCommitGridChanges,
  onGeneratedSqlSync,
  onGeneratedSqlQuery,
  onCancel,
  onStatus,
}: {
  panel: PanelState;
  sqlEngine: string;
  onSheetSelect: (sheetId: string) => void;
  onSheetClose: (sheetId: string) => void;
  onCloseSheets: (sheetIds: string[]) => void;
  onTabChange: (sheetId: string, tab: ResultSubTab) => void;
  onRefreshSheet: (sheetId: string, mode: QueryRefreshMode) => void;
  onCommitGridChanges: (sheetId: string, payload: QueryGridCommitPayload) => Promise<void>;
  onGeneratedSqlSync: (sheetId: string, sql: string, mode: QueryGeneratedSqlSyncMode) => void;
  onGeneratedSqlQuery: (
    sheetId: string,
    sql: string,
    rewriteRequest?: DbResultSqlRewriteRequest,
  ) => void | Promise<void>;
  onCancel: () => void;
  onStatus: (message: string) => void;
}) {
  const t = useT();
  const sheetMenu = useContextMenu();
  const sheet = activeSheet(panel);
  const tab = "h-6 px-3 text-[11px] inline-flex items-center";
  const waitingForFirstResult =
    !!sheet?.running &&
    sheet.result !== null &&
    sheet.result.columns.length === 0 &&
    sheet.result.rows.length === 0;

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
    <div
      className="h-full flex flex-col min-h-0"
      style={{ background: "var(--taomni-bg)", fontSize: "var(--taomni-db-font-size, 12px)" }}
    >
      {sheetMenu.render}
      <div
        className="h-7 shrink-0 flex items-end gap-1 px-1 overflow-hidden"
        style={{ background: "var(--taomni-chrome-bg)", borderBottom: "1px solid var(--taomni-divider)" }}
      >
        {panel.sheets.length === 0 ? (
          <span className="px-2 pb-1 text-[11px] text-[var(--taomni-text-muted)]">Result sheets</span>
        ) : (
          panel.sheets.map((resultSheet) => {
            const active = resultSheet.id === sheet?.id;
            return (
              <button
                key={resultSheet.id}
                type="button"
                data-testid="result-sheet-tab"
                data-sheet-id={resultSheet.id}
                className="h-6 max-w-[220px] min-w-0 px-2 inline-flex items-center gap-1 overflow-hidden text-[11px]"
                style={{
                  background: active ? "var(--taomni-tab-active)" : "var(--taomni-tab-inactive)",
                  color: active ? "var(--taomni-accent)" : "var(--taomni-text-muted)",
                  border: "1px solid var(--taomni-tab-border)",
                  borderBottom: active ? "1px solid var(--taomni-tab-active)" : "1px solid var(--taomni-divider)",
                  borderTopLeftRadius: 4,
                  borderTopRightRadius: 4,
                }}
                onClick={() => onSheetSelect(resultSheet.id)}
                onContextMenu={(event) => openSheetMenu(event, resultSheet.id)}
                title={resultSheetTimingTitle(resultSheet)}
              >
                <span className="truncate">{resultSheet.title}</span>
                <span className="shrink-0 font-mono text-[10px] opacity-80">
                  {formatClockTime(resultSheet.createdAt)}
                </span>
                {resultSheet.running && <Loader2 className="w-3 h-3 shrink-0 animate-spin" />}
                {(resultSheet.error || resultSheet.warnings.length > 0) && (
                  <span className="text-[10px] shrink-0">●</span>
                )}
                <X
                  className="w-3 h-3 shrink-0 hover:text-[var(--taomni-text)]"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSheetClose(resultSheet.id);
                  }}
                />
              </button>
            );
          })
        )}
      </div>
      {sheet && (
        <div className="h-7 shrink-0 flex items-center gap-1 px-1" style={{ borderBottom: "1px solid var(--taomni-divider)" }}>
          <button
            type="button"
            className={tab}
            style={{ color: sheet.resultTab === "results" ? "var(--taomni-accent)" : "var(--taomni-text-muted)" }}
            onClick={() => onTabChange(sheet.id, "results")}
          >
            Results
          </button>
          <button
            type="button"
            className={tab}
            style={{ color: sheet.resultTab === "messages" ? "var(--taomni-accent)" : "var(--taomni-text-muted)" }}
            onClick={() => onTabChange(sheet.id, "messages")}
          >
            Messages{(sheet.error || sheet.warnings.length > 0) ? " ●" : ""}
          </button>
          <span
            className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap px-1.5 text-[10px] text-[var(--taomni-text-muted)] font-mono"
            title={resultSheetTimingTitle(sheet)}
          >
            <Clock className="w-3 h-3" />
            {formatFullDateTime(sheet.createdAt)}
            {sheet.running
              ? ` | ${formatDurationMs(sheet.elapsedMs) ?? "0 ms"}`
              : sheet.result
                ? ` | ${formatDurationMs(sheet.result.durationMs) ?? "0 ms"}`
                : ""}
          </span>
          <span className="ml-auto truncate px-2 text-[10px] text-[var(--taomni-text-muted)] font-mono" title={sheet.sql}>
            {sheet.sql.replace(/\s+/g, " ")}
          </span>
        </div>
      )}
      <div className="flex-1 min-h-0 flex flex-col">
        {!sheet ? (
          <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
            Run a query to create a result sheet.
          </div>
        ) : sheet.resultTab === "results" ? (
          waitingForFirstResult ? (
            <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
              {sheet.cancelling ? "Cancelling…" : "Running…"}
            </div>
          ) : sheet.result ? (
            <div className={`flex-1 min-h-0 flex flex-col ${sheet.cancelling ? "opacity-50 pointer-events-none" : ""}`}>
              <QueryResultGrid
                result={sheet.result}
                sourceSql={sheet.sql}
                baseSql={sheet.baseSql}
                sqlEngine={sqlEngine}
                running={sheet.running}
                cancelling={sheet.cancelling}
                onRefresh={(mode) => onRefreshSheet(sheet.id, mode)}
                onCancel={onCancel}
                onCommitChanges={(payload) => onCommitGridChanges(sheet.id, payload)}
                onGeneratedSqlSync={(sql, mode) => onGeneratedSqlSync(sheet.id, sql, mode)}
                onGeneratedSqlQuery={(sql, rewriteRequest) => onGeneratedSqlQuery(sheet.id, sql, rewriteRequest)}
                onStatus={onStatus}
              />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
              {sheet.running ? "Running…" : "Run a query to see results."}
            </div>
          )
        ) : (
          <div
            className="flex-1 overflow-auto taomni-scroll-y p-2 text-[12px] font-mono"
            style={{ fontSize: "var(--taomni-db-font-size, 12px)" }}
          >
            {sheet.error && <div style={{ color: "#d9534f" }}>{sheet.error}</div>}
            {sheet.warnings.map((w, i) => (
              <div key={i} style={{ color: "#e6a817" }}>
                {w}
              </div>
            ))}
            {!sheet.error && sheet.warnings.length === 0 && (
              <div className="text-[var(--taomni-text-muted)]">No messages.</div>
            )}
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
    <div
      className="h-6 shrink-0 flex items-center gap-3 px-2 text-[11px] text-[var(--taomni-text-muted)]"
      style={{ background: "var(--taomni-quick-bg)", borderTop: "1px solid var(--taomni-divider)" }}
    >
      {sheet?.running ? (
        <span className="inline-flex items-center gap-1">
          <Loader2 className="w-3 h-3 animate-spin" /> {sheet.cancelling ? "Cancelling" : "Running"}{" "}
          {(sheet.elapsedMs / 1000).toFixed(1)}s
        </span>
      ) : r ? (
        <>
          {r.columns.length > 0 && <span>{r.rows.length} rows</span>}
          {r.columns.length > 0 && <span>{r.columns.length} cols</span>}
          {r.rowsAffected > 0 && <span>{r.rowsAffected} affected</span>}
          <span>{r.durationMs} ms</span>
          {sheet && <span>limit {sheet.rowLimit}</span>}
        </>
      ) : (
        <span>{panel.sheets.length} result sheet(s)</span>
      )}
    </div>
  );
}
