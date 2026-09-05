import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeWorkspaceRootInfo } from "../../../types";
import {
  clearGitSnapshotCache,
  clearGitSnapshotInFlight,
  fetchGitSnapshotDeduplicated,
  useWorkspaceGitSnapshots,
} from "./useWorkspaceGitSnapshots";

const workspaceMocks = vi.hoisted(() => ({
  workspaceDetectGitRoots: vi.fn(),
}));
const gitMocks = vi.hoisted(() => ({
  gitSnapshot: vi.fn(),
}));
const gitRefreshMocks = vi.hoisted(() => ({
  notifyGitRepoChanged: vi.fn(),
  subscribeGitRepoRefresh: vi.fn(),
}));

vi.mock("../../../lib/editor/workspace", () => workspaceMocks);
vi.mock("../../../lib/git", () => gitMocks);
vi.mock("../../../lib/gitRefresh", () => gitRefreshMocks);

const roots: CodeWorkspaceRootInfo[] = [{
  id: "root-1",
  name: "repo",
  path: "/repo",
  kind: "folder",
}];

const detectedRoot = {
  id: "git-1",
  name: "repo",
  path: "/repo",
  repoRoot: "/repo",
  rootIds: ["root-1"],
};

function snapshot(currentBranch: string, headOid: string) {
  return {
    repoRoot: "/repo",
    currentBranch,
    headOid,
    detached: false,
    upstream: "origin/main",
    ahead: 1,
    behind: 2,
    changes: [{
      path: "src/main.ts",
      oldPath: null,
      status: "modified",
      staged: false,
      unstaged: true,
      conflict: false,
    }],
    remotes: [],
    branches: [],
    stashes: [],
    tags: [],
    settings: {},
  };
}

