import { useState } from "react";
import { X } from "lucide-react";
import type { WorkspaceBuildRunTools } from "./codeWorkspaceModel";

interface WorkspaceBuildRunToolsDialogProps {
  config: WorkspaceBuildRunTools;
  onSave: (config: WorkspaceBuildRunTools) => void;
  onClose: () => void;
}

const TOOLS = [
  { id: "maven", label: "Maven", placeholder: "mvn, mvn.cmd, or an absolute path" },
  { id: "gradle", label: "Gradle", placeholder: "gradle, gradle.bat, or an absolute path" },
] as const;

export function WorkspaceBuildRunToolsDialog({
  config,
  onSave,
  onClose,
}: WorkspaceBuildRunToolsDialogProps) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(
    TOOLS.map(({ id }) => [id, config.tools[id]?.executable ?? ""]),
  ));

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
        aria-label="Build and run tools"
        className="w-[520px] max-w-[calc(100vw-32px)] rounded-md border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex h-10 items-center border-b border-[var(--taomni-code-border)] px-3">
          <span className="font-medium">Build and Run Tools</span>
          <button type="button" aria-label="Close build and run tools" className="ml-auto" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 p-3 text-xs">
          <p className="text-[var(--taomni-code-muted)]">
            Resolution order is project wrapper, configured executable, then workspace SDK/PATH.
            Leave a field empty for automatic discovery.
          </p>
          {TOOLS.map((tool) => (
            <label key={tool.id} className="grid grid-cols-[80px_1fr] items-center gap-2">
              <span>{tool.label}</span>
              <input
                aria-label={`${tool.label} executable`}
                value={values[tool.id]}
                placeholder={tool.placeholder}
                onChange={(event) => setValues((current) => ({ ...current, [tool.id]: event.target.value }))}
                className="h-7 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-2"
              />
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--taomni-code-border)] p-3">
          <button type="button" className="taomni-btn h-7 px-3" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="taomni-btn h-7 px-3"
            onClick={() => {
              const tools = { ...config.tools };
              for (const { id } of TOOLS) {
                const executable = values[id].trim();
                if (executable) tools[id] = { executable };
                else delete tools[id];
              }
              onSave({ tools });
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
