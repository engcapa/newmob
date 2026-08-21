import { forwardRef, useCallback, useLayoutEffect, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";

export interface MenuItem {
  label: string;
  testId?: string;
  icon?: React.ReactNode;
  shortcut?: string;
  checked?: boolean;
  onClick?: () => void;
  danger?: boolean;
  separator?: boolean;
  disabled?: boolean;
  children?: MenuItem[];
  openOnClick?: boolean;
  customPanel?: React.ReactNode;
}

interface ContextMenuProps {
  items: MenuItem[];
  x: number;
  y: number;
  onClose: () => void;
}

const MENU_MARGIN = 6;

export function ContextMenu({ items, x, y, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const maxLeft = Math.max(MENU_MARGIN, window.innerWidth - rect.width - MENU_MARGIN);
    const maxTop = Math.max(MENU_MARGIN, window.innerHeight - rect.height - MENU_MARGIN);

    setPosition({
      left: Math.min(Math.max(MENU_MARGIN, x), maxLeft),
      top: Math.min(Math.max(MENU_MARGIN, y), maxTop),
    });
  }, [x, y, items]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      // Submenus and custom panels render in a portal outside `ref`, so test
      // against the shared marker attribute instead of DOM containment.
      if (!target || !target.closest("[data-taomni-context-menu]")) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  const style: CSSProperties = {
    position: "fixed",
    left: position.left,
    top: position.top,
    zIndex: 9999,
  };

  return <MenuSurface ref={ref} items={items} onClose={onClose} style={style} />;
}

export const MenuSurface = forwardRef<HTMLDivElement, {
  items: MenuItem[];
  onClose: () => void;
  style?: CSSProperties;
  isSubmenu?: boolean;
  onBack?: () => void;
}>(({ items, onClose, style, isSubmenu, onBack }, forwardedRef) => {
  const innerRef = useRef<HTMLDivElement | null>(null);

  const selectableIndices = useMemo(() => {
    return items
      .map((item, idx) => (!item.separator && !item.disabled ? idx : -1))
      .filter((idx) => idx !== -1);
  }, [items]);

  const [activeIndex, setActiveIndex] = useState<number>(() => selectableIndices[0] ?? -1);
  const [openSubmenuIndex, setOpenSubmenuIndex] = useState<number | null>(null);

  useEffect(() => {
    if (selectableIndices.length > 0 && !selectableIndices.includes(activeIndex)) {
      setActiveIndex(selectableIndices[0] ?? -1);
    }
  }, [items, selectableIndices, activeIndex]);

  const setRef = useCallback((node: HTMLDivElement | null) => {
    innerRef.current = node;
    if (typeof forwardedRef === "function") forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  }, [forwardedRef]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // If a submenu is currently open, let the child submenu handle the key event
      if (openSubmenuIndex !== null) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        if (selectableIndices.length === 0) return;
        const currentPos = selectableIndices.indexOf(activeIndex);
        const nextPos = currentPos === -1 || currentPos === selectableIndices.length - 1 ? 0 : currentPos + 1;
        setActiveIndex(selectableIndices[nextPos]!);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        if (selectableIndices.length === 0) return;
        const currentPos = selectableIndices.indexOf(activeIndex);
        const prevPos = currentPos <= 0 ? selectableIndices.length - 1 : currentPos - 1;
        setActiveIndex(selectableIndices[prevPos]!);
      } else if (e.key === "Home") {
        e.preventDefault();
        e.stopPropagation();
        if (selectableIndices.length > 0) setActiveIndex(selectableIndices[0]!);
      } else if (e.key === "End") {
        e.preventDefault();
        e.stopPropagation();
        if (selectableIndices.length > 0) setActiveIndex(selectableIndices[selectableIndices.length - 1]!);
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        if (activeIndex !== -1 && items[activeIndex]) {
          const item = items[activeIndex]!;
          if (item.children?.length || item.customPanel) {
            setOpenSubmenuIndex(activeIndex);
          } else if (item.onClick) {
            item.onClick();
            onClose();
          }
        }
      } else if (e.key === "ArrowRight") {
        if (activeIndex !== -1 && items[activeIndex]) {
          const item = items[activeIndex]!;
          if (item.children?.length || item.customPanel) {
            e.preventDefault();
            e.stopPropagation();
            setOpenSubmenuIndex(activeIndex);
          }
        }
      } else if (e.key === "ArrowLeft") {
        if (isSubmenu && onBack) {
          e.preventDefault();
          e.stopPropagation();
          onBack();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (isSubmenu && onBack) {
          onBack();
        } else {
          onClose();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [activeIndex, isSubmenu, items, onBack, onClose, openSubmenuIndex, selectableIndices]);

  return (
    <div
      ref={setRef}
      data-testid="context-menu"
      data-taomni-context-menu=""
      className="min-w-[220px] py-1 rounded shadow-lg border text-[12px] outline-none"
      style={{
        background: "var(--taomni-panel-bg)",
        borderColor: "var(--taomni-divider)",
        color: "var(--taomni-text)",
        ...style,
        maxHeight: "calc(100vh - 12px)",
        overflowY: "auto",
      }}
    >
      {items.map((item, i) => (
        <MenuRow
          key={i}
          item={item}
          active={activeIndex === i}
          isSubmenuOpen={openSubmenuIndex === i}
          onHover={() => setActiveIndex(i)}
          onOpenSubmenu={() => setOpenSubmenuIndex(i)}
          onCloseSubmenu={() => setOpenSubmenuIndex(null)}
          onClose={onClose}
        />
      ))}
    </div>
  );
});

MenuSurface.displayName = "MenuSurface";

function PortalFlyout({
  triggerRef,
  onMouseEnter,
  onMouseLeave,
  children,
}: {
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const el = ref.current;
    if (!trigger || !el) return;
    const tRect = trigger.getBoundingClientRect();
    const rect = el.getBoundingClientRect();

    // Prefer opening to the right of the trigger; flip left if it overflows.
    let left = tRect.right - 1;
    if (left + rect.width > window.innerWidth - MENU_MARGIN) {
      left = tRect.left - rect.width + 1;
    }
    left = Math.max(MENU_MARGIN, Math.min(left, window.innerWidth - rect.width - MENU_MARGIN));

    // Align to the trigger top; shift up if it would overflow the bottom.
    let top = tRect.top - 4;
    if (top + rect.height > window.innerHeight - MENU_MARGIN) {
      top = window.innerHeight - rect.height - MENU_MARGIN;
    }
    top = Math.max(MENU_MARGIN, top);

    setPos({ left, top });
  }, [triggerRef, children]);

  return createPortal(
    <div
      ref={ref}
      data-taomni-context-menu=""
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        position: "fixed",
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        visibility: pos ? "visible" : "hidden",
        zIndex: 9999,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

function MenuRow({
  item,
  active,
  isSubmenuOpen,
  onHover,
  onOpenSubmenu,
  onCloseSubmenu,
  onClose,
}: {
  item: MenuItem;
  active: boolean;
  isSubmenuOpen: boolean;
  onHover: () => void;
  onOpenSubmenu: () => void;
  onCloseSubmenu: () => void;
  onClose: () => void;
}) {
  const [openByHover, setOpenByHover] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<number | null>(null);

  const open = isSubmenuOpen || openByHover;

  useEffect(
    () => () => {
      if (closeTimer.current != null) clearTimeout(closeTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (active && triggerRef.current) {
      triggerRef.current.scrollIntoView?.({ block: "nearest" });
    }
  }, [active]);

  if (item.separator) {
    return <div className="h-px mx-2 my-1" style={{ background: "var(--taomni-divider)" }} />;
  }

  const hasChildren = !!item.children?.length || !!item.customPanel;
  const content = (
    <>
      <span className="w-4 flex-shrink-0 text-center">{item.checked ? "✓" : item.icon}</span>
      <span className="flex-1 truncate">{item.label}</span>
      {item.shortcut && (
        <span className="ml-6 flex-shrink-0 text-[11px] text-[var(--taomni-text-muted)]">{item.shortcut}</span>
      )}
      {hasChildren && <ChevronRight className="w-3 h-3 text-[var(--taomni-text-muted)]" />}
    </>
  );

  if (hasChildren) {
    const cancelClose = () => {
      if (closeTimer.current != null) {
        clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
    };
    const scheduleClose = () => {
      cancelClose();
      closeTimer.current = window.setTimeout(() => {
        setOpenByHover(false);
        onCloseSubmenu();
      }, 120);
    };
    const openNow = () => {
      cancelClose();
      setOpenByHover(true);
      onHover();
      onOpenSubmenu();
    };

    return (
      <div
        className="relative group/menu-row"
        onMouseEnter={item.openOnClick ? () => { cancelClose(); onHover(); } : openNow}
        onMouseLeave={scheduleClose}
      >
        <button
          ref={triggerRef}
          data-testid={item.testId ?? `context-menu-item-${slugForTestId(item.label)}`}
          data-active={active ? "true" : undefined}
          className="w-full px-3 py-1 text-left flex items-center gap-2 hover:bg-[var(--taomni-hover)] data-[active=true]:bg-[var(--taomni-hover)] disabled:opacity-40 outline-none"
          style={item.danger ? { color: "#b22222" } : undefined}
          disabled={item.disabled}
          onClick={item.openOnClick ? () => {
            if (open) {
              setOpenByHover(false);
              onCloseSubmenu();
            } else {
              setOpenByHover(true);
              onOpenSubmenu();
            }
          } : undefined}
          type="button"
        >
          {content}
        </button>
        {!item.disabled && open && (
          <PortalFlyout triggerRef={triggerRef} onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>
            {item.customPanel ? item.customPanel : (
              <MenuSurface
                isSubmenu
                items={item.children ?? []}
                onClose={onClose}
                onBack={() => {
                  setOpenByHover(false);
                  onCloseSubmenu();
                }}
              />
            )}
          </PortalFlyout>
        )}
      </div>
    );
  }

  return (
    <button
      ref={triggerRef}
      data-testid={item.testId ?? `context-menu-item-${slugForTestId(item.label)}`}
      data-active={active ? "true" : undefined}
      className="w-full px-3 py-1 text-left flex items-center gap-2 hover:bg-[var(--taomni-hover)] data-[active=true]:bg-[var(--taomni-hover)] disabled:opacity-40 outline-none"
      style={item.danger ? { color: "#b22222" } : undefined}
      onMouseEnter={onHover}
      onClick={() => {
        item.onClick?.();
        onClose();
      }}
      disabled={item.disabled}
      type="button"
    >
      {content}
    </button>
  );
}

export function useContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  const show = useCallback((e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  }, []);
  const showAt = useCallback((x: number, y: number, items: MenuItem[]) => {
    setMenu({ x, y, items });
  }, []);
  const refreshItems = useCallback((items: MenuItem[]) => {
    setMenu((current) => current ? { ...current, items } : current);
  }, []);

  const close = useCallback(() => setMenu(null), []);

  return useMemo(() => ({
    show,
    showAt,
    refreshItems,
    close,
    render: menu ? (
      <ContextMenu items={menu.items} x={menu.x} y={menu.y} onClose={close} />
    ) : null,
    isOpen: menu !== null,
  }), [close, menu, refreshItems, show, showAt]);
}

function slugForTestId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}
