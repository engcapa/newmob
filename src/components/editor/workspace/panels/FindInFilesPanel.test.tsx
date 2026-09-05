import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WorkspaceSearchEvent,
  WorkspaceSearchMatch,
} from "../../../../lib/editor/workspaceSearch";
import type { LspWorkspaceEdit } from "../../../../lib/editor/lsp";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import {
  DEFAULT_MATCHES_PER_FILE,
  FindInFilesPanel,
  matchSegments,
} from "./FindInFilesPanel";

const searchMocks = vi.hoisted(() => ({
  newWorkspaceSearchId: vi.fn(() => "search-1"),
  subscribeWorkspaceSearch: vi.fn(),
  workspaceSearchStart: vi.fn(),
  workspaceSearchCancel: vi.fn(async () => true),
}));

vi.mock("../../../../lib/editor/workspaceSearch", () => searchMocks);

const roots: CodeWorkspaceRootInfo[] = [
  { id: "root-1", name: "app", path: "C:/repo/app", kind: "git" },
];

function searchMatch(overrides: Partial<WorkspaceSearchMatch> = {}): WorkspaceSearchMatch {
  return {
    rootId: "root-1",
    rootName: "app",
    rootPath: "C:/repo/app",
    path: "src/a.ts",
    lineNumber: 12,
    column: 7,
    matchStart: 6,
    matchEnd: 12,
    lineText: "const needle = 1;",
    ...overrides,
  };
}

function doneEvent(overrides: Partial<WorkspaceSearchEvent> = {}): WorkspaceSearchEvent {
  return {
    searchId: "search-1",
    kind: "done",
    matches: [],
    truncated: false,
    cancelled: false,
    filesScanned: 4,
    totalMatches: 3,
    error: null,
    ...overrides,
  };
}

