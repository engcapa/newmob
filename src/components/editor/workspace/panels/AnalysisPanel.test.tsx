import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LspDocumentStatus } from "../../../../lib/editor/lsp";
import { defaultInspectionProfile, updateInspectionRule } from "../inspectionProfile";
import type { ProblemFileGroup } from "./ProblemsPanel";
import { AnalysisPanel } from "./AnalysisPanel";
import { createWorkspaceSemanticIndexSnapshot } from "../workspaceSemanticIndex";

function status(): LspDocumentStatus {
  return {
    path: "/repo/src/main.ts",
    uri: "file:///repo/src/main.ts",
    presetId: "typescript",
    languageId: "typescript",
    displayName: "TypeScript",
    available: true,
    active: true,
    selectedCommandId: "ts",
    selectedCommand: "typescript-language-server",
    installHint: null,
    error: null,
    capabilities: {
      completion: true,
      signatureHelp: false,
      hover: true,
      definition: true,
      typeDefinition: false,
      implementation: false,
      references: true,
      documentSymbol: true,
      workspaceSymbol: true,
      rename: true,
      formatting: true,
      rangeFormatting: false,
      codeAction: true,
      documentHighlight: true,
      callHierarchy: false,
      typeHierarchy: false,
      inlayHint: false,
      selectionRange: false,
      semanticTokens: true,
      codeActionKinds: ["quickfix", "refactor.extract"],
      completionTriggerCharacters: ["."],
      signatureTriggerCharacters: ["("] ,
    },
  };
}

const files: ProblemFileGroup[] = [{
  key: "root:app:src/main.ts",
  title: "main.ts",
  subtitle: "app / src/main.ts",
  diagnostics: [{
    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } },
    severity: 2,
    source: "typescript",
    code: "taint",
    message: "Value reaches a sink",
    relatedInformation: [{
      location: {
        uri: "file:///repo/src/sink.ts",
        path: "/repo/src/sink.ts",
        range: { start: { line: 8, character: 1 }, end: { line: 8, character: 4 } },
      },
      message: "Sink receives the value",
    }],
  }],
}];

