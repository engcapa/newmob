import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type MutableRefObject,
} from "react";
import { Compartment, EditorState, Prec, type Extension, type Text } from "@codemirror/state";
import {
  EditorView,
  closeHoverTooltip,
  crosshairCursor,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  hoverTooltip,
  keymap,
  lineNumbers,
  rectangularSelection,
  showTooltip,
  tooltips,
  type Tooltip,
} from "@codemirror/view";
import {
  openExternalDocumentation,
  referenceHrefFromEventTarget,
  validateExternalDocUrl,
  type QuickDocContent,
} from "./referenceDocumentation";
import {
  startWindowResizeSession,
  type ResizeCorner,
  type WindowResizeSession,
} from "./windowResizeSession";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  startCompletion,
} from "@codemirror/autocomplete";
import {
  createLiveTemplateCompletionSource,
  expandLiveTemplateAt,
  liveTemplateLanguageForPath,
} from "./liveTemplates";
import {
  bracketMatching,
  foldAll,
  foldGutter,
  indentOnInput,
  indentUnit,
  unfoldAll,
} from "@codemirror/language";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { renderFormatted } from "../../../lib/chat/renderFormatted";
import { readTextResult, writeText } from "../../../lib/clipboard";
import { codeViewExtensions } from "../../../lib/codeViewTheme";
import type { EffectiveCodeStyle } from "./codeStyleModel";
import type {
  LspCompletionItem,
  LspCompletionResult,
  LspDiagnostic,
  LspDocumentHighlight,
  LspInlayHint,
  LspSemanticToken,
  LspPosition,
  LspRange,
  LspSignatureHelpResult,
} from "../../../lib/editor/lsp";
import { languageForPath } from "../../git/diffLanguage";
import { acquireClipboardStore, clipboardStoreForWorkspace, type WorkspaceClipboardHandle } from "./workspaceClipboardSession";
import { createWorkspaceSearchPanel, WORKSPACE_SEARCH_STYLE } from "./editorSearchPanel";
import {
  activeLspSnippetChoices,
  advanceLspSnippetTabstop,
  cancelLspSnippetSession,
  cycleLspSnippetChoice,
  createLspCompletionSource,
  lspSnippetSessionInvalidator,
  type CompletionAcceptanceDiagnostic,
  type CompletionRequestIdentity,
  type CompletionRequestToken,
} from "./lspCompletion";
import { createDiagnosticChrome } from "./lspDiagnosticChrome";
import {
  createLspOverlayChrome,
  createLspSemanticTokenChrome,
  LSP_INTELLIGENCE_THEME,
} from "./lspIntelligenceChrome";
import { createLspHyperlinkExtension } from "./lspHyperlink";
import { createGitEditorChrome, type GitLineChange } from "./gitEditorChrome";
import { createDebugEditorChrome, type DebugBreakpointMarker } from "./debugEditorChrome";
import { createCoverageEditorChrome } from "./coverageEditorChrome";
import {
  editorAppearanceExtension,
  type EditorAppearanceExtensionProfile,
} from "./editorAppearanceExtension";
import type { FileCoverage } from "./coverageModel";
import type { DebugStepAction } from "./dapDebugModel";
import type { GitBlameLine } from "../../../lib/git";
import { lspPositionFromOffset, offsetFromLspPosition } from "./lspPositions";
import {
  cloneCaretAbove,
  cloneCaretBelow,
  cutEditorSelections,
  editorClipboardPayload,
  escapeEditorSelections,
  expandSelectionFromLspRanges,
  expandSyntaxSelection,
  foldSelection,
  moveStatementDown,
  moveStatementUp,
  occurrenceSessionField,
  pasteEditorClipboardPayload,
  plainTextClipboardPayload,
  createRegionFoldService,
  selectAllEditorOccurrences,
  selectNextEditorOccurrence,
  selectionHistoryField,
  workspaceEditorKeymap,
  type EditorClipboardPayload,
} from "./workspaceEditorCommands";
import {
  buildEditorHostActions,
} from "./workspaceCodeMirrorKeymap";
import {
  completeStatementPlan,
  surroundWithPlan,
  type SurroundKind,
} from "./workspaceSemanticEditing";
import type { WorkspaceActionHost } from "./workspaceActionHost";

export interface EditorRevealTarget {
  line: number;
  character: number;
}

export interface EditorSelectionRange {
  start: LspPosition;
  end: LspPosition;
  empty: boolean;
  text: string;
  /** Viewport-relative rect of the selection head; null when empty/unavailable. */
  rect: { top: number; left: number; right: number; bottom: number } | null;
}

interface CodeMirrorHostProps {
  path: string;
  /** Stable buffer identity used by the workspace editor command owner. */
  fileKey?: string;
  doc: string;
  visible: boolean;
  /**
   * Owning workspace instance id (§8.17.6): copy/cut write the workspace
   * clipboard session and paste reads it across every split view.
   */
  clipboardWorkspaceId?: string;
  /** Surfaced when a clipboard operation degraded (system clipboard failed). */
  onClipboardUnavailable?: (message: string) => void;
  diagnostics: LspDiagnostic[];
  highlights?: LspDocumentHighlight[];
  inlayHints?: LspInlayHint[];
  semanticTokens?: LspSemanticToken[];
  gitChanges?: GitLineChange[];
  gitBlame?: GitBlameLine | null;
  /** File test coverage data. */
  fileCoverage?: FileCoverage | null;
  /** Whether coverage gutter overlay is enabled. */
  coverageEnabled?: boolean;
  /** Debug breakpoints on this file (M9) — rendered in the breakpoint gutter. */
  debugBreakpoints?: DebugBreakpointMarker[];
  /** 1-based line the debugger is currently stopped on for this file (or null). */
  debugCurrentLine?: number | null;
  /** Selected-frame locals (`name → value`) rendered as inline values. */
  debugInlineValues?: Record<string, string>;
  /** Stepping / stop actions for the debugger keymap; null when no session runs. */
  debugStep?: ((action: DebugStepAction) => void) | null;
  debugRunToCursor?: ((line: number) => void) | null;
  debugStop?: (() => void) | null;
  /** Hover evaluation while stopped in this file (null disables the tooltip). */
  debugEvaluate?: ((expression: string) => Promise<{ value: string; type: string | null } | null>) | null;
  reveal: EditorRevealTarget | null;
  /** Block edits (library / decompiled sources that have no file to write back to). */
  readOnly?: boolean;
  onChange: (doc: string, caret: LspPosition, caretOffset: number) => void;
  onSave: () => void;
  onHover: (position: LspPosition) => Promise<QuickDocContent | null>;
  onPinHoverDoc?: (content: QuickDocContent) => void;
  onDefinition: (position: LspPosition) => Promise<boolean>;
  onReferences: (position: LspPosition) => Promise<void>;
  onComplete?: (
    position: LspPosition,
    triggerCharacter: string | null,
    token: CompletionRequestToken,
  ) => Promise<LspCompletionResult | null>;
  onCompleteResolve?: (
    raw: unknown,
    token: CompletionRequestToken,
  ) => Promise<LspCompletionItem | null>;
  /** Live completion request identity (§8.16.2); null = typed unavailable. */
  getCompletionIdentity: () => CompletionRequestIdentity | null;
  onCompletionDiagnostic: (kind: CompletionAcceptanceDiagnostic, detail?: string) => void;
  onSignatureHelp?: (
    position: LspPosition,
    triggerCharacter: string | null,
  ) => Promise<LspSignatureHelpResult | null>;
  onSelectionChange?: (selection: EditorSelectionRange) => void;
  onViewportChange?: (range: LspRange) => void;
  onExpandSelection?: (selection: EditorSelectionRange) => Promise<LspRange[] | null>;
  onLightbulb?: (line: number) => void;
  onGitChangeClick?: (change: GitLineChange) => void;
  /** Toggle a breakpoint at a 1-based line (breakpoint gutter click). */
  onToggleBreakpoint?: (line: number) => void;
  /** Edit a breakpoint's condition/logpoint at a 1-based line (gutter right-click). */
  onEditBreakpoint?: (line: number) => void;
  /** Editor-area right-click (symbol / buffer menu). */
  onContextMenu?: (info: EditorContextMenuRequest) => void;
  onCommandPortChange?: (registration: EditorCommandPortRegistration) => void;
  completionTriggers?: string[];
  signatureTriggers?: string[];
  /** Wrap logical lines at the viewport edge (IDEA soft-wrap mode). */
  softWrap?: boolean;
  /** Workspace-scoped Code Workspace editor appearance. */
  appearance?: EditorAppearanceExtensionProfile;
  /** When false, provider documentation is not requested from pointer hover. */
  showHoverDocumentation?: boolean;
  /** Pointer settle time before requesting documentation. */
  hoverDocumentationDelayMs?: number;
  /** Monotonic explicit request from the workspace ActionHost. */
  parameterInfoRequestNonce?: number;
  /** Whether typing a provider signature trigger opens Parameter Info. */
  parameterInfoAutoPopup?: boolean;
  /** Delay for typed signature triggers; explicit requests bypass it. */
  parameterInfoDelayMs?: number;
  /** Render all provider overloads instead of only the active signature. */
  parameterInfoShowFullSignatures?: boolean;
  /** Effective code style driving indentUnit, tabSize, and insertSpaces. */
  codeStyle?: EffectiveCodeStyle;
  /** When enabled, a normal mouse drag creates a rectangular selection. */
  columnSelectionMode?: boolean;
  /**
   * §8.18.2: when provided, the editor's business bindings (save / replace /
   * parameter info / extend selection) are registered as explicit `editor.*`
   * actions on this host and resolved through it — the inline spread-keymap
   * entries are not installed. Null keeps isolated-usage legacy bindings.
   */
  workspaceActionHost?: WorkspaceActionHost | null;
}

