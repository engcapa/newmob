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
  const [mavenJvmArgs, setMavenJvmArgs] = useState(() => config.mavenRun.jvmArgs.join("\n"));
  const [inheritProjectJvmArgs, setInheritProjectJvmArgs] = useState(
    () => config.mavenRun.inheritProjectJvmArgs,
  );

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
        data-testid="workspace-build-run-tools-dialog"
        className="w-[620px] max-w-[calc(100vw-32px)] rounded-md border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] shadow-xl"
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
          <div className="space-y-1 pt-1">
            <label className="block" htmlFor="workspace-maven-run-jvm-args">Maven Run JVM options</label>
            <textarea
              id="workspace-maven-run-jvm-args"
              data-testid="workspace-maven-run-jvm-args"
              aria-label="Maven Run JVM options"
              value={mavenJvmArgs}
              placeholder="One JVM option per line, for example: --add-opens=java.base/sun.nio.ch=ALL-UNNAMED"
              onChange={(event) => setMavenJvmArgs(event.target.value)}
              rows={4}
              className="block w-full resize-y rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-2 py-1 font-mono text-[11px]"
            />
            <p className="text-[var(--taomni-code-muted)]">
              Applied to the Maven JVM through MAVEN_OPTS, one option per line.
              For Chronicle on recent JDKs, add
              {" "}
              <code>--add-opens=java.base/sun.nio.ch=ALL-UNNAMED</code>.
            </p>
          </div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              data-testid="workspace-maven-inherit-argline"
              checked={inheritProjectJvmArgs}
              onChange={(event) => setInheritProjectJvmArgs(event.target.checked)}
            />
            <span>Inherit module-access options from Maven test configuration</span>
          </label>
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
              onSave({
                tools,
                mavenRun: {
                  jvmArgs: mavenJvmArgs.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
                  inheritProjectJvmArgs,
                },
              });
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
