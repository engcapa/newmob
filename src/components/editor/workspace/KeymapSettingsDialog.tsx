import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { ActionSnapshotItem } from "./workspaceActionHost";
import {
  createKeymapScheme,
  setActionBindings,
  setActionDisabled,
  strokeFromKeyboardEvent,
  isReservedStroke,
  type KeymapBaseSchemeId,
  type KeymapSchemeV3,
  type Shortcut,
} from "./workspaceKeymapScheme";
import { disabledReasonLabel } from "./workspaceCodeMirrorKeymap";

interface KeymapSettingsDialogProps {
  open: boolean;
  /** Instance-scoped snapshot: rows and their effective state (§8.18.2). */
  snapshot: readonly ActionSnapshotItem[];
  schemes: readonly KeymapSchemeV3[];
  activeSchemeId: string | null;
  defaultSchemeName: string;
  corruptDiagnostic?: string | null;
  onActiveSchemeChange: (schemeId: string | null) => void;
  onSchemesChange: (schemes: readonly KeymapSchemeV3[]) => void;
  /** Persist + apply one scheme mutation to the live host. */
  onApplyScheme: (scheme: KeymapSchemeV3) => void;
  onClose: () => void;
}

type CaptureTarget = { actionId: string; replaceIndex: number | null };

/**
 * IDEA-like Keymap settings surface (§8.18.2): scheme copy/rename/reset/
 * delete, action search, per-action shortcut swatches with add (keystroke
 * recording) / remove / enable-disable, conflict badges and reserved-key
 * warnings. The Cheat Sheet stays the read-only projection of the same data.
 */