/** Payload for the editor context menu (coordinates + clipboard helpers). */
export interface EditorContextMenuRequest {
  position: LspPosition;
  selectionStart: LspPosition;
  selectionEnd: LspPosition;
  clientX: number;
  clientY: number;
  hasSelection: boolean;
  selectedText: string;
  cut: () => void;
  copy: () => void;
  paste: () => void;
}

/**
 * Frozen target for host-owned context-menu execution. Captured when the menu
 * opens so a later active-group change cannot redirect the action.
 */
export interface EditorCommandTarget {
  groupId: string;
  fileKey: string;
}

const editorClipboardPayloadByView = new WeakMap<EditorView, EditorClipboardPayload>();

// Clipboard helpers close over host props through this per-view registry
// (bound at mount) so the module-level helpers stay pure and testable.
const clipboardContextByView = new WeakMap<
  EditorView,
  {
    workspaceId: string | null;
    onUnavailable: (message: string) => void;
    /** Refcounted session handle (§8.18.4); null for legacy non-workspace views. */
    handle: WorkspaceClipboardHandle | null;
  }
>();

type ClipboardStoreLike = Pick<WorkspaceClipboardHandle, "write" | "read">;

function workspaceStoreFor(
  context: { workspaceId: string | null; handle: WorkspaceClipboardHandle | null } | undefined,
): ClipboardStoreLike | null {
  if (!context) return null;
  if (context.handle) return context.handle;
  return context.workspaceId ? clipboardStoreForWorkspace(context.workspaceId) : null;
}

function rememberEditorClipboardPayload(
  view: EditorView,
  payload: EditorClipboardPayload,
  options: { systemClipboardUnavailable?: boolean } = {},
): void {
  // WeakMap stays as a compat read for legacy call paths only; the workspace
  // session store below is the owner shared across split views (§8.17.6).
  editorClipboardPayloadByView.set(view, {
    ...payload,
    segments: payload.segments ? [...payload.segments] : undefined,
  });
  const context = clipboardContextByView.get(view);
  const store = workspaceStoreFor(context);
  if (store) {
    store.write({
      sourceViewId: String(view.dom.getAttribute("data-cm-id") ?? ""),
      plainText: payload.plainText,
      segments: payload.segments,
      rectangular: payload.rectangular,
      sourceEol: payload.sourceEol,
      ...(options.systemClipboardUnavailable ? { systemClipboardUnavailable: true } : {}),
    });
  }
}

function payloadForSystemClipboardText(
  view: EditorView,
  text: string,
): EditorClipboardPayload {
  // Workspace session first: a copy in ANOTHER split view must still paste
  // with its segments/rectangular shape here.
  const context = clipboardContextByView.get(view);
  const store = workspaceStoreFor(context);
  const session = store ? store.read() : null;
  if (session && session.plainText === text && (session.segments?.length || session.rectangular)) {
    return {
      plainText: session.plainText,
      segments: session.segments ?? undefined,
      sourceEol: session.sourceEol,
      rectangular: session.rectangular,
    };
  }
  const remembered = editorClipboardPayloadByView.get(view);
  return remembered?.plainText === text
    ? remembered
    : plainTextClipboardPayload(text);
}

function writeEditorSelectionToClipboard(view: EditorView): boolean {
  const payload = editorClipboardPayload(view.state);
  if (!payload) return false;
  const context = clipboardContextByView.get(view);
  void writeText(payload.plainText)
    .then(() => {
      if (view.dom.isConnected) rememberEditorClipboardPayload(view, payload);
    })
    .catch(() => {
      // System clipboard denied: the workspace session still owns the full
      // payload; surface unavailable instead of silently dropping it.
      if (view.dom.isConnected) {
        rememberEditorClipboardPayload(view, payload, { systemClipboardUnavailable: true });
        context?.onUnavailable(
          "System clipboard unavailable — copy kept for in-workspace paste only",
        );
      }
    });
  return true;
}

function pasteSystemClipboard(view: EditorView): boolean {
  if (view.composing || view.state.readOnly) return false;
  const docAtRequest = view.state.doc;
  const selectionAtRequest = view.state.selection;
  const context = clipboardContextByView.get(view);
  void readTextResult()
    .then((result) => {
      if (
        !result.ok
        || !view.dom.isConnected
        || view.composing
        || view.state.doc !== docAtRequest
        || !view.state.selection.eq(selectionAtRequest, true)
      ) {
        if (!result.ok && view.dom.isConnected && !view.composing) {
          const fallbackStore = workspaceStoreFor(context);
          const session = fallbackStore ? fallbackStore.read() : null;
          if (session) {
            // System clipboard read failed; the workspace session preserves
            // the last copy/cut (segments intact) with an explicit notice.
            pasteEditorClipboardPayload(view, {
              plainText: session.plainText,
              segments: session.segments ?? undefined,
              sourceEol: session.sourceEol,
              rectangular: session.rectangular,
            });
            context?.onUnavailable(
              "System clipboard unavailable — pasted the last in-workspace copy instead",
            );
            view.focus();
          }
        }
        return;
      }
      pasteEditorClipboardPayload(
        view,
        payloadForSystemClipboardText(view, result.text),
      );
      view.focus();
    })
    .catch(() => {});
  return true;
}

function cutSystemClipboard(view: EditorView): boolean {
  if (view.composing || view.state.readOnly) return false;
  const payload = editorClipboardPayload(view.state);
  if (!payload) return false;
  const docAtRequest = view.state.doc;
  const selectionAtRequest = view.state.selection;
  const context = clipboardContextByView.get(view);
  void writeText(payload.plainText)
    .then(() => {
      if (
        !view.dom.isConnected
        || view.composing
        || view.state.doc !== docAtRequest
        || !view.state.selection.eq(selectionAtRequest, true)
      ) {
        return;
      }
      rememberEditorClipboardPayload(view, payload);
      cutEditorSelections(view);
      view.focus();
    })
    .catch(() => {
      if (
        view.dom.isConnected
        && !view.composing
        && view.state.doc === docAtRequest
        && view.state.selection.eq(selectionAtRequest, true)
      ) {
        rememberEditorClipboardPayload(view, payload, { systemClipboardUnavailable: true });
        cutEditorSelections(view);
        context?.onUnavailable(
          "System clipboard unavailable — cut kept for in-workspace paste only",
        );
        view.focus();
      }
    });
  return true;
}

export type EditorCommandId =
  | "cloneCaretAbove"
  | "cloneCaretBelow"
  | "collapseCarets"
  | "completeStatement"
  | "copy"
  | "cut"
  | "foldAll"
  | "foldSelection"
  | "moveStatementDown"
  | "moveStatementUp"
  | "paste"
  | "selectAllOccurrences"
  | "selectNextOccurrence"
  | "surroundWithTryCatch"
  | "unfoldAll";

export interface EditorCommandState {
  composing: boolean;
  readOnly: boolean;
  hasSelection: boolean;
  caretCount: number;
  occurrenceSessionActive: boolean;
}

export interface EditorCommandPort {
  execute: (commandId: EditorCommandId) => boolean;
  state: () => EditorCommandState;
}

export interface EditorCommandPortRegistration {
  fileKey: string;
  token: object;
  port: EditorCommandPort | null;
}

/**
 * Apply a Surround With plan to the main selection (§8.18.8). The selection
 * must span whole lines of one range; everything else is a typed no-op.
 */
function applySurroundWith(view: EditorView, kindId: SurroundKind["id"]): boolean {
  if (view.state.readOnly || view.composing) return false;
  const ranges = view.state.selection.ranges;
  const main = view.state.selection.main;
  if (ranges.length !== 1) return false;
  const fromLine = view.state.doc.lineAt(main.from);
  const toLine = view.state.doc.lineAt(main.to);
  const languageId = guessEditorLanguageId(view) ?? "plaintext";
  const plan = surroundWithPlan(kindId, {
    text: view.state.doc.sliceString(fromLine.from, toLine.to),
    from: fromLine.from,
    to: toLine.to,
    fromLineStart: main.from === fromLine.from,
    toLineEnd: main.to === toLine.to,
    rangeCount: ranges.length,
    readOnly: view.state.readOnly,
    languageId,
  });
  if (plan.kind === "unavailable") return false;
  view.dispatch({
    changes: plan.changes,
    selection: { anchor: Math.min(plan.selection.anchor, view.state.doc.length + plan.changes.reduce((sum, change) => sum + ("insert" in change ? (change.insert as string)?.length ?? 0 : 0), 0)) },
    userEvent: "input.surround",
    scrollIntoView: true,
  });
  return true;
}

/** Per-view language identity, registered at mount from the file path. */
const editorLanguageByView = new WeakMap<EditorView, string>();

/** Best-effort language id from the host's current file path (§8.18.8). */
function guessEditorLanguageId(view: EditorView): string | null {
  return editorLanguageByView.get(view) ?? liveTemplateLanguageForPath(null);
}

