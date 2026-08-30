import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { ChevronRight, File, Folder, Hash, MoreHorizontal } from "lucide-react";
import type { LspDocumentSymbol, LspPosition } from "../../../lib/editor/lsp";
import { navigateSegments } from "./navigationBarModel";

export interface BreadcrumbPathSegment {
  label: string;
  path: string;
  kind: "root" | "directory" | "file";
}

/** Child/sibling entry shown in a path-segment dropdown (IDEA-style). */
export interface BreadcrumbPathChild {
  label: string;
  path: string;
  kind: "directory" | "file";
  /** True when this entry is the next segment on the current trail. */
  active?: boolean;
}

export interface BreadcrumbPathAction {
  id: string;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
}

type BreadcrumbItem =
  | { type: "path"; value: BreadcrumbPathSegment }
  | { type: "symbol"; value: LspDocumentSymbol }
  | { type: "collapsed"; hiddenPaths: BreadcrumbPathSegment[] };

interface BreadcrumbsProps {
  pathSegments: BreadcrumbPathSegment[];
  symbols: LspDocumentSymbol[];
  position: LspPosition;
  /**
   * Load children of a directory/root, or siblings of a file (parent listing).
   * When provided, path segment clicks open an IDEA-style navigation popup.
   */
  loadPathChildren?: (segment: BreadcrumbPathSegment) => Promise<BreadcrumbPathChild[]>;
  /** Navigate to a child/sibling picked from the path dropdown. */
  onPathNavigate?: (child: BreadcrumbPathChild, fromSegment: BreadcrumbPathSegment) => void;
  /** Context / footer actions for a path segment (copy path, reveal, …). */
  pathActionsForSegment?: (segment: BreadcrumbPathSegment) => BreadcrumbPathAction[];
  /**
   * Fallback simple click when `loadPathChildren` is not provided
   * (e.g. reveal the segment in the project tree).
   */
  onPathClick?: (segment: BreadcrumbPathSegment) => void;
  onSymbolClick?: (symbol: LspDocumentSymbol) => void;
  /** When activated via Alt+Home / workspace.activateNavigationBar, keyboard arrow navigation is enabled. */
  activeNavigationBar?: boolean;
  onCloseNavigationBar?: () => void;
}

type OpenPopup =
  | {
      kind: "path";
      segment: BreadcrumbPathSegment;
      anchor: DOMRect;
      children: BreadcrumbPathChild[];
      loading: boolean;
      error: string | null;
    }
  | {
      kind: "symbol";
      symbol: LspDocumentSymbol;
      siblings: LspDocumentSymbol[];
      anchor: DOMRect;
    }
  | {
      kind: "collapsed";
      segments: BreadcrumbPathSegment[];
      anchor: DOMRect;
    };

function positionWithin(symbol: LspDocumentSymbol, position: LspPosition): boolean {
  const { start, end } = symbol.range;
  if (position.line < start.line || position.line > end.line) return false;
  if (position.line === start.line && position.character < start.character) return false;
  if (position.line === end.line && position.character > end.character) return false;
  return true;
}

export function symbolChainAtPosition(
  symbols: LspDocumentSymbol[],
  position: LspPosition,
): LspDocumentSymbol[] {
  return symbols
    .filter((symbol) => positionWithin(symbol, position))
    .sort((left, right) => left.depth - right.depth);
}

/**
 * Siblings of `target` under the same enclosing parent symbol (or top-level
 * peers when depth is 0). Matches IDEA breadcrumb symbol dropdown behavior.
 */
export function symbolSiblingsAt(
  symbols: LspDocumentSymbol[],
  target: LspDocumentSymbol,
): LspDocumentSymbol[] {
  const parent = symbols
    .filter((symbol) =>
      symbol.depth === target.depth - 1 && positionWithin(symbol, target.selectionRange.start)
    )
    .sort((left, right) => right.depth - left.depth)[0] ?? null;

  return symbols
    .filter((symbol) => {
      if (symbol.depth !== target.depth) return false;
      if (!parent) return target.depth === 0;
      return positionWithin(parent, symbol.selectionRange.start);
    })
    .sort((left, right) => {
      if (left.range.start.line !== right.range.start.line) {
        return left.range.start.line - right.range.start.line;
      }
      return left.range.start.character - right.range.start.character;
    });
}

