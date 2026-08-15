/**
 * Unified Workspace Action Registry (E0.1 & E0.3).
 *
 * Consolidates actions from Editor, Navigation, Refactoring, Run, Debug, View, and Tools
 * into a single queryable metadata model with when-contexts, provenance, and execution handlers.
 */

export type ActionCategory =
  | "Edit"
  | "Navigate"
  | "Refactor"
  | "Run"
  | "Debug"
  | "View"
  | "File"
  | "Help";

export type ActionProvenance =
  | "local"      // Implemented natively in client editor/workspace
  | "index"      // Powered by local semantic index
  | "provider"   // Delegated to external Language Server / DAP / Toolchain
  | "partial"    // Partially implemented / heuristic
  | "unsupported"; // Action placeholder / unsupported in current context

export interface ActionPlatformKeybindings {
  macos?: string;
  windows?: string;
  linux?: string;
  default: string;
}

export interface WorkspaceActionMetadata {
  id: string;
  title: string;
  description?: string;
  category: ActionCategory;
  keybinding?: string | ActionPlatformKeybindings;
  secondaryKeybindings?: string[];
  when?: string; // e.g. "editorTextFocus", "editorHasSelection", "debugActive", "splitActive"
  provenance: ActionProvenance;
  capabilityRequirement?: string;
  keywords?: string[];
}

export interface ExecutableWorkspaceAction extends WorkspaceActionMetadata {
  run: (context?: Record<string, unknown>) => void | Promise<void>;
  isEnabled?: (context?: Record<string, unknown>) => boolean;
}

class ActionRegistry {
  private actions = new Map<string, ExecutableWorkspaceAction>();

  register(action: ExecutableWorkspaceAction): () => void {
    this.actions.set(action.id, action);
    return () => {
      this.actions.delete(action.id);
    };
  }

  get(id: string): ExecutableWorkspaceAction | undefined {
    return this.actions.get(id);
  }

  getAll(): ExecutableWorkspaceAction[] {
    return Array.from(this.actions.values());
  }

  getByCategory(category: ActionCategory): ExecutableWorkspaceAction[] {
    return this.getAll().filter((a) => a.category === category);
  }

  search(query: string): ExecutableWorkspaceAction[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.getAll();
    return this.getAll().filter((a) => {
      if (a.id.toLowerCase().includes(q)) return true;
      if (a.title.toLowerCase().includes(q)) return true;
      if (a.category.toLowerCase().includes(q)) return true;
      if (a.description?.toLowerCase().includes(q)) return true;
      if (a.keywords?.some((k) => k.toLowerCase().includes(q))) return true;
      const kb = typeof a.keybinding === "string" ? a.keybinding : a.keybinding?.default;
      if (kb && kb.toLowerCase().includes(q)) return true;
      return false;
    });
  }

  clear(): void {
    this.actions.clear();
  }
}

export const workspaceActionRegistry = new ActionRegistry();

/**
 * Standard default action catalog for Code Workspace.
 */
