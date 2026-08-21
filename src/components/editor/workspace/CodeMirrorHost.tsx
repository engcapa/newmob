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
import type { QuickDocContent } from "./QuickDocPopup";
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
import { bracketMatching, foldGutter, indentOnInput, indentUnit } from "@codemirror/language";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { renderFormatted } from "../../../lib/chat/renderFormatted";
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
import { createWorkspaceSearchPanel, WORKSPACE_SEARCH_STYLE } from "./editorSearchPanel";
import { createLspCompletionSource } from "./lspCompletion";
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
import type { FileCoverage } from "./coverageModel";
import type { DebugStepAction } from "./dapDebugModel";
import type { GitBlameLine } from "../../../lib/git";
import { lspPositionFromOffset, offsetFromLspPosition } from "./lspPositions";
import {
  expandSelectionFromLspRanges,
  expandSyntaxSelection,
  selectionHistoryField,
  workspaceEditorKeymap,
} from "./workspaceEditorCommands";

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
  doc: string;
  visible: boolean;
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
  onChange: (doc: string) => void;
  onSave: () => void;
  onHover: (position: LspPosition) => Promise<string | null>;
  onPinHoverDoc?: (content: QuickDocContent) => void;
  onDefinition: (position: LspPosition) => Promise<boolean>;
  onReferences: (position: LspPosition) => Promise<void>;
  onComplete?: (
    position: LspPosition,
    triggerCharacter: string | null,
  ) => Promise<LspCompletionResult | null>;
  onCompleteResolve?: (raw: unknown) => Promise<LspCompletionItem | null>;
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
  completionTriggers?: string[];
  signatureTriggers?: string[];
  /** Wrap logical lines at the viewport edge (IDEA soft-wrap mode). */
  softWrap?: boolean;
  /** Effective code style driving indentUnit, tabSize, and insertSpaces. */
  codeStyle?: EffectiveCodeStyle;
  /** When enabled, a normal mouse drag creates a rectangular selection. */
  columnSelectionMode?: boolean;
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

type ResizeCorner = "se" | "sw" | "ne" | "nw";

function setupHoverResize(container: HTMLElement, handle: HTMLElement, corner: ResizeCorner = "se") {
  handle.onmousedown = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startRect = container.getBoundingClientRect();
    const startWidth = startRect.width > 0 ? startRect.width : 440;
    const startHeight = startRect.height > 0 ? startRect.height : 280;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      const maxWidth = typeof window !== "undefined" && window.innerWidth > 0 ? window.innerWidth * 0.85 : 1200;
      const maxHeight = typeof window !== "undefined" && window.innerHeight > 0 ? window.innerHeight * 0.75 : 800;

      let newWidth = startWidth;
      let newHeight = startHeight;

      if (corner === "se") {
        newWidth = startWidth + deltaX;
        newHeight = startHeight + deltaY;
      } else if (corner === "sw") {
        newWidth = startWidth - deltaX;
        newHeight = startHeight + deltaY;
      } else if (corner === "ne") {
        newWidth = startWidth + deltaX;
        newHeight = startHeight - deltaY;
      } else if (corner === "nw") {
        newWidth = startWidth - deltaX;
        newHeight = startHeight - deltaY;
      }

      newWidth = Math.max(260, Math.min(maxWidth, newWidth));
      newHeight = Math.max(100, Math.min(maxHeight, newHeight));
      container.style.width = `${Math.round(newWidth)}px`;
      container.style.height = `${Math.round(newHeight)}px`;
    };

    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };
}