/** Keep the root, the active file, and the nearest parent visible in narrow panes. */
export function collapsedBreadcrumbItems(
  pathSegments: BreadcrumbPathSegment[],
  symbols: LspDocumentSymbol[],
): BreadcrumbItem[] {
  const compactPath: BreadcrumbItem[] = pathSegments.length > 3
    ? [
        { type: "path", value: pathSegments[0]! },
        { type: "collapsed", hiddenPaths: pathSegments.slice(1, -2) },
        ...pathSegments.slice(-2).map((value) => ({ type: "path" as const, value })),
      ]
    : pathSegments.map((value) => ({ type: "path" as const, value }));
  const compactSymbols: BreadcrumbItem[] = symbols.length > 1
    ? [{ type: "collapsed", hiddenPaths: [] }, { type: "symbol", value: symbols.at(-1)! }]
    : symbols.map((value) => ({ type: "symbol" as const, value }));

  return [...compactPath, ...compactSymbols];
}

function sortPathChildren(entries: BreadcrumbPathChild[]): BreadcrumbPathChild[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.label.localeCompare(right.label, undefined, { sensitivity: "base" });
  });
}

function filterByQuery<T>(items: T[], query: string, labelOf: (item: T) => string): T[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return items;
  return items.filter((item) => labelOf(item).toLowerCase().includes(trimmed));
}

interface SegmentPopupProps {
  open: OpenPopup;
  query: string;
  selectedIndex: number;
  actions: BreadcrumbPathAction[];
  onQueryChange: (value: string) => void;
  onSelectedIndexChange: (index: number) => void;
  onClose: (restoreFocus?: boolean) => void;
  onPickPathChild: (child: BreadcrumbPathChild) => void;
  onPickSymbol: (symbol: LspDocumentSymbol) => void;
  onPickCollapsedSegment: (segment: BreadcrumbPathSegment) => void;
  onAction: (action: BreadcrumbPathAction) => void;
}

