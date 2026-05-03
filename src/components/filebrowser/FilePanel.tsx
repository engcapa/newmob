import { useEffect, useMemo, useState, useCallback, useRef, type DragEvent, type MouseEvent } from "react";
import { Folder, File as FileIcon, Link as LinkIcon } from "lucide-react";
import { PathBreadcrumb } from "./PathBreadcrumb";
import { FileToolbar } from "./FileToolbar";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { useSftpStore, type PaneSide } from "../../stores/sftpStore";
import {
  basename,
  formatBytes,
  parentPath,
  type FileEntry,
} from "../../lib/sftp";

interface FilePanelProps {
  sessionId: string;
  side: PaneSide;
  /** Optional subtitle (e.g. host) shown in muted text next to the LOCAL/REMOTE badge. */
  subtitle?: string;
  detachable?: boolean;
  onDetach?: () => void;
  onItemDoubleClick: (entry: FileEntry) => void;
  onItemContext?: (entry: FileEntry, anchor: { x: number; y: number }) => MenuItem[];
  onEmptyContext?: (anchor: { x: number; y: number }) => MenuItem[];
  onPaneFiles?: (files: File[]) => void;
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
  onDeleteSelected?: (entries: FileEntry[]) => void;
  onChmodSelected?: (entry: FileEntry) => void;
  onPreviewSelected?: (entry: FileEntry) => void;
  onNewFile?: () => void;
  onOpenTerminalHere?: (path: string) => void;
}

const SUPPORTED_PREVIEW_EXT = new Set([
  "txt", "md", "log", "json", "yaml", "yml", "js", "ts", "tsx",
  "jsx", "html", "css", "py", "rs", "go", "rb", "sh", "conf", "ini",
]);

