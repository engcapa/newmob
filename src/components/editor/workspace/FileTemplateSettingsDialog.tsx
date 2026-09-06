import { useEffect, useId, useState } from "react";
import { Settings2, RotateCcw, Save, X } from "lucide-react";
import {
  ALLOWED_TEMPLATE_VARIABLES,
  DEFAULT_JAVA_TEMPLATES,
  type JavaTemplateKind,
} from "./fileTemplateModel";
import {
  loadJavaTemplatePreferences,
  resetJavaTemplatePreferences,
  saveJavaTemplatePreferences,
} from "../../../lib/fileTemplatePreferences";

export interface FileTemplateSettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

const TEMPLATE_TABS: { kind: JavaTemplateKind; label: string }[] = [
  { kind: "class", label: "Class" },
  { kind: "interface", label: "Interface" },
  { kind: "record", label: "Record" },
  { kind: "enum", label: "Enum" },
  { kind: "annotation", label: "Annotation" },
];

export function FileTemplateSettingsDialog({ open, onClose }: FileTemplateSettingsDialogProps) {
  const [activeKind, setActiveKind] = useState<JavaTemplateKind>("class");
  const [templates, setTemplates] = useState<Record<JavaTemplateKind, string>>({
    ...DEFAULT_JAVA_TEMPLATES,
  });
  const [savedNotice, setSavedNotice] = useState(false);
  const titleId = useId();

  useEffect(() => {
    if (open) {
      const prefs = loadJavaTemplatePreferences();
      setTemplates({ ...prefs.templates });
      setActiveKind("class");
      setSavedNotice(false);
    }
  }, [open]);

  if (!open) return null;

  const handleSave = () => {
    saveJavaTemplatePreferences({ templates });
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 2000);
  };

  const handleReset = () => {
    const defaults = resetJavaTemplatePreferences();
    setTemplates({ ...defaults.templates });
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 2000);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="file-template-settings-dialog"
      onKeyDown={handleKeyDown}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[10vh]"
    >
      <div className="flex w-full max-w-2xl flex-col rounded-lg border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] text-[12px] text-[var(--taomni-code-fg)] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--taomni-code-border)] px-4 py-2.5">
          <div className="flex items-center gap-2 font-medium">
            <Settings2 className="h-4 w-4 text-blue-400" />
            <span id={titleId}>File and Code Templates</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            data-testid="file-template-close-button"
            className="rounded p-1 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-hover)] hover:text-[var(--taomni-code-fg)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center border-b border-[var(--taomni-code-border)] px-4 bg-[var(--taomni-code-hover)]/30">
          {TEMPLATE_TABS.map((tab) => (
            <button
              key={tab.kind}
              type="button"
              onClick={() => setActiveKind(tab.kind)}
              data-testid={`file-template-tab-${tab.kind}`}
              className={`border-b-2 px-3 py-2 text-[12px] font-medium transition-colors ${
                activeKind === tab.kind
                  ? "border-blue-500 text-[var(--taomni-code-fg)]"
                  : "border-transparent text-[var(--taomni-code-muted)] hover:text-[var(--taomni-code-fg)]"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Editor Body */}
        <div className="flex flex-col gap-3 p-4">
          <div className="flex flex-col gap-1">
            <label
              htmlFor="file-template-editor-textarea"
              className="text-[11px] font-semibold text-[var(--taomni-code-muted)]"
            >
              Template Text ({activeKind}):
            </label>
            <textarea
              id="file-template-editor-textarea"
              value={templates[activeKind]}
              onChange={(e) =>
                setTemplates((prev) => ({
                  ...prev,
                  [activeKind]: e.target.value,
                }))
              }
              rows={10}
              data-testid="file-template-editor-textarea"
              className="w-full font-mono rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-input-bg,var(--taomni-code-bg))] p-2.5 text-[12px] text-[var(--taomni-code-fg)] outline-none focus:border-blue-500"
            />
          </div>

          {/* Allowed Variables Info */}
          <div className="rounded bg-[var(--taomni-code-hover)]/40 p-2.5 text-[11px]">
            <div className="font-semibold text-[var(--taomni-code-muted)] mb-1">
              Available Variables:
            </div>
            <div className="flex flex-wrap gap-1.5 font-mono text-[10px]">
              {ALLOWED_TEMPLATE_VARIABLES.map((v) => (
                <span
                  key={v}
                  className="rounded bg-[var(--taomni-code-border)]/60 px-1.5 py-0.5 text-[var(--taomni-code-fg)]"
                >
                  ${"{" + v + "}"}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-[var(--taomni-code-border)] px-4 py-2.5">
          <button
            type="button"
            onClick={handleReset}
            data-testid="file-template-reset-button"
            className="flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-hover)] hover:text-[var(--taomni-code-fg)]"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Reset to Default</span>
          </button>

          <div className="flex items-center gap-2">
            {savedNotice && (
              <span className="text-[11px] text-green-400 font-medium">Saved!</span>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded px-3 py-1 text-[11px] text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-hover)] hover:text-[var(--taomni-code-fg)]"
            >
              Close
            </button>
            <button
              type="button"
              onClick={handleSave}
              data-testid="file-template-save-button"
              className="flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1 font-medium text-[11px] text-white hover:bg-blue-500"
            >
              <Save className="h-3.5 w-3.5" />
              <span>Save</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
