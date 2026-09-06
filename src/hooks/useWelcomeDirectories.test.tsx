import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcMocks = vi.hoisted(() => ({
  listCommonLocalDirectories: vi.fn(),
  listenWelcomeDirectoriesChanged: vi.fn(async (_cb: (revision: number) => void) => {
    listeners.add(_cb);
    return () => listeners.delete(_cb);
  }),
}));

const listeners = new Set<(revision: number) => void>();

vi.mock("../lib/ipc", () => ipcMocks);

import { useWelcomeDirectories } from "./useWelcomeDirectories";

const dir = (
  path: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  label: path.split("/").pop() ?? path,
  path,
  kind: "personal",
  directoryId: `id-${path}`,
  lastUsedAtMs: null,
  timeSource: null,
  legacyRank: null,
  defaultId: null,
  availability: "available",
  ...overrides,
});

describe("useWelcomeDirectories", () => {
  beforeEach(() => {
    listeners.clear();
    ipcMocks.listCommonLocalDirectories.mockReset();
    ipcMocks.listenWelcomeDirectoriesChanged.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("keeps the backend order and reads the envelope revision", async () => {
    ipcMocks.listCommonLocalDirectories.mockResolvedValue({
      revision: 7,
      directories: [dir("/used/a", { lastUsedAtMs: 300 }), dir("/used/b", { lastUsedAtMs: 200 }), dir("/fresh")],
    });

    const { result } = renderHook(() => useWelcomeDirectories(true));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.directories.map((d) => d.path)).toEqual(["/used/a", "/used/b", "/fresh"]);
    expect(result.current.directories[0].lastUsedAtMs).toBe(300);
  });

  it("keeps the last successful list when a refresh fails and reports retry", async () => {
    ipcMocks.listCommonLocalDirectories.mockResolvedValueOnce({
      revision: 1,
      directories: [dir("/ok")],
    });
    ipcMocks.listCommonLocalDirectories.mockRejectedValueOnce(new Error("db busy"));

    const { result } = renderHook(() => useWelcomeDirectories(true));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.directories).toHaveLength(1);

    act(() => {
      result.current.reload();
    });
    await waitFor(() => expect(ipcMocks.listCommonLocalDirectories).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.error).toContain("db busy"));
    // Old array preserved; status stays ready with an error message.
    expect(result.current.status).toBe("ready");
    expect(result.current.directories).toHaveLength(1);
  });

  it("shows the error state instead of a fake empty list on first-load failure", async () => {
    ipcMocks.listCommonLocalDirectories.mockRejectedValue(new Error("storage unavailable"));
    const { result } = renderHook(() => useWelcomeDirectories(true));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.directories).toEqual([]);
    expect(result.current.error).toContain("storage unavailable");
  });

  it("merges revision-event bursts into one refresh and ignores stale revisions", async () => {
    ipcMocks.listCommonLocalDirectories.mockResolvedValue({
      revision: 1,
      directories: [dir("/v1")],
    });
    const { result } = renderHook(() => useWelcomeDirectories(true));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    ipcMocks.listCommonLocalDirectories.mockResolvedValue({
      revision: 5,
      directories: [dir("/v5")],
    });

    // Burst: several events for the same revision window.
    act(() => {
      for (const cb of listeners) cb(2);
      for (const cb of listeners) cb(3);
      for (const cb of listeners) cb(5);
    });
    await waitFor(
      () => expect(result.current.directories[0].path).toBe("/v5"),
      { timeout: 2000 },
    );
    // The burst merged into a single reload.
    expect(ipcMocks.listCommonLocalDirectories).toHaveBeenCalledTimes(2);

    // Older revision events after the refresh are ignored.
    const calls = ipcMocks.listCommonLocalDirectories.mock.calls.length;
    act(() => {
      for (const cb of listeners) cb(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(ipcMocks.listCommonLocalDirectories.mock.calls.length).toBe(calls);
  });

  it("marks dirty while hidden and reloads once on becoming active", async () => {
    ipcMocks.listCommonLocalDirectories.mockResolvedValue({
      revision: 1,
      directories: [dir("/v1")],
    });
    const { result, rerender } = renderHook((props: { active: boolean }) => useWelcomeDirectories(props.active), {
      initialProps: { active: true },
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    ipcMocks.listCommonLocalDirectories.mockResolvedValue({
      revision: 4,
      directories: [dir("/v4")],
    });

    rerender({ active: false });
    act(() => {
      for (const cb of listeners) cb(4);
    });
    // Hidden: no immediate load.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(ipcMocks.listCommonLocalDirectories).toHaveBeenCalledTimes(1);

    rerender({ active: true });
    await waitFor(() => expect(result.current.directories[0].path).toBe("/v4"));
    // Activation reloads exactly once (no duplicate dirty refresh).
    expect(ipcMocks.listCommonLocalDirectories).toHaveBeenCalledTimes(2);
  });

  it("releases the revision listener on unmount", async () => {
    ipcMocks.listCommonLocalDirectories.mockResolvedValue({ revision: 1, directories: [] });
    const { unmount } = renderHook(() => useWelcomeDirectories(true));
    await waitFor(() => expect(listeners.size).toBe(1));
    unmount();
    expect(listeners.size).toBe(0);
  });

  it("does not let a stale response overwrite a newer list", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    ipcMocks.listCommonLocalDirectories.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    ipcMocks.listCommonLocalDirectories.mockResolvedValue({
      revision: 9,
      directories: [dir("/new")],
    });

    const { result } = renderHook(() => useWelcomeDirectories(true));
    // First request is still pending; start a newer one via reload.
    await waitFor(() => expect(resolveFirst).toBeDefined());
    act(() => {
      result.current.reload();
    });
    await waitFor(() => expect(result.current.directories[0]?.path).toBe("/new"));

    // The older request finally resolves late — it must not win.
    await act(async () => {
      resolveFirst?.({ revision: 2, directories: [dir("/stale")] });
      await Promise.resolve();
    });
    expect(result.current.directories[0]?.path).toBe("/new");
  });
});
