import { useEffect, useMemo, useState, useCallback, useRef, type DragEvent, type MouseEvent } from "react";
import {
  AlertTriangle,
  ChevronDown,
  Eye,
  File as FileIcon,
  Folder,
  HardDrive,
  HelpCircle,
  Link as LinkIcon,
  X,
} from "lucide-react";
import { PathBreadcrumb } from "./PathBreadcrumb";
import { FileToolbar } from "./FileToolbar";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { useSftpStore, WINDOWS_DRIVES_ROOT, type PaneSide, type FilePanelStoreHook } from "../../stores/sftpStore";
import {
  basename,
  formatBytes,
  parentPath,
  sftpLocalDrives,
  type DriveEntry,
  type FileEntry,
} from "../../lib/sftp";
import {
  NATIVE_FILE_DROP_EVENT,
  type NativeFileDropDetail,
  droppedFiles,
  isOsFileDrag,
} from "../../lib/osFileDrop";
import {
  startCustomDrag,
  useCustomDropTarget,
  type CustomDragData,
} from "../../lib/customDnD";
import { useT } from "../../lib/i18n";

const CROSS_PANE_DRAG_MIME = "taomni/sftp-files";

interface CrossPaneDragPayload {
  sessionId: string;
  side: PaneSide;
  paths: string[];
}

interface ColWidths {
  name: number;
  size: number;
  mtime: number;
  type: number;
}
const DEFAULT_COL_WIDTHS: ColWidths = { name: 280, size: 80, mtime: 150, type: 90 };
const MIN_COL_WIDTH = 40;
const MAX_COL_WIDTH = 800;
const COL_KEY_PREFIX = "taomni.sftp.cols.";

function loadColWidths(side: PaneSide): ColWidths {
  try {
    const raw = localStorage.getItem(COL_KEY_PREFIX + side);
    if (!raw) return DEFAULT_COL_WIDTHS;
    const parsed = JSON.parse(raw) as Partial<ColWidths>;
    return {
      name: clampCol(parsed.name ?? DEFAULT_COL_WIDTHS.name),
      size: clampCol(parsed.size ?? DEFAULT_COL_WIDTHS.size),
      mtime: clampCol(parsed.mtime ?? DEFAULT_COL_WIDTHS.mtime),
      type: clampCol(parsed.type ?? DEFAULT_COL_WIDTHS.type),
    };
  } catch {
    return DEFAULT_COL_WIDTHS;
  }
}

function saveColWidths(side: PaneSide, widths: ColWidths): void {
  try {
    localStorage.setItem(COL_KEY_PREFIX + side, JSON.stringify(widths));
  } catch {
    /* noop */
  }
}

function clampCol(n: number): number {
  if (!Number.isFinite(n)) return MIN_COL_WIDTH;
  return Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, Math.round(n)));
}

interface FilePanelProps {
  sessionId: string;
  side: PaneSide;
  /**
   * Optional store driving this panel. Defaults to the SFTP store. The
   * object-storage browser passes its own store (same {@link FilePanelStore}
   * surface) so the panel renders buckets/objects with no SFTP coupling. Must
   * be stable across the component's lifetime (don't swap stores per render).
   */
  store?: FilePanelStoreHook;
  /** Optional subtitle (e.g. host) shown in muted text next to the LOCAL/REMOTE badge. */
  subtitle?: string;
  detachable?: boolean;
  onDetach?: () => void;
  onItemDoubleClick: (entry: FileEntry) => void;
  onItemContext?: (
    entry: FileEntry,
    anchor: { x: number; y: number },
    selectedEntries: FileEntry[],
  ) => MenuItem[];
  onEmptyContext?: (anchor: { x: number; y: number }) => MenuItem[];
  onCrossPaneDrop?: (entries: FileEntry[]) => void;
  acceptCrossPane?: boolean;
  /** Optional substring filter typed by the user (case-insensitive). */
  filterText?: string;
  /** Mutator wired to the filter text input. */
  onFilterTextChange?: (next: string) => void;
  /** Toolbar callbacks operating on the current selection / current dir. */
  onDownloadSelected?: (entries: FileEntry[]) => void;
  onUploadSelected?: (entries: FileEntry[]) => void;
  onUploadFromDisk?: (files: File[]) => void;
  onUploadPathsFromDisk?: (paths: string[]) => void;
  onDeleteSelected?: (entries: FileEntry[]) => void;
  onChmodSelected?: (entries: FileEntry[]) => void;
  onPreviewSelected?: (entry: FileEntry) => void;
  onNewFolder?: () => void;
  onNewFile?: () => void;
  onOpenTerminalHere?: (path: string) => void;
  /** Local pane only: open selected files/dirs with the system default app. */
  onOpenLocalSelected?: (entries: FileEntry[]) => void;
  /** Local pane only: reveal the current directory in the OS file manager. */
  onRevealInOs?: (path: string) => void;
}

