import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import {
  MergeView,
  unifiedMergeView,
  getChunks,
  type Chunk,
} from "@codemirror/merge";
import { ChevronDown, ChevronUp, Columns2, Loader2, RefreshCw, Rows2 } from "lucide-react";
import type { GitBlobPair } from "../../lib/git";
import {
  buildDiffOverride,
  eolOnlyDiffLabel,
  isEolOnlyDiff,
  type WhitespaceMode,
} from "../../lib/diffWhitespace";
import { codeViewExtensions } from "../../lib/codeViewTheme";
import { languageForPath } from "./diffLanguage";

type ViewMode = "split" | "unified";

interface DiffViewerProps {
  pair: GitBlobPair | null;
  loading?: boolean;
  emptyLabel?: string;
  /** When set, shown for EOL-only pairs so the user can rewrite the worktree. */
  onNormalizeLineEndings?: () => void;
  normalizeLineEndingsBusy?: boolean;
  /** P2: allow editing the worktree (new) side of the diff. */
  worktreeEditable?: boolean;
  onSaveWorktree?: (text: string) => Promise<void> | void;
}

const VIEW_KEY = "taomni.git.diff.view";
const WS_KEY = "taomni.git.diff.ws";
const SYNC_SCROLL_KEY = "taomni.git.diff.syncScroll";
const MAX_AUTO_RENDER_CHARS = 300_000;
const MAX_AUTO_RENDER_LINES = 12_000;
const CONNECTOR_WIDTH = 36;
const MIN_PANE_WIDTH = 160;
const MIN_SPLIT_CONTENT_WIDTH = MIN_PANE_WIDTH * 2;

function readPref<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T) || fallback;
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

const diffTheme = EditorView.theme({
  "&": { backgroundColor: "var(--taomni-code-bg)", color: "var(--taomni-code-text)", height: "100%" },
  ".cm-content": { caretColor: "transparent" },
  ".cm-cursor": { display: "none" },
});

const diffThemeEditable = EditorView.theme({
  "&": { backgroundColor: "var(--taomni-code-bg)", color: "var(--taomni-code-text)", height: "100%" },
  ".cm-content": { caretColor: "var(--taomni-code-text)" },
});

function baseExtensions(language: Extension | null, editable = false): Extension[] {
  const ext: Extension[] = [
    lineNumbers(),
    EditorView.editable.of(editable),
    EditorState.readOnly.of(!editable),
    ...codeViewExtensions(),
    editable ? diffThemeEditable : diffTheme,
  ];
  if (language) ext.push(language);
  return ext;
}

