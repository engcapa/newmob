import { useEffect, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import {
  cloneEditorAppearanceProfile,
  defaultEditorAppearanceProfile,
  normalizeEditorAppearanceProfile,
  type EditorAppearanceProfile,
} from "./editorAppearanceProfile";

export interface WorkspaceEditorAppearanceSettingsDialogProps {
  open: boolean;
  profile: EditorAppearanceProfile;
  onApply: (profile: EditorAppearanceProfile) => void;
  onClose: () => void;
}

function listText(values: readonly string[]): string {
  return values.join("\n");
}

function parseList(value: string): string[] {
  return value
    .split(/[\r\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function WorkspaceEditorAppearanceSettingsDialog({
  open,
  profile,
  onApply,
  onClose,
}: WorkspaceEditorAppearanceSettingsDialogProps) {
  const [draft, setDraft] = useState(() => cloneEditorAppearanceProfile(profile));
  const [softWrapPatterns, setSoftWrapPatterns] = useState(() => listText(profile.softWrap.patterns));
  const [breadcrumbLanguages, setBreadcrumbLanguages] = useState(() => listText(profile.breadcrumbs.languages));

  useEffect(() => {
    if (!open) return;
    const next = cloneEditorAppearanceProfile(profile);
    setDraft(next);
    setSoftWrapPatterns(listText(next.softWrap.patterns));
    setBreadcrumbLanguages(listText(next.breadcrumbs.languages));
  }, [open, profile]);

  if (!open) return null;

  const updateDraft = (patch: Partial<EditorAppearanceProfile>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const applyDraft = () => {
    onApply(normalizeEditorAppearanceProfile({
      ...draft,
      softWrap: {
        ...draft.softWrap,
        patterns: parseList(softWrapPatterns),
      },
      breadcrumbs: {
        ...draft.breadcrumbs,
        languages: parseList(breadcrumbLanguages),
      },
    }));
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[900] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Workspace editor appearance settings"
        data-testid="workspace-editor-appearance-settings-dialog"
        className="w-[min(700px,calc(100vw-32px))] max-w-full rounded-md border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex h-10 items-center border-b border-[var(--taomni-code-border)] px-3">
          <span className="font-medium">Editor Appearance</span>
          <button
            type="button"
            data-testid="workspace-editor-appearance-close"
            aria-label="Close workspace editor appearance settings"
            className="ml-auto inline-flex h-7 w-7 items-center justify-center"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[min(76vh,720px)] space-y-5 overflow-y-auto p-4 text-xs">
          <section aria-labelledby="workspace-editor-appearance-typography-heading" className="space-y-3">
            <h3 id="workspace-editor-appearance-typography-heading" className="font-medium">Typography</h3>
            <label className="grid grid-cols-[1fr_270px] items-center gap-3">
              <span>Font family</span>
              <input
                type="text"
                data-testid="workspace-editor-appearance-font-family"
                aria-label="Editor font family"
                value={draft.fontFamily}
                onChange={(event) => updateDraft({ fontFamily: event.target.value })}
                className="h-7 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-2 font-mono"
              />
            </label>
            <label className="grid grid-cols-[1fr_270px] items-center gap-3">
              <span>Font size</span>
              <span className="flex items-center gap-2">
                <input
                  type="number"
                  min={8}
                  max={32}
                  step={1}
                  data-testid="workspace-editor-appearance-font-size-px"
                  aria-label="Editor font size"
                  value={draft.fontSizePx}
                  onChange={(event) => updateDraft({ fontSizePx: Number(event.target.value) })}
                  className="h-7 w-24 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-2"
                />
                <span className="text-[var(--taomni-code-muted)]">px</span>
              </span>
            </label>
            <label className="grid grid-cols-[1fr_270px] items-center gap-3">
              <span>Line height</span>
              <input
                type="number"
                min={1}
                max={3}
                step={0.05}
                data-testid="workspace-editor-appearance-line-height"
                aria-label="Editor line height"
                value={draft.lineHeight}
                onChange={(event) => updateDraft({ lineHeight: Number(event.target.value) })}
                className="h-7 w-24 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-2"
              />
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid="workspace-editor-appearance-ligatures"
                checked={draft.ligatures}
                onChange={(event) => updateDraft({ ligatures: event.target.checked })}
              />
              <span>Enable font ligatures</span>
            </label>
          </section>

          <section aria-labelledby="workspace-editor-appearance-color-heading" className="space-y-3 border-t border-[var(--taomni-code-border)] pt-4">
            <h3 id="workspace-editor-appearance-color-heading" className="font-medium">Color and Zoom</h3>
            <label className="grid grid-cols-[1fr_270px] items-center gap-3">
              <span>Color scheme id</span>
              <input
                type="text"
                data-testid="workspace-editor-appearance-color-scheme-id"
                aria-label="Editor color scheme id"
                value={draft.colorSchemeId}
                onChange={(event) => updateDraft({ colorSchemeId: event.target.value })}
                className="h-7 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-2"
              />
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid="workspace-editor-appearance-high-contrast"
                checked={draft.highContrast}
                onChange={(event) => updateDraft({ highContrast: event.target.checked })}
              />
              <span>Use high contrast editor colors</span>
            </label>
            <label className="grid grid-cols-[1fr_270px] items-center gap-3">
              <span>Zoom scope</span>
              <select
                data-testid="workspace-editor-appearance-zoom-scope"
                aria-label="Editor zoom scope"
                value={draft.zoomScope}
                onChange={(event) => updateDraft({
                  zoomScope: event.target.value === "active-editor" ? "active-editor" : "all-editors",
                })}
                className="h-7 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-2"
              >
                <option value="all-editors">All editors</option>
                <option value="active-editor">Active editor</option>
              </select>
            </label>
          </section>

          <section aria-labelledby="workspace-editor-appearance-wrap-heading" className="space-y-3 border-t border-[var(--taomni-code-border)] pt-4">
            <h3 id="workspace-editor-appearance-wrap-heading" className="font-medium">Soft Wrap</h3>
            <label className="block space-y-1">
              <span>Path patterns</span>
              <textarea
                data-testid="workspace-editor-appearance-soft-wrap-patterns"
                aria-label="Soft wrap path patterns"
                value={softWrapPatterns}
                onChange={(event) => setSoftWrapPatterns(event.target.value)}
                placeholder="One glob per line, for example: **/*.md"
                rows={3}
                className="block w-full resize-y rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-2 py-1 font-mono text-[11px]"
              />
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid="workspace-editor-appearance-soft-wrap-use-original-indent"
                checked={draft.softWrap.useOriginalIndent}
                onChange={(event) => updateDraft({
                  softWrap: { ...draft.softWrap, useOriginalIndent: event.target.checked },
                })}
              />
              <span>Use original indentation when wrapping</span>
            </label>
            <label className="grid grid-cols-[1fr_270px] items-center gap-3">
              <span>Additional indent</span>
              <input
                type="number"
                min={0}
                max={16}
                step={1}
                data-testid="workspace-editor-appearance-soft-wrap-additional-indent"
                aria-label="Soft wrap additional indent"
                value={draft.softWrap.additionalIndent}
                onChange={(event) => updateDraft({
                  softWrap: { ...draft.softWrap, additionalIndent: Number(event.target.value) },
                })}
                className="h-7 w-24 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-2"
              />
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid="workspace-editor-appearance-soft-wrap-show-markers"
                checked={draft.softWrap.showMarkers}
                onChange={(event) => updateDraft({
                  softWrap: { ...draft.softWrap, showMarkers: event.target.checked },
                })}
              />
              <span>Show soft-wrap markers</span>
            </label>
          </section>

          <section aria-labelledby="workspace-editor-appearance-space-heading" className="space-y-3 border-t border-[var(--taomni-code-border)] pt-4">
            <h3 id="workspace-editor-appearance-space-heading" className="font-medium">Virtual Space</h3>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid="workspace-editor-appearance-virtual-space-after-line-end"
                checked={draft.virtualSpace.afterLineEnd}
                onChange={(event) => updateDraft({
                  virtualSpace: { ...draft.virtualSpace, afterLineEnd: event.target.checked },
                })}
              />
              <span>Allow caret after line end</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid="workspace-editor-appearance-virtual-space-at-file-bottom"
                checked={draft.virtualSpace.atFileBottom}
                onChange={(event) => updateDraft({
                  virtualSpace: { ...draft.virtualSpace, atFileBottom: event.target.checked },
                })}
              />
              <span>Allow caret at file bottom</span>
            </label>
          </section>

          <section aria-labelledby="workspace-editor-appearance-breadcrumbs-heading" className="space-y-3 border-t border-[var(--taomni-code-border)] pt-4">
            <h3 id="workspace-editor-appearance-breadcrumbs-heading" className="font-medium">Breadcrumbs</h3>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid="workspace-editor-appearance-breadcrumbs-visible"
                checked={draft.breadcrumbs.visible}
                onChange={(event) => updateDraft({
                  breadcrumbs: { ...draft.breadcrumbs, visible: event.target.checked },
                })}
              />
              <span>Show editor breadcrumbs</span>
            </label>
            <label className="grid grid-cols-[1fr_270px] items-center gap-3">
              <span>Placement</span>
              <select
                data-testid="workspace-editor-appearance-breadcrumbs-placement"
                aria-label="Breadcrumb placement"
                value={draft.breadcrumbs.placement}
                onChange={(event) => updateDraft({
                  breadcrumbs: {
                    ...draft.breadcrumbs,
                    placement: event.target.value === "bottom" ? "bottom" : "top",
                  },
                })}
                className="h-7 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-2"
              >
                <option value="top">Top</option>
                <option value="bottom">Bottom</option>
              </select>
            </label>
            <label className="block space-y-1">
              <span>Languages</span>
              <textarea
                data-testid="workspace-editor-appearance-breadcrumbs-languages"
                aria-label="Breadcrumb languages"
                value={breadcrumbLanguages}
                onChange={(event) => setBreadcrumbLanguages(event.target.value)}
                placeholder="One language id or glob per line, for example: typescript"
                rows={3}
                className="block w-full resize-y rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-2 py-1 font-mono text-[11px]"
              />
            </label>
          </section>
        </div>

        <div className="flex items-center gap-2 border-t border-[var(--taomni-code-border)] p-3">
          <button
            type="button"
            data-testid="workspace-editor-appearance-reset"
            className="taomni-btn inline-flex h-7 items-center gap-1.5 px-3"
            onClick={() => {
              const next = defaultEditorAppearanceProfile();
              setDraft(next);
              setSoftWrapPatterns(listText(next.softWrap.patterns));
              setBreadcrumbLanguages(listText(next.breadcrumbs.languages));
            }}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset
          </button>
          <button
            type="button"
            data-testid="workspace-editor-appearance-cancel"
            className="taomni-btn ml-auto h-7 px-3"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="workspace-editor-appearance-apply"
            className="taomni-btn h-7 px-3"
            onClick={applyDraft}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