function editorCommandPort(view: EditorView): EditorCommandPort {
  return {
    execute(commandId) {
      switch (commandId) {
        case "cloneCaretAbove": return cloneCaretAbove(view);
        case "cloneCaretBelow": return cloneCaretBelow(view);
        case "collapseCarets": return escapeEditorSelections(view);
        case "completeStatement": {
          // §8.18.8: conservative plan — uncertain boundaries are no-ops.
          const head = view.state.selection.main.head;
          const line = view.state.doc.lineAt(head);
          const plan = completeStatementPlan({
            lineText: line.text,
            nextLineStart: null,
            readOnly: view.state.readOnly,
            languageId: "java",
          });
          if ("kind" in plan) return false;
          view.dispatch({
            changes: { from: plan.insertSemicolonAt, insert: ";" },
            selection: { anchor: plan.insertSemicolonAt + 1 },
            userEvent: "input.complete",
          });
          return true;
        }
        case "copy": return writeEditorSelectionToClipboard(view);
        case "cut": return cutSystemClipboard(view);
        case "foldAll": return foldAll(view) ?? false;
        case "foldSelection": return foldSelection(view);
        case "moveStatementDown": return moveStatementDown(view);
        case "moveStatementUp": return moveStatementUp(view);
        case "paste": return pasteSystemClipboard(view);
        case "selectAllOccurrences": return selectAllEditorOccurrences(view);
        case "selectNextOccurrence": return selectNextEditorOccurrence(view);
        case "surroundWithTryCatch": return applySurroundWith(view, "try-catch");
        case "unfoldAll": return unfoldAll(view) ?? false;
      }
    },
    state: () => ({
      composing: view.composing,
      readOnly: view.state.readOnly,
      hasSelection: view.state.selection.ranges.some((range) => !range.empty),
      caretCount: view.state.selection.ranges.length,
      occurrenceSessionActive: view.state.field(occurrenceSessionField, false) ?? false,
    }),
  };
}

/**
 * Read-only buffers keep the caret, selection, search, and Ctrl+click navigation —
 * only document changes are rejected (IDEA's decompiled-source behaviour).
 */
function readOnlyExtension(readOnly: boolean): Extension {
  return readOnly
    ? [
      EditorState.readOnly.of(true),
      EditorView.contentAttributes.of({ "aria-readonly": "true" }),
    ]
    : [];
}

const WORKSPACE_EDITOR_STYLE = EditorView.theme({
  "&": {
    height: "100%",
  },
  ".cm-foldGutter .cm-gutterElement": {
    minWidth: "1.6ch",
    padding: "0 4px",
  },
});

const LSP_EDITOR_STYLE = EditorView.theme({
  ".cm-lsp-diagnostic-error": {
    textDecoration: "underline wavy #ef4444 1px",
    textUnderlineOffset: "2px",
  },
  ".cm-lsp-diagnostic-warning": {
    textDecoration: "underline wavy #f59e0b 1px",
    textUnderlineOffset: "2px",
  },
  ".cm-lsp-diagnostic-info": {
    textDecoration: "underline dotted #38bdf8 1px",
    textUnderlineOffset: "2px",
  },
  ".cm-tooltip": {
    zIndex: "50 !important",
  },
  ".cm-tooltip.cm-tooltip-hover": {
    background: "transparent !important",
    border: "none !important",
    boxShadow: "none !important",
    padding: "0 !important",
    overflow: "visible !important",
  },
  ".cm-lsp-hover-container": {
    width: "440px",
    height: "280px",
    minWidth: "260px",
    minHeight: "100px",
    maxWidth: "min(560px, 85vw)",
    maxHeight: "min(380px, 45vh)",
  },
  ".cm-lsp-hover": {
    overflow: "auto",
    padding: "8px 12px",
    background: "var(--taomni-code-tooltip-bg)",
    color: "var(--taomni-code-text)",
    fontSize: "12px",
    lineHeight: "1.5",
    outline: "none",
  },
  // Nested markdown (via .taomni-chat-md) is themed in index.css so it tracks
  // --taomni-code-* even when the tooltip is portaled outside the editor host.
});

const EMPTY_HIGHLIGHTS: LspDocumentHighlight[] = [];
const EMPTY_INLAY_HINTS: LspInlayHint[] = [];
const EMPTY_SEMANTIC_TOKENS: LspSemanticToken[] = [];
const EMPTY_GIT_CHANGES: GitLineChange[] = [];

/**
 * New empty-array props are common while LSP requests are debounced, and a
 * caller that rebuilds a derived array per render would otherwise force a full
 * compartment reconfigure on every keystroke. Callers should keep identities
 * stable; the element-wise pass is a cheap backstop for the ones that leak
 * (these arrays hold tens of entries, not thousands).
 */
function sameArrayOrBothEmpty<T>(previous: readonly T[], next: readonly T[]): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) return false;
  }
  return true;
}

/**
 * Inline values are rebuilt on every stop, so identity comparison alone would
 * reconfigure the editor even when the values did not change (stepping over a
 * line that touches nothing).
 */
function sameInlineValues(
  previous: Record<string, string> | undefined,
  next: Record<string, string> | undefined,
): boolean {
  if (previous === next) return true;
  const a = previous ?? {};
  const b = next ?? {};
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

function extractIdentifierAtPos(doc: Text, pos: number): string {
  if (pos < 0 || pos > doc.length) return "Documentation";
  const line = doc.lineAt(pos);
  const col = pos - line.from;
  const left = line.text.slice(0, col);
  const right = line.text.slice(col);
  const start = left.search(/[A-Za-z0-9_$]+$/);
  const endMatch = right.match(/^[A-Za-z0-9_$]*/);
  const from = start >= 0 ? start : col;
  const to = col + (endMatch?.[0].length ?? 0);
  const word = line.text.slice(from, to).trim();
  return word || "Documentation";
}

function cancelActiveHoverResize(
  activeSessionRef: MutableRefObject<WindowResizeSession | null>,
): void {
  activeSessionRef.current?.dispose();
  activeSessionRef.current = null;
}

function setupHoverResize(
  container: HTMLElement,
  handle: HTMLElement,
  activeSessionRef: MutableRefObject<WindowResizeSession | null>,
  corner: ResizeCorner = "se",
) {
  handle.onmousedown = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    cancelActiveHoverResize(activeSessionRef);
    const startRect = container.getBoundingClientRect();
    const session = startWindowResizeSession({
      corner,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: startRect.width > 0 ? startRect.width : 440,
      startHeight: startRect.height > 0 ? startRect.height : 280,
      minWidth: 260,
      minHeight: 100,
      maxWidth: () => window.innerWidth > 0 ? window.innerWidth * 0.85 : 1200,
      maxHeight: () => window.innerHeight > 0 ? window.innerHeight * 0.75 : 800,
      onResize: (width, height) => {
        container.style.width = `${width}px`;
        container.style.height = `${height}px`;
      },
      onDispose: () => {
        if (activeSessionRef.current === session) activeSessionRef.current = null;
      },
    });
    activeSessionRef.current = session;
  };
}

function createHoverDocDom({
  content,
  onPin,
  onClose,
  activeResizeSessionRef,
}: {
  content: QuickDocContent;
  onPin?: (content: QuickDocContent) => void;
  onClose?: () => void;
  activeResizeSessionRef: MutableRefObject<WindowResizeSession | null>;
}): HTMLElement {
  const container = document.createElement("div");
  container.className = "cm-lsp-hover-container relative flex flex-col overflow-hidden rounded-md border border-[var(--taomni-code-border)] bg-[var(--taomni-code-tooltip-bg)] shadow-xl outline-none select-text";
  container.tabIndex = 0;
  container.setAttribute("role", "dialog");
  container.setAttribute("aria-label", "Hover documentation");
  container.setAttribute("data-testid", "code-workspace-hover-doc");

  // Header bar matching QuickDocPopup
  const header = document.createElement("div");
  header.className = "flex h-8 shrink-0 items-center gap-1 border-b border-[var(--taomni-code-border)] px-2 select-none bg-[var(--taomni-code-tooltip-bg)]";

  const titleSpan = document.createElement("span");
  titleSpan.className = "min-w-0 flex-1 truncate text-[11px] font-medium text-[var(--taomni-code-text)]";
  titleSpan.textContent = content.title;
  header.appendChild(titleSpan);

  if (onPin) {
    const pinBtn = document.createElement("button");
    pinBtn.type = "button";
    pinBtn.title = "Pin to Documentation pane";
    pinBtn.setAttribute("aria-label", "Pin to Documentation pane");
    pinBtn.setAttribute("data-testid", "code-workspace-hover-doc-pin");
    pinBtn.className = "inline-flex h-6 w-6 items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)]";
    pinBtn.innerHTML = `<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>`;
    pinBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      onPin(content);
      onClose?.();
    };
    header.appendChild(pinBtn);
  }

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.title = "Close";
  closeBtn.setAttribute("aria-label", "Close quick documentation");
  closeBtn.className = "inline-flex h-6 w-6 items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)]";
  closeBtn.innerHTML = `<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
  closeBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClose?.();
  };
  header.appendChild(closeBtn);

  container.appendChild(header);

  // Markdown body
  const body = document.createElement("div");
  body.className = "cm-lsp-hover taomni-chat-md min-h-0 flex-1 overflow-auto px-3 py-2 text-[12px] leading-relaxed text-[var(--taomni-code-text)]";
  body.innerHTML = renderFormatted(content.body, "md") ?? "";
  body.onclick = (event) => {
    const href = referenceHrefFromEventTarget(event.target);
    if (!href) return;
    event.preventDefault();
    event.stopPropagation();
    void openExternalDocumentation(href);
  };
  container.appendChild(body);

  if (content.source || content.links?.length) {
    const footer = document.createElement("div");
    footer.className = "flex min-h-7 shrink-0 items-center gap-2 border-t border-[var(--taomni-code-border)] px-2 py-1 text-[10px] text-[var(--taomni-code-muted)]";
    const source = document.createElement("span");
    source.className = "min-w-0 flex-1 truncate";
    source.textContent = content.source;
    source.title = content.uri ?? content.source;
    footer.appendChild(source);
    for (const link of content.links ?? []) {
      const decision = validateExternalDocUrl(link.url);
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = link.label;
      button.setAttribute("aria-label", `Open external documentation: ${link.label}`);
      button.disabled = decision.kind !== "allowed";
      button.title = decision.kind === "allowed"
        ? `${link.label} (${new URL(decision.url).host})`
        : `External Documentation unavailable (${decision.reason})`;
      button.className = "shrink-0 rounded px-1.5 py-0.5 hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40";
      button.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        void openExternalDocumentation(link.url);
      };
      footer.appendChild(button);
    }
    container.appendChild(footer);
  }

  // 4-corner resize handles
  const gripNW = document.createElement("div");
  gripNW.className = "absolute top-0 left-0 h-4 w-4 cursor-nw-resize z-10 select-none";
  setupHoverResize(container, gripNW, activeResizeSessionRef, "nw");
  container.appendChild(gripNW);

  const gripNE = document.createElement("div");
  gripNE.className = "absolute top-0 right-0 h-4 w-4 cursor-ne-resize z-10 select-none";
  setupHoverResize(container, gripNE, activeResizeSessionRef, "ne");
  container.appendChild(gripNE);

  const gripSW = document.createElement("div");
  gripSW.className = "absolute bottom-0 left-0 h-4 w-4 cursor-sw-resize z-10 select-none";
  setupHoverResize(container, gripSW, activeResizeSessionRef, "sw");
  container.appendChild(gripSW);

  const gripSE = document.createElement("div");
  gripSE.setAttribute("data-testid", "code-workspace-hover-doc-resize-handle");
  gripSE.setAttribute("aria-label", "Resize hover documentation");
  gripSE.className = "absolute bottom-0 right-0 h-4 w-4 cursor-se-resize flex items-end justify-end p-0.5 opacity-40 hover:opacity-100 select-none z-10";
  gripSE.innerHTML = `<svg viewBox="0 0 6 6" class="h-2.5 w-2.5 fill-current text-[var(--taomni-code-muted)]"><path d="M5 1L1 5M5 3L3 5M5 5L5 5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>`;
  setupHoverResize(container, gripSE, activeResizeSessionRef, "se");
  container.appendChild(gripSE);

  return container;
}

