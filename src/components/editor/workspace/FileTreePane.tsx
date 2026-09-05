import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ChevronLeft,
  Columns2,
  File,
  FilePlus,
  FolderOpen,
  FolderPlus,
  List,
  ListTree,
  MoreHorizontal,
  Search,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useContextMenu, type MenuItem } from "../../ContextMenu";
import {
  nextTreeViewMode,
  treeToolbarDensity,
  treeToolbarVisibility,
  treeViewModeLabel,
  type FileTreeViewMode,
} from "./treeToolbarChrome";

export type { FileTreeViewMode };

interface FileTreePaneProps {
  paneRef: RefObject<HTMLElement | null>;
  style: CSSProperties;
  filter: string;
  onFilterChange: (value: string) => void;
  viewMode: FileTreeViewMode;
  onViewModeChange: (mode: FileTreeViewMode) => void;
  fontSize: number;
  minFontSize: number;
  maxFontSize: number;
  defaultFontSize: number;
  onFontSizeChange: (size: number) => void;
  /** When provided, show a panel-local collapse control (like BottomDock). */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onOpenFile: () => void;
  onAddFolder: () => void;
  canCreate: boolean;
  canMutateSelection: boolean;
  onCreateFile: () => void;
  onCreateDirectory: () => void;
  onRename: () => void;
  onDelete: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  children: ReactNode;
}

interface TreeIconButtonProps {
  label: string;
  icon: ReactNode;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  testId?: string;
  active?: boolean;
  disabled?: boolean;
}