function SegmentPopup({
  open,
  query,
  selectedIndex,
  actions,
  onQueryChange,
  onSelectedIndexChange,
  onClose,
  onPickPathChild,
  onPickSymbol,
  onPickCollapsedSegment,
  onAction,
}: SegmentPopupProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState({ left: open.anchor.left, top: open.anchor.bottom + 2 });
  const popupId = `code-workspace-breadcrumb-popup-${useId().replace(/:/g, "")}`;

  const pathChildren = open.kind === "path" ? sortPathChildren(open.children) : [];
  const filteredPath = open.kind === "path"
    ? filterByQuery(pathChildren, query, (item) => item.label)
    : [];
  const filteredSymbols = open.kind === "symbol"
    ? filterByQuery(open.siblings, query, (item) => item.name)
    : [];
  const filteredCollapsed = open.kind === "collapsed"
    ? filterByQuery(open.segments, query, (item) => item.label)
    : [];

  const itemCount = open.kind === "path"
    ? filteredPath.length
    : open.kind === "symbol"
      ? filteredSymbols.length
      : filteredCollapsed.length;
  const actionStart = itemCount;
  const totalCount = itemCount + actions.length;
  const safeIndex = totalCount === 0 ? 0 : Math.min(selectedIndex, totalCount - 1);
  const activeOptionId = totalCount > 0 ? `${popupId}-option-${safeIndex}` : undefined;

  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 6;
    const left = Math.min(
      Math.max(margin, open.anchor.left),
      Math.max(margin, window.innerWidth - rect.width - margin),
    );
    const preferBelow = open.anchor.bottom + 2;
    const top = preferBelow + rect.height + margin > window.innerHeight
      ? Math.max(margin, open.anchor.top - rect.height - 2)
      : preferBelow;
    setCoords({ left, top });
  }, [open, query, itemCount, actions.length]);

  useEffect(() => {
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open.kind, open.kind === "path" ? open.segment.path : open.kind === "symbol" ? open.symbol.name : "collapsed"]);

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (panelRef.current && target && !panelRef.current.contains(target)) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose(true);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>(`[data-popup-index="${safeIndex}"]`);
    if (active && typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ block: "nearest" });
    }
  }, [safeIndex]);

  const activate = (index: number) => {
    if (index < itemCount) {
      if (open.kind === "path") {
        const child = filteredPath[index];
        if (child) onPickPathChild(child);
      } else if (open.kind === "symbol") {
        const symbol = filteredSymbols[index];
        if (symbol) onPickSymbol(symbol);
      } else {
        const segment = filteredCollapsed[index];
        if (segment) onPickCollapsedSegment(segment);
      }
      return;
    }
    const action = actions[index - itemCount];
    if (action && !action.disabled) onAction(action);
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (totalCount > 0) onSelectedIndexChange((safeIndex + 1) % totalCount);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (totalCount > 0) onSelectedIndexChange((safeIndex - 1 + totalCount) % totalCount);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      activate(safeIndex);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClose(true);
    }
  };

  const title = open.kind === "path"
    ? open.segment.label
    : open.kind === "symbol"
      ? open.symbol.name
      : "Path";

  return createPortal(
    <div
      ref={panelRef}
      role="listbox"
      aria-label={`${title} breadcrumb menu`}
      aria-activedescendant={activeOptionId}
      id={popupId}
      data-testid="code-workspace-breadcrumb-popup"
      data-taomni-context-menu="true"
      className="fixed z-[500] flex max-h-[min(360px,50vh)] w-[min(320px,calc(100vw-12px))] flex-col overflow-hidden rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-tooltip-bg)] text-[11px] text-[var(--taomni-code-text)] shadow-xl"
      style={{ left: coords.left, top: coords.top }}
      onKeyDown={onKeyDown}
    >
      <div className="border-b border-[var(--taomni-code-border)] px-2 py-1.5">
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          data-testid="code-workspace-breadcrumb-popup-filter"
          aria-label="Filter breadcrumb entries"
          aria-controls={popupId}
          aria-expanded="true"
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          className="taomni-input h-6 w-full text-[11px]"
          placeholder={open.kind === "path" && open.loading ? "Loading…" : "Type to filter"}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
        {open.kind === "path" && open.loading && (
          <div className="px-2 py-1.5 text-[var(--taomni-code-muted)]">Loading…</div>
        )}
        {open.kind === "path" && open.error && (
          <div className="px-2 py-1.5 text-red-400">{open.error}</div>
        )}
        {open.kind === "path" && !open.loading && !open.error && filteredPath.length === 0 && (
          <div className="px-2 py-1.5 text-[var(--taomni-code-muted)]">
            {query.trim() ? "No matching entries" : "Empty folder"}
          </div>
        )}
        {open.kind === "path" && filteredPath.map((child, index) => (
          <button
            key={`${child.kind}:${child.path}`}
            type="button"
            role="option"
            id={`${popupId}-option-${index}`}
            aria-selected={index === safeIndex}
            aria-current={child.active ? "page" : undefined}
            data-popup-index={index}
            data-active={child.active || undefined}
            data-testid={`code-workspace-breadcrumb-entry-${child.kind}`}
            className={`flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-[var(--taomni-code-active-line-bg)] ${
              index === safeIndex ? "bg-[var(--taomni-code-active-line-bg)]" : ""
            } ${child.active ? "text-[var(--taomni-code-text)] font-medium" : "text-[var(--taomni-code-muted)]"}`}
            onMouseEnter={() => onSelectedIndexChange(index)}
            onClick={() => activate(index)}
          >
            {child.kind === "directory" ? (
              <Folder className="h-3 w-3 shrink-0 text-[#d59d32]" />
            ) : (
              <File className="h-3 w-3 shrink-0" />
            )}
            <span className="min-w-0 truncate">{child.label}</span>
          </button>
        ))}
        {open.kind === "symbol" && filteredSymbols.length === 0 && (
          <div className="px-2 py-1.5 text-[var(--taomni-code-muted)]">
            {query.trim() ? "No matching symbols" : "No symbols"}
          </div>
        )}
        {open.kind === "symbol" && filteredSymbols.map((symbol, index) => {
          const current = symbol === open.symbol
            || (symbol.name === open.symbol.name
              && symbol.selectionRange.start.line === open.symbol.selectionRange.start.line
              && symbol.selectionRange.start.character === open.symbol.selectionRange.start.character);
          return (
            <button
              key={`${symbol.name}:${symbol.selectionRange.start.line}:${symbol.selectionRange.start.character}`}
              type="button"
              role="option"
              id={`${popupId}-option-${index}`}
              aria-selected={index === safeIndex}
              data-popup-index={index}
              data-testid="code-workspace-breadcrumb-entry-symbol"
              className={`flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-[var(--taomni-code-active-line-bg)] ${
                index === safeIndex ? "bg-[var(--taomni-code-active-line-bg)]" : ""
              } ${current ? "text-[var(--taomni-code-text)] font-medium" : "text-[var(--taomni-code-muted)]"}`}
              onMouseEnter={() => onSelectedIndexChange(index)}
              onClick={() => activate(index)}
            >
              <Hash className="h-3 w-3 shrink-0 text-[var(--taomni-accent)]" />
              <span className="min-w-0 truncate">{symbol.name}</span>
              {symbol.detail && (
                <span className="ml-auto min-w-0 max-w-[40%] truncate text-[10px] text-[var(--taomni-code-muted)]">
                  {symbol.detail}
                </span>
              )}
            </button>
          );
        })}
        {open.kind === "collapsed" && filteredCollapsed.map((segment, index) => (
          <button
            key={`collapsed:${segment.path}:${segment.label}`}
            type="button"
            role="option"
            id={`${popupId}-option-${index}`}
            aria-selected={index === safeIndex}
            data-popup-index={index}
            data-testid="code-workspace-breadcrumb-entry-collapsed"
            className={`flex w-full items-center gap-1.5 px-2 py-1 text-left text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] ${
              index === safeIndex ? "bg-[var(--taomni-code-active-line-bg)]" : ""
            }`}
            onMouseEnter={() => onSelectedIndexChange(index)}
            onClick={() => activate(index)}
          >
            {segment.kind === "file" ? (
              <File className="h-3 w-3 shrink-0" />
            ) : (
              <Folder className="h-3 w-3 shrink-0 text-[#d59d32]" />
            )}
            <span className="min-w-0 truncate">{segment.label}</span>
          </button>
        ))}
      </div>
      {actions.length > 0 && (
        <div className="border-t border-[var(--taomni-code-border)] py-1">
          {actions.map((action, offset) => {
            const index = actionStart + offset;
            return (
              <button
                key={action.id}
                type="button"
                role="option"
                id={`${popupId}-option-${index}`}
                aria-selected={index === safeIndex}
                data-popup-index={index}
                data-testid={`code-workspace-breadcrumb-action-${action.id}`}
                disabled={action.disabled}
                className={`flex w-full items-center px-2 py-1 text-left hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40 ${
                  index === safeIndex ? "bg-[var(--taomni-code-active-line-bg)]" : ""
                } ${action.danger ? "text-red-400" : "text-[var(--taomni-code-text)]"}`}
                onMouseEnter={() => onSelectedIndexChange(index)}
                onClick={() => activate(index)}
              >
                {action.label}
              </button>
            );
          })}
        </div>
      )}
    </div>,
    document.body,
  );
}

