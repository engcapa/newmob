import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeWorkspaceRootInfo } from "../../../types";
import type { WorkspaceTreeLoadResult } from "../../../lib/editor/workspace";
import { useWorkspaceTreeData } from "./useWorkspaceTreeData";

const workspaceMocks = vi.hoisted(() => ({
  workspaceListDir: vi.fn(),
  workspaceCompactChain: vi.fn(),
  workspaceListFilesRecursive: vi.fn(),
}));

vi.mock("../../../lib/editor/workspace", () => workspaceMocks);

const root: CodeWorkspaceRootInfo = {
  id: "root-1",
  name: "repo",
  path: "/repo",
  kind: "folder",
};
const roots = [root];
const expandedRoots = new Set([root.id]);
const noExpandedRoots = new Set<string>();

const ready = (entries: unknown[], truncated = false): WorkspaceTreeLoadResult<unknown> => ({
  state: "ready",
  entries,
  truncated,
});

const ENTRY = {
  name: "a.ts",
  path: "a.ts",
  fileType: "file",
  size: 1,
  mtime: 1,
  isHidden: false,
};

describe("useWorkspaceTreeData", () => {
  beforeEach(() => {
    workspaceMocks.workspaceListDir.mockReset().mockResolvedValue(ready([]));
    workspaceMocks.workspaceCompactChain.mockReset().mockResolvedValue(ready([]));
    workspaceMocks.workspaceListFilesRecursive.mockReset().mockResolvedValue(ready([]));
  });

  it("loads expanded roots and recursive flat indexes", async () => {
    const onError = vi.fn();
    const { result, rerender } = renderHook(
      ({ mode, filter }: { mode: "tree" | "flat"; filter?: string }) => useWorkspaceTreeData({
        roots,
        expandedRootIds: expandedRoots,
        treeViewMode: mode,
        treeFilter: filter ?? "",
        onError,
      }),
      { initialProps: { mode: "tree" as "tree" | "flat", filter: "" } },
    );

    await waitFor(() => expect(result.current.directories["root-1:"]?.loaded).toBe(true));
    expect(workspaceMocks.workspaceListDir).toHaveBeenCalledWith("/repo", "");
    expect(workspaceMocks.workspaceListFilesRecursive).not.toHaveBeenCalled();

    rerender({ mode: "tree", filter: "http" });
    await waitFor(() => expect(result.current.flatFiles[root.id]?.loaded).toBe(true));
    expect(workspaceMocks.workspaceListFilesRecursive).toHaveBeenCalledWith("/repo", "", 25, 2_000);

    // Flat mode reuses the already-warmed index (no second recursive scan).
    workspaceMocks.workspaceListFilesRecursive.mockClear();
    rerender({ mode: "flat", filter: "" });
    expect(result.current.flatFiles[root.id]?.loaded).toBe(true);
    expect(workspaceMocks.workspaceListFilesRecursive).not.toHaveBeenCalled();
  });

  it("discards in-flight results after reset and removes one root cache", async () => {
    let resolveListing!: (result: WorkspaceTreeLoadResult<unknown>) => void;
    workspaceMocks.workspaceListDir.mockImplementation(() => new Promise<WorkspaceTreeLoadResult<unknown>>((resolve) => {
      resolveListing = resolve;
    }));
    const onError = vi.fn();
    const { result } = renderHook(() => useWorkspaceTreeData({
      roots,
      expandedRootIds: noExpandedRoots,
      treeViewMode: "tree",
      onError,
    }));

    let pending: Promise<void>;
    act(() => {
      pending = result.current.loadDir(root.id, "src");
    });
    await waitFor(() => expect(result.current.directories["root-1:src"]?.loading).toBe(true));
    act(() => result.current.reset());
    resolveListing(ready([]));
    await act(async () => pending);
    expect(result.current.directories).toEqual({});

    workspaceMocks.workspaceListDir.mockResolvedValue(ready([]));
    await act(async () => result.current.loadDir(root.id, "src"));
    expect(result.current.directories["root-1:src"]?.loaded).toBe(true);
    act(() => result.current.removeRoot(root.id));
    expect(result.current.directories).toEqual({});
  });

  // ── W0 §8.20.1 boundary: non-ready unions keep cache + error, never crash ──

  it.each([
    ["failed", { state: "failed", message: "workspace_list_dir returned no payload" }],
    ["unavailable", { state: "unavailable", reason: "backend missing" }],
  ])("keeps previous cache + error row when listDir resolves %s", async (_label, payload) => {
    const onError = vi.fn();
    const { result } = renderHook(() => useWorkspaceTreeData({
      roots,
      expandedRootIds: noExpandedRoots,
      treeViewMode: "tree",
      onError,
    }));

    // Seed a good cache first.
    workspaceMocks.workspaceListDir.mockResolvedValueOnce(ready([ENTRY]));
    await act(async () => result.current.loadDir(root.id, "src"));
    expect(result.current.directories["root-1:src"]).toMatchObject({
      loaded: true,
      error: null,
    });

    workspaceMocks.workspaceListDir.mockResolvedValueOnce(payload);
    await act(async () => result.current.loadDir(root.id, "src"));
    const state = result.current.directories["root-1:src"];
    expect(state?.loaded).toBe(true);
    expect(state?.loading).toBe(false);
    expect(state?.error).toBeTruthy();
    // Previous entries survive (error row + retry, not a blank/crashed tree).
    expect(state?.entries).toEqual([ENTRY]);
    expect(onError).toHaveBeenCalled();
  });

  it("propagates the truncated flag from a capped recursive listing", async () => {
    workspaceMocks.workspaceListFilesRecursive.mockResolvedValue(
      ready([ENTRY], true),
    );
    const onError = vi.fn();
    const { result } = renderHook(() => useWorkspaceTreeData({
      roots,
      expandedRootIds: noExpandedRoots,
      treeViewMode: "flat",
      onError,
    }));
    await waitFor(() => expect(result.current.flatFiles[root.id]?.loaded).toBe(true));
    expect(result.current.flatFiles[root.id]?.truncated).toBe(true);
  });

  it("does not resurrect cache when the root disappears mid-flight", async () => {
    let resolveListing!: (result: WorkspaceTreeLoadResult<unknown>) => void;
    workspaceMocks.workspaceListDir.mockImplementation(() => new Promise<WorkspaceTreeLoadResult<unknown>>((resolve) => {
      resolveListing = resolve;
    }));
    const onError = vi.fn();
    const { result, rerender } = renderHook(
      ({ currentRoots }: { currentRoots: CodeWorkspaceRootInfo[] }) => useWorkspaceTreeData({
        roots: currentRoots,
        expandedRootIds: noExpandedRoots,
        treeViewMode: "tree",
        onError,
      }),
      { initialProps: { currentRoots: roots } },
    );

    let pending: Promise<void>;
    act(() => {
      pending = result.current.loadDir(root.id, "src");
    });
    await waitFor(() => expect(result.current.directories["root-1:src"]?.loading).toBe(true));

    // Root removed while the request is in flight…
    rerender({ currentRoots: [] });
    act(() => result.current.removeRoot(root.id));
    resolveListing(ready([ENTRY]));
    await act(async () => pending);
    // …the late response must not write state back for the dead root.
    expect(result.current.directories["root-1:src"]).toBeUndefined();
  });
});