async function runSearch(query = "needle"): Promise<(event: WorkspaceSearchEvent) => void> {
  const unlisten = vi.fn();
  searchMocks.subscribeWorkspaceSearch.mockResolvedValue(unlisten);
  searchMocks.workspaceSearchStart.mockResolvedValue("search-1");

  const input = screen.getByLabelText("Search query");
  fireEvent.change(input, { target: { value: query } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(searchMocks.workspaceSearchStart).toHaveBeenCalled());
  return searchMocks.subscribeWorkspaceSearch.mock.calls.at(-1)![1];
}

describe("FindInFilesPanel", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.stubGlobal("confirm", vi.fn(() => true));
  });

  it("subscribes before starting and streams grouped results", async () => {
    const onOpenMatch = vi.fn();
    render(<FindInFilesPanel roots={roots} onOpenMatch={onOpenMatch} />);

    const emit = await runSearch();

    expect(searchMocks.subscribeWorkspaceSearch.mock.invocationCallOrder[0])
      .toBeLessThan(searchMocks.workspaceSearchStart.mock.invocationCallOrder[0]);
    expect(searchMocks.workspaceSearchStart).toHaveBeenCalledWith(
      "search-1",
      [{ id: "root-1", name: "app", path: "C:/repo/app" }],
      "needle",
      expect.objectContaining({ caseSensitive: false, wholeWord: false, regexp: false }),
    );

    act(() => {
      emit({
        ...doneEvent(),
        kind: "batch",
        matches: [
          searchMatch(),
          searchMatch({ lineNumber: 20, column: 1, matchStart: 0, matchEnd: 6, lineText: "needle();" }),
          searchMatch({ path: "src/b.ts", lineText: "let needle = 2;", matchStart: 4, matchEnd: 10, column: 5 }),
        ],
      });
      emit(doneEvent());
    });

    expect(screen.getByText("app/src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("app/src/b.ts")).toBeInTheDocument();
    expect(screen.getByText("3 results · 2 files")).toBeInTheDocument();
    // Keyword hits use the dedicated find-match styling (not plain text-inherit).
    const hits = screen.getAllByTestId("code-workspace-find-match-hit");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].className).toContain("find-match-bg");

    fireEvent.click(screen.getByRole("button", { name: /12:7/ }));
    expect(onOpenMatch).toHaveBeenCalledWith(searchMatch(), { preview: true });

    fireEvent.doubleClick(screen.getByTitle("app/src/a.ts:12:7"));
    expect(onOpenMatch).toHaveBeenLastCalledWith(searchMatch(), { preview: false });
  });

  it("passes search options and globs through to the backend", async () => {
    render(<FindInFilesPanel roots={roots} onOpenMatch={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Match case" }));
    fireEvent.click(screen.getByRole("button", { name: "Regular expression" }));
    fireEvent.change(screen.getByLabelText("Include globs"), { target: { value: "*.ts, src/**" } });
    fireEvent.change(screen.getByLabelText("Exclude globs"), { target: { value: "dist/**" } });
    await runSearch("nee.le");

    expect(searchMocks.workspaceSearchStart).toHaveBeenCalledWith(
      "search-1",
      expect.anything(),
      "nee.le",
      expect.objectContaining({
        caseSensitive: true,
        regexp: true,
        includeGlobs: ["*.ts", "src/**"],
        excludeGlobs: ["dist/**"],
      }),
    );
  });

  it("cancels a running search and reports partial results", async () => {
    render(<FindInFilesPanel roots={roots} onOpenMatch={vi.fn()} />);
    const emit = await runSearch();

    fireEvent.click(screen.getByRole("button", { name: "Cancel search" }));
    expect(searchMocks.workspaceSearchCancel).toHaveBeenCalledWith("search-1");

    act(() => emit(doneEvent({ cancelled: true, totalMatches: 1 })));
    expect(screen.getByText(/Search cancelled/)).toBeInTheDocument();
  });

  it("reports truncation and backend errors", async () => {
    render(<FindInFilesPanel roots={roots} onOpenMatch={vi.fn()} />);
    let emit = await runSearch();
    act(() => emit(doneEvent({ truncated: true })));
    expect(screen.getByText(/Match limit reached/)).toBeInTheDocument();

    emit = await runSearch("other");
    act(() => emit(doneEvent({ kind: "error", error: "Invalid search pattern: boom" })));
    expect(screen.getByText("Invalid search pattern: boom")).toBeInTheDocument();
  });

  it("explains when there are no roots to search", () => {
    render(<FindInFilesPanel roots={[]} onOpenMatch={vi.fn()} />);
    expect(screen.getByText("Add a folder to the workspace to search its files")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run search" })).toBeDisabled();
  });

  it("limits visible matches per file and expands on demand", async () => {
    render(<FindInFilesPanel roots={roots} onOpenMatch={vi.fn()} />);
    const emit = await runSearch();
    const many = Array.from({ length: DEFAULT_MATCHES_PER_FILE + 5 }, (_, index) =>
      searchMatch({
        lineNumber: index + 1,
        column: 1,
        matchStart: 0,
        matchEnd: 6,
        lineText: `needle at ${index + 1}`,
      }),
    );

    act(() => {
      emit({ ...doneEvent(), kind: "batch", matches: many });
      emit(doneEvent({ totalMatches: many.length }));
    });

    expect(screen.getAllByTestId("code-workspace-find-match-hit")).toHaveLength(DEFAULT_MATCHES_PER_FILE);
    expect(screen.getByTestId("code-workspace-find-file-count")).toHaveTextContent(
      `${DEFAULT_MATCHES_PER_FILE}/${many.length}`,
    );
    expect(screen.getByTestId("code-workspace-find-show-more")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("code-workspace-find-show-all"));
    expect(screen.getAllByTestId("code-workspace-find-match-hit")).toHaveLength(many.length);
    expect(screen.queryByTestId("code-workspace-find-show-more")).not.toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-find-file-count")).toHaveTextContent(`${many.length}`);
  });

  it("collapses a file group without dropping the full replace set", async () => {
    const onReplaceMatches = vi.fn();
    render(
      <FindInFilesPanel
        roots={roots}
        onOpenMatch={vi.fn()}
        onReplaceMatches={onReplaceMatches}
      />,
    );
    const emit = await runSearch();
    const matches = [
      searchMatch({ lineNumber: 1, lineText: "needle one", matchStart: 0, matchEnd: 6, column: 1 }),
      searchMatch({ lineNumber: 2, lineText: "needle two", matchStart: 0, matchEnd: 6, column: 1 }),
      searchMatch({ path: "src/b.ts", lineNumber: 3, lineText: "needle three", matchStart: 0, matchEnd: 6, column: 1 }),
    ];

    act(() => {
      emit({ ...doneEvent(), kind: "batch", matches });
      emit(doneEvent({ totalMatches: matches.length }));
    });

    expect(screen.getAllByTestId("code-workspace-find-match-hit")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Collapse app/src/a.ts" }));
    // Two matches in a.ts are hidden; b.ts remains.
    expect(screen.getAllByTestId("code-workspace-find-match-hit")).toHaveLength(1);

    // ED-FIND-004: replace opens a structured preview instead of a bare
    // confirm; the full result set (not just visible rows) is committed.
    fireEvent.click(screen.getByRole("button", { name: "Preview replace all matches" }));
    expect(await screen.findByTestId("code-workspace-replace-preview")).toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-replace-counts")).toHaveTextContent("3 of 3");
  });

  it("applies editor-style syntax classes on result lines once the language loads", async () => {
    render(<FindInFilesPanel roots={roots} onOpenMatch={vi.fn()} />);
    const emit = await runSearch();

    act(() => {
      emit({
        ...doneEvent(),
        kind: "batch",
        matches: [searchMatch({ lineText: "const needle = 1;", matchStart: 6, matchEnd: 12, column: 7 })],
      });
      emit(doneEvent({ totalMatches: 1 }));
    });

    await waitFor(() => {
      const line = document.querySelector(".taomni-find-line");
      expect(line?.querySelector(".tok-keyword")).toBeTruthy();
    });
    expect(screen.getByTestId("code-workspace-find-match-hit")).toHaveTextContent("needle");
  });
});

describe("matchSegments", () => {
  it("trims leading whitespace and keeps the match highlighted", () => {
    const segments = matchSegments(searchMatch({
      lineText: "    const needle = 1;",
      matchStart: 10,
      matchEnd: 16,
    }));
    expect(segments.before).toBe("const ");
    expect(segments.hit).toBe("needle");
    expect(segments.after).toBe(" = 1;");
    expect(segments.elidedStart).toBe(false);
    expect(segments.elidedEnd).toBe(false);
    expect(segments.text).toBe("const needle = 1;");
    expect(segments.hitStart).toBe(6);
    expect(segments.hitEnd).toBe(12);
  });

  it("elides long prefixes ahead of the match", () => {
    const prefix = "x".repeat(80);
    const segments = matchSegments(searchMatch({
      lineText: `${prefix}needle`,
      matchStart: 80,
      matchEnd: 86,
    }));
    expect(segments.before.startsWith("…")).toBe(true);
    expect(segments.hit).toBe("needle");
    expect(segments.elidedStart).toBe(true);
    // Default CONTEXT_BEFORE_MATCH is 48 when after-side is empty.
    expect(Array.from(segments.text).length).toBeLessThanOrEqual(120);
    expect(segments.before).toBe(`…${"x".repeat(48)}`);
  });

  it("elides long suffixes after the match", () => {
    const suffix = "y".repeat(100);
    const segments = matchSegments(searchMatch({
      lineText: `needle${suffix}`,
      matchStart: 0,
      matchEnd: 6,
    }));
    expect(segments.hit).toBe("needle");
    expect(segments.after.endsWith("…")).toBe(true);
    expect(segments.elidedEnd).toBe(true);
    expect(Array.from(segments.text).length).toBeLessThanOrEqual(120);
  });

  it("keeps the full hit when the line is long on both sides", () => {
    const left = "L".repeat(80);
    const right = "R".repeat(80);
    const segments = matchSegments(searchMatch({
      lineText: `${left}HIT${right}`,
      matchStart: 80,
      matchEnd: 83,
    }));
    expect(segments.hit).toBe("HIT");
    expect(segments.elidedStart).toBe(true);
    expect(segments.elidedEnd).toBe(true);
    expect(Array.from(segments.text).length).toBeLessThanOrEqual(120);
    expect(segments.text.includes("HIT")).toBe(true);
  });

  it("slices by code points so CJK offsets stay aligned", () => {
    const segments = matchSegments(searchMatch({
      lineText: "变量 needle 结束",
      matchStart: 3,
      matchEnd: 9,
    }));
    expect(segments.hit).toBe("needle");
    expect(segments.after).toBe(" 结束");
  });
});

describe("ED-FIND-003: scope planning in FindInFilesPanel", () => {
  afterEach(async () => {
    cleanup();
    const { useProjectFactsStore } = await import("../../../../stores/projectFactsStore");
    useProjectFactsStore.setState({ workspaces: {} });
  });

  const moduleRoots = [{ id: "root-1", name: "app", path: "C:/repo/app", kind: "git" as const }];

  async function seedModuleFacts(generation = 2) {
    const { useProjectFactsStore } = await import("../../../../stores/projectFactsStore");
    const { buildProjectStructureSnapshotV2 } = await import("../projectStructureModel");
    useProjectFactsStore.setState({ workspaces: {} });
    useProjectFactsStore.setState({
      workspaces: {
        "C:/repo/app": {
          workspaceRoot: "C:/repo/app",
          generation,
          status: "ready",
          reason: null,
          fingerprint: "fp",
          structure: buildProjectStructureSnapshotV2({
            generation,
            modules: [
              {
                id: "com.example:core",
                buildSystem: "maven",
                root: "C:/repo/app/core",
                sourceRoots: ["C:/repo/app/core/src/main/java"],
                testRoots: [],
                generatedRoots: [],
                excludedRoots: [],
                dependencyFingerprint: "cp",
              },
            ],
            source: "maven-model",
          }),
          provenance: null,
          isStale: false,
          abortController: null,
        },
      },
    });
  }

  it("shows the scope selector and fails module scope closed without facts (A1/A3)", async () => {
    const { useProjectFactsStore } = await import("../../../../stores/projectFactsStore");
    useProjectFactsStore.setState({ workspaces: {} });
    render(<FindInFilesPanel roots={moduleRoots} onOpenMatch={vi.fn()} />);

    const scopeSelect = screen.getByLabelText("Search scope") as HTMLSelectElement;
    expect(scopeSelect.value).toBe("project");
    fireEvent.change(scopeSelect, { target: { value: "module" } });

    expect(await screen.findByTestId("code-workspace-find-scope-notice")).toBeInTheDocument();
    expect(searchMocks.workspaceSearchStart).not.toHaveBeenCalled();
  });

  it("searches exact module roots from ready facts (A1)", async () => {
    await seedModuleFacts(2);
    render(<FindInFilesPanel roots={moduleRoots} onOpenMatch={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Search scope"), { target: { value: "module" } });
    // Module picker lists the ready facts module.
    expect(screen.getByLabelText("Search module")).toBeInTheDocument();
    const emit = await runSearch();

    expect(searchMocks.workspaceSearchStart).toHaveBeenCalledWith(
      "search-1",
      expect.arrayContaining([
        expect.objectContaining({ path: "C:/repo/app/core" }),
        expect.objectContaining({ path: "C:/repo/app/core/src/main/java" }),
      ]),
      "needle",
      expect.anything(),
    );

    act(() => {
      emit({
        ...doneEvent(),
        kind: "batch",
        matches: [
          searchMatch({ rootPath: "C:/repo/app", path: "core/src/main/java/Service.java", lineText: "needle service" }),
          searchMatch({ rootPath: "C:/repo/app", path: "other/Outside.java", lineText: "needle outside" }),
        ],
      });
      emit(doneEvent({ totalMatches: 1 }));
    });
    // Client-side scope filter keeps the module match and drops the outsider.
    expect(screen.getByText("app/core/src/main/java/Service.java")).toBeInTheDocument();
    expect(screen.queryByText("app/other/Outside.java")).not.toBeInTheDocument();
  });

  it("drops superseded search batches when a new search starts (A4)", async () => {
    render(<FindInFilesPanel roots={roots} onOpenMatch={vi.fn()} />);

    searchMocks.newWorkspaceSearchId
      .mockReturnValueOnce("search-1")
      .mockReturnValueOnce("search-2");
    const unlisten = vi.fn();
    searchMocks.subscribeWorkspaceSearch.mockResolvedValue(unlisten);
    searchMocks.workspaceSearchStart.mockResolvedValue("search-2");

    const input = screen.getByLabelText("Search query");
    fireEvent.change(input, { target: { value: "first" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(searchMocks.workspaceSearchStart).toHaveBeenCalledTimes(1));
    const firstEmit = searchMocks.subscribeWorkspaceSearch.mock.calls.at(-1)![1];

    fireEvent.change(input, { target: { value: "second" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(searchMocks.workspaceSearchStart).toHaveBeenCalledTimes(2));

    // Late batch from the superseded search is ignored.
    act(() => {
      firstEmit({ ...doneEvent(), kind: "batch", matches: [searchMatch({ lineText: "stale batch" })] });
      firstEmit(doneEvent());
    });
    expect(screen.queryByText(/stale batch/)).not.toBeInTheDocument();
    expect(searchMocks.workspaceSearchCancel).toHaveBeenCalledWith("search-1");
  });

  it("stops publishing when facts generation moves mid-search (A4)", async () => {
    await seedModuleFacts(2);
    render(<FindInFilesPanel roots={moduleRoots} onOpenMatch={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Search scope"), { target: { value: "module" } });
    const emit = await runSearch();

    // Facts refresh bumps the generation while results stream in.
    const { useProjectFactsStore } = await import("../../../../stores/projectFactsStore");
    const live = useProjectFactsStore.getState().getWorkspaceFacts("C:/repo/app");
    useProjectFactsStore.setState({
      workspaces: { "C:/repo/app": { ...live, generation: 3 } },
    });

    act(() => {
      emit({
        ...doneEvent(),
        kind: "batch",
        matches: [searchMatch({ rootPath: "C:/repo/app", path: "core/src/main/java/Service.java", lineText: "late needle" })],
      });
    });

    expect(screen.queryByText(/late needle/)).not.toBeInTheDocument();
    expect(await screen.findByTestId("code-workspace-find-error")).toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-find-error")).toHaveTextContent(/G2 -> G3/);
  });
});

describe("ED-FIND-004: replace preview commit flow in FindInFilesPanel", () => {
  afterEach(() => {
    cleanup();
  });

  async function openPreview(
    onReplaceMatches: (
      matches: WorkspaceSearchMatch[],
      replacement: string,
      edit: LspWorkspaceEdit,
    ) => Promise<{ ok: boolean; appliedCount?: number; fileCount?: number; message?: string }>,
  ) {
    render(
      <FindInFilesPanel
        roots={roots}
        onOpenMatch={vi.fn()}
        onReplaceMatches={onReplaceMatches}
      />,
    );
    const emit = await runSearch();
    const matches = [
      searchMatch({ lineNumber: 1, lineText: "needle one", matchStart: 0, matchEnd: 6, column: 1 }),
      searchMatch({ path: "src/b.ts", lineNumber: 3, lineText: "needle three", matchStart: 0, matchEnd: 6, column: 1 }),
    ];
    act(() => {
      emit({ ...doneEvent(), kind: "batch", matches });
      emit(doneEvent({ totalMatches: matches.length }));
    });
    fireEvent.change(screen.getByLabelText("Replace text"), { target: { value: "thread" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview replace all matches" }));
    expect(await screen.findByTestId("code-workspace-replace-preview")).toBeInTheDocument();
    return matches;
  }

  it("commits the filtered set and closes on success (A1/A3)", async () => {
    const onReplaceMatches = vi.fn(
      async (
        _matches: WorkspaceSearchMatch[],
        _replacement: string,
        _edit: LspWorkspaceEdit,
      ): Promise<{ ok: boolean; appliedCount?: number; fileCount?: number; message?: string }> =>
        ({ ok: true as const, appliedCount: 1, fileCount: 1 }),
    );
    await openPreview(onReplaceMatches);

    // Exclude the b.ts occurrence; only a.ts remains.
    fireEvent.click(screen.getByLabelText("Include occurrence at C:/repo/app/src/b.ts:3"));
    expect(screen.getByTestId("code-workspace-replace-counts")).toHaveTextContent("1 of 2");
    fireEvent.click(screen.getByTestId("code-workspace-replace-commit"));

    await waitFor(() => expect(onReplaceMatches).toHaveBeenCalledTimes(1));
    const call = onReplaceMatches.mock.calls[0];
    if (!call) throw new Error("expected onReplaceMatches to have been called");
    const [filtered, replacement, edit] = call;
    if (!filtered || replacement === undefined || !edit) {
      throw new Error("expected commit arguments");
    }
    expect(filtered).toHaveLength(1);
    expect(filtered[0].path).toBe("src/a.ts");
    expect(replacement).toBe("thread");
    expect(edit.documentEdits).toHaveLength(1);
    await waitFor(() => expect(screen.queryByTestId("code-workspace-replace-preview")).not.toBeInTheDocument());
  });

  it("keeps the preview open and shows the blocker message on conflict (A2)", async () => {
    const onReplaceMatches = vi.fn(
      async () => ({ ok: false as const, message: "Replace blocked: dirty buffer" }),
    );
    await openPreview(onReplaceMatches);

    fireEvent.click(screen.getByTestId("code-workspace-replace-commit"));
    expect(await screen.findByTestId("code-workspace-replace-commit-error")).toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-replace-commit-error")).toHaveTextContent("dirty buffer");
    // Zero commit: the dialog stays open for correction or cancel.
    expect(screen.getByTestId("code-workspace-replace-preview")).toBeInTheDocument();
    expect(onReplaceMatches).toHaveBeenCalledTimes(1);
  });

  it("cancels with zero backend effect (A2)", async () => {
    const onReplaceMatches = vi.fn();
    await openPreview(onReplaceMatches);

    fireEvent.click(screen.getByTestId("code-workspace-replace-cancel"));
    expect(screen.queryByTestId("code-workspace-replace-preview")).not.toBeInTheDocument();
    expect(onReplaceMatches).not.toHaveBeenCalled();
  });
});
