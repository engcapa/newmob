import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import {
  ChangeSet,
  Compartment,
  EditorState,
  Prec,
  Transaction,
  type Extension,
  type Text,
  type TransactionSpec,
} from "@codemirror/state";
import {
  remoteTransactionAnnotation,
  type DocumentChangeDelta,
  type DocumentTransaction,
  type WorkspaceDocumentTransactionOwner,
} from "./workspaceDocumentTransactionOwner";
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
  type Rect,
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
  history,
} from "@codemirror/commands";
import type { KeyBinding } from "@codemirror/view";
import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeCompletion,
  completionStatus,
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
import { openSearchPanel, search } from "@codemirror/search";
import { renderFormatted } from "../../../lib/chat/renderFormatted";
import { readNativeTextResult, readTextResult, writeText } from "../../../lib/clipboard";
import { codeViewExtensions } from "../../../lib/codeViewTheme";
import { getAppPlatform, isTauriRuntime } from "../../../lib/runtime";
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
  LspSignatureInfo,
} from "../../../lib/editor/lsp";
import type { ParameterPopupView } from "./referenceInfoSession";
import { languageForPath } from "../../git/diffLanguage";
import {
  useWorkspaceClipboardSession,
  type GuardedSystemReadResult,
  type GuardedSystemWriteResult,
  type WorkspaceClipboardHandle,
} from "./workspaceClipboardSession";
import {
  createClipboardReadObservation,
  createClipboardWriteObservation,
  type ClipboardObservationOperation,
  type ClipboardObservationRecord,
} from "./clipboardObservationContract";
import { createWorkspaceSearchPanel, WORKSPACE_SEARCH_STYLE } from "./editorSearchPanel";
import {
  activeLspSnippetChoices,
  advanceLspSnippetTabstop,
  cancelLspSnippetSession,
  cycleLspSnippetChoice,
  createLspCompletionSource,
  LspCompletionController,
  lspSnippetSessionInvalidator,
  resetBasicCompletionSession,
  type CompletionAcceptanceDiagnostic,
  type CompletionInvocationRequest,
  type CompletionRequestIdentity,
  type CompletionRequestToken,
  type CompletionResolveGateRequest,
} from "./lspCompletion";
import type { CompletionScopeFactsState } from "./completionScopeAdapter";
import { createDiagnosticChrome } from "./lspDiagnosticChrome";
import {
  createLspOverlayChrome,
  createLspSemanticTokenChrome,
  LSP_INTELLIGENCE_THEME,
  updateLspOverlayChrome,
  updateLspSemanticTokenChrome,
} from "./lspIntelligenceChrome";
import { createLspHyperlinkExtension } from "./lspHyperlink";
import {
  createGitEditorChrome,
  updateGitEditorChrome,
  type GitLineChange,
} from "./gitEditorChrome";
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
  completeCurrentStatement,
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
  pasteEditorWithAutoImports,
  plainTextClipboardPayload,
  createRegionFoldService,
  detectLineFoldProvenance,
  selectAllEditorOccurrences,
  selectNextEditorOccurrence,
  selectionHistoryField,
  type EditorClipboardPayload,
  type RegionFoldingProvenance,
} from "./workspaceEditorCommands";
import {
  buildEditorHostActions,
  buildEditorPrimitiveKeybindings,
} from "./workspaceCodeMirrorKeymap";
import { EditorActionBridge } from "./workspaceActionHost";
import {
  RENDERED_DOC_THEME,
  renderedDocDecorationConfig,
  renderedDocDecorationField,
} from "./renderedDocCommentsExtension";
import {
  completeStatementStrategy,
  surroundWithPlan,
  type SemanticEditSource,
  type SurroundKind,
} from "./workspaceSemanticEditing";
import { observeSyntaxFacts, treeRevisionField } from "./workspaceSyntaxFacts";
import {
  desiredVisualColumnField,
  isEditorGeometryReady,
  virtualSpaceClickHandler,
  virtualSpaceOverflowField,
  virtualSpaceTypingHandler,
} from "./workspaceVirtualSpace";
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
  /** Editor view or group identifier (§8.26 / ED-MULTIVIEW-002). */
  viewId?: string;
  /** Shared document transaction owner (§8.26 / ED-MULTIVIEW-002). */
  transactionOwner?: WorkspaceDocumentTransactionOwner | null;
  /** Store revision used when the first view creates the canonical document. */
  documentRevision?: number;
  doc: string;
  visible: boolean;
  /**
   * Owning workspace instance id (§8.17.6): copy/cut write the workspace
   * clipboard session and paste reads it across every split view.
   */
  clipboardWorkspaceId?: string;
  /** Root workspace clipboard handle (§8.26.2 AA1) */
  clipboardHandle?: WorkspaceClipboardHandle | null;
  /** Surfaced when a clipboard operation degraded (system clipboard failed). */
  onClipboardUnavailable?: (message: string) => void;
  /**
   * ED-CLIP-004: typed, metadata-only observation of every settled guarded
   * clipboard result. Carries outcome/effect/permission-epoch facts, never the
   * clipboard payload, so packaged-runtime evidence can assert which enum
   * member production actually chose.
   */
  onClipboardObservation?: (record: ClipboardObservationRecord) => void;
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
    /** Repeated-call facts (§8.19.4); ordinal ≥ 2 requests expanded scope. */
    invocation?: CompletionInvocationRequest,
  ) => Promise<LspCompletionResult | null>;
  onCompleteResolve?: (
    raw: unknown,
    token: CompletionRequestToken,
  ) => Promise<LspCompletionItem | null>;
  /** Live completion request identity (§8.16.2); null = typed unavailable. */
  getCompletionIdentity: () => CompletionRequestIdentity | null;
  onCompletionDiagnostic: (kind: CompletionAcceptanceDiagnostic, detail?: string) => void;
  /** ED-COMP-004: explicit completion that falls back for missing scope facts. */
  onScopeFallback?: (state: CompletionScopeFactsState) => void;
  /**
   * §8.20.2 W1 single channel: the host only EMITS parameter trigger events
   * (typed signature-trigger char or an explicit nonce); the workspace-side
   * ParameterInfoSession owns requests, delays and cancellation.
   */
  onParameterTrigger?: (event: {
    position: LspPosition;
    anchorOffset: number;
    triggerCharacter: string | null;
    origin: "explicit" | "typing";
  }) => void;
  /** Host-reported viewport churn; the session decides dismissal. */
  onParameterInvalidate?: (reason: "doc-changed" | "caret-moved" | "closing-char") => void;
  /** Esc slot in the editor escape stack — true iff this kind consumed it. */
  onParameterEscape?: () => boolean;
  /** Controlled Parameter Info display state published by the session. */
  parameterPopup?: ParameterPopupView | null;
  onSelectionChange?: (selection: EditorSelectionRange) => void;
  onFoldProvenanceChange?: (provenance: RegionFoldingProvenance | null) => void;
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
  completionController?: LspCompletionController;
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
  /** Render all provider overloads instead of only the active signature. */
  parameterInfoShowFullSignatures?: boolean;
  /** Effective code style driving indentUnit, tabSize, and insertSpaces. */
  codeStyle?: EffectiveCodeStyle;
  /** In-place rendered documentation comments for the active source buffer. */
  renderedDocEnabled?: boolean;
  /** Provider/path language identity used by the documentation renderer. */
  renderedDocLanguageId?: string | null;
  /** Returns from a rendered block to the source view without changing text. */
  onToggleRenderedDocRaw?: () => void;
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

let nextEditorHostViewId = 0;

// Clipboard helpers close over host props through this per-view registry
// (bound at mount) so the module-level helpers stay pure and testable.
const clipboardContextByView = new WeakMap<
  EditorView,
  {
    workspaceId: string | null;
    onUnavailable: (message: string) => void;
    /** ED-CLIP-004: typed metadata-only observation of the guarded result. */
    onObservation?: (record: ClipboardObservationRecord) => void;
    /** Refcounted session handle (§8.18.4); null for legacy non-workspace views. */
    handle: WorkspaceClipboardHandle | null;
  }
>();

/**
 * ED-CLIP-004: project one settled guarded clipboard result into the typed
 * observation seam. Copy/cut report the local payload shape; paste reports the
 * shape of whatever was actually inserted (OS text or workspace fallback).
 */
