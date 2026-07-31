import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import {
  Archive,
  Clipboard,
  Edit3,
  FileText,
  FolderOpen,
  Globe2,
  Link2,
  MoreVertical,
  Play,
  Plus,
  Search,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import {
  dbArchiveSavedQuery,
  dbDeleteSavedQuery,
  dbListSavedQueries,
  dbSaveSavedQuery,
  type DbSavedQuery,
  type DbSavedQueryScope,
} from "../../lib/ipc";
import { confirmAppDialog } from "../../lib/appDialogs";
import { useContextMenu, type MenuItem } from "../ContextMenu";

export interface QueryLibraryPanelProps {
  engine: string;
  connectionId: string;
  activeContent: string;
  catalogName?: string | null;
  databaseName?: string | null;
  schemaName?: string | null;
  contentLabel?: string;
  onOpenQuery: (query: DbSavedQuery) => void;
  onRunQuery: (query: DbSavedQuery) => void;
  onSavedQuery?: (query: DbSavedQuery) => void;
  onAddTriggerRef?: MutableRefObject<(() => void) | null>;
}

function uniqueTags(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  );
}

function namespaceLabel(query: DbSavedQuery): string | null {
  const parts = [query.catalogName, query.databaseName, query.schemaName].filter(Boolean);
  return parts.length > 0 ? parts.join(" / ") : null;
}

function errorMessage(error: unknown): string {
  const message = String(error);
  if (message.includes("saved_query_name_conflict:")) {
    return `A query with this name already exists in the selected scope and namespace.`;
  }
  if (message.includes("saved_query_revision_conflict:")) {
    return "This query changed in another window. Refresh the library and apply your edit again.";
  }
  return message;
}

