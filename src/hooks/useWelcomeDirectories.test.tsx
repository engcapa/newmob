import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWelcomeDirectories } from "./useWelcomeDirectories";

const ipcMocks = vi.hoisted(() => ({
  listWithRevision: vi.fn(),
  listenChanged: vi.fn(),
}));

vi.mock("../lib/ipc", () => ({
  listCommonLocalDirectoriesWithRevision: ipcMocks.listWithRevision,
  listenWelcomeDirectoriesChanged: ipcMocks.listenChanged,
}));

describe("useWelcomeDirectories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcMocks.listenChanged.mockResolvedValue(() => undefined);
  });

  it("keeps backend order and exposes revision", async () => {
    ipcMocks.listWithRevision.mockResolvedValue({
      revision: 7,
      directories: [
        { label: "A", path: "/tmp/a", kind: "personal", lastUsedAtMs: 3000 },
        { label: "Home", path: "/tmp/home", kind: "system", lastUsedAtMs: 2000 },
      ],
    });
    const { result } = renderHook(() => useWelcomeDirectories(true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.directories.map((d) => d.path)).toEqual(["/tmp/a", "/tmp/home"]);
    expect(result.current.revision).toBe(7);
    expect(result.current.error).toBeNull();
  });

  it("preserves the last good list on load error and retries", async () => {
    ipcMocks.listWithRevision
      .mockResolvedValueOnce({ revision: 1, directories: [{ label: "A", path: "/a", kind: "personal" }] })
      .mockRejectedValueOnce(new Error("storage-busy"));
    const { result } = renderHook(() => useWelcomeDirectories(true));
    await waitFor(() => expect(result.current.directories.length).toBe(1));
    act(() => {
      result.current.reload();
    });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    // Last good list preserved, not cleared to a fake default-only list.
    expect(result.current.directories.length).toBe(1);
  });

  it("ignores stale responses by request sequence", async () => {
    let firstResolve!: (v: { revision: number; directories: never[] }) => void;
    const first = new Promise<{ revision: number; directories: never[] }>((resolve) => {
      firstResolve = resolve;
    });
    ipcMocks.listWithRevision
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ revision: 2, directories: [] });
    const { result } = renderHook(() => useWelcomeDirectories(true));
    act(() => {
      result.current.reload();
    });
    firstResolve({ revision: 1, directories: [] });
    await waitFor(() => expect(ipcMocks.listWithRevision).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.revision).toBe(2);
  });
});