function reportClipboardWriteObservation(
  view: EditorView,
  operation: ClipboardObservationOperation,
  result: GuardedSystemWriteResult,
  payload: EditorClipboardPayload,
  caretCount: number,
): void {
  const context = clipboardContextByView.get(view);
  if (!context?.onObservation) return;
  const handle = context.handle;
  const snapshot = handle?.getSnapshot();
  context.onObservation(createClipboardWriteObservation({
    operation,
    result,
    payload: {
      plainText: payload.plainText,
      segments: payload.segments,
      rectangular: payload.rectangular,
    },
    permission: snapshot?.permission ?? "unknown",
    permissionGeneration: snapshot?.permissionGeneration ?? 0,
    historyExclusion: snapshot?.exclusion ?? "recorded",
    payloadRevision: snapshot?.payloadRevision ?? 0,
    caretCount,
  }));
}

function reportClipboardReadObservation(
  view: EditorView,
  operation: ClipboardObservationOperation,
  result: GuardedSystemReadResult,
  caretCount: number,
): void {
  const context = clipboardContextByView.get(view);
  if (!context?.onObservation) return;
  const handle = context.handle;
  const snapshot = handle?.getSnapshot();
  context.onObservation(createClipboardReadObservation({
    operation,
    result,
    permission: snapshot?.permission ?? "unknown",
    permissionGeneration: snapshot?.permissionGeneration ?? 0,
    historyExclusion: snapshot?.exclusion ?? "recorded",
    payloadRevision: snapshot?.payloadRevision ?? 0,
    caretCount,
  }));
}

type ClipboardStoreLike = Pick<WorkspaceClipboardHandle, "write" | "read" | "pasteFromHistory">
  & Partial<Pick<WorkspaceClipboardHandle, "historyExclusion">>;

