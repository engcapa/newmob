import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LspLocation } from "../../../../lib/editor/lsp";
import { ReferencesPanel } from "./ReferencesPanel";
import { createWorkspaceSemanticIndexSnapshot } from "../workspaceSemanticIndex";

const location: LspLocation = {
  uri: "file:///C:/repo/src/example.ts",
  path: "C:\\repo\\src\\example.ts",
  range: {
    start: { line: 4, character: 2 },
    end: { line: 4, character: 9 },
  },
};

describe("ReferencesPanel", () => {
  afterEach(() => cleanup());

  it("shows workspace-relative locations and opens the selected reference", () => {
    const onOpenLocation = vi.fn();
    render(
      <ReferencesPanel
        roots={[{ id: "root", name: "repo", path: "C:\\repo", kind: "folder" }]}
        semanticIndex={createWorkspaceSemanticIndexSnapshot()}
        result={{ loading: false, origin: "example.ts:1:1", locations: [location], error: null }}
        onOpenLocation={onOpenLocation}
      />,
    );

    const result = screen.getByRole("button", { name: /repo\/src\/example.ts/ });
    expect(result).toHaveTextContent("5:3");
    fireEvent.click(result);
    expect(onOpenLocation).toHaveBeenCalledWith(location);
  });

  it("renders empty and loading states explicitly", () => {
    const { rerender } = render(
      <ReferencesPanel
        roots={[]}
        semanticIndex={createWorkspaceSemanticIndexSnapshot()}
        result={{ loading: false, origin: null, locations: [], error: null }}
        onOpenLocation={vi.fn()}
      />,
    );
    expect(screen.getByText("No references")).toBeInTheDocument();

    rerender(
      <ReferencesPanel
        roots={[]}
        semanticIndex={createWorkspaceSemanticIndexSnapshot()}
        result={{ loading: true, origin: null, locations: [], error: null }}
        onOpenLocation={vi.fn()}
      />,
    );
    expect(screen.getByText("Finding references...")).toBeInTheDocument();
  });

  it("marks a previously returned list stale after the workspace revision moves", () => {
    const snapshot = createWorkspaceSemanticIndexSnapshot();
    const current = {
      ...snapshot,
      status: "ready" as const,
      provider: "language-server" as const,
      generation: 2,
      revision: 3,
      indexedRevision: 3,
      staleReasons: [],
    };
    render(
      <ReferencesPanel
        roots={[]}
        semanticIndex={current}
        result={{
          loading: false,
          origin: "main.ts",
          locations: [],
          error: null,
          semanticGeneration: 2,
          semanticRevision: 2,
        }}
        onOpenLocation={vi.fn()}
      />,
    );
    expect(screen.getByTestId("references-semantic-index")).toHaveTextContent("Stale · result generation 2");
  });
});