export function QueryLibraryPanel({
  engine,
  connectionId,
  activeContent,
  catalogName,
  databaseName,
  schemaName,
  contentLabel = "SQL",
  onOpenQuery,
  onRunQuery,
  onSavedQuery,
  onAddTriggerRef,
}: QueryLibraryPanelProps) {
  const [queries, setQueries] = useState<DbSavedQuery[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [allNamespaces, setAllNamespaces] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingQuery, setEditingQuery] = useState<DbSavedQuery | null>(null);
  const [modalName, setModalName] = useState("");
  const [modalRemarks, setModalRemarks] = useState("");
  const [modalTags, setModalTags] = useState("");
  const [modalContent, setModalContent] = useState("");
  const [modalScope, setModalScope] = useState<DbSavedQueryScope>("connection");
  const [saving, setSaving] = useState(false);
  const formRef = useRef<HTMLFormElement | null>(null);
  const { show: openMenu, render: menu } = useContextMenu();

  const loadQueries = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await dbListSavedQueries({
        connectionId,
        engine,
        catalogName,
        databaseName,
        schemaName,
        includeAllNamespaces: allNamespaces,
        includeArchived: showArchived,
      });
      setQueries(list);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [allNamespaces, catalogName, connectionId, databaseName, engine, schemaName, showArchived]);

  useEffect(() => {
    void loadQueries();
  }, [loadQueries]);

  const openCreate = useCallback(() => {
    setEditingQuery(null);
    setModalName("");
    setModalRemarks("");
    setModalTags("");
    setModalContent(activeContent);
    setModalScope("connection");
    setError(null);
    setModalOpen(true);
  }, [activeContent]);

  useEffect(() => {
    if (!onAddTriggerRef) return;
    onAddTriggerRef.current = openCreate;
    return () => {
      onAddTriggerRef.current = null;
    };
  }, [onAddTriggerRef, openCreate]);

  useEffect(() => {
    if (!modalOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setModalOpen(false);
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        formRef.current?.requestSubmit();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [modalOpen]);

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    for (const query of queries) {
      for (const tag of query.tags) {
        if (tag.trim()) tags.add(tag.trim());
      }
    }
    return Array.from(tags).sort((left, right) => left.localeCompare(right));
  }, [queries]);

  const filteredQueries = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return queries.filter((query) => {
      if (!showArchived && query.archivedAt) return false;
      if (
        term &&
        !query.name.toLowerCase().includes(term) &&
        !query.content.toLowerCase().includes(term) &&
        !(query.remarks?.toLowerCase().includes(term) ?? false) &&
        !query.tags.some((tag) => tag.toLowerCase().includes(term))
      ) {
        return false;
      }
      return selectedTags.every((tag) => query.tags.includes(tag));
    });
  }, [queries, searchTerm, selectedTags, showArchived]);

  const openEdit = (query: DbSavedQuery) => {
    setEditingQuery(query);
    setModalName(query.name);
    setModalRemarks(query.remarks ?? "");
    setModalTags(query.tags.join(", "));
    setModalContent(query.content);
    setModalScope(query.scopeType);
    setError(null);
    setModalOpen(true);
  };

  const saveQuery = async (event: React.FormEvent) => {
    event.preventDefault();
    const now = Date.now();
    const scopeId = modalScope === "connection" ? connectionId : engine;
    if (!scopeId) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await dbSaveSavedQuery({
        id: editingQuery?.id ?? globalThis.crypto?.randomUUID?.() ?? `query-${now}-${Math.random()}`,
        scopeType: modalScope,
        scopeId,
        engine,
        catalogName,
        databaseName,
        schemaName,
        namespaceKey: editingQuery?.namespaceKey ?? "",
        name: modalName.trim(),
        content: modalContent,
        remarks: modalRemarks.trim() || null,
        tags: uniqueTags(modalTags),
        revision: editingQuery?.revision ?? 0,
        archivedAt: editingQuery?.archivedAt ?? null,
        createdAt: editingQuery?.createdAt ?? now,
        updatedAt: now,
      });
      setModalOpen(false);
      await loadQueries();
      onSavedQuery?.(saved);
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  const archiveQuery = async (query: DbSavedQuery) => {
    const confirmed = await confirmAppDialog({
      message: query.archivedAt
        ? `Permanently delete query "${query.name}"?`
        : `Archive query "${query.name}"?`,
      confirmLabel: query.archivedAt ? "Delete" : "Archive",
      danger: true,
    });
    if (!confirmed) return;
    try {
      if (query.archivedAt) {
        await dbDeleteSavedQuery(query.id);
      } else {
        await dbArchiveSavedQuery(query.id, query.revision, Date.now(), Date.now());
      }
      await loadQueries();
    } catch (archiveError) {
      setError(errorMessage(archiveError));
    }
  };

  const restoreQuery = async (query: DbSavedQuery) => {
    try {
      await dbArchiveSavedQuery(query.id, query.revision, null, Date.now());
      await loadQueries();
    } catch (restoreError) {
      setError(errorMessage(restoreError));
    }
  };

  const queryMenu = (query: DbSavedQuery): MenuItem[] => [
    {
      label: `Run ${contentLabel.toLowerCase()}`,
      icon: <Play className="w-3.5 h-3.5" />,
      disabled: !!query.archivedAt,
      onClick: () => onRunQuery(query),
    },
    {
      label: "Open in editor",
      icon: <FolderOpen className="w-3.5 h-3.5" />,
      disabled: !!query.archivedAt,
      onClick: () => onOpenQuery(query),
    },
    {
      label: `Copy ${contentLabel}`,
      icon: <Clipboard className="w-3.5 h-3.5" />,
      onClick: () => navigator.clipboard.writeText(query.content).catch(() => undefined),
    },
    { label: "", separator: true },
    query.archivedAt
      ? {
          label: "Restore",
          icon: <Archive className="w-3.5 h-3.5" />,
          onClick: () => void restoreQuery(query),
        }
      : {
          label: "Edit...",
          icon: <Edit3 className="w-3.5 h-3.5" />,
          onClick: () => openEdit(query),
        },
    {
      label: query.archivedAt ? "Delete permanently" : "Archive",
      icon: query.archivedAt
        ? <Trash2 className="w-3.5 h-3.5" />
        : <Archive className="w-3.5 h-3.5" />,
      danger: true,
      onClick: () => void archiveQuery(query),
    },
  ];

  return (
    <div
      className="h-full flex flex-col min-h-0 bg-[var(--taomni-bg)] text-[var(--taomni-text)] text-[12px]"
      data-testid="query-library-panel"
    >
      <div className="p-2 border-b border-[var(--taomni-divider)] flex flex-col gap-2 shrink-0 bg-[var(--taomni-quick-bg)]">
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-[5px] w-3.5 h-3.5 text-[var(--taomni-text-muted)]" />
            <input
              type="search"
              aria-label="Search saved queries"
              placeholder="Search queries..."
              className="taomni-input w-full h-6 text-[11px]"
              style={{ paddingLeft: "24px" }}
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
          </div>
          <button
            type="button"
            className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)] border border-[var(--taomni-tab-border)]"
            title="Save current editor as query"
            aria-label="Save current editor as query"
            onClick={openCreate}
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex items-center gap-1 text-[10px]">
          <button
            type="button"
            className="px-1.5 h-5 rounded border"
            style={{
              borderColor: !allNamespaces ? "var(--taomni-accent)" : "var(--taomni-divider)",
              color: !allNamespaces ? "var(--taomni-accent)" : "var(--taomni-text-muted)",
            }}
            onClick={() => setAllNamespaces(false)}
          >
            Current namespace
          </button>
          <button
            type="button"
            className="px-1.5 h-5 rounded border"
            style={{
              borderColor: allNamespaces ? "var(--taomni-accent)" : "var(--taomni-divider)",
              color: allNamespaces ? "var(--taomni-accent)" : "var(--taomni-text-muted)",
            }}
            onClick={() => setAllNamespaces(true)}
          >
            All
          </button>
          <label className="ml-auto inline-flex items-center gap-1 text-[var(--taomni-text-muted)]">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
            />
            Archived
          </label>
        </div>

        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-1 max-h-[60px] overflow-y-auto taomni-scroll-y py-0.5">
            {allTags.map((tag) => {
              const selected = selectedTags.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() =>
                    setSelectedTags((current) =>
                      selected ? current.filter((item) => item !== tag) : [...current, tag],
                    )
                  }
                  className="px-1.5 py-0.5 rounded text-[10px] flex items-center gap-0.5 border"
                  style={{
                    background: selected ? "var(--taomni-selected)" : "transparent",
                    borderColor: selected ? "var(--taomni-accent)" : "var(--taomni-divider)",
                    color: selected ? "var(--taomni-accent)" : "var(--taomni-text-muted)",
                  }}
                >
                  <Tag className="w-2.5 h-2.5" />
                  {tag}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto taomni-scroll-y p-1">
        {loading ? (
          <div className="px-3 py-4 text-center text-[var(--taomni-text-muted)]">Loading queries...</div>
        ) : filteredQueries.length === 0 ? (
          <div className="px-3 py-8 text-center text-[var(--taomni-text-muted)] flex flex-col items-center gap-2">
            <FileText className="w-8 h-8 opacity-40" />
            <span>{error ?? "No saved queries in this scope."}</span>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {filteredQueries.map((query) => {
              const location = namespaceLabel(query);
              return (
                <div
                  key={query.id}
                  className="group flex flex-col p-2 rounded cursor-pointer hover:bg-[var(--taomni-hover)]"
                  style={{ opacity: query.archivedAt ? 0.6 : 1 }}
                  data-testid={`saved-query-${query.id}`}
                  onClick={() => !query.archivedAt && onOpenQuery(query)}
                  onDoubleClick={() => !query.archivedAt && onRunQuery(query)}
                  onContextMenu={(event) => openMenu(event, queryMenu(query))}
                >
                  <div className="flex items-start gap-1.5">
                    <FileText className="w-3.5 h-3.5 text-[var(--taomni-accent)] mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <span className="font-semibold text-[12px] truncate block">{query.name}</span>
                      <span className="text-[9px] text-[var(--taomni-text-muted)] inline-flex items-center gap-0.5">
                        {query.scopeType === "connection" ? (
                          <Link2 className="w-2.5 h-2.5" />
                        ) : (
                          <Globe2 className="w-2.5 h-2.5" />
                        )}
                        {query.scopeType === "connection" ? "Connection" : query.engine}
                        {location ? ` · ${location}` : " · All namespaces"}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[var(--taomni-divider)] shrink-0"
                      aria-label={`Actions for ${query.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        openMenu(event, queryMenu(query));
                      }}
                    >
                      <MoreVertical className="w-3.5 h-3.5 text-[var(--taomni-text-muted)]" />
                    </button>
                  </div>
                  <div className="taomni-mono text-[10px] text-[var(--taomni-text-muted)] truncate mt-1 px-1 rounded bg-[color-mix(in_srgb,var(--taomni-hover)_40%,transparent)]">
                    {query.content.replace(/\s+/g, " ")}
                  </div>
                  {query.remarks && (
                    <div className="text-[10px] text-[var(--taomni-text-muted)] truncate mt-0.5">
                      {query.remarks}
                    </div>
                  )}
                  {query.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {query.tags.map((tag) => (
                        <span
                          key={tag}
                          className="px-1 rounded-[3px] text-[9px] bg-[var(--taomni-divider)] text-[var(--taomni-text-muted)] inline-flex items-center gap-0.5"
                        >
                          <Tag className="w-2 h-2" />
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {error && filteredQueries.length > 0 && (
          <div className="px-2 py-1 text-[10px] text-red-500">{error}</div>
        )}
      </div>

      {menu}

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={editingQuery ? "Edit saved query" : "Save query"}
            className="rounded shadow-lg p-4 flex flex-col gap-3 w-[520px] h-[560px] max-h-[90vh] max-w-[95vw] overflow-hidden"
            style={{
              background: "var(--taomni-bg)",
              border: "1px solid var(--taomni-card-border)",
            }}
          >
            <div className="flex justify-between items-center pb-2 border-b border-[var(--taomni-divider)] shrink-0">
              <span className="font-semibold text-[13px]">
                {editingQuery ? "Edit Saved Query" : "Save Current Query"}
              </span>
              <button type="button" aria-label="Close" onClick={() => setModalOpen(false)}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <form ref={formRef} onSubmit={saveQuery} className="flex-1 flex flex-col gap-3 min-h-0">
              <div className="grid grid-cols-[1fr_150px] gap-3 shrink-0">
                <label className="flex flex-col gap-0.5 text-[11px] text-[var(--taomni-text-muted)]">
                  Name
                  <input
                    type="text"
                    aria-label="Query name"
                    placeholder="Automatic: Query-N"
                    className="taomni-input h-7 w-full text-[12px] px-2"
                    value={modalName}
                    onChange={(event) => setModalName(event.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-0.5 text-[11px] text-[var(--taomni-text-muted)]">
                  Scope
                  <select
                    aria-label="Query scope"
                    className="taomni-input h-7 w-full text-[12px] px-2"
                    value={modalScope}
                    onChange={(event) => setModalScope(event.target.value as DbSavedQueryScope)}
                  >
                    <option value="connection">This connection</option>
                    <option value="engine">All {engine}</option>
                  </select>
                </label>
              </div>
              <label className="flex flex-col gap-0.5 text-[11px] text-[var(--taomni-text-muted)] shrink-0">
                Remarks / Description
                <textarea
                  className="taomni-input w-full text-[12px] p-1.5 h-12 resize-none"
                  value={modalRemarks}
                  onChange={(event) => setModalRemarks(event.target.value)}
                />
              </label>
              <label className="flex flex-col gap-0.5 text-[11px] text-[var(--taomni-text-muted)] shrink-0">
                Tags (comma separated)
                <input
                  type="text"
                  className="taomni-input h-7 w-full text-[12px] px-2"
                  value={modalTags}
                  onChange={(event) => setModalTags(event.target.value)}
                />
              </label>
              <label className="flex-1 flex flex-col gap-0.5 text-[11px] text-[var(--taomni-text-muted)] min-h-[120px]">
                {contentLabel} content
                <textarea
                  aria-label={`${contentLabel} content`}
                  className="taomni-input w-full flex-1 text-[11px] taomni-mono p-2 resize-none taomni-scroll-y"
                  value={modalContent}
                  onChange={(event) => setModalContent(event.target.value)}
                />
              </label>
              {error && <div className="text-[11px] text-red-500">{error}</div>}
              <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--taomni-divider)] shrink-0">
                <button type="button" className="taomni-btn h-8 px-4" onClick={() => setModalOpen(false)}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="taomni-btn h-8 px-4"
                  style={{ background: "var(--taomni-accent)", color: "white" }}
                  disabled={saving}
                >
                  {saving ? "Saving..." : "Save Query"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
