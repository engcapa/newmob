import { useEffect, useId, useMemo, useRef, useState } from "react";
import { FileCode, AlertCircle, X, Settings2 } from "lucide-react";
import {
  type JavaTemplateKind,
  type PlanTemplateCreationResult,
  derivePackageName,
  planJavaTemplateCreation,
} from "./fileTemplateModel";
import { loadJavaTemplatePreferences } from "../../../lib/fileTemplatePreferences";

export interface NewJavaClassDialogProps {
  open: boolean;
  targetDirectory: string;
  sourceRoots: readonly string[];
  existingFiles: readonly string[];
  projectFactsStatus?: string;
  onClose: () => void;
  onCreate: (plan: PlanTemplateCreationResult & { valid: true }) => Promise<boolean | void> | boolean | void;
  onOpenSettings?: () => void;
}

const TEMPLATE_KIND_OPTIONS: { kind: JavaTemplateKind; label: string }[] = [
  { kind: "class", label: "Class" },
  { kind: "interface", label: "Interface" },
  { kind: "record", label: "Record" },
  { kind: "enum", label: "Enum" },
  { kind: "annotation", label: "Annotation" },
];

export function NewJavaClassDialog({
  open,
  targetDirectory,
  sourceRoots,
  existingFiles,
  projectFactsStatus,
  onClose,
  onCreate,
  onOpenSettings,
}: NewJavaClassDialogProps) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<JavaTemplateKind>("class");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (open) {
      setName("");
      setKind("class");
      setSubmitting(false);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [open]);

  // Derived package
  const isFactsReady = !projectFactsStatus || projectFactsStatus === "ready";
  const effectiveSourceRoots = isFactsReady ? sourceRoots : [];
  const packageName = useMemo(
    () => derivePackageName(targetDirectory, effectiveSourceRoots),
    [targetDirectory, effectiveSourceRoots],
  );

  // Live validation & plan computation
  const plan = useMemo(() => {
    if (!name.trim()) return null;
    const prefs = loadJavaTemplatePreferences();
    return planJavaTemplateCreation({
      kind,
      name: name.trim(),
      targetDirectory,
      sourceRoots: effectiveSourceRoots,
      existingFiles,
      customTemplate: prefs.templates[kind],
      projectFactsStatus,
      requireReadyFacts: true,
    });
  }, [name, kind, targetDirectory, effectiveSourceRoots, existingFiles, projectFactsStatus]);

  if (!open) return null;

  const handleSubmit = async () => {
    if (!plan || !plan.valid || submitting) return;
    setSubmitting(true);
    try {
      const created = await onCreate(plan);
      if (created === false) {
        setSubmitting(false);
        return;
      }
      onClose();
    } catch {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter" && plan?.valid && !submitting) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  const hasName = name.trim().length > 0;
  const error = hasName && plan && !plan.valid ? plan.error : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="new-java-class-dialog"
      onKeyDown={handleKeyDown}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[12vh]"
    >
      <div className="flex w-full max-w-md flex-col rounded-lg border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] text-[12px] text-[var(--taomni-code-fg)] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--taomni-code-border)] px-4 py-2.5">
          <div className="flex items-center gap-2 font-medium">
            <FileCode className="h-4 w-4 text-blue-400" />
            <span id={titleId}>New Java Class</span>
          </div>
          <div className="flex items-center gap-1">
            {onOpenSettings && (
              <button
                type="button"
                onClick={onOpenSettings}
                title="Edit file templates"
                data-testid="new-java-class-edit-templates"
                className="rounded p-1 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-hover)] hover:text-[var(--taomni-code-fg)]"
              >
                <Settings2 className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              data-testid="new-java-class-cancel"
              className="rounded p-1 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-hover)] hover:text-[var(--taomni-code-fg)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex flex-col gap-3 p-4">
          {/* Name & Kind inputs */}
          <div className="flex flex-col gap-1">
            <label htmlFor="new-java-class-name" className="text-[11px] font-semibold text-[var(--taomni-code-muted)]">
              Name:
            </label>
            <input
              id="new-java-class-name"
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. MyService"
              data-testid="new-java-class-name-input"
              className="w-full rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-input-bg,var(--taomni-code-bg))] px-2.5 py-1.5 text-[12px] text-[var(--taomni-code-fg)] outline-none focus:border-blue-500"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="new-java-class-kind" className="text-[11px] font-semibold text-[var(--taomni-code-muted)]">
              Kind:
            </label>
            <select
              id="new-java-class-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as JavaTemplateKind)}
              data-testid="new-java-class-kind-select"
              className="w-full rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-input-bg,var(--taomni-code-bg))] px-2.5 py-1.5 text-[12px] text-[var(--taomni-code-fg)] outline-none focus:border-blue-500"
            >
              {TEMPLATE_KIND_OPTIONS.map((opt) => (
                <option key={opt.kind} value={opt.kind}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Package and Facts Information */}
          <div className="rounded bg-[var(--taomni-code-hover)]/40 px-3 py-2 text-[11px] space-y-1">
            <div className="flex items-center justify-between" data-testid="new-java-class-package">
              <span className="text-[var(--taomni-code-muted)]">Package:</span>
              <span className="font-mono text-[var(--taomni-code-fg)]">
                {packageName || "(default package)"}
              </span>
            </div>
            {projectFactsStatus && projectFactsStatus !== "ready" && (
              <div
                className="flex items-center gap-1.5 text-amber-400"
                data-testid="new-java-class-facts-status"
              >
                <AlertCircle className="h-3 w-3 shrink-0" />
                <span>Project facts not ready ({projectFactsStatus})</span>
              </div>
            )}
          </div>

          {/* Error message */}
          {error && (
            <div
              className="flex items-center gap-1.5 rounded bg-red-950/40 border border-red-900/50 p-2 text-[11px] text-red-400"
              data-testid="new-java-class-error"
            >
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-[var(--taomni-code-border)] px-4 py-2.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1 text-[11px] text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-hover)] hover:text-[var(--taomni-code-fg)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!plan?.valid || submitting}
            data-testid="new-java-class-submit"
            className="rounded bg-blue-600 px-3 py-1 font-medium text-[11px] text-white hover:bg-blue-500 disabled:opacity-50 disabled:pointer-events-none"
          >
            {submitting ? "Creating..." : "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
