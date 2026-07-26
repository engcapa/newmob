import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Columns2,
  Download,
  Eye,
  File,
  Loader2,
  MoreHorizontal,
  Pin,
  X,
} from "lucide-react";
import type {
  LspCapabilitySummary,
  LspDiagnostic,
  LspDocumentHighlight,
  LspInlayHint,
  LspPosition,
  LspRange,
  LspSemanticToken,
} from "../../../lib/editor/lsp";
import type {
  LspCompletionItem,
  LspCompletionResult,
  LspSignatureHelpResult,
} from "../../../lib/editor/lsp";
import {
  CodeMirrorHost,
  type EditorContextMenuRequest,
  type EditorSelectionRange,
} from "./CodeMirrorHost";
import { mergeCompletionTriggers } from "./lspCompletion";
import type { OpenFileViewModel } from "./editorGroupTypes";
import { useContextMenu } from "../../ContextMenu";
import type { EditorGroupId } from "../../../stores/codeWorkspaceStore";
import type { GitBlameLine } from "../../../lib/git";
import type { GitLineChange } from "./gitEditorChrome";
import type { DebugBreakpointMarker } from "./debugEditorChrome";
import type { DebugStepAction } from "./dapDebugModel";
import { GitDiffPeek } from "./GitDiffPeek";
import {
  computeEditorTabScrollState,
  editorTabScrollStep,
  ensureChildVisibleScrollLeft,
  setScrollLeft,
  type EditorTabScrollState,
} from "./editorTabScroll";

export type MarkdownViewMode = "edit" | "preview" | "split";

export interface EditorRevealTarget {
  key: string;
  line: number;
  character: number;
  nonce: number;
}

interface EditorGroupProps {
  groupId: EditorGroupId;
  workspaceInstanceId: string;
  visible: boolean;
  openOrder: string[];
  openFiles: Record<string, OpenFileViewModel>;
  activeKey: string | null;
  previewKey: string | null;
  pinnedKeys: string[];
  activeFile: OpenFileViewModel | null;
  activeMarkdownMode: MarkdownViewMode;
  activeDiagnostics: LspDiagnostic[];
  activeHighlights: LspDocumentHighlight[];
  activeInlayHints: LspInlayHint[];
  activeSemanticTokens?: LspSemanticToken[];
  activeGitChanges: GitLineChange[];
  activeGitBlame: GitBlameLine | null;
  /** Breakpoints on the active file (M9), for the breakpoint gutter. */
  activeDebugBreakpoints?: DebugBreakpointMarker[];
  /** 1-based current-execution line on the active file (or null). */
  activeDebugCurrentLine?: number | null;
  /** Selected-frame locals rendered as inline values on the active file. */
  activeDebugInlineValues?: Record<string, string>;
  onToggleBreakpoint?: (line: number) => void;
  onEditBreakpoint?: (line: number) => void;
  /** Debugger keymap actions (F7/F8/F9/Ctrl+F2/Alt+F9); null when idle. */
  debugStep?: ((action: DebugStepAction) => void) | null;
  debugRunToCursor?: ((line: number) => void) | null;
  debugStop?: (() => void) | null;
  /** Hover evaluation on the active file while stopped there. */
  debugEvaluate?: ((expression: string) => Promise<{ value: string; type: string | null } | null>) | null;
  activeCapabilities: LspCapabilitySummary | null;
  activeLspSyncing: boolean;
  lspStatusPill: ReactNode;
  breadcrumbs: ReactNode;
  revealTarget: EditorRevealTarget | null;
  editorPaneRef: MutableRefObject<HTMLElement | null>;
  editorPaneStyle: CSSProperties;
  onActivate: (key: string) => void;
  onActivateGroup: () => void;
  onClose: (key: string) => void;
  onPin: (key: string, pinned: boolean) => void;
  onPromotePreview: (key: string) => void;
  onCloseOthers: (key: string) => void;
  onCloseRight: (key: string) => void;
  onCloseUnmodified: () => void;
  onCloseAll: () => void;
  onSplitRight: (key: string) => void;
  onSplitDown: (key: string) => void;
  onCopyPath: (key: string, absolute: boolean) => void;
  onRevealInTree: (key: string) => void;
  onRevealInSystem: (key: string) => void;
  onOpenInTerminal: (key: string) => void;
  onLocalHistory?: (key: string) => void;
  /** Fetch attached sources for a decompiled library buffer (jdtls Java classes). */
  onDownloadSources?: (key: string) => void;
  /** Keys whose sources are currently downloading (drives the banner spinner). */
  downloadingSourcesKeys?: string[];
  onMarkdownModeChange: (mode: MarkdownViewMode) => void;
  onChangeText: (key: string, text: string) => void;
  onSave: (key: string) => void;
  onHover: (file: OpenFileViewModel, position: LspPosition) => Promise<string | null>;
  onDefinition: (file: OpenFileViewModel, position: LspPosition) => Promise<boolean>;
  onReferences: (file: OpenFileViewModel, position: LspPosition) => Promise<void>;
  onComplete: (
    file: OpenFileViewModel,
    position: LspPosition,
    trigger: string | null,
  ) => Promise<LspCompletionResult | null>;
  onCompleteResolve: (file: OpenFileViewModel, raw: unknown) => Promise<LspCompletionItem | null>;
  onSignatureHelp: (
    file: OpenFileViewModel,
    position: LspPosition,
    trigger: string | null,
  ) => Promise<LspSignatureHelpResult | null>;
  onSelectionChange: (selection: EditorSelectionRange) => void;
  onViewportChange: (range: LspRange) => void;
  onExpandSelection: (file: OpenFileViewModel, selection: EditorSelectionRange) => Promise<LspRange[] | null>;
  onLightbulb: (line: number) => void;
  onEditorContextMenu: (file: OpenFileViewModel, request: EditorContextMenuRequest) => void;
  onOpenMarkdownHref: (href: string) => boolean;
  formatBytes: (size: number) => string;
  formatMtime: (mtime: number) => string;
  isMarkdownPath: (path: string) => boolean;
  renderMarkdownPreview: (file: OpenFileViewModel, onOpenHref: (href: string) => boolean) => ReactNode;
}