export function FilePanel({
  sessionId,
  side,
  subtitle,
  detachable,
  onDetach,
  onItemDoubleClick,
  onItemContext,
  onEmptyContext,
  onPaneFiles,
  onCrossPaneDrop,
  acceptCrossPane,
  filterText,
  onFilterTextChange,
  onDownloadSelected,
  onUploadSelected,
  onUploadFromDisk,
  onDeleteSelected,
  onChmodSelected,
  onPreviewSelected,
  onNewFile,
  onOpenTerminalHere,
}: FilePanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const session = useSftpStore((s) => s.sessions[sessionId]);
  const navigate = useSftpStore((s) => s.navigate);
  const navigateBack = useSftpStore((s) => s.navigateBack);
  const navigateForward = useSftpStore((s) => s.navigateForward);
  const navigateUp = useSftpStore((s) => s.navigateUp);
  const refresh = useSftpStore((s) => s.refreshPane);
  const setSelection = useSftpStore((s) => s.setSelection);
  const toggleHidden = useSftpStore((s) => s.toggleHidden);
  const ctx = useContextMenu();

  const [sortKey, setSortKey] = useState<"name" | "size" | "mtime" | "type">("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [draggingOver, setDraggingOver] = useState(false);
  const lastClickedRef = useRef<string | null>(null);

  const pane = session?.[side];
  const showHidden = pane?.showHidden ?? false;

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

  if (!pane) {
    return (
      <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--moba-text-muted)]">
        Pane is not initialized.
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
    if (!pane.selection.includes(entry.path)) {
      setSelection(sessionId, side, [entry.path]);
    }
    if (!onItemContext) return;
    const items = onItemContext(entry, { x: e.clientX, y: e.clientY });
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

  const handleDragStart = (entry: FileEntry, e: DragEvent) => {
    const sel = pane.selection.includes(entry.path) ? pane.selection : [entry.path];
    const payload = JSON.stringify({
      sessionId,
      side,
      paths: sel,
    });
    e.dataTransfer.setData("application/x-newmob-files", payload);
    e.dataTransfer.setData("text/plain", sel.join("\n"));
    e.dataTransfer.effectAllowed = "copy";
  };

  const handleDragOver = (e: DragEvent) => {
    if (e.dataTransfer.types.includes("Files") && onPaneFiles) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDraggingOver(true);
      return;
    }
    if (acceptCrossPane && e.dataTransfer.types.includes("application/x-newmob-files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDraggingOver(true);
    }
  };

  const handleDragLeave = (e: DragEvent) => {
    if (e.currentTarget === e.target) setDraggingOver(false);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setDraggingOver(false);

    const osFiles = Array.from(e.dataTransfer.files);
    if (osFiles.length > 0 && onPaneFiles) {
      onPaneFiles(osFiles);
      return;
    }

    if (acceptCrossPane) {
      const raw = e.dataTransfer.getData("application/x-newmob-files");
      if (!raw) return;
      try {
        const data = JSON.parse(raw) as { sessionId: string; side: PaneSide; paths: string[] };
        if (data.side === side && data.sessionId === sessionId) return;
        const otherPane = useSftpStore.getState().sessions[data.sessionId]?.[data.side];
        if (!otherPane) return;
        const entries = otherPane.entries.filter((entry) => data.paths.includes(entry.path));
        if (entries.length > 0) onCrossPaneDrop?.(entries);
      } catch {
        /* ignore malformed drag */
      }
    }
  };

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

  const handleMkdir = () => {
    if (!onEmptyContext) return;
    const items = onEmptyContext({ x: 0, y: 0 });
    const mkdirItem = items.find((it) => it.label.toLowerCase().includes("folder"));
    if (mkdirItem?.onClick) mkdirItem.onClick();
  };

  return (
    <div className="h-full w-full min-w-0 flex flex-col min-h-0">
      <div
        className="h-7 flex items-center px-2 text-[11px] border-b shrink-0 gap-2"
        style={{ borderColor: "var(--moba-divider)", background: "var(--moba-quick-bg)" }}
      >
        <span
          className="px-1.5 py-[1px] text-[10px] font-bold tracking-wider rounded shrink-0"
          style={{
            background: side === "remote" ? "var(--moba-accent)" : "var(--moba-text-muted)",
            color: "#fff",
            letterSpacing: "0.08em",
          }}
        >
          {side === "remote" ? "REMOTE" : "LOCAL"}
        </span>
        {subtitle && (
          <span
            className="truncate text-[11px]"
            style={{ color: "var(--moba-text-muted)" }}
            title={subtitle}
          >
            {subtitle}
          </span>
        )}
        <div className="flex-1" />
        {onFilterTextChange && (
          <input
            type="search"
            value={filterText ?? ""}
            placeholder="Filter…"
            onChange={(e) => onFilterTextChange(e.target.value)}
            className="moba-input h-5 px-1.5 text-[11px] w-[140px] rounded shrink-0"
            style={{
              background: "var(--moba-input-bg)",
              border: "1px solid var(--moba-input-border)",
              color: "var(--moba-text)",
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
        canUp={pane.path !== "/" && !!pane.path && !/^[A-Z]:\\?$/i.test(pane.path)}
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
          onChmodSelected && firstSelected
            ? () => onChmodSelected(firstSelected)
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
        onOpenTerminalHere={
          side === "remote" && onOpenTerminalHere
            ? () => onOpenTerminalHere(pane.path)
            : undefined
        }
        onToggleHidden={() => toggleHidden(sessionId, side)}
        onDetach={detachable ? onDetach : undefined}
      />
      <div className="h-6 flex items-center gap-1 px-1 border-b shrink-0"
        style={{ borderColor: "var(--moba-divider)" }}>
        <PathBreadcrumb
          path={pane.path}
          homePath={side === "remote" ? session?.homeDir ?? null : null}
          onNavigate={(p) => void navigate(sessionId, side, p)}
          onSubmit={(p) => void navigate(sessionId, side, p)}
          detectWindows={pane.path.includes("\\")}
        />
      </div>

      <div
        className="flex-1 overflow-auto text-[12px] relative"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onContextMenu={handleEmptyContext}
        onClick={handleEmptyClick}
        style={{ background: "var(--moba-bg)" }}
      >
        {ctx.render}
        {draggingOver && (
          <div
            className="absolute inset-0 pointer-events-none border-2 border-dashed z-10 flex items-center justify-center"
            style={{ borderColor: "var(--moba-accent)", background: "rgba(43,93,139,0.08)" }}
          >
            <span className="text-xs font-semibold text-[var(--moba-accent)]">
              Drop to copy here
            </span>
          </div>
        )}
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10" style={{ background: "var(--moba-quick-bg)" }}>
            <tr className="text-[11px] uppercase tracking-wide" style={{ color: "var(--moba-text-muted)" }}>
              <SortHeader label="Name" active={sortKey === "name"} dir={sortDir} onClick={() => onHeaderClick("name")} />
              <SortHeader label="Size" active={sortKey === "size"} dir={sortDir} onClick={() => onHeaderClick("size")} className="w-[80px] text-right" />
              <SortHeader label="Modified" active={sortKey === "mtime"} dir={sortDir} onClick={() => onHeaderClick("mtime")} className="w-[140px]" />
              <SortHeader label="Type" active={sortKey === "type"} dir={sortDir} onClick={() => onHeaderClick("type")} className="w-[80px]" />
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
                <td colSpan={4} className="px-2 py-3 text-center text-[var(--moba-text-muted)]">
                  Empty directory
                </td>
              </tr>
            )}
            {sortedEntries.map((entry) => (
              <tr
                key={entry.path}
                data-row
                draggable
                onDragStart={(e) => handleDragStart(entry, e)}
                className="cursor-default select-none"
                style={{
                  background: pane.selection.includes(entry.path)
                    ? "var(--moba-selected)"
                    : undefined,
                }}
                onClick={(e) => handleRowClick(entry, e)}
                onDoubleClick={() => onItemDoubleClick(entry)}
                onContextMenu={(e) => handleRowContext(entry, e)}
                title={entry.path}
              >
                <td className="px-1.5 py-0.5 flex items-center gap-1 truncate">
                  <FileTypeIcon entry={entry} />
                  <span className="truncate">{entry.name}</span>
                  {entry.symlinkTarget && (
                    <span className="text-[10px] text-[var(--moba-text-muted)]">→ {entry.symlinkTarget}</span>
                  )}
                </td>
                <td className="px-1.5 py-0.5 text-right text-[var(--moba-text-muted)]">
                  {entry.fileType === "dir" ? "" : formatBytes(entry.size)}
                </td>
                <td className="px-1.5 py-0.5 text-[var(--moba-text-muted)]">
                  {entry.mtime ? new Date(entry.mtime * 1000).toLocaleString() : ""}
                </td>
                <td className="px-1.5 py-0.5 text-[var(--moba-text-muted)]">
                  {entry.fileType === "dir"
                    ? "folder"
                    : (entry.name.split(".").pop() ?? "").toLowerCase()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="h-5 px-2 text-[11px] flex items-center border-t shrink-0"
        style={{ borderColor: "var(--moba-divider)", background: "var(--moba-status-bg)", color: "var(--moba-status-text)" }}>
        {pane.loading
          ? "Loading…"
          : `${sortedEntries.length} item${sortedEntries.length === 1 ? "" : "s"}` +
            (pane.selection.length > 0 ? ` • ${pane.selection.length} selected` : "")}
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
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
  className?: string;
}) {
  return (
    <th
      className={`text-left px-1.5 py-0.5 cursor-pointer select-none border-b ${className ?? ""}`}
      style={{ borderColor: "var(--moba-divider)" }}
      onClick={onClick}
    >
      {label} {active ? (dir === "asc" ? "▲" : "▼") : ""}
    </th>
  );
}

function FileTypeIcon({ entry }: { entry: FileEntry }) {
  if (entry.fileType === "dir") return <Folder className="w-3.5 h-3.5 shrink-0" style={{ color: "#dab760" }} />;
  if (entry.fileType === "symlink") return <LinkIcon className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--moba-accent)" }} />;
  return <FileIcon className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--moba-text-muted)" }} />;
}

export function isPreviewable(entry: FileEntry): boolean {
  if (entry.fileType !== "file") return false;
  if (!entry.name.includes(".")) return entry.size <= 256 * 1024;
  const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
  return SUPPORTED_PREVIEW_EXT.has(ext);
}

export { basename, parentPath };
