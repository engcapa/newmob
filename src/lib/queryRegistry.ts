/**
 * Cross-component registry for live database query tabs.
 *
 * Database panels register a small imperative surface so AI chat actions can
 * push generated SQL into the focused query editor without threading refs
 * through the whole layout tree.
 */

export interface QueryRegistryEntry {
  tabId: string;
  title: string;
  engine: string;
  insertQuery: (
    sql: string,
    options?: {
      run?: boolean;
      destination?: "current" | "new";
      position?: "caret" | "first" | "last" | "replaceAll";
    },
  ) => void;
  /**
   * Append a statement echoed from an AI/Claude Code SQL execution to a
   * dedicated echo editor panel — never runs it. Reuses the same panel across
   * calls (creating one if the tab has none) so the whole chat session's SQL
   * accumulates in one place. `note` is an optional comment line rendered above
   * the statement.
   */
  appendEchoSql: (sql: string, note?: string) => void;
  /** Persist the latest SQL editor buffers before the owning app tab unmounts. */
  flushWorkspace?: () => Promise<void>;
}

interface QueryRegistryShape {
  entries: Map<string, QueryRegistryEntry>;
  activeTabId: string | null;
}

const KEY = "__taomni_query_registry__";

function ensureRegistry(): QueryRegistryShape {
  const g = globalThis as unknown as Record<string, unknown>;
  let reg = g[KEY] as QueryRegistryShape | undefined;
  if (!reg) {
    reg = { entries: new Map(), activeTabId: null };
    g[KEY] = reg;
  }
  return reg;
}

export function registerQueryTab(entry: QueryRegistryEntry): () => void {
  const reg = ensureRegistry();
  reg.entries.set(entry.tabId, entry);
  return () => {
    const cur = ensureRegistry();
    const existing = cur.entries.get(entry.tabId);
    if (existing === entry) {
      cur.entries.delete(entry.tabId);
    }
  };
}

export function setActiveQueryTab(tabId: string | null): void {
  ensureRegistry().activeTabId = tabId;
}

export function getActiveQueryTabId(): string | null {
  return ensureRegistry().activeTabId;
}

export function getQueryTab(tabId: string | null | undefined): QueryRegistryEntry | null {
  if (!tabId) return null;
  return ensureRegistry().entries.get(tabId) ?? null;
}

export function getActiveQueryTab(): QueryRegistryEntry | null {
  const reg = ensureRegistry();
  return reg.activeTabId ? reg.entries.get(reg.activeTabId) ?? null : null;
}

export function listQueryTabs(): QueryRegistryEntry[] {
  return Array.from(ensureRegistry().entries.values());
}