function signatureTooltipDom(
  result: LspSignatureHelpResult,
  showFullSignatures: boolean,
): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-lsp-hover taomni-chat-md";
  dom.setAttribute("role", "dialog");
  dom.setAttribute("aria-label", "Parameter info");
  dom.setAttribute("data-testid", "code-workspace-parameter-info");
  const active = Math.min(result.activeSignature, Math.max(0, result.signatures.length - 1));
  const indices = showFullSignatures
    ? result.signatures.map((_signature, index) => index)
    : [active];

  for (const index of indices) {
    const signature = result.signatures[index];
    if (!signature) continue;
    const section = document.createElement("div");
    section.setAttribute("data-signature-index", String(index));
    section.className = index === active ? "cm-signature-active" : "cm-signature-overload";
    if (index > 0 && showFullSignatures) section.style.marginTop = "8px";
    if (index !== active) section.style.opacity = "0.7";

    const label = document.createElement("div");
    label.style.fontFamily = "var(--taomni-code-font-family, monospace)";
    label.style.whiteSpace = "pre-wrap";
    const parameterIndex = signature.activeParameter ?? result.activeParameter;
    const parameter = signature.parameters[parameterIndex];
    const start = parameter?.labelStart
      ?? (parameter ? signature.label.indexOf(parameter.label) : -1);
    const end = parameter?.labelEnd
      ?? (parameter && start >= 0 ? start + parameter.label.length : -1);
    if (parameter && start >= 0 && end > start) {
      label.append(signature.label.slice(0, start));
      const bold = document.createElement("b");
      bold.textContent = signature.label.slice(start, end);
      label.append(bold, signature.label.slice(end));
    } else {
      label.textContent = signature.label;
    }
    section.appendChild(label);

    const documentation = parameter?.documentation ?? signature.documentation;
    if (documentation && (index === active || showFullSignatures)) {
      const doc = document.createElement("div");
      doc.style.marginTop = "6px";
      doc.innerHTML = renderFormatted(documentation, "md") ?? "";
      section.appendChild(doc);
    }
    dom.appendChild(section);
  }

  if (result.signatures.length > 1) {
    const counter = document.createElement("div");
    counter.style.opacity = "0.6";
    counter.style.fontSize = "11px";
    counter.style.marginTop = "6px";
    counter.textContent = showFullSignatures
      ? `${result.signatures.length} overloads`
      : `${active + 1}/${result.signatures.length} overloads`;
    dom.appendChild(counter);
  }
  return dom;
}

function lspNavigationExtensions(
  definitionRef: MutableRefObject<(position: LspPosition) => Promise<boolean>>,
  referencesRef: MutableRefObject<(position: LspPosition) => Promise<void>>,
): Extension[] {
  const definitionAtSelection = (view: EditorView) => {
    const position = lspPositionFromOffset(view.state.doc, view.state.selection.main.head);
    void definitionRef.current(position);
    return true;
  };
  const referencesAtSelection = (view: EditorView) => {
    const position = lspPositionFromOffset(view.state.doc, view.state.selection.main.head);
    void referencesRef.current(position);
    return true;
  };
  return [
    tooltips({
      position: "fixed",
      parent: typeof document !== "undefined" ? document.body : undefined,
      tooltipSpace: (view) => {
        if (typeof window === "undefined") {
          return { top: 0, left: 0, bottom: 800, right: 1000 };
        }
        const rect = view.dom.getBoundingClientRect();
        return {
          top: Math.max(0, rect.top),
          left: Math.max(0, rect.left),
          bottom: rect.bottom > 0 ? rect.bottom : window.innerHeight,
          right: rect.right > 0 ? rect.right : window.innerWidth,
        };
      },
    }),
    createLspHyperlinkExtension({
      onDefinition: (position) => definitionRef.current(position),
    }),
    keymap.of([
      { key: "F12", run: definitionAtSelection },
      { key: "Shift-F12", run: referencesAtSelection },
      { key: "Mod-b", run: definitionAtSelection },
      { key: "Mod-Alt-B", run: definitionAtSelection },
    ]),
  ];
}

function lspHoverExtension(
  hoverRef: MutableRefObject<(position: LspPosition) => Promise<QuickDocContent | null>>,
  onPinHoverDocRef: MutableRefObject<((content: QuickDocContent) => void) | undefined>,
  activeResizeSessionRef: MutableRefObject<WindowResizeSession | null>,
  enabled: boolean,
  hoverTime: number,
): Extension {
  if (!enabled) return [];
  const extension = hoverTooltip((view, pos): Promise<Tooltip | null> => {
    const position = lspPositionFromOffset(view.state.doc, pos);
    return hoverRef.current(position).then((content) => {
      if (!content) return null;
      const title = extractIdentifierAtPos(view.state.doc, pos);
      const displayContent = content.title ? content : { ...content, title };
      return {
        pos,
        above: true,
        create() {
          const dom = createHoverDocDom({
            content: displayContent,
            onPin: onPinHoverDocRef.current,
            onClose: () => view.dispatch({ effects: closeHoverTooltip(extension) }),
            activeResizeSessionRef,
          });
          return {
            dom,
            destroy: () => cancelActiveHoverResize(activeResizeSessionRef),
          };
        },
      };
    });
  }, {
    hideOnChange: true,
    hoverTime,
  });
  return extension;
}

function sameCodeStyle(a?: EffectiveCodeStyle, b?: EffectiveCodeStyle): boolean {
  if (a === b) return true;
  return (a?.tabSize ?? 2) === (b?.tabSize ?? 2)
    && (a?.insertSpaces ?? true) === (b?.insertSpaces ?? true)
    && (a?.indentSize ?? 2) === (b?.indentSize ?? 2);
}

const EMPTY_LIST: readonly never[] = [];

function sameOptionalArray<T>(
  a?: readonly T[],
  b?: readonly T[],
  equal: (x: T, y: T) => boolean = (x, y) => x === y,
): boolean {
  if (a === b) return true;
  const arrA = a ?? EMPTY_LIST;
  const arrB = b ?? EMPTY_LIST;
  if (arrA.length !== arrB.length) return false;
  for (let i = 0; i < arrA.length; i++) {
    if (!equal(arrA[i] as T, arrB[i] as T)) return false;
  }
  return true;
}

function sameEditorAppearance(
  a?: EditorAppearanceExtensionProfile,
  b?: EditorAppearanceExtensionProfile,
): boolean {
  return a === b || (
    !!a
    && !!b
    && a.fontFamily === b.fontFamily
    && a.fontSizePx === b.fontSizePx
    && a.lineHeight === b.lineHeight
    && a.ligatures === b.ligatures
    && a.colorSchemeId === b.colorSchemeId
    && a.highContrast === b.highContrast
    && a.virtualSpace?.afterLineEnd === b.virtualSpace?.afterLineEnd
    && a.virtualSpace?.atFileBottom === b.virtualSpace?.atFileBottom
  );
}

