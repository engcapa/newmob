/**
 * Cross-component registry for live terminal panels.
 *
 * Each `TerminalPanel` registers itself on mount with:
 *   - `tabId`: the owning tab's id (canonical key the rest of the app uses)
 *   - `sessionId`: the backend terminal session id for write_terminal IPC
 *   - `getBufferText`: returns the entire scrollback as plain text
 *   - `getLastLines(n)`: returns the last N lines of the active buffer
 *   - `writeInput(data)`: forwards text to the terminal stdin (base64-encoded
 *     by the underlying writeTerminal call)
 *
 * Consumers (the AI Chat Drawer being the primary one) look up the registered
 * entry by `tabId` to either pull terminal context for `@terminal:last-N`
 * resolution or push commands the assistant suggested into the live terminal
 * via the "Send to terminal" button on rendered code blocks.
 *
 * The registry lives on `globalThis` so it survives Vite HMR remounts; React
 * components register on mount and unregister on unmount. We deliberately do
 * NOT make it a Zustand store: tracking xterm refs in React state triggers
 * extra renders for every keystroke. A plain Map is the right primitive.
 */

export interface TerminalRegistryEntry {
  tabId: string;
  sessionId: string;
  /** Title shown when a tab-bound chat displays its linked terminal. */
  title: string;
  /**
   * Facts about a bound LOCAL terminal. Absent for SSH/remote terminals, where
   * the saved session card is the source of truth.
   */
  localEnvironment?: {
    platform: string;
    shellId?: string | null;
    shellName?: string | null;
    shellArgs?: string[];
  } | null;
  /** Full scrollback as plain text. */
  getBufferText: () => string;
  /** Last `n` non-wrapped lines as plain text. */
  getLastLines: (n: number) => string;
  /** Write text to the terminal's stdin (newlines flow as-is). */
  writeInput: (data: string) => void;
  /**
   * Run a command as an integrated task using the registered local shell's
   * syntax. The implementation reports completion through OSC 633 while
   * leaving the interactive shell alive. Optional for legacy/test registrants.
   */
  runTask?: (
    command: string,
    environment?: import("./commandInput").TerminalTaskVariables,
  ) => void;
  /**
   * Write display-only text directly to the terminal screen (xterm `write`),
   * WITHOUT sending it to the backend pty/ssh stdin. Used to mirror Claude
   * Code's captured-run activity (`run_captured`, the independent-channel B
   * path that is otherwise invisible) into the bound terminal as a read-only
   * trace, so the user can see what the assistant ran. Accepts ANSI; lines must
   * use `\r\n`. Optional — not every registrant provides it (e.g. test fakes).
   */
  writeEcho?: (data: string) => void;
}

interface TerminalRegistryShape {
  entries: Map<string, TerminalRegistryEntry>;
  activeTabId: string | null;
  /** Tab ids whose unmount should preserve the backend session because
   *  ownership is transitioning to a detached window. Consumed once. */
  detachPending: Set<string>;
}

const KEY = "__taomni_terminal_registry__";

function ensureRegistry(): TerminalRegistryShape {
  const g = globalThis as unknown as Record<string, unknown>;
  let reg = g[KEY] as TerminalRegistryShape | undefined;
  if (!reg) {
    reg = { entries: new Map(), activeTabId: null, detachPending: new Set() };
    g[KEY] = reg;
  } else if (!reg.detachPending) {
    reg.detachPending = new Set();
  }
  return reg;
}

export function registerTerminal(entry: TerminalRegistryEntry): () => void {
  const reg = ensureRegistry();
  reg.entries.set(entry.tabId, entry);
  return () => {
    const cur = ensureRegistry();
    const existing = cur.entries.get(entry.tabId);
    // Only remove if the registered entry is still ours — guards against
    // race conditions where StrictMode double-mounts a panel and the unmount
    // fires after the second mount has overwritten the entry.
    if (existing && existing.sessionId === entry.sessionId) {
      cur.entries.delete(entry.tabId);
    }
  };
}

/** Mark the tab whose terminal panel currently has focus / is the active tab. */
export function setActiveTerminalTab(tabId: string | null): void {
  ensureRegistry().activeTabId = tabId;
}

export function getActiveTerminalTabId(): string | null {
  return ensureRegistry().activeTabId;
}

export function getTerminal(tabId: string | null | undefined): TerminalRegistryEntry | null {
  if (!tabId) return null;
  return ensureRegistry().entries.get(tabId) ?? null;
}

export function getActiveTerminal(): TerminalRegistryEntry | null {
  const reg = ensureRegistry();
  return reg.activeTabId ? reg.entries.get(reg.activeTabId) ?? null : null;
}

export function listTerminals(): TerminalRegistryEntry[] {
  return Array.from(ensureRegistry().entries.values());
}

/**
 * Mark a tab as transitioning to a detached window. The TerminalPanel
 * for that tab will skip its `closeTerminal` cleanup on the imminent
 * unmount so the backend PTY/SSH session survives the handoff. Cleared
 * by `consumeTerminalDetachPending` once it has been honoured (or by
 * the caller if the detach attempt fails).
 */
export function markTerminalDetachPending(tabId: string): void {
  ensureRegistry().detachPending.add(tabId);
}

export function consumeTerminalDetachPending(tabId: string): boolean {
  const reg = ensureRegistry();
  if (!reg.detachPending.has(tabId)) return false;
  reg.detachPending.delete(tabId);
  return true;
}

export function clearTerminalDetachPending(tabId: string): void {
  ensureRegistry().detachPending.delete(tabId);
}
