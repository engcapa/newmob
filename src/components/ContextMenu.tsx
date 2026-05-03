import { forwardRef, useLayoutEffect, useEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronRight } from "lucide-react";

export interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  shortcut?: string;
  checked?: boolean;
  onClick?: () => void;
  danger?: boolean;
  separator?: boolean;
  disabled?: boolean;
  children?: MenuItem[];
}

interface ContextMenuProps {
  items: MenuItem[];
  x: number;
  y: number;
  onClose: () => void;
}

export function ContextMenu({ items, x, y, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const margin = 6;
    const rect = el.getBoundingClientRect();
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);

    setPosition({
      left: Math.min(Math.max(margin, x), maxLeft),
      top: Math.min(Math.max(margin, y), maxTop),
    });
  }, [x, y, items]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [onClose]);

  const style: CSSProperties = {
    position: "fixed",
    left: position.left,
    top: position.top,
    zIndex: 9999,
    maxHeight: "calc(100vh - 12px)",
    overflow: "visible",
  };

  return (
    <MenuSurface ref={ref} items={items} onClose={onClose} style={style} />
  );
}

const MenuSurface = forwardRef<HTMLDivElement, {
  items: MenuItem[];
  onClose: () => void;
  style?: CSSProperties;
}>(({ items, onClose, style }, ref) => (
  <div
    ref={ref}
    data-testid="context-menu"
    className="min-w-[220px] py-1 rounded shadow-lg border text-[12px]"
    style={{ ...style, background: "var(--moba-panel-bg)", borderColor: "var(--moba-divider)", color: "var(--moba-text)" }}
  >
    {items.map((item, i) => (
      <MenuRow key={i} item={item} onClose={onClose} />
    ))}
  </div>
));

MenuSurface.displayName = "MenuSurface";

function MenuRow({ item, onClose }: { item: MenuItem; onClose: () => void }) {
  if (item.separator) {
    return <div className="h-px mx-2 my-1" style={{ background: "var(--moba-divider)" }} />;
  }

  const hasChildren = !!item.children?.length;
  const content = (
    <>
      <span className="w-4 flex-shrink-0 text-center">{item.checked ? "✓" : item.icon}</span>
      <span className="flex-1 truncate">{item.label}</span>
      {item.shortcut && (
        <span className="ml-6 flex-shrink-0 text-[11px] text-[var(--moba-text-muted)]">{item.shortcut}</span>
      )}
      {hasChildren && <ChevronRight className="w-3 h-3 text-[var(--moba-text-muted)]" />}
    </>
  );

  if (hasChildren) {
    return (
      <div className="relative group/menu-row">
        <button
          data-testid={`context-menu-item-${slugForTestId(item.label)}`}
          className="w-full px-3 py-1 text-left flex items-center gap-2 hover:bg-[var(--moba-hover)] disabled:opacity-40"
          style={item.danger ? { color: "#b22222" } : undefined}
          disabled={item.disabled}
          type="button"
        >
          {content}
        </button>
        {!item.disabled && (
          <div className="hidden group-hover/menu-row:block absolute left-full top-[-4px] pl-1">
            <MenuSurface items={item.children ?? []} onClose={onClose} />
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      data-testid={`context-menu-item-${slugForTestId(item.label)}`}
      className="w-full px-3 py-1 text-left flex items-center gap-2 hover:bg-[var(--moba-hover)] disabled:opacity-40"
      style={item.danger ? { color: "#b22222" } : undefined}
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

  const show = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const close = () => setMenu(null);

  const render = menu ? (
    <ContextMenu items={menu.items} x={menu.x} y={menu.y} onClose={close} />
  ) : null;

  return { show, close, render };
}

function slugForTestId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}