export function KeymapSettingsDialog({
  open,
  snapshot,
  schemes,
  activeSchemeId,
  defaultSchemeName,
  corruptDiagnostic,
  onActiveSchemeChange,
  onSchemesChange,
  onApplyScheme,
  onClose,
}: KeymapSettingsDialogProps) {
  const [filter, setFilter] = useState("");
  const [capture, setCapture] = useState<CaptureTarget | null>(null);
  const captureRef = useRef<CaptureTarget | null>(null);
  captureRef.current = capture;

  const activeScheme = schemes.find((scheme) => scheme.id === activeSchemeId) ?? null;

  const effectiveForAction = useMemo(() => {
    const map = new Map<string, { shortcuts: readonly Shortcut[]; disabled: boolean; conflictsWith: string[] }>();
    const byStroke = new Map<string, string[]>();
    for (const item of snapshot) {
      for (const binding of item.keybindings ?? []) {
        const list = byStroke.get(binding) ?? [];
        list.push(item.id);
        byStroke.set(binding, list);
      }
    }
    for (const item of snapshot) {
      const conflicts = new Set<string>();
      for (const binding of item.keybindings ?? []) {
        for (const other of byStroke.get(binding) ?? []) {
          if (other !== item.id) conflicts.add(other);
        }
      }
      map.set(item.id, {
        shortcuts: parseDisplayBindings(item),
        disabled: item.state.disabledReason === "userDisabled",
        conflictsWith: [...conflicts],
      });
    }
    return map;
  }, [snapshot]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      const target = captureRef.current;
      if (!target) {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
        return;
      }
      // Keystroke recording: first key press after "Add" becomes the binding.
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setCapture(null);
        return;
      }
      if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return;
      if (isReservedStroke(strokeFromKeyboardEvent(event))) return;
      const scheme = ensureMutableScheme();
      if (!scheme) return;
      const shortcut: Shortcut = {
        kind: "keyboard",
        strokes: [strokeFromKeyboardEvent(event)],
      };
      const current = [...(scheme.bindings[target.actionId] ?? [])];
      let next: typeof current;
      if (target.replaceIndex !== null) {
        next = current.map((binding, index) => (index === target.replaceIndex ? shortcut : binding));
      } else {
        next = [...current, shortcut];
      }
      onApplyScheme(setActionBindings(scheme, target.actionId, next));
      setCapture(null);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, schemes]);

  function ensureMutableScheme(): KeymapSchemeV3 | null {
    if (activeScheme && !activeScheme.readOnly) return activeScheme;
    // Implicitly fork a user scheme from the defaults on first edit.
    const forked = createKeymapScheme({
      id: `keymap-user-${Date.now().toString(36)}`,
      name: `${activeScheme?.name ?? defaultSchemeName} (copy)`,
      base: (activeScheme?.base ?? guessBase()) as KeymapBaseSchemeId,
    });
    onSchemesChange([...schemes, forked]);
    onActiveSchemeChange(forked.id);
    return forked;
  }

  const filteredActions = snapshot.filter((item) =>
    !filter.trim()
    || item.title.toLowerCase().includes(filter.trim().toLowerCase())
    || item.id.toLowerCase().includes(filter.trim().toLowerCase())
    || (item.category ?? "").toLowerCase().includes(filter.trim().toLowerCase()));

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[900] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Workspace keymap settings"
        data-testid="workspace-keymap-settings-dialog"
        className="flex max-h-[80vh] w-[720px] max-w-[calc(100vw-32px)] flex-col rounded-md border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--taomni-code-border)] px-3">
          <span className="font-medium">Keymap</span>
          <select
            aria-label="Keymap scheme"
            data-testid="keymap-scheme-select"
            className="ml-auto rounded border border-[var(--taomni-code-border)] bg-transparent px-1 py-0.5 text-xs"
            value={activeSchemeId ?? ""}
            onChange={(event) => onActiveSchemeChange(event.target.value || null)}
          >
            <option value="">{defaultSchemeName} (default)</option>
            {schemes.map((scheme) => (
              <option key={scheme.id} value={scheme.id}>{scheme.name}</option>
            ))}
          </select>
          <button
            type="button"
            className="rounded px-2 py-0.5 text-xs hover:bg-[var(--taomni-code-hover)]"
            onClick={() => {
              const source = activeScheme;
              const copy = createKeymapScheme({
                id: `keymap-copy-${Date.now().toString(36)}`,
                name: `${source?.name ?? defaultSchemeName} copy`,
                base: (source?.base ?? guessBase()) as KeymapBaseSchemeId,
              });
              if (source) {
                copy.bindings = { ...source.bindings };
                copy.disabledActionIds = [...source.disabledActionIds];
              }
              onSchemesChange([...schemes, copy]);
              onActiveSchemeChange(copy.id);
            }}
          >
            Copy
          </button>
          <button
            type="button"
            className="rounded px-2 py-0.5 text-xs hover:bg-[var(--taomni-code-hover)] disabled:opacity-40"
            disabled={!activeScheme || activeScheme.readOnly}
            onClick={() => {
              if (!activeScheme) return;
              const name = window.prompt("Scheme name", activeScheme.name);
              if (!name) return;
              const renamed = { ...activeScheme, name, updatedAt: Date.now() };
              onSchemesChange(schemes.map((scheme) => (scheme.id === renamed.id ? renamed : scheme)));
            }}
          >
            Rename
          </button>
          <button
            type="button"
            className="rounded px-2 py-0.5 text-xs hover:bg-[var(--taomni-code-hover)] disabled:opacity-40"
            disabled={!activeScheme}
            onClick={() => {
              if (!activeScheme) return;
              // Reset = restore built-in defaults: drop user delta bindings.
              onApplyScheme({ ...activeScheme, bindings: {}, disabledActionIds: [], updatedAt: Date.now() });
            }}
          >
            Reset
          </button>
          <button
            type="button"
            className="rounded px-2 py-0.5 text-xs hover:bg-[var(--taomni-code-hover)] disabled:opacity-40"
            disabled={!activeScheme || activeScheme.readOnly}
            onClick={() => {
              if (!activeScheme) return;
              const remaining = schemes.filter((scheme) => scheme.id !== activeScheme.id);
              onSchemesChange(remaining);
              onActiveSchemeChange(null);
            }}
          >
            Delete
          </button>
          <button
            type="button"
            aria-label="Close keymap settings"
            data-testid="keymap-settings-close"
            className="ml-1 rounded p-1 hover:bg-[var(--taomni-code-hover)]"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>

        {(corruptDiagnostic || activeScheme?.readOnly) && (
          <div className="shrink-0 border-b border-[var(--taomni-code-border)] px-3 py-1.5 text-xs text-amber-500" role="status">
            {corruptDiagnostic
              ? "Stored keymap was corrupted; a backup was kept and defaults are active."
              : "This scheme is read-only."}
          </div>
        )}

        <div className="shrink-0 px-3 pt-2">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Find actions by name…"
            aria-label="Find actions"
            data-testid="keymap-action-filter"
            className="w-full rounded border border-[var(--taomni-code-border)] bg-transparent px-2 py-1 text-sm outline-none focus:border-[var(--taomni-code-accent, #4b9edd)]"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2" role="list" aria-label="Keymap actions">
          {filteredActions.map((item) => {
            const info = effectiveForAction.get(item.id);
            const mutable = !!activeScheme && !activeScheme.readOnly;
            const capturing = capture?.actionId === item.id;
            return (
              <div
                key={item.id}
                role="listitem"
                data-testid={`keymap-row-${item.id}`}
                className="flex items-center gap-2 border-b border-[var(--taomni-code-border)] py-1.5 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{item.title}</div>
                  <div className="truncate text-[11px] opacity-60">
                    {item.category} · {item.id}
                    {item.state.availability !== "available" && !info?.disabled
                      ? ` · ${disabledReasonLabel(item.state.disabledReason) ?? "Unavailable here"}`
                      : ""}
                    {info?.disabled ? " · Disabled in Keymap" : ""}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {(item.keybindings ?? []).length === 0 && (
                    <span className="text-[11px] opacity-50">no shortcut</span>
                  )}
                  {(item.keybindings ?? []).map((binding, index) => (
                    <span
                      key={`${item.id}-${binding}-${index}`}
                      className="inline-flex items-center gap-1 rounded border border-[var(--taomni-code-border)] px-1.5 py-0.5 font-mono text-[11px]"
                      title={info?.conflictsWith.length
                        ? `Also used by: ${info.conflictsWith.join(", ")}`
                        : undefined}
                    >
                      {binding}
                      {info?.conflictsWith.length ? (
                        <span aria-label="conflict" className="text-amber-500">⚠</span>
                      ) : null}
                      {mutable && (
                        <button
                          type="button"
                          aria-label={`Remove shortcut ${binding} from ${item.title}`}
                          className="opacity-60 hover:opacity-100"
                          onClick={() => {
                            const scheme = ensureMutableScheme();
                            if (!scheme) return;
                            const parsed = parseDisplayBindings(item);
                            const next = parsed.filter((_, i) => i !== index);
                            onApplyScheme(setActionBindings(scheme, item.id, next));
                          }}
                        >
                          ×
                        </button>
                      )}
                    </span>
                  ))}
                  {mutable && (
                    <button
                      type="button"
                      data-testid={`keymap-add-${item.id}`}
                      aria-label={capturing ? `Recording shortcut for ${item.title}` : `Add shortcut to ${item.title}`}
                      className="rounded border border-[var(--taomni-code-border)] px-1.5 py-0.5 text-[11px] hover:bg-[var(--taomni-code-hover)]"
                      onClick={() => setCapture({ actionId: item.id, replaceIndex: null })}
                    >
                      {capturing ? "press keys… (Esc cancels)" : "+ Add"}
                    </button>
                  )}
                  <label className="ml-1 flex items-center gap-1 text-[11px]">
                    <input
                      type="checkbox"
                      aria-label={`Action ${item.title} enabled`}
                      checked={!info?.disabled}
                      disabled={!mutable}
                      onChange={(event) => {
                        const scheme = ensureMutableScheme();
                        if (!scheme) return;
                        onApplyScheme(setActionDisabled(scheme, item.id, !event.target.checked));
                      }}
                    />
                    on
                  </label>
                </div>
              </div>
            );
          })}
          {filteredActions.length === 0 && (
            <div className="py-6 text-center text-xs opacity-60">No matching actions.</div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Snapshot display strings back into Shortcut values for delta editing. */
function parseDisplayBindings(item: ActionSnapshotItem): readonly Shortcut[] {
  const out: Shortcut[] = [];
  for (const binding of item.keybindings ?? []) {
    const parts = binding.split(" ");
    const strokes = parts.map((part) => {
      const segments = part.split("+").map((segment) => segment.trim()).filter(Boolean);
      const key = segments[segments.length - 1] ?? "";
      const modifiers = new Set(segments.slice(0, -1).map((segment) => segment.toLowerCase()));
      return {
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        key,
        ctrl: modifiers.has("ctrl"),
        alt: modifiers.has("alt"),
        shift: modifiers.has("shift"),
        meta: modifiers.has("meta"),
      };
    });
    out.push({ kind: "keyboard", strokes: strokes as [typeof strokes[number]] });
  }
  return out;
}

function guessBase(): KeymapBaseSchemeId {
  return navigator.platform.toLowerCase().includes("mac") ? "idea-macos" : "idea-windows-linux";
}
