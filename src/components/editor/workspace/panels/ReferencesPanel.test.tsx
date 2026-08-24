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

  it("keeps role filters disabled with an honest reason and filters libraries by URI owner", () => {
    const inRoot: LspLocation = {
      ...location,
      uri: "file:///C:/repo/src/example.ts",
      path: "C:\\repo\\src\\example.ts",
    };
    const outsideRoot: LspLocation = {
      ...location,
      uri: "file:///C:/other/lib/dep.ts",
      path: "C:\\other\\lib\\dep.ts",
    };
    render(
      <ReferencesPanel
        roots={[{ id: "root", name: "repo", path: "C:\\repo", kind: "folder" }]}
        semanticIndex={createWorkspaceSemanticIndexSnapshot()}
        result={{ loading: false, origin: null, locations: [inRoot, outsideRoot], error: null }}
        onOpenLocation={vi.fn()}
      />,
    );

    // Roles are unknown for plain LSP references: the toggles must not pretend
    // to filter (§8.19.7).
    for (const label of ["Reads", "Writes", "Declarations"]) {
      const checkbox = screen.getByRole("checkbox", { name: label }) as HTMLInputElement;
      expect(checkbox.disabled).toBe(true);
    }
    expect(screen.getAllByRole("button", { name: /example\.ts|dep\.ts/ }).length).toBe(2);

    // The libraries toggle is real: unchecking removes out-of-root owners.
    fireEvent.click(screen.getByTestId("references-filter-libraries"));
    expect(screen.queryByRole("button", { name: /dep\.ts/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /example\.ts/ })).toBeInTheDocument();
  });

  it("reports pin changes upward instead of keeping them panel-local", () => {
    const onPinChange = vi.fn();
    render(
      <ReferencesPanel
        roots={[]}
        semanticIndex={createWorkspaceSemanticIndexSnapshot()}
        result={{ loading: false, origin: null, locations: [location], error: null }}
        onOpenLocation={vi.fn()}
        pinned={false}
        onPinChange={onPinChange}
      />,
    );
    fireEvent.click(screen.getByTestId("references-pin-toggle"));
    expect(onPinChange).toHaveBeenCalledWith(true);
  });
});