export function Breadcrumbs({
  pathSegments,
  symbols,
  position,
  loadPathChildren,
  onPathNavigate,
  pathActionsForSegment,
  onPathClick,
  onSymbolClick,
  activeNavigationBar = false,
  onCloseNavigationBar,
}: BreadcrumbsProps) {
  const symbolChain = symbolChainAtPosition(symbols, position);
  const navRef = useRef<HTMLElement | null>(null);
  const fullPathMeasureRef = useRef<HTMLDivElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [popup, setPopup] = useState<OpenPopup | null>(null);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [navBarFocusedIndex, setNavBarFocusedIndex] = useState<number | null>(null);
  const loadGenerationRef = useRef(0);

  const fullItems = useMemo<BreadcrumbItem[]>(() => [
    ...pathSegments.map((value) => ({ type: "path" as const, value })),
    ...symbolChain.map((value) => ({ type: "symbol" as const, value })),
  ], [pathSegments, symbolChain]);
  const compactItems = useMemo(
    () => collapsedBreadcrumbItems(pathSegments, symbolChain),
    [pathSegments, symbolChain],
  );
  const visibleItems = collapsed ? compactItems : fullItems;

  useEffect(() => {
    if (activeNavigationBar) {
      setNavBarFocusedIndex(visibleItems.length > 0 ? visibleItems.length - 1 : 0);
      navRef.current?.focus();
    } else {
      setNavBarFocusedIndex(null);
    }
  }, [activeNavigationBar, visibleItems.length]);

  useLayoutEffect(() => {
    const updateCollapsedState = () => {
      const availableWidth = navRef.current?.clientWidth ?? 0;
      const fullPathWidth = fullPathMeasureRef.current?.getBoundingClientRect().width ?? 0;
      if (availableWidth > 0 && fullPathWidth > 0) {
        setCollapsed(fullPathWidth > availableWidth);
      }
    };

    updateCollapsedState();
    if (typeof ResizeObserver === "undefined" || !navRef.current) return;
    const observer = new ResizeObserver(updateCollapsedState);
    observer.observe(navRef.current);
    return () => observer.disconnect();
  }, [fullItems]);

  // Close popup when the active trail changes (file switch / cursor jump).
  useEffect(() => {
    // Invalidate an in-flight directory listing whenever the active trail or
    // caret changes, so a late response cannot reopen an obsolete popup.
    loadGenerationRef.current += 1;
    setPopup(null);
    setQuery("");
    setSelectedIndex(0);
  }, [pathSegments, position.line, position.character]);

  const closePopup = useCallback((restoreFocus = false) => {
    loadGenerationRef.current += 1;
    setPopup(null);
    setQuery("");
    setSelectedIndex(0);
    if (restoreFocus) navRef.current?.focus();
  }, []);

  const actionsForOpen = useMemo(() => {
    if (!popup || popup.kind !== "path" || !pathActionsForSegment) return [];
    return pathActionsForSegment(popup.segment);
  }, [pathActionsForSegment, popup]);

  const openPathPopup = useCallback(async (
    segment: BreadcrumbPathSegment,
    anchorEl: HTMLElement,
  ) => {
    const anchor = anchorEl.getBoundingClientRect();
    if (!loadPathChildren) {
      onPathClick?.(segment);
      return;
    }
    const generation = ++loadGenerationRef.current;
    setQuery("");
    setSelectedIndex(0);
    setPopup({
      kind: "path",
      segment,
      anchor,
      children: [],
      loading: true,
      error: null,
    });
    try {
      const children = await loadPathChildren(segment);
      if (generation !== loadGenerationRef.current) return;
      const activeIndex = Math.max(0, sortPathChildren(children).findIndex((child) => child.active));
      setSelectedIndex(activeIndex);
      setPopup({
        kind: "path",
        segment,
        anchor,
        children,
        loading: false,
        error: null,
      });
    } catch (error) {
      if (generation !== loadGenerationRef.current) return;
      setPopup({
        kind: "path",
        segment,
        anchor,
        children: [],
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [loadPathChildren, onPathClick]);

  const openSymbolPopup = useCallback((
    symbol: LspDocumentSymbol,
    anchorEl: HTMLElement,
  ) => {
    const siblings = symbolSiblingsAt(symbols, symbol);
    if (siblings.length <= 1) {
      onSymbolClick?.(symbol);
      return;
    }
    const anchor = anchorEl.getBoundingClientRect();
    const activeIndex = Math.max(0, siblings.findIndex((item) =>
      item.name === symbol.name
      && item.selectionRange.start.line === symbol.selectionRange.start.line
      && item.selectionRange.start.character === symbol.selectionRange.start.character
    ));
    setQuery("");
    setSelectedIndex(activeIndex);
    setPopup({ kind: "symbol", symbol, siblings, anchor });
  }, [onSymbolClick, symbols]);

  const openCollapsedPopup = useCallback((
    segments: BreadcrumbPathSegment[],
    anchorEl: HTMLElement,
  ) => {
    if (segments.length === 0) return;
    setQuery("");
    setSelectedIndex(0);
    setPopup({
      kind: "collapsed",
      segments,
      anchor: anchorEl.getBoundingClientRect(),
    });
  }, []);

  const handlePathContextMenu = useCallback((
    event: ReactMouseEvent,
    segment: BreadcrumbPathSegment,
  ) => {
    const actions = pathActionsForSegment?.(segment) ?? [];
    if (actions.length === 0 && !loadPathChildren) return;
    event.preventDefault();
    event.stopPropagation();
    const anchorEl = event.currentTarget as HTMLElement;
    void openPathPopup(segment, anchorEl);
  }, [loadPathChildren, openPathPopup, pathActionsForSegment]);

  const handleNavKeyDown = useCallback((event: ReactKeyboardEvent) => {
    if (!activeNavigationBar && navBarFocusedIndex === null) return;
    if (popup) return;

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setNavBarFocusedIndex((prev) => navigateSegments(prev ?? visibleItems.length - 1, visibleItems.length, "left"));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setNavBarFocusedIndex((prev) => navigateSegments(prev ?? 0, visibleItems.length, "right"));
    } else if (event.key === "Home") {
      event.preventDefault();
      setNavBarFocusedIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setNavBarFocusedIndex(visibleItems.length - 1);
    } else if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const currentIdx = navBarFocusedIndex ?? visibleItems.length - 1;
      const currentItem = visibleItems[currentIdx];
      if (!currentItem) return;
      const targetBtn = navRef.current?.querySelector<HTMLElement>(`[data-nav-index="${currentIdx}"]`);
      if (targetBtn) {
        if (currentItem.type === "path") void openPathPopup(currentItem.value, targetBtn);
        if (currentItem.type === "symbol") openSymbolPopup(currentItem.value, targetBtn);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      setNavBarFocusedIndex(null);
      onCloseNavigationBar?.();
    }
  }, [activeNavigationBar, navBarFocusedIndex, onCloseNavigationBar, openPathPopup, openSymbolPopup, popup, visibleItems]);

  const renderItems = (items: BreadcrumbItem[], compact: boolean, interactive: boolean) => items.map((item, index) => {
    const path = item.type === "path" ? item.value : null;
    const symbol = item.type === "symbol" ? item.value : null;
    const label = path?.label ?? symbol?.name ?? "";
    const flexible = compact && (path?.kind === "file" || !!symbol);
    const isFocused = navBarFocusedIndex === index;
    const icon = path?.kind === "root" || path?.kind === "directory" ? (
      <Folder className="h-3 w-3 shrink-0 text-[#d59d32]" />
    ) : path?.kind === "file" ? (
      <File className="h-3 w-3 shrink-0" />
    ) : item.type === "collapsed" ? (
      <MoreHorizontal className="h-3 w-3" />
    ) : (
      <Hash className="h-3 w-3 shrink-0 text-[var(--taomni-accent)]" />
    );

    if (item.type === "collapsed") {
      return (
        <span key={`collapsed:${index}`} className="inline-flex shrink-0 items-center">
          {index > 0 && <ChevronRight className="mx-0.5 h-3 w-3" />}
          {interactive ? (
            <button
              type="button"
              className={`inline-flex h-5 items-center rounded px-1 hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)] ${
                isFocused ? "ring-1 ring-[var(--taomni-accent)] bg-[var(--taomni-code-active-line-bg)]" : ""
              }`}
              aria-label="Hidden breadcrumb segments"
              id={`code-workspace-breadcrumb-segment-${index}`}
              tabIndex={activeNavigationBar ? -1 : 0}
              data-testid="code-workspace-breadcrumb-collapsed"
              data-nav-index={index}
              onClick={(event) => {
                if (item.hiddenPaths.length > 0) {
                  openCollapsedPopup(item.hiddenPaths, event.currentTarget);
                }
              }}
            >
              {icon}
            </button>
          ) : (
            <span className="inline-flex h-5 items-center rounded px-1">{icon}</span>
          )}
        </span>
      );
    }

    const content = (
      <>
        {icon}
        <span className={flexible ? "truncate" : undefined}>{label}</span>
      </>
    );

    return (
      <span
        key={`${item.type}:${label}:${index}`}
        className={`inline-flex min-w-0 items-center ${flexible ? "flex-1" : "shrink-0"}`}
      >
        {index > 0 && <ChevronRight className="mx-0.5 h-3 w-3 shrink-0" />}
        {interactive ? (
          <button
            type="button"
            className={`inline-flex h-5 min-w-0 items-center gap-1 rounded px-1 hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)] ${
              flexible ? "flex-1" : ""
            } ${isFocused ? "ring-1 ring-[var(--taomni-accent)] bg-[var(--taomni-code-active-line-bg)]" : ""}`}
            aria-haspopup="listbox"
            aria-current={index === items.length - 1 ? (path?.kind === "file" ? "page" : symbol ? "location" : undefined) : undefined}
            id={`code-workspace-breadcrumb-segment-${index}`}
            tabIndex={activeNavigationBar ? -1 : 0}
            data-nav-index={index}
            data-focused={isFocused ? "true" : undefined}
            data-testid={path
              ? `code-workspace-breadcrumb-path-${path.kind}`
              : "code-workspace-breadcrumb-symbol"}
            onClick={(event) => {
              if (path) void openPathPopup(path, event.currentTarget);
              if (symbol) openSymbolPopup(symbol, event.currentTarget);
            }}
            onContextMenu={(event) => {
              if (path) handlePathContextMenu(event, path);
            }}
          >
            {content}
          </button>
        ) : (
          <span className={`inline-flex h-5 min-w-0 items-center gap-1 rounded px-1 ${flexible ? "flex-1" : ""}`}>
            {content}
          </span>
        )}
      </span>
    );
  });

  return (
    <nav
      ref={navRef}
      tabIndex={activeNavigationBar ? 0 : -1}
      aria-activedescendant={navBarFocusedIndex === null || visibleItems.length === 0
        ? undefined
        : `code-workspace-breadcrumb-segment-${navBarFocusedIndex}`}
      onKeyDown={handleNavKeyDown}
      aria-label="Editor breadcrumbs"
      data-testid="code-workspace-breadcrumbs"
      className="relative flex h-7 shrink-0 items-center overflow-hidden border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-2 text-[11px] text-[var(--taomni-code-muted)] outline-none"
    >
      <div
        ref={fullPathMeasureRef}
        aria-hidden="true"
        className="pointer-events-none absolute invisible w-max whitespace-nowrap"
      >
        {renderItems(fullItems, false, false)}
      </div>
      <div className="flex min-w-0 flex-1 items-center overflow-hidden">
        {renderItems(visibleItems, collapsed, true)}
      </div>
      {popup && (
        <SegmentPopup
          open={popup}
          query={query}
          selectedIndex={selectedIndex}
          actions={actionsForOpen}
          onQueryChange={(value) => {
            setQuery(value);
            setSelectedIndex(0);
          }}
          onSelectedIndexChange={setSelectedIndex}
          onClose={closePopup}
          onPickPathChild={(child) => {
            if (popup.kind === "path") {
              onPathNavigate?.(child, popup.segment);
            }
            closePopup();
          }}
          onPickSymbol={(symbol) => {
            onSymbolClick?.(symbol);
            closePopup();
          }}
          onPickCollapsedSegment={(segment) => {
            // Swap the collapsed list for that intermediate segment's children menu.
            const anchor = popup.kind === "collapsed"
              ? popup.anchor
              : navRef.current?.getBoundingClientRect() ?? new DOMRect(8, 8, 0, 0);
            if (!loadPathChildren) {
              onPathClick?.(segment);
              closePopup();
              return;
            }
            const generation = ++loadGenerationRef.current;
            setQuery("");
            setSelectedIndex(0);
            setPopup({
              kind: "path",
              segment,
              anchor,
              children: [],
              loading: true,
              error: null,
            });
            void loadPathChildren(segment).then((children) => {
              if (generation !== loadGenerationRef.current) return;
              const activeIndex = Math.max(0, sortPathChildren(children).findIndex((child) => child.active));
              setSelectedIndex(activeIndex);
              setPopup({
                kind: "path",
                segment,
                anchor,
                children,
                loading: false,
                error: null,
              });
            }).catch((error) => {
              if (generation !== loadGenerationRef.current) return;
              setPopup({
                kind: "path",
                segment,
                anchor,
                children: [],
                loading: false,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }}
          onAction={(action) => {
            action.onSelect();
            closePopup();
          }}
        />
      )}
    </nav>
  );
}