/**
 * Single editor group: tab strip + active buffer chrome + CodeMirror/markdown.
 * File buffers and LSP sessions stay owned by the shell/store; this is the
 * presentation boundary for the center pane (M3 will grow this into multi-group).
 */
export function EditorGroup({
  groupId,
  workspaceInstanceId,
  visible,
  openOrder,
  openFiles,
  activeKey,
  previewKey,
  pinnedKeys,
  activeFile,
  activeMarkdownMode,
  activeDiagnostics,
  activeHighlights,
  activeInlayHints,
  activeSemanticTokens = [],
  activeGitChanges,
  activeGitBlame,
  activeDebugBreakpoints,
  activeDebugCurrentLine,
  activeDebugInlineValues,
  onToggleBreakpoint,
  onEditBreakpoint,
  debugStep,
  debugRunToCursor,
  debugStop,
  debugEvaluate,
  activeCapabilities,
  activeLspSyncing,
  lspStatusPill,
  breadcrumbs,
  revealTarget,
  editorPaneRef,
  editorPaneStyle,
  onActivate,
  onActivateGroup,
  onClose,
  onPin,
  onPromotePreview,
  onCloseOthers,
  onCloseRight,
  onCloseUnmodified,
  onCloseAll,
  onSplitRight,
  onSplitDown,
  onCopyPath,
  onRevealInTree,
  onRevealInSystem,
  onOpenInTerminal,
  onLocalHistory,
  onDownloadSources,
  downloadingSourcesKeys,
  onMarkdownModeChange,
  onChangeText,
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
  onEditorContextMenu,
  onOpenMarkdownHref,
  formatBytes,
  formatMtime,
  isMarkdownPath,
  renderMarkdownPreview,
}: EditorGroupProps) {
  const tabMenu = useContextMenu();
  const [gitDiffPeek, setGitDiffPeek] = useState<GitLineChange | null>(null);
  const tabScrollRef = useRef<HTMLDivElement>(null);
  const [tabScrollState, setTabScrollState] = useState<EditorTabScrollState>({
    overflow: false,
    atStart: true,
    atEnd: true,
  });
  useEffect(() => setGitDiffPeek(null), [activeKey]);
  const pinnedSet = new Set(pinnedKeys);
  const orderedKeys = [
    ...openOrder.filter((key) => pinnedSet.has(key)),
    ...openOrder.filter((key) => !pinnedSet.has(key)),
  ];

  const updateTabScrollState = useCallback(() => {
    const el = tabScrollRef.current;
    if (!el) return;
    const next = computeEditorTabScrollState(el);
    setTabScrollState((prev) =>
      prev.overflow === next.overflow &&
      prev.atStart === next.atStart &&
      prev.atEnd === next.atEnd
        ? prev
        : next,
    );
  }, []);

  const scrollTabsBy = useCallback(
    (direction: "left" | "right") => {
      const el = tabScrollRef.current;
      if (!el) return;
      const delta = editorTabScrollStep(el.clientWidth);
      setScrollLeft(el, el.scrollLeft + (direction === "right" ? delta : -delta));
      updateTabScrollState();
    },
    [updateTabScrollState],
  );

  useEffect(() => {
    updateTabScrollState();
  }, [openOrder, orderedKeys.length, updateTabScrollState]);

  useEffect(() => {
    const el = tabScrollRef.current;
    if (!el) return;
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => updateTabScrollState());
    ro?.observe(el);
    window.addEventListener("resize", updateTabScrollState);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", updateTabScrollState);
    };
  }, [openOrder.length, updateTabScrollState]);

  useEffect(() => {
    const container = tabScrollRef.current;
    if (!container || !activeKey) return;
    const child = Array.from(container.children).find(
      (node): node is HTMLElement =>
        node instanceof HTMLElement && node.dataset.editorTabKey === activeKey,
    );
    if (!child) return;
    const nextLeft = ensureChildVisibleScrollLeft(container, child);
    if (nextLeft !== container.scrollLeft) {
      setScrollLeft(container, nextLeft);
    }
    updateTabScrollState();
  }, [activeKey, openOrder, updateTabScrollState]);

  const showTabMenu = (event: React.MouseEvent, key: string) => {
    const pinned = pinnedSet.has(key);
    tabMenu.show(event, [
      { label: pinned ? "Unpin Tab" : "Pin Tab", onClick: () => onPin(key, !pinned) },
      { label: "Open in Split Right", onClick: () => onSplitRight(key) },
      { label: "Open in Split Down", onClick: () => onSplitDown(key) },
      { separator: true, label: "" },
      { label: "Close", shortcut: "Ctrl+F4", onClick: () => onClose(key) },
      { label: "Close Others", onClick: () => onCloseOthers(key) },
      { label: "Close Tabs to the Right", onClick: () => onCloseRight(key) },
      { label: "Close Unmodified", onClick: onCloseUnmodified },
      { separator: true, label: "" },
      { label: "Close All", onClick: onCloseAll },
      { separator: true, label: "" },
      { label: "Copy Path", onClick: () => onCopyPath(key, true) },
      { label: "Copy Relative Path", onClick: () => onCopyPath(key, false) },
      { label: "Reveal in Project Tree", shortcut: "Alt+F1", onClick: () => onRevealInTree(key) },
      { label: "Reveal in Explorer", onClick: () => onRevealInSystem(key) },
      { label: "Open in Terminal", onClick: () => onOpenInTerminal(key) },
      ...(onLocalHistory ? [
        { separator: true as const, label: "" },
        { label: "Local History…", onClick: () => onLocalHistory(key) },
      ] : []),
    ]);
  };
  return (
    <main
      ref={editorPaneRef}
      data-testid="code-workspace-editor-pane"
      data-editor-group-id={groupId}
      onMouseDown={onActivateGroup}
      className="h-full min-h-0 flex flex-col bg-[var(--taomni-code-bg)]"
      style={editorPaneStyle}
    >
      {openOrder.length > 0 && (
        <div
          data-testid="code-workspace-editor-tab-strip"
          className="shrink-0 flex items-stretch border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)]"
          style={{ height: "var(--taomni-code-editor-tab-height)" }}
        >
          {/*
            Scroll track is height-matched to tab content via the CSS token (not rem h-8,
            which collapses to 24px under the 12px app root font). Classic native scrollbars
            are suppressed via taomni-tab-scroll so they cannot steal vertical space.
            Chevron buttons and the all-tabs menu stay outside the scroll track.
          */}
          {tabScrollState.overflow && (
            <button
              type="button"
              data-testid="code-workspace-editor-tab-scroll-left"
              aria-label="Scroll editor tabs left"
              title="Scroll tabs left"
              disabled={tabScrollState.atStart}
              className="h-full w-7 shrink-0 inline-flex items-center justify-center border-r border-[var(--taomni-code-border)] hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40"
              onClick={() => scrollTabsBy("left")}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
          )}
          <div
            ref={tabScrollRef}
            data-testid="code-workspace-editor-tab-scroll"
            className="taomni-tab-scroll min-w-0 flex-1 flex items-stretch overflow-x-auto overflow-y-hidden"
            onScroll={updateTabScrollState}
          >
            {orderedKeys.map((key) => {
              const file = openFiles[key];
              if (!file) return null;
              const active = key === activeKey;
              const preview = key === previewKey;
              const pinned = pinnedSet.has(key);
              return (
                <div
                  key={key}
                  data-editor-tab-key={key}
                  data-active={active || undefined}
                  data-preview={preview || undefined}
                  data-pinned={pinned || undefined}
                  className="h-full min-w-[96px] max-w-[240px] flex items-center border-r border-[var(--taomni-code-border)] text-[length:var(--taomni-code-editor-ui-small-font-size)] text-[var(--taomni-code-muted)] data-[active=true]:bg-[var(--taomni-code-bg)] data-[active=true]:text-[var(--taomni-code-text)]"
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 h-full flex items-center gap-1.5 px-2 text-left hover:bg-[var(--taomni-code-active-line-bg)]"
                    title={file.subtitle}
                    onClick={() => onActivate(key)}
                    onDoubleClick={() => onPromotePreview(key)}
                    onAuxClick={(event) => {
                      if (event.button === 1) onClose(key);
                    }}
                    onContextMenu={(event) => showTabMenu(event, key)}
                  >
                    <File className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
                    {pinned && <Pin className="h-3 w-3 shrink-0" />}
                    <span className={`truncate ${preview ? "italic" : ""}`}>{file.title}</span>
                    {file.dirty && <span className="text-[var(--taomni-accent)]">*</span>}
                  </button>
                  <button
                    type="button"
                    className="h-full w-6 shrink-0 inline-flex items-center justify-center hover:bg-[var(--taomni-code-active-line-bg)]"
                    title="Close"
                    onClick={() => onClose(key)}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
          </div>
          {tabScrollState.overflow && (
            <button
              type="button"
              data-testid="code-workspace-editor-tab-scroll-right"
              aria-label="Scroll editor tabs right"
              title="Scroll tabs right"
              disabled={tabScrollState.atEnd}
              className="h-full w-7 shrink-0 inline-flex items-center justify-center border-l border-[var(--taomni-code-border)] hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-40"
              onClick={() => scrollTabsBy("right")}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          )}
          {openOrder.length > 1 && (
            <button
              type="button"
              data-testid="code-workspace-editor-tabs-menu"
              aria-label="Show all editor tabs"
              className="h-full w-7 shrink-0 inline-flex items-center justify-center border-l border-[var(--taomni-code-border)] hover:bg-[var(--taomni-code-active-line-bg)]"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                tabMenu.showAt(rect.right, rect.bottom, orderedKeys.map((key) => ({
                  label: openFiles[key]?.title ?? key,
                  checked: key === activeKey,
                  onClick: () => onActivate(key),
                })));
              }}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
      <div
        id={`code-workspace-editor-stack-${workspaceInstanceId}`}
        className="flex-1 min-h-0"
      >
        <div className="h-full min-h-0 relative">
          {activeFile ? (
            <div className="absolute inset-0 flex flex-col">
              {breadcrumbs}
              <div
                data-testid="code-workspace-file-status"
                className="min-h-7 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] text-[length:var(--taomni-code-editor-ui-small-font-size)] text-[var(--taomni-code-text)]"
              >
                <div className="ml-auto flex min-w-0 items-center gap-2">
                  <span className="shrink-0 text-[var(--taomni-code-muted)]">{formatBytes(activeFile.size)}</span>
                  {formatMtime(activeFile.mtime) && (
                    <span className="shrink-0 text-[var(--taomni-code-muted)]">{formatMtime(activeFile.mtime)}</span>
                  )}
                  {activeFile.loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--taomni-code-muted)]" />}
                  {activeLspSyncing && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--taomni-code-muted)]" />}
                  {lspStatusPill}
                </div>
                {isMarkdownPath(activeFile.languagePath) && (
                  <div className="flex items-center gap-0.5">
                    <ModeButton
                      label="Edit"
                      active={activeMarkdownMode === "edit"}
                      icon={<File className="w-3 h-3" />}
                      onClick={() => onMarkdownModeChange("edit")}
                    />
                    <ModeButton
                      label="Preview"
                      active={activeMarkdownMode === "preview"}
                      icon={<Eye className="w-3 h-3" />}
                      onClick={() => onMarkdownModeChange("preview")}
                    />
                    <ModeButton
                      label="Split"
                      active={activeMarkdownMode === "split"}
                      icon={<Columns2 className="w-3 h-3" />}
                      onClick={() => onMarkdownModeChange("split")}
                    />
                  </div>
                )}
              </div>
              {activeFile.error && (
                <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-red-500/30 bg-red-500/10 text-[12px] text-red-500">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span className="min-w-0 truncate">{activeFile.error}</span>
                </div>
              )}
              {activeFile.library?.decompiled && (
                <div
                  data-testid="code-workspace-decompiled-banner"
                  className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-amber-500/30 bg-amber-500/10 text-[12px] text-[var(--taomni-code-fg)]"
                >
                  <AlertTriangle className="w-4 h-4 shrink-0 text-amber-500" />
                  <span className="min-w-0 flex-1 truncate">
                    Decompiled from bytecode — source not attached.
                  </span>
                  {onDownloadSources && (() => {
                    const downloading = downloadingSourcesKeys?.includes(activeFile.key) ?? false;
                    return (
                      <button
                        type="button"
                        data-testid="code-workspace-download-sources"
                        disabled={downloading}
                        onClick={() => onDownloadSources(activeFile.key)}
                        className="shrink-0 inline-flex items-center gap-1 rounded px-2 py-0.5 text-[12px] font-medium border border-[var(--taomni-code-border)] hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-60"
                      >
                        {downloading
                          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          : <Download className="w-3.5 h-3.5" />}
                        {downloading ? "Downloading…" : "Download sources"}
                      </button>
                    );
                  })()}
                </div>
              )}
              <div data-testid="code-workspace-editor" className="relative flex-1 min-h-0">
                {gitDiffPeek && <GitDiffPeek change={gitDiffPeek} onClose={() => setGitDiffPeek(null)} />}
                {activeFile.loading ? (
                  <div className="h-full flex items-center justify-center text-[12px] text-[var(--taomni-code-muted)]">
                    <Loader2 className="w-4 h-4 animate-spin" />
                  </div>
                ) : isMarkdownPath(activeFile.languagePath) && activeMarkdownMode === "preview" ? (
                  renderMarkdownPreview(activeFile, onOpenMarkdownHref)
                ) : isMarkdownPath(activeFile.languagePath) && activeMarkdownMode === "split" ? (
                  <div className="h-full min-h-0 grid grid-cols-2">
                    <div className="min-w-0 min-h-0 border-r border-[var(--taomni-code-border)]">
                      <CodeMirrorHost
                        key={`${activeFile.key}:edit`}
                        path={activeFile.languagePath}
                        doc={activeFile.text}
                        visible={visible}
                        diagnostics={activeDiagnostics}
                        highlights={activeHighlights}
                        inlayHints={activeInlayHints}
                        semanticTokens={activeSemanticTokens}
                        gitChanges={activeGitChanges}
                        gitBlame={activeGitBlame}
                        reveal={revealTarget?.key === activeFile.key ? revealTarget : null}
                        // Library sources (JDK / dependency classes) cannot be written back.
                        readOnly={!!activeFile.library}
                        onChange={(doc) => {
                          if (previewKey === activeFile.key) onPromotePreview(activeFile.key);
                          onChangeText(activeFile.key, doc);
                        }}
                        onSave={() => onSave(activeFile.key)}
                        onHover={(position) => onHover(activeFile, position)}
                        onDefinition={(position) => onDefinition(activeFile, position)}
                        onReferences={(position) => onReferences(activeFile, position)}
                        onComplete={(position, trigger) => onComplete(activeFile, position, trigger)}
                        onCompleteResolve={(raw) => onCompleteResolve(activeFile, raw)}
                        onSignatureHelp={(position, trigger) => onSignatureHelp(activeFile, position, trigger)}
                        onSelectionChange={onSelectionChange}
                        onViewportChange={onViewportChange}
                        onExpandSelection={(selection) => onExpandSelection(activeFile, selection)}
                        onLightbulb={onLightbulb}
                        onGitChangeClick={setGitDiffPeek}
                        onContextMenu={(request) => onEditorContextMenu(activeFile, request)}
                        completionTriggers={mergeCompletionTriggers(
                          activeCapabilities?.completionTriggerCharacters,
                        )}
                        signatureTriggers={activeCapabilities?.signatureTriggerCharacters ?? []}
                      />
                    </div>
                    {renderMarkdownPreview(activeFile, onOpenMarkdownHref)}
                  </div>
                ) : (
                  <CodeMirrorHost
                    key={activeFile.key}
                    path={activeFile.languagePath}
                    doc={activeFile.text}
                    visible={visible}
                    diagnostics={activeDiagnostics}
                    highlights={activeHighlights}
                    inlayHints={activeInlayHints}
                    semanticTokens={activeSemanticTokens}
                    gitChanges={activeGitChanges}
                    gitBlame={activeGitBlame}
                    debugBreakpoints={activeDebugBreakpoints}
                    debugCurrentLine={activeDebugCurrentLine}
                    debugInlineValues={activeDebugInlineValues}
                    debugStep={debugStep}
                    debugRunToCursor={debugRunToCursor}
                    debugStop={debugStop}
                    debugEvaluate={debugEvaluate}
                    onToggleBreakpoint={onToggleBreakpoint}
                    onEditBreakpoint={onEditBreakpoint}
                    reveal={revealTarget?.key === activeFile.key ? revealTarget : null}
                    onChange={(doc) => {
                      if (previewKey === activeFile.key) onPromotePreview(activeFile.key);
                      onChangeText(activeFile.key, doc);
                    }}
                    onSave={() => onSave(activeFile.key)}
                    onHover={(position) => onHover(activeFile, position)}
                    onDefinition={(position) => onDefinition(activeFile, position)}
                    onReferences={(position) => onReferences(activeFile, position)}
                    onComplete={(position, trigger) => onComplete(activeFile, position, trigger)}
                    onCompleteResolve={(raw) => onCompleteResolve(activeFile, raw)}
                    onSignatureHelp={(position, trigger) => onSignatureHelp(activeFile, position, trigger)}
                    onSelectionChange={onSelectionChange}
                    onViewportChange={onViewportChange}
                    onExpandSelection={(selection) => onExpandSelection(activeFile, selection)}
                    onLightbulb={onLightbulb}
                    onGitChangeClick={setGitDiffPeek}
                    onContextMenu={(request) => onEditorContextMenu(activeFile, request)}
                    completionTriggers={mergeCompletionTriggers(
                      activeCapabilities?.completionTriggerCharacters,
                    )}
                    signatureTriggers={activeCapabilities?.signatureTriggerCharacters ?? []}
                  />
                )}
              </div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-[12px] text-[var(--taomni-code-muted)]">
              No file open
            </div>
          )}
        </div>
      </div>
      {tabMenu.render}
    </main>
  );
}

function ModeButton({
  label,
  active,
  icon,
  onClick,
}: {
  label: string;
  active?: boolean;
  icon: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      data-active={active || undefined}
      className="h-6 inline-flex items-center gap-1 rounded px-1.5 text-[10px] text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] data-[active=true]:bg-[var(--taomni-code-selection-match-bg)] data-[active=true]:text-[var(--taomni-code-text)]"
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
