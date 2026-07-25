import { create } from "zustand";

export type WorkspaceEol = "LF" | "CRLF" | "CR";

export interface CodeWorkspaceStatusSegments {
  tabId: string;
  /** 1-based line for display. */
  line: number;
  /** 1-based column for display. */
  column: number;
  encoding: string;
  eol: WorkspaceEol;
  languageId: string | null;
  lspActive: boolean;
  lspLabel: string | null;
  lspError: boolean;
  gitBranch: string | null;
  gitAhead: number;
  gitBehind: number;
  fontSize: number;
  /** Large-file mode: semantic tokens / inlay hints / highlight are downgraded. */
  largeFile: boolean;
}

export interface CodeWorkspaceStatusActions {
  openLanguagePanel?: () => void;
  openGitManager?: () => void;
}

interface CodeWorkspaceStatusStoreState {
  status: CodeWorkspaceStatusSegments | null;
  actions: CodeWorkspaceStatusActions | null;
  setStatus: (status: CodeWorkspaceStatusSegments | null) => void;
  setActions: (tabId: string, actions: CodeWorkspaceStatusActions | null) => void;
  clearForTab: (tabId: string) => void;
}

function segmentsEqual(
  left: CodeWorkspaceStatusSegments | null,
  right: CodeWorkspaceStatusSegments | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.tabId === right.tabId
    && left.line === right.line
    && left.column === right.column
    && left.encoding === right.encoding
    && left.eol === right.eol
    && left.languageId === right.languageId
    && left.lspActive === right.lspActive
    && left.lspLabel === right.lspLabel
    && left.lspError === right.lspError
    && left.gitBranch === right.gitBranch
    && left.gitAhead === right.gitAhead
    && left.gitBehind === right.gitBehind
    && left.fontSize === right.fontSize
    && left.largeFile === right.largeFile;
}

export function detectWorkspaceEol(text: string): WorkspaceEol {
  if (text.includes("\r\n")) return "CRLF";
  if (text.includes("\r")) return "CR";
  return "LF";
}

export const useCodeWorkspaceStatusStore = create<CodeWorkspaceStatusStoreState>((set, get) => ({
  status: null,
  actions: null,

  setStatus: (status) => {
    if (segmentsEqual(get().status, status)) return;
    set({ status });
  },

  setActions: (tabId, actions) => {
    const current = get().status;
    if (current && current.tabId !== tabId && actions) return;
    set({ actions });
  },

  clearForTab: (tabId) => {
    const current = get().status;
    if (current?.tabId === tabId) {
      set({ status: null, actions: null });
      return;
    }
    // Actions may outlive status briefly while switching files inside the same tab.
    if (!current) set({ actions: null });
  },
}));
