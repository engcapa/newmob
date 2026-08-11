import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeWorkspaceRootInfo } from "../../../types";
import { useWorkspaceFileActions } from "./useWorkspaceFileActions";

const dialogMocks = vi.hoisted(() => ({
  confirmAppDialog: vi.fn(),
  promptAppDialog: vi.fn(),
}));
const workspaceMocks = vi.hoisted(() => ({
  workspaceCreateDir: vi.fn(),
  workspaceCreateFile: vi.fn(),
  workspaceDeletePath: vi.fn(),
  workspaceReadFile: vi.fn(),
  workspaceRenamePath: vi.fn(),
}));
const lspMocks = vi.hoisted(() => ({
  lspWorkspaceDidFileOperation: vi.fn(),
  lspWorkspaceWillFileOperation: vi.fn(),
}));
const ipcMocks = vi.hoisted(() => ({
  selectFilePath: vi.fn(),
  selectFolderPath: vi.fn(),
}));
const gitMocks = vi.hoisted(() => ({
  gitIgnorePath: vi.fn(),
}));

vi.mock("../../../lib/appDialogs", () => dialogMocks);
vi.mock("../../../lib/editor/lsp", () => lspMocks);
vi.mock("../../../lib/editor/workspace", () => workspaceMocks);
vi.mock("../../../lib/ipc", () => ipcMocks);
vi.mock("../../../lib/git", () => gitMocks);
vi.mock("../../../lib/clipboard", () => ({ writeText: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

const roots: CodeWorkspaceRootInfo[] = [{
  id: "root-1",
  name: "repo",
  path: "/repo",
  kind: "folder",
}];

function options(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "workspace-1",
    roots,
    gitRoots: [{
      id: "git-1",
      name: "repo",
      path: "/repo",
      repoRoot: "/repo",
      rootIds: ["root-1"],
    }],
    selected: { kind: "dir" as const, rootId: "root-1", path: "src" },
    activeKey: null,
    openFiles: {},
    directories: {},
    expandedRoots: new Set<string>(),
    expandedDirs: new Set<string>(),
    treeViewMode: "tree" as const,
    rootsRef: { current: roots },
    looseFilesRef: { current: [] },
    openFilesRef: { current: {} },
    openOrderRef: { current: [] },
    setRoots: vi.fn(),
    setLooseFiles: vi.fn(),
    setSelected: vi.fn(),
    setExpandedRoots: vi.fn(),
    setExpandedDirs: vi.fn(),
    setOpenFiles: vi.fn(),
    setOpenOrder: vi.fn(),
    setActiveKey: vi.fn(),
    loadDir: vi.fn(async () => {}),
    loadFlatFiles: vi.fn(async () => {}),
    resetTreeData: vi.fn(),
    removeTreeDataRoot: vi.fn(),
    openFile: vi.fn(async () => {}),
    applyResourceOperation: vi.fn(async () => {}),
    notifyWorkspacePathGitChanged: vi.fn(),
    onStatus: vi.fn(),
    ...overrides,
  };
}

describe("useWorkspaceFileActions", () => {
  beforeEach(() => {
    dialogMocks.confirmAppDialog.mockReset().mockResolvedValue(true);
    dialogMocks.promptAppDialog.mockReset();
    workspaceMocks.workspaceCreateDir.mockReset();
    workspaceMocks.workspaceCreateFile.mockReset();
    workspaceMocks.workspaceDeletePath.mockReset();
    workspaceMocks.workspaceReadFile.mockReset();
    workspaceMocks.workspaceRenamePath.mockReset();
    lspMocks.lspWorkspaceDidFileOperation.mockReset().mockResolvedValue(1);
    lspMocks.lspWorkspaceWillFileOperation.mockReset().mockResolvedValue(1);
    ipcMocks.selectFilePath.mockReset();
    ipcMocks.selectFolderPath.mockReset();
    gitMocks.gitIgnorePath.mockReset();
  });

  it("derives the selected directory and owns file creation", async () => {
    dialogMocks.promptAppDialog.mockResolvedValue("main.ts");
    workspaceMocks.workspaceCreateFile.mockResolvedValue({
      path: "src/main.ts",
      text: "",
      size: 0,
      mtime: 1,
      hash: "hash",
    });
    const props = options();
    const { result } = renderHook(() => useWorkspaceFileActions(props));

    expect(result.current.selectedRootDirectory).toEqual({ rootId: "root-1", path: "src" });
    await act(async () => result.current.createFile());

    expect(workspaceMocks.workspaceCreateFile).toHaveBeenCalledWith("/repo", "src/main.ts");
    const operation = {
      kind: "create",
      files: [{ path: "/repo/src/main.ts", isDirectory: false }],
    };
    expect(lspMocks.lspWorkspaceWillFileOperation).toHaveBeenCalledWith("workspace-1", operation);
    expect(lspMocks.lspWorkspaceDidFileOperation).toHaveBeenCalledWith("workspace-1", operation);
    expect(lspMocks.lspWorkspaceWillFileOperation.mock.invocationCallOrder[0]).toBeLessThan(
      workspaceMocks.workspaceCreateFile.mock.invocationCallOrder[0],
    );
    expect(workspaceMocks.workspaceCreateFile.mock.invocationCallOrder[0]).toBeLessThan(
      lspMocks.lspWorkspaceDidFileOperation.mock.invocationCallOrder[0],
    );
    expect(lspMocks.lspWorkspaceDidFileOperation.mock.invocationCallOrder[0]).toBeLessThan(
      props.loadDir.mock.invocationCallOrder[0],
    );
    expect(props.loadDir).toHaveBeenCalledWith("root-1", "src");
    expect(props.openFile).toHaveBeenCalledWith({
      kind: "root",
      rootId: "root-1",
      path: "src/main.ts",
    });
    expect(props.notifyWorkspacePathGitChanged).toHaveBeenCalledWith("root-1", "src/main.ts");
  });

  it("does not mutate the filesystem when willCreateFiles fails", async () => {
    dialogMocks.promptAppDialog.mockResolvedValue("blocked.ts");
    lspMocks.lspWorkspaceWillFileOperation.mockRejectedValue(new Error("server rejected create"));
    const props = options();
    const { result } = renderHook(() => useWorkspaceFileActions(props));

    await act(async () => result.current.createFile());

    expect(workspaceMocks.workspaceCreateFile).not.toHaveBeenCalled();
    expect(lspMocks.lspWorkspaceDidFileOperation).not.toHaveBeenCalled();
    expect(props.onStatus).toHaveBeenCalledWith("server rejected create");
  });

  it("keeps UI state convergence after a didCreateFiles transport failure", async () => {
    dialogMocks.promptAppDialog.mockResolvedValue("created.ts");
    lspMocks.lspWorkspaceDidFileOperation.mockRejectedValue(new Error("did notify failed"));
    workspaceMocks.workspaceCreateFile.mockResolvedValue({
      path: "src/created.ts",
      text: "",
      size: 0,
      mtime: 1,
      hash: "hash",
    });
    const props = options();
    const { result } = renderHook(() => useWorkspaceFileActions(props));

    await act(async () => result.current.createFile());

    expect(props.loadDir).toHaveBeenCalledWith("root-1", "src");
    expect(props.openFile).toHaveBeenCalledWith({
      kind: "root",
      rootId: "root-1",
      path: "src/created.ts",
    });
    expect(props.onStatus).toHaveBeenCalledWith(
      "Created repo / src/created.ts; language server notification failed: did notify failed",
    );
  });

  it("renames and deletes workspace paths through one mutation boundary", async () => {
    dialogMocks.promptAppDialog.mockResolvedValue("renamed.ts");
    const props = options();
    const { result } = renderHook(() => useWorkspaceFileActions(props));
    const selection = {
      kind: "file" as const,
      ref: { kind: "root" as const, rootId: "root-1", path: "src/original.ts" },
    };

    await act(async () => result.current.renameSelected(selection));
    expect(props.applyResourceOperation).toHaveBeenNthCalledWith(1, {
      kind: "rename",
      oldUri: "",
      oldPath: "/repo/src/original.ts",
      newUri: "",
      newPath: "/repo/src/renamed.ts",
      overwrite: false,
      ignoreIfExists: false,
      annotationId: null,
    });
    expect(lspMocks.lspWorkspaceWillFileOperation).toHaveBeenNthCalledWith(1, "workspace-1", {
      kind: "rename",
      files: [{
        oldPath: "/repo/src/original.ts",
        newPath: "/repo/src/renamed.ts",
        isDirectory: false,
      }],
    });
    expect(lspMocks.lspWorkspaceDidFileOperation).toHaveBeenNthCalledWith(1, "workspace-1", {
      kind: "rename",
      files: [{
        oldPath: "/repo/src/original.ts",
        newPath: "/repo/src/renamed.ts",
        isDirectory: false,
      }],
    });
    await act(async () => result.current.deleteSelected(selection));
    expect(props.applyResourceOperation).toHaveBeenNthCalledWith(2, {
      kind: "delete",
      uri: "",
      path: "/repo/src/original.ts",
      recursive: false,
      ignoreIfNotExists: false,
      annotationId: null,
    });
    expect(lspMocks.lspWorkspaceWillFileOperation).toHaveBeenNthCalledWith(2, "workspace-1", {
      kind: "delete",
      files: [{ path: "/repo/src/original.ts", isDirectory: false }],
    });
    expect(lspMocks.lspWorkspaceDidFileOperation).toHaveBeenNthCalledWith(2, "workspace-1", {
      kind: "delete",
      files: [{ path: "/repo/src/original.ts", isDirectory: false }],
    });
  });

  it("owns the internal tree clipboard and refreshes Git after paste", async () => {
    workspaceMocks.workspaceReadFile.mockResolvedValue({
      path: "src/source.ts",
      text: "source",
      size: 6,
      mtime: 1,
      hash: "hash",
    });
    workspaceMocks.workspaceCreateFile.mockResolvedValue({
      path: "dest/source.ts",
      text: "source",
      size: 6,
      mtime: 1,
      hash: "hash-2",
    });
    const props = options();
    const { result } = renderHook(() => useWorkspaceFileActions(props));

    act(() => result.current.stageTreeClipboard("copy", "root-1", "src/source.ts"));
    expect(result.current.canPasteTreeClipboard()).toBe(true);
    await act(async () => result.current.pasteTreeClipboard({ rootId: "root-1", path: "dest" }));

    expect(workspaceMocks.workspaceCreateFile).toHaveBeenCalledWith(
      "/repo",
      "dest/source.ts",
      "source",
    );
    expect(lspMocks.lspWorkspaceWillFileOperation).toHaveBeenCalledWith("workspace-1", {
      kind: "create",
      files: [{ path: "/repo/dest/source.ts", isDirectory: false }],
    });
    expect(lspMocks.lspWorkspaceDidFileOperation).toHaveBeenCalledWith("workspace-1", {
      kind: "create",
      files: [{ path: "/repo/dest/source.ts", isDirectory: false }],
    });
    expect(props.notifyWorkspacePathGitChanged).toHaveBeenCalledWith("root-1", "dest/source.ts");
  });

  it("routes a cut directory through rename lifecycle with folder semantics", async () => {
    const props = options();
    const { result } = renderHook(() => useWorkspaceFileActions(props));

    act(() => result.current.stageTreeClipboard("cut", "root-1", "src/module", true));
    await act(async () => result.current.pasteTreeClipboard({ rootId: "root-1", path: "dest" }));

    const operation = {
      kind: "rename",
      files: [{
        oldPath: "/repo/src/module",
        newPath: "/repo/dest/module",
        isDirectory: true,
      }],
    };
    expect(lspMocks.lspWorkspaceWillFileOperation).toHaveBeenCalledWith("workspace-1", operation);
    expect(props.applyResourceOperation).toHaveBeenCalledWith({
      kind: "rename",
      oldUri: "",
      oldPath: "/repo/src/module",
      newUri: "",
      newPath: "/repo/dest/module",
      overwrite: false,
      ignoreIfExists: false,
      annotationId: null,
    });
    expect(lspMocks.lspWorkspaceDidFileOperation).toHaveBeenCalledWith("workspace-1", operation);
  });

  it("adds repository-relative ignore rules and refreshes Git state", async () => {
    gitMocks.gitIgnorePath.mockResolvedValue({
      rule: "/build/",
      gitignorePath: "/repo/.gitignore",
      added: true,
    });
    const props = options();
    const { result } = renderHook(() => useWorkspaceFileActions(props));

    await act(async () => result.current.ignoreWorkspacePath("root-1", "build", true));

    expect(gitMocks.gitIgnorePath).toHaveBeenCalledWith("/repo", "build", true);
    expect(props.notifyWorkspacePathGitChanged).toHaveBeenCalledWith("root-1", "build");
    expect(props.onStatus).toHaveBeenCalledWith("Added /build/ to .gitignore");
  });
});