const SUPPORTED_PREVIEW_EXT = new Set([
  "txt", "md", "log", "json", "yaml", "yml", "js", "ts", "tsx",
  "jsx", "html", "css", "py", "rs", "go", "rb", "sh", "conf", "ini",
]);

export function FilePanel({
  sessionId,
  side,
  store,
  subtitle,
  detachable,
  onDetach,
  onItemDoubleClick,
  onItemContext,
  onEmptyContext,
  onCrossPaneDrop,
  acceptCrossPane,
  filterText,
  onFilterTextChange,
  onDownloadSelected,
  onUploadSelected,
  onUploadFromDisk,
  onUploadPathsFromDisk,
  onDeleteSelected,
  onChmodSelected,
  onPreviewSelected,
  onNewFolder,
  onNewFile,
  onOpenTerminalHere,
  onOpenLocalSelected,
  onRevealInOs,
}: FilePanelProps) {
  const t = useT();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // `store` is stable per mount (see prop docs), so the conditional default
  // resolves to one consistent hook identity across renders.
  const useStore = (store ?? useSftpStore) as FilePanelStoreHook;
  const session = useStore((s) => s.sessions[sessionId]);
  const navigate = useStore((s) => s.navigate);
  const navigateBack = useStore((s) => s.navigateBack);
  const navigateForward = useStore((s) => s.navigateForward);
  const navigateUp = useStore((s) => s.navigateUp);
  const refresh = useStore((s) => s.refreshPane);
  const setSelection = useStore((s) => s.setSelection);
  const toggleHidden = useStore((s) => s.toggleHidden);
  const ctx = useContextMenu();

  const [sortKey, setSortKey] = useState<"name" | "size" | "mtime" | "type">("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [draggingOver, setDraggingOver] = useState(false);
  const lastClickedRef = useRef<string | null>(null);

  const [colWidths, setColWidths] = useState<ColWidths>(() => loadColWidths(side));
  const dragColRef = useRef<{ key: keyof ColWidths; startX: number; startW: number } | null>(null);

  const resetCol = useCallback((key: keyof ColWidths) => {
    setColWidths((prev) => ({ ...prev, [key]: DEFAULT_COL_WIDTHS[key] }));
  }, []);

  const startColResize = useCallback(
    (key: keyof ColWidths, e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragColRef.current = { key, startX: e.clientX, startW: colWidths[key] };
      const onMove = (ev: globalThis.MouseEvent) => {
        const ctx = dragColRef.current;
        if (!ctx) return;
        const next = clampCol(ctx.startW + (ev.clientX - ctx.startX));
        setColWidths((prev) =>
          prev[ctx.key] === next ? prev : { ...prev, [ctx.key]: next },
        );
      };
      const onUp = () => {
        dragColRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [colWidths],
  );

  useEffect(() => {
    saveColWidths(side, colWidths);
  }, [side, colWidths]);

  const pane = session?.[side];
  const showHidden = pane?.showHidden ?? false;
  // Show the drives dropdown only on the LOCAL pane when the current path
  // looks like a Windows path. Lets the user jump back from `C:\foo` to a
  // list of drives (C:, D:, …) without typing the path manually.
  const showDrivesPicker =
    side === "local" &&
    !!pane?.path &&
    (/^[A-Z]:/i.test(pane.path) || pane.path === "\\\\");

  const sortedEntries = useMemo<FileEntry[]>(() => {
    if (!pane) return [];
    let entries = showHidden
      ? pane.entries
      : pane.entries.filter((e) => !e.isHidden);
    if (filterText && filterText.trim()) {
      const needle = filterText.trim().toLowerCase();
      entries = entries.filter((e) => e.name.toLowerCase().includes(needle));
    }
    const dir = sortDir === "asc" ? 1 : -1;
    return [...entries].sort((a, b) => {
      if (a.fileType === "dir" && b.fileType !== "dir") return -1;
      if (b.fileType === "dir" && a.fileType !== "dir") return 1;
      switch (sortKey) {
        case "size":
          return ((a.size ?? 0) - (b.size ?? 0)) * dir;
        case "mtime":
          return ((a.mtime ?? 0) - (b.mtime ?? 0)) * dir;
        case "type": {
          const at = a.fileType + (a.name.split(".").pop() ?? "");
          const bt = b.fileType + (b.name.split(".").pop() ?? "");
          return at.localeCompare(bt) * dir;
        }
        default:
          return a.name.localeCompare(b.name) * dir;
      }
    });
  }, [pane, sortKey, sortDir, showHidden, filterText]);

  const normalizedFilter = filterText?.trim() ?? "";
  const filterActive = normalizedFilter.length > 0;
  const hiddenEntryCount = pane?.entries.filter((entry) => entry.isHidden).length ?? 0;
  const hiddenBySettingCount = showHidden ? 0 : hiddenEntryCount;
  const filterCandidateCount = Math.max(0, (pane?.entries.length ?? 0) - hiddenBySettingCount);
  const skippedEntryCount = pane?.skippedEntryCount ?? 0;
  const entryDiagnostics = pane?.entryDiagnostics ?? [];
  const diagnosticTitle = entryDiagnostics
    .map((diagnostic, index) => {
      const label = diagnostic.name ?? diagnostic.path ?? `#${index + 1}`;
      return `${label}: ${diagnostic.error}`;
    })
    .join("\n");
  const hasListingStatus = hiddenBySettingCount > 0 || filterActive || skippedEntryCount > 0;

  const onHeaderClick = useCallback(
    (key: typeof sortKey) => {
      if (key === sortKey) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortKey(key);
        setSortDir("asc");
      }
    },
    [sortKey],
  );

  useEffect(() => {
    setSelection(sessionId, side, []);
  }, [sessionId, side, setSelection, pane?.path]);

  useEffect(() => {
    if (side !== "remote" || !onUploadPathsFromDisk) return;

    const handleNativeFileDrop = (event: Event) => {
      const detail = (event as CustomEvent<NativeFileDropDetail>).detail;
      if (!detail?.paths?.length) return;

      const list = listRef.current;
      const target = document.elementFromPoint(detail.clientX, detail.clientY);
      if (!list || !target || !list.contains(target)) return;

      setDraggingOver(false);
      onUploadPathsFromDisk(detail.paths);
    };

    window.addEventListener(NATIVE_FILE_DROP_EVENT, handleNativeFileDrop);
    return () => window.removeEventListener(NATIVE_FILE_DROP_EVENT, handleNativeFileDrop);
  }, [onUploadPathsFromDisk, side]);

  const selectedEntries = useMemo<FileEntry[]>(() => {
    if (!pane) return [];
    const set = new Set(pane.selection);
    return sortedEntries.filter((e) => set.has(e.path));
  }, [pane, sortedEntries]);

  const firstSelected = selectedEntries[0];
  const canPreview = !!(
    onPreviewSelected &&
    selectedEntries.length === 1 &&
    firstSelected &&
    firstSelected.fileType === "file"
  );

  useCustomDropTarget<HTMLDivElement>(listRef, {
    accepts: (data: CustomDragData) => {
      if (!acceptCrossPane) return false;
      if (data.mime !== CROSS_PANE_DRAG_MIME) return false;
      const payload = data.payload as CrossPaneDragPayload | null;
      if (!payload) return false;
      // Reject same-pane drags so dropping back doesn't trigger a copy.
      return !(payload.sessionId === sessionId && payload.side === side);
    },
    onDragEnter: () => setDraggingOver(true),
    onDragLeave: () => setDraggingOver(false),
    onDrop: (detail) => {
      setDraggingOver(false);
      const payload = detail.data.payload as CrossPaneDragPayload | null;
      if (!payload) return;
      const otherPane = useStore.getState().sessions[payload.sessionId]?.[payload.side];
      if (!otherPane) return;
      const entries = otherPane.entries.filter((entry) => payload.paths.includes(entry.path));
      if (entries.length > 0) onCrossPaneDrop?.(entries);
    },
  });

  if (!pane) {
    return (
      <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
        {t("fileBrowser.paneNotInitialized")}
      </div>
    );
  }

  const handleRowClick = (entry: FileEntry, e: MouseEvent) => {
    const selection = pane.selection.slice();
    if (e.shiftKey && lastClickedRef.current) {
      const start = sortedEntries.findIndex((x) => x.path === lastClickedRef.current);
      const end = sortedEntries.findIndex((x) => x.path === entry.path);
      if (start >= 0 && end >= 0) {
        const [a, b] = start < end ? [start, end] : [end, start];
        const range = sortedEntries.slice(a, b + 1).map((x) => x.path);
        setSelection(sessionId, side, range);
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      const idx = selection.indexOf(entry.path);
      if (idx >= 0) selection.splice(idx, 1);
      else selection.push(entry.path);
      setSelection(sessionId, side, selection);
    } else {
      setSelection(sessionId, side, [entry.path]);
    }
    lastClickedRef.current = entry.path;
  };

  const handleRowContext = (entry: FileEntry, e: MouseEvent) => {
    e.preventDefault();
    const effectiveSelection = pane.selection.includes(entry.path)
      ? pane.selection
      : [entry.path];
    if (!pane.selection.includes(entry.path)) {
      setSelection(sessionId, side, effectiveSelection);
    }
    if (!onItemContext) return;
    const selectedSet = new Set(effectiveSelection);
    const contextEntries = sortedEntries.filter((x) => selectedSet.has(x.path));
    const items = onItemContext(
      entry,
      { x: e.clientX, y: e.clientY },
      contextEntries.length > 0 ? contextEntries : [entry],
    );
    if (items.length > 0) ctx.show(e, items);
  };

  const handleEmptyContext = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-row]")) return;
    e.preventDefault();
    if (!onEmptyContext) return;
    const items = onEmptyContext({ x: e.clientX, y: e.clientY });
    if (items.length > 0) ctx.show(e, items);
  };

  const handleEmptyClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-row]")) return;
    setSelection(sessionId, side, []);
  };

  const handleRowPointerDown = (entry: FileEntry, e: React.PointerEvent<HTMLTableRowElement>) => {
    if (e.button !== 0) return;
    const sel = pane.selection.includes(entry.path) ? pane.selection : [entry.path];
    const ghostText = sel.length === 1 ? entry.name : `${sel.length} items`;
    startCustomDrag({
      event: e,
      data: {
        mime: CROSS_PANE_DRAG_MIME,
        payload: {
          sessionId,
          side,
          paths: sel,
        } satisfies CrossPaneDragPayload,
      },
      ghostText,
    });
  };

  // Browser dev mode: OS file drag delivers `File` objects through HTML5 DnD.
  // Inside Tauri, OS file drops arrive via `NATIVE_FILE_DROP_EVENT` instead
  // (because dragDropEnabled=true intercepts HTML5 file drops on Windows).
  // Cross-pane intra-app drag is handled by useCustomDropTarget below.
  const handleDragOver = (e: DragEvent) => {
    if (side === "remote" && onUploadFromDisk && isOsFileDrag(e.dataTransfer)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDraggingOver(true);
    }
  };

  const handleDragLeave = (e: DragEvent) => {
    if (e.currentTarget === e.target) setDraggingOver(false);
  };

  const handleDrop = (e: DragEvent) => {
    if (side === "remote" && onUploadFromDisk && isOsFileDrag(e.dataTransfer)) {
      e.preventDefault();
      setDraggingOver(false);
      const files = droppedFiles(e.dataTransfer);
      if (files.length > 0) onUploadFromDisk(files);
    }
  };

  const handleMkdir = () => {
    if (onNewFolder) {
      onNewFolder();
      return;
    }
    if (!onEmptyContext) return;
    const items = onEmptyContext({ x: 0, y: 0 });
    const mkdirItem = items.find((it) => it.label.toLowerCase().includes("folder"));
    if (mkdirItem?.onClick) mkdirItem.onClick();
  };

  return (
    <div data-testid={`sftp-${side}-pane`} className="h-full w-full min-w-0 flex flex-col min-h-0">
      <div
        className="h-7 flex items-center px-2 text-[11px] border-b shrink-0 gap-2"
        style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
      >
        <span
          className="px-1.5 py-[1px] text-[10px] font-bold tracking-wider rounded shrink-0"
          style={{
            background: side === "remote" ? "var(--taomni-accent)" : "var(--taomni-text-muted)",
            color: "#fff",
            letterSpacing: "0.08em",
          }}
        >
          {side === "remote" ? "REMOTE" : "LOCAL"}
        </span>
        {subtitle && (
          <span
            className="truncate text-[11px]"
            style={{ color: "var(--taomni-text-muted)" }}
            title={subtitle}
          >
            {subtitle}
          </span>
        )}
        <div className="flex-1" />
        {onFilterTextChange && (
          <input
            type="search"
            data-testid={`sftp-${side}-filter`}
            value={filterText ?? ""}
            placeholder={t("fileBrowser.filterPlaceholder")}
            onChange={(e) => onFilterTextChange(e.target.value)}
            className="taomni-input h-5 px-1.5 text-[11px] w-[140px] rounded shrink-0"
            style={{
              background: "var(--taomni-input-bg)",
              border: "1px solid var(--taomni-input-border)",
              color: "var(--taomni-text)",
            }}
          />
        )}
      </div>
      {onUploadFromDisk && (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length > 0) onUploadFromDisk(files);
            e.target.value = "";
          }}
        />
      )}
      <FileToolbar
        side={side}
        canBack={pane.historyIndex > 0}
        canForward={pane.historyIndex < pane.history.length - 1}
        canUp={
          !!pane.path &&
          pane.path !== "/" &&
          pane.path !== WINDOWS_DRIVES_ROOT
        }
        showHidden={showHidden}
        loading={pane.loading}
        selectionCount={selectedEntries.length}
        canPreview={canPreview}
        onBack={() => void navigateBack(sessionId, side)}
        onForward={() => void navigateForward(sessionId, side)}
        onUp={() => void navigateUp(sessionId, side)}
        onRefresh={() => void refresh(sessionId, side)}
        onMkdir={handleMkdir}
        onNewFile={onNewFile}
        onDelete={
          onDeleteSelected
            ? () => {
                if (selectedEntries.length === 0) return;
                onDeleteSelected(selectedEntries);
              }
            : undefined
        }
        onChmod={
          onChmodSelected && selectedEntries.length > 0
            ? () => onChmodSelected(selectedEntries)
            : undefined
        }
        onPreview={
          onPreviewSelected && firstSelected
            ? () => onPreviewSelected(firstSelected)
            : undefined
        }
        onDownloadSelected={
          side === "remote" && onDownloadSelected
            ? () => {
                if (selectedEntries.length === 0) return;
                onDownloadSelected(selectedEntries);
              }
            : undefined
        }
        onUploadSelected={
          side === "local" && onUploadSelected
            ? () => {
                if (selectedEntries.length === 0) return;
                onUploadSelected(selectedEntries);
              }
            : undefined
        }
        onUploadFromDisk={
          side === "remote" && onUploadFromDisk
            ? () => fileInputRef.current?.click()
            : undefined
        }
        onOpenLocalSelected={
          side === "local" && onOpenLocalSelected && selectedEntries.length > 0
            ? () => onOpenLocalSelected(selectedEntries)
            : undefined
        }
        onRevealInOs={
          side === "local" && onRevealInOs && pane.path
            ? () => onRevealInOs(pane.path)
            : undefined
        }
        onOpenTerminalHere={
          side === "remote" && onOpenTerminalHere
            ? () => onOpenTerminalHere(pane.path)
            : undefined
        }
        onToggleHidden={() => toggleHidden(sessionId, side)}
        onDetach={detachable ? onDetach : undefined}
      />
      <div className="h-6 flex items-center gap-1 px-1 border-b shrink-0"
        style={{ borderColor: "var(--taomni-divider)" }}>
        {showDrivesPicker && (
          <DrivesPicker
            onSelect={(p) => void navigate(sessionId, side, p)}
          />
        )}
        <PathBreadcrumb
          testId={`sftp-${side}-path`}
          path={pane.path}
          homePath={side === "remote" ? session?.homeDir ?? null : null}
          onNavigate={(p) => void navigate(sessionId, side, p)}
          onSubmit={(p) => void navigate(sessionId, side, p)}
          detectWindows={pane.path.includes("\\")}
        />
      </div>

      {!pane.error && hasListingStatus && (
        <div
          data-testid={`sftp-${side}-listing-status`}
          role="status"
          className="min-h-6 flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1 border-b shrink-0 text-[11px]"
          style={{
            borderColor: "var(--taomni-divider)",
            background: "var(--taomni-quick-bg)",
            color: "var(--taomni-text-muted)",
          }}
        >
          {skippedEntryCount > 0 && (
            <span
              data-testid={`sftp-${side}-access-warning`}
              className="inline-flex min-w-0 items-center gap-1 text-amber-700 dark:text-amber-400"
              title={diagnosticTitle || undefined}
            >
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>{t("fileBrowser.unreadableItemsSummary", { count: skippedEntryCount })}</span>
            </span>
          )}
          {hiddenBySettingCount > 0 && (
            <button
              type="button"
              data-testid={`sftp-${side}-show-hidden-filtered`}
              className="inline-flex items-center gap-1 hover:text-[var(--taomni-text)]"
              title={t("fileBrowser.showHidden")}
              onClick={() => toggleHidden(sessionId, side)}
            >
              <Eye className="h-3.5 w-3.5" />
              <span>{t("fileBrowser.hiddenItemsSummary", { count: hiddenBySettingCount })}</span>
            </button>
          )}
          {filterActive && (
            <span className="inline-flex min-w-0 items-center gap-1">
              <span className="truncate">
                {t("fileBrowser.filterSummary", {
                  shown: sortedEntries.length,
                  total: filterCandidateCount,
                  query: normalizedFilter,
                })}
              </span>
              <button
                type="button"
                data-testid={`sftp-${side}-clear-filter`}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center hover:text-[var(--taomni-text)]"
                title={t("fileBrowser.clearFilter")}
                onClick={() => onFilterTextChange?.("")}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          )}
        </div>
      )}

      <div
        ref={listRef}
        data-testid={`sftp-${side}-list`}
        className="flex-1 overflow-auto text-[12px] relative"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onContextMenu={handleEmptyContext}
        onClick={handleEmptyClick}
        style={{ background: "var(--taomni-bg)" }}
      >
        {ctx.render}
        {draggingOver && (
          <div
            className="absolute inset-0 pointer-events-none border-2 border-dashed z-10 flex items-center justify-center"
            style={{ borderColor: "var(--taomni-accent)", background: "rgba(43,93,139,0.08)" }}
          >
            <span className="text-xs font-semibold text-[var(--taomni-accent)]">
              {t("fileBrowser.dropToCopy")}
            </span>
          </div>
        )}
        <table
          className="border-collapse"
          // Use max(100%, sumOfWidths) so the table always fills the
          // pane horizontally but can also exceed it (with horizontal
          // scroll on the wrapper) when the user enlarges columns.
          style={{
            tableLayout: "fixed",
            width: `max(100%, ${
              colWidths.name + colWidths.size + colWidths.mtime + colWidths.type
            }px)`,
          }}
        >
          <colgroup>
            <col style={{ width: colWidths.name }} />
            <col style={{ width: colWidths.size }} />
            <col style={{ width: colWidths.mtime }} />
            <col style={{ width: colWidths.type }} />
          </colgroup>
          <thead className="sticky top-0 z-10" style={{ background: "var(--taomni-quick-bg)" }}>
            <tr className="text-[11px] uppercase tracking-wide" style={{ color: "var(--taomni-text-muted)" }}>
              <SortHeader
                label={t("fileBrowser.sortName")}
                active={sortKey === "name"}
                dir={sortDir}
                onClick={() => onHeaderClick("name")}
                onResizeStart={(e) => startColResize("name", e)}
                onResizeReset={() => resetCol("name")}
                hint={t("fileBrowser.sortNameHint")}
                resizeTitle={t("fileBrowser.resizeHandleTitle")}
                testKey="name"
              />
              <SortHeader
                label={t("fileBrowser.sortSize")}
                active={sortKey === "size"}
                dir={sortDir}
                onClick={() => onHeaderClick("size")}
                className="text-right"
                onResizeStart={(e) => startColResize("size", e)}
                onResizeReset={() => resetCol("size")}
                resizeTitle={t("fileBrowser.resizeHandleTitle")}
                testKey="size"
              />
              <SortHeader
                label={t("fileBrowser.sortModified")}
                active={sortKey === "mtime"}
                dir={sortDir}
                onClick={() => onHeaderClick("mtime")}
                onResizeStart={(e) => startColResize("mtime", e)}
                onResizeReset={() => resetCol("mtime")}
                resizeTitle={t("fileBrowser.resizeHandleTitle")}
                testKey="mtime"
              />
              <SortHeader
                label={t("fileBrowser.sortType")}
                active={sortKey === "type"}
                dir={sortDir}
                onClick={() => onHeaderClick("type")}
                onResizeStart={(e) => startColResize("type", e)}
                onResizeReset={() => resetCol("type")}
                resizeTitle={t("fileBrowser.resizeHandleTitle")}
                testKey="type"
              />
            </tr>
          </thead>
          <tbody>
            {pane.error && (
              <tr>
                <td colSpan={4} className="px-2 py-2 text-red-500 text-[11px]">
                  {pane.error}
                </td>
              </tr>
            )}
            {sortedEntries.length === 0 && !pane.loading && !pane.error && (
              <tr>
                <td colSpan={4} className="px-2 py-3 text-center text-[var(--taomni-text-muted)]">
                  {pane.entries.length === 0 && skippedEntryCount > 0
                    ? t("fileBrowser.noReadableEntries")
                    : filterActive
                      ? t("fileBrowser.noFilterMatches", { query: normalizedFilter })
                      : hiddenBySettingCount > 0
                        ? t("fileBrowser.hiddenItemsNotShown", { count: hiddenBySettingCount })
                        : t("fileBrowser.emptyDirectory")}
                </td>
              </tr>
            )}
            {sortedEntries.map((entry) => (
              <tr
                key={entry.path}
                data-row
                onPointerDown={(e) => handleRowPointerDown(entry, e)}
                className="cursor-default select-none"
                style={{
                  background: pane.selection.includes(entry.path)
                    ? "var(--taomni-selected)"
                    : undefined,
                }}
                onClick={(e) => handleRowClick(entry, e)}
                onDoubleClick={() => onItemDoubleClick(entry)}
                onContextMenu={(e) => handleRowContext(entry, e)}
                title={entry.path}
              >
                <td className="px-1.5 py-0.5 truncate">
                  <div className="flex items-center gap-1 min-w-0">
                    <FileTypeIcon entry={entry} />
                    <span className="truncate">{entry.name}</span>
                    {entry.symlinkTarget && (
                      <span className="truncate text-[10px] text-[var(--taomni-text-muted)]">→ {entry.symlinkTarget}</span>
                    )}
                  </div>
                </td>
                <td className="px-1.5 py-0.5 text-right text-[var(--taomni-text-muted)] truncate">
                  {entry.fileType === "dir" ? "" : formatBytes(entry.size)}
                </td>
                <td className="px-1.5 py-0.5 text-[var(--taomni-text-muted)] truncate">
                  {entry.mtime ? new Date(entry.mtime * 1000).toLocaleString() : ""}
                </td>
                <td className="px-1.5 py-0.5 text-[var(--taomni-text-muted)] truncate">
                  {entry.fileType === "dir"
                    ? t("fileBrowser.typeFolder")
                    : (entry.name.split(".").pop() ?? "").toLowerCase()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="h-5 px-2 text-[11px] flex items-center border-t shrink-0"
        style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-status-bg)", color: "var(--taomni-status-text)" }}>
        {pane.loading
          ? t("fileBrowser.statusLoading")
          : pane.selection.length > 0
            ? t("fileBrowser.statusItemsCountSelected", {
                count: sortedEntries.length,
                plural: sortedEntries.length === 1 ? "" : "s",
                selected: pane.selection.length,
              })
            : t("fileBrowser.statusItemsCount", {
                count: sortedEntries.length,
                plural: sortedEntries.length === 1 ? "" : "s",
              })}
      </div>
    </div>
  );
}

function SortHeader({
  label,
  active,
  dir,
  onClick,
  className,
  onResizeStart,
  onResizeReset,
  hint,
  resizeTitle,
  testKey,
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
  className?: string;
  /** When set, renders a 4-px drag handle on the right edge that resizes
   *  the *next* column. Omit on the last column. */
  onResizeStart?: (e: MouseEvent) => void;
  /** Double-clicking the handle resets the affected column to its default. */
  onResizeReset?: () => void;
  /** Optional help text shown via a small "?" icon next to the label. */
  hint?: string;
  /** Tooltip shown on the resize handle. */
  resizeTitle?: string;
  /** Stable key used for data-testid attributes (independent of localized label). */
  testKey?: string;
}) {
  const slug = (testKey ?? label).toLowerCase();
  return (
    <th
      data-testid={`col-header-${slug}`}
      className={`text-left px-1.5 py-0.5 cursor-pointer select-none border-b relative ${className ?? ""}`}
      style={{ borderColor: "var(--taomni-divider)" }}
      onClick={onClick}
    >
      <span className="truncate inline-block align-bottom max-w-full">
        {label} {active ? (dir === "asc" ? "▲" : "▼") : ""}
      </span>
      {hint && (
        <span
          aria-label={hint}
          data-testid={`col-header-${slug}-hint`}
          title={hint}
          onClick={(e) => e.stopPropagation()}
          className="inline-flex align-middle ml-1 opacity-60 hover:opacity-100 cursor-help"
        >
          <HelpCircle className="w-3 h-3" />
        </span>
      )}
      {onResizeStart && (
        <span
          role="separator"
          aria-orientation="vertical"
          data-testid={`col-resize-${slug}`}
          title={resizeTitle ?? "Drag to resize next column • double-click to reset"}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={onResizeStart}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onResizeReset?.();
          }}
          className="absolute top-0 right-0 h-full w-[5px] cursor-col-resize hover:bg-[var(--taomni-accent)]"
          style={{ zIndex: 1 }}
        />
      )}
    </th>
  );
}