function TreeIconButton({
  label,
  icon,
  onClick,
  testId,
  active = false,
  disabled = false,
}: TreeIconButtonProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-active={active || undefined}
      title={label}
      aria-label={label}
      disabled={disabled}
      className="h-6 w-6 shrink-0 inline-flex items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] data-[active=true]:bg-[var(--taomni-code-selection-match-bg)] data-[active=true]:text-[var(--taomni-code-text)] disabled:opacity-40"
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

function viewModeIcon(mode: FileTreeViewMode): ReactNode {
  switch (mode) {
    case "tree":
      return <ListTree className="w-3.5 h-3.5" />;
    case "compact":
      return <Columns2 className="w-3.5 h-3.5" />;
    case "flat":
      return <List className="w-3.5 h-3.5" />;
  }
}

export function FileTreePane({
  paneRef,
  style,
  filter,
  onFilterChange,
  viewMode,
  onViewModeChange,
  fontSize,
  minFontSize,
  maxFontSize,
  defaultFontSize,
  onFontSizeChange,
  collapsed = false,
  onToggleCollapse,
  onOpenFile,
  onAddFolder,
  canCreate,
  canMutateSelection,
  onCreateFile,
  onCreateDirectory,
  onRename,
  onDelete,
  children,
  onKeyDown,
}: FileTreePaneProps) {
  const toolbarMenu = useContextMenu();
  const [toolbarWidth, setToolbarWidth] = useState(TREE_DEFAULT_WIDTH_ASSUMPTION);
  const density = treeToolbarDensity(toolbarWidth);
  const visibility = useMemo(() => treeToolbarVisibility(density), [density]);

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const measure = () => {
      const width = pane.getBoundingClientRect().width;
      if (width > 0) setToolbarWidth(width);
    };
    measure();
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => measure());
    ro?.observe(pane);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [paneRef]);

  const openToolbarOverflow = (event: MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const items: MenuItem[] = [];
    if (!visibility.showNewFile) {
      items.push({ label: "New file", disabled: !canCreate, onClick: onCreateFile });
    }
    if (!visibility.showNewDirectory) {
      items.push({ label: "New directory", disabled: !canCreate, onClick: onCreateDirectory });
    }
    if (items.length > 0) {
      items.push({ separator: true, label: "" });
    }
    items.push(
      { label: "Rename", disabled: !canMutateSelection, onClick: onRename },
      { label: "Delete or remove", disabled: !canMutateSelection, onClick: onDelete },
    );
    if (!visibility.showZoom) {
      items.push(
        { separator: true, label: "" },
        {
          label: "Zoom out",
          disabled: fontSize <= minFontSize,
          onClick: () => onFontSizeChange(fontSize - 1),
        },
        {
          label: `Reset zoom (${defaultFontSize}px)`,
          onClick: () => onFontSizeChange(defaultFontSize),
        },
        {
          label: "Zoom in",
          disabled: fontSize >= maxFontSize,
          onClick: () => onFontSizeChange(fontSize + 1),
        },
      );
    }
    if (visibility.showViewCycle) {
      items.push(
        { separator: true, label: "" },
        { label: "Tree view", checked: viewMode === "tree", onClick: () => onViewModeChange("tree") },
        { label: "Compact tree view", checked: viewMode === "compact", onClick: () => onViewModeChange("compact") },
        { label: "Flat file view", checked: viewMode === "flat", onClick: () => onViewModeChange("flat") },
      );
    }
    toolbarMenu.showAt(rect.right, rect.bottom, items);
  };

  return (
    <aside
      ref={paneRef}
      tabIndex={0}
      data-testid="code-workspace-tree-pane"
      data-tree-toolbar-density={density}
      className="h-full min-h-0 flex flex-col border-r border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--taomni-accent)]"
      style={style}
      onKeyDown={onKeyDown}
    >
      {/*
        Two-row chrome (fixed px heights):
        - Row 1: project actions. Open/Add always visible; New* collapse first.
        - Row 2: filter + view/zoom (zoom/views collapse before Open/Add).
        No classic overflow-x-auto row — progressive hide + ⋯ menu only.
      */}
      <div
        data-testid="code-workspace-tree-toolbar"
        className="shrink-0 flex flex-col border-b border-[var(--taomni-code-border)]"
      >
        <div
          data-testid="code-workspace-tree-toolbar-actions"
          className="h-[28px] flex items-center gap-0.5 px-1.5"
        >
          <TreeIconButton
            label="Open file"
            testId="code-workspace-tree-open-file"
            icon={<File className="w-3.5 h-3.5" />}
            onClick={onOpenFile}
          />
          <TreeIconButton
            label="Add folder"
            testId="code-workspace-tree-add-folder"
            icon={<FolderOpen className="w-3.5 h-3.5" />}
            onClick={onAddFolder}
          />
          {visibility.showNewFile && (
            <TreeIconButton
              label="New file"
              testId="code-workspace-tree-new-file"
              icon={<FilePlus className="w-3.5 h-3.5" />}
              disabled={!canCreate}
              onClick={onCreateFile}
            />
          )}
          {visibility.showNewDirectory && (
            <TreeIconButton
              label="New directory"
              testId="code-workspace-tree-new-directory"
              icon={<FolderPlus className="w-3.5 h-3.5" />}
              disabled={!canCreate}
              onClick={onCreateDirectory}
            />
          )}
          <div className="flex-1 min-w-0" />
          <TreeIconButton
            label="More tree actions"
            testId="code-workspace-tree-toolbar-more"
            icon={<MoreHorizontal className="w-3.5 h-3.5" />}
            onClick={openToolbarOverflow}
          />
          {onToggleCollapse && (
            <TreeIconButton
              label={collapsed ? "Show project tree" : "Hide project tree"}
              testId="code-workspace-tree-collapse"
              icon={<ChevronLeft className="w-3.5 h-3.5" />}
              onClick={onToggleCollapse}
            />
          )}
        </div>
        <div
          data-testid="code-workspace-tree-toolbar-browse"
          className="h-[28px] flex items-center gap-1 px-1.5 border-t border-[var(--taomni-code-border)]"
        >
          <Search className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
          <div className="min-w-0 flex-1 flex items-center gap-0.5">
            <input
              type="search"
              data-testid="code-workspace-tree-filter"
              value={filter}
              onChange={(event) => onFilterChange(event.target.value)}
              placeholder="Filter"
              aria-label="Filter files"
              className="min-w-0 flex-1 bg-transparent outline-none text-[var(--taomni-code-text)] placeholder:text-[var(--taomni-code-muted)]"
              style={{ fontSize: "var(--taomni-code-tree-font-size)" }}
            />
          </div>
          {visibility.showViewModes && (
            <div className="flex shrink-0 items-center gap-0.5 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-0.5">
              <TreeIconButton
                label="Tree view"
                testId="code-workspace-view-tree"
                icon={<ListTree className="w-3.5 h-3.5" />}
                active={viewMode === "tree"}
                onClick={() => onViewModeChange("tree")}
              />
              <TreeIconButton
                label="Compact tree view"
                testId="code-workspace-view-compact"
                icon={<Columns2 className="w-3.5 h-3.5" />}
                active={viewMode === "compact"}
                onClick={() => onViewModeChange("compact")}
              />
              <TreeIconButton
                label="Flat file view"
                testId="code-workspace-view-flat"
                icon={<List className="w-3.5 h-3.5" />}
                active={viewMode === "flat"}
                onClick={() => onViewModeChange("flat")}
              />
            </div>
          )}
          {visibility.showViewCycle && (
            <TreeIconButton
              label={`Cycle view (${treeViewModeLabel(viewMode)})`}
              testId="code-workspace-view-cycle"
              icon={viewModeIcon(viewMode)}
              active
              onClick={() => onViewModeChange(nextTreeViewMode(viewMode))}
            />
          )}
          {visibility.showZoom && (
            <div className="flex shrink-0 items-center gap-0.5 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-0.5">
              <TreeIconButton
                label="Tree zoom out"
                testId="code-workspace-tree-zoom-out"
                icon={<ZoomOut className="w-3.5 h-3.5" />}
                disabled={fontSize <= minFontSize}
                onClick={() => onFontSizeChange(fontSize - 1)}
              />
              <button
                type="button"
                data-testid="code-workspace-tree-zoom-reset"
                title="Reset tree zoom"
                aria-label="Reset tree zoom"
                className="h-6 min-w-8 rounded px-1 text-[11px] tabular-nums text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
                onClick={() => onFontSizeChange(defaultFontSize)}
              >
                {fontSize}px
              </button>
              <TreeIconButton
                label="Tree zoom in"
                testId="code-workspace-tree-zoom-in"
                icon={<ZoomIn className="w-3.5 h-3.5" />}
                disabled={fontSize >= maxFontSize}
                onClick={() => onFontSizeChange(fontSize + 1)}
              />
            </div>
          )}
        </div>
      </div>
      <div
        data-testid="code-workspace-tree"
        className="flex-1 min-h-0 overflow-auto py-1"
        style={{ fontSize: "var(--taomni-code-tree-font-size)" }}
      >
        {children}
      </div>
      {toolbarMenu.render}
    </aside>
  );
}

/** Default before first measure — treat as wide so SSR/tests show full primary actions. */
const TREE_DEFAULT_WIDTH_ASSUMPTION = 360;
