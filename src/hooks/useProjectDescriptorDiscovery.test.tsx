import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceEntry, WorkspaceFile, WorkspaceTreeLoadResult } from "../lib/editor/workspace";
import { workspaceListFilesRecursive, workspaceReadFile } from "../lib/editor/workspace";
import { useProjectDescriptorDiscovery } from "./useProjectDescriptorDiscovery";

vi.mock("../lib/editor/workspace", () => ({
  workspaceListFilesRecursive: vi.fn(),
  workspaceReadFile: vi.fn(),
}));

const listFilesMock = vi.mocked(workspaceListFilesRecursive);
const readFileMock = vi.mocked(workspaceReadFile);

function entry(name: string, path: string): WorkspaceEntry {
  return {
    name,
    path,
    fileType: "file",
    size: 32,
    mtime: 1_788_888_888,
    isHidden: false,
  };
}

function file(path: string, text: string): WorkspaceFile {
  return {
    path,
    text,
    size: text.length,
    mtime: 1_788_888_888,
    hash: `hash-${path}`,
  };
}

function ready(entries: readonly WorkspaceEntry[]): WorkspaceTreeLoadResult<WorkspaceEntry> {
  return { state: "ready", entries, truncated: false };
}

afterEach(() => {
  vi.clearAllMocks();
});

beforeEach(() => {
  listFilesMock.mockResolvedValue(ready([]));
  readFileMock.mockResolvedValue(file("", ""));
});

describe("useProjectDescriptorDiscovery", () => {
  it("discovers descriptors through the bounded workspace IPC without producing ready facts", async () => {
    listFilesMock.mockResolvedValue(ready([
      entry("pom.xml", "pom.xml"),
      entry("build.gradle", "service/build.gradle"),
      entry("README.md", "README.md"),
    ]));
    readFileMock.mockImplementation(async (_root, path) => (
      path === "pom.xml"
        ? file(path, "<project><artifactId>app</artifactId></project>")
        : file(path, "plugins { id 'java' }")
    ));

    const { result } = renderHook(() => useProjectDescriptorDiscovery("/repo/app", { autoRefresh: true }));

    await waitFor(() => expect(result.current.status).toBe("descriptor-only"));
    expect(result.current.discovery?.status).toBe("descriptor-only");
    expect(result.current.discovery?.descriptors.map((descriptor) => descriptor.buildSystem)).toEqual([
      "maven",
      "gradle",
    ]);
    expect(listFilesMock).toHaveBeenCalledWith("/repo/app", "", 16, 2000);
    expect(readFileMock).toHaveBeenCalledWith("/repo/app", "pom.xml", 256 * 1024);
    expect(readFileMock).toHaveBeenCalledWith("/repo/app", "service/build.gradle", 256 * 1024);
  });

  it("reports a bounded scan failure as failed and keeps the reason visible", async () => {
    listFilesMock.mockResolvedValue({ state: "failed", message: "workspace scan unavailable" });

    const { result } = renderHook(() => useProjectDescriptorDiscovery("/repo/app", { autoRefresh: true }));

    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.discovery).toBeNull();
    expect(result.current.reason).toBe("workspace scan unavailable");
  });

  it("drops a late result after the workspace root changes", async () => {
    let resolveFirst: ((value: WorkspaceTreeLoadResult<WorkspaceEntry>) => void) | undefined;
    const firstRequest = new Promise<WorkspaceTreeLoadResult<WorkspaceEntry>>((resolve) => {
      resolveFirst = resolve;
    });
    listFilesMock
      .mockReturnValueOnce(firstRequest)
      .mockResolvedValueOnce(ready([]));

    const { result, rerender } = renderHook(
      ({ root }: { root: string }) => useProjectDescriptorDiscovery(root, { autoRefresh: true }),
      { initialProps: { root: "/repo/first" } },
    );

    await waitFor(() => expect(result.current.status).toBe("loading"));
    rerender({ root: "/repo/second" });
    await waitFor(() => expect(result.current.status).toBe("unresolved"));

    await act(async () => {
      resolveFirst?.(ready([entry("pom.xml", "pom.xml")]));
    });
    await waitFor(() => expect(result.current.discovery?.generation).toBe(2));
    expect(result.current.discovery?.descriptors).toHaveLength(0);
    expect(result.current.reason).toContain("No build descriptors found");
  });
});
