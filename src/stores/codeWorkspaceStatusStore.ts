import { create } from "zustand";

export type WorkspaceEol = "LF" | "CRLF" | "CR";

export interface CodeWorkspaceLspProgress {
  key: string;
  label: string;
  message: string | null;
  percentage: number | null;
  cancellable: boolean;
}

export interface CodeWorkspaceStatusSegments {
  tabId: string;
  /** 1-based line for display. */
  line: number;
  /** 1-based column for display. */
  column: number;
  encoding: string;
  eol: WorkspaceEol;
  indentation?: string | null;
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
  /** Most recently updated server work-done task, when one is active. */
  lspProgress?: CodeWorkspaceLspProgress | null;
}

export interface CodeWorkspaceStatusActions {
  openLanguagePanel?: () => void;
  openGitManager?: () => void;
  cancelLspProgress?: () => void;
  /** Cycle the active editor's on-disk line ending and mark it dirty. */
  cycleEol?: () => void;
  /** Toggle preservation of the UTF-8 byte-order marker and mark it dirty. */
  toggleBom?: () => void;
  /** Open the charset/BOM chooser for the active editor. */
  chooseEncoding?: () => void;
  /** Cycle the active editor's indentation display and preference. */
  cycleIndentation?: () => void;
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
    && left.indentation === right.indentation
    && left.languageId === right.languageId
    && left.lspActive === right.lspActive
    && left.lspLabel === right.lspLabel
    && left.lspError === right.lspError
    && left.gitBranch === right.gitBranch
    && left.gitAhead === right.gitAhead
    && left.gitBehind === right.gitBehind
    && left.fontSize === right.fontSize
    && left.largeFile === right.largeFile
    && left.lspProgress?.key === right.lspProgress?.key
    && left.lspProgress?.label === right.lspProgress?.label
    && left.lspProgress?.message === right.lspProgress?.message
    && left.lspProgress?.percentage === right.lspProgress?.percentage
    && left.lspProgress?.cancellable === right.lspProgress?.cancellable;
}

export function detectWorkspaceEol(text: string): WorkspaceEol {
  if (text.includes("\r\n")) return "CRLF";
  if (text.includes("\r")) return "CR";
  return "LF";
}

export function detectIndentation(text: string): { type: "spaces" | "tabs"; size: number; label: string } {
  let tabCount = 0;
  let space2Count = 0;
  let space4Count = 0;

  for (const line of text.split("\n").slice(0, 300)) {
    if (!line || /^\s*$/.test(line)) continue;
    if (line.startsWith("\t")) {
      tabCount += 1;
    } else {
      const match = line.match(/^ +/);
      if (match) {
        const len = match[0].length;
        if (len % 4 === 0) space4Count += 1;
        else if (len % 2 === 0) space2Count += 1;
      }
    }
  }

  if (tabCount > space2Count && tabCount > space4Count) {
    return { type: "tabs", size: 4, label: "Tab: 4" };
  }
  if (space4Count > space2Count) {
    return { type: "spaces", size: 4, label: "Spaces: 4" };
  }
  return { type: "spaces", size: 2, label: "Spaces: 2" };
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