export const DEFAULT_WORKSPACE_ACTIONS: WorkspaceActionMetadata[] = [
  // --- Edit ---
  {
    id: "workspace.toggleCase",
    title: "Toggle Case",
    description: "Cycle uppercase, lowercase, and camelCase for selection or word under cursor",
    category: "Edit",
    keybinding: "Ctrl+Shift+U",
    provenance: "local",
    keywords: ["case", "uppercase", "lowercase", "capitalize"],
  },
  {
    id: "workspace.formatDocument",
    title: "Reformat Code",
    description: "Format active document or selection using effective code style and language formatter",
    category: "Edit",
    keybinding: "Ctrl+Alt+L",
    provenance: "provider",
    keywords: ["format", "reformat", "indent", "prettify"],
  },
  {
    id: "workspace.optimizeImports",
    title: "Optimize Imports",
    description: "Organize and clean up unused import statements",
    category: "Edit",
    keybinding: "Ctrl+Alt+O",
    provenance: "provider",
    keywords: ["import", "organize", "unused"],
  },
  {
    id: "workspace.parameterInfo",
    title: "Parameter Info",
    description: "Show active method or function signature and parameters",
    category: "Edit",
    keybinding: "Ctrl+P",
    provenance: "provider",
    keywords: ["parameter", "signature", "arguments"],
  },
  {
    id: "workspace.completeCurrentStatement",
    title: "Complete Current Statement",
    description: "Insert missing semicolons, closing brackets, or block braces",
    category: "Edit",
    keybinding: "Ctrl+Shift+Enter",
    provenance: "partial",
    keywords: ["statement", "semicolon", "brace"],
  },

  // --- Navigate ---
  {
    id: "workspace.nextDiagnostic",
    title: "Next Highlighted Error",
    description: "Navigate to the next error or warning in the active file",
    category: "Navigate",
    keybinding: "F2",
    provenance: "provider",
    keywords: ["error", "warning", "diagnostic", "next"],
  },
  {
    id: "workspace.prevDiagnostic",
    title: "Previous Highlighted Error",
    description: "Navigate to the previous error or warning in the active file",
    category: "Navigate",
    keybinding: "Shift+F2",
    provenance: "provider",
    keywords: ["error", "warning", "diagnostic", "prev"],
  },
  {
    id: "workspace.quickDefinitionPeek",
    title: "Quick Definition Peek",
    description: "Preview symbol definition inline without losing editor focus",
    category: "Navigate",
    keybinding: "Ctrl+Shift+I",
    provenance: "provider",
    keywords: ["definition", "peek", "preview"],
  },
  {
    id: "workspace.revealActiveFileInTree",
    title: "Select in Project View",
    description: "Reveal and focus the active file in the project file tree",
    category: "Navigate",
    keybinding: "Alt+F1",
    provenance: "local",
    keywords: ["reveal", "tree", "project", "locate"],
  },
  {
    id: "workspace.searchEverywhere",
    title: "Search Everywhere",
    description: "Search all files, classes, symbols, and actions across the workspace",
    category: "Navigate",
    keybinding: "Shift+Shift",
    provenance: "local",
    keywords: ["search", "find", "everywhere", "symbol"],
  },
  {
    id: "workspace.recentFiles",
    title: "Recent Files",
    description: "List recently opened files and switch with rapid navigation",
    category: "Navigate",
    keybinding: "Ctrl+E",
    provenance: "local",
    keywords: ["recent", "switcher", "history"],
  },

  // --- Refactor ---
  {
    id: "workspace.refactorThis",
    title: "Refactor This…",
    description: "Open context popup with all applicable refactoring actions",
    category: "Refactor",
    keybinding: "Ctrl+Alt+Shift+T",
    provenance: "provider",
    keywords: ["refactor", "extract", "inline", "rename"],
  },
  {
    id: "workspace.rename",
    title: "Rename Symbol",
    description: "Rename symbol across references with conflict verification",
    category: "Refactor",
    keybinding: "Shift+F6",
    provenance: "provider",
    keywords: ["rename", "symbol", "refactor"],
  },
  {
    id: "workspace.safeDelete",
    title: "Safe Delete",
    description: "Check usages across workspace before deleting symbol",
    category: "Refactor",
    keybinding: "Alt+Delete",
    provenance: "provider",
    keywords: ["delete", "safe", "usages"],
  },

  // --- Run & Debug ---
  {
    id: "workspace.runContextConfiguration",
    title: "Run Context Configuration",
    description: "Execute the main target or test associated with the active file",
    category: "Run",
    keybinding: "Ctrl+Shift+F10",
    provenance: "local",
    keywords: ["run", "execute", "launch"],
  },
  {
    id: "workspace.recompileActiveFile",
    title: "Recompile Active File",
    description: "Trigger incremental recompile of the active file or module",
    category: "Run",
    keybinding: "Ctrl+Shift+F9",
    provenance: "local",
    keywords: ["compile", "build", "recompile"],
  },
  {
    id: "workspace.toggleBreakpoint",
    title: "Toggle Line Breakpoint",
    description: "Toggle line breakpoint on the current cursor line",
    category: "Debug",
    keybinding: "Ctrl+F8",
    provenance: "local",
    keywords: ["breakpoint", "debug", "line"],
  },
  {
    id: "workspace.toggleMuteBreakpoints",
    title: "Mute Breakpoints",
    description: "Temporarily mute all breakpoints during debugger execution",
    category: "Debug",
    provenance: "local",
    keywords: ["mute", "breakpoints", "debug"],
  },

  // --- View ---
  {
    id: "workspace.toggleSyncSplitScroll",
    title: "Toggle Synchronized Split Scrolling",
    description: "Synchronize viewport scroll between left and right editor panes",
    category: "View",
    provenance: "local",
    keywords: ["scroll", "split", "sync", "mirror"],
  },
  {
    id: "workspace.showCoverage",
    title: "Show Test Coverage",
    description: "Scan workspace and display test coverage reports and gutters",
    category: "View",
    provenance: "local",
    keywords: ["coverage", "jacoco", "lcov", "gutter"],
  },
  {
    id: "workspace.openKeymapCheatsheet",
    title: "Keyboard Shortcuts & Keymap",
    description: "Open shortcut reference and command executor dialog",
    category: "Help",
    keybinding: "Ctrl+Alt+/",
    secondaryKeybindings: ["Ctrl+K Ctrl+S"],
    provenance: "local",
    keywords: ["keymap", "shortcuts", "cheat sheet", "keyboard"],
  },
  {
    id: "workspace.openDapAdapterGuide",
    title: "DAP Debug Adapter Setup Guide",
    description: "View installation guides and launch configurations for debug adapters",
    category: "Help",
    provenance: "local",
    keywords: ["dap", "debug", "adapter", "guide", "lldb", "dlv", "debugpy"],
  },
];