function areCodeMirrorHostPropsEqual(prev: CodeMirrorHostProps, next: CodeMirrorHostProps): boolean {
  if (prev.path !== next.path) return false;
  if (prev.fileKey !== next.fileKey) return false;
  if (prev.doc !== next.doc) return false;
  if (prev.visible !== next.visible) return false;
  if (prev.readOnly !== next.readOnly) return false;
  if (prev.softWrap !== next.softWrap) return false;
  if (!sameEditorAppearance(prev.appearance, next.appearance)) return false;
  if (prev.columnSelectionMode !== next.columnSelectionMode) return false;
  if (prev.showHoverDocumentation !== next.showHoverDocumentation) return false;
  if (prev.hoverDocumentationDelayMs !== next.hoverDocumentationDelayMs) return false;
  if (prev.parameterInfoRequestNonce !== next.parameterInfoRequestNonce) return false;
  if (prev.parameterInfoAutoPopup !== next.parameterInfoAutoPopup) return false;
  if (prev.parameterInfoDelayMs !== next.parameterInfoDelayMs) return false;
  if (prev.parameterInfoShowFullSignatures !== next.parameterInfoShowFullSignatures) return false;
  if (prev.coverageEnabled !== next.coverageEnabled) return false;
  if (prev.fileCoverage !== next.fileCoverage) return false;
  if (prev.reveal !== next.reveal) return false;
  if (prev.gitBlame !== next.gitBlame) return false;
  if (prev.debugCurrentLine !== next.debugCurrentLine) return false;
  if (!sameCodeStyle(prev.codeStyle, next.codeStyle)) return false;
  if (!sameArrayOrBothEmpty(prev.diagnostics, next.diagnostics)) return false;
  if (!sameOptionalArray(prev.highlights, next.highlights)) return false;
  if (!sameOptionalArray(prev.inlayHints, next.inlayHints)) return false;
  if (!sameOptionalArray(prev.semanticTokens, next.semanticTokens)) return false;
  if (!sameOptionalArray(prev.gitChanges, next.gitChanges)) return false;
  if (!sameOptionalArray(prev.debugBreakpoints, next.debugBreakpoints)) return false;
  if (!sameOptionalArray(prev.completionTriggers, next.completionTriggers)) return false;
  if (!sameOptionalArray(prev.signatureTriggers, next.signatureTriggers)) return false;
  if (prev.debugStep !== next.debugStep) return false;
  if (prev.debugRunToCursor !== next.debugRunToCursor) return false;
  if (prev.debugStop !== next.debugStop) return false;
  if (prev.debugEvaluate !== next.debugEvaluate) return false;
  if (prev.onPinHoverDoc !== next.onPinHoverDoc) return false;
  if (prev.onCommandPortChange !== next.onCommandPortChange) return false;
  return true;
}