describe("useWorkspaceGitSnapshots", () => {
  let refreshListener: ((repoRoot: string, revision: number) => void) | null;

  beforeEach(() => {
    refreshListener = null;
    clearGitSnapshotCache();
    clearGitSnapshotInFlight();
    workspaceMocks.workspaceDetectGitRoots.mockReset().mockResolvedValue([detectedRoot]);
    gitMocks.gitSnapshot.mockReset().mockResolvedValue(snapshot("main", "head-1"));
    gitRefreshMocks.notifyGitRepoChanged.mockReset();
    gitRefreshMocks.subscribeGitRepoRefresh.mockReset().mockImplementation((listener) => {
      refreshListener = listener;
      return vi.fn();
    });
  });

  it("detects repositories and owns their periodically refreshed snapshots", async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useWorkspaceGitSnapshots({ roots, onError }));

    await waitFor(() => expect(result.current.gitRootsLoading).toBe(false));
    await waitFor(() => expect(result.current.gitSnapshots["/repo"]?.loading).toBe(false));

    expect(workspaceMocks.workspaceDetectGitRoots).toHaveBeenCalledWith([{
      id: "root-1",
      name: "repo",
      path: "/repo",
    }]);
    expect(result.current.gitRoots).toEqual([detectedRoot]);
    expect(result.current.gitSnapshots["/repo"]).toMatchObject({
      currentBranch: "main",
      headOid: "head-1",
      ahead: 1,
      behind: 2,
      loading: false,
      error: null,
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("refreshes the matching repository and publishes path changes", async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useWorkspaceGitSnapshots({
      roots,
      onError,
    }));
    await waitFor(() => expect(result.current.gitSnapshots["/repo"]?.headOid).toBe("head-1"));

    gitMocks.gitSnapshot.mockResolvedValue(snapshot("feature", "head-2"));
    act(() => refreshListener?.("/repo", 2));
    await waitFor(() => expect(result.current.gitSnapshots["/repo"]?.headOid).toBe("head-2"));

    act(() => result.current.notifyWorkspacePathGitChanged("root-1", "src/main.ts"));
    expect(gitRefreshMocks.notifyGitRepoChanged).toHaveBeenCalledWith("/repo");
  });

  it("reports repository detection failures without retaining detected roots", async () => {
    workspaceMocks.workspaceDetectGitRoots.mockRejectedValue(new Error("git unavailable"));
    const onError = vi.fn();
    const { result } = renderHook(() => useWorkspaceGitSnapshots({ roots, onError }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith("git unavailable"));
    expect(result.current.gitRootsLoading).toBe(false);
    expect(result.current.gitRoots).toEqual([]);
    expect(gitMocks.gitSnapshot).not.toHaveBeenCalled();
  });

  it("ED-PERF-002-A1: skips Git detection and polling while hidden", async () => {
    const onError = vi.fn();
    const { result, rerender } = renderHook(
      ({ visible }) => useWorkspaceGitSnapshots({ roots, onError, visible }),
      { initialProps: { visible: false } },
    );

    await waitFor(() => expect(result.current.gitRootsLoading).toBe(false));
    expect(result.current.gitRoots).toEqual([]);
    expect(workspaceMocks.workspaceDetectGitRoots).not.toHaveBeenCalled();
    expect(gitMocks.gitSnapshot).not.toHaveBeenCalled();

    rerender({ visible: true });
    await waitFor(() => expect(result.current.gitRoots).toEqual([detectedRoot]));
    await waitFor(() => expect(gitMocks.gitSnapshot).toHaveBeenCalledTimes(1));
  });

  it("ED-PERF-002-A1: pauses polling when hidden and resumes it when shown", async () => {
    const onError = vi.fn();
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(
        ({ visible }) => useWorkspaceGitSnapshots({ roots, onError, visible }),
        { initialProps: { visible: true } },
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(result.current.gitRoots).toEqual([detectedRoot]);
      expect(gitMocks.gitSnapshot).toHaveBeenCalledTimes(1);

      rerender({ visible: false });
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(gitMocks.gitSnapshot).toHaveBeenCalledTimes(1);

      rerender({ visible: true });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(gitMocks.gitSnapshot).toHaveBeenCalledTimes(2);

      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(gitMocks.gitSnapshot).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ED-PERF-002-A2: shares in-flight and completed snapshots only by repo root", async () => {
    let resolveSnapshot!: (value: ReturnType<typeof snapshot>) => void;
    gitMocks.gitSnapshot.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSnapshot = resolve;
    }));

    const first = fetchGitSnapshotDeduplicated(" /repo ");
    const second = fetchGitSnapshotDeduplicated("/repo");
    expect(first).toBe(second);
    expect(gitMocks.gitSnapshot).toHaveBeenCalledTimes(1);

    resolveSnapshot(snapshot("main", "head-1"));
    await expect(first).resolves.toMatchObject({ headOid: "head-1" });

    await expect(fetchGitSnapshotDeduplicated("/repo")).resolves.toMatchObject({ headOid: "head-1" });
    expect(gitMocks.gitSnapshot).toHaveBeenCalledTimes(1);

    gitMocks.gitSnapshot.mockResolvedValueOnce({ ...snapshot("feature", "head-2"), repoRoot: "/other" });
    await expect(fetchGitSnapshotDeduplicated("/other")).resolves.toMatchObject({ headOid: "head-2" });
    expect(gitMocks.gitSnapshot).toHaveBeenCalledTimes(2);
  });

  it("ED-PERF-002-A3: suppresses a slow hidden result and refreshes on show", async () => {
    let resolveFirst!: (value: ReturnType<typeof snapshot>) => void;
    gitMocks.gitSnapshot
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce(snapshot("feature", "head-2"));
    const onError = vi.fn();
    const { result, rerender } = renderHook(
      ({ visible }) => useWorkspaceGitSnapshots({ roots, onError, visible }),
      { initialProps: { visible: true } },
    );

    await waitFor(() => expect(gitMocks.gitSnapshot).toHaveBeenCalledTimes(1));
    rerender({ visible: false });
    await act(async () => {
      resolveFirst(snapshot("stale", "stale-head"));
      await Promise.resolve();
    });
    expect(result.current.gitSnapshots["/repo"]?.headOid).not.toBe("stale-head");

    rerender({ visible: true });
    await waitFor(() => expect(result.current.gitSnapshots["/repo"]?.headOid).toBe("head-2"));
    expect(gitMocks.gitSnapshot).toHaveBeenCalledTimes(2);
  });
});
