import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type {
  DebugDataBreakpoint,
  DebugExceptionBreakMode,
} from "../../dapDebugModel";

/** One expandable variables node (D4) — children fetched lazily on expand. */
export interface VarNode {
  name: string;
  value: string;
  type: string | null;
  variablesReference: number;
  /** `variablesReference` of the container (scope/object) this node lives in. */
  parentRef: number;
  /** Watch roots are expressions; scope roots are not valid data targets. */
  dataBreakpointExpression: boolean;
  children: VarNode[] | null; // null = not yet loaded
  expanded: boolean;
  /** True when variable value changed across debugger stop epochs (D2) */
  hasChanged?: boolean;
}

export function variableDataBreakpointTargetKey(node: VarNode): string {
  return `${node.parentRef}:${node.dataBreakpointExpression ? "expression" : "variable"}:${node.name}`;
}

export function parseVariables(body: unknown, parentRef: number): VarNode[] {
  const list = body && typeof body === "object" ? (body as { variables?: unknown }).variables : null;
  if (!Array.isArray(list)) return [];
  return list.flatMap((v) => {
    const rec = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    if (typeof rec.name !== "string") return [];
    return [{
      name: rec.name,
      value: typeof rec.value === "string" ? rec.value : "",
      type: typeof rec.type === "string" ? rec.type : null,
      variablesReference: typeof rec.variablesReference === "number" ? rec.variablesReference : 0,
      parentRef,
      dataBreakpointExpression: false,
      children: null,
      expanded: false,
    }];
  });
}

/** Immutable tree update: replace `target` (by identity) via `update`. */
export function updateNode(nodes: VarNode[], target: VarNode, update: (n: VarNode) => VarNode): VarNode[] {
  return nodes.map((n) => {
    if (n === target) return update(n);
    return n.children ? { ...n, children: updateNode(n.children, target, update) } : n;
  });
}

export interface VarEditState {
  node: VarNode | null;
  value: string;
}

export function configurationSourceLabel(
  source: "provider" | "shared" | "local" | undefined,
): string {
  switch (source) {
    case "shared":
      return "Shared";
    case "local":
      return "Local";
    case "provider":
      return "Provider";
    default:
      return "Detected";
  }
}

export function configurationAvailabilityLabel(available: boolean | undefined): string {
  return available === false ? " [Unavailable]" : "";
}

export function consoleLineClass(category: string): string {
  switch (category) {
    case "stderr":
    case "error":
      return "text-rose-500 dark:text-rose-400";
    case "repl":
      return "text-sky-600 dark:text-sky-400";
    case "console":
    case "important":
      return "text-[var(--taomni-text-muted)] italic";
    default:
      return "text-[var(--taomni-text)]";
  }
}

export function parseSignedMemoryOffset(value: string): number | undefined | null {
  const raw = value.trim();
  if (!raw) return undefined;
  if (!/^[+-]?\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parsePositiveMemoryCount(value: string, max: number): number | null {
  const raw = value.trim();
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= max ? parsed : null;
}

export function dataAccessTypeLabel(accessType: NonNullable<DebugDataBreakpoint["accessType"]>): string {
  switch (accessType) {
    case "read": return "Read";
    case "write": return "Write";
    case "readWrite": return "Read/write";
  }
}

export const EXCEPTION_BREAK_MODES: Array<{ value: DebugExceptionBreakMode; label: string }> = [
  { value: "always", label: "Caught and uncaught" },
  { value: "unhandled", label: "Uncaught" },
  { value: "userUnhandled", label: "Unhandled in user code" },
  { value: "never", label: "Never" },
];

export function parseExceptionPathNames(value: string): string[] {
  return Array.from(new Set(value.split(",").map((name) => name.trim()).filter(Boolean)));
}

export function Section({
  title,
  defaultOpen = true,
  forceOpen = false,
  actions,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  /** Keep the section expanded regardless of the user's toggle (e.g. editing). */
  forceOpen?: boolean;
  /** Header-right controls (mute / clear …); they do not toggle the section. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const open = expanded || forceOpen;
  // Toggling starts from the *visible* state, so collapsing a force-opened
  // section works on the first click.
  const setOpen = (next: boolean | ((v: boolean) => boolean)) => {
    setExpanded(typeof next === "function" ? next(open) : next);
  };
  return (
    <div className="border-b border-[var(--taomni-code-border)]">
      <div className="flex items-center pr-2">
        <button
          type="button"
          className="min-w-0 flex-1 flex items-center gap-1 px-2 py-1 text-left font-medium text-[var(--taomni-text-muted)]"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {title}
        </button>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
      {open && <div className="pb-1">{children}</div>}
    </div>
  );
}

export function SectionAction({
  testId,
  label,
  active = false,
  onClick,
  children,
}: {
  testId: string;
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`inline-flex h-5 w-5 items-center justify-center rounded ${
        active ? "text-amber-500" : "text-[var(--taomni-text-muted)]"
      } hover:bg-[var(--taomni-hover-bg)]`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function Empty({ text }: { text: string }) {
  return <div className="px-3 py-1 text-[var(--taomni-text-muted)]">{text}</div>;
}

/** react-resizable-panels v4 layout map: panel id -> flexGrow value. */
export type DebugSplitLayout = Record<string, number>;

/** Read a persisted split layout; returns undefined on any inconsistency. */
export function readDebugSplitLayout(storageKey: string, panelIds: string[]): DebugSplitLayout | undefined {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const rec = parsed as Record<string, unknown>;
    const layout: DebugSplitLayout = {};
    for (const id of panelIds) {
      const value = rec[id];
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
      layout[id] = value;
    }
    return layout;
  } catch {
    return undefined;
  }
}

export function writeDebugSplitLayout(storageKey: string, layout: DebugSplitLayout): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(layout));
  } catch {
    // Ignore storage failures.
  }
}

/** Text field that reports its value on Enter or blur, not per keystroke. */
export function CommitField({
  label,
  testId,
  className,
  placeholder,
  maxLength,
  initialValue,
  onCommit,
}: {
  label: string;
  testId: string;
  className: string;
  placeholder: string;
  maxLength?: number;
  initialValue: string;
  onCommit: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <label className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[var(--taomni-text-muted)]">{label}</span>
      <input
        data-testid={testId}
        className={className}
        placeholder={placeholder}
        maxLength={maxLength}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => { if (value !== initialValue) onCommit(value); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit(value);
          else if (e.key === "Escape") setValue(initialValue);
        }}
      />
    </label>
  );
}