function DrivesPicker({ onSelect }: { onSelect: (path: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [drives, setDrives] = useState<DriveEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await sftpLocalDrives();
      setDrives(list);
    } catch {
      setDrives([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    if (!drives) void refresh();
    const onDoc = (e: globalThis.MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDoc);
    return () => window.removeEventListener("mousedown", onDoc);
  }, [open, drives, refresh]);

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        title={t("fileBrowser.drivesSwitchTitle")}
        className="h-5 px-1 inline-flex items-center gap-0.5 rounded hover:bg-[var(--taomni-hover)] text-[11px]"
        onClick={() => setOpen((v) => !v)}
        style={{ color: "var(--taomni-text-muted)" }}
      >
        <HardDrive className="w-3 h-3" />
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div
          className="absolute top-full left-0 mt-0.5 z-50 min-w-[160px] py-1 text-[12px] shadow-lg rounded"
          style={{
            background: "var(--taomni-bg)",
            border: "1px solid var(--taomni-divider)",
            color: "var(--taomni-text)",
          }}
        >
          {loading && (
            <div className="px-2 py-1 text-[var(--taomni-text-muted)]">{t("fileBrowser.drivesLoading")}</div>
          )}
          {!loading && drives && drives.length === 0 && (
            <div className="px-2 py-1 text-[var(--taomni-text-muted)]">
              {t("fileBrowser.drivesNoneReported")}
            </div>
          )}
          {!loading &&
            drives?.map((d) => (
              <button
                key={d.id}
                type="button"
                className="w-full text-left px-2 py-1 hover:bg-[var(--taomni-hover)] flex items-center gap-1.5"
                onClick={() => {
                  onSelect(d.path);
                  setOpen(false);
                }}
                title={d.path}
              >
                <HardDrive className="w-3 h-3 shrink-0" />
                <span className="truncate">{d.label}</span>
                <span
                  className="ml-auto text-[10px]"
                  style={{ color: "var(--taomni-text-muted)" }}
                >
                  {d.path}
                </span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

function FileTypeIcon({ entry }: { entry: FileEntry }) {
  if (entry.fileType === "dir") return <Folder className="w-3.5 h-3.5 shrink-0" style={{ color: "#dab760" }} />;
  if (entry.fileType === "symlink") return <LinkIcon className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--taomni-accent)" }} />;
  return <FileIcon className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--taomni-text-muted)" }} />;
}

export function isPreviewable(entry: FileEntry): boolean {
  if (entry.fileType !== "file") return false;
  if (!entry.name.includes(".")) return entry.size <= 256 * 1024;
  const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
  return SUPPORTED_PREVIEW_EXT.has(ext);
}

export { basename, parentPath };
