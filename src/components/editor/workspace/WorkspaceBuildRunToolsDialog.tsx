import { useState } from "react";
import { X } from "lucide-react";
import {
  DEFAULT_WORKSPACE_DEBUG_STEP_FILTERS,
  type WorkspaceBuildRunTools,
} from "./codeWorkspaceModel";

interface WorkspaceBuildRunToolsDialogProps {
  config: WorkspaceBuildRunTools;
  onSave: (config: WorkspaceBuildRunTools) => void;
  onClose: () => void;
}

const TOOLS = [
  { id: "cargo", label: "Cargo", placeholder: "cargo or an absolute path" },
  { id: "go", label: "Go", placeholder: "go or an absolute path" },
  { id: "node", label: "Node.js", placeholder: "node or an absolute path" },
  { id: "npm", label: "npm", placeholder: "npm or an absolute path" },
  { id: "pnpm", label: "pnpm", placeholder: "pnpm or an absolute path" },
  { id: "yarn", label: "Yarn", placeholder: "yarn or an absolute path" },
  { id: "python", label: "Python", placeholder: "python3, python.exe, or an absolute path" },
  { id: "cmake", label: "CMake", placeholder: "cmake or an absolute path" },
  { id: "dotnet", label: ".NET", placeholder: "dotnet or an absolute path" },
  { id: "maven", label: "Maven", placeholder: "mvn, mvn.cmd, or an absolute path" },
  { id: "gradle", label: "Gradle", placeholder: "gradle, gradle.bat, or an absolute path" },
  { id: "sbt", label: "sbt", placeholder: "sbt or an absolute path" },
  { id: "swift", label: "Swift", placeholder: "swift or an absolute path" },
  { id: "lldbDap", label: "LLDB DAP", placeholder: "lldb-dap or an absolute path" },
  { id: "delve", label: "Delve", placeholder: "dlv or an absolute path" },
  { id: "debugpy", label: "debugpy", placeholder: "debugpy-adapter or an absolute path" },
  { id: "jsDebug", label: "JS Debug", placeholder: "js-debug-adapter or an absolute path" },
  { id: "netcoredbg", label: "CoreCLR", placeholder: "netcoredbg or an absolute path" },
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
  const [stepFiltersEnabled, setStepFiltersEnabled] = useState(
    () => config.stepFilters?.enabled ?? true,
  );
  const [stepFilterPatterns, setStepFilterPatterns] = useState(
    () => (config.stepFilters?.patterns ?? DEFAULT_WORKSPACE_DEBUG_STEP_FILTERS.patterns).join("\n"),
  );
  const [skipSynthetics, setSkipSynthetics] = useState(
    () => config.stepFilters?.skipSynthetics ?? true,
  );
  const [skipStaticInitializers, setSkipStaticInitializers] = useState(
    () => config.stepFilters?.skipStaticInitializers ?? false,
  );
  const [skipConstructors, setSkipConstructors] = useState(
    () => config.stepFilters?.skipConstructors ?? false,
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
          <button
            type="button"
            data-testid="workspace-build-run-tools-close"
            aria-label="Close build and run tools"
            className="ml-auto"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[min(72vh,680px)] space-y-3 overflow-y-auto p-3 text-xs">
          <p className="text-[var(--taomni-code-muted)]">
            Resolution order is project wrapper, configured executable, then workspace SDK/PATH.
            Leave a field empty for automatic discovery.
          </p>
          {TOOLS.map((tool) => (
            <label key={tool.id} className="grid grid-cols-[92px_1fr] items-center gap-2">
              <span>{tool.label}</span>
              <input
                data-testid={`workspace-tool-${tool.id}`}
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

          <div className="border-t border-[var(--taomni-code-border)] pt-3 space-y-2">
            <div className="font-medium">Debugger Step Filters (跳过标准库/框架代码)</div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid="workspace-debug-step-filters-enabled"
                checked={stepFiltersEnabled}
                onChange={(e) => setStepFiltersEnabled(e.target.checked)}
              />
              <span>Enable Step Filters (Step Over matching classes/packages)</span>
            </label>
            {stepFiltersEnabled && (
              <>
                <label className="block text-[11px] text-[var(--taomni-code-muted)]" htmlFor="workspace-debug-step-filter-patterns">
                  Class & package patterns to skip (one per line, e.g. <code>java.*</code>, <code>javax.*</code>, <code>sun.*</code>, <code>com.sun.*</code>)
                </label>
                <textarea
                  id="workspace-debug-step-filter-patterns"
                  data-testid="workspace-debug-step-filter-patterns"
                  aria-label="Step filter class patterns"
                  value={stepFilterPatterns}
                  onChange={(e) => setStepFilterPatterns(e.target.value)}
                  rows={4}
                  className="block w-full resize-y rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)] px-2 py-1 font-mono text-[11px]"
                />
                <div className="flex flex-wrap gap-4 pt-1">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      data-testid="workspace-debug-skip-synthetics"
                      checked={skipSynthetics}
                      onChange={(e) => setSkipSynthetics(e.target.checked)}
                    />
                    <span>Skip synthetic methods</span>
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      data-testid="workspace-debug-skip-static-init"
                      checked={skipStaticInitializers}
                      onChange={(e) => setSkipStaticInitializers(e.target.checked)}
                    />
                    <span>Skip static initializers</span>
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      data-testid="workspace-debug-skip-constructors"
                      checked={skipConstructors}
                      onChange={(e) => setSkipConstructors(e.target.checked)}
                    />
                    <span>Skip constructors</span>
                  </label>
                </div>
              </>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--taomni-code-border)] p-3">
          <button
            type="button"
            data-testid="workspace-build-run-tools-cancel"
            className="taomni-btn h-7 px-3"
            onClick={onClose}
          >Cancel</button>
          <button
            type="button"
            data-testid="workspace-build-run-tools-save"
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
                stepFilters: {
                  enabled: stepFiltersEnabled,
                  patterns: stepFilterPatterns.split(/\r?\n/).map((p) => p.trim()).filter(Boolean),
                  skipSynthetics,
                  skipStaticInitializers,
                  skipConstructors,
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