describe("AnalysisPanel", () => {
  afterEach(cleanup);

  it("shows capability state, inspection controls, and provider-backed data flow", () => {
    const onUpdateRule = vi.fn();
    const onOpenLocation = vi.fn();
    const onOpenDiagnostic = vi.fn();
    render(
      <AnalysisPanel
        files={files}
        status={status()}
        semanticTokenCount={4}
        semanticIndex={{
          ...createWorkspaceSemanticIndexSnapshot(),
          status: "ready",
          provider: "language-server",
          indexedRevision: 0,
          staleReasons: [],
        }}
        profile={defaultInspectionProfile()}
        onUpdateRule={onUpdateRule}
        onCreateBaseline={vi.fn()}
        onClearBaseline={vi.fn()}
        onRemoveBaselineEntry={vi.fn()}
        onRemoveSuppression={vi.fn()}
        onExportBaseline={vi.fn()}
        onImportBaseline={vi.fn()}
        onOpenLocation={onOpenLocation}
        onOpenDiagnostic={onOpenDiagnostic}
      />,
    );
    expect(screen.getByText("TypeScript")).toBeInTheDocument();
    expect(screen.getByTestId("analysis-semantic-index")).toHaveTextContent("Ready · generation 0");
    expect(screen.getByTestId("analysis-semantic-index")).toHaveTextContent("IntelliJ PSI/stub guarantees are not available yet");
    expect(screen.getByText("Semantic tokens received: 4")).toBeInTheDocument();
    expect(screen.getAllByText("typescript:taint").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId("analysis-evidence-kind-taint")).toHaveTextContent("Taint flow");
    expect(screen.getByTestId("analysis-evidence-proof-level")).toHaveTextContent("text-inferred");
    fireEvent.click(screen.getByRole("checkbox", { name: "Show typescript:taint diagnostics" }));
    expect(onUpdateRule).toHaveBeenCalledWith("typescript:taint", { enabled: false });
    fireEvent.click(screen.getAllByText("Sink receives the value")[0]!);
    expect(onOpenLocation).toHaveBeenCalled();
    fireEvent.click(screen.getByText("Value reaches a sink"));
    expect(onOpenDiagnostic).toHaveBeenCalledWith(files[0].key, files[0].diagnostics[0]);
  });

  it("renders structured flow evidence and navigates its provider locations", () => {
    const structured = {
      ...files[0].diagnostics[0],
      code: "flow",
      message: "Structured flow reported",
      data: {
        analysisKind: "data-flow",
        flowSteps: [{
          role: "source",
          message: "Request parameter",
          location: {
            uri: "file:///repo/src/input.ts",
            path: "/repo/src/input.ts",
            range: { start: { line: 2, character: 1 }, end: { line: 2, character: 8 } },
          },
        }],
      },
      relatedInformation: undefined,
    };
    const onOpenLocation = vi.fn();
    render(
      <AnalysisPanel
        files={[{ ...files[0], diagnostics: [structured] }]}
        status={null}
        semanticTokenCount={0}
        semanticIndex={createWorkspaceSemanticIndexSnapshot()}
        profile={defaultInspectionProfile()}
        onUpdateRule={vi.fn()}
        onCreateBaseline={vi.fn()}
        onClearBaseline={vi.fn()}
        onRemoveBaselineEntry={vi.fn()}
        onRemoveSuppression={vi.fn()}
        onExportBaseline={vi.fn()}
        onImportBaseline={vi.fn()}
        onOpenLocation={onOpenLocation}
        onOpenDiagnostic={vi.fn()}
      />,
    );
    expect(screen.getByTestId("analysis-evidence-proof-level")).toHaveTextContent("structured");
    fireEvent.click(screen.getByText("Request parameter"));
    expect(onOpenLocation).toHaveBeenCalledWith(expect.objectContaining({ path: "/repo/src/input.ts" }));
  });

  it("shows an explicit provider boundary when no related locations exist", () => {
    render(
      <AnalysisPanel
        files={[{ ...files[0], diagnostics: [{ ...files[0].diagnostics[0], relatedInformation: undefined }] }]}
        status={null}
        semanticTokenCount={0}
        semanticIndex={createWorkspaceSemanticIndexSnapshot()}
        profile={updateInspectionRule(defaultInspectionProfile(), "typescript:taint", { enabled: false })}
        onUpdateRule={vi.fn()}
        onCreateBaseline={vi.fn()}
        onClearBaseline={vi.fn()}
        onRemoveBaselineEntry={vi.fn()}
        onRemoveSuppression={vi.fn()}
        onExportBaseline={vi.fn()}
        onImportBaseline={vi.fn()}
        onOpenLocation={vi.fn()}
        onOpenDiagnostic={vi.fn()}
      />,
    );
    expect(screen.getByText(/provider-backed analysis evidence is available/)).toBeInTheDocument();
    expect(screen.getByText("typescript:taint")).toBeInTheDocument();
  });

  it("suppresses provider-backed data-flow entries when the inspection is disabled", () => {
    const profile = updateInspectionRule(defaultInspectionProfile(), "typescript:taint", { enabled: false });
    render(
      <AnalysisPanel
        files={files}
        status={status()}
        semanticTokenCount={0}
        semanticIndex={createWorkspaceSemanticIndexSnapshot()}
        profile={profile}
        onUpdateRule={vi.fn()}
        onCreateBaseline={vi.fn()}
        onClearBaseline={vi.fn()}
        onRemoveBaselineEntry={vi.fn()}
        onRemoveSuppression={vi.fn()}
        onExportBaseline={vi.fn()}
        onImportBaseline={vi.fn()}
        onOpenLocation={vi.fn()}
        onOpenDiagnostic={vi.fn()}
      />,
    );

    expect(screen.getByTestId("analysis-data-flow")).toHaveTextContent(
      "No provider-backed analysis evidence is available",
    );
    expect(screen.queryByText("Sink receives the value")).not.toBeInTheDocument();
  });

  it("exposes baseline and suppression management controls", () => {
    const profile = {
      ...defaultInspectionProfile(),
      baseline: {
        createdAt: 1,
        entries: [{ inspectionId: "typescript:taint", path: "root:app:src/main.ts", message: "Value reaches a sink" }],
      },
      suppressions: [{ inspectionId: "typescript:taint", path: "root:app:src/main.ts", line: 1 }],
    };
    const callbacks = {
      onCreateBaseline: vi.fn(),
      onClearBaseline: vi.fn(),
      onRemoveBaselineEntry: vi.fn(),
      onRemoveSuppression: vi.fn(),
      onExportBaseline: vi.fn(),
      onImportBaseline: vi.fn(),
    };
    render(
      <AnalysisPanel
        files={files}
        status={null}
        semanticTokenCount={0}
        semanticIndex={createWorkspaceSemanticIndexSnapshot()}
        profile={profile}
        onUpdateRule={vi.fn()}
        {...callbacks}
        onOpenLocation={vi.fn()}
        onOpenDiagnostic={vi.fn()}
      />,
    );
    expect(screen.getByTestId("analysis-inspection-baseline")).toHaveTextContent("1 entries");
    expect(screen.getByTestId("analysis-inspection-suppressions")).toHaveTextContent("line 2");
    fireEvent.click(screen.getByTestId("analysis-baseline-create"));
    fireEvent.click(screen.getByTestId("analysis-baseline-clear"));
    fireEvent.click(screen.getByRole("button", { name: "Remove baseline typescript:taint" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove suppression typescript:taint" }));
    expect(callbacks.onCreateBaseline).toHaveBeenCalled();
    expect(callbacks.onClearBaseline).toHaveBeenCalled();
    expect(callbacks.onRemoveBaselineEntry).toHaveBeenCalled();
    expect(callbacks.onRemoveSuppression).toHaveBeenCalled();
  });

  it("handles lastQuery coverage with undefined diagnostics without crashing", () => {
    const semanticIndex = {
      ...createWorkspaceSemanticIndexSnapshot(),
      status: "ready" as const,
      provider: "language-server" as const,
      lastQuery: {
        kind: "symbols" as const,
        generation: 1,
        completedAt: Date.now(),
        resultCount: 5,
        provider: "language-server" as const,
        coverage: {
          scope: "workspace" as const,
          sessionCount: 1,
          providerCount: 1,
          skippedProviderCount: 0,
          failedProviderCount: 0,
          complete: true,
          truncated: false,
          diagnostics: undefined as unknown as string[],
        },
      },
    };

    render(
      <AnalysisPanel
        files={[]}
        status={null}
        semanticTokenCount={0}
        semanticIndex={semanticIndex}
        profile={defaultInspectionProfile()}
        onUpdateRule={vi.fn()}
        onCreateBaseline={vi.fn()}
        onClearBaseline={vi.fn()}
        onRemoveBaselineEntry={vi.fn()}
        onRemoveSuppression={vi.fn()}
        onExportBaseline={vi.fn()}
        onImportBaseline={vi.fn()}
        onOpenLocation={vi.fn()}
        onOpenDiagnostic={vi.fn()}
      />,
    );

    expect(screen.getByTestId("analysis-semantic-index")).toHaveTextContent("Last query: symbols");
  });
});
