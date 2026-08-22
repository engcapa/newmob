import { useEffect, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import {
  DEFAULT_WORKSPACE_INTELLIGENCE_PREFERENCES,
  normalizeWorkspaceIntelligencePreferences,
  type WorkspaceIntelligencePreferences,
} from "./intelligencePreferences";

interface WorkspaceIntelligenceSettingsDialogProps {
  open: boolean;
  preferences: WorkspaceIntelligencePreferences;
  onApply: (preferences: WorkspaceIntelligencePreferences) => void;
  onClose: () => void;
}

function clonePreferences(
  preferences: WorkspaceIntelligencePreferences,
): WorkspaceIntelligencePreferences {
  return {
    ...preferences,
    inlayHintLanguages: { ...preferences.inlayHintLanguages },
    parameterInfo: { ...preferences.parameterInfo },
    quickDoc: { ...preferences.quickDoc },
  };
}

export function WorkspaceIntelligenceSettingsDialog({
  open,
  preferences,
  onApply,
  onClose,
}: WorkspaceIntelligenceSettingsDialogProps) {
  const [draft, setDraft] = useState(() => clonePreferences(preferences));

  useEffect(() => {
    if (open) setDraft(clonePreferences(preferences));
  }, [open, preferences]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[900] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Editor intelligence settings"
        data-testid="workspace-intelligence-settings-dialog"
        className="w-[560px] max-w-[calc(100vw-32px)] rounded-md border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex h-10 items-center border-b border-[var(--taomni-code-border)] px-3">
          <span className="font-medium">Editor Intelligence</span>
          <button
            type="button"
            aria-label="Close editor intelligence settings"
            className="ml-auto inline-flex h-7 w-7 items-center justify-center"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[min(70vh,620px)] space-y-5 overflow-y-auto p-4 text-xs">
          <section aria-labelledby="quick-doc-settings-heading" className="space-y-3">
            <h3 id="quick-doc-settings-heading" className="font-medium">Quick Documentation</h3>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid="workspace-quick-doc-hover-enabled"
                checked={draft.quickDoc.showOnHover}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  quickDoc: { ...current.quickDoc, showOnHover: event.target.checked },
                }))}
              />
              <span>Show documentation on pointer hover</span>
            </label>
            <label className="grid grid-cols-[1fr_150px] items-center gap-3">
              <span>Hover delay</span>
              <span className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  max={5_000}
                  step={50}
                  aria-label="Quick documentation hover delay"
                  data-testid="workspace-quick-doc-hover-delay"
                  value={draft.quickDoc.hoverDelayMs}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    quickDoc: {
                      ...current.quickDoc,
                      hoverDelayMs: Number(event.target.value),
                    },
                  }))}
                  className="h-7 w-24 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-2"
                />
                <span className="text-[var(--taomni-code-muted)]">ms</span>
              </span>
            </label>
            <label className="grid grid-cols-[1fr_150px] items-center gap-3">
              <span>Explicit documentation target</span>
              <select
                aria-label="Quick documentation default target"
                data-testid="workspace-quick-doc-default-target"
                value={draft.quickDoc.defaultTarget}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  quickDoc: {
                    ...current.quickDoc,
                    defaultTarget: event.target.value === "tool-window" ? "tool-window" : "popup",
                  },
                }))}
                className="h-7 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-2"
              >
                <option value="popup">Popup</option>
                <option value="tool-window">Documentation pane</option>
              </select>
            </label>
          </section>

          <section aria-labelledby="parameter-info-settings-heading" className="space-y-3 border-t border-[var(--taomni-code-border)] pt-4">
            <h3 id="parameter-info-settings-heading" className="font-medium">Parameter Info</h3>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid="workspace-parameter-info-auto-popup"
                checked={draft.parameterInfo.autoPopup}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  parameterInfo: { ...current.parameterInfo, autoPopup: event.target.checked },
                }))}
              />
              <span>Open automatically after signature trigger characters</span>
            </label>
            <label className="grid grid-cols-[1fr_150px] items-center gap-3">
              <span>Automatic popup delay</span>
              <span className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  max={5_000}
                  step={50}
                  aria-label="Parameter info popup delay"
                  data-testid="workspace-parameter-info-delay"
                  value={draft.parameterInfo.delayMs}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    parameterInfo: {
                      ...current.parameterInfo,
                      delayMs: Number(event.target.value),
                    },
                  }))}
                  className="h-7 w-24 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-2"
                />
                <span className="text-[var(--taomni-code-muted)]">ms</span>
              </span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid="workspace-parameter-info-full-signatures"
                checked={draft.parameterInfo.showFullSignatures}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  parameterInfo: {
                    ...current.parameterInfo,
                    showFullSignatures: event.target.checked,
                  },
                }))}
              />
              <span>Show all overload signatures</span>
            </label>
          </section>
        </div>

        <div className="flex items-center gap-2 border-t border-[var(--taomni-code-border)] p-3">
          <button
            type="button"
            data-testid="workspace-intelligence-settings-reset"
            className="taomni-btn inline-flex h-7 items-center gap-1.5 px-3"
            onClick={() => setDraft(clonePreferences(DEFAULT_WORKSPACE_INTELLIGENCE_PREFERENCES))}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset
          </button>
          <button
            type="button"
            data-testid="workspace-intelligence-settings-cancel"
            className="taomni-btn ml-auto h-7 px-3"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="workspace-intelligence-settings-apply"
            className="taomni-btn h-7 px-3"
            onClick={() => {
              onApply(normalizeWorkspaceIntelligencePreferences(draft));
              onClose();
            }}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