function createHoverDocDom({
  title,
  contents,
  onPin,
  onClose,
}: {
  title: string;
  contents: string;
  onPin?: (content: QuickDocContent) => void;
  onClose?: () => void;
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
  titleSpan.textContent = title;
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
      onPin({ title, body: contents });
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
  body.innerHTML = renderFormatted(contents, "md") ?? "";
  container.appendChild(body);

  // 4-corner resize handles
  const gripNW = document.createElement("div");
  gripNW.className = "absolute top-0 left-0 h-4 w-4 cursor-nw-resize z-10 select-none";
  setupHoverResize(container, gripNW, "nw");
  container.appendChild(gripNW);

  const gripNE = document.createElement("div");
  gripNE.className = "absolute top-0 right-0 h-4 w-4 cursor-ne-resize z-10 select-none";
  setupHoverResize(container, gripNE, "ne");
  container.appendChild(gripNE);

  const gripSW = document.createElement("div");
  gripSW.className = "absolute bottom-0 left-0 h-4 w-4 cursor-sw-resize z-10 select-none";
  setupHoverResize(container, gripSW, "sw");
  container.appendChild(gripSW);

  const gripSE = document.createElement("div");
  gripSE.setAttribute("data-testid", "code-workspace-hover-doc-resize-handle");
  gripSE.setAttribute("aria-label", "Resize hover documentation");
  gripSE.className = "absolute bottom-0 right-0 h-4 w-4 cursor-se-resize flex items-end justify-end p-0.5 opacity-40 hover:opacity-100 select-none z-10";
  gripSE.innerHTML = `<svg viewBox="0 0 6 6" class="h-2.5 w-2.5 fill-current text-[var(--taomni-code-muted)]"><path d="M5 1L1 5M5 3L3 5M5 5L5 5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>`;
  setupHoverResize(container, gripSE, "se");
  container.appendChild(gripSE);

  return container;
}

function signatureTooltipDom(result: LspSignatureHelpResult): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-lsp-hover taomni-chat-md";
  const active = Math.min(result.activeSignature, Math.max(0, result.signatures.length - 1));
  const signature = result.signatures[active];
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
  dom.appendChild(label);
  if (result.signatures.length > 1) {
    const counter = document.createElement("div");
    counter.style.opacity = "0.6";
    counter.style.fontSize = "11px";
    counter.textContent = `${active + 1}/${result.signatures.length} overloads`;
    dom.appendChild(counter);
  }
  const documentation = parameter?.documentation ?? signature.documentation;
  if (documentation) {
    const doc = document.createElement("div");
    doc.style.marginTop = "6px";
    doc.innerHTML = renderFormatted(documentation, "md") ?? "";
    dom.appendChild(doc);
  }
  return dom;
}

function lspInteractionExtensions(
  hoverRef: MutableRefObject<(position: LspPosition) => Promise<string | null>>,
  definitionRef: MutableRefObject<(position: LspPosition) => Promise<boolean>>,
  referencesRef: MutableRefObject<(position: LspPosition) => Promise<void>>,
  onPinHoverDocRef?: MutableRefObject<((content: QuickDocContent) => void) | undefined>,
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
    hoverTooltip((view, pos): Promise<Tooltip | null> => {
      const position = lspPositionFromOffset(view.state.doc, pos);
      return hoverRef.current(position).then((contents) => {
        if (!contents) return null;
        const title = extractIdentifierAtPos(view.state.doc, pos);
        return {
          pos,
          above: true,
          create() {
            const dom = createHoverDocDom({
              title,
              contents,
              onPin: onPinHoverDocRef?.current,
              onClose: () => {
                const tooltipEl = dom.closest(".cm-tooltip") as HTMLElement | null;
                if (tooltipEl) {
                  tooltipEl.style.display = "none";
                }
              },
            });
            return { dom };
          },
        };
      });
    }),
    // Ctrl/Cmd+hover underline + pointer cursor; Ctrl/Cmd+click and middle-click jump.
    createLspHyperlinkExtension({
      onDefinition: (position) => definitionRef.current(position),
    }),
    keymap.of([
      { key: "F12", run: definitionAtSelection },
      { key: "Shift-F12", run: referencesAtSelection },
      // IDEA-like: Ctrl+B / Cmd+B go to declaration/definition at caret.
      { key: "Mod-b", run: definitionAtSelection },
      { key: "Mod-Alt-B", run: definitionAtSelection },
    ]),
  ];
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

