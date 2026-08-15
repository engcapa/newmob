import { useMemo, useState } from "react";
import { Keyboard, Search, Sparkles, X } from "lucide-react";
import type { WorkspaceCommand } from "./workspaceCommands";
import { DEFAULT_WORKSPACE_ACTIONS } from "./workspaceActionRegistry";

export interface KeymapCheatSheetDialogProps {
  open: boolean;
  commands: readonly WorkspaceCommand[];
  onClose: () => void;
  onExecuteCommand?: (commandId: string) => void;
}

function parseKeyParts(binding: string): string[] {
  return binding
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((p) => {
      if (p.toLowerCase() === "mod") return "Ctrl / ⌘";
      if (p.toLowerCase() === "ctrl") return "Ctrl";
      if (p.toLowerCase() === "shift") return "Shift";
      if (p.toLowerCase() === "alt") return "Alt / ⌥";
      if (p.toLowerCase() === "meta" || p.toLowerCase() === "cmd") return "⌘";
      if (p.toLowerCase() === "arrowup" || p.toLowerCase() === "up") return "↑";
      if (p.toLowerCase() === "arrowdown" || p.toLowerCase() === "down") return "↓";
      if (p.toLowerCase() === "arrowleft" || p.toLowerCase() === "left") return "←";
      if (p.toLowerCase() === "arrowright" || p.toLowerCase() === "right") return "→";
      if (p.toLowerCase() === "enter") return "Enter ↵";
      if (p.toLowerCase() === "escape" || p.toLowerCase() === "esc") return "Esc";
      return p.toUpperCase();
    });
}