// Make the CodeMirror merge/unified editors fill the scroll host.
const STYLE_ID = "taomni-diff-style";
if (typeof document !== "undefined" && !document.getElementById(STYLE_ID)) {
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.taomni-diff-host {
  --taomni-git-diff-font-size: var(--taomni-code-font-size);
  --taomni-diff-editor-bg: var(--taomni-code-bg);
  --taomni-diff-gutter-bg: var(--taomni-code-gutter-bg);
  --taomni-diff-text: var(--taomni-code-text);
  --taomni-diff-muted: var(--taomni-code-muted);
  --taomni-diff-border: var(--taomni-code-border);
  --taomni-diff-scroll-track: var(--taomni-code-scrollbar-track);
  --taomni-diff-scroll-thumb: var(--taomni-code-scrollbar-thumb);
  --taomni-diff-added-bg: var(--taomni-code-diff-added-bg);
  --taomni-diff-added-word: var(--taomni-code-diff-added-word);
  --taomni-diff-deleted-bg: var(--taomni-code-diff-deleted-bg);
  --taomni-diff-deleted-word: var(--taomni-code-diff-deleted-word);
  --taomni-diff-deleted-border: var(--taomni-code-diff-deleted-border);
  --taomni-diff-modified-bg: var(--taomni-code-diff-modified-bg);
  --taomni-diff-modified-word: var(--taomni-code-diff-modified-word);
  --taomni-diff-connector-added: var(--taomni-code-diff-connector-added);
  --taomni-diff-connector-deleted: var(--taomni-code-diff-connector-deleted);
  --taomni-diff-connector-modified: var(--taomni-code-diff-connector-modified);
  --taomni-diff-connector-stroke: var(--taomni-code-diff-connector-stroke);
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

.taomni-diff-host .cm-mergeView,
.taomni-diff-host .cm-mergeViewEditors,
.taomni-diff-host .cm-editor {
  height: 100% !important;
  width: 100% !important;
  min-height: 0;
  min-width: 0;
  box-sizing: border-box;
}

.taomni-diff-host .cm-mergeView {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  overflow: hidden !important;
  background: var(--taomni-diff-editor-bg);
}

.taomni-diff-host .cm-mergeViewEditors {
  display: flex;
  flex-direction: row;
  align-items: stretch;
  flex: 1 1 auto;
  width: 100%;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

.taomni-diff-host .cm-mergeViewEditor {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  width: auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--taomni-diff-editor-bg);
}

.taomni-diff-host .cm-mergeViewEditor > .cm-editor {
  flex: 1 1 auto;
  width: 100% !important;
  min-width: 0;
  min-height: 0;
}

.taomni-diff-host .cm-mergeViewEditor + .cm-mergeViewEditor {
  border-left: 1px solid var(--taomni-diff-border);
}

.taomni-diff-host .cm-mergeView .cm-editor .cm-scroller,
.taomni-diff-host > .cm-editor .cm-scroller {
  flex: 1 1 auto;
  height: 100% !important;
  width: 100% !important;
  min-height: 0;
  min-width: 0;
  overflow-x: auto !important;
  overflow-y: auto !important;
}

.taomni-diff-host .cm-editor,
.taomni-diff-host .cm-mergeView,
.taomni-diff-host .cm-deletedChunk {
  font-family: var(--taomni-code-font-family) !important;
  font-size: var(--taomni-git-diff-font-size) !important;
  line-height: var(--taomni-code-line-height) !important;
}

.taomni-diff-host .cm-editor {
  background: var(--taomni-diff-editor-bg) !important;
  color: var(--taomni-diff-text) !important;
}

.taomni-diff-host .cm-line {
  color: var(--taomni-diff-text);
}

.taomni-diff-host .cm-gutters {
  background: var(--taomni-diff-gutter-bg) !important;
  color: var(--taomni-diff-muted) !important;
  border-right: 1px solid var(--taomni-diff-border) !important;
}

.taomni-diff-host .cm-activeLine,
.taomni-diff-host .cm-activeLineGutter {
  background: var(--taomni-code-active-line-bg) !important;
}

.taomni-diff-host .cm-selectionBackground,
.taomni-diff-host .cm-focused .cm-selectionBackground {
  background: var(--taomni-code-selection-bg) !important;
}

.taomni-diff-host .cm-merge-a .cm-changedLine {
  background-color: var(--taomni-diff-deleted-bg) !important;
}

.taomni-diff-host .cm-merge-a .cm-changedText {
  background: var(--taomni-diff-deleted-word) !important;
  border-radius: 2px;
}

.taomni-diff-host .cm-merge-b .cm-changedLine {
  background-color: var(--taomni-diff-added-bg) !important;
}

.taomni-diff-host .cm-merge-b .cm-changedText {
  background: var(--taomni-diff-added-word) !important;
  border-radius: 2px;
}

.taomni-diff-host .cm-deletedChunk {
  background: var(--taomni-diff-deleted-bg) !important;
  border-left: 3px solid var(--taomni-diff-deleted-border) !important;
  padding-left: 8px !important;
}

.taomni-diff-host .cm-deletedLine {
  background: transparent !important;
}

.taomni-diff-host .cm-deletedChunk .cm-deletedText {
  background: var(--taomni-diff-deleted-word) !important;
  border-radius: 2px;
}

.taomni-diff-host .cm-inlineChangedLine {
  background: var(--taomni-diff-modified-bg) !important;
}

.taomni-diff-host .cm-merge-a .cm-changedLineGutter,
.taomni-diff-host .cm-deletedLineGutter {
  background: var(--taomni-diff-deleted-bg) !important;
  color: var(--taomni-diff-text) !important;
}

.taomni-diff-host .cm-merge-b .cm-changedLineGutter {
  background: var(--taomni-diff-added-bg) !important;
  color: var(--taomni-diff-text) !important;
}

.taomni-diff-host .cm-inlineChangedLineGutter {
  background: var(--taomni-diff-modified-bg) !important;
  color: var(--taomni-diff-text) !important;
}

.taomni-diff-host .cm-mergeSpacer {
  background: color-mix(in srgb, var(--taomni-diff-border) 28%, transparent) !important;
  background-image: none !important;
}

.taomni-diff-host .taomni-diff-connector {
  position: relative;
  align-self: stretch;
  box-sizing: border-box;
  flex: 0 0 ${CONNECTOR_WIDTH}px;
  width: ${CONNECTOR_WIDTH}px;
  min-width: ${CONNECTOR_WIDTH}px;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background:
    linear-gradient(to right, transparent 0, color-mix(in srgb, var(--taomni-diff-border) 55%, transparent) 50%, transparent 100%),
    var(--taomni-diff-gutter-bg);
  border-left: 1px solid var(--taomni-diff-border);
  border-right: 1px solid var(--taomni-diff-border);
  cursor: col-resize;
  pointer-events: auto;
  touch-action: none;
  user-select: none;
}

.taomni-diff-host .taomni-diff-connector:focus-visible {
  outline: 1px solid var(--taomni-accent);
  outline-offset: -1px;
}

.taomni-diff-host .taomni-diff-connector.is-dragging {
  background-color: color-mix(in srgb, var(--taomni-accent) 16%, var(--taomni-diff-gutter-bg));
}

.taomni-diff-host .taomni-diff-connector svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}

.taomni-diff-host .taomni-diff-connector-path {
  stroke: var(--taomni-diff-connector-stroke);
  stroke-width: 1;
}

.taomni-diff-host .taomni-diff-connector-path.is-added {
  fill: var(--taomni-diff-connector-added);
}

.taomni-diff-host .taomni-diff-connector-path.is-deleted {
  fill: var(--taomni-diff-connector-deleted);
}

.taomni-diff-host .taomni-diff-connector-path.is-modified {
  fill: var(--taomni-diff-connector-modified);
}

.taomni-diff-host .cm-scroller {
  scrollbar-color: var(--taomni-diff-scroll-thumb) var(--taomni-diff-scroll-track);
  scrollbar-width: thin;
}

.taomni-diff-host .cm-scroller::-webkit-scrollbar {
  width: 12px;
  height: 12px;
}

.taomni-diff-host .cm-scroller::-webkit-scrollbar-track {
  background: var(--taomni-diff-scroll-track);
}

.taomni-diff-host .cm-scroller::-webkit-scrollbar-thumb {
  background: var(--taomni-diff-scroll-thumb);
  border: 3px solid var(--taomni-diff-scroll-track);
  border-radius: 6px;
}

.taomni-diff-host .cm-scroller::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--taomni-diff-scroll-thumb) 78%, var(--taomni-diff-text));
}
`;
  document.head.appendChild(style);
}

function imageDataUrl(path: string, b64: string | null): string | null {
  if (!b64) return null;
  const ext = path.toLowerCase().split(".").pop() ?? "";
  const mime =
    ext === "svg" ? "image/svg+xml" : ext === "ico" ? "image/x-icon" : `image/${ext === "jpg" ? "jpeg" : ext}`;
  return `data:${mime};base64,${b64}`;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function chunkKind(chunk: Chunk): "added" | "deleted" | "modified" {
  if (chunk.fromA === chunk.toA) return "added";
  if (chunk.fromB === chunk.toB) return "deleted";
  return "modified";
}

function sideRange(view: EditorView, chunk: Chunk, side: "a" | "b"): { top: number; bottom: number } {
  const docLength = view.state.doc.length;
  const from = side === "a" ? chunk.fromA : chunk.fromB;
  const to = side === "a" ? chunk.toA : chunk.toB;
  const end = side === "a" ? chunk.endA : chunk.endB;
  const empty = from === to;
  const startPos = clampNumber(from, 0, docLength);
  const startBlock = view.lineBlockAt(startPos);
  const top = startBlock.top - view.scrollDOM.scrollTop;
  if (empty) {
    const markerHeight = clampNumber(startBlock.height * 0.25, 4, 8);
    return { top, bottom: top + markerHeight };
  }
  const endPos = clampNumber(Math.max(startPos, end - 1), 0, docLength);
  const endBlock = view.lineBlockAt(endPos);
  return { top, bottom: endBlock.bottom - view.scrollDOM.scrollTop };
}

function connectorPath(left: { top: number; bottom: number }, right: { top: number; bottom: number }, width: number): string {
  const leftTop = Math.round(left.top * 10) / 10;
  const rightTop = Math.round(right.top * 10) / 10;
  const leftBottom = Math.max(leftTop + 3, Math.round(left.bottom * 10) / 10);
  const rightBottom = Math.max(rightTop + 3, Math.round(right.bottom * 10) / 10);
  const c1 = Math.round(width * 0.42);
  const c2 = Math.round(width * 0.58);
  return [
    `M 0 ${leftTop}`,
    `C ${c1} ${leftTop}, ${c2} ${rightTop}, ${width} ${rightTop}`,
    `L ${width} ${rightBottom}`,
    `C ${c2} ${rightBottom}, ${c1} ${leftBottom}, 0 ${leftBottom}`,
    "Z",
  ].join(" ");
}

function mappedScrollTop(source: HTMLElement, target: HTMLElement): number {
  const sourceMax = Math.max(0, source.scrollHeight - source.clientHeight);
  const targetMax = Math.max(0, target.scrollHeight - target.clientHeight);
  if (sourceMax === 0 || targetMax === 0) return 0;
  return (source.scrollTop / sourceMax) * targetMax;
}

function setImportantStyle(element: HTMLElement, property: string, value: string) {
  element.style.setProperty(property, value, "important");
}

function setImportantStyleIfChanged(element: HTMLElement, property: string, value: string): boolean {
  if (element.style.getPropertyValue(property) === value && element.style.getPropertyPriority(property) === "important") {
    return false;
  }
  setImportantStyle(element, property, value);
  return true;
}

function elementWidth(element: HTMLElement): number {
  if (element.clientWidth > 0) return element.clientWidth;
  const width = element.getBoundingClientRect().width;
  return Number.isFinite(width) && width > 0 ? width : 0;
}

interface SplitLayoutMetrics {
  width: number;
  availableWidth: number;
  leftWidth: number;
  rightWidth: number;
  effectiveRatio: number;
  disabled: boolean;
}

function splitLayoutMetrics(editorDom: HTMLElement, preferredRatio: number): SplitLayoutMetrics {
  const width = elementWidth(editorDom);
  const availableWidth = Math.max(0, width - CONNECTOR_WIDTH);
  const disabled = availableWidth < MIN_SPLIT_CONTENT_WIDTH;
  if (availableWidth === 0) {
    return { width, availableWidth, leftWidth: 0, rightWidth: 0, effectiveRatio: 0.5, disabled: true };
  }
  if (disabled) {
    const half = availableWidth / 2;
    return { width, availableWidth, leftWidth: half, rightWidth: half, effectiveRatio: 0.5, disabled: true };
  }
  const minRatio = MIN_PANE_WIDTH / availableWidth;
  const effectiveRatio = clampNumber(preferredRatio, minRatio, 1 - minRatio);
  const leftWidth = availableWidth * effectiveRatio;
  return {
    width,
    availableWidth,
    leftWidth,
    rightWidth: availableWidth - leftWidth,
    effectiveRatio,
    disabled: false,
  };
}

function applyEditorViewportLayout(view: EditorView) {
  const editor = view.dom;
  const scroller = view.scrollDOM;

  setImportantStyle(editor, "display", "flex");
  setImportantStyle(editor, "flex-direction", "column");
  setImportantStyle(editor, "height", "100%");
  setImportantStyle(editor, "width", "100%");
  setImportantStyle(editor, "min-height", "0");
  setImportantStyle(editor, "min-width", "0");
  setImportantStyle(editor, "overflow", "hidden");
  editor.style.setProperty("flex", "1 1 auto");

  scroller.style.setProperty("flex", "1 1 auto");
  setImportantStyle(scroller, "height", "100%");
  setImportantStyle(scroller, "width", "100%");
  setImportantStyle(scroller, "min-height", "0");
  setImportantStyle(scroller, "min-width", "0");
  setImportantStyle(scroller, "overflow-x", "auto");
  setImportantStyle(scroller, "overflow-y", "auto");
}

function applySplitDiffLayout(
  mv: MergeView,
  preferredRatio: number,
): ({
  editorDom: HTMLElement;
  leftWrap: HTMLElement;
  rightWrap: HTMLElement;
} & SplitLayoutMetrics) | null {
  const editorDom = mv.dom.querySelector<HTMLElement>(".cm-mergeViewEditors");
  const leftWrap = mv.a.dom.parentElement;
  const rightWrap = mv.b.dom.parentElement;
  if (
    !editorDom ||
    !leftWrap ||
    !rightWrap ||
    leftWrap.parentElement !== editorDom ||
    rightWrap.parentElement !== editorDom
  ) {
    return null;
  }

  setImportantStyle(mv.dom, "display", "flex");
  setImportantStyle(mv.dom, "flex-direction", "column");
  setImportantStyle(mv.dom, "height", "100%");
  setImportantStyle(mv.dom, "width", "100%");
  setImportantStyle(mv.dom, "min-height", "0");
  setImportantStyle(mv.dom, "min-width", "0");
  setImportantStyle(mv.dom, "overflow", "hidden");

  setImportantStyle(editorDom, "display", "flex");
  setImportantStyle(editorDom, "flex-direction", "row");
  setImportantStyle(editorDom, "align-items", "stretch");
  editorDom.style.setProperty("flex", "1 1 auto");
  setImportantStyle(editorDom, "height", "100%");
  setImportantStyle(editorDom, "width", "100%");
  setImportantStyle(editorDom, "min-height", "0");
  setImportantStyle(editorDom, "min-width", "0");
  setImportantStyle(editorDom, "overflow", "hidden");

  for (const wrap of [leftWrap, rightWrap]) {
    // Column so the nested .cm-editor stretches to the full pane width;
    // row (the previous default) sized editors to content and left the
    // scrollbar floating mid-panel instead of on each pane's right edge.
    setImportantStyle(wrap, "display", "flex");
    setImportantStyle(wrap, "flex-direction", "column");
    setImportantStyle(wrap, "align-items", "stretch");
    setImportantStyle(wrap, "min-height", "0");
    setImportantStyle(wrap, "min-width", "0");
    setImportantStyle(wrap, "overflow", "hidden");
  }

  const metrics = splitLayoutMetrics(editorDom, preferredRatio);
  const shouldApplyMeasuredWidths = metrics.width > CONNECTOR_WIDTH;
  const leftFlex = shouldApplyMeasuredWidths ? `0 0 ${metrics.leftWidth}px` : "1 1 0";
  const rightFlex = shouldApplyMeasuredWidths ? `0 0 ${metrics.rightWidth}px` : "1 1 0";
  const leftWidth = shouldApplyMeasuredWidths ? `${metrics.leftWidth}px` : "auto";
  const rightWidth = shouldApplyMeasuredWidths ? `${metrics.rightWidth}px` : "auto";
  const leftFlexChanged = setImportantStyleIfChanged(leftWrap, "flex", leftFlex);
  const leftWidthChanged = setImportantStyleIfChanged(leftWrap, "width", leftWidth);
  const rightFlexChanged = setImportantStyleIfChanged(rightWrap, "flex", rightFlex);
  const rightWidthChanged = setImportantStyleIfChanged(rightWrap, "width", rightWidth);
  const leftChanged = leftFlexChanged || leftWidthChanged;
  const rightChanged = rightFlexChanged || rightWidthChanged;

  applyEditorViewportLayout(mv.a);
  applyEditorViewportLayout(mv.b);
  if (leftChanged || rightChanged) {
    mv.a.requestMeasure();
    mv.b.requestMeasure();
  }

  return { editorDom, leftWrap, rightWrap, ...metrics };
}

interface SplitInteractionOptions {
  isSyncEnabled: () => boolean;
  readPreferredRatio: () => number;
  commitPreferredRatio: (ratio: number) => void;
  leftPaneId: string;
  rightPaneId: string;
  cancelPendingScrollCorrection: () => void;
  onLayoutReady: () => void;
}

interface DragState {
  pointerId: number;
  startClientX: number;
  startLeftWidth: number;
  startAvailableWidth: number;
  startPreferredRatio: number;
}

function setupSplitDiffInteractions(mv: MergeView, options: SplitInteractionOptions): () => void {
  const initialLayout = applySplitDiffLayout(mv, options.readPreferredRatio());
  if (!initialLayout) return () => {};
  let layout = initialLayout;
  const { editorDom, leftWrap, rightWrap } = layout;

  leftWrap.id = options.leftPaneId;
  rightWrap.id = options.rightPaneId;

  editorDom.querySelector(".taomni-diff-connector")?.remove();

  const connector = document.createElement("div");
  connector.className = "taomni-diff-connector";
  connector.dataset.testid = "git-diff-splitter";
  connector.setAttribute("role", "separator");
  connector.setAttribute("aria-orientation", "vertical");
  connector.setAttribute("aria-label", "Resize diff panes");
  connector.tabIndex = 0;
  connector.setAttribute("aria-controls", `${options.leftPaneId} ${options.rightPaneId}`);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  const pathLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  svg.appendChild(pathLayer);
  connector.appendChild(svg);
  editorDom.insertBefore(connector, rightWrap);

  const aScroll = mv.a.scrollDOM;
  const bScroll = mv.b.scrollDOM;
  aScroll.dataset.testid = "git-diff-left-scroll";
  bScroll.dataset.testid = "git-diff-right-scroll";
  let ignoreNextScroll: HTMLElement | null = null;
  let renderFrame = 0;
  let deferredRender = 0;
  let lastWidth = layout.width;
  let drag: DragState | null = null;
  let pendingClientX: number | null = null;
  let dragFrame = 0;
  let previewRatio: number | null = null;
  let previousBodyCursor = "";
  let previousBodyUserSelect = "";

  const renderConnectors = () => {
    renderFrame = 0;
    if (!connector.isConnected) return;
    const width = connector.clientWidth || CONNECTOR_WIDTH;
    const height =
      connector.clientHeight ||
      editorDom.clientHeight ||
      Math.max(aScroll.clientHeight, bScroll.clientHeight);
    if (height <= 0) return;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));

    const fragment = document.createDocumentFragment();
    for (const chunk of mv.chunks) {
      const left = sideRange(mv.a, chunk, "a");
      const right = sideRange(mv.b, chunk, "b");
      if (Math.max(left.bottom, right.bottom) < -24 || Math.min(left.top, right.top) > height + 24) {
        continue;
      }
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("class", `taomni-diff-connector-path is-${chunkKind(chunk)}`);
      path.setAttribute("d", connectorPath(left, right, width));
      fragment.appendChild(path);
    }
    pathLayer.replaceChildren(fragment);
  };

  const queueRender = () => {
    if (renderFrame === 0) {
      renderFrame = window.requestAnimationFrame(renderConnectors);
    }
  };

  const updateSeparatorA11y = () => {
    const min = layout.disabled ? 50 : Math.round((MIN_PANE_WIDTH / layout.availableWidth) * 100);
    const max = layout.disabled ? 50 : 100 - min;
    connector.setAttribute("aria-disabled", String(layout.disabled));
    connector.setAttribute("aria-valuemin", String(min));
    connector.setAttribute("aria-valuemax", String(max));
    connector.setAttribute("aria-valuenow", String(Math.round(layout.effectiveRatio * 100)));
    connector.dataset.availableWidth = String(Math.round(layout.availableWidth));
  };

  const applyLayout = (preferredRatio: number) => {
    const next = applySplitDiffLayout(mv, preferredRatio);
    if (next) {
      layout = next;
      updateSeparatorA11y();
    }
    return next;
  };

  updateSeparatorA11y();

  const restoreDocumentStyles = () => {
    if (typeof document === "undefined" || !document.body) return;
    document.body.style.cursor = previousBodyCursor;
    document.body.style.userSelect = previousBodyUserSelect;
  };

  const removeDragWindowListeners = () => {
    window.removeEventListener("pointermove", onWindowPointerMove);
    window.removeEventListener("pointerup", onWindowPointerUp);
    window.removeEventListener("pointercancel", onWindowPointerCancel);
  };

  const endDrag = (commit: boolean) => {
    const state = drag;
    if (!state) return;
    drag = null;
    pendingClientX = null;
    if (dragFrame !== 0) {
      window.cancelAnimationFrame(dragFrame);
      dragFrame = 0;
    }

    const ratio = commit ? previewRatio : null;
    const restored = applyLayout(ratio ?? state.startPreferredRatio);
    if (commit && restored && !restored.disabled) {
      options.commitPreferredRatio(restored.effectiveRatio);
    }
    previewRatio = null;
    removeDragWindowListeners();
    connector.classList.remove("is-dragging");
    restoreDocumentStyles();
    if (connector.hasPointerCapture?.(state.pointerId)) {
      try {
        connector.releasePointerCapture(state.pointerId);
      } catch {
        /* Pointer capture may already have been lost. */
      }
    }
  };

  const pointerRatio = (clientX: number, state: DragState): number | null => {
    const current = splitLayoutMetrics(editorDom, options.readPreferredRatio());
    if (
      current.availableWidth < MIN_SPLIT_CONTENT_WIDTH
      || Math.abs(current.availableWidth - state.startAvailableWidth) > 0.5
    ) {
      return null;
    }
    const leftWidth = state.startLeftWidth + clientX - state.startClientX;
    const minRatio = MIN_PANE_WIDTH / current.availableWidth;
    return clampNumber(leftWidth / current.availableWidth, minRatio, 1 - minRatio);
  };

  const applyDragAt = (clientX: number): boolean => {
    const state = drag;
    if (!state) return false;
    const ratio = pointerRatio(clientX, state);
    if (ratio == null) return false;
    const next = applyLayout(ratio);
    if (!next || next.disabled) return false;
    previewRatio = next.effectiveRatio;
    return true;
  };

  const applyPendingDrag = () => {
    dragFrame = 0;
    if (!drag || pendingClientX == null) return;
    const clientX = pendingClientX;
    pendingClientX = null;
    if (!applyDragAt(clientX)) endDrag(false);
  };

  const queueDragAt = (clientX: number) => {
    pendingClientX = clientX;
    if (dragFrame === 0) dragFrame = window.requestAnimationFrame(applyPendingDrag);
  };

  function onWindowPointerMove(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    queueDragAt(event.clientX);
  }

  function onWindowPointerUp(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    if (dragFrame !== 0) {
      window.cancelAnimationFrame(dragFrame);
      dragFrame = 0;
    }
    const applied = applyDragAt(event.clientX);
    endDrag(applied);
  }

  function onWindowPointerCancel(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    endDrag(false);
  }

  function onWindowBlur() {
    if (drag) endDrag(false);
  }

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || ("isPrimary" in event && !event.isPrimary)) return;
    options.cancelPendingScrollCorrection();
    const current = applyLayout(options.readPreferredRatio());
    if (!current || current.disabled || current.availableWidth <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    connector.focus();
    drag = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startLeftWidth: current.leftWidth,
      startAvailableWidth: current.availableWidth,
      startPreferredRatio: options.readPreferredRatio(),
    };
    previewRatio = current.effectiveRatio;
    previousBodyCursor = document.body?.style.cursor ?? "";
    previousBodyUserSelect = document.body?.style.userSelect ?? "";
    if (document.body) {
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }
    connector.classList.add("is-dragging");
    window.addEventListener("pointermove", onWindowPointerMove);
    window.addEventListener("pointerup", onWindowPointerUp);
    window.addEventListener("pointercancel", onWindowPointerCancel);
    window.addEventListener("blur", onWindowBlur);
    if (connector.setPointerCapture) {
      try {
        connector.setPointerCapture(event.pointerId);
      } catch {
        /* The window listeners remain the fallback when capture is unavailable. */
      }
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    queueDragAt(event.clientX);
  };

  const onPointerUp = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    onWindowPointerUp(event);
  };

  const onPointerCancel = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    onWindowPointerCancel(event);
  };

  const onLostPointerCapture = () => {
    if (drag) endDrag(false);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      if (drag) {
        event.preventDefault();
        endDrag(false);
      }
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(event.key)) return;
    const current = applyLayout(options.readPreferredRatio());
    if (!current) return;
    let nextRatio: number;
    if (event.key === "Enter") {
      nextRatio = 0.5;
    } else if (current.disabled) {
      return;
    } else if (event.key === "Home") {
      nextRatio = MIN_PANE_WIDTH / current.availableWidth;
    } else if (event.key === "End") {
      nextRatio = 1 - MIN_PANE_WIDTH / current.availableWidth;
    } else {
      const delta = event.shiftKey ? 0.1 : 0.02;
      nextRatio = current.effectiveRatio + (event.key === "ArrowRight" ? delta : -delta);
    }
    event.preventDefault();
    const next = applyLayout(nextRatio);
    if (next && !next.disabled) options.commitPreferredRatio(next.effectiveRatio);
  };

  const onDoubleClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    options.cancelPendingScrollCorrection();
    if (drag) endDrag(false);
    const next = applyLayout(0.5);
    if (next && !next.disabled) options.commitPreferredRatio(next.effectiveRatio);
  };

  const cancelPendingCorrection = () => options.cancelPendingScrollCorrection();
  const interactionTargets = [aScroll, bScroll, mv.a.dom, mv.b.dom];
  for (const target of interactionTargets) {
    target.addEventListener("wheel", cancelPendingCorrection, { passive: true });
    target.addEventListener("pointerdown", cancelPendingCorrection, { passive: true });
    target.addEventListener("touchstart", cancelPendingCorrection, { passive: true });
    target.addEventListener("beforeinput", cancelPendingCorrection);
    target.addEventListener("input", cancelPendingCorrection);
  }

  const handleScroll = (source: HTMLElement, target: HTMLElement) => {
    if (ignoreNextScroll === source) {
      ignoreNextScroll = null;
      queueRender();
      return;
    }
    if (options.isSyncEnabled()) {
      ignoreNextScroll = target;
      target.scrollTop = mappedScrollTop(source, target);
    }
    queueRender();
  };

  const onAScroll = () => handleScroll(aScroll, bScroll);
  const onBScroll = () => handleScroll(bScroll, aScroll);
  aScroll.addEventListener("scroll", onAScroll, { passive: true });
  bScroll.addEventListener("scroll", onBScroll, { passive: true });

  const handleResize = () => {
    const width = elementWidth(editorDom);
    if (width !== lastWidth) {
      const becameUsable = lastWidth <= CONNECTOR_WIDTH && width > CONNECTOR_WIDTH;
      if (drag) endDrag(false);
      lastWidth = width;
      applyLayout(options.readPreferredRatio());
      if (becameUsable) options.onLayoutReady();
    }
    queueRender();
  };
  const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(handleResize) : null;
  resizeObserver?.observe(mv.dom);
  resizeObserver?.observe(editorDom);
  resizeObserver?.observe(connector);
  resizeObserver?.observe(aScroll);
  resizeObserver?.observe(bScroll);
  window.addEventListener("resize", handleResize);

  connector.addEventListener("pointerdown", onPointerDown);
  connector.addEventListener("pointermove", onPointerMove);
  connector.addEventListener("pointerup", onPointerUp);
  connector.addEventListener("pointercancel", onPointerCancel);
  connector.addEventListener("lostpointercapture", onLostPointerCapture);
  connector.addEventListener("keydown", onKeyDown);
  connector.addEventListener("dblclick", onDoubleClick);

  queueRender();
  deferredRender = window.setTimeout(queueRender, 80);
  if (layout.width > CONNECTOR_WIDTH) options.onLayoutReady();

  return () => {
    options.cancelPendingScrollCorrection();
    endDrag(false);
    connector.removeEventListener("pointerdown", onPointerDown);
    connector.removeEventListener("pointermove", onPointerMove);
    connector.removeEventListener("pointerup", onPointerUp);
    connector.removeEventListener("pointercancel", onPointerCancel);
    connector.removeEventListener("lostpointercapture", onLostPointerCapture);
    connector.removeEventListener("keydown", onKeyDown);
    connector.removeEventListener("dblclick", onDoubleClick);
    for (const target of interactionTargets) {
      target.removeEventListener("wheel", cancelPendingCorrection);
      target.removeEventListener("pointerdown", cancelPendingCorrection);
      target.removeEventListener("touchstart", cancelPendingCorrection);
      target.removeEventListener("beforeinput", cancelPendingCorrection);
      target.removeEventListener("input", cancelPendingCorrection);
    }
    aScroll.removeEventListener("scroll", onAScroll);
    bScroll.removeEventListener("scroll", onBScroll);
    window.removeEventListener("resize", handleResize);
    window.removeEventListener("blur", onWindowBlur);
    resizeObserver?.disconnect();
    if (dragFrame !== 0) window.cancelAnimationFrame(dragFrame);
    if (renderFrame !== 0) window.cancelAnimationFrame(renderFrame);
    if (deferredRender !== 0) window.clearTimeout(deferredRender);
    connector.remove();
  };
}

function scrollChunkIntoView(view: EditorView, chunk: Chunk, side: "a" | "b") {
  const docLength = view.state.doc.length;
  const from = side === "a" ? chunk.fromA : chunk.fromB;
  const anchor = clampNumber(from, 0, docLength);
  const lineStart = docLength === 0 ? 0 : view.state.doc.lineAt(anchor).from;
  const scrollerRect = view.scrollDOM.getBoundingClientRect();
  const contentRect = view.contentDOM.getBoundingClientRect();
  const contentOrigin = contentRect.width > 0 && scrollerRect.width > 0
    ? contentRect.left - scrollerRect.left + view.scrollDOM.scrollLeft
    : 0;
  view.dispatch({
    selection: { anchor: lineStart },
    effects: EditorView.scrollIntoView(lineStart, {
      y: "center",
      x: "start",
      // Align the text origin rather than the gutter edge. Without this,
      // CodeMirror treats the line-number gutter as a horizontal offset.
      xMargin: Math.max(0, contentOrigin),
    }),
  });
  // CodeMirror applies the scroll effect during its next measure. Set the
  // horizontal origin immediately as well so navigation never exposes a
  // transient horizontal offset to the next interaction or assertion.
  view.scrollDOM.scrollLeft = 0;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function DiffViewer({
  pair,
  loading,
  emptyLabel,
  onNormalizeLineEndings,
  normalizeLineEndingsBusy = false,
  worktreeEditable = false,
  onSaveWorktree,
}: DiffViewerProps) {
  const instanceId = useId().replace(/:/g, "");
  const leftPaneId = `git-diff-left-pane-${instanceId}`;
  const rightPaneId = `git-diff-right-pane-${instanceId}`;
  const [view, setView] = useState<ViewMode>(() => readPref<ViewMode>(VIEW_KEY, "split"));
  const [whitespace, setWhitespace] = useState<WhitespaceMode>(() => readPref<WhitespaceMode>(WS_KEY, "none"));
  const [syncScrolling, setSyncScrolling] = useState(
    () => readPref<"true" | "false">(SYNC_SCROLL_KEY, "true") !== "false",
  );
  const [highlightWords, setHighlightWords] = useState(true);
  const [diffCount, setDiffCount] = useState(0);
  const [forceRenderLargeDiffKey, setForceRenderLargeDiffKey] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const mergeRef = useRef<MergeView | null>(null);
  const unifiedRef = useRef<EditorView | null>(null);
  const scrollCleanupRef = useRef<(() => void) | null>(null);
  const scrollZeroRef = useRef<((views: EditorView[]) => void) | null>(null);
  const cancelScrollZeroRef = useRef<(() => void) | null>(null);
  const preferredRatioRef = useRef(0.5);
  const syncScrollingRef = useRef(syncScrolling);
  const activeChunkIndexRef = useRef(-1);
  const baselineNewTextRef = useRef("");
  const canEditWorktree = worktreeEditable
    && !!onSaveWorktree
    && !!pair
    && !pair.binary
    && !pair.image
    && !pair.oversize
    && pair.newExists
    && pair.newText != null;
  const pairKey = useMemo(
    () => pair
      ? `${pair.path}\0${pair.oldPath ?? ""}\0${pair.oldSize}\0${pair.newSize}\0${pair.oldText ?? ""}\0${pair.newText ?? ""}`
      : "",
    [pair],
  );
  const complexity = useMemo(() => (pair ? diffComplexity(pair) : null), [pairKey, pair]);
  const largeTextDiff = !!complexity?.tooLarge && forceRenderLargeDiffKey !== pairKey;

  const renderable = useMemo(
    () =>
      !!pair &&
      !pair.binary &&
      !pair.image &&
      !pair.oversize &&
      !largeTextDiff &&
      (pair.oldText != null || pair.newText != null),
    [largeTextDiff, pair],
  );

  useEffect(() => writePref(VIEW_KEY, view), [view]);
  useEffect(() => writePref(WS_KEY, whitespace), [whitespace]);
  useEffect(() => writePref(SYNC_SCROLL_KEY, String(syncScrolling)), [syncScrolling]);
  useEffect(() => {
    syncScrollingRef.current = syncScrolling;
  }, [syncScrolling]);

  useEffect(() => {
    setDirty(false);
    baselineNewTextRef.current = pair?.newText ?? "";
  }, [pair]);

  const readWorktreeText = useCallback((): string | null => {
    if (mergeRef.current) return mergeRef.current.b.state.doc.toString();
    if (unifiedRef.current) return unifiedRef.current.state.doc.toString();
    return null;
  }, []);

  const handleSave = useCallback(async () => {
    if (!onSaveWorktree || !canEditWorktree) return;
    const text = readWorktreeText();
    if (text == null) return;
    setSaving(true);
    try {
      await onSaveWorktree(text);
      baselineNewTextRef.current = text;
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }, [canEditWorktree, onSaveWorktree, readWorktreeText]);

  // BUILD_EFFECT
  useEffect(() => {
    let cancelled = false;
    let correctionFrame = 0;
    let correctionGeneration = 0;
    let viewportCleanup: (() => void) | null = null;

    const cancelPendingScrollCorrection = () => {
      correctionGeneration += 1;
      if (correctionFrame !== 0) {
        window.cancelAnimationFrame(correctionFrame);
        correctionFrame = 0;
      }
    };

    const scheduleScrollZero = (views: EditorView[]) => {
      cancelPendingScrollCorrection();
      const generation = correctionGeneration;
      correctionFrame = window.requestAnimationFrame(() => {
        correctionFrame = 0;
        if (cancelled || generation !== correctionGeneration) return;
        for (const editorView of views) {
          editorView.requestMeasure({
            read: () => true,
            write: () => {
              if (
                cancelled
                || generation !== correctionGeneration
                || !editorView.dom.isConnected
                || elementWidth(editorView.dom) <= 0
              ) return;
              editorView.scrollDOM.scrollLeft = 0;
            },
          });
        }
      });
    };

    scrollZeroRef.current = scheduleScrollZero;
    cancelScrollZeroRef.current = cancelPendingScrollCorrection;
    const teardown = () => {
      cancelPendingScrollCorrection();
      viewportCleanup?.();
      viewportCleanup = null;
      scrollCleanupRef.current?.();
      scrollCleanupRef.current = null;
      mergeRef.current?.destroy();
      mergeRef.current = null;
      unifiedRef.current?.destroy();
      unifiedRef.current = null;
    };
    teardown();
    setDiffCount(0);
    activeChunkIndexRef.current = -1;
    const host = hostRef.current;
    if (loading || !host || !renderable || !pair) {
      return () => {
        cancelled = true;
        teardown();
        if (scrollZeroRef.current === scheduleScrollZero) scrollZeroRef.current = null;
        if (cancelScrollZeroRef.current === cancelPendingScrollCorrection) cancelScrollZeroRef.current = null;
      };
    }
    host.innerHTML = "";
    const oldText = pair.oldText ?? "";
    const newText = pair.newText ?? "";
    baselineNewTextRef.current = newText;
    const override = buildDiffOverride(whitespace);
    const diffConfig = override ? { override } : undefined;
    const editable = canEditWorktree;
    const updateListener = editable
      ? EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        cancelPendingScrollCorrection();
        const text = update.state.doc.toString();
        setDirty(text !== baselineNewTextRef.current);
      })
      : null;

    void languageForPath(pair.path)
      .then((language) => {
        if (cancelled || hostRef.current !== host) return;
        if (view === "split") {
          const bExtensions = [
            ...baseExtensions(language, editable),
            ...(updateListener ? [updateListener] : []),
          ];
          const mv = new MergeView({
            a: { doc: oldText, extensions: baseExtensions(language, false) },
            b: { doc: newText, extensions: bExtensions },
            parent: host,
            orientation: "a-b",
            highlightChanges: highlightWords,
            gutter: true,
            diffConfig,
          });
          mergeRef.current = mv;
          scrollCleanupRef.current = setupSplitDiffInteractions(mv, {
            isSyncEnabled: () => syncScrollingRef.current,
            readPreferredRatio: () => preferredRatioRef.current,
            commitPreferredRatio: (ratio) => {
              preferredRatioRef.current = clampNumber(ratio, 0, 1);
            },
            leftPaneId,
            rightPaneId,
            cancelPendingScrollCorrection,
            onLayoutReady: () => scheduleScrollZero([mv.a, mv.b]),
          });
          setDiffCount(mv.chunks.length);
        } else {
          const uv = new EditorView({
            doc: newText,
            parent: host,
            extensions: [
              ...baseExtensions(language, editable),
              ...(updateListener ? [updateListener] : []),
              unifiedMergeView({
                original: oldText,
                mergeControls: false,
                highlightChanges: highlightWords,
                gutter: true,
                diffConfig,
              }),
            ],
          });
          unifiedRef.current = uv;
          uv.scrollDOM.dataset.testid = "git-diff-right-scroll";
          applyEditorViewportLayout(uv);
          const cancelUnifiedCorrection = () => cancelPendingScrollCorrection();
          for (const target of [uv.scrollDOM, uv.dom]) {
            target.addEventListener("wheel", cancelUnifiedCorrection, { passive: true });
            target.addEventListener("pointerdown", cancelUnifiedCorrection, { passive: true });
            target.addEventListener("touchstart", cancelUnifiedCorrection, { passive: true });
            target.addEventListener("beforeinput", cancelUnifiedCorrection);
            target.addEventListener("input", cancelUnifiedCorrection);
          }
          let wasUsable = elementWidth(uv.dom) > 0;
          const unifiedResizeObserver = typeof ResizeObserver !== "undefined"
            ? new ResizeObserver(() => {
              const usable = elementWidth(uv.dom) > 0;
              if (usable && !wasUsable) scheduleScrollZero([uv]);
              wasUsable = usable;
            })
            : null;
          unifiedResizeObserver?.observe(uv.dom);
          viewportCleanup = () => {
            unifiedResizeObserver?.disconnect();
            for (const target of [uv.scrollDOM, uv.dom]) {
              target.removeEventListener("wheel", cancelUnifiedCorrection);
              target.removeEventListener("pointerdown", cancelUnifiedCorrection);
              target.removeEventListener("touchstart", cancelUnifiedCorrection);
              target.removeEventListener("beforeinput", cancelUnifiedCorrection);
              target.removeEventListener("input", cancelUnifiedCorrection);
            }
          };
          uv.requestMeasure();
          scheduleScrollZero([uv]);
          setDiffCount(getChunks(uv.state)?.chunks.length ?? 0);
        }
      })
      .catch(() => {
        /* language load failure: leave host empty */
      });

    return () => {
      cancelled = true;
      teardown();
      if (scrollZeroRef.current === scheduleScrollZero) scrollZeroRef.current = null;
      if (cancelScrollZeroRef.current === cancelPendingScrollCorrection) cancelScrollZeroRef.current = null;
    };
  }, [canEditWorktree, highlightWords, leftPaneId, loading, pair, renderable, rightPaneId, view, whitespace]);

  const goToChunk = useCallback((direction: 1 | -1) => {
    const mv = mergeRef.current;
    const uv = unifiedRef.current;
    const chunks = mv?.chunks ?? (uv ? getChunks(uv.state)?.chunks : null) ?? [];
    if (chunks.length === 0) return;

    const current = activeChunkIndexRef.current;
    const next =
      current < 0 || current >= chunks.length
        ? direction < 0
          ? chunks.length - 1
          : 0
        : (current + direction + chunks.length) % chunks.length;
    activeChunkIndexRef.current = next;
    const chunk = chunks[next];

    if (mv) {
      scrollChunkIntoView(mv.a, chunk, "a");
      scrollChunkIntoView(mv.b, chunk, "b");
      mv.b.focus();
      scrollZeroRef.current?.([mv.a, mv.b]);
      return;
    }

    if (uv) {
      scrollChunkIntoView(uv, chunk, "b");
      uv.focus();
      scrollZeroRef.current?.([uv]);
    }
  }, []);
  const goNext = useCallback(() => goToChunk(1), [goToChunk]);
  const goPrev = useCallback(() => goToChunk(-1), [goToChunk]);

  // RENDER
  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-[var(--taomni-text-muted)]">
        <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading diff
      </div>
    );
  }
  if (!pair) {
    return <DiffNotice text={emptyLabel ?? "Select an item to preview its diff"} />;
  }
  if (pair.oversize) {
    return (
      <DiffNotice
        text={`File too large to display a diff (${formatBytes(pair.oldSize)} → ${formatBytes(pair.newSize)}).`}
      />
    );
  }
  if (pair.image) {
    return <ImageDiff pair={pair} />;
  }
  if (pair.binary) {
    return (
      <DiffNotice
        text={`Binary file — no text diff available (${formatBytes(pair.oldSize)} → ${formatBytes(pair.newSize)}).`}
      />
    );
  }
  if (largeTextDiff && complexity) {
    return (
      <DiffNotice
        path={pair.path}
        text={`Large text diff skipped (${formatBytes(pair.oldSize)} to ${formatBytes(pair.newSize)}, ${formatLines(complexity.maxLines)}).`}
      >
        <button
          className="taomni-btn h-7 px-2 mt-3"
          type="button"
          data-testid="git-diff-render-anyway"
          onClick={() => setForceRenderLargeDiffKey(pairKey)}
        >
          Render anyway
        </button>
      </DiffNotice>
    );
  }

  const eolOnly = isEolOnlyDiff(pair.oldText, pair.newText);
  const eolLabel = eolOnly && pair.oldText != null && pair.newText != null
    ? eolOnlyDiffLabel(pair.oldText, pair.newText)
    : null;

  return (
    <div
      data-testid="git-diff-viewer"
      data-path={pair.path}
      className="h-full min-h-0 min-w-0 w-full flex flex-col bg-[var(--taomni-panel-bg)]"
    >
      {eolOnly && eolLabel ? (
        <div
          data-testid="git-diff-eol-only-banner"
          className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-amber-500/40 bg-amber-500/10 text-[11px] text-amber-700 dark:text-amber-300"
        >
          <span className="min-w-0 flex-1">{eolLabel}</span>
          {onNormalizeLineEndings ? (
            <button
              type="button"
              className="taomni-btn h-6 px-2 shrink-0"
              data-testid="git-diff-normalize-eol"
              disabled={normalizeLineEndingsBusy}
              onClick={onNormalizeLineEndings}
            >
              {normalizeLineEndingsBusy ? "Normalizing…" : "Normalize line endings"}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="h-10 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--taomni-divider)] text-[12px] bg-[var(--taomni-chrome-bg)]">
        <div className="inline-flex rounded-md p-0.5 bg-[var(--taomni-hover)] border border-[var(--taomni-divider)]">
          <button
            type="button"
            data-testid="git-diff-mode-split"
            title="Side-by-side (Split)"
            className={`h-6 px-2.5 rounded text-[11px] font-medium inline-flex items-center gap-1.5 transition-all duration-150 ${view === "split" ? "bg-[var(--taomni-card-bg)] text-[var(--taomni-text)] shadow-sm" : "text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)]"}`}
            onClick={() => setView("split")}
          >
            <Columns2 className="w-3.5 h-3.5" /> Split
          </button>
          <button
            type="button"
            data-testid="git-diff-mode-unified"
            title="Unified"
            className={`h-6 px-2.5 rounded text-[11px] font-medium inline-flex items-center gap-1.5 transition-all duration-150 ${view === "unified" ? "bg-[var(--taomni-card-bg)] text-[var(--taomni-text)] shadow-sm" : "text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)]"}`}
            onClick={() => setView("unified")}
          >
            <Rows2 className="w-3.5 h-3.5" /> Unified
          </button>
        </div>

        <div className="h-4 w-[1px] bg-[var(--taomni-divider)] mx-1" />

        {view === "split" && (
          <button
            type="button"
            data-testid="git-diff-sync-scroll"
            title={syncScrolling ? "Synchronize scrolling: on" : "Synchronize scrolling: off"}
            aria-pressed={syncScrolling}
            className={`h-7 w-7 rounded-md inline-flex items-center justify-center border transition-all duration-150 cursor-pointer ${
              syncScrolling
                ? "border-[var(--taomni-accent-soft)] bg-[color-mix(in_srgb,var(--taomni-accent)_15%,transparent)] text-[var(--taomni-accent)]"
                : "border-[var(--taomni-divider)] bg-[var(--taomni-card-bg)] text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)]"
            }`}
            onClick={() => setSyncScrolling((current) => !current)}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span className="sr-only">Synchronize scrolling</span>
          </button>
        )}

        <select
          className="h-7 bg-[var(--taomni-input-bg)] border border-[var(--taomni-input-border)] rounded-md px-2 text-[11px] text-[var(--taomni-text)] hover:border-[var(--taomni-accent-soft)] focus:outline-none transition-all duration-150 cursor-pointer"
          value={whitespace}
          title="Whitespace"
          onChange={(e) => setWhitespace(e.target.value as WhitespaceMode)}
        >
          <option value="none">Do not ignore whitespace</option>
          <option value="trailing">Ignore trailing whitespace</option>
          <option value="all">Ignore all whitespace</option>
        </select>

        <label className="inline-flex items-center gap-1.5 select-none text-[11px] font-medium text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)] cursor-pointer transition-all duration-150" title="Highlight changed words">
          <input
            type="checkbox"
            className="rounded border-[var(--taomni-input-border)] text-[var(--taomni-accent)] focus:ring-[var(--taomni-accent-soft)] w-3.5 h-3.5 cursor-pointer bg-[var(--taomni-input-bg)]"
            checked={highlightWords}
            onChange={(e) => setHighlightWords(e.target.checked)}
          />
          <span>Highlight words</span>
        </label>

        <div className="flex-1" />

        {canEditWorktree ? (
          <button
            type="button"
            className="taomni-btn h-7 px-2"
            data-testid="git-diff-save-worktree"
            disabled={!dirty || saving}
            onClick={() => void handleSave()}
            title="Save worktree file"
          >
            {saving ? "Saving…" : dirty ? "Save" : "Saved"}
          </button>
        ) : null}

        <span className="text-[11px] font-medium text-[var(--taomni-text-muted)] bg-[var(--taomni-hover)] px-2.5 py-0.5 rounded-full border border-[var(--taomni-divider)]">
          {diffCount === 0 ? "No differences" : `${diffCount} difference${diffCount === 1 ? "" : "s"}`}
        </span>

        <div className="flex items-center gap-1">
          <button
            className="h-7 w-7 rounded-md inline-flex items-center justify-center border border-[var(--taomni-divider)] bg-[var(--taomni-card-bg)] text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)] disabled:opacity-40 disabled:hover:bg-[var(--taomni-card-bg)] transition-all duration-150 cursor-pointer"
            type="button"
            data-testid="git-diff-prev"
            title="Previous change"
            disabled={!diffCount}
            onClick={goPrev}
          >
            <ChevronUp className="w-4 h-4" />
          </button>
          <button
            className="h-7 w-7 rounded-md inline-flex items-center justify-center border border-[var(--taomni-divider)] bg-[var(--taomni-card-bg)] text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)] disabled:opacity-40 disabled:hover:bg-[var(--taomni-card-bg)] transition-all duration-150 cursor-pointer"
            type="button"
            data-testid="git-diff-next"
            title="Next change"
            disabled={!diffCount}
            onClick={goNext}
          >
            <ChevronDown className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div ref={hostRef} className="taomni-diff-host flex-1 min-h-0 min-w-0 w-full overflow-hidden" />
    </div>
  );
}

function DiffNotice({ text, children, path }: { text: string; children?: ReactNode; path?: string }) {
  return (
    <div
      data-testid={path ? "git-diff-viewer" : undefined}
      data-path={path}
      className="h-full min-h-24 flex flex-col items-center justify-center px-4 text-center text-[12px] text-[var(--taomni-text-muted)]"
    >
      <div>{text}</div>
      {children}
    </div>
  );
}

function diffComplexity(pair: GitBlobPair): { tooLarge: boolean; maxLines: number } {
  const oldText = pair.oldText ?? "";
  const newText = pair.newText ?? "";
  const maxChars = Math.max(oldText.length, newText.length);
  const maxLines = Math.max(countLines(oldText), countLines(newText));
  return {
    tooLarge: maxChars > MAX_AUTO_RENDER_CHARS || maxLines > MAX_AUTO_RENDER_LINES,
    maxLines,
  };
}

function countLines(text: string): number {
  if (!text) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}

function formatLines(n: number): string {
  return `${n.toLocaleString()} line${n === 1 ? "" : "s"}`;
}

function ImageDiff({ pair }: { pair: GitBlobPair }) {
  const oldUrl = imageDataUrl(pair.oldPath ?? pair.path, pair.oldImageB64);
  const newUrl = imageDataUrl(pair.path, pair.newImageB64);
  return (
    <div className="h-full min-h-0 grid grid-cols-2 gap-2 p-3 overflow-auto bg-[var(--taomni-term-bg,#111827)]">
      <ImageSide label={`Before · ${formatBytes(pair.oldSize)}`} url={oldUrl} missing="Not present" />
      <ImageSide label={`After · ${formatBytes(pair.newSize)}`} url={newUrl} missing="Deleted" />
    </div>
  );
}

function ImageSide({ label, url, missing }: { label: string; url: string | null; missing: string }) {
  return (
    <div className="min-w-0 flex flex-col items-center gap-2">
      <div className="text-[11px] text-slate-300">{label}</div>
      {url ? (
        <img src={url} alt={label} className="max-w-full object-contain border border-[var(--taomni-divider)]" />
      ) : (
        <div className="flex-1 flex items-center justify-center text-[12px] text-slate-400">{missing}</div>
      )}
    </div>
  );
}



