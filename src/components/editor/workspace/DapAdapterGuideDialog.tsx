import { useState } from "react";
import {
  Bug,
  Check,
  Code2,
  Copy,
  ExternalLink,
  Info,
  Layers,
  Terminal,
  X,
} from "lucide-react";
import {
  DAP_ADAPTER_CONTRACT_FIXTURES,
  type DapAdapterContractFixture,
  type DapAdapterContractLanguage,
} from "./dapAdapterContracts";

export interface DapAdapterGuideDialogProps {
  open: boolean;
  onClose: () => void;
  initialLanguage?: DapAdapterContractLanguage;
}

interface AdapterGuideDetails {
  installCommand: string;
  binaryName: string;
  defaultConfigSnippet: string;
  docsUrl: string;
  description: string;
}

const ADAPTER_DETAILS: Record<DapAdapterContractLanguage, AdapterGuideDetails> = {
  java: {
    binaryName: "java-debug / Eclipse JDT LS",
    installCommand: "# Included with Java Language Server / Taomni JDTLS runtime\n# No extra installation needed",
    defaultConfigSnippet: JSON.stringify(
      {
        version: "2.0",
        configurations: [
          {
            id: "java-main",
            name: "Java Application",
            type: "java",
            request: "launch",
            mainClass: "com.example.Main",
          },
        ],
      },
      null,
      2,
    ),
    docsUrl: "https://github.com/microsoft/java-debug",
    description: "Standard JVM debugging over JDWP, supporting threads, variables, evaluation, and hot code replace.",
  },
  javascript: {
    binaryName: "js-debug (Node / Browser / Bun / Deno)",
    installCommand: "npm install -g @vscode/js-debug\n# Or run directly via Node.js inspector: node --inspect-brk=9229",
    defaultConfigSnippet: JSON.stringify(
      {
        version: "2.0",
        configurations: [
          {
            id: "node-launch",
            name: "Launch Node Program",
            type: "pwa-node",
            request: "launch",
            program: "${workspaceFolder}/src/index.ts",
            runtimeExecutable: "node",
          },
        ],
      },
      null,
      2,
    ),
    docsUrl: "https://github.com/microsoft/vscode-js-debug",
    description: "V8 Inspector protocol debugger for Node.js, Chromium browsers, Deno, and Bun runtime environments.",
  },
  python: {
    binaryName: "debugpy",
    installCommand: "pip install debugpy\n# Or with uv / poetry:\nuv pip install debugpy",
    defaultConfigSnippet: JSON.stringify(
      {
        version: "2.0",
        configurations: [
          {
            id: "python-launch",
            name: "Python: Current File",
            type: "python",
            request: "launch",
            program: "${file}",
            console: "integratedTerminal",
          },
        ],
      },
      null,
      2,
    ),
    docsUrl: "https://github.com/microsoft/debugpy",
    description: "Official Python DAP adapter supporting multi-threaded debugging, data breakpoints, and Django/Flask frameworks.",
  },
  go: {
    binaryName: "dlv (Delve)",
    installCommand: "go install github.com/go-delve/delve/cmd/dlv@latest",
    defaultConfigSnippet: JSON.stringify(
      {
        version: "2.0",
        configurations: [
          {
            id: "go-debug",
            name: "Launch Go Package",
            type: "go",
            request: "launch",
            mode: "auto",
            program: "${workspaceFolder}",
          },
        ],
      },
      null,
      2,
    ),
    docsUrl: "https://github.com/go-delve/delve",
    description: "Delve debugger for the Go programming language with goroutine inspection and memory dumping.",
  },
  rust: {
    binaryName: "lldb-dap / CodeLLDB",
    installCommand: "# Linux:\nsudo apt install lldb  # or pacman -S lldb\n# macOS:\nxcode-select --install  # or brew install llvm",
    defaultConfigSnippet: JSON.stringify(
      {
        version: "2.0",
        configurations: [
          {
            id: "rust-debug",
            name: "Debug Rust Binary",
            type: "lldb",
            request: "launch",
            program: "${workspaceFolder}/target/debug/app",
            cwd: "${workspaceFolder}",
          },
        ],
      },
      null,
      2,
    ),
    docsUrl: "https://lldb.llvm.org/",
    description: "Native LLDB debug adapter for Rust, C, and C++ with instruction disassembly, register inspection, and memory read/write.",
  },
  cpp: {
    binaryName: "lldb-dap / gdb / CodeLLDB",
    installCommand: "# Linux:\nsudo apt install lldb gdb\n# macOS:\nbrew install llvm",
    defaultConfigSnippet: JSON.stringify(
      {
        version: "2.0",
        configurations: [
          {
            id: "cpp-debug",
            name: "Debug C/C++ Executable",
            type: "lldb",
            request: "launch",
            program: "${workspaceFolder}/build/main",
            cwd: "${workspaceFolder}",
          },
        ],
      },
      null,
      2,
    ),
    docsUrl: "https://lldb.llvm.org/",
    description: "Native LLDB and GDB adapters for C and C++ native binaries with hardware/software watchpoints.",
  },
};