export function KeymapCheatSheetDialog({
  open,
  commands,
  onClose,
  onExecuteCommand,
}: KeymapCheatSheetDialogProps) {
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("All");

  const boundCommands = useMemo(() => {
    return commands.filter((c) => !!c.keybinding || (c.keybindings && c.keybindings.length > 0));
  }, [commands]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const c of boundCommands) {
      if (c.category) set.add(c.category);
    }
    return ["All", ...Array.from(set).sort()];
  }, [boundCommands]);

  const filteredCommands = useMemo(() => {
    const q = search.trim().toLowerCase();
    return boundCommands.filter((c) => {
      if (selectedCategory !== "All" && c.category !== selectedCategory) {
        return false;
      }
      if (!q) return true;
      const matchTitle = c.title.toLowerCase().includes(q);
      const matchCategory = c.category.toLowerCase().includes(q);
      const matchId = c.id.toLowerCase().includes(q);
      const allBindings = [c.keybinding, ...(c.keybindings ?? [])].filter(Boolean).join(" ").toLowerCase();
      return matchTitle || matchCategory || matchId || allBindings.includes(q);
    });
  }, [boundCommands, search, selectedCategory]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="keymap-cheatsheet-title"
      data-testid="keymap-cheatsheet-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="flex h-[80vh] w-full max-w-4xl flex-col rounded-lg border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] shadow-2xl text-[12px] text-[var(--taomni-code-fg)]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--taomni-code-border)] px-4 py-3">
          <div className="flex items-center gap-2">
            <Keyboard className="h-5 w-5 text-sky-400" />
            <div>
              <h2 id="keymap-cheatsheet-title" className="text-[14px] font-semibold">
                Keyboard Shortcuts & Keymap
              </h2>
              <p className="text-[11px] text-[var(--taomni-code-muted)] mt-0.5">
                {boundCommands.length} shortcut keybindings configured (IntelliJ IDEA keymap layout)
              </p>
            </div>
          </div>
          <button
            type="button"
            data-testid="keymap-cheatsheet-close"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-fg)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Toolbar & Search */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-active-line-bg)]/30 px-4 py-2 text-[11px]">
          {/* Category Chips */}
          <div className="flex flex-wrap items-center gap-1.5">
            {categories.map((category) => (
              <button
                key={category}
                type="button"
                data-testid={`keymap-category-${category}`}
                onClick={() => setSelectedCategory(category)}
                className={`rounded-full px-2.5 py-0.5 transition-colors ${
                  selectedCategory === category
                    ? "bg-sky-500/20 text-sky-400 font-semibold border border-sky-500/40"
                    : "text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
                }`}
              >
                {category}
              </button>
            ))}
          </div>

          {/* Search Input */}
          <div className="relative flex items-center">
            <Search className="absolute left-2 h-3.5 w-3.5 text-[var(--taomni-code-muted)]" />
            <input
              type="text"
              data-testid="keymap-search-input"
              placeholder="Search shortcut or action..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-7 w-60 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] pl-7 pr-2 text-[11px] text-[var(--taomni-code-fg)] placeholder:text-[var(--taomni-code-muted)] focus:outline-none focus:border-sky-500"
            />
          </div>
        </div>

        {/* Table Content */}
        <div className="flex-1 min-h-0 overflow-y-auto p-3 divide-y divide-[var(--taomni-code-border)]/40">
          {filteredCommands.length === 0 ? (
            <div className="p-8 text-center text-[var(--taomni-code-muted)]">
              No keyboard shortcuts found matching &quot;{search}&quot;
            </div>
          ) : (
            filteredCommands.map((command) => {
              const bindings = [command.keybinding, ...(command.keybindings ?? [])].filter(
                Boolean,
              ) as string[];

              const meta = DEFAULT_WORKSPACE_ACTIONS.find((a) => a.id === command.id);
              const provenance = meta?.provenance;

              return (
                <div
                  key={command.id}
                  data-testid={`keymap-item-${command.id}`}
                  className="group flex items-center justify-between py-2 px-2 rounded hover:bg-[var(--taomni-code-active-line-bg)]/50 transition-colors"
                >
                  <div className="flex items-center gap-2 min-w-0 pr-4">
                    <span className="rounded bg-[var(--taomni-code-active-line-bg)] px-1.5 py-0.5 text-[10px] text-[var(--taomni-code-muted)] shrink-0 font-medium">
                      {command.category}
                    </span>
                    {provenance && (
                      <span
                        className={`rounded px-1.5 py-0.5 text-[9px] font-medium shrink-0 ${
                          provenance === "local"
                            ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                            : provenance === "provider"
                              ? "bg-sky-500/10 text-sky-400 border border-sky-500/20"
                              : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                        }`}
                      >
                        {provenance === "local" ? "Local" : provenance === "provider" ? "LSP" : "Partial"}
                      </span>
                    )}
                    <div className="min-w-0 truncate">
                      <span className="font-medium text-[12px]">{command.title}</span>
                      <span className="ml-2 font-mono text-[10px] text-[var(--taomni-code-muted)] opacity-60">
                        {command.id}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <div className="flex items-center gap-1.5">
                      {bindings.map((b, idx) => {
                        const parts = parseKeyParts(b);
                        return (
                          <div key={idx} className="flex items-center gap-1">
                            {parts.map((p, pIdx) => (
                              <kbd
                                key={pIdx}
                                className="rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-active-line-bg)] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[var(--taomni-code-fg)] shadow-sm"
                              >
                                {p}
                              </kbd>
                            ))}
                            {idx < bindings.length - 1 && (
                              <span className="text-[10px] text-[var(--taomni-code-muted)] mx-0.5">or</span>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {onExecuteCommand && (
                      <button
                        type="button"
                        data-testid={`keymap-run-${command.id}`}
                        onClick={() => {
                          onClose();
                          onExecuteCommand(command.id);
                        }}
                        className="opacity-0 group-hover:opacity-100 rounded px-2 py-0.5 text-[10px] font-medium bg-sky-500/10 text-sky-400 hover:bg-sky-500/20 transition-opacity"
                      >
                        Run
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-[var(--taomni-code-border)] bg-[var(--taomni-code-active-line-bg)]/20 px-4 py-2.5 text-[11px] text-[var(--taomni-code-muted)]">
          <div className="flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-amber-400" />
            <span>Standard IntelliJ IDEA shortcut mappings with multi-platform parity</span>
          </div>
          <button
            type="button"
            data-testid="keymap-cheatsheet-footer-close"
            onClick={onClose}
            className="rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-3 py-1 text-[var(--taomni-code-fg)] hover:bg-[var(--taomni-code-active-line-bg)]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