function areCodeMirrorHostPropsEqual(prev: CodeMirrorHostProps, next: CodeMirrorHostProps): boolean {
  if (prev.path !== next.path) return false;
  if (prev.doc !== next.doc) return false;
  if (prev.visible !== next.visible) return false;
  if (prev.readOnly !== next.readOnly) return false;
  if (prev.softWrap !== next.softWrap) return false;
  if (prev.columnSelectionMode !== next.columnSelectionMode) return false;
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
  return true;
}

export const CodeMirrorHost = memo(function CodeMirrorHost({
  path,
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
  onComplete,
  onCompleteResolve,
  onSignatureHelp,
  onSelectionChange,
  onViewportChange,
  onExpandSelection,
  onLightbulb,
  onGitChangeClick,
  onToggleBreakpoint,
  onEditBreakpoint,
  onContextMenu,
  completionTriggers,
  signatureTriggers,
  softWrap = false,
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
}: CodeMirrorHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartment = useRef(new Compartment());
  const codeStyleCompartment = useRef(new Compartment());
  const diagnosticsCompartment = useRef(new Compartment());
  const overlayCompartment = useRef(new Compartment());
  const semanticTokensCompartment = useRef(new Compartment());
  const gitCompartment = useRef(new Compartment());
  const coverageCompartment = useRef(new Compartment());
  const debugCompartment = useRef(new Compartment());
  const signatureCompartment = useRef(new Compartment());
  const readOnlyCompartment = useRef(new Compartment());
  const wrappingCompartment = useRef(new Compartment());
  const signatureShownRef = useRef(false);
  /** True while applying a prop-driven doc replace so it is not treated as a user edit. */
  const applyingExternalDocRef = useRef(false);
  /** Mirrors the last full text sent through onChange or applied from props. */
  const lastDocumentTextRef = useRef(doc);
  const lastSelectionRef = useRef<{ from: number; to: number } | null>(null);
  const selectionEmitTimerRef = useRef<number | null>(null);
  const renderedDiagnosticsRef = useRef(diagnostics);
  const renderedReadOnlyRef = useRef(readOnly);
  const renderedSoftWrapRef = useRef(softWrap);
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
  const pathRef = useRef(path);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onHoverRef.current = onHover;
  onDefinitionRef.current = onDefinition;
  onReferencesRef.current = onReferences;
  onCompleteRef.current = onComplete;
  onCompleteResolveRef.current = onCompleteResolve;
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
    const hideSignature = () => {
      if (!signatureShownRef.current) return false;
      signatureShownRef.current = false;
      // Deferred: this may run from inside an update listener, where
      // synchronous dispatches are not allowed.
      window.queueMicrotask(() => {
        viewRef.current?.dispatch({
          effects: signatureCompartment.current.reconfigure([]),
        });
      });
      return true;
    };
    const requestSignatureHelp = (view: EditorView, trigger: string | null) => {
      const handler = onSignatureHelpRef.current;
      if (!handler) return false;
      const position = lspPositionFromOffset(view.state.doc, view.state.selection.main.head);
      void handler(position, trigger)
        .then((result) => {
          const current = viewRef.current;
          if (!current) return;
          if (!result || result.signatures.length === 0) {
            hideSignature();
            return;
          }
          signatureShownRef.current = true;
          const pos = current.state.selection.main.head;
          current.dispatch({
            effects: signatureCompartment.current.reconfigure(
              showTooltip.of({
                pos,
                above: true,
                create: () => ({ dom: signatureTooltipDom(result) }),
              }),
            ),
          });
        })
        .catch(() => {});
      return true;
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
              fetch: (position, trigger) =>
                onCompleteRef.current?.(position, trigger) ?? Promise.resolve(null),
              resolve: (raw) =>
                onCompleteResolveRef.current?.(raw) ?? Promise.resolve(null),
              triggerCharacters: () => completionTriggersRef.current,
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
        readOnlyCompartment.current.of(readOnlyExtension(readOnly)),
        wrappingCompartment.current.of(softWrap ? EditorView.lineWrapping : []),
        ...lspInteractionExtensions(onHoverRef, onDefinitionRef, onReferencesRef, onPinHoverDocRef),
        ...codeViewExtensions(),
        WORKSPACE_EDITOR_STYLE,
        LSP_EDITOR_STYLE,
        WORKSPACE_SEARCH_STYLE,
        // IDEA-style Tab:
        // 1) Accept the active completion (often a live template).
        // 2) Else expand an exact live/postfix template under the caret
        //    even when the popup is closed (sout + Tab without waiting).
        // 3) Else fall through to snippet tabstops / indentWithTab.
        Prec.high(keymap.of([
          {
            key: "Tab",
            run: (view) => {
              if (acceptCompletion(view)) return true;
              return expandLiveTemplateAt(
                view,
                liveTemplateLanguageForPath(pathRef.current),
              );
            },
          },
        ])),
        keymap.of([
          { key: "Mod-s", run: saveHandler },
          { key: "Mod-r", run: openReplacePanel },
          { key: "Escape", run: () => hideSignature() },
          { key: "Mod-p", run: (view) => requestSignatureHelp(view, null) },
          { key: "Ctrl-p", run: (view) => requestSignatureHelp(view, null) },
          { key: "Mod-Shift-Space", run: (view) => requestSignatureHelp(view, null) },
          { key: "Mod-w", run: expandSemanticSelection },
          ...workspaceEditorKeymap,
          ...searchKeymap,
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.domEventHandlers({
          contextmenu(event, view) {
            const handler = onContextMenuRef.current;
            if (!handler) return false;
            const coords = { x: event.clientX, y: event.clientY };
            // posAtCoords can be null in headless/jsdom; fall back to caret.
            const pos = view.posAtCoords(coords) ?? view.state.selection.main.head;
            event.preventDefault();
            const main = view.state.selection.main;
            // Click outside the selection: place the caret there (IDEA-like).
            if (pos < main.from || pos > main.to) {
              view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
            }
            const selection = view.state.selection.main;
            const selectedText = view.state.sliceDoc(selection.from, selection.to);
            const replaceSelection = (text: string) => {
              view.dispatch(view.state.replaceSelection(text));
              view.focus();
            };
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
              hasSelection: !selection.empty,
              selectedText,
              cut: () => {
                if (selection.empty) return;
                void navigator.clipboard.writeText(selectedText).catch(() => {});
                replaceSelection("");
              },
              copy: () => {
                if (selection.empty) return;
                void navigator.clipboard.writeText(selectedText).catch(() => {});
              },
              paste: () => {
                void navigator.clipboard.readText()
                  .then((text) => replaceSelection(text))
                  .catch(() => {});
              },
            });
            return true;
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            if (!applyingExternalDocRef.current) {
              // onChange currently carries a full string, so one conversion is
              // unavoidable. Remember it to avoid a second full conversion in
              // the controlled-doc effect after React reflects the change.
              const nextDoc = update.state.doc.toString();
              lastDocumentTextRef.current = nextDoc;
              onChangeRef.current(nextDoc);
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
    viewRef.current = view;
    emitSelection(view);
    emitViewport(view);
    return () => {
      clearPendingSelectionEmit();
      view.destroy();
      viewRef.current = null;
    };
  }, []);

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
    if (renderedReadOnlyRef.current === readOnly) return;
    renderedReadOnlyRef.current = readOnly;
    view.dispatch({ effects: readOnlyCompartment.current.reconfigure(readOnlyExtension(readOnly)) });
  }, [readOnly]);

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
