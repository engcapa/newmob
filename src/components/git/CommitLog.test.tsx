import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitBlobPair, GitChange, GitLogEntry } from "../../lib/git";
import { CommitLog } from "./CommitLog";

const gitMocks = vi.hoisted(() => ({
  gitBlobPair: vi.fn(),
  gitCommitFiles: vi.fn(),
  gitLog: vi.fn(),
}));

vi.mock("../../lib/git", () => gitMocks);

vi.mock("./DiffViewer", () => ({
  DiffViewer: ({ emptyLabel, loading, pair }: {
    emptyLabel?: string;
    loading?: boolean;
    pair?: GitBlobPair | null;
  }) => (
    <div data-testid="diff-viewer" data-path={pair?.path ?? ""}>
      {loading ? "Loading diff" : pair?.path ?? emptyLabel}
    </div>
  ),
}));

function commit(oid: string): GitLogEntry {
  return {
    oid,
    shortOid: oid.slice(0, 7),
    parents: [],
    authorName: "Ada",
    authorEmail: "ada@example.com",
    date: "2026-02-02T10:00:00Z",
    subject: "Commit",
    body: "",
    refs: [],
  };
}

function change(path: string): GitChange {
  return {
    path,
    oldPath: null,
    status: "modified",
    staged: false,
    unstaged: false,
    conflict: false,
  };
}

function pair(path: string): GitBlobPair {
  return {
    path,
    oldPath: null,
    oldText: "old",
    newText: "new",
    oldExists: true,
    newExists: true,
    binary: false,
    image: false,
    oldImageB64: null,
    newImageB64: null,
    oversize: false,
    oldSize: 3,
    newSize: 3,
  };
}

describe("CommitLog", () => {
  beforeEach(() => {
    gitMocks.gitBlobPair.mockReset();
    gitMocks.gitCommitFiles.mockReset();
    gitMocks.gitLog.mockReset();
    gitMocks.gitCommitFiles.mockResolvedValue([change("deleted.txt"), change("long-lines.txt")]);
    gitMocks.gitBlobPair.mockImplementation(async (_repoRoot: string, path: string) => pair(path));
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps the selected file when a log refresh returns the same commit", async () => {
    let resolveRefresh: ((entries: GitLogEntry[]) => void) | undefined;
    const refresh = new Promise<GitLogEntry[]>((resolve) => {
      resolveRefresh = resolve;
    });
    gitMocks.gitLog
      .mockResolvedValueOnce([commit("commit-1")])
      .mockReturnValueOnce(refresh);

    const props = {
      repoRoot: "/repo",
      headOid: "head-1",
      busy: false,
      onContextMenu: vi.fn(),
    };
    const { rerender } = render(<CommitLog {...props} />);

    const longFile = await waitFor(() => {
      const element = screen.getAllByTestId("git-log-file")
        .find((item) => item.getAttribute("data-path") === "long-lines.txt");
      if (!element) throw new Error("long-lines.txt file row is not rendered");
      return element;
    });
    fireEvent.click(longFile);
    await waitFor(() => expect(longFile).toHaveAttribute("aria-pressed", "true"));

    rerender(<CommitLog {...props} headOid="head-2" />);
    await waitFor(() => expect(gitMocks.gitLog).toHaveBeenCalledTimes(2));
    resolveRefresh?.([commit("commit-1")]);

    await waitFor(() => {
      const refreshedLongFile = screen.getAllByTestId("git-log-file")
        .find((item) => item.getAttribute("data-path") === "long-lines.txt");
      expect(refreshedLongFile).toHaveAttribute("aria-pressed", "true");
    });
    expect(gitMocks.gitCommitFiles).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId("diff-viewer"))
      .toHaveAttribute("data-path", "long-lines.txt"));
  });
});
