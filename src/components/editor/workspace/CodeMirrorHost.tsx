import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type MutableRefObject,
} from "react";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
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
  type Tooltip,
} from "@codemirror/view";
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
import { bracketMatching, foldGutter, indentOnInput } from "@codemirror/language";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { renderFormatted } from "../../../lib/chat/renderFormatted";
import { codeViewExtensions } from "../../../lib/codeViewTheme";
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
  ".cm-lsp-hover": {
    maxWidth: "520px",
    maxHeight: "320px",
    overflow: "auto",
    padding: "8px 10px",
    border: "1px solid var(--taomni-code-border)",
    // Prefer a surface slightly lifted from the editor bg so body text and
    // nested markdown code blocks remain legible across light/dark code themes.
    background: "var(--taomni-code-tooltip-bg)",
    color: "var(--taomni-code-text)",
    boxShadow: "0 12px 28px rgba(0, 0, 0, 0.28)",
    fontSize: "12px",
    lineHeight: "1.5",
  },
  // Nested markdown (via .taomni-chat-md) is themed in index.css so it tracks
  // --taomni-code-* even when the tooltip is portaled outside the editor host.
});

const EMPTY_HIGHLIGHTS: LspDocumentHighlight[] = [];
const EMPTY_INLAY_HINTS: LspInlayHint[] = [];
const EMPTY_SEMANTIC_TOKENS: LspSemanticToken[] = [];
const EMPTY_GIT_CHANGES: GitLineChange[] = [];

/** New empty-array props are common while LSP requests are debounced. */
function sameArrayOrBothEmpty<T>(previous: readonly T[], next: readonly T[]): boolean {
  return previous === next || (previous.length === 0 && next.length === 0);
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
    hoverTooltip((view, pos): Promise<Tooltip | null> => {
      const position = lspPositionFromOffset(view.state.doc, pos);
      return hoverRef.current(position).then((contents) => {
        if (!contents) return null;
        return {
          pos,
          above: true,
          create() {
            const dom = document.createElement("div");
            dom.className = "cm-lsp-hover taomni-chat-md";
            dom.innerHTML = renderFormatted(contents, "md") ?? "";
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

export function CodeMirrorHost({
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
}: CodeMirrorHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartment = useRef(new Compartment());
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
          activateOnTypingDelay: 50,
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
        ...lspInteractionExtensions(onHoverRef, onDefinitionRef, onReferencesRef),
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
    view.dispatch({ effects: readOnlyCompartment.current.reconfigure(readOnlyExtension(readOnly)) });
  }, [readOnly]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
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
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
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
}
