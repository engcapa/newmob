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
        onOpenLocation={onOpenLocation}
        onOpenDiagnostic={onOpenDiagnostic}
      />,
    );
    expect(screen.getByText("TypeScript")).toBeInTheDocument();
    expect(screen.getByTestId("analysis-semantic-index")).toHaveTextContent("Ready · generation 0");
    expect(screen.getByTestId("analysis-semantic-index")).toHaveTextContent("IntelliJ PSI/stub guarantees are not available yet");
    expect(screen.getByText("Semantic tokens received: 4")).toBeInTheDocument();
    expect(screen.getByText("typescript:taint")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Enable inspection typescript:taint" }));
    expect(onUpdateRule).toHaveBeenCalledWith("typescript:taint", { enabled: false });
    fireEvent.click(screen.getByText("Sink receives the value"));
    expect(onOpenLocation).toHaveBeenCalled();
    fireEvent.click(screen.getByText("Value reaches a sink"));
    expect(onOpenDiagnostic).toHaveBeenCalledWith(files[0].key, files[0].diagnostics[0]);
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
        onOpenLocation={vi.fn()}
        onOpenDiagnostic={vi.fn()}
      />,
    );
    expect(screen.getByText(/provider-backed data-flow path is available/)).toBeInTheDocument();
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
        onOpenLocation={vi.fn()}
        onOpenDiagnostic={vi.fn()}
      />,
    );

    expect(screen.getByTestId("analysis-data-flow")).toHaveTextContent(
      "No provider-backed data-flow path is available",
    );
    expect(screen.queryByText("Sink receives the value")).not.toBeInTheDocument();
  });
});