export function DapAdapterGuideDialog({
  open,
  onClose,
  initialLanguage = "java",
}: DapAdapterGuideDialogProps) {
  const [selectedLang, setSelectedLang] = useState<DapAdapterContractLanguage>(initialLanguage);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  if (!open) return null;

  const currentFixture = DAP_ADAPTER_CONTRACT_FIXTURES.find((f) => f.language === selectedLang) ?? DAP_ADAPTER_CONTRACT_FIXTURES[0];
  const details = ADAPTER_DETAILS[selectedLang];

  const handleCopy = (text: string, key: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="dap-adapter-guide-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
    >
      <div className="flex h-[min(650px,90vh)] w-[min(820px,94vw)] flex-col overflow-hidden rounded-lg border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] text-[var(--taomni-code-fg)] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-active-line-bg)]/40 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <Bug className="h-5 w-5 text-emerald-400" />
            <div>
              <h2 className="text-[13px] font-semibold">DAP Debug Adapter Matrix & Setup Guide</h2>
              <p className="text-[11px] text-[var(--taomni-code-muted)]">
                Runtime adapter detection, installation commands, and configuration templates
              </p>
            </div>
          </div>
          <button
            type="button"
            data-testid="dap-guide-close-btn"
            onClick={onClose}
            className="rounded p-1 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-fg)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Language Tabs */}
        <div className="flex border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-4">
          {DAP_ADAPTER_CONTRACT_FIXTURES.map((fixture) => (
            <button
              key={fixture.id}
              type="button"
              data-testid={`dap-tab-${fixture.language}`}
              onClick={() => setSelectedLang(fixture.language)}
              className={`flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[12px] font-medium transition-colors ${
                selectedLang === fixture.language
                  ? "border-emerald-500 text-emerald-400"
                  : "border-transparent text-[var(--taomni-code-muted)] hover:text-[var(--taomni-code-fg)]"
              }`}
            >
              <Code2 className="h-3.5 w-3.5" />
              <span>{fixture.label.split(" / ")[0]}</span>
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {/* Adapter Summary Card */}
          <div className="rounded-lg border border-[var(--taomni-code-border)] bg-[var(--taomni-code-active-line-bg)]/20 p-3.5">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="font-semibold text-[13px] text-[var(--taomni-code-fg)]">
                  {currentFixture.label}
                </h3>
                <p className="mt-1 text-[11px] text-[var(--taomni-code-muted)]">
                  {details.description}
                </p>
              </div>
              <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-emerald-400">
                Runtime: {currentFixture.runtime}
              </span>
            </div>

            {/* Protocol Capabilities Checklist */}
            <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-[var(--taomni-code-border)]/40 text-[11px]">
              <div className="flex items-center gap-1 text-emerald-400">
                <Check className="h-3.5 w-3.5" />
                <span>Breakpoints / Step</span>
              </div>
              <div className="flex items-center gap-1 text-emerald-400">
                <Check className="h-3.5 w-3.5" />
                <span>Evaluate / Watch</span>
              </div>
              <div className="flex items-center gap-1 text-emerald-400">
                <Check className="h-3.5 w-3.5" />
                <span>Exception Options</span>
              </div>
              <div className="flex items-center gap-1 text-emerald-400">
                <Check className="h-3.5 w-3.5" />
                <span>Memory & Mode Gate</span>
              </div>
            </div>
          </div>

          {/* Installation Instructions */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-1.5 text-[12px] font-semibold">
                <Terminal className="h-4 w-4 text-emerald-400" />
                <span>Installation & Binary Setup</span>
              </div>
              <button
                type="button"
                data-testid="dap-copy-install-btn"
                onClick={() => handleCopy(details.installCommand, "install")}
                className="flex items-center gap-1 rounded border border-[var(--taomni-code-border)] px-2 py-0.5 text-[10px] hover:bg-[var(--taomni-code-active-line-bg)]"
              >
                {copiedKey === "install" ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                <span>{copiedKey === "install" ? "Copied" : "Copy Command"}</span>
              </button>
            </div>
            <pre className="rounded border border-[var(--taomni-code-border)] bg-black/40 p-2.5 font-mono text-[11px] text-[var(--taomni-code-fg)] overflow-x-auto">
              {details.installCommand}
            </pre>
          </div>

          {/* Configuration Template */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-1.5 text-[12px] font-semibold">
                <Layers className="h-4 w-4 text-emerald-400" />
                <span>Launch Configuration Template (<code>.taomni/run-configurations.json</code>)</span>
              </div>
              <button
                type="button"
                data-testid="dap-copy-config-btn"
                onClick={() => handleCopy(details.defaultConfigSnippet, "config")}
                className="flex items-center gap-1 rounded border border-[var(--taomni-code-border)] px-2 py-0.5 text-[10px] hover:bg-[var(--taomni-code-active-line-bg)]"
              >
                {copiedKey === "config" ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                <span>{copiedKey === "config" ? "Copied" : "Copy JSON"}</span>
              </button>
            </div>
            <pre className="rounded border border-[var(--taomni-code-border)] bg-black/40 p-2.5 font-mono text-[11px] text-[var(--taomni-code-fg)] overflow-x-auto">
              {details.defaultConfigSnippet}
            </pre>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-[var(--taomni-code-border)] bg-[var(--taomni-code-active-line-bg)]/30 px-4 py-2.5 text-[11px]">
          <div className="flex items-center gap-1.5 text-[var(--taomni-code-muted)]">
            <Info className="h-3.5 w-3.5" />
            <span>Adapters are detected automatically when present in your system PATH</span>
          </div>
          <a
            href={details.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-emerald-400 hover:underline"
          >
            <span>Adapter Documentation</span>
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>
    </div>
  );
}
