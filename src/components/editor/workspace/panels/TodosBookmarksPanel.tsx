import { Bookmark, ListTodo } from "lucide-react";
import type { WorkspaceBookmark, WorkspaceTodoItem } from "../todoBookmarks";

interface TodosBookmarksPanelProps {
  todos: WorkspaceTodoItem[];
  bookmarks: WorkspaceBookmark[];
  onOpenTodo: (item: WorkspaceTodoItem) => void;
  onOpenBookmark: (item: WorkspaceBookmark) => void;
  onRemoveBookmark: (id: string) => void;
}

export function TodosBookmarksPanel({
  todos,
  bookmarks,
  onOpenTodo,
  onOpenBookmark,
  onRemoveBookmark,
}: TodosBookmarksPanelProps) {
  return (
    <div data-testid="code-workspace-todos-panel" className="h-full min-h-0 overflow-auto text-[11px]">
      <section className="border-b border-[var(--taomni-code-border)]">
        <header className="flex h-8 items-center gap-1.5 px-2 text-[var(--taomni-code-muted)]">
          <ListTodo className="h-3.5 w-3.5" />
          <span className="font-semibold text-[var(--taomni-code-text)]">TODOs in open files</span>
          <span className="ml-auto tabular-nums">{todos.length}</span>
        </header>
        {todos.length === 0 ? (
          <div className="px-3 py-2 text-[var(--taomni-code-muted)]">No TODO/FIXME markers in open editors.</div>
        ) : (
          <ul>
            {todos.map((item) => (
              <li key={item.key}>
                <button
                  type="button"
                  className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-[var(--taomni-code-active-line-bg)]"
                  onClick={() => onOpenTodo(item)}
                >
                  <span className="shrink-0 rounded bg-[var(--taomni-code-active-line-bg)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--taomni-accent)]">
                    {item.kind}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[var(--taomni-code-text)]">{item.text}</span>
                    <span className="block truncate text-[10px] text-[var(--taomni-code-muted)]">
                      {item.pathLabel}:{item.line + 1}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <header className="flex h-8 items-center gap-1.5 px-2 text-[var(--taomni-code-muted)]">
          <Bookmark className="h-3.5 w-3.5" />
          <span className="font-semibold text-[var(--taomni-code-text)]">Bookmarks</span>
          <span className="ml-auto tabular-nums">{bookmarks.length}</span>
        </header>
        {bookmarks.length === 0 ? (
          <div className="px-3 py-2 text-[var(--taomni-code-muted)]">
            No bookmarks yet. Use “Toggle Bookmark” on the current editor line.
          </div>
        ) : (
          <div>
            {Array.from(
              bookmarks.reduce((groups, item) => {
                const groupName = item.group || (item.mnemonic ? "Mnemonic Bookmarks" : "General Bookmarks");
                const list = groups.get(groupName) ?? [];
                list.push(item);
                groups.set(groupName, list);
                return groups;
              }, new Map<string, WorkspaceBookmark[]>()),
            ).map(([groupName, items]) => (
              <div key={groupName} className="mb-2">
                <div className="bg-[var(--taomni-code-gutter-bg)] px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--taomni-code-muted)]">
                  {groupName} ({items.length})
                </div>
                <ul>
                  {items.map((item) => (
                    <li key={item.id} className="flex items-stretch">
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-start gap-2 px-3 py-1.5 text-left hover:bg-[var(--taomni-code-active-line-bg)]"
                        onClick={() => onOpenBookmark(item)}
                      >
                        {item.mnemonic && (
                          <span className="shrink-0 rounded border border-[var(--taomni-accent)] bg-[var(--taomni-code-active-line-bg)] px-1 py-0.2 text-[9px] font-bold text-[var(--taomni-accent)]">
                            {item.mnemonic}
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[var(--taomni-code-text)]">{item.label}</span>
                          <span className="block truncate text-[10px] text-[var(--taomni-code-muted)]">
                            {item.pathLabel}:{item.line + 1}
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove bookmark ${item.label}`}
                        className="shrink-0 px-2 text-[10px] text-[var(--taomni-code-muted)] hover:text-[var(--taomni-code-text)]"
                        onClick={() => onRemoveBookmark(item.id)}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