function workspaceStoreFor(
  context: { workspaceId: string | null; handle: WorkspaceClipboardHandle | null } | undefined,
): ClipboardStoreLike | null {
  return context?.handle ?? null;
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
    // §8.19.5 non-blocking notice when the ring declined the payload.
    const exclusion = store.historyExclusion?.() ?? "recorded";
    if (exclusion === "sensitive") {
      context?.onUnavailable("Sensitive content was kept out of clipboard history");
    } else if (exclusion === "oversized-item") {
      context?.onUnavailable("Oversized content was kept out of clipboard history");
    }
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
  const handle = context?.handle;
  const caretCountAtCopy = view.state.selection.ranges.length;
  if (handle) {
    void handle.writeSystemClipboard(payload.plainText).then((res) => {
      if (!view.dom.isConnected) return;
      if (res.outcome === "success") {
        rememberEditorClipboardPayload(view, payload);
      } else if (res.outcome === "denied") {
        rememberEditorClipboardPayload(
          view,
          payload,
          res.systemEffect === "performed" ? {} : { systemClipboardUnavailable: true },
        );
        context?.onUnavailable(
          res.systemEffect === "performed"
            ? "System clipboard permission was denied after the copy completed"
            : "System clipboard access denied — copy kept for in-workspace paste only",
        );
      } else if (res.outcome === "stale-generation") {
        rememberEditorClipboardPayload(
          view,
          payload,
          res.systemEffect === "performed" ? {} : { systemClipboardUnavailable: true },
        );
        context?.onUnavailable(
          res.systemEffect === "performed"
            ? "Clipboard permission changed after the system clipboard copy completed"
            : "Clipboard permission changed during copy — system clipboard effect is unknown; copy kept for in-workspace paste",
        );
      } else {
        rememberEditorClipboardPayload(view, payload, { systemClipboardUnavailable: true });
        context?.onUnavailable(
          "System clipboard write effect is unknown — copy kept for in-workspace paste",
        );
      }
      // Reported after the payload landed in the slot so the observation's
      // revision/exclusion fields describe the committed state, not the
      // pre-write one.
      reportClipboardWriteObservation(view, "copy", res, payload, caretCountAtCopy);
    });
    return true;
  }
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

function readCodeWorkspaceClipboardText() {
  // Linux/WebKitGTK can return an old in-process clipboard value after the
  // current X11 owner rejects conversion. Cross the Rust boundary there so a
  // real denial stays observable. Keep the established macOS/Windows strategy
  // in readTextResult(): those platforms are outside this card's native matrix.
  return isTauriRuntime() && getAppPlatform() === "linux"
    ? readNativeTextResult()
    : readTextResult();
}

function pasteSystemClipboard(view: EditorView): boolean {
  if (view.composing || view.state.readOnly) return false;
  const docAtRequest = view.state.doc;
  const selectionAtRequest = view.state.selection;
  const context = clipboardContextByView.get(view);
  const handle = context?.handle;

  const caretCountAtPaste = view.state.selection.ranges.length;

  if (handle) {
    void handle.readSystemClipboard({ readTextResult: readCodeWorkspaceClipboardText }).then((result) => {
      if (
        !view.dom.isConnected
        || view.composing
        || view.state.doc !== docAtRequest
        || !view.state.selection.eq(selectionAtRequest, true)
      ) {
        // Stale/cancelled paste: no effect and, per the shared contract, no
        // observation entry either.
        return;
      }
      reportClipboardReadObservation(view, "paste", result, caretCountAtPaste);
      if (result.outcome === "success") {
        pasteEditorClipboardPayload(
          view,
          payloadForSystemClipboardText(view, result.text),
        );
        view.focus();
      } else {
        const session = result.fallbackSession;
        if (session) {
          pasteEditorClipboardPayload(view, {
            plainText: session.plainText,
            segments: session.segments ?? undefined,
            sourceEol: session.sourceEol,
            rectangular: session.rectangular,
          });
          const reasonMsg = result.outcome === "denied"
            ? "System clipboard access denied — pasted from in-workspace session slot instead"
            : result.outcome === "stale-generation"
            ? "Clipboard permission changed during read — pasted from in-workspace session slot instead"
            : "System clipboard access denied — pasted from in-workspace session slot instead";
          context?.onUnavailable(reasonMsg);
          view.focus();
        } else {
          const reasonMsg = result.outcome === "denied"
            ? "System clipboard access denied and no in-workspace clipboard session available"
            : result.outcome === "stale-generation"
            ? "Clipboard permission changed during read and no in-workspace clipboard session available"
            : "System clipboard access denied and no in-workspace clipboard session available";
          context?.onUnavailable(reasonMsg);
        }
      }
    }).catch(() => {});
    return true;
  }

  void readCodeWorkspaceClipboardText()
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
              "System clipboard access denied — pasted from in-workspace session slot instead",
            );
            view.focus();
          } else {
            context?.onUnavailable(
              "System clipboard access denied and no in-workspace clipboard session available",
            );
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

/**
 * §8.19.5 / §8.21.3 Plain Paste: internal rectangular/segment metadata is deliberately
 * dropped — the system (or in-workspace fallback) text inserts as ONE plain
 * string per caret in a single dispatch, so one undo restores everything.
 */
function pasteAsPlainText(view: EditorView): boolean {
  if (view.composing || view.state.readOnly) return false;
  const docAtRequest = view.state.doc;
  const context = clipboardContextByView.get(view);
  const handle = context?.handle;

  const caretCountAtPlainPaste = view.state.selection.ranges.length;

  if (handle) {
    void handle.readSystemClipboard({ readTextResult: readCodeWorkspaceClipboardText }).then((result) => {
      if (!view.dom.isConnected || view.composing || view.state.doc !== docAtRequest) return;
      reportClipboardReadObservation(view, "paste-plain", result, caretCountAtPlainPaste);
      const text = result.outcome === "success" ? result.text : result.fallbackSession?.plainText ?? "";
      if (!text) {
        context?.onUnavailable(
          result.outcome === "success"
            ? "Nothing to paste"
            : result.outcome === "denied"
            ? "System clipboard access denied and no in-workspace clipboard session available"
            : "System clipboard access denied and no in-workspace clipboard session available",
        );
        return;
      }
      const ranges = [...view.state.selection.ranges].sort((a, b) => a.from - b.from);
      view.dispatch({
        changes: ranges.map((range) => ({ from: range.from, to: range.to, insert: text })),
        userEvent: "input.paste.plain",
        scrollIntoView: true,
      });
      if (result.outcome !== "success" && result.fallbackSession) {
        context?.onUnavailable(
          "System clipboard access denied — pasted from in-workspace session slot as plain text",
        );
      }
      view.focus();
    }).catch(() => {});
    return true;
  }

  void readCodeWorkspaceClipboardText()
    .then((result) => {
      if (!view.dom.isConnected || view.composing || view.state.doc !== docAtRequest) return;
      const session = workspaceStoreFor(context)?.read() ?? null;
      const text = result.ok ? result.text : session?.plainText ?? "";
      if (!text) {
        context?.onUnavailable(
          result.ok ? "Nothing to paste" : "System clipboard access denied and no in-workspace clipboard session available",
        );
        return;
      }
      // Ascending per-caret replacement of the same full text; no segments,
      // no rectangular plan, no cycling.
      const ranges = [...view.state.selection.ranges].sort((a, b) => a.from - b.from);
      view.dispatch({
        changes: ranges.map((range) => ({ from: range.from, to: range.to, insert: text })),
        userEvent: "input.paste.plain",
        scrollIntoView: true,
      });
      if (!result.ok && session) {
        context?.onUnavailable(
          "System clipboard access denied — pasted from in-workspace session slot as plain text",
        );
      }
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
  const handle = context?.handle;

  const caretCountAtCut = view.state.selection.ranges.length;

  if (handle) {
    void handle.writeSystemClipboard(payload.plainText).then((res) => {
      if (
        !view.dom.isConnected
        || view.composing
        || view.state.doc !== docAtRequest
        || !view.state.selection.eq(selectionAtRequest, true)
      ) {
        return;
      }
      if (res.outcome === "success") {
        rememberEditorClipboardPayload(view, payload);
        cutEditorSelections(view);
        view.focus();
      } else {
        rememberEditorClipboardPayload(
          view,
          payload,
          res.systemEffect === "performed" ? {} : { systemClipboardUnavailable: true },
        );
        cutEditorSelections(view);
        const reasonMsg = res.outcome === "denied"
          ? res.systemEffect === "performed"
            ? "System clipboard permission was denied after the cut copy completed"
            : "System clipboard access denied — cut kept for in-workspace paste only"
          : res.outcome === "stale-generation"
          ? res.systemEffect === "performed"
            ? "Clipboard permission changed after the system clipboard cut copy completed"
            : "Clipboard permission changed during cut — system clipboard effect is unknown; cut kept for in-workspace paste"
          : "System clipboard write effect is unknown — cut kept for in-workspace paste";
        context?.onUnavailable(reasonMsg);
        view.focus();
      }
      reportClipboardWriteObservation(view, "cut", res, payload, caretCountAtCut);
    });
    return true;
  }

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
  | "pasteAsPlainText"
  | "pasteFromHistory"
  | "pasteWithAutoImports"
  | "selectAllOccurrences"
  | "selectNextOccurrence"
  | "surroundWith"
  | "unfoldAll";

/** Options for commands that need arguments beyond the id (§8.19.8). */
export interface EditorCommandOptions {
  surroundKindId?: SurroundKind["id"];
  /** §8.19.5: index into the workspace clipboard history ring. */
  historyIndex?: number;
  /** Applied once the surround transaction dispatches, with its provenance. */
  onSemanticEditApplied?: (result: { applied: boolean; provenance: SemanticEditSource | null }) => void;
  /** ED-IMPORT-001 A4: atomic paste + import payload. */
  pastePayload?: {
    text: string;
    importStatements?: readonly string[];
  };
}

export interface EditorCommandState {
  composing: boolean;
  readOnly: boolean;
  hasSelection: boolean;
  caretCount: number;
  occurrenceSessionActive: boolean;
  completionActive: boolean;
}

export interface EditorCommandPort {
  execute: (commandId: EditorCommandId, options?: EditorCommandOptions) => boolean;
  state: () => EditorCommandState;
}

export interface EditorCommandPortRegistration {
  fileKey: string;
  token: object;
  port: EditorCommandPort | null;
}

/**
 * Apply a Surround With plan to the main selection (§8.18.8/§8.19.8). The
 * selection must span whole lines of one range; everything else is a typed
 * no-op. Provenance comes from live syntax facts when the Lezer tree aligns
 * exactly with the expanded line range and parses cleanly — otherwise the
 * plan stays honestly local-text.
 */
function applySurroundWith(
  view: EditorView,
  kindId: SurroundKind["id"],
  onApplied?: EditorCommandOptions["onSemanticEditApplied"],
): boolean {
  if (view.state.readOnly || view.composing) return false;
  const ranges = view.state.selection.ranges;
  const main = view.state.selection.main;
  if (ranges.length !== 1) return false;
  const fromLine = view.state.doc.lineAt(main.from);
  const toLine = view.state.doc.lineAt(main.to);
  const languageId = guessEditorLanguageId(view) ?? "plaintext";
  // Node evidence is observed against the EXPANDED whole-line bounds, which
  // are what statement nodes actually align to.
  const syntax = observeSyntaxFacts(view.state, fromLine.from, toLine.to);
  const plan = surroundWithPlan(kindId, {
    text: view.state.doc.sliceString(fromLine.from, toLine.to),
    from: fromLine.from,
    to: toLine.to,
    fromLineStart: main.from === fromLine.from,
    toLineEnd: main.to === toLine.to,
    rangeCount: ranges.length,
    readOnly: view.state.readOnly,
    languageId,
    syntax,
  });
  if (plan.kind === "unavailable") {
    onApplied?.({ applied: false, provenance: null });
    return false;
  }
  view.dispatch({
    changes: plan.changes,
    selection: { anchor: Math.min(plan.selection.anchor, view.state.doc.length + plan.changes.reduce((sum, change) => sum + ("insert" in change ? (change.insert as string)?.length ?? 0 : 0), 0)) },
    userEvent: "input.surround",
    scrollIntoView: true,
  });
  // One transaction == one undo entry carrying its provenance evidence.
  onApplied?.({ applied: true, provenance: plan.provenance });
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
    execute(commandId, options) {
      switch (commandId) {
        case "cloneCaretAbove": return cloneCaretAbove(view);
        case "cloneCaretBelow": return cloneCaretBelow(view);
        case "collapseCarets": return escapeEditorSelections(view);
        case "completeStatement": {
          // §8.19.8: the strategy decides between a syntax-tree-proven `;`,
          // the clearly-labelled Local/Heuristic fallback, and an explicit
          // no-op with reason. Same command the in-editor Mod-Shift-Enter
          // keymap runs, so shortcuts and direct typing share one behaviour.
          if (view.state.readOnly || view.composing) return false;
          const main = view.state.selection.main;
          const line = view.state.doc.lineAt(main.head);
          const decision = completeStatementStrategy({
            languageId: guessEditorLanguageId(view) ?? "plaintext",
            readOnly: view.state.readOnly,
            caretCount: view.state.selection.ranges.length,
            lineText: line.text,
            syntax: observeSyntaxFacts(view.state, line.from, line.to),
          });
          if (decision.kind === "unavailable") {
            options?.onSemanticEditApplied?.({ applied: false, provenance: null });
            return false;
          }
          if (decision.kind === "exact") {
            const at = Math.min(line.from + decision.insertSemicolonAt, line.to);
            view.dispatch({
              changes: { from: at, insert: ";" },
              selection: { anchor: at + 1 },
              userEvent: "input.completeStatement.syntax",
              scrollIntoView: true,
            });
            options?.onSemanticEditApplied?.({ applied: true, provenance: decision.provenance });
            return true;
          }
          const done = completeCurrentStatement(view);
          options?.onSemanticEditApplied?.({
            applied: done,
            provenance: { kind: "local-text", ruleId: decision.ruleId },
          });
          return done;
        }
        case "copy": return writeEditorSelectionToClipboard(view);
        case "cut": return cutSystemClipboard(view);
        case "foldAll": return foldAll(view) ?? false;
        case "foldSelection": return foldSelection(view);
        case "moveStatementDown": return moveStatementDown(view);
        case "moveStatementUp": return moveStatementUp(view);
        case "paste": return pasteSystemClipboard(view);
        case "pasteAsPlainText": return pasteAsPlainText(view);
        case "pasteFromHistory": {
          // §8.19.5: history paste promotes the entry to the live slot and
          // dispatches its FULL segment plan at the caret — deliberately
          // bypassing the system clipboard, which may hold newer content.
          const index = options?.historyIndex;
          if (index == null || view.composing || view.state.readOnly) return false;
          const store = workspaceStoreFor(clipboardContextByView.get(view));
          const session = index >= 0 && store ? store.pasteFromHistory(index) : null;
          if (!session) return false;
          pasteEditorClipboardPayload(view, {
            plainText: session.plainText,
            segments: session.segments ?? undefined,
            sourceEol: session.sourceEol,
            rectangular: session.rectangular,
          });
          view.focus();
          return true;
        }
        case "pasteWithAutoImports": {
          if (!options?.pastePayload) return false;
          return pasteEditorWithAutoImports(view, {
            pastedText: options.pastePayload.text,
            importStatements: options.pastePayload.importStatements,
          });
        }
        case "selectAllOccurrences": return selectAllEditorOccurrences(view);
        case "selectNextOccurrence": return selectNextEditorOccurrence(view);
        case "surroundWith": {
          // §8.19.8: every surround kind routes through this one entry point.
          const kindId = options?.surroundKindId;
          if (!kindId) return false;
          return applySurroundWith(view, kindId, options?.onSemanticEditApplied);
        }
        case "unfoldAll": return unfoldAll(view) ?? false;
      }
    },
    state: () => ({
      composing: view.composing,
      readOnly: view.state.readOnly,
      hasSelection: view.state.selection.ranges.some((range) => !range.empty),
      caretCount: view.state.selection.ranges.length,
      occurrenceSessionActive: view.state.field(occurrenceSessionField, false) ?? false,
      completionActive: completionStatus(view.state) !== null,
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
  ".cm-tooltip-autocomplete > ul > li": {
    cursor: "pointer",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected][role=option]": {
    backgroundColor: "#1d4ed8",
    color: "#ffffff",
    boxShadow: "inset 3px 0 #93c5fd",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionIcon, .cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionMatchedText": {
    color: "inherit",
    opacity: "1",
  },
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

function positionCompletionInfo(view: EditorView, list: Rect, option: Rect, info: Rect, space: Rect) {
  const gap = 4;
  const width = Math.min(400, info.right - info.left, space.right - space.left);
  const height = info.bottom - info.top;
  const right = space.right - list.right - gap;
  const left = list.left - space.left - gap;
  let x: number;
  let y: number;
  let maxHeight: number;
  if (right >= width || left >= width) {
    x = right >= width ? list.right + gap : list.left - width - gap;
    y = Math.max(space.top, Math.min(option.top, space.bottom - height));
    maxHeight = space.bottom - y;
  } else {
    // CodeMirror's narrow fallback overlaps the selected row's neighbours.
    // Stack outside the entire list so every candidate remains clickable.
    const below = space.bottom - list.bottom - gap;
    const above = list.top - space.top - gap;
    x = Math.max(space.left, Math.min(list.left, space.right - width));
    if (below >= Math.min(height, above)) {
      y = list.bottom + gap;
      maxHeight = below;
    } else {
      maxHeight = above;
      y = list.top - Math.min(height, above) - gap;
    }
  }
  return {
    style: `left: ${(x - list.left) / view.scaleX}px; top: ${(y - list.top) / view.scaleY}px; `
      + `width: ${width / view.scaleX}px; max-width: ${width / view.scaleX}px; `
      + `max-height: ${Math.max(0, maxHeight) / view.scaleY}px; box-sizing: border-box; overflow-y: auto`,
  };
}

const EMPTY_DIAGNOSTICS: LspDiagnostic[] = [];
const EMPTY_HIGHLIGHTS: LspDocumentHighlight[] = [];
const EMPTY_INLAY_HINTS: LspInlayHint[] = [];
const EMPTY_SEMANTIC_TOKENS: LspSemanticToken[] = [];
const EMPTY_GIT_CHANGES: GitLineChange[] = [];
const EMPTY_DEBUG_BREAKPOINTS: DebugBreakpointMarker[] = [];
const EMPTY_DEBUG_INLINE_VALUES: Record<string, string> = {};

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

/**
 * Pure renderer for the Parameter Info tooltip (§8.20.2 W1: display only —
 * it never issues requests and holds no request sequence).
 */
function signatureTooltipDom(
  result: {
    signatures: readonly LspSignatureInfo[];
    activeSignature: number;
    activeParameter: number;
  },
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

function foldHoverProvenanceTooltip(resolvePath: () => string | null | undefined): Extension {
  return hoverTooltip((view, pos): Tooltip | null => {
    const line = view.state.doc.lineAt(pos);
    const provenance = detectLineFoldProvenance(view.state, line.number, resolvePath());
    if (!provenance) return null;
    return {
      pos: line.from,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.className = "cm-fold-hover-tooltip px-2 py-1 text-[11px] rounded bg-[var(--taomni-code-bg)] text-[var(--taomni-code-text)] border border-[var(--taomni-code-border)] shadow-md";
        dom.setAttribute("data-testid", "code-workspace-fold-hover-tooltip");
        dom.setAttribute("data-fold-provenance", provenance);
        dom.textContent = `Region fold source: ${provenance}`;
        return { dom };
      },
    };
  }, { hoverTime: 250 });
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
  if (prev.viewId !== next.viewId) return false;
  if (prev.transactionOwner !== next.transactionOwner) return false;
  if (prev.documentRevision !== next.documentRevision) return false;
  if (prev.doc !== next.doc) return false;
  if (prev.visible !== next.visible) return false;
  if (prev.readOnly !== next.readOnly) return false;
  if (prev.renderedDocEnabled !== next.renderedDocEnabled) return false;
  if (prev.renderedDocLanguageId !== next.renderedDocLanguageId) return false;
  if (prev.softWrap !== next.softWrap) return false;
  if (!sameEditorAppearance(prev.appearance, next.appearance)) return false;
  if (prev.columnSelectionMode !== next.columnSelectionMode) return false;
  if (prev.showHoverDocumentation !== next.showHoverDocumentation) return false;
  if (prev.hoverDocumentationDelayMs !== next.hoverDocumentationDelayMs) return false;
  if (prev.parameterInfoRequestNonce !== next.parameterInfoRequestNonce) return false;
  if (prev.parameterInfoShowFullSignatures !== next.parameterInfoShowFullSignatures) return false;
  if (prev.parameterPopup !== next.parameterPopup) return false;
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

function documentReplacementChange(currentText: string, nextText: string): DocumentChangeDelta | null {
  if (currentText === nextText) return null;

  let prefix = 0;
  const maxPrefix = Math.min(currentText.length, nextText.length);
  while (prefix < maxPrefix && currentText[prefix] === nextText[prefix]) prefix += 1;

  let suffix = 0;
  const maxSuffix = Math.min(currentText.length - prefix, nextText.length - prefix);
  while (
    suffix < maxSuffix
    && currentText[currentText.length - suffix - 1] === nextText[nextText.length - suffix - 1]
  ) {
    suffix += 1;
  }

  const deleted = currentText.slice(prefix, currentText.length - suffix);
  return {
    from: prefix,
    to: currentText.length - suffix,
    insert: nextText.slice(prefix, nextText.length - suffix),
    ...(deleted ? { deleted } : {}),
  };
}

function applySharedTransactionToView(view: EditorView, transaction: DocumentTransaction): boolean {
  if (transaction.changes.length === 0) return false;
  const changes = transaction.changes.map(({ from, to, insert }) => ({ from, to, insert }));
  let changeSet: ChangeSet;
  try {
    changeSet = ChangeSet.of(changes, view.state.doc.length);
  } catch {
    return false;
  }
  view.dispatch({
    changes,
    selection: view.state.selection.map(changeSet),
    scrollIntoView: false,
    annotations: [
      remoteTransactionAnnotation.of(true),
      Transaction.addToHistory.of(false),
    ],
  });
  return true;
}

function applyDocumentSnapshotToView(view: EditorView, nextText: string): boolean {
  const change = documentReplacementChange(view.state.doc.toString(), nextText);
  if (!change) return false;
  const changes = [{ from: change.from, to: change.to, insert: change.insert }];
  let changeSet: ChangeSet;
  try {
    changeSet = ChangeSet.of(changes, view.state.doc.length);
  } catch {
    return false;
  }
  view.dispatch({
    changes,
    selection: view.state.selection.map(changeSet),
    scrollIntoView: false,
    annotations: [
      remoteTransactionAnnotation.of(true),
      Transaction.addToHistory.of(false),
    ],
  } satisfies TransactionSpec);
  return true;
}

export const CodeMirrorHost = memo(function CodeMirrorHost({
  path,
  fileKey = path,
  viewId,
  transactionOwner = null,
  documentRevision = 0,
  doc,
  visible,
  diagnostics = EMPTY_DIAGNOSTICS,
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
  clipboardHandle,
  onClipboardUnavailable,
  onClipboardObservation,
  onComplete,
  onCompleteResolve,
  getCompletionIdentity,
  onCompletionDiagnostic,
  onScopeFallback,
  onParameterTrigger,
  onParameterInvalidate,
  onParameterEscape,
  parameterPopup = null,
  onSelectionChange,
  onFoldProvenanceChange,
  onViewportChange,
  onExpandSelection,
  onLightbulb,
  onGitChangeClick,
  onToggleBreakpoint,
  onEditBreakpoint,
  onContextMenu,
  onCommandPortChange,
  completionTriggers,
  completionController,
  signatureTriggers,
  showHoverDocumentation = true,
  hoverDocumentationDelayMs = 300,
  parameterInfoRequestNonce = 0,
  parameterInfoShowFullSignatures = false,
  softWrap = false,
  appearance,
  columnSelectionMode = false,
  debugBreakpoints = EMPTY_DEBUG_BREAKPOINTS,
  debugCurrentLine,
  debugInlineValues = EMPTY_DEBUG_INLINE_VALUES,
  debugStep,
  debugRunToCursor,
  debugStop,
  debugEvaluate,
  fileCoverage,
  coverageEnabled = true,
  codeStyle,
  renderedDocEnabled = false,
  renderedDocLanguageId,
  onToggleRenderedDocRaw,
  workspaceActionHost = null,
}: CodeMirrorHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const completionControllerRef = useRef(completionController);
  completionControllerRef.current = completionController;
  const fallbackViewIdRef = useRef<string | null>(null);
  if (fallbackViewIdRef.current === null) {
    nextEditorHostViewId += 1;
    fallbackViewIdRef.current = `cm-view-${nextEditorHostViewId}`;
  }
  const editorViewId = viewId ?? fallbackViewIdRef.current;
  const viewIdRef = useRef(editorViewId);
  viewIdRef.current = editorViewId;
  const fileKeyRef = useRef(fileKey);
  fileKeyRef.current = fileKey;
  const transactionOwnerRef = useRef(transactionOwner);
  transactionOwnerRef.current = transactionOwner;
  const documentRevisionRef = useRef(documentRevision);
  documentRevisionRef.current = documentRevision;
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
  const onClipboardObservationRef = useRef((record: ClipboardObservationRecord) => {
    onClipboardObservation?.(record);
  });
  onClipboardObservationRef.current = (record: ClipboardObservationRecord) => {
    onClipboardObservation?.(record);
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
  const completionCompartment = useRef(new Compartment());
  const renderedDocCompartment = useRef(new Compartment());
  const presentResolveGateRef = useRef<((request: CompletionResolveGateRequest) => void) | null>(null);

  const buildAutocompletionExtension = useCallback(() => {
    const policy = completionController?.getPolicy();
    const autoPopup = policy?.autoPopup ?? true;
    const delayMs = policy?.delayMs ?? 100;
    const maxVisibleItems = policy?.maxVisibleItems ?? 100;
    const docDelayMs = policy?.documentation?.delayMs ?? hoverDocumentationDelayMs ?? 75;

    return autocompletion({
      activateOnTyping: autoPopup,
      activateOnTypingDelay: delayMs,
      defaultKeymap: true,
      icons: true,
      maxRenderedOptions: maxVisibleItems,
      interactionDelay: docDelayMs,
      positionInfo: positionCompletionInfo,
      optionClass: (completion) => (
        completion.type ? `cm-completion-type-${completion.type}` : ""
      ),
      override: [
        createLiveTemplateCompletionSource(() => pathRef.current),
        createLspCompletionSource({
          identity: () => getCompletionIdentityRef.current(),
          fetch: (position, trigger, token, invocation) =>
            onCompleteRef.current?.(position, trigger, token, invocation) ?? Promise.resolve(null),
          resolve: (raw, token) =>
            onCompleteResolveRef.current?.(raw, token) ?? Promise.resolve(null),
          triggerCharacters: () => completionTriggersRef.current,
          getDocumentRevision: () => getCompletionIdentityRef.current()?.documentRevision ?? -1,
          reportDiagnostic: (kind, detail) => onCompletionDiagnosticRef.current(kind, detail),
          onScopeFallback: (state) => onScopeFallbackRef.current?.(state),
          onResolveGate: (request) => presentResolveGateRef.current?.(request),
          controller: completionControllerRef.current,
          getView: () => viewRef.current,
        }),
      ],
    });
  }, [completionController, hoverDocumentationDelayMs]);
  const lastParameterInfoNonceRef = useRef(parameterInfoRequestNonce);
  const requestParameterInfoRef = useRef<(() => boolean) | null>(null);
  const activeHoverResizeSessionRef = useRef<WindowResizeSession | null>(null);
  /** True while applying a prop-driven doc replace so it is not treated as a user edit. */
  const applyingExternalDocRef = useRef(false);
  /** Mirrors the last full text sent through onChange or applied from props. */
  const lastDocumentTextRef = useRef(doc);
  /** Last controlled prop snapshot; distinguishes stale lag from a real reload. */
  const lastPropDocumentTextRef = useRef(doc);
  /** Local snapshots awaiting a controlled-prop echo, oldest first. */
  const pendingLocalDocumentEchoesRef = useRef<Array<{
    text: string;
    expectedDocumentRevision: number;
  }>>([]);
  const lastLocalDocumentRevisionRef = useRef(documentRevision);
  const rememberLocalDocumentEcho = (text: string): void => {
    const expectedDocumentRevision = Math.max(
      documentRevisionRef.current,
      lastLocalDocumentRevisionRef.current,
    ) + 1;
    lastLocalDocumentRevisionRef.current = expectedDocumentRevision;
    const pendingEchoes = pendingLocalDocumentEchoesRef.current;
    const lastPendingEcho = pendingEchoes[pendingEchoes.length - 1];
    if (
      lastPendingEcho?.text !== text
      || lastPendingEcho.expectedDocumentRevision !== expectedDocumentRevision
    ) {
      pendingEchoes.push({ text, expectedDocumentRevision });
      if (pendingEchoes.length > 64) pendingEchoes.splice(0, pendingEchoes.length - 64);
    }
  };
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
  const pendingGitUpdateFrameRef = useRef<number | null>(null);
  const renderedDebugRef = useRef({
    breakpoints: debugBreakpoints,
    currentLine: debugCurrentLine,
    inlineValues: debugInlineValues,
    evaluating: !!debugEvaluate,
  });
  const renderedDocConfigRef = useRef({
    enabled: !!renderedDocEnabled,
    languageId: renderedDocLanguageId ?? liveTemplateLanguageForPath(path),
  });
  const renderedCompletionPolicyRef = useRef<{
    autoPopup: boolean;
    delayMs: number;
    maxVisibleItems: number;
    docDelayMs: number;
  } | null>(null);
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
  const onScopeFallbackRef = useRef(onScopeFallback);
  const onParameterTriggerRef = useRef(onParameterTrigger);
  const onParameterInvalidateRef = useRef(onParameterInvalidate);
  const onParameterEscapeRef = useRef(onParameterEscape);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onFoldProvenanceChangeRef = useRef(onFoldProvenanceChange);
  const onViewportChangeRef = useRef(onViewportChange);
  const onExpandSelectionRef = useRef(onExpandSelection);
  const onLightbulbRef = useRef(onLightbulb);
  const onGitChangeClickRef = useRef(onGitChangeClick);
  const onContextMenuRef = useRef(onContextMenu);
  const onToggleRenderedDocRawRef = useRef(onToggleRenderedDocRaw);
  const completionTriggersRef = useRef(completionTriggers ?? []);
  const signatureTriggersRef = useRef(signatureTriggers ?? []);
  const columnSelectionModeRef = useRef(columnSelectionMode);
  const parameterInfoShowFullSignaturesRef = useRef(parameterInfoShowFullSignatures);
  const pathRef = useRef(path);
  // §8.19.4: set around the editor.basicCompletion close+reopen toggle so the
  // popup-close listener does not reset the repeated-call ordinal mid-toggle.
  const basicCompletionReopenRef = useRef(false);
  // §8.19.4 resolve gate banner state; the closures inside the request guard
  // staleness themselves, this only drives presentation.
  const [resolveGateUi, setResolveGateUi] = useState<{
    label: string;
    message: string;
    failed: boolean;
    retrying: boolean;
    top: number;
    left: number;
    retry: () => Promise<"committed" | "unavailable">;
    insertWithoutImport: () => boolean;
    dismiss: () => void;
  } | null>(null);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onHoverRef.current = onHover;
  onDefinitionRef.current = onDefinition;
  onReferencesRef.current = onReferences;
  onCompleteRef.current = onComplete;
  onCompleteResolveRef.current = onCompleteResolve;
  getCompletionIdentityRef.current = getCompletionIdentity;
  onCompletionDiagnosticRef.current = onCompletionDiagnostic;
  onScopeFallbackRef.current = onScopeFallback;
  onParameterTriggerRef.current = onParameterTrigger;
  onParameterInvalidateRef.current = onParameterInvalidate;
  onParameterEscapeRef.current = onParameterEscape;
  onSelectionChangeRef.current = onSelectionChange;
  onFoldProvenanceChangeRef.current = onFoldProvenanceChange;
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
  onToggleRenderedDocRawRef.current = onToggleRenderedDocRaw;

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
  parameterInfoShowFullSignaturesRef.current = parameterInfoShowFullSignatures;
  pathRef.current = path;

  const emitSelection = (view: EditorView) => {
    const handler = onSelectionChangeRef.current;
    const foldHandler = onFoldProvenanceChangeRef.current;
    if (!handler && !foldHandler) return;
    const main = view.state.selection.main;
    const from = Math.min(main.from, main.to);
    const to = Math.max(main.from, main.to);
    const previous = lastSelectionRef.current;
    if (previous?.from === from && previous.to === to) return;
    lastSelectionRef.current = { from, to };
    if (handler) {
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
    }
    if (foldHandler) {
      const line = view.state.doc.lineAt(from);
      const provenance = detectLineFoldProvenance(view.state, line.number, pathRef.current);
      foldHandler(provenance);
    }
  };

  const emitViewport = (view: EditorView) => {
    onViewportChangeRef.current?.({
      start: lspPositionFromOffset(view.state.doc, view.viewport.from),
      end: lspPositionFromOffset(view.state.doc, view.viewport.to),
    });
  };

  useEffect(() => {
    if (!hostRef.current) return;
    const owner = transactionOwnerRef.current;
    const sharedFileKey = fileKeyRef.current;
    const sharedViewId = viewIdRef.current;
    const initialDocumentText = owner && sharedFileKey
      ? owner.acquireView(sharedFileKey, sharedViewId, doc, documentRevision)
      : doc;
    lastDocumentTextRef.current = initialDocumentText;
    const initialDoc = EditorState.create({ doc: initialDocumentText }).doc;
    // §8.19.4 resolve gate banner: anchored to the caret at presentation time.
    // The gate request's own closures re-verify identity/doc before acting, so
    // a stale banner is inert — this only decides where it shows.
    const presentResolveGate = (request: CompletionResolveGateRequest) => {
      const view = viewRef.current;
      const coords = view?.coordsAtPos(request.range.from);
      const container = hostRef.current?.getBoundingClientRect();
      setResolveGateUi({
        label: request.item.label,
        message: request.message,
        failed: false,
        retrying: false,
        top: coords && container ? Math.max(0, coords.bottom - container.top + 4) : 28,
        left: coords && container ? Math.max(0, coords.left - container.left) : 12,
        retry: request.retry,
        insertWithoutImport: request.insertWithoutImport,
        dismiss: () => {
          request.dismiss();
          setResolveGateUi(null);
        },
      });
    };
    presentResolveGateRef.current = presentResolveGate;
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
    // §8.20.2 W1 single channel: the host only REPORTS trigger events. All
    // request sequencing, delays, supersede and cancellation live in the
    // workspace-side ParameterInfoSession; rendering follows the controlled
    // `parameterPopup` prop via the effect below.
    const emitParameterTrigger = (
      view: EditorView,
      triggerCharacter: string | null,
      origin: "explicit" | "typing",
    ) => {
      const handler = onParameterTriggerRef.current;
      if (!handler) return false;
      const head = view.state.selection.main.head;
      handler({
        position: lspPositionFromOffset(view.state.doc, head),
        anchorOffset: head,
        triggerCharacter,
        origin,
      });
      return true;
    };
    requestParameterInfoRef.current = () => {
      const current = viewRef.current;
      return current ? emitParameterTrigger(current, null, "explicit") : false;
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
        foldHoverProvenanceTooltip(() => pathRef.current),
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
        ...(owner && sharedFileKey ? [] : [history()]),
        // §8.19.8 treeRevision source for semantic-edit evidence envelopes.
        treeRevisionField,
        // §8.19.5 / §8.21.3 Virtual Space: overflow tracking, typing materialization,
        // vertical desired column preservation, and click-past-EOL.
        virtualSpaceOverflowField,
        desiredVisualColumnField,
        virtualSpaceTypingHandler,
        virtualSpaceClickHandler,
        bracketMatching(),
        closeBrackets(),
        indentOnInput(),
        completionCompartment.current.of(buildAutocompletionExtension()),
        // IDEA: typing `.` / `:` (or server trigger chars) opens the popup
        // immediately instead of waiting for activateOnTypingDelay.
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || update.transactions.every((tr) => !tr.isUserEvent("input.type"))) {
            return;
          }
          if (completionControllerRef.current && !completionControllerRef.current.shouldAutoTrigger(1, false)) {
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
        // §8.19.4: closing the completion popup ends the repeated-Basic-call
        // sequence, so the next explicit invocation is a fresh ordinal-1
        // request. The editor.basicCompletion toggle suppresses this once.
        EditorView.updateListener.of((update) => {
          const previous = completionStatus(update.startState);
          const current = completionStatus(update.state);
          if (previous === current || previous === null || current !== null) return;
          if (basicCompletionReopenRef.current) return;
          const identity = getCompletionIdentityRef.current();
          if (identity) resetBasicCompletionSession(identity.workspaceId, identity.fileKey);
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
        renderedDocDecorationField,
        renderedDocCompartment.current.of(renderedDocDecorationConfig.of({
          languageId: renderedDocLanguageId ?? liveTemplateLanguageForPath(pathRef.current),
          enabled: renderedDocEnabled,
          onToggleRaw: () => {
            onToggleRenderedDocRawRef.current?.();
            viewRef.current?.focus();
          },
        })),
        ...lspNavigationExtensions(onDefinitionRef, onReferencesRef),
        ...codeViewExtensions(),
        WORKSPACE_EDITOR_STYLE,
        LSP_EDITOR_STYLE,
        WORKSPACE_SEARCH_STYLE,
        RENDERED_DOC_THEME,
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
          // §8.19.2 retained primitives: with a host, ONLY the allowlisted
          // set remains here (Escape panel-close stack, closeBrackets typing,
          // defaultKeymap cursor/selection, indentWithTab); every user-visible
          // business binding resolves through the workspace action host.
          ...(buildEditorPrimitiveKeybindings(!!workspaceActionHost) as KeyBinding[]),
          ...(workspaceActionHost
            ? [
                // Esc stays an editor-local primitive stack: completion's own
                // high-precedence binding closes the popup FIRST, then snippet
                // cancel → selection collapse → §8.20.2 parameter kind. The
                // last slot consults the session via ref and returns false
                // when nothing of this kind is open, so Esc never claims a
                // keystroke it did not consume.
                { key: "Escape", run: (view: EditorView) => cancelLspSnippetSession(view) },
                { key: "Escape", run: escapeEditorSelections },
                { key: "Escape", run: () => onParameterEscapeRef.current?.() ?? false },
              ]
            : [
                // Transitional unhosted fallback: standalone embedders/tests
                // without an action host keep the pre-R1 inline bindings.
                // Must never grow new entries (see LEGACY_UNHOSTED_SPREAD).
                // Parameter Info is NOT available here — §8.20.2 requires the
                // single controller-owned channel, which needs a session.
                { key: "Mod-s", run: saveHandler },
                { key: "Mod-r", run: openReplacePanel },
                { key: "Mod-w", run: expandSemanticSelection },
              ]),
        ]),
        EditorView.domEventHandlers({
          // WebKitGTK's WebDriver pointer path can deliver the editor mouse
          // event without transferring DOM focus from the body. Keep the
          // production pointer entry equivalent to a user click before
          // CodeMirror resolves its selection position.
          mousedown(_event, view) {
            if (!view.hasFocus) view.focus();
            return false;
          },
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
            const isRemote = update.transactions.some((tr) => tr.annotation(remoteTransactionAnnotation));
            if (!applyingExternalDocRef.current && !isRemote) {
              // onChange currently carries a full string, so one conversion is
              // unavoidable. Remember it to avoid a second full conversion in
              // the controlled-doc effect after React reflects the change.
              const nextDoc = update.state.doc.toString();
              lastDocumentTextRef.current = nextDoc;
              if (transactionOwnerRef.current && fileKeyRef.current && viewIdRef.current) {
                const deltas: DocumentChangeDelta[] = [];
                update.changes.iterChanges((fromA, toA, _fromB, _toB, insertedText) => {
                  const deleted = update.startState.doc.sliceString(fromA, toA);
                  deltas.push({
                    from: fromA,
                    to: toA,
                    insert: insertedText.toString(),
                    ...(deleted ? { deleted } : {}),
                  });
                });
                if (deltas.length > 0) {
                  const sharedTransaction = transactionOwnerRef.current.dispatchTransaction(
                    fileKeyRef.current,
                    viewIdRef.current,
                    deltas,
                    "user-input",
                  );
                  if (!sharedTransaction) {
                    const rejectedView = update.view;
                    const rejectedText = nextDoc;
                    queueMicrotask(() => {
                      const currentView = viewRef.current;
                      const currentOwner = transactionOwnerRef.current;
                      const currentFileKey = fileKeyRef.current;
                      if (
                        currentView !== rejectedView
                        || !currentOwner
                        || !currentFileKey
                        || currentView.state.doc.toString() !== rejectedText
                      ) return;
                      const canonical = currentOwner.getDocument(currentFileKey);
                      if (canonical === null || canonical === rejectedText) return;
                      applyingExternalDocRef.current = true;
                      try {
                        applyDocumentSnapshotToView(currentView, canonical);
                        lastDocumentTextRef.current = currentView.state.doc.toString();
                      } finally {
                        applyingExternalDocRef.current = false;
                      }
                    });
                    return;
                  }
                }
              }
              rememberLocalDocumentEcho(nextDoc);
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
              && !isRemote
              && lastChar
              && signatureTriggersRef.current.includes(lastChar)
            ) {
              emitParameterTrigger(update.view, lastChar, "typing");
            } else if (lastChar === ")" || inserted.includes("\n")) {
              onParameterInvalidateRef.current?.("closing-char");
            } else {
              // §8.20.2: a document change closes the OLD tooltip; the next
              // trigger character opens a fresh request through the session.
              onParameterInvalidateRef.current?.("doc-changed");
            }
          } else if (update.selectionSet) {
            // A cursor move without an edit (mouse click, jump) dismisses it.
            onParameterInvalidateRef.current?.("caret-moved");
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
    let bridgeRegistration: { dispose(): void } | null = null;
    let legacyBridgeRegistration: { dispose(): void } | null = null;
    if (actionHost && !actionHost.isDisposed()) {
      // Handlers close over this mount's view instance; the registration is
      // removed in cleanup so a remount re-binds against the fresh view.
      unregisterEditorActions = actionHost.registerActions(buildEditorHostActions({
        openReplacePanel: () => openReplacePanel(view),
        expandSemanticSelection: () => expandSemanticSelection(view),
        // §8.19.4 explicit Basic Completion. With a popup already open at
        // this caret, close + restart so the second explicit call re-runs the
        // source (ordinal ≥ 2 → requestedScope expanded); the reopen flag
        // stops the popup-close listener from resetting the ordinal between
        // the two halves of the toggle.
        startBasicCompletion: () => {
          if (!viewRef.current) return false;
          if (completionStatus(view.state) === null) {
            startCompletion(view);
            return true;
          }
          basicCompletionReopenRef.current = true;
          try {
            closeCompletion(view);
            startCompletion(view);
          } finally {
            basicCompletionReopenRef.current = false;
          }
          return true;
        },
        escapeStack: () =>
          cancelLspSnippetSession(view)
          || escapeEditorSelections(view)
          || (onParameterEscapeRef.current?.() ?? false),
        isEditorGeometryReady: () => isEditorGeometryReady(view),
        runEditorCommand: (command) => command(view),
        undo: () => {
          const currentOwner = transactionOwnerRef.current;
          if (!currentOwner) return undefined;
          if (view.state.readOnly || view.composing) return false;
          if (currentOwner.getDocument(fileKeyRef.current) !== view.state.doc.toString()) return false;
          const transaction = currentOwner.undo(fileKeyRef.current, viewIdRef.current);
          if (!transaction || !applySharedTransactionToView(view, transaction)) return false;
          rememberLocalDocumentEcho(view.state.doc.toString());
          onChangeRef.current(
            view.state.doc.toString(),
            lspPositionFromOffset(view.state.doc, view.state.selection.main.head),
            view.state.selection.main.head,
          );
          return true;
        },
        redo: () => {
          const currentOwner = transactionOwnerRef.current;
          if (!currentOwner) return undefined;
          if (view.state.readOnly || view.composing) return false;
          if (currentOwner.getDocument(fileKeyRef.current) !== view.state.doc.toString()) return false;
          const transaction = currentOwner.redo(fileKeyRef.current, viewIdRef.current);
          if (!transaction || !applySharedTransactionToView(view, transaction)) return false;
          rememberLocalDocumentEcho(view.state.doc.toString());
          onChangeRef.current(
            view.state.doc.toString(),
            lspPositionFromOffset(view.state.doc, view.state.selection.main.head),
            view.state.selection.main.head,
          );
          return true;
        },
      }), { ownerViewId: viewId ?? fileKey });
      // §8.19.2 EditorActionBridge: register this mounted view so keyboard
      // dispatch knows the live view set; unmount releases it.
      bridgeRegistration = new EditorActionBridge(actionHost).registerView(sharedViewId);
      // Standalone consumers historically passed fileKey as their dispatch
      // target without a viewId. Keep that alias outside the shared-owner
      // identity path while production split views use the unique id above.
      if (!viewId && fileKey !== sharedViewId) {
        legacyBridgeRegistration = new EditorActionBridge(actionHost).registerView(fileKey);
      }
    }

    return () => {
      legacyBridgeRegistration?.dispose();
      bridgeRegistration?.dispose();
      unregisterEditorActions?.();
      clearPendingSelectionEmit();
      requestParameterInfoRef.current = null;
      cancelActiveHoverResize(activeHoverResizeSessionRef);
      clipboardContextByView.delete(view);
      view.destroy();
      viewRef.current = null;
      if (owner && sharedFileKey) owner.releaseView(sharedFileKey, sharedViewId);
    };
  }, []);

  const contextClipboardHandle = useWorkspaceClipboardSession();
  const effectiveClipboardHandle = clipboardHandle ?? contextClipboardHandle;

  // §8.17.6/§8.18.4/§8.26.2 AA1: clipboard helpers read the owning workspace
  // handle + unavailable callback through this registry so copy/paste works
  // across split views. The host attaches as a consumer with a lease.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const consumerId = `cm-${fileKey || Math.random().toString(36).slice(2, 9)}`;
    const lease = effectiveClipboardHandle?.attachConsumer(consumerId, "codemirror-host");
    clipboardContextByView.set(view, {
      workspaceId: effectiveClipboardHandle?.workspaceId ?? clipboardWorkspaceId ?? null,
      onUnavailable: (message) => onClipboardUnavailableRef.current(message),
      onObservation: (record) => onClipboardObservationRef.current(record),
      handle: effectiveClipboardHandle ?? null,
    });
    return () => {
      lease?.detach();
      clipboardContextByView.set(view, {
        workspaceId: null,
        onUnavailable: () => {},
        handle: null,
      });
    };
  }, [effectiveClipboardHandle, clipboardWorkspaceId, fileKey]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !onCommandPortChange) return;
    const token = {};
    onCommandPortChange({ fileKey, token, port: editorCommandPort(view) });
    return () => onCommandPortChange({ fileKey, token, port: null });
  }, [fileKey, onCommandPortChange]);

  // §8.19.4: a resolve gate belongs to one buffer identity; switching files
  // drops the banner (the request closures would refuse to act anyway).
  useEffect(() => {
    setResolveGateUi(null);
  }, [fileKey]);

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

  // §8.20.2 W1: the Parameter Info tooltip is pure display — it renders the
  // session-published view and nothing else. No request sequence lives here.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (!parameterPopup || parameterPopup.signatures.length === 0) {
      window.queueMicrotask(() => {
        const current = viewRef.current;
        if (!current || current !== view) return;
        current.dispatch({ effects: signatureCompartment.current.reconfigure([]) });
      });
      return;
    }
    const pos = Math.min(Math.max(0, parameterPopup.anchorOffset), view.state.doc.length);
    view.dispatch({
      effects: signatureCompartment.current.reconfigure(
        showTooltip.of({
          pos,
          above: true,
          create: () => ({
            dom: signatureTooltipDom(parameterPopup, parameterInfoShowFullSignaturesRef.current),
          }),
        }),
      ),
    });
  }, [parameterPopup]);

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

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const languageId = renderedDocLanguageId ?? liveTemplateLanguageForPath(path);
    const enabled = !!renderedDocEnabled;
    const previous = renderedDocConfigRef.current;
    if (previous.enabled === enabled && previous.languageId === languageId) return;
    renderedDocConfigRef.current = { enabled, languageId };
    view.dispatch({
      effects: renderedDocCompartment.current.reconfigure(
        renderedDocDecorationConfig.of({
          languageId,
          enabled,
          onToggleRaw: () => {
            onToggleRenderedDocRawRef.current?.();
            viewRef.current?.focus();
          },
        }),
      ),
    });
  }, [path, renderedDocEnabled, renderedDocLanguageId]);

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
      effects: updateLspOverlayChrome(highlights, inlayHints),
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
      effects: updateLspSemanticTokenChrome(semanticTokens),
    });
  }, [semanticTokens]);

  useEffect(() => {
    const previous = renderedGitRef.current;
    if (sameArrayOrBothEmpty(previous.changes, gitChanges) && previous.blame === gitBlame) return;
    const frame = window.requestAnimationFrame(() => {
      if (pendingGitUpdateFrameRef.current !== frame) return;
      pendingGitUpdateFrameRef.current = null;
      const view = viewRef.current;
      if (!view || !view.dom.isConnected) return;
      renderedGitRef.current = { changes: gitChanges, blame: gitBlame };
      view.dispatch({
        effects: updateGitEditorChrome(
          gitChanges,
          gitBlame,
          (change) => onGitChangeClickRef.current?.(change),
        ),
      });
    });
    pendingGitUpdateFrameRef.current = frame;
    return () => {
      if (pendingGitUpdateFrameRef.current !== frame) return;
      window.cancelAnimationFrame(frame);
      pendingGitUpdateFrameRef.current = null;
    };
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

  const reconfigureAutocompletion = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const policy = completionControllerRef.current?.getPolicy();
    const autoPopup = policy?.autoPopup ?? true;
    const delayMs = policy?.delayMs ?? 100;
    const maxVisibleItems = policy?.maxVisibleItems ?? 100;
    const docDelayMs = policy?.documentation?.delayMs ?? hoverDocumentationDelayMs ?? 75;

    const prev = renderedCompletionPolicyRef.current;
    if (
      prev &&
      prev.autoPopup === autoPopup &&
      prev.delayMs === delayMs &&
      prev.maxVisibleItems === maxVisibleItems &&
      prev.docDelayMs === docDelayMs
    ) {
      return;
    }
    renderedCompletionPolicyRef.current = { autoPopup, delayMs, maxVisibleItems, docDelayMs };
    view.dispatch({
      effects: completionCompartment.current.reconfigure(buildAutocompletionExtension()),
    });
  }, [buildAutocompletionExtension, hoverDocumentationDelayMs]);

  useEffect(() => {
    reconfigureAutocompletion();
  }, [reconfigureAutocompletion]);

  useEffect(() => {
    if (!completionController) return;
    return completionController.subscribe(() => {
      reconfigureAutocompletion();
    });
  }, [completionController, reconfigureAutocompletion]);

  useEffect(() => {
    const owner = transactionOwner;
    if (!owner || !fileKey) return;

    return owner.subscribe(fileKey, (transaction) => {
      if (transaction.sourceViewId === editorViewId) return;
      const currentView = viewRef.current;
      if (!currentView || !currentView.dom.isConnected) return;
      if (applySharedTransactionToView(currentView, transaction)) {
        lastDocumentTextRef.current = currentView.state.doc.toString();
      }
    });
  }, [transactionOwner, fileKey, editorViewId]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const previousPropDocument = lastPropDocumentTextRef.current;
    lastPropDocumentTextRef.current = doc;
    const pendingEchoes = pendingLocalDocumentEchoesRef.current;
    lastLocalDocumentRevisionRef.current = Math.max(
      lastLocalDocumentRevisionRef.current,
      documentRevision,
    );
    let localEchoIndex = -1;
    for (let index = pendingEchoes.length - 1; index >= 0; index -= 1) {
      const entry = pendingEchoes[index]!;
      if (
        entry.text === doc
        && entry.expectedDocumentRevision === documentRevision
      ) {
        localEchoIndex = index;
        break;
      }
    }
    if (localEchoIndex >= 0) {
      pendingEchoes.splice(0, localEchoIndex + 1);
      // A recognized echo acknowledges an earlier local transaction. During
      // native character-level input, both the view and shared owner may have
      // advanced again before React delivers this prop. Replacing the live
      // document here can corrupt an in-flight CodeMirror change set; a later
      // non-echo snapshot remains responsible for canonical reconciliation.
      lastDocumentTextRef.current = view.state.doc.toString();
      return;
    }
    while (
      pendingEchoes.length > 0
      && pendingEchoes[0]!.expectedDocumentRevision <= documentRevision
    ) {
      pendingEchoes.shift();
    }

    const owner = transactionOwnerRef.current;
    if (owner && fileKeyRef.current) {
      const canonical = owner.getDocument(fileKeyRef.current);
      if (canonical !== null) {
        const currentText = view.state.doc.toString();
        if (doc === canonical) {
          // The controlled snapshot caught up with the shared owner. If a
          // remote transaction raced this effect, repair only the changed
          // range and preserve the view's selection.
          if (currentText !== canonical) {
            applyingExternalDocRef.current = true;
            try {
              applyDocumentSnapshotToView(view, canonical);
            } finally {
              applyingExternalDocRef.current = false;
            }
          }
          lastDocumentTextRef.current = view.state.doc.toString();
          return;
        }
        if (previousPropDocument !== doc) {
          // A changed prop is an external/store snapshot. Make it one shared
          // transaction so every split sees the same replacement and history
          // remains owned by the canonical document.
          const transaction = owner.replaceDocument(
            fileKeyRef.current,
            viewIdRef.current,
            doc,
            "external-disk",
          );
          if (transaction) applySharedTransactionToView(view, transaction);
          lastDocumentTextRef.current = view.state.doc.toString();
          return;
        }
        if (currentText === canonical || lastDocumentTextRef.current === canonical) {
          // React may still expose the previous store value while a live
          // editor edit is buffered. The shared owner is authoritative.
          lastDocumentTextRef.current = currentText;
          return;
        }
      }
    }

    if (lastDocumentTextRef.current === doc) return;
    applyingExternalDocRef.current = true;
    try {
      applyDocumentSnapshotToView(view, doc);
      lastDocumentTextRef.current = view.state.doc.toString();
    } finally {
      applyingExternalDocRef.current = false;
    }
  }, [doc, documentRevision]);

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
      className="relative h-full w-full"
    >
      {resolveGateUi && (
        <div
          data-testid="completion-resolve-gate"
          className="cm-lsp-resolve-gate absolute z-50 flex max-w-md items-center gap-2 rounded border border-dashed border-amber-500/70 bg-[var(--taomni-bg-elevated,#1f2228)] px-2 py-1.5 text-xs shadow-lg"
          style={{ top: resolveGateUi.top, left: resolveGateUi.left }}
        >
          <span className="text-amber-400">⚠</span>
          <span className="min-w-0 truncate" title={`${resolveGateUi.label} — ${resolveGateUi.message}`}>
            <strong className="font-medium">{resolveGateUi.label}</strong>
            {" — "}
            {resolveGateUi.message}
          </span>
          <button
            type="button"
            data-testid="completion-resolve-gate-retry"
            disabled={resolveGateUi.retrying}
            className="shrink-0 rounded border border-[var(--taomni-border,#3a3f4b)] px-1.5 py-0.5 hover:bg-[var(--taomni-hover,#2a2e36)] disabled:opacity-50"
            onClick={() => {
              setResolveGateUi((gate) => gate ? { ...gate, retrying: true, failed: false } : gate);
              void resolveGateUi.retry().then((outcome) => {
                if (outcome === "committed") {
                  setResolveGateUi(null);
                  return;
                }
                // Retry also failed: keep the item visible with its choices.
                setResolveGateUi((gate) => gate ? { ...gate, retrying: false, failed: true } : gate);
              });
            }}
          >
            Retry
          </button>
          <button
            type="button"
            data-testid="completion-resolve-gate-insert-without-import"
            disabled={resolveGateUi.retrying}
            className="shrink-0 rounded border border-[var(--taomni-border,#3a3f4b)] px-1.5 py-0.5 hover:bg-[var(--taomni-hover,#2a2e36)] disabled:opacity-50"
            onClick={() => {
              const inserted = resolveGateUi.insertWithoutImport();
              if (inserted) setResolveGateUi(null);
            }}
          >
            Insert without import
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            data-testid="completion-resolve-gate-dismiss"
            className="shrink-0 px-1 text-[var(--taomni-text-secondary,#9aa0aa)] hover:text-[var(--taomni-text,#e6e6e6)]"
            onClick={resolveGateUi.dismiss}
          >
            ✕
          </button>
          {resolveGateUi.failed && (
            <span className="shrink-0 text-red-400" data-testid="completion-resolve-gate-failed-note">
              retry failed
            </span>
          )}
        </div>
      )}
    </div>
  );
}, areCodeMirrorHostPropsEqual);
