import { useLayoutEffect, useRef, useState } from "react";
import { Bookmark, Check, ListTodo, Pencil, X } from "lucide-react";
import { workspaceBookmarkGroupName, type WorkspaceBookmark, type WorkspaceTodoItem } from "../todoBookmarks";

interface TodosBookmarksPanelProps {
  todos: WorkspaceTodoItem[];
  bookmarks: WorkspaceBookmark[];
  onOpenTodo: (item: WorkspaceTodoItem) => void;
  onOpenBookmark: (item: WorkspaceBookmark) => void;
  onRemoveBookmark: (id: string) => void;
  onRenameBookmarkGroup: (oldGroupName: string, newGroupName: string) => void;
}

export function TodosBookmarksPanel({
  todos,
  bookmarks,
  onOpenTodo,
  onOpenBookmark,
  onRemoveBookmark,
  onRenameBookmarkGroup,
}: TodosBookmarksPanelProps) {
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [groupDraft, setGroupDraft] = useState("");
  const renameButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocusGroupRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (editingGroup !== null) return;
    const groupName = pendingFocusGroupRef.current;
    if (!groupName) return;
    const button = renameButtonRefs.current.get(groupName);
    if (!button) return;
    pendingFocusGroupRef.current = null;
    button.focus();
  }, [bookmarks, editingGroup]);

  const setRenameButtonRef = (groupName: string, node: HTMLButtonElement | null) => {
    if (node) renameButtonRefs.current.set(groupName, node);
    else renameButtonRefs.current.delete(groupName);
  };

  const beginGroupRename = (groupName: string) => {
    setEditingGroup(groupName);
    setGroupDraft(groupName);
  };

  const cancelGroupRename = (focusGroupName = editingGroup) => {
    pendingFocusGroupRef.current = focusGroupName;
    setEditingGroup(null);
    setGroupDraft("");
  };

  const saveGroupRename = (groupName: string) => {
    const nextName = groupDraft.trim();
    if (!nextName) return;
    onRenameBookmarkGroup(groupName, nextName);
    cancelGroupRename(nextName);
  };

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
                const groupName = workspaceBookmarkGroupName(item);
                const list = groups.get(groupName) ?? [];
                list.push(item);
                groups.set(groupName, list);
                return groups;
              }, new Map<string, WorkspaceBookmark[]>()),
            ).map(([groupName, items]) => (
              <div
                key={groupName}
                data-testid="code-workspace-bookmark-group"
                data-group-name={groupName}
                role="group"
                aria-label={`Bookmark group ${groupName}`}
                className="mb-2"
              >
                <div className="flex min-h-7 items-center gap-1 bg-[var(--taomni-code-gutter-bg)] px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--taomni-code-muted)]">
                  {editingGroup === groupName ? (
                    <input
                      data-testid="code-workspace-bookmark-group-input"
                      aria-label={`Rename bookmark group ${groupName}`}
                      className="min-w-0 flex-1 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1 py-0.5 font-normal normal-case tracking-normal text-[var(--taomni-code-text)] outline-none focus:border-[var(--taomni-accent)]"
                      value={groupDraft}
                      autoFocus
                      onChange={(event) => setGroupDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          saveGroupRename(groupName);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          cancelGroupRename(groupName);
                        }
                      }}
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate">{groupName} ({items.length})</span>
                  )}
                  {editingGroup === groupName ? (
                    <>
                      <button
                        type="button"
                        data-testid="code-workspace-bookmark-group-save"
                        aria-label={`Save bookmark group ${groupName}`}
                        title="Save bookmark group"
                        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-[var(--taomni-code-active-line-bg)]"
                        onClick={() => saveGroupRename(groupName)}
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        data-testid="code-workspace-bookmark-group-cancel"
                        aria-label={`Cancel renaming bookmark group ${groupName}`}
                        title="Cancel group rename"
                        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-[var(--taomni-code-active-line-bg)]"
                        onClick={() => cancelGroupRename(groupName)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      data-testid="code-workspace-bookmark-group-rename"
                      aria-label={`Rename bookmark group ${groupName}`}
                      title="Rename bookmark group"
                      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-[var(--taomni-code-active-line-bg)]"
                      ref={(node) => setRenameButtonRef(groupName, node)}
                      onClick={() => beginGroupRename(groupName)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <ul>
                  {items.map((item) => (
                    <li key={item.id} data-testid="code-workspace-bookmark-item" data-state={item.state ?? "current"} className="flex items-stretch">
                      <button
                        type="button"
                        data-testid="code-workspace-bookmark-open"
                        aria-label={item.state === "missing" ? `Missing bookmark target ${item.label}` : `Open bookmark ${item.label}`}
                        className="flex min-w-0 flex-1 items-start gap-2 px-3 py-1.5 text-left hover:bg-[var(--taomni-code-active-line-bg)]"
                        onClick={() => onOpenBookmark(item)}
                      >
                        {item.mnemonic && (
                          <span
                            data-testid="code-workspace-bookmark-mnemonic"
                            className="shrink-0 rounded border border-[var(--taomni-accent)] bg-[var(--taomni-code-active-line-bg)] px-1 py-0.2 text-[9px] font-bold text-[var(--taomni-accent)]"
                          >
                            {item.mnemonic}
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[var(--taomni-code-text)]">{item.label}</span>
                          <span className="block truncate text-[10px] text-[var(--taomni-code-muted)]">
                            {item.pathLabel}:{item.line + 1}
                          </span>
                          {item.state === "missing" && (
                            <span
                              data-testid="code-workspace-bookmark-missing"
                              className="block truncate text-[10px] text-amber-400"
                            >
                              Missing target
                            </span>
                          )}
                        </span>
                      </button>
                      <button
                        type="button"
                        data-testid="code-workspace-bookmark-remove"
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
