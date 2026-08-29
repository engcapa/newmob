import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCodeWorkspaceStore } from "../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceFileRef, CodeWorkspaceRootInfo } from "../../../types";
import type { OpenFileState } from "./codeWorkspaceModel";
import { useWorkspaceNavigation } from "./useWorkspaceNavigation";
import { WorkspaceSemanticQueryHost } from "./workspaceSemanticQueryHost";

const roots: CodeWorkspaceRootInfo[] = [{
  id: "root-1",
  name: "repo",
  path: "/repo",
  kind: "folder",
}];

function openState(ref: CodeWorkspaceFileRef): OpenFileState {
  const path = ref.path;
  return {
    key: ref.kind === "root" ? `root:${ref.rootId}:${path}` : `loose:${ref.id}`,
    ref,
    path,
    title: path.split("/").pop() ?? path,
    subtitle: `repo / ${path}`,
    languagePath: path,
    text: "",
    savedText: "",
    eol: "LF",
    hash: "hash",
    mtime: 1,
    size: 0,
    loading: false,
    saving: false,
    dirty: false,
    documentRevision: 0,
    error: null,
  };
}

describe("useWorkspaceNavigation", () => {
  beforeEach(() => {
    useCodeWorkspaceStore.setState({ byInstanceId: {} });
    useCodeWorkspaceStore.getState().ensureInstance("workspace-1");
  });

  it("builds file navigation items and opens search after warming every root", () => {
    const loadFlatFiles = vi.fn(async () => {});
    const setMode = vi.fn();
    const setOpen = vi.fn();
    const { result } = renderHook(() => useWorkspaceNavigation({
      workspaceInstanceId: "workspace-1",
      activeKey: null,
      roots,
      flatFiles: {
        "root-1": {
          entries: [
            { name: "main.ts", path: "src/main.ts", fileType: "file", size: 1, mtime: 1, isHidden: false },
            { name: ".git", path: ".git", fileType: "dir", size: 0, mtime: 1, isHidden: true },
          ],
          loaded: true,
          loading: false,
          error: null,
          truncated: true,
        },
      },
      visible: true,
      rootsRef: { current: roots },
      looseFilesRef: { current: [] },
      openFilesRef: { current: {} },
      loadFlatFiles,
      openFile: vi.fn(async () => {}),
      revealLocation: vi.fn(),
      setSearchEverywhereMode: setMode,
      setSearchEverywhereOpen: setOpen,
      setRecentEntries: vi.fn(),
      setRecentFilesOpen: vi.fn(),
    }));

    expect(result.current.goToFileItems).toEqual([{
      rootId: "root-1",
      rootName: "repo",
      path: "src/main.ts",
    }]);
    expect(result.current.goToFileTruncated).toBe(true);
    act(() => result.current.openSearchEverywhere("symbols"));
    expect(loadFlatFiles).toHaveBeenCalledWith("root-1");
    expect(setMode).toHaveBeenCalledWith("symbols");
    expect(setOpen).toHaveBeenCalledWith(true);
  });

  it("owns recent files and back-forward navigation history with caret restore", async () => {
    const first: CodeWorkspaceFileRef = { kind: "root", rootId: "root-1", path: "src/first.ts" };
    const second: CodeWorkspaceFileRef = { kind: "root", rootId: "root-1", path: "src/second.ts" };
    const openFilesRef = { current: {
      "root:root-1:src/first.ts": openState(first),
      "root:root-1:src/second.ts": openState(second),
    } };
    const openFile = vi.fn(async () => {});
    const revealLocation = vi.fn();
    const setRecentEntries = vi.fn();
    const setRecentFilesOpen = vi.fn();
    const props = {
      workspaceInstanceId: "workspace-1",
      roots,
      flatFiles: {},
      visible: false,
      rootsRef: { current: roots },
      looseFilesRef: { current: [] },
      openFilesRef,
      loadFlatFiles: vi.fn(async () => {}),
      openFile,
      revealLocation,
      setSearchEverywhereMode: vi.fn(),
      setSearchEverywhereOpen: vi.fn(),
      setRecentEntries,
      setRecentFilesOpen,
    };
    const { result, rerender } = renderHook(
      ({ activeKey }) => useWorkspaceNavigation({ ...props, activeKey }),
      { initialProps: { activeKey: "root:root-1:src/first.ts" as string | null } },
    );
    act(() => result.current.noteCaretPosition("root:root-1:src/first.ts", { line: 10, character: 4 }));
    rerender({ activeKey: "root:root-1:src/second.ts" });
    await waitFor(() => expect(result.current.navCan.back).toBe(true));

    act(() => result.current.navigateHistory(-1));
    expect(openFile).toHaveBeenCalledWith(first);
    expect(revealLocation).toHaveBeenCalledWith("root:root-1:src/first.ts", { line: 10, character: 4 });
    expect(result.current.navCan.forward).toBe(true);

    act(() => result.current.openRecentFiles());
    expect(setRecentEntries).toHaveBeenCalledWith([
      expect.objectContaining({ ref: second, open: true }),
      expect.objectContaining({ ref: first, open: true }),
    ]);
    expect(setRecentFilesOpen).toHaveBeenCalledWith(true);
  });

  it("records origin and destination so same-file go-to-definition can navigate back", () => {
    const file: CodeWorkspaceFileRef = { kind: "root", rootId: "root-1", path: "src/Main.java" };
    const openFilesRef = {
      current: { "root:root-1:src/Main.java": openState(file) },
    };
    const openFile = vi.fn(async () => {});
    const revealLocation = vi.fn();
    const { result } = renderHook(() => useWorkspaceNavigation({
      workspaceInstanceId: "workspace-1",
      activeKey: "root:root-1:src/Main.java",
      roots,
      flatFiles: {},
      visible: false,
      rootsRef: { current: roots },
      looseFilesRef: { current: [] },
      openFilesRef,
      loadFlatFiles: vi.fn(async () => {}),
      openFile,
      revealLocation,
      setSearchEverywhereMode: vi.fn(),
      setSearchEverywhereOpen: vi.fn(),
      setRecentEntries: vi.fn(),
      setRecentFilesOpen: vi.fn(),
    }));

    act(() => {
      result.current.recordNavigationLocation(file, { line: 5, character: 2 });
      result.current.recordNavigationLocation(file, { line: 40, character: 8 }, { replaceSameFile: false });
    });
    expect(result.current.navCan.back).toBe(true);

    act(() => result.current.navigateHistory(-1));
    expect(openFile).toHaveBeenCalledWith(file);
    expect(revealLocation).toHaveBeenCalledWith("root:root-1:src/Main.java", { line: 5, character: 2 });
  });

  it("opens Go to File results in preview or the opposite split", () => {
    const openFile = vi.fn(async () => {});
    const setSearchEverywhereOpen = vi.fn();
    const { result } = renderHook(() => useWorkspaceNavigation({
      workspaceInstanceId: "workspace-1",
      activeKey: null,
      roots,
      flatFiles: {},
      visible: false,
      rootsRef: { current: roots },
      looseFilesRef: { current: [] },
      openFilesRef: { current: {} },
      loadFlatFiles: vi.fn(async () => {}),
      openFile,
      revealLocation: vi.fn(),
      setSearchEverywhereMode: vi.fn(),
      setSearchEverywhereOpen,
      setRecentEntries: vi.fn(),
      setRecentFilesOpen: vi.fn(),
    }));
    const item = { rootId: "root-1", rootName: "repo", path: "src/main.ts" };

    act(() => result.current.openGoToFileItem(item));
    expect(openFile).toHaveBeenLastCalledWith(
      { kind: "root", rootId: "root-1", path: "src/main.ts" },
      { preview: true },
    );

    act(() => result.current.openGoToFileItem(item, { split: true }));
    expect(openFile).toHaveBeenLastCalledWith(
      { kind: "root", rootId: "root-1", path: "src/main.ts" },
      { groupId: expect.any(String) },
    );
    const ui = useCodeWorkspaceStore.getState().getInstance("workspace-1");
    expect(ui.layoutTreeV2.type).toBe("split");
    expect(ui.splitOrientation).toBe("vertical");
    expect(setSearchEverywhereOpen).toHaveBeenCalledWith(false);
  });

  it("remaps navigation history, carets, and recent files after a resource move", async () => {
    const first: CodeWorkspaceFileRef = { kind: "root", rootId: "root-1", path: "src/first.ts" };
    const second: CodeWorkspaceFileRef = { kind: "root", rootId: "root-1", path: "src/second.ts" };
    const moved: CodeWorkspaceFileRef = { kind: "root", rootId: "root-2", path: "lib/first.ts" };
    const openFilesRef = { current: {
      "root:root-1:src/first.ts": openState(first),
      "root:root-1:src/second.ts": openState(second),
    } };
    const openFile = vi.fn(async () => {});
    const revealLocation = vi.fn();
    const setRecentEntries = vi.fn();
    const { result, rerender } = renderHook(
      ({ activeKey }) => useWorkspaceNavigation({
        workspaceInstanceId: "workspace-1",
        activeKey,
        roots,
        flatFiles: {},
        visible: false,
        rootsRef: { current: roots },
        looseFilesRef: { current: [] },
        openFilesRef,
        loadFlatFiles: vi.fn(async () => {}),
        openFile,
        revealLocation,
        setSearchEverywhereMode: vi.fn(),
        setSearchEverywhereOpen: vi.fn(),
        setRecentEntries,
        setRecentFilesOpen: vi.fn(),
      }),
      { initialProps: { activeKey: "root:root-1:src/first.ts" as string | null } },
    );
    act(() => result.current.noteCaretPosition("root:root-1:src/first.ts", { line: 7, character: 3 }));
    rerender({ activeKey: "root:root-1:src/second.ts" });
    await waitFor(() => expect(result.current.navCan.back).toBe(true));

    act(() => result.current.reconcileFileReferences((ref) => {
      if (ref.kind !== "root") return ref;
      if (ref.path === "src/first.ts") return moved;
      return ref;
    }));
    act(() => result.current.navigateHistory(-1));
    expect(openFile).toHaveBeenLastCalledWith(moved);
    expect(revealLocation).toHaveBeenLastCalledWith("root:root-2:lib/first.ts", { line: 7, character: 3 });

    act(() => result.current.openRecentFiles());
    expect(setRecentEntries).toHaveBeenLastCalledWith([
      expect.objectContaining({ key: "root:root-1:src/second.ts", ref: second }),
      expect.objectContaining({ key: "root:root-2:lib/first.ts", ref: moved }),
    ]);
  });

  it("navigates to last edit location and filters recently changed files", async () => {
    const first: CodeWorkspaceFileRef = { kind: "root", rootId: "root-1", path: "src/first.ts" };
    const second: CodeWorkspaceFileRef = { kind: "root", rootId: "root-1", path: "src/second.ts" };
    const openFilesRef = { current: {
      "root:root-1:src/first.ts": openState(first),
      "root:root-1:src/second.ts": openState(second),
    } };
    const openFile = vi.fn(async () => {});
    const revealLocation = vi.fn();
    const setRecentEntries = vi.fn();
    const { result, rerender } = renderHook(
      ({ activeKey }) => useWorkspaceNavigation({
        workspaceInstanceId: "workspace-1",
        activeKey,
        roots,
        flatFiles: {},
        visible: false,
        rootsRef: { current: roots },
        looseFilesRef: { current: [] },
        openFilesRef,
        loadFlatFiles: vi.fn(async () => {}),
        openFile,
        revealLocation,
        setSearchEverywhereMode: vi.fn(),
        setSearchEverywhereOpen: vi.fn(),
        setRecentEntries,
        setRecentFilesOpen: vi.fn(),
      }),
      { initialProps: { activeKey: "root:root-1:src/first.ts" as string | null } },
    );

    // Record an edit in first.ts at line 14, character 2
    act(() => result.current.recordEditLocation(first, { line: 14, character: 2 }));

    // Switch active file to second.ts
    rerender({ activeKey: "root:root-1:src/second.ts" });

    // Ctrl+Shift+Backspace jumps back to last edit location in first.ts
    act(() => result.current.navigateLastEditLocation());
    expect(revealLocation).toHaveBeenLastCalledWith("root:root-1:src/first.ts", { line: 14, character: 2 });
    expect(openFile).toHaveBeenLastCalledWith(first);

    // Ctrl+Shift+E shows only changed files (first.ts)
    act(() => result.current.openRecentFiles({ changedOnly: true }));
    expect(result.current.recentChangedOnly).toBe(true);
    expect(setRecentEntries).toHaveBeenLastCalledWith([
      expect.objectContaining({ key: "root:root-1:src/first.ts", ref: first }),
    ]);
  });

  describe("§ED-QUERY-002: Semantic Query Routing & Navigation History Invariants", () => {
    it("handles 0/1/many typed query outcomes and only records history upon actual jump", async () => {
      const fileA: CodeWorkspaceFileRef = { kind: "root", rootId: "root-1", path: "src/A.ts" };
      const fileB: CodeWorkspaceFileRef = { kind: "root", rootId: "root-1", path: "src/B.ts" };
      const openFilesRef = { current: {
        "root:root-1:src/A.ts": openState(fileA),
        "root:root-1:src/B.ts": openState(fileB),
      } };
      const openFile = vi.fn(async () => {});
      const revealLocation = vi.fn();
      const { result } = renderHook(() => useWorkspaceNavigation({
        workspaceInstanceId: "workspace-1",
        activeKey: "root:root-1:src/A.ts",
        roots,
        flatFiles: {},
        visible: false,
        rootsRef: { current: roots },
        looseFilesRef: { current: [] },
        openFilesRef,
        loadFlatFiles: vi.fn(async () => {}),
        openFile,
        revealLocation,
        setSearchEverywhereMode: vi.fn(),
        setSearchEverywhereOpen: vi.fn(),
        setRecentEntries: vi.fn(),
        setRecentFilesOpen: vi.fn(),
      }));

      const host = new WorkspaceSemanticQueryHost();

      // 1. 0 results: query yields 0 items, status message shown, NO history recorded
      const res0 = await host.executeEnvelope({
        kind: "definitions",
        identity: { uri: "file:///repo/src/A.ts", position: { line: 5, character: 2 } },
        fetcher: async () => [],
      });
      expect(res0.status).toBe("success");
      expect(res0.items).toHaveLength(0);
      // History remains empty
      expect(result.current.navCan.back).toBe(false);

      // 2. Failed / cancelled / stale: query errors, NO history recorded
      const resFailed = await host.executeEnvelope({
        kind: "typeDefinitions",
        identity: { uri: "file:///repo/src/A.ts", position: { line: 5, character: 2 } },
        fetcher: async () => { throw new Error("LSP failure"); },
      });
      expect(resFailed.status).toBe("error");
      expect(result.current.navCan.back).toBe(false);

      // 3. 1 result: jumps to target location, records origin location in history
      const res1 = await host.executeEnvelope({
        kind: "definitions",
        identity: { uri: "file:///repo/src/A.ts", position: { line: 5, character: 2 } },
        fetcher: async () => [{ uri: "file:///repo/src/B.ts", path: "src/B.ts", range: { start: { line: 12, character: 0 }, end: { line: 12, character: 5 } } }],
      });
      expect(res1.status).toBe("success");
      expect(res1.items).toHaveLength(1);

      // Simulate jump on 1 result: origin recorded, then destination recorded
      act(() => {
        result.current.recordNavigationLocation(fileA, { line: 5, character: 2 });
        result.current.recordNavigationLocation(fileB, { line: 12, character: 0 }, { replaceSameFile: false });
      });
      expect(result.current.navCan.back).toBe(true);

      // Navigate back recovers origin location in A.ts
      act(() => result.current.navigateHistory(-1));
      expect(openFile).toHaveBeenCalledWith(fileA);
      expect(revealLocation).toHaveBeenCalledWith("root:root-1:src/A.ts", { line: 5, character: 2 });
    });
  });
});