export const CodeMirrorHost = memo(function CodeMirrorHost({
  path,
  fileKey = path,
  doc,
  visible,
  diagnostics,
  highlights = EMPTY_HIGHLIGHTS,
  inlayHints = EMPTY_INLAY_HINTS,
  semanticTokens = EMPTY_SEMANTIC_TOKENS,
  gitChanges = EMPTY_GIT_CHANGES,
  gitBlame = null,
  reveal,
  readOnly = false,
  onChange,
  onSave,
  onHover,
  onPinHoverDoc,
  onDefinition,
  onReferences,
  clipboardWorkspaceId,
  onClipboardUnavailable,
  onComplete,
  onCompleteResolve,
  getCompletionIdentity,
  onCompletionDiagnostic,
  onSignatureHelp,
  onSelectionChange,
  onViewportChange,
  onExpandSelection,
  onLightbulb,
  onGitChangeClick,
  onToggleBreakpoint,
  onEditBreakpoint,
  onContextMenu,
  onCommandPortChange,
  completionTriggers,
  signatureTriggers,
  showHoverDocumentation = true,
  hoverDocumentationDelayMs = 300,
  parameterInfoRequestNonce = 0,
  parameterInfoAutoPopup = true,
  parameterInfoDelayMs = 0,
  parameterInfoShowFullSignatures = false,
  softWrap = false,
  appearance,
  columnSelectionMode = false,
  debugBreakpoints,
  debugCurrentLine,
  debugInlineValues,
  debugStep,
  debugRunToCursor,
  debugStop,
  debugEvaluate,
  fileCoverage,
  coverageEnabled = true,
  codeStyle,
  workspaceActionHost = null,
}: CodeMirrorHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // §8.18.2: the mount-once editor effect reads the live host through a ref so
  // editor.* actions register against the workspace controller's instance.
  const workspaceActionHostRef = useRef<WorkspaceActionHost | null>(workspaceActionHost);
  workspaceActionHostRef.current = workspaceActionHost;
  const onClipboardUnavailableRef = useRef((message: string) => {
    onClipboardUnavailable?.(message);
  });
  onClipboardUnavailableRef.current = (message: string) => {
    onClipboardUnavailable?.(message);
  };
  const languageCompartment = useRef(new Compartment());
  const codeStyleCompartment = useRef(new Compartment());
  const diagnosticsCompartment = useRef(new Compartment());
  const overlayCompartment = useRef(new Compartment());
  const semanticTokensCompartment = useRef(new Compartment());
  const gitCompartment = useRef(new Compartment());
  const coverageCompartment = useRef(new Compartment());
  const debugCompartment = useRef(new Compartment());
  const signatureCompartment = useRef(new Compartment());
  const hoverCompartment = useRef(new Compartment());
  const readOnlyCompartment = useRef(new Compartment());
  const wrappingCompartment = useRef(new Compartment());
  const appearanceCompartment = useRef(new Compartment());
  const signatureShownRef = useRef(false);
  const signatureRequestSequenceRef = useRef(0);
  const signatureDelayTimerRef = useRef<number | null>(null);
  const lastParameterInfoNonceRef = useRef(parameterInfoRequestNonce);
  const requestParameterInfoRef = useRef<(() => boolean) | null>(null);
  const activeHoverResizeSessionRef = useRef<WindowResizeSession | null>(null);
  /** True while applying a prop-driven doc replace so it is not treated as a user edit. */
  const applyingExternalDocRef = useRef(false);
  /** Mirrors the last full text sent through onChange or applied from props. */
  const lastDocumentTextRef = useRef(doc);
  const lastSelectionRef = useRef<{ from: number; to: number } | null>(null);
  const selectionEmitTimerRef = useRef<number | null>(null);
  const renderedDiagnosticsRef = useRef(diagnostics);
  const renderedReadOnlyRef = useRef(readOnly);
  const renderedSoftWrapRef = useRef(softWrap);
  const renderedAppearanceRef = useRef(appearance);
  const renderedHoverRef = useRef({
    enabled: showHoverDocumentation,
    delayMs: hoverDocumentationDelayMs,
  });
  const renderedCodeStyleRef = useRef({
    tabSize: codeStyle?.tabSize ?? 2,
    insertSpaces: codeStyle?.insertSpaces ?? true,
    indentSize: codeStyle?.indentSize || (codeStyle?.tabSize ?? 2),
  });
  const renderedCoverageRef = useRef({ fileCoverage, coverageEnabled });
  const renderedOverlayRef = useRef({ highlights, inlayHints });
  const renderedSemanticTokensRef = useRef(semanticTokens);
  const renderedGitRef = useRef({ changes: gitChanges, blame: gitBlame });
  const renderedDebugRef = useRef({
    breakpoints: debugBreakpoints,
    currentLine: debugCurrentLine,
    inlineValues: debugInlineValues,
    evaluating: !!debugEvaluate,
  });
  const onToggleBreakpointRef = useRef(onToggleBreakpoint);
  const onEditBreakpointRef = useRef(onEditBreakpoint);
  const onPinHoverDocRef = useRef(onPinHoverDoc);
  onPinHoverDocRef.current = onPinHoverDoc;
  // Debug actions go through refs so a new session (or a step landing) does not
  // force the whole editor extension set to be rebuilt.
  const debugStepRef = useRef(debugStep);
  const debugRunToCursorRef = useRef(debugRunToCursor);
  const debugStopRef = useRef(debugStop);
  const debugEvaluateRef = useRef(debugEvaluate);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onHoverRef = useRef(onHover);
  const onDefinitionRef = useRef(onDefinition);
  const onReferencesRef = useRef(onReferences);
  const onCompleteRef = useRef(onComplete);
  const onCompleteResolveRef = useRef(onCompleteResolve);
  const getCompletionIdentityRef = useRef(getCompletionIdentity);
  const onCompletionDiagnosticRef = useRef(onCompletionDiagnostic);
  const onSignatureHelpRef = useRef(onSignatureHelp);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onViewportChangeRef = useRef(onViewportChange);
  const onExpandSelectionRef = useRef(onExpandSelection);
  const onLightbulbRef = useRef(onLightbulb);
  const onGitChangeClickRef = useRef(onGitChangeClick);
  const onContextMenuRef = useRef(onContextMenu);
  const completionTriggersRef = useRef(completionTriggers ?? []);
  const signatureTriggersRef = useRef(signatureTriggers ?? []);
  const columnSelectionModeRef = useRef(columnSelectionMode);
  const parameterInfoAutoPopupRef = useRef(parameterInfoAutoPopup);
  const parameterInfoDelayMsRef = useRef(parameterInfoDelayMs);
  const parameterInfoShowFullSignaturesRef = useRef(parameterInfoShowFullSignatures);
  const pathRef = useRef(path);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onHoverRef.current = onHover;
  onDefinitionRef.current = onDefinition;
  onReferencesRef.current = onReferences;
  onCompleteRef.current = onComplete;
  onCompleteResolveRef.current = onCompleteResolve;
  getCompletionIdentityRef.current = getCompletionIdentity;
  onCompletionDiagnosticRef.current = onCompletionDiagnostic;
  onSignatureHelpRef.current = onSignatureHelp;
  onSelectionChangeRef.current = onSelectionChange;
  onViewportChangeRef.current = onViewportChange;
  onExpandSelectionRef.current = onExpandSelection;
  onLightbulbRef.current = onLightbulb;
  onGitChangeClickRef.current = onGitChangeClick;
  onToggleBreakpointRef.current = onToggleBreakpoint;
  onEditBreakpointRef.current = onEditBreakpoint;
  debugStepRef.current = debugStep;
  debugRunToCursorRef.current = debugRunToCursor;
  debugStopRef.current = debugStop;
  debugEvaluateRef.current = debugEvaluate;
  onContextMenuRef.current = onContextMenu;

  /**
   * Build the debug compartment's extensions. Actions read through refs so the
   * extension only has to be rebuilt when what is *rendered* changes; `evaluating`
   * is a flag rather than the callback so a new function identity per render
   * does not churn the editor.
   */
  const buildDebugChrome = useCallback((
    markers: DebugBreakpointMarker[] | undefined,
    currentLine: number | null | undefined,
    inlineValues: Record<string, string> | undefined,
    evaluating: boolean,
  ) => createDebugEditorChrome({
    markers: markers ?? [],
    currentLine: currentLine ?? null,
    inlineValues,
    actions: {
      toggleBreakpoint: (line) => onToggleBreakpointRef.current?.(line),
      editBreakpoint: (line) => onEditBreakpointRef.current?.(line),
      step: (action) => {
        const step = debugStepRef.current;
        if (!step) return false;
        step(action);
        return true;
      },
      runToCursor: (line) => {
        const run = debugRunToCursorRef.current;
        if (!run) return false;
        run(line);
        return true;
      },
      stop: () => {
        const stop = debugStopRef.current;
        if (!stop) return false;
        stop();
        return true;
      },
    },
    evaluate: evaluating ? (expression) => debugEvaluateRef.current?.(expression) ?? Promise.resolve(null) : null,
  }), []);
  completionTriggersRef.current = completionTriggers ?? [];
  signatureTriggersRef.current = signatureTriggers ?? [];
  columnSelectionModeRef.current = columnSelectionMode;
  parameterInfoAutoPopupRef.current = parameterInfoAutoPopup;
  parameterInfoDelayMsRef.current = parameterInfoDelayMs;
  parameterInfoShowFullSignaturesRef.current = parameterInfoShowFullSignatures;
  pathRef.current = path;

  const emitSelection = (view: EditorView) => {
    const handler = onSelectionChangeRef.current;
    if (!handler) return;
    const main = view.state.selection.main;
    const from = Math.min(main.from, main.to);
    const to = Math.max(main.from, main.to);
    const previous = lastSelectionRef.current;
    if (previous?.from === from && previous.to === to) return;
    lastSelectionRef.current = { from, to };
    let rect: EditorSelectionRange["rect"] = null;
    if (!main.empty) {
      const startCoords = view.coordsAtPos(from);
      const endCoords = view.coordsAtPos(to);
      if (startCoords && endCoords) {
        rect = {
          top: Math.min(startCoords.top, endCoords.top),
          left: Math.min(startCoords.left, endCoords.left),
          right: Math.max(startCoords.right, endCoords.right),
          bottom: Math.max(startCoords.bottom, endCoords.bottom),
        };
      }
    }
    handler({
      start: lspPositionFromOffset(view.state.doc, from),
      end: lspPositionFromOffset(view.state.doc, to),
      empty: main.empty,
      text: main.empty ? "" : view.state.doc.sliceString(from, to),
      rect,
    });
  };

  const emitViewport = (view: EditorView) => {
    onViewportChangeRef.current?.({
      start: lspPositionFromOffset(view.state.doc, view.viewport.from),
      end: lspPositionFromOffset(view.state.doc, view.viewport.to),
    });
  };

  useEffect(() => {
    if (!hostRef.current) return;
    const initialDoc = EditorState.create({ doc }).doc;
    const clearPendingSelectionEmit = () => {
      if (selectionEmitTimerRef.current === null) return;
      window.clearTimeout(selectionEmitTimerRef.current);
      selectionEmitTimerRef.current = null;
    };
    const scheduleSelectionEmit = (view: EditorView, delay = 0) => {
      clearPendingSelectionEmit();
      if (delay === 0) {
        emitSelection(view);
        return;
      }
      selectionEmitTimerRef.current = window.setTimeout(() => {
        selectionEmitTimerRef.current = null;
        if (viewRef.current === view) emitSelection(view);
      }, delay);
    };
    const saveHandler = () => {
      onSaveRef.current();
      return true;
    };
    const clearSignatureDelay = () => {
      if (signatureDelayTimerRef.current === null) return;
      window.clearTimeout(signatureDelayTimerRef.current);
      signatureDelayTimerRef.current = null;
    };
    const hideSignature = () => {
      clearSignatureDelay();
      signatureRequestSequenceRef.current += 1;
      if (!signatureShownRef.current) return false;
      signatureShownRef.current = false;
      window.queueMicrotask(() => {
        viewRef.current?.dispatch({
          effects: signatureCompartment.current.reconfigure([]),
        });
      });
      return true;
    };
    const requestSignatureHelp = (
      view: EditorView,
      trigger: string | null,
      options: { explicit?: boolean } = {},
    ) => {
      const handler = onSignatureHelpRef.current;
      if (!handler) return false;
      if (!options.explicit && !parameterInfoAutoPopupRef.current) return false;
      clearSignatureDelay();
      signatureRequestSequenceRef.current += 1;
      const sequence = signatureRequestSequenceRef.current;
      const docAtRequest = view.state.doc;
      const headAtRequest = view.state.selection.main.head;
      const run = () => {
        signatureDelayTimerRef.current = null;
        const currentBefore = viewRef.current;
        if (
          !currentBefore
          || currentBefore !== view
          || currentBefore.state.doc !== docAtRequest
          || currentBefore.state.selection.main.head !== headAtRequest
        ) {
          return;
        }
        const position = lspPositionFromOffset(docAtRequest, headAtRequest);
        void handler(position, trigger)
          .then((result) => {
            const current = viewRef.current;
            if (
              !current
              || current !== view
              || sequence !== signatureRequestSequenceRef.current
              || current.state.doc !== docAtRequest
              || current.state.selection.main.head !== headAtRequest
            ) {
              return;
            }
            if (!result || !result.status.active || result.signatures.length === 0) {
              hideSignature();
              return;
            }
            signatureShownRef.current = true;
            current.dispatch({
              effects: signatureCompartment.current.reconfigure(
                showTooltip.of({
                  pos: headAtRequest,
                  above: true,
                  create: () => ({
                    dom: signatureTooltipDom(
                      result,
                      parameterInfoShowFullSignaturesRef.current,
                    ),
                  }),
                }),
              ),
            });
          })
          .catch(() => {
            if (sequence === signatureRequestSequenceRef.current) hideSignature();
          });
      };
      const delayMs = options.explicit ? 0 : Math.max(0, parameterInfoDelayMsRef.current);
      if (delayMs > 0) {
        signatureDelayTimerRef.current = window.setTimeout(run, delayMs);
      } else {
        run();
      }
      return true;
    };
    requestParameterInfoRef.current = () => {
      const current = viewRef.current;
      return current ? requestSignatureHelp(current, null, { explicit: true }) : false;
    };
    const openReplacePanel = (view: EditorView) => {
      openSearchPanel(view);
      window.requestAnimationFrame(() => {
        const field = view.dom.querySelector<HTMLInputElement>('.cm-workspace-search-input[name="replace"]');
        field?.focus();
        field?.select();
      });
      return true;
    };
    const expandSemanticSelection = (view: EditorView) => {
      const handler = onExpandSelectionRef.current;
      if (!handler) return expandSyntaxSelection(view);
      const main = view.state.selection.main;
      const selection: EditorSelectionRange = {
        start: lspPositionFromOffset(view.state.doc, main.from),
        end: lspPositionFromOffset(view.state.doc, main.to),
        empty: main.empty,
        text: main.empty ? "" : view.state.doc.sliceString(main.from, main.to),
        rect: null,
      };
      void handler(selection).then((ranges) => {
        const current = viewRef.current;
        if (!current || current !== view) return;
        if (!ranges || !expandSelectionFromLspRanges(current, ranges)) {
          expandSyntaxSelection(current);
        }
      }).catch(() => {
        const current = viewRef.current;
        if (current === view) expandSyntaxSelection(current);
      });
      return true;
    };
    const state = EditorState.create({
      doc: initialDoc,
      extensions: [
        lineNumbers(),
        foldGutter(),
        // Language-aware region grammar; unknown languages never fold.
        createRegionFoldService(() => pathRef.current),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        EditorState.allowMultipleSelections.of(true),
        drawSelection(),
        rectangularSelection({
          eventFilter: (event) =>
            event.button === 0 && (
              columnSelectionModeRef.current
              || event.altKey
              || (event.ctrlKey && event.shiftKey)
            ),
        }),
        crosshairCursor(),
        history(),
        bracketMatching(),
        closeBrackets(),
        indentOnInput(),
        autocompletion({
          // Closer to IDEA: short settle while typing; trigger chars fire
          // immediately via the updateListener below.
          activateOnTyping: true,
          activateOnTypingDelay: 100,
          // Prefer the first server-ranked item (sortText / boost) when open.
          defaultKeymap: true,
          icons: true,
          // Large jdtls/ra lists stay scrollable without freezing the UI thread.
          maxRenderedOptions: 100,
          // Delay documentation side-panel slightly so arrowing through the
          // list does not thrash completionItem/resolve.
          interactionDelay: 75,
          optionClass: (completion) => (
            completion.type ? `cm-completion-type-${completion.type}` : ""
          ),
          override: [
            // Local IDEA-style live/postfix templates (sout, psvm, fori, …).
            // Ranked above most LSP items via boost so Tab expands them first.
            createLiveTemplateCompletionSource(() => pathRef.current),
            createLspCompletionSource({
              identity: () => getCompletionIdentityRef.current(),
              fetch: (position, trigger, token) =>
                onCompleteRef.current?.(position, trigger, token) ?? Promise.resolve(null),
              resolve: (raw, token) =>
                onCompleteResolveRef.current?.(raw, token) ?? Promise.resolve(null),
              triggerCharacters: () => completionTriggersRef.current,
              getDocumentRevision: () => getCompletionIdentityRef.current()?.documentRevision ?? -1,
              reportDiagnostic: (kind, detail) => onCompletionDiagnosticRef.current(kind, detail),
            }),
          ],
        }),
        // IDEA: typing `.` / `:` (or server trigger chars) opens the popup
        // immediately instead of waiting for activateOnTypingDelay.
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || update.transactions.every((tr) => !tr.isUserEvent("input.type"))) {
            return;
          }
          const triggers = completionTriggersRef.current;
          if (!triggers.length) return;
          let typedTrigger = false;
          update.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
            if (typedTrigger) return;
            const text = inserted.toString();
            if (!text) return;
            const last = text[text.length - 1];
            if (last && triggers.includes(last)) typedTrigger = true;
          });
          if (typedTrigger) startCompletion(update.view);
        }),
        search({ top: true, createPanel: createWorkspaceSearchPanel }),
        selectionHistoryField,
        occurrenceSessionField,
        // Drop pending LSP snippet tabstop sessions on any unrelated edit.
        lspSnippetSessionInvalidator(),
        codeStyleCompartment.current.of([
          EditorState.tabSize.of(codeStyle?.tabSize ?? 2),
          indentUnit.of(codeStyle?.insertSpaces ? " ".repeat(codeStyle?.indentSize || codeStyle?.tabSize || 2) : "\t"),
        ]),
        languageCompartment.current.of([]),
        diagnosticsCompartment.current.of(createDiagnosticChrome(
          diagnostics,
          (line) => onLightbulbRef.current?.(line),
        )),
        overlayCompartment.current.of(createLspOverlayChrome(
          initialDoc,
          highlights,
          inlayHints,
        )),
        semanticTokensCompartment.current.of(createLspSemanticTokenChrome(
          initialDoc,
          semanticTokens,
        )),
        LSP_INTELLIGENCE_THEME,
        gitCompartment.current.of(createGitEditorChrome(
          gitChanges,
          gitBlame,
          (change) => onGitChangeClickRef.current?.(change),
        )),
        coverageCompartment.current.of(createCoverageEditorChrome(
          fileCoverage ?? null,
          coverageEnabled,
        )),
        debugCompartment.current.of(buildDebugChrome(
          debugBreakpoints,
          debugCurrentLine,
          debugInlineValues,
          !!debugEvaluate,
        )),
        signatureCompartment.current.of([]),
        hoverCompartment.current.of(lspHoverExtension(
          onHoverRef,
          onPinHoverDocRef,
          activeHoverResizeSessionRef,
          showHoverDocumentation,
          hoverDocumentationDelayMs,
        )),
        readOnlyCompartment.current.of(readOnlyExtension(readOnly)),
        wrappingCompartment.current.of(softWrap ? EditorView.lineWrapping : []),
        appearanceCompartment.current.of(
          appearance ? editorAppearanceExtension(appearance) : [],
        ),
        ...lspNavigationExtensions(onDefinitionRef, onReferencesRef),
        ...codeViewExtensions(),
        WORKSPACE_EDITOR_STYLE,
        LSP_EDITOR_STYLE,
        WORKSPACE_SEARCH_STYLE,
        // IDEA-style Tab:
        // 1) Accept the active completion (often a live template).
        // 2) Else expand an exact live/postfix template under the caret
        //    even when the popup is closed (sout + Tab without waiting).
        // 3) Else cycle a choice placeholder's options (§8.18.3 interactive
        //    choice session), else plain LSP snippet tabstops (combined
        //    snippet+import acceptance committed in one transaction).
        // 4) Else fall through to CM snippet tabstops / indentWithTab.
        Prec.high(keymap.of([
          {
            key: "Tab",
            run: (view) => {
              if (acceptCompletion(view)) return true;
              if (expandLiveTemplateAt(
                view,
                liveTemplateLanguageForPath(pathRef.current),
              )) return true;
              if (activeLspSnippetChoices(view)) return cycleLspSnippetChoice(view);
              return advanceLspSnippetTabstop(view);
            },
          },
        ])),
        keymap.of([
          // §8.18.2: with a workspace action host, business bindings resolve
          // exclusively through the host's scheme-aware dispatcher; only
          // generic editor primitives remain in this spread.
          ...(workspaceActionHost ? [] : [
            { key: "Mod-s", run: saveHandler },
            { key: "Mod-r", run: openReplacePanel },
            { key: "Mod-p", run: (view: EditorView) => requestSignatureHelp(view, null, { explicit: true }) },
            { key: "Ctrl-p", run: (view: EditorView) => requestSignatureHelp(view, null, { explicit: true }) },
            { key: "Mod-Shift-Space", run: (view: EditorView) => requestSignatureHelp(view, null, { explicit: true }) },
            { key: "Mod-w", run: expandSemanticSelection },
          ]),
          // Escape stack stays an editor-local primitive (snippet/signature/
          // selection state is not part of WorkspaceActionContext).
          { key: "Escape", run: (view) => cancelLspSnippetSession(view) },
          { key: "Escape", run: escapeEditorSelections },
          { key: "Escape", run: () => hideSignature() },
          ...workspaceEditorKeymap,
          ...searchKeymap,
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.domEventHandlers({
          copy(event, view) {
            const payload = editorClipboardPayload(view.state);
            if (!payload) return false;
            event.preventDefault();
            if (event.clipboardData) {
              event.clipboardData.setData("text/plain", payload.plainText);
              rememberEditorClipboardPayload(view, payload);
            } else {
              void writeText(payload.plainText).then(() => {
                if (view.dom.isConnected) rememberEditorClipboardPayload(view, payload);
              }).catch(() => {});
            }
            return true;
          },
          cut(event, view) {
            if (view.composing || view.state.readOnly) return false;
            const payload = editorClipboardPayload(view.state);
            if (!payload) return false;
            event.preventDefault();
            if (!event.clipboardData) {
              cutSystemClipboard(view);
              return true;
            }
            event.clipboardData.setData("text/plain", payload.plainText);
            rememberEditorClipboardPayload(view, payload);
            return cutEditorSelections(view);
          },
          paste(event, view) {
            if (view.composing || view.state.readOnly) return false;
            const text = event.clipboardData?.getData("text/plain");
            if (text === undefined) return false;
            event.preventDefault();
            return pasteEditorClipboardPayload(view, payloadForSystemClipboardText(view, text));
          },
          contextmenu(event, view) {
            const handler = onContextMenuRef.current;
            if (!handler) return false;
            const coords = { x: event.clientX, y: event.clientY };
            // posAtCoords can be null in headless/jsdom; fall back to caret.
            const pos = view.posAtCoords(coords) ?? view.state.selection.main.head;
            event.preventDefault();
            const clickedSelection = view.state.selection.ranges.find((range) => (
              pos >= range.from && pos <= range.to
            ));
            // Click outside every selection: place the caret there (IDEA-like).
            if (!clickedSelection) {
              view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
            }
            const selection = view.state.selection.main;
            const selectedRanges = view.state.selection.ranges.filter((range) => !range.empty);
            const selectedText = selectedRanges
              .map((range) => view.state.sliceDoc(range.from, range.to))
              .join(view.state.lineBreak);
            const selectionStart = lspPositionFromOffset(
              view.state.doc,
              Math.min(selection.from, selection.to),
            );
            const selectionEnd = lspPositionFromOffset(
              view.state.doc,
              Math.max(selection.from, selection.to),
            );
            handler({
              position: lspPositionFromOffset(view.state.doc, selection.head),
              selectionStart,
              selectionEnd,
              clientX: event.clientX,
              clientY: event.clientY,
              hasSelection: selectedRanges.length > 0,
              selectedText,
              cut: () => cutSystemClipboard(view),
              copy: () => {
                writeEditorSelectionToClipboard(view);
                view.focus();
              },
              paste: () => pasteSystemClipboard(view),
            });
            return true;
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            clearSignatureDelay();
            signatureRequestSequenceRef.current += 1;
            if (!applyingExternalDocRef.current) {
              // onChange currently carries a full string, so one conversion is
              // unavoidable. Remember it to avoid a second full conversion in
              // the controlled-doc effect after React reflects the change.
              const nextDoc = update.state.doc.toString();
              lastDocumentTextRef.current = nextDoc;
              onChangeRef.current(
                nextDoc,
                lspPositionFromOffset(update.state.doc, update.state.selection.main.head),
                update.state.selection.main.head,
              );
            }
            let inserted = "";
            update.changes.iterChanges((_fromA, _toA, _fromB, _toB, text) => {
              inserted = text.toString();
            });
            const lastChar = inserted.slice(-1);
            if (
              !applyingExternalDocRef.current
              && lastChar
              && signatureTriggersRef.current.includes(lastChar)
            ) {
              requestSignatureHelp(update.view, lastChar);
            } else if (
              signatureShownRef.current &&
              (lastChar === ")" || inserted.includes("\n"))
            ) {
              hideSignature();
            }
          } else if (update.selectionSet && signatureShownRef.current) {
            // A cursor move without an edit (mouse click, jump) dismisses it.
            hideSignature();
          }
          if (update.selectionSet || update.docChanged) {
            // Cursor state fans out into workspace UI and LSP effects. During
            // a text burst, publish the final cursor after a short idle rather
            // than causing a React render for every keypress.
            scheduleSelectionEmit(update.view, update.docChanged ? 125 : 0);
          }
          if (update.viewportChanged) emitViewport(update.view);
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    editorLanguageByView.set(view, liveTemplateLanguageForPath(pathRef.current));
    viewRef.current = view;
    emitSelection(view);
    emitViewport(view);

    // §8.18.2 单一 catalog: with a workspace action host present, the editor's
    // business bindings live as explicit editor.* actions (conflict graph,
    // Search Everywhere and Keymap settings all see them). Without one
    // (isolated usage), the legacy inline bindings below stay active.
    const actionHost = workspaceActionHostRef.current;
    let unregisterEditorActions: (() => void) | null = null;
    if (actionHost && !actionHost.isDisposed()) {
      // Handlers close over this mount's view instance; the registration is
      // removed in cleanup so a remount re-binds against the fresh view.
      unregisterEditorActions = actionHost.registerActions(buildEditorHostActions({
        save: saveHandler,
        openReplacePanel: () => openReplacePanel(view),
        expandSemanticSelection: () => expandSemanticSelection(view),
        escapeStack: () =>
          cancelLspSnippetSession(view)
          || escapeEditorSelections(view)
          || hideSignature(),
      }));
    }

    return () => {
      unregisterEditorActions?.();
      clearPendingSelectionEmit();
      clearSignatureDelay();
      requestParameterInfoRef.current = null;
      signatureRequestSequenceRef.current += 1;
      cancelActiveHoverResize(activeHoverResizeSessionRef);
      clipboardContextByView.delete(view);
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // §8.17.6/§8.18.4: clipboard helpers read the owning workspace handle +
  // unavailable callback through this registry so copy/paste works across
  // split views. The handle is refcounted; release clears the slot when the
  // last view of the workspace unmounts.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const handle = clipboardWorkspaceId ? acquireClipboardStore(clipboardWorkspaceId) : null;
    clipboardContextByView.set(view, {
      workspaceId: clipboardWorkspaceId ?? null,
      onUnavailable: (message) => onClipboardUnavailableRef.current(message),
      handle,
    });
    return () => {
      handle?.release();
      clipboardContextByView.set(view, {
        workspaceId: null,
        onUnavailable: () => {},
        handle: null,
      });
    };
  }, [clipboardWorkspaceId]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !onCommandPortChange) return;
    const token = {};
    onCommandPortChange({ fileKey, token, port: editorCommandPort(view) });
    return () => onCommandPortChange({ fileKey, token, port: null });
  }, [fileKey, onCommandPortChange]);

  useEffect(() => {
    let cancelled = false;
    void languageForPath(path)
      .then((language: Extension | null) => {
        if (cancelled || !viewRef.current) return;
        viewRef.current.dispatch({
          effects: languageCompartment.current.reconfigure(language ?? []),
        });
      })
      .catch(() => {
        if (cancelled || !viewRef.current) return;
        viewRef.current.dispatch({
          effects: languageCompartment.current.reconfigure([]),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const previous = renderedHoverRef.current;
    if (
      previous.enabled === showHoverDocumentation
      && previous.delayMs === hoverDocumentationDelayMs
    ) {
      return;
    }
    renderedHoverRef.current = {
      enabled: showHoverDocumentation,
      delayMs: hoverDocumentationDelayMs,
    };
    cancelActiveHoverResize(activeHoverResizeSessionRef);
    view.dispatch({
      effects: hoverCompartment.current.reconfigure(lspHoverExtension(
        onHoverRef,
        onPinHoverDocRef,
        activeHoverResizeSessionRef,
        showHoverDocumentation,
        hoverDocumentationDelayMs,
      )),
    });
  }, [hoverDocumentationDelayMs, showHoverDocumentation]);

  useEffect(() => {
    if (parameterInfoRequestNonce === lastParameterInfoNonceRef.current) return;
    lastParameterInfoNonceRef.current = parameterInfoRequestNonce;
    requestParameterInfoRef.current?.();
  }, [parameterInfoRequestNonce]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (renderedReadOnlyRef.current === readOnly) return;
    renderedReadOnlyRef.current = readOnly;
    view.dispatch({ effects: readOnlyCompartment.current.reconfigure(readOnlyExtension(readOnly)) });
  }, [readOnly]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (sameEditorAppearance(renderedAppearanceRef.current, appearance)) return;
    renderedAppearanceRef.current = appearance;
    view.dispatch({
      effects: appearanceCompartment.current.reconfigure(
        appearance ? editorAppearanceExtension(appearance) : [],
      ),
    });
  }, [appearance]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (renderedSoftWrapRef.current === softWrap) return;
    renderedSoftWrapRef.current = softWrap;
    view.dispatch({
      effects: wrappingCompartment.current.reconfigure(softWrap ? EditorView.lineWrapping : []),
    });
  }, [softWrap]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (sameArrayOrBothEmpty(renderedDiagnosticsRef.current, diagnostics)) return;
    renderedDiagnosticsRef.current = diagnostics;
    view.dispatch({
      effects: diagnosticsCompartment.current.reconfigure(createDiagnosticChrome(
        diagnostics,
        (line) => onLightbulbRef.current?.(line),
      )),
    });
  }, [diagnostics]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const previous = renderedOverlayRef.current;
    if (
      sameArrayOrBothEmpty(previous.highlights, highlights)
      && sameArrayOrBothEmpty(previous.inlayHints, inlayHints)
    ) {
      return;
    }
    renderedOverlayRef.current = { highlights, inlayHints };
    view.dispatch({
      effects: overlayCompartment.current.reconfigure(
        createLspOverlayChrome(view.state.doc, highlights, inlayHints),
      ),
    });
  }, [highlights, inlayHints]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const tabSize = codeStyle?.tabSize ?? 2;
    const insertSpaces = codeStyle?.insertSpaces ?? true;
    const indentSize = codeStyle?.indentSize || tabSize;
    const prev = renderedCodeStyleRef.current;
    if (prev.tabSize === tabSize && prev.insertSpaces === insertSpaces && prev.indentSize === indentSize) {
      return;
    }
    renderedCodeStyleRef.current = { tabSize, insertSpaces, indentSize };
    view.dispatch({
      effects: codeStyleCompartment.current.reconfigure([
        EditorState.tabSize.of(tabSize),
        indentUnit.of(insertSpaces ? " ".repeat(indentSize) : "\t"),
      ]),
    });
  }, [codeStyle?.tabSize, codeStyle?.indentSize, codeStyle?.insertSpaces]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (sameArrayOrBothEmpty(renderedSemanticTokensRef.current, semanticTokens)) return;
    renderedSemanticTokensRef.current = semanticTokens;
    view.dispatch({
      effects: semanticTokensCompartment.current.reconfigure(
        createLspSemanticTokenChrome(view.state.doc, semanticTokens),
      ),
    });
  }, [semanticTokens]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const previous = renderedGitRef.current;
    if (sameArrayOrBothEmpty(previous.changes, gitChanges) && previous.blame === gitBlame) return;
    renderedGitRef.current = { changes: gitChanges, blame: gitBlame };
    view.dispatch({
      effects: gitCompartment.current.reconfigure(createGitEditorChrome(
        gitChanges,
        gitBlame,
        (change) => onGitChangeClickRef.current?.(change),
      )),
    });
  }, [gitBlame, gitChanges]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const prev = renderedCoverageRef.current;
    if (prev.fileCoverage === fileCoverage && prev.coverageEnabled === coverageEnabled) {
      return;
    }
    renderedCoverageRef.current = { fileCoverage, coverageEnabled };
    view.dispatch({
      effects: coverageCompartment.current.reconfigure(
        createCoverageEditorChrome(fileCoverage ?? null, coverageEnabled),
      ),
    });
  }, [fileCoverage, coverageEnabled]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const previous = renderedDebugRef.current;
    const evaluating = !!debugEvaluate;
    if (
      sameArrayOrBothEmpty(previous.breakpoints ?? [], debugBreakpoints ?? [])
      && previous.currentLine === debugCurrentLine
      && sameInlineValues(previous.inlineValues, debugInlineValues)
      && previous.evaluating === evaluating
    ) {
      return;
    }
    renderedDebugRef.current = {
      breakpoints: debugBreakpoints,
      currentLine: debugCurrentLine,
      inlineValues: debugInlineValues,
      evaluating,
    };
    view.dispatch({
      effects: debugCompartment.current.reconfigure(buildDebugChrome(
        debugBreakpoints,
        debugCurrentLine,
        debugInlineValues,
        evaluating,
      )),
    });
  }, [buildDebugChrome, debugBreakpoints, debugCurrentLine, debugEvaluate, debugInlineValues]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (lastDocumentTextRef.current === doc) return;
    applyingExternalDocRef.current = true;
    try {
      lastDocumentTextRef.current = doc;
      const currentSelection = view.state.selection;
      const clampedAnchor = Math.min(currentSelection.main.anchor, doc.length);
      const clampedHead = Math.min(currentSelection.main.head, doc.length);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc },
        selection: { anchor: clampedAnchor, head: clampedHead },
        scrollIntoView: false,
      });
    } finally {
      applyingExternalDocRef.current = false;
    }
  }, [doc]);

  useEffect(() => {
    if (!visible) return;
    viewRef.current?.requestMeasure();
  }, [visible]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !reveal) return;
    const pos = offsetFromLspPosition(view.state.doc, reveal);
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    view.focus();
  }, [reveal]);

  return (
    <div
      ref={hostRef}
      data-soft-wrap={softWrap || undefined}
      data-column-selection={columnSelectionMode || undefined}
      className="h-full w-full"
    />
  );
}, areCodeMirrorHostPropsEqual);
